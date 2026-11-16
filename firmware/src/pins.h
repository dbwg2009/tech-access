// WT32-ETH01 pin plan (decision 2026-11-16, weeks 5-6). Full table and reasons: docs/wiki/Lock-Boxes.md.
//
// Used by the board itself, never touch:
//   GPIO0  LAN8720 50 MHz clock input, and the "hold low to flash" strap (IO0 to GND at reset)
//   GPIO16 LAN8720 oscillator enable      GPIO18 MDIO   GPIO23 MDC
//   GPIO19, 21, 22, 25, 26, 27  RMII data
//   GPIO1 / GPIO3  USB serial (flashing + the provisioning console)
// Strapping pins left free: GPIO2, GPIO12 (must be low at reset or flash runs at 1.8 V), GPIO15.
#pragma once

// PN532 in HSU mode (UART2). The board's own RXD/TXD labels; same mode as the desk reader.
constexpr int PIN_PN532_RX = 5;   // ESP32 RX  <- PN532 TXD  (strap pin, but PN532 idles high = its default)
constexpr int PIN_PN532_TX = 17;  // ESP32 TX  -> PN532 RXD

// Maglock: logic-level N-MOSFET low-side switch. HIGH = locked (maglock powered).
// 10 kΩ gate pull-down, so reset, boot, crash, watchdog or brown-out = gate low = unlocked.
// GPIO32 has no boot-time activity and isn't a strapping pin.
constexpr int PIN_LOCK = 32;

// Reed switch between this pin and GND. Internal pull-up + 10 kΩ external pull-up.
// LOW = magnet present = door shut. A broken wire reads "open" (the safe report).
constexpr int PIN_DOOR = 4;

// LAN8720 on the WT32-ETH01 (also in the board's variant file; spelled out so the
// esp32-wifi build compiles the same code).
constexpr int ETH_ADDR = 1;
constexpr int ETH_MDC = 23;
constexpr int ETH_MDIO = 18;
constexpr int ETH_POWER = 16;
