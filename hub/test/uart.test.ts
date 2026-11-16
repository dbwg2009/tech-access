import { describe, expect, test } from "bun:test";
import { DeviceMissingError, Pn532UartReader } from "../src/reader/pn532Reader";
import { UartTransport } from "../src/reader/uart";
import type { ReaderStatus, Tap } from "../src/reader/types";

describe("UartTransport", () => {
  test("missing device -> DeviceMissingError (works on any OS)", async () => {
    const t = new UartTransport("/dev/tech-access-no-such-tty");
    await expect(t.open(() => {}, () => {})).rejects.toBeInstanceOf(DeviceMissingError);
  });

  // End to end over a real Linux pseudo-terminal: stty, non-blocking reads, device loss.
  // Needs Linux, stty and python3 (the PN532 stand-in). The Pi and the dev container have all
  // three; on a PC without them this test is reported as skipped, not passed.
  const canPty = process.platform === "linux" && !!Bun.which("stty") && !!Bun.which("python3");
  test.skipIf(!canPty)("PN532 stand-in on a pty: wakes, reads one tap, notices the device vanish", async () => {
    const proc = Bun.spawn(["python3", "-I", `${import.meta.dir}/pty/pn532_pty.py`, "04A1B2C3D4E580", "0.5", "1.5"], { stdout: "pipe" });
    const reader = proc.stdout.getReader();
    let path = "";
    while (!path.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      path += new TextDecoder().decode(value);
    }
    path = path.trim();
    expect(path).toMatch(/^\/dev\/pts\/\d+$/);

    const r = new Pn532UartReader(new UartTransport(path), { pollMs: 20, releaseMs: 200, retryMs: [5000] });
    const taps: Tap[] = [];
    const states: ReaderStatus["state"][] = [];
    r.on("tap", (t) => taps.push(t));
    r.on("status", (s) => states.push(s.state));
    r.on("error", () => {});
    r.start();
    const t0 = Date.now();
    while (!states.includes("error") && Date.now() - t0 < 4000) await Bun.sleep(20);
    await r.stop();
    await proc.exited;

    expect(states[0]).toBe("ok");
    expect(r.status().firmware).toBe("PN532 v1.6");
    expect(taps.map((t) => t.uid)).toEqual(["04A1B2C3D4E580"]); // held 0.5 s = one tap
    expect(states).toContain("error"); // pty closed -> reader noticed, will reopen
  });
});
