//! AWS Price List **Query** API (`aws-sdk-pricing` `GetProducts`) — targeted per-`(product,
//! region)` filters, never a bulk index download (ADR 0006 D3). Called only by the background
//! refresher.
//!
//! The Query API is served only from a few regions; we pin `us-east-1` (`PRICING_ENDPOINT_REGION`)
//! — the *priced* region is a `regionCode` **filter**, not the endpoint.
//!
//! CAVEAT (ADR 0006 D3): Price List attribute names (`productFamily`, `group`, `usagetype`, …)
//! are quirky and vary by service — e.g. Public IPv4 is under `AmazonVPC`/`group`, not
//! `AmazonEC2`/`productFamily`; EBS snapshot returns ~6 line items and only one is the storage
//! rate. The filter + discriminator pair for each of the five product keys was verified live
//! against `us-east-1`, `sa-east-1` and `ap-south-1` (2026-09-03). Anything that still returns no
//! usable rate becomes a failure marker in the cache — never a panic.

use aws_config::SdkConfig;
use aws_sdk_pricing::config::retry::RetryConfig;
use aws_sdk_pricing::config::Region;
use aws_sdk_pricing::types::{Filter, FilterType};
use serde_json::Value;

use crate::aws::describe_sdk_error;
use crate::pricing::{ProductKey, PRICING_ENDPOINT_REGION};

pub fn client(base: &SdkConfig) -> aws_sdk_pricing::Client {
    let cfg = aws_sdk_pricing::config::Builder::from(base)
        .region(Region::new(PRICING_ENDPOINT_REGION))
        // The Price List Query API throttles hard — a cold cache is ~190 GetProducts calls.
        // Adaptive retry adds a client-side rate limiter that backs the whole client off on
        // `ThrottlingException` instead of just failing the call.
        .retry_config(RetryConfig::adaptive().with_max_attempts(6))
        .build();
    aws_sdk_pricing::Client::from_conf(cfg)
}

/// `(raw product JSON, USD per unit)` for one `(product, region)`, or a short error.
pub async fn fetch(
    client: &aws_sdk_pricing::Client,
    key: &ProductKey,
    region: &str,
) -> Result<(String, f64), String> {
    let mut req = client
        .get_products()
        .service_code(key.service)
        .format_version("aws_v1")
        .max_results(100);
    for f in filters_for(key, region) {
        req = req.filters(f);
    }

    let resp = req.send().await.map_err(|e| describe_sdk_error(&e))?;

    let discriminate = discriminator_for(&key.key);
    for raw in resp.price_list() {
        let doc: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !discriminate(&doc) {
            continue;
        }
        if let Some(rate) = on_demand_usd(&doc) {
            return Ok((raw.clone(), rate));
        }
    }
    Err(format!(
        "no matching OnDemand USD rate for {} in {region} ({} product(s) returned)",
        key.key,
        resp.price_list().len()
    ))
}

fn term(field: &str, value: &str) -> Filter {
    Filter::builder()
        .r#type(FilterType::TermMatch)
        .field(field)
        .value(value)
        .build()
        .expect("Filter needs type + field + value")
}

fn filters_for(key: &ProductKey, region: &str) -> Vec<Filter> {
    let mut f = vec![term("regionCode", region)];
    match key.key.as_str() {
        k if k.starts_with("ebs:") && k != "ebs:snapshot" => {
            f.push(term("productFamily", "Storage"));
            f.push(term("volumeApiName", &k["ebs:".len()..]));
        }
        // Storage Snapshot returns ~6 line items (plain usage, archive tiers, outposts); the
        // discriminator below keeps only plain `EBS:SnapshotUsage`.
        "ebs:snapshot" => f.push(term("productFamily", "Storage Snapshot")),
        // `AmazonVPC` service (see `products_for`); this group holds exactly the idle/in-use
        // Public IPv4 hourly charges. Filtering by `productFamily` returns nothing here.
        "eip:idle" => f.push(term("group", "VPCPublicIPv4Address")),
        // RDS backup storage also lives under "Storage Snapshot"; without it the AmazonRDS
        // result set is thousands of rows and the backup line falls past `max_results` in busy
        // regions. With it: ~40 rows, discriminated by `usagetype` below.
        "rds:backup" => f.push(term("productFamily", "Storage Snapshot")),
        // CloudWatch Logs storage: region + service only; the discriminator picks by `usagetype`.
        "cwlogs:storage" => {}
        _ => {}
    }
    f
}

