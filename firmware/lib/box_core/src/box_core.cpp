// box_core: see box_core.h. Plain C++17 + ArduinoJson (header-only, no Arduino needed).
#include "box_core.h"

#include <ArduinoJson.h>

#include <cctype>
#include <cstdio>
#include <utility>

namespace boxcore {

namespace {

bool isHex(char c) { return std::isxdigit(static_cast<unsigned char>(c)) != 0; }

bool isDate(const std::string& s) {
  if (s.size() != 10 || s[4] != '-' || s[7] != '-') return false;
  for (size_t i : {0, 1, 2, 3, 5, 6, 8, 9})
    if (!std::isdigit(static_cast<unsigned char>(s[i]))) return false;
  return true;
}

// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
int64_t daysFromCivil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

void civilFromDays(int64_t z, int64_t& y, unsigned& m, unsigned& d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  y = static_cast<int64_t>(yoe) + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  d = doy - (153 * mp + 2) / 5 + 1;
  m = mp < 10 ? mp + 3 : mp - 9;
  y += m <= 2;
}

int64_t floorDiv(int64_t a, int64_t b) { return a / b - ((a % b != 0) && ((a < 0) != (b < 0))); }

/** Unix ms of 01:00 UTC on the last Sunday of the month (UK clock change). */
int64_t lastSundayOneUtc(int64_t year, unsigned month) {
  static const unsigned kDays[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  const int64_t last = daysFromCivil(year, month, kDays[month - 1]);  // March and October: 31
  const int64_t weekday = ((last + 4) % 7 + 7) % 7;  // 1970-01-01 was a Thursday; 0 = Sunday
  return (last - weekday) * 86400000LL + 3600000LL;
}

std::string toJson(const JsonDocument& doc) {
  std::string s;
  serializeJson(doc, s);
  return s;
}

}  // namespace

// ---------------- Helpers ----------------

bool parseIsoUtc(const std::string& s, int64_t& out) {
  // YYYY-MM-DDTHH:MM:SS[.fff]Z
  if (s.size() < 20 || s.back() != 'Z' || s[10] != 'T' || s[13] != ':' || s[16] != ':') return false;
  if (!isDate(s.substr(0, 10))) return false;
  auto num = [&](size_t at, size_t n, int& v) {
    v = 0;
    for (size_t i = at; i < at + n; i++) {
      if (!std::isdigit(static_cast<unsigned char>(s[i]))) return false;
      v = v * 10 + (s[i] - '0');
    }
    return true;
  };
  int y, mo, d, h, mi, se, ms = 0;
  if (!num(0, 4, y) || !num(5, 2, mo) || !num(8, 2, d) || !num(11, 2, h) || !num(14, 2, mi) || !num(17, 2, se)) return false;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return false;
  size_t i = 19;
  if (s[i] == '.') {
    i++;
    int digits = 0;
    while (i < s.size() - 1) {
      if (!std::isdigit(static_cast<unsigned char>(s[i]))) return false;
      if (digits < 3) ms = ms * 10 + (s[i] - '0');
      digits++;
      i++;
    }
    if (digits == 0) return false;
    for (; digits < 3; digits++) ms *= 10;
  }
  if (i != s.size() - 1) return false;
  out = ((daysFromCivil(y, mo, d) * 24 + h) * 60 + mi) * 60000LL + se * 1000LL + ms;
  return true;
}

std::string isoUtc(int64_t ms) {
  const int64_t days = floorDiv(ms, 86400000LL);
  int64_t rem = ms - days * 86400000LL;
  int64_t y;
  unsigned m, d;
  civilFromDays(days, y, m, d);
  char buf[32];
  std::snprintf(buf, sizeof buf, "%04d-%02u-%02uT%02d:%02d:%02d.%03dZ", static_cast<int>(y), m, d,
                static_cast<int>(rem / 3600000), static_cast<int>(rem / 60000 % 60),
                static_cast<int>(rem / 1000 % 60), static_cast<int>(rem % 1000));
  return buf;
}

std::string londonDate(int64_t utc_ms) {
  int64_t y;
  unsigned m, d;
  civilFromDays(floorDiv(utc_ms, 86400000LL), y, m, d);
  const bool bst = utc_ms >= lastSundayOneUtc(y, 3) && utc_ms < lastSundayOneUtc(y, 10);
  const int64_t local = utc_ms + (bst ? 3600000LL : 0);
  civilFromDays(floorDiv(local, 86400000LL), y, m, d);
  char buf[16];
  std::snprintf(buf, sizeof buf, "%04d-%02u-%02u", static_cast<int>(y), m, d);
  return buf;
}

bool normaliseUid(const std::string& in, std::string& out) {
  if (in.size() != 8 && in.size() != 14 && in.size() != 20) return false;
  std::string r;
  r.reserve(in.size());
  for (char c : in) {
    if (!isHex(c)) return false;
    r.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(c))));
  }
  out = r;
  return true;
}

