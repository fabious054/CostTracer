/**
 * Command input/output shapes for the Tauri IPC bridge. One entry per command in
 * `docs/scope-1-connection-flow.md`. Mirrored from `src-tauri/src/model.rs`.
 */

import { AccountInfo, CallerIdentity, SsoTarget } from './aws';

export interface ManualCredentialInput {
  accessKeyId: string;
  secretAccessKey: string;
  /** Required for temporary credentials (Access Key ID starting with `ASIA`). */
  sessionToken: string | null;
}

export interface UseDetectedInput {
  profile: string | null;
}

export interface SsoStartInput {
  startUrl: string;
  region: string;
}

export interface SsoSelectTargetInput {
  accountId: string;
  roleName: string;
}

/** Outcome of any credential validation (`credential_*`, `sso_select_target`). */
export type ValidationOutcome =
  | { status: 'ok'; identity: CallerIdentity }
  | { status: 'invalid'; message: string }
  | { status: 'insufficient'; message: string; probedAction: string };

/** Outcome of `session_resume` on launch. */
export type ResumeOutcome =
  | { status: 'ok'; account: AccountInfo }
  | { status: 'stale' }
  | { status: 'none' };

/** Outcome of a single `sso_poll` tick. */
export type SsoPollOutcome =
  | { state: 'pending' }
  | { state: 'slow_down' }
  | { state: 'expired' }
  | { state: 'authorized'; targets: SsoTarget[] };

/** The command surface exposed by the Rust core. Keys are the exact `invoke` names. */
export interface IpcCommandMap {
  session_resume: { args: undefined; result: ResumeOutcome };
  detect_local_config: { args: undefined; result: import('./aws').DetectedConfig };
  open_url: { args: { url: string }; result: void };
  credential_submit_manual: { args: { input: ManualCredentialInput }; result: ValidationOutcome };
  credential_use_detected: { args: { input: UseDetectedInput }; result: ValidationOutcome };
  credential_revalidate: { args: undefined; result: ValidationOutcome };
  sso_start: { args: { input: SsoStartInput }; result: import('./aws').SsoDeviceAuth };
  sso_poll: { args: undefined; result: SsoPollOutcome };
  sso_select_target: { args: { input: SsoSelectTargetInput }; result: ValidationOutcome };
  permissions_check: { args: undefined; result: import('./aws').PermissionAudit };
  policy_minimal_read: { args: undefined; result: string };
  connection_finalize: { args: undefined; result: AccountInfo };
  connection_disconnect: { args: undefined; result: void };
  /** The account the vault currently holds (no STS call) — used to reconcile a drifted window. */
  connection_account: { args: undefined; result: AccountInfo | null };
  session_discard: { args: undefined; result: void };

  // Scope 2 + 4 — idle-resource scan (progressive, multi-region)
  scan_run: { args: undefined; result: import('./scan').ScanRunOutcome };
  scan_cancel: { args: undefined; result: void };
  scan_latest: { args: undefined; result: import('./scan').ScanResult | null };
  resource_mark_intentional: { args: { input: import('./scan').ResourceRef }; result: void };
  resource_unmark_intentional: { args: { input: import('./scan').ResourceRef }; result: void };

  // DEV-ONLY — debug builds only, gated by isDevMode() in the UI. Removed at Scope 3 closure.
  dev_seed_scan: { args: undefined; result: import('./scan').ScanResult };
}

export type IpcCommand = keyof IpcCommandMap;
