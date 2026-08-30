# Development

## Prerequisites

- **Node.js** 20+ and npm (bundled).
- **Rust** stable (`rustup` recommended) — for the Tauri core.
- **Tauri OS prerequisites**: see <https://v2.tauri.app/start/prerequisites/>. On Windows this is
  the WebView2 runtime (present on Windows 11 by default) and the MSVC build tools.
- A Chromium browser for unit tests (Chrome or Edge). Point `CHROME_BIN` at it if it is not
  auto-detected — e.g. `CHROME_BIN="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"`.

Nothing about the running app requires anything pre-installed on an end user's machine — the
prerequisites above are for building only.

## Commands

| Task | Command |
|------|---------|
| Install JS deps | `npm install` |
| Run the app (Angular + Tauri, hot reload) | `npm run tauri:dev` |
| Frontend only, in a browser (no core) | `npm start` → http://localhost:4200 |
| Frontend unit tests | `npm test` — or headless: `CHROME_BIN="<path>" npx ng test --watch=false --browsers=ChromeHeadless` |
| Rust core check + tests | `cd src-tauri && cargo check && cargo test` |
| Production bundle | `npm run tauri:build` |
| Regenerate app icons | `npx tauri icon src-tauri/icons/app-icon-source.png` |

## Layout

```
src/                          Angular webview — no credential or AWS SDK code ever lives here
  app/core/
    ipc/tauri-ipc.service.ts    the only caller of Tauri `invoke`
    models/                     DTOs mirrored from src-tauri/src/model.rs
      aws.ts, aws-regions.ts      connection-side types + the region picker list
      scan.ts                     scan result / resource / confidence-level types
      ipc-contracts.ts            the typed command map (args + result per command)
    connection/
      connection.state.ts         the finite state machine: ConnectionState + ConnectionEvent + reduce()
      connection.store.ts         signal store; drives side effects, feeds outcomes back through reduce()
      *.spec.ts                   reducer negative-path tests + store flow tests
    scan/
      scan.store.ts               signal store for run / load-latest / mark-intentional
    sso/
      saved-urls.ts               locally-remembered Start URLs (localStorage) — see Notes
    format/
      event-time.ts               shared date+time formatter for exact-event timestamps
    i18n/                         hand-rolled runtime i18n (messages.ts = en + pt, i18n.service.ts)
  app/features/
    onboarding/                   one component per step (see docs/scope-1-connection-flow.md)
    main/                         the post-connection screen: account bar + scan
      main-view.component.ts        replaces the Scope 1 "connected" account card
      scan-panel.component.ts       first-run CTA, scan meta + rescan, the 3 detector sections
      detector-section.component.ts full per-detector inventory, count, region errors, collapse
      resource-row.component.ts     one resource; alerts highlighted + mandatory explanation
    shell/
      titlebar.component.ts        custom window chrome + language toggle + app version label
src-tauri/src/
  lib.rs                       Tauri entry point (builder, state, command registration)
  commands.rs                  one #[tauri::command] per side effect (18 commands)
  session.rs                   in-memory OnboardingSession — holds secrets between commands
  vault.rs                     keyring (OS-native secret store) wrapper, with blob chunking
  error.rs, util.rs            shared error type + helpers
  aws/                         config, identity (validate + probe), permission_audit, sso, local_config
  detectors/                   idle-resource detectors: ebs, elastic_ip, snapshot (+ mod = run_region)
  scan.rs                      scan orchestrator: load credential → validate → run detectors per region → persist
  store/                       bundled SQLite (rusqlite): migrations + record_scan / build_scan_result / intentional flags
  model.rs                     serde DTOs — source of truth for the frontend types
docs/
  scope-1-connection-flow.md   state & screen structure for the connection flow (read this first)
  scope-2-detectors.md         detectors, confidence scale, DB schema, commands, DTOs
  adr/0001-angular-state-management.md   hand-rolled signal store + pure reducer
  adr/0002-local-scan-persistence.md     SQLite engine, retention, streak semantics, kept the hand-rolled store
  iam-policy-minimal.json      embedded into the binary via include_str!; served by policy_minimal_read
```

## Verification status

Scopes 1 and 2 are closed and tagged (`v0.1.0-scope1`, `v0.2.0-scope2` on `main`). The app has run
live against a real AWS account throughout both scopes; see `cost-tracer/scope-reports/` for the
per-scope validation logs.

- **Frontend**: `ng build` (dev + prod) clean; 39 unit tests pass (reducer + connection store +
  scan store + i18n key-parity + saved-urls + event-time). Prod bundle ≈ 67 kB estimated transfer.