bool TapDebouncer::poll(uint64_t mono, const std::string& uid, std::string& tap) {
  if (uid.empty()) {
    if (have_ && mono - last_seen_ >= kAwayMs) have_ = false;
    return false;
  }
  const bool fresh = !have_ || uid != present_ || mono - last_seen_ >= kAwayMs;
  present_ = uid;
  have_ = true;
  last_seen_ = mono;
  if (fresh) tap = uid;
  return fresh;
}

// ---------------- Box ----------------

void Box::boot(const Now& now, const BootInfo& info) {
  *this = Box();
  fw_ = info.fw;
  door_sensor_ = info.door_sensor;
  ota_pending_verify_ = info.ota_pending_verify;
  boot_ms_ = now.mono_ms;
  offline_since_ = now.mono_ms;  // the hub hasn't been seen yet
  last_hb_ = now.mono_ms;
  if (info.stored_fobs) applyFobs(*info.stored_fobs);
  if (!info.rolled_back_from.empty()) {
    ota_status_ = "rolled_back";
    ota_why_ = "new firmware didn't reach the hub";
    ota_version_ = info.rolled_back_from;
  }
  evaluate(now, true);
}

std::vector<Action> Box::take() { return std::exchange(out_, {}); }

void Box::tick(const Now& now) {
  if (ota_pending_verify_ && now.mono_ms - boot_ms_ >= kOtaVerifyMs) {
    ota_pending_verify_ = false;
    Action a{ActionType::RollbackReboot};
    out_.push_back(a);
    return;
  }
  evaluate(now);
  if (broker_ && now.mono_ms - last_hb_ >= kHeartbeatMs) publishHeartbeat(now);
}

void Box::evaluate(const Now& now, bool force_state) {
  if (!hubReachable() && !offline_unlocked_ && now.mono_ms - offline_since_ >= uint64_t(offline_min_) * 60000ULL) {
    offline_unlocked_ = true;
  }
  if (open_until_ && now.mono_ms >= open_until_) {
    open_until_ = 0;
    open_why_.clear();
  }
  std::string why;
  if (show_) why = "show";
  else if (offline_unlocked_) why = "offline";
  else if (!has_list_) why = "no_list";
  else if (open_until_) why = open_why_;
  const bool want_locked = why.empty();
  if (want_locked) why = locked_why_;
  else locked_why_.clear();

  if (!lock_known_ || want_locked != locked_) {
    Action a{ActionType::SetLock};
    a.locked = want_locked;
    out_.push_back(a);
    locked_ = want_locked;
    lock_known_ = true;
    why_ = why;
    state_dirty_ = true;
  } else if (why != why_) {
    why_ = why;
    state_dirty_ = true;
  }
  if (force_state) state_dirty_ = true;
  if (state_dirty_ && broker_) publishState(now);
}

void Box::publish(const std::string& topic, const std::string& payload, bool retain, int qos) {
  Action a{ActionType::Publish};
  a.topic = topic;
  a.payload = payload;
  a.retain = retain;
  a.qos = qos;
  out_.push_back(a);
}

void Box::publishState(const Now& now) {
  JsonDocument doc;
  doc["lock"] = locked_ ? "locked" : "open";
  if (!why_.empty()) doc["why"] = why_;
  if (door_sensor_ && door_known_) doc["door"] = door_shut_ ? "shut" : "open";
  if (now.clock_set) doc["ts"] = isoUtc(now.utc_ms);
  else doc["ts"] = nullptr;
  if (have_ref_) doc["ref"] = ref_;
  doc["fw"] = fw_;
  if (!ota_status_.empty()) {
    doc["ota"] = ota_status_;
    if (!ota_version_.empty()) doc["ota_version"] = ota_version_;
    if (!ota_why_.empty()) doc["ota_why"] = ota_why_;
  }
  publish("state", toJson(doc), true, 1);
  state_dirty_ = false;
  have_ref_ = false;
  if (ota_status_ != "updating") {  // results are reported once; "updating" stays until done
    ota_status_.clear();
    ota_why_.clear();
    ota_version_.clear();
  }
}

