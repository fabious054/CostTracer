# Development

## Prerequisites

- **Node.js** 20+ and npm (bundled).
- **Rust** stable (`rustup` recommended) — for the Tauri core.
- **Tauri OS prerequisites**: see <https://v2.tauri.app/start/prerequisites/>. On Windows this is
  the WebView2 runtime (present on Windows 11 by default) and the MSVC build tools.
- A Chromium browser for unit tests (Chrome or Edge). Point `CHROME_BIN` at it if it is not
  auto-detected.

Nothing about the running app requires anything pre-installed on an end user's machine — the
prerequisites above are for building only.

## Commands

| Task | Command |
|------|---------|
| Install JS deps | `npm install` |
| Run the app (Angular + Tauri, hot reload) | `npm run tauri:dev` |
| Frontend only, in a browser (no core) | `npm start` → http://localhost:4200 |
| Unit tests (store + reducer) | `npm test` — or headless: `CHROME_BIN="<path>" npx ng test --watch=false --browsers=ChromeHeadless` |
| Production bundle | `npm run tauri:build` |
| Regenerate app icons | `npx tauri icon src-tauri/icons/app-icon-source.png` |

## Layout

```
src/                         Angular webview — no credential or AWS SDK code ever lives here
  app/core/
    ipc/tauri-ipc.service.ts    the only caller of Tauri `invoke`
    models/                     DTOs mirrored from src-tauri/src/model.rs
    connection/
      connection.state.ts       the finite state machine: ConnectionState + ConnectionEvent + reduce()
      connection.store.ts        signal store; drives side effects, feeds outcomes back through reduce()
      *.spec.ts                  reducer negative-path tests + store flow tests
  app/features/
    onboarding/                 one component per step (see docs/scope-1-connection-flow.md)
    account/                    the final "connected" screen
src-tauri/src/
  commands.rs                 one #[tauri::command] per side effect
  session.rs                  in-memory OnboardingSession — holds secrets between commands
  vault.rs                    keyring (OS-native secret store) wrapper
  aws/                        config, identity (validate + probe), permission_audit, sso, local_config
  model.rs                   serde DTOs — source of truth for the frontend types
docs/
  scope-1-connection-flow.md   state & screen structure (read this first)
  adr/0001-angular-state-management.md
  iam-policy-minimal.json      embedded into the binary via include_str!; served by policy_minimal_read
```

## Verification status

- **Frontend**: `ng build` (dev + prod) and all 21 unit tests pass. Prod bundle ≈ 53 kB transfer.
- **Rust core**: `cargo check` clean, no warnings. Resolved SDK versions: `aws-config` 1.11,
  `aws-sdk-{sts 1.113, iam 1.122, ec2 1.251, sso 1.108, ssooidc 1.110}`, `keyring` 3.6, `tauri` 2.11.
- **Not yet run**: `cargo build` / `npm run tauri:dev` (full link + WebView2), and any live call
  against a real AWS account.

## Notes / v1 simplifications

- **Temporary credentials (`ASIA…` / SSO role credentials) expire** (1–12 h). There is no SSO token
  refresh in v1: once the stored credential expires, `session_resume` fails and the user re-onboards.
  For a session that persists indefinitely, use a long-term IAM user key (`AKIA…`) with the minimal
  policy. Refresh is a Scope 2 item.
- The vault blob is **chunked** across sibling keyring entries (`aws-connection`, `aws-connection-1`,
  …) because Windows Credential Manager caps one blob at 2560 bytes and a session token alone can
  exceed that. macOS/Linux are unaffected by the cap but still use the chunked layout.
- SSO account/role listing is single-page (`max_results(100)`); pagination is a later concern.
- The permission-audit fallback flags broad **managed** policies by name
  (`AdministratorAccess`, `PowerUserAccess`, `IAMFullAccess`, `*FullAccess`). Detecting inline
  statements with `"Action": "*"` needs `iam:GetUserPolicy` / `iam:ListUserPolicies`, which are
  deliberately *not* in the minimal policy; `SimulatePrincipalPolicy` (the preferred path) already
  catches wildcard grants behaviourally.
- Change detection is zoneless (`provideZonelessChangeDetection`); there is no `zone.js`. TestBed
  specs that exercise DI/effects must add `provideZonelessChangeDetection()` to the testing module.
- **i18n** is hand-rolled and runtime (`src/app/core/i18n/`): `I18nService.t(key, params?)` reads a
  `locale` signal, so template calls re-evaluate on language change. Strings live in `messages.ts`
  (en + pt). Webview strings only — text returned by the Rust core stays English.
- **Window chrome** is custom: `decorations: false` in `tauri.conf.json` + `TitlebarComponent`
  (drag region, min/max/close, language toggle). Needs the `core:window:*` permissions in
  `capabilities/default.json`.
