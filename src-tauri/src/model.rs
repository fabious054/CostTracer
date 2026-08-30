//! DTOs exchanged with the webview. These are the Rust source of truth; the TypeScript in
//! `src/app/core/models/` mirrors them. Field casing is camelCase to match the frontend.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CredentialSourceKind {
    Detected,
    Manual,
    Sso,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerIdentity {
    pub account_id: String,
    pub user_id: String,
    pub arn: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedConfig {
    pub has_env_credentials: bool,
    pub has_shared_credentials_file: bool,
    pub has_config_file: bool,
    pub profiles: Vec<String>,
    pub default_region: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub account_id: String,
    pub arn: String,
    pub user_id: String,
    pub regions: Vec<String>,
    /// `false` when `ec2:DescribeRegions` failed at connect time and `regions` is only the
    /// single-region safety fallback — the UI must not present that count as a fact about the
    /// account. A scan re-runs discovery and surfaces the real error.
    pub regions_discovered: bool,
    pub source_kind: CredentialSourceKind,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RiskKind {
    SimulatedActionAllowed,
    BroadManagedPolicy,
    /// Reserved for inline-statement `"Action": "*"` detection (needs IAM perms outside the
    /// minimal policy — see docs/development.md). Not emitted in v1.
    #[allow(dead_code)]
    WildcardActionStatement,
}

#[derive(Debug, Clone, Serialize)]
pub struct RiskFinding {
    pub kind: RiskKind,
    pub label: String,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionAuditMethod {
    Simulate,
    ListPolicies,
    Inconclusive,
}

#[derive(Debug, Clone, Serialize)]
pub struct PermissionAudit {
    pub method: PermissionAuditMethod,
    pub excessive: bool,
    pub findings: Vec<RiskFinding>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoDeviceAuth {
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    /// Epoch milliseconds.
    pub expires_at: u64,
    pub interval_sec: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoTarget {
    pub account_id: String,
    pub account_name: String,
    pub role_name: String,
}

// --- command outcomes ----------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ValidationOutcome {
    Ok {
        identity: CallerIdentity,
    },
    Invalid {
        message: String,
    },
    Insufficient {
        message: String,
        #[serde(rename = "probedAction")]
        probed_action: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResumeOutcome {
    Ok { account: AccountInfo },
    Stale,
    None,
}

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SsoPollOutcome {
    Pending,
    SlowDown,
    Expired,
    Authorized { targets: Vec<SsoTarget> },
}

// --- command inputs ----------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCredentialInput {
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Required for temporary credentials (Access Key ID starting with `ASIA`).
    pub session_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UseDetectedInput {
    pub profile: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoStartInput {
    pub start_url: String,
    pub region: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoSelectTargetInput {
    pub account_id: String,
    pub role_name: String,
}

// --- persisted blob --------------------------------------------------------

/// What actually goes into the OS vault (as a JSON string). Never leaves the Rust process.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredential {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    pub region: String,
    pub regions: Vec<String>,
    /// See `AccountInfo::regions_discovered`. `default = true`: a blob written before this field
    /// existed had a real region list from a successful discovery in the overwhelming majority of
    /// cases — don't raise a false alarm on upgrade; a reconnect refreshes it either way.
    #[serde(default = "default_true")]
    pub regions_discovered: bool,
    pub source_kind: CredentialSourceKind,
    pub account_id: String,
    pub user_id: String,
    pub arn: String,
    pub saved_at_unix: u64,
}

fn default_true() -> bool {
    true
}

// === Scope 2 — idle-resource scan ==========================================
// Dates cross the boundary as unix seconds (i64); the webview formats them.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceType {
    EbsVolume,
    ElasticIp,
    EbsSnapshot,
}

impl ResourceType {
    pub fn as_db(self) -> &'static str {
        match self {
            ResourceType::EbsVolume => "ebs_volume",
            ResourceType::ElasticIp => "elastic_ip",
            ResourceType::EbsSnapshot => "ebs_snapshot",
        }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "ebs_volume" => Some(ResourceType::EbsVolume),
            "elastic_ip" => Some(ResourceType::ElasticIp),
            "ebs_snapshot" => Some(ResourceType::EbsSnapshot),
            _ => None,
        }
    }
    /// Snapshots confirm on the slower scale (retention is commonly intentional).
    pub fn confidence_scale(self) -> ConfidenceScale {
        match self {
            ResourceType::EbsSnapshot => ConfidenceScale::Snapshot,
            _ => ConfidenceScale::Standard,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DetectorKind {
    EbsUnattached,
    ElasticIpIdle,
    OrphanSnapshot,
}

impl DetectorKind {
    pub fn resource_type(self) -> ResourceType {
        match self {
            DetectorKind::EbsUnattached => ResourceType::EbsVolume,
            DetectorKind::ElasticIpIdle => ResourceType::ElasticIp,
            DetectorKind::OrphanSnapshot => ResourceType::EbsSnapshot,
        }
    }
    pub fn as_db(self) -> &'static str {
        match self {
            DetectorKind::EbsUnattached => "ebs-unattached",
            DetectorKind::ElasticIpIdle => "elastic-ip-idle",
            DetectorKind::OrphanSnapshot => "orphan-snapshot",
        }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "ebs-unattached" => Some(DetectorKind::EbsUnattached),
            "elastic-ip-idle" => Some(DetectorKind::ElasticIpIdle),
            "orphan-snapshot" => Some(DetectorKind::OrphanSnapshot),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScanStatus {
    /// A scan row exists but no final status yet — a scan in progress, or one whose process died.
    Running,
    /// Every attempted region finished with no detector errors.
    Ok,
    /// At least one detector errored in at least one region.
    Partial,
    /// The user cancelled — some regions were simply not attempted (ADR 0004 D3).
    Cancelled,
}

impl ScanStatus {
    pub fn as_db(self) -> &'static str {
        match self {
            ScanStatus::Running => "running",
            ScanStatus::Ok => "ok",
            ScanStatus::Partial => "partial",
            ScanStatus::Cancelled => "cancelled",
        }
    }
    pub fn from_db(s: &str) -> Self {
        match s {
            "running" => ScanStatus::Running,
            "partial" => ScanStatus::Partial,
            "cancelled" => ScanStatus::Cancelled,
            _ => ScanStatus::Ok,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceState {
    Alert,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfidenceScale {
    Standard,
    Snapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConfidenceLevel {
    Observed,
    Persisting,
    Probable,
    Confirmed,
}

impl ConfidenceLevel {
    /// Pure function of coverage. Standard: Probable 5–6, Confirmed ≥7 (ADR 0002).
    pub fn from_days(days: i64, scale: ConfidenceScale) -> Self {
        let d = days.max(0);
        match scale {
            ConfidenceScale::Standard => match d {
                0..=1 => ConfidenceLevel::Observed,
                2..=4 => ConfidenceLevel::Persisting,
                5..=6 => ConfidenceLevel::Probable,
                _ => ConfidenceLevel::Confirmed,
            },
            ConfidenceScale::Snapshot => match d {
                0..=6 => ConfidenceLevel::Observed,
                7..=18 => ConfidenceLevel::Persisting,
                19..=29 => ConfidenceLevel::Probable,
                _ => ConfidenceLevel::Confirmed,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfidenceInfo {
    pub level: ConfidenceLevel,
    pub days_coverage: i64,
    pub scale: ConfidenceScale,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionError {
    pub region: String,
    pub message: String,
}

// --- Scope 3 — estimated cost (ADR 0003) -----------------------------------
// The core produces USD figures + the unpriced counts; the webview does the USD→BRL display
// (fixed rate in `ScanResult.fx_usd_brl`), formatting, and the caveat copy.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CostBasis {
    /// EBS volume: size (GiB) × $/GiB-month.
    EbsGib,
    /// Elastic IP: idle hourly rate × 730.
    EipFlat,
    /// EBS snapshot: source volume size (GiB) × $/GB-month.
    SnapshotGib,
}

/// A machine-readable caveat on an estimate the webview renders as a short note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CostQualifier {
    /// io1/io2: provisioned IOPS (and gp3 throughput) are billed on top and not captured.
    EbsIopsNotIncluded,
    /// Snapshot priced on the full source volume size, not the incremental stored size.
    SnapshotFullVolumeSize,
    /// Unknown volume type — priced as gp3.
    EbsTypeAssumed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CostUnavailable {
    /// The resource's region is not in the fixed price table.
    Region,
    /// A fact needed for the estimate (e.g. size) was missing from the scan.
    MissingFact,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimatedCost {
    /// USD per month. `None` exactly when `unavailable` is set.
    pub monthly_usd: Option<f64>,
    pub basis: CostBasis,
    pub qualifiers: Vec<CostQualifier>,
    pub unavailable: Option<CostUnavailable>,
}

/// Per-detector total — over alerting, non-intentional resources only.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorCostRollup {
    pub monthly_usd: f64,
    pub priced_count: u32,
    pub unpriced_count: u32,
}

/// Account total — two figures: Probable+Confirmed (primary) and Observed+Persisting (context).
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCostRollup {
    pub primary_monthly_usd: f64,
    pub context_monthly_usd: f64,
    pub unpriced_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceItem {
    pub resource_type: ResourceType,
    pub resource_id: String,
    pub region: String,
    pub display_name: Option<String>,
    pub state: ResourceState,
    /// Stable code (e.g. "associated-instance-stopped"); the webview maps it to a translated string.
    pub neutral_note: Option<String>,
    pub intentional: bool,
    /// AWS `CreateTime` / `StartTime`, unix seconds. `None` for Elastic IP (AWS gives no date).
    pub created_at: Option<i64>,
    /// First scan that ever saw this resource, unix seconds. The age anchor for Elastic IP.
    pub monitored_since: i64,
    /// Present only for alerting, non-intentional resources.
    pub confidence: Option<ConfidenceInfo>,
    /// Present exactly when `confidence` is — same "alerting, non-intentional" gate.
    pub estimated_cost: Option<EstimatedCost>,
    pub facts: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorResult {
    pub kind: DetectorKind,
    pub region_errors: Vec<RegionError>,
    pub items: Vec<ResourceItem>,
    pub cost_rollup: DetectorCostRollup,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub scan_id: i64,
    pub started_at: i64,
    pub finished_at: i64,
    pub account_id: String,
    pub regions: Vec<String>,
    pub status: ScanStatus,
    pub detectors: Vec<DetectorResult>,
    pub cost_rollup: AccountCostRollup,
    /// Fixed USD→BRL rate from the price table (placeholder value; UI labels it approximate).
    pub fx_usd_brl: f64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ScanRunOutcome {
    Ok { result: ScanResult },
    /// The user cancelled — `result` reflects the regions that did finish (ADR 0004 D3).
    Cancelled { result: ScanResult },
    /// The stored credential no longer validates — the webview must send the user back to onboarding.
    ReauthRequired,
}

// --- Scope 4 — progressive multi-region scan events (ADR 0004 D6) -----------
// Emitted on the Tauri event bus as the scan runs; mirrored in `core/models/scan.ts`.

/// `scan://started` — fired once, before any region runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStartedEvent {
    pub scan_id: i64,
    pub regions: Vec<String>,
}

/// `scan://region` — fired as each region finishes and is persisted. `result` is the full
/// accumulating `ScanResult` so far, so the webview just replaces what it holds.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRegionEvent {
    pub scan_id: i64,
    pub region: String,
    /// `Ok` = every detector ran; `Partial` = a detector errored in this region.
    pub region_status: ScanStatus,
    pub result: ScanResult,
}

/// `scan://done` — terminal. `status` is the whole scan's outcome.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanDoneEvent {
    pub scan_id: i64,
    pub status: ScanStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRef {
    pub resource_type: ResourceType,
    pub resource_id: String,
    pub region: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[cfg(test)]
mod confidence_tests {
    use super::ConfidenceLevel::*;
    use super::{ConfidenceLevel, ConfidenceScale};

    #[test]
    fn standard_scale_cutoffs() {
        let s = ConfidenceScale::Standard;
        let l = |d| ConfidenceLevel::from_days(d, s);
        assert_eq!(l(-3), Observed); // clamps
        assert_eq!(l(0), Observed);
        assert_eq!(l(1), Observed);
        assert_eq!(l(2), Persisting);
        assert_eq!(l(4), Persisting);
        assert_eq!(l(5), Probable);
        assert_eq!(l(6), Probable);
        assert_eq!(l(7), Confirmed); // resolved ambiguity: Probable 5–6, Confirmed ≥7
        assert_eq!(l(400), Confirmed);
    }

    #[test]
    fn snapshot_scale_cutoffs() {
        let s = ConfidenceScale::Snapshot;
        let l = |d| ConfidenceLevel::from_days(d, s);
        assert_eq!(l(0), Observed);
        assert_eq!(l(6), Observed);
        assert_eq!(l(7), Persisting);
        assert_eq!(l(18), Persisting);
        assert_eq!(l(19), Probable);
        assert_eq!(l(29), Probable);
        assert_eq!(l(30), Confirmed);
    }
}