void Box::publishHeartbeat(const Now& now) {
  JsonDocument doc;
  if (now.clock_set) doc["ts"] = isoUtc(now.utc_ms);
  else doc["ts"] = nullptr;
  doc["fw"] = fw_;
  doc["uptime_s"] = (now.mono_ms - boot_ms_) / 1000;
  if (!ip_.empty()) doc["ip"] = ip_;
  publish("heartbeat", toJson(doc), false, 0);
  last_hb_ = now.mono_ms;
  // Rollback guard: the new image has reached the broker and sent a heartbeat, so it works.
  if (ota_pending_verify_) {
    ota_pending_verify_ = false;
    out_.push_back(Action{ActionType::MarkAppValid});
    ota_status_ = "updated";
    ota_version_ = fw_;
    publishState(now);
  }
}

void Box::flushTaps() {
  while (!tap_queue_.empty()) {
    publish("tap", tap_queue_.front(), false, 1);
    tap_queue_.pop_front();
  }
}

void Box::setHubReachable(const Now& now, bool before) {
  const bool after = hubReachable();
  if (before && !after) offline_since_ = now.mono_ms;
  if (after) offline_unlocked_ = false;
  if (after && !before) flushTaps();  // taps made while the hub was away
}

void Box::broker(const Now& now, bool connected) {
  const bool before = hubReachable();
  broker_ = connected;
  if (!connected) hub_online_ = false;  // hub/status is retained: it comes back on resubscribe
  setHubReachable(now, before);
  if (connected) {
    evaluate(now, true);  // publishes state
    publishHeartbeat(now);
  } else {
    evaluate(now);
  }
}

void Box::door(const Now& now, bool shut) {
  if (door_known_ && shut == door_shut_) return;
  door_known_ = true;
  door_shut_ = shut;
  state_dirty_ = true;
  evaluate(now);
}

void Box::tap(const Now& now, const std::string& raw) {
  std::string uid;
  if (!normaliseUid(raw, uid)) return;
  last_tap_ = now.mono_ms;
  any_tap_ = true;
  const char* result = "deny";
  const char* reason = "not_listed";
  if (show_) {
    result = "allow", reason = "show";
  } else if (offline_unlocked_) {
    result = "allow", reason = "offline";
  } else if (!has_list_) {
    result = "allow", reason = "no_list";
  } else {
    for (const auto& f : fobs_) {
      if (f.uid != uid) continue;
      if (f.until.empty()) result = "allow", reason = "listed";
      else if (!now.clock_set) reason = "no_clock";
      else if (londonDate(now.utc_ms) > f.until) reason = "day_pass_expired";
      else result = "allow", reason = "listed";
      break;
    }
    if (std::string(reason) == "listed") {
      open_until_ = now.mono_ms + kTapOpenMs;
      open_why_ = "fob";
    }
  }
  JsonDocument doc;
  doc["uid"] = uid;
  doc["result"] = result;
  doc["reason"] = reason;
  doc["source"] = hubReachable() ? "cached" : "offline";
  if (now.clock_set) doc["ts"] = isoUtc(now.utc_ms);
  else doc["ts"] = nullptr;
  doc["fw"] = fw_;
  const std::string payload = toJson(doc);
  // Only send when the hub is there to log it: with the hub down, a broker with no subscriber
  // would drop it. Queued taps go out when hub/status says online again.
  if (hubReachable()) {
    publish("tap", payload, false, 1);
  } else {
    tap_queue_.push_back(payload);
    while (tap_queue_.size() > kTapQueueMax) tap_queue_.pop_front();
  }
  evaluate(now);
}

void Box::message(const Now& now, const std::string& kind, const std::string& payload) {
  if (kind == "cmd") onCmd(now, payload);
  else if (kind == "mode") onMode(now, payload);
  else if (kind == "ota") onOta(now, payload);
  else if (kind == "fobs") {
    if (applyFobs(payload)) {
      Action a{ActionType::StoreFobs};
      a.payload = payload;
      out_.push_back(a);
    }
    evaluate(now);
  } else if (kind == "hub") {
    JsonDocument doc;
    bool online = false;
    if (!payload.empty() && !deserializeJson(doc, payload) && doc["online"].is<bool>()) online = doc["online"].as<bool>();
    const bool before = hubReachable();
    hub_online_ = online && broker_;
    setHubReachable(now, before);
    evaluate(now);
  }
}

