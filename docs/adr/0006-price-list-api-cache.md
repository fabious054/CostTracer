# ADR 0006 — AWS Price List API with a local cache

- **Status:** Accepted — 2026-08-31 (D1, D3, D4, D5; D2 revised to a decoupled background refresher, D2a-D2f confirmed as recommended).
- **Date:** 2026-08-31
- **Scope affected:** Scope 6 (price source migration) — post-Phase-1 solidification work, not part of any numbered phase (Phase 2 stays reserved for assisted action)

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | USD→BRL rate source (Price List API has no FX) | **A — Frankfurter (`api.frankfurter.dev`), the one documented non-AWS host, disclosed in the README** |
| 2 | Where price / FX resolution happens | **Revised — B: a background refresher, fully decoupled from the scan. The scan only ever does a plain cache read.** Sub-decisions D2a–D2f below. |
| 3 | Price List API query method | **A — `aws-sdk-pricing` `GetProducts` + per-(resource, region) filters** |
| 4 | Where the cache lives | **A — a dedicated `pricing-cache.sqlite3`, separate from the scan DB** |
| 5 | `EstimatedCost` model changes for the new failure / staleness semantics | **As proposed, + a `PricePending` state (D2e)** |

Also settled here without options (fixed by the product doc or by a single reasonable path):

- **The fixed table goes away completely.** `price-table.toml`, its parse/validate code, the
  current `estimate()`, and `pricing::tests` (the shape test that walks the 9 regions) are
  deleted. No table-based fallback stays anywhere. `[fx] usd_brl` goes with it.
- **Two staleness windows, hard-coded constants**, not user-configurable: **resource prices 3
  days**, **FX rate 5 hours**.
- **Layered resolution runs entirely in the background refresher (D2), never in the scan.** Per
  `(resource type, region)` (and for FX):
  1. cache younger than the window → nothing to do;
  2. cache missing or older than the window → call the source;
     - source ok → write the value + `fetched_at`;
     - source fails, a cache row exists (even expired) → leave it; the scan will use it and show
       its real `fetched_at` date;
     - source fails, no cache row → write a **failure marker** row (`price_json` NULL +
       `last_attempt_at`), so a later read can tell "not fetched yet" from "tried and failed".
- **The scan never touches the network for prices or FX.** `build_scan_result` does a plain,
  synchronous cache read of whatever is saved *at that instant* — fresh, expired, a failure
  marker, or absent — exactly as fast and simple as reading the old fixed table. A refresh in
  flight during a scan is a non-event: the scan uses what was saved before it started.
- **All enabled regions are priced.** The scan already discovers them (`ec2:DescribeRegions`,
  ADR 0004); pricing follows the same coverage — no priority-region subset.
- **The imprecision qualifiers are unchanged** (`io1`/`io2` GiB-only, snapshot on full source
  size, CloudWatch Logs storage-only). They describe what the *detector captures*, not where the
  price comes from — still valid.
- **The three rollup levels are unchanged** in structure; only the number's origin moves.
- **No detector logic changes** beyond how each obtains a price.
- **IAM:** `pricing:GetProducts` is added to `docs/iam-policy-minimal.json` — the Price List Query
  API is IAM-gated, not anonymous.
- **Out of scope** (product doc): a "force refresh prices" button (backlog); any AWS write/delete;
  any change to the set of 5 detectors.

---

## Context

Since Scope 3 the estimated cost has come from `src-tauri/src/pricing/price-table.toml` — a
hand-maintained file covering **9 priority regions**, embedded with `include_str!`, parsed once,
read by a pure `estimate(resource_type, region, facts) -> EstimatedCost`. Scope 5 pushed it to
**5 sections** (EBS, Elastic IP, EBS snapshot, CloudWatch Logs, RDS snapshot). Both Scope 3 (a
regional inconsistency caught in review) and Scope 5 (a conscious "scale by borrowed factors"
instead of a real per-region capture) flagged this as past its scale limit — the reports name
the Price List API migration as the next scope.

