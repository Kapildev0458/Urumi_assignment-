# Urumi — WooCommerce hosting with a Team MCP Gateway

A Kubernetes platform that runs a WooCommerce store, a self-written WooCommerce MCP server,
and a team MCP gateway (dashboard + backend + chat agent) that fans out to every registered
MCP server through one endpoint. Same Helm charts locally (k3d) and on a VPS (k3s).

## Repository layout

```
apps/          woo-mcp, notes-mcp, time-mcp (upstream MCP servers), gateway (backend), dashboard (React)
charts/        Helm charts: umbrella "platform" (values-local/prod) + one chart per component
k3d/           local cluster definition + ingress smoke test
scripts/       PowerShell helpers: prerequisites, cluster up/down, build images, deploy
docs/          brief (ASSIGNMENT.md), system design and tradeoffs (ARCHITECTURE.md), threat model (THREAT-MODEL.md)
```

- **System design and tradeoffs:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Threat model:** [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)
- **End-to-end check:** [`scripts/dod-check.ps1`](scripts/dod-check.ps1) runs the whole Definition
  of Done with two users, plus every stand-out item below, against the cluster.

## Bonus and stand-out items

| Item | Status | Where |
|---|---|---|
| Bonus: multi-store provisioning | Not attempted | — |
| 1. Production-like VPS deployment | **Done:** live on Azure k3s with Let's Encrypt TLS, same charts plus `values-prod.yaml`, full `dod-check.ps1` passes. <https://app.4.194.15.15.sslip.io> | [`scripts/vps-setup.sh`](scripts/vps-setup.sh), "Production-like VPS (k3s)" below |
| 2. Tool permissions | Done: per role, per tool or whole server; hidden from the list *and* rejected by name | `allowed()`, `listTools()`, `callTool()` in [`apps/gateway/src/upstreams.ts`](apps/gateway/src/upstreams.ts); `PUT /api/servers/:id/permissions`; Servers page |
| 3. OAuth on the gateway | Not attempted | — |
| 4. Handling many tools | Done: `gateway__search_tools` + `gateway__call_tool` (`/mcp?tools=search`, chat search mode) | `META_TOOLS`, `rankTools()` in `upstreams.ts`; [`apps/gateway/src/chat.ts`](apps/gateway/src/chat.ts) |
| 5. Hosted MCP servers | Not attempted | — |
| 6. Security hardening | Done, except WordPress (Apache) still starts as root | Default-deny NetworkPolicy + per-component policies, non-root containers, SSRF guard (`checkUpstreamUrl` in [`api.ts`](apps/gateway/src/api.ts)), AES-256-GCM credentials, no service-account tokens (no component uses the Kubernetes API, so no RBAC), [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) |
| 7. Scaling | Done: rate limits per key and per user, shared across replicas; multiple gateway replicas | [`apps/gateway/src/ratelimit.ts`](apps/gateway/src/ratelimit.ts); `gateway.replicas` |
| 8. Observability | Done: per-server calls, error rate, p50/p95; Prometheus `/metrics`; reasons for unreachable servers and failed calls | Audit page, `GET /api/stats`, [`apps/gateway/src/metrics.ts`](apps/gateway/src/metrics.ts) |
| 9. Upgrades and rollback | Documented | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), "Upgrades and rollback" |

## Local environment

### Prerequisites

| Tool | Install (Windows) |
|---|---|
| WSL2 | `wsl --install` in an **admin** terminal, then reboot |
| Docker Desktop | `winget install -e --id Docker.DockerDesktop` (WSL2 backend), start it once |
| kubectl, Helm, k3d | `winget install -e --id Kubernetes.kubectl`, `Helm.Helm`, `k3d.k3d` |
| Node.js 20+ | `winget install -e --id OpenJS.NodeJS.LTS` |

Check everything with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\check-prereqs.ps1
```

### Start / stop the cluster

```powershell
powershell -ExecutionPolicy Bypass -File scripts\cluster-up.ps1        # create or start + smoke test
powershell -ExecutionPolicy Bypass -File scripts\cluster-down.ps1 -Stop # stop, keep data
powershell -ExecutionPolicy Bypass -File scripts\cluster-down.ps1       # delete everything
```

`cluster-up.ps1` creates a single-node k3d cluster named `urumi` (k3s `v1.35.5-k3s1`, the same
version we install on the VPS), then runs a smoke test: it pushes an image to the local
registry, deploys it behind an Ingress and fetches `http://hello.127.0.0.1.nip.io`.

