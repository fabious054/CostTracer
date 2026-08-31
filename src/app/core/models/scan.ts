/**
 * Scope 2 — idle-resource scan DTOs. Mirrored from `src-tauri/src/model.rs`.
 * Dates cross the boundary as unix seconds (number); the webview formats them.
 */

export type ResourceType =
  | 'ebs_volume'
  | 'elastic_ip'
  | 'ebs_snapshot'
  | 'cloudwatch_log_group'
  | 'rds_snapshot';
export type DetectorKind =
  | 'ebs-unattached'
  | 'elastic-ip-idle'
  | 'orphan-snapshot'
  | 'log-group-no-retention'
  | 'orphan-rds-snapshot';
export type ScanStatus = 'running' | 'ok' | 'partial' | 'cancelled';
export type ResourceState = 'alert' | 'neutral';
export type ConfidenceLevel = 'observed' | 'persisting' | 'probable' | 'confirmed';
export type ConfidenceScale = 'standard' | 'snapshot';

export interface ConfidenceInfo {
  level: ConfidenceLevel;
  daysCoverage: number;
  scale: ConfidenceScale;
}

export interface RegionError {
  region: string;
  message: string;
}

// --- Scope 3 — estimated cost (ADR 0003). Core produces USD; the webview does the BRL display. ---

export type CostBasis =
  | 'ebs-gib'
  | 'eip-flat'
  | 'snapshot-gib'
  | 'logs-gb-month'
  | 'rds-snapshot-gb';
export type CostQualifier =
  | 'ebs-iops-not-included'
  | 'snapshot-full-volume-size'
  | 'ebs-type-assumed'
  | 'logs-storage-only'
  | 'logs-size-reported'
  | 'rds-snapshot-allocated-size';
export type CostUnavailable = 'region' | 'missing-fact';

export interface EstimatedCost {
  /** USD per month. `null` exactly when `unavailable` is set. */
  monthlyUsd: number | null;
  basis: CostBasis;
  qualifiers: CostQualifier[];
  unavailable: CostUnavailable | null;
}

/** Per-detector total — over alerting, non-intentional resources only. */
export interface DetectorCostRollup {
  monthlyUsd: number;
  pricedCount: number;
  unpricedCount: number;
}

/** Account total — Probable+Confirmed (primary) and Observed+Persisting (context). */
export interface AccountCostRollup {
  primaryMonthlyUsd: number;
  contextMonthlyUsd: number;
  unpricedCount: number;
}

export interface ResourceItem {
  resourceType: ResourceType;
  resourceId: string;
  region: string;
  displayName: string | null;
  state: ResourceState;
  /** Stable code — the webview maps it to a translated note. */
  neutralNote: string | null;
  intentional: boolean;
  /** AWS CreateTime / StartTime, unix seconds. `null` for Elastic IP. */
  createdAt: number | null;
  /** First scan that ever saw this resource, unix seconds — the age anchor for Elastic IP. */
  monitoredSince: number;
  /** Present only for alerting, non-intentional resources. */
  confidence: ConfidenceInfo | null;
  /** Present exactly when `confidence` is — same "alerting, non-intentional" gate. */
  estimatedCost: EstimatedCost | null;
  facts: Record<string, string | number | null>;
}

export interface DetectorResult {
  kind: DetectorKind;
  regionErrors: RegionError[];
  items: ResourceItem[];
  costRollup: DetectorCostRollup;
}

export interface ScanResult {
  scanId: number;
  startedAt: number;
  finishedAt: number;
  accountId: string;
  regions: string[];
  status: ScanStatus;
  detectors: DetectorResult[];
  costRollup: AccountCostRollup;
  /** Fixed USD→BRL rate from the price table (placeholder value; UI labels it approximate). */
  fxUsdBrl: number;
}

export type ScanRunOutcome =
  | { status: 'ok'; result: ScanResult }
  | { status: 'cancelled'; result: ScanResult }
  | { status: 'reauthRequired' };

// --- Scope 4 — progressive multi-region scan events (mirrors model.rs, ADR 0004 D6) ---

/** `scan://started` — fired once, before any region runs. */
export interface ScanStartedEvent {
  scanId: number;
  regions: string[];
}

/** `scan://region` — fired as each region finishes; `result` is the full accumulating scan. */
export interface ScanRegionEvent {
  scanId: number;
  region: string;
  regionStatus: 'ok' | 'partial';
  result: ScanResult;
}

/** `scan://done` — terminal. */
export interface ScanDoneEvent {
  scanId: number;
  status: ScanStatus;
}

/** Per-region UI state during a progressive scan. */
export type RegionScanState = 'running' | 'done' | 'partial' | 'skipped';

export interface ResourceRef {
  resourceType: ResourceType;
  resourceId: string;
  region: string;
  note?: string | null;
}
