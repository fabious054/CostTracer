//! Scope 2 scan orchestrator: load the stored credential, run the 3 detectors across the
//! connected account's regions, persist the scan, and return the full inventory with computed
//! confidence. Read-only against AWS.

use crate::aws;
use crate::detectors;
use crate::error::AppResult;
use crate::model::{ScanRunOutcome, ScanStatus, ValidationOutcome};
use crate::store::{Db, DetectorRegionError, RegionFinding};
use crate::util::now_unix_secs;
use crate::vault;

pub async fn run_scan(db: &Db) -> AppResult<ScanRunOutcome> {
    let stored = match vault::load()? {
        Some(s) => s,
        None => return Ok(ScanRunOutcome::ReauthRequired),
    };

    let regions: Vec<String> = if stored.regions.is_empty() {
        vec![stored.region.clone()]
    } else {
        stored.regions.clone()
    };

    // Fail fast (and cleanly) if the stored credential no longer validates — e.g. a temporary
    // credential that has since expired.
    let probe = aws::config::from_static_keys(
        &stored.access_key_id,
        &stored.secret_access_key,
        stored.session_token.clone(),
        &regions[0],
    )
    .await;
    if !matches!(
        aws::identity::validate(&probe).await,
        ValidationOutcome::Ok { .. }
    ) {
        return Ok(ScanRunOutcome::ReauthRequired);
    }

    let started_at = now_unix_secs();
    let mut findings: Vec<RegionFinding> = Vec::new();
    let mut region_errors: Vec<DetectorRegionError> = Vec::new();

    for region in &regions {
        let cfg = aws::config::from_static_keys(
            &stored.access_key_id,
            &stored.secret_access_key,
            stored.session_token.clone(),
            region,
        )
        .await;
        let ec2 = aws_sdk_ec2::Client::new(&cfg);

        let (region_findings, region_errs) = detectors::run_region(&ec2).await;
        for finding in region_findings {
            findings.push(RegionFinding {
                region: region.clone(),
                finding,
            });
        }
        for (detector, message) in region_errs {
            region_errors.push(DetectorRegionError {
                detector,
                region: region.clone(),
                message,
            });
        }
    }

    let finished_at = now_unix_secs();
    let status = if region_errors.is_empty() {
        ScanStatus::Ok
    } else {
        ScanStatus::Partial
    };

    let scan_id = db.record_scan(
        started_at,
        finished_at,
        &stored.account_id,
        &regions,
        status,
        &findings,
        &region_errors,
    )?;
    let result = db.build_scan_result(scan_id, &stored.account_id)?;
    Ok(ScanRunOutcome::Ok { result })
}
