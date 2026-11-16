// Desk panel UI. One screen at a time, driven by the hub's event stream (taps, session open /
// close, confirms, screen on / off). Plain DOM, no framework. 1280x800, dark, big targets.
import { get, post, stream, upload, type ApiResult } from "./api";
import { btn, h, mount } from "./dom";
import { keyboard } from "./keyboard";

// ---------------------------------------------------------------------------------------------
// state

interface SessionView {
  id: string;
  kind: "crew" | "admin";
  name: string;
  expiresAt: string;
  timeoutMs: number;
  pending: { id: string; label: string; expiresAt: string } | null;
  capture: { purpose: "enrol" | "day_pass"; expiresAt: string } | null;
  guest?: boolean;
  level?: number | null;
  specialism?: string | null;
  type?: string;
  signedIn?: boolean;
  kitOut?: { kit_id: string; item: string }[];
}

type Row = Record<string, any>;
type View =
  | { v: "idle" }
  | { v: "denied"; reason: string; name: string | null }
  | { v: "crew" }
  | { v: "take"; items: Row[] | null }
  | { v: "return"; items: Row[] | null }
  | { v: "boxes"; items: Row[] | null }
  | { v: "admin"; menu: Row | null }
  | { v: "students"; menu: Row | null }
  | { v: "enrol"; step: "tap" | "who" | "new"; uid: string | null; people: Row[] | null; draft: Row }
  | { v: "fobs"; items: Row[] | null; sel: Row | null }
  | { v: "daypass"; step: "tap" | "form"; uid: string | null; guest: string; level: number }
  | { v: "show"; menu: Row | null }
  | { v: "force"; items: Row[] | null }
  | { v: "eos"; data: Row | null; done: Row | null }
  | { v: "log"; data: Row | null; filters: Row | null; q: Record<string, string>; page: number }
  | { v: "status"; data: Row | null }
  | { v: "restart" }
  | { v: "import"; preview: Row | null; res: Record<string, "panel" | "sheet">; error: string | null };

const S = {
  session: null as SessionView | null,
  view: { v: "idle" } as View,
  overview: null as Row | null,
  screenOn: true,
  guard: false,
  timezone: "Europe/London",
  devReader: false,
  deniedTimer: 0 as number | ReturnType<typeof setTimeout>,
  confirmMsg: "",
};

const kiosk = new URLSearchParams(location.search).has("kiosk");
if (kiosk) document.body.classList.add("kiosk");

// ---------------------------------------------------------------------------------------------
// helpers

const fmtTime = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: S.timezone, hour: "2-digit", minute: "2-digit" }).format(d);
const fmtDate = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: S.timezone, weekday: "long", day: "numeric", month: "long" }).format(d);
const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: S.timezone, day: "numeric", month: "short" }).format(d);
  return `${day} ${fmtTime(d)}`;
};
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  return hrs < 24 ? `${hrs} h ${m % 60} min` : fmtWhen(iso);
};

function toast(text: string, good = true): void {
  mount("toast", h("div", { class: good ? "" : "bad" }, text));
  clearTimeout((toast as any).t);
  (toast as any).t = setTimeout(() => mount("toast"), good ? 3500 : 5000);
}

function show(r: ApiResult): boolean {
  if (r.confirm === "tap") return true; // the confirm overlay opens from the session update
  if (r.ok) toast(r.message ?? "Done");
  else toast(r.reason ?? "That didn't work", false);
  return r.ok;
}

const sid = () => S.session?.id ?? "";

function go(view: View): void {
  S.view = view;
  render();
  void load();
}

// ---------------------------------------------------------------------------------------------
// data loading for the current view

async function load(): Promise<void> {
  const v = S.view;
  const q = `session=${encodeURIComponent(sid())}`;
  try {
    switch (v.v) {
      case "crew":
        S.overview = await get(`/api/panel/overview?${q}`);
        break;
      case "take":
      case "return": {
        const lists = await get<{ take: Row[]; mine: Row[] }>(`/api/panel/kit?${q}`);
        v.items = v.v === "take" ? lists.take : lists.mine;
        break;
      }
      case "boxes":
        v.items = (await get<{ boxes: Row[] }>(`/api/panel/boxes?${q}`)).boxes;
        break;
      case "admin":
      case "students":
      case "show":
        v.menu = await get(`/api/admin/menu?${q}`);
        break;
      case "enrol":
        if (v.step === "who" && !v.people) v.people = (await get<{ people: Row[] }>(`/api/admin/people?${q}`)).people;
        break;
      case "fobs":
        v.items = (await get<{ fobs: Row[] }>(`/api/admin/fobs?${q}`)).fobs;
        break;
      case "force":
        v.items = (await get<{ kit: Row[] }>(`/api/admin/kit-out?${q}`)).kit;
        break;
      case "eos":
        v.data = await get(`/api/admin/end-of-session?${q}`);
        break;
      case "log": {
        const p = new URLSearchParams({ session: sid(), page: String(v.page), ...v.q });
        v.data = await get(`/api/admin/events?${p}`);
        if (!v.filters) v.filters = await get(`/api/admin/event-filters?${q}`);
        break;
      }
      case "status":
        v.data = await get(`/api/admin/status?${q}`);
        break;
      default:
        return;
    }
  } catch {
    // hub briefly unreachable: keep what's on screen
  }
  if (S.view === v) render();
}

// ---------------------------------------------------------------------------------------------
// rendering

function bar(title: string, back?: () => void): HTMLElement {
  return h(
    "div",
    { class: "bar" },
    back ? btn("‹ Back", back, "small quiet") : null,
    h("div", { class: "title" }, title),
    h("div", { class: "spacer" }),
    S.overview?.showMode ? h("div", { class: "flag" }, "SHOW MODE") : null,
    S.session ? btn(S.session.kind === "admin" ? "Close menu" : "Done", closeSession, "small") : null,
    h("div", { class: "clock", id: "barclock" }, fmtTime(new Date())),
    S.session ? h("div", { class: "timeout", id: "timeout" }) : null,
  );
}

