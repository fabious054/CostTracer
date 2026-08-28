//! In-memory onboarding session. Holds the raw credential / SSO token between commands so the
//! webview never has to keep a secret. Cleared on finalize, disconnect, or `session_discard`.

use aws_config::SdkConfig;
use tokio::sync::Mutex;

use crate::model::{CallerIdentity, CredentialSourceKind};

#[derive(Default)]
pub struct OnboardingSession {
    pub inner: Mutex<SessionInner>,
}

#[derive(Default)]
pub struct SessionInner {
    pub pending: Option<PendingCredential>,
    pub sso: Option<SsoFlow>,
}

impl SessionInner {
    pub fn clear(&mut self) {
        self.pending = None;
        self.sso = None;
    }
}

/// A credential that has been captured (and possibly validated) but not yet persisted.
pub struct PendingCredential {
    pub config: SdkConfig,
    pub source: CredentialSourceKind,
    pub regions: Vec<String>,
    pub identity: Option<CallerIdentity>,
}

/// State for an in-progress SSO device-authorization flow.
pub struct SsoFlow {
    pub region: String,
    pub client_id: String,
    pub client_secret: String,
    pub device_code: String,
    pub access_token: Option<String>,
}
