#include "ota.h"

#include <HTTPClient.h>
#include <Update.h>
#include <mbedtls/sha256.h>

bool otaRun(NetworkClient& net, const String& url, const String& sha256, uint32_t size, String& why, void (*feed)()) {
  HTTPClient http;
  http.setTimeout(10000);
  http.setConnectTimeout(5000);
  if (!http.begin(net, url)) {
    why = "bad_url";
    return false;
  }
  const int code = http.GET();
  if (code != 200) {
    why = "http_" + String(code);
    http.end();
    return false;
  }
  const int len = http.getSize();
  if (len != static_cast<int>(size)) {
    why = "size_mismatch";
    http.end();
    return false;
  }
  if (!Update.begin(size, U_FLASH)) {
    why = "no_space";
    http.end();
    return false;
  }
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  Stream* s = http.getStreamPtr();
  uint8_t buf[1024];
  uint32_t got = 0;
  uint32_t lastData = millis();
  while (got < size) {
    feed();
    const int avail = s->available();
    if (avail <= 0) {
      if (!http.connected() || millis() - lastData > 10000) break;
      delay(2);
      continue;
    }
    const int n = s->readBytes(buf, min(static_cast<uint32_t>(sizeof buf), min(static_cast<uint32_t>(avail), size - got)));
    if (n <= 0) continue;
    lastData = millis();
    mbedtls_sha256_update(&ctx, buf, n);
    if (Update.write(buf, n) != static_cast<size_t>(n)) {
      why = "flash_write_failed";
      Update.abort();
      mbedtls_sha256_free(&ctx);
      http.end();
      return false;
    }
    got += n;
  }
  http.end();
  uint8_t digest[32];
  mbedtls_sha256_finish(&ctx, digest);
  mbedtls_sha256_free(&ctx);
  if (got != size) {
    why = "download_incomplete";
    Update.abort();
    return false;
  }
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", digest[i]);
  if (!sha256.equalsIgnoreCase(hex)) {
    why = "sha256_mismatch";
    Update.abort();
    return false;
  }
  if (!Update.end(false)) {  // also checks the image header and sets it as the next boot slot
    why = "flash_failed";
    return false;
  }
  return true;
}