function render(): void {
  const v = S.view;
  let screen: (HTMLElement | null)[];
  switch (v.v) {
    case "idle":
      screen = [idle()];
      break;
    case "denied":
      screen = [denied(v)];
      break;
    case "crew":
      screen = crew();
      break;
    case "take":
    case "return":
      screen = kitPicker(v);
      break;
    case "boxes":
      screen = boxPicker(v);
      break;
    case "admin":
      screen = adminMenu(v);
      break;
    case "students":
      screen = students(v);
      break;
    case "enrol":
      screen = enrol(v);
      break;
    case "fobs":
      screen = fobs(v);
      break;
    case "daypass":
      screen = dayPass(v);
      break;
    case "show":
      screen = showMode(v);
      break;
    case "force":
      screen = forceReturn(v);
      break;
    case "eos":
      screen = endOfSession(v);
      break;
    case "log":
      screen = eventLog(v);
      break;
    case "status":
      screen = hubStatus(v);
      break;
    case "restart":
      screen = restart();
      break;
    case "import":
      screen = importScreen(v);
      break;
  }
  mount("app", ...screen, S.devReader ? devKey() : null);
  renderConfirm();
  tickTimers();
}

// ---- idle / denied ---------------------------------------------------------------------------

function idle(): HTMLElement {
  const now = new Date();
  return h(
    "div",
    { class: "idle" },
    h("div", { class: "time", id: "bigclock" }, fmtTime(now)),
    h("div", { class: "date", id: "bigdate" }, fmtDate(now)),
  );
}

function denied(v: Extract<View, { v: "denied" }>): HTMLElement {
  return h(
    "div",
    { class: "denied", onclick: () => go({ v: "idle" }) },
    h("div", { class: "big" }, "Ask a staff member"),
    h("div", { class: "why" }, v.reason),
    v.name ? h("div", { class: "who" }, v.name) : null,
  );
}

// ---- crew card + overview ----------------------------------------------------------------------

function crew(): HTMLElement[] {
  const s = S.session!;
  const meta = s.guest ? `Guest · Level ${s.level ?? 1}` : s.type === "Student" ? `Level ${s.level ?? "?"}${s.specialism ? ` · ${s.specialism}` : ""}` : `${s.type}${s.specialism ? ` · ${s.specialism}` : ""}`;
  const out = s.kitOut ?? [];
  const card = h(
    "div",
    { class: "col card" },
    h(
      "div",
      { class: "who" },
      h("div", { class: "name" }, s.name),
      h("div", { class: "meta" }, meta, " ", s.signedIn ? h("span", { class: "pill in" }, "Signed in") : h("span", { class: "pill" }, "Not signed in")),
      h("div", { class: "out" }, h("b", null, "You have out"), out.length ? out.map((k) => k.item).join(", ") : "Nothing"),
    ),
    btn(s.signedIn ? "Sign out" : "Sign in", signInOut, s.signedIn ? "" : "go"),
    btn("Take kit", () => go({ v: "take", items: null }), "blue"),
    btn("Return kit", () => go({ v: "return", items: null }), "", out.length === 0),
    btn("Open a box", () => go({ v: "boxes", items: null })),
  );
  return [bar(s.guest ? "Guest" : "Hello"), h("div", { class: "main" }, card, overview())];
}

function overview(): HTMLElement {
  const o = S.overview;
  if (!o) return h("div", { class: "ov" });
  const list = (rows: HTMLElement[], none: string) => h("div", { class: "list" }, rows.length ? rows : h("div", { class: "none" }, none));
  const hl = o.health ?? {};
  const reader = hl.reader;
  const disk = hl.diskFreeMB === null || hl.diskFreeMB === undefined ? "?" : hl.diskFreeMB >= 1000 ? `${Math.round(hl.diskFreeMB / 1000)} GB` : `${hl.diskFreeMB} MB`;
  return h(
    "div",
    { class: "ov" },
    h("div", { class: "box" }, h("h3", null, `Signed in (${o.signedIn.length})`), list(o.signedIn.map((p: Row) => h("div", { class: "row" }, h("span", null, p.name), h("span", null, ago(p.since)))), "Nobody")),
    h("div", { class: "box" }, h("h3", null, "Boxes"), list(o.boxes.map((b: Row) => h("div", { class: "row" }, h("span", null, b.name), h("span", { class: `st-${b.status}` }, b.statusText))), "No boxes yet")),
    h("div", { class: "box", style: "grid-column: 1 / 3" }, h("h3", null, `Kit out (${o.kitOut.length})`), list(o.kitOut.map((k: Row) => h("div", { class: "row" }, h("span", null, k.item), h("span", null, `${k.holder} · ${ago(k.since)}`))), "Everything is in")),
    h(
      "div",
      { class: "box health" },
      h("h3", null, "Hub"),
      h("span", null, h("span", { class: `dot ${hl.tempC === null ? "" : hl.tempC >= 75 ? "bad" : hl.tempC >= 65 ? "warn" : "good"}` }), hl.tempC === null ? "No temp" : `${hl.tempC} °C`),
      h("span", null, h("span", { class: `dot ${hl.diskFreeMB !== null && hl.diskFreeMB < 2000 ? "bad" : "good"}` }), `${disk} free`),
      h("span", null, h("span", { class: `dot ${hl.mqtt ? "good" : "bad"}` }), hl.mqtt ? "Box link OK" : "Box link down"),
      reader ? h("span", null, h("span", { class: `dot ${reader.state === "ok" ? "good" : "bad"}` }), reader.state === "ok" ? "Reader OK" : "Reader not found") : null,
      o.studentsDisabled ? h("span", { class: "flag" }, "Students disabled") : null,
    ),
  );
}

