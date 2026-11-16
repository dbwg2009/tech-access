// Native unit tests for box_core: `pio test -e native`.
// Most rules are checked by the shared vectors in test/vectors/*.json (the box simulator runs
// the same files). The helpers below get direct tests.
#include <ArduinoJson.h>
#include <unity.h>

#include <box_core.h>

#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#ifndef VECTORS_DIR
#error "VECTORS_DIR must be set (see platformio.ini, env:native)"
#endif

using namespace boxcore;

void setUp() {}
void tearDown() {}

// ------------------------------------------------------------------ helpers

static void test_iso_round_trip() {
  int64_t ms;
  TEST_ASSERT_TRUE(parseIsoUtc("2026-11-16T18:00:15.000Z", ms));
  TEST_ASSERT_EQUAL_INT64(1794852015000LL, ms);
  TEST_ASSERT_EQUAL_STRING("2026-11-16T18:00:15.000Z", isoUtc(ms).c_str());
  TEST_ASSERT_TRUE(parseIsoUtc("2026-11-16T18:00:15Z", ms));
  TEST_ASSERT_EQUAL_INT64(1794852015000LL, ms);
  TEST_ASSERT_TRUE(parseIsoUtc("2026-11-16T18:00:15.5Z", ms));
  TEST_ASSERT_EQUAL_INT64(1794852015500LL, ms);
  TEST_ASSERT_FALSE(parseIsoUtc("2026-11-16 18:00:15Z", ms));
  TEST_ASSERT_FALSE(parseIsoUtc("2026-11-16T18:00:15+01:00", ms));
  TEST_ASSERT_FALSE(parseIsoUtc("", ms));
}

static void test_london_date() {
  int64_t ms;
  // BST 2026: 29 March 01:00 UTC to 25 October 01:00 UTC.
  parseIsoUtc("2026-03-29T00:59:59.999Z", ms);
  TEST_ASSERT_EQUAL_STRING("2026-03-29", londonDate(ms).c_str());
  parseIsoUtc("2026-03-28T23:30:00.000Z", ms);
  TEST_ASSERT_EQUAL_STRING("2026-03-28", londonDate(ms).c_str());  // still GMT
  parseIsoUtc("2026-07-15T23:00:00.000Z", ms);
  TEST_ASSERT_EQUAL_STRING("2026-07-16", londonDate(ms).c_str());  // BST
  parseIsoUtc("2026-07-15T22:59:59.999Z", ms);
  TEST_ASSERT_EQUAL_STRING("2026-07-15", londonDate(ms).c_str());
  parseIsoUtc("2026-10-24T23:30:00.000Z", ms);
  TEST_ASSERT_EQUAL_STRING("2026-10-25", londonDate(ms).c_str());  // BST until 01:00 UTC on the 25th
  parseIsoUtc("2026-10-25T23:30:00.000Z", ms);
  TEST_ASSERT_EQUAL_STRING("2026-10-25", londonDate(ms).c_str());  // GMT again
  parseIsoUtc("2028-02-29T12:00:00.000Z", ms);
  TEST_ASSERT_EQUAL_STRING("2028-02-29", londonDate(ms).c_str());
}

static void test_normalise_uid() {
  std::string u;
  TEST_ASSERT_TRUE(normaliseUid("04a1b2c3d4e5f6", u));
  TEST_ASSERT_EQUAL_STRING("04A1B2C3D4E5F6", u.c_str());
  TEST_ASSERT_TRUE(normaliseUid("AABBCCDD", u));
  TEST_ASSERT_TRUE(normaliseUid("00112233445566778899", u));
  TEST_ASSERT_FALSE(normaliseUid("AABBCC", u));
  TEST_ASSERT_FALSE(normaliseUid("AA:BB:CC:DD", u));
  TEST_ASSERT_FALSE(normaliseUid("GGBBCCDD", u));
}

static void test_debounce() {
  TapDebouncer d;
  std::string t;
  TEST_ASSERT_TRUE(d.poll(0, "AABBCCDD", t));
  TEST_ASSERT_EQUAL_STRING("AABBCCDD", t.c_str());
  TEST_ASSERT_FALSE(d.poll(150, "AABBCCDD", t));   // held
  TEST_ASSERT_FALSE(d.poll(300, "", t));           // one missed poll
  TEST_ASSERT_FALSE(d.poll(450, "AABBCCDD", t));   // still the same tap
  TEST_ASSERT_TRUE(d.poll(600, "11223344", t));    // a different fob
  TEST_ASSERT_FALSE(d.poll(750, "", t));
  TEST_ASSERT_FALSE(d.poll(1200, "", t));          // gone 600 ms
  TEST_ASSERT_TRUE(d.poll(1350, "11223344", t));   // tapped again
}

