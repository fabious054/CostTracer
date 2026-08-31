# ADR 0005 — Scope 5 detectors: CloudWatch Logs retention, RDS orphan snapshot

- **Status:** Accepted — 2026-08-30
- **Date:** 2026-08-30
- **Scope affected:** Scope 5 (two more resource types) — second scope of Phase 1

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | RDS orphan-snapshot: which `SnapshotType`s are in scope | **A — manual only** |
| 2 | Aurora **DB cluster** snapshots in this scope | **A — follow-up, not now** |
| 3 | CloudWatch Logs cost basis + labelling | **A — storage-only, GB (10⁹), two qualifiers, IA priced as STANDARD** |
| 4 | How `run_region` gets the new per-service clients | **C — pass `&SdkConfig`, build clients inside** |

Also settled here without options (single reasonable path, fixed by the product doc or by parity
with the existing detectors):

- **Raw alert states.** CloudWatch Logs: `retentionInDays` null/absent ⇒ alert; any value set ⇒
  neutral. No size threshold — every retention-less log group enters the confidence scale from
  first detection, including groups auto-created by other AWS services (Lambda/ECS/API Gateway).
  RDS: source `DBInstanceIdentifier` absent from `DescribeDBInstances` ⇒ alert; present ⇒ neutral.
- **Confidence scales.** CloudWatch Logs uses the **standard** scale (0-1 / 2-4 / 5-6 / 7+), same
  as EBS / Elastic IP. RDS snapshot **reuses the snapshot scale** (0-6 / 7-18 / 19-29 / 30+) — same
  conservative floor as EBS snapshots (DB backup retention is commonly intentional / compliance);
  may be revisited later if an even longer RDS-specific cutoff proves warranted.
- **Age anchor.** CloudWatch Logs `creationTime` (epoch **milliseconds** — divide by 1000). RDS
  `SnapshotCreateTime`. Same "created X days ago" line the other detectors already show.
- **A source that exists again is neutral.** An RDS snapshot whose `DBInstanceIdentifier` matches a
  currently-existing instance is neutral even if that instance was deleted and recreated under the
  same name — same as the EBS orphan-snapshot detector treats a re-used volume id. No extra logic.
- **Price table.** Same fixed local TOML, no Price List API call (that is the *next* scope). Two
  new flat `region → USD/GB-month` sections (`cw_logs`, `rds_snapshot`) for the **same 9 regions**;
  a region outside the table is `unavailable`, never approximated. `pricing::estimate` gains two
  match arms; the shape test gains the two sections.
- **IAM.** `docs/iam-policy-minimal.json` gains `logs:DescribeLogGroups`, `rds:DescribeDBSnapshots`,
  `rds:DescribeDBInstances` (all read-only, no resource contents). If D2 = include Aurora,
  also `rds:DescribeDBClusterSnapshots` + `rds:DescribeDBClusters`.
- **Aggregation.** The two detectors plug into the existing three rollup levels (row / detector /
  account) with zero rollup-code change — `DetectorResult` / `AccountCostRollup` are generic over
  `DetectorKind`.
- **Dev fixture.** `store/demo_seed.rs` gains representative rows for both new types (kept
  permanently, CLAUDE.md checklist exception).
- **New crates:** `aws-sdk-cloudwatchlogs`, `aws-sdk-rds` (official AWS SDK, the locked stack
  decision — "outros conforme novos detectores forem adicionados").
- **No schema migration.** `observation` / `resource` store `resource_type` and `detector` as
  free TEXT; new enum values need no DDL.

---

## Context (shared)

Phase 1's roadmap line is "more resource types". Scope 5 adds the last two that were still open
after multi-region (Scope 4): **CloudWatch Logs groups with no retention policy** (AWS keeps logs
forever by default) and **orphan RDS snapshots** (a DB snapshot whose source instance is gone).

