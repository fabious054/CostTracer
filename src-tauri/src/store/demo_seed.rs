//! DEV-ONLY (`#[cfg(debug_assertions)]`). Writes a realistic mid/large-company scan into the
//! store so the cost/inventory UI can be reviewed with representative data — every confidence
//! level, both currencies, the qualifiers, priced and unpriced regions, intentional and neutral
//! rows, and (Scope 5) the CloudWatch Logs / RDS-snapshot detectors. No AWS contact. Kept
//! permanently as a dev tool (CLAUDE.md scope-closure checklist, item 2 exception), not removed
//! at any scope close. Grep marker: DEV-ONLY.

use rusqlite::{params, Connection};
use serde_json::json;

use crate::error::AppResult;
use crate::model::ResourceType;
use crate::util::now_unix_secs;

const DAY: i64 = 86_400;

struct Row {
    kind: ResourceType,
    id: &'static str,
    name: &'static str,
    region: &'static str,
    /// EBS / snapshot size in GiB; 0 for Elastic IP.
    size_gib: i64,
    /// EBS volume type; "" otherwise.
    vol_type: &'static str,
    /// Span between first and last alerting observation — drives the confidence level.
    coverage_days: i64,
    /// false = in use / associated: neutral, no confidence, no cost.
    alerting: bool,
    intentional: bool,
    /// `created_at` age in days; negative => NULL (Elastic IP has no creation date).
    created_days_ago: i64,
}

fn ebs(
    id: &'static str,
    name: &'static str,
    region: &'static str,
    vol_type: &'static str,
    size_gib: i64,
    coverage_days: i64,
    created_days_ago: i64,
) -> Row {
    Row {
        kind: ResourceType::EbsVolume,
        id,
        name,
        region,
        size_gib,
        vol_type,
        coverage_days,
        alerting: true,
        intentional: false,
        created_days_ago,
    }
}

fn eip(id: &'static str, name: &'static str, region: &'static str, coverage_days: i64) -> Row {
    Row {
        kind: ResourceType::ElasticIp,
        id,
        name,
        region,
        size_gib: 0,
        vol_type: "",
        coverage_days,
        alerting: true,
        intentional: false,
        created_days_ago: -1,
    }
}

fn snap(
    id: &'static str,
    name: &'static str,
    region: &'static str,
    size_gib: i64,
    coverage_days: i64,
    created_days_ago: i64,
) -> Row {
    Row {
        kind: ResourceType::EbsSnapshot,
        id,
        name,
        region,
        size_gib,
        vol_type: "",
        coverage_days,
        alerting: true,
        intentional: false,
        created_days_ago,
    }
}

/// CloudWatch Logs group. `stored_gb` doubles as the size fact (→ `storedBytes`); 0 = empty
/// group (priced $0.00, still an alert). Standard confidence scale.
fn log_group(
    path: &'static str,
    region: &'static str,
    stored_gb: i64,
    coverage_days: i64,
    created_days_ago: i64,
) -> Row {
    Row {
        kind: ResourceType::CloudwatchLogGroup,
        id: path,
        name: path,
        region,
        size_gib: stored_gb,
        vol_type: "",
        coverage_days,
        alerting: true,
        intentional: false,
        created_days_ago,
    }
}

/// Manual RDS snapshot. `allocated_gb` is the source instance's allocated storage. Snapshot scale.
fn rds_snap(
    id: &'static str,
    name: &'static str,
    region: &'static str,
    allocated_gb: i64,
    coverage_days: i64,
    created_days_ago: i64,
) -> Row {
    Row {
        kind: ResourceType::RdsSnapshot,
        id,
        name,
        region,
        size_gib: allocated_gb,
        vol_type: "",
        coverage_days,
        alerting: true,
        intentional: false,
        created_days_ago,
    }
}

fn neutral(mut r: Row) -> Row {
    r.alerting = false;
    r
}
fn intentional(mut r: Row) -> Row {
    r.intentional = true;
    r
}