What the cluster provides:

| Piece | Local value |
|---|---|
| kubectl context | `k3d-urumi` |
| Ingress controller | Traefik (bundled with k3s), `ingressClassName: traefik`, host ports 80/443 |
| Storage | `local-path` StorageClass (bundled with k3s); data survives `-Stop`, not delete |
| Image registry | push to `localhost:5000/<image>:<tag>`; pods use the same reference |
| NetworkPolicy | enforced (k3s ships an embedded network-policy controller) |

### Local domains

We use **[nip.io](https://nip.io)** wildcard DNS: any name ending in `.127.0.0.1.nip.io`
resolves to `127.0.0.1`, where k3d forwards ports 80/443 to Traefik. No hosts-file edits and
every service gets a stable URL:

| URL | Service |
|---|---|
| `http://store.127.0.0.1.nip.io` | WooCommerce storefront + `/wp-admin` |
| `http://app.127.0.0.1.nip.io` | Dashboard (`/`), backend API (`/api`), gateway MCP endpoint (`/mcp`) |

The base domain is a single Helm value (`global.domain`), so production only changes it to a
real domain (see `values-prod.yaml`).

**Fallback** if your router or DNS blocks nip.io (DNS-rebinding protection): add to
`C:\Windows\System32\drivers\etc\hosts` (admin editor):

```
127.0.0.1 store.127.0.0.1.nip.io app.127.0.0.1.nip.io hello.127.0.0.1.nip.io
```

## Deploying

From a fresh clone, after `cluster-up.ps1`: build and push the images to the k3d registry, then
deploy. The first deploy takes several minutes (WordPress and WooCommerce install in a Job).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-images.ps1                # writes charts\platform\values-images.yaml
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1                      # local (values-local.yaml)
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Environment prod    # VPS (values-prod.yaml)
```

The chat agent also needs an LLM key in a Secret; see "Chat agent" below. Everything else works
without it.

`charts/platform` is an umbrella chart. Each component is its own chart, so it can also be
installed alone: `store`, `woo-mcp`, `notes-mcp`, `time-mcp`, `gateway` (with its PostgreSQL)
and `dashboard`.

## Production-like VPS (k3s)

The same charts deploy to a single-node k3s server with `values-prod.yaml`; only values change.
[`scripts/vps-setup.sh`](scripts/vps-setup.sh) does the whole setup on a fresh Ubuntu VM.

> **Live:** deployed with exactly these steps on an Azure VM (Ubuntu 24.04, Standard_B2as_v2,
> Southeast Asia), with Let's Encrypt HTTPS:
> - storefront: <https://store.4.194.15.15.sslip.io>
> - dashboard: <https://app.4.194.15.15.sslip.io>
> - MCP endpoint: `https://app.4.194.15.15.sslip.io/mcp`
>
> `scripts/dod-check.ps1 -Domain 4.194.15.15.sslip.io -Https -AdminEmail admin@example.com` passes
> against it with 0 failures (kubectl through an SSH tunnel; the API port is not opened).
>
> The deployment found two bugs that the local cluster could not:
> - with TLS, woo-mcp signed OAuth against `http://` (fixed by `woo-mcp.store.publicTls`);
> - the default-deny NetworkPolicy blocked cert-manager's HTTP-01 solver pods (fixed by
>   `allow-acme-http01-solver`).
>
> The upgrade that shipped the second fix was a normal `helm upgrade` (revision 2).

**1. A server.** Ubuntu 24.04, 2 vCPU, 8 GB RAM (4 GB minimum), 30 GB disk, with TCP 22, 80 and
443 open. Any provider works; with the Azure CLI, for example:

```bash
az group create -n urumi-rg -l centralindia
az vm create -g urumi-rg -n urumi-vps --image Ubuntu2404 --size Standard_B2as_v2 \
  --admin-username azureuser --generate-ssh-keys --public-ip-sku Standard --os-disk-size-gb 64
az vm open-port -g urumi-rg -n urumi-vps --port 80,443 --priority 1010
```

