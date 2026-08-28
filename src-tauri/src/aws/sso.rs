//! IAM Identity Center device-authorization flow.
//!
//! `register_client` -> `start_device_authorization` (returns the user code + URL) ->
//! poll `create_token` until approved -> list accounts/roles -> `get_role_credentials`.

use aws_smithy_types::error::metadata::ProvideErrorMetadata;

use crate::aws::config;
use crate::model::SsoTarget;

pub struct RegisteredDeviceAuth {
    pub client_id: String,
    pub client_secret: String,
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

pub enum PollResult {
    Pending,
    SlowDown,
    Expired,
    Authorized { access_token: String },
}

pub async fn register_and_start(
    region: &str,
    start_url: &str,
) -> Result<RegisteredDeviceAuth, String> {
    let cfg = config::no_auth(region).await;
    let client = aws_sdk_ssooidc::Client::new(&cfg);

    let registration = client
        .register_client()
        .client_name("cost-tracer")
        .client_type("public")
        .send()
        .await
        .map_err(|e| format!("register_client failed: {e}"))?;

    let client_id = registration.client_id().unwrap_or_default().to_string();
    let client_secret = registration.client_secret().unwrap_or_default().to_string();

    let auth = client
        .start_device_authorization()
        .client_id(&client_id)
        .client_secret(&client_secret)
        .start_url(start_url)
        .send()
        .await
        .map_err(|e| format!("start_device_authorization failed: {e}"))?;

    Ok(RegisteredDeviceAuth {
        client_id,
        client_secret,
        device_code: auth.device_code().unwrap_or_default().to_string(),
        user_code: auth.user_code().unwrap_or_default().to_string(),
        verification_uri: auth.verification_uri().unwrap_or_default().to_string(),
        verification_uri_complete: auth
            .verification_uri_complete()
            .unwrap_or_default()
            .to_string(),
        expires_in: auth.expires_in().max(0) as u64,
        interval: auth.interval().max(1) as u64,
    })
}

pub async fn poll_token(
    region: &str,
    client_id: &str,
    client_secret: &str,
    device_code: &str,
) -> Result<PollResult, String> {
    let cfg = config::no_auth(region).await;
    let client = aws_sdk_ssooidc::Client::new(&cfg);

    match client
        .create_token()
        .client_id(client_id)
        .client_secret(client_secret)
        .grant_type("urn:ietf:params:oauth:grant-type:device_code")
        .device_code(device_code)
        .send()
        .await
    {
        Ok(token) => Ok(PollResult::Authorized {
            access_token: token.access_token().unwrap_or_default().to_string(),
        }),
        Err(e) => {
            if let Some(service) = e.as_service_error() {
                if service.is_authorization_pending_exception() {
                    return Ok(PollResult::Pending);
                }
                if service.is_slow_down_exception() {
                    return Ok(PollResult::SlowDown);
                }
                if service.is_expired_token_exception() {
                    return Ok(PollResult::Expired);
                }
                // InvalidGrantException = the browser approval was never completed, was denied,
                // or the code was already used. From the user's side this is the same recovery
                // as an expiry: start the flow again.
                if service.is_invalid_grant_exception() {
                    return Err(
                        "The browser authorization wasn't completed (or was denied). Start again \
                         and approve the request for CostTracer."
                            .to_string(),
                    );
                }
                if service.is_access_denied_exception() {
                    return Err(
                        "IAM Identity Center denied this device authorization. Check the start URL \
                         and that your user is assigned to an account."
                            .to_string(),
                    );
                }
                return Err(format!(
                    "SSO token request failed: {}",
                    service.code().unwrap_or("unknown error")
                ));
            }
            Err(format!("SSO token request failed: {e}"))
        }
    }
}

/// Every account + role the access token can assume (single page, up to 100 each — enough for v1).
pub async fn list_targets(region: &str, access_token: &str) -> Result<Vec<SsoTarget>, String> {
    let cfg = config::no_auth(region).await;
    let client = aws_sdk_sso::Client::new(&cfg);

    let accounts = client
        .list_accounts()
        .access_token(access_token)
        .max_results(100)
        .send()
        .await
        .map_err(|e| format!("list_accounts failed: {e}"))?;

    let mut targets = Vec::new();
    for account in accounts.account_list() {
        let account_id = account.account_id().unwrap_or_default().to_string();
        let account_name = account.account_name().unwrap_or_default().to_string();

        let roles = client
            .list_account_roles()
            .account_id(&account_id)
            .access_token(access_token)
            .max_results(100)
            .send()
            .await
            .map_err(|e| format!("list_account_roles failed: {e}"))?;

        for role in roles.role_list() {
            targets.push(SsoTarget {
                account_id: account_id.clone(),
                account_name: account_name.clone(),
                role_name: role.role_name().unwrap_or_default().to_string(),
            });
        }
    }

    Ok(targets)
}

pub struct RoleKeys {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

pub async fn role_credentials(
    region: &str,
    access_token: &str,
    account_id: &str,
    role_name: &str,
) -> Result<RoleKeys, String> {
    let cfg = config::no_auth(region).await;
    let client = aws_sdk_sso::Client::new(&cfg);

    let response = client
        .get_role_credentials()
        .role_name(role_name)
        .account_id(account_id)
        .access_token(access_token)
        .send()
        .await
        .map_err(|e| format!("get_role_credentials failed: {e}"))?;

    let creds = response
        .role_credentials()
        .ok_or_else(|| "SSO returned no role credentials".to_string())?;

    Ok(RoleKeys {
        access_key_id: creds.access_key_id().unwrap_or_default().to_string(),
        secret_access_key: creds.secret_access_key().unwrap_or_default().to_string(),
        session_token: {
            let t = creds.session_token().unwrap_or_default();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        },
    })
}
