//! The Tauri command surface. One command per side effect in `docs/scope-1-connection-flow.md`.
//! The webview never receives a secret — raw keys and SSO tokens stay in `OnboardingSession`
//! until `connection_finalize` moves them into the OS vault.

use aws_credential_types::provider::ProvideCredentials;
use tauri::State;

use crate::aws;
use crate::aws::sso::PollResult;
use crate::error::{AppError, AppResult};
use crate::model::{
    AccountInfo, CallerIdentity, CredentialSourceKind, DetectedConfig, ManualCredentialInput,
    PermissionAudit, ResourceRef, ResumeOutcome, ScanResult, ScanRunOutcome, SsoDeviceAuth,
    SsoPollOutcome, SsoSelectTargetInput, SsoStartInput, StoredCredential, UseDetectedInput,
    ValidationOutcome,
};
use crate::session::{OnboardingSession, PendingCredential, SsoFlow};
use crate::store::Db;
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
            account: account_info(identity, &stored.regions, &stored.region, stored.source_kind),
        }),
        _ => Ok(ResumeOutcome::Stale),
    }
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
    let region = aws::config::resolve_region(input.region.as_deref());
    let session_token = input.session_token.filter(|t| !t.trim().is_empty());
    let config = aws::config::from_static_keys(
        input.access_key_id.trim(),
        input.secret_access_key.trim(),
        session_token,
        &region,
    )
    .await;
    let regions = aws::config::collect_regions(input.region.as_deref(), None);

    let outcome = aws::identity::validate(&config).await;
    store_pending(&session, config, CredentialSourceKind::Manual, regions, &outcome).await;
    Ok(outcome)
}

#[tauri::command]
pub async fn credential_use_detected(
    input: UseDetectedInput,
    session: State<'_, OnboardingSession>,
) -> AppResult<ValidationOutcome> {
    let detected = aws::local_config::detect();
    let region = aws::config::resolve_region(
        input
            .region
            .as_deref()
            .or(detected.default_region.as_deref()),
    );
    let config = aws::config::from_profile(input.profile.as_deref(), &region).await;
    let regions =
        aws::config::collect_regions(input.region.as_deref(), detected.default_region.as_deref());

    let outcome = aws::identity::validate(&config).await;
    store_pending(&session, config, CredentialSourceKind::Detected, regions, &outcome).await;
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
    let regions = aws::config::collect_regions(Some(&region), None);

    let outcome = aws::identity::validate(&config).await;
    store_pending(&session, config, CredentialSourceKind::Sso, regions, &outcome).await;
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
    let stored = StoredCredential {
        access_key_id: creds.access_key_id().to_string(),
        secret_access_key: creds.secret_access_key().to_string(),
        session_token: creds.session_token().map(str::to_string),
        region: region.clone(),
        regions: regions.clone(),
        source_kind: source,
        account_id: identity.account_id.clone(),
        user_id: identity.user_id.clone(),
        arn: identity.arn.clone(),
        saved_at_unix: now_unix(),
    };
    vault::save(&stored)?;

    session.inner.lock().await.clear();
    Ok(account_info(identity, &regions, &region, source))
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

// --- Scope 2: idle-resource scan --------------------------------------------

#[tauri::command]
pub async fn scan_run(db: State<'_, Db>) -> AppResult<ScanRunOutcome> {
    crate::scan::run_scan(db.inner()).await
}

#[tauri::command]
pub fn scan_latest(db: State<'_, Db>) -> AppResult<Option<ScanResult>> {
    match vault::load()? {
        Some(cred) => db.latest_scan_result(&cred.account_id),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn resource_mark_intentional(input: ResourceRef, db: State<'_, Db>) -> AppResult<()> {
    db.mark_intentional(&connected_account_id()?, &input)
}

#[tauri::command]
pub fn resource_unmark_intentional(input: ResourceRef, db: State<'_, Db>) -> AppResult<()> {
    db.unmark_intentional(&connected_account_id()?, &input)
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