static void test_tap_queue_keeps_newest() {
  Box b;
  std::string list = R"({"v":1,"offline_unlock_min":5,"fobs":[]})";
  BootInfo bi;
  bi.fw = "0.1.0";
  bi.stored_fobs = &list;
  Now n;
  n.clock_set = true;
  n.utc_ms = 1794852000000LL;
  b.boot(n, bi);
  char uid[9];
  for (int i = 0; i < 40; i++) {
    n.mono_ms = 1000 + i;
    std::snprintf(uid, sizeof uid, "%08X", i);
    b.tap(n, uid);
  }
  b.take();
  b.broker(n, true);
  b.message(n, "hub", R"({"online":true})");
  int taps = 0;
  std::string first;
  for (auto& a : b.take())
    if (a.type == ActionType::Publish && a.topic == "tap") {
      if (!taps) first = a.payload;
      taps++;
    }
  TEST_ASSERT_EQUAL(int(kTapQueueMax), taps);
  TEST_ASSERT_NOT_EQUAL(std::string::npos, first.find("00000008"));  // 0..7 dropped
}

static void test_boot_drives_the_lock() {
  // The hardware layer must get a SetLock on boot, whatever the state.
  Box b;
  BootInfo bi;
  bi.fw = "0.1.0";
  b.boot(Now{}, bi);
  auto acts = b.take();
  TEST_ASSERT_TRUE(!acts.empty());
  TEST_ASSERT_TRUE(acts[0].type == ActionType::SetLock);
  TEST_ASSERT_FALSE(acts[0].locked);  // no list yet: unlocked (Daniel's answer, step 0)
}

// ------------------------------------------------------------------ vectors

