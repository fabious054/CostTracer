//! The Tauri command surface. One command per side effect in `docs/scope-1-connection-flow.md`.
//! The webview never receives a secret — raw keys and SSO tokens stay in `OnboardingSession`
//! until `connection_finalize` moves them into the OS vault.

use std::sync::{Arc, Mutex};

use aws_credential_types::provider::ProvideCredentials;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::aws;
use crate::aws::sso::PollResult;
use crate::error::{AppError, AppResult};
use crate::model::{
    AccountInfo, CallerIdentity, CredentialSourceKind, DetectedConfig, ManualCredentialInput,
    PermissionAudit, ResourceRef, ResumeOutcome, ScanResult, ScanRunOutcome, SsoDeviceAuth,
    SsoPollOutcome, SsoSelectTargetInput, SsoStartInput, StoredCredential, UseDetectedInput,
    ValidationOutcome,
};
use crate::pricing::{price_needs, PriceBook, PriceCache, PriceRefresher};
use crate::session::{OnboardingSession, PendingCredential, SsoFlow};
use crate::store::Db;
use crate::util::now_unix_secs;
use crate::vault;

/// Single source of truth for the recommended policy — the exact repo file, embedded at build time.
const MINIMAL_POLICY_JSON: &str = include_str!("../../docs/iam-policy-minimal.json");

// --- launch --------------------------------------------------------------------

#[tauri::command]
pub async fn session_resume() -> AppResult<ResumeOutcome> {
    let stored = match vault::load()? {
        Some(s) => s,
        None => return Ok(ResumeOutcome::None),
    };

    let config = aws::config::from_static_keys(
        &stored.access_key_id,
        &stored.secret_access_key,
        stored.session_token.clone(),
        &stored.region,
    )
    .await;

    match aws::identity::validate(&config).await {
        ValidationOutcome::Ok { identity } => Ok(ResumeOutcome::Ok {
            account: account_info(
                identity,
                &stored.regions,
                &stored.region,
                stored.source_kind,
                stored.regions_discovered,
            ),
        }),
        _ => Ok(ResumeOutcome::Stale),
    }
}

/// The account the vault currently holds, built straight from the stored blob — no STS call.
/// The vault is a single shared store; a window keeps its own `connection` state in memory and
/// can drift from it (another window connects a different account, an interrupted reconnect).
/// The webview calls this to reconcile — cheap enough to run on every window focus.
#[tauri::command]
pub fn connection_account() -> AppResult<Option<AccountInfo>> {
    Ok(vault::load()?.map(|s| AccountInfo {
        account_id: s.account_id,
        arn: s.arn,
        user_id: s.user_id,
        regions: s.regions,
        regions_discovered: s.regions_discovered,
        source_kind: s.source_kind,
    }))
}

#[tauri::command]
pub fn detect_local_config() -> AppResult<DetectedConfig> {
    Ok(aws::local_config::detect())
}

#[tauri::command]
pub fn policy_minimal_read() -> AppResult<String> {
    Ok(MINIMAL_POLICY_JSON.to_string())
}

/// Open a URL in the user's default browser (used by the SSO device-authorization screen).
#[tauri::command]
pub fn open_url(app: tauri::AppHandle, url: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::msg(format!("Could not open your browser: {e}")))
}

// --- credential capture ------------------------------------------------------

#[tauri::command]
pub async fn credential_submit_manual(
    input: ManualCredentialInput,
    session: State<'_, OnboardingSession>,
) -> AppResult<ValidationOutcome> {
    // No region field any more — the scan discovers the account's regions itself (Scope 4).
    // A home region is still needed for the STS / EC2 validation probe.
    let region = aws::config::resolve_region(None);
    let session_token = input.session_token.filter(|t| !t.trim().is_empty());
    let config = aws::config::from_static_keys(
        input.access_key_id.trim(),
        input.secret_access_key.trim(),
        session_token,
        &region,
    )
    .await;

    let outcome = aws::identity::validate(&config).await;
    store_pending(&session, config, CredentialSourceKind::Manual, Vec::new(), &outcome).await;
    Ok(outcome)
}

