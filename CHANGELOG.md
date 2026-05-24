# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet. Next planned: an `@vscode/test-electron` + testcontainers
e2e harness and performance-budget enforcement (the tasks blocked on
test infra in spec 001).

## [1.0.3] — 2026-05-24

### Changed

- Removed the `preview` flag from the Marketplace listing — the
  extension is past its first public release and is no longer
  preview-quality.
- Added an extension icon (square logo) so the Marketplace listing and
  the Extensions view show branding instead of the default placeholder.
- `galleryBanner` color + theme set for a coherent listing header.
- Restructured this CHANGELOG into proper Keep-a-Changelog versioned
  sections (it had accumulated under a single `[Unreleased]` block) so
  the Marketplace "Changelog" tab reads cleanly.

## [1.0.2] — 2026-05-24

### Fixed

- **Extension failed to activate on Marketplace installs** —
  `@kubernetes/client-node` was marked `external` in the esbuild config
  but the VSIX is packaged with `vsce package --no-dependencies`, so the
  module was absent at runtime. The first `require('@kubernetes/client-node')`
  threw, crashing `activate()` before any command or tree-data provider
  registered (symptoms: "command 'cnpg.refresh' not found" and "There is
  no data provider registered that can provide view data"). Dev (F5)
  masked it because `node_modules` is present on disk there. Fixed by
  bundling the Kubernetes client into `dist/extension.js`.

## [1.0.1] — 2026-05-24

### Fixed

- **Clusters pane empty on Marketplace installs** — `activationEvents`
  only listed `onLanguage:sql`, so opening the CloudNativePG view didn't
  activate the extension (and thus never registered the tree-data
  provider). Added explicit `onView:cnpg.clusters`, `onView:cnpg.schema`,
  and `onLanguage:postgres` activation events. (Superseded as the full
  fix by 1.0.2, which addressed the underlying activation crash.)

## [1.0.0] — 2026-05-17

First public release on the VS Code Marketplace, shipped as six
per-platform VSIXs (linux-x64/arm64, darwin-x64/arm64, win32-x64/arm64)
via an automated GitHub Actions pipeline.

### Added (Grid Editor — DB-IDE-parity table editing)

- **Grid Editor surface (FR-037 / FR-038 / FR-039)**. A dedicated
  `vscode.WebviewPanel` per open table, hosting glide-data-grid + React,
  delivering DB-IDE-parity tabular editing: canvas-rendered virtualized
  rows, per-PG-type cell editors (text / number / boolean / date /
  jsonb popout / enum dropdown), per-column sort + filter, dirty-row
  tracking with a single bulk **Apply** that previews every parameterized
  `UPDATE` before running, per-row apply results, FK navigation
  (right-click an FK cell → opens a new pre-filtered Grid Editor tab on
  the referenced table), CSV / JSON / SQL-INSERT export (every emitted
  statement routed through the credential-redaction chokepoint),
  workspace-persisted layout (column widths / sort / filters per
  `(cluster, database, schema, table)`), and tab hibernation via a
  `WebviewPanelSerializer`. Two entrypoints: right-click a table in the
  Schema view → **CNPG: Open in Grid Editor**, or the command palette
  via **CNPG: Open Table in Grid Editor...**. CSP locked to
  `default-src 'none'` with a per-load nonce; no external CDNs, no
  `unsafe-eval`. Read-only gate still applies — Write mode required, and
  views / matviews / PK-less tables stay read-only.

### Added (CI/CD — spec 002)

- **Automated release pipeline** (GitHub Actions). Every PR is gated by
  typecheck + lint + unit + contract tests + production build + webview
  CSP audit + dependency-licence audit + security-advisory scan. Pushing
  a `v*` tag triggers a publish workflow (preflight → wait-for-CI →
  Marketplace collision check → build six per-platform VSIXs → publish →
  GitHub Release with assets + auto-generated changelog). Stable channel
  for bare SemVer tags, pre-release channel for `-pre.N` tags. The PAT
  never appears in any log line. See `docs/release-process.md`.

### Added

- Initial project scaffolding (TypeScript + esbuild + vsce, VS Code engine
  `^1.85.0`).
- Lint guardrail forbidding writes to VS Code persistent state outside
  `src/state/history.ts` and `src/state/tabs.ts` (per Constitution §Security).
- LogOutputChannel-backed logging with credential redaction at the chokepoint
  (per Constitution §IV).
- Foundational test scaffolding (Vitest unit + contract, `@vscode/test-electron` e2e).
- US1: kubeconfig discovery, CNPG operator detection, CNPG Cluster listing,
  Clusters tree view with status indicators.
- US2: read-only cluster detail surface rendered as a markdown preview, with
  copy-friendly inline-code identifiers for each field.
- US3: visibility- and focus-aware refresh timer that pauses when the view
  is hidden or the window loses focus, with live setting reload.
- US4 core: cluster Connect / Disconnect flow with port-forward tunnel FSM,
  CA-pinned TLS to the in-cluster service, credential picker that defaults
  to the `<cluster>-app` Secret, in-process pg connection pool, two-layer
  read-only gate (client-side keyword allowlist + `SET LOCAL
  transaction_read_only` server-side), per-connection Write-mode toggle
  with status-bar indicator, untitled SQL console binding, Ctrl/Cmd+Enter
  run-query command (results render in a sibling preview document until
  the result-grid webview lands in US6).
- US5: lazy-loaded Schema tree (Connection → Schema → Tables / Views /
  Indexes / Sequences / Functions / Triggers / Types …) with a 60-second
  TTL cache and reactive refresh on connect/disconnect. Per-node action
  commands: Copy fully-qualified name, Open Definition (DDL via
  `pg_get_*def` helpers and `pg_attribute` reconstruction), Browse Top
  100, Count Rows, Generate INSERT template. Write-mode actions: DROP,
  TRUNCATE, REINDEX, Scaffold ALTER — each gated by a typed-name
  confirmation modal that cannot be bypassed silently.

### Changed

- Default click on a cluster row now invokes Connect (was Show Details).
  Connect is idempotent: if a connection already exists for the cluster,
  a new console bound to it opens immediately. Show Details is reachable
  via the context menu. Spec `FR-019` records the rule.
- The Schema view no longer disappears when the user switches focus to a
  non-SQL document. `cnpg.activeConnection` now reflects session state
  (whether any connection exists), not editor binding. Spec `FR-022`
  amended to require this. The status bar still tracks the active
  editor's bound connection, showing `(unbound editor)` when no binding
  exists but other connections do.
- Status-bar click now opens an action menu (Toggle Mode / Bind / Switch /
  Disconnect) via the new `cnpg.connection.actions` command instead of
  jumping straight to Bind Connection.
- **Architectural change**: the interactive SQL surface is now a VS Code
  Notebook (`cnpg-sql` notebook type) instead of an untitled `.sql`
  document with per-tab connection binding. One `NotebookController` is
  registered per active database connection; cells execute via
  Shift+Enter (native), and results render inline beneath each cell.
  Schema-tree actions (Browse Rows, Count Rows, INSERT template,
  DROP / TRUNCATE / REINDEX, ALTER scaffold) now append a cell to the
  active notebook instead of opening a preview document. A new
  `cnpg.runFromSqlFile` command supports running statements from
  workspace `.sql` files; it routes through the most-recently-active
  notebook's controller. New requirements `FR-035` (notebook
  architecture) and `FR-036` (run-from-`.sql`-file) record the rule;
  see `spec.md` § Clarifications for the decision and rationale.
