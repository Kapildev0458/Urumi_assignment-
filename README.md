# Urumi — WooCommerce hosting with a Team MCP Gateway

A Kubernetes platform that runs a WooCommerce store, a self-written WooCommerce MCP server,
and a team MCP gateway (dashboard + backend + chat agent) that fans out to every registered
MCP server through one endpoint. Same Helm charts locally (k3d) and on a VPS (k3s).

## Repository layout

```
apps/          application source: woo-mcp (done); notes-mcp, gateway, dashboard [upcoming]
charts/        Helm charts: umbrella "platform" (values-local/prod) + "store", "woo-mcp"
k3d/           local cluster definition + ingress smoke test
scripts/       PowerShell helpers to create, check and tear down the cluster
docs/          architecture and design decisions                             [upcoming]
```

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

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1                    # local (values-local.yaml)
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Environment prod  # VPS (values-prod.yaml)
```

`charts/platform` is an umbrella chart; each component (`charts/store`, later the MCP server,
gateway and dashboard) is its own chart so it can also be installed alone.

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

Build and push all images to the k3d registry, then deploy:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-images.ps1   # writes charts\platform\values-images.yaml
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

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
