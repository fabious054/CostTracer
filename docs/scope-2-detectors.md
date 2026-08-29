# Scope 2 — idle-resource detectors

On-demand scan. After connecting (Scope 1), the user runs a scan that inventories the account,
classifies every resource of each detected type, and gives each alerting resource a confidence
level that grows with observed time. Read-only against AWS; the temporal signal lives only in
the local store (ADR 0002).

## Detectors

| Detector | `resource_type` | Alert state (raw) | Neutral state | Age datum | Confidence scale |
|---|---|---|---|---|---|
| Unattached EBS | `ebs_volume` | `State = available` | `in-use` | `CreateTime` | standard |
| Idle Elastic IP | `elastic_ip` | no `AssociationId` | associated (incl. to a *stopped* instance — noted, not alerted) | — (AWS gives none) | standard |
| Orphan snapshot | `ebs_snapshot` | source `VolumeId` no longer in `DescribeVolumes` | source volume exists, or source can't be determined | `StartTime` | snapshot |

Per region the scan calls `DescribeVolumes` (feeds the EBS detector **and** the snapshot's
existing-volume set), `DescribeAddresses` + `DescribeInstances` (Elastic IP, the latter only for
the stopped-instance note), and `DescribeSnapshots(OwnerIds=["self"])`. All paginated. No
threshold of initial tolerance — a resource in the alert state enters the scale on first
detection. The deferred Load Balancer detector is out of scope.

## Confidence scale

Level from **days of coverage** = span between the first and most recent *consecutive* alert
observations (lenient streak — only a non-alert observation resets it; a missing scan does not).
Computed on read as a pure function of `(days, scale)` — see `ConfidenceLevel::from_days`.

| Level | standard (EBS / EIP) | snapshot |
|---|---|---|
| Observed | 0–1 | 0–6 |
| Persisting | 2–4 | 7–18 |
| Probable | 5–6 | 19–29 |
| Confirmed | ≥ 7 | ≥ 30 |

## "Mark as intentional"

A per-resource local flag (`resource_exception` table). Never a tag or any write to AWS. An
intentional resource stays in the inventory, shown as "Ignored — marked as intentional" with no
level. Reversible.

## SQLite schema (v1 — `app_local_data_dir()/costtracer.sqlite3`)

- `scan(id, started_at, finished_at, account_id, regions_json, status)` — `status` ∈ `ok|partial`.
- `scan_region_error(scan_id, region, detector, message)` — partial-failure transparency.
- `observation(id, scan_id, observed_at, account_id, region, resource_type, resource_id,
  in_alert, created_at, facts_json, display_name, neutral_note)` — **append-only, source of
  truth.** `UNIQUE(scan_id, account_id, region, resource_type, resource_id)`.
- `resource(account_id, region, resource_type, resource_id, first_seen_at, last_seen_at,
  first_alert_at, last_alert_at)` — derived streak cache, rebuildable from `observation`.
  An alert observation extends/starts the streak; a non-alert observation nulls
  `first_alert_at` / `last_alert_at`.
- `resource_exception(account_id, region, resource_type, resource_id, marked_at, note)`.

## Tauri commands

| Command | In → Out |
|---|---|
| `scan_run` | — → `{status:'ok', result: ScanResult} \| {status:'reauthRequired'}` — loads the vaulted credential, validates it (fail fast → `reauthRequired`), runs the 3 detectors over `AccountInfo.regions`, persists, returns the full inventory. |
| `scan_latest` | — → `ScanResult \| null` — the most recent stored scan (reopening the app shows it). |
| `resource_mark_intentional` | `{ input: ResourceRef }` → void |
| `resource_unmark_intentional` | `{ input: ResourceRef }` → void |

`ResourceRef = { resourceType, resourceId, region, note? }`. `account_id` is read from the vault
by the command, not passed by the webview.

## DTOs (unix-seconds dates; the webview formats them)

```
ScanResult   { scanId, startedAt, finishedAt, accountId, regions[], status, detectors: DetectorResult[] }
DetectorResult { kind: 'ebs-unattached'|'elastic-ip-idle'|'orphan-snapshot', regionErrors: {region,message}[], items: ResourceItem[] }
ResourceItem {
  resourceType, resourceId, region, displayName?,
  state: 'alert'|'neutral', neutralNote?, intentional,
  createdAt: number|null,          // AWS date; null for Elastic IP
  monitoredSince: number,          // first scan that saw it — the EIP age anchor
  confidence: { level, daysCoverage, scale } | null,   // only for alerting, non-intentional
  facts: object                    // sizeGiB, az, type, publicIp, sourceVolumeId, description…
}
```

## UI (webview)

The `connected` step renders `MainViewComponent` (account bar + `ScanPanelComponent`) instead of
the onboarding wizard shell. Pattern per detector: **full inventory, selective highlight**.

- Every resource of the type is listed. Neutral rows are discreet; alerting rows are highlighted.
- **Every alert carries the explanation sentence** (transparency principle, `messages.ts`
  `scan.explain.*`), composed in the webview from `confidence` + dates + kind so it is
  translatable. The level badge supports the sentence, never replaces it.
- `regionErrors` are shown inline so incomplete coverage is visible.
- "Mark as intentional" is offered only on **alerting** rows (the action only removes a resource
  from the confidence scale — it does nothing on a neutral one) plus "Undo" on an already-marked
  one.

Rust-originated strings still in English (AWS error text in `regionErrors`, `neutralNote` is a
code the webview translates). Same i18n debt as Scope 1.
