// box_core: every decision a lock box makes, in plain C++17 with no Arduino headers, so the
// same code runs on the ESP32 and in `pio test -e native`. It is a state machine: the hardware
// layer (src/) feeds it inputs and carries out the actions it returns. It never does I/O.
//
// Contract: docs/mqtt.md. Rules and why: docs/decisions.md (2026-11-16, weeks 5-6).
// The box simulator (tools/box-sim/core.ts) is a line-by-line port; both run test/vectors/*.json.
#pragma once

#include <cstdint>
#include <deque>
#include <string>
#include <vector>

namespace boxcore {

// ---- Timing (one place, so the simulator and docs can match) ----
constexpr uint32_t kTapOpenMs = 8000;         // a fob tapped at the box: same 8 s as a panel open
constexpr uint32_t kDefaultCmdOpenS = 8;      // cmd "open" without "seconds"
constexpr uint32_t kMaxCmdOpenS = 30;         // never hold a box open longer than this per command
constexpr uint32_t kHeartbeatMs = 30000;      // box/<id>/heartbeat
constexpr uint32_t kDefaultOfflineMin = 5;    // until a fobs list says otherwise
constexpr uint32_t kMidTapMs = 3000;          // OTA refused for this long after any tap
constexpr uint32_t kOtaVerifyMs = 5 * 60000;  // new firmware must reach the hub within this, or roll back
constexpr size_t kTapQueueMax = 32;           // taps kept while the hub is unreachable (newest kept)
constexpr size_t kMaxFobs = 400;              // a list longer than this is refused (keeps the old one)

/** The clock, as the hardware layer sees it right now. */
struct Now {
  uint64_t mono_ms = 0;  // milliseconds since boot, never goes backwards
  bool clock_set = false;  // true once SNTP has set the wall clock since boot
  int64_t utc_ms = 0;      // Unix time in ms, only meaningful when clock_set
};

enum class ActionType {
  SetLock,       // locked = drive the maglock (GPIO high); !locked = release it
  Publish,       // topic is the part after "box/<id>/"
  StoreFobs,     // payload = fobs JSON to keep in flash
  StartOta,      // url, sha256, size, version
  MarkAppValid,  // new firmware reached the hub: cancel rollback
  RollbackReboot // new firmware never reached the hub: boot the previous one
};

struct Action {
  ActionType type;
  bool locked = true;
  std::string topic;
  std::string payload;
  bool retain = false;
  int qos = 0;
  std::string url, sha256, version;
  uint32_t size = 0;
};

struct BootInfo {
  std::string fw;                 // this firmware's version, e.g. "0.1.0"
  bool door_sensor = true;        // reed switch fitted (decision 2026-11-16)
  const std::string* stored_fobs = nullptr;  // fobs JSON from flash, or nullptr
  bool ota_pending_verify = false;  // first boot of a freshly flashed image
  std::string rolled_back_from;     // non-empty: the bootloader rolled back from this version
};

struct FobEntry {
  std::string uid;    // uppercase hex
  std::string until;  // "" or YYYY-MM-DD (local Europe/London)
};

class Box {
 public:
  void boot(const Now& now, const BootInfo& info);
  /** Call often (every loop). Runs timers: open time, offline unlock, heartbeat, OTA verify. */
  void tick(const Now& now);
  /** A new tap (already debounced). */
  void tap(const Now& now, const std::string& uid);
  /** A message on a subscribed topic. kind: "cmd", "mode", "fobs", "ota" or "hub" (hub/status). */
  void message(const Now& now, const std::string& kind, const std::string& payload);
  /** MQTT session up (subscriptions in place) or down. */
  void broker(const Now& now, bool connected);
  /** Reed switch: true = door shut. */
  void door(const Now& now, bool shut);
  /** OTA finished. ok = flashed and about to reboot; otherwise why it failed. */
  void otaResult(const Now& now, bool ok, const std::string& why);
  /** Set the IP shown in heartbeats. */
  void setIp(const std::string& ip) { ip_ = ip; }

