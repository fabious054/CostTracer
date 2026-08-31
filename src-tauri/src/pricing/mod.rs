//! Fixed local price table + the pure per-resource cost estimate (ADR 0003).
//!
//! The table (`price-table.toml`) is embedded at build time and parsed once. `estimate` is a
//! pure function of `(resource_type, region, facts)` — it never calls AWS and never approximates
//! a region that isn't in the table (it reports `unavailable` instead).

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

use crate::model::{
    CostBasis, CostQualifier, CostUnavailable, EstimatedCost, ResourceType,
};

const RAW: &str = include_str!("price-table.toml");

#[derive(Debug, Deserialize)]
struct Meta {
    hours_per_month: f64,
    #[allow(dead_code)]
    captured: String,
}

#[derive(Debug, Deserialize)]
struct Fx {
    usd_brl: f64,
}

#[derive(Debug, Deserialize)]
struct RawTable {
    meta: Meta,
    fx: Fx,
    /// region -> volume type -> USD per GiB-month
    ebs: HashMap<String, HashMap<String, f64>>,
    /// region -> USD per hour (idle address)
    elastic_ip: HashMap<String, f64>,
    /// region -> USD per GB-month (EBS snapshot stored data)
    snapshot: HashMap<String, f64>,
    /// region -> USD per GB-month (CloudWatch Logs storage; ADR 0005 D3)
    cw_logs: HashMap<String, f64>,
    /// region -> USD per GB-month (RDS backup / snapshot storage)
    rds_snapshot: HashMap<String, f64>,
}

struct PriceTable {
    raw: RawTable,
}

fn table() -> &'static PriceTable {
    static T: OnceLock<PriceTable> = OnceLock::new();
    T.get_or_init(|| {
        let raw: RawTable = toml::from_str(RAW).expect("price-table.toml is malformed");
        assert!(raw.meta.hours_per_month > 0.0, "meta.hours_per_month must be > 0");
        assert!(raw.fx.usd_brl > 0.0, "fx.usd_brl must be > 0");
        for (region, types) in &raw.ebs {
            for (ty, price) in types {
                assert!(*price > 0.0, "ebs price {region}/{ty} must be > 0");
            }
        }
        for (region, p) in &raw.elastic_ip {
            assert!(*p > 0.0, "elastic_ip price {region} must be > 0");
        }
        for (region, p) in &raw.snapshot {
            assert!(*p > 0.0, "snapshot price {region} must be > 0");
        }
        for (region, p) in &raw.cw_logs {
            assert!(*p > 0.0, "cw_logs price {region} must be > 0");
        }
        for (region, p) in &raw.rds_snapshot {
            assert!(*p > 0.0, "rds_snapshot price {region} must be > 0");
        }
        PriceTable { raw }
    })
}

/// The fixed USD→BRL rate from the table. Placeholder value; the UI labels it approximate.
pub fn fx_usd_brl() -> f64 {
    table().raw.fx.usd_brl
}

/// Estimated monthly cost of one flagged resource: size/use × table price × month.
pub fn estimate(rt: ResourceType, region: &str, facts: &Value) -> EstimatedCost {
    match rt {
        ResourceType::EbsVolume => estimate_ebs(region, facts),
        ResourceType::ElasticIp => estimate_eip(region),
        ResourceType::EbsSnapshot => estimate_snapshot(region, facts),
        ResourceType::CloudwatchLogGroup => estimate_logs(region, facts),
        ResourceType::RdsSnapshot => estimate_rds_snapshot(region, facts),
    }
}

fn fact_f64(facts: &Value, key: &str) -> Option<f64> {
    facts.get(key).and_then(Value::as_f64)
}

fn unavailable(basis: CostBasis, why: CostUnavailable) -> EstimatedCost {
    EstimatedCost {
        monthly_usd: None,
        basis,
        qualifiers: Vec::new(),
        unavailable: Some(why),
    }
}

fn estimate_ebs(region: &str, facts: &Value) -> EstimatedCost {
    let basis = CostBasis::EbsGib;
    let Some(size) = fact_f64(facts, "sizeGiB") else {
        return unavailable(basis, CostUnavailable::MissingFact);
    };
    let Some(types) = table().raw.ebs.get(region) else {
        return unavailable(basis, CostUnavailable::Region);
    };
    let vol_type = facts.get("type").and_then(Value::as_str).unwrap_or("gp3");

    let mut qualifiers = Vec::new();
    let price = match types.get(vol_type) {
        Some(p) => *p,
        None => {
            // AWS added a volume type we don't price yet — use gp3 and say so, rather than
            // dropping the resource (region coverage is the thing we never approximate).
            qualifiers.push(CostQualifier::EbsTypeAssumed);
            *types.get("gp3").expect("gp3 is keyed for every region (validated)")
        }
    };
    if matches!(vol_type, "io1" | "io2") {
        qualifiers.push(CostQualifier::EbsIopsNotIncluded);
    }

    EstimatedCost {
        monthly_usd: Some(size * price),
        basis,
        qualifiers,
        unavailable: None,
    }
}

