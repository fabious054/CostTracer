//! Local scan-history store — SQLite via `rusqlite` (ADR 0002). Only the Rust core touches it;
//! the webview receives DTOs. One file at `app_local_data_dir()/costtracer.sqlite3`.

mod migrations;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::detectors::RawFinding;
use crate::error::{AppError, AppResult};
use crate::model::{
    ConfidenceInfo, ConfidenceLevel, DetectorKind, DetectorResult, RegionError, ResourceItem,
    ResourceRef, ResourceState, ResourceType, ScanResult, ScanStatus,
};
use crate::util::now_unix_secs;

const DETECTORS: [DetectorKind; 3] = [
    DetectorKind::EbsUnattached,
    DetectorKind::ElasticIpIdle,
    DetectorKind::OrphanSnapshot,
];

pub struct Db {
    conn: Mutex<Connection>,
}

/// One resource seen during a scan, plus the region it was in.
pub struct RegionFinding {
    pub region: String,
    pub finding: RawFinding,
}

/// A detector that failed for one region — surfaced to the user, other regions/detectors proceed.
pub struct DetectorRegionError {
    pub detector: DetectorKind,
    pub region: String,
    pub message: String,
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrations::run(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        migrations::run(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("scan-history db mutex poisoned")
    }

    /// Persist a scan: the `scan` row, one `observation` per resource, the `resource` streak
    /// upsert, and any per-region detector errors. Returns the new scan id.
    pub fn record_scan(
        &self,
        started_at: i64,
        finished_at: i64,
        account_id: &str,
        regions: &[String],
        status: ScanStatus,
        findings: &[RegionFinding],
        region_errors: &[DetectorRegionError],
    ) -> AppResult<i64> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;

        let status_str = match status {
            ScanStatus::Ok => "ok",
            ScanStatus::Partial => "partial",
        };
        tx.execute(
            "INSERT INTO scan (started_at, finished_at, account_id, regions_json, status)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                started_at,
                finished_at,
                account_id,
                serde_json::to_string(regions)?,
                status_str
            ],
        )?;
        let scan_id = tx.last_insert_rowid();

        for rf in findings {
            let f = &rf.finding;
            tx.execute(
                "INSERT INTO observation
                   (scan_id, observed_at, account_id, region, resource_type, resource_id,
                    in_alert, created_at, facts_json, display_name, neutral_note)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    scan_id,
                    started_at,
                    account_id,
                    rf.region,
                    f.resource_type.as_db(),
                    f.resource_id,
                    f.in_alert as i64,
                    f.created_at,
                    serde_json::to_string(&f.facts)?,
                    f.display_name,
                    f.neutral_note,
                ],
            )?;

