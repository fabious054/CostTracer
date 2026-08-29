//! Detector 1 — unattached EBS volume. Alert state: `State = available`. Neutral: `in-use`.

use serde_json::json;

use crate::aws::describe_sdk_error;
use crate::detectors::{tag_name, RawFinding};
use crate::model::ResourceType;

const STATE_AVAILABLE: &str = "available";

/// The fields the EBS detector and the orphan-snapshot detector both need from `DescribeVolumes`.
pub struct VolumeInfo {
    pub id: String,
    pub state: String,
    pub created_at: Option<i64>,
    pub size_gib: Option<i32>,
    pub az: Option<String>,
    pub vol_type: Option<String>,
    pub name: Option<String>,
}

pub async fn list_volumes(ec2: &aws_sdk_ec2::Client) -> Result<Vec<VolumeInfo>, String> {
    let mut pages = ec2.describe_volumes().into_paginator().send();
    let mut out = Vec::new();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| describe_sdk_error(&e))?;
        for v in page.volumes() {
            let id = v.volume_id().unwrap_or_default().to_string();
            if id.is_empty() {
                continue;
            }
            out.push(VolumeInfo {
                id,
                state: v.state().map(|s| s.as_str().to_string()).unwrap_or_default(),
                created_at: v.create_time().map(|t| t.secs()),
                size_gib: v.size(),
                az: v.availability_zone().map(str::to_string),
                vol_type: v.volume_type().map(|t| t.as_str().to_string()),
                name: tag_name(v.tags()),
            });
        }
    }
    Ok(out)
}

pub fn findings(volumes: &[VolumeInfo]) -> Vec<RawFinding> {
    volumes
        .iter()
        .map(|v| RawFinding {
            resource_type: ResourceType::EbsVolume,
            resource_id: v.id.clone(),
            in_alert: v.state == STATE_AVAILABLE,
            created_at: v.created_at,
            display_name: v.name.clone(),
            neutral_note: None,
            facts: json!({
                "sizeGiB": v.size_gib,
                "az": v.az,
                "type": v.vol_type,
                "state": v.state,
            }),
        })
        .collect()
}
