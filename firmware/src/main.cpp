// tech-access lock box firmware: the hardware layer. Every decision is in lib/box_core; this file
// feeds it inputs (taps, MQTT messages, the clock, the reed switch) and carries out its actions.
//
// Fail open, by design:
//   - The lock pin is LOW (unlocked) from reset until box_core says otherwise, with a 10 kΩ gate
//     pull-down so reset, boot, a crash, a watchdog reboot or a brown-out all release the maglock.
//   - The hub unreachable for offline_unlock_min = unlock (box_core).
#include <Arduino.h>
#include <ETH.h>
#include <MQTT.h>
#include <Network.h>
#include <WiFi.h>
#include <box_core.h>
#include <esp_ota_ops.h>
#include <esp_task_wdt.h>
#include <time.h>

#include <deque>

#include "config.h"
#include "fobstore.h"
#include "ota.h"
#include "pins.h"
#include "reader.h"

#ifndef FW_VERSION
#define FW_VERSION "0.0.0-dev"
#endif

// Keep the new image "pending verify" until box_core says it reached the hub (see esp32-hal-misc.c).
extern "C" bool verifyRollbackLater() { return true; }

static constexpr uint32_t kWatchdogS = 10;
static constexpr uint32_t kReaderPollMs = 150;
static constexpr uint32_t kDoorDebounceMs = 50;
static const uint32_t kMqttBackoffMs[] = {1000, 2000, 5000, 10000, 30000};

static BoxConfig cfg;
static boxcore::Box core;
static boxcore::TapDebouncer debounce;
static NetworkClient netClient;     // MQTT
static NetworkClient otaClient;     // firmware download
static MQTTClient mqtt(16384, 1024);  // big read buffer: the retained fobs list
static std::deque<std::pair<std::string, std::string>> inbox;  // MQTT callback -> loop()
static String topicBase, willPayload = "{\"lock\":\"open\",\"why\":\"offline\"}";
static bool mqttUp = false;
static uint64_t nextMqttTry = 0;
static uint32_t mqttBackoff = 0;
static uint64_t nextReaderPoll = 0;
static bool doorRaw = true, doorStable = true;
static uint64_t doorChangedAt = 0;
static bool netStarted = false;
static bool provisioned = false;

static uint64_t monoMs() { return static_cast<uint64_t>(esp_timer_get_time() / 1000); }

static boxcore::Now nowInfo() {
  boxcore::Now n;
  n.mono_ms = monoMs();
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  n.clock_set = tv.tv_sec > 1735689600;  // after 2025-01-01: SNTP has set it since boot
  n.utc_ms = static_cast<int64_t>(tv.tv_sec) * 1000 + tv.tv_usec / 1000;
  return n;
}

static void feed() { esp_task_wdt_reset(); }

static void setLock(bool locked) {
  digitalWrite(PIN_LOCK, locked ? HIGH : LOW);
  if (core.why().empty()) Serial.printf("lock: %s\n", locked ? "locked" : "open");
  else Serial.printf("lock: %s (%s)\n", locked ? "locked" : "open", core.why().c_str());
}

static void mqttPublish(const boxcore::Action& a) {
  if (!mqttUp) return;
  const String t = topicBase + a.topic.c_str();
  if (!mqtt.publish(t.c_str(), a.payload.c_str(), static_cast<int>(a.payload.size()), a.retain, a.qos)) {
    Serial.printf("mqtt: publish to %s failed\n", t.c_str());
  }
}

static void apply();

static void startOta(const boxcore::Action& a) {
  Serial.printf("ota: %s from %s (%lu bytes)\n", a.version.c_str(), a.url.c_str(), (unsigned long)a.size);
  apply();  // send the "updating" state first
  mqtt.loop();
  String why;
  const bool ok = otaRun(otaClient, a.url.c_str(), a.sha256.c_str(), a.size, why, feed);
  core.otaResult(nowInfo(), ok, why.c_str());
  if (!ok) {
    Serial.printf("ota: failed (%s)\n", why.c_str());
    return;
  }
  nvsPut("try", a.version.c_str());  // the next boot knows which version it was trying
  apply();                           // "rebooting"
  for (int i = 0; i < 20; i++) {     // let the state message go out
    mqtt.loop();
    delay(25);
  }
  Serial.println("ota: flashed, rebooting");
  mqtt.disconnect();
  ESP.restart();
}

/** Carry out everything box_core asked for (some actions produce more). */
static void apply() {
  for (int guard = 0; guard < 8; guard++) {
    auto actions = core.take();
    if (actions.empty()) return;
    for (const auto& a : actions) {
      switch (a.type) {
        case boxcore::ActionType::SetLock: setLock(a.locked); break;
        case boxcore::ActionType::Publish: mqttPublish(a); break;
        case boxcore::ActionType::StoreFobs:
          if (!fobstoreSave(a.payload)) Serial.println("fobs: couldn't save the list to flash");
          break;
        case boxcore::ActionType::StartOta: startOta(a); break;
        case boxcore::ActionType::MarkAppValid:
          esp_ota_mark_app_valid_cancel_rollback();
          nvsPut("try", "");
          Serial.println("ota: new firmware reached the hub, marked valid");
          break;
        case boxcore::ActionType::RollbackReboot:
          Serial.println("ota: new firmware never reached the hub, rolling back");
          esp_ota_mark_app_invalid_rollback_and_reboot();
          ESP.restart();  // only reached if there's nothing to roll back to
          break;
      }
    }
  }
}