#[tauri::command]
pub async fn credential_use_detected(
    input: UseDetectedInput,
    session: State<'_, OnboardingSession>,
) -> AppResult<ValidationOutcome> {
    let detected = aws::local_config::detect();
    // Home region for the validation probe only — the scan discovers the account's regions.
    let region = aws::config::resolve_region(detected.default_region.as_deref());
    let config = aws::config::from_profile(input.profile.as_deref(), &region).await;

    let outcome = aws::identity::validate(&config).await;
    store_pending(&session, config, CredentialSourceKind::Detected, Vec::new(), &outcome).await;
    Ok(outcome)
}

#[tauri::command]
pub async fn credential_revalidate(
    session: State<'_, OnboardingSession>,
) -> AppResult<ValidationOutcome> {
    let config = {
        let guard = session.inner.lock().await;
        guard
            .pending
            .as_ref()
            .ok_or_else(|| AppError::msg("No credential in progress to re-validate."))?
            .config
            .clone()
    };

    let outcome = aws::identity::validate(&config).await;

    let mut guard = session.inner.lock().await;
    if let Some(pending) = guard.pending.as_mut() {
        pending.identity = outcome_identity(&outcome);
    }
    Ok(outcome)
}

// --- SSO -------------------------------------------------------------------

#[tauri::command]
pub async fn sso_start(
    input: SsoStartInput,
    session: State<'_, OnboardingSession>,
) -> AppResult<SsoDeviceAuth> {
    let started = aws::sso::register_and_start(&input.region, &input.start_url)
        .await
        .map_err(AppError::msg)?;

    let device_auth = SsoDeviceAuth {
        user_code: started.user_code,
        verification_uri: started.verification_uri,
        verification_uri_complete: started.verification_uri_complete,
        expires_at: now_ms() + started.expires_in * 1000,
        interval_sec: started.interval,
    };

    let mut guard = session.inner.lock().await;
    guard.sso = Some(SsoFlow {
        region: input.region,
        client_id: started.client_id,
        client_secret: started.client_secret,
        device_code: started.device_code,
        access_token: None,
    });
    Ok(device_auth)
}

#[tauri::command]
pub async fn sso_poll(session: State<'_, OnboardingSession>) -> AppResult<SsoPollOutcome> {
    let (region, existing_token, client_id, client_secret, device_code) = {
        let guard = session.inner.lock().await;
        let flow = guard
            .sso
            .as_ref()
            .ok_or_else(|| AppError::msg("No SSO flow in progress."))?;
        (
            flow.region.clone(),
            flow.access_token.clone(),
            flow.client_id.clone(),
            flow.client_secret.clone(),
            flow.device_code.clone(),
        )
    };

    // The device code is single-use: if a previous poll already exchanged it for a token, never
    // call `create_token` again (that returns InvalidGrantException). Just re-resolve targets.
    if let Some(token) = existing_token {
        let targets = aws::sso::list_targets(&region, &token)
            .await
            .map_err(AppError::msg)?;
        return Ok(SsoPollOutcome::Authorized { targets });
    }

    match aws::sso::poll_token(&region, &client_id, &client_secret, &device_code)
        .await
        .map_err(AppError::msg)?
    {
        PollResult::Pending => Ok(SsoPollOutcome::Pending),
        PollResult::SlowDown => Ok(SsoPollOutcome::SlowDown),
        PollResult::Expired => Ok(SsoPollOutcome::Expired),
        PollResult::Authorized { access_token } => {
            {
                let mut guard = session.inner.lock().await;
                if let Some(flow) = guard.sso.as_mut() {
                    flow.access_token = Some(access_token.clone());
                }
            }
            let targets = aws::sso::list_targets(&region, &access_token)
                .await
                .map_err(AppError::msg)?;
            Ok(SsoPollOutcome::Authorized { targets })
        }
    }
}

#[tauri::command]
pub async fn sso_select_target(
    input: SsoSelectTargetInput,
    session: State<'_, OnboardingSession>,
) -> AppResult<ValidationOutcome> {
    let (region, token) = {
        let guard = session.inner.lock().await;
        let flow = guard
            .sso
            .as_ref()
            .ok_or_else(|| AppError::msg("No SSO flow in progress."))?;
        let token = flow
            .access_token
            .clone()
            .ok_or_else(|| AppError::msg("SSO is not authorized yet."))?;
        (flow.region.clone(), token)
    };

    let keys =
        aws::sso::role_credentials(&region, &token, &input.account_id, &input.role_name)
            .await
            .map_err(AppError::msg)?;

    let config = aws::config::from_static_keys(
        &keys.access_key_id,
        &keys.secret_access_key,
        keys.session_token,
        &region,
    )
    .await;

    let outcome = aws::identity::validate(&config).await;
    store_pending(&session, config, CredentialSourceKind::Sso, Vec::new(), &outcome).await;
    Ok(outcome)
}

