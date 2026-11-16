// Fob reader interface. The hub only ever sees `tap` events with a normalised UID; how the UID
// was read (PN532 on the Pi's UART, or the fake reader in development) is hidden behind this.
import { EventEmitter } from "node:events";

export interface Tap {
  /** Uppercase hex, 4/7/10 bytes: the same rules as the workbook's Fob UID column. */
  uid: string;
  at: Date;
}

export type ReaderState =
  | "starting" // opening the port / waking the PN532
  | "ok" // polling
  | "not_found" // no device, or nothing answering on it
  | "error"; // was working, now failing; retrying

export interface ReaderStatus {
  state: ReaderState;
  /** Plain words for the hub status screen, e.g. "reader not found: /dev/ttyAMA0 missing". */
  detail: string;
  /** e.g. "PN532 v1.6" once GetFirmwareVersion has answered. */
  firmware: string | null;
  /** Last time the reader answered anything (ISO), or null. */
  lastOkAt: string | null;
}

export interface ReaderEvents {
  tap: [Tap];
  error: [Error];
  status: [ReaderStatus];
}

/**
 * What the rest of the hub uses: start/stop, current status, and `tap` / `error` / `status`
 * events (typed by ReaderEvents). Implemented by FakeReader and Pn532UartReader.
 */
export type FobReader = Pick<BaseReader, "kind" | "start" | "stop" | "status" | "on" | "off" | "once">;

/**
 * Shared event plumbing. `error` never throws: Node's EventEmitter throws on an `error` event
 * with no listener, and a reader problem must never take the hub down.
 */
export abstract class BaseReader extends EventEmitter<ReaderEvents> {
  abstract readonly kind: "pn532" | "fake";
  protected current: ReaderStatus = { state: "starting", detail: "starting", firmware: null, lastOkAt: null };

  abstract start(): void;
  abstract stop(): Promise<void>;

  status(): ReaderStatus {
    return { ...this.current };
  }

  protected setStatus(patch: Partial<ReaderStatus>): void {
    const next = { ...this.current, ...patch };
    const changed = next.state !== this.current.state || next.detail !== this.current.detail || next.firmware !== this.current.firmware;
    this.current = next;
    if (changed) this.emit("status", this.status());
  }

  protected fail(err: Error): void {
    if (this.listenerCount("error") > 0) this.emit("error", err);
    else console.error(`reader: ${err.message}`);
  }
}
