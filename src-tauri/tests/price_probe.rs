//! Permanent diagnostic tool (Scope 6; CLAUDE.md scope-closure checklist item 2 exception,
//! alongside `dev_seed_scan`) — always `#[ignore]`d, never runs in `cargo test` or CI, not wired
//! into the app. See `docs/development.md` § "price_probe".
//!
//! Born from `eip:idle` and `ebs:snapshot` coming back as failure markers in every region after
//! the Price List API migration (ADR 0006 D3's caveat: filter attributes are undocumented in
//! practice and vary by service). This reads the connected credential straight from the OS vault
//! and dumps raw `GetProducts` output for candidate filter sets, so a filter/discriminator pair
//! for `pricing/list_api.rs` can be worked out against the real API — keep it for the next
//! detector that needs a Price List rate.
//!
//! Run:  PROBE_REGION=sa-east-1 cargo test --test price_probe -- --ignored --nocapture
//! (PROBE_REGION defaults to us-east-1)

use aws_config::SdkConfig;
use aws_sdk_pricing::config::{Credentials, Region};
use aws_sdk_pricing::types::{Filter, FilterType};
use aws_smithy_types::error::display::DisplayErrorContext;
use cost_tracer_lib::pricing::list_api;
use cost_tracer_lib::pricing::ProductKey;
use serde_json::Value;

const VAULT_SERVICE: &str = "com.costtracer.app";
const VAULT_ACCOUNT: &str = "aws-connection";

fn load_credential_blob() -> String {
    let first = keyring::Entry::new(VAULT_SERVICE, VAULT_ACCOUNT)
        .unwrap()
        .get_password()
        .expect("no saved credential — connect an account in the app first");
    let (count_line, first_chunk) = first.split_once('\n').expect("chunk-0 header");
    let count: usize = count_line.trim().parse().expect("chunk count");
    let mut blob = String::from(first_chunk);
    for i in 1..count {
        let acct = format!("{VAULT_ACCOUNT}-{i}");
        blob.push_str(&keyring::Entry::new(VAULT_SERVICE, &acct).unwrap().get_password().unwrap());
    }
    blob
}

async fn sdk_config() -> SdkConfig {
    let cred: Value = serde_json::from_str(&load_credential_blob()).expect("credential blob is JSON");
    let get = |k: &str| {
        cred.get(k)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("no string field {k:?}; keys: {:?}",
                cred.as_object().map(|o| o.keys().collect::<Vec<_>>())))
            .to_string()
    };
    let creds = Credentials::new(
        get("accessKeyId"),
        get("secretAccessKey"),
        cred.get("sessionToken").and_then(Value::as_str).map(String::from),
        None,
        "price_probe",
    );
    aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(Region::new("us-east-1"))
        .credentials_provider(creds)
        .load()
        .await
}

fn term(field: &str, value: &str) -> Filter {
    Filter::builder()
        .r#type(FilterType::TermMatch)
        .field(field)
        .value(value)
        .build()
        .unwrap()
}

fn attr<'a>(doc: &'a Value, name: &str) -> Option<&'a str> {
    doc.pointer(&format!("/product/attributes/{name}")).and_then(Value::as_str)
}

fn on_demand_usd(doc: &Value) -> Option<f64> {
    let terms = doc.pointer("/terms/OnDemand")?.as_object()?;
    for offer in terms.values() {
        let Some(dims) = offer.get("priceDimensions").and_then(Value::as_object) else { continue };
        for dim in dims.values() {
            if let Some(v) = dim
                .pointer("/pricePerUnit/USD")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<f64>().ok())
            {
                return Some(v);
            }
        }
    }
    None
}

async fn dump(client: &aws_sdk_pricing::Client, label: &str, service: &str, filters: Vec<Filter>) {
    print!("\n----- {label} -----\n  service={service}");
    for f in &filters {
        print!("  | {}={:?}", f.field(), f.value());
    }
    println!();
    let mut req = client
        .get_products()
        .service_code(service)
        .format_version("aws_v1")
        .max_results(100);
    for f in filters {
        req = req.filters(f);
    }
    match req.send().await {
        Err(e) => println!("  !! {}", DisplayErrorContext(&e)),
        Ok(resp) => {
            let list = resp.price_list();
            println!("  -> {} product(s)", list.len());
            for (n, raw) in list.iter().enumerate().take(15) {
                let Ok(doc) = serde_json::from_str::<Value>(raw) else { continue };
                println!(
                    "   [{n:2}] pf={:?} usagetype={:?} group={:?} groupDescription={:?} operation={:?} usd={:?}",
                    attr(&doc, "productFamily").unwrap_or("-"),
                    attr(&doc, "usagetype").unwrap_or("-"),
                    attr(&doc, "group").unwrap_or("-"),
                    attr(&doc, "groupDescription").unwrap_or("-"),
                    attr(&doc, "operation").unwrap_or("-"),
                    on_demand_usd(&doc),
                );
            }
        }
    }
}

#[tokio::test]
#[ignore = "hits the real AWS Price List API with the saved credential"]
async fn probe_eip_and_snapshot() {
    let region = std::env::var("PROBE_REGION").unwrap_or_else(|_| "us-east-1".to_string());
    println!("== PROBE_REGION = {region} ==");

    let base = sdk_config().await;
    let client = list_api::client(&base);

    let _ = &region;
    let _ = dump; // keep the helper available for ad-hoc filter probing

    // Cold-cache burst simulation — every priced product key across many regions, the same
    // MAX_IN_FLIGHT=2 the refresher uses, with the adaptive-retry client. Counts throttles.
    let regions = [
        "us-east-1", "us-east-2", "us-west-1", "us-west-2", "sa-east-1", "eu-west-1",
        "eu-west-2", "eu-central-1", "eu-north-1", "ca-central-1", "ap-south-1",
        "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-3",
    ];
    let keys: Vec<ProductKey> = [
        ("AmazonEC2", "ebs:gp3"), ("AmazonEC2", "ebs:gp2"), ("AmazonEC2", "ebs:io1"),
        ("AmazonEC2", "ebs:io2"), ("AmazonEC2", "ebs:st1"), ("AmazonEC2", "ebs:sc1"),
        ("AmazonEC2", "ebs:standard"), ("AmazonEC2", "ebs:snapshot"),
        ("AmazonVPC", "eip:idle"), ("AmazonCloudWatch", "cwlogs:storage"),
        ("AmazonRDS", "rds:backup"),
    ]
    .iter()
    .map(|(s, k)| ProductKey { service: s, key: (*k).into() })
    .collect();

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(2));
    let mut set = tokio::task::JoinSet::new();
    for r in regions {
        for key in &keys {
            let (client, key, sem) = (client.clone(), key.clone(), sem.clone());
            set.spawn(async move {
                let _p = sem.acquire_owned().await.unwrap();
                match list_api::fetch(&client, &key, r).await {
                    Ok((_, rate)) => (key.key, r, Ok(rate)),
                    Err(e) => (key.key, r, Err(e)),
                }
            });
        }
    }
    let (mut ok, mut throttled, mut other) = (0u32, 0u32, 0u32);
    while let Some(res) = set.join_next().await {
        let (k, r, out) = res.unwrap();
        match out {
            Ok(_) => ok += 1,
            Err(e) if e.contains("Throttl") || e.contains("Rate exceeded") => {
                throttled += 1;
                println!("  THROTTLED {k}/{r}");
            }
            Err(e) => {
                other += 1;
                println!("  ERR       {k}/{r}: {e}");
            }
        }
    }
    println!("\nburst: {ok} ok, {throttled} throttled, {other} other  (of {})", regions.len() * keys.len());
}