            // Streak: an alerting observation extends (or starts) the streak; a non-alert
            // observation resets it. A resource absent from the scan is left untouched (ADR 0002).
            tx.execute(
                "INSERT INTO resource
                   (account_id, region, resource_type, resource_id,
                    first_seen_at, last_seen_at, first_alert_at, last_alert_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5,
                         CASE WHEN ?6 THEN ?5 ELSE NULL END,
                         CASE WHEN ?6 THEN ?5 ELSE NULL END)
                 ON CONFLICT (account_id, region, resource_type, resource_id) DO UPDATE SET
                   last_seen_at   = ?5,
                   first_alert_at = CASE WHEN ?6 THEN COALESCE(first_alert_at, ?5) ELSE NULL END,
                   last_alert_at  = CASE WHEN ?6 THEN ?5 ELSE NULL END",
                params![
                    account_id,
                    rf.region,
                    f.resource_type.as_db(),
                    f.resource_id,
                    started_at,
                    f.in_alert as i64,
                ],
            )?;
        }

        for e in region_errors {
            tx.execute(
                "INSERT INTO scan_region_error (scan_id, region, detector, message)
                 VALUES (?1, ?2, ?3, ?4)",
                params![scan_id, e.region, e.detector.as_db(), e.message],
            )?;
        }

        tx.commit()?;
        Ok(scan_id)
    }

    pub fn build_scan_result(&self, scan_id: i64, account_id: &str) -> AppResult<ScanResult> {
        let conn = self.lock();
        scan_result_from_conn(&conn, scan_id, account_id)
    }

    /// Most recent scan **for this account** — never another account's stale result.
    pub fn latest_scan_result(&self, account_id: &str) -> AppResult<Option<ScanResult>> {
        let conn = self.lock();
        let head: Option<i64> = conn
            .query_row(
                "SELECT id FROM scan WHERE account_id = ?1 ORDER BY id DESC LIMIT 1",
                params![account_id],
                |r| r.get(0),
            )
            .optional()?;
        match head {
            Some(id) => Ok(Some(scan_result_from_conn(&conn, id, account_id)?)),
            None => Ok(None),
        }
    }

    pub fn mark_intentional(&self, account_id: &str, r: &ResourceRef) -> AppResult<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO resource_exception
               (account_id, region, resource_type, resource_id, marked_at, note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (account_id, region, resource_type, resource_id) DO UPDATE SET
               marked_at = ?5, note = ?6",
            params![
                account_id,
                r.region,
                r.resource_type.as_db(),
                r.resource_id,
                now_unix_secs(),
                r.note,
            ],
        )?;
        Ok(())
    }

    pub fn unmark_intentional(&self, account_id: &str, r: &ResourceRef) -> AppResult<()> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM resource_exception
             WHERE account_id = ?1 AND region = ?2 AND resource_type = ?3 AND resource_id = ?4",
            params![account_id, r.region, r.resource_type.as_db(), r.resource_id],
        )?;
        Ok(())
    }
}

struct RawItemRow {
    region: String,
    resource_type: String,
    resource_id: String,
    in_alert: bool,
    created_at: Option<i64>,
    facts_json: String,
    display_name: Option<String>,
    neutral_note: Option<String>,
    first_seen_at: i64,
    first_alert_at: Option<i64>,
    last_alert_at: Option<i64>,
    intentional: bool,
}

impl RawItemRow {
    fn into_item(self) -> AppResult<ResourceItem> {
        let resource_type = ResourceType::from_db(&self.resource_type)
            .ok_or_else(|| AppError::msg(format!("unknown resource_type '{}'", self.resource_type)))?;
        let facts: Value = serde_json::from_str(&self.facts_json)?;

        let state = if self.in_alert {
            ResourceState::Alert
        } else {
            ResourceState::Neutral
        };

        let confidence = match (self.in_alert && !self.intentional, self.first_alert_at, self.last_alert_at)
        {
            (true, Some(first), Some(last)) => {
                let days = ((last - first) / 86_400).max(0);
                let scale = resource_type.confidence_scale();
                Some(ConfidenceInfo {
                    level: ConfidenceLevel::from_days(days, scale),
                    days_coverage: days,
                    scale,
                })
            }
            _ => None,
        };

        Ok(ResourceItem {
            resource_type,
            resource_id: self.resource_id,
            region: self.region,
            display_name: self.display_name,
            state,
            neutral_note: self.neutral_note,
            intentional: self.intentional,
            created_at: self.created_at,
            monitored_since: self.first_seen_at,
            confidence,
            facts,
        })
    }
}

