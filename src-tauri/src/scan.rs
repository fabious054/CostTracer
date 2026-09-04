//! Progressive multi-region scan orchestrator (Scope 4, ADR 0004). Loads the stored credential,
//! discovers the account's enabled regions via `ec2:DescribeRegions`, then runs the detectors
//! region-by-region — persisting and emitting each region as it finishes, and stopping cleanly on
//! cancellation. Read-only against AWS.
//!
//! Prices: the scan **never** fetches. It loads one read snapshot (`PriceBook`) from the local
//! `pricing-cache.sqlite3` and reads from that; a background refresher keeps the cache warm
//! (ADR 0006 D2).

use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use crate::aws;
use crate::detectors;
use crate::error::{AppError, AppResult};
use crate::model::{
    ScanDoneEvent, ScanRegionEvent, ScanRunOutcome, ScanStartedEvent, ScanStatus, ValidationOutcome,
};
use crate::pricing::{price_needs, PriceCache, PriceRefresher};
use crate::store::Db;
use crate::util::now_unix_secs;
use crate::vault;

pub async fn run_scan(
    app: &AppHandle,
    db: &Db,
    price_cache: &PriceCache,
    refresher: &PriceRefresher,
    cancel: CancellationToken,
) -> AppResult<ScanRunOutcome> {
    let stored = match vault::load()? {
        Some(s) => s,
        None => return Ok(ScanRunOutcome::ReauthRequired),
    };

    // A base config for validation + region discovery. `us-east-1` is only the STS home here;
    // each region gets its own client below.
    let base = aws::config::from_static_keys(
        &stored.access_key_id,
        &stored.secret_access_key,
        stored.session_token.clone(),
        "us-east-1",
    )
    .await;

    // Fail fast (and cleanly) if the stored credential no longer validates.
    if !matches!(
        aws::identity::validate(&base).await,
        ValidationOutcome::Ok { .. }
    ) {
        return Ok(ScanRunOutcome::ReauthRequired);
    }

    // No manual region choice in this version — the account's enabled regions are the scan set
    // (ADR 0004). A discovery failure is a hard error, never a silent single-region fallback.
    let regions = aws::regions::enabled_regions(&base).await.map_err(|e| {
        AppError::msg(format!(
            "CostTracer couldn't list your account's regions ({e}). \
             Grant ec2:DescribeRegions — see docs/iam-policy-minimal.json."
        ))
    })?;

    let started_at = now_unix_secs();
    let scan_id = db.begin_scan(started_at, &stored.account_id, &regions)?;
    let _ = app.emit(
        "scan://started",
        ScanStartedEvent {
            scan_id,
            regions: regions.clone(),
        },
    );

    // One plain read of the local price cache for this scan's whole grid — no network, ADR 0006.
    // Absent entries surface as "price pending" until the background refresher fills them.
    let price_book = price_cache.load_book(&price_needs(&regions), started_at)?;

    let mut any_error = false;
    let mut cancelled = false;

    for region in &regions {
        let cfg = aws::config::from_static_keys(
            &stored.access_key_id,
            &stored.secret_access_key,
            stored.session_token.clone(),
            region,
        )
        .await;

        // Cancel wins the race — the region's AWS calls are dropped mid-flight and nothing is
        // persisted for it. Regions already written stay; the rest never run (ADR 0004 D1/D5).
        // `run_region` builds its own per-service clients from `cfg` (ADR 0005 D4).
        let (findings, errs) = tokio::select! {
            biased;
            _ = cancel.cancelled() => { cancelled = true; break; }
            out = detectors::run_region(&cfg) => out,
        };

        db.record_region(scan_id, started_at, &stored.account_id, region, &findings, &errs)?;
        if !errs.is_empty() {
            any_error = true;
        }
        let region_status = if errs.is_empty() {
            ScanStatus::Ok
        } else {
            ScanStatus::Partial
        };

        let result = db.build_scan_result(scan_id, &stored.account_id, &price_book)?;
        let _ = app.emit(
            "scan://region",
            ScanRegionEvent {
                scan_id,
                region: region.clone(),
                region_status,
                result,
            },
        );
    }

    let final_status = if cancelled {
        ScanStatus::Cancelled
    } else if any_error {
        ScanStatus::Partial
    } else {
        ScanStatus::Ok
    };
    db.finish_scan(scan_id, final_status, now_unix_secs())?;
    let _ = app.emit(
        "scan://done",
        ScanDoneEvent {
            scan_id,
            status: final_status,
        },
    );

    // Nudge the background refresher — cheap if the cache is already warm, and closes the gap for
    // a region the account opted into since the last cycle (ADR 0006 D2b).
    refresher.nudge();

    let result = db.build_scan_result(scan_id, &stored.account_id, &price_book)?;
    Ok(match final_status {
        ScanStatus::Cancelled => ScanRunOutcome::Cancelled { result },
        _ => ScanRunOutcome::Ok { result },
    })
}
