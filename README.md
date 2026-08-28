# CostTracer

🇺🇸 English (this file) | 🇧🇷 [Leia em português](README.pt-BR.md)

> Local-first AWS cost visibility tool. Tracks idle resources over time to confirm real waste — read-only, no credentials ever leave your machine.

🚧 **Status:** Early development — currently working on **Scope 1: AWS connection flow**. No functional release yet.

---

## The Problem

In cloud environments, financial waste is silent and cumulative. Developers and infrastructure teams routinely spin up resources for testing or temporary needs — unattached disks, static IP addresses, network gateways, log retention — and forget to tear them down. The result is hundreds or thousands of dollars burned every month before anyone notices the impact on the bill.

Most existing tools require pasting AWS credentials into a third-party web platform (SaaS), which many companies explicitly forbid for compliance and governance reasons. That's a real adoption blocker, not just a preference.

## The Solution

CostTracer is a desktop application that audits your AWS account for idle and wasteful resources, running **100% locally** on your machine. It inspects your account, flags likely waste, estimates its accumulated cost, and — critically — **confirms that waste over time** before you ever act on it. No credential, no account data, and no telemetry ever leaves your computer.

### The three pillars

1. **Collector** — talks to AWS, read-only, gathers the current state of resources.
2. **History** — persists what was observed over time, turning a one-off "suspicion" into a confirmed pattern.
3. **Confidence** — surfaces how certain the tool is that something is waste, based on accumulated history, in plain language the user can trust.

Most tools in this space only do #1. CostTracer is designed around all three from the start.

## Why local-first

- No sign-up, no external account, no server storing your data.
- Uses credentials you provide or already have configured — you choose how: auto-detected local AWS config, manual Access Key entry, or SSO. Nothing is required to be pre-installed on your machine.
- Every credential is checked for excessive permissions before use, with a minimal recommended IAM read-only policy provided and ready to copy — see [`docs/iam-policy-minimal.json`](docs/iam-policy-minimal.json).
- v1 is entirely **read-only**. No write or delete action exists in this phase.

## Tech Stack

- **Core:** Rust + Tauri v2 — native performance, low memory footprint, no bundled browser runtime.
- **UI:** Angular + TypeScript — typed, structured dashboards and interactive tables.
- **Storage:** local only (no cloud backend).

## Roadmap

- **Phase 0 — Honest visibility** *(current)*: read-only scan, estimated cost, temporal confirmation mechanism (a resource must show up as idle across multiple scans before being flagged as confirmed waste). No write actions.
- **Phase 1 — Reliability & coverage**: more resource types, multi-region support, exception/allowlist system (e.g. tag-based exclusions) to reduce false positives.
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
