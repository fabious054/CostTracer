# ADR 0003 — Estimated cost per resource

- **Status:** Accepted — 2026-08-30
- **Date:** 2026-08-30
- **Scope affected:** Scope 3 (estimated cost per resource) — the last piece of Phase 0

## Decisions (all Option A)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Price-table format + location | **A — TOML file, embedded via `include_str!`, validated by a test** |
| 2 | Where the cost math runs | **A — Rust core, on-read (next to `ConfidenceLevel`)** |
| 3 | USD→BRL rate: home + value | **A — `[fx] usd_brl` in the table; seed `5.40` as a flagged placeholder** |
| 4 | LocalStack integration harness | **A — opt-in manual harness, not in the default `cargo test` / CI** |
| 5 | Estimation-fidelity gaps (EBS IOPS, snapshot size) | **A — price GiB-month + attach a visible qualifier; detector IOPS capture → backlog** |

Copy for the ~8–12 `cost.*` strings ships functional-but-rough, to be tuned on screen with the
product owner (confirmed).

This ADR bundles the decisions needed before Scope 3 implementation can start. D1–D3 are one
coherent question ("how a price is looked up, computed, and converted"); D4 is the test
environment; D5 acknowledges two places where a fixed table cannot be exact and picks how the UI
says so.

---

## Context (shared)

Every resource a detector flags (unattached EBS, idle Elastic IP, orphan snapshot) gets an
**estimated monthly cost**, shown at three aggregation levels: per resource, per detector, and
per account. Fixed by the product doc:

- **Local fixed price table.** No new external call, no AWS Price List API (backlog).
- **9 regions**, in priority order: `us-east-1, us-east-2, us-west-1, us-west-2, eu-west-1,
  eu-central-1, ap-southeast-1, ap-northeast-1, sa-east-1`.
- **Region not in the table ⇒ never approximate.** Show "price unavailable" and make the count of
  unpriced resources observable, so we know which regions to add next.
- **Cost shows from `Observed`** (the first confidence level), not only from `Confirmed` —
  same transparency principle as the rest of the product. Copy must frame it as a projection.
- **Formula:** resource size/use × table price × time, normalised to **one month** as the standard
  reference ("estimated cost per month"), even if the resource is younger than a month.
- **Currency:** USD always. When the UI language is Portuguese, show BRL alongside (never
  instead); English shows USD only. Conversion uses a **fixed rate** (real-time rate is backlog).
  UI must say the conversion is approximate.
- **Per-detector total** sums only that detector's resources at *any* alert level
  (Observed / Persisting / Probable / Confirmed) — never neutral, never intentional.
- **Account total** shows two numbers: resources at Probable **or** Confirmed (primary), and the
  additional total for Observed **or** Persisting (context).
- **Unpriced resources in a total:** not silently dropped (would mask the number), not fatal. The
  total carries an "N resources without an available price, counted separately" indicator.

Hard constraints (CLAUDE.md): nothing is ever written to AWS; the webview stays a formatter;
nothing new is required to be pre-installed for the running app.

Facts the detectors already emit (Scope 2), which is all the pricing engine has to work with:

| Resource | Facts available | Missing for exact pricing |
|---|---|---|
| EBS volume | `sizeGiB`, `type` (gp2/gp3/io1/…), `az`, `state` | provisioned IOPS, provisioned throughput |
| Elastic IP | `publicIp` | — (flat rate) |
| EBS snapshot | `sizeGiB` (= **source volume** size), `sourceVolumeId` | actual stored (changed-block) size |

