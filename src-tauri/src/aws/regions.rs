//! Discover the account's enabled regions (Scope 4, ADR 0004). `ec2:DescribeRegions` with the
//! default filter returns only regions the account can actually use (opt-in-not-required plus
//! any opted-in) — that is exactly the set we want to scan. Read-only metadata, no resource data.

use aws_config::SdkConfig;

use crate::aws::describe_sdk_error;

/// The account's enabled regions, sorted. `Err` means the call failed (usually a missing
/// `ec2:DescribeRegions` permission) — the caller turns that into a clear scan error rather than
/// silently falling back to a single region.
pub async fn enabled_regions(config: &SdkConfig) -> Result<Vec<String>, String> {
    let ec2 = aws_sdk_ec2::Client::new(config);
    let resp = ec2
        .describe_regions()
        .send()
        .await
        .map_err(|e| describe_sdk_error(&e))?;

    let mut regions: Vec<String> = resp
        .regions()
        .iter()
        .filter_map(|r| r.region_name().map(str::to_string))
        .collect();
    regions.sort_unstable();
    regions.dedup();

    if regions.is_empty() {
        return Err("DescribeRegions returned no regions".to_string());
    }
    Ok(regions)
}
