// Development / test reader. Taps come from `POST /api/dev/tap` (loopback, `fake_reader = true`)
// or the panel's dev key. No debounce: every call is one deliberate tap.
import { normaliseUid } from "../uid";
import { BaseReader, type Tap } from "./types";

export class FakeReader extends BaseReader {
  readonly kind = "fake" as const;
  private running = false;
  private nextIndex = 0;

  constructor(
    private readonly fobs: readonly string[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
    this.current = { state: "starting", detail: "fake reader (development)", firmware: null, lastOkAt: null };
  }

  start(): void {
    this.running = true;
    this.setStatus({ state: "ok", detail: "fake reader (development)", lastOkAt: this.now().toISOString() });
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /** Emit a tap. Throws on a malformed UID so the dev route can answer 400. */
  tap(rawUid: string): Tap {
    const r = normaliseUid(rawUid);
    if (!r.ok) throw new Error(r.error);
    if (!this.running) throw new Error("fake reader isn't running");
    const t: Tap = { uid: r.value, at: this.now() };
    this.current.lastOkAt = t.at.toISOString();
    this.emit("tap", t);
    return t;
  }

  /** The panel's dev key: send the next fob from `fake_fobs` in the config, round robin. */
  tapNext(): Tap {
    if (this.fobs.length === 0) throw new Error("fake_fobs is empty in the config");
    const uid = this.fobs[this.nextIndex % this.fobs.length]!;
    this.nextIndex++;
    return this.tap(uid);
  }

  list(): readonly string[] {
    return this.fobs;
  }
}