Standard assumption baked into the table: **730 hours/month** (AWS's own convention).

---

## Decision 1 — Price-table format + location

### What's at stake

The table must be (a) easy to update by hand from the AWS pricing pages, (b) self-documenting
about where each number came from and when, (c) validated so a typo can't ship a silently-wrong
price. It ships inside the binary — no file to distribute.

### Options

**A — TOML file, embedded via `include_str!`, parsed + validated once at startup.**
Lives at `src-tauri/src/pricing/price-table.toml`. Comments carry the source URL and capture date
per section. A `cargo test` parses it and asserts shape (all 9 regions present for each resource
kind, every EBS type keyed, no negative/zero prices). Same embedding mechanism as
`docs/iam-policy-minimal.json`, swapping JSON→TOML for the inline provenance.

**B — JSON file, embedded via `include_str!`.** Exact consistency with
`iam-policy-minimal.json`. No inline comments, so provenance goes in a `_meta` object or a
sibling `price-table.SOURCES.md`.

**C — Rust `const` table in `pricing/table.rs`.** Compile-checked, zero runtime parsing. But a
price change is a code change + rebuild, and it is the least approachable format for a
non-Rust manual update — which the product doc explicitly wants to keep easy.

### Comparison

| | A — TOML | B — JSON | C — Rust const |
|---|---|---|---|
| Manual edit friendliness | high (comments) | medium | low |
| Provenance next to the number | yes | no | yes (comments) |
| Runtime parse/validate cost | once at startup + a test | once at startup + a test | none |
| Consistency with existing repo | close (`include_str!`) | exact | new pattern |

### Recommendation

**A.** The product doc's priority is easy manual updates with a documented source; TOML comments
put the AWS pricing URL and capture date on the same screen as the price. The one-time parse is
negligible and a table test removes the typo risk.

### Decision: A

---

## Decision 2 — Where the cost math runs

### What's at stake

Per-resource amount, per-detector rollup, and account rollup (including the unpriced counts) are
domain logic. The choice fixes which side owns the price table and how the math is tested.

### Options

**A — Rust core.** The engine computes USD amounts and both rollups while it builds the scan
result (right where `ConfidenceLevel` is already computed on read, ADR 0002 D2). New DTO fields
carry the numbers and the unpriced counts. The webview does only USD→BRL, formatting, and copy.
The fixed FX rate rides along in the DTO so the webview needn't know the table.

**B — TS webview.** Price table and all math in TypeScript; the core ships unchanged.

### Comparison

| | A — core | B — webview |
|---|---|---|
| Consistency with confidence-level precedent | matches | diverges |
| Testable in `cargo test` (fake table) | yes | no (Karma only) |
| Price table copies | one (core) | one (webview) |
| Webview role | stays a formatter | gains domain logic |

### Recommendation

**A.** Cost is the same kind of derived, on-read value as the confidence level; keeping it in the
core makes it unit-testable next to the scale cutoffs and keeps the webview a formatter.

### Decision: A

---

## Decision 3 — USD→BRL rate: home + value

### What's at stake

A single fixed number, plus where it lives and how it is kept honest.

### Options

**A — In the price table file, `[fx] usd_brl = <n>` with a source comment + capture date.**
Shipped to the webview as a plain `fxUsdBrl` field on the scan result; the webview multiplies and
labels it approximate. One file to update when refreshing prices.

**B — Separate constant in the core** (`pricing::FX_USD_BRL`). Same behaviour, one more place to
remember.

### Recommendation

**A**, and seed the value at **`5.40`** (round, clearly a placeholder). Replace with the rate you
want on the day we finalise; it is one line with a comment. Real-time FX stays in the backlog.

### Decision: A — `[fx] usd_brl = 5.40`, commented as a placeholder (not a real quote).

---

## Decision 4 — LocalStack integration harness

### What's at stake

The product ask is to validate the engine against data that "behaves like real AWS" without a
real account. LocalStack mocks EC2 `DescribeVolumes` / `DescribeAddresses` / `DescribeSnapshots`
(Community edition is enough). The question is how far it wires into the build.

> **Environment:** Docker Desktop 4.88.1 is installed and the daemon is running (verified 2026-08-30:
> `docker run --rm hello-world` OK, WSL2 `docker-desktop` distro up, `docker compose` v5.4.0). The
> LocalStack container and harness can be exercised here.

### Options

**A — Manual/local harness, not in the default test run.** `docker-compose.localstack.yml` +
`scripts/localstack-seed.*` (SDK pointed at `http://localhost:4566`, seeds fake volumes/EIPs/
snapshots with known type/size/region) + a `#[ignore]`-by-default integration test that runs the
real scan+pricing pipeline against it and asserts totals. Documented in `docs/development.md`.
The core reads an `AWS_ENDPOINT_URL` override in `aws/config.rs` (unset in production).
Pure pricing math keeps normal `cargo test` coverage with a fake table.

**B — Wired into `cargo test` behind an env/feature guard** that auto-skips when `:4566` is
unreachable.

### Recommendation

**A.** CLAUDE.md already says automated real-AWS-style tests aren't expected; there is no CI yet
and Docker isn't a given on a dev machine. Keep LocalStack as an opt-in harness, keep the unit
tests hermetic.

### Decision: A

---

## Decision 5 — Estimation-fidelity gaps

### What's at stake

Two resource kinds cannot be priced exactly from the facts the detectors capture. The product
doc's rule is "never invent a value" — these aren't invented, but they are knowingly imprecise,
so the UI should qualify them rather than present a false-precise number.

### The gaps

1. **EBS `io1` / `io2` (and `gp3` beyond baseline).** Billed for provisioned IOPS and throughput
   on top of GiB-month. The detector captures only `sizeGiB` + `type`, so the estimate is
   **GiB-only and will understate** these volumes.
2. **EBS snapshots.** Billed on incremental changed-block size; `sizeGiB` is the **source volume**
   size — an upper bound. The estimate will be **conservative-high**. No cheap API gives the real
   figure.

### Options

**A — Price what we can, attach a qualifier.** GiB-month math for every EBS type and for
snapshots; resources whose estimate is known-partial carry a machine-readable qualifier
(`ebs-iops-not-included`, `snapshot-full-volume-size`) that the row renders as a short caveat.
The number still counts toward the rollups (it is a real floor/ceiling, not a guess).

**B — Extend the EBS detector to capture provisioned IOPS/throughput.** More accurate `io1`/`io2`,
but it is Scope 2 detector work reopening inside Scope 3, and a new `ec2:DescribeVolumes` field
(no new IAM permission — same call).

### Recommendation

**A** for Scope 3; log **B** as backlog. The qualifier keeps the estimate honest without growing
the scope. Snapshot incremental sizing has no in-scope fix and stays qualified.

### Decision: A

---

## Consequences (once decided)

Assuming all **A**:

- **New module** `src-tauri/src/pricing/` — `price-table.toml` (embedded), `mod.rs`
  (parse + validate + `estimate(resource_type, region, facts) -> Estimate`), tests with a fake
  table. Source pages and update procedure documented in `docs/development.md`.
- **DTO additions** (`model.rs` + `core/models/scan.ts`), all `camelCase` over IPC:
  - `ResourceItem.estimatedCost`: `{ monthlyUsd: number | null, basis: 'ebs-gib' | 'eip-flat' |
    'snapshot-gib', qualifiers: string[], unavailable: 'region' | 'missing-fact' | null }`.
  - `DetectorResult.costRollup`: `{ monthlyUsd: number, pricedCount: number, unpricedCount: number }`
    — over alerting, non-intentional items only.
  - `ScanResult.costRollup`: `{ primaryMonthlyUsd: number` (Probable + Confirmed)`,
    contextMonthlyUsd: number` (Observed + Persisting)`, unpricedCount: number }`.
  - `ScanResult.fxUsdBrl: number`.
- **Engine is pure and on-read** — no schema/migration change; recomputes from the same
  `observation`/`resource` data plus the embedded table. Refreshing the table reprices history for
  free.
- **Frontend:** `resource-row` shows the per-resource line under the mandatory explanation;
  `detector-section` header shows the per-detector total; `main-view` shows the account panel with
  the two side-by-side numbers. A `cost.ts` helper does USD formatting and the language-gated BRL
  suffix (reads `I18nService.locale()`), plus the "approximate" and "unpriced" caveat strings.
  ~8–12 new `cost.*` i18n keys in both locales; final copy to be tuned on screen with the owner.
- **Unpriced visibility:** `unavailable: 'region'` resources are excluded from the summed USD but
  counted in `unpricedCount` at every level; the core also emits a `tracing` line
  (`region`, `resource_type`, count) so it shows up in logs.
- **LocalStack:** `docker-compose.localstack.yml`, `scripts/localstack-seed.*`, an
  `AWS_ENDPOINT_URL` override in `aws/config.rs` (unset in prod), an `#[ignore]` integration test,
  and a `docs/development.md` section. Not in the default `cargo test` / CI path.

## Open questions for the decider

1. **D1** — TOML (recommended) or JSON for the price table?
2. **D2** — cost math in the Rust core (recommended) or the webview?
3. **D3** — confirm `[fx] usd_brl` lives in the table (recommended) and give the seed value to
   use (placeholder `5.40`).
4. **D4** — OK to add LocalStack as an opt-in manual harness (recommended)? (Docker Desktop is
   already installed and verified working.)
5. **D5** — qualify-and-count the imprecise EBS/snapshot estimates (recommended), with detector
   IOPS capture deferred to backlog?
6. Copy for every cost string is left functional-but-rough on purpose, to refine on screen — OK?