// ---------------------------------------------------------------- network

static bool netReady() {
  if (cfg.net == "eth") return ETH.linkUp() && ETH.localIP() != IPAddress(0, 0, 0, 0);
  return WiFi.status() == WL_CONNECTED;
}

static void netBegin() {
  IPAddress ip, mask, none(0, 0, 0, 0);
  ip.fromString(cfg.ip);
  mask.fromString(cfg.mask);
  if (cfg.net == "eth") {
    ETH.begin(ETH_PHY_LAN8720, ETH_ADDR, ETH_MDC, ETH_MDIO, ETH_POWER, ETH_CLOCK_GPIO0_IN);
    ETH.config(ip, none, mask, none);  // show network: no gateway, no DNS
  } else {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    if (cfg.ip.length()) WiFi.config(ip, none, mask, none);
    WiFi.begin(cfg.ssid.c_str(), cfg.wifiPass.c_str());
  }
  configTime(0, 0, cfg.hub.c_str());  // SNTP from the Pi; times stay UTC, box_core works out London
  netStarted = true;
}

static String localIp() { return (cfg.net == "eth" ? ETH.localIP() : WiFi.localIP()).toString(); }

// ---------------------------------------------------------------- MQTT

static void onMqtt(MQTTClient*, char topic[], char bytes[], int length) {
  // Don't use the client from inside its callback: queue for loop().
  if (inbox.size() < 16) inbox.emplace_back(topic, std::string(bytes, length));
}

static void mqttMaintain(uint64_t now) {
  const bool up = mqtt.connected();
  if (mqttUp && !up) {
    mqttUp = false;
    Serial.printf("mqtt: disconnected (error %d)\n", mqtt.lastError());
    core.broker(nowInfo(), false);
  }
  if (up) return;
  if (!netReady() || now < nextMqttTry) return;
  core.setIp(localIp().c_str());
  if (mqtt.connect(cfg.id.c_str(), cfg.id.c_str(), cfg.pass.c_str())) {
    mqttBackoff = 0;
    const char* subs[] = {"cmd", "mode", "fobs", "ota"};
    for (const char* s : subs) mqtt.subscribe((topicBase + s).c_str(), 1);
    mqtt.subscribe("hub/status", 1);
    mqttUp = true;
    Serial.printf("mqtt: connected to %s as %s\n", cfg.hub.c_str(), cfg.id.c_str());
    core.broker(nowInfo(), true);
  } else {
    const uint32_t wait = kMqttBackoffMs[mqttBackoff];
    nextMqttTry = now + wait;
    if (mqttBackoff < 4) mqttBackoff++;
    Serial.printf("mqtt: connect failed (error %d, code %d), retrying in %lu s\n", mqtt.lastError(), mqtt.returnCode(),
                  (unsigned long)(wait / 1000));
  }
}

static void handleInbox() {
  while (!inbox.empty()) {
    auto [topic, payload] = inbox.front();
    inbox.pop_front();
    std::string kind;
    if (topic == "hub/status") kind = "hub";
    else if (topic.rfind(topicBase.c_str(), 0) == 0) kind = topic.substr(topicBase.length());
    else continue;
    core.message(nowInfo(), kind, payload);
    apply();
  }
}

// ---------------------------------------------------------------- serial console

static void printHelp() {
  Serial.println(
      "commands:\n"
      "  set id BOX-01 | set pass <password> | set net eth|wifi | set ip 10.102.40.101|dhcp\n"
      "  set mask 255.255.0.0 | set hub 10.102.40.10 | set port 1883\n"
      "  set ssid <name> | set wifipass <password> | set door on|off\n"
      "  show | status | reboot | forget-fobs | factory-reset | help");
}

static void printStatus() {
  Serial.printf("fw %s, uptime %llu s\n", FW_VERSION, monoMs() / 1000);
  Serial.printf("lock %s (%s), show %s, fobs %s (%u), hub %s\n", core.locked() ? "locked" : "open", core.why().c_str(),
                core.show() ? "on" : "off", core.hasList() ? "stored" : "none", (unsigned)core.fobCount(),
                core.hubReachable() ? "reachable" : "unreachable");
  Serial.printf("net %s %s, mqtt %s, reader %s, door %s, clock %s\n", cfg.net.c_str(), netReady() ? localIp().c_str() : "down",
                mqttUp ? "up" : "down", readerOk() ? "ok" : "not answering", doorStable ? "open" : "shut",
                nowInfo().clock_set ? boxcore::isoUtc(nowInfo().utc_ms).c_str() : "not set");
}

