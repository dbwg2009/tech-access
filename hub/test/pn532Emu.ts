// Emulated PN532 on a serial line, for reader tests. Answers the four commands the reader uses
// with ACK + response frames, like the real chip in HSU mode.
import { DeviceMissingError, type SerialTransport } from "../src/reader/pn532Reader";
import { ACK, CMD, FrameParser } from "../src/reader/pn532Frames";

function responseFrame(data: number[]): Uint8Array {
  const len = data.length + 1;
  let sum = 0xd5;
  for (const d of data) sum += d;
  return Uint8Array.of(0x00, 0x00, 0xff, len, (0x100 - len) & 0xff, 0xd5, ...data, (0x100 - (sum & 0xff)) & 0xff, 0x00);
}

export class EmulatedPn532 implements SerialTransport {
  readonly path = "/dev/ttyEMU0";
  /** Card currently on the reader (UID bytes), or null. */
  card: number[] | null = null;
  /** No device node at all. */
  missing = false;
  /** Device node exists but nothing answers (unwired / wrong DIP switches). */
  silent = false;
  /** Drop the answer to the next N InListPassiveTarget polls (RF glitch / missed poll). */
  dropPolls = 0;
  opens = 0;
  isOpen = false;
  readonly received: number[][] = [];
  private onData: ((c: Uint8Array) => void) | null = null;
  private onLost: ((e: Error) => void) | null = null;
  private parser = new FrameParser();

  async open(onData: (c: Uint8Array) => void, onLost: (e: Error) => void): Promise<void> {
    this.opens++;
    if (this.missing) throw new DeviceMissingError(`${this.path} missing`);
    this.onData = onData;
    this.onLost = onLost;
    this.parser.reset();
    this.isOpen = true;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.isOpen) throw new Error("port closed");
    if (this.silent) return;
    for (const f of this.parser.push(bytes)) {
      if (f.kind !== "data" || f.tfi !== 0xd4) continue;
      const cmd = f.data[0]!;
      this.received.push(Array.from(f.data));
      if (cmd === CMD.InListPassiveTarget && this.dropPolls > 0) {
        this.dropPolls--;
        continue; // no ACK, no response: the reader times out
      }
      const reply = this.answer(cmd);
      setTimeout(() => {
        this.onData?.(ACK);
        if (reply) setTimeout(() => this.onData?.(reply), 1);
      }, 1);
    }
  }

  private answer(cmd: number): Uint8Array | null {
    switch (cmd) {
      case CMD.GetFirmwareVersion:
        return responseFrame([0x03, 0x32, 0x01, 0x06, 0x07]);
      case CMD.SAMConfiguration:
        return responseFrame([0x15]);
      case CMD.RFConfiguration:
        return responseFrame([0x33]);
      case CMD.InListPassiveTarget:
        if (!this.card) return responseFrame([0x4b, 0x00]);
        // NTAG: SENS_RES 00 44, SEL_RES 00
        return responseFrame([0x4b, 0x01, 0x01, 0x00, 0x44, 0x00, this.card.length, ...this.card]);
      default:
        return null;
    }
  }

  /** Simulate the serial device going away (cable pulled, driver reset). */
  unplug(): void {
    this.isOpen = false;
    this.onLost?.(new Error("device lost (EIO)"));
  }

  async close(): Promise<void> {
    this.isOpen = false;
    this.onData = null;
  }
}
