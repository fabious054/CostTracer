//! The pure per-resource cost estimate (ADR 0003 formulas; ADR 0006 source). A function of
//! `(resource_type, region, facts, &PriceBook)` — no AWS, no network, no cache access. The
//! `PriceBook` is a snapshot the caller loaded from `PriceCache`.

use serde_json::Value;

use crate::model::{CostBasis, CostQualifier, CostUnavailable, EstimatedCost, ResourceType};
use crate::pricing::ebs_flat_key;
use crate::pricing::pricebook::{PriceBook, PriceEntry};

/// AWS bills a "month" as 730 hours everywhere — turns the Elastic IP per-hour rate into a
/// per-month figure.
const HOURS_PER_MONTH: f64 = 730.0;

pub fn estimate(rt: ResourceType, region: &str, facts: &Value, book: &PriceBook) -> EstimatedCost {
    match rt {
        ResourceType::EbsVolume => estimate_ebs(region, facts, book),
        ResourceType::ElasticIp => estimate_eip(region, book),
        ResourceType::EbsSnapshot => estimate_snapshot(region, facts, book),
        ResourceType::CloudwatchLogGroup => estimate_logs(region, facts, book),
        ResourceType::RdsSnapshot => estimate_rds_snapshot(region, facts, book),
    }
}

fn fact_f64(facts: &Value, key: &str) -> Option<f64> {
    facts.get(key).and_then(Value::as_f64)
}

fn priced(
    monthly_usd: f64,
    basis: CostBasis,
    qualifiers: Vec<CostQualifier>,
    priced_at: Option<i64>,
) -> EstimatedCost {
    EstimatedCost {
        monthly_usd: Some(monthly_usd),
        basis,
        qualifiers,
        unavailable: None,
        priced_at,
    }
}

fn unavailable(basis: CostBasis, why: CostUnavailable) -> EstimatedCost {
    EstimatedCost {
        monthly_usd: None,
        basis,
        qualifiers: Vec::new(),
        unavailable: Some(why),
        priced_at: None,
    }
}

/// A rate from the book, or the reason there isn't one: no row yet ⇒ `PricePending`,
/// failure marker ⇒ `PriceUnavailable`.
fn rate(book: &PriceBook, flat_key: &str, region: &str) -> Result<(f64, Option<i64>), CostUnavailable> {
    match book.lookup(flat_key, region) {
        Some(PriceEntry::Priced { usd_per_unit, priced_at }) => Ok((usd_per_unit, priced_at)),
        Some(PriceEntry::Failed) => Err(CostUnavailable::PriceUnavailable),
        None => Err(CostUnavailable::PricePending),
    }
}

fn estimate_ebs(region: &str, facts: &Value, book: &PriceBook) -> EstimatedCost {
    let basis = CostBasis::EbsGib;
    let Some(size) = fact_f64(facts, "sizeGiB") else {
        return unavailable(basis, CostUnavailable::MissingFact);
    };
    let (flat_key, type_assumed) = ebs_flat_key(facts);
    let (price, priced_at) = match rate(book, &flat_key, region) {
        Ok(v) => v,
        Err(why) => return unavailable(basis, why),
    };

    let mut qualifiers = Vec::new();
    if type_assumed {
        qualifiers.push(CostQualifier::EbsTypeAssumed);
    }
    if matches!(facts.get("type").and_then(Value::as_str), Some("io1" | "io2")) {
        qualifiers.push(CostQualifier::EbsIopsNotIncluded);
    }
    priced(size * price, basis, qualifiers, priced_at)
}

fn estimate_eip(region: &str, book: &PriceBook) -> EstimatedCost {
    let basis = CostBasis::EipFlat;
    match rate(book, "eip:idle", region) {
        Ok((hourly, priced_at)) => priced(hourly * HOURS_PER_MONTH, basis, Vec::new(), priced_at),
        Err(why) => unavailable(basis, why),
    }
}

fn estimate_snapshot(region: &str, facts: &Value, book: &PriceBook) -> EstimatedCost {
    let basis = CostBasis::SnapshotGib;
    let Some(size) = fact_f64(facts, "sizeGiB") else {
        return unavailable(basis, CostUnavailable::MissingFact);
    };
    match rate(book, "ebs:snapshot", region) {
        Ok((price, priced_at)) => priced(
            size * price,
            basis,
            vec![CostQualifier::SnapshotFullVolumeSize],
            priced_at,
        ),
        Err(why) => unavailable(basis, why),
    }
}

fn estimate_logs(region: &str, facts: &Value, book: &PriceBook) -> EstimatedCost {
    let basis = CostBasis::LogsGbMonth;
    // The API always returns `storedBytes` (0 for an empty group). Missing / zero ⇒ an honest
    // $0.00, not `MissingFact` (ADR 0005 D3).
    let bytes = fact_f64(facts, "storedBytes").unwrap_or(0.0);
    match rate(book, "cwlogs:storage", region) {
        Ok((price, priced_at)) => priced(
            bytes / 1e9 * price,
            basis,
            vec![CostQualifier::LogsStorageOnly, CostQualifier::LogsSizeReported],
            priced_at,
        ),
        Err(why) => unavailable(basis, why),
    }
}