- Removed commands: `cnpg.console.open`, `cnpg.console.bindConnection`,
  `cnpg.runQuery`, `cnpg.runQueryAll` (superseded by native notebook
  cell execution + `cnpg.runFromSqlFile`).
- Removed keybinding: custom Ctrl+Enter `cnpg.runQuery`. Notebook cells
  use the native Shift+Enter execute keybinding.
- Contribute our own `postgres` language id (aliases `["PostgreSQL",
  "postgres"]`, file extension `.pgsql`) with a TextMate grammar that
  delegates to `source.sql` and adds PostgreSQL-specific keywords,
  types, and dollar-quoted-string handling. Notebook cells default to
  `postgres` so the cell-language picker reads "PostgreSQL" instead of
  "MS SQL" (the label VS Code applies to its built-in `sql` language
  whenever any Microsoft SQL extension is installed). Spec `FR-035`
  amended.

### Removed

- The "Saved Scripts" sidebar pane (`cnpg.savedScripts` view), the
  `cnpg.scripts.saveAs` command, and the `cnpg4vscode.scripts.location`
  setting. These were designed for the editor-binding console era and
  added no value under the notebook architecture — saving a session is
  now the standard `Ctrl+S` gesture on a `cnpg-sql` notebook, and saved
  files appear in VS Code's regular file explorer. Spec `FR-032`
  amended to describe the notebook-save semantics. Constitution §V
  (Simplicity & YAGNI).

