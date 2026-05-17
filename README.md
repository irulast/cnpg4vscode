# cnpg4vscode

A VS Code extension for working with
[CloudNativePG](https://cloudnative-pg.io/) PostgreSQL clusters on
Kubernetes — browse clusters from your kubeconfig, run SQL against
them in native VS Code notebooks, navigate schemas with rich actions,
and visualize relationships with ER diagrams. No `kubectl`
shell-outs, no credential persistence to disk, native VS Code surfaces
throughout.

> **Status**: **v1.0.0 live on the VS Code Marketplace** as of
> 2026-05-17. Install with
> `code --install-extension Irulast.cnpg4vscode` or search
> "CloudNativePG" in the **Extensions** view. The full feature set
> across spec 001's six user stories is implemented end-to-end and
> spec 002's CI/CD pipeline ships releases automatically from
> tag pushes.

## Features

### Cluster discovery — every cluster your kubeconfig can see

The **CNPG** activity-bar view lists every Kubernetes context in your
kubeconfig and every CloudNativePG `Cluster` resource visible inside
each. Status icons reflect the operator-reported phase
(healthy / setting up / failing). Errors per context surface verbatim
(RBAC denial, network failure, CNPG not installed) without breaking
sibling contexts.

### One-click connect — credential picker → port-forward → SQL notebook

Click any cluster in the tree to:

1. Open a port-forward tunnel to the cluster's primary read/write
   service (via the official `@kubernetes/client-node` SPDY API — no
   `kubectl` shell-out).
2. Pick a credential from the CNPG-issued Secrets in the cluster's
   namespace; `<cluster>-app` is pre-selected as the safe default.
3. Open a `cnpg-sql` notebook with a controller bound to the new
   connection. Cells run via Shift+Enter; results render in an
   interactive table beneath each cell.

Connections are idempotent — clicking a cluster you're already
connected to opens a fresh notebook bound to the existing controller
without re-tunneling.

### Read-only by default — two-tier write protection

Every connection opens in **read-only mode**. A two-layer gate
prevents accidental writes:

- **Client-side**: a SQL keyword allowlist rejects statements before
  they leave your editor. SELECT / EXPLAIN / SHOW / WITH (read-only)
  pass; anything else is rejected with a clear message naming the
  read-only restriction.
- **Server-side**: every cell runs inside a `BEGIN; SET LOCAL
  transaction_read_only = on; … ; ROLLBACK;` wrapper, so the
  PostgreSQL server itself refuses writes — even if the client gate is
  bypassed somehow.

Toggle into Write mode per-connection via the status-bar action menu.
Mode never persists across VS Code restarts.

### Schema tree — lazy navigation with per-node actions

Under each connected database, browse schemas, tables, views,
materialized views, indexes, sequences, functions, triggers, types,
extensions, and roles — all lazy-loaded with a 60-second cache.
Per-node actions:

- **Browse Rows** / **Count Rows** — append a `SELECT` cell to the
  active notebook and execute.
- **Open Definition** — DDL via `pg_get_viewdef` /
  `pg_get_functiondef` / `pg_get_indexdef` /
  `pg_get_constraintdef`; tables are reconstructed from
  `pg_attribute` + `pg_constraint`.
- **Copy Fully-Qualified Name** — schema-qualified identifier to the
  clipboard.
- **Generate INSERT Template** — parameterized INSERT cell ready to
  fill in.

In Write mode, additional destructive actions appear:

- **DROP** / **TRUNCATE** / **REINDEX** / **Scaffold ALTER** — each
  gated by a typed-name confirmation modal (you must type the
  fully-qualified target name exactly to proceed).

### Grid Editor — DB-IDE-parity cell editing

Right-click any table in the schema tree → **Open in Grid Editor** to
open a dedicated tab with a canvas-rendered virtualized grid:

- **Browse, sort, filter** — sticky header, per-column sort + filter
  glyphs, full filter DSL (`=`, `≠`, `<`, `LIKE`, `IS NULL`, …).
- **Edit cells** with a per-PG-type editor (text / number / boolean /
  date / jsonb popout / enum dropdown). Edits buffer dirty;
  **Apply** previews every parameterized `UPDATE` before running.
  Per-row results stream in.
- **FK navigation** — right-click an FK cell to jump to the
  referenced row in a new pre-filtered tab.
- **Export** the current filter to CSV, JSON, or runnable SQL
  INSERTs. Every emitted statement passes through the same
  credential-redaction chokepoint as logs.
- **Layout + tab hibernation** — column widths, sort, filters
  persist per `(cluster, database, schema, table)`. Tabs reopen
  with VS Code workspace restore.

The read-only gate still applies — Write mode is required for
editing, and views / materialized views / tables without a PK stay
read-only.

### ER diagram — Mermaid in markdown preview

Right-click a database or schema in the Schema view → **CNPG: Show ER
Diagram** → a markdown document opens with a Mermaid `erDiagram`
showing tables, columns (with type, PK markers) and foreign-key
relationships. Renders inline via the VS Code markdown preview.

> Requires the [Markdown Preview Mermaid
> Support](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid)
> extension (declared as an extension dependency — pulled in
> automatically by Marketplace installs).

### Notebook → cluster organization

Save notebooks scoped to the cluster they were written against:

- Status-bar action menu → **Save notebook to cluster...** → writes to
  `${workspaceRoot}/.cnpg/notebooks/<context>/<namespace>/<cluster>/<name>.cnpg-sql`.
- The Clusters tree shows saved notebooks as expandable children
  under their cluster row; click to reopen.
- Files live in your workspace, version-controllable, visible in the
  standard Explorer.

### Diagnostic-friendly logging

A dedicated **cnpg4vscode** output channel captures every cluster
query, tunnel state transition, and notebook execution as
human-readable KV lines. Every line passes through a redaction
chokepoint — credential literals (`PASSWORD '...'`, `Bearer ...`,
libpq URLs with embedded passwords, PEM blocks, plpgsql function
bodies, etc.) are stripped before write.

**`CNPG: Report a Problem`** assembles the last 200 redacted log lines
plus environment info (VS Code version, extension version, platform,
Node version, active connection / tunnel counts) into a Markdown
document ready to paste into a support thread.

### Native VS Code surfaces

Most surfaces are native — the only webview is the Grid Editor,
opened on demand when you right-click a table:

- **Clusters / Schema** — native `TreeView`s.
- **SQL console** — native VS Code Notebook (`cnpg-sql`).
- **Inline result grid** — native NotebookRendererProvider.
- **Grid Editor** (on demand) — canvas-rendered virtualized webview
  with CSP locked to `default-src 'none'`, no external CDNs, no
  `unsafe-eval`. Theme-aware via `--vscode-*` variables.
- **Cluster details** — markdown preview.
- **ER diagram** — markdown preview (Mermaid via `bierner.markdown-mermaid`).
- **Status bar** — native VS Code status bar with action menu.

Theme-aware throughout (light, dark, high-contrast). Snippets for PG
included for `postgres` and `sql` languages.

## Install

**From the Marketplace** (recommended once a release is published):

```sh
code --install-extension Irulast.cnpg4vscode
```

Or search "CloudNativePG" in the **Extensions** view inside VS Code.

**From a GitHub Release** (sideload — useful in air-gapped environments
or for testing pre-release builds):

1. Visit the [Releases page](https://github.com/irulast/cnpg4vscode/releases)
   and download the VSIX matching your platform
   (`cnpg4vscode-<platform>-<version>.vsix`).
2. `code --install-extension <file>.vsix`

**From source** (for development):

```sh
git clone https://github.com/irulast/cnpg4vscode.git
cd cnpg4vscode
pnpm install
pnpm build
```

Then press **F5** in VS Code (with the cnpg4vscode folder open) to
launch the Extension Development Host.

## Quickstart

See [`docs/quickstart.md`](docs/quickstart.md) for a step-by-step walk-through against a
local `kind` cluster with CloudNativePG installed.

For feature walk-throughs (each major feature, with screenshots
placeholders), see [`docs/features.md`](docs/features.md).

For dev-environment setup (running tests, the spec-kit workflow), see
[`specs/001-cnpg-cluster-explorer/quickstart.md`](specs/001-cnpg-cluster-explorer/quickstart.md).

## Roadmap

| Release | Adds | Status |
|---|---|---|
| `0.1.0` | Cluster discovery, details, auto-refresh | landed |
| `0.2.0` | Connect & run SQL in notebooks, read-only gate, status bar | landed |
| `0.3.0` | Schema tree, per-node actions, typed-name confirmation | landed |
| `0.4.0` | Notebook result-grid renderer, per-cluster notebook organization, ER diagram, snippets, report-problem | landed |
| `0.5.0` | Cell editing (UPDATE/DELETE from the grid), saved-query history, full-featured Grid Editor (canvas grid + per-PG-type editors + bulk Apply + FK navigation + export) | landed |
| `0.6.0` | Visual index / constraint editors, migration wizard, per-platform packaging (`scripts/package.mjs`) | landed |
| `0.7.0` | Automated CI/CD via GitHub Actions — every PR gated by typecheck + lint + tests + build + audits + security scan; tag → Marketplace publish (stable + pre-release channels) + GitHub Release with per-platform VSIXs | landed |
| **`1.0.0`** | **First public Marketplace release — `Irulast.cnpg4vscode` (six per-platform VSIXs).** | **landed (2026-05-17)** |
| `1.1.0` | e2e test harness (`@vscode/test-electron` + testcontainers); performance budget enforcement (spec 001's blocked tasks) | planned |

Releases are automated via GitHub Actions on the standard
GitHub-hosted runner pool — see
[`docs/release-process.md`](docs/release-process.md) for the
maintainer runbook (bump → merge → push tag; the workflow handles
the rest).

## Security

- **Credentials never persisted**: kubeconfig contents, Secret
  material, decoded database passwords, and live query results stay
  in process memory only. SQL source code in notebooks IS persisted
  (via standard `Ctrl+S`), but always passes through the redaction
  chokepoint first so credential literals don't reach disk.
- **Read-only by default**: every connection opens in read-only mode;
  switching to write requires an explicit modal confirmation.
- **Destructive operations gated**: DROP / TRUNCATE / REINDEX require
  the user to type the fully-qualified target name in the confirmation
  modal.
- **No telemetry**: the extension never collects usage analytics. The
  only outbound network traffic is to your kubeconfig-configured
  Kubernetes API servers and the PostgreSQL instances you connect to.
- **No remote-code execution**: the extension does not eval
  user-supplied YAML, does not shell out to `kubectl`, and does not
  load any JavaScript from external CDNs.

## Governance

This project is governed by
[`.specify/memory/constitution.md`](.specify/memory/constitution.md)
(v1.0.0). Notable principles:

- VS Code UX consistency — native surfaces by default.
- Kubernetes-native integration — via `@kubernetes/client-node`,
  never `kubectl`.
- Test-first development (non-negotiable).
- Observability with no default telemetry.
- Simplicity and YAGNI.

Feature specs live under [`specs/`](specs/):

- [`001-cnpg-cluster-explorer/`](specs/001-cnpg-cluster-explorer/) —
  the foundational extension (clusters, schemas, notebooks, Grid
  Editor, ER diagrams, migration wizard).
- [`002-github-actions-deploy/`](specs/002-github-actions-deploy/) —
  the automated CI/CD pipeline (self-hosted runners, tag-triggered
  Marketplace publish, partial-failure recovery).

## Contributing

Patches welcome. See [`specs/001-cnpg-cluster-explorer/quickstart.md`](specs/001-cnpg-cluster-explorer/quickstart.md)
for the dev environment setup. The repo follows the [Spec Kit](https://github.com/github/spec-kit)
workflow — new features go through `/speckit-specify` → `/speckit-plan`
→ `/speckit-tasks` → `/speckit-implement`.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and
[`THIRD_PARTY_LICENSES`](THIRD_PARTY_LICENSES).