Both follow the pattern the three Scope 2 detectors established: a module in `detectors/`, a
`RawFinding` per resource classified `in_alert` / neutral, facts captured for the row + the
mandatory explanation, nothing written back to AWS. The orphan-RDS detector mirrors the
orphan-EBS-snapshot one exactly: list the "parents" first, build a `HashSet` of their ids, flag
any child whose parent id isn't in it; a failure to list the parents skips the child detector for
that region rather than flagging everything.

Hard constraints (CLAUDE.md): read-only; nothing written to AWS; least privilege (new permissions
justified and added in the same change); the webview stays a formatter.

Fixed by the product doc: no size threshold on log groups (scan completeness matters more than
"not worth showing"); an empty log group still shows an honest `$0.00/mo`, not hidden; the RDS
snapshot scale starts from the same conservative floor as EBS snapshots; same 9 priced regions;
Price List API migration is the *next* scope, not this one (this scope takes the count of
hand-maintained price tables from 3 to 5 — the deferral has a scale limit).

---

## Decision 1 — RDS orphan-snapshot: which `SnapshotType`s are in scope

### What's at stake

`DescribeDBSnapshots` returns two kinds. **Manual** snapshots are created by a person/automation,
outlive their instance, and are the classic "forgotten backup". **Automated** snapshots are
managed by AWS's backup lifecycle — created on the backup window, deleted with the instance (or by
the retention policy). You cannot "forget" an automated one; it can briefly outlive a deleted
instance before AWS cleans it up.

### Options

**A — Manual only.** `DescribeDBSnapshots().snapshot_type("manual")` × `DescribeDBInstances`. No
transient noise; matches "orphan = someone made it and forgot it".

**B — Manual + automated.** No type filter. "More complete" in the scan-completeness spirit, but
automated snapshots of a *live* instance are neutral anyway, and the few that briefly survive an
instance deletion become a transient false alert until AWS deletes them.

### Comparison

| | A — manual only | B — manual + automated |
|---|---|---|
| Transient false alerts | none | possible (post-deletion window) |
| "Forgotten backup" intent | exact | diluted by lifecycle-managed rows |
| API | one call, `snapshot_type=manual` | one call, unfiltered |

### Recommendation

**A.** Automated snapshots aren't a thing a user can act on or forget — flagging them is noise, not
coverage. The completeness argument in the product doc is about *not filtering by size/impact*, not
about surfacing AWS-lifecycle-managed objects.

### Decision: A

---

## Decision 2 — Aurora **DB cluster** snapshots in this scope

### What's at stake

`DescribeDBSnapshots` only covers **instance** snapshots. Aurora uses **cluster** snapshots
(`DescribeDBClusterSnapshots` × `DescribeDBClusters`) — a separate API, a separate neutral set,
one more IAM permission each. Aurora is a large share of real RDS usage, so "orphan RDS snapshot"
that ignores Aurora covers less than the name implies.

### Options

**A — Out of scope now.** Instance snapshots only. Aurora cluster snapshots become a follow-up
(its own mini-scope, or folded into Scope 6). One new detector, smallest new surface.

**B — Include now.** Covers forgotten Aurora backups immediately. Cost: +2 API calls per region,
+2 IAM permissions, a second new raw-state/neutral pair to maintain, and a second new
`DetectorKind` / `ResourceType` this scope.

### Recommendation

**A.** Two new detectors already land this scope (CloudWatch Logs + instance-snapshot RDS). Adding
a third at the same time widens the blast radius of one review. The Aurora variant is a clean,
well-understood follow-up once the instance one is validated on screen.

### Decision: A

---

## Decision 3 — CloudWatch Logs cost basis + labelling

### What's at stake

The product doc fixes the basis as `storedBytes` and wants an honest `$0.00/mo` for empty groups.
Three things it doesn't pin down: what the figure *excludes*, the byte→GB unit, and whether the
newer Infrequent-Access log class gets its own (cheaper) storage price.

