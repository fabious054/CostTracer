/**
 * DTOs mirrored from the Rust core (`src-tauri/src/model.rs`). The Rust side is the source of
 * truth; keep these in sync. All fields are camelCase — the Rust structs use
 * `#[serde(rename_all = "camelCase")]`.
 */

export type CredentialSourceKind = 'detected' | 'manual' | 'sso';

/** Result of `sts:GetCallerIdentity`. */
export interface CallerIdentity {
  accountId: string;
  userId: string;
  arn: string;
}

/** Result of the silent local-config scan (`detect_local_config`). */
export interface DetectedConfig {
  hasEnvCredentials: boolean;
  hasSharedCredentialsFile: boolean;
  hasConfigFile: boolean;
  profiles: string[];
  defaultRegion: string | null;
}

export function hasAnyDetectedConfig(d: DetectedConfig): boolean {
  return d.hasEnvCredentials || d.hasSharedCredentialsFile || d.hasConfigFile;
}

/** A single over-privilege signal surfaced by the permission audit. */
export interface RiskFinding {
  kind: 'simulated-action-allowed' | 'broad-managed-policy' | 'wildcard-action-statement';
  /** The offending action or policy name, e.g. `ec2:TerminateInstances` or `AdministratorAccess`. */
  label: string;
  /** Human-readable explanation shown under the label. */
  detail: string;
}

export type PermissionAuditMethod = 'simulate' | 'list-policies' | 'inconclusive';

export interface PermissionAudit {
  method: PermissionAuditMethod;
  excessive: boolean;
  findings: RiskFinding[];
}

/** Final-screen payload. */
export interface AccountInfo {
  accountId: string;
  arn: string;
  userId: string;
  /** Active / configured regions, de-duplicated. Never empty (falls back to `us-east-1`). */
  regions: string[];
  sourceKind: CredentialSourceKind;
}

/** Device-authorization details for the SSO flow. */
export interface SsoDeviceAuth {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Epoch milliseconds after which the device code is dead. */
  expiresAt: number;
  /** Minimum seconds between `sso_poll` calls, per the OIDC response. */
  intervalSec: number;
}

/** An account+role pair the SSO token can assume. */
export interface SsoTarget {
  accountId: string;
  accountName: string;
  roleName: string;
}