async function signInOut(): Promise<void> {
  show(await post("/api/panel/sign", { session: sid() }));
}

function kitPicker(v: Extract<View, { v: "take" | "return" }>): HTMLElement[] {
  const take = v.v === "take";
  const items = v.items;
  const tiles = items === null ? [] : items.map((k) => h("button", { class: "tile", onclick: () => kitAction(take, k) }, h("div", { class: "t" }, k.item), h("div", { class: "s" }, k.box ? `${k.box}${k.slot ? ` · ${k.slot}` : ""}` : k.category)));
  return [
    bar(take ? "Take kit" : "Return kit", () => go({ v: "crew" })),
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "pick" },
        h("div", { class: "help" }, take ? "Kit that's in and that you're cleared for. Tap one to take it." : "Tap the item you're giving back."),
        items !== null && items.length === 0 ? h("div", { class: "empty" }, take ? "Nothing you're cleared for is in right now." : "You have nothing out.") : h("div", { class: "tiles" }, tiles),
      ),
    ),
  ];
}

async function kitAction(take: boolean, k: Row): Promise<void> {
  const r = await post(take ? "/api/panel/take" : "/api/panel/return", { session: sid(), kitId: k.kit_id });
  if (show(r)) go({ v: "crew" });
  else void load();
}

function boxPicker(v: Extract<View, { v: "boxes" }>): HTMLElement[] {
  const items = v.items;
  const word: Record<string, string> = { locked: "Locked", open: "Open", offline: "Offline", never_seen: "Not set up yet" };
  return [
    bar("Open a box", () => go({ v: "crew" })),
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "pick" },
        h("div", { class: "help" }, "Boxes you're cleared for. Tap one to open it."),
        items !== null && items.length === 0
          ? h("div", { class: "empty" }, "No boxes you can open.")
          : h("div", { class: "tiles" }, (items ?? []).map((b) => h("button", { class: "tile", onclick: () => openBox(b) }, h("div", { class: "t" }, b.name), h("div", { class: `s st-${b.status}` }, word[b.status] ?? b.status)))),
      ),
    ),
  ];
}

async function openBox(b: Row): Promise<void> {
  const r = await post("/api/panel/open", { session: sid(), boxId: b.box_id });
  if (r.ok) {
    toast(r.message ?? "Opening", !/offline/.test(r.message ?? ""));
    go({ v: "crew" });
  } else show(r);
}

// ---- admin -----------------------------------------------------------------------------------

const back = () => go({ v: "admin", menu: null });

function adminMenu(v: Extract<View, { v: "admin" }>): HTMLElement[] {
  const m = v.menu ?? {};
  const t = (title: string, sub: string, fn: () => void, cls = "") => h("button", { class: `tile ${cls}`, onclick: fn }, h("div", { class: "t" }, title), h("div", { class: "s" }, sub));
  return [
    bar(`Admin · ${S.session?.name ?? ""}`),
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "menu" },
        t("Students", m.studentsDisabled ? "Disabled now" : "Enabled", () => go({ v: "students", menu: null }), m.studentsDisabled ? "sel" : ""),
        t("Enrol a fob", "New or spare fob", () => startEnrol()),
        t("Lost / revoke", "Mark a fob lost or revoked", () => go({ v: "fobs", items: null, sel: null })),
        t("Day pass", "Guest fob for today", () => startDayPass()),
        t("Show mode", m.showMode ? "ON: boxes unlocked" : "Off", () => go({ v: "show", menu: null }), m.showMode ? "sel" : ""),
        t("Force return", m.kitOut ? `${m.kitOut} item${m.kitOut === 1 ? "" : "s"} out` : "Nothing out", () => go({ v: "force", items: null })),
        t("End of session", "Lock everything", () => go({ v: "eos", data: null, done: null })),
        t("Event log", "Who did what", () => go({ v: "log", data: null, filters: null, q: {}, page: 1 })),
        t("Hub status", "Version, disk, temperature", () => go({ v: "status", data: null })),
        t("Backup now", "Copy the database", backupNow),
        t("Update from workbook", "Preview, then apply", () => go({ v: "import", preview: null, res: {}, error: null })),
        t("Restart / reboot", "Hub or Pi", () => go({ v: "restart" }), "danger"),
      ),
    ),
  ];
}

function students(v: Extract<View, { v: "students" }>): HTMLElement[] {
  const off = v.menu?.studentsDisabled === true;
  return [
    bar("Students", back),
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "pick" },
        h("div", { class: "big-state" }, off ? "Students are disabled" : "Students are enabled"),
        h("div", { class: "note" }, "Disabling stops every student fob: boxes, kit and the desk. Staff, hire techs, day passes and admin fobs still work."),
        h("div", { class: "grow" }),
        h("div", { class: "foot" }, off ? btn("Enable students again", () => act("/api/admin/students", { disabled: false }), "go") : btn("Disable all students", () => act("/api/admin/students", { disabled: true }), "stop")),
      ),
    ),
  ];
}

async function act(path: string, body: Record<string, unknown> = {}, after?: () => void): Promise<ApiResult> {
  const r = await post(path, { session: sid(), ...body });
  show(r);
  if (r.ok && r.confirm !== "tap") (after ?? (() => void load()))();
  return r;
}

// enrol
async function startEnrol(): Promise<void> {
  const r = await post("/api/admin/enrol/start", { session: sid() });
  if (!r.ok) return void show(r);
  go({ v: "enrol", step: "tap", uid: null, people: null, draft: { role: "Standard", issuedOffset: 0 } });
}

