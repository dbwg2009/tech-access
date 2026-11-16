"""Minimal PN532 (HSU) on a pseudo-terminal, for the UART transport test.

Prints the slave device path, then answers SAMConfiguration, RFConfiguration,
GetFirmwareVersion and InListPassiveTarget with ACK + response, like the chip.
A card is "on the reader" for the first ON seconds after the first poll.
Exits after RUN seconds, which closes the pty (the hub sees the device vanish).
Usage: python3 -I pn532_pty.py UIDHEX ON RUN
"""
import os, pty, select, sys, time, tty

uid = bytes.fromhex(sys.argv[1]); on_for = float(sys.argv[2]); run_for = float(sys.argv[3])
m, s = pty.openpty()
tty.setraw(s)
print(os.ttyname(s), flush=True)
ACK = bytes([0, 0, 0xFF, 0, 0xFF, 0])

def frame(data):
    d = bytes([0xD5]) + bytes(data)
    return bytes([0, 0, 0xFF, len(d), (0x100 - len(d)) & 0xFF]) + d + bytes([(0x100 - sum(d)) & 0xFF, 0])

first_poll = None
buf = b""
end = time.time() + run_for
while time.time() < end:
    r, _, _ = select.select([m], [], [], 0.05)
    if not r:
        continue
    buf += os.read(m, 1024)
    while True:
        i = buf.find(b"\x00\xff")
        if i < 0 or len(buf) < i + 4:
            break
        ln = buf[i + 2]
        if ln == 0:  # host ACK
            buf = buf[i + 4:]
            continue
        if len(buf) < i + 5 + ln + 1:
            break
        body = buf[i + 4:i + 4 + ln]
        buf = buf[i + 5 + ln + 1:]
        if body[0] != 0xD4:
            continue
        cmd = body[1]
        if cmd == 0x14: resp = [0x15]
        elif cmd == 0x32: resp = [0x33]
        elif cmd == 0x02: resp = [0x03, 0x32, 0x01, 0x06, 0x07]
        elif cmd == 0x4A:
            first_poll = first_poll or time.time()
            if time.time() - first_poll < on_for:
                resp = [0x4B, 1, 1, 0x00, 0x44, 0x00, len(uid)] + list(uid)
            else:
                resp = [0x4B, 0]
        else:
            continue
        os.write(m, ACK + frame(resp))
os.close(m)
