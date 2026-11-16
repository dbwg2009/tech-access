// PN532 fob reader over HSU (serial). Protocol and timings: NXP UM0701-02, §6.2.3 (HSU).
//
// Lifecycle: open the port -> wake -> SAMConfiguration (normal) -> MaxRetries -> GetFirmwareVersion
// -> poll InListPassiveTarget every `pollMs`, with GetFirmwareVersion as a health check every
// `healthMs`. Any failure closes the port and tries again with back-off, for ever. A missing
// reader is cheap: status says "reader not found" and the rest of the hub carries on.
import { uidFromBytes } from "../uid";
import { Debouncer } from "./debounce";
import {
  ACK,
  CMD,
  FrameParser,
  HSU_WAKEUP,
  TFI_PN532,
  commands,
  describeFirmware,
  hex,
  parseFirmwareVersion,
  parseInListPassiveTarget,
  type Frame,
} from "./pn532Frames";
import { BaseReader } from "./types";

/** Byte pipe to the PN532. The real one is the Pi's UART; tests use an emulated PN532. */
export interface SerialTransport {
  readonly path: string;
  /** Open the device. Throws `DeviceMissingError` if it isn't there. */
  open(onData: (chunk: Uint8Array) => void, onLost: (err: Error) => void): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** The serial device itself is missing (e.g. UART not enabled). */
export class DeviceMissingError extends Error {}
/** The device opened but nothing answered: PN532 not wired, not powered, or not in HSU mode. */
export class NoAnswerError extends Error {}

export interface Pn532Options {
  pollMs?: number;
  releaseMs?: number;
  healthMs?: number;
  /** The manual says the ACK comes within 15 ms; allow for a busy Pi. */
  ackTimeoutMs?: number;
  responseTimeoutMs?: number;
  /** Back-off between reopen attempts, last value repeats. */
  retryMs?: number[];
  /** Consecutive failed polls before the port is closed and reopened. */
  maxPollFailures?: number;
  now?: () => Date;
}

const DEFAULTS: Required<Omit<Pn532Options, "now">> = {
  pollMs: 150,
  releaseMs: 600,
  healthMs: 30_000,
  ackTimeoutMs: 100,
  responseTimeoutMs: 1_000,
  retryMs: [1_000, 2_000, 5_000, 10_000, 30_000],
  maxPollFailures: 3,
};

export class Pn532UartReader extends BaseReader {
  readonly kind = "pn532" as const;
  private readonly o: Required<Omit<Pn532Options, "now">>;
  private readonly now: () => Date;
  private readonly parser = new FrameParser();
  private readonly debouncer: Debouncer;
  private frames: Frame[] = [];
  private waiter: (() => void) | null = null;
  private lost: Error | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private wakeSleep: (() => void) | null = null;

  constructor(
    private readonly transport: SerialTransport,
    opts: Pn532Options = {},
  ) {
    super();
    this.o = { ...DEFAULTS, ...opts };
    this.now = opts.now ?? (() => new Date());
    this.debouncer = new Debouncer(this.o.releaseMs);
    this.current = { state: "starting", detail: `opening ${transport.path}`, firmware: null, lastOkAt: null };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wakeSleep?.();
    this.notify();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (this.running) {
      try {
        this.lost = null;
        this.frames = [];
        this.parser.reset();
        this.debouncer.reset();
        await this.transport.open(
          (chunk) => this.onBytes(chunk),
          (err) => {
            this.lost = err;
            this.notify();
          },
        );
        const fw = await this.init();
        attempt = 0;
        this.setStatus({ state: "ok", detail: "reader working", firmware: fw, lastOkAt: this.now().toISOString() });
        await this.pollLoop();
      } catch (e) {
        if (this.running) this.report(e as Error);
      } finally {
        await this.transport.close().catch(() => {});
      }
      if (!this.running) break;
      await this.sleep(this.o.retryMs[Math.min(attempt, this.o.retryMs.length - 1)]!);
      attempt++;
    }
  }