/// ~30 resources across the 9 priced regions plus `ap-south-1` / `ca-central-1` (unpriced), a
/// spread of confidence levels on both scales, io1/io2 (IOPS qualifier), a couple marked
/// intentional, and a few neutral (in-use) rows.
fn fixture() -> Vec<Row> {
    vec![
        // --- Unattached EBS volumes ---
        ebs("vol-0a1b2c3d4e5f60001", "prod-pg-primary-data (retired)", "us-east-1", "gp3", 512, 44, 410),
        ebs("vol-0a1b2c3d4e5f60002", "emr-spark-scratch-01", "us-east-1", "gp3", 1024, 31, 205),
        ebs("vol-0a1b2c3d4e5f60003", "gitlab-runner-cache-use2", "us-east-2", "gp2", 120, 12, 88),
        ebs("vol-0a1b2c3d4e5f60004", "oracle-redo-legacy", "us-east-1", "io1", 200, 8, 150),
        ebs("vol-0a1b2c3d4e5f60005", "ml-checkpoints-west", "us-west-2", "io2", 2048, 6, 40),
        ebs("vol-0a1b2c3d4e5f60006", "staging-es-data-eu", "eu-west-1", "gp3", 256, 5, 61),
        intentional(ebs("vol-0a1b2c3d4e5f60007", "backup-mysql-staging", "eu-central-1", "gp2", 300, 4, 75)),
        ebs("vol-0a1b2c3d4e5f60008", "jenkins-ws-eu", "eu-west-1", "gp3", 128, 3, 30),
        ebs("vol-0a1b2c3d4e5f60009", "dev-sandbox-scratch-apse1", "ap-southeast-1", "gp3", 64, 2, 20),
        ebs("vol-0a1b2c3d4e5f6000a", "perf-loadgen-apne1", "ap-northeast-1", "gp3", 80, 1, 9),
        // region not in the price table -> "unavailable", counted separately
        ebs("vol-0a1b2c3d4e5f6000b", "archive-apsouth", "ap-south-1", "gp3", 400, 10, 120),
        // neutral (in use) — no cost line
        neutral(ebs("vol-0a1b2c3d4e5f6000c", "prod-web-root-01", "us-east-1", "gp3", 30, 0, 300)),
        neutral(ebs("vol-0a1b2c3d4e5f6000d", "prod-web-root-02", "us-east-1", "gp3", 30, 0, 300)),
        // --- Idle Elastic IPs ---
        eip("eipalloc-0aa11bb22cc330001", "nat-gw-decommissioned-use1", "us-east-1", 58),
        eip("eipalloc-0aa11bb22cc330002", "old-bastion-eip", "us-east-1", 21),
        eip("eipalloc-0aa11bb22cc330003", "bluegreen-swap-leftover", "us-west-2", 6),
        eip("eipalloc-0aa11bb22cc330004", "eu-vpn-endpoint-old", "eu-west-1", 2),
        neutral(eip("eipalloc-0aa11bb22cc330005", "prod-nat-gw-use1", "us-east-1", 0)),
        // --- Orphan snapshots (slower scale: Persisting >=7, Probable >=19, Confirmed >=30) ---
        snap("snap-0c1d2e3f4a5b60001", "ami-build-2024-legacy", "us-east-1", 30, 240, 245),
        snap("snap-0c1d2e3f4a5b60002", "prod-db-pre-upgrade-2025", "us-east-1", 512, 92, 96),
        intentional(snap("snap-0c1d2e3f4a5b60003", "compliance-2025q3-eu", "eu-west-1", 256, 61, 64)),
        snap("snap-0c1d2e3f4a5b60004", "tf-state-vol-snap", "us-east-2", 8, 33, 36),
        snap("snap-0c1d2e3f4a5b60005", "detached-appserver-snap", "us-west-2", 100, 24, 26),
        snap("snap-0c1d2e3f4a5b60006", "test-restore-point-eu", "eu-central-1", 200, 20, 22),
        snap("snap-0c1d2e3f4a5b60007", "lambda-layer-build-apse1", "ap-southeast-1", 16, 11, 13),
        snap("snap-0c1d2e3f4a5b60008", "hotfix-rollback-apne1", "ap-northeast-1", 64, 8, 10),
        snap("snap-0c1d2e3f4a5b60009", "sa-east-nightly-old", "sa-east-1", 128, 4, 6),
        // region not in the price table
        snap("snap-0c1d2e3f4a5b6000a", "ca-central-archive", "ca-central-1", 300, 35, 38),
        // --- CloudWatch Logs groups with no retention (standard scale) ---
        log_group("/aws/lambda/prod-image-resize", "us-east-1", 40, 90, 410),
        log_group("/aws/lambda/legacy-cron-worker", "us-east-1", 5, 30, 210),
        log_group("/aws/ecs/staging-api", "eu-west-1", 12, 6, 45),
        // empty group — priced $0.00, still flagged
        log_group("/aws/apigateway/dev-sandbox", "us-west-2", 0, 3, 20),
        intentional(log_group("/aws/lambda/audit-trail-keep", "eu-central-1", 8, 20, 60)),
        // region not in the price table
        log_group("/aws/lambda/apsouth-batch", "ap-south-1", 15, 12, 120),
        // neutral — retention IS set
        neutral(log_group("/aws/lambda/prod-checkout", "us-east-1", 20, 0, 300)),
        // --- Orphan manual RDS snapshots (snapshot scale) ---
        rds_snap("prod-pg-final-2024", "prod-pg-final-2024", "us-east-1", 200, 240, 245),
        rds_snap("manual-mysql-preupgrade", "manual-mysql-preupgrade", "us-east-1", 512, 92, 96),
        intentional(rds_snap("compliance-2025q3", "compliance-2025q3", "eu-west-1", 256, 61, 64)),
        rds_snap("analytics-rds-detached", "analytics-rds-detached", "us-west-2", 100, 24, 26),
        rds_snap("hotfix-restore-point", "hotfix-restore-point", "eu-central-1", 64, 11, 13),
        // region not in the price table
        rds_snap("ca-central-rds-archive", "ca-central-rds-archive", "ca-central-1", 300, 35, 38),
        // neutral — source instance still exists
        neutral(rds_snap("nightly-prod-ok", "nightly-prod-ok", "us-east-1", 128, 0, 5)),
    ]
}

