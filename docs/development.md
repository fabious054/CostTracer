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
| Run against LocalStack (cost UI review) | `npm run tauri:dev:localstack` — see "LocalStack harness" below |
| Production bundle | `npm run tauri:build` |
| Regenerate app icons | `npx tauri icon src-tauri/icons/app-icon-source.png` |

## Layout

```
src/                          Angular webview — no credential or AWS SDK code ever lives here
  app/core/
    ipc/tauri-ipc.service.ts    the only caller of Tauri `invoke`
    models/                     DTOs mirrored from src-tauri/src/model.rs
      aws.ts, aws-regions.ts      connection-side types + the SSO Identity Center region list
      scan.ts                     scan result / resource / confidence types + the scan:// event payloads
      ipc-contracts.ts            the typed command map (args + result per command)
    connection/
      connection.state.ts         the finite state machine: ConnectionState + ConnectionEvent + reduce()
      connection.store.ts         signal store; drives side effects, feeds outcomes back through reduce()
      *.spec.ts                   reducer negative-path tests + store flow tests
    events/
      tauri-events.service.ts     thin wrapper over @tauri-apps/api `listen` (scan:// progress events)
    scan/
      scan.store.ts               signal store: progressive event-driven run, per-account isolation,
                                  region-by-region merge, cancel, load-latest, mark-intentional
    sso/
      saved-urls.ts               locally-remembered Start URLs (localStorage) — see Notes
    format/
      event-time.ts               shared date+time formatter for exact-event timestamps
      cost.ts                      USD formatting + the pt-only approximate-BRL suffix (Scope 3)
    i18n/                         hand-rolled runtime i18n (messages.ts = en + pt, i18n.service.ts)
  app/shared/
    tooltip.directive.ts          [ctTooltip] — themed hover/focus hint box (replaces native title)
  app/features/
    onboarding/                   one component per step (see docs/scope-1-connection-flow.md)
    main/                         the post-connection screen: account bar + scan
      main-view.component.ts        account bar: id, region count + live per-region status tooltip,
                                   the "partial scan" status seal on the header's bottom border
      scan-panel.component.ts       first-run CTA, one fixed status line (progress + cancel),
                                   pre-scan multi-region warning, region panel, stale-credential
                                   banner, the 5 detector sections
      detector-section.component.ts per-detector inventory, count, collapse; region errors folded
                                   by message (errKey) into one block per distinct error
      resource-row.component.ts     one resource; alerts highlighted + mandatory explanation
    shell/
      titlebar.component.ts        custom window chrome + language toggle + app version label
src-tauri/src/
  lib.rs                       Tauri entry point (builder, state, command registration)
  commands.rs                  one #[tauri::command] per side effect (21 commands)
  session.rs                   in-memory OnboardingSession — holds secrets between commands
  vault.rs                     keyring (OS-native secret store) wrapper, with blob chunking
  error.rs, util.rs            shared error type + helpers
  aws/                         config, identity, regions (DescribeRegions discovery), permission_audit, sso, local_config
  detectors/                   idle-resource detectors: ebs, elastic_ip, snapshot, cw_logs,
                               rds_snapshot (+ mod = run_region, which takes &SdkConfig and builds
                               its own per-service clients — ADR 0005 D4)
  scan.rs                      scan orchestrator: discover regions → run detectors region-by-region,
                               emitting + persisting each as it finishes, cancellable mid-run
  store/                       bundled SQLite (rusqlite): migrations + begin_scan / record_region /
                               finish_scan (per-region txn) + build_scan_result + intentional flags
  pricing/                     fixed price table (price-table.toml — ebs / elastic_ip / snapshot /
                               cw_logs / rds_snapshot, embedded) + pure estimate() (ADR 0003 + 0005)
  model.rs                     serde DTOs — source of truth for the frontend types
  tests/localstack.rs          opt-in #[ignore] harness — detector→store→pricing against LocalStack (ADR 0003 D4)
docs/
  scope-1-connection-flow.md   state & screen structure for the connection flow (read this first)
  scope-2-detectors.md         detectors, confidence scale, DB schema, commands, DTOs
  adr/0001-angular-state-management.md   hand-rolled signal store + pure reducer
  adr/0002-local-scan-persistence.md     SQLite engine, retention, streak semantics, kept the hand-rolled store
  adr/0003-resource-cost-estimation.md   price-table format, cost math in the core, USD/BRL, LocalStack
  adr/0004-multi-region-scan.md          discovery, per-region persistence, cancellation, scan:// events
  adr/0005-scope-5-detectors.md          CloudWatch Logs retention + RDS orphan snapshot: type filter,
                                        cost basis, run_region client plumbing
  iam-policy-minimal.json      embedded into the binary via include_str!; served by policy_minimal_read
docker-compose.localstack.yml  opt-in LocalStack container for the harness above (not the app, not CI)
scripts/localstack-seed.sh     seeds the LocalStack fixture the harness expects
```

