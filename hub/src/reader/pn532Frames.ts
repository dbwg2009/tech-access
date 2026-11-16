// PN532 host link frames (NXP UM0701-02 "PN532 User Manual" Rev. 02, §6.2.1) and the few
// commands the desk reader uses. Pure: bytes in, bytes out. Tested against the manual's examples.

export const TFI_HOST = 0xd4; // host -> PN532
export const TFI_PN532 = 0xd5; // PN532 -> host

export const CMD = {
  GetFirmwareVersion: 0x02, // §7.2.2
  SAMConfiguration: 0x14, // §7.2.10
  RFConfiguration: 0x32, // §7.3.1
  InListPassiveTarget: 0x4a, // §7.3.5
} as const;

/** §6.2.1.3 */
export const ACK = Uint8Array.of(0x00, 0x00, 0xff, 0x00, 0xff, 0x00);
/** §6.2.1.4 */
export const NACK = Uint8Array.of(0x00, 0x00, 0xff, 0xff, 0x00, 0x00);
/**
 * HSU wake-up (§7.2.11 "HSU wake up condition"): a long preamble of dummy bytes before the first
 * command so the PN532 has woken before the start code arrives. 0x55 gives plenty of rising edges.
 */
export const HSU_WAKEUP = Uint8Array.of(0x55, 0x55, ...new Array<number>(14).fill(0x00));

const low = (n: number) => n & 0xff;
const checksum = (n: number) => low(0x100 - low(n));

/** Normal information frame (§6.2.1.1): 00 00 FF LEN LCS D4 PD0..PDn DCS 00. */
export function buildFrame(data: ArrayLike<number>): Uint8Array {
  const len = data.length + 1; // + TFI
  if (len > 255) throw new Error("PN532 frame too long for a normal frame");
  let sum = TFI_HOST;
  for (let i = 0; i < data.length; i++) sum += data[i]!;
  return Uint8Array.of(0x00, 0x00, 0xff, len, checksum(len), TFI_HOST, ...Array.from(data), checksum(sum), 0x00);
}

export const commands = {
  getFirmwareVersion: () => buildFrame([CMD.GetFirmwareVersion]),
  /** Normal mode, SAM not used (§7.2.10). Timeout is optional outside Virtual Card mode. */
  samConfigurationNormal: () => buildFrame([CMD.SAMConfiguration, 0x01]),
  /**
   * MaxRetries (§7.3.1 CfgItem 0x05): MxRtyATR, MxRtyPSL, MxRtyPassiveActivation. The default
   * passive activation retry is 0xFF (forever), so InListPassiveTarget would never say "no card".
   * 0x02 makes it return NbTg = 0 quickly, which is what polling and debounce need.
   */
  setMaxRetries: (passiveActivation = 0x02) => buildFrame([CMD.RFConfiguration, 0x05, 0xff, 0x01, passiveActivation]),
  /** One target, 106 kbps type A (§7.3.5). */
  inListPassiveTargetTypeA: () => buildFrame([CMD.InListPassiveTarget, 0x01, 0x00]),
};

export type Frame =
  | { kind: "ack" }
  | { kind: "nack" }
  /** Syntax error frame (§6.2.1.5): the PN532 didn't understand the command. */
  | { kind: "error"; code: number }
  /** Information frame from the PN532: `data` is PD0..PDn (PD0 = command code + 1). */
  | { kind: "data"; tfi: number; data: Uint8Array }
  /** Start code seen but the frame was damaged (bad checksum). The bytes are skipped. */
  | { kind: "bad"; reason: string };

/**
 * Incremental parser: push bytes as they arrive from the UART, get whole frames out. Anything
 * before a 00 FF start code (preamble, postamble, line noise) is ignored, as the manual allows.
 */
export class FrameParser {
  private buf: number[] = [];