### Added (per-cluster notebook organization)

- New command `cnpg.notebook.saveToCluster` (`CNPG: Save Notebook to
  Cluster`) — prompts for a name and writes the active `cnpg-sql`
  notebook to `${workspaceRoot}/.cnpg/notebooks/<context>/<namespace>/<cluster>/<name>.cnpg-sql`.
  Also available from the status-bar action menu when a CNPG notebook
  is the active editor.
- The Clusters tree now expands cluster rows when at least one saved
  notebook exists in the convention folder. Each notebook appears as a
  leaf that opens on click; the cluster description shows the count.
- The tree updates automatically when notebooks are added, removed, or
  renamed in the workspace (FileSystemWatcher; no polling).
- New setting `cnpg4vscode.notebooks.location` (default
  `.cnpg/notebooks`) — the workspace-relative root of the convention
  path. Resolved against the first workspace folder; refuses absolute
  paths and `..` traversal.
- New requirement `FR-037` records the convention; `FR-032` references
  it. Convention not requirement: notebooks saved outside the folder
  still open, they just don't appear under the cluster.

### Added (polish)

- **Snippets**: 16 PostgreSQL-flavored snippets bundled at
  `snippets/postgres.code-snippets`, contributed for both `postgres` and
  `sql` languages. Triggers: `sel`, `selw`, `cnt`, `ins`, `upd`, `del`,
  `ctbl`, `cidx`, `cuidx`, `addcol`, `expl`, `fn`, `lst`, `slow`,
  `idxstat`, `size`. Available in notebook cells and workspace
  `.sql` / `.pgsql` files (T074).
- **`CNPG: Report a Problem` command** (T128) — opens a Markdown
  document with the most recent 200 log lines (already redacted) plus
  environment info (VS Code / extension / platform / Node versions,
  active connection + tunnel counts). Ready to paste into a support
  thread or GitHub issue. The log buffer is bounded and lives entirely
  in-memory; every captured line has already passed through
  `redact()`.
- **Marketplace metadata** (T132) — added the `Notebooks` category,
  broader keywords, `preview: true`, `qna: "marketplace"`, and
  `extensionKind: ["workspace"]` (the extension must run in the
  workspace host because of its kubeconfig and `pg`-driver
  dependencies).
- **Result-grid notebook renderer** (T104). Cells with query results
  now render in an interactive HTML table instead of a plain-text
  preview. Sticky header, row numbers, theme-aware via `--vscode-*`
  variables, distinct cell styling for NULL / boolean / number / Date /
  object types, sortable scrollable body, footer with row count and
  truncation notice. Implemented as a VS Code
  `NotebookRendererProvider` consuming a new mime type
  `application/x-cnpg-result+json` emitted by the cell output. Falls
  back to the existing `text/plain` and `text/markdown` items if the
  renderer is disabled. The ~4.5 KB renderer bundle is built as a
  second esbuild target (`dist/notebook-renderer.js`). Pure HTML
  builder is unit-tested (10 assertions).
- **ER diagram** (T115/T118 — original T116/T117 superseded). Right-click
  a database or schema in the Schema view → **CNPG: Show ER Diagram** →
  opens a markdown document with a Mermaid `erDiagram` block rendered
  inline. Per-schema and whole-database scopes. **No webview** in v1:
  research §7 revised banner explains the trade-off (Mermaid handles
  the typical CNPG app-DB scale with zero bundle weight from us;
  ELK+D3+webview remains the documented upgrade target if a user hits
  the ~50-table limit). Surfaces a friendly preamble when the table
  count exceeds `cnpg4vscode.er.warnOverTables`. Pure builder is
  unit-tested (11 assertions).
