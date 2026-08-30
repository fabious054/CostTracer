//! Building `SdkConfig` for each of the three credential sources.

use aws_config::{BehaviorVersion, ConfigLoader, Region, SdkConfig};
use aws_credential_types::Credentials;

const DEFAULT_REGION: &str = "us-east-1";
const PROVIDER_NAME: &str = "cost-tracer";

/// LocalStack / test override (ADR 0003 D4): when `AWS_ENDPOINT_URL` is set, every SDK client
/// talks to that endpoint instead of real AWS. Unset in production — only the opt-in LocalStack
/// harness sets it.
fn with_endpoint_override(loader: ConfigLoader) -> ConfigLoader {
    match std::env::var("AWS_ENDPOINT_URL") {
        Ok(url) if !url.is_empty() => loader.endpoint_url(url),
        _ => loader,
    }
}

/// Pick a region: explicit input, then `AWS_REGION` / `AWS_DEFAULT_REGION`, then `us-east-1`.
pub fn resolve_region(explicit: Option<&str>) -> String {
    explicit
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("AWS_REGION").ok().filter(|s| !s.is_empty()))
        .or_else(|| std::env::var("AWS_DEFAULT_REGION").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| DEFAULT_REGION.to_string())
}

/// All regions we can reasonably say are "active or configured", de-duplicated, never empty.
pub fn collect_regions(explicit: Option<&str>, config_default: Option<&str>) -> Vec<String> {
    let candidates = [
        explicit.map(str::to_string),
        std::env::var("AWS_REGION").ok(),
        std::env::var("AWS_DEFAULT_REGION").ok(),
        config_default.map(str::to_string),
    ];
    let mut out: Vec<String> = Vec::new();
    for c in candidates.into_iter().flatten() {
        if !c.is_empty() && !out.contains(&c) {
            out.push(c);
        }
    }
    if out.is_empty() {
        out.push(DEFAULT_REGION.to_string());
    }
    out
}

/// Static keys (manual entry, resumed session, or SSO role credentials).
pub async fn from_static_keys(
    access_key_id: &str,
    secret_access_key: &str,
    session_token: Option<String>,
    region: &str,
) -> SdkConfig {
    let creds = Credentials::new(
        access_key_id,
        secret_access_key,
        session_token,
        None,
        PROVIDER_NAME,
    );
    with_endpoint_override(
        aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(region.to_string()))
            .credentials_provider(creds),
    )
    .load()
    .await
}

/// The default provider chain, optionally pinned to a named profile (detected configuration).
pub async fn from_profile(profile: Option<&str>, region: &str) -> SdkConfig {
    let mut loader =
        aws_config::defaults(BehaviorVersion::latest()).region(Region::new(region.to_string()));
    if let Some(name) = profile.filter(|p| !p.is_empty()) {
        loader = loader.profile_name(name);
    }
    with_endpoint_override(loader).load().await
}

/// Config with no credential provider — for the unauthenticated SSO OIDC / SSO portal calls.
pub async fn no_auth(region: &str) -> SdkConfig {
    with_endpoint_override(
        aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(region.to_string()))
            .no_credentials(),
    )
    .load()
    .await
}

pub fn region_of(config: &SdkConfig) -> String {
    config
        .region()
        .map(|r| r.as_ref().to_string())
        .unwrap_or_else(|| DEFAULT_REGION.to_string())
}
