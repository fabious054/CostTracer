//! The three Scope 2 detectors. Each classifies every resource of its type as `in_alert` (the
//! detector's raw alert state) or neutral, and captures the facts needed to render the row and
//! its mandatory explanation. Nothing here is written back to AWS.

pub mod ebs;
pub mod elastic_ip;
pub mod snapshot;

use std::collections::HashSet;

use aws_sdk_ec2::types::Tag;
use serde_json::Value;

use crate::model::{DetectorKind, ResourceType};

/// One resource as seen by a detector during one region's scan.
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

/// Run all three detectors against one region. Never returns a top-level error: each detector's
/// failure is captured so the others (and other regions) still produce results.
pub async fn run_region(
    ec2: &aws_sdk_ec2::Client,
) -> (Vec<RawFinding>, Vec<(DetectorKind, String)>) {
    let mut findings = Vec::new();
    let mut errors = Vec::new();

    let volumes = match ebs::list_volumes(ec2).await {
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
        match snapshot::detect(ec2, &existing).await {
            Ok(f) => findings.extend(f),
            Err(e) => errors.push((DetectorKind::OrphanSnapshot, e)),
        }
    }

    match elastic_ip::detect(ec2).await {
        Ok(f) => findings.extend(f),
        Err(e) => errors.push((DetectorKind::ElasticIpIdle, e)),
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
