//! Credential validation: `sts:GetCallerIdentity` proves the credential is real; a cheap read
//! probe (`ec2:DescribeVolumes`) separates "valid and usable" from "valid but under-permissioned".

use aws_config::SdkConfig;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;

use crate::aws::{describe_sdk_error, is_authorization_denied};
use crate::model::{CallerIdentity, ValidationOutcome};

pub const PROBE_ACTION: &str = "ec2:DescribeVolumes";

pub async fn validate(config: &SdkConfig) -> ValidationOutcome {
    let sts = aws_sdk_sts::Client::new(config);
    let response = match sts.get_caller_identity().send().await {
        Ok(r) => r,
        Err(e) => {
            return ValidationOutcome::Invalid {
                message: describe_sdk_error(&e),
            }
        }
    };

    let identity = CallerIdentity {
        account_id: response.account().unwrap_or_default().to_string(),
        user_id: response.user_id().unwrap_or_default().to_string(),
        arn: response.arn().unwrap_or_default().to_string(),
    };

    let ec2 = aws_sdk_ec2::Client::new(config);
    match ec2.describe_volumes().max_results(5).send().await {
        Ok(_) => ValidationOutcome::Ok { identity },
        Err(e) => {
            let code = e
                .as_service_error()
                .and_then(|svc| svc.code())
                .unwrap_or_default()
                .to_string();
            if is_authorization_denied(&code) {
                ValidationOutcome::Insufficient {
                    // Just the fact — the UI adds the (translated) "what to do" guidance.
                    message: format!("{PROBE_ACTION} was denied ({code})."),
                    probed_action: PROBE_ACTION.to_string(),
                }
            } else {
                // A non-authorization failure (network, throttling, disabled region) should not
                // block onboarding — the identity itself is valid.
                ValidationOutcome::Ok { identity }
            }
        }
    }
}
