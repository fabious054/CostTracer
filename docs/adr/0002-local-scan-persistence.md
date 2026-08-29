# ADR 0002 — Local persistence for scan history

- **Status:** Accepted — 2026-08-28
- **Date:** 2026-08-28
- **Scope affected:** Scope 2 (idle-resource detectors) and everything temporal after it

## Decisions (all Option A)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Storage engine | **A — SQLite via `rusqlite` (`bundled`), in the core** |
| 2 | Observation history retention | **A — append-only `observation` log as source of truth** |
| 3 | Day-coverage streak semantics | **A — lenient: only a non-alert observation resets** |
| 4 | Angular state (ADR 0001 checkpoint) | **A — keep the hand-rolled signal store; no `@ngrx/*`** |
| 5 | ELB perms in the minimal IAM policy | **A — remove the 3 unused `elasticloadbalancing:*` actions now** |

Scale ambiguity resolved: **Probable 5–6 days, Confirmed ≥ 7** (EBS / Elastic IP scale).

This ADR bundles **four related decisions** needed before Scope 2 implementation can start.
Each has a `Decision:` line to fill in. Decisions 1–3 are one coherent question ("how scan
history is stored and how day-coverage is computed"); Decision 4 is the ADR 0001 checkpoint;
Decision 5 is a small change to the minimal IAM policy.

---

## Context (shared)

Scope 2 runs an on-demand scan of 3 detectors (unattached EBS, idle Elastic IP, orphan snapshot)
and must remember, across app restarts and over months:

1. **Every scan** — when it ran, which account and regions, whether it completed fully.
2. **Per resource, per scan** — whether it was in that detector's raw *alert* state, plus the raw
   facts to render the row and its mandatory explanation (size, AZ, public IP, source volume id,
   `CreateTime` / `StartTime`).
3. **"Marked as intentional"** flags.

An alerting resource's **confidence level** is derived from **days of coverage** — the span
between the first and the most recent *consecutive* alert observations of that resource. It is a
time span, not a scan count: two observations 8 days apart count as 8 days.

Hard constraints (CLAUDE.md):

- **Never written to AWS.** This store is the only home for the temporal signal.
- Read/written **only by the Rust core**; the webview gets typed DTOs, never queries the store.
- Lives in `app_local_data_dir()`, outside the repo.
- Nothing pre-installed — no system database, no external service.

Confidence scales (fixed by the product doc):

| Level | EBS / Elastic IP (days) | Snapshot (days) |
|---|---|---|
| Observed | 0–1 | 0–6 |
| Persisting | 2–4 | 7–18 |
| Probable | 5–7 | 19–29 |
| Confirmed | 7+ | 30+ |

> Minor ambiguity to resolve alongside these decisions: the EBS/EIP scale lists "Probable 5–7"
> and "Confirmed 7+", which overlap at day 7. Assumed reading: **Probable 5–6, Confirmed ≥ 7**.
> Correct here if it should be Probable 5–7 / Confirmed ≥ 8. → **Resolution:** _(pending)_

---

## Decision 1 — Storage engine

### What's at stake

The two hot queries are (a) day-coverage streaks with reset, (b) "does the snapshot's source
`VolumeId` still exist in the latest scan". The engine choice fixes how much of that is a query
vs. hand-written Rust, the migration story, and one dependency.

### Options

**A — SQLite via `rusqlite` (feature `bundled`), in the core.** Hand-written SQL; a
`schema_version` table + ordered migration functions.
- Relational queries are SQL's job — least custom code for (a) and (b).
- `bundled` compiles SQLite from source (C): **no system dependency**, but +~1 MB binary,
  +~1–2 min on a *clean* build (irrelevant incrementally).
- Migrations: the well-trodden path. Inspect with any SQLite browser.
- Not pure-Rust.

**B — `redb` (pure-Rust embedded, single file, ACID).** Typed `key -> value` tables, values are
serde blobs; secondary indices by hand.
- **Pure Rust**, no C, tiny, fast build.
- No query language: day-coverage aggregation and the "volume still exists" check become Rust
  over iterators — more code, easier to get subtly wrong.
- Migrations = version tag per value + upgrade-on-read (you write it). Needs a custom dump
  command to inspect.

**C — JSON file(s) via serde.** Whole history in memory, rewritten on change.
- Nothing new (`serde` only), smallest footprint.
- Fine at today's volume; grows unbounded in one blob, no partial read, concurrent-write safety
  is on us (mitigable: write-temp-then-rename). Least suited to "years of history".

`sled` is the same family as B; `redb` represents it (sled is long-lived beta).

### Comparison

| | A — rusqlite (bundled) | B — redb | C — JSON |
|---|---|---|---|
| New dependency | `rusqlite` + bundled SQLite (C) | `redb` (pure Rust) | none |
| Clean-build cost | +~1–2 min, +~1 MB | negligible | none |
| (a) day-coverage / (b) "volume exists" | SQL | hand-rolled Rust | hand-rolled Rust |
| Migrations | standard | DIY value versioning | DIY file versioning |
| Inspect the store | any SQLite tool | custom command | text editor |
| Partial-write / corruption safety | WAL, mature | ACID, mature | DIY |
| Fits "years of history" | yes | yes | weakly |

### Recommendation

**A — `rusqlite` bundled.** The data is relational; the hot queries are what SQL is best at with
the least custom code; `bundled` keeps the "nothing pre-installed" promise. Pick **B** only if
100% pure-Rust outweighs writing the temporal aggregation by hand.

### Decision: _(pending)_

---

## Decision 2 — Observation history retention

### What's at stake

Whether a change to the confidence scale (or its day cut-offs) can recompute levels
retroactively.

### Options

**A — Append-only observation log as the source of truth.** One row per (scan, resource),
forever. The `resource` table is only a rebuildable cache of the current streak.
- A scale/cut-off change recomputes past levels with no data migration.
- Cost: low thousands of rows per year — trivial.
- (A prune/retention policy is a later concern — noted as debt regardless.)

**B — Current streak state only.** Store just `first_alert_at` / `last_alert_at` per resource; no
historical log.
- Smaller, simpler.
- A future scale tweak only applies going forward — the past cannot be recomputed.

### Recommendation

**A.** The transparency principle and "confidence evolves with observed time" are the core of
this scope; being unable to re-derive it after a tuning change is a real limitation for near-zero
saving.

### Decision: _(pending)_

---

## Decision 3 — Day-coverage streak semantics when a scan doesn't cover a resource

### What's at stake

How coverage is counted when scans are missing, or a resource is absent from a scan (e.g. that
region errored). Directly affects how fast an alert reaches "Confirmed".

### Options

**A — Lenient: only a non-alert observation resets.** Coverage = `date(last alert obs) −
date(first alert obs)`. A scan that sees the resource in a **non-alert** state resets the streak.
Missing scans, or the resource being absent from a scan, do **not** reset. Matches the product
doc's "two observations 8 days apart = 8 days".

**B — Strict: needs continuous confirmation.** Every scan inside the window must have observed
the resource *in alert state*. Any scan where it appears neutral **or is absent** resets the
streak; reappearing starts a new window. Slower, fewer false positives, but a transient region
error delays confirmation.

### Recommendation

**A.** "Absent because a region call failed" is not evidence the resource changed; treating it as
a reset would let infrastructure flakiness, not the resource's actual state, drive confirmation
speed — the opposite of what the day-coverage rule is for.

### Decision: _(pending)_

---

## Decision 4 — Angular state management (ADR 0001 Scope 2 checkpoint)

### Context

ADR 0001 chose a hand-rolled signal store and said to revisit "when entity collections /
sortable tables arrive — likely migrate to `@ngrx/signals` `withEntities`".

Scope 2's result screen is **3 flat lists rendered from one `ScanResult` DTO** + a per-row
boolean toggle ("mark intentional"). Not a normalized entity graph; no pagination; no
cross-detector references in this scope.

### Options

**A — Keep the hand-rolled signal store.** A `ScanStore` holding `signal<ScanResult | null>` +
scan status; sort/filter via `computed()`; the toggle mutates the item and calls a command.
- No new runtime dependency; consistent with Scope 1.
- Records the checkpoint as evaluated → "not yet".

**B — Adopt `@ngrx/signals` `withEntities` now.** Normalize resources into an entity map by
`resourceId`.
- Pays off for large paginated tables / optimistic updates at scale / cross-detector linking —
  none of which Scope 2 has.
- Opens ADR 0003; adds the frontend's first runtime dependency.

### Recommendation

**A.** The trigger condition from ADR 0001 (a normalized entity graph) isn't met by "3 lists from
one DTO". Re-evaluate again if Scope 3 adds history browsing / filtering across scans.

### Decision: _(pending)_

---

## Decision 5 — Remove unused ELB permissions from the minimal IAM policy

### Context

`docs/iam-policy-minimal.json` currently includes `elasticloadbalancing:DescribeLoadBalancers`,
`:DescribeTargetGroups`, `:DescribeTargetHealth` — added in Scope 1 anticipating the LB detector,
which the Scope 2 doc **defers**. Scope 2's 3 detectors need only EC2 Describe actions, all
already present. Nothing in Scope 1 or 2 calls ELB.

CLAUDE.md: "Menor permissão sempre. Nunca adicione permissão 'por via das dúvidas'."

### Options

**A — Remove the 3 ELB actions now**, re-add them in the same commit as the LB detector when it
lands.

**B — Keep them** as forward-compat, accepting the credential asks for slightly more than it
uses today.

### Recommendation

**A**, per the project's own least-privilege rule. Also lets the excessive-permission audit stay
honest: a credential scoped exactly to the minimal policy shouldn't carry ELB read it never uses.

### Decision: _(pending)_

---

## Consequences (once decided)

- **D1 = A:** add `rusqlite = { version = "0.32", features = ["bundled"] }`; new
  `src-tauri/src/store/` (connection, migrations, typed queries); DB at
  `app_local_data_dir()/costtracer.sqlite3`, single file with `account_id` columns (Phase 3
  multi-account needs no migration). Full schema goes in `docs/scope-2-detectors.md`.
- **D2 = A:** `observation` rows are never deleted in Scope 2; `resource` is a derived cache;
  confidence level is a pure function of `(days, scale)` computed on read.
- **D3 = A:** streak reset only on a non-alert observation; the daily-coverage query ignores
  gaps and absences.
- **D4 = A:** `ScanStore` signal service; note the checkpoint outcome; no `@ngrx/*`.
- **D5 = A:** edit `docs/iam-policy-minimal.json` in the Scope 2 branch; note it in the scope
  report's "deviations".