- **Rust core**: `cargo check` clean, no warnings; `cargo test` 11/11 (confidence-scale cutoffs,
  scan-store coverage/streak/scoping, vault chunk round-trip). Crate families: `aws-config` /
  `aws-sdk-{sts,iam,ec2,sso,ssooidc}` v1, `aws-credential-types` v1, `keyring` v3, `rusqlite` 0.32
  (`bundled`), `tauri` v2, `tokio` v1 — exact resolved versions in `Cargo.toml` / `Cargo.lock`.
- **Not covered by automated tests**: real AWS SDK calls (manual validation only); rendering of the
  scan components (checked visually). The alert-path scan UI and the reauth-required flow were
  validated during Scope 2 via temporary `#[cfg(debug_assertions)]` dev affordances that were
  removed before the scope closed — a real scan that finds an idle resource, and the
  Observed→Confirmed progression over real days, remain unobserved (the owner won't create billable
  AWS resources just to test).

## Notes / v1 simplifications

### Connection (Scope 1)

- **Temporary credentials (`ASIA…` / SSO role credentials) expire** (1–12 h). **SSO token refresh is
  not implemented** — once the stored credential expires, `session_resume` fails and the user
  re-onboards. This was *not* addressed in Scope 2; it stays on the backlog as documented technical
  debt in the scope reports. For a session that persists indefinitely, use a long-term IAM user key
  (`AKIA…`) with the minimal policy.
- The vault blob is **chunked** across sibling keyring entries (`aws-connection`, `aws-connection-1`,
  …) because Windows Credential Manager caps one blob at 2560 bytes and a session token alone can
  exceed that. macOS/Linux are unaffected by the cap but still use the chunked layout.
- SSO account/role listing is single-page (`max_results(100)`); pagination is a later concern.
- The permission-audit fallback flags broad **managed** policies by name
  (`AdministratorAccess`, `PowerUserAccess`, `IAMFullAccess`, `*FullAccess`). Detecting inline
  statements with `"Action": "*"` needs `iam:GetUserPolicy` / `iam:ListUserPolicies`, which are
  deliberately *not* in the minimal policy; `SimulatePrincipalPolicy` (the preferred path) already
  catches wildcard grants behaviourally.

### Scan & history (Scope 2)

- The scan history is **bundled SQLite** at `app_local_data_dir()/costtracer.sqlite3` (`rusqlite`,
  feature `bundled` — no system libsqlite needed). ADR 0002 has the reasoning.
- The `observation` table is **append-only and the source of truth**; `resource` is a cache. The
  confidence level is **computed on read** from day-coverage, so changing the scale is retroactive.
- Coverage is elapsed time between the first and last alerting observation, not a scan count. A
  neutral observation resets the streak; a missing scan does not.
- **No retention / prune** of `observation` yet — it grows unbounded (trivial at current volume).
  `resource` rows for resources that have disappeared (e.g. a deleted volume) are never cleaned
  either; no functional impact, just accumulation.
- **"Mark as intentional" is a local flag** (`resource_exception` table). It only appears on
  alerting rows and never writes anything to AWS.
- `scan_run` is a single call with no progress events — accounts with many regions show only a
  spinner until it finishes.
- Dates cross the IPC as **unix seconds** (`i64` / `number`); the webview formats them
  (locale-aware, machine-local timezone).

### UI / platform

- Change detection is zoneless (`provideZonelessChangeDetection`); there is no `zone.js`. TestBed
  specs that exercise DI/effects must add `provideZonelessChangeDetection()` to the testing module.
- **i18n** is hand-rolled and runtime (`src/app/core/i18n/`): `I18nService.t(key, params?)` reads a
  `locale` signal, so template calls re-evaluate on language change. Strings live in `messages.ts`
  (en + pt) and `i18n.service.spec.ts` enforces key parity. Webview strings only — text returned by
  the Rust core (AWS errors, region errors) stays English.
- **Window chrome** is custom: `decorations: false` in `tauri.conf.json` + `TitlebarComponent`
  (drag region, min/max/close, language toggle, app version label). Needs the `core:window:*` and
  `core:app:allow-version` permissions in `capabilities/default.json`. The version label is read at
  runtime via `getVersion()` — it is never hardcoded, so it always matches `tauri.conf.json`.
- Saved SSO **Start URLs** are a purely local convenience: `localStorage` key `ct.sso.startUrls`
  (same class of thing as the persisted locale and collapsed-panel state), with a pin-to-top
  favourite. A Start URL is a public portal address, not a secret; nothing here touches AWS.