namespace {

std::string readFile(const std::string& path) {
  std::ifstream f(path);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

std::string json(JsonVariantConst v) {
  std::string s;
  serializeJson(v, s);
  return s;
}

const char* actionName(ActionType t) {
  switch (t) {
    case ActionType::SetLock: return "set_lock";
    case ActionType::Publish: return "publish";
    case ActionType::StoreFobs: return "store_fobs";
    case ActionType::StartOta: return "start_ota";
    case ActionType::MarkAppValid: return "mark_valid";
    case ActionType::RollbackReboot: return "rollback";
  }
  return "?";
}

struct Runner {
  std::vector<std::string> errors;
  std::string where;

  void fail(const std::string& msg) { errors.push_back(where + ": " + msg); }

  void runCase(JsonVariantConst defaults, JsonVariantConst c) {
    JsonDocument boot;
    boot.set(defaults);
    for (JsonPairConst kv : c["boot"].as<JsonObjectConst>()) boot[kv.key()] = kv.value();

    Box box;
    Now now;
    int64_t clock0 = 0;
    now.clock_set = false;
    if (boot["clock"].is<const char*>()) {
      parseIsoUtc(boot["clock"].as<const char*>(), clock0);
      now.clock_set = true;
      now.utc_ms = clock0;
    }
    BootInfo bi;
    bi.fw = boot["fw"] | "0.1.0";
    bi.door_sensor = boot["door_sensor"] | true;
    bi.ota_pending_verify = boot["ota_pending_verify"] | false;
    bi.rolled_back_from = boot["rolled_back_from"] | "";
    std::string fobs;
    if (boot["fobs"].is<const char*>()) fobs = boot["fobs"].as<const char*>();
    else if (!boot["fobs"].isNull()) fobs = json(boot["fobs"]);
    if (!boot["fobs"].isNull()) bi.stored_fobs = &fobs;
    box.boot(now, bi);

    std::vector<Action> window = box.take();
    int i = 0;
    for (JsonVariantConst s : c["steps"].as<JsonArrayConst>()) {
      where = std::string(c["name"].as<const char*>()) + " / step " + std::to_string(i++);
      now.mono_ms = s["at"].as<uint64_t>();
      if (now.clock_set) now.utc_ms = clock0 + int64_t(now.mono_ms);
      box.tick(now);
      if (!s["broker"].isNull()) box.broker(now, s["broker"].as<bool>());
      else if (!s["msg"].isNull()) {
        JsonVariantConst p = s["payload"];
        std::string payload = p.isNull() ? "" : p.is<const char*>() ? p.as<std::string>() : json(p);
        box.message(now, s["msg"].as<std::string>(), payload);
      } else if (!s["tap"].isNull()) box.tap(now, s["tap"].as<std::string>());
      else if (!s["door"].isNull()) box.door(now, s["door"].as<std::string>() == "shut");
      else if (!s["ntp"].isNull()) {
        int64_t t;
        parseIsoUtc(s["ntp"].as<const char*>(), t);
        clock0 = t - int64_t(now.mono_ms);
        now.clock_set = true;
        now.utc_ms = t;
      } else if (!s["ota_result"].isNull()) {
        box.otaResult(now, s["ota_result"]["ok"].as<bool>(), s["ota_result"]["why"] | "");
      }
      for (auto& a : box.take()) window.push_back(a);

      bool checked = false;
      if (!s["expect"].isNull()) {
        checked = true;
        JsonVariantConst e = s["expect"];
        if (!e["lock"].isNull() && e["lock"].as<std::string>() != (box.locked() ? "locked" : "open"))
          fail("lock is " + std::string(box.locked() ? "locked" : "open") + ", expected " + e["lock"].as<std::string>());
        if (!e["why"].isNull() && e["why"].as<std::string>() != box.why())
          fail("why is '" + box.why() + "', expected '" + e["why"].as<std::string>() + "'");
      }
      if (!s["publish"].isNull()) {
        checked = true;
        for (JsonVariantConst want : s["publish"].as<JsonArrayConst>()) checkPublish(window, want);
      }
      if (!s["no_publish"].isNull()) {
        checked = true;
        for (JsonVariantConst t : s["no_publish"].as<JsonArrayConst>())
          for (auto& a : window)
            if (a.type == ActionType::Publish && a.topic == t.as<std::string>()) fail("unexpected publish on " + a.topic + ": " + a.payload);
      }
      if (!s["actions"].isNull()) {
        checked = true;
        for (JsonVariantConst t : s["actions"].as<JsonArrayConst>()) {
          bool found = false;
          for (auto& a : window) found = found || t.as<std::string>() == actionName(a.type);
          if (!found) fail("expected action " + t.as<std::string>());
        }
      }
      if (!s["no_actions"].isNull()) {
        checked = true;
        for (JsonVariantConst t : s["no_actions"].as<JsonArrayConst>())
          for (auto& a : window)
            if (t.as<std::string>() == actionName(a.type)) fail("unexpected action " + t.as<std::string>());
      }
      (void)checked;
      window.clear();  // each step's checks see only what that step did (and boot, for step 0)
    }
  }

  void checkPublish(const std::vector<Action>& window, JsonVariantConst want) {
    const std::string topic = want["topic"].as<std::string>();
    std::string seen;
    for (auto& a : window) {
      if (a.type != ActionType::Publish || a.topic != topic) continue;
      seen += "\n    " + a.payload;
      JsonDocument got;
      if (deserializeJson(got, a.payload)) continue;
      bool ok = true;
      for (JsonPairConst kv : want["match"].as<JsonObjectConst>()) {
        JsonVariantConst g = got[kv.key()];
        if (kv.value().is<const char*>() && std::string(kv.value().as<const char*>()) == "*") ok = ok && !g.isUnbound();
        else ok = ok && !g.isUnbound() && json(g) == json(kv.value());
      }
      for (JsonVariantConst k : want["absent"].as<JsonArrayConst>()) ok = ok && got[k.as<const char*>()].isUnbound();
      if (ok) return;
    }
    fail("no " + topic + " message matching " + json(want) + (seen.empty() ? " (none sent)" : "; sent:" + seen));
  }
};

void runVectorFile(const char* name) {
  const std::string text = readFile(std::string(VECTORS_DIR) + "/" + name);
  TEST_ASSERT_FALSE_MESSAGE(text.empty(), (std::string("can't read ") + name).c_str());
  JsonDocument doc;
  TEST_ASSERT_FALSE_MESSAGE(deserializeJson(doc, text), (std::string("bad JSON in ") + name).c_str());
  Runner r;
  int cases = 0;
  for (JsonVariantConst c : doc["cases"].as<JsonArrayConst>()) {
    r.runCase(doc["defaults"]["boot"], c);
    cases++;
  }
  TEST_ASSERT_TRUE(cases > 0);
  if (!r.errors.empty()) {
    std::string all;
    for (auto& e : r.errors) all += "\n  " + e;
    TEST_FAIL_MESSAGE(all.c_str());
  }
}

}  // namespace

#define VECTOR_TEST(file)                       \
  static void test_vectors_##file() { runVectorFile(#file ".json"); }
VECTOR_TEST(taps)
VECTOR_TEST(daypass)
VECTOR_TEST(cmd)
VECTOR_TEST(mode)
VECTOR_TEST(offline)
VECTOR_TEST(fobs)
VECTOR_TEST(door)
VECTOR_TEST(heartbeat)
VECTOR_TEST(ota)
VECTOR_TEST(rollback)

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_iso_round_trip);
  RUN_TEST(test_london_date);
  RUN_TEST(test_normalise_uid);
  RUN_TEST(test_debounce);
  RUN_TEST(test_tap_queue_keeps_newest);
  RUN_TEST(test_boot_drives_the_lock);
  RUN_TEST(test_vectors_taps);
  RUN_TEST(test_vectors_daypass);
  RUN_TEST(test_vectors_cmd);
  RUN_TEST(test_vectors_mode);
  RUN_TEST(test_vectors_offline);
  RUN_TEST(test_vectors_fobs);
  RUN_TEST(test_vectors_door);
  RUN_TEST(test_vectors_heartbeat);
  RUN_TEST(test_vectors_ota);
  RUN_TEST(test_vectors_rollback);
  return UNITY_END();
}