// --- permission audit ------------------------------------------------------

#[tauri::command]
pub async fn permissions_check(
    session: State<'_, OnboardingSession>,
) -> AppResult<PermissionAudit> {
    let (config, identity) = {
        let guard = session.inner.lock().await;
        let pending = guard
            .pending
            .as_ref()
            .ok_or_else(|| AppError::msg("No validated credential."))?;
        let identity = pending
            .identity
            .clone()
            .ok_or_else(|| AppError::msg("Credential has not been validated yet."))?;
        (pending.config.clone(), identity)
    };

    Ok(aws::permission_audit::audit(&config, &identity).await)
}

// --- finalize / teardown -------------------------------------------------

#[tauri::command]
pub async fn connection_finalize(
    session: State<'_, OnboardingSession>,
) -> AppResult<AccountInfo> {
    let (config, source, regions, identity) = {
        let guard = session.inner.lock().await;
        let pending = guard
            .pending
            .as_ref()
            .ok_or_else(|| AppError::msg("No credential to finalize."))?;
        let identity = pending
            .identity
            .clone()
            .ok_or_else(|| AppError::msg("Credential has not been validated."))?;
        (
            pending.config.clone(),
            pending.source,
            pending.regions.clone(),
            identity,
        )
    };

    let provider = config
        .credentials_provider()
        .ok_or_else(|| AppError::msg("No credential provider resolved for storage."))?;
    let creds = provider
        .provide_credentials()
        .await
        .map_err(|e| AppError::msg(format!("Could not resolve credentials for storage: {e}")))?;

    let region = aws::config::region_of(&config);

    // Discover the account's enabled regions now, so the connected view can show them straight
    // away (ADR 0004 D4). Non-blocking: if the call fails (e.g. `ec2:DescribeRegions` not yet
    // granted), fall back to a single region but mark it undiscovered — the UI must not show that
    // count as a fact, and the first scan re-runs discovery to surface the missing permission.
    let (regions, regions_discovered) = match aws::regions::enabled_regions(&config).await {
        Ok(discovered) => (discovered, true),
        Err(_) if !regions.is_empty() => (regions, false),
        Err(_) => (vec![region.clone()], false),
    };

    let stored = StoredCredential {
        access_key_id: creds.access_key_id().to_string(),
        secret_access_key: creds.secret_access_key().to_string(),
        session_token: creds.session_token().map(str::to_string),
        region: region.clone(),
        regions: regions.clone(),
        regions_discovered,
        source_kind: source,
        account_id: identity.account_id.clone(),
        user_id: identity.user_id.clone(),
        arn: identity.arn.clone(),
        saved_at_unix: now_unix(),
    };
    vault::save(&stored)?;

    session.inner.lock().await.clear();
    Ok(account_info(identity, &regions, &region, source, regions_discovered))
}

#[tauri::command]
pub async fn connection_disconnect(session: State<'_, OnboardingSession>) -> AppResult<()> {
    vault::delete()?;
    session.inner.lock().await.clear();
    Ok(())
}

#[tauri::command]
pub async fn session_discard(session: State<'_, OnboardingSession>) -> AppResult<()> {
    session.inner.lock().await.clear();
    Ok(())
}

// --- Scope 2 + 4: idle-resource scan --------------------------------------------

/// Holds the current scan's cancellation token in Tauri managed state (ADR 0004 D1). Each
/// `scan_run` installs a fresh one; `scan_cancel` trips whatever is installed.
#[derive(Default)]
pub struct ScanCancel(Mutex<CancellationToken>);

impl ScanCancel {
    fn fresh(&self) -> CancellationToken {
        let mut guard = self.0.lock().expect("scan-cancel mutex poisoned");
        *guard = CancellationToken::new();
        guard.clone()
    }
    fn trip(&self) {
        self.0.lock().expect("scan-cancel mutex poisoned").cancel();
    }
}