## Verification status

Scopes 1–5 are closed and tagged (`v0.1.0-scope1` … `v0.5.0-scope5` on `main`) — Phase 0 is
complete, Phase 1 is in progress (Scopes 4 and 5). The app has run live against a real AWS account
throughout; see `cost-tracer/scope-reports/` for the per-scope validation logs.

- **Frontend**: `ng build` (dev + prod) clean; 56 unit tests pass (reducer, incl. the
  `connection/resynced` transition + connection store, incl. progressive multi-region merge,
  per-account isolation and the window↔vault `resync()` + i18n key-parity + `errKey` region-error
  grouping + saved-urls + event-time + cost formatting). Prod bundle ≈ 76 kB estimated transfer.
- **Rust core**: `cargo check` clean; `cargo test` 26/26 (confidence-scale cutoffs; scan-store
  coverage/streak, account scoping incl. `latest_is_scoped_to_the_account` and
  `a_scan_can_only_be_read_back_as_its_own_account`, `begin_scan`/`finish_scan` lifecycle;
  vault chunk round-trip; price-table shape + `estimate()` per resource type — EBS / EIP / EBS
  snapshot / CloudWatch Logs (incl. an empty group priced `$0.00`, not "unavailable") / RDS
  snapshot — plus the unpriced-region path; demo-seed fixture). One further test,
  `tests/localstack.rs`, is `#[ignore]` — the opt-in LocalStack harness (see below). Crate
  families: `aws-config` / `aws-sdk-{sts,iam,ec2,cloudwatchlogs,rds,sso,ssooidc}` v1,
  `aws-credential-types` v1, `keyring` v3, `rusqlite` 0.32 (`bundled`), `toml` 0.8, `tauri` v2,
  `tokio` v1, `tokio-util` 0.7 — exact resolved versions in `Cargo.toml` / `Cargo.lock`.
- **Not covered by automated tests**: real AWS SDK calls (manual validation only); rendering of the
  scan components — the progressive status line, cancel, region panel, stale-credential /
  regions-unknown states, the partial-scan seal and the folded region-error block are checked
  visually. Validated live during Scope 4 against a real multi-region account: a full progressive
  scan, cancellation, cross-account isolation, the missing-`ec2:DescribeRegions` path. Scope 5's
  two detectors were validated live against real accounts (`890247063933`, `770017446846`): the
  CloudWatch Logs detector flagged 2 retention-less groups out of ~283 with the right sizes /
  cost / qualifiers and cross-account isolation held; the RDS-snapshot detector returned 0 orphans
  (a valid no-false-positive result). Against LocalStack (no `logs` / `rds`) the same detectors'
  per-region errors fold into one block and end the scan `partial` — the missing-permission
  shape. The empty-group `$0.00` and unpriced-region paths also have unit tests + a `dev_seed_scan`
  fixture. Still unobserved (a time factor, not coverage): the Observed→Confirmed progression over
  real days.

## Estimated cost — the price table (Scope 3, ADR 0003; extended in Scope 5, ADR 0005)