CloudWatch Logs billing has three parts: **ingestion** (~$0.50/GB, one-off), **storage/archival**
(~$0.03/GB-month, recurring), and analysis. `storedBytes` ⇒ storage only.

### Options

**A — storage-only, GB (10⁹), two qualifiers, IA class ignored.** Price = `storedBytes / 1e9 ×
table[region]`. Row carries two of the same short qualifier notes the other detectors use:
*"storage only — excludes ingestion"* and *"size reported by AWS, updated periodically"*
(`storedBytes` lags real time by hours). `logGroupClass = INFREQUENT_ACCESS` is priced as
STANDARD for now (an IA group with no retention is still a valid alert; only the figure runs a
little high) — IA pricing is backlog.

**B — as A but GiB (2²⁰³⁰).** Internal label consistency with EBS ("{n} GiB"), at the cost of
diverging ~7% from the unit the AWS pricing page states.

**C — model the IA log class now.** A second price row per region (`cw_logs_ia`) and a branch on
`logGroupClass`. More accurate for IA-heavy accounts; more table to hand-maintain (the thing this
scope is already flagging as near its limit).

### Recommendation

**A.** Storage-only is forced by the doc; GB matches the pricing source; the two qualifiers reuse
an existing UI affordance; IA is a rare-enough case that STANDARD-priced-with-a-caveat is honest
enough for an estimate already labelled approximate.

### Decision: A

---

## Decision 4 — How `run_region` gets the new per-service clients

### What's at stake

`detectors::run_region` takes `&aws_sdk_ec2::Client` today. It now also needs a CloudWatch Logs
client and an RDS client. `scan.rs` builds the client(s) per region inside the scan loop.

### Options

**A — Add two params.** `run_region(ec2, logs, rds)`. Explicit; the signature churns again with
every future detector family.

**B — A `RegionClients<'a>` struct.** `run_region(&RegionClients)` bundling the three. One type to
extend; still constructed in `scan.rs`.

**C — Pass `&SdkConfig`; `run_region` builds what it needs.** `scan.rs` stops building clients;
`run_region` does `aws_sdk_*::Client::new(cfg)` for each family it uses. Client construction is
cheap (no I/O). Future detectors touch only `detectors/`.

### Comparison

| | A — params | B — struct | C — `&SdkConfig` |
|---|---|---|---|
| Signature stability | churns per family | one type to edit | stable |
| `scan.rs` knowledge of detectors | which clients | which clients | none |
| Explicit about what a detector uses | yes | yes | yes (at `Client::new` call site) |

### Recommendation

**C.** It keeps `scan.rs` a pure orchestrator (loop regions, race the cancel token, persist, emit)
and confines "which AWS services do we call" to `detectors/`, where the next scope will work.

### Decision: C

---

## Consequences (once decided)

Assuming **D1=A, D2=A, D3=A, D4=C**:

- **New detectors.** `detectors/cw_logs.rs` (`DescribeLogGroups`, paginated; `retentionInDays`
  null ⇒ alert; facts: `storedBytes`, `storedGiB` for display, `retentionDays: null`,
  `logGroupClass`) and `detectors/rds_snapshot.rs` (`DescribeDBInstances` → `HashSet<id>`, then
  `DescribeDBSnapshots(manual)`; facts: `allocatedStorageGb`, `sourceDbInstanceId`, `engine`).
  `detectors/mod.rs`: `run_region(app_cfg: &SdkConfig)` builds `ec2` / `cloudwatchlogs` / `rds`
  clients; adds the two detectors to the findings/errors aggregation with the same
  skip-on-parent-list-failure guard the EBS/snapshot pair uses.