**2. A domain.** Use `<public-ip>.sslip.io`, a wildcard DNS like nip.io, so `store.` and `app.`
resolve with no setup. With your own domain, point `store.<domain>` and `app.<domain>` (A records)
at the server.

**3. Deploy** (on the server):

```bash
git clone https://github.com/Kapildev0458/Urumi_assignment- urumi && cd urumi
sudo DOMAIN=<public-ip>.sslip.io bash scripts/vps-setup.sh            # HTTPS via Let's Encrypt
sudo DOMAIN=<public-ip>.sslip.io TLS=false bash scripts/vps-setup.sh  # or plain HTTP
```

The script:
1. Installs k3s at the same version as local (`v1.35.5+k3s1`, Traefik and `local-path` included),
   then Helm and Docker. Docker only builds the images.
2. With TLS, installs cert-manager and a `letsencrypt-prod` ClusterIssuer (HTTP-01 through Traefik).
3. Builds the five app images on the server and imports them into k3s's containerd. No registry
   is needed, and the tags go into a generated `values-images.yaml`, as locally.
4. Runs `helm upgrade --install urumi charts/platform -f values-prod.yaml -f values-images.yaml --set global.domain=<domain>`.
5. Prints the URLs and how to read the admin password.

**4. Chat agent:** create the LLM Secret as in "Chat agent" below, with `sudo k3s kubectl` instead
of `kubectl`, then restart the gateway.

**5. Use it:** open `https://app.<domain>`. Connect Claude Code with
`claude mcp add --transport http urumi https://app.<domain>/mcp --header "Authorization: Bearer <key>"`.

**Upgrade and rollback:**
- Upgrade: `git pull`, then run the script again. It builds new image tags, and `helm upgrade` rolls
  the pods one by one behind their readiness probes.
- Roll back:
  `sudo helm --kubeconfig /etc/rancher/k3s/k3s.yaml -n urumi history urumi`, then `… rollback urumi <revision>`.
- See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), "Upgrades and rollback", for the database
  caveat.

**What changes from local to VPS** (all through Helm values):

| | Local (`values-local.yaml`) | VPS (`values-prod.yaml`) |
|---|---|---|
| DNS / domain | `127.0.0.1.nip.io` | `<ip>.sslip.io` or your domain (`--set global.domain`) |
| Ingress | Traefik, HTTP | Traefik, HTTPS: cert-manager annotations, `tls.enabled: true`, `Secure` cookies, https store URL for WooCommerce's OAuth signature |
| Storage | `local-path`, 2 Gi | `local-path` (single node), 10 Gi. On a multi-node cluster, only `storageClass` changes (Longhorn, a cloud disk class) |
| Secrets | Generated once by Helm (`lookup`), kept on upgrade; LLM key created with `kubectl` | Same. Back up `urumi-gateway-secrets`: without its `credentials-key`, stored upstream credentials can't be decrypted |
| Images | k3d registry `localhost:5000` | Built on the server, or a real registry (`image.repository`) |
| Replicas | gateway 2, others 1 | gateway 2, dashboard 2 |

## Store (`charts/store`)

| Piece | How |
|---|---|
| Database | MariaDB 11.4 StatefulSet, 2Gi PVC (`volumeClaimTemplates`), headless Service |
| WordPress | `wordpress:7.1.3-php8.3-apache` Deployment (`Recreate`), **only `wp-content` on a PVC** |
| Setup | Helm post-install/upgrade hook Job running WP-CLI (idempotent, safe to re-run) |
| Secrets | `<release>-store-credentials` (DB, admin password, WP salts) and `<release>-store-woo-api` (REST key for the MCP server), generated once with `lookup` and kept across upgrades |
| Network | NetworkPolicies: MariaDB accepts only WordPress + setup job; WordPress accepts only Traefik, the setup job and pods labelled `app.kubernetes.io/component: woo-mcp` |
| Probes | startup + readiness + liveness on every container; requests/limits everywhere |

The setup job installs WordPress, the Storefront theme and WooCommerce, then:
- turns off "coming soon" mode
- enables **Cash on delivery**
- turns off shipping, so checkout needs no zones
- creates the shop, cart and checkout pages, plus one sample product
- registers the REST API key from the Secret

