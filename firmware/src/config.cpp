#include "config.h"

#include <Preferences.h>

static bool validIp(const String& s) {
  IPAddress a;
  return a.fromString(s);
}

void configLoad(BoxConfig& c) {
  Preferences p;
  p.begin("box", true);
  c.id = p.getString("id", "");
  c.pass = p.getString("pass", "");
  c.net = p.getString("net", BOX_NET_DEFAULT_ETH ? "eth" : "wifi");
  c.ip = p.getString("ip", "");
  c.mask = p.getString("mask", "255.255.0.0");
  c.hub = p.getString("hub", "10.102.40.10");
  c.port = p.getUShort("port", 1883);
  c.ssid = p.getString("ssid", "");
  c.wifiPass = p.getString("wifipass", "");
  c.door = p.getBool("door", true);
  p.end();
}

String configSet(BoxConfig& c, const String& key, const String& v) {
  if (key == "id") {
    if (v.isEmpty() || v == "hub") return "id must be a Box ID like BOX-01";
    for (char ch : v)
      if (!isalnum(ch) && ch != '-' && ch != '_') return "id: letters, digits, - and _ only";
    c.id = v;
  } else if (key == "pass") {
    if (v.length() < 8) return "pass looks too short (use the one from mqtt-add-box.sh)";
    c.pass = v;
  } else if (key == "net") {
    if (v != "eth" && v != "wifi") return "net must be eth or wifi";
    c.net = v;
  } else if (key == "ip") {
    if (!v.isEmpty() && v != "dhcp" && !validIp(v)) return "ip must look like 10.102.40.101 (or dhcp)";
    c.ip = v == "dhcp" ? "" : v;
  } else if (key == "mask") {
    if (!validIp(v)) return "mask must look like 255.255.0.0";
    c.mask = v;
  } else if (key == "hub") {
    if (!validIp(v)) return "hub must be an IP address like 10.102.40.10";
    c.hub = v;
  } else if (key == "port") {
    long n = v.toInt();
    if (n < 1 || n > 65535) return "port must be 1-65535";
    c.port = static_cast<uint16_t>(n);
  } else if (key == "ssid") {
    c.ssid = v;
  } else if (key == "wifipass") {
    c.wifiPass = v;
  } else if (key == "door") {
    if (v != "on" && v != "off") return "door must be on or off";
    c.door = v == "on";
  } else {
    return "unknown setting '" + key + "' (id, pass, net, ip, mask, hub, port, ssid, wifipass, door)";
  }
  return "";
}

void configSave(const BoxConfig& c) {
  Preferences p;
  p.begin("box", false);
  p.putString("id", c.id);
  p.putString("pass", c.pass);
  p.putString("net", c.net);
  p.putString("ip", c.ip);
  p.putString("mask", c.mask);
  p.putString("hub", c.hub);
  p.putUShort("port", c.port);
  p.putString("ssid", c.ssid);
  p.putString("wifipass", c.wifiPass);
  p.putBool("door", c.door);
  p.end();
}

void configPrint(const BoxConfig& c, Print& out) {
  out.printf("id       %s\n", c.id.c_str());
  out.printf("pass     %s\n", c.pass.isEmpty() ? "(not set)" : "(set)");
  out.printf("net      %s\n", c.net.c_str());
  out.printf("ip       %s\n", c.ip.isEmpty() ? "(dhcp)" : c.ip.c_str());
  out.printf("mask     %s\n", c.mask.c_str());
  out.printf("hub      %s\n", c.hub.c_str());
  out.printf("port     %u\n", c.port);
  out.printf("ssid     %s\n", c.ssid.c_str());
  out.printf("wifipass %s\n", c.wifiPass.isEmpty() ? "(not set)" : "(set)");
  out.printf("door     %s\n", c.door ? "on" : "off");
}

void configErase() {
  Preferences p;
  p.begin("box", false);
  p.clear();
  p.end();
}

String nvsGet(const char* key) {
  Preferences p;
  p.begin("ota", true);
  String v = p.getString(key, "");
  p.end();
  return v;
}

void nvsPut(const char* key, const String& value) {
  Preferences p;
  p.begin("ota", false);
  if (value.isEmpty()) p.remove(key);
  else p.putString(key, value);
  p.end();
}
