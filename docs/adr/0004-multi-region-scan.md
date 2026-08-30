# ADR 0004 — Real multi-region scanning

- **Status:** Accepted — 2026-08-30
- **Date:** 2026-08-30
- **Scope affected:** Scope 4 (multi-region coverage) — first scope of Phase 1

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scan cancellation mechanism | **A — CancellationToken (tokio-util), raced per region** |
| 2 | Store API + scan lifecycle | **A — begin_scan / record_region / finish_scan** |
| 3 | scan status values + latest_scan_result | **A — ok / partial / cancelled / running; latest ignores running** |
| 4 | Replacement for StoredCredential.regions | **A — discover + store enabled regions at connection_finalize** |
| 5 | Pre-scan warning timing | **A — once per connected session, when regions > 1** |

Also settled here without options (single reasonable path): `ec2:DescribeRegions` with the
default filter (enabled / opt-in regions only), added to `docs/iam-policy-minimal.json`; the
Tauri event contract (D6 in Consequences); discovery failure = the scan fails with a specific
message, never a silent single-region fallback (D7 in Consequences).

---

## Context (shared)

Today a scan hits exactly one region — `resolve_region` falls through the connection-form field →
`AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`, and `scan.rs` loops over `stored.regions`
(almost always a 1-element list). A resource in any other region is never queried.

Scope 4 makes the scan cover **every enabled region** of the account, discovered at run time via
`ec2:DescribeRegions`, streamed to the UI region-by-region as each finishes, and cancellable.

What is already in place and does **not** change:

- **Persistence is region-keyed.** `observation` / `resource` are keyed by
  `(account_id, region, resource_type, resource_id)`; `scan.regions_json` records coverage;
  `scan_region_error` + `ScanStatus::Partial` already model per-region failure.
- **The streak rule already handles partial coverage.** ADR 0002 D3: only a *non-alert*
  observation resets a resource's streak; a resource absent from a scan is left untouched. So a
  cancelled scan that covered 3 of 17 regions leaves the other 14 regions' resources exactly as
  they were — no rollback needed, by construction.

Hard constraints (CLAUDE.md): read-only in every region; nothing written to AWS; the webview
stays a formatter; nothing new pre-installed.

Fixed by the product doc: no manual region selection in this version (backlog); discovery is
automatic and total; the pre-scan warning states the region *count*, an explicit read-only
reassurance beside it, and a longer-run-time expectation — and must not imply resources were
already found ("detectamos" and equivalents are banned).

---

## Decision 1 — Scan cancellation mechanism

### What's at stake