fn estimate_eip(region: &str) -> EstimatedCost {
    let basis = CostBasis::EipFlat;
    match table().raw.elastic_ip.get(region) {
        Some(hourly) => EstimatedCost {
            monthly_usd: Some(hourly * table().raw.meta.hours_per_month),
            basis,
            qualifiers: Vec::new(),
            unavailable: None,
        },
        None => unavailable(basis, CostUnavailable::Region),
    }
}

fn estimate_snapshot(region: &str, facts: &Value) -> EstimatedCost {
    let basis = CostBasis::SnapshotGib;
    let Some(size) = fact_f64(facts, "sizeGiB") else {
        return unavailable(basis, CostUnavailable::MissingFact);
    };
    match table().raw.snapshot.get(region) {
        Some(price) => EstimatedCost {
            monthly_usd: Some(size * price),
            basis,
            // Billing is on incremental size; we only have the source volume size (upper bound).
            qualifiers: vec![CostQualifier::SnapshotFullVolumeSize],
            unavailable: None,
        },
        None => unavailable(basis, CostUnavailable::Region),
    }
}

fn estimate_logs(region: &str, facts: &Value) -> EstimatedCost {
    let basis = CostBasis::LogsGbMonth;
    // The API always returns `storedBytes` (0 for an empty / just-created group). A missing or
    // zero value is an honest $0.00 estimate, not `MissingFact` — an empty retention-less group
    // is still a real alert, just with no financial urgency (ADR 0005 D3).
    let bytes = fact_f64(facts, "storedBytes").unwrap_or(0.0);
    match table().raw.cw_logs.get(region) {
        Some(price) => EstimatedCost {
            // GB = 10^9 bytes — the unit the AWS pricing page states (ADR 0005 D3).
            monthly_usd: Some(bytes / 1e9 * price),
            basis,
            qualifiers: vec![CostQualifier::LogsStorageOnly, CostQualifier::LogsSizeReported],
            unavailable: None,
        },
        None => unavailable(basis, CostUnavailable::Region),
    }
}