function waitingForTap(title: string, help: string, backFn: () => void): HTMLElement[] {
  return [
    bar(title, backFn),
    h("div", { class: "main" }, h("div", { class: "idle" }, h("div", { class: "fob" }, "TAP"), h("div", { class: "date" }, help), h("div", { class: "hint" }, "Hold the fob on the reader"))),
  ];
}

const issuedDate = (offset: number) => {
  const d = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: S.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};

function enrol(v: Extract<View, { v: "enrol" }>): HTMLElement[] {
  if (v.step === "tap") return waitingForTap("Enrol a fob", "Tap the new fob", () => cancelCapture());
  const d = v.draft;
  const seg = (opts: (string | number)[], cur: unknown, set: (x: any) => void, labels?: Record<string, string>) =>
    h("div", { class: "seg" }, opts.map((o) => btn(labels?.[String(o)] ?? String(o), () => (set(o), render()), cur === o ? "on" : "")));
  const common = [
    h("div", { class: "lbl" }, "Role"),
    seg(["Standard", "Admin"], d.role, (x) => (d.role = x)),
    h("div", { class: "lbl" }, "Issued"),
    h("div", { class: "seg" }, btn("−", () => ((d.issuedOffset -= 1), render()), "small"), h("div", { class: "field", style: "width: 280px" }, issuedDate(d.issuedOffset)), btn("+", () => ((d.issuedOffset = Math.min(0, d.issuedOffset + 1)), render()), "small"), d.issuedOffset !== 0 ? btn("Today", () => ((d.issuedOffset = 0), render()), "small") : null),
  ];
  if (v.step === "who") {
    const people = v.people;
    return [
      bar(`Fob …${v.uid?.slice(-4)}: who is it for?`, back),
      h(
        "div",
        { class: "main" },
        h(
          "div",
          { class: "pick" },
          h("div", { class: "tiles four", style: "max-height: 400px" }, btn("+ Add a new person", () => ((v.step = "new"), render()), "go"), (people ?? []).map((p) => h("button", { class: `tile${d.personId === p.person_id ? " sel" : ""}`, onclick: () => ((d.personId = p.person_id), render()) }, h("div", { class: "t" }, p.name), h("div", { class: "s" }, p.type === "Student" ? `Year ${p.year ?? "?"} · L${p.level ?? "?"}` : p.type)))),
          h("div", { class: "form" }, common),
          h("div", { class: "grow" }),
          h("div", { class: "foot" }, btn("Enrol fob", () => submitEnrol(v, { personId: d.personId }), "go", !d.personId)),
        ),
      ),
    ];
  }
  // new person
  const student = d.type === "Student";
  const ready = !!d.name && !!d.type && (!student || !!d.year);
  return [
    bar(`Fob …${v.uid?.slice(-4)}: new person`, () => ((v.step = "who"), render())),
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "pick" },
        h(
          "div",
          { class: "form" },
          h("div", { class: "lbl" }, "Name"),
          h("button", { class: `field${d.name ? "" : " placeholder"}`, onclick: () => keyboard("Full name", d.name ?? "", 60, (x) => { mount("overlay"); if (x !== null) d.name = x; render(); }) }, d.name || "Tap to type"),
          h("div", { class: "lbl" }, "Type"),
          seg(["Student", "Staff", "Hire tech"], d.type, (x) => (d.type = x)),
          student ? [h("div", { class: "lbl" }, "Year"), seg([7, 8, 9, 10, 11, 12, 13], d.year, (x) => (d.year = x))] : null,
          student ? [h("div", { class: "lbl" }, "Level"), seg([1, 2, 3, 4], d.level ?? 1, (x) => (d.level = x))] : null,
          h("div", { class: "lbl" }, "Specialism"),
          seg(["", "Lighting", "Sound", "Lighting + Sound"], d.specialism ?? "", (x) => (d.specialism = x), { "": "None" }),
          common,
        ),
        h("div", { class: "grow" }),
        h("div", { class: "foot" }, btn("Add and enrol", () => submitEnrol(v, { person: { name: d.name, type: d.type, year: d.year ?? null, level: d.level ?? 1, specialism: d.specialism || null } }), "go", !ready)),
      ),
    ),
  ];
}

async function submitEnrol(v: Extract<View, { v: "enrol" }>, who: Record<string, unknown>): Promise<void> {
  const r = await post("/api/admin/enrol", { session: sid(), uid: v.uid, role: v.draft.role, issued: issuedDate(v.draft.issuedOffset), ...who });
  if (show(r)) back();
}

async function cancelCapture(): Promise<void> {
  await post("/api/admin/cancel", { session: sid() });
  back();
}

// lost / revoke
function fobs(v: Extract<View, { v: "fobs" }>): HTMLElement[] {
  const sel = v.sel;
  return [
    bar("Lost / revoke a fob", back),
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "pick" },
        h("div", { class: "help" }, "Tap the fob, then choose Lost or Revoked. A lost fob is never used again."),
        h(
          "div",
          { class: "tiles four", style: "flex: 1" },
          (v.items ?? []).map((f) => h("button", { class: `tile${sel?.fob_uid === f.fob_uid ? " sel" : ""}`, onclick: () => ((v.sel = f), render()) }, h("div", { class: "t" }, f.name), h("div", { class: "s" }, `${f.role}${f.status === "Spare" ? " · spare" : ""} · …${f.fob_uid.slice(-4)}`), f.lostBefore ? h("div", { class: "s" }, `${f.lostBefore} lost before`) : null)),
        ),
        h(
          "div",
          { class: "foot" },
          btn(sel ? `${sel.name}: Lost` : "Lost", () => act("/api/admin/fob-status", { uid: sel!.fob_uid, status: "Lost" }), "stop", !sel),
          btn(sel ? `${sel.name}: Revoked` : "Revoked", () => act("/api/admin/fob-status", { uid: sel!.fob_uid, status: "Revoked" }), "warn", !sel),
        ),
      ),
    ),
  ];
}

