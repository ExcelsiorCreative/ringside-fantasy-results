-- Ringside Results DB: initial schema (Cloudflare D1 / SQLite)
-- Booleans are INTEGER 0/1; timestamps are ISO-8601 UTC text.

CREATE TABLE wrestlers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_search TEXT NOT NULL,
  promotion TEXT NOT NULL CHECK (promotion IN ('WWE','AEW','TNA','NXT')),
  gender TEXT NOT NULL CHECK (gender IN ('M','W')),
  active INTEGER NOT NULL DEFAULT 1,
  overall_rank INTEGER,
  rank_in_gender INTEGER,
  baseline_2026_wins INTEGER,
  baseline_2026_losses INTEGER,
  baseline_career_wins INTEGER,
  baseline_career_losses INTEGER,
  baseline_as_of TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX wrestlers_search ON wrestlers(name_search);

CREATE TABLE aliases (
  alias_search TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  wrestler_id TEXT NOT NULL REFERENCES wrestlers(id),
  source TEXT NOT NULL DEFAULT 'seed'
);
CREATE INDEX aliases_wrestler ON aliases(wrestler_id);

CREATE TABLE stables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_search TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'tag' CHECK (type IN ('tag','trio','stable')),
  promotion TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE stable_members (
  stable_id TEXT NOT NULL REFERENCES stables(id),
  wrestler_id TEXT NOT NULL REFERENCES wrestlers(id),
  joined_on TEXT,
  left_on TEXT,
  PRIMARY KEY (stable_id, wrestler_id)
);

CREATE TABLE shows (
  id TEXT PRIMARY KEY,                 -- e.g. wikipedia:12345:n1
  promotion TEXT NOT NULL,
  name TEXT NOT NULL,
  show_type TEXT NOT NULL DEFAULT 'ple' CHECK (show_type IN ('weekly','ple','special')),
  date TEXT NOT NULL,
  local_start_time TEXT,
  time_zone TEXT,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','held')),
  confidence REAL NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  hold_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  UNIQUE (source, source_event_id)
);
CREATE INDEX shows_date ON shows(date);

CREATE TABLE matches (
  id TEXT PRIMARY KEY,                 -- show_id + ':' + match_number
  show_id TEXT NOT NULL REFERENCES shows(id),
  match_number INTEGER NOT NULL,
  is_main_event INTEGER NOT NULL DEFAULT 0,
  pre_show INTEGER NOT NULL DEFAULT 0,
  match_type TEXT NOT NULL,
  stipulation TEXT,
  is_qualifier INTEGER NOT NULL DEFAULT 0,
  is_tournament INTEGER NOT NULL DEFAULT 0,
  finish TEXT NOT NULL DEFAULT 'unknown',
  title_championship_id TEXT REFERENCES championships(id),
  title_outcome TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL CHECK (status IN ('published','held','expired')),
  confidence REAL NOT NULL DEFAULT 1,
  hold_reason TEXT,
  first_held_at TEXT,
  raw_text TEXT,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  UNIQUE (show_id, match_number)
);
CREATE INDEX matches_status ON matches(status);
CREATE INDEX matches_title ON matches(title_championship_id);

CREATE TABLE match_participants (
  match_id TEXT NOT NULL REFERENCES matches(id),
  wrestler_id TEXT,                    -- null while the name is unknown (match is held)
  raw_name TEXT NOT NULL,
  side INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('win','loss','draw','no_contest')),
  champion_going_in INTEGER NOT NULL DEFAULT 0,
  lost_by_dq_or_interference INTEGER NOT NULL DEFAULT 0,
  rumble_entry INTEGER, rumble_eliminations INTEGER, rumble_place INTEGER,
  chamber_entered INTEGER NOT NULL DEFAULT 0, chamber_eliminations INTEGER,
  mitb_entered INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, raw_name)
);
CREATE INDEX mp_wrestler ON match_participants(wrestler_id);

CREATE TABLE cash_ins (
  match_id TEXT NOT NULL REFERENCES matches(id),
  wrestler_id TEXT NOT NULL REFERENCES wrestlers(id),
  success INTEGER NOT NULL,
  PRIMARY KEY (match_id, wrestler_id)
);

CREATE TABLE championships (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_search TEXT NOT NULL,
  promotion TEXT NOT NULL,
  gender TEXT NOT NULL,
  holders_per_reign INTEGER NOT NULL DEFAULT 1,
  wiki_page TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE reigns (
  id TEXT PRIMARY KEY,
  championship_id TEXT NOT NULL REFERENCES championships(id),
  started_on TEXT,
  started_match_id TEXT,
  ended_on TEXT,
  ended_match_id TEXT,
  vacated INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX reigns_open ON reigns(championship_id, ended_on);
CREATE TABLE reign_holders (
  reign_id TEXT NOT NULL REFERENCES reigns(id),
  wrestler_id TEXT NOT NULL REFERENCES wrestlers(id),
  PRIMARY KEY (reign_id, wrestler_id)
);

CREATE TABLE briefcases (
  id TEXT PRIMARY KEY,
  promotion TEXT NOT NULL,
  gender TEXT NOT NULL,
  holder_wrestler_id TEXT NOT NULL REFERENCES wrestlers(id),
  won_match_id TEXT,
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','cashed_success','cashed_failed','lost')),
  resolved_match_id TEXT
);

CREATE TABLE status_entries (
  id TEXT PRIMARY KEY,
  wrestler_id TEXT NOT NULL REFERENCES wrestlers(id),
  kind TEXT NOT NULL CHECK (kind IN ('injured','away','suspended','inactive')),
  note TEXT,
  started_on TEXT,
  ended_on TEXT,
  ended_reason TEXT,
  source TEXT NOT NULL,
  source_url TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX status_open ON status_entries(wrestler_id, ended_on);

CREATE TABLE news_items (
  id TEXT PRIMARY KEY,
  wrestler_id TEXT NOT NULL REFERENCES wrestlers(id),
  text TEXT NOT NULL,
  as_of TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto','imported'))
);
CREATE INDEX news_wrestler ON news_items(wrestler_id, as_of);

CREATE TABLE unknown_names (
  normalized TEXT PRIMARY KEY,
  raw_name TEXT NOT NULL,
  source_url TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  times_seen INTEGER NOT NULL DEFAULT 1,
  resolved_wrestler_id TEXT
);

CREATE TABLE ingestion_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  shows_seen INTEGER NOT NULL DEFAULT 0,
  matches_new INTEGER NOT NULL DEFAULT 0,
  matches_changed INTEGER NOT NULL DEFAULT 0,
  matches_held INTEGER NOT NULL DEFAULT 0,
  unknown_names INTEGER NOT NULL DEFAULT 0,
  d1_writes INTEGER NOT NULL DEFAULT 0,
  errors TEXT
);

CREATE TABLE change_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,          -- wrestler | show | match | championship | status | news
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('upsert','delete')),
  version INTEGER NOT NULL DEFAULT 1,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at TEXT
);

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE usage_daily (
  day TEXT PRIMARY KEY,
  writes INTEGER NOT NULL DEFAULT 0,
  api_requests INTEGER NOT NULL DEFAULT 0
);

INSERT INTO config(key, value) VALUES
  ('source.wikipedia.enabled', 'true'),
  ('source.cagematch.enabled', 'false'),
  ('cagematch_permission_confirmed', 'false'),
  ('source.official_sites.enabled', 'false'),
  ('hold_retry_days', '14'),
  ('recheck_days', '7'),
  ('status_unconfirmed_days', '120'),
  ('records_year', '2026'),
  ('data_time_zone', 'America/New_York');
