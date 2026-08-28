pub mod config;
pub mod identity;
pub mod local_config;
pub mod permission_audit;
pub mod sso;

use aws_smithy_runtime_api::client::result::SdkError;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;

/// Turn any AWS SDK error into a compact `code: message` string for the UI.
pub fn describe_sdk_error<E, R>(err: &SdkError<E, R>) -> String
where
    E: ProvideErrorMetadata,
{
    if let Some(service) = err.as_service_error() {
        let code = service.code().unwrap_or("ServiceError");
        match service.message() {
            Some(msg) if !msg.is_empty() => format!("{code}: {msg}"),
            _ => code.to_string(),
        }
    } else {
        err.to_string()
    }
}

/// AWS error codes that mean "the call worked but this principal is not allowed".
pub fn is_authorization_denied(code: &str) -> bool {
    matches!(
        code,
        "AccessDenied"
            | "AccessDeniedException"
            | "UnauthorizedOperation"
            | "Client.UnauthorizedOperation"
            | "AuthorizationError"
            | "NotAuthorized"
    )
}