Prices come from **one fixed file**, `src-tauri/src/pricing/price-table.toml`, embedded in the
binary with `include_str!`. No AWS Price List API call — real-time pricing is backlog (and now the
**next scope**: five hand-maintained tables — `ebs`, `elastic_ip`, `snapshot`, `cw_logs`,
`rds_snapshot` — is where the deferral hits its scale limit). The engine (`pricing::estimate`) is
a pure function of `(resource_type, region, facts)`; the cost figures and the "no price for this
region" counts are computed in the core while the scan result is built (same place as the
confidence level), and shipped in the DTO. The webview only formats them and, when the UI language
is Portuguese, appends the approximate BRL conversion using the fixed `fx_usd_brl` rate.

**Updating a price:**

1. Open the source pages listed at the top of `price-table.toml` (EBS/snapshot: EBS pricing;
   Elastic IP: VPC pricing; CloudWatch Logs storage: CloudWatch pricing; RDS backup storage: RDS
   pricing — read the `[rds_snapshot]` comment about the manual-snapshot vs export-to-S3 rate).
2. Edit the file. Keep every region block complete — all seven EBS types keyed.
3. Bump `captured` in `[meta]`.
4. `cd src-tauri && cargo test pricing::` must stay green (all 9 regions present for each resource
   kind, no price zero or negative).

A region **not** in the file is reported as "price unavailable" and counted separately — never
approximated. `[fx] usd_brl` is a **placeholder**, not a real quote; replace it before any release.

Deliberately imprecise, each with a visible caveat: `io1`/`io2` GiB-only (provisioned IOPS not
captured); EBS snapshots on source volume size (upper bound; real billing is incremental);
CloudWatch Logs storage-only (ingestion excluded) and off `storedBytes` (AWS-reported, lags hours);
RDS snapshots on the source instance's allocated storage (upper bound).

**Known gap (ADR 0005, same treatment as Scope 3):** only the `us-east-1` base rates for
`cw_logs` ($0.03/GB-mo) and `rds_snapshot` ($0.095/GB-mo) are verified against official AWS
content. The other 8 regions are scaled by the `[snapshot]` regional factors as a first cut,
marked `VERIFY` in the TOML — a per-region capture is outstanding, non-blocking.

## LocalStack harness (opt-in)

