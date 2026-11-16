-- 002: desk panel (weeks 3-4).
-- 1. New event types: kit_denied (a refused Take/Return), tap_denied (a fob the panel won't open
--    a card for). SQLite can't change a CHECK in place, so events is rebuilt with the same rows,
--    ids, indexes and append-only triggers.
-- 2. Box state reported over MQTT (box/<id>/state), hub-owned like last_seen.
-- 3. panel_changes: every change made on the panel, per sheet / row / field, until exported.
--    The importer uses it to refuse to silently undo panel changes (decision 2026-11-16).

DROP TRIGGER events_no_update;
DROP TRIGGER events_no_delete;

CREATE TABLE events_new (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  type      TEXT NOT NULL CHECK (type IN ('sign_in', 'sign_out', 'kit_out', 'kit_in', 'kit_denied', 'box_open',
                                          'box_denied', 'tap_denied', 'admin_action', 'import_applied', 'export',
                                          'software_update')),
  person_id TEXT,
  fob_uid   TEXT,
  box_id    TEXT,
  kit_id    TEXT,
  detail    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail))
) STRICT;
INSERT INTO events_new (id, ts, type, person_id, fob_uid, box_id, kit_id, detail)
  SELECT id, ts, type, person_id, fob_uid, box_id, kit_id, detail FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX events_ts ON events (ts);
CREATE INDEX events_kit ON events (kit_id, id);
CREATE INDEX events_person ON events (person_id, id);
CREATE INDEX events_fob ON events (fob_uid, id);
CREATE INDEX events_box ON events (box_id, id);
CREATE INDEX events_type ON events (type, id);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

-- Latest lock state from box/<id>/state: 'locked' or 'open'. NULL = never reported.
ALTER TABLE boxes ADD COLUMN lock_state TEXT CHECK (lock_state IS NULL OR lock_state IN ('locked', 'open'));
ALTER TABLE boxes ADD COLUMN lock_state_at TEXT;

CREATE TABLE panel_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  sheet       TEXT NOT NULL CHECK (sheet IN ('people', 'fobs', 'kit', 'boxes')),
  row_id      TEXT NOT NULL,
  -- DB column name, or '*' when the panel created the row.
  field       TEXT NOT NULL,
  old_value   TEXT CHECK (old_value IS NULL OR json_valid(old_value)),
  new_value   TEXT CHECK (new_value IS NULL OR json_valid(new_value)),
  fob_uid     TEXT NOT NULL,           -- admin fob that made the change
  event_id    INTEGER,                 -- the admin_action event it belongs to
  exported_at TEXT,                    -- set by export; NULL = still only on the panel
  resolved_at TEXT                     -- set when an import's "use sheet" overrode it
) STRICT;
CREATE INDEX panel_changes_open ON panel_changes (sheet, row_id, field) WHERE exported_at IS NULL AND resolved_at IS NULL;
