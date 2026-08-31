//! The idle-resource detectors. Each classifies every resource of its type as `in_alert` (the
//! detector's raw alert state) or neutral, and captures the facts needed to render the row and
//! its mandatory explanation. Nothing here is written back to AWS.
//!
//! Scope 2: unattached EBS volume, idle Elastic IP, orphan EBS snapshot.
//! Scope 5 (ADR 0005): CloudWatch Logs group with no retention, orphan RDS snapshot.

pub mod cw_logs;
pub mod ebs;
pub mod elastic_ip;
pub mod rds_snapshot;
pub mod snapshot;

use std::collections::HashSet;

use aws_config::SdkConfig;
use aws_sdk_ec2::types::Tag;
use serde_json::Value;

use crate::model::{DetectorKind, ResourceType};

/// One resource as seen by a detector during one region's scan.
#[derive(Clone)]
pub struct RawFinding {
    pub resource_type: ResourceType,
    pub resource_id: String,
    pub in_alert: bool,
    /// AWS creation time (unix seconds). `None` for Elastic IP — AWS reports no such date.
    pub created_at: Option<i64>,
    pub display_name: Option<String>,
    /// Stable code the webview maps to a translated note (e.g. "associated-instance-stopped").
    pub neutral_note: Option<String>,
    pub facts: Value,
}

/// Run every detector against one region. Never returns a top-level error: each detector's
/// failure is captured so the others (and other regions) still produce results.
///
/// Takes the region's `SdkConfig` and builds the per-service clients it needs (ADR 0005 D4) —
/// `scan.rs` stays a pure orchestrator and future detectors don't churn this signature. Client
/// construction is cheap (no I/O).
pub async fn run_region(cfg: &SdkConfig) -> (Vec<RawFinding>, Vec<(DetectorKind, String)>) {
    let ec2 = aws_sdk_ec2::Client::new(cfg);
    let logs = aws_sdk_cloudwatchlogs::Client::new(cfg);
    let rds = aws_sdk_rds::Client::new(cfg);

    let mut findings = Vec::new();
    let mut errors = Vec::new();

    // --- EBS volumes + orphan EBS snapshots (share the DescribeVolumes result) ---
    let volumes = match ebs::list_volumes(&ec2).await {
        Ok(v) => Some(v),
        Err(e) => {
            // Without the volume list, orphan-snapshot detection would flag every snapshot.
            errors.push((DetectorKind::EbsUnattached, e.clone()));
            errors.push((DetectorKind::OrphanSnapshot, format!("skipped — {e}")));
            None
        }
    };

    if let Some(volumes) = volumes {
        findings.extend(ebs::findings(&volumes));

        let existing: HashSet<&str> = volumes.iter().map(|v| v.id.as_str()).collect();
        match snapshot::detect(&ec2, &existing).await {
            Ok(f) => findings.extend(f),
            Err(e) => errors.push((DetectorKind::OrphanSnapshot, e)),
        }
    }

    // --- Idle Elastic IPs ---
    match elastic_ip::detect(&ec2).await {
        Ok(f) => findings.extend(f),
        Err(e) => errors.push((DetectorKind::ElasticIpIdle, e)),
    }

    // --- CloudWatch Logs groups with no retention ---
    match cw_logs::detect(&logs).await {
        Ok(f) => findings.extend(f),
        Err(e) => errors.push((DetectorKind::LogGroupNoRetention, e)),
    }

    // --- Orphan RDS snapshots (list the parent instances first, like the EBS-snapshot pair) ---
    match rds_snapshot::list_instance_ids(&rds).await {
        Ok(instances) => match rds_snapshot::detect(&rds, &instances).await {
            Ok(f) => findings.extend(f),
            Err(e) => errors.push((DetectorKind::OrphanRdsSnapshot, e)),
        },
        Err(e) => errors.push((DetectorKind::OrphanRdsSnapshot, format!("skipped — {e}"))),
    }

    (findings, errors)
}

/// The value of the `Name` tag, if any.
pub(crate) fn tag_name(tags: &[Tag]) -> Option<String> {
    tags.iter()
        .find(|t| t.key() == Some("Name"))
        .and_then(|t| t.value())
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}
