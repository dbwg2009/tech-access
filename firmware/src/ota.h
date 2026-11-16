// Download a firmware image over HTTP from the Pi, check its size and sha256, flash it into the
// other app slot. The bootloader's app rollback (enabled in Arduino-ESP32 3.3.12) boots it as
// "pending verify"; main.cpp marks it valid once it has reached MQTT (box_core decides when).
#pragma once
#include <Arduino.h>
#include <NetworkClient.h>

/** Blocking (about 10-20 s on the LAN). feed() is called between chunks (watchdog, etc.). */
bool otaRun(NetworkClient& net, const String& url, const String& sha256, uint32_t size, String& why, void (*feed)());