Design decisions:
- **Only `wp-content` is persisted.** WordPress core comes from the image, so upgrading or rolling back WordPress is just a change of `wordpress.image.tag` plus `helm rollback`. Plugins, themes and uploads survive.
- **The API key is generated in Helm, not in WordPress.** It exists as a Kubernetes Secret from the first install. The setup job inserts its HMAC into `wp_woocommerce_api_keys` the same way WooCommerce's own UI does, so no component needs RBAC to write Secrets.
- **The job copies WordPress core from the same image tag as the site** into a scratch volume and mounts the shared `wp-content` PVC. WP-CLI therefore always matches the running site. It runs as uid 33 (`www-data`), so WordPress can still write every file it creates.
- **Volume access:** the job shares the RWO `wp-content` volume with WordPress. That's fine on single-node k3d/k3s. Multi-node would need RWX storage.

Useful commands:

```powershell
kubectl -n urumi logs job/urumi-store-setup                  # setup progress / errors
kubectl -n urumi get secret urumi-store-credentials -o jsonpath="{.data.wp-admin-password}"  # base64
```

## WooCommerce MCP server (`apps/woo-mcp`, `charts/woo-mcp`)

Self-written in TypeScript with the official MCP SDK. It speaks **Streamable HTTP** on
`POST /mcp` and is **stateless**: every request gets a fresh server and transport, so any
replica can answer and a restart loses nothing.

| Tool | WooCommerce call |
|---|---|
| `list_products` (search, status, paging) | `GET /wc/v3/products` |
| `create_product` (name, regular_price, description, sku, stock, status) | `POST /wc/v3/products` |
| `list_orders` (`date`: `today` / `yesterday` / `YYYY-MM-DD`, or `after`/`before`, status, search) | `GET /wc/v3/orders` |
| `get_order` (id) | `GET /wc/v3/orders/<id>` |
| `update_order_status` (id, status, optional note) | `PUT /wc/v3/orders/<id>` (+ `POST .../notes`) |

Results are compact JSON summaries, not raw WooCommerce objects, to save model context. Store
errors come back as MCP tool errors (`isError: true`) with the HTTP status and WooCommerce
message, and every store call has a timeout (`store.timeoutMs`, 10 s).

**How it talks to the store: the WooCommerce REST API.** We chose it for these reasons:
- It is the store's public, versioned contract (`wc/v3`). WooCommerce's validation, hooks,
  stock handling and order notes all run, the same as when an admin clicks in wp-admin. Writing
  to the database directly would skip all of that.
- It needs only an HTTP connection and one scoped key pair. WP-CLI would need the WordPress
  files and DB credentials inside the MCP pod (or `kubectl exec`, which needs RBAC). Both
  would give the MCP server far more power than it needs.
- The key is least-privilege. The MCP pod only gets the `<release>-store-woo-api` Secret,
  never the DB or admin passwords.

**Authentication detail.** Inside the cluster the server calls WordPress over plain HTTP
(`http://<release>-store-wordpress`). Over HTTP, WooCommerce rejects Basic auth and requires
**OAuth 1.0a one-legged signatures** (HMAC-SHA256, see `src/oauth.ts`). WooCommerce rebuilds the
signed URL from the site's *home URL*, not from the request's Host. So we sign against
`WOO_PUBLIC_URL` (`http://store.<domain>`; always `http://`, because `is_ssl()` is false for
in-cluster calls) and send the request to the internal Service.

**"Orders today"** means today in the *store's* timezone. The server reads WordPress's
`gmt_offset` and brackets the day with `after`/`before`. The pod's clock (UTC) is not used.

**Isolation:**
- The Service is ClusterIP only, with no Ingress.
- The `urumi-woo-mcp` NetworkPolicy admits only pods labelled
  `app.kubernetes.io/component: gateway`.
- The server also requires a bearer token (`<release>-woo-mcp-auth` Secret, generated once).
  The gateway registers it as this server's upstream credential.
- The pod runs as non-root with a read-only root filesystem and no service account token.

Develop and test locally (no cluster needed):

```powershell
cd apps\woo-mcp; npm install; npm test        # unit tests (OAuth signing, date ranges)
```

## Notes MCP server (`apps/notes-mcp`, `charts/notes-mcp`)