fn estimate_rds_snapshot(region: &str, facts: &Value) -> EstimatedCost {
    let basis = CostBasis::RdsSnapshotGb;
    let Some(gb) = fact_f64(facts, "allocatedStorageGb") else {
        return unavailable(basis, CostUnavailable::MissingFact);
    };
    match table().raw.rds_snapshot.get(region) {
        Some(price) => EstimatedCost {
            monthly_usd: Some(gb * price),
            basis,
            // Priced on the source instance's allocated storage — an upper bound on the actual
            // (incremental) backup size.
            qualifiers: vec![CostQualifier::RdsSnapshotAllocatedSize],
            unavailable: None,
        },
        None => unavailable(basis, CostUnavailable::Region),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const REGIONS: [&str; 9] = [
        "us-east-1",
        "us-east-2",
        "us-west-1",
        "us-west-2",
        "eu-west-1",
        "eu-central-1",
        "ap-southeast-1",
        "ap-northeast-1",
        "sa-east-1",
    ];
    const EBS_TYPES: [&str; 7] = ["gp3", "gp2", "io1", "io2", "st1", "sc1", "standard"];

    fn approx(got: Option<f64>, want: f64) {
        let g = got.expect("expected a priced estimate");
        assert!((g - want).abs() < 1e-9, "got {g}, want {want}");
    }

    #[test]
    fn table_parses_and_covers_every_region() {
        let t = table();
        assert!(t.raw.fx.usd_brl > 0.0);
        assert_eq!(t.raw.meta.hours_per_month, 730.0);
        for r in REGIONS {
            let ebs = t.raw.ebs.get(r).unwrap_or_else(|| panic!("ebs missing region {r}"));
            for ty in EBS_TYPES {
                assert!(ebs.contains_key(ty), "ebs {r} missing type {ty}");
            }
            assert!(t.raw.elastic_ip.contains_key(r), "elastic_ip missing {r}");
            assert!(t.raw.snapshot.contains_key(r), "snapshot missing {r}");
            assert!(t.raw.cw_logs.contains_key(r), "cw_logs missing {r}");
            assert!(t.raw.rds_snapshot.contains_key(r), "rds_snapshot missing {r}");
        }
    }

    #[test]
    fn ebs_estimate_is_size_times_price() {
        let e = estimate(
            ResourceType::EbsVolume,
            "us-east-1",
            &json!({ "sizeGiB": 100, "type": "gp3" }),
        );
        approx(e.monthly_usd, 8.0); // 100 * 0.08
        assert!(e.unavailable.is_none());
        assert!(e.qualifiers.is_empty());
    }

    #[test]
    fn io1_is_flagged_iops_not_included() {
        let e = estimate(
            ResourceType::EbsVolume,
            "us-east-1",
            &json!({ "sizeGiB": 100, "type": "io1" }),
        );
        approx(e.monthly_usd, 12.5);
        assert!(e.qualifiers.contains(&CostQualifier::EbsIopsNotIncluded));
    }

    #[test]
    fn eip_is_hourly_times_hours_per_month() {
        let e = estimate(ResourceType::ElasticIp, "sa-east-1", &json!({}));
        approx(e.monthly_usd, 0.005 * 730.0);
        assert!(e.qualifiers.is_empty());
    }

    #[test]
    fn snapshot_uses_source_volume_size_and_is_flagged() {
        let e = estimate(
            ResourceType::EbsSnapshot,
            "eu-west-1",
            &json!({ "sizeGiB": 200 }),
        );
        approx(e.monthly_usd, 10.0); // 200 * 0.05
        assert!(e.qualifiers.contains(&CostQualifier::SnapshotFullVolumeSize));
    }

    #[test]
    fn logs_priced_on_stored_bytes_storage_only() {
        let e = estimate(
            ResourceType::CloudwatchLogGroup,
            "us-east-1",
            &json!({ "storedBytes": 50_000_000_000_i64 }), // 50 GB
        );
        approx(e.monthly_usd, 50.0 * 0.03); // 50 GB * $0.03/GB-month
        assert!(e.qualifiers.contains(&CostQualifier::LogsStorageOnly));
        assert!(e.qualifiers.contains(&CostQualifier::LogsSizeReported));
    }

    #[test]
    fn empty_log_group_is_priced_zero_not_unavailable() {
        let e = estimate(ResourceType::CloudwatchLogGroup, "us-east-1", &json!({ "storedBytes": 0 }));
        approx(e.monthly_usd, 0.0);
        assert!(e.unavailable.is_none());

        let missing = estimate(ResourceType::CloudwatchLogGroup, "us-east-1", &json!({}));
        approx(missing.monthly_usd, 0.0);
        assert!(missing.unavailable.is_none());
    }

    #[test]
    fn rds_snapshot_priced_on_allocated_storage_and_flagged() {
        let e = estimate(
            ResourceType::RdsSnapshot,
            "us-east-1",
            &json!({ "allocatedStorageGb": 100 }),
        );
        approx(e.monthly_usd, 100.0 * 0.095);
        assert!(e.qualifiers.contains(&CostQualifier::RdsSnapshotAllocatedSize));
    }

    #[test]
    fn rds_snapshot_missing_size_is_unavailable() {
        let e = estimate(ResourceType::RdsSnapshot, "us-east-1", &json!({ "engine": "postgres" }));
        assert_eq!(e.unavailable, Some(CostUnavailable::MissingFact));
    }

    #[test]
    fn logs_region_outside_the_table_is_unavailable() {
        let e = estimate(
            ResourceType::CloudwatchLogGroup,
            "ca-central-1",
            &json!({ "storedBytes": 10_000_000_000_i64 }),
        );
        assert!(e.monthly_usd.is_none());
        assert_eq!(e.unavailable, Some(CostUnavailable::Region));
    }

    #[test]
    fn region_outside_the_table_is_unavailable_not_approximated() {
        let e = estimate(
            ResourceType::EbsVolume,
            "ca-central-1",
            &json!({ "sizeGiB": 100, "type": "gp3" }),
        );
        assert!(e.monthly_usd.is_none());
        assert_eq!(e.unavailable, Some(CostUnavailable::Region));
    }

    #[test]
    fn missing_size_fact_is_unavailable() {
        let e = estimate(ResourceType::EbsVolume, "us-east-1", &json!({ "type": "gp3" }));
        assert_eq!(e.unavailable, Some(CostUnavailable::MissingFact));
    }
}