Scope 6 replaces the file with the **AWS Price List Query API** plus a **local cache**, covering
every enabled region, with a layered fallback so a scan still produces figures when the API is
slow or unreachable.

Constraints that shape this (CLAUDE.md):

- **Read-only against AWS**; nothing written. The Price List API is read-only.
- **No network calls outside AWS domains without explicit sign-off** — the FX rate is the problem
  (D1): AWS has no FX service.
- **Least privilege** — the one new permission (`pricing:GetProducts`) lands in the same change.
- **Small frontend bundle** — the webview is unaffected here; all new code is in the Rust core.

Current shape that constrains the design: `Db::build_scan_result` is **synchronous**, holds the
scan-DB mutex, calls `pricing::estimate` per alerting item and `pricing::fx_usd_brl` once, and is
invoked **once per region plus once at the end** of every scan (`scan.rs`) — ~18–35 times for a
17-region account. Any price resolution that does network I/O cannot live inside it.

---

## Decision 1 — USD→BRL rate source

### What's at stake

The product doc says the FX rate "migrates to automatic lookup" and that **no trace of the TOML
table stays** — so the fixed `[fx] usd_brl` is gone and there is no build-time constant to fall
back to. But the **AWS Price List API does not publish exchange rates**, and there is no other AWS
service that does. An automatic USD→BRL rate therefore requires a call to a **non-AWS host**,
which CLAUDE.md says must be surfaced as an explicit decision to validate — the product's
security pitch ("verifiable: nothing talks to anything but AWS") changes the moment this ships.

### Options

**A — A no-key public FX API, cached (5 h window).** Recommend **Frankfurter**
(`https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL`): ECB reference rates, open-source,
HTTPS, **no API key**, no account, no request that carries anything identifying (just
`base`/`symbols`). One GET per 5-hour window; the response (`{"rates":{"BRL":5.43},...}`) goes in
the cache. ECB updates once per business day, so a 5-hour window just means we re-check sooner,
not that the number moves that often. The domain (`api.frankfurter.dev`) is documented in the
README security section and is the *only* non-AWS host the app ever contacts.

**B — A different no-key FX API** (`open.er-api.com`, community-run; or a keyed one like
`exchangerate.host` / `openexchangerates.org`). `open.er-api.com` works without a key but is a
single-maintainer service with less transparent sourcing; keyed services mean shipping/managing a
key in an open-source desktop app, which is its own problem.

**C — Don't fetch FX; drop or freeze the BRL feature.** Either remove the pt-only BRL suffix
entirely, or keep a single hard-coded rate in a Rust constant (not a data file). This keeps the
"AWS-only" property intact but **contradicts the product doc** ("migrates to automatic lookup",
"no trace of the TOML"), so it's only viable if product reverses that.

### Comparison

| | A — Frankfurter | B — other FX API | C — no fetch |
|---|---|---|---|
| Matches the product doc | yes | yes | no |
| Non-AWS host contacted | 1 (`api.frankfurter.dev`) | 1 | 0 |
| API key to ship | no | maybe | n/a |
| Source transparency | ECB, open-source | varies | n/a |
| "AWS-only" pitch | needs an asterisk + doc | needs an asterisk + doc | intact |

### Recommendation

**A**, contingent on your sign-off that CostTracer may contact exactly one documented non-AWS
host for the FX rate. Frankfurter is the least-bad option: no key, no identifying request, ECB
data, open-source, and it's easy to state plainly in the README ("the only non-AWS request is an
anonymous exchange-rate lookup to api.frankfurter.dev; disable it and BRL simply doesn't show").
If that asterisk isn't acceptable, we go to C and take it back to the product conversation.

### Decision: A (Frankfurter) — approved, with the README disclosure

---

## Decision 2 — Where price / FX resolution happens (REVISED)

### What's at stake

