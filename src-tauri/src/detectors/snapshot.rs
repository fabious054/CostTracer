//! Detector 3 — orphan snapshot. Alert state: the source `VolumeId` no longer exists in
//! `DescribeVolumes`. Neutral: source volume still exists (or the source can't be determined —
//! AWS-created snapshots can carry an empty / placeholder volume id).
//! Confirms on the slower "snapshot" confidence scale (retention is commonly intentional).

use std::collections::HashSet;

use serde_json::json;

use crate::aws::describe_sdk_error;
use crate::detectors::{tag_name, RawFinding};
use crate::model::ResourceType;

const PLACEHOLDER_VOLUME_ID: &str = "vol-ffffffff";

pub async fn detect(
    ec2: &aws_sdk_ec2::Client,
    existing_volume_ids: &HashSet<&str>,
) -> Result<Vec<RawFinding>, String> {
    // `owner_ids("self")` is required — without it the call returns every public snapshot on AWS.
    let mut pages = ec2
        .describe_snapshots()
        .owner_ids("self")
        .into_paginator()
        .send();

    let mut findings = Vec::new();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| describe_sdk_error(&e))?;
        for s in page.snapshots() {
            let id = s.snapshot_id().unwrap_or_default().to_string();
            if id.is_empty() {
                continue;
            }

            let source = s.volume_id().unwrap_or_default();
            let source_known = !source.is_empty() && source != PLACEHOLDER_VOLUME_ID;
            let in_alert = source_known && !existing_volume_ids.contains(source);
            let neutral_note = if source_known {
                None
            } else {
                Some("snapshot-source-unknown".to_string())
            };

            findings.push(RawFinding {
                resource_type: ResourceType::EbsSnapshot,
                resource_id: id,
                in_alert,
                created_at: s.start_time().map(|t| t.secs()),
                display_name: tag_name(s.tags()),
                neutral_note,
                facts: json!({
                    "sizeGiB": s.volume_size(),
                    "sourceVolumeId": if source.is_empty() { None } else { Some(source) },
                    "description": s.description(),
                }),
            });
        }
    }
    Ok(findings)
}
