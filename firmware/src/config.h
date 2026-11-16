// Per-box settings in NVS (namespace "box"), set over USB with the serial console
// (tools/provision.py). Nothing here is in git: the password comes from pi/mqtt-add-box.sh.
#pragma once
#include <Arduino.h>

struct BoxConfig {
  String id;                    // BOX-01: MQTT username and topic prefix
  String pass;                  // MQTT password
  String net;                   // "eth" or "wifi"
  String ip;                    // static IP, e.g. 10.102.40.101 ("" = DHCP, Wi-Fi only)
  String mask = "255.255.0.0";  // show network is a /16 with no gateway
  String hub = "10.102.40.10";  // MQTT broker, firmware server and NTP server (the Pi)
  uint16_t port = 1883;
  String ssid;                  // Wi-Fi only
  String wifiPass;
  bool door = true;             // reed switch fitted

  bool complete() const { return id.length() && pass.length() && hub.length() && (net == "eth" ? ip.length() > 0 : ssid.length() > 0); }
};

void configLoad(BoxConfig& c);
/** Set one key from the console. Returns an error message, or "" when it worked. */
String configSet(BoxConfig& c, const String& key, const String& value);
void configSave(const BoxConfig& c);
void configPrint(const BoxConfig& c, Print& out);
void configErase();

/** One-shot NVS values used by OTA. */
String nvsGet(const char* key);
void nvsPut(const char* key, const String& value);
