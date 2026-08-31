# CostTracer

🇺🇸 English (this file) | 🇧🇷 [Leia em português](README.pt-BR.md)

> Local-first AWS cost visibility tool. Tracks idle resources over time to confirm real waste — read-only, no credentials ever leave your machine.

🚧 **Status:** **Phase 0 complete; Phase 1 underway.** Five scopes are closed and tagged:

- **`v0.1.0-scope1` — AWS connection flow.** Connect via auto-detected local AWS config, manual access-key entry, or IAM Identity Center (SSO) device authorization. Every identity is screened for over-broad permissions before use; credentials are stored in the OS-native vault, never in plain text.
- **`v0.2.0-scope2` — Idle-resource detectors.** Unattached EBS volumes, idle Elastic IPs, and orphan snapshots, with a local scan history (SQLite) and a four-level confidence scale (Observed → Persisting → Probable → Confirmed) that rises the longer a resource stays idle across scans. Every flagged resource carries a plain-language explanation; any resource can be marked *intentional* — a local-only flag, the tool never writes to AWS.
- **`v0.3.0-scope3` — Estimated cost.** Every flagged resource shows an estimated monthly cost from a fixed local price table (nine regions), rolled up per detector and per account. Primary in USD; in Portuguese an approximate BRL follows at a fixed rate. Resources in a region the table doesn't cover are counted separately, never approximated. No AWS Price List API call.
- **`v0.4.0-scope4` — Multi-region coverage** *(first scope of Phase 1)*. A scan discovers the account's enabled regions itself (`ec2:DescribeRegions`) and checks every one — no manual region choice. It runs region by region, showing results as each finishes and letting you cancel mid-run; regions already done stay saved. When the connected credential can't list regions, the tool says so plainly and doesn't guess a count or run a pointless scan.
- **`v0.5.0-scope5` — Two more detectors.** CloudWatch Logs groups with no retention policy (AWS keeps logs forever by default) and orphan RDS snapshots (a manual DB snapshot whose source instance is gone). Both plug into the existing history, confidence scale, and cost rollups. An empty log group still shows an honest `$0.00/mo` — flagged because hundreds of them are a signal, not hidden because one is cheap.

These tags mark closed scopes, not packaged downloads — there is no installer yet. Run from source: `npm install`, then `npm run tauri:dev`. Phase 1 continues (see Roadmap).

---

## The Problem

In cloud environments, financial waste is silent and cumulative. Developers and infrastructure teams routinely spin up resources for testing or temporary needs — unattached disks, static IP addresses, network gateways, log retention — and forget to tear them down. The result is hundreds or thousands of dollars burned every month before anyone notices the impact on the bill.

Most existing tools require pasting AWS credentials into a third-party web platform (SaaS), which many companies explicitly forbid for compliance and governance reasons. That's a real adoption blocker, not just a preference.

## The Solution

CostTracer is a desktop application that audits your AWS account for idle and wasteful resources, running **100% locally** on your machine. It inspects your account, flags likely waste, **estimates its monthly cost** from a fixed local price table, and — critically — **confirms that waste over time** before you ever act on it. No credential, no account data, and no telemetry ever leaves your computer.

### The three pillars

1. **Collector** — talks to AWS, read-only, gathers the current state of resources.
2. **History** — persists what was observed over time, turning a one-off "suspicion" into a confirmed pattern.
3. **Confidence** — surfaces how certain the tool is that something is waste, based on accumulated history, in plain language the user can trust.

Most tools in this space only do #1. CostTracer is designed around all three from the start — as of the current build, all three are in place: the collector (five detectors, run across every enabled region), the history (a local SQLite log of every observation), and the confidence layer (a four-level scale computed from that history).

## Why local-first

- No sign-up, no external account, no server storing your data.
- Uses credentials you provide or already have configured — you choose how: auto-detected local AWS config, manual Access Key entry, or SSO. Nothing is required to be pre-installed on your machine.
- Every credential is checked for excessive permissions before use, with a minimal recommended IAM read-only policy provided and ready to copy — see [`docs/iam-policy-minimal.json`](docs/iam-policy-minimal.json).
- v1 is entirely **read-only**. No write or delete action exists in this phase.

## Tech Stack

- **Core:** Rust + Tauri v2 — native performance, low memory footprint, no bundled browser runtime.
- **UI:** Angular + TypeScript — typed, structured dashboards and interactive tables.
- **Storage:** local only, no cloud backend — bundled SQLite for scan history, the OS-native vault for credentials.

## Roadmap

- **Phase 0 — Honest visibility** *(complete)*: read-only scan, estimated cost, and temporal confirmation (a resource must stay idle across multiple scans before it counts as confirmed waste). No write actions.
  - ✅ AWS connection flow + permission audit + native vault — `v0.1.0-scope1`
  - ✅ Idle-resource detectors (EBS, Elastic IP, snapshot) + scan history + four-level confidence scale — `v0.2.0-scope2`
  - ✅ Estimated monthly cost per flagged resource, per detector, and per account (fixed local price table, USD with a pt-only approximate BRL) — `v0.3.0-scope3`
- **Phase 1 — Reliability & coverage** *(in progress)*: multi-region support, more resource types, and an exception system to reduce false positives (✅ local "mark as intentional" since Scope 2, never writes to AWS; recognising existing AWS tags was evaluated and deliberately deferred to preserve the "connect and it works, no prior setup in your account" pitch — product backlog).
  - ✅ Multi-region coverage — auto-discovered regions, progressive region-by-region scan, cancellable — `v0.4.0-scope4`
  - ✅ CloudWatch Logs (no retention) + orphan RDS snapshot detectors — `v0.5.0-scope5`
- **Phase 2 — Assisted action**: opt-in dry-run simulation and, eventually, guarded execution — starting only with the resource types the confidence layer trusts most.
- **Phase 3 — Multi-account**: relevant for organizations using AWS Organizations; not a near-term priority.

## Security Model

CostTracer follows a zero-trust-by-design approach:

- Never requires write permissions in Phase 0.
- Validates the connected identity via `sts:GetCallerIdentity`.
- Checks for over-privileged credentials and warns the user, offering a minimal-permission IAM policy to copy and apply instead.
- Stores any credential in the OS-native secure vault (Keychain / Credential Manager / Secret Service) — never in plain text.

## License

MIT — see [LICENSE](LICENSE) for details.
