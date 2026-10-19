# Urumi — interview take-home (deadline 2026-10-26)

WooCommerce hosting platform with a team MCP gateway on Kubernetes (k3d locally, k3s on a VPS,
same Helm charts).

At the start of every session:
1. Read [`PROGRESS.md`](PROGRESS.md) — what is done, what is next, the day plan.
2. The full brief is in [`docs/ASSIGNMENT.md`](docs/ASSIGNMENT.md); the Definition of Done there
   is what gets graded. Check new work against it.
3. Setup and design details are in [`README.md`](README.md).

At the end of every session (or after finishing a checklist item), update `PROGRESS.md`:
tick boxes (`[x]` only when verified in the cluster, `[~]` when written but untested), update
"Current status" and add a dated line to the log.

Environment: Windows 11 + WSL2 + Docker Desktop. Scripts are PowerShell; run them with
`powershell -ExecutionPolicy Bypass -File scripts\<name>.ps1`.