// day pass
async function startDayPass(): Promise<void> {
  const r = await post("/api/admin/day-pass/start", { session: sid() });
  if (!r.ok) return void show(r);
  go({ v: "daypass", step: "tap", uid: null, guest: "", level: 1 });
}

function dayPass(v: Extract<View, { v: "daypass" }>): HTMLElement[] {
  if (v.step === "tap") return waitingForTap("Guest day pass", "Tap a spare fob", () => cancelCapture());
  return [
    bar(`Day pass · fob …${v.uid?.slice(-4)}`, back),
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "pick" },
        h(
          "div",
          { class: "form" },
          h("div", { class: "lbl" }, "Company / reason"),
          h("button", { class: `field${v.guest ? "" : " placeholder"}`, onclick: () => keyboard("Company / reason", v.guest, 120, (x) => { mount("overlay"); if (x !== null) v.guest = x; render(); }) }, v.guest || "Tap to type"),
          h("div", { class: "lbl" }, "Level"),
          h("div", { class: "seg" }, [1, 2, 3, 4].map((l) => btn(`Level ${l}`, () => ((v.level = l), render()), v.level === l ? "on" : ""))),
        ),
        h("div", { class: "note" }, "Works today only. It stops at midnight."),
        h("div", { class: "grow" }),
        h("div", { class: "foot" }, btn("Issue day pass", async () => { const r = await post("/api/admin/day-pass", { session: sid(), uid: v.uid, guest: v.guest, level: v.level }); if (show(r)) back(); }, "go", !v.guest)),
      ),
    ),
  ];
}

// show mode
function showMode(v: Extract<View, { v: "show" }>): HTMLElement[] {
  const on = v.menu?.showMode === true;
  return [
    bar("Show mode", back),
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "pick" },
        h("div", { class: "big-state" }, on ? "Show mode is ON" : "Show mode is off"),
        h("div", { class: "note" }, on ? "Every box is unlocked, no fob needed. It stays on until you turn it off or run End of session." : "Turn it on for a show: every box unlocks and stays unlocked, no fob needed."),
        h("div", { class: "grow" }),
        h("div", { class: "foot" }, on ? btn("Turn show mode off", () => act("/api/admin/show-mode", { on: false }), "go") : btn("Turn show mode on", () => act("/api/admin/show-mode", { on: true }), "warn")),
      ),
    ),
  ];
}

// force return
function forceReturn(v: Extract<View, { v: "force" }>): HTMLElement[] {
  return [
    bar("Force return", back),
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "pick" },
        h("div", { class: "help" }, "Tap an item to mark it as returned, whoever has it."),
        v.items !== null && v.items.length === 0
          ? h("div", { class: "empty" }, "Everything is in.")
          : h("div", { class: "tiles" }, (v.items ?? []).map((k) => h("button", { class: "tile", onclick: () => act("/api/admin/force-return", { kitId: k.kit_id }) }, h("div", { class: "t" }, k.item), h("div", { class: "s" }, `${k.holder} · ${ago(k.since)}`)))),
      ),
    ),
  ];
}

// end of session
function endOfSession(v: Extract<View, { v: "eos" }>): HTMLElement[] {
  const d = v.done ?? v.data;
  const list = (rows: string[], none: string) => h("div", { class: "list" }, rows.length ? rows.map((r) => h("div", null, r)) : h("div", { class: "none" }, none));
  return [
    bar("End of session", back),
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "pick" },
        h("div", { class: "help" }, v.done ? "Done. Here's what was still out:" : "This locks every box and turns show mode off. Nobody is signed out."),
        h(
          "div",
          { class: "counts", style: "flex: 1" },
          h("div", { class: "box" }, h("h3", null, "Kit still out"), list((d?.kitOut ?? []).map((k: Row) => `${k.item} · ${k.holder}`), "Everything is in")),
          h("div", { class: "box" }, h("h3", null, "Boxes still open"), list((d?.boxesOpen ?? []).map((b: Row) => b.name), "None")),
        ),
        h("div", { class: "foot" }, v.done ? btn("Back to menu", back) : btn("Lock everything", async () => { const r = await post("/api/admin/end-of-session", { session: sid() }); show(r); if (r.ok) { v.done = r as Row; render(); } }, "go")),
      ),
    ),
  ];
}

// event log
const TYPE_WORDS: Record<string, string> = { sign_in: "Sign in", sign_out: "Sign out", kit_out: "Kit out", kit_in: "Kit in", kit_denied: "Kit refused", box_open: "Box open", box_denied: "Box refused", tap_denied: "Fob refused", admin_action: "Admin", import_applied: "Import", export: "Export" };

