# Contract — VS Code commands

Every command the extension contributes via `package.json`
`contributes.commands`. IDs are stable (changing them is a MAJOR bump
per the constitution's versioning policy).

Categories: all under `CNPG`.

| ID | Title | When-clause | Purpose |
|---|---|---|---|
| `cnpg.refresh` | `CNPG: Refresh` | `view == cnpg.clusters` | Re-query visible contexts now (FR-005). |
| `cnpg.reveal` | `CNPG: Reveal in Tree` | always | Reveal a given cluster/database/table in the tree by id (programmatic use from other commands). |
| `cnpg.cluster.showDetails` | `CNPG: Show Cluster Details` | `view == cnpg.clusters && viewItem == cluster` | Open the read-only cluster summary (US2). Reachable via the context menu only — single-click on a cluster invokes `cnpg.cluster.connect` instead per FR-019. |
| `cnpg.cluster.connect` | `CNPG: Connect` | `view == cnpg.clusters && viewItem == cluster` | Run the credential picker and open a SQL console (US4). Bound as the default single-click action on cluster rows. Idempotent: if a connection already exists for the cluster, opens a new console bound to it without re-tunneling or re-prompting. |
| `cnpg.cluster.disconnect` | `CNPG: Disconnect` | `view == cnpg.clusters && viewItem == cluster && cnpg.cluster.connected` | Tear down tunnel + dependent connections (FR-031). |
| `cnpg.connection.toggleWriteMode` | `CNPG: Toggle Write Mode` | `editorLangId == sql && cnpg.activeConnection` | Toggle read-only ↔ write for the active connection (FR-020). |
| `cnpg.connection.actions` | `CNPG: Connection Actions` | `cnpg.activeConnection` | Status-bar action menu (Quick Pick): Switch to Write / Read-only mode, Open new notebook with this controller, Switch connection, Disconnect. Operates on the active notebook's selected controller when one exists; otherwise on the sole active connection (or prompts to pick). |
| `cnpg.notebook.new` | `CNPG: New SQL Notebook` | always | Create a new untitled `cnpg-sql` notebook, prompting for the target connection / controller (FR-035). |
| `cnpg.notebook.saveToCluster` | `CNPG: Save Notebook to Cluster` | `notebookType == cnpg-sql` | Save the active `cnpg-sql` notebook under the convention path `${workspaceRoot}/<base>/<context>/<namespace>/<cluster>/<name>.cnpg-sql` (FR-037). Prompts for a name; refuses with an error when no workspace folder is open. |
| `cnpg.runFromSqlFile` | `CNPG: Run Statement (from .sql file)` | `editorLangId == sql && cnpg.activeConnection && !inNotebookEditor` | Execute the statement under the cursor (or the selection) from a workspace `.sql` file. Routes through the most-recently-active `cnpg-sql` notebook's controller; if none is open, prompts to create one. Result lands as a new cell at the bottom of the target notebook (FR-036). |
| `cnpg.notebook.openSaved` | (no UI title — used by tree-node click) | always | Open a saved `.cnpg-sql` file by its workspace URI. Invoked from the per-cluster notebook tree-node click handler. |
| `cnpg.tree.copyName` | `CNPG: Copy Fully-Qualified Name` | `view == cnpg.schema && viewItem in (schema,table,view,...)` | Copy the schema-qualified identifier (FR-010, FR-023). |
| `cnpg.tree.openDefinition` | `CNPG: Open Definition` | `view == cnpg.schema && viewItem in (table,view,...)` | Open the object's DDL as a read-only `.sql` document. |
| `cnpg.tree.browseRows` | `CNPG: Browse Rows` | `view == cnpg.schema && viewItem in (table,view,materializedView)` | Append a `SELECT * FROM <fqn> LIMIT 100` cell to the active `cnpg-sql` notebook (or create one bound to the relation's connection) and execute it. Result renders inline beneath the cell. |
| `cnpg.tree.countRows` | `CNPG: Count Rows` | `view == cnpg.schema && viewItem in (table,view,materializedView)` | Append `SELECT count(*) FROM ...` as a cell and execute. |
| `cnpg.tree.insertTemplate` | `CNPG: Generate INSERT Template` | `view == cnpg.schema && viewItem == table` | Append a parameterized INSERT cell to the active notebook (or create one bound to the relation's connection) for the user to edit and run. |
| `cnpg.tree.drop` | `CNPG: Drop ...` | `view == cnpg.schema && viewItem in (...) && cnpg.connection.writeMode` | Show the typed-name confirmation modal then execute DROP (FR-024). |
| `cnpg.tree.truncate` | `CNPG: Truncate ...` | `view == cnpg.schema && viewItem == table && cnpg.connection.writeMode` | Typed-confirmation TRUNCATE (FR-024). |
| `cnpg.tree.reindex` | `CNPG: REINDEX ...` | `view == cnpg.schema && viewItem in (table,index) && cnpg.connection.writeMode` | Typed-confirmation REINDEX (FR-024). |
| `cnpg.tree.alterScaffold` | `CNPG: Scaffold ALTER ...` | `view == cnpg.schema && viewItem in (...) && cnpg.connection.writeMode` | Emit editable ALTER into the active console (FR-024). |
| `cnpg.editor.index.create` | `CNPG: New Index...` | `view == cnpg.schema && viewItem == table && cnpg.connection.writeMode` | Open the visual index editor (FR-026). |
| `cnpg.editor.constraint.create` | `CNPG: New Constraint...` | `view == cnpg.schema && viewItem == table && cnpg.connection.writeMode` | Open the visual constraint editor (FR-026). |
| `cnpg.migration.open` | `CNPG: Open Migration Wizard` | `cnpg.activeConnection` | Launch the migration wizard (FR-027). |
| `cnpg.er.open` | `CNPG: Show ER Diagram` | `view == cnpg.schema && viewItem in (database,schema)` | Open the ER diagram webview (FR-028). |
| `cnpg.history.open` | `CNPG: Open Query History` | always | Open the searchable history view (FR-033). |
| `cnpg.history.clear` | `CNPG: Clear Query History` | always | Clear the workspace's history with confirmation. |
| `cnpg.reportProblem` | `CNPG: Report a Problem` | always | Open a copyable buffer with the last 200 redacted log lines (constitution §IV). |

*(Removed: `cnpg.scripts.saveAs` — superseded by VS Code's native Save / Save As on a `cnpg-sql` notebook; see spec.md § Clarifications 2026-05-15 and amended `FR-032`.)*

## Context keys

The extension sets these `when`-clause context keys via `setContext`:

| Key | Type | Meaning |
|---|---|---|
| `cnpg.cluster.connected` | boolean (per cluster node) | True when a `DatabaseConnection` exists for the focused cluster. |
| `cnpg.activeConnection` | boolean | True when **any** database connection exists in the current session (session state, NOT editor binding). Drives Schema view visibility. MUST NOT be flipped off by an editor-focus change — otherwise the Schema view would disappear whenever the user looked at a non-SQL document. |
| `cnpg.connection.writeMode` | boolean | True when the active editor's bound connection is in write mode. Reflects editor state, may flip on editor focus changes. |
| `cnpg.tunnel.state` | `'idle' \| 'opening' \| 'open' \| 'retrying' \| 'closed' \| 'error'` (per node) | Drives icon swapping in the cluster tree. |

## Tree view contributions

| View id | Container | Provider |
|---|---|---|
| `cnpg.clusters` | Activity bar → `cnpg` (custom view container) | `ClustersTreeProvider`. Cluster rows are collapsible when at least one notebook exists under their per-cluster folder (`<workspaceRoot>/<base>/<context>/<namespace>/<cluster>/*.cnpg-sql`); expanded, the row's children are notebook leaves that open the file on click. Per FR-037. |
| `cnpg.schema` | Activity bar → `cnpg` | `SchemaTreeProvider` (visible when ≥ 1 active connection) |
| `cnpg.history` | Panel area | Backed by SQLite + FTS5 query (deferred) |

*(Removed: `cnpg.savedScripts` — saved `cnpg-sql` notebooks appear in VS Code's standard file explorer; a dedicated CNPG sidebar duplicated that capability without adding value. See spec.md § Clarifications 2026-05-15 and amended `FR-032`.)*

## Status-bar items

| Id | Alignment | Behavior |
|---|---|---|
| `cnpg.activeConnection` | Right, priority 100 | Shows `cluster/db ⚙ read-only` or `cluster/db ⚙ write` reflecting the active editor's bound connection. When the active editor has no binding but connections exist, shows `cluster/db (unbound editor)`. Clicking invokes `cnpg.connection.actions`, which opens a Quick Pick with Toggle Write Mode / Bind / Switch / Disconnect. Color: warning background when in write mode. |

## Stability policy

- Removing or renaming any ID in this table is a MAJOR version bump
  (constitution §Development Workflow → Versioning).
- Adding a new ID is a MINOR bump.
- Changing only the title or icon is a PATCH bump.
