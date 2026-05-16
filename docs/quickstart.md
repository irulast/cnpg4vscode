# Quickstart

Get from zero to a running query against a CloudNativePG cluster in
about ten minutes.

This guide assumes you already have a Kubernetes cluster (any —
local `kind`, a cloud cluster, your team's lab cluster) with the
CloudNativePG operator installed. If you don't have that yet, the
[CloudNativePG quickstart](https://cloudnative-pg.io/documentation/current/quickstart/)
walks through it.

## 1. Install the extension

> Not yet on the Marketplace. Install from a `.vsix` file (see
> [Install from source](#install-from-source) below) or build from
> source.

The extension declares a dependency on
[`bierner.markdown-mermaid`](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid)
for ER-diagram rendering. Marketplace installs pull it in
automatically; for `.vsix` installs you'll be prompted on first ER
open.

## 2. Verify your kubeconfig

The extension reads your active kubeconfig the same way `kubectl`
does:

- `$KUBECONFIG` if set (colon-separated list on macOS/Linux,
  semicolon-separated on Windows).
- Otherwise `~/.kube/config`.

Confirm `kubectl get clusters.postgresql.cnpg.io --all-namespaces`
works against the context you want to use. If you can't list clusters
at the cluster scope, the extension automatically falls back to the
namespace recorded in your kubeconfig context.

## 3. Open the CNPG view

Click the **CNPG** icon in the activity bar (left side). You'll see
each kubeconfig context as a root node. Expand a context to see the
namespaces with CNPG clusters inside, then expand a namespace to see
the clusters.

A green check on a cluster row means the operator reports it healthy.
Other icons indicate the verbatim phase (setting up, failing, etc.).

If a context can't reach its API server, or doesn't have the CNPG CRD
installed, or your user lacks permission to list clusters — the
affected context shows an explicit error node with the upstream
message. Sibling contexts continue to work.

## 4. Connect to a cluster

**Click** any cluster row. Three things happen in sequence:

1. The extension opens a port-forward tunnel to the cluster's primary
   read/write service.
2. A credential picker pops up listing the CNPG-issued Secrets in the
   cluster's namespace. `<cluster>-app` is pre-selected — accept it
   with Enter (or pick a different secret for superuser access).
3. A new `cnpg-sql` notebook opens with the cluster's controller
   already selected. The status bar (lower-right) shows
   `CNPG: <cluster>/<db> ⚙ read-only`.

## 5. Run your first query

In the notebook's first cell, type:

```sql
SELECT current_database(), current_user, version();
```

Press **Shift+Enter** to execute. The result renders in an
interactive table directly beneath the cell.

Add a new cell with the `+ Code` button (or **Ctrl+; A** to add below)
and try something against your data:

```sql
SELECT count(*) FROM pg_stat_activity;
```

## 6. Browse the schema

In the CNPG activity bar, the **Schema** tree appears once you have a
connection. Expand:

- **Connection** → your databases
- **Database** → schemas
- **Schema** → Tables / Views / Materialized Views / Sequences / Functions / Types
- **Table** → Columns / Indexes / Constraints / Triggers

Right-click any node for context actions:

- **Copy Fully-Qualified Name** — clipboard contains `"public"."users"`.
- **Open Definition** — DDL opens in a read-only editor.
- **Browse Rows** — appends a `SELECT * FROM ... LIMIT 100` cell to
  the active notebook and runs it.
- **Count Rows** — appends a `SELECT count(*)` cell and runs it.
- **Generate INSERT Template** — drops a parameterized INSERT cell into
  the active notebook for you to fill in.

## 7. Try the ER diagram

Right-click a schema in the Schema tree → **CNPG: Show ER Diagram**.
A markdown document opens with a Mermaid diagram rendered inline,
showing every table in the scope plus its foreign-key relationships.

(If you don't see a rendered diagram — just the Mermaid source — you
need to install
[`bierner.markdown-mermaid`](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid).
The extension prompts you the first time.)

## 8. Save the notebook to the cluster

Once you've built up some useful queries, click the status-bar item
(lower-right showing the active connection) and pick **Save notebook
to cluster...**. Give it a name (e.g., `daily-checks`) and it lands at
`.cnpg/notebooks/<context>/<namespace>/<cluster>/daily-checks.cnpg-sql`
in your workspace. The Clusters tree shows saved notebooks as
expandable children under their cluster row.

## 9. Need write access? Toggle Write mode

Click the status bar → **Switch to Write mode**. A modal warns you
that destructive operations will be permitted; confirm.

Now write-mode actions appear:

- DROP / TRUNCATE / REINDEX in the Schema tree (each guarded by a
  typed-name confirmation modal).
- DML and DDL run from notebook cells.

The mode is per-connection and **never persists across VS Code
restarts** — every reconnect starts in read-only mode.

## 10. Disconnect when you're done

Status bar → **Disconnect** tears down the port-forward tunnel and
closes any dependent connections.

---

## Install from source

```sh
git clone <repo-url> cnpg4vscode
cd cnpg4vscode
pnpm install
pnpm build
# Then either F5 in VS Code (Extension Development Host) or:
pnpm package      # produces dist/vsix/cnpg4vscode-<platform>-<version>.vsix
code --install-extension dist/vsix/cnpg4vscode-<platform>-<version>.vsix
```

## Troubleshooting

See [`docs/troubleshooting.md`](troubleshooting.md) for the common
gotchas (proxy issues stripping the SPDY upgrade header, expired
cloud-provider tokens, missing `aws eks get-token` / `gke-gcloud-auth-plugin`
on PATH, etc.).
