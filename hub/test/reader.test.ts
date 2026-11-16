import { describe, expect, test } from "bun:test";
import { Debouncer } from "../src/reader/debounce";
import { FakeReader } from "../src/reader/fake";
import {
  ACK,
  FrameParser,
  NACK,
  buildFrame,
  commands,
  describeFirmware,
  parseFirmwareVersion,
  parseInListPassiveTarget,
} from "../src/reader/pn532Frames";
import { Pn532UartReader } from "../src/reader/pn532Reader";
import type { ReaderStatus, Tap } from "../src/reader/types";
import { uidFromBytes } from "../src/uid";
import { EmulatedPn532 } from "./pn532Emu";

const bytes = (s: string) => Uint8Array.from(s.trim().split(/\s+/).map((h) => parseInt(h, 16)));

// Byte sequences below are copied from NXP UM0701-02 (PN532 User Manual, Rev. 02).
describe("PN532 frames (UM0701-02)", () => {
  test("GetFirmwareVersion command: §6.2.1.6 example", () => {
    expect(commands.getFirmwareVersion()).toEqual(bytes("00 00 FF 02 FE D4 02 2A 00"));
  });

  test("ACK and NACK: §6.2.1.3, §6.2.1.4", () => {
    expect(ACK).toEqual(bytes("00 00 FF 00 FF 00"));
    expect(NACK).toEqual(bytes("00 00 FF FF 00 00"));
  });

  test("InListPassiveTarget 106 kbps type A: §7.3.5 example (D4 4A 01 00)", () => {
    expect(commands.inListPassiveTargetTypeA()).toEqual(buildFrame([0x4a, 0x01, 0x00]));
    expect(commands.inListPassiveTargetTypeA()).toEqual(bytes("00 00 FF 04 FC D4 4A 01 00 E1 00"));
  });

  test("SAMConfiguration normal mode and MaxRetries frames have valid checksums", () => {
    expect(commands.samConfigurationNormal()).toEqual(bytes("00 00 FF 03 FD D4 14 01 17 00"));
    expect(commands.setMaxRetries()).toEqual(bytes("00 00 FF 06 FA D4 32 05 FF 01 02 F3 00"));
  });

  test("parses the §7.2.9 GetFirmwareVersion response, with and without pre/postamble", () => {
    for (const s of ["00 00 FF 06 FA D5 03 32 01 05 07 E9 00", "00 FF 06 FA D5 03 32 01 05 07 E9"]) {
      const [f] = new FrameParser().push(bytes(s));
      expect(f?.kind).toBe("data");
      if (f?.kind !== "data") return;
      expect(f.tfi).toBe(0xd5);
      const fw = parseFirmwareVersion(f.data);
      expect(fw).toEqual({ ic: 0x32, ver: 1, rev: 5, support: 7 });
      expect(describeFirmware(fw)).toBe("PN532 v1.5");
    }
  });

  test("parses the §7.3.5 InListPassiveTarget answer (4-byte UID 92 2E 58 32)", () => {
    const data = bytes("4B 01 01 04 00 08 04 92 2E 58 32");
    const t = parseInListPassiveTarget(data);
    expect(t).not.toBeNull();
    expect(t!.tg).toBe(1);
    expect(t!.selRes).toBe(0x08);
    expect(Array.from(t!.uid)).toEqual([0x92, 0x2e, 0x58, 0x32]);
    expect(uidFromBytes(t!.uid)).toEqual({ ok: true, value: "922E5832" });
    // Same thing wrapped in a frame built from those bytes.
    const [f] = new FrameParser().push(bytes("00 00 FF 0C F4 D5 4B 01 01 04 00 08 04 92 2E 58 32 84 00"));
    expect(f?.kind).toBe("data");
  });

  test("no target -> null; 7-byte NTAG UID normalises like the workbook", () => {
    expect(parseInListPassiveTarget(bytes("4B 00"))).toBeNull();
    const t = parseInListPassiveTarget(bytes("4B 01 01 00 44 00 07 04 a1 b2 c3 d4 e5 80"));
    expect(uidFromBytes(t!.uid)).toEqual({ ok: true, value: "04A1B2C3D4E580" });
  });

  test("syntax error frame: §6.2.1.5", () => {
    expect(new FrameParser().push(bytes("00 00 FF 01 FF 7F 81 00"))).toEqual([{ kind: "error", code: 0x7f }]);
  });

  test("ACK then response split across chunks at awkward places, with line noise", () => {
    const p = new FrameParser();
    const all = [...bytes("13 37 00 00 FF 00 FF 00"), ...bytes("00 00 FF 02 FE D5 15 16 00")];
    const out = [];
    for (const b of all) out.push(...p.push([b])); // one byte at a time
    expect(out.map((f) => f.kind)).toEqual(["ack", "data"]);
  });

  test("damaged frames are reported and skipped, and the next frame still parses", () => {
    const p = new FrameParser();
    const out = p.push([...bytes("00 00 FF 02 FE D5 15 99 00"), ...ACK]);
    expect(out.map((f) => f.kind)).toEqual(["bad", "ack"]);
    expect(p.push(bytes("00 FF 05 FA 00"))[0]).toEqual({ kind: "bad", reason: "length checksum" });
  });

  test("extended information frame (§6.2.1.2) is parsed", () => {
    // 00 00 FF FF FF LENM LENL LCS TFI PD.. DCS 00 with LEN = 3 (D5 15 AA)
    const sum = 0xd5 + 0x15 + 0xaa;
    const f = new FrameParser().push([0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x03, 0xfd, 0xd5, 0x15, 0xaa, (0x100 - (sum & 0xff)) & 0xff, 0x00]);
    expect(f).toEqual([{ kind: "data", tfi: 0xd5, data: Uint8Array.of(0x15, 0xaa) }]);
  });
});