  private report(e: Error): void {
    const path = this.transport.path;
    let patch;
    if (e instanceof DeviceMissingError) patch = { state: "not_found" as const, detail: `reader not found: ${path} missing` };
    else if (e instanceof NoAnswerError && this.current.state !== "ok")
      patch = { state: "not_found" as const, detail: `reader not found: no answer on ${path}` };
    else patch = { state: "error" as const, detail: `reader error: ${e.message}` };
    const repeated = patch.detail === this.current.detail;
    this.setStatus(patch);
    if (!repeated) this.fail(e); // log once per distinct problem, not every retry
  }

  private async init(): Promise<string> {
    await this.transport.write(HSU_WAKEUP);
    await this.exchange(commands.samConfigurationNormal(), CMD.SAMConfiguration);
    await this.exchange(commands.setMaxRetries(), CMD.RFConfiguration);
    return describeFirmware(parseFirmwareVersion(await this.exchange(commands.getFirmwareVersion(), CMD.GetFirmwareVersion)));
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    let lastHealth = Date.now();
    while (this.running) {
      try {
        const data = await this.exchange(commands.inListPassiveTargetTypeA(), CMD.InListPassiveTarget);
        const target = parseInListPassiveTarget(data);
        const at = this.now();
        failures = 0;
        this.current.lastOkAt = at.toISOString();
        const raw = target ? hex(target.uid).replace(/ /g, "") : null;
        const fresh = this.debouncer.seen(raw, at.getTime());
        if (fresh !== null) {
          const uid = uidFromBytes(target!.uid);
          if (uid.ok) this.emit("tap", { uid: uid.value, at });
          else this.fail(new Error(`card not supported: ${uid.error}`));
        }
        if (Date.now() - lastHealth >= this.o.healthMs) {
          lastHealth = Date.now();
          const fw = describeFirmware(parseFirmwareVersion(await this.exchange(commands.getFirmwareVersion(), CMD.GetFirmwareVersion)));
          this.setStatus({ firmware: fw });
        }
      } catch (e) {
        if (this.lost || !this.running) throw this.lost ?? e;
        failures++;
        // Abort whatever the PN532 was doing (§6.2.1.3: ACK from the host aborts) and resync.
        await this.transport.write(ACK).catch(() => {});
        this.frames = [];
        this.parser.reset();
        if (failures >= this.o.maxPollFailures) throw new Error(`stopped answering (${(e as Error).message})`);
      }
      await this.sleep(this.o.pollMs);
    }
  }

  /** Send a command frame, wait for the ACK, then for the response. Returns PD0..PDn. */
  private async exchange(frame: Uint8Array, cmd: number): Promise<Uint8Array> {
    this.frames = [];
    await this.transport.write(frame);
    const ack = await this.nextFrame(this.o.ackTimeoutMs, "ACK");
    if (ack.kind !== "ack") throw new Error(`expected ACK, got ${ack.kind}`);
    const res = await this.nextFrame(this.o.responseTimeoutMs, "response");
    if (res.kind === "error") throw new Error("PN532 rejected the command (syntax error frame)");
    if (res.kind !== "data") throw new Error(`expected a response, got ${res.kind === "bad" ? `a damaged frame (${res.reason})` : res.kind}`);
    if (res.tfi !== TFI_PN532 || res.data[0] !== cmd + 1) throw new Error(`unexpected response ${hex(res.data.slice(0, 1))}`);
    await this.transport.write(ACK).catch(() => {}); // optional host ACK (Fig 29)
    return res.data;
  }

  private nextFrame(timeoutMs: number, what: string): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new NoAnswerError(`no ${what} within ${timeoutMs} ms`));
      }, timeoutMs);
      const check = () => {
        if (this.lost) {
          clearTimeout(timer);
          this.waiter = null;
          reject(this.lost);
        } else if (!this.running) {
          clearTimeout(timer);
          this.waiter = null;
          reject(new Error("stopping"));
        } else if (this.frames.length) {
          clearTimeout(timer);
          this.waiter = null;
          resolve(this.frames.shift()!);
        }
      };
      this.waiter = check;
      check();
    });
  }

  private onBytes(chunk: Uint8Array): void {
    this.frames.push(...this.parser.push(chunk));
    this.notify();
  }

  private notify(): void {
    this.waiter?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        if (self.wakeSleep === done) self.wakeSleep = null;
        resolve();
      }
      this.wakeSleep = done;
      if (!this.running) done();
    });
  }
}