/// A product-JSON predicate that picks the right line item when `filters_for` casts a wide net.
fn discriminator_for(flat_key: &str) -> fn(&Value) -> bool {
    match flat_key {
        // An unassociated Elastic IP is billed as an *idle* Public IPv4 address ($0.005/h).
        "eip:idle" => |doc| attr(doc, "usagetype").contains("PublicIPv4:IdleAddress"),
        // Keep plain `EBS:SnapshotUsage` (regionless in us-east-1, `<REGION>-` prefixed elsewhere);
        // drop `.outposts`, `SnapshotUsageUnderBilling`, and every `SnapshotArchive*` tier.
        "ebs:snapshot" => |doc| {
            let u = attr(doc, "usagetype");
            u == "EBS:SnapshotUsage" || u.ends_with("-EBS:SnapshotUsage")
        },
        "cwlogs:storage" => |doc| attr(doc, "usagetype").contains("TimedStorage-ByteHrs"),
        // Plain RDS backup storage only — not `RDSCustom:` and not `Aurora:` (out of scope,
        // ADR 0005 D2), both of which also carry a `…BackupUsage` usagetype.
        "rds:backup" => |doc| {
            let u = attr(doc, "usagetype");
            u.ends_with("RDS:ChargedBackupUsage") || u.ends_with("RDS:BackupUsage")
        },
        _ => |_| true,
    }
}

fn attr<'a>(doc: &'a Value, name: &str) -> &'a str {
    doc.pointer(&format!("/product/attributes/{name}"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

/// First OnDemand price dimension with a USD rate, preferring the tier that starts at 0.
fn on_demand_usd(doc: &Value) -> Option<f64> {
    let terms = doc.pointer("/terms/OnDemand")?.as_object()?;
    let mut best: Option<f64> = None;
    for offer in terms.values() {
        let Some(dims) = offer.get("priceDimensions").and_then(Value::as_object) else { continue };
        for dim in dims.values() {
            let usd = dim
                .pointer("/pricePerUnit/USD")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<f64>().ok());
            let Some(usd) = usd else { continue };
            let begins_at_zero = dim.get("beginRange").and_then(Value::as_str) == Some("0");
            if begins_at_zero {
                return Some(usd);
            }
            best.get_or_insert(usd);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_the_zero_tier_on_demand_usd() {
        let doc = json!({
            "terms": { "OnDemand": { "ABC.JRTCKXETXF": { "priceDimensions": {
                "ABC.JRTCKXETXF.6YS6EN2CT7": {
                    "beginRange": "0", "endRange": "Inf", "unit": "GB-Mo",
                    "pricePerUnit": { "USD": "0.0800000000" }
                }
            }}}}
        });
        assert_eq!(on_demand_usd(&doc), Some(0.08));
    }

    fn usagetype(u: &str) -> Value {
        json!({ "product": { "attributes": { "usagetype": u }}})
    }

    #[test]
    fn rds_discriminator_matches_plain_backup_not_custom_or_aurora() {
        let d = discriminator_for("rds:backup");
        assert!(d(&usagetype("RDS:ChargedBackupUsage"))); // us-east-1, no prefix
        assert!(d(&usagetype("USE1-RDS:ChargedBackupUsage"))); // other regions
        assert!(!d(&usagetype("RDSCustom:ChargedBackupUsage")));
        assert!(!d(&usagetype("Aurora:BackupUsage")));
        assert!(!d(&usagetype("USE1-InstanceUsage:db.t3.micro")));
    }

    #[test]
    fn eip_discriminator_matches_idle_public_ipv4_only() {
        let d = discriminator_for("eip:idle");
        assert!(d(&usagetype("SAE1-PublicIPv4:IdleAddress")));
        assert!(!d(&usagetype("SAE1-PublicIPv4:InUseAddress")));
    }

    #[test]
    fn snapshot_discriminator_keeps_plain_usage_drops_archive_and_outposts() {
        let d = discriminator_for("ebs:snapshot");
        assert!(d(&usagetype("EBS:SnapshotUsage"))); // us-east-1, no region prefix
        assert!(d(&usagetype("SAE1-EBS:SnapshotUsage"))); // other regions
        assert!(!d(&usagetype("SAE1-EBS:SnapshotUsage.outposts")));
        assert!(!d(&usagetype("EBS:SnapshotUsageUnderBilling")));
        assert!(!d(&usagetype("SAE1-EBS:SnapshotArchiveStorage")));
    }
}
