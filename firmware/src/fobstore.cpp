#include "fobstore.h"

#include <LittleFS.h>

static const char* kFile = "/list.json";
static const char* kTmp = "/list.tmp";
static bool mounted = false;

bool fobstoreBegin() {
  mounted = LittleFS.begin(true, "/fobs", 2, "fobs");
  if (!mounted) Serial.println("fobs: flash store unavailable (list kept in RAM only)");
  return mounted;
}

bool fobstoreLoad(std::string& out) {
  if (!mounted || !LittleFS.exists(kFile)) return false;
  File f = LittleFS.open(kFile, "r");
  if (!f) return false;
  out.clear();
  out.reserve(f.size());
  while (f.available()) out.push_back(static_cast<char>(f.read()));
  f.close();
  return !out.empty();
}

bool fobstoreSave(const std::string& json) {
  if (!mounted) return false;
  std::string old;
  if (fobstoreLoad(old) && old == json) return true;
  File f = LittleFS.open(kTmp, "w");
  if (!f) return false;
  const size_t n = f.write(reinterpret_cast<const uint8_t*>(json.data()), json.size());
  f.close();
  if (n != json.size()) return false;
  LittleFS.remove(kFile);  // rename doesn't replace on LittleFS
  return LittleFS.rename(kTmp, kFile);
}

void fobstoreErase() {
  if (!mounted) return;
  LittleFS.remove(kFile);
  LittleFS.remove(kTmp);
}
