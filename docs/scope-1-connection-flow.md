# Scope 1 — AWS connection flow (state & screen structure)

This document is the source of truth for the onboarding state machine. The Angular
`ConnectionStore` (ADR 0001, Option A) implements exactly these states, events and transitions;
the Rust core exposes one command per side effect. Components never branch on anything other than
`state.step`.

## States

| `step` | Screen | Holds | Purpose |
|--------|--------|-------|---------|
| `booting` | full-screen spinner | — | On launch: load vault, silently revalidate a stored credential. |
| `detecting` | full-screen spinner | — | Silent scan of `~/.aws/credentials`, `~/.aws/config`, `AWS_*` env vars. |
| `methodSelect` | method picker | `detected: DetectedConfig \| null`, `notice: string \| null` | 1–3 cards. The "detected" card renders only when `detected != null`. No card is marked "recommended". |
| `manualEntry` | form | — | Access Key ID, Secret Access Key, optional default region. |
| `ssoStart` | form | `notice: string \| null` | IAM Identity Center Start URL + region. |
| `ssoDeviceAuth` | code + link | `auth: SsoDeviceAuth` | Shows `userCode` + `verificationUriComplete`; store polls for the token. |
| `ssoSelectTarget` | list | `targets: SsoTarget[]` | Account + role picker. Auto-skipped when exactly one target is returned. |
| `validating` | spinner | `sourceKind` | `sts:GetCallerIdentity` **and** a minimum-permission probe (`ec2:DescribeVolumes`, `MaxResults=5`). |
| `validationFailed` | error, same screen | `sourceKind`, `kind`, `message` | Stays here. `kind` is `invalid-or-expired` or `insufficient-permission`, each with its own copy. Actions: **Try again** / **Switch method**. |
| `checkingPermissions` | spinner | `identity` | `iam:SimulatePrincipalPolicy` on destructive actions; fallback `iam:ListAttachedUserPolicies`. |
| `excessivePermissions` | alert | `identity`, `audit: PermissionAudit`, `recommendedPolicy: string` | Lists risky findings + minimal-policy JSON block with a **Copy** button. Actions: **Continue at my own risk** / **Go back and switch credential**. |
| `persisting` | spinner | `identity` | Write the validated credential to the OS vault. |
| `connected` | account info | `account: AccountInfo` | Final screen: Account ID + active/configured region(s). Action: **Disconnect** (clears the vault). |

Why the extra probe in `validating`: `sts:GetCallerIdentity` succeeds for *any* valid signature, so
it alone cannot tell "valid but under-permissioned" apart from "valid and usable". One cheap
read that is inside the minimal policy separates the two reliably.

Why `ssoSelectTarget` (not in the original acceptance criteria): IAM Identity Center returns
credentials per *account + role*, not per user. When the token maps to exactly one account with one
role, the store selects it automatically and this screen never shows. It only appears when the
choice is genuinely ambiguous. Multi-account remains out of scope (Phase 3) — this is just target
resolution for a single connection.

## Transitions

```
booting ──resumed────────────────► connected
        ──no-session / stale────► detecting        (stale carries a notice into methodSelect)

detecting ──done────────────────► methodSelect

methodSelect ──choose-detected──► validating(detected)
             ──choose-manual────► manualEntry
             ──choose-sso───────► ssoStart

manualEntry ──submit────────────► validating(manual)

ssoStart ──submit───────────────► ssoDeviceAuth
ssoDeviceAuth ──authorized──────► ssoSelectTarget   (or straight to validating if 1 target)
             ──expired / error──► ssoStart(notice)
ssoSelectTarget ──submit────────► validating(sso)

validating ──ok─────────────────► checkingPermissions
           ──invalid-or-expired─► validationFailed
           ──insufficient───────► validationFailed

validationFailed ──retry────────► validating(same source)   ← never falls back to methodSelect
                 ──switch-method► methodSelect

checkingPermissions ──clean─────► persisting
                    ──excessive─► excessivePermissions
                    ──inconclusive► persisting            (cannot prove excess → proceed)

excessivePermissions ──accept───► persisting
                     ──switch───► methodSelect

persisting ──done───────────────► connected

connected ──disconnect──────────► detecting
```

Any unexpected `error` event routes to `validationFailed` when a credential source is in play,
otherwise `methodSelect` with a notice. Illegal `(state, event)` pairs are no-ops (dev build logs a
warning) — see `connection.state.ts` reducer and its spec.

## Rust commands (one per side effect)

| Command | Input | Output |
|---------|-------|--------|
| `session_resume` | — | `{ status: 'ok', account } \| { status: 'stale' } \| { status: 'none' }` |
| `detect_local_config` | — | `DetectedConfig` |
| `credential_submit_manual` | `{ accessKeyId, secretAccessKey, region? }` | `ValidationOutcome` |
| `credential_use_detected` | `{ profile?, region? }` | `ValidationOutcome` |
| `credential_revalidate` | — | `ValidationOutcome` (re-runs on the credential held in the session) |
| `sso_start` | `{ startUrl, region }` | `SsoDeviceAuth` |
| `sso_poll` | — | `{ state: 'pending' \| 'slow_down' \| 'expired' } \| { state: 'authorized', targets: SsoTarget[] }` |
| `sso_select_target` | `{ accountId, roleName }` | `ValidationOutcome` |
| `permissions_check` | — | `PermissionAudit` |
| `policy_minimal_read` | — | `string` (the embedded `docs/iam-policy-minimal.json`) |
| `connection_finalize` | — | `AccountInfo` (persists the session credential to the vault) |
| `connection_disconnect` | — | `void` (deletes the vault entry) |
| `session_discard` | — | `void` (drops the in-memory pending credential) |

`ValidationOutcome = { status: 'ok', identity: CallerIdentity } | { status: 'invalid', message } |
{ status: 'insufficient', message, probedAction }`.

The webview never receives a secret: raw keys and SSO tokens live only in the Rust process
(`OnboardingSession`, an in-memory `Mutex`) until `connection_finalize` moves them into the OS vault.