Prices now need a cache read and sometimes a network call. The first proposal (A) resolved the
cache at the *start of each scan*, before `build_scan_result`. That still lets a scan **wait on
the network** the first time a price is missing or expired. The product decision is that a scan
must **never** wait on price/FX network I/O — under any circumstance.

### Decision: B — a background refresher, decoupled from the scan

- A **background process**, owned by the Rust core, keeps `pricing-cache.sqlite3` warm on its own:
  it checks what is missing or past its window (3 d prices / 5 h FX) and fetches it — with **no
  manual action** and **without a scan having run**.
- The **layered resolution** (fresh → source → keep-expired → failure-marker) lives *entirely* in
  this refresher.
- The **scan** (`build_scan_result` / `scan_result_from_conn` / `estimate`) does a plain,
  synchronous **read** of the cache as it stands at that instant. `estimate` stays a pure
  function — now `estimate(rt, region, facts, &PriceBook)` where `PriceBook` is a snapshot loaded
  from the cache in one query at the top of `build_scan_result` (not built inline by fetching).
- If the refresher is mid-fetch while a scan runs, the scan just uses whatever was committed
  before it started. No lock contention (separate DB file), no waiting.

This keeps everything good about the original A (pure `estimate`, testable without network, one
place that does the layered logic) and removes the one thing the product rejected (a scan ever
blocking on price I/O).

### Sub-decisions this opens

**D2a — which `(resource type, region)` set the price refresher keeps warm.**
- **A (recommended)** — the account's enabled regions from `StoredCredential.regions` (Scope 4
  already discovers and stores these at connect). × the 5 resource types. Zero extra AWS calls to
  learn the set; it's in the vault the moment you're connected.
- B — the refresher runs its own `ec2:DescribeRegions` on start. One more call, redundant with
  what connect already did.
- C — every AWS region for the 5 types, account-independent (~35 × 5). Heavier every cycle;
  warms regions the account will never scan.
- **The FX refresher needs no credentials** (Frankfurter is anonymous), so it runs whenever the
  app is open. **The price refresher needs the connected credential** (`pricing:GetProducts` is
  IAM-gated), so it runs only while connected.

**D2b — trigger + orchestration.**
- **A (recommended)** — the frontend calls a `pricing_refresh_start` command once, after the
  connection resolves on boot (and again on `connection_finalize`). The command spawns **one**
  long-lived `tokio` task held in Tauri managed state: it does an immediate stale-check + fetch,
  then loops with `tokio::time::sleep` re-checking every ~30 min (so a long session that crosses a
  window boundary still refreshes), and can be **nudged** (via a channel) when a scan finishes
  with a region not yet in the cache. It emits `pricing://refreshing` (active) / `pricing://idle`
  on the Tauri event bus — the same pattern as `scan://` (Scope 4).
- B — a pure Rust-side timer with no frontend involvement. Fewer moving parts, but the UI banner
  (below) then needs the events anyway, so A is barely more code and keeps the frontend in the
  loop for the banner.

**D2c — no duplicate / concurrent refreshers.**
- **A (recommended)** — the managed-state task handle is the guard: `pricing_refresh_start` is
  idempotent — if a live task already exists, it's a no-op. One app process ⇒ one refresher. For
  the rare two-app-instances case, the two share `pricing-cache.sqlite3` and SQLite's file lock
  serialises writers (a `busy_timeout` handles the brief overlap); worst case is one wasted fetch,
  never corruption. A cross-process lock row is possible but over-engineered for a single-user
  desktop tool — noted, not built.

**D2d — periodic re-check while the app is open.** Yes (folded into D2b/A): a ~30 min tick that
acts only on what's actually stale/missing. Cheap; closes the gap for long sessions and for a
region the account opted into after connect.

**D2e — the scan must tell "not fetched yet" from "fetch failed".** The scan only reads the
cache, so the cache has to carry the distinction:
- a row with a value + `fetched_at` (fresh or expired — `priced_at` set only when expired);
- a **failure-marker** row (value NULL + `last_attempt_at`) → the refresher tried and the source
  gave nothing;
