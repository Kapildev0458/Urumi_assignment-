# Architecture

How the WooCommerce hosting platform and its team MCP gateway fit together, and why each design
choice was made. Setup and the demo walkthrough are in the [README](../README.md); the brief is in
[ASSIGNMENT.md](ASSIGNMENT.md).

## Components

```
                         Internet / browser / MCP clients (Claude Code, Cursor, Inspector)
                                               │
                                     Traefik Ingress (k3s)
              ┌────────────────────────────────┼─────────────────────────────────┐
   store.<domain>/                    app.<domain>/                  app.<domain>/api, /mcp
              │                                │                                 │
     ┌────────▼────────┐             ┌─────────▼────────┐             ┌──────────▼──────────┐
     │ WordPress +     │             │ dashboard        │             │ gateway             │
     │ WooCommerce     │             │ (React, nginx)   │             │ REST API + MCP      │
     └────────┬────────┘             └──────────────────┘             │ server + MCP client │
              │                                                       │ + chat agent loop   │
     ┌────────▼────────┐                                              └──┬──────┬──────┬──┬─┘
     │ MariaDB         │        ┌──────────────────┐  only gateway pods  │      │      │  │
     │ (StatefulSet)   │        │ PostgreSQL       │◄────────────────────┘      │      │  │
     └─────────────────┘        │ users, keys,     │                            │      │  │
              ▲                 │ servers, audit   │      Bearer token per server │      │  │ HTTPS
              │ REST (OAuth1)   └──────────────────┘                            │      │  │
     ┌────────┴────────┐                             ┌──────────────┐ ┌─────────▼──┐ ┌─▼──────────┐
     │ woo-mcp         │◄────────────────────────────┤ notes-mcp    │ │ time-mcp   │ │ LLM API    │
     │ (ClusterIP)     │   (all upstreams admit      │ (PVC, JSON)  │ │ (stateless)│ │ (optional) │
     └─────────────────┘    only gateway pods)       └──────────────┘ └────────────┘ └────────────┘
```

Every box runs in the cluster from its own Helm chart, and `charts/platform` pulls them together.
The three upstream MCP servers have no Ingress and are ClusterIP only. A NetworkPolicy lets in only
pods labelled `app.kubernetes.io/component: gateway`, and each server also checks its own bearer
token. So nothing but the gateway can talk to them: the browser, external clients and the chat
agent all go through it.

## Request flows

**External client (user B, Claude Code):**
1. The client sends `POST /mcp` with `Authorization: Bearer ugw_…`.
2. The gateway hashes the key with SHA-256, looks it up, and rejects it if it is revoked or its
   user is disabled. A revoked key is still audited as `denied` under its owner.
3. A fresh low-level MCP `Server` is created for this request and bound to that user (stateless
   Streamable HTTP, JSON responses).
4. `tools/list`: the gateway reads which servers are enabled *from the database on every call*,
   so a disable takes effect at once on every replica. It then takes each reachable server's
   cached tool list and prefixes the names.
5. `tools/call woo__list_orders`:
   - The gateway splits the name at the first `__` and loads server `woo`.
   - It decrypts the stored credential and opens a short-lived MCP client to the upstream.
   - It calls `list_orders` with a timeout and writes the audit row.
   - It returns the upstream's result unchanged.

**Chat agent (user A, dashboard):**
1. The browser sends `POST /api/chat` with the text history and the session cookie.
2. The gateway runs the LLM tool loop *on the server* (at most 10 steps):
   - the model sees the same aggregated tools
   - each `tool_use` goes through the same `Upstreams.callTool` as `/mcp`, so it is audited under
     user A with `via = chat`
3. The reply comes back with the list of tool calls (name, arguments, result, duration), and the
   chat shows them.

Because the agent shares one code path with `/mcp`, the chat and external clients can never see
different tools or skip the audit.

**Health:** every 15 s (and right after an admin change), the gateway connects to each enabled
server and lists its tools. The result (Connected or Unreachable with a reason, plus latency) is
cached per replica and shown in the dashboard.

## Key decisions