- **Model.** `ResourceType` gains `CloudwatchLogGroup`, `RdsSnapshot` (+ `as_db` /`from_db` /
  `confidence_scale` — Log group = Standard, RDS snapshot = Snapshot). `DetectorKind` gains
  `LogGroupNoRetention`, `OrphanRdsSnapshot` (+ `resource_type` / `as_db` / `from_db`).
  `CostBasis` gains `LogsGbMonth`, `RdsSnapshotGb`. `CostQualifier` gains `LogsStorageOnly`,
  `LogsSizeReported`, `RdsSnapshotAllocatedSize`.
- **Pricing.** `RawTable` gains `cw_logs: HashMap<String, f64>` and `rds_snapshot: HashMap<String,
  f64>`; `estimate` gains `estimate_logs` (storedBytes/1e9 × price; missing/zero bytes ⇒ priced
  `$0.00`, *not* `MissingFact`) and `estimate_rds_snapshot` (allocated GB × price, with the
  allocated-size qualifier). `price-table.toml` gains `[cw_logs]` + `[rds_snapshot]` with sources
  + `captured` date; the shape test covers both across the 9 regions.
- **Store.** `DETECTORS` const 3 → 5. `demo_seed.rs` fixture gains a few log-group rows (empty +
  sized, a couple of regions incl. one unpriced) and RDS-snapshot rows (spread across the snapshot
  scale, one intentional, one neutral).
- **Scan orchestrator.** `scan.rs` region loop passes `&cfg` to `run_region` instead of building
  `ec2` itself.
- **Frontend.** `core/models/scan.ts`: extend the `ResourceType` / `DetectorKind` / `CostBasis` /
  `CostQualifier` string unions. `resource-row.component.ts`: `explanation()` + `factsLine()` gain
  a `cloudwatch_log_group` case (retention-less for N days; stored size) and an `rds_snapshot` case
  (orphaned for N days; allocated GB · engine). `detector-section.component.ts` unchanged (generic
  over `DetectorKind`). `messages.ts`: new keys both locales — `scan.detector.log-group-no-retention`
  / `scan.detector.orphan-rds-snapshot`, `scan.explain.logGroup` / `scan.explain.rdsSnapshot`,
  `scan.fact.*` as needed, `cost.qualifier.logs-storage-only` / `.logs-size-reported` /
  `.rds-snapshot-allocated-size`. Copy ships functional-but-rough, refined on screen.
- **IAM.** `logs:DescribeLogGroups`, `rds:DescribeDBSnapshots`, `rds:DescribeDBInstances` added to
  `docs/iam-policy-minimal.json` in the same change.
- **Tests.** `pricing::tests` gains the two shape checks + `estimate` cases (incl. zero-bytes ⇒
  `$0.00` and region-not-in-table ⇒ `unavailable`). Frontend spec fixtures that assert
  `detectors.length === 3` / index into `detectors[0..2]` move to 5. `model::confidence_tests`
  unchanged (scales reused).
- **Deviation to expect:** none architectural — this is the Scope 2 detector pattern applied twice
  plus the Scope 3 price-table pattern applied twice. Will be noted as such in the report.

## Open questions for the decider

1. **D1** — RDS orphan-snapshot over **manual** snapshots only (recommended), or manual +
   automated?
2. **D2** — Aurora **DB cluster** snapshots: follow-up (recommended), or in this scope (+2 APIs, +2
   IAM permissions, a 3rd new detector this round)?
3. **D3** — CloudWatch Logs cost = storage only, GB (10⁹), with *"storage only"* + *"size reported
   by AWS"* qualifiers, IA log class priced as STANDARD for now (recommended)? Or GiB for label
   consistency / model the IA class now?
4. **D4** — `run_region` takes `&SdkConfig` and builds its own clients (recommended), or keep
   passing explicit clients?
5. Prices for `[cw_logs]` + `[rds_snapshot]` (9 regions each) come in by manual capture from the
   AWS pricing pages with a `captured` date — you sanity-check the numbers at review, same as any
   price update. OK?
6. Explanation / fact / qualifier copy for the two new detectors ships functional-but-rough,
   refined on screen — OK?