function eventLog(v: Extract<View, { v: "log" }>): HTMLElement[] {
  const d = v.data;
  const f = v.filters;
  const setQ = (k: string, val: string | null) => {
    if (val === null || v.q[k] === val) delete v.q[k];
    else v.q[k] = val;
    v.page = 1;
    void load();
  };
  const pickFrom = (title: string, key: string, items: Row[]) => {
    mount(
      "overlay",
      h(
        "div",
        { class: "dialog", style: "width: 1100px; max-height: 720px" },
        h("h2", null, title),
        h("div", { class: "tiles four", style: "width: 100%; max-height: 480px" }, items.map((it) => h("button", { class: `tile${v.q[key] === it.id ? " sel" : ""}`, onclick: () => { mount("overlay"); setQ(key, it.id); } }, h("div", { class: "t", style: "font-size: 24px" }, it.name)))),
        h("div", { class: "row" }, btn("Any", () => { mount("overlay"); setQ(key, null); }), btn("Close", () => mount("overlay"))),
      ),
    );
  };
  const name = (key: string, list: Row[] | undefined) => list?.find((x) => x.id === v.q[key])?.name;
  return [
    bar("Event log", back),
    h(
      "div",
      { class: "main", style: "flex-direction: column; gap: 12px" },
      h("div", { class: "chips" }, (f?.types ?? []).map((t: string) => btn(TYPE_WORDS[t] ?? t, () => setQ("type", t), v.q.type === t ? "on" : ""))),
      h(
        "div",
        { class: "chips" },
        btn(`Person: ${name("person", f?.people) ?? "any"}`, () => pickFrom("Person", "person", f?.people ?? []), v.q.person ? "on" : ""),
        btn(`Box: ${name("box", f?.boxes) ?? "any"}`, () => pickFrom("Box", "box", f?.boxes ?? []), v.q.box ? "on" : ""),
        btn(`Kit: ${name("kit", f?.kit) ?? "any"}`, () => pickFrom("Kit", "kit", f?.kit ?? []), v.q.kit ? "on" : ""),
        Object.keys(v.q).length ? btn("Clear filters", () => ((v.q = {}), (v.page = 1), void load())) : null,
      ),
      h(
        "div",
        { class: "log" },
        d === null ? null : d.events.length === 0 ? h("div", { class: "empty" }, "Nothing matches.") : d.events.map((e: Row) => h("div", { class: `ev${/denied/.test(e.type) ? " deny" : ""}` }, h("div", { class: "when" }, fmtWhen(e.ts)), h("div", { class: "what" }, e.text))),
      ),
      h(
        "div",
        { class: "foot" },
        btn("‹ Newer", () => ((v.page -= 1), void load()), "small", !d || v.page <= 1),
        h("div", { class: "note", style: "flex: 1; text-align: center; align-self: center" }, d ? `Page ${d.page} of ${d.pages} · ${d.total} events` : ""),
        btn("Older ›", () => ((v.page += 1), void load()), "small", !d || v.page >= d.pages),
      ),
    ),
  ];
}

// hub status
function hubStatus(v: Extract<View, { v: "status" }>): HTMLElement[] {
  const d = v.data ?? {};
  const up = typeof d.uptimeSeconds === "number" ? (d.uptimeSeconds < 3600 ? `${Math.floor(d.uptimeSeconds / 60)} min` : d.uptimeSeconds < 86400 ? `${Math.floor(d.uptimeSeconds / 3600)} h ${Math.floor((d.uptimeSeconds % 3600) / 60)} min` : `${Math.floor(d.uptimeSeconds / 86400)} days`) : "?";
  const kv = (k: string, val: string, cls = "") => h("div", { class: "box" }, h("div", { class: "k" }, k), h("div", { class: `v ${cls}` }, val));
  const disk = d.diskFreeMB === null || d.diskFreeMB === undefined ? "?" : `${(d.diskFreeMB / 1000).toFixed(1)} GB free`;
  return [
    bar("Hub status", back),
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "pick" },
        h(
          "div",
          { class: "kv" },
          kv("Version", `${d.version ?? "?"} (db ${d.schemaVersion ?? "?"})`),
          kv("Up for", up),
          kv("Temperature", d.tempC === null || d.tempC === undefined ? "not a Pi" : `${d.tempC} °C`, d.tempC >= 75 ? "st-open" : ""),
          kv("Disk", disk, d.diskFreeMB !== null && d.diskFreeMB < 2000 ? "st-open" : ""),
          kv("Boxes link (MQTT)", d.mqtt ? "Connected" : "Not connected", d.mqtt ? "st-locked" : "st-open"),
          kv("Fob reader", d.reader ? (d.reader.state === "ok" ? "Working" : d.reader.detail) : "none", d.reader?.state === "ok" ? "st-locked" : "st-open"),
        ),
        h("div", { class: "note" }, `Last backup: ${d.lastBackup ? String(d.lastBackup).split("/").pop() : "none yet"}`),
        h("div", { class: "grow" }),
        h("div", { class: "foot" }, btn("Refresh", () => void load()), btn("Backup now", backupNow, "blue")),
      ),
    ),
  ];
}

async function backupNow(): Promise<void> {
  toast("Backing up…");
  show(await post("/api/admin/backup", { session: sid() }));
}

function restart(): HTMLElement[] {
  return [
    bar("Restart / reboot", back),
    h(
      "div",
      { class: "main" },
      h(
        "div",
        { class: "pick" },
        h("div", { class: "note" }, "Only if something is stuck. Boxes keep working on their own while the hub is away. Never during a show."),
        h("div", { class: "grow" }),
        h("div", { class: "foot" }, btn(h("span", null, "Restart the hub", h("span", { class: "sub" }, "back in about 10 seconds")), () => act("/api/admin/restart", { what: "hub" }), "warn stack"), btn(h("span", null, "Reboot the Pi", h("span", { class: "sub" }, "back in about a minute")), () => act("/api/admin/restart", { what: "pi" }), "stop stack")),
      ),
    ),
  ];
}

