# Features

Walk-throughs of each major feature. Screenshots are placeholders
(`[screenshot: ...]`) until the v1 packaging pass.

## Cluster discovery

> `[screenshot: CNPG activity bar with three contexts, each showing
> namespaces and clusters with status icons]`

The **CNPG** activity-bar view discovers Kubernetes contexts the same
way `kubectl` does (`$KUBECONFIG`, falling back to `~/.kube/config`)
and lists every CloudNativePG `Cluster` custom resource visible inside
each.

- **Cluster status** is the verbatim `.status.phase` from the operator
  (e.g., `Cluster in healthy state`, `Setting up primary`).
- **Auto-refresh** polls every 30 seconds (configurable via
  `cnpg4vscode.refreshIntervalSeconds`). The timer pauses when the
  view is hidden OR the editor window loses focus, and resumes when
  both become true.
- **Error nodes** surface the verbatim upstream message for forbidden
  RBAC, unreachable API server, missing CRD, or expired credentials —
  sibling contexts continue to function.
- **Saved notebooks** appear as expandable children under their
  cluster row once you've saved any (see [Per-cluster notebook
  organization](#per-cluster-notebook-organization)).

## Cluster details

> `[screenshot: markdown preview showing phase, instances, primary, PG
> version, storage, and last condition]`

Right-click a cluster → **CNPG: Show Cluster Details** → opens a
read-only markdown preview with:

- Phase, instance count, primary instance name
- PostgreSQL major version
- Storage size per instance
- The most recent operator-reported condition (type, status, message,
  transition time)
- The read/write service and CA secret names

Inline-code formatting on every identifier lets you double-click to
select for copy.

## Connecting to a cluster

> `[screenshot: cluster row → credential picker showing app /
> superuser / other secrets]`

Single-click any cluster row to invoke the **Connect** flow:

1. **CA bundle loaded** from the cluster's `<cluster>-ca` Secret for
   TLS pinning.
2. **Primary pod resolved** via the `<cluster>-rw` service's
   endpoints.
3. **Port-forward tunnel opened** on a local ephemeral port
   (`127.0.0.1:0` — loopback only) via the official
   `@kubernetes/client-node` SPDY API.
4. **Credential picker** lists every CNPG-issued Secret the user can
   read in the namespace, pre-selecting `<cluster>-app`.
5. **pg connection** opens in read-only mode with TLS pinned to the
   CA bundle.
6. **Notebook opens** with the new connection's controller
   pre-selected.

Connections are **idempotent** — clicking a cluster you're already
connected to opens a fresh notebook bound to the existing controller,
no re-tunnel or re-prompt.

## SQL Notebooks

> `[screenshot: notebook with a SELECT cell + rendered result grid +
> a second markdown cell]`

The interactive SQL surface is a VS Code Notebook (`cnpg-sql` type).
Each cell is one statement; execute with **Shift+Enter**.

- **Cell language**: `postgres` (our contribution; aliases to
  `["PostgreSQL", "postgres"]`). Falls back to `sql` cleanly. The
  cell-language picker reads "PostgreSQL" regardless of which other
  SQL extensions you have installed.
- **Snippets**: 16 PG-flavored snippets ship with the extension.
  Trigger `sel`, `selw`, `cnt`, `ins`, `upd`, `del`, `ctbl`, `cidx`,
  `cuidx`, `addcol`, `expl`, `fn`, `lst`, `slow`, `idxstat`, `size`.
- **Multi-tab**: any number of notebooks against any number of
  connections. Each notebook records its bound controller id in
  metadata so VS Code restores the selection on restart.
- **Save anywhere** via standard `Ctrl+S`. Saved `.cnpg-sql` files
  are workspace artefacts — version-controllable, visible in the
  Explorer. Saved cell text always passes through the credential
  redaction chokepoint first.

### Result grid

> `[screenshot: result grid with sticky header, row numbers, distinct
> NULL/bool/number/object styling]`

Cells with query results render in an interactive HTML table beneath
the cell:

- **Sticky header** + row numbers + scrollable body.
- **Distinct styling** per cell type: NULL / boolean / number / Date /
  JSON object — colored via `--vscode-*` theme variables.
- **Footer** with the SQL command + row count + truncation notice
  when the result exceeds the preview cap (`cnpg4vscode.results.pageSize`).
- **Fallback rendering** as text/plain + text/markdown items if the
  custom renderer is disabled.

### Read-only by default

> `[screenshot: status bar showing read-only · cell error "Read-only
> mode rejected DELETE"]`

Every connection opens read-only. The two-layer gate:

- **Client-side allowlist** rejects anything that isn't SELECT /
  EXPLAIN / SHOW / WITH (read-only) before the statement leaves your
  editor. Embedded write keywords (DELETE inside a CTE) or
  side-effecting function calls (`nextval`, `setval`,
  `pg_advisory_lock`, etc.) are rejected with an explicit reason.
- **Server-side guard**: every cell runs inside `BEGIN; SET LOCAL
  transaction_read_only = on; … ; ROLLBACK;`. Even if the client
  gate is bypassed, the PostgreSQL server itself refuses writes.

Toggle into Write mode via the status-bar action menu. The toggle is
per-connection, never persists across restarts, and surfaces a modal
warning when switching to write.

## Schema tree

> `[screenshot: schema tree expanded showing public schema with
> tables, columns, indexes, constraints]`

Once connected, the **Schema** view appears in the activity bar.
Browse:

- Connection → Database → Schema
- Schema → Tables / Views / Materialized Views / Foreign Tables /
  Sequences / Functions / Types
- Table → Columns / Indexes / Constraints / Triggers

Lazy-loaded with a 60-second cache per `(connection, OID)`. The
introspection layer uses hand-written `pg_catalog` queries (faster
than `information_schema` and gives stable OID identity across
renames).

### Per-node actions

Right-click any node:

- **Copy Fully-Qualified Name** — schema-qualified identifier to clipboard.
- **Open Definition** — DDL via `pg_get_*def` helpers; tables
  reconstructed from `pg_attribute` + `pg_constraint`.
- **Browse Rows** — appends `SELECT * FROM <fqn> LIMIT 100` to the
  active notebook and runs it.
- **Count Rows** — appends `SELECT count(*) FROM <fqn>` and runs it.
- **Generate INSERT Template** — parameterized INSERT cell ready to
  edit.

### Destructive actions (Write mode only)

> `[screenshot: typed-name confirmation modal with OK disabled until
> the user types public.scratch_table exactly]`

In Write mode, additional actions appear:

- **DROP** / **TRUNCATE** / **REINDEX** — typed-name confirmation
  modal required. The OK button stays disabled until you type the
  fully-qualified target name exactly.
- **Scaffold ALTER** — emits an editable ALTER statement into the
  active notebook so you can fill in the rest.

Disabling the confirmation (`cnpg4vscode.confirmation.requireTypedName`)
still requires a yes/no modal AND logs a WARN line on every
destructive action.

## ER diagrams

> `[screenshot: Mermaid ER diagram showing tables and FK relationships]`

Right-click a database or schema → **CNPG: Show ER Diagram** → a
markdown document opens with a Mermaid `erDiagram` rendered inline.

- **Scope**: per-schema or whole-database.
- **Type fidelity**: PG types like `numeric(10,2)`, `timestamp with
  time zone`, `text[]`, `geometry(Point,4326)` are normalized to
  Mermaid-safe tokens AND preserved as Mermaid column comments so the
  full type shows in the rendered diagram.
- **Large-schema warning**: if the table count exceeds
  `cnpg4vscode.er.warnOverTables` (default 100), the document leads
  with a friendly `> ⚠️ N tables exceed Mermaid's comfortable range`
  callout, suggesting you scope to a single schema.

Requires [`bierner.markdown-mermaid`](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid)
for inline rendering (pulled in automatically by Marketplace
installs; prompted on first ER open if missing).

## Per-cluster notebook organization

> `[screenshot: cluster row with "3 notebooks" badge, expanded to show
> three .cnpg-sql files]`

Save notebooks scoped to the cluster they were written against:

1. Status-bar action menu → **Save notebook to cluster...** → enter a
   name.
2. The notebook is written to
   `${workspaceRoot}/.cnpg/notebooks/<context>/<namespace>/<cluster>/<name>.cnpg-sql`.
3. The Clusters tree shows saved notebooks as expandable children
   under their cluster row (with a count badge).
4. Click a notebook leaf to reopen it.
5. Files also appear in VS Code's standard Explorer, are
   version-controllable, and survive workspace switches.

The convention is configurable via `cnpg4vscode.notebooks.location`
(default `.cnpg/notebooks`).

## Running SQL from `.sql` files

For workspace `.sql` or `.pgsql` files (outside a notebook), use:

- **Command Palette** → **CNPG: Run Statement (from .sql file)**
- Or the editor context menu → **CNPG: Run Statement (from .sql file)**

The command runs the statement under the cursor (or the selection)
against the most-recently-active notebook's controller; if no
notebook is open, it prompts you to pick a connection and creates
one.

## Visual constraint editor

Add `PRIMARY KEY`, `UNIQUE`, `FOREIGN KEY`, or `CHECK` constraints to
a table through a guided flow — no hand-written DDL:

1. Ensure the connection is in **Write mode**.
2. In the Schema view, right-click a **table** → **CNPG: New Constraint...**.
3. Pick the constraint kind:
   - **PRIMARY KEY** / **UNIQUE** — multi-select the local columns
     (selection order preserved for composite constraints), then confirm
     the auto-suggested name (`pk_<table>` / `uq_<table>_<cols>`).
   - **FOREIGN KEY** — multi-select the local columns, then pick the
     **referenced schema** → **referenced table** → multi-select the
     **referenced columns** (must match the local-side arity exactly),
     then pick **ON UPDATE** and **ON DELETE** actions (NO ACTION /
     RESTRICT / CASCADE / SET NULL / SET DEFAULT). Default name is
     `fk_<local>_<referenced>`.
   - **CHECK** — type the predicate expression directly (e.g. `price > 0`).
     The wizard rejects bare `;` as a SQL-injection guard. Default name
     is `ck_<table>` or `ck_<table>_<cols>` when columns are supplied.
4. Confirm or override the constraint name (≤63 chars, PostgreSQL's
   NAMEDATALEN limit — the wizard auto-truncates suggestions to fit).
5. The modal preview shows the full `ALTER TABLE … ADD CONSTRAINT …`
   statement plus a per-spec breakdown (target, kind, columns, FK
   references and actions, CHECK predicate).
6. Click **Create** to execute. Success / failure surfaces as a
   notification.

Like the index editor, the whole flow uses native VS Code modals — no
webview to theme. Action picks and column selectors are standard
QuickPicks; the CHECK expression and constraint name come in via
InputBox.

## Visual index editor

Add an index to a table without hand-writing DDL:

1. Make sure the target connection is in **Write mode** (status bar →
   connection actions → Switch to Write mode).
2. In the Schema view, right-click a **table** → **CNPG: New Index...**.
3. Multi-select the columns to include — **selection order is preserved**
   because index column order is load-bearing for the query planner.
4. Pick **UNIQUE** (enforces uniqueness; index name defaults to `ux_…`)
   or non-unique (`ix_…`).
5. Pick **CONCURRENTLY**: yes for non-blocking builds on production
   tables (non-transactional — leaves partial index on failure), no for
   simpler atomic behavior.
6. Optional **WHERE clause** for a partial index (e.g. `deleted_at IS
   NULL`). Leave blank for a full index. The wizard rejects clauses
   containing a `;` as a SQL-injection guard.
7. Confirm or override the **index name**. The default follows the
   `ix_<table>_<col1>_<col2>…` convention, truncated to PostgreSQL's
   63-character identifier limit.
8. A modal preview shows the full `CREATE [UNIQUE] INDEX [CONCURRENTLY]
   …` statement plus a per-spec breakdown.
9. Click **Create** to execute. The connection's pool runs the
   statement; success / failure surfaces as a notification.

The whole flow is native VS Code modals (no webview) — multi-select
QuickPick + InputBox + warning modal — so theming, accessibility, and
keyboard navigation come for free.

## Migration wizard

Author and run a multi-statement migration with transactional safety:

1. **Command Palette** → **CNPG: Open Migration Wizard**.
2. If multiple connections are active, pick the target. The command
   opens an untitled `.sql` document seeded with a starter banner that
   names the target cluster + database and explains the contract.
3. Author your statements — separate them with `;`. You get the full
   editor experience: multi-line, syntax highlighting via the SQL
   grammar, snippets, vim mode if you have it.
4. When ready, **Command Palette** → **CNPG: Run Migration (active SQL
   editor)**. The wizard splits the document at top-level semicolons
   and shows a modal preview:
   - **Transactional mode** (default): `BEGIN` / `COMMIT` wrap the
     statement set. Any failure rolls the whole set back.
   - **Non-transactional mode**: triggered when the set contains DDL
     that PostgreSQL refuses inside a transaction (`CREATE INDEX
     CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`, etc.). The preview
     surfaces a warning: a mid-set failure will leave the already-
     applied prefix in place.
5. Confirm and the migration runs against the active connection.
6. After a successful run, you're offered to **Export** the assembled
   SQL to `migrations/YYYYMMDD-HHMMSS-migration.sql` in your workspace
   — credentials are redacted out of the exported text before it lands
   on disk.
7. Whatever the outcome (success / failed-with-rollback /
   partially-applied), a markdown summary opens with the per-statement
   breakdown so you can copy/paste into a support thread.

The wizard requires a Write-mode connection — toggle write mode via
the status bar's connection actions menu first.

## Diagnostics

### Output channel

The **cnpg4vscode** output channel captures every cluster query,
tunnel state transition, and notebook execution as human-readable
KV lines (`event=tunnel.state cluster=default/app-db state=open`).

Every line passes through a redaction chokepoint before write. Credential
literals (`PASSWORD '...'`, `IDENTIFIED BY '...'`, `Bearer ...`,
libpq URLs with embedded passwords, PEM blocks, plpgsql function
bodies, etc.) are stripped — they never reach the channel or the
disk.

### Report a problem

**Command Palette** → **CNPG: Report a Problem** assembles a Markdown
document with:

- VS Code version, extension version, platform, Node version
- Count of active connections and tunnels
- The last 200 log lines (already redacted)

Ready to paste into a support thread or GitHub issue.

## Configuration

Every key is namespaced `cnpg4vscode.*`. See **File > Preferences >
Settings > Extensions > CloudNativePG** for the full list. Highlights:

| Setting | Default | Purpose |
|---|---|---|
| `cnpg4vscode.refreshIntervalSeconds` | `30` | Cluster-tree auto-refresh cadence. |
| `cnpg4vscode.results.pageSize` | `1000` | Rows rendered per result-grid output. |
| `cnpg4vscode.notebooks.location` | `.cnpg/notebooks` | Workspace-relative root for per-cluster saved notebooks. |
| `cnpg4vscode.confirmation.requireTypedName` | `true` | Require typing the FQN on destructive actions. Disabling logs a WARN per action. |
| `cnpg4vscode.er.warnOverTables` | `100` | Show the large-schema warning when an ER diagram exceeds this. |
| `cnpg4vscode.log.level` | `info` | Verbosity of the output channel. |

The full schema lives in the contract: [`specs/001-cnpg-cluster-explorer/contracts/settings.md`](../specs/001-cnpg-cluster-explorer/contracts/settings.md).