fn scan_result_from_conn(
    conn: &Connection,
    scan_id: i64,
    account_id: &str,
) -> AppResult<ScanResult> {
    let (started_at, finished_at, regions_json, status_str): (i64, i64, String, String) = conn
        .query_row(
            "SELECT started_at, finished_at, regions_json, status FROM scan WHERE id = ?1",
            params![scan_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    let regions: Vec<String> = serde_json::from_str(&regions_json)?;
    let status = if status_str == "partial" {
        ScanStatus::Partial
    } else {
        ScanStatus::Ok
    };

    let mut stmt = conn.prepare(
        "SELECT o.region, o.resource_type, o.resource_id, o.in_alert, o.created_at, o.facts_json,
                o.display_name, o.neutral_note,
                r.first_seen_at, r.first_alert_at, r.last_alert_at,
                (e.marked_at IS NOT NULL) AS intentional
         FROM observation o
         JOIN resource r
           ON r.account_id = ?1 AND r.region = o.region
          AND r.resource_type = o.resource_type AND r.resource_id = o.resource_id
         LEFT JOIN resource_exception e
           ON e.account_id = ?1 AND e.region = o.region
          AND e.resource_type = o.resource_type AND e.resource_id = o.resource_id
         WHERE o.scan_id = ?2",
    )?;
    let rows = stmt.query_map(params![account_id, scan_id], |row| {
        Ok(RawItemRow {
            region: row.get(0)?,
            resource_type: row.get(1)?,
            resource_id: row.get(2)?,
            in_alert: row.get(3)?,
            created_at: row.get(4)?,
            facts_json: row.get(5)?,
            display_name: row.get(6)?,
            neutral_note: row.get(7)?,
            first_seen_at: row.get(8)?,
            first_alert_at: row.get(9)?,
            last_alert_at: row.get(10)?,
            intentional: row.get(11)?,
        })
    })?;

    let mut by_type: HashMap<ResourceType, Vec<ResourceItem>> = HashMap::new();
    for row in rows {
        let item = row?.into_item()?;
        by_type.entry(item.resource_type).or_default().push(item);
    }
    for items in by_type.values_mut() {
        items.sort_by(|a, b| sort_rank(a).cmp(&sort_rank(b)));
    }

    let mut errors: HashMap<DetectorKind, Vec<RegionError>> = HashMap::new();
    let mut err_stmt = conn.prepare(
        "SELECT detector, region, message FROM scan_region_error WHERE scan_id = ?1",
    )?;
    let err_rows = err_stmt.query_map(params![scan_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in err_rows {
        let (detector, region, message) = row?;
        if let Some(kind) = DetectorKind::from_db(&detector) {
            errors
                .entry(kind)
                .or_default()
                .push(RegionError { region, message });
        }
    }

    let detectors = DETECTORS
        .into_iter()
        .map(|kind| DetectorResult {
            kind,
            region_errors: errors.remove(&kind).unwrap_or_default(),
            items: by_type.remove(&kind.resource_type()).unwrap_or_default(),
        })
        .collect();

    Ok(ScanResult {
        scan_id,
        started_at,
        finished_at,
        account_id: account_id.to_string(),
        regions,
        status,
        detectors,
    })
}

/// Default order: active alerts first (widest coverage first), then intentional, then neutral.
fn sort_rank(i: &ResourceItem) -> (u8, i64, String) {
    let bucket = match (i.state, i.intentional) {
        (ResourceState::Alert, false) => 0,
        (ResourceState::Alert, true) => 1,
        (ResourceState::Neutral, _) => 2,
    };
    let days = i.confidence.as_ref().map(|c| -c.days_coverage).unwrap_or(0);
    (bucket, days, i.resource_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DAY: i64 = 86_400;

    fn finding(id: &str, in_alert: bool) -> RawFinding {
        RawFinding {
            resource_type: ResourceType::EbsVolume,
            resource_id: id.to_string(),
            in_alert,
            created_at: Some(1_000),
            display_name: None,
            neutral_note: None,
            facts: json!({}),
        }
    }

    fn scan_at(db: &Db, t: i64, id: &str, in_alert: bool) -> i64 {
        db.record_scan(
            t,
            t,
            "acc",
            &["us-east-1".to_string()],
            ScanStatus::Ok,
            &[RegionFinding {
                region: "us-east-1".to_string(),
                finding: finding(id, in_alert),
            }],
            &[],
        )
        .unwrap()
    }

    fn ebs_items(db: &Db, scan_id: i64) -> Vec<ResourceItem> {
        let mut r = db.build_scan_result(scan_id, "acc").unwrap();
        std::mem::take(&mut r.detectors[0].items)
    }

    #[test]
    fn coverage_is_the_span_between_first_and_last_alert() {
        let db = Db::in_memory().unwrap();
        scan_at(&db, 0, "vol-1", true);
        let sid = scan_at(&db, 8 * DAY, "vol-1", true);
        let items = ebs_items(&db, sid);
        let c = items[0].confidence.as_ref().unwrap();
        assert_eq!(c.days_coverage, 8);
        assert_eq!(c.level, ConfidenceLevel::Confirmed);
    }

    #[test]
    fn a_neutral_observation_resets_the_streak() {
        let db = Db::in_memory().unwrap();
        scan_at(&db, 0, "vol-1", true);
        scan_at(&db, 5 * DAY, "vol-1", false); // now in-use → reset
        let sid = scan_at(&db, 6 * DAY, "vol-1", true); // alerting again → fresh streak
        let items = ebs_items(&db, sid);
        assert_eq!(items[0].state, ResourceState::Alert);
        assert_eq!(items[0].confidence.as_ref().unwrap().days_coverage, 0);
    }

    #[test]
    fn a_missing_scan_does_not_reset_the_streak() {
        let db = Db::in_memory().unwrap();
        scan_at(&db, 0, "vol-1", true);
        // vol-1 absent from this scan (e.g. its region errored) — different resource only.
        scan_at(&db, 3 * DAY, "vol-2", true);
        let sid = scan_at(&db, 6 * DAY, "vol-1", true);
        assert_eq!(ebs_items(&db, sid)[0].confidence.as_ref().unwrap().days_coverage, 6);
    }

    #[test]
    fn neutral_resource_has_no_confidence() {
        let db = Db::in_memory().unwrap();
        let sid = scan_at(&db, 0, "vol-1", false);
        let items = ebs_items(&db, sid);
        assert_eq!(items[0].state, ResourceState::Neutral);
        assert!(items[0].confidence.is_none());
    }

    #[test]
    fn intentional_resource_stays_in_inventory_without_a_level() {
        let db = Db::in_memory().unwrap();
        scan_at(&db, 0, "vol-1", true);
        db.mark_intentional(
            "acc",
            &ResourceRef {
                resource_type: ResourceType::EbsVolume,
                resource_id: "vol-1".to_string(),
                region: "us-east-1".to_string(),
                note: None,
            },
        )
        .unwrap();
        let sid = scan_at(&db, 10 * DAY, "vol-1", true);
        let items = ebs_items(&db, sid);
        assert_eq!(items.len(), 1);
        assert!(items[0].intentional);
        assert!(items[0].confidence.is_none());
    }

    #[test]
    fn latest_returns_the_most_recent_scan() {
        let db = Db::in_memory().unwrap();
        scan_at(&db, 0, "vol-1", true);
        scan_at(&db, DAY, "vol-1", true);
        let latest = db.latest_scan_result("acc").unwrap().unwrap();
        assert_eq!(latest.detectors.len(), 3);
        assert_eq!(latest.detectors[0].items.len(), 1);
    }

    #[test]
    fn latest_is_scoped_to_the_account() {
        let db = Db::in_memory().unwrap();
        db.record_scan(
            0,
            0,
            "acct-a",
            &["us-east-1".to_string()],
            ScanStatus::Ok,
            &[RegionFinding {
                region: "us-east-1".to_string(),
                finding: finding("vol-a", true),
            }],
            &[],
        )
        .unwrap();
        // A newer scan on a different account must not leak into account A's latest.
        db.record_scan(
            DAY,
            DAY,
            "acct-b",
            &["us-east-1".to_string()],
            ScanStatus::Ok,
            &[RegionFinding {
                region: "us-east-1".to_string(),
                finding: finding("vol-b", true),
            }],
            &[],
        )
        .unwrap();

        let a = db.latest_scan_result("acct-a").unwrap().unwrap();
        assert_eq!(a.account_id, "acct-a");
        assert_eq!(a.detectors[0].items[0].resource_id, "vol-a");

        assert!(db.latest_scan_result("acct-c").unwrap().is_none());
    }
}