// import preview
function importScreen(v: Extract<View, { v: "import" }>): HTMLElement[] {
  const p = v.preview;
  if (!p) {
    const input = h("input", { type: "file", accept: ".xlsx", style: "display:none" }) as HTMLInputElement;
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      if (!f) return;
      const r = await upload("/api/import", f);
      if (r.error) v.error = String(r.error);
      else {
        v.preview = r;
        for (const c of (r.diff as Row).conflicts ?? []) v.res[c.key] = "panel";
      }
      render();
    });
    return [
      bar("Update from workbook", back),
      h("div", { class: "main" }, h("div", { class: "pick" }, h("div", { class: "note" }, "From week 7 this opens by itself when a TECHUPDATE stick goes in. For now, choose the .xlsx file."), v.error ? h("div", { class: "issue error" }, v.error) : null, h("div", { class: "grow" }), input, h("div", { class: "foot" }, btn("Choose workbook file", () => input.click(), "blue")))),
    ];
  }
  const d = p.diff as Row;
  const sheets: [string, string][] = [["people", "People"], ["fobs", "Fobs"], ["kit", "Kit"], ["boxes", "Boxes"]];
  const conflicts: Row[] = d.conflicts ?? [];
  const names: Record<string, string> = (p.names as Record<string, string>) ?? {};
  const thing = (c: Row) => {
    if (c.sheet === "fobs") return `${c.label && names[c.label] ? `${names[c.label]}'s fob` : "Fob"} …${String(c.id).slice(-4)}`;
    if (c.sheet === "people") return names[c.id] ?? c.label ?? c.id;
    return `${c.sheetName} ${c.id}${c.label ? ` (${c.label})` : ""}`;
  };
  const countText = (c: Row) => {
    const parts = [c.adds ? `${c.adds} new` : "", c.changes ? `${c.changes} changed` : "", c.removals ? `${c.removals} removed` : ""].filter(Boolean);
    return parts.length ? parts.join(" · ") : "No changes";
  };
  const unresolved = conflicts.filter((c) => !v.res[c.key]).length;
  const fmt = (x: unknown) => (x === null || x === undefined || x === "" ? "blank" : String(x));
  const changes: HTMLElement[] = [];
  for (const [key, label] of sheets) {
    const sd = d.sheets[key];
    for (const a of sd.adds) changes.push(h("div", { class: "issue" }, `${label}: add ${a.id}${a.restores ? " (back again)" : ""}`));
    for (const c of sd.changes) for (const f of c.fields) if (!conflicts.some((x) => x.key === `${key}/${c.id}/${f.column}`)) changes.push(h("div", { class: "issue" }, `${label} ${c.id}: ${f.column} ${fmt(f.old)} → ${fmt(f.new)}`));
    for (const r of sd.removals) if (!conflicts.some((x) => x.key === `${key}/${r.id}/*`)) changes.push(h("div", { class: "issue" }, `${label}: remove ${r.id}${r.label ? ` (${r.label})` : ""}`));
  }
  return [
    bar(`Workbook preview${p.fileName ? ` · ${p.fileName}` : ""}`, back),
    h(
      "div",
      { class: "main", style: "flex-direction: column; gap: 12px" },
      h("div", { class: "counts" }, sheets.map(([k, label]) => h("div", { class: "box" }, h("h3", null, label), h("div", null, countText(d.counts[k]))))),
      h(
        "div",
        { class: "log" },
        d.errors.map((e: Row) => h("div", { class: "issue error" }, `${e.sheet} row ${e.row ?? "?"}: ${e.message}`)),
        conflicts.length ? h("div", { class: "note" }, `Changed on the panel since the last export (${conflicts.length}). Choose for each:`) : null,
        conflicts.map((c) =>
          h(
            "div",
            { class: "conflict" },
            h("div", { class: "d" }, c.kind === "removal" ? `${thing(c)}: the workbook removes it` : `${thing(c)}, ${c.column}: panel “${fmt(c.panel)}”, workbook “${fmt(c.sheetValue)}”`, h("small", null, `changed on the panel ${fmtWhen(c.changedAt)}`)),
            btn("Keep panel", () => ((v.res[c.key] = "panel"), render()), v.res[c.key] === "panel" ? "on" : ""),
            btn(c.kind === "removal" ? "Remove it" : "Use workbook", () => ((v.res[c.key] = "sheet"), render()), v.res[c.key] === "sheet" ? "on" : ""),
          ),
        ),
        d.warnings.map((w: Row) => h("div", { class: "issue" }, `⚠ ${w.sheet}${w.row ? ` row ${w.row}` : ""}: ${w.message}`)),
        changes,
        d.empty && !d.errors.length ? h("div", { class: "empty" }, "Nothing to change: the hub already matches this workbook.") : null,
      ),
      h(
        "div",
        { class: "foot" },
        btn("Choose another file", () => ((v.preview = null), render())),
        btn(d.errors.length ? `Fix ${d.errors.length} error(s) first` : unresolved ? `Choose for ${unresolved} conflict(s)` : "Apply (tap admin fob)", () => act("/api/admin/import-apply", { batchId: p.batchId, resolutions: v.res }), "go", !p.canApply || unresolved > 0 || d.empty),
      ),
    ),
  ];
}

// ---- overlays --------------------------------------------------------------------------------

function renderConfirm(): void {
  const p = S.session?.pending;
  const ov = document.getElementById("overlay")!;
  if (!p) {
    if (ov.dataset.kind === "confirm") {
      mount("overlay");
      delete ov.dataset.kind;
    }
    return;
  }
  ov.dataset.kind = "confirm";
  mount(
    "overlay",
    h(
      "div",
      { class: "dialog" },
      h("h2", null, "Tap an admin fob to confirm"),
      h("div", { class: "label" }, p.label),
      h("div", { class: "fob" }, "TAP"),
      h("div", { class: "msg", id: "confirm-msg" }, S.confirmMsg),
      h("div", { class: "countdown" }, h("div", { id: "confirm-bar" })),
      h("div", { class: "row" }, btn("Cancel", () => void post("/api/admin/cancel", { session: sid() }))),
    ),
  );
}

function devKey(): HTMLElement {
  return h("button", { class: "devkey", onclick: (e: MouseEvent) => { e.stopPropagation(); void post("/api/dev/tap-next"); } }, "DEV: tap next fob");
}

// ---------------------------------------------------------------------------------------------
// session lifecycle

