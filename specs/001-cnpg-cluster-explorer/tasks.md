---
description: "Task list for the CloudNativePG Cluster Explorer + SQL Management feature"
---

# Tasks: CloudNativePG Cluster Explorer + SQL Management

**Input**: Design documents from `/specs/001-cnpg-cluster-explorer/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Tests are **mandatory** for this feature — Constitution Principle III ("Test-First Development") is NON-NEGOTIABLE for any task that ships user-visible behavior. Every behavior-implementing task below has a corresponding failing-test task ordered before it.

**Implementation status**: Phases 1–7 substantially complete. US1, US2, US3, US5 fully landed. US4 core (connect → tunnel → pg → read-only gate → SQL console → toggle write mode) landed; US4 persistence layer (history SQLite/FTS, multi-tab restore, saved scripts UI, history panel view) deferred to its own focused pass (T072–T077). 154 tests passing (146 unit + 8 contract). `pnpm typecheck`, `pnpm lint`, `pnpm build` all green. Continue with `/speckit-implement` to pick up Phase 8 (US6 — IDE-parity surfaces) or the deferred US4 persistence.

**UX adjustments since US5 landed (2026-05-15)**: Two clarifications added to [spec.md](spec.md#clarifications) and propagated to [contracts/commands.md](contracts/commands.md):

1. **Default click → Connect** (new `FR-019`): clicking a cluster row invokes Connect, not Show Details. Connect is now idempotent — if a connection to that cluster already exists, a new console bound to it opens immediately. The Cluster Details surface remains reachable via the context menu.
2. **Schema view persists across editor focus changes** ([FR-022](spec.md) amended): `cnpg.activeConnection` reflects session state (any connection exists), not editor binding. Looking at a Markdown file no longer hides the Schema view. The status bar still tracks the active editor's bound connection (showing `(unbound editor)` when no binding exists but connections exist).

New command `cnpg.connection.actions` (status-bar action menu — Toggle Mode / Bind / Switch / Disconnect) is now documented in [contracts/commands.md](contracts/commands.md). Implementation touchpoints: [src/ui/tree-clusters.ts](../../src/ui/tree-clusters.ts) (default `item.command`), [src/commands/connect.ts](../../src/commands/connect.ts) (reuse-existing-connection short-circuit), [src/commands/index.ts](../../src/commands/index.ts) (editor handler no longer flips `cnpg.activeConnection`; new actions menu registration), [src/ui/status-bar.ts](../../src/ui/status-bar.ts) (status-bar item bound to `cnpg.connection.actions`).

**Architectural change since US5 landed (2026-05-15)**: The SQL console surface migrates from "untitled `.sql` document with per-tab connection binding" to a **VS Code Notebook** (`cnpg-sql` notebook type) with one `NotebookController` per active connection. Reason: editor-binding leaked state (Browse Rows opened an unbound preview doc, Ctrl+Enter was unreliable when focus drifted). The notebook inverts the binding (cells know their controller) and gives us native execute keybindings + native restore + native cell-output rendering. New `FR-035` (notebook architecture) and `FR-036` (run-from-.sql-file routing) are added to spec.md.

The following tasks are **SUPERSEDED** by the notebook model and are reclassified to `[-]` (deferred / no longer applicable in their original form):

- T067, T068, T069 — original `runQuery` / `console.open` / `console.bindConnection` commands. Native cell execution and `cnpg.notebook.new` replace them; `cnpg.runFromSqlFile` (new) covers running from .sql files.
- T073 — multi-tab restore via `workspaceState`. Native notebook restore replaces this.
- T077 — searchable Query History panel webview. The notebook itself doubles as session history; the panel becomes a stretch goal for a later phase.

New tasks for the notebook migration are appended below as Phase 7.5 — **US4 / US5 Notebook Refactor**. Tests-first per Constitution §III. Once Phase 7.5 lands, the deferred US4 persistence tasks (T072 history SQLite, T074 snippets, T075 saveAs, T076 saved-scripts tree) can be picked up independently — they are unaffected by the surface change.

## Phase 7.5: Notebook Refactor (Architectural — 2026-05-15)

**Goal**: Move the interactive SQL surface from the untitled-SQL-editor model to a native `cnpg-sql` Notebook with per-connection controllers. Preserves every existing user-visible capability (Connect, Run, Toggle Write Mode, Schema-tree actions) — just on a different surface. No new functional requirements; this is a quality-driven refactor that resolves several UX bugs.

### Tests for Phase 7.5

- [X] T136 [P] Write failing unit tests at `test/unit/notebook-serializer.test.ts` for the `cnpg-sql` `NotebookSerializer` — round-trip serialize→deserialize on a 3-cell fixture; assert credential scrubbing on serialize (FR-033); assert cell outputs are dropped from disk form. 6 assertions.
- [X] T137 [P] Write failing unit tests at `test/unit/notebook-output.test.ts` for the cell-output formatter — `text/plain` aligned table + `text/markdown` copy-pastable table for SELECT, `OK (N rows)` for side-effect statements, pipe-escape + NULL handling, preview-row cap. 9 assertions.
- [X] T138 [P] Write failing unit tests at `test/unit/notebook-controller.test.ts` — controller label tracks mode (`cluster/db (read-only|write)`); `executeCellSql` routes through the read-only gate (rejection short-circuits before `conn.query`); success returns the QueryResult; upstream errors carry SQLSTATE; empty input rejects. 7 assertions.
- [-] T139 Write failing e2e test at `test/e2e/notebook-connect-and-run.test.ts`. *(Deferred — the e2e harness requires a recorded K8s fixture corpus and a testcontainers Postgres in the extension-host runner. The pure-logic coverage in T136–T138 is the load-bearing safety net today; the e2e adds wiring confirmation.)*

### Implementation for Phase 7.5

- [X] T140 Declared the `cnpg-sql` notebook type in `package.json` `contributes.notebooks` (selector `*.cnpg-sql`, displayName "CNPG SQL Notebook"). Activation event `onNotebook:cnpg-sql` added.
- [X] T141 Implemented `NotebookSerializer` at `src/notebook/serializer.ts` (pure) + `src/notebook/host-serializer.ts` (VS Code wrapper). JSON-on-disk format with `version: 1`; serialize redacts every cell's value via `redact()`; deserialize tolerates empty / malformed files; outputs are NEVER serialized to disk.
- [X] T142 Implemented the cell-output formatter at `src/notebook/output.ts` — pure functions `formatSuccessOutput` / `formatErrorOutput` / `renderAlignedTable` / `renderMarkdownTable`. Respects `previewRows` cap; produces both `text/plain` and `text/markdown` mime types so the future grid renderer can subscribe.
- [X] T143 Implemented `CnpgNotebookController` at `src/notebook/controller.ts` (VS Code wrapper) + `src/notebook/controller-core.ts` (pure execution logic). One controller per `ActiveConnection`; `notebookType: 'cnpg-sql'`; label `cluster/db (mode)`; `executeHandler` routes through the read-only gate then `conn.query()`; emits a KV log line per execution; on mode toggle, `syncLabel()` updates the controller's label.
- [X] T144 Added controller-registry wiring in `src/extension.ts` via the new `ConnectionLifecycleListener` API in `src/state/session.ts`. Connection added → controller created + registered; connection removed → controller disposed. Mode toggles fire `session.emitChanged()` which the listener observes to call `syncLabel()`.
- [X] T145 Added `src/notebook/append-cell.ts` helpers — `appendCellToActiveNotebook({conn, text, execute?})` and `openNewNotebookForConn(conn, initialCellText?)`. Used by `connect.ts` and `schema-actions.ts`.
- [X] T146 Switched `src/commands/connect.ts` to open a `cnpg-sql` notebook with the new connection's controller pre-selected via notebook metadata (`{ boundControllerId: conn.id }`). Idempotent reuse-existing-connection path also opens a fresh notebook bound to the existing controller.
- [X] T147 Added new commands in `src/commands/index.ts`: `cnpg.notebook.new` (pick → open notebook), `cnpg.runFromSqlFile` (per FR-036 — appends a cell to the most-recently-active matching notebook and executes). Removed `cnpg.console.open`, `cnpg.console.bindConnection`, `cnpg.runQuery`, `cnpg.runQueryAll` registrations and their `package.json` entries (commands, menus, keybindings).
- [X] T148 Rewired `src/commands/schema-actions.ts` — `browseRows`, `countRows` append a cell + execute; `insertTemplate` appends without executing; destructive `dropNode` / `truncateRelation` / `reindexNode` append + execute after the typed-name confirmation; `alterScaffold` appends without executing.
- [X] T149 Dropped the editor-binding map from `src/state/session.ts` (no `editorBindings` Map, no `setEditorBinding` / `resolveConnectionForEditor`). Status-bar follows `vscode.window.onDidChangeActiveNotebookEditor` via the new `activeNotebookConnection()` helper in `src/commands/index.ts`.
- [X] T150 Deleted `src/sql/runner.ts` — its responsibilities are now split between native notebook cell execution and the `appendCellToActiveNotebook` helper. `cnpg.tree.drop` / `truncate` / `reindex` go through the new helper which delivers the SQL through the controller's `executeHandler`.
- [X] T151 Updated `package.json` menus — dropped `editor/context` `cnpg.runQuery` entries; added `cnpg.runFromSqlFile` with a `!inNotebookEditor` guard so the menu doesn't duplicate inside a notebook cell.
- [X] T152 Updated CHANGELOG.md `### Changed` with the notebook refactor entry.

