-- 003: lock boxes and OTA (weeks 5-6). All hub-owned, never in the workbook.
-- 1. What each box last reported: firmware version (heartbeat / state), door (reed switch) and
--    its latest firmware-update status (box/<id>/state `ota`).
-- 2. firmware: box firmware images the hub can serve at /fw/<file> (files in the firmware dir).

ALTER TABLE boxes ADD COLUMN fw TEXT;
ALTER TABLE boxes ADD COLUMN door_state TEXT CHECK (door_state IS NULL OR door_state IN ('open', 'shut'));
ALTER TABLE boxes ADD COLUMN door_state_at TEXT;
-- requested (hub asked), updating, refused, failed, rebooting, updated, rolled_back
ALTER TABLE boxes ADD COLUMN ota_status TEXT;
ALTER TABLE boxes ADD COLUMN ota_version TEXT;
ALTER TABLE boxes ADD COLUMN ota_why TEXT;
ALTER TABLE boxes ADD COLUMN ota_at TEXT;

CREATE TABLE firmware (
  version     TEXT PRIMARY KEY CHECK (length(version) BETWEEN 1 AND 32),
  file        TEXT NOT NULL UNIQUE,
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size        INTEGER NOT NULL CHECK (size > 0),
  uploaded_at TEXT NOT NULL,
  uploaded_by TEXT,                                   -- fob UID that uploaded it, if any
  source      TEXT NOT NULL CHECK (source IN ('panel', 'usb', 'api'))
) STRICT;