- **no row** → the refresher hasn't reached this `(type, region)` yet.
So `CostUnavailable` gets **two** variants, not one: `PricePending` (no row — refresh pending /
in progress) and `PriceUnavailable` (failure marker — the lookup failed). Different messages to
the user. FX gets the same: `fx_usd_brl == 0` with `fx_as_of == None` and a "pending" vs
"unavailable" flag — simplest is a small `FxStatus { rate: f64, as_of: Option<i64>, state:
Fresh|Stale|Pending|Unavailable }` on `ScanResult` instead of the bare `f64`.

**D2f — first run on a cold cache.** Consequence of B: a brand-new install that connects and
scans immediately, before the refresher has fetched anything, shows every priced row as
`PricePending` ("preço ainda não disponível — atualização em segundo plano"). The banner (below)
is visible the whole time. A rescan a few seconds later (or the same scan re-opened) picks up
whatever the refresher has committed. This is acceptable and self-explanatory *because* of the
banner + the distinct "pending" copy — it is **not** the same as an error.

### UI — new component (product-specified)

A visible, clearly-worded strip **separate from the scan/detector/cost content area** (so it
doesn't add to the clutter there), near the account header, **shown only while a refresh is
actively running** and gone entirely otherwise. Covers prices and FX together in one place.
Driven by the `pricing://refreshing` / `pricing://idle` events. Exact position + copy tuned on
screen.

### Decision: B (revised). D2a-D2f: all as recommended.

---

## Decision 3 — Price List API query method

### What's at stake

The Price List API has two shapes: the **Query API** (`aws-sdk-pricing`: `GetProducts`,
`GetAttributeValues`, `GetPriceListFileUrl`) and the **Bulk API** (download whole per-service
offer files). The product doc rules out "downloading full service indexes".

### Options

**A — `aws-sdk-pricing` `GetProducts` with per-`(resource, region)` `TermMatch` filters.**
Endpoint pinned to `us-east-1` (the Query API lives only in a few regions; the *priced* region is
a filter attribute, not the endpoint). `format_version("aws_v1")`. Each call returns
`price_list: Vec<String>` where every string is a product JSON document; we read the OnDemand
term's price dimension → `pricePerUnit.USD`. One `GetProducts` per `(resource type, region)` that
isn't in a fresh cache. Concurrency capped (~6 in flight); rely on the SDK's adaptive retry for
throttling. New crate: `aws-sdk-pricing`.

**B — `GetPriceListFileUrl` + download the regional offer file.** Smaller than the full index but
still megabytes per service per region; and it's the "download a file and parse it" shape the
product doc pushed away from.

### Recommendation

**A.** Targeted `GetProducts` calls, cached, is exactly the "query specific products, don't bulk
download" intent. **Caveat to expect during implementation:** the per-resource-type filter
attributes (`productFamily`, `volumeApiName`, `group`, `usagetype`, `regionCode` vs `location`,
…) are notoriously fiddly and occasionally change; the filter map for the 5 detectors will need
live iteration against the real API, and each detector's resolver gets a focused test against a
captured sample response.

### Decision: A

### Filter map — resolved live (2026-09-03)

The caveat played out as expected. Verified against `us-east-1`, `sa-east-1`, `ap-south-1`,
`eu-central-1`:

| Product key | Service | Filters | Discriminator (on `usagetype`) |
|---|---|---|---|
| `ebs:{type}` | `AmazonEC2` | `productFamily=Storage`, `volumeApiName={type}`, `regionCode` | zero-tier OnDemand |
| `ebs:snapshot` | `AmazonEC2` | `productFamily=Storage Snapshot`, `regionCode` | `EBS:SnapshotUsage` exactly, or `-EBS:SnapshotUsage` suffix — **not** the archive tiers / `.outposts` / `UnderBilling` |
| `eip:idle` | **`AmazonVPC`** | `group=VPCPublicIPv4Address`, `regionCode` | contains `PublicIPv4:IdleAddress` |
| `cwlogs:storage` | `AmazonCloudWatch` | `regionCode` | contains `TimedStorage-ByteHrs` |
| `rds:backup` | `AmazonRDS` | `productFamily=Storage Snapshot`, `regionCode` | ends `RDS:ChargedBackupUsage` / `RDS:BackupUsage` — not `RDSCustom:` / `Aurora:` |

Traps the first cuts hit: Public IPv4 moved to the `AmazonVPC` service with the Feb-2024 pricing
change (`productFamily="IP Address"` on `AmazonEC2` matches nothing); `productFamily="Storage
Snapshot"` returns ~6 line items whose order varies by region, so a no-op discriminator picked
the archive rate in some regions; and `rds:backup` with only a service filter drowned in
thousands of AmazonRDS rows past `max_results(100)` in busy regions — `productFamily="Storage
Snapshot"` (RDS reuses it) cuts that to ~40. `regionCode` works as a filter for every one of the
five — no `location` fallback needed. **Failure markers** age out after `FAILED_RETRY_SECS`
(30 min), not the price window: a throttle on the cold-cache burst must not hide a price for days.

---

## Decision 4 — Where the cache lives

### What's at stake

The cache is public AWS data with **no relationship to which account is connected** — unlike the
scan DB, which is account-scoped and has had cross-account leak bugs fixed twice (Scopes 2, 4).

### Options

**A — A dedicated `pricing-cache.sqlite3`** in the same `app_local_data_dir()`, its own `rusqlite`
connection in Tauri managed state, two tables:
`price_cache(service TEXT, product_key TEXT, region TEXT, price_json TEXT, fetched_at INTEGER,
PRIMARY KEY(service, product_key, region))` — `price_json` is the raw AWS document, stored as-is
(product doc: no normalising before storing); and
`fx_cache(pair TEXT PRIMARY KEY, rate REAL, fetched_at INTEGER)`.
Keeping it a **separate file** means no schema, migration, or query ever mixes account-scoped and
account-independent data — the cross-account risk category simply can't reopen here.

**B — New tables inside the existing `costtracer.sqlite3`.** One fewer file, but reintroduces the
exact "one DB holds both kinds of data" shape the product doc says to avoid.

**C — Flat JSON files on disk** (`pricing-cache/<service>-<region>.json` + `fx.json`). No SQL
dependency for this (rusqlite is already in, so no saving), and TTL/upsert are slightly more
code than a SQL `INSERT … ON CONFLICT` + a `WHERE fetched_at > ?`.

### Recommendation

**A** — it's what the product doc describes, and the separate-file boundary is a cheap, permanent
guard against the leak class.

### Decision: A

---

## Decision 5 — `EstimatedCost` model changes

### What's at stake

The DTO must express two things it can't today: **the price lookup failed** (vs the old "no price
for this region"), and **this figure is from an expired cache, dated {when}**.

### Proposal (no real alternatives — listed for your review)

- `CostUnavailable`: drop `Region` (impossible now — all enabled regions are covered), add
  `PriceUnavailable` — "couldn't get a price: the API failed and there's no cache, or it returned
  nothing". `MissingFact` stays.
- `EstimatedCost` gains `priced_at: Option<i64>` (unix seconds) — set **only** when the value came
  from an **expired** cache; `None` for a fresh value. The webview shows a "price cached {date}"
  note exactly when it's `Some`.
- `ScanResult`: `fx_usd_brl: f64` stays (0.0 when the rate is unavailable → the webview already
  degrades to USD-only in pt). Add `fx_as_of: Option<i64>` on the same "only when from an expired
  cache" rule, for a parallel "rate cached {date}" note.
- Qualifiers: unchanged.
- **HTTP client for the FX call:** a minimal `reqwest` (`rustls-tls`, `default-features = false`) —
  the AWS SDK's HTTP stack is awkward to point at a non-AWS host. Only pulled in if D1 = A/B.

### Decision: as proposed, plus PricePending (see D2e)

---

## Consequences (once decided)

Assuming **D1 = A, D2 = B + D2a–D2f as recommended, D3 = A, D4 = A, D5 = proposal + `PricePending`**:

### Deleted

`src-tauri/src/pricing/price-table.toml`; `RawTable` / `table()` / `estimate_*` / `pricing::tests`;
`pricing::fx_usd_brl()`.

### New — `src-tauri/src/pricing/`

- `estimate.rs` — the pure `estimate(rt, region, facts, &PriceBook) -> EstimatedCost`. Cost math
  formulas unchanged (GiB×rate, hourly×730, bytes/1e9×rate, allocated GB×rate); the rate comes
  from the `PriceBook` snapshot, never from the network.
- `pricebook.rs` — `PriceBook` = the read snapshot loaded from the cache in one query at the top
  of `build_scan_result`. Entry: `Priced { usd_per_unit, priced_at: Option<i64> }` (expired ⇒
  `priced_at` Some) | `Failed` (failure marker seen) | *absent* (⇒ pending).
- `list_api.rs` — `aws-sdk-pricing` client pinned to `us-east-1`; one resolver fn per resource
  type building `GetProducts` `TermMatch` filters and parsing the OnDemand USD rate. **Filter
  attributes will need live iteration** against the real API (D3 caveat).
- `fx.rs` — the Frankfurter GET (`reqwest`) + parse (D1).
- `cache.rs` — `PriceCache` over `pricing-cache.sqlite3` (D4): `price_cache(service, product_key,
  region, price_json TEXT NULL, fetched_at INTEGER NULL, last_attempt_at INTEGER, PRIMARY
  KEY(service, product_key, region))` — `price_json` NULL = failure marker; `fx_cache(pair,
  rate REAL NULL, fetched_at INTEGER NULL, last_attempt_at INTEGER)`. Read helpers classify a row
  as fresh / stale / failed against the 3 d / 5 h windows; a `busy_timeout` covers the rare
  two-process overlap.
- `refresh.rs` — **the background refresher (D2/D2b).** One long-lived task, spawned via a
  `pricing_refresh_start` command and held in Tauri managed state (`PriceRefresher`,
  `Mutex<Option<JoinHandle>>` — start is idempotent, D2c). It:
  1. builds the work set — FX always; prices = 5 types × `StoredCredential.regions` **when
     connected** (D2a/D2f); filters to what's missing or past-window;
  2. fetches with a small concurrency cap (~6), SDK adaptive retry for throttling;
  3. writes each result (value or failure marker) to the cache;
  4. emits `pricing://refreshing` while step 2–3 is active for anything, `pricing://idle` when the
     work set is empty;
  5. sleeps ~30 min and re-checks (D2d); also wakes on a channel nudge sent by `scan.rs` when a
     scan finishes with a region not yet cached.
  Layered resolution (fresh → API → keep-expired → failure-marker) lives **only here**.

### Changed

- **`scan.rs`:** no price/FX network work. After a scan, if any scanned region isn't in
  `price_cache`, send the refresher a nudge. `build_scan_result` gets its `PriceBook` from a single
  cache read.
- **`store/mod.rs`:** `build_scan_result` / `scan_result_from_conn` take `&PriceCache` (or a
  pre-loaded `&PriceBook`); `into_item` calls `estimate(rt, region, facts, price_book)`.
- **`model.rs`:** `CostUnavailable` → drop `Region`, add **`PricePending`** and **`PriceUnavailable`**
  (D2e). `EstimatedCost` gains `priced_at: Option<i64>`. `ScanResult.fx_usd_brl: f64` →
  `fx: FxStatus { rate: f64, as_of: Option<i64>, state: 'fresh'|'stale'|'pending'|'unavailable' }`.
  Mirrored in `core/models/scan.ts`.
- **`commands.rs` / `lib.rs`:** `.manage(PriceCache::open(app_local_data_dir()))`,
  `.manage(PriceRefresher::default())`; new command `pricing_refresh_start`.
- **Frontend:**
  - New `core/pricing/` — a tiny store + `TauriEventsService` subscription to
    `pricing://refreshing` / `pricing://idle` driving one signal `refreshing()`.
  - New component near the account header (in `main-view.component.ts`), **separate from the cost
    panel and detector list**, rendered only while `refreshing()` — "Atualizando preços em segundo
    plano…". Position + copy tuned on screen.
  - `App` (or `MainView`) calls `pricing_refresh_start` once after the connection resolves.
  - `resource-row.component.ts` `costChip` — branches for `priced_at` (→ "preço em cache de
    {data}"), `PricePending` (→ "preço ainda não disponível — atualização em andamento"),
    `PriceUnavailable` (→ "falha ao consultar o preço na AWS").
  - `format/cost.ts` — reads `fx.rate`; already degrades to USD-only when it's 0. A "câmbio ~{data}"
    note where the headline BRL shows when `fx.state === 'stale'`.
  - New i18n keys (`cost.pricePending`, `cost.priceStale`, `cost.priceLookupFailed`, `cost.fxStale`,
    `pricing.refreshing`), both locales — **copy rough**.
- **`docs/iam-policy-minimal.json`:** + `pricing:GetProducts`.
- **`Cargo.toml`:** + `aws-sdk-pricing`, + `reqwest` (`rustls-tls`, `default-features = false`).
- **`docs/development.md` / READMEs:** replace the price-table section with the API + cache +
  background-refresher model; the README security section gains the one-sentence non-AWS-host
  disclosure (D1).
- **`tests/localstack.rs`:** pricing assertions move from "table lookup" to "against a `PriceBook`
  fixture" (LocalStack has no Price List API).

### Tests

- `estimate` against a hand-built `PriceBook` — all 5 types, `Priced` fresh / `Priced` expired
  (carries `priced_at`) / `Failed` / absent.
- `cache.rs` — fresh vs the 3-day / 5-hour boundary; failure-marker round-trip; upsert.
- `refresh.rs` work-set builder — missing + expired selected, fresh skipped; connected vs not
  (FX only).
- each `list_api` resolver's JSON parse against a captured sample response.
- `reducer`-style test of the front `refreshing()` signal from the two events.
- Real API / real Frankfurter calls stay manual (CLAUDE.md).

### Deviations to expect (report)

- `reqwest` — first non-AWS runtime dependency in the core; `api.frankfurter.dev` — first non-AWS
  network call in the product. Both direct consequences of D1.
- The background refresher + its command + events + the front component are infrastructure the
  earlier scopes didn't need — in service of "the scan never waits on price I/O".

## Open questions for the decider

D1, D3, D4, D5 are **accepted**. Remaining, before implementation:

1. **D2a** — the price refresher warms `5 types × StoredCredential.regions` while connected, FX
   always (recommended)? Or re-discover regions / warm all AWS regions?
2. **D2b** — orchestration: a `pricing_refresh_start` command spawning one long-lived Rust task
   that emits `pricing://refreshing` / `pricing://idle`, self-re-checks every ~30 min, and takes a
   nudge from `scan.rs` (recommended)? Or a pure Rust timer with no command?
3. **D2c** — dedup via the managed-state task handle + SQLite `busy_timeout` for the two-instance
   case (recommended), no cross-process lock row?
4. **D2e** — two `CostUnavailable` variants (`PricePending` vs `PriceUnavailable`) and an
   `FxStatus` struct on `ScanResult` replacing the bare `f64` (recommended)?
5. **D2f** — a cold-cache first scan showing every priced row as "pending" (with the banner up) is
   acceptable, self-explanatory, and not treated as an error — OK?
6. Copy for all the new messages ships functional-but-rough, refined on screen — OK?
