#include "reader.h"

#include <Adafruit_PN532.h>
#include <Arduino.h>

#include "pins.h"

// RSTPD_N isn't broken out on the common PN532 boards, so no reset pin (255 = none; Arduino-ESP32
// ignores writes to it). Recovery is a SAMConfig wake-up, then a full re-begin.
static Adafruit_PN532* nfc = nullptr;
static bool ok = false;
static uint64_t nextTry = 0;
static uint32_t backoffIdx = 0;
static uint64_t nextHealth = 0;
static const uint32_t kBackoffMs[] = {1000, 2000, 5000, 10000, 30000};

static bool pn532Init() {
  Serial2.begin(115200, SERIAL_8N1, PIN_PN532_RX, PIN_PN532_TX);
  if (!nfc) nfc = new Adafruit_PN532(255, &Serial2);
  nfc->begin();  // re-begins Serial2 on the pins set above
  const uint32_t v = nfc->getFirmwareVersion();
  if (!v) return false;
  // MaxRetries 2: InListPassiveTarget answers "no card" instead of waiting forever
  // (same as the desk reader, decision 2026-11-16).
  nfc->setPassiveActivationRetries(2);
  nfc->SAMConfig();
  Serial.printf("reader: PN532 firmware %u.%u\n", (unsigned)(v >> 16) & 0xFF, (unsigned)(v >> 8) & 0xFF);
  return true;
}

void readerBegin() {
  ok = pn532Init();
  if (!ok) Serial.println("reader: PN532 not answering (retrying with back-off)");
}

bool readerOk() { return ok; }

std::string readerPoll(uint64_t now) {
  if (!ok) {
    if (now < nextTry) return "";
    ok = pn532Init();
    if (!ok) {
      nextTry = now + kBackoffMs[backoffIdx];
      if (backoffIdx < 4) backoffIdx++;
      return "";
    }
    backoffIdx = 0;
  }
  if (now >= nextHealth) {  // health check every 30 s, like the desk reader
    nextHealth = now + 30000;
    if (!nfc->getFirmwareVersion()) {
      ok = false;
      Serial.println("reader: PN532 stopped answering");
      return "";
    }
  }
  uint8_t uid[10];
  uint8_t len = 0;
  if (!nfc->readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &len, 100) || (len != 4 && len != 7 && len != 10)) return "";
  static const char* hex = "0123456789ABCDEF";
  std::string s;
  for (uint8_t i = 0; i < len; i++) {
    s.push_back(hex[uid[i] >> 4]);
    s.push_back(hex[uid[i] & 0xF]);
  }
  return s;
}