bool Box::applyFobs(const std::string& payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return false;
  if (!doc["v"].is<int>() || doc["v"].as<int>() != 1) return false;  // unknown format: keep the old list
  JsonArrayConst arr = doc["fobs"].as<JsonArrayConst>();
  if (arr.isNull() || arr.size() > kMaxFobs) return false;
  std::vector<FobEntry> list;
  list.reserve(arr.size());
  for (JsonVariantConst e : arr) {
    FobEntry f;
    if (!e["uid"].is<const char*>() || !normaliseUid(e["uid"].as<const char*>(), f.uid)) continue;
    if (!e["until"].isNull()) {
      if (!e["until"].is<const char*>()) continue;
      f.until = e["until"].as<const char*>();
      if (!isDate(f.until)) continue;  // can't read the date: leave the fob out (deny, not allow)
    }
    list.push_back(std::move(f));
  }
  fobs_ = std::move(list);
  has_list_ = true;
  JsonVariantConst m = doc["offline_unlock_min"];
  if (m.is<int>() && m.as<int>() >= 0) offline_min_ = m.as<int>() > 1440 ? 1440 : static_cast<uint32_t>(m.as<int>());
  else offline_min_ = kDefaultOfflineMin;
  return true;
}

void Box::onCmd(const Now& now, const std::string& payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload) || !doc["cmd"].is<const char*>()) return;
  const std::string cmd = doc["cmd"].as<const char*>();
  if (cmd != "open" && cmd != "lock") return;
  // Stale commands are ignored. With no clock yet we can't tell, so the command is accepted
  // (Daniel's answer, step 0): the broker never queues commands for an offline box.
  if (now.clock_set) {
    int64_t exp;
    if (!doc["expires"].is<const char*>() || !parseIsoUtc(doc["expires"].as<const char*>(), exp)) return;
    if (exp <= now.utc_ms) return;
  }
  have_ref_ = doc["ref"].is<int64_t>();
  ref_ = have_ref_ ? doc["ref"].as<int64_t>() : 0;
  if (cmd == "open") {
    uint32_t s = kDefaultCmdOpenS;
    if (doc["seconds"].is<int>() && doc["seconds"].as<int>() > 0) s = static_cast<uint32_t>(doc["seconds"].as<int>());
    if (s > kMaxCmdOpenS) s = kMaxCmdOpenS;
    open_until_ = now.mono_ms + s * 1000ULL;
    open_why_ = "cmd";
  } else {
    open_until_ = 0;
    open_why_.clear();
    locked_why_ = "cmd";
  }
  state_dirty_ = true;  // always answer, so the hub can match ref
  evaluate(now);
}

void Box::onMode(const Now& now, const std::string& payload) {
  bool show = false;  // an empty (cleared) retained message = no show mode
  if (!payload.empty()) {
    JsonDocument doc;
    if (deserializeJson(doc, payload) || !doc["show"].is<bool>()) return;
    show = doc["show"].as<bool>();
  }
  show_ = show;
  evaluate(now);
}

void Box::otaRefuse(const Now& now, const char* why, const std::string& version) {
  if (ota_busy_) return;  // one update at a time; the one in progress reports its own result
  ota_status_ = "refused";
  ota_why_ = why;
  ota_version_ = version;
  state_dirty_ = true;
  evaluate(now);
}

void Box::onOta(const Now& now, const std::string& payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return otaRefuse(now, "bad_request", "");
  const std::string version = doc["version"] | "";
  const std::string url = doc["url"] | "";
  const std::string sha = doc["sha256"] | "";
  const int64_t size = doc["size"] | int64_t(0);
  bool sha_ok = sha.size() == 64;
  for (char c : sha) sha_ok = sha_ok && isHex(c);
  if (version.empty() || url.rfind("http://", 0) != 0 || !sha_ok || size <= 0) return otaRefuse(now, "bad_request", version);
  if (ota_busy_) return;  // already updating
  if (now.clock_set) {
    int64_t exp;
    if (!doc["expires"].is<const char*>() || !parseIsoUtc(doc["expires"].as<const char*>(), exp) || exp <= now.utc_ms)
      return otaRefuse(now, "expired", version);
  }
  if (version == fw_) return otaRefuse(now, "already_running", version);
  if (show_) return otaRefuse(now, "show_mode", version);
  if (!locked_) return otaRefuse(now, "unlocked", version);
  if (any_tap_ && now.mono_ms - last_tap_ < kMidTapMs) return otaRefuse(now, "mid_tap", version);

  Action a{ActionType::StartOta};
  a.url = url;
  a.sha256 = sha;
  a.size = static_cast<uint32_t>(size);
  a.version = version;
  out_.push_back(a);
  ota_busy_ = true;
  ota_status_ = "updating";
  ota_why_.clear();
  ota_version_ = version;
  state_dirty_ = true;
  evaluate(now);
}

void Box::otaResult(const Now& now, bool ok, const std::string& why) {
  if (!ota_busy_) return;
  ota_busy_ = false;
  ota_status_ = ok ? "rebooting" : "failed";
  ota_why_ = ok ? "" : why;
  state_dirty_ = true;
  evaluate(now);
}

}  // namespace boxcore
