# Feature Specification: CloudNativePG Cluster Explorer

**Feature Branch**: `001-cnpg-cluster-explorer`

**Created**: 2026-05-15

**Status**: Draft

**Input**: User description: *(none provided — derived as the foundational MVP for the cnpg4vscode extension: a read-only tree view of CloudNativePG clusters discovered through the user's active kubeconfig context. See Assumptions for the reasoning.)*

**Expanded scope** *(via `/speckit-clarify`, 2026-05-15)*: The feature now also encompasses a full database management surface — credential lookup from CNPG-issued secrets, port-forward lifecycle management, an interactive SQL console, and a schema tree (catalogs / schemas / tables / views / indexes / functions / etc.) with per-node actions.

## Clarifications

### Session 2026-05-15

- Q: SQL write capability — what's the boundary between read and write operations from the extension? → A: Two-tier mode. Every connection opens read-only by default; the user must explicitly toggle "Write mode" per connection. Active mode is surfaced as a status-bar indicator while the connection is in scope.
- Q: Which credentials does the SQL surface use to connect? → A: User picks per connection at connect time; the `<cluster>-app` secret is the default. Choice is remembered for the current VS Code session only and is not persisted to disk.
- Q: What action set does the schema tree expose? → A: Full IDE-parity. Browse + view definition + row count + index/column/constraint inspection + insert-row templates + DROP/TRUNCATE with typed-name confirmation, PLUS GUI cell-level row editing in result grids, visual index/constraint editors, schema migration wizards, and an ER diagram view. All destructive operations require Write mode (FR-020) and an explicit confirmation. The set is large enough that the implementation plan will sequence sub-capabilities across multiple delivery increments.
- Q: When are port-forward tunnels opened and closed? → A: Always-on for visible clusters. A tunnel opens eagerly when the user expands a cluster in the tree, stays open while the cluster remains expanded, and is torn down on collapse or VS Code exit. Tunnels are scoped per-cluster (one tunnel reused across multiple database connections to that cluster).
- Q: How are SQL scripts, query history, and multi-tab console state persisted? → A: Full editor parity. The extension supports saving / opening `.sql` files in the workspace, a persistent and searchable query history (stored per-workspace), named saved scripts, snippet expansion, and multi-tab consoles whose unsaved state restores after VS Code restart. Persisted history and restored tab content MUST be scrubbed of credential-shaped tokens (e.g., `PASSWORD 'literal'`) before write.
- Q: What is the default action when a user clicks a cluster row in the tree? → A: **Connect.** Clicking a cluster initiates the credential picker → tunnel → SQL console flow. If a connection already exists for the cluster, a new console bound to the existing connection opens immediately (no re-tunnel). The read-only Cluster Details surface (US2) is reached via the context menu's "Show Cluster Details" entry — it is no longer the default-click target. Reasoning: connecting is the action 95% of users take 95% of the time; details is occasional.
- Q: When the user switches focus to an unrelated editor (a Markdown file, JSON file, etc.), should the Schema view disappear? → A: **No.** The Schema view's visibility tracks *session state* (whether any database connection exists), not the active editor's binding. Once the user has connected to at least one database, the Schema view remains visible regardless of which document is in front. The status bar still reflects the active editor's bound connection (or "(unbound editor)" when no binding exists), but the tree view itself stays put.
- Q: What UI surface hosts the interactive SQL "console" — an untitled `sql` editor with a per-tab binding, a custom webview, or a VS Code Notebook? → A: **VS Code Notebook (`cnpg-sql` notebook type).** Each cell is one SQL statement; cell execution is driven by a `NotebookController` whose identity IS the database connection (one controller per active connection). Results render inline beneath their producing cell via a NotebookOutputRenderer. Reasoning: the editor-binding model leaked invisible state (Browse Rows opened a new unbound editor; Ctrl+Enter was unreliable when focus drifted to a result preview). The notebook inverts this — cells know their controller, not the editor knows its connection — so per-tab binding state disappears entirely. The native execute keybinding (Shift+Enter) replaces the custom Ctrl+Enter, native cell-output rendering replaces the result-preview-as-new-doc anti-pattern, and the planned result-grid webview (US6) becomes a NotebookRendererProvider, reducing US6 scope. Trade-off: differs from DataGrip/DBeaver continuous-text consoles. Running SQL directly from a `.sql` file in the workspace is supported via a separate `cnpg.runFromSqlFile` command that targets the most-recently-active notebook controller.
- Q: What language id should cells default to? VS Code's built-in `sql` language picker is labeled "MS SQL" whenever any Microsoft SQL extension is installed (a common case), which is the wrong vendor for CNPG. → A: **The extension contributes its own `postgres` language id** (aliases: `["PostgreSQL", "postgres"]`, extension: `.pgsql`) with a TextMate grammar that delegates to `source.sql` and adds PostgreSQL-specific tokens (dollar-quoted strings, `RETURNING` / `ILIKE` / `LATERAL` / etc. keywords, PG types). Notebook cells default to `postgres`; the controller's `supportedLanguages` is `["postgres", "sql"]` so cells authored under either id execute identically. Reasoning: the only `sql` language vendor in VS Code's marketplace ecosystem is Microsoft, and their extension brands the picker label "MS SQL" — wrong vendor for our PostgreSQL-only target. Shipping our own language id makes the cell-language picker say "PostgreSQL" regardless of what else the user has installed. The grammar is intentionally minimal (no full PG parser — that lives in the read-only gate per research §9) and falls through to `source.sql` for the bulk of SQL syntax highlighting.
- Q: Is there a "Saved Scripts" sidebar listing `.cnpg/scripts/*.sql` files? → A: **No** — the original FR-032 sidebar was designed for the editor-binding console era. Under the notebook architecture, the natural "save a session" gesture is `Ctrl+S` on the notebook (writes a `.cnpg-sql` file), and the saved file appears in VS Code's standard file explorer. A dedicated CNPG sidebar duplicates explorer functionality without adding value — Constitution §V (Simplicity & YAGNI). The `cnpg.savedScripts` view contribution, the `cnpg.scripts.saveAs` command, the `cnpg4vscode.scripts.location` setting, and `src/ui/tree-scripts.ts` are all removed. FR-032 is amended to apply to `.cnpg-sql` notebooks instead of `.sql` files: notebooks save via standard VS Code behaviour, with the redaction chokepoint in the serializer ensuring credentials never reach disk.
- Q: How should saved notebooks be organized so a user can find "the notebooks I wrote against cluster X"? → A: **Convention-based per-cluster path + Cluster-tree integration.** The default save path is `${workspaceRoot}/.cnpg/notebooks/<context>/<namespace>/<cluster>/<name>.cnpg-sql` (override via `cnpg4vscode.notebooks.location`). The existing Clusters tree (no new top-level pane) gains a child node under each cluster row that lazily lists the `.cnpg-sql` files in that cluster's folder; clicking a node opens the notebook. A new `cnpg.notebook.saveToCluster` command (and a status-bar action menu entry) prompts for a name and writes to the convention path. The files are workspace artefacts — they appear in the standard file explorer, are version-controllable, and live alongside the rest of the user's code. The tree is purely a discoverability shortcut; a notebook saved elsewhere still opens, it just doesn't appear under the cluster. Convention not requirement.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discover CloudNativePG Clusters Across My Kubeconfig Contexts (Priority: P1)

A platform engineer has multiple Kubernetes clusters configured in their
kubeconfig (local kind, a staging EKS, a production GKE). They open VS Code,
expand the cnpg4vscode side panel, and see each kubeconfig context listed.
Expanding a context reveals every namespace that contains at least one
CloudNativePG cluster, and expanding a namespace lists the clusters by name
with a status indicator (healthy / degraded / unknown). They can see at a
glance which clusters exist where, without typing a single `kubectl` command.

**Why this priority**: This is the entry point for every other capability the
extension will eventually offer (inspect a cluster, view logs, trigger a
failover, etc.). Without discovery, the extension has no surface to hang
anything else on. Cluster discovery alone is also useful in isolation — many
users have lost track of what they have running where.

**Independent Test**: Configure a kubeconfig with at least one cluster that
has the CNPG operator installed and one CNPG `Cluster` custom resource.
Activate the extension. Verify that the tree view shows the kubeconfig
context, the namespace containing the cluster, and the cluster itself with a
status icon that matches the cluster's reported phase.

**Acceptance Scenarios**:

1. **Given** a kubeconfig with one context pointing at a cluster where CNPG
   is installed and one CNPG `Cluster` resource named `app-db` exists in
   namespace `prod`, **When** the user opens the cnpg4vscode tree view,
   **Then** they see the context name at the root, `prod` as a child node,
   and `app-db` as a leaf with a status indicator reflecting the cluster's
   reported phase.
2. **Given** a kubeconfig with three contexts where only two have the CNPG
   operator installed, **When** the user expands each context, **Then**
   contexts without CNPG show a clear "CNPG not installed" marker rather
   than appearing empty or erroring silently.
3. **Given** a kubeconfig context the user lacks permission to list CNPG
   resources in, **When** the user expands that context, **Then** they see
   a node labelled with the upstream RBAC denial reason (e.g., "Forbidden:
   clusters.postgresql.cnpg.io is forbidden") rather than a generic error.
4. **Given** the active kubeconfig is changed externally (user runs
   `kubectl config use-context`) while VS Code is open, **When** the user
   triggers the "Refresh" action on the tree, **Then** the tree reflects
   the new active context within 5 seconds.

---

### User Story 2 - Inspect a Cluster's Key Facts Without Leaving the Editor (Priority: P2)

The same engineer selects one of the discovered clusters and wants to see
the essentials at a glance: instance count, primary instance name,
PostgreSQL major version, storage size, and the current phase / health
condition. They open a read-only detail view that summarises these fields
in a format that is easy to scan and copy. No editing, no destructive
actions — purely informational.

**Why this priority**: Discovery (US1) tells you a cluster exists; this
story tells you whether it's healthy and how it's configured. It transforms
the extension from a directory into a diagnostic tool, but it is dependent
on US1 and can ship in a subsequent release.

**Independent Test**: With a CNPG cluster present (from US1's setup),
right-click the cluster in the tree and choose **CNPG: Show Cluster
Details**. (Single-click is reserved for the connect flow per the
2026-05-15 clarification.) Verify the detail surface displays the
instance count, primary, PG version, storage size, and current phase,
and that the values match what `kubectl describe cluster` would report.

**Acceptance Scenarios**:

1. **Given** a healthy 3-instance CNPG cluster running PostgreSQL 16, **When**
   the user opens the cluster's detail view, **Then** they see "Instances:
   3", the name of the current primary, "PostgreSQL: 16", the storage size
   per instance, and a "Phase: Cluster in healthy state" indicator.
2. **Given** a cluster in a degraded state (e.g., one replica failing),
   **When** the user opens the detail view, **Then** the most recent
   condition message from the operator is shown prominently with a warning
   indicator.
3. **Given** a cluster whose CRD includes fields the extension does not
   recognise (newer operator version), **When** the user opens the detail
   view, **Then** the known fields render correctly and unknown fields are
   omitted silently rather than producing errors.

---

### User Story 3 - Refresh and Stay Current Without Manual Reloads (Priority: P3)

The engineer keeps the tree view open while doing other work and expects it
to reflect cluster state changes within a reasonable window — for example,
when a cluster they just created appears, or when the primary fails over
and a new instance takes over.

**Why this priority**: Useful quality-of-life improvement but not required
for the MVP value loop (open extension → find cluster → see status). Manual
refresh is acceptable for early releases.

**Independent Test**: With the tree view open showing a cluster, change the
cluster externally (scale instances, trigger a failover, or delete it).
Within the refresh interval the tree updates to reflect the change without
the user clicking anything.

**Acceptance Scenarios**:

1. **Given** the tree view is open and a new CNPG cluster is created in a
   visible namespace, **When** at most 30 seconds elapse, **Then** the new
   cluster appears in the tree without the user manually refreshing.
2. **Given** a cluster's primary fails over to a different instance,
   **When** the next refresh completes, **Then** the primary indicator in
   the detail view updates to the new primary's name.
3. **Given** a cluster is deleted externally, **When** the next refresh
   completes, **Then** the cluster disappears from the tree and any open
   detail view for it shows a clear "cluster no longer exists" state.

---

### User Story 4 - Connect to a Cluster's Database and Run SQL (Priority: P2)

After finding a cluster in the tree (US1), the engineer clicks it. A
port-forward tunnel opens automatically (FR-029) and a credential picker
prompts them to choose which CNPG-issued secret to use (default
`<cluster>-app`). On selection, a `cnpg-sql` **notebook** opens, with a
`NotebookController` bound to the new connection auto-selected. They write
one SQL statement per cell; Shift+Enter executes the cell and renders the
result inline below it. The connection is in read-only mode by default
(status-bar indicator). They switch to Write mode via an explicit toggle.
Their session — open notebooks, unsaved cell contents, query history —
survives a VS Code restart via the native notebook persistence layer.

**Why this priority**: This is the second value pillar of the extension.
US1-US3 prove discovery; US4 proves the extension can actually *do
something* with a discovered cluster. It depends on US1 (cluster must be
discoverable) and on FR-029 (tunnel lifecycle).

**Independent Test**: Click a healthy CNPG cluster in the tree, accept
the default credential, see a `cnpg-sql` notebook open with the cluster's
controller selected. In a cell, type `SELECT 1` and press Shift+Enter;
observe the result rendered beneath the cell. Toggle Write mode via the
status bar; in a new cell, run `CREATE TABLE t (id int)`, and verify it
executes; then in a fresh read-only-mode controller, verify the same
statement is rejected client-side without reaching the server.

**Acceptance Scenarios**:

1. **Given** a healthy CNPG cluster, **When** the user clicks it in the
   tree, **Then** within 5 seconds a tunnel opens, a credential picker
   appears pre-selecting `<cluster>-app`, and on confirmation a
   `cnpg-sql` notebook opens with the cluster's controller auto-selected
   in read-only mode (status bar reflects the mode). (If a connection to
   that cluster already exists, the credential picker is skipped and a
   new notebook bound to the existing controller opens immediately.)
2. **Given** a notebook attached to a read-only controller, **When** the
   user runs a cell containing `DELETE FROM users`, **Then** the cell
   output reports a rejection with a message naming the read-only
   restriction; nothing reaches the server.
3. **Given** the user toggles the controller to Write mode, **When**
   they run a cell containing a DROP TABLE statement, **Then** they are
   presented with a typed-name confirmation modal and must retype the
   target name before execution.
4. **Given** an open notebook with unsaved cells and a non-empty query
   history, **When** the user restarts VS Code and reopens the
   workspace, **Then** the notebook is restored via VS Code's native
   notebook persistence with its unsaved cells intact, history is
   searchable as before, and all persisted text has credential literals
   scrubbed.

---

### User Story 5 - Navigate the Schema Tree and Take Per-Node Actions (Priority: P2)

The same engineer expands the connected database in the tree and sees a
hierarchical browser of schemas → tables / views / indexes / sequences /
functions / triggers / etc. Right-clicking any node offers a menu of
applicable actions: open definition, copy fully-qualified name, browse
rows, count rows, inspect columns/constraints, generate INSERT template.
When the connection is in Write mode, additional actions appear: DROP,
TRUNCATE, REINDEX, ALTER scaffolding — each gated by typed-name
confirmation.

**Why this priority**: This is the navigational backbone of "fully
featured" SQL management. It transforms the console from a blank prompt
into a discovery-driven workflow. Depends on US4.

**Independent Test**: With a connected database containing at least one
schema, table, view, and index, expand each node type in the tree. For a
table, invoke "Browse top 100 rows" and verify the result grid shows the
expected rows. With Write mode on, invoke DROP on a throwaway table and
verify the confirmation modal demands typing the fully-qualified name.

**Acceptance Scenarios**:

1. **Given** a connected database with schema `public` containing a table
   `orders`, **When** the user expands the tree to the `orders` node,
   **Then** they see child nodes for Columns, Indexes, Constraints, and
   Triggers, each lazily loaded.
2. **Given** any tree node, **When** the user invokes "Copy fully-
   qualified name", **Then** the clipboard contains the schema-qualified
   identifier in a form that can be pasted into a SQL statement.
3. **Given** a connection in read-only mode, **When** the user opens the
   context menu on a table node, **Then** DROP / TRUNCATE / REINDEX /
   ALTER actions are not visible (or are visibly disabled with a
   tooltip explaining Write mode is required).
4. **Given** a connection in Write mode and a table `public.scratch`,
   **When** the user invokes DROP and the confirmation modal appears,
   **Then** the OK button remains disabled until the user has typed
   `public.scratch` exactly.

---

### User Story 6 - Edit Data, Author DDL Visually, Run Migrations, Inspect ER (Priority: P3)

For deeper work, the engineer uses the IDE-parity surface: cell-level row
editing in result grids (Write mode only, primary key required), visual
editors for indexes and constraints, a guided migration wizard that runs
DDL in an explicit transaction and exports the resulting `.sql` to the
workspace, and a read-only ER diagram for visualising relationships.

**Why this priority**: This is the long tail of "fully featured" — high
value for power users, but each capability is independently shippable
after US5. Each sub-capability may land in its own delivery increment per
the plan.

**Independent Test**: Each capability has an independent acceptance path:
- Cell editing: open a result grid for a table with a primary key, edit a
  cell, click Apply, see the generated UPDATE in a preview, confirm, and
  verify the change.
- Visual index editor: create a new index on a table via the dialog,
  preview the generated CREATE INDEX, confirm, verify the index exists.
- Migration wizard: assemble two DDL statements, run them in a
  transaction, confirm both succeeded, verify a `.sql` file appears in
  the workspace.
- ER diagram: pick a schema with at least 3 tables and 2 foreign keys,
  render the diagram, verify each table and FK is shown.

**Acceptance Scenarios**:

1. **Given** a Write-mode connection and a table with a primary key,
   **When** the user edits a cell in the result grid and clicks Apply,
   **Then** they see a preview of the generated UPDATE statement before
   it executes, and execution proceeds only on explicit confirmation.
2. **Given** the visual index editor, **When** the user configures a
   composite index and previews it, **Then** the displayed DDL matches
   what would be executed and is editable before confirming.
3. **Given** the migration wizard with two DDL statements queued,
   **When** the user runs the migration and the second statement fails,
   **Then** the first statement is rolled back (where the storage engine
   permits) and the failure is reported with the offending statement
   highlighted.
4. **Given** an ER diagram is open, **When** the schema changes externally
   (e.g., a column is added via psql), **Then** the diagram either re-
   renders on the next refresh interval or shows a clear "schema changed
   — refresh" prompt; it never silently displays stale relationships.
5. **Given** a TABLE node in the Schema view and an active connection,
   **When** the user right-clicks the table and picks **CNPG: Open in
   Grid Editor**, **Then** a dedicated editor tab opens showing the
   table's rows in a virtualized grid, with PK and FK columns marked,
   per-column sort/filter affordances, and (if the connection is in
   Write mode) cell editing enabled. Closing the tab MUST NOT close
   the connection or invalidate the schema cache.
6. **Given** an open Grid Editor with several pending cell edits,
   **When** the user clicks **Apply**, **Then** they see a single
   modal preview listing every dirty row's parameterized UPDATE before
   any statement executes; confirming runs them in order, and any
   per-row failure surfaces inline on that row (the rest still apply).
   The dirty-row gutter marks clear as each row succeeds.
7. **Given** an open Grid Editor on `public.posts` with a `user_id`
   FK to `public.users(id)`, **When** the user right-clicks a `user_id`
   cell and picks **Go to referenced row**, **Then** a new Grid Editor
   tab opens on `public.users` filtered to that row's id; closing the
   new tab leaves the original Grid Editor unchanged.
8. **Given** a Grid Editor where the user has resized columns, applied
   a sort, and added a filter, **When** the user closes VS Code and
   reopens the workspace, **Then** reopening the same table restores
   the previous column widths, sort, and filter (per FR-039 — no cell
   data is persisted, only layout primitives).

---

### Edge Cases

- **No kubeconfig present**: The extension shows a single helpful node
  explaining that no kubeconfig was found and pointing the user at the
  standard `KUBECONFIG` location, rather than failing to activate.
- **Kubeconfig present but unreachable cluster** (network down, VPN off):
  The affected context shows a "Cannot reach cluster" marker with the
  underlying error class; sibling contexts continue to load independently.
- **Very large clusters list** (hundreds of CNPG clusters in one
  namespace): The tree remains responsive; rendering does not block the
  VS Code UI thread.
- **Expired credentials** (e.g., short-lived cloud-provider tokens): The
  affected context surfaces an "Authentication failed — refresh
  credentials" marker rather than retrying indefinitely.
- **Mixed-version operators across contexts**: Each context is queried
  independently, so a newer operator in one cluster does not break
  rendering for an older operator in another.
- **HTTP proxy required**: The extension respects VS Code's `http.proxy`
  and `http.proxyStrictSSL` settings (per constitution §Security).
- **Tunnel established but database refuses connection** (e.g., the
  selected secret holds stale credentials after a password rotation):
  the SQL surface MUST display the upstream PostgreSQL error verbatim
  ("password authentication failed for user X") rather than a generic
  "connection failed" message.
- **Port collision** (the ephemeral local port chosen for a tunnel is
  already in use): the extension MUST retry with a different port up to
  3 times before reporting a terminal failure.
- **No primary key on a table** when the user attempts row-grid cell
  editing: the result grid MUST switch to read-only for that table and
  display a clear inline explanation ("No primary key — cannot
  identify rows safely").
- **Very large result set** (e.g., a SELECT returning millions of rows):
  the result grid MUST page lazily (default 100 rows per page) and
  expose the total count separately rather than materialising the full
  set in memory.
- **Schema changes mid-session** (the tree shows objects that have been
  dropped, or misses objects that have been created): refreshing the
  affected tree node MUST re-introspect that subtree without
  invalidating unrelated nodes.
- **ER diagram on huge schemas** (hundreds of tables): the diagram MUST
  warn before rendering and offer a way to scope to a subset of tables
  rather than blocking the UI.
- **VS Code restart with stale workspace state** (e.g., the cluster the
  restored tab pointed to no longer exists): the restored tab MUST open
  in a disconnected state with a clear "cluster not found" banner and
  a "Reconnect to..." action.
- **CNPG secret format changes across operator versions**: the
  credential picker MUST surface the raw key names from the secret if
  the expected `username` / `password` keys are missing, rather than
  failing silently.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The extension MUST discover Kubernetes contexts from the
  user's active kubeconfig (resolved using the same precedence rules as
  `kubectl`: `$KUBECONFIG` env var if set, otherwise `~/.kube/config`).
- **FR-002**: For each discovered context, the extension MUST determine
  whether the CloudNativePG operator's `clusters.postgresql.cnpg.io` CRD is
  installed and report this state to the user.
- **FR-003**: For each context where CNPG is installed, the extension MUST
  list CNPG `Cluster` resources visible to the user, grouped by namespace.
- **FR-004**: Each cluster entry in the tree MUST show the cluster name and
  a visual status indicator reflecting the cluster's current phase
  (healthy / not healthy / unknown).
- **FR-005**: The extension MUST provide a manual "Refresh" action that
  re-queries all visible contexts on demand.
- **FR-006**: The extension MUST automatically re-query visible contexts on
  a periodic interval no longer than 30 seconds while the tree view is
  visible, and MUST stop polling when the view is hidden or the editor
  loses focus for an extended period.
- **FR-007**: When a query against a context fails (network error,
  authentication failure, RBAC denial), the extension MUST surface the
  upstream error message verbatim on the affected node and MUST continue
  to function for unaffected contexts.
- **FR-008**: The extension MUST provide a per-cluster detail surface
  showing: instance count, primary instance name, PostgreSQL major version,
  storage size per instance, and the most recent operator-reported
  condition or phase message.
- **FR-009**: The Kubernetes-level detail surface (cluster summary,
  instance count, primary, PG version, storage size) MUST be strictly
  read-only; no field is editable and no action button performs a write
  against the CNPG Cluster CR or the operator. *(Note: this restriction
  applies to Kubernetes-level state. SQL-level read/write capability
  against the PostgreSQL database itself is governed by the two-tier
  mode in FR-020.)*
- **FR-010**: All cluster identifiers shown in the UI (context, namespace,
  cluster name) MUST be copyable to the clipboard with a single action.
- **FR-011**: The extension MUST log every cluster query (start, success,
  failure) to a dedicated VS Code Output channel, redacting any bearer
  tokens or credentials before display (per constitution §IV).
- **FR-012**: The extension MUST NOT persist kubeconfig contents,
  Secret material, decoded database passwords, or live cluster /
  database query results outside of process memory. SQL source code
  (user-authored scripts and history) MAY be persisted under the
  conditions defined in FR-032 / FR-033 / FR-034 below.
- **FR-013**: The extension MUST respect the user's active VS Code colour
  theme (light, dark, high-contrast) for all icons and text it renders.
- **FR-014**: When the active kubeconfig context changes externally, the
  extension MUST detect the change on the next refresh and reflect it in
  the tree.

### Functional Requirements — SQL Management Surface

- **FR-020** *(SQL write capability)*: Every database connection MUST
  open in read-only mode by default. Read-only mode MUST reject any
  statement other than SELECT, EXPLAIN, SHOW, and other side-effect-free
  introspection commands; rejection happens client-side before the
  statement is sent. The user MUST be able to toggle the connection
  into "Write mode" via an explicit action; this toggle is per-
  connection (not global) and MUST NOT persist across VS Code restarts.
  The currently-active mode (read-only / write) MUST be visible in the
  VS Code status bar whenever a notebook attached to that connection's
  controller has focus, and MUST be reflected in the controller's label.

- **FR-021** *(Credential selection)*: For each CNPG cluster, the
  extension MUST discover all Kubernetes Secrets the user can read that
  are owned by (or annotated as belonging to) the cluster, surface them
  in a credential picker at connection time, and pre-select the
  `<cluster>-app` secret as the default. If no default-matching secret
  exists, the picker MUST require an explicit selection rather than
  auto-picking. The selected secret choice MUST be remembered for the
  current VS Code session only (in-memory; not written to disk or to
  workspace state). On VS Code restart the picker re-prompts.

- **FR-022** *(Schema tree)*: Under each connected database the
  extension MUST surface a navigable tree exposing, at minimum: schemas,
  tables, views, materialized views, indexes, sequences, functions,
  procedures, triggers, types, extensions, and roles visible to the
  connected user. Each node MUST be lazily loaded; expanding a node
  triggers introspection only for that node's children. The Schema view
  MUST remain visible whenever at least one database connection exists,
  regardless of which document is in the active editor; visibility tracks
  *session* state, not editor binding.

- **FR-023** *(Tree actions — non-destructive)*: Each tree node MUST
  expose, where semantically applicable, the following non-destructive
  actions: open object definition as read-only SQL, copy fully-qualified
  name, count rows (tables/views), browse top-N rows in a result grid,
  inspect columns / indexes / constraints / triggers, and generate an
  INSERT template into the active console.

- **FR-024** *(Tree actions — destructive)*: When the connection is in
  Write mode (per FR-020), each tree node MUST additionally expose, where
  applicable: DROP, TRUNCATE (tables), REINDEX (tables/indexes), and
  ALTER scaffolding (generates an editable ALTER statement into the
  console rather than executing in place). Every destructive action MUST
  require a confirmation step that displays the fully-qualified target
  name and requires the user to retype it before execution.

- **FR-025** *(Result grid with cell editing)*: Query results and tree-
  driven row browses MUST render in a result grid that supports cell-
  level editing for tables with a usable primary key, when the
  connection is in Write mode. Edits MUST be staged client-side and
  committed only when the user explicitly applies them; the apply step
  MUST preview the generated UPDATE/DELETE statements before execution.
  *(See FR-037 / FR-038 / FR-039 for the dedicated Grid Editor surface
  that delivers full IDE-parity editing; the inline notebook renderer
  remains the lightweight "just-looking" view for the 95% case.)*

- **FR-026** *(Visual editors)*: The extension MUST provide visual
  editors for index and constraint definitions on tables (create / edit
  / drop with confirmation). Visual editors MUST generate equivalent
  DDL and display it before executing.

- **FR-027** *(Schema migration wizard)*: The extension MUST provide a
  guided migration surface that lets the user assemble a sequence of
  DDL statements, preview them, run them inside an explicit transaction
  where supported, and export the resulting script to a `.sql` file in
  the workspace. The wizard MUST NOT auto-apply migrations without an
  explicit confirmation gesture.

- **FR-028** *(ER diagram)*: The extension MUST render a read-only ER
  diagram for a selected schema or set of tables, showing tables, columns,
  primary keys, and foreign-key relationships. The diagram is a
  visualization only and MUST NOT permit schema edits.

- **FR-019** *(Default click action)*: Clicking a cluster row in the
  tree MUST invoke the Connect flow (credential picker → tunnel → SQL
  notebook). If a connection already exists for the cluster, a new
  notebook bound to the existing controller MUST open without re-running
  the credential picker or re-opening the tunnel. The read-only Cluster
  Details surface (FR-008) is reachable via the context menu only.

- **FR-029** *(Port-forward lifecycle)*: For each CNPG cluster expanded
  in the tree, the extension MUST open a single port-forward tunnel to
  the cluster's primary read/write service (e.g., `<cluster>-rw`) on a
  locally-bound ephemeral port. The tunnel MUST open eagerly on cluster
  expansion, remain open while the cluster node remains expanded, and
  be torn down deterministically when the cluster is collapsed or VS
  Code exits. A single tunnel per cluster MUST be reused across all
  database connections originating from that cluster.

- **FR-030** *(Port-forward health & visibility)*: The extension MUST
  monitor each open tunnel's health (process or stream liveness). On
  failure, the affected cluster node MUST show a clear "tunnel lost —
  retrying" indicator and the extension MUST attempt at most 3
  reconnections with exponential backoff before surfacing a terminal
  error and marking dependent connections as disconnected. The current
  tunnel state (opening / open / retrying / closed) MUST be visible on
  the cluster's tree node icon.

- **FR-031** *(Tunnel teardown safety)*: Tearing down a tunnel (cluster
  collapse, VS Code exit, error) MUST first close any active database
  connections that depend on it, rolling back uncommitted transactions
  rather than leaving them in an indeterminate state. The Output channel
  MUST log each teardown with the reason.

- **FR-032** *(Saved sessions)*: `cnpg-sql` notebooks are first-class
  workspace artefacts. The user saves a session via the standard VS
  Code Save / Save As gesture, which writes a `.cnpg-sql` file
  whose contents pass through `redact()` (FR-033). Saved notebooks
  appear in VS Code's standard file explorer; the extension does NOT
  contribute a dedicated "Saved Scripts" sidebar (that was a remnant
  of the editor-binding console model and is redundant under the
  notebook architecture — see spec.md § Clarifications 2026-05-15).
  Running SQL from `.sql` / `.pgsql` files in the workspace is covered
  by `cnpg.runFromSqlFile` (FR-036), not by a saved-script picker.
  A per-cluster path convention and the cluster-tree integration that
  surfaces matching files are defined in FR-037.

- **FR-037** *(Per-cluster notebook organization)*: When the user
  invokes `cnpg.notebook.saveToCluster` (or picks "Save to cluster" from
  the status-bar action menu), the extension MUST write the active
  notebook to `${workspaceRoot}/<base>/<context>/<namespace>/<cluster>/<name>.cnpg-sql`
  where `<base>` is the `cnpg4vscode.notebooks.location` setting
  (default `.cnpg/notebooks`). The Clusters tree (FR-003) MUST add a
  collapsible child node under each cluster row when the convention
  folder contains at least one `.cnpg-sql` file; expanding the node
  lists the files (alphabetically) as leaves that open the notebook on
  click. The extension MUST watch the convention folder for file
  add/remove/rename and refresh the affected subtree without polling.
  Notebooks saved outside the convention folder are NOT discovered by
  the cluster tree — the convention is a discoverability shortcut, not
  a storage requirement; standard VS Code Save / Save As remains the
  authoritative save path. When no workspace folder is open, the
  "Save to cluster" command MUST surface a clear error rather than
  attempt to write outside a workspace.

- **FR-033** *(Query history)*: The extension MUST persist a searchable
  query history per workspace. Each entry MUST capture: the SQL text,
  the cluster + database + user it ran against, timestamp, success /
  error, and rows affected (if known). History MUST be queryable by
  full-text search and filterable by cluster / database. Before writing
  any history entry, the extension MUST scrub credential-shaped
  literals from the SQL text using a documented redaction ruleset (at
  minimum: `PASSWORD '<literal>'`, `IDENTIFIED BY '<literal>'`, and
  bearer-token-shaped strings). Redactions MUST be visually marked in
  the history view (e.g., `PASSWORD '••• redacted'`).

- **FR-034** *(Snippets & notebook restore)*: The extension MUST support
  SQL snippets via VS Code's standard snippet contribution mechanism
  (workspace-scoped snippet files); snippets are available inside
  notebook cells (which use the `sql` language). Open `cnpg-sql`
  notebooks are restored after a VS Code restart via the platform's
  native notebook persistence — the extension does not maintain a
  parallel tab-restore state. Notebook files saved to disk MUST be
  scrubbed of credential-shaped tokens (per FR-033) when serialized,
  even mid-edit save, so credentials never reach the workspace folder.

- **FR-035** *(Notebook architecture)*: The interactive SQL surface MUST
  be implemented as a VS Code Notebook of type `cnpg-sql`. The extension
  MUST register one `NotebookController` per active database connection;
  the controller's `id` matches the connection's `id`, its `label`
  reflects `cluster/db (mode)`, and its `supportedLanguages` is
  `["postgres", "sql"]`. The extension MUST contribute its own `postgres`
  language id (aliases `["PostgreSQL", "postgres"]`, file extension
  `.pgsql`) with a PostgreSQL-specific TextMate grammar that delegates
  to `source.sql` for the bulk of SQL highlighting. New cells default to
  the `postgres` language so the cell-language picker reads "PostgreSQL"
  regardless of what other SQL extensions the user has installed. Cell
  execution MUST route through the same read-only gate (FR-020) and
  history-recording pipeline as any other query. Cell output MUST render
  inline beneath the producing cell as a `NotebookCellOutput`
  (text/markdown for v1; a richer grid renderer lands as a
  `NotebookRendererProvider` in US6). Notebook-level metadata MUST
  identify the bound connection so the controller can be re-selected on
  restore.

- **FR-036** *(Running SQL from a workspace `.sql` file)*: When the user
  invokes "Run statement" from a `.sql` file in the workspace (not a
  notebook), the extension MUST route execution through the
  most-recently-active `cnpg-sql` notebook's controller, surfacing the
  result as a new cell at the bottom of that notebook (the SQL text +
  its result). If no notebook is open, the extension MUST prompt the
  user to pick a connection, then create a new notebook containing the
  statement.

- **FR-037** *(Grid Editor surface)*: The extension MUST provide a
  dedicated Grid Editor surface (a `vscode.WebviewPanel` opened in a
  separate editor tab) that delivers full DB-IDE-parity tabular
  editing. The Grid Editor MUST be reachable from at least two
  entrypoints: (a) right-clicking a TABLE (or VIEW / MATERIALIZED
  VIEW) in the Schema tree → **CNPG: Open in Grid Editor**; (b) the
  command palette via **CNPG: Open Table in Grid Editor...**. Opening
  on a VIEW or MATERIALIZED VIEW MUST render the grid in read-only
  mode regardless of the connection mode (the view's underlying
  storage is not directly editable). The Grid Editor MUST be styled
  exclusively via `--vscode-*` CSS variables (no hard-coded colors —
  enforced by the theme-snapshot test) and MUST pass the webview CSP
  audit (`scripts/audit-webview-csp.mjs`).

- **FR-038** *(Grid Editor capabilities)*: The Grid Editor MUST
  support, at minimum:
  - Virtualized rendering for ≥100k rows without scroll jitter (real
    DB-IDE feel — DBeaver / DataGrip / TablePlus / Beekeeper-parity).
  - Per-type cell editors (text, number, boolean, date / timestamp,
    `jsonb` / `json` via a popout editor, enum-typed columns rendered
    as dropdowns from the column's underlying `pg_type` allowed
    values).
  - Distinct visual treatment for NULL (grayed `NULL`) and DEFAULT
    (italic `DEFAULT`); explicit keystrokes for "set NULL" and "reset
    to DEFAULT" on the focused cell.
  - Per-column header affordances: sort, multi-column sort (Shift +
    click), single-column filter UI, hide / show, freeze first N
    columns, resize (persisted per `(connection, table)` in workspace
    state). The header MUST mark the PK column(s) with a 🔑 indicator
    and FK columns with a `→` indicator that, on right-click, offers
    **Go to referenced row** which opens a new Grid Editor tab for
    the referenced table filtered to the FK target value.
  - Dirty-row tracking: a left-gutter mark on rows with pending edits
    plus an "X unsaved" status in the footer. **Apply** commits all
    dirty rows in a single client-side preview of the assembled
    UPDATE statements (one per dirty row, parameterized — same gate
    the cell-edit orchestrator already enforces) and a single user
    confirmation. **Revert** discards pending edits.
  - Row-level operations: **Add Row** (opens an in-grid row form
    seeded with column defaults), **Delete Selected** (requires the
    same typed-name confirmation gate as DROP / TRUNCATE — the
    typed name is the table identifier). Multi-row selection is
    supported.
  - Result-set affordances: footer shows `<rows shown> of <total> ·
    <duration>ms · PK: <cols>`. The **Refresh** button re-runs the
    underlying SELECT against the same connection. **Export** offers
    CSV, JSON, and INSERT-statement export of the selection (or all
    rows if nothing is selected); the SQL form routes through
    `redact()` so no credential literal can survive export to disk.
  - Connection mode mirroring: when the bound connection toggles
    between read-only and Write modes, the Grid Editor's edit
    affordances MUST follow without requiring a tab reopen.

- **FR-039** *(Grid Editor persistence)*: The Grid Editor's per-table
  state — visible columns, column order, column widths, sort columns,
  filter values, scroll position — MUST persist across VS Code reload
  in the per-workspace storage (same surface as query history).
  Persistence MUST be keyed by `(contextName, namespace, clusterName,
  database, schema, table)` so reopening the same table restores the
  user's preferred layout, while a different table starts with the
  defaults. Persisted state MUST NOT include any cell data (in-memory
  result sets are never persisted, per Constitution §Security) — only
  the layout primitives above.

### Key Entities

- **Kubeconfig Context**: A named pointer to a Kubernetes API server and a
  set of credentials, as discovered in the user's kubeconfig file. Each
  context is the root of one subtree.
- **Namespace**: A Kubernetes namespace within a context, surfaced only
  when it contains at least one CNPG `Cluster`.
- **CNPG Cluster**: A `postgresql.cnpg.io/Cluster` custom resource. Carries
  identifying attributes (name, namespace, context) and observable state
  (phase, instance count, primary instance, PostgreSQL version, storage
  size, most-recent condition message).
- **Operator Presence**: A per-context flag indicating whether the CNPG
  CRD is installed and readable by the current user.
- **CNPG Secret (Database Credential)**: A Kubernetes Secret owned by or
  annotated as belonging to a CNPG Cluster, holding a `username` and
  `password` (and optionally a `database` name). Surfaced in the
  credential picker; never persisted to disk.
- **Port-Forward Tunnel**: A per-cluster SPDY tunnel from the user's
  workstation to the cluster's primary read/write service, with state
  (opening / open / retrying / closed) and a locally-bound ephemeral
  port.
- **Database Connection**: A logical PostgreSQL session built on top of a
  Port-Forward Tunnel, identified by (cluster, secret, database). Carries
  a mode flag (read-only / write). Surfaced to the user as a Notebook
  Controller (see below).
- **Notebook Controller**: A `vscode.NotebookController` registered for
  `cnpg-sql` notebooks. Exactly one controller exists per active
  Database Connection; the controller's id is the connection's id, its
  label is `cluster/db (mode)`. Owns cell execution: routes each cell's
  text through the read-only gate and the connection's `query()`.
- **CNPG SQL Notebook**: A `cnpg-sql` notebook file (saved or untitled)
  consisting of code cells (`sql` language) and optional markdown cells.
  Notebook-level metadata records the bound controller id so the
  selection restores after a VS Code restart. Cell outputs (rendered
  query results) live inside the notebook's serialised form.
- **Per-Cluster Notebook Folder**: A workspace-relative directory at
  `<workspaceRoot>/<base>/<context>/<namespace>/<cluster>/` where
  `<base>` is the `cnpg4vscode.notebooks.location` setting. Holds
  `.cnpg-sql` notebooks saved via "Save to cluster". Surfaced under the
  matching cluster row in the Clusters tree. A discoverability
  convention, not a storage requirement (FR-037).
- **Result Grid Row Edit**: A staged client-side change to a row in a
  table with a usable primary key. Holds the original values, the new
  values, and a generated UPDATE/DELETE preview.
- **Schema Tree Node**: A node in the database browser tree of a known
  type (schema, table, view, materialized view, index, sequence,
  function, procedure, trigger, type, extension, role) with type-
  specific action set.
- **Saved Script**: A `.sql` file in the workspace at a user-configurable
  location (default `.cnpg/scripts/`), listed in the Saved Scripts view.
- **Query History Entry**: A persisted record of one executed statement
  with credentials scrubbed: SQL text (redacted), cluster, database, user,
  timestamp, success/error, rows affected.
- **Migration Script**: A user-assembled, ordered list of DDL statements
  produced by the migration wizard, executable as a single transaction
  where supported and exportable to a `.sql` file in the workspace.
- **ER Diagram**: A read-only rendered visualisation of a selected scope
  of tables with their primary keys, foreign keys, and column lists.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user with a kubeconfig containing one reachable CNPG-
  enabled cluster can open VS Code and visually locate that cluster in
  under 15 seconds from extension activation.
- **SC-002**: For a kubeconfig context containing up to 50 CNPG clusters,
  the tree renders all clusters within 3 seconds of expanding the context
  (on a typical broadband connection to a regional Kubernetes API server).
- **SC-003**: Every error state surfaced by the extension (RBAC denial,
  network error, CNPG not installed, expired credentials) is
  distinguishable from every other error state by name or icon — verified
  by a usability check with at least 3 test users who can correctly
  identify each state without consulting documentation.
- **SC-004**: A user who has never used the extension before can find and
  identify the primary instance of a known cluster in under 60 seconds
  from first activation, without reading external docs.
- **SC-005**: While the tree view is open and idle, the extension consumes
  fewer than 50 MB of additional VS Code process memory and issues no more
  than one set of API calls per refresh interval per visible context.
- **SC-006**: Zero credentials, bearer tokens, or kubeconfig file contents
  appear in the extension's Output channel across the full test suite
  (verified by an automated log scrubber check).
- **SC-007**: From expanding a cluster to a connected, queryable SQL
  console (default credential accepted), the user reaches a usable
  prompt in under 10 seconds on a typical broadband connection.
- **SC-008**: 100% of statements not on the read-only allowlist are
  rejected client-side when the connection is in read-only mode, across
  an automated test corpus of at least 50 representative statements
  (DML, DDL, transaction control, vendor-specific).
- **SC-009**: All destructive tree actions (DROP, TRUNCATE, REINDEX,
  destructive ALTER) require a typed-name confirmation before
  executing, verified by an automated UX test that asserts the
  confirmation modal blocks execution until the target name is typed
  exactly.
- **SC-010**: Zero credential-shaped literals (passwords inside
  `PASSWORD '...'` / `IDENTIFIED BY '...'`, bearer-token-shaped strings)
  appear in persisted query history or restored console buffers across
  a redaction test corpus of at least 30 statements.
- **SC-011**: A result grid backed by a SELECT returning 1 million rows
  renders the first page in under 2 seconds and never holds more than
  10 000 rows in memory at once.
- **SC-012**: Tearing down a port-forward tunnel (cluster collapse or
  VS Code exit) closes all dependent database connections and logs the
  reason within 2 seconds, with no orphaned local processes or sockets
  remaining (verified by an integration test).

## Assumptions

- **No feature description was supplied with `/speckit-specify`.** The
  spec author selected the read-only Cluster Explorer as the foundational
  MVP because it is the smallest end-to-end slice that proves the
  extension's value proposition (VS Code ↔ kubeconfig ↔ CNPG CRDs) and
  unlocks every subsequent feature. If a different MVP was intended, this
  spec should be replaced rather than amended.
- The user has a working kubeconfig and at least one Kubernetes cluster
  reachable from their workstation. Bootstrapping a cluster or installing
  the CNPG operator is out of scope.
- The user is responsible for installing the CNPG operator on their
  clusters; the extension only detects whether it is installed.
- **Kubernetes-level state is read-only in this feature.** Mutating
  Kubernetes operations against the CNPG Cluster CR (scale instances,
  failover, delete cluster, edit CRD) are deferred to later features
  and are explicitly out of scope here.
- **Database-level (SQL) operations are read-write under a two-tier
  mode.** Every database connection opens in read-only mode by default
  and the user explicitly toggles Write mode per connection (FR-020).
  This means SQL execution, DDL, cell editing, visual editors,
  migrations, and the destructive tree actions are all in scope —
  governed by Write mode and the typed-name confirmation gate.
- This is a substantial scope; the implementation plan is expected to
  sequence the SQL surface across multiple delivery increments (e.g.,
  US4 → US5 → US6, with US6 sub-capabilities possibly split). Each
  user story remains independently testable per the spec template.
- VS Code engine version compatibility is to be decided at plan time; for
  the purposes of this spec, "current stable VS Code" is assumed.
- The extension targets the desktop VS Code product. VS Code Web /
  github.dev support is out of scope for this feature; it may be
  reconsidered when network access patterns are better understood.
- Telemetry is disabled by default (per constitution §IV). Adding opt-in
  telemetry is out of scope for this feature.