#[tauri::command]
pub async fn scan_run(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    prices: State<'_, Arc<PriceCache>>,
    refresher: State<'_, PriceRefresher>,
    cancel: State<'_, ScanCancel>,
) -> AppResult<ScanRunOutcome> {
    let token = cancel.fresh();
    crate::scan::run_scan(&app, db.inner(), prices.inner(), refresher.inner(), token).await
}

#[tauri::command]
pub fn scan_cancel(cancel: State<'_, ScanCancel>) -> AppResult<()> {
    cancel.trip();
    Ok(())
}

/// A price snapshot from the local cache for `regions` — no network (ADR 0006). Absent entries
/// read back as "price pending".
fn price_book(cache: &PriceCache, regions: &[String]) -> AppResult<PriceBook> {
    cache.load_book(&price_needs(regions), now_unix_secs())
}

#[tauri::command]
pub fn scan_latest(
    db: State<'_, Db>,
    prices: State<'_, Arc<PriceCache>>,
) -> AppResult<Option<ScanResult>> {
    match vault::load()? {
        Some(cred) => {
            let book = price_book(prices.inner(), &cred.regions)?;
            db.latest_scan_result(&cred.account_id, &book)
        }
        None => Ok(None),
    }
}

/// Start the background price/FX refresher if it isn't running (idempotent, ADR 0006 D2b/D2c) and
/// return whether a fetch cycle is running **right now** — so the webview can show the "updating
/// prices" strip even if it missed the boot-time `pricing://refreshing` event.
#[tauri::command]
pub fn pricing_refresh_start(
    app: tauri::AppHandle,
    prices: State<'_, Arc<PriceCache>>,
    refresher: State<'_, PriceRefresher>,
) -> AppResult<bool> {
    refresher.ensure_started(app, prices.inner().clone());
    Ok(refresher.is_active())
}

#[tauri::command]
pub fn resource_mark_intentional(input: ResourceRef, db: State<'_, Db>) -> AppResult<()> {
    db.mark_intentional(&connected_account_id()?, &input)
}

#[tauri::command]
pub fn resource_unmark_intentional(input: ResourceRef, db: State<'_, Db>) -> AppResult<()> {
    db.unmark_intentional(&connected_account_id()?, &input)
}

// DEV-ONLY (`#[cfg(debug_assertions)]`). Replaces the connected account's scan history with a
// realistic fixture so the cost/inventory UI can be reviewed with representative data — no AWS.
// Kept permanently as a dev tool (CLAUDE.md scope-closure checklist, item 2 exception), not
// removed at any scope close.
#[cfg(debug_assertions)]
#[tauri::command]
pub fn dev_seed_scan(db: State<'_, Db>) -> AppResult<ScanResult> {
    // A synthetic price book so the demo shows numbers with no network / no cache dependency.
    db.seed_demo(&connected_account_id()?, &crate::store::demo_price_book())
}

fn connected_account_id() -> AppResult<String> {
    vault::load()?
        .map(|s| s.account_id)
        .ok_or_else(|| AppError::msg("Not connected to an AWS account."))
}

// --- helpers -------------------------------------------------------------

async fn store_pending(
    session: &State<'_, OnboardingSession>,
    config: aws_config::SdkConfig,
    source: CredentialSourceKind,
    regions: Vec<String>,
    outcome: &ValidationOutcome,
) {
    let mut guard = session.inner.lock().await;
    guard.pending = Some(PendingCredential {
        config,
        source,
        regions,
        identity: outcome_identity(outcome),
    });
}

fn outcome_identity(outcome: &ValidationOutcome) -> Option<CallerIdentity> {
    match outcome {
        ValidationOutcome::Ok { identity } => Some(identity.clone()),
        _ => None,
    }
}

fn account_info(
    identity: CallerIdentity,
    regions: &[String],
    region: &str,
    source: CredentialSourceKind,
    regions_discovered: bool,
) -> AccountInfo {
    AccountInfo {
        account_id: identity.account_id,
        arn: identity.arn,
        user_id: identity.user_id,
        regions: if regions.is_empty() {
            vec![region.to_string()]
        } else {
            regions.to_vec()
        },
        regions_discovered,
        source_kind: source,
    }
}

fn now_ms() -> u64 {
    since_epoch().as_millis() as u64
}

fn now_unix() -> u64 {
    since_epoch().as_secs()
}

fn since_epoch() -> std::time::Duration {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
}
