//! Detector 5 — orphan RDS snapshot. Alert state: the snapshot's source `DBInstanceIdentifier`
//! no longer exists in `DescribeDBInstances`. Neutral: source instance still exists (or the
//! source can't be determined).
//!
//! Manual snapshots only (ADR 0005 D1) — automated snapshots are AWS-lifecycle-managed and can't
//! be "forgotten". Aurora DB *cluster* snapshots are a separate API and out of scope for now.
//! Confirms on the slower "snapshot" scale, same as EBS snapshots.

use std::collections::HashSet;

use serde_json::json;

use crate::aws::describe_sdk_error;
use crate::detectors::RawFinding;
use crate::model::ResourceType;

/// The set of DB instance identifiers that currently exist — the "parent" list the detector
/// checks each snapshot against. Listed first so a failure here skips the detector for the
/// region rather than flagging every snapshot.
pub async fn list_instance_ids(
    rds: &aws_sdk_rds::Client,
) -> Result<HashSet<String>, String> {
    let mut pages = rds.describe_db_instances().into_paginator().send();
    let mut ids = HashSet::new();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| describe_sdk_error(&e))?;
        for i in page.db_instances() {
            if let Some(id) = i.db_instance_identifier() {
                if !id.is_empty() {
                    ids.insert(id.to_string());
                }
            }
        }
    }
    Ok(ids)
}

pub async fn detect(
    rds: &aws_sdk_rds::Client,
    existing_instance_ids: &HashSet<String>,
) -> Result<Vec<RawFinding>, String> {
    let mut pages = rds
        .describe_db_snapshots()
        .snapshot_type("manual")
        .into_paginator()
        .send();

    let mut findings = Vec::new();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| describe_sdk_error(&e))?;
        for s in page.db_snapshots() {
            let id = s.db_snapshot_identifier().unwrap_or_default().to_string();
            if id.is_empty() {
                continue;
            }

            let source = s.db_instance_identifier().unwrap_or_default();
            let source_known = !source.is_empty();
            let in_alert = source_known && !existing_instance_ids.contains(source);
            let neutral_note = if source_known {
                None
            } else {
                Some("rds-snapshot-source-unknown".to_string())
            };

            findings.push(RawFinding {
                resource_type: ResourceType::RdsSnapshot,
                resource_id: id,
                in_alert,
                created_at: s.snapshot_create_time().map(|t| t.secs()),
                display_name: None,
                neutral_note,
                facts: json!({
                    "allocatedStorageGb": s.allocated_storage(),
                    "sourceDbInstanceId": (!source.is_empty()).then_some(source),
                    "engine": s.engine(),
                }),
            });
        }
    }
    Ok(findings)
}