The scan is now a long loop over N regions. "Cancel" must: keep every region already persisted,
never persist the region in flight, not start the remaining regions. How responsive the cancel is
(does it wait for the current region's AWS calls to finish?) and whether a new dependency is
needed follow from the choice.

### Options

**A — `CancellationToken` (`tokio-util`), raced per region.** A fresh
`tokio_util::sync::CancellationToken` per scan, held in Tauri managed state. The region loop does
`tokio::select! { _ = token.cancelled() => break, r = run_region(&ec2) => persist(r) }`. A
`scan_cancel` command calls `token.cancel()`. Cancel is **immediate** — a slow region in flight is
dropped mid-call, its result discarded (never persisted). New dep: `tokio-util` (small, same
ecosystem as `tokio` which is already in).

**B — `Arc<AtomicBool>`, checked between regions.** Zero new dependency. The loop checks the flag
before starting each region; `scan_cancel` sets it. Cancel **waits** for the current region's
detectors to finish (can be several seconds on a slow region) before stopping. That region *is*
then persisted (it completed) — or we check again after it and discard it; discarding a completed
region is a wrinkle.

**C — Task abort.** `scan_run` spawns the work as a `tokio::task`; its `AbortHandle` lives in
state; `scan_cancel` aborts. Immediate, zero dep. But abort fires at an arbitrary `.await`, so
reasoning about "what state are we in" is fuzzier; the per-region-transaction invariant still
saves us (an aborted region never reached its write), but it's the least explicit option.

### Comparison

| | A — CancellationToken | B — AtomicBool | C — abort |
|---|---|---|---|
| Cancel latency | immediate | up to one region | immediate |
| New dependency | `tokio-util` | none | none |
| In-flight region on cancel | cleanly dropped | completes (wrinkle) | dropped (implicit) |
| Explicitness | high (`select!`) | high | low |

### Recommendation

**A.** Immediate cancel is the point of the feature (multi-region scans are the slow case). The
`select!` makes "cancelled ⇒ stop now, don't persist this one" obvious in the code, and
`tokio-util` is a negligible, well-trusted addition.

### Decision: A

---

## Decision 2 — Store API + scan lifecycle for per-region persistence

### What's at stake

`Db::record_scan` today writes everything — the `scan` row, all observations, all resource
upserts, all region errors — in one transaction. Per-region atomic persistence needs that split
up, and the scan row now outlives a single call.

### Options

**A — Three calls: `begin_scan` / `record_region` / `finish_scan`.**
- `begin_scan(account_id, regions: &[String]) -> scan_id` — inserts the `scan` row (status
  `running`), returns the id.
- `record_region(scan_id, region, findings, region_errors)` — one transaction per region:
  that region's `observation` rows + `resource` streak upserts + `scan_region_error` rows.
- `finish_scan(scan_id, status)` — sets the final `scan.status`.
`build_scan_result` / `latest_scan_result` are unchanged (they read whatever is persisted).
Existing `record_scan` tests are rewritten against the new calls.

**B — Keep `record_scan`, call it once per region with an "append" flag.** Less code churn, but
`record_scan` already assumes it owns the whole scan (creates the row); making it
create-or-append muddies it, and the "which call sets the final status" question doesn't go away.

### Recommendation

**A.** The three-call shape maps exactly to the lifecycle (start → N region writes → finish) and
keeps each function single-purpose. It's the natural home for the cancellation semantics too
(`finish_scan(scan_id, Cancelled)`).

### Decision: A

---

## Decision 3 — `scan` status values + what `latest_scan_result` returns

### What's at stake

A scan can now end `ok` (all regions fine), `partial` (some regions errored), or `cancelled`
(user stopped it — some regions simply not attempted). And a scan row can briefly be `running`,
or be left `running` forever if the app is killed mid-scan.

### Options

**A — Statuses `ok` | `partial` | `cancelled` | `running`; `latest_scan_result` returns the newest
scan that is _not_ `running`.** A crashed-mid-scan `running` row is skipped by "latest" (its
observations still count toward streaks — "missing scan doesn't reset"). `cancelled` is a
first-class result the UI can label ("stopped — 4 of 17 regions checked"); `regions_json` already
records what was attempted, and the persisted detectors say what completed.

**B — No `cancelled`; a stopped scan is just `partial`.** Fewer states, but the UI can't tell
"you cancelled this" from "3 regions failed", which are different messages to the user.

**C — No `running`; the row is created only when the first region is ready to write.** Avoids
orphan `running` rows, but then `begin_scan` can't return an id up front for the events, and a
scan cancelled before any region finishes leaves no trace at all (arguably fine, but the UI got a
`scan://started` for a scanId that never lands in the DB).

### Recommendation

**A.** `cancelled` carries real meaning for the user; `running` + the "latest ignores running"
rule is a one-line guard that makes crash recovery sane.

### Decision: A

---

## Decision 4 — What replaces `StoredCredential.regions` after the field is removed

### What's at stake

The connection form's region field is going away. `StoredCredential.regions` and
`AccountInfo.regions` still exist and the account bar renders `regions.join(' · ')`. The scan will
discover regions fresh each run, so what — if anything — do we store and show between scans?

### Options

**A — Discover once at `connection_finalize` and store the enabled regions.** One extra
`ec2:DescribeRegions` call during onboarding; `StoredCredential.regions` holds the real enabled
list; the account bar is informative the moment you connect. The scan still re-discovers at run
time as the source of truth (the stored list can go stale if the account opts into a new region).

**B — Stop storing regions; `AccountInfo.regions` becomes `[]` / removed.** The account bar shows
region info only after the first scan (from `ScanResult.regions`). Less code, one fewer call, but
a freshly-connected account shows nothing about its regions.

### Recommendation

**A.** The extra call is cheap and read-only, and "connected — here's your account, here are its
N regions" is a better first impression than a blank. Also surfaces a missing `ec2:DescribeRegions`
permission at connect time rather than at first scan (ties into D7).

### Decision: A

---

## Decision 5 — Pre-scan multi-region warning: when it is shown

### What's at stake

The product doc says "before the **first** scan with multiple regions". Literally every scan?
Once per connected session? Once ever, with a "don't show again"?

### Options

**A — Once per connected session, when discovered regions > 1.** An in-memory flag in the scan
store; reconnecting (or reopening the app) shows it again. No persistence. Simple, matches "first
scan" without nagging on every rescan.

**B — Every scan that will hit > 1 region.** Safest for consent, but becomes noise on the 5th
rescan of the day.

**C — Once ever, persisted (`localStorage`), with an explicit "got it" that suppresses it.** Least
nagging long-term; needs a persisted ack key and the copy has to carry the "this won't be shown
again" weight.

### Recommendation

**A.** "First scan of this session" is the natural reading of the doc and the lightest touch. Easy
to move to C later if you want it fully one-time.

### Decision: A

---

## Consequences (once decided)

Assuming all **A**:

- **Discovery.** New `aws/regions.rs` (or in `aws/config.rs`): `enabled_regions(&SdkConfig) ->
  Result<Vec<String>, _>` via `ec2:DescribeRegions` (default filter). `docs/iam-policy-minimal.json`
  gains `ec2:DescribeRegions` (read-only metadata, no resource data). The excessive-permission
  audit is unaffected (it looks for *too much*, not *too little*).
- **Connection.** Remove `<ct-region-field>` + the `region` signal from `manual-entry.component`;
  `ManualCredentialInput.region` and `UseDetectedInput.region` drop (or stay ignored — TBD in
  implementation). `resolve_region(None)` still yields `us-east-1` for the STS / `DescribeVolumes`
  validation probe, so validation is unchanged. `region.label` / `region.placeholder` i18n keys
  removed; `region.ssoLabel` stays (SSO still needs its Identity Center region — that field is
  **not** removed, it is not a scan-region choice).
- **D7 — discovery failure.** If `ec2:DescribeRegions` fails, the scan returns a specific error
  ("CostTracer couldn't list your account's regions — add `ec2:DescribeRegions`, see
  docs/iam-policy-minimal.json"), never a silent us-east-1 scan. With D4=A the same permission is
  also probed at connect time.
- **Store (D2=A).** `store/mod.rs`: `record_scan` → `begin_scan` + `record_region` + `finish_scan`.
  Migration: none (schema already fits); `scan.status` just takes new string values. Tests for
  `record_scan` rewritten.
- **Scan orchestrator.** `scan.rs`: load credential → validate → `enabled_regions()` →
  `begin_scan` → emit `scan://started { scanId, regions }` → for each region: `run_region`
  (raced against the cancel token, D1=A) → `record_region` → emit `scan://region { scanId,
  region, status, detectors, regionErrors }` → on cancel `break` → `finish_scan(status)` → emit
  `scan://done { scanId, status }`. `scan_run` still returns `ScanRunOutcome` (final `ScanResult`
  | `ReauthRequired` | `Cancelled`) as the authoritative end state.
- **D6 — event contract.** Three app events, payloads mirrored in `core/models/scan.ts`:
  `scan://started` `{ scanId: number, regions: string[] }`,
  `scan://region` `{ scanId, region, status: 'ok'|'partial'|'error', detectors: DetectorResult[],
  regionErrors: RegionError[] }`,
  `scan://done` `{ scanId, status: 'ok'|'partial'|'cancelled' }`.
  May need `core:event:allow-listen` in `capabilities/default.json` (verify against Tauri v2 —
  `core:default` may already cover webview `listen`).
- **Commands.** New `scan_cancel` (flips the token). `scan_run` becomes fire-and-observe: it still
  runs to completion server-side and returns the outcome, but the UI is driven by the events.
- **Frontend.** New `core/events/tauri-events.service.ts` wrapping `@tauri-apps/api/event`
  `listen` with `DestroyRef` cleanup. `ScanStore` reworked: holds `regionStatus: Record<region,
  'pending'|'running'|'done'|'error'>` + the merged `ScanResult`; subscribes on `run()`, merges
  each `scan://region`, clears on `scan://done`. `scan-panel` shows the pre-scan warning
  (D5=A), a per-region "checking…" indicator (regions not yet `done`), and a **Cancel** button
  while a scan is running. `detector-section` / `resource-row` unchanged (they render whatever
  detectors are in the merged result).
- **New deps:** `tokio-util` (D1=A) in `src-tauri`. No frontend dep (`@tauri-apps/api` already in).
- **Deviation to expect:** the scan-store rework + a Tauri-events service is infrastructure the
  earlier scopes didn't need; small, in service of this scope, will be noted in the report.

## Open questions for the decider

1. **D1** — cancellation via `CancellationToken` + `select!` (recommended, adds `tokio-util`), a
   zero-dep `AtomicBool` checked between regions, or task abort?
2. **D2** — split `record_scan` into `begin_scan` / `record_region` / `finish_scan` (recommended)?
3. **D3** — statuses `ok` / `partial` / `cancelled` / `running`, with `latest_scan_result` ignoring
   `running` (recommended)? Or fold cancel into `partial`?
4. **D4** — discover + store the enabled regions at `connection_finalize` (recommended), or don't
   store regions at all?
5. **D5** — pre-scan warning once per connected session (recommended), every multi-region scan, or
   once ever (persisted)?
6. Copy for the warning + the "checking…" / cancel UI ships functional-but-rough, refined on
   screen — OK?
