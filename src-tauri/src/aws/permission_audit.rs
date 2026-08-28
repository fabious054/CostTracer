//! Over-privilege check. Preferred path: `iam:SimulatePrincipalPolicy` against a list of
//! destructive actions. Fallback (when simulate fails for any reason): `iam:ListAttached*Policies`
//! and flag broadly-scoped managed policies by name.

use aws_config::SdkConfig;
use aws_sdk_iam::types::PolicyEvaluationDecisionType;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;

use crate::model::{CallerIdentity, PermissionAudit, PermissionAuditMethod, RiskFinding, RiskKind};

/// Destructive actions we never need. If the principal is allowed any of them, it is over-scoped.
const DESTRUCTIVE_ACTIONS: &[&str] = &[
    "ec2:TerminateInstances",
    "ec2:DeleteVolume",
    "ec2:DeleteSnapshot",
    "ec2:ReleaseAddress",
    "s3:DeleteBucket",
    "iam:CreateUser",
    "iam:DeleteRole",
    "iam:AttachUserPolicy",
    "iam:PutUserPolicy",
    "iam:CreateAccessKey",
];

/// AWS-managed policies whose mere attachment means far more than read-only.
const BROAD_MANAGED_POLICIES: &[&str] = &["AdministratorAccess", "PowerUserAccess", "IAMFullAccess"];

pub async fn audit(config: &SdkConfig, identity: &CallerIdentity) -> PermissionAudit {
    let client = aws_sdk_iam::Client::new(config);
    // SimulatePrincipalPolicy needs an IAM user/role ARN, never an STS assumed-role ARN.
    let principal_arn = iam_principal_arn(&identity.arn);

    match simulate(&client, &principal_arn).await {
        Ok(audit) => audit,
        // Any failure (denied, bad ARN, throttle, …) — try the name-based fallback before giving up.
        Err(_) => fallback(&client, &identity.arn).await,
    }
}

fn inconclusive() -> PermissionAudit {
    PermissionAudit {
        method: PermissionAuditMethod::Inconclusive,
        excessive: false,
        findings: Vec::new(),
    }
}

async fn simulate(
    client: &aws_sdk_iam::Client,
    principal_arn: &str,
) -> Result<PermissionAudit, String> {
    let response = client
        .simulate_principal_policy()
        .policy_source_arn(principal_arn)
        .set_action_names(Some(
            DESTRUCTIVE_ACTIONS.iter().map(|s| s.to_string()).collect(),
        ))
        .send()
        .await
        .map_err(|e| {
            e.as_service_error()
                .and_then(|svc| svc.code())
                .map(str::to_string)
                .unwrap_or_else(|| e.to_string())
        })?;

    let mut findings = Vec::new();
    for result in response.evaluation_results() {
        if result.eval_decision() == &PolicyEvaluationDecisionType::Allowed {
            findings.push(RiskFinding {
                kind: RiskKind::SimulatedActionAllowed,
                label: result.eval_action_name().to_string(),
                detail: "Policy simulation says this identity can perform this destructive action."
                    .to_string(),
            });
        }
    }

    Ok(PermissionAudit {
        method: PermissionAuditMethod::Simulate,
        excessive: !findings.is_empty(),
        findings,
    })
}

async fn fallback(client: &aws_sdk_iam::Client, arn: &str) -> PermissionAudit {
    let attached = match attached_policy_names(client, arn).await {
        Some(names) => names,
        None => return inconclusive(),
    };

    let findings: Vec<RiskFinding> = attached
        .into_iter()
        .filter(|name| BROAD_MANAGED_POLICIES.contains(&name.as_str()) || name.ends_with("FullAccess"))
        .map(|name| RiskFinding {
            kind: RiskKind::BroadManagedPolicy,
            label: name,
            detail: "This attached managed policy grants far more than CostTracer's read-only needs."
                .to_string(),
        })
        .collect();

    PermissionAudit {
        method: PermissionAuditMethod::ListPolicies,
        excessive: !findings.is_empty(),
        findings,
    }
}

async fn attached_policy_names(client: &aws_sdk_iam::Client, arn: &str) -> Option<Vec<String>> {
    if let Some(rest) = principal_after(arn, ":user/") {
        let user = last_segment(rest); // strip any IAM path
        return client
            .list_attached_user_policies()
            .user_name(user)
            .send()
            .await
            .ok()
            .map(|resp| policy_names(resp.attached_policies()));
    }

    let role = principal_after(arn, ":assumed-role/")
        .map(first_segment)
        .or_else(|| principal_after(arn, ":role/").map(last_segment));

    if let Some(role) = role {
        return client
            .list_attached_role_policies()
            .role_name(role)
            .send()
            .await
            .ok()
            .map(|resp| policy_names(resp.attached_policies()));
    }

    None
}

fn policy_names(policies: &[aws_sdk_iam::types::AttachedPolicy]) -> Vec<String> {
    policies
        .iter()
        .filter_map(|p| p.policy_name().map(str::to_string))
        .collect()
}

/// `arn:aws:sts::ACCT:assumed-role/ROLE/SESSION` -> `arn:aws:iam::ACCT:role/ROLE`; other ARNs pass through.
fn iam_principal_arn(arn: &str) -> String {
    if let Some(rest) = arn.strip_prefix("arn:aws:sts::") {
        if let Some((account, tail)) = rest.split_once(":assumed-role/") {
            return format!("arn:aws:iam::{account}:role/{}", first_segment(tail));
        }
    }
    arn.to_string()
}

/// Text after `marker`, e.g. `principal_after("…:user/bob", ":user/") == Some("bob")`.
fn principal_after<'a>(arn: &'a str, marker: &str) -> Option<&'a str> {
    arn.find(marker).map(|i| &arn[i + marker.len()..])
}

fn first_segment(s: &str) -> &str {
    s.split('/').next().unwrap_or(s)
}

fn last_segment(s: &str) -> &str {
    s.rsplit('/').next().unwrap_or(s)
}