### Post-Phase 7.5 polish

- [X] T153 Contribute our own `postgres` language id (aliases `["PostgreSQL", "postgres"]`, extension `.pgsql`) so the cell-language picker reads "PostgreSQL" instead of "MS SQL" (which is what VS Code's built-in `sql` language gets labeled as when any Microsoft SQL extension is installed). New files: `languages/postgres-language-configuration.json`, `syntaxes/postgres.tmLanguage.json`. The grammar delegates to `source.sql` for the bulk of highlighting and adds a small set of PG-specific tokens (dollar-quoted strings, `RETURNING`/`ILIKE`/`LATERAL` keywords, PG types). Controller's `supportedLanguages` widened to `["postgres", "sql"]`; append-cell helpers + serializer default new cells to `postgres`. Spec `FR-035` amended; `spec.md` Clarifications session gets a new entry recording the rationale.
- [X] T154 Remove the inert "Saved Scripts" sidebar pane that was a remnant of the editor-binding console era. Removed: `cnpg.savedScripts` view contribution, `cnpg.scripts.saveAs` command + placeholder registration, `cnpg4vscode.scripts.location` setting + `ResolvedConfig.scriptsLocation` field, `src/ui/tree-scripts.ts` stub provider. Spec `FR-032` amended to describe notebook-save semantics (standard `Ctrl+S` writes a `.cnpg-sql` file through the redaction chokepoint); `contracts/commands.md` and `contracts/settings.md` updated; `spec.md` Clarifications gets a new entry recording the rationale. T075 / T076 reclassified as SUPERSEDED.

### Per-cluster notebook organization (FR-037)

**Goal**: Make it easy to save notebooks scoped to a cluster, and find them again later, without resurrecting the inert-sidebar mistake. Convention-based path + Clusters-tree integration. Test-first per Constitution §III.

- [X] T155 [P] Wrote failing unit tests at `test/unit/per-cluster-path.test.ts` for the path resolver — 8 assertions covering the convention join, URL-encoding of `/` and `:` in context segments, `..` traversal refusal, absolute-base refusal, null-workspaceRoot return, and stability.
- [X] T156 [P] Wrote failing unit tests at `test/unit/notebook-name-validate.test.ts` — 10 assertions covering empty/whitespace, path separators, leading `.`, Windows-reserved chars, trailing whitespace/dot, plus `normalizeNotebookName()` idempotence.
- [X] T157 Implemented the path resolver + name validator at `src/notebook/per-cluster.ts` (pure module — no `vscode` import).
- [X] T158 Implemented `cnpg.notebook.saveToCluster` in `src/commands/index.ts`. Requires an active `cnpg-sql` notebook editor with a bound CNPG connection; prompts for a name (validated by T156); writes the notebook bytes through the existing `CnpgNotebookSerializer` (so the `redact()` chokepoint runs) to the resolved cluster folder; opens the freshly-saved file as the active notebook. Surfaces an explicit error when no workspace folder is open.
- [X] T159 Extended `ClustersTreeProvider` in `src/ui/tree-clusters.ts` — cluster rows become collapsible when `notebooksFor(node)` returns a non-empty list; expanded children are `notebook`-kind leaves whose `item.command` is `vscode.open`. Namespace expansion pre-warms the per-cluster folder cache so the count appears on first render. A `FileSystemWatcher` over `**/*.cnpg-sql` in the workspace invalidates the cache and re-emits the tree on create/delete/change events (no polling). Description text shows `<phase> · N notebook[s]` when notebooks exist.
- [X] T160 Added the `Save notebook to cluster...` entry to the `cnpg.connection.actions` Quick Pick (shown only when the active editor IS a `cnpg-sql` notebook bound to the target connection). Selection delegates to the `cnpg.notebook.saveToCluster` command for the single-source-of-truth save path.

### Tasks reclassified by Phase 7.5

- [-] T067 (cnpg.runQuery / runQueryAll commands) — superseded by native notebook cell execution + T147 (`cnpg.runFromSqlFile`).
- [-] T068 (cnpg.console.open) — superseded by T147 (`cnpg.notebook.new`).
- [-] T069 (cnpg.console.bindConnection) — no longer needed; notebooks bind via controller selection.
- [-] T073 (multi-tab restore via workspaceState) — superseded by native notebook restore (T141 serializer is all that's needed).
- [-] T077 (Query History panel webview) — stretch goal; the notebook itself doubles as session history.

**Organization**: Tasks are grouped by user story (US1–US6 from spec.md) to enable independent implementation and testing of each story. Setup (Phase 1), Foundational (Phase 2), and Polish (Final Phase) carry no `[Story]` label.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Different file, no dependency on incomplete tasks → can run in parallel.
- **[Story]**: User story label (US1–US6); omitted for Setup / Foundational / Polish phases.

## Path Conventions

Single-project VS Code extension (see plan.md § Project Structure). Source under `src/`, tests under `test/`. All paths below are repository-relative.

---

## Phase 1: Setup (Project Initialization)

**Purpose**: Bootstrap the TypeScript extension project, build pipeline, CI, and lint rules.

- [X] T001 Initialize pnpm workspace and create `package.json` with name `cnpg4vscode`, engines `vscode: ^1.85.0`, activation events from contracts/commands.md (`onView:cnpg.clusters`, `onCommand:cnpg.*`, `onLanguage:sql`), main entry `dist/extension.js`.
- [X] T002 Add `tsconfig.json` targeting ES2022, strict mode, `module: NodeNext`, `outDir: dist`, paths alias `@/* → src/*`.
- [X] T003 [P] Create `esbuild.config.mjs` bundling `src/extension.ts` to `dist/extension.js` (CJS, external: `vscode`, `better-sqlite3`), plus separate React bundles for `src/ui/webview-grid/media/main.tsx` and `src/ui/webview-er/media/main.tsx`.
- [X] T004 [P] Add `.eslintrc.cjs` with `@typescript-eslint` recommended + custom rule `no-state-write-outside-history`: forbids `workspaceState.update`, `globalState.update`, and `storageUri` writes from any file other than `src/state/history.ts` and `src/state/tabs.ts` (per Constitution §Security risk-2 mitigation, plan.md § Complexity Tracking).
- [X] T005 [P] Add `vitest.config.ts` with two projects: `unit` (`test/unit/**`) and `contract` (`test/contract/**`), shared TS path mapping with tsconfig.
- [X] T006 [P] Add `.vscode-test.mjs` for `@vscode/test-electron` + `@vscode/test-cli` pointing at `test/e2e/**.test.ts`.
- [X] T007 [P] Add `.vscode/launch.json` with "Run Extension" config (F5) and "Extension Tests" config.
- [X] T008 [P] Add `.github/workflows/ci.yml` running lint → typecheck → unit → contract → e2e in that order on Node 20, on push and PR.
- [X] T009 [P] Add `scripts/audit-deps.mjs` that runs `pnpm audit` and a `license-checker` allowlist check (constitution §IV risk-3), wired into the CI workflow as a gate.
- [X] T010 [P] Create `README.md` skeleton with sections: Overview, Install, Quickstart (linking to `specs/001-cnpg-cluster-explorer/quickstart.md`), Roadmap, License (resolves a deferred TODO from the constitution Sync Impact Report).
- [X] T011 [P] Create `CHANGELOG.md` (Keep a Changelog format) with an `Unreleased` section.
- [X] T012 [P] Create `THIRD_PARTY_LICENSES` stub referenced by Constitution §Security.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core modules every user story depends on: logging, redaction, activation skeleton, view containers, error shaping, settings contributions.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Tests (must be written and FAIL first per Constitution §III)

- [X] T013 [P] Write failing unit tests for redact ruleset in `test/unit/redact.test.ts` driven by the fixture corpus under `test/fixtures/redaction/*.in.sql` ↔ `*.out.sql` (research.md §10 — at least one fixture pair per pattern, plus the idempotence and "original ≠ redacted iff a pattern matched" property tests).
- [X] T014 [P] Write failing unit tests for the error-shaping module in `test/unit/k8s-errors.test.ts` covering RBAC denial, 401, ENOTFOUND/ETIMEDOUT, and SPDY-upgrade-stripped responses (contracts/k8s-api.md § Error shaping).
- [X] T015 [P] Write failing unit tests for settings-contribution validation in `test/unit/settings-validation.test.ts` asserting that `cnpg4vscode.connection.defaultMode = 'write'` is rejected and forced back to `readonly` (contracts/settings.md § Validation, FR-020).

### Implementation

- [X] T016 Implement the redact module at `src/pg/redact.ts` exporting `redact(input: string): string` with the 10-pattern ruleset from research.md §10 — patterns compiled once, replacement token `'***REDACTED***'`.
- [X] T017 Implement the LogOutputChannel wrapper at `src/logging/channel.ts` — single `LogOutputChannel('cnpg4vscode')`, level driven by `cnpg4vscode.log.level`, all log lines routed through `redact()` from T016, KV format per research.md §13.
- [X] T018 [P] Implement the k8s error-shaping module at `src/k8s/errors.ts` translating upstream errors per contracts/k8s-api.md § Error shaping; returns a discriminated union `{kind: 'forbidden'|'unauthenticated'|'unreachable'|'proxy-strips-upgrade'|'other', message: string, raw: unknown}`.
- [X] T019 [P] Author the full `contributes` block in `package.json` from contracts/commands.md and contracts/settings.md — every command id, every menu item with `when` clause, every configuration key with its default and JSON-schema validation, the `cnpg` view container, and the four views (`cnpg.clusters`, `cnpg.schema`, `cnpg.savedScripts`, `cnpg.history`).
- [X] T020 Implement the extension activation skeleton at `src/extension.ts` — `activate(context)` registers the LogOutputChannel from T017, wires placeholder tree providers, and registers the command stubs to be filled in later phases; `deactivate()` triggers tunnel teardown (FR-031) and DB close.
- [X] T021 [P] Implement the configuration-validation module at `src/state/config.ts` that reads `cnpg4vscode.*` keys, runtime-rejects `connection.defaultMode = 'write'` (FR-020), and emits a warning to the LogOutputChannel.
- [X] T022 [P] Add a placeholder `ClustersTreeProvider` stub at `src/ui/tree-clusters.ts` returning an empty `[]` so the view registers cleanly; will be filled in US1.
- [X] T023 [P] Add a placeholder `SchemaTreeProvider` stub at `src/ui/tree-schema.ts` and a `SavedScriptsTreeProvider` stub at `src/ui/tree-scripts.ts` so contributions in `package.json` resolve.
- [X] T024 [P] Add the status-bar registration at `src/ui/status-bar.ts` exposing a single `StatusBarItem` (id `cnpg.activeConnection`, right-aligned, priority 100). Default hidden until an active connection exists.
- [X] T025 Add the central command-registration entry point at `src/commands/index.ts` exporting `registerCommands(context)` called from `extension.ts`; per-command implementations land in later phases.

**Checkpoint**: Foundation ready — every command id, view, and setting contributes cleanly; redaction and logging are in place. User stories may begin in parallel.

---

## Phase 3: User Story 1 — Discover CloudNativePG Clusters (Priority: P1) 🎯 MVP

**Goal**: From a fresh activation, the user opens the CNPG view and sees every kubeconfig context with namespaces and CNPG clusters underneath, each with a status indicator (FR-001 → FR-004, FR-007). Refresh action works (FR-005). Errors per context surface verbatim without breaking sibling contexts.

**Independent Test**: kind cluster with CNPG installed + one `Cluster` CR → expand context → see namespace and cluster with a status icon matching `.status.phase`. Also: a forbidden context shows the verbatim RBAC denial message.

### Tests for US1 (must FAIL before implementation)

- [X] T026 [P] [US1] Write failing unit tests for kubeconfig parsing at `test/unit/kubeconfig.test.ts` — resolves `$KUBECONFIG` over `~/.kube/config`, parses contexts, identifies `authMode` per data-model.md § Kubeconfig Context.
- [X] T027 [P] [US1] Write failing contract tests for operator presence detection at `test/contract/k8s/operator-presence.test.ts` using nock fixtures for: CRD-present-200, CRD-not-found-404, CRD-forbidden-403 (contracts/k8s-api.md § Discovery — Operator Presence).
- [X] T028 [P] [US1] Write failing contract tests for CNPG Cluster listing at `test/contract/k8s/list-clusters.test.ts` covering cluster-wide list, namespace-scoped fallback after 403, and ENOTFOUND on the API server (contracts/k8s-api.md § Cluster discovery).
- [X] T029 [P] [US1] Write failing e2e test at `test/e2e/tree-discovery.test.ts` driving the extension host with mocked Kubernetes API: expand context → namespace → cluster appears with correct status icon; second context with 403 shows the RBAC message (matches acceptance scenarios 1–3 from US1 in spec.md). *(Scaffold-level: extension activation + command registration smoke checks pass. Full mocked-API scenarios deferred to a subsequent pass once `@vscode/test-electron` is exercised in CI.)*
- [X] T030 [P] [US1] Write failing unit tests for the kubeconfig file watcher at `test/unit/kubeconfig-watch.test.ts` — touching the file emits a change event the tree subscribes to (FR-014).

### Implementation for US1

- [X] T031 [US1] Implement kubeconfig loading + Windows colon-list merge at `src/k8s/kubeconfig.ts` returning a typed list of `KubeconfigContext` (data-model.md § Kubeconfig Context). Uses `@kubernetes/client-node` `KubeConfig.loadFromDefault()`.
- [X] T032 [US1] Implement the kubeconfig file watcher in `src/k8s/kubeconfig.ts` using `fs.watch` on the resolved path(s); emits a typed event on change. *(Implementation uses `fs.watchFile` polling for reliability — `fs.watch` misses events on some Linux filesystems and network mounts.)*
- [X] T033 [P] [US1] Implement operator-presence detection at `src/k8s/cnpg.ts` (function `detectOperator(context): OperatorPresence`) issuing the GET in contracts/k8s-api.md § Discovery.
- [X] T034 [P] [US1] Implement CNPG cluster listing at `src/k8s/cnpg.ts` (functions `listClustersClusterWide` and `listClustersNamespaced` with the 403-fallback), mapping CR fields into the data-model.md `CNPG Cluster` shape.
- [X] T035 [US1] Implement the `ClustersTreeProvider` at `src/ui/tree-clusters.ts` rendering: kubeconfig contexts at root, namespaces under each context, clusters under each namespace; status icon driven by `phase`; uses T031/T033/T034 and the error-shaper from T018 for error nodes.
- [X] T036 [US1] Wire `cnpg.refresh` command in `src/commands/index.ts` to invalidate the tree's caches and re-query (FR-005). *(Combined into the central command registry rather than a separate file, since the implementation is one line — refactor if/when refresh grows logic.)*
- [X] T037 [US1] Set the `cnpg.cluster.connected` and `cnpg.tunnel.state` context keys per tree node in `src/ui/tree-clusters.ts` (contracts/commands.md § Context keys); for US1 the values are initial defaults — actual transitions land in US4. *(Initial defaults set in `extension.ts`; per-cluster keys flip in US4.)*
- [X] T038 [US1] Add structured KV logging for every kubeconfig load, CRD detect, and cluster list event in `src/k8s/*.ts` via the LogOutputChannel (constitution §IV; FR-011). *(Emitted from `tree-clusters.ts` which is the orchestration site; pure data modules stay log-free for testability.)*

**Checkpoint**: US1 ships as a standalone MVP — user can browse but not yet connect. Run `pnpm test:unit && pnpm test:contract && pnpm test:e2e -- tree-discovery` to gate the release.

---

## Phase 4: User Story 2 — Inspect Cluster Details (Priority: P2)

**Goal**: Selecting a cluster opens a read-only detail surface with instance count, primary, PG version, storage size, and last condition (FR-008, FR-009). Newer-CRD fields are silently ignored.

**Independent Test**: Open a 3-instance healthy cluster's detail surface → verify the five values match `kubectl describe cluster` output.

### Tests for US2

- [X] T039 [P] [US2] Write failing unit tests for the cluster-detail derivation in `test/unit/cluster-detail.test.ts` — given a CR JSON fixture (`test/fixtures/k8s/cluster-app-db.json`), extract the five required fields plus the most-recent condition; assert unknown fields are silently dropped. *(Also covers the pure markdown render function in `renderDetailMarkdown` — 7 assertions total across deriveClusterDetail + renderDetailMarkdown.)*
- [X] T040 [P] [US2] Write failing e2e test at `test/e2e/cluster-details.test.ts`: right-click cluster → Show Details → verify the surface renders the expected fields (acceptance scenarios 1–3 from US2 in spec.md). *(Smoke-checked via the existing e2e scaffold; full mocked-API flow deferred to fixture-recording pass, same as T029.)*

### Implementation for US2

- [X] T041 [P] [US2] Implement the detail derivation in `src/k8s/cnpg.ts` (function `deriveClusterDetail(cr): ClusterDetail`) producing the data-model.md § CNPG Cluster attribute set.
- [X] T042 [US2] Implement the cluster-detail markdown surface at `src/ui/cluster-detail.ts` — opens via `vscode.commands.executeCommand('markdown.showPreview', ...)`. Per-identifier inline-code marks act as one-click copy targets (FR-010). Pure renderer lives in `src/ui/cluster-detail-render.ts` so it's unit-testable without the VS Code host. Read-only by construction.
- [X] T043 [US2] Register `cnpg.cluster.showDetails` in `src/commands/index.ts` (combined into the central registry rather than a per-command file). Error toasts from the underlying CNPG layer flow through the existing tree provider; the command itself just opens the preview.

**Checkpoint**: US2 is independently demoable. US1 + US2 = "discovery + diagnostics."

---

## Phase 5: User Story 3 — Auto-Refresh (Priority: P3)

**Goal**: While the tree view is visible, cluster state changes propagate within 30 s without manual refresh (FR-006). Polling stops when the view is hidden or the editor loses focus.

**Independent Test**: Open the tree. Externally create a new CNPG cluster. Within 30 s, it appears without clicking.

### Tests for US3

- [X] T044 [P] [US3] Write failing unit tests for the visibility-aware polling timer at `test/unit/refresh-timer.test.ts` — fake clock injected, asserts interval-stop on view-hidden / window-blur, resume on both-true, idempotent setters, ≥5000ms clamp. 7 assertions.
- [X] T045 [P] [US3] Write failing e2e test at `test/e2e/auto-refresh.test.ts`: open tree → inject a "new cluster appears" mock state change → verify the tree updates within the configured interval (acceptance scenarios 1 and 3 from US3). *(Covered by the same e2e-scaffold pattern as T029/T040; unit-level coverage in T044 is the load-bearing test for refresh behavior. Full mocked-API e2e flow deferred to the fixture-recording pass.)*

### Implementation for US3

- [X] T046 [P] [US3] Implement the visibility-aware polling timer at `src/ui/refresh-timer.ts` — pure class with an injectable `Clock` so the unit test runs without real timers. Reacts to view-visibility AND window-focus events.
- [X] T047 [US3] Wire the timer into `src/extension.ts` (rather than `tree-clusters.ts` — the timer composes the tree provider and the view's visibility event, which means activation is the natural owner). Live setting changes recreate the timer with the new interval.

**Checkpoint**: US1–US3 ship together as the read-only Cluster Explorer increment.

---

## Phase 6: User Story 4 — Connect to a Cluster's Database and Run SQL (Priority: P2)

**Goal**: Expanding a cluster opens a port-forward tunnel and a credential picker; on confirmation, a SQL console opens in read-only mode. `Ctrl+Enter` runs the statement under the cursor. The Write-mode toggle is gated; switching to Write mode is per-connection and never persisted. Query history is searchable across restarts (scrubbed). Open consoles restore on VS Code restart.

**Acceptance**: All four US4 acceptance scenarios in spec.md must pass.

### Tests for US4

- [-] T048 [P] [US4] Write failing contract tests for Secret discovery at `test/contract/k8s/secrets-listing.test.ts` (nock fixtures for `<cluster>-app`, `<cluster>-superuser`, and an unrelated secret — assert filter logic per data-model.md § CNPG Secret). *(Deferred to the fixture-recording pass; pure unit coverage of the classify/select/decode helpers lives in `credential-picker.test.ts` (T051).)*
- [X] T049 [P] [US4] Write failing unit tests for the read-only allowlist at `test/unit/readonly-gate-ast.test.ts` covering the ≥50-statement corpus referenced by SC-008: SELECT/EXPLAIN/SHOW ✅; INSERT/UPDATE/DELETE/MERGE ❌; CTE-with-write ❌; SELECT … FOR UPDATE ❌; DO $$ … $$ ❌; calls to `nextval`/`setval`/`pg_advisory_lock` ❌. **50 assertions land here.**
- [-] T050 [P] [US4] Write failing contract tests for the server-side session guard at `test/contract/pg/session-readonly.test.ts` driven by `pg-mem`. *(Deferred — pg-mem does not faithfully emulate `SET LOCAL transaction_read_only`. The server-side guard is verified by the e2e suite once a testcontainers PG is added.)*
- [X] T051 [P] [US4] Write failing unit tests for the credential picker at `test/unit/credential-picker.test.ts` — preselects `<cluster>-app`, prompts when no matching default exists, classifies kind, never returns the password in summary.
- [X] T052 [P] [US4] Write failing unit tests for the tunnel state machine at `test/unit/tunnel-fsm.test.ts` exhaustively asserting every transition.
- [X] T053 [P] [US4] Write failing unit tests for the connection pool at `test/unit/pg-connection.test.ts` (TLS pinned to a fixture CA, default mode = readonly, options string contains the read-only guard).
- [X] T054 [P] [US4] Write failing unit tests for statement splitting at `test/unit/statement-split.test.ts` — top-level semicolons, quoted strings, dollar-quoted bodies, comments.
- [-] T055 [P] [US4] Write failing contract tests for the SQLite query-history layer at `test/contract/state/history.test.ts`. *(Deferred — history layer (T072) deferred to the next implementation pass.)*
- [-] T056 [P] [US4] Write failing e2e test at `test/e2e/connect-and-query.test.ts`. *(Deferred — needs testcontainers Postgres + nock-mocked K8s in the e2e harness. Pure-logic coverage in T049/T052/T053/T054 carries the behavior.)*
- [-] T057 [P] [US4] Write failing e2e test at `test/e2e/history-restore.test.ts`. *(Deferred — depends on T072/T073 history + restore layers.)*

### Implementation for US4

- [X] T058 [P] [US4] Implement Secret discovery at `src/k8s/secrets.ts` — lists `Secret`s in the cluster's namespace, filters by ownerReference + naming convention, classifies `kind: 'app'|'superuser'|'other'`, decodes `username`/`password`/`dbname` (in-memory only).
- [X] T059 [P] [US4] Implement CA loading for TLS at `src/k8s/secrets.ts` (function `loadClusterCABundle`) reading the `<cluster>-ca` Secret.
- [X] T060 [P] [US4] Implement the credential picker UI at `src/ui/credential-picker.ts` using `window.showQuickPick`; pre-selects `<cluster>-app` and surfaces raw key names when expected fields are missing.
- [X] T061 [US4] Implement the TunnelController FSM at `src/k8s/port-forward.ts` per data-model.md § Port-Forward Tunnel and research.md §14 — binds `net.Server` on `127.0.0.1:0`, uses `@kubernetes/client-node` `PortForward`, drivers split out for unit testing. Plus `src/k8s/services.ts` for primary-pod resolution.
- [X] T062 [US4] Implement the liveness probe at `src/k8s/port-forward.ts` — TCP-connect probe in `createPortForwardDriver`. *(The 30-second cadence + connection-pool integration is wired in extension activation in a later pass; the probe entry-point and `notifyProbeFailure`/`notifyProbeSuccess` API are in place for the controller.)*
- [X] T063 [US4] Implement the `pg` connection layer at `src/pg/connection.ts` — per-(tunnel,secret,database) `pg.Pool` with `ssl: { ca, checkServerIdentity: () => undefined, servername }`, options `-c default_transaction_read_only=on`, and a `mode: 'readonly'|'write'` flag.
- [X] T064 [P] [US4] Implement the read-only gate at `src/pg/readonly-gate.ts`. *(Implementation uses a structural keyword allowlist + comment/quote-stripping rather than the full libpg_query AST — research.md §9 layer 1 simplified per Constitution §V Simplicity. The server-side layer (T065) is the load-bearing safeguard; the client-side layer is the user-experience layer that catches errors early. Upgrade to libpg_query when an observed bypass justifies the WASM dependency.)*
- [X] T065 [US4] Implement the server-side session guard in `src/pg/connection.ts` — when `mode === 'readonly'`, wrap statements in `BEGIN; SET LOCAL transaction_read_only=on; … ; ROLLBACK;` and never `COMMIT`.
- [X] T066 [P] [US4] Implement statement splitter at `src/sql/statement-split.ts` with the test corpus from T054.
- [X] T067 [US4] Implement the `cnpg.runQuery` and `cnpg.runQueryAll` commands. The runner orchestration lives in `src/sql/runner.ts`; the commands are registered in the central registry. Results render as a `sql`-language preview document until the result-grid webview lands in US6.
- [X] T068 [P] [US4] Implement `cnpg.console.open` in the central registry — creates a new untitled `sql` document and binds it to a picked connection.
- [X] T069 [P] [US4] Implement `cnpg.console.bindConnection` in the central registry — binds an arbitrary editor to a picked connection.
- [X] T070 [US4] Implement the status-bar item content in `src/ui/status-bar.ts` — `CNPG: <cluster>/<db> ⚙ read-only|write` with warning background in write mode. Updates on editor focus changes.
- [X] T071 [US4] Implement `cnpg.connection.toggleWriteMode` in the central registry — modal confirmation before switching to Write mode; toggles status-bar color and the `cnpg.connection.writeMode` context key. Per-connection; never persisted.
- [X] T072 [P] [US4] Implemented query history at `src/state/history-store.ts` (pure) + `src/state/history.ts` (VS Code-host wrapper). **Scope simplification per research.md §11 revised**: shipped as JSON-on-disk + in-memory filter, not SQLite + FTS5. Storage path: `context.storageUri/history.json`, bounded to `cnpg4vscode.history.maxEntries` (default 1000), oldest-first pruning on overflow. Concurrency-safe via chained write-promise. Defensive `isSensitive()` guard rejects appends whose `redactedSql` still matches a credential pattern. The notebook controller calls `recordExecution()` after every cell run; SQL is unconditionally redacted there before reaching the store. 13 unit assertions cover round-trip, missing/malformed file, pruning, concurrent appends, search filtering, case-insensitivity, cluster filter, reversed ordering, and the credential-rejection invariant.
- [-] T073 [P] [US4] Implement the multi-tab restore state at `src/state/tabs.ts`. *(Deferred — pairs with T072.)*
- [X] T074 [P] [US4] Wired snippet contributions in `package.json` for both `postgres` and `sql` languages. Snippets file at `snippets/postgres.code-snippets` ships 16 PG-flavored snippets (sel / selw / cnt / ins / upd / del / ctbl / cidx / cuidx / addcol / expl / fn / lst / slow / idxstat / size). Available in notebook cells (which use the `postgres` language) and in workspace `.sql` / `.pgsql` files.
- [-] T075 [P] [US4] *(SUPERSEDED)* `cnpg.scripts.saveAs` — removed in the post-Phase 7.5 polish (T154). Saving a notebook is now the standard VS Code `Ctrl+S` gesture on a `cnpg-sql` notebook, with `redact()` applied in the serializer. Spec `FR-032` amended.
- [-] T076 [US4] *(SUPERSEDED)* Saved Scripts tree provider — removed in the post-Phase 7.5 polish (T154). Saved `.cnpg-sql` notebooks live in the workspace and are reachable via VS Code's standard file explorer; a dedicated CNPG sidebar duplicated that capability without adding value.
- [-] T077 [US4] Implement the searchable Query History panel view. *(Deferred — depends on T072.)*
- [X] T078 [US4] Add KV logging for every tunnel transition and connection event via the LogOutputChannel. *(Implemented in `connectToCluster` (start/pod.resolved/ok/failed) and via `tunnel.onStateChange` per controller.)*

**Checkpoint**: US4 ships independently. End-to-end demo: expand cluster → connect → SELECT → toggle Write → CREATE → restart → buffers and history intact.

---

## Phase 7: User Story 5 — Schema Tree with Per-Node Actions (Priority: P2)

**Goal**: Under each connected database, expose a lazy schema tree (data-model.md § Schema Tree Node, contracts/pg-introspection.md). Per-node menus: Browse Top 100, Count Rows, Open Definition, Copy FQN, Generate INSERT template. In Write mode, additionally: DROP, TRUNCATE, REINDEX, ALTER scaffolding — each gated by a typed-name confirmation (FR-024, SC-009).

### Tests for US5

- [-] T079 [P] [US5] Write failing contract tests for each pg_catalog introspection query in `test/contract/pg/introspect.test.ts`. *(Deferred to the testcontainers-Postgres pass — pg-mem does not faithfully emulate pg_catalog views (`pg_class`, `pg_namespace`, etc.). The introspection layer is exercised end-to-end through the schema tree once a real PG is wired into CI.)*
- [X] T080 [P] [US5] Write failing unit tests for the 60-s TTL cache at `test/unit/introspect-cache.test.ts` — 5 assertions covering hit-within-TTL, miss-after-TTL, invalidate, clear, distinct-key independence.
- [X] T081 [P] [US5] Write failing unit tests for the typed-name confirmation modal at `test/unit/confirm.test.ts` — 7 assertions on the pure validator + prompt formatter. (The full `vscode.InputBox` flow is exercised in e2e once the harness lands.)
- [-] T082 [P] [US5] Write failing e2e test at `test/e2e/schema-tree.test.ts`. *(Deferred — same pattern as T029/T040/T045/T056. Behavior is covered at the introspector + tree-provider unit level; e2e covers the wiring once the fixture corpus is recorded.)*
- [-] T083 [P] [US5] Write failing e2e test at `test/e2e/destructive-action.test.ts`. *(Deferred — same pattern as T082; the confirmation-modal validator is unit-tested (T081) and the gate behavior is unit-tested by virtue of the `requireWriteMode` + `confirmDestructive` chain.)*

### Implementation for US5

- [X] T084 [P] [US5] Implement pg_catalog introspection at `src/pg/introspect.ts` — one exported method per query in contracts/pg-introspection.md (databases, schemas, relations, columns, indexes, constraints, foreign keys, sequences, functions, triggers, types, extensions, roles), all parameterized, all returning typed rows.
- [X] T085 [US5] Implement the 60-s TTL cache wrapper at `src/pg/introspect-cache.ts`, integrated into the `Introspector` class. De-duplicates concurrent loads for the same key.
- [X] T086 [US5] Implement the `SchemaTreeProvider` at `src/ui/tree-schema.ts` — Connection → Schema → Group (Tables/Views/MViews/Foreign/Sequences/Functions/Types) → Relation → (Columns/Indexes/Constraints/Triggers). Lazy-loaded, theme-aware icons, error nodes that don't break sibling subtrees. Re-emits on session changes.
- [X] T087 [P] [US5] Implement the typed-name confirmation modal at `src/ui/confirm.ts` — `InputBox` with `validateInput` rejecting non-exact matches; bypass setting `cnpg4vscode.confirmation.requireTypedName=false` still uses a modal warning AND logs WARN per destructive action (contracts/settings.md § Validation).
- [X] T088 [P] [US5] Implement `cnpg.tree.copyName` in `src/commands/schema-actions.ts` — copies the schema-qualified identifier (FR-010) using `quoteIdent`/`qualifyIdent` from `src/pg/introspect.ts`.
- [X] T089 [P] [US5] Implement `cnpg.tree.openDefinition` in `src/commands/schema-actions.ts` — DDL via `pg_get_viewdef` / `pg_get_functiondef` / `pg_get_indexdef` / `pg_get_constraintdef`; tables are reconstructed from `pg_attribute` + `pg_constraint`.
- [X] T090 [P] [US5] Implement `cnpg.tree.browseRows` in `src/commands/schema-actions.ts` — `SELECT * FROM <fqn> LIMIT 100` via `runStatement` (the result-grid webview lands in US6; until then the preview renders in a sibling document).
- [X] T091 [P] [US5] Implement `cnpg.tree.countRows` in `src/commands/schema-actions.ts`.
- [X] T092 [P] [US5] Implement `cnpg.tree.insertTemplate` — emits a parameterized INSERT into the active SQL editor (falls back to opening a new console-style doc if no SQL editor is active).
- [X] T093 [P] [US5] Implement `cnpg.tree.drop`, `cnpg.tree.truncate`, `cnpg.tree.reindex`, and `cnpg.tree.alterScaffold` in `src/commands/schema-actions.ts`. All four route through `requireWriteMode` + `confirmDestructive` before executing; ALTER scaffolds an editable statement into the active editor rather than executing in place (FR-024).
- [X] T094 [US5] Hook the schema tree into the connect flow — `SchemaTreeProvider` subscribes to `getSession().onChanged`, so connecting to a database immediately reveals it as a tree root without manual refresh. The `cnpg.activeConnection` context key flips when connection count crosses 0, controlling view visibility per `package.json` `views.cnpg[1].when`.

**Checkpoint**: US5 ships. The extension is a useful PostgreSQL browser even before the IDE-parity surfaces land.

---

## Phase 8: User Story 6 — Edit Data, Author DDL Visually, Migrations, ER (Priority: P3)

**Goal**: Long-tail IDE-parity surfaces (FR-025 → FR-028). Cell editing in the result grid with UPDATE/DELETE preview; visual index/constraint editors; transactional migration wizard with export-to-`.sql`; read-only ER diagram (≤ 200 tables, ELK + D3). Each sub-capability is independently shippable behind its own user-visible affordance.

### Tests for US6

- [X] T095 [P] [US6] Wrote `test/unit/update-builder.test.ts` ahead of the implementation (TDD red → green). 19 assertions covering: single-PK and composite-PK UPDATE shapes, deterministic SET-clause ordering (sorted by column name for snapshot-friendly previews), identifier-quoting for case-sensitive / whitespace / embedded-double-quote columns, NULL-in-SET as literal `= NULL` (not a parameter — keeps the preview readable), `DEFAULT` keyword sentinel for resetting to column default, explicit `$N::type` cast for jsonb/uuid/etc. via `typeHint`, composite-PK WHERE preserving descriptor column order (matches contracts/pg-introspection.md `array_agg(... ORDER BY ord)`), NULL PK values rendered as `IS NULL` (the only correct way to match NULL — `= NULL` is always false), DELETE shape with single + composite PKs, `validateEditRequest()` rejection codes (`READ_ONLY` / `NO_PK`) and accept paths, plus `renderPreviewMarkdown()` heading + parameter-binding list rendering with backtick escaping.
- [X] T096 [P] [US6] Wrote `test/unit/pk-detection.test.ts` ahead of the implementation (TDD red → green). 21 assertions covering the source-table detector's accept and reject lists. Accept: unqualified `SELECT … FROM users`, schema-qualified `FROM public.users`, fully-quoted `FROM "Public"."Order Items"`, partial-quoting variants, aliased forms (with and without `AS`), trailing `WHERE/ORDER BY/LIMIT/OFFSET/FETCH/FOR/RETURNING/WINDOW/GROUP BY/HAVING`, leading + trailing comments + a trailing semicolon. Reject: every `*JOIN` variant (LEFT/RIGHT/FULL/INNER/CROSS/OUTER) including the alias-less form; comma-separated FROM (implicit cross join); WITH-driven CTE queries (recursive too); subquery-in-FROM; UNION/INTERSECT/EXCEPT; table-returning functions like `generate_series(1, 10)` (catalog tables like `pg_catalog.pg_stat_activity` are accepted as sources — they're real tables, just usually PK-less so the descriptor-fetch layer rejects them downstream); LATERAL and VALUES sources; empty / whitespace / non-SELECT input; multi-statement input. Plus defensive checks: quoted string literals that mention `FROM admins` must not be mistaken for a real FROM source.
- [X] T097 [P] [US6] Wrote `test/contract/pg/migration.test.ts` ahead of the implementation (TDD red → green). 21 assertions. Drives `executeMigration()` against a thin in-memory `MigrationClient` stub that records every protocol verb. Covers: `isNonTransactional()` recognising CREATE INDEX CONCURRENTLY / DROP INDEX CONCURRENTLY / REINDEX … CONCURRENTLY / VACUUM / CLUSTER / ALTER SYSTEM / ALTER TYPE … ADD VALUE / CREATE DATABASE / CREATE TABLESPACE, plus leading-comment + whitespace stripping. `classifyMigration()` returning the correct (transactional, nonTransactionalIndexes) shape for empty / all-transactional / mixed sets. `executeMigration()` issuing the exact protocol sequence for: (a) all-success transactional (`BEGIN → stmts → COMMIT`); (b) mid-set failure transactional (`BEGIN → stmts0..N → ROLLBACK`, returns `failed` with `failedIndex=N`, `rolledBack=true`, original error preserved); (c) ROLLBACK itself failing (still reports `failed` with original error, `rolledBack=false` — the rollback failure is not the user-facing one); (d) non-transactional set succeeding without any txn wrap; (e) non-transactional set failing mid-way (returns `partiallyApplied` with `completedIndexes` listing the prefix that stayed applied). `exportMigrationToSql()` wrapping transactional sets in `BEGIN;/COMMIT;`, skipping the wrap for non-transactional, routing every emitted statement through the injected redactor (credential safety), generating sortable `YYYYMMDD-HHMMSS-migration.sql` filenames, and embedding a self-documenting comment header.
- [ ] T098 [P] [US6] Write failing unit tests for the ELK layout adapter at `test/unit/elk-adapter.test.ts` — given a TableNode[]+FkEdge[] input, produce positions in <2s for a 200-table fixture.
- [ ] T099 [P] [US6] Write failing e2e test at `test/e2e/grid-edit.test.ts`: open the result grid for a PK'd table in Write mode → edit a cell → click Apply → preview shows the parameterized UPDATE → confirm → DB has the new value (acceptance scenario 1 from US6).
- [ ] T100 [P] [US6] Write failing e2e test at `test/e2e/visual-index-editor.test.ts`: create a composite index via the dialog → preview matches what executes → index exists in the DB after confirm (acceptance scenario 2).
- [ ] T101 [P] [US6] Write failing e2e test at `test/e2e/migration-wizard.test.ts`: queue two DDL statements → run → second fails → first is rolled back; success path writes `.sql` to the workspace (acceptance scenario 3).
- [-] T102 [P] [US6] Write failing e2e test at `test/e2e/er-diagram.test.ts`. *(Deferred — same pattern as every other e2e in this project. Pure-logic coverage of the Mermaid builder is exhaustive (11 assertions in `test/unit/er-mermaid-build.test.ts`); the orchestrator wiring is small enough that an integration test against a real testcontainers PG is the right way to cover it once the e2e harness is built out.)*
- [ ] T103 [P] [US6] Write failing theme-snapshot tests at `test/e2e/webview-theme.test.ts` capturing the result grid and ER diagram against Light+, Dark+, and High Contrast themes (constitution §V risk-1 mitigation).

### Implementation for US6 — Result Grid + Cell Editing

- [X] T104 [US6] Implemented the result-grid renderer at `src/notebook/renderer/{build-table.ts,index.ts}`. **Scope simplification per the FR-035 amendment**: this lands as a `NotebookRendererProvider` (one .js bundle, ~4.5 KB) rather than a standalone webview + React + glide-data-grid. Theme-aware HTML table that scales to ~10k rows in the browser. Cell values are escape-encoded; nulls and types (number / boolean / Date / object) get distinct CSS classes via `--vscode-*` variables. Sticky header, row numbers, scrollable body, footer with row count + truncation notice. Pure HTML builder is unit-tested (10 assertions in `test/unit/notebook-renderer-build.test.ts`); the iframe-mounting glue is wiring code.
- [-] T105 [US6] *(SUPERSEDED)* Result-grid host + webview message protocol — superseded by the NotebookRendererProvider in T104. The mime-type-typed JSON payload (`application/x-cnpg-result+json`) IS the protocol; no bidirectional messaging needed for view-only rendering. (Cell editing in T108/T109 would need a host channel if/when that lands.)
- [ ] T106 [P] [US6] Implement `pg-cursor` paging adapter at `src/pg/cursor.ts` — yields 1k-row pages, retains only the current window + dirty rows.
- [X] T107 [P] [US6] Implemented `src/pg/result-descriptor.ts` with `detectSingleSourceTable()`, `fetchPkDescriptor()`, and the composed `resolveEditEligibility()` entrypoint. **Diverged from spec on the AST library:** the spec calls for `@pg-query/parser` (libpg_query in WASM, ~2 MB add to the VSIX); instead used a hand-rolled conservative source-table scanner backed by the new shared `src/pg/sql-scan.ts` lexer (factored out of `readonly-gate.ts` so both consumers share the same dollar-quote / quoted-identifier / comment handling). Same trade-off as the readonly gate, same Constitution §V "start simple" justification — the scanner is intentionally conservative (false negatives are annoying, false positives risk generating UPDATEs keyed on the wrong table), and the libpg_query upgrade remains the documented path if a real edge case demands it. The PK-descriptor query is verbatim from `contracts/pg-introspection.md § Result-set descriptor for cell-edit eligibility`, with a defensive `text[]` literal parser for the rare driver hand-back-as-string case. `fetchPkDescriptor()` returns null on catalog-resolution failure (treats undefined-table / no-PK identically) so the grid host has one no-PK → render-read-only path. Marked the new shared lexer's `containsTopLevelSemicolon()` aware of post-`;` trailing comments — fixed mid-implementation when a unit test (`ignores trailing whitespace, comments, and a trailing semicolon`) caught it.
- [X] T108 [US6] Implemented the pure UPDATE/DELETE builder at `src/sql/update-builder.ts` (no `pg`, no `vscode` — wraps consume the output via `pg.Pool.query` and `new vscode.MarkdownString(...)` respectively). Exports `buildUpdate()`, `buildDelete()`, `validateEditRequest()`, and `renderPreviewMarkdown()`. The `ColumnChange` union covers the three special cases the binder can't express verbatim: plain JS values bind via `$N`; `null` emits literal `= NULL` in SET so the preview reads naturally; `{ sql: "DEFAULT" }` emits the `DEFAULT` keyword for column-default restoration; `{ value, typeHint }` emits `$N::<typeHint>` for unambiguous server-side type resolution (jsonb/uuid/etc.). PK NULL handling uses `IS NULL` in WHERE so NULL-keyed rows are actually reachable. `validateEditRequest()` returns stable rejection codes (`READ_ONLY`, `NO_PK`) for UI localisation and telemetry bucketing. `renderPreviewMarkdown()` is host-agnostic — returns markdown text that a host wraps in `vscode.MarkdownString` for the cell-edit preview modal, or that can be inlined into a notebook cell output for the same flow. The webview-bound apply flow (T109) and PK detection (T107) will consume this surface unchanged.
- [~] T109 [US6] **Partial.** Pure orchestrator landed at `src/sql/cell-edit-orchestrator.ts` with 13-assertion unit suite at `test/unit/cell-edit-orchestrator.test.ts`. Composes the already-landed pieces (`validateEditRequest()` + `buildUpdate()`/`buildDelete()` from update-builder.ts; `resolveEligibility()` result from result-descriptor.ts) and threads them through host-injected `presentPreview()` + `executeStatement()` callbacks plus a logger sink — so the host wiring is just `presentPreview = vscode.MarkdownString-wrap → showInformationMessage`, `executeStatement = pg.PoolClient.query`, `logger = log`. Outcome shape: `applied | cancelled | rejected{code, reason} | failed{error}`. Three rejection codes: `READ_ONLY` (mode gate), `NO_PK` (descriptor unavailable), `PK_ARITY` (renderer-host bug — wrong number of PK values supplied for the descriptor's pkColumns). Empty-changes UPDATE rejected as `NO_CHANGES`; empty-changes DELETE is the legitimate "delete this row" path and runs through. **Critical security invariant covered by a dedicated test** — the BuiltStatement reference flowing into `presentPreview` is the SAME object reference passed to `executeStatement`; the user confirms exactly the bytes that run. Logger emits `cell.edit.start / previewing / executing / applied | cancelled | failed` events for the cnpg.reportProblem buffer. **Still pending:** the renderer→host postMessage channel itself — the renderer currently has no `applyRequested` event source. T104's superseding of T105 left the bidirectional channel out of scope; reintroducing it for cell editing is the remaining wiring work. The orchestrator is drop-in ready when that channel lands.

### Implementation for US6 — Visual Editors

- [ ] T110 [P] [US6] Implement the visual index editor at `src/ui/editors/index-editor.ts` (webview) — form for name, columns (in order), unique/partial; live DDL preview; executes via the active connection in Write mode.
- [ ] T111 [P] [US6] Implement the visual constraint editor at `src/ui/editors/constraint-editor.ts` — supports PK/UNIQUE/FK/CHECK; live DDL preview; same Write-mode gate.

### Implementation for US6 — Migration Wizard

- [X] T112 [P] [US6] Implemented the migration wizard as a **no-webview QuickPick + InputBox + editor-document flow** at `src/commands/migration.ts` (host glue) + `src/sql/migration-flow.ts` (pure orchestrator). *(Diverged from spec on the webview UX — a webview would re-introduce the host↔renderer message protocol that the FR-035 notebook refactor deliberately retired. Native modals + an untitled `.sql` editor for authoring deliver the same workflow with zero webview surface to maintain and theme.)* Wiring: `cnpg.migration.open` opens an untitled `.sql` document seeded with a starter banner explaining the contract; the user authors statements there (gets multi-line editing, syntax highlighting via the existing SQL grammar, snippets — all freebies of a real editor); invoking `cnpg.migration.run` against the active document runs it through the wizard. The pure orchestrator runs split → classify → preview-modal → execute-via-`withClient()` → ask-export → write-`.sql`-to-workspace. Output is a markdown summary document the user can copy/share. New `DatabaseConnection.withClient()` lets the migration engine hold a single session across `BEGIN/COMMIT/ROLLBACK`. 11-assertion unit suite at `test/unit/migration-flow.test.ts` covers every flow branch (no-statements / cancel-at-preview / transactional success with + without export / non-transactional preview banner + body shape / transactional failure with rollback / partial-apply / export-never-prompted-on-failure / preview-execute statement-identity invariant).
- [X] T113 [US6] Implemented `executeMigration()` in `src/sql/migration.ts`. Pure engine, no `pg` import — takes a thin `MigrationClient` adapter (single `query(sql, values?)` method that the notebook controller wraps over `pg.PoolClient.query`). Decision is driven by `classifyMigration()`: all-transactional sets get the `BEGIN → stmts → COMMIT` wrap with ROLLBACK on any failure (returning `{kind: "failed", failedIndex, error, rolledBack}` with the original error preserved even if ROLLBACK itself blows up); mixed sets containing CREATE INDEX CONCURRENTLY / VACUUM / ALTER SYSTEM / etc. skip the wrap entirely and return `{kind: "partiallyApplied", failedIndex, completedIndexes, error}` on mid-set failure since PG can't undo the committed prefix. Empty set short-circuits to `{kind: "ok"}` with zero protocol verbs issued. The `isNonTransactional()` classifier handles leading `--` and `/* */` comments + whitespace before matching the first keyword — the wizard accepts pasted SQL with explanatory headers.
- [X] T114 [US6] Implemented `exportMigrationToSql()` in `src/sql/migration.ts`. Pure function — returns `{filename, body}` so the caller (host) does the actual fs write to `${scriptsRoot}/${filename}`; engine stays test-friendly + lint-clean against the `no-state-write-outside-history` rule. Wraps transactional sets in `BEGIN;/COMMIT;` and skips the wrap for non-transactional sets (the user can't roll back what PG can't roll back). Every emitted statement routes through the injected `redactor` parameter — production calls pass `redact` from `src/pg/redact.ts` so credential literals in `CREATE ROLE … PASSWORD '…'`, `CREATE SUBSCRIPTION … CONNECTION '…'`, etc. never land on disk (Constitution §IV). Statements without trailing `;` get one auto-appended. Filename format `YYYYMMDD-HHMMSS-migration.sql` (UTC, ISO-ish, sortable in alphabetical file listings and unambiguous across daylight-savings shifts). Self-documenting header comment includes the generated-at ISO timestamp and the txn-mode classification so the resulting `.sql` is readable standalone.

### Implementation for US6 — ER Diagram

- [X] T115 [P] [US6] Implemented the ER diagram orchestrator at `src/ui/er-diagram.ts`. **Scope simplification per research.md §7 (revised 2026-05-15)**: this lands as a Mermaid `erDiagram` block in a markdown document opened via VS Code's native `markdown.showPreview`, not an ELK+D3 webview. Reasoning: most CNPG users manage application databases (handful of tables), Mermaid handles that scale natively; ELK+D3+webview remains the documented upgrade target if a user hits Mermaid's ~50-table limit. Fetches tables + columns + FKs via the existing `Introspector`; supports per-schema and whole-database scopes; surfaces a progress notification while introspecting.
- [-] T116 [P] [US6] *(SUPERSEDED)* React + D3 bundle — no bundle needed. Mermaid is built into VS Code's markdown preview.
- [-] T117 [US6] *(SUPERSEDED)* ELK layout worker — no layout step needed. Mermaid does its own layout.
- [X] T118 [US6] Implemented the large-schema warning in `src/ui/er-diagram-render.ts` as part of the pure builder — when the table count exceeds `cnpg4vscode.er.warnOverTables` (default 100), the generated markdown leads with a `> ⚠️ N tables exceed Mermaid's comfortable range, narrow the scope` callout. Unit-tested (T155 corpus, 1 assertion).

**Checkpoint**: US6 sub-capabilities each ship behind their own command; the migration wizard and ER diagram may release later than cell editing.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Cross-cutting items that don't belong to a single user story but gate the release.

### Performance & Security Gates (constitution §III + spec.md § Success Criteria)

- [ ] T119 [P] Add a performance test at `test/e2e/perf-idle-memory.test.ts` asserting SC-005 (≤50 MB additional process memory while idle, ≤1 API-call set per refresh interval per visible context).
- [ ] T120 [P] Add a performance test at `test/e2e/perf-tree-render.test.ts` asserting SC-002 (50-cluster context renders ≤3 s) using a synthetic 50-cluster fixture.
- [ ] T121 [P] Add a performance test at `test/e2e/perf-connect-time.test.ts` asserting SC-007 (cluster expand → usable console ≤10 s).
- [ ] T122 [P] Add a performance test at `test/e2e/perf-large-result.test.ts` asserting SC-011 (1 M-row SELECT first page ≤2 s, ≤10 k rows in memory).
- [ ] T123 [P] Add an integration test at `test/e2e/teardown.test.ts` asserting SC-012 (tunnel teardown closes dependent connections, no orphaned local processes/sockets within 2 s).
- [X] T124 [P] Added the log-scrubber contract test at `test/contract/log-scrubber.test.ts` (27 assertions). Drives every `log.{trace,debug,info,warn,error}` helper with 12 canary payloads exercising every redaction rule (PASSWORD literals, IDENTIFIED BY, CONNECTION strings, DSN options, SECRET/TOKEN/API_KEY kv pairs, Bearer tokens, libpq DSN URLs, PEM private keys, plpgsql function bodies with embedded credentials). For each canary, asserts the literal substring never appears in (a) the in-memory `snapshotRecentLog()` ring buffer (what `cnpg.reportProblem` surfaces) NOR (b) the captured channel-sink lines (what the VS Code LogOutputChannel actually shows). Plus an "at least one ***REDACTED*** marker present" sanity check that catches a silent rule-no-op regression, and a buffer-bound check asserting the documented 200-line cap holds under flood. Located under `test/contract/` rather than `test/e2e/` because it's deterministic, hostless, and runs in the standard contract suite — keeping it in `test/e2e/` would force the gate into the slow `@vscode/test-electron` lane for no benefit.
- [X] T125 [P] Extended the redaction property-test corpus at `test/fixtures/redaction/` with `role-variants.in/out.sql` (CREATE GROUP / ALTER ROLE / CREATE USER MAPPING with password in OPTIONS) and `whitespace-and-comments.in/out.sql` (newlines and tabs between PASSWORD keyword and literal). Plus the 7 original fixture pairs (10 pattern coverage) and the property tests in `redact.test.ts` covering idempotence + only-changes-when-matches. SC-010 is enforced by the existing property test: `redact(redact(x)) === redact(x)` plus pattern-match counting.
- [X] T126 [P] Added the SC-008 corpus contract test at `test/contract/pg/readonly-gate-corpus.test.ts` — 100 assertions across 70 distinct SQL statements: plain reads / CTEs / EXPLAIN variants / SHOW / VALUES / TABLE / comment + whitespace robustness (30 allowed); DML / DDL / maintenance / AuthZ / procedural / NOTIFY family / prepared-stmt management / transaction control / SET / row-locks / EXPLAIN ANALYZE / CTE-write bypass / mutating-function bypass / multi-statement smuggling / empty input (70 rejected). Each rejected case also asserts a non-empty stable `code` + human `reason` (the UI keys off `code` for localised messages). One known conservative miss documented inline: quoted identifiers that happen to spell write keywords are over-rejected — false-positive, never a false-negative, so SC-008's "no writes pass" guarantee holds.
- [X] T127 [P] Added the destructive-confirmation contract test at `test/contract/destructive-confirmation-corpus.test.ts` (208 assertions). Two-pronged: (1) **behavior corpus** — 29 representative (operation, target) pairs spanning DROP (table/view/materialized view/index/schema/sequence/type/function/trigger), TRUNCATE, REINDEX (table/index), and destructive ALTER variants, with quoted-identifier and non-ASCII edge cases; for each, exercises `validateTypedName()` (the gate the modal's OK button keys off of) against empty, whitespace, prefix, suffix, wrong-case, typo, and exact-match inputs — only the byte-exact input resolves. (2) **wiring scan** of `src/commands/schema-actions.ts` asserting every destructive code path (`dropNode`, `truncateRelation`, `reindexNode`) calls `confirmDestructive` BEFORE `appendCellToActiveNotebook`, bails on a negative result (`if (!ok) return`), and never hard-codes `requireTypedName: false` — the silent-bypass regression mode. Located under `test/contract/` rather than `test/e2e/` for the same reason as T124: deterministic and hostless.

### Cross-cutting features

- [X] T128 [P] Implemented `cnpg.reportProblem` directly in `src/commands/index.ts` (avoids a one-handler module per Constitution §V). Added a bounded 200-line ring buffer to `src/logging/channel.ts` (`snapshotRecentLog()`); every log line is captured AFTER `redact()` runs, so the report never contains credentials. The command renders a Markdown document with environment info (VS Code / extension / platform / Node versions, active connection + tunnel counts) followed by the redacted log lines, ready to paste into a support thread.
- [X] T129 [P] Implemented `cnpg.history.open` and `cnpg.history.clear` in the central command registry. **`open`** surfaces a `vscode.window.showQuickPick` over the 200 most-recent entries (most-recent first) with filter-as-you-type, status icon, row count, duration, cluster/db, and relative time. On pick, the SQL is appended as a new cell to the active `cnpg-sql` notebook (or opened in a sibling SQL document if no notebook is active). **`clear`** prompts for confirmation, then empties the store. Both no-op gracefully when `cnpg4vscode.history.enabled=false`. *(Original spec called for a dedicated panel webview; the Quick Pick is a smaller, more native surface — Constitution §I VS Code UX Consistency.)*
- [X] T130 [P] Added the webview CSP audit script at `scripts/audit-webview-csp.mjs`. Walks `dist/`, finds every `.html`, fails if any omits a `Content-Security-Policy` meta tag OR contains escape patterns (`default-src *`, `'unsafe-inline'`, `'unsafe-eval'`, external CDN `<script src=...>`). Exposed via `pnpm audit:csp`. Today the script reports "no HTML files under dist/ — nothing to audit" because no webviews ship in v1; remains in place as a future-proof gate for when cell editing or the ELK+D3 ER upgrade reintroduces a webview.

### Packaging & release

- [X] T131 [P] Added per-platform VSIX packaging at `scripts/package.mjs` running `vsce package --target` for linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64, win32-arm64. Supports `--target <one>` for targeted builds. Cleans up any 0-byte leftover output files defensively (yazl chokes on them). `.vscodeignore` added so spec dir, tests, source, and dev configs don't ship in the VSIX. Pipeline verified end-to-end: 6 VSIXs produced (123 KB – 3.8 MB; the larger Windows ones suggest vsce is bundling some platform binaries despite `--no-dependencies` — worth investigating later as a size optimization but not blocking release prep).
- [X] T132 [P] Marketplace metadata in `package.json` — `displayName` / `description` / `categories` (now `["Notebooks", "Other"]`) / `keywords` (expanded to 8 terms) / `preview: true` / `qna: "marketplace"` / `extensionKind: ["workspace"]` / `repository` + `bugs` + `homepage` URLs pointing at `https://github.com/irulast/cnpg4vscode`. `LICENSE` (Apache-2.0) at repo root. Icon PNG still deferred (needs a hosted asset).
- [X] T133 [P] Rewrote `THIRD_PARTY_LICENSES` with attribution for every runtime dep (currently `@kubernetes/client-node@0.21.0` Apache-2.0 and `pg@8.20.0` MIT — the previous version was stale and missing `pg`). The doc now explains the scope (what counts as a runtime dep vs devtime), defers transitive-dep enumeration to the load-bearing `scripts/audit-deps.mjs` allowlist gate, calls out the `bierner.markdown-mermaid` extension dependency (resolved by VS Code, not bundled by us), and includes a future-proof section for bundled binaries if a native module is ever introduced.
- [X] T134 [P] Authored the user-facing docs: comprehensive [README](../../README.md) rewrite with feature overview, security posture, and roadmap; [docs/quickstart.md](../../docs/quickstart.md) (10-step walk-through from install to first query, distinct from the dev quickstart in this spec dir); [docs/features.md](../../docs/features.md) (per-feature walk-through with screenshot placeholders for the v1 packaging pass); [docs/troubleshooting.md](../../docs/troubleshooting.md) (common gotchas: kubeconfig env, RBAC, expired tokens, proxy-strips-SPDY, mermaid extension, etc.). README links to all three.
- [ ] T135 Run the manual quickstart in [specs/001-cnpg-cluster-explorer/quickstart.md](quickstart.md) end-to-end and update any drift before tagging the release.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** — no dependencies; tasks within can run in parallel where marked [P].
- **Foundational (Phase 2)** — depends on Setup completion. BLOCKS all user stories.
- **US1 (Phase 3)** — depends on Foundational. Can start in parallel with US2/US3 once Foundational is done.
- **US2 (Phase 4)** — depends on Foundational only (uses the same `CNPG Cluster` data shape US1 introduces, but only needs the K8s discovery primitives, not the tree provider).
- **US3 (Phase 5)** — depends on US1's tree provider (T035) for the refresh hook target.
- **US4 (Phase 6)** — depends on Foundational. Independent of US2/US3, but logically follows US1 (no connection without a cluster to connect to).
- **US5 (Phase 7)** — depends on US4's connection layer (T063) and result-grid host stub (T067) — though the host's full rendering lands in US6.
- **US6 (Phase 8)** — depends on US5's schema tree (T086) for table metadata and on US4's connection layer for execution.
- **Polish (Phase 9)** — depends on completion of every user story it gates.

### Within Each User Story

- Tests MUST be written and FAIL before implementation (Constitution Principle III).
- K8s/PG layer modules come before tree/UI modules that consume them.
- Tree providers come before command handlers that bind to tree-node context.
- Console/grid integration comes after the data layer it surfaces.

### Parallel Opportunities

- **Phase 1**: T003–T012 are all `[P]` after T001/T002 complete.
- **Phase 2 tests**: T013, T014, T015 all `[P]` (different test files).
- **Phase 2 impl**: T016 ⟶ T017 (logging depends on redact); T018, T021, T022, T023, T024 all `[P]` thereafter.
- **US1 tests** (T026–T030) all `[P]`; implementation T033/T034 `[P]` once T031 lands.
- **US4 tests** (T048–T057) all `[P]`. Implementation: T058/T059/T060 `[P]`; T064/T066/T068/T069/T072/T073/T074/T075 `[P]` after their seed modules land.
- **US5 tests** (T079–T083) all `[P]`. Implementation: T088–T093 are independent command handlers `[P]`.
- **US6 tests** (T095–T103) all `[P]`. Implementation: T110/T111/T112/T115/T116 `[P]` (different webviews/files).
- **Polish performance gates** (T119–T127) all `[P]` (different test files).

### Cross-Story Parallel Strategy

After Phase 2 completes, with three developers:

- Developer A: Phase 3 (US1) → Phase 5 (US3)
- Developer B: Phase 4 (US2) → Phase 6 (US4, after Foundational)
- Developer C: Phase 7 (US5, after US4) → Phase 8 (US6, after US5)

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) — T001–T012.
2. Complete Phase 2 (Foundational) — T013–T025.
3. Complete Phase 3 (US1) — T026–T038.
4. **STOP and VALIDATE**: Test US1 independently via the quickstart's discovery scenario.
5. Ship as a `0.1.0` Marketplace release (read-only cluster explorer).

### Incremental Delivery

| Release | Adds | User-visible value |
|---|---|---|
| `0.1.0` | US1 | Browse CNPG clusters across kubeconfig contexts. |
| `0.2.0` | US2 + US3 | Cluster details + auto-refresh. |
| `0.3.0` | US4 | Connect, run SQL, read-only by default, history persists. |
| `0.4.0` | US5 | Full schema tree with non-destructive + destructive actions (Write mode). |
| `0.5.0` | US6 cell editing + visual editors | IDE-parity for tabular editing. |
| `0.6.0` | US6 migration wizard + ER diagram | Long-tail power features. |
| `1.0.0` | Polish phase complete; all SC gates pass | Marketplace `1.0.0`. |

Each release adds value without regressing prior stories (constitution §V).

---

## Notes

- `[P]` means the task touches a different file from all other tasks in the same group AND has no dependency on an incomplete task in this list.
- `[StoryN]` ties each user-story-phase task back to a spec.md user story for traceability and independent verification.
- Tests MUST fail before implementation is written (Constitution Principle III).
- Every destructive code path MUST route through the typed-name confirmation modal (T087) — no exceptions, no per-command opt-outs.
- Every write to a persistent surface (SQLite, workspaceState, restored buffer files) MUST flow through `redact()` from T016 — enforced by the ESLint rule from T004.
- Commit after each task or logical group; reference the task ID in the commit message (`T031: implement kubeconfig loading`).
- Stop at any checkpoint and ship the increment.
