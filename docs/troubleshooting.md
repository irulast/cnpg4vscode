# Troubleshooting

Common gotchas. If your issue isn't here, run **CNPG: Report a
Problem** (Command Palette) and paste the generated Markdown into a
new issue.

## Cluster discovery

### "No kubeconfig found"

The extension resolves the kubeconfig path the same way `kubectl`
does:

- `$KUBECONFIG` env var if set
  - macOS / Linux: colon-separated list of paths, merged in order
  - Windows: semicolon-separated list
- Otherwise `~/.kube/config`

If `kubectl config view` works in the same terminal you launched VS
Code from but the extension doesn't see your config:

- The env var may not be inherited by VS Code. Set it system-wide or
  launch VS Code from a shell that has it.
- On macOS, GUI-launched apps don't inherit shell env. Use the
  [Launchctl trick](https://stackoverflow.com/q/135688) or launch VS
  Code from the terminal.

### "Forbidden: clusters.postgresql.cnpg.io is forbidden"

Your kubeconfig user lacks cluster-wide list permission on the CNPG
CRD. The extension falls back to listing within the namespace pinned
in your kubeconfig context. If that still fails, you don't have list
permission in any namespace — fix the RBAC binding for your user.

### "Cannot reach cluster (ENOTFOUND)" / "ETIMEDOUT"

Network issue between your workstation and the cluster's API server:

- VPN required and not connected?
- Cluster behind a private endpoint?
- DNS resolution working for the API server hostname?

The error class (ENOTFOUND vs ETIMEDOUT vs ECONNRESET) is shown
verbatim — `kubectl get nodes` against the same context will reproduce
the underlying issue.

### "Authentication failed — refresh credentials"

Short-lived cloud-provider tokens (EKS / GKE / AKS) expired:

- **EKS**: ensure `aws eks get-token` works in the terminal that
  launched VS Code. The `aws` CLI must be on PATH.
- **GKE**: ensure `gke-gcloud-auth-plugin` is installed and on PATH
  (separately from `gcloud` itself in modern versions).
- **AKS**: re-run `az aks get-credentials --resource-group <rg> --name <cluster>`.

The extension reads kubeconfig via the official
`@kubernetes/client-node`, which runs your kubeconfig's `exec` block
to refresh tokens. Output from the exec command must be valid JSON of
the `ExecCredential` shape — if it's printing extra stderr that ends
up in stdout, refresh will fail.

### "Tunnel unsupported by proxy"

Your HTTPS proxy is stripping the SPDY `Upgrade` header that
port-forwarding requires. Options:

- Configure the proxy to allow `Upgrade` headers (most enterprise
  proxies have a setting for this).
- Bypass the proxy for the Kubernetes API server's hostname via your
  `NO_PROXY` env var.
- Use direct connectivity (VPN tunnel that doesn't intercept HTTPS).

## Connecting / running queries

### Credential picker shows raw key names instead of "app" / "superuser"

The Secret doesn't have the standard CNPG `username` / `password`
keys. Likely a non-standard CNPG version or a hand-edited secret.
The extension surfaces the raw keys so you can see what's actually in
the Secret; you'll need to either fix the Secret or pick one that
follows the convention.

### `SELECT 1` works but DDL fails with "read_only transaction"

You're in read-only mode (the default). Click the status bar →
**Switch to Write mode**. The mode is per-connection and never
persists across VS Code restarts.

### Cell rejected with "Statement type X is not permitted in read-only mode"

The client-side allowlist rejected your statement before it reached
the server. This is by design when the connection is in read-only
mode. The rejection message names the keyword (`Statement type DROP
is not permitted...`). Toggle Write mode (see above) to proceed.

### "Connection test failed: password authentication failed"

The credentials in the Secret you picked don't work against the
database. Possibilities:

- Password rotated externally; the Secret is stale.
- You picked the wrong Secret (e.g., for a different cluster).
- The `dbname` key in the Secret points at a database that doesn't
  exist or you don't have CONNECT on.

The full upstream PostgreSQL error is shown — `password
authentication failed for user X` from the server is reliable signal.

### Notebook cell "Run" shows "no controller selected"

The notebook isn't bound to a controller. Either:

- Click the controller picker at the top-right of the notebook editor
  and pick the right `cluster/db (mode)` entry, OR
- Re-invoke **CNPG: Connect** on the cluster — it'll open a fresh
  notebook with the controller pre-selected.

## ER diagram

### "I see Mermaid source instead of a rendered diagram"

The Markdown Preview Mermaid Support extension isn't installed. The
extension prompts you the first time you open an ER diagram; if you
dismissed the prompt, install it manually:

- **Command Palette** → **Extensions: Install Extensions**
- Search for "Markdown Preview Mermaid Support" (publisher
  `bierner`)

Reopen the ER diagram after install.

### "Parse error on line N"

Likely an exotic PostgreSQL type that Mermaid's parser rejected. The
extension normalizes common cases (`timestamp with time zone`,
`numeric(10,2)`, `text[]`, `geometry(Point,4326)`, etc.) but bug
reports for unhandled types are welcome — copy the failing source from
the markdown editor (not the preview) into a GitHub issue.

### "60 tables exceed Mermaid's comfortable range"

Mermaid's layout engine struggles past ~50 tables. Right-click an
individual schema (not the whole database) to scope the diagram down.
Adjust `cnpg4vscode.er.warnOverTables` if you want the warning at a
different threshold.

## Performance

### Tree expansion feels slow

- Each context probe waits for the Kubernetes API server response — if
  your cluster's API is slow (e.g., overloaded or far away), every
  refresh inherits that latency.
- The 30-second auto-refresh interval may be too aggressive for a
  large kubeconfig. Increase `cnpg4vscode.refreshIntervalSeconds`.

### Result grid feels sluggish on large result sets

The renderer caps preview rows at `cnpg4vscode.results.pageSize`
(default 1000). For larger results, the footer shows a "truncated"
notice. Add an explicit `LIMIT` to your query, or paginate with
`OFFSET`.

## Reporting a bug

**Command Palette** → **CNPG: Report a Problem** assembles a Markdown
document with:

- VS Code version, extension version, platform, Node version
- Count of active connections and tunnels
- The last 200 log lines (already redacted — no credentials)

Paste that into a new GitHub issue along with the steps to reproduce.