- **`bierner.markdown-mermaid` added as an `extensionDependencies`
  entry.** VS Code's built-in markdown preview does NOT render Mermaid
  natively — it requires this widely-installed extension (6.5M+
  installs, by the VS Code markdown maintainer at Microsoft).
  Marketplace installs of cnpg4vscode now pull it in automatically.
  Dev-mode / VSIX users get a one-time prompt on first ER open with
  Install / Open in Marketplace / Not now. ER markdown still opens
  even if declined — the user just sees the diagram source.
  *(Initial revision incorrectly assumed Mermaid was built into VS
  Code; fixed same day after bug report.)*

### Added (visual constraint editor)

- **No-webview visual ADD CONSTRAINT wizard** (T111 scope variant).
  Right-click a table in the Schema view → **CNPG: New Constraint...** →
  pick kind (PRIMARY KEY / UNIQUE / FOREIGN KEY / CHECK). Kind-specific
  flow follows: PK/UNIQUE collect local columns + auto-suggested name;
  FK walks through local cols → referenced schema → referenced table →
  arity-matched referenced cols → ON UPDATE / ON DELETE action picks;
  CHECK takes a free-form predicate guarded against bare `;` (same
  injection guard as the partial-index WHERE clause). Modal preview
  shows the full ALTER TABLE statement before execution. Pure builder
  + validator at `src/sql/constraint-builder.ts` (22-assertion unit
  suite); host glue extends the existing `src/commands/editors.ts` that
  already houses the index editor — same playbook, two more verbs.

### Added (visual index editor)

