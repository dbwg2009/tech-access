// The Pi's UART as a SerialTransport for the PN532 (decision 2026-11-16).
//
// No native addons: `stty` (coreutils, always on Pi OS) sets raw 115200 8N1 on every open, then
// the device is opened non-blocking and drained with readSync every few milliseconds. Doing the
// stty at open (not in the systemd unit) means it's re-applied after every reopen, and a missing
// reader can't stop the hub service from starting. Blocking read streams were rejected: after
// close they leave a read pending, which could swallow bytes meant for the next open.
import { closeSync, constants, existsSync, openSync, readSync, writeSync } from "node:fs";
import { DeviceMissingError, type SerialTransport } from "./pn532Reader";

export const STTY_ARGS = ["115200", "raw", "-echo", "cs8", "-cstopb", "-parenb", "-crtscts", "-ixon", "-ixoff", "clocal", "cread"];

export interface UartOptions {
  /** How often to drain the receive buffer. */
  readEveryMs?: number;
}

export class UartTransport implements SerialTransport {
  private fd: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly buf = Buffer.alloc(512);
  private readonly readEveryMs: number;

  constructor(
    readonly path: string,
    opts: UartOptions = {},
  ) {
    this.readEveryMs = opts.readEveryMs ?? 10;
  }

  async open(onData: (chunk: Uint8Array) => void, onLost: (err: Error) => void): Promise<void> {
    await this.close();
    if (!existsSync(this.path)) throw new DeviceMissingError(`${this.path} missing`);

    const stty = Bun.spawnSync(["stty", "-F", this.path, ...STTY_ARGS], { stderr: "pipe", stdout: "ignore" });
    if (stty.exitCode !== 0) {
      const msg = stty.stderr.toString().trim();
      if (/no such file/i.test(msg)) throw new DeviceMissingError(`${this.path} missing`);
      throw new Error(explain(msg, this.path));
    }

    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") throw new DeviceMissingError(`${this.path} missing`);
      throw new Error(explain(err.code ?? err.message, this.path));
    }
    this.fd = fd;

    const lost = (err: Error) => {
      void this.close();
      onLost(err);
    };
    this.timer = setInterval(() => {
      if (this.fd !== fd) return;
      for (;;) {
        let n: number;
        try {
          n = readSync(fd, this.buf, 0, this.buf.length, null);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EAGAIN" || code === "EWOULDBLOCK") return; // nothing more right now
          return lost(new Error(`${this.path}: ${code ?? (e as Error).message}`));
        }
        if (n <= 0) return lost(new Error(`${this.path} closed`));
        onData(Uint8Array.from(this.buf.subarray(0, n)));
      }
    }, this.readEveryMs);
  }

  async write(bytes: Uint8Array): Promise<void> {
    const fd = this.fd;
    if (fd === null) throw new Error("port not open");
    let off = 0;
    const deadline = Date.now() + 200;
    while (off < bytes.length) {
      try {
        off += writeSync(fd, bytes, off, bytes.length - off);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if ((code === "EAGAIN" || code === "EWOULDBLOCK") && Date.now() < deadline) {
          await Bun.sleep(2);
          continue;
        }
        throw new Error(`${this.path}: write failed (${code ?? (e as Error).message})`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const fd = this.fd;
    this.fd = null;
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
    }
  }
}

function explain(msg: string, path: string): string {
  if (/EACCES|permission denied/i.test(msg)) return `permission denied on ${path} (is the hub user in the dialout group?)`;
  if (/EBUSY|busy/i.test(msg)) return `${path} is in use by something else (serial console still on?)`;
  return `${path}: ${msg}`;
}