static void consoleLine(String line) {
  line.trim();
  if (line.isEmpty()) return;
  const int sp1 = line.indexOf(' ');
  const String cmd = sp1 < 0 ? line : line.substring(0, sp1);
  if (cmd == "set") {
    String rest = line.substring(sp1 + 1);
    rest.trim();
    const int sp2 = rest.indexOf(' ');
    const String key = sp2 < 0 ? rest : rest.substring(0, sp2);
    String val = sp2 < 0 ? "" : rest.substring(sp2 + 1);
    val.trim();
    const String err = configSet(cfg, key, val);
    if (err.length()) Serial.println("ERR " + err);
    else {
      configSave(cfg);
      Serial.println("OK " + key + " (takes effect after reboot)");
    }
  } else if (cmd == "show") {
    configPrint(cfg, Serial);
    Serial.println("OK");
  } else if (cmd == "status") {
    printStatus();
    Serial.println("OK");
  } else if (cmd == "reboot") {
    Serial.println("OK rebooting");
    delay(100);
    ESP.restart();
  } else if (cmd == "forget-fobs") {
    fobstoreErase();
    Serial.println("OK fobs list erased (box is unlocked until the hub sends a new one, after reboot)");
  } else if (cmd == "factory-reset") {
    configErase();
    fobstoreErase();
    Serial.println("OK settings and fobs list erased, rebooting");
    delay(100);
    ESP.restart();
  } else if (cmd == "help") {
    printHelp();
    Serial.println("OK");
  } else {
    Serial.println("ERR unknown command (type help)");
  }
}

static void consolePoll() {
  static String buf;
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      consoleLine(buf);
      buf = "";
    } else if (buf.length() < 200) {
      buf += c;
    }
  }
}

// ---------------------------------------------------------------- setup / loop

void setup() {
  // Lock first: LOW before OUTPUT so there is no glitch; box_core decides after boot.
  digitalWrite(PIN_LOCK, LOW);
  pinMode(PIN_LOCK, OUTPUT);
  pinMode(PIN_DOOR, INPUT_PULLUP);

  Serial.begin(115200);
  delay(50);
  Serial.printf("\ntech-access box firmware %s\n", FW_VERSION);

  esp_task_wdt_config_t wdt = {.timeout_ms = kWatchdogS * 1000, .idle_core_mask = 0, .trigger_panic = true};
  esp_task_wdt_reconfigure(&wdt);
  esp_task_wdt_add(nullptr);

  configLoad(cfg);
  provisioned = cfg.complete();
  topicBase = "box/" + cfg.id + "/";

  // Rollback bookkeeping. "try" = the version we flashed before the last reboot.
  boxcore::BootInfo bi;
  bi.fw = FW_VERSION;
  bi.door_sensor = cfg.door;
  esp_ota_img_states_t st;
  if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &st) == ESP_OK) bi.ota_pending_verify = st == ESP_OTA_IMG_PENDING_VERIFY;
  const String tried = nvsGet("try");
  if (tried.length() && tried != FW_VERSION) {
    bi.rolled_back_from = tried.c_str();
    nvsPut("try", "");
  }

  fobstoreBegin();
  std::string stored;
  if (fobstoreLoad(stored)) bi.stored_fobs = &stored;

  doorRaw = doorStable = digitalRead(PIN_DOOR) == HIGH;  // HIGH = open
  core.boot(nowInfo(), bi);
  if (cfg.door) core.door(nowInfo(), !doorStable);
  apply();

  if (!provisioned) {
    Serial.println("not provisioned: set id, pass, net, ip (and ssid for Wi-Fi), then reboot. Type help.");
  } else {
    IPAddress hubIp;
    hubIp.fromString(cfg.hub);
    mqtt.begin(hubIp, cfg.port, netClient);
    // Last will exactly as docs/mqtt.md: if the box drops off, the hub's view becomes "open".
    mqtt.setWill((topicBase + "state").c_str(), willPayload.c_str(), true, 1);
    mqtt.setKeepAlive(15);
    mqtt.setCleanSession(true);  // never get old commands queued for us
    mqtt.setTimeout(2000);
    mqtt.onMessageAdvanced(onMqtt);
    netBegin();
  }
  readerBegin();
}

void loop() {
  feed();
  consolePoll();
  const uint64_t now = monoMs();

  if (cfg.door) {
    const bool raw = digitalRead(PIN_DOOR) == HIGH;
    if (raw != doorRaw) {
      doorRaw = raw;
      doorChangedAt = now;
    } else if (raw != doorStable && now - doorChangedAt >= kDoorDebounceMs) {
      doorStable = raw;
      core.door(nowInfo(), !doorStable);
    }
  }

  if (now >= nextReaderPoll) {
    nextReaderPoll = now + kReaderPollMs;
    std::string tap;
    if (debounce.poll(now, readerPoll(now), tap)) {
      Serial.printf("tap: %s\n", tap.c_str());
      core.tap(nowInfo(), tap);
    }
  }

  if (provisioned && netStarted) {
    mqttMaintain(now);
    if (mqttUp) mqtt.loop();
    handleInbox();
  }

  core.tick(nowInfo());
  apply();
  delay(5);
}