| Decision | Why |
|---|---|
| Tool names `<server>__<tool>` | Collision-free by construction. Clients and LLMs accept `[A-Za-z0-9_-]`, and server slugs can't contain `__`, so the first `__` splits unambiguously. A description prefix `[server]` helps the model. Alternative considered: only prefix names that collide. Rejected, because tool names would then change when someone adds a server. |
| Stateless Streamable HTTP everywhere | Any gateway replica can serve any request; no sticky sessions, nothing lost on restart. Upstreams are stateless too, so the gateway opens a short-lived client per check and call. In-cluster this costs one extra small request (`initialize`) per call, and it means a restarted upstream never leaves a broken cached connection. |
| Dead upstream isolation | Health checks run in parallel, each with its own timeout (5 s). `tools/list` uses the cached snapshot, so a dead server never slows down listing. Calls fail fast with `ECONNREFUSED` or "timed out after N ms" as an MCP tool error (`isError: true`), which clients show and models can reason about. |
| PostgreSQL, not SQLite | Several gateway replicas share one database (see `values-prod.yaml`: 2 replicas). The schema is created at startup under an advisory lock, so replicas don't race. |
| Upstream credentials encrypted at rest | AES-256-GCM with a key in a Helm-generated Secret (`lookup`, so it is kept across upgrades, plus `resource-policy: keep`). They are decrypted only in memory to build the upstream request, and the API returns only `hasCredential`. |
| API keys: SHA-256, not bcrypt | Keys are 256-bit random values, so they can't be brute-forced and a slow hash adds nothing. A fast hash keeps every MCP request cheap. Passwords, which humans choose, use scrypt. |
| Seeded servers read tokens from Secrets | Each MCP chart generates its own token Secret. The gateway gets the token as an env var `secretKeyRef` and stores it encrypted, so nobody ever types or sees it. Seeds apply once, so admins stay in control afterwards. |
| LLM key outside Helm | `secretKeyRef … optional: true` to a Secret the user creates with `kubectl`. No key ever sits in values files, and the platform installs and runs without one. |
| Chat loop on the server | The browser never holds an LLM key or upstream credential, and calls are audited under the logged-in user. Claude goes through the official SDK, with server-side refusal fallback (`fallbacks: "default"`) and `effort: medium`. Other providers use the OpenAI-compatible API. |
| WooCommerce REST API | See README, "How it talks to the store" (OAuth 1.0a over in-cluster HTTP, least-privilege key). |
| Tool permissions per role | A `tool_restrictions` row (tool name, or `*` for the whole server) makes a tool admin-only. It is applied in the one shared `listTools`/`callTool` path, so `/mcp` and the chat can't disagree. Restricted tools are hidden from the list *and* rejected by name (`denied` in the audit), because hiding alone is not a security boundary. |

## Security summary

- **NetworkPolicies:**
  - upstream MCP servers ← gateway only
  - PostgreSQL ← gateway only
  - gateway and dashboard ← ingress controller only
  - MariaDB ← WordPress and setup job only
  - WordPress ← Traefik, setup job, woo-mcp
- **Containers:** non-root with numeric uids, read-only root filesystem, `drop: [ALL]`,
  `seccompProfile: RuntimeDefault`, no service-account token. No component calls the Kubernetes
  API, so no RBAC is needed.
- **SSRF:** admin-entered upstream URLs must be http(s), carry no userinfo, and may not be or
  resolve to link-local or cloud-metadata addresses (`169.254.0.0/16`, `fe80::/10`,
  `metadata.google.internal`). Cluster-internal names stay allowed on purpose, because that is
  where upstreams live.
- **Browser:**
  - httpOnly `SameSite=Lax` session cookie (`Secure` when TLS is on).
  - State-changing API calls need the `X-Requested-With` header, a CSRF guard.
  - CSP, `X-Frame-Options: DENY`.
- **Secrets:** nothing is hardcoded. Every password, token and key is generated by Helm into a
  Secret, or created by the operator (the LLM key).

## Local vs production (values diff)

The same charts are used everywhere; only values change.

| Value | `values-local.yaml` | `values-prod.yaml` |
|---|---|---|
| `global.domain` | `127.0.0.1.nip.io` | your domain (or `<vps-ip>.nip.io`) |
| TLS | off | on, cert-manager `letsencrypt-prod`. One cert `app-tls` is issued from the gateway Ingress and reused by the dashboard Ingress. Store TLS is set the same way. |
| Session cookie | `Secure` off | `Secure` on (follows `ingress.tls.enabled`) |
| Images | `localhost:5000/urumi/*` (k3d registry) | `ghcr.io/<you>/urumi-*` |
| Replicas | 1 each | gateway 2, dashboard 2 (stateless, shared PostgreSQL) |
| Storage | `local-path`, small | `local-path` (k3s), larger PVCs |
| Store resources and sample product | small, sample product on | larger, sample product off |

## Upgrades and rollback

- **Our apps** (gateway, dashboard, MCP servers):
  1. Build a new image tag.
  2. `helm upgrade` (`scripts/deploy.ps1`). Deployments roll pod by pod; readiness probes gate
     traffic.
  3. `helm rollback urumi <revision>` returns to the previous tag.
  The gateway schema is additive (`CREATE … IF NOT EXISTS`), so an older gateway runs fine
  against a newer database.
- **WordPress / WooCommerce:**
  - Core comes from the image and only `wp-content` is persisted. Upgrading is a change of
    `wordpress.image.tag` plus `woocommerce.version`; the setup job runs `wp core update-db`.
  - Roll back the image with `helm rollback`. A database migration that already ran is *not* undone
    by a rollback, so back up first: `kubectl exec … mariadb-dump`.
- **Secrets:** generated Secrets are read back with `lookup` on every upgrade, so they never
  rotate by accident. To rotate a token on purpose:
  1. Delete the Secret and run `helm upgrade`.
  2. Update the server's credential in the dashboard.

## Known limitations / next steps

- Status snapshots are per replica, so after an outage one replica can show "Connected" up to
  15 s before another.
- Tool permissions are per role (admin-only or everyone), not per user. Per-user allow lists
  would add a `user_id` column to `tool_restrictions`.
- Invites are copy-paste links, since there is no mail server.
- The chat history lives in the browser, and only text turns are sent back (each turn's tool loop
  is complete on the server).