describe("debounce", () => {
  test("a fob held on the reader is one tap", () => {
    const d = new Debouncer(600);
    const taps = [];
    for (let t = 0; t <= 3000; t += 150) taps.push(d.seen("04A1B2C3D4E580", t));
    expect(taps.filter(Boolean)).toEqual(["04A1B2C3D4E580"]);
  });

  test("one missed poll while held doesn't make a second tap", () => {
    const d = new Debouncer(600);
    expect(d.seen("AAAAAAAA", 0)).toBe("AAAAAAAA");
    expect(d.seen(null, 150)).toBeNull();
    expect(d.seen("AAAAAAAA", 300)).toBeNull();
  });

  test("lift and tap again after the release time is a new tap", () => {
    const d = new Debouncer(600);
    expect(d.seen("AAAAAAAA", 0)).toBe("AAAAAAAA");
    expect(d.seen(null, 300)).toBeNull();
    expect(d.seen(null, 700)).toBeNull();
    expect(d.seen("AAAAAAAA", 900)).toBe("AAAAAAAA");
  });

  test("a different fob is a new tap straight away", () => {
    const d = new Debouncer(600);
    expect(d.seen("AAAAAAAA", 0)).toBe("AAAAAAAA");
    expect(d.seen("BBBBBBBB", 150)).toBe("BBBBBBBB");
    expect(d.seen("AAAAAAAA", 300)).toBe("AAAAAAAA");
  });
});

const fast = { pollMs: 5, releaseMs: 60, ackTimeoutMs: 30, responseTimeoutMs: 60, retryMs: [10], healthMs: 50 };

function until(cond: () => boolean, ms = 1500): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => (cond() ? resolve() : Date.now() - t0 > ms ? reject(new Error("timed out")) : setTimeout(tick, 5));
    tick();
  });
}

