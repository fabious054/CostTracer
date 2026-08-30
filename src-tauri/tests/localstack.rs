//! Opt-in LocalStack harness for the Scope 3 cost engine (ADR 0003, decision D4).
//!
//! `#[ignore]` — NOT part of `cargo test` or CI. It needs LocalStack running and seeded:
//!
//!   docker compose -f docker-compose.localstack.yml up -d
//!   bash scripts/localstack-seed.sh
//!   ( cd src-tauri && AWS_ENDPOINT_URL=http://localhost:4566 \
//!       cargo test --test localstack -- --ignored --nocapture )
//!
//! It drives the real detector -> store -> pricing pipeline (no vault, no credential check)
//! against the seeded fixture and asserts the per-resource and per-detector cost figures —
//! including the "region not in the price table" path.
//!
//! Note: LocalStack/moto's `DescribeSnapshots` returns a large canned catalogue of AMI-backing
//! snapshots even for `owner-ids self`, so this test targets the resources it seeded (by their
//! `Name` tag) and asserts structural properties of the rollups rather than exact account totals.

use cost_tracer_lib::detectors::run_region;
use cost_tracer_lib::model::{
    ConfidenceLevel, CostUnavailable, DetectorKind, DetectorResult, ResourceItem, ScanResult,
    ScanStatus,
};
use cost_tracer_lib::store::{Db, DetectorRegionError, RegionFinding};

use aws_config::{BehaviorVersion, Region};
use aws_sdk_ec2::config::Credentials;
use aws_sdk_ec2::Client;

const PRICED_REGION: &str = "sa-east-1";
const UNPRICED_REGION: &str = "ca-central-1";

fn approx(got: Option<f64>, want: f64) {
    let g = got.expect("expected a priced estimate");
    assert!((g - want).abs() < 1e-6, "got {g}, want {want}");
}

fn detector(r: &ScanResult, k: DetectorKind) -> &DetectorResult {
    r.detectors
        .iter()
        .find(|d| d.kind == k)
        .unwrap_or_else(|| panic!("no {k:?} detector"))
}

fn named<'a>(d: &'a DetectorResult, name: &str) -> &'a ResourceItem {
    d.items
        .iter()
        .find(|i| i.display_name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("no seeded item named {name}"))
}

async fn ec2(region: &str) -> Client {
    let endpoint =
        std::env::var("AWS_ENDPOINT_URL").unwrap_or_else(|_| "http://localhost:4566".to_string());
    let cfg = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(region.to_string()))
        .endpoint_url(endpoint)
        .credentials_provider(Credentials::new("test", "test", None, None, "localstack"))
        .load()
        .await;
    Client::new(&cfg)
}

#[tokio::test]
#[ignore = "needs a running, seeded LocalStack — see the module docs"]
async fn cost_pipeline_against_localstack() {
    let mut findings: Vec<RegionFinding> = Vec::new();
    for region in [PRICED_REGION, UNPRICED_REGION] {
        let (region_findings, errs) = run_region(&ec2(region).await).await;
        assert!(errs.is_empty(), "{region}: detector errors: {errs:?}");
        for f in region_findings {
            findings.push(RegionFinding {
                region: region.to_string(),
                finding: f,
            });
        }
    }

    let path = std::env::temp_dir().join(format!("ct-localstack-{}.sqlite3", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let db = Db::open(&path).expect("open scan-history db");

    let no_errors: Vec<DetectorRegionError> = Vec::new();
    let scan_id = db
        .record_scan(
            0,
            0,
            "acct-localstack",
            &[PRICED_REGION.to_string(), UNPRICED_REGION.to_string()],
            ScanStatus::Ok,
            &findings,
            &no_errors,
        )
        .expect("record scan");
    let result = db
        .build_scan_result(scan_id, "acct-localstack")
        .expect("build scan result");
    let _ = std::fs::remove_file(&path);

    assert!(result.fx_usd_brl > 0.0, "fx rate should be present");

    // --- EBS: priced sa-east-1 gp3, 500 GiB (moto seeds no volumes, so this detector is clean) ---
    let ebs = detector(&result, DetectorKind::EbsUnattached);
    let priced = named(ebs, "ct-idle-gp3");
    assert_eq!(priced.region, PRICED_REGION);
    approx(priced.estimated_cost.as_ref().unwrap().monthly_usd, 500.0 * 0.1276);

    // --- EBS: region not in the price table -> unavailable, never approximated ---
    let unpriced = named(ebs, "ct-unpriced");
    assert_eq!(unpriced.region, UNPRICED_REGION);
    let ec = unpriced.estimated_cost.as_ref().unwrap();
    assert!(ec.monthly_usd.is_none());
    assert_eq!(ec.unavailable, Some(CostUnavailable::Region));

    assert_eq!(ebs.cost_rollup.priced_count, 1);
    assert_eq!(ebs.cost_rollup.unpriced_count, 1);
    approx(Some(ebs.cost_rollup.monthly_usd), 500.0 * 0.1276);

    // --- Elastic IP: flat idle hourly x 730 (moto seeds no addresses) ---
    let eip = detector(&result, DetectorKind::ElasticIpIdle);
    let eip_item = eip.items.first().expect("an EIP item");
    assert_eq!(eip.items.len(), 1);
    approx(eip_item.estimated_cost.as_ref().unwrap().monthly_usd, 0.005 * 730.0);

    // --- Snapshot: source volume size x rate, flagged as an upper bound ---
    let snap = detector(&result, DetectorKind::OrphanSnapshot);
    let snap_item = named(snap, "ct-orphan-snap");
    let size = snap_item.facts["sizeGiB"].as_f64().expect("snapshot size fact");
    assert_eq!(size, 200.0, "seeded source volume was 200 GiB");
    let snap_cost = snap_item.estimated_cost.as_ref().unwrap();
    approx(snap_cost.monthly_usd, size * 0.0684);
    assert!(
        !snap_cost.qualifiers.is_empty(),
        "snapshot estimate should carry the 'full volume size' caveat"
    );

    // --- Account rollup: brand-new resources are Observed, so nothing is in the primary figure ---
    let acct = result.cost_rollup;
    assert_eq!(acct.primary_monthly_usd, 0.0, "nothing is Probable/Confirmed yet");
    assert!(acct.context_monthly_usd > 0.0);
    assert!(acct.unpriced_count >= 1, "the ca-central-1 volume must count as unpriced");
    assert!(
        snap_item.confidence.as_ref().map(|c| c.level) == Some(ConfidenceLevel::Observed),
        "first sighting is Observed"
    );
}