`tests/localstack.rs` drives the real detector → store → pricing pipeline against
[LocalStack](https://localstack.cloud/) — EC2 data that behaves like AWS, no account, no cost. It
is `#[ignore]` and **not** part of `cargo test` or CI; it needs Docker and a running container.

```
docker compose -f docker-compose.localstack.yml up -d
bash scripts/localstack-seed.sh
( cd src-tauri && AWS_ENDPOINT_URL=http://localhost:4566 \
    cargo test --test localstack -- --ignored --nocapture )
docker compose -f docker-compose.localstack.yml down
```

`AWS_ENDPOINT_URL` is read in `aws/config.rs` and applied to every SDK client; it is unset in
production. The seed script (run via `awslocal` inside the container, so no host AWS CLI is needed)
creates a known fixture: an unattached gp3 volume, an idle Elastic IP and an orphan snapshot in
`sa-east-1` (all priced), plus one volume in `ca-central-1` (a region not in the table, to exercise
the unpriced path). The test targets its seeded resources by `Name` tag — LocalStack/moto's
`DescribeSnapshots` also returns a large canned catalogue of AMI-backing snapshots, so account-total
assertions there are structural, not exact.

### Running the app itself against LocalStack (on-screen review)

The same `AWS_ENDPOINT_URL` override works for the whole running app, not just the test — connect
and scan through the real UI against LocalStack, no account, no cost.

```
npm run tauri:dev:localstack
```

That one command (see `scripts/dev-localstack.mjs`) brings the container up, waits for it, seeds
the fixture, and launches `tauri dev` with `AWS_ENDPOINT_URL` already set. The pieces are also
available on their own: `npm run localstack:up` / `localstack:seed` / `localstack:down`, then
`AWS_ENDPOINT_URL=http://localhost:4566 npm run tauri:dev` (Git Bash) or
`$env:AWS_ENDPOINT_URL = "http://localhost:4566"; npm run tauri:dev` (PowerShell).

Then in the app: **Manual Access Key** → `test` / `test` → connect → run a scan. The
connect → scan → cost UI renders end to end. (There is no region field any more — Scope 4; the
scan discovers regions itself. LocalStack/moto returns all ~34 as "enabled".)

- **The variable is read once, at process start.** It can't be injected into a `tauri:dev` that's
  already running — stop it and relaunch in the same shell with the variable set. If you see
  "invalid credential" or a network error to `amazonaws.com`, it didn't take.
- Fresh LocalStack shows every flagged resource at **Observed** (0 days coverage), so the account
  panel's **primary** figure (Probable + Confirmed) is `$0` — everything lands in the context
  figure. Seeing the primary figure populated needs scan history spread over days.
- LocalStack/moto returns hundreds of canned AMI-backing snapshots, so the "orphan snapshots"
  section is noisy — real AWS with `owner-ids self` would not be. Multi-region multiplies it
  (thousands of rows); expected in the sim, not a bug.
- LocalStack Community has **no `logs` and no `rds`**, so the CloudWatch Logs and RDS-snapshot
  detectors error in every region there. Those errors fold into one collapsible block per detector
  and the scan ends `partial` (seal on the header). Same shape a real account would show for a
  missing IAM permission.
- The permission audit degrades to "inconclusive" (LocalStack Community here runs only `ec2` +
  `sts`, no IAM). The connection still completes.

### "seed demo" — permanent dev tool

`dev_seed_scan` / the **"seed demo"** button writes a ~30-resource fixture (every confidence
level, both scales, io1/io2, priced + unpriced regions, intentional + neutral rows) straight into
the store so the cost/inventory UI can be reviewed without a real AWS account and without spending
money. Double-gated: `#[cfg(debug_assertions)]` in the core, `isDevMode()` on the button — it is
**never in a production build**. Every touch point carries a `DEV-ONLY` marker
(`grep -rn "DEV-ONLY" src src-tauri/src`).

Per the CLAUDE.md scope-closure checklist (item 2), this one is **kept permanently** — it stays
useful for validating any future scope visually. Only genuinely temporary, single-use dev
affordances (e.g. a `dev_force_reauth`) get removed at closure. Touch points:
`src-tauri/src/store/demo_seed.rs`, plus the marked lines in `store/mod.rs`, `commands.rs`,
`lib.rs`, `core/models/ipc-contracts.ts`, `core/scan/scan.store.ts`,
`features/main/scan-panel.component.ts`, and the `demo_seed_produces_a_populated_cost_result` test.

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
- The vault is **one store shared across windows / app runs**; each window keeps its own
  `connection.state()` in memory. `AppComponent` runs `ConnectionStore.resync()` on `window:focus`
  (and `scan-panel` before a scan) — it re-reads the vault via `connection_account` (no STS call)
  and swaps the window's account in place (`connection/resynced`) or drops to onboarding if the
  vault was cleared, so a drifted window can't show or scan for the wrong account.

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
- `scan_run` is progressive (Scope 4): the core discovers the enabled regions, then runs and
  persists them one at a time, emitting `scan://started` → `scan://region` (per region) →
  `scan://done` on the Tauri event bus. The frontend merges each region in as it lands and can
  cancel mid-run via `scan_cancel` — finished regions stay saved, the in-flight one is discarded,
  not-started ones never run. Per-region status is live-only; it is not rebuilt from a stored
  scan on reload (backlog — see the Scope 4 report).
- Dates cross the IPC as **unix seconds** (`i64` / `number`); the webview formats them
  (locale-aware, machine-local timezone).
- **Five detectors** as of Scope 5 (ADR 0005): + CloudWatch Logs groups with no `retentionInDays`
  (standard confidence scale, cost off `storedBytes`) and orphan **manual** RDS snapshots (snapshot
  scale, cost off allocated storage). Automated RDS snapshots and Aurora DB-cluster snapshots are
  out of scope (follow-up). `detector-section` folds a detector's `regionErrors` by message so a
  systemic failure (a service off, a permission missing account-wide) is one collapsible block,
  not N identical alert boxes; a finished `partial` scan shows a status seal on the account
  header's bottom border.

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
