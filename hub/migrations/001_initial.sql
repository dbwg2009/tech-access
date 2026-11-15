-- 001: initial schema. Enum values are the exact workbook text (docs/workbook-format.md).
-- Rows removed by a workbook import are archived (archived_at set), never hard-deleted,
-- so the events log always points at something real.

CREATE TABLE people (
  person_id   TEXT PRIMARY KEY CHECK (length(trim(person_id)) > 0),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  type        TEXT NOT NULL CHECK (type IN ('Student', 'Staff', 'Hire tech')),
  year        INTEGER CHECK (year IS NULL OR year BETWEEN 7 AND 13),
  level       INTEGER CHECK (level IS NULL OR level BETWEEN 1 AND 4),
  specialism  TEXT CHECK (specialism IS NULL OR specialism IN ('Lighting', 'Sound', 'Lighting + Sound')),
  status      TEXT NOT NULL CHECK (status IN ('Active', 'Disabled', 'Left')),
  notes       TEXT NOT NULL DEFAULT '',
  extra       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra)),  -- unknown workbook columns, kept for export
  archived_at TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE boxes (
  box_id             TEXT PRIMARY KEY CHECK (length(trim(box_id)) > 0),
  name               TEXT NOT NULL CHECK (length(trim(name)) > 0),
  type               TEXT NOT NULL CHECK (type IN ('Fixed (PoE)', 'Flight case (Wi-Fi)', 'Key cabinet')),
  required_level     INTEGER CHECK (required_level IS NULL OR required_level BETWEEN 1 AND 4),
  network            TEXT NOT NULL CHECK (network IN ('Ethernet', 'Wi-Fi')),
  ip_address         TEXT,
  location           TEXT NOT NULL DEFAULT '',
  offline_unlock_min INTEGER NOT NULL DEFAULT 5 CHECK (offline_unlock_min >= 0),
  notes              TEXT NOT NULL DEFAULT '',
  extra              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra)),
  last_seen          TEXT,  -- last MQTT heartbeat (hub-owned, exported as "Last seen (auto)")
  archived_at        TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE fobs (
  fob_uid     TEXT PRIMARY KEY
              CHECK (length(fob_uid) IN (8, 14, 20) AND fob_uid NOT GLOB '*[^0-9A-F]*'),
  person_id   TEXT REFERENCES people (person_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  role        TEXT NOT NULL CHECK (role IN ('Standard', 'Admin', 'Day pass')),
  status      TEXT NOT NULL CHECK (status IN ('Active', 'Spare', 'Lost', 'Revoked')),
  level       INTEGER CHECK (level IS NULL OR level BETWEEN 1 AND 4),  -- Day pass only
  issued      TEXT CHECK (issued IS NULL OR issued GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ended       TEXT CHECK (ended  IS NULL OR ended  GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  notes       TEXT NOT NULL DEFAULT '',
  extra       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra)),
  archived_at TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Blank Person ID only for Spare fobs and Day passes (guests). Decision 2026-11-15.
  CHECK (person_id IS NOT NULL OR status = 'Spare' OR role = 'Day pass')
) STRICT;
CREATE INDEX fobs_person ON fobs (person_id);

CREATE TABLE kit (
  kit_id         TEXT PRIMARY KEY CHECK (length(trim(kit_id)) > 0),
  item           TEXT NOT NULL CHECK (length(trim(item)) > 0),
  category       TEXT NOT NULL CHECK (category IN ('Lighting', 'Sound', 'Radio mics', 'Keys', 'Show network', 'Other')),
  required_level INTEGER CHECK (required_level IS NULL OR required_level BETWEEN 1 AND 4),
  specialism     TEXT CHECK (specialism IS NULL OR specialism IN ('Any', 'Lighting', 'Sound')),
  box_id         TEXT REFERENCES boxes (box_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  slot           TEXT NOT NULL DEFAULT '',
  tag_uid        TEXT UNIQUE
                 CHECK (tag_uid IS NULL OR (length(tag_uid) IN (8, 14, 20) AND tag_uid NOT GLOB '*[^0-9A-F]*')),
  notes          TEXT NOT NULL DEFAULT '',
  extra          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra)),
  archived_at    TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX kit_box ON kit (box_id);

-- Append-only log. No foreign keys on purpose: a denied tap from an unknown fob must still be logged.
CREATE TABLE events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  type      TEXT NOT NULL CHECK (type IN ('sign_in', 'sign_out', 'kit_out', 'kit_in', 'box_open', 'box_denied',
                                          'admin_action', 'import_applied', 'export', 'software_update')),
  person_id TEXT,
  fob_uid   TEXT,
  box_id    TEXT,
  kit_id    TEXT,
  detail    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail))
) STRICT;
CREATE INDEX events_ts ON events (ts);
CREATE INDEX events_kit ON events (kit_id, id);
CREATE INDEX events_person ON events (person_id, id);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE TABLE import_batches (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash          TEXT NOT NULL,             -- sha256 hex of the uploaded .xlsx
  file_name          TEXT,
  uploaded_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  parsed             TEXT NOT NULL CHECK (json_valid(parsed)),   -- normalised rows to apply
  preview            TEXT NOT NULL CHECK (json_valid(preview)),  -- diff shown on the panel
  error_count        INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'superseded')),
  applied_by_fob_uid TEXT,
  applied_at         TEXT,
  CHECK ((status = 'applied') = (applied_at IS NOT NULL AND applied_by_fob_uid IS NOT NULL))
) STRICT;

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO settings (key, value) VALUES
  ('students_disabled', 'false'),
  ('show_mode', 'false');
