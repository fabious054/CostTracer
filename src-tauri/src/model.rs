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
    pub region: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UseDetectedInput {
    pub profile: Option<String>,
    pub region: Option<String>,
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
    pub source_kind: CredentialSourceKind,
    pub account_id: String,
    pub user_id: String,
    pub arn: String,
    pub saved_at_unix: u64,
}