  /** Actions produced since the last call. */
  std::vector<Action> take();

  // Read-only views (tests, logs, the serial `show` command).
  bool locked() const { return locked_; }
  const std::string& why() const { return why_; }
  bool show() const { return show_; }
  bool hasList() const { return has_list_; }
  bool hubReachable() const { return broker_ && hub_online_; }
  bool offlineUnlocked() const { return offline_unlocked_; }
  bool otaBusy() const { return ota_busy_; }
  uint32_t offlineUnlockMin() const { return offline_min_; }
  size_t fobCount() const { return fobs_.size(); }

 private:
  void evaluate(const Now& now, bool force_state = false);
  void publishState(const Now& now);
  void publishHeartbeat(const Now& now);
  void publish(const std::string& topic, const std::string& payload, bool retain, int qos);
  void flushTaps();
  bool applyFobs(const std::string& payload);
  void onCmd(const Now& now, const std::string& payload);
  void onMode(const Now& now, const std::string& payload);
  void onOta(const Now& now, const std::string& payload);
  void otaRefuse(const Now& now, const char* why, const std::string& version);
  void setHubReachable(const Now& now, bool before);

  std::vector<Action> out_;

  std::string fw_, ip_;
  bool door_sensor_ = true;

  // Allowlist
  bool has_list_ = false;
  std::vector<FobEntry> fobs_;
  uint32_t offline_min_ = kDefaultOfflineMin;

  // Hub link
  bool broker_ = false;
  bool hub_online_ = false;
  uint64_t offline_since_ = 0;
  bool offline_unlocked_ = false;

  // Lock
  bool show_ = false;
  uint64_t open_until_ = 0;
  std::string open_why_;  // "fob" or "cmd"
  bool locked_ = true;     // what we last told the hardware
  bool lock_known_ = false;
  std::string why_;
  std::string locked_why_;  // "cmd" after a lock command, until the box next opens
  bool have_ref_ = false;
  int64_t ref_ = 0;

  // Door
  bool door_shut_ = true;
  bool door_known_ = false;

  // Publishing
  bool state_dirty_ = true;
  uint64_t last_hb_ = 0;
  bool hb_sent_since_connect_ = false;
  std::deque<std::string> tap_queue_;
  uint64_t last_tap_ = 0;
  bool any_tap_ = false;

  // OTA
  bool ota_busy_ = false;
  bool ota_pending_verify_ = false;
  uint64_t boot_ms_ = 0;
  std::string ota_status_, ota_why_, ota_version_;
};

// ---- Helpers (exposed for tests) ----

/** "2026-11-16T18:00:00.000Z" -> Unix ms. False if it isn't a UTC ISO 8601 time. */
bool parseIsoUtc(const std::string& s, int64_t& out_ms);
/** Unix ms -> "2026-11-16T18:00:00.000Z". */
std::string isoUtc(int64_t ms);
/** Local date in Europe/London (GMT, BST from the last Sunday of March to the last Sunday of
 *  October, changing at 01:00 UTC), as YYYY-MM-DD. */
std::string londonDate(int64_t utc_ms);
/** Uppercase hex, 4/7/10 bytes, no separators. False otherwise. */
bool normaliseUid(const std::string& in, std::string& out);

/**
 * Turns "what's on the reader right now" (polled) into taps. A UID is a new tap if it differs
 * from the fob on the reader, or the same fob comes back after kAwayMs away (desk reader rule,
 * decision 2026-11-16).
 */
class TapDebouncer {
 public:
  static constexpr uint32_t kAwayMs = 600;
  /** uid empty = nothing on the reader. Returns true (and sets tap) when this poll is a new tap. */
  bool poll(uint64_t mono_ms, const std::string& uid, std::string& tap);

 private:
  std::string present_;
  uint64_t last_seen_ = 0;
  bool have_ = false;
};

}  // namespace boxcore
