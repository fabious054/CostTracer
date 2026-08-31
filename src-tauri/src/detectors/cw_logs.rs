//! Detector 4 — CloudWatch Logs group with no retention policy. Alert state: `retentionInDays`
//! is null/absent (AWS keeps logs forever by default). Neutral: any retention value is set.
//!
//! No size threshold — every retention-less group counts from first detection, including groups
//! auto-created by other AWS services (Lambda / ECS / API Gateway). The log group name *is* the
//! identifier. Standard confidence scale. See ADR 0005.

use serde_json::json;

use crate::aws::describe_sdk_error;
use crate::detectors::RawFinding;
use crate::model::ResourceType;

pub async fn detect(
    logs: &aws_sdk_cloudwatchlogs::Client,
) -> Result<Vec<RawFinding>, String> {
    let mut pages = logs.describe_log_groups().into_paginator().send();

    let mut findings = Vec::new();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| describe_sdk_error(&e))?;
        for g in page.log_groups() {
            let name = g.log_group_name().unwrap_or_default().to_string();
            if name.is_empty() {
                continue;
            }

            let retention = g.retention_in_days();

            findings.push(RawFinding {
                resource_type: ResourceType::CloudwatchLogGroup,
                resource_id: name,
                in_alert: retention.is_none(),
                // `creationTime` is epoch milliseconds here (unlike the EC2 APIs).
                created_at: g.creation_time().map(|ms| ms / 1000),
                display_name: None,
                neutral_note: None,
                facts: json!({
                    "storedBytes": g.stored_bytes().unwrap_or(0),
                    "retentionDays": retention,
                    "logGroupClass": g.log_group_class().map(|c| c.as_str()),
                }),
            });
        }
    }
    Ok(findings)
}