A second self-written upstream server: shared team notes. Same stack and shape as woo-mcp
(Streamable HTTP, stateless, `POST /mcp`).

| Tool | What it does |
|---|---|
| `add_note` (title, text) | Saves a note with a short id and timestamp |
| `list_notes` (optional search) | Newest first, optional case-insensitive word filter |
| `delete_note` (id) | Deletes one note; unknown id is a tool error (`isError: true`) |

- **Storage:** one JSON file (`NOTES_FILE=/data/notes.json`) on the `<release>-notes-mcp-data`
  PVC. Writes go to a temp file and are renamed, so a crash never leaves a half-written file. The
  PVC has `helm.sh/resource-policy: keep`, so uninstalling the release keeps the notes.
- **One writer:** a ReadWriteOnce volume and a single file, so `replicas: 1` with the `Recreate`
  strategy (the old pod stops before the new one starts).
- **Probes:** `/healthz` (process alive) and `/readyz` (data folder writable, notes file parses).
- **Isolation:** same as woo-mcp: ClusterIP only, NetworkPolicy admits only the gateway, bearer
  token in `<release>-notes-mcp-auth`, non-root, read-only root filesystem.

## Time MCP server (`apps/time-mcp`, `charts/time-mcp`)

The third upstream server: stateless and dependency-free, so it can run any number of replicas.
Same isolation as the other two (ClusterIP, gateway-only NetworkPolicy, bearer token).

| Tool | What it does |
|---|---|
| `current_time` (optional timezone) | Date, time, weekday and UTC offset in an IANA timezone (default `Asia/Kolkata`) |
| `convert_time` (ISO time, timezones[]) | One moment shown in several timezones |
| `date_diff` (from, to) | Minutes, hours and days between two dates |

## Gateway (`apps/gateway`, `charts/gateway`)

Node.js + TypeScript, official MCP SDK, PostgreSQL. Design details and trade-offs are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). In short:

- **One MCP endpoint**, `POST http://app.<domain>/mcp` (Streamable HTTP, stateless). The caller
  sends `Authorization: Bearer <personal API key>`.
  - `tools/list` returns the tools of every enabled, reachable server.
  - `tools/call` is routed to the right server, using that server's stored credential.
- **Name collisions:** every tool is exposed as `<server>__<tool>`, e.g. `woo__list_orders` or
  `notes__add_note`.
  - Server names are unique slugs (`[a-z][a-z0-9-]*`, so they can't contain `__`), and the first
    `__` always splits a name unambiguously.
  - So two servers that both have `search` become `notes__search` and `docs__search`.
  - Each description also starts with `[server]`.
- **Registry:** admins add, edit, disable and remove servers (URL + optional bearer token or
  custom header).
  - Credentials are encrypted at rest (AES-256-GCM, key in the `<release>-gateway-secrets` Secret).
  - They are decrypted only to call the upstream. The API only ever says `hasCredential: true`.
- **Status:**
  - Every 15 s the gateway connects to each enabled server and lists its tools, with a 5 s timeout.
  - The status is Connected, Unreachable (with the reason) or Disabled.
  - A dead or slow server is skipped in `tools/list`. Calls to it fail fast with a clear error;
    other servers are unaffected.
  - Calls time out after 30 s.
- **Users and keys:**
  - There are two roles, admin and member.
  - Admins invite people with a one-time invite link (no mail server is needed).
  - Every user can generate their own API keys; admins can issue keys for anyone and revoke any key.
  - Keys are shown once and stored only as a SHA-256 hash. They are 256-bit random, so a fast
    hash is safe. Passwords use scrypt.
- **Tool permissions** (per role): on the Servers page an admin ticks *admins only* on a tool,
  or on a whole server.
  - Members no longer see that tool in `tools/list`, in the chat or on the Servers page.
  - A member who calls it by name gets "Tool '…' is restricted to admins", audited as `denied`.
  - Example from the brief: make `woo__create_product` and `woo__update_order_status` admin-only.
    Members can still read products and orders.
  - Stored in `tool_restrictions`, and read on every list and call like the enabled flag, so a
    change applies at once on every replica (`PUT /api/servers/:id/permissions`).
- **Many tools (search mode):** with ten servers a client can face hundreds of tools. Connect to
  `http://app.<domain>/mcp?tools=search` and the client gets just two meta-tools:
  - `gateway__search_tools(query)`: keyword search over the tools you may use, returning names,
    descriptions and input schemas;
  - `gateway__call_tool(name, arguments)`: runs one of them through the normal routing,
    permissions and audit.

  The chat agent switches to this mode automatically above `toolSearchThreshold` (40) tools, or
  when you tick *Tool search mode* on the Chat page. `gateway` is a reserved server name, so no
  upstream can shadow these tools.
- **Rate limits** (scaling): 120 MCP requests per minute per API key (HTTP 429 with
  `Retry-After`, audited as `denied`) and 10 chat messages per minute per user (each one spends LLM
  credits). Counted per minute in PostgreSQL, so the limit holds across replicas. Set them with
  `gateway.rateLimit.*` (0 = off).
- **Replicas** (scaling): the gateway is stateless. MCP is stateless, and sessions, rate limits
  and the latest health check per server live in PostgreSQL. So both `values-local.yaml` and
  `values-prod.yaml` run 2 replicas, and `scripts\dod-check.ps1` passes against them.
- **Observability:**
  - The Audit page shows, per server for the last 24 h: calls, error rate, denied calls, and p50/p95
    latency (`GET /api/stats`, computed from the audit log, so it covers every replica).
  - Prometheus metrics on the pod port, not routed by the Ingress:
    `urumi_tool_calls_total{server,tool,via,outcome}`, `urumi_tool_call_duration_seconds` (histogram)
    and `urumi_upstream_up{server,status}`. Try
    `kubectl -n urumi exec deploy/urumi-gateway -- node -e "fetch('http://localhost:3000/metrics').then(r=>r.text()).then(console.log)"`.
  - Why something failed: the Servers page shows each unreachable server's reason (`ECONNREFUSED`,
    `timed out after 5000 ms`, HTTP status), and failed calls return and audit the error text.