function setSession(s: SessionView | null): void {
  const prev = S.session;
  S.session = s;
  if (!s) {
    S.confirmMsg = "";
    mount("overlay");
    if (S.view.v !== "denied") go({ v: "idle" });
    return;
  }
  if (!prev || prev.id !== s.id) {
    clearTimeout(S.deniedTimer as number);
    mount("overlay");
    S.overview = null;
    go(s.kind === "admin" ? { v: "admin", menu: null } : { v: "crew" });
    if (s.kind === "admin") void get(`/api/panel/overview?session=${s.id}`).then((o) => { S.overview = o; render(); });
    return;
  }
  // same session updated (signed in, kit out, pending confirm, capture)
  if (!s.pending) S.confirmMsg = "";
  render();
}

async function closeSession(): Promise<void> {
  await post("/api/panel/close", { session: sid() });
}

// ---------------------------------------------------------------------------------------------
// timers: clocks, timeout bar, confirm countdown

function tickTimers(): void {
  const now = new Date();
  const t = fmtTime(now);
  const big = document.getElementById("bigclock");
  if (big && big.textContent !== t) big.textContent = t;
  const date = document.getElementById("bigdate");
  if (date) date.textContent = fmtDate(now);
  const bc = document.getElementById("barclock");
  if (bc && bc.textContent !== t) bc.textContent = t;
  const s = S.session;
  const tb = document.getElementById("timeout");
  if (s && tb) {
    const left = Math.max(0, Date.parse(s.expiresAt) - Date.now());
    tb.style.width = `${(left / s.timeoutMs) * 100}%`;
  }
  const cb = document.getElementById("confirm-bar");
  if (s?.pending && cb) cb.style.width = `${Math.max(0, (Date.parse(s.pending.expiresAt) - Date.now()) / 200)}%`;
}
setInterval(tickTimers, 250);

// ---------------------------------------------------------------------------------------------
// touches: keep the card open, report activity, and the wake guard

let lastPing = 0;
function onTouch(): void {
  const now = Date.now();
  if (now - lastPing < 2000) return;
  lastPing = now;
  if (S.session) {
    void post("/api/panel/touch", { session: S.session.id }).then((r) => {
      if (r.ok && S.session) {
        S.session.expiresAt = new Date(Date.now() + S.session.timeoutMs).toISOString();
      }
    });
  } else void post("/api/panel/activity");
}

function setGuard(on: boolean): void {
  S.guard = on;
  document.getElementById("guard")!.hidden = !on;
}

// Capture phase, so the guard sees the touch before any button does.
window.addEventListener(
  "pointerdown",
  (e) => {
    if (S.guard) {
      // The screen was off: this touch only wakes it.
      e.preventDefault();
      e.stopPropagation();
      setGuard(false);
      S.screenOn = true;
      lastPing = 0;
      onTouch();
      // swallow the click that follows this pointerdown too
      window.addEventListener("click", (c) => { c.preventDefault(); c.stopPropagation(); }, { capture: true, once: true });
      return;
    }
    onTouch();
  },
  { capture: true },
);
for (const ev of ["contextmenu", "dragstart", "selectstart"]) window.addEventListener(ev, (e) => e.preventDefault());
window.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
window.addEventListener("gesturestart", (e) => e.preventDefault());

// ---------------------------------------------------------------------------------------------
// live events

let overviewTimer: ReturnType<typeof setTimeout> | null = null;

stream(
  {
    hello: (d) => {
      S.screenOn = d.screen?.on !== false;
      setGuard(!S.screenOn);
      setSession(d.session);
    },
    session: (d) => setSession(d.session),
    tap: () => {
      // a fob tap wakes the screen without needing a touch
      setGuard(false);
      S.screenOn = true;
    },
    denied: (d) => {
      S.session = null;
      mount("overlay");
      go({ v: "denied", reason: d.reason, name: d.name });
      clearTimeout(S.deniedTimer as number);
      S.deniedTimer = setTimeout(() => { if (S.view.v === "denied") go({ v: "idle" }); }, 8000);
    },
    overview: () => {
      if (!S.session) return;
      if (overviewTimer) clearTimeout(overviewTimer);
      overviewTimer = setTimeout(async () => {
        if (!S.session) return;
        S.overview = await get(`/api/panel/overview?session=${S.session.id}`).catch(() => S.overview);
        if (S.view.v === "crew" || S.view.v === "admin") render();
      }, 150);
    },
    screen: (d) => {
      S.screenOn = d.on;
      setGuard(!d.on);
    },
    confirm: (d) => {
      if (d.ok) {
        S.confirmMsg = "";
        toast(d.message ?? "Done");
        void load();
      } else if (d.expired) {
        S.confirmMsg = "";
        toast("Not confirmed in time. Nothing was changed", false);
      } else if (S.session?.pending) {
        S.confirmMsg = d.reason ?? "Not confirmed";
        const msg = document.getElementById("confirm-msg");
        if (msg) {
          msg.textContent = S.confirmMsg;
          msg.parentElement?.classList.remove("shake");
          void msg.parentElement?.offsetWidth;
          msg.parentElement?.classList.add("shake");
        }
      } else toast(d.reason ?? "That didn't work", false);
    },
    captured: (d) => {
      const v = S.view;
      if (!d.ok) {
        toast(d.reason, false);
        if (v.v === "enrol" || v.v === "daypass") back();
        return;
      }
      if (v.v === "enrol" && d.purpose === "enrol") {
        v.uid = d.uid;
        v.step = "who";
        void load();
        render();
      } else if (v.v === "daypass" && d.purpose === "day_pass") {
        v.uid = d.uid;
        v.step = "form";
        render();
      }
    },
  },
  () => void get<Row>("/api/panel/state").then((st) => { S.timezone = st.timezone ?? S.timezone; S.devReader = !!st.devReader; render(); }),
);

render();