fn facts_for(r: &Row) -> serde_json::Value {
    match r.kind {
        ResourceType::EbsVolume => json!({
            "sizeGiB": r.size_gib,
            "az": format!("{}a", r.region),
            "type": r.vol_type,
            "state": if r.alerting { "available" } else { "in-use" },
        }),
        ResourceType::ElasticIp => {
            let o = r.id.bytes().map(|b| b as u32).sum::<u32>() % 200 + 20;
            json!({ "publicIp": format!("52.{}.{}.{}", o % 255, (o * 7) % 255, (o * 13) % 255) })
        }
        ResourceType::EbsSnapshot => json!({
            "sizeGiB": r.size_gib,
            "sourceVolumeId": if r.alerting { serde_json::Value::Null } else { json!("vol-0f0f0f0f0f0f0f0f0") },
        }),
        ResourceType::CloudwatchLogGroup => json!({
            "storedBytes": r.size_gib * 1_000_000_000,
            "retentionDays": if r.alerting { serde_json::Value::Null } else { json!(30) },
            "logGroupClass": "STANDARD",
        }),
        ResourceType::RdsSnapshot => json!({
            "allocatedStorageGb": r.size_gib,
            "sourceDbInstanceId": if r.alerting { serde_json::Value::Null } else { json!("db-prod-1") },
            "engine": "postgres",
        }),
    }
}

/// Replace this account's scan history with the fixture. Returns the new scan id.
pub fn seed(conn: &Connection, account_id: &str) -> AppResult<i64> {
    for table in [
        "scan_region_error",
        "observation",
        "resource",
        "resource_exception",
        "scan",
    ] {
        // scan_region_error / observation reference scan(id); clear children first.
        if table == "scan" || table == "resource" || table == "resource_exception" {
            conn.execute(&format!("DELETE FROM {table} WHERE account_id = ?1"), params![account_id])?;
        } else {
            conn.execute(
                &format!(
                    "DELETE FROM {table} WHERE scan_id IN (SELECT id FROM scan WHERE account_id = ?1)"
                ),
                params![account_id],
            )?;
        }
    }

    let rows = fixture();
    let now = now_unix_secs();
    let mut regions: Vec<&str> = rows.iter().map(|r| r.region).collect();
    regions.sort_unstable();
    regions.dedup();

    conn.execute(
        "INSERT INTO scan (started_at, finished_at, account_id, regions_json, status)
         VALUES (?1, ?2, ?3, ?4, 'ok')",
        params![now - 90, now, account_id, serde_json::to_string(&regions)?],
    )?;
    let scan_id = conn.last_insert_rowid();

    for r in &rows {
        let created_at: Option<i64> =
            (r.created_days_ago >= 0).then(|| now - r.created_days_ago * DAY);
        let first_alert_at: Option<i64> = r.alerting.then(|| now - r.coverage_days * DAY);
        let last_alert_at: Option<i64> = r.alerting.then_some(now);
        let first_seen_at = now - r.coverage_days.max(r.created_days_ago).max(1) * DAY;

        conn.execute(
            "INSERT INTO observation
               (scan_id, observed_at, account_id, region, resource_type, resource_id,
                in_alert, created_at, facts_json, display_name, neutral_note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
            params![
                scan_id,
                now,
                account_id,
                r.region,
                r.kind.as_db(),
                r.id,
                r.alerting as i64,
                created_at,
                serde_json::to_string(&facts_for(r))?,
                r.name,
            ],
        )?;

        conn.execute(
            "INSERT INTO resource
               (account_id, region, resource_type, resource_id,
                first_seen_at, last_seen_at, first_alert_at, last_alert_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                account_id,
                r.region,
                r.kind.as_db(),
                r.id,
                first_seen_at,
                now,
                first_alert_at,
                last_alert_at,
            ],
        )?;

        if r.intentional {
            conn.execute(
                "INSERT INTO resource_exception
                   (account_id, region, resource_type, resource_id, marked_at, note)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
                params![account_id, r.region, r.kind.as_db(), r.id, now],
            )?;
        }
    }

    Ok(scan_id)
}