describe("Pn532UartReader against an emulated PN532", () => {
  test("wakes, configures, polls; a held fob is one tap; lifting and re-tapping is another", async () => {
    const emu = new EmulatedPn532();
    const r = new Pn532UartReader(emu, fast);
    const taps: Tap[] = [];
    r.on("tap", (t) => taps.push(t));
    r.start();
    await until(() => r.status().state === "ok");
    expect(r.status().firmware).toBe("PN532 v1.6");
    expect(emu.received.slice(0, 3).map((c) => c[0])).toEqual([0x14, 0x32, 0x02]); // SAM, RFConfig, firmware
    emu.card = [0x04, 0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0x80];
    await until(() => taps.length === 1);
    await Bun.sleep(150); // still held
    expect(taps.length).toBe(1);
    expect(taps[0]!.uid).toBe("04A1B2C3D4E580");
    emu.card = null;
    await Bun.sleep(120);
    emu.card = [0x04, 0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0x80];
    await until(() => taps.length === 2);
    await r.stop();
    expect(emu.isOpen).toBe(false);
  });

  test("missing device: status says reader not found, keeps retrying, recovers when it appears", async () => {
    const emu = new EmulatedPn532();
    emu.missing = true;
    const r = new Pn532UartReader(emu, fast);
    const errors: Error[] = [];
    r.on("error", (e) => errors.push(e));
    r.start();
    await until(() => r.status().state === "not_found");
    expect(r.status().detail).toBe("reader not found: /dev/ttyEMU0 missing");
    await until(() => emu.opens >= 3);
    expect(errors.length).toBe(1); // logged once, not on every retry
    emu.missing = false;
    await until(() => r.status().state === "ok");
    await r.stop();
  });

  test("nothing answering on the port is 'reader not found: no answer'", async () => {
    const emu = new EmulatedPn532();
    emu.silent = true;
    const r = new Pn532UartReader(emu, fast);
    r.on("error", () => {});
    r.start();
    await until(() => r.status().state === "not_found");
    expect(r.status().detail).toBe("reader not found: no answer on /dev/ttyEMU0");
    await r.stop();
  });

  test("port drops: the reader reopens it and carries on", async () => {
    const emu = new EmulatedPn532();
    const r = new Pn532UartReader(emu, fast);
    const states: ReaderStatus["state"][] = [];
    r.on("status", (s) => states.push(s.state));
    r.on("error", () => {});
    r.start();
    await until(() => r.status().state === "ok");
    emu.unplug();
    await until(() => states.includes("error"));
    await until(() => r.status().state === "ok" && emu.opens >= 2);
    const taps: Tap[] = [];
    r.on("tap", (t) => taps.push(t));
    emu.card = [0x01, 0x02, 0x03, 0x04];
    await until(() => taps.length === 1);
    expect(taps[0]!.uid).toBe("01020304");
    await r.stop();
  });

  test("a missed poll is retried without reopening; health check keeps running", async () => {
    const emu = new EmulatedPn532();
    const r = new Pn532UartReader(emu, fast);
    r.start();
    await until(() => r.status().state === "ok");
    r.on("error", () => {});
    emu.dropPolls = 1;
    await until(() => emu.dropPolls === 0);
    await Bun.sleep(100);
    expect(r.status().state).toBe("ok");
    expect(emu.opens).toBe(1);
    expect(emu.received.filter((c) => c[0] === 0x02).length).toBeGreaterThan(1); // health checks
    await r.stop();
  });
});

describe("FakeReader", () => {
  test("normalises UIDs and refuses bad ones", () => {
    const r = new FakeReader(["04:a1:b2:c3:d4:e5:80", "AAAAAAAA"], () => new Date("2026-11-16T10:00:00Z"));
    const taps: Tap[] = [];
    r.on("tap", (t) => taps.push(t));
    r.start();
    expect(r.tap("04 a1 b2 c3 d4 e5 80").uid).toBe("04A1B2C3D4E580");
    expect(() => r.tap("XYZ")).toThrow("not hex");
    expect(() => r.tap("0102")).toThrow("4, 7 or 10 bytes");
    expect(r.tapNext().uid).toBe("04A1B2C3D4E580");
    expect(r.tapNext().uid).toBe("AAAAAAAA");
    expect(r.tapNext().uid).toBe("04A1B2C3D4E580");
    expect(taps.length).toBe(4);
    expect(taps[0]!.at.toISOString()).toBe("2026-11-16T10:00:00.000Z");
  });
});
