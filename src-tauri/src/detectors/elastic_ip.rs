//! Detector 2 — idle Elastic IP. Alert state: no `AssociationId`. Neutral: associated (an
//! association to a *stopped* instance still counts as associated — noted, not alerted).
//! AWS reports no creation date for an Elastic IP, so `created_at` is always `None`; the age
//! anchor is "monitored since" (the first scan that saw it).

use std::collections::HashSet;

use serde_json::json;

use crate::aws::describe_sdk_error;
use crate::detectors::{tag_name, RawFinding};
use crate::model::ResourceType;

pub async fn detect(ec2: &aws_sdk_ec2::Client) -> Result<Vec<RawFinding>, String> {
    let addresses = ec2
        .describe_addresses()
        .send()
        .await
        .map_err(|e| describe_sdk_error(&e))?;

    // Best-effort — used only for the "associated to a stopped instance" note.
    let stopped = stopped_instance_ids(ec2).await.unwrap_or_default();

    let mut findings = Vec::new();
    for a in addresses.addresses() {
        let id = a
            .allocation_id()
            .or(a.public_ip())
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            continue;
        }

        let associated = a.association_id().is_some();
        let neutral_note = match (associated, a.instance_id()) {
            (true, Some(iid)) if stopped.contains(iid) => {
                Some("associated-instance-stopped".to_string())
            }
            _ => None,
        };

        findings.push(RawFinding {
            resource_type: ResourceType::ElasticIp,
            resource_id: id,
            in_alert: !associated,
            created_at: None,
            display_name: tag_name(a.tags()),
            neutral_note,
            facts: json!({
                "publicIp": a.public_ip(),
                "domain": a.domain().map(|d| d.as_str()),
                "associationId": a.association_id(),
                "instanceId": a.instance_id(),
                "networkInterfaceId": a.network_interface_id(),
            }),
        });
    }
    Ok(findings)
}

async fn stopped_instance_ids(ec2: &aws_sdk_ec2::Client) -> Result<HashSet<String>, String> {
    let mut pages = ec2.describe_instances().into_paginator().send();
    let mut stopped = HashSet::new();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| describe_sdk_error(&e))?;
        for reservation in page.reservations() {
            for instance in reservation.instances() {
                let is_stopped = instance
                    .state()
                    .and_then(|s| s.name())
                    .map(|n| n.as_str() == "stopped")
                    .unwrap_or(false);
                if is_stopped {
                    if let Some(id) = instance.instance_id() {
                        stopped.insert(id.to_string());
                    }
                }
            }
        }
    }
    Ok(stopped)
}