  push(chunk: ArrayLike<number>): Frame[] {
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]!);
    const out: Frame[] = [];
    for (;;) {
      const f = this.next();
      if (f === null) break;
      out.push(f);
    }
    return out;
  }

  reset(): void {
    this.buf = [];
  }

  private next(): Frame | null {
    const b = this.buf;
    // Find start code 00 FF.
    let s = -1;
    for (let i = 0; i + 1 < b.length; i++) {
      if (b[i] === 0x00 && b[i + 1] === 0xff) {
        s = i;
        break;
      }
    }
    if (s < 0) {
      // Keep a trailing 00 in case FF is in the next chunk.
      this.buf = b.length && b[b.length - 1] === 0x00 ? [0x00] : [];
      return null;
    }
    if (s > 0) b.splice(0, s);
    if (b.length < 4) return null; // 00 FF LEN LCS
    const len = b[2]!;
    const lcs = b[3]!;
    if (len === 0x00 && lcs === 0xff) {
      b.splice(0, 4);
      return { kind: "ack" };
    }
    if (len === 0xff && lcs === 0x00) {
      b.splice(0, 4);
      return { kind: "nack" };
    }
    if (len === 0xff && lcs === 0xff) {
      // Extended frame (§6.2.1.2). The PN532 only sends one for > 255 bytes, which none of our
      // commands produce, but parse it properly rather than mistake it for garbage.
      if (b.length < 7) return null;
      const xlen = b[4]! * 256 + b[5]!;
      if (low(b[4]! + b[5]! + b[6]!) !== 0) return this.skip("extended length checksum");
      return this.body(7, xlen);
    }
    if (low(len + lcs) !== 0) return this.skip("length checksum");
    return this.body(4, len);
  }

  /** TFI + data starts at `at`, `len` bytes, then DCS. */
  private body(at: number, len: number): Frame | null {
    const b = this.buf;
    if (b.length < at + len + 1) return null;
    let sum = 0;
    for (let i = at; i < at + len + 1; i++) sum += b[i]!;
    const bytes = b.slice(at, at + len);
    b.splice(0, at + len + 1);
    if (low(sum) !== 0) return { kind: "bad", reason: "data checksum" };
    if (len === 1 && bytes[0] === 0x7f) return { kind: "error", code: 0x7f };
    return { kind: "data", tfi: bytes[0]!, data: Uint8Array.from(bytes.slice(1)) };
  }

  private skip(reason: string): Frame {
    this.buf.splice(0, 2); // drop this 00 FF and look for the next one
    return { kind: "bad", reason };
  }
}

export interface FirmwareVersion {
  ic: number;
  ver: number;
  rev: number;
  support: number;
}

/** D5 03 IC Ver Rev Support (§7.2.2). `data` is PD0.. (PD0 = 0x03). */
export function parseFirmwareVersion(data: Uint8Array): FirmwareVersion {
  if (data.length < 5 || data[0] !== CMD.GetFirmwareVersion + 1) throw new Error("not a GetFirmwareVersion response");
  return { ic: data[1]!, ver: data[2]!, rev: data[3]!, support: data[4]! };
}

export function describeFirmware(f: FirmwareVersion): string {
  return `${f.ic === 0x32 ? "PN532" : `IC 0x${f.ic.toString(16)}`} v${f.ver}.${f.rev}`;
}

export interface TypeATarget {
  tg: number;
  sensRes: number;
  selRes: number;
  uid: Uint8Array;
}

/**
 * D5 4B NbTg [Tg SENS_RES(2) SEL_RES NFCIDLength NFCID1[] (ATS[])] (§7.3.5, 106 kbps type A).
 * Returns null when no target was found (NbTg = 0). We ask for one target only, so only the
 * first is read.
 */
export function parseInListPassiveTarget(data: Uint8Array): TypeATarget | null {
  if (data.length < 2 || data[0] !== CMD.InListPassiveTarget + 1) throw new Error("not an InListPassiveTarget response");
  if (data[1] === 0) return null;
  if (data.length < 7) throw new Error("InListPassiveTarget response too short");
  const idLen = data[6]!;
  if (data.length < 7 + idLen) throw new Error("InListPassiveTarget response cut short");
  return { tg: data[2]!, sensRes: (data[3]! << 8) | data[4]!, selRes: data[5]!, uid: data.slice(7, 7 + idLen) };
}

export const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ");
