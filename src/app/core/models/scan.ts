/**
 * Scope 2 — idle-resource scan DTOs. Mirrored from `src-tauri/src/model.rs`.
 * Dates cross the boundary as unix seconds (number); the webview formats them.
 */

export type ResourceType = 'ebs_volume' | 'elastic_ip' | 'ebs_snapshot';
export type DetectorKind = 'ebs-unattached' | 'elastic-ip-idle' | 'orphan-snapshot';
export type ScanStatus = 'ok' | 'partial';
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
  facts: Record<string, string | number | null>;
}

export interface DetectorResult {
  kind: DetectorKind;
  regionErrors: RegionError[];
  items: ResourceItem[];
}

export interface ScanResult {
  scanId: number;
  startedAt: number;
  finishedAt: number;
  accountId: string;
  regions: string[];
  status: ScanStatus;
  detectors: DetectorResult[];
}

export type ScanRunOutcome =
  | { status: 'ok'; result: ScanResult }
  | { status: 'reauthRequired' };

export interface ResourceRef {
  resourceType: ResourceType;
  resourceId: string;
  region: string;
  note?: string | null;
}