- **Audit log:** every tool call is recorded with user, via (`mcp` or `chat`), server, tool, time,
  duration and outcome (`success`, `error` or `denied`).
  - Requests with a revoked key, and calls to a restricted tool, are recorded as `denied` under the
    user.
- **Seeding:** on first start the gateway creates the admin (`admin.email`, generated password)
  and registers woo, notes and time.
  - The tokens are read from each server's generated auth Secret, so nobody types or stores them.
  - Each seed is applied only once, so an admin can later edit or remove the servers.

```powershell
kubectl -n urumi get secret urumi-gateway-secrets -o jsonpath="{.data.admin-password}"   # base64; login: admin@urumi.local
cd apps\gateway; npm install; npm test      # unit tests (encryption, hashing, keys, tool permissions)
```

## Dashboard (`apps/dashboard`, `charts/dashboard`)

React 19 + Vite, built into static files and served by unprivileged nginx. The Ingress for
`app.<domain>` sends `/` to the dashboard and `/api`, `/mcp` to the gateway (two Ingress objects on
the same host). Pages:

- **Servers:** status, tools, add/edit/disable/remove.
- **Chat**
- **My API keys:** generate or revoke, plus copy-paste setup for Claude Code, Cursor and Inspector.
- **Members** (admin): invite, issue or revoke keys, change role, disable a user.
- **Audit log**

Sessions are httpOnly `SameSite=Lax` cookies. Every state-changing API call must also carry
`X-Requested-With: urumi`, which a cross-site page cannot send without a CORS preflight.

## Chat agent

The tool loop runs **inside the gateway, as the logged-in user**. It uses the same aggregated
tool list as `/mcp`, and every call goes through the same routing code, so it shows up in the audit
log under that user with `via = chat`. The chat page shows each tool the model called, with its
arguments and result.

Providers:
- `anthropic`: Claude, via the official Anthropic SDK. Default model `claude-opus-5-5`.
- `openai`: any OpenAI-compatible Chat Completions API: OpenAI, OpenRouter, Groq, Gemini's OpenAI
  endpoint, or a local Ollama.

The key is never in values files. Put it in a Secret that Helm does not manage, then restart the
gateway:

```powershell
# Claude
kubectl -n urumi create secret generic urumi-gateway-llm --from-literal=provider=anthropic --from-literal=api-key=<key>
# ...or any OpenAI-compatible API (example: Groq)
kubectl -n urumi create secret generic urumi-gateway-llm --from-literal=provider=openai --from-literal=api-key=<key> `
  --from-literal=base-url=https://api.groq.com/openai/v1 --from-literal=model=llama-3.3-70b-versatile
kubectl -n urumi rollout restart deployment urumi-gateway
```

Without the Secret, everything else works and the chat page says "LLM not configured".

## Demo: the Definition of Done, step by step

All URLs are local; see "Local domains". Use two browsers (or one private window) for the two
users.

1. **Store:** open `http://store.127.0.0.1.nip.io`, add a product to the cart, check out with
   *Cash on delivery*. The order shows in `wp-admin` → WooCommerce → Orders.
2. **Admin (user A):** log in at `http://app.127.0.0.1.nip.io` as `admin@urumi.local`.
   - **Servers** shows woo, notes and time as Connected, with their tools.
   - To show "add by URL": remove `time`, then add it again with URL `http://urumi-time-mcp/mcp`,
     type *Bearer*, and the token from
     `kubectl -n urumi get secret urumi-time-mcp-auth -o jsonpath="{.data.token}"` (base64-decode it).
3. **Invite user B:** **Members** → invite `bob@example.com` → open the link in the other browser
   and set a password. B opens **My API keys** → *Generate key*.
4. **Chat as A** (needs the LLM Secret):
   - *"Create a product called Blue Mug priced at 12.50"*. The product is on the storefront.
   - Order it on the storefront by hand, then ask *"What orders came in today?"*.
5. **External client as B** (Claude Code):
   - `claude mcp add --transport http urumi http://app.127.0.0.1.nip.io/mcp --header "Authorization: Bearer <B's key>"`
   - `/mcp` lists all tools.
   - Ask *"What orders came in today?"*.
   - Cross-server: *"Save a note summarising today's orders and include the current time in Asia/Kolkata"*
     (woo + notes + time).
6. **Revoke:** as A, **Members** → revoke B's key. B's next call fails with "API key has been revoked".
7. **Disable:** **Servers** → *Disable* notes. Its tools are gone from the chat and from B's
   `tools/list`. Claude Code keeps the tool list it fetched at connect time, so run `/mcp` →
   *Reconnect* to see them disappear; calling one directly is rejected right away
   ("Server 'notes' is disabled").
8. **Kill an upstream:** `kubectl -n urumi scale deploy/urumi-time-mcp --replicas=0`.
   - Within 15 s (or press *Check*) time shows **Unreachable** (`ECONNREFUSED`, or "timed out after 5000 ms" while the pod is still shutting down); woo and notes keep
     working.
   - Bring it back with `--replicas=1`.
   - `kubectl delete pod` works too, but the Deployment replaces the pod within seconds.
9. **Audit log:** every call above, with user, via, server, tool, duration and outcome, and B's
   rejected call as `denied`.

### Troubleshooting

- *Port 80 in use*: `check-prereqs.ps1` names the process; stop it (often IIS: `iisreset /stop`).
- *Pods stuck in `ContainerCreating` / "Progress deadline exceeded" on first deploy*: pulls from
  inside the k3d node can be far slower than Docker Desktop's own. `deploy.ps1` (local) therefore
  pulls every third-party image on the host and loads it into the node with `ctr images import`.
  `k3d image import` is not used: with Docker Desktop's containerd image store it fails with
  "content digest not found" and still reports success. After a timeout, re-running
  `deploy.ps1` is safe. If a release is stuck in `pending-upgrade`, run
  `helm -n urumi rollback urumi`.
- *WooCommerce install fails with "Minimum WordPress requirement"*: bump `wordpress.image.tag`
  and `woocommerce.version` together in `charts/store/values.yaml`.
- *A brand-new pod is refused by a NetworkPolicy for its first seconds*: k3s's policy controller
  (kube-router) needs a moment to add the pod's IP. Clients should retry, which the gateway will.
- *Scripts blocked*: always run them with `powershell -ExecutionPolicy Bypass -File ...`.
- *Cluster state*: `kubectl get pods -A`, `k3d cluster list`, `docker ps`.