- **No-webview visual CREATE INDEX wizard** (T110 scope variant). Right-click
  a table in the Schema view → **CNPG: New Index...** → multi-step flow that
  collects: column selection (multi-select, order preserved — order matters
  for query planning), UNIQUE y/n, CONCURRENTLY y/n, optional WHERE clause
  (partial index — rejects bare `;` as a SQL-injection guard), index name
  (auto-suggested `ix_<table>_<col>...` or `ux_<...>` for unique, truncated
  to PG's 63-char NAMEDATALEN). Modal preview shows the full DDL + a per-
  spec breakdown before execution. *(Same divergence rationale as the
  migration wizard — a webview would re-introduce the host↔renderer message
  protocol that FR-035 retired.)* Pure builder + validator at
  `src/sql/index-builder.ts`, host glue at `src/commands/editors.ts`; pure
  parts have an 18-assertion unit suite at `test/unit/index-builder.test.ts`.

### Added (migration wizard)

- **No-webview migration wizard** (T112 scope variant; FR-027). Two new
  commands — **`CNPG: Open Migration Wizard`** opens an untitled `.sql`
  document seeded with a starter banner; the user authors statements
  there (with real editor affordances — multi-line, syntax highlighting,
  snippets). **`CNPG: Run Migration (active SQL editor)`** picks up the
  document text, splits it at top-level semicolons, classifies the set
  (transactional vs non-transactional based on CREATE INDEX CONCURRENTLY
  and friends), shows a modal preview with the per-statement breakdown
  and a warning banner when non-transactional, executes via the new
  `DatabaseConnection.withClient()` so `BEGIN/COMMIT/ROLLBACK` land on
  one session, then offers to export the assembled SQL to
  `migrations/YYYYMMDD-HHMMSS-migration.sql` in the workspace. Outcome
  (success / failed-with-rollback / partially-applied) renders as a
  markdown summary the user can copy or paste into a support thread.
  *(Diverged from the spec's webview UX — a webview would re-introduce
  the host↔renderer message protocol that the FR-035 notebook refactor
  deliberately retired. Native modals + a real editor deliver the same
  workflow with zero webview surface to theme.)* The pure orchestrator
  (`src/sql/migration-flow.ts`) is unit-tested separately from the host
  glue (11 assertions covering every flow branch); the engine itself
  (`executeMigration` + `exportMigrationToSql`) has its own 21-assertion
  contract suite from the earlier T097/T113/T114 round.

### Added (cluster detail enrichment)

- **Per-pod status on the cluster detail surface (US2 enrichment).**
  The markdown detail view now includes a **Pods** table listing each
  pod that belongs to the cluster (label selector
  `cnpg.io/cluster=<name>`), sorted primary-first then by name. Columns:
  Role (🟢 primary / replica), Name, Phase, Ready (`n/m`), Restarts,
  Age. Terminating pods carry an `_(terminating)_` marker. Issued via
  `CoreV1Api.listNamespacedPod` — see `contracts/k8s-api.md § Pod
  listing`. If the call fails (e.g. 403 on Pods in the cluster's
  namespace) the rest of the detail surface still renders, with a
  `Could not list pods: <message>` line in place of the table
  (FR-007 sibling-resilience). Pure derivation is unit-tested
  (`test/unit/cluster-pods.test.ts` — 8 assertions) and the rendering
  branch is covered in `test/unit/cluster-detail.test.ts` (5 new
  assertions covering healthy table, terminating marker, error
  passthrough, empty-state, and omit-when-absent).

### Added (release prep)

- **Comprehensive README** (T134) — feature overview, security
  posture, roadmap, governance pointer. Replaces the placeholder.
- **`docs/quickstart.md`** (T134) — user-facing 10-step walk-through
  from install to first query. Distinct from the dev quickstart in
  the spec dir, which is for contributors.
- **`docs/features.md`** (T134) — per-feature walk-through with
  screenshot placeholders ready for the v1 packaging pass.
- **`docs/troubleshooting.md`** (T134) — common gotchas: kubeconfig
  env on macOS, RBAC denial, expired EKS / GKE / AKS tokens,
  proxy-strips-SPDY, missing Mermaid extension, etc.
- **Per-platform VSIX packaging** (T131) at `scripts/package.mjs`.
  Builds `vsce package --target <platform-arch>` for all 6 supported
  platforms (linux-x64 / arm64, darwin-x64 / arm64, win32-x64 / arm64).
  `pnpm package --target <one>` for a single platform. `.vscodeignore`
  ensures the spec dir, tests, and dev configs don't ship.
- **Webview CSP audit script** (T130) at `scripts/audit-webview-csp.mjs`.
  Walks `dist/` for `.html` files, fails on missing CSP or escape
  patterns. Today reports clean (no webviews); remains as a gate for
  future cell-editing / ELK+D3 work.
- **Extended redaction property-test corpus** (T125) — two new fixture
  pairs (`role-variants`, `whitespace-and-comments`) covering CREATE
  GROUP / ALTER ROLE / CREATE USER MAPPING / multi-line + tab
  whitespace.
- **`package.json` repository / bugs / homepage URLs** pointing at
  `https://github.com/irulast/cnpg4vscode`. Resolves vsce's
  relative-link warning and makes README links work in the
  Marketplace listing.

### Added (query history — T072 + T129)

- **Per-workspace query history**. Every notebook cell execution is
  recorded to `${context.storageUri}/history.json` (per-workspace,
  bounded to `cnpg4vscode.history.maxEntries`, default 1000). SQL is
  redacted before persistence; a defensive guard inside the store
  rejects any entry whose text still matches a credential pattern.
- **`CNPG: Open Query History`** command surfaces a native Quick Pick
  (filter-as-you-type) over the 200 most-recent entries. Each row
  shows status / row count / duration / cluster-db / relative time.
  On pick, the SQL appends as a new cell to the active `cnpg-sql`
  notebook (or opens in a sibling SQL document if none is active).
- **`CNPG: Clear Query History`** command with confirmation modal.
- **Storage choice** (research §11 revised banner): shipped as JSON +
  in-memory filter, not SQLite + FTS5. JSON handles the typical CNPG
  user's session size (~100–500 queries) with zero native-binding
  complexity, zero per-platform packaging penalty, and trivial
  migration. SQLite remains the documented upgrade target if a user
  reports search latency at scale; the storage interface is
  intentionally swappable.
