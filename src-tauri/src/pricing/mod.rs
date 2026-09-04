//! Estimated-cost pricing (ADR 0003 → migrated to the AWS Price List API in ADR 0006).
//!
//! Shape after Scope 6:
//! - `cache` — `pricing-cache.sqlite3`, a store **separate** from the scan DB (prices are public,
//!   account-independent data; keeping them apart keeps the cross-account-leak class shut).
//! - `list_api` — `aws-sdk-pricing` `GetProducts` calls + per-resource-type parsers.
//! - `fx` — the one non-AWS call: an anonymous USD→BRL lookup to `api.frankfurter.dev`.
//! - `refresh` — the background task that keeps the cache warm on its own (D2). **Nothing else**
//!   fetches; the scan only ever reads.
//! - `estimate` — a **pure** `(resource_type, region, facts, &PriceBook) -> EstimatedCost`. It
//!   reads a `PriceBook` snapshot the caller loaded from the cache; it never touches the network.

pub mod cache;
pub mod estimate;
pub mod fx;
pub mod list_api;
pub mod pricebook;
pub mod refresh;

pub use cache::PriceCache;
pub use estimate::estimate;
pub use pricebook::PriceBook;
pub use refresh::PriceRefresher;

use crate::model::{CostBasis, ResourceType};

/// Staleness windows — hard-coded, not user-configurable (ADR 0006).
pub const PRICE_WINDOW_SECS: i64 = 3 * 86_400;
pub const FX_WINDOW_SECS: i64 = 5 * 3_600;
/// How long a failure marker suppresses re-fetching. Much shorter than the price window: most
/// failures are transient (a throttle on the cold-cache burst, a timeout), and a real "no such
/// product" is cheap to re-confirm on the next re-check.
pub const FAILED_RETRY_SECS: i64 = 30 * 60;

/// The AWS Price List `GetProducts` endpoint region (the *priced* region is a filter attribute,
/// not the endpoint — the Query API is only served from a few regions).
pub const PRICING_ENDPOINT_REGION: &str = "us-east-1";

pub const FX_PAIR: &str = "USD_BRL";

/// One priceable line item: the AWS service code + a stable flat key that, with a region, names
/// exactly one on-demand rate. For EBS the volume type is part of the key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProductKey {
    pub service: &'static str,
    pub key: String,
}

impl ProductKey {
    fn new(service: &'static str, key: impl Into<String>) -> Self {
        Self {
            service,
            key: key.into(),
        }
    }
}

/// The set of `(ProductKey, CostBasis)` a detector needs to price a resource of this type.
/// EBS returns one entry per volume type; the others return one.
pub fn products_for(rt: ResourceType) -> Vec<(ProductKey, CostBasis)> {
    match rt {
        ResourceType::EbsVolume => EBS_VOLUME_TYPES
            .iter()
            .map(|t| (ProductKey::new("AmazonEC2", format!("ebs:{t}")), CostBasis::EbsGib))
            .collect(),
        ResourceType::ElasticIp => {
            // Public IPv4 is billed by VPC, not EC2, since the Feb-2024 pricing change.
            vec![(ProductKey::new("AmazonVPC", "eip:idle"), CostBasis::EipFlat)]
        }
        ResourceType::EbsSnapshot => {
            vec![(ProductKey::new("AmazonEC2", "ebs:snapshot"), CostBasis::SnapshotGib)]
        }
        ResourceType::CloudwatchLogGroup => {
            vec![(ProductKey::new("AmazonCloudWatch", "cwlogs:storage"), CostBasis::LogsGbMonth)]
        }
        ResourceType::RdsSnapshot => {
            vec![(ProductKey::new("AmazonRDS", "rds:backup"), CostBasis::RdsSnapshotGb)]
        }
    }
}

/// Volume types the EBS estimate knows; also the `volumeApiName` filter values for `GetProducts`.
pub const EBS_VOLUME_TYPES: [&str; 7] = ["gp3", "gp2", "io1", "io2", "st1", "sc1", "standard"];

/// The resource types that carry an estimated cost — the grid the refresher and the scan care about.
pub const PRICED_TYPES: [ResourceType; 5] = [
    ResourceType::EbsVolume,
    ResourceType::ElasticIp,
    ResourceType::EbsSnapshot,
    ResourceType::CloudwatchLogGroup,
    ResourceType::RdsSnapshot,
];

/// Every `(ProductKey, region)` pair needed to price the 5 types across `regions`.
pub fn price_needs(regions: &[String]) -> Vec<(ProductKey, String)> {
    let mut needs = Vec::new();
    for region in regions {
        for rt in PRICED_TYPES {
            for (key, _basis) in products_for(rt) {
                needs.push((key, region.clone()));
            }
        }
    }
    needs
}

/// Flat key for the specific EBS volume type in `facts` (defaults to gp3 for an unknown type —
/// the estimate flags that with `EbsTypeAssumed`).
pub fn ebs_flat_key(facts: &serde_json::Value) -> (String, bool) {
    let ty = facts.get("type").and_then(|v| v.as_str()).unwrap_or("gp3");
    if EBS_VOLUME_TYPES.contains(&ty) {
        (format!("ebs:{ty}"), false)
    } else {
        ("ebs:gp3".to_string(), true)
    }
}
