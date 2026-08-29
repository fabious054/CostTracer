use rusqlite::Connection;

use crate::error::AppResult;

/// Schema v1 (ADR 0002). `observation` is the append-only source of truth; `resource` caches the
/// current alert streak and is rebuildable from `observation`.
const V1: &str = r#"
CREATE TABLE scan (
  id           INTEGER PRIMARY KEY,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER NOT NULL,
  account_id   TEXT NOT NULL,
  regions_json TEXT NOT NULL,
  status       TEXT NOT NULL
);

CREATE TABLE scan_region_error (
  scan_id  INTEGER NOT NULL REFERENCES scan(id),
  region   TEXT NOT NULL,
  detector TEXT NOT NULL,
  message  TEXT NOT NULL
);

CREATE TABLE observation (
  id            INTEGER PRIMARY KEY,
  scan_id       INTEGER NOT NULL REFERENCES scan(id),
  observed_at   INTEGER NOT NULL,
  account_id    TEXT NOT NULL,
  region        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  in_alert      INTEGER NOT NULL,
  created_at    INTEGER,
  facts_json    TEXT NOT NULL,
  display_name  TEXT,
  neutral_note  TEXT,
  UNIQUE (scan_id, account_id, region, resource_type, resource_id)
);
CREATE INDEX idx_obs_resource
  ON observation (account_id, region, resource_type, resource_id, observed_at);

CREATE TABLE resource (
  account_id     TEXT NOT NULL,
  region         TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  resource_id    TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  first_alert_at INTEGER,
  last_alert_at  INTEGER,
  PRIMARY KEY (account_id, region, resource_type, resource_id)
);

CREATE TABLE resource_exception (
  account_id    TEXT NOT NULL,
  region        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  marked_at     INTEGER NOT NULL,
  note          TEXT,
  PRIMARY KEY (account_id, region, resource_type, resource_id)
);
"#;

pub fn run(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(V1)?;
        conn.pragma_update(None, "user_version", 1)?;
    }
    Ok(())
}