fn estimate_rds_snapshot(region: &str, facts: &Value, book: &PriceBook) -> EstimatedCost {
    let basis = CostBasis::RdsSnapshotGb;
    let Some(gb) = fact_f64(facts, "allocatedStorageGb") else {
        return unavailable(basis, CostUnavailable::MissingFact);
    };
    match rate(book, "rds:backup", region) {
        Ok((price, priced_at)) => priced(
            gb * price,
            basis,
            vec![CostQualifier::RdsSnapshotAllocatedSize],
            priced_at,
        ),
        Err(why) => unavailable(basis, why),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pricing::pricebook::PriceEntry;
    use serde_json::json;

    fn book(entries: &[(&str, &str, PriceEntry)]) -> PriceBook {
        let mut b = PriceBook::new();
        for (k, r, e) in entries {
            b.insert(k, r, *e);
        }
        b
    }
    fn fresh(rate: f64) -> PriceEntry {
        PriceEntry::Priced { usd_per_unit: rate, priced_at: None }
    }

    #[test]
    fn ebs_is_size_times_rate() {
        let b = book(&[("ebs:gp3", "us-east-1", fresh(0.08))]);
        let e = estimate(ResourceType::EbsVolume, "us-east-1", &json!({"sizeGiB": 100, "type": "gp3"}), &b);
        assert_eq!(e.monthly_usd, Some(8.0));
        assert!(e.qualifiers.is_empty());
        assert!(e.priced_at.is_none());
    }

    #[test]
    fn io1_flags_iops_and_unknown_type_falls_back_to_gp3() {
        let b = book(&[("ebs:io1", "us-east-1", fresh(0.125)), ("ebs:gp3", "us-east-1", fresh(0.08))]);
        let io1 = estimate(ResourceType::EbsVolume, "us-east-1", &json!({"sizeGiB": 100, "type": "io1"}), &b);
        assert_eq!(io1.monthly_usd, Some(12.5));
        assert!(io1.qualifiers.contains(&CostQualifier::EbsIopsNotIncluded));

        let weird = estimate(ResourceType::EbsVolume, "us-east-1", &json!({"sizeGiB": 100, "type": "gp9"}), &b);
        assert_eq!(weird.monthly_usd, Some(8.0));
        assert!(weird.qualifiers.contains(&CostQualifier::EbsTypeAssumed));
    }

    #[test]
    fn eip_is_hourly_times_730() {
        let b = book(&[("eip:idle", "sa-east-1", fresh(0.005))]);
        let e = estimate(ResourceType::ElasticIp, "sa-east-1", &json!({}), &b);
        assert_eq!(e.monthly_usd, Some(0.005 * 730.0));
    }

    #[test]
    fn empty_log_group_is_zero_not_missing_fact() {
        let b = book(&[("cwlogs:storage", "us-east-1", fresh(0.03))]);
        let e = estimate(ResourceType::CloudwatchLogGroup, "us-east-1", &json!({"storedBytes": 0}), &b);
        assert_eq!(e.monthly_usd, Some(0.0));
        assert!(e.unavailable.is_none());
        assert!(e.qualifiers.contains(&CostQualifier::LogsStorageOnly));
    }

    #[test]
    fn expired_cache_carries_priced_at() {
        let b = book(&[(
            "rds:backup",
            "us-east-1",
            PriceEntry::Priced { usd_per_unit: 0.095, priced_at: Some(1_700_000_000) },
        )]);
        let e = estimate(ResourceType::RdsSnapshot, "us-east-1", &json!({"allocatedStorageGb": 100}), &b);
        assert_eq!(e.monthly_usd, Some(9.5));
        assert_eq!(e.priced_at, Some(1_700_000_000));
    }

    #[test]
    fn no_row_is_pending_failure_marker_is_unavailable() {
        let b = book(&[("ebs:gp3", "eu-west-1", PriceEntry::Failed)]);
        let pending = estimate(ResourceType::EbsVolume, "us-east-1", &json!({"sizeGiB": 50, "type": "gp3"}), &b);
        assert_eq!(pending.unavailable, Some(CostUnavailable::PricePending));

        let failed = estimate(ResourceType::EbsVolume, "eu-west-1", &json!({"sizeGiB": 50, "type": "gp3"}), &b);
        assert_eq!(failed.unavailable, Some(CostUnavailable::PriceUnavailable));
    }

    #[test]
    fn missing_size_is_missing_fact() {
        let b = book(&[("ebs:gp3", "us-east-1", fresh(0.08))]);
        let e = estimate(ResourceType::EbsVolume, "us-east-1", &json!({"type": "gp3"}), &b);
        assert_eq!(e.unavailable, Some(CostUnavailable::MissingFact));
    }
}
