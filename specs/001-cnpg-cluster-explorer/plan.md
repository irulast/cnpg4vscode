# Implementation Plan: CloudNativePG Cluster Explorer + SQL Management

**Branch**: `001-cnpg-cluster-explorer` | **Date**: 2026-05-15 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-cnpg-cluster-explorer/spec.md`

## Summary

A VS Code extension that lets users discover CloudNativePG clusters from
their active kubeconfig and operate on the PostgreSQL databases inside them
through a full IDE-parity SQL surface — schema tree with per-node actions,
multi-tab consoles with read-only/write toggle, result grid with cell
editing, visual index/constraint editors, transactional migration wizard,
and a read-only ER diagram. Always-on per-cluster port-forward tunnels
provide connectivity; CNPG-issued Secrets provide credentials; every
write surface is gated by Write mode + typed-name confirmation; every
persisted artefact has credential literals scrubbed.

**Technical approach**: TypeScript extension bundled with esbuild,
activated on first view/command. Kubernetes interactions via the
official `@kubernetes/client-node` (lists, watches, SPDY port-forward).
PostgreSQL interactions via `pg` (node-postgres) over a port-forwarded
`127.0.0.1` socket with TLS pinned to the CNPG-issued CA. Three user-
facing surfaces: (a) a native `TreeView` for cluster/schema browsing,
(b) **a native VS Code Notebook (`cnpg-sql` type) for the interactive
SQL console — one `NotebookController` per active connection, cell
execution renders results inline as cell outputs**, (c) one webview for
the ER diagram (ELK+D3). Persistent history in SQLite via
`better-sqlite3`. Read-only gate enforced both client-side (keyword
allowlist) and server-side (`SET LOCAL transaction_read_only`).

**Notebook architecture rationale**: The interactive SQL surface is a
VS Code Notebook rather than an editor-bound untitled `.sql` document
(decision recorded in [spec.md § Clarifications](spec.md#clarifications),
new `FR-035` / `FR-036`). The notebook model inverts the binding
question — *cells know their controller, not the editor knows its
connection* — eliminating per-tab binding state. It also gives us
native execute keybindings (Shift+Enter), native cell-output rendering,
native restore-on-restart, and reduces US6 scope by turning the
planned result-grid webview into a `NotebookRendererProvider` (much
smaller surface than a standalone webview).

## Technical Context

**Language/Version**: TypeScript 5.4+, targeting Node 20 (the runtime VS
Code engine `^1.85` ships). Output as ESM where the loader allows,
CommonJS for the extension entrypoint per VS Code's host expectation.

**Primary Dependencies**:
- `@kubernetes/client-node` ^0.21 — Kubernetes API + SPDY port-forward
- `pg` ^8.11 + `pg-cursor` — PostgreSQL driver + streaming results
- `@pg-query/parser` (libpg_query WASM) — SQL AST for the read-only gate
- `better-sqlite3` ^11 — per-workspace persistent history
- `glide-data-grid` ^6 + React ^18 — result grid webview
- `elkjs` ^0.9 + `d3` ^7 — ER diagram webview
- `esbuild` ^0.20 — bundler
- `@vscode/vsce` ^2.24 — packager

**Storage**:
- In-memory: kubeconfig contents, decoded Secret material, live tunnels,
  connection pool state, result-set windows.
- On-disk (per-workspace, `context.storageUri`):
  - `history.db` — SQLite, redacted-SQL history with FTS5 search.
  - Restored tab buffers (also redacted before write).
- Workspace files (user-controlled):
  - `.cnpg/scripts/*.sql` — saved scripts (user-visible, version-controllable).
  - User-authored `.sql` files anywhere in the workspace.

**Testing**:
- Unit: Vitest ^1.5 (host Node, fast watch).
- Contract (k8s): Vitest + `nock`-replayed fixtures recorded from a real
  kind cluster with CNPG installed.
- Contract (PG): `pg-mem` for SQL-shape and redaction tests.
- E2E: `@vscode/test-electron` + `@vscode/test-cli` against a
  testcontainers Postgres 16 plus nock-mocked Kubernetes API.

**Target Platform**: VS Code Desktop (Linux x64/arm64, macOS x64/arm64,
Windows x64). Engine `^1.85.0`. Native modules (`better-sqlite3`)
require platform-specific VSIXs published via `vsce package --target`.

**Project Type**: Single-project VS Code extension.

**Performance Goals**:
- Tree expansion: 50-cluster context renders ≤3s (SC-002), schema-tree
  node expand ≤1s on typical broadband.
- SQL connect: cluster-expand → usable console ≤10s (SC-007).
- Result grid: 1M-row SELECT first page ≤2s, max 10k rows in memory
  (SC-011).
- ER diagram: layout up to 200 tables in <2s in a worker.
- Tunnel teardown: dependent connections closed ≤2s (SC-012).

**Constraints**:
- Memory: ≤50 MB additional process memory while idle (SC-005).
- Network: no credentials in any log line, ever (SC-006); no telemetry by
  default (constitution §IV).
- No shelling out to `kubectl` for parseable output (constitution §II).
- No on-disk persistence of Secret material or live query results
  (FR-012).

**Scale/Scope**:
- Up to 10 kubeconfig contexts visible.
- Up to 50 CNPG clusters per context discoverable.
- Up to 10k tables per database introspectable lazily.
- Up to 1M rows queryable with grid pagination.
- Up to 10k+ history entries per workspace (FTS5 search remains <100ms).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution version: 1.0.0 (ratified 2026-05-15).

| Principle | Gate question | Status | Evidence |
|---|---|---|---|
| **I. VS Code UX Consistency** | Are all surfaces native VS Code where one fits? | ✅ PASS | TreeView for clusters/schema, Command Palette for actions, `cnpg-sql` notebook for SQL interaction, status-bar item for active connection / mode, NotebookRendererProvider for result grids, native markdown preview (Mermaid `erDiagram`) for ER diagrams. **Zero webviews shipped in v1.** ELK+D3+webview remains the documented upgrade target if a user hits Mermaid's ~50-table limit. |
| **II. Kubernetes-Native Integration** | Is all cluster interaction via kubeconfig + official client + CNPG CRDs? Does it honor RBAC? | ✅ PASS | `@kubernetes/client-node` reads kubeconfig natively (incl. exec plugins). CNPG `Cluster` listed via `CustomObjectsApi` against `postgresql.cnpg.io/v1`. Secrets read via `CoreV1Api`. Port-forward via official `PortForward` (no kubectl shellout). All errors surfaced verbatim (FR-007), no retry escalation. |
| **III. Test-First (NON-NEGOTIABLE)** | Will every behavior-shipping task have a failing test first? Are all three layers covered? | ✅ PASS | Plan mandates Vitest unit, nock-fixture contract tests for k8s, pg-mem contract tests for PG SQL generation, and `@vscode/test-electron` e2e at the boundary. Tasks (Phase 2) will enforce test-first per FR with SC-008..SC-012 as automatable gates. |
| **IV. Observability & Diagnostics** | Is there a dedicated Output channel with redacted lifecycle logs? Telemetry off by default? "Report a problem" command? | ✅ PASS | Single `LogOutputChannel` "cnpg4vscode" with leveled `key=value` lines (research §13). Every line passes through `redact()` (research §10). No telemetry SDK shipped. "cnpg.reportProblem" command will snapshot the last N log lines (already redacted) into a copyable buffer. |
| **V. Simplicity & YAGNI** | Is each feature the smallest scope that delivers value? Are abstractions introduced only with a second consumer? | ⚠ JUSTIFIED COMPLEXITY | The clarified scope is large (US4-US6 add a full SQL IDE surface). The plan sequences delivery in increments — US1 ships independently, US4 ships next, US5/US6 sub-capabilities each ship behind their own user-visible toggle. See Complexity Tracking below for the explicit tradeoffs. |
| **Security & Operational Constraints** | Credentials never logged, persisted, or eval'd? Destructive ops gated by typed confirmation? Proxy respected? | ✅ PASS | `redact()` chokepoint applied at every persistence/log boundary. ESLint rule forbids `workspaceState`/`storageUri` writes outside `src/state/history.ts`. Destructive tree actions gated by typed-name modal (FR-024). `http.proxy`/`http.proxyStrictSSL` honored by Node `https` config. No code-eval, no remote execution. |

**Result**: Pre-research gate PASS with one justified complexity (V) tracked below. No NEEDS CLARIFICATION items remain after Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/001-cnpg-cluster-explorer/
├── plan.md              # This file
├── spec.md              # Feature spec (already complete)
├── research.md          # Phase 0 — technology decisions (this command)
├── data-model.md        # Phase 1 — entities & relationships (this command)
├── quickstart.md        # Phase 1 — local dev quickstart (this command)
├── contracts/           # Phase 1 — internal & external contracts (this command)
│   ├── k8s-api.md       # Which K8s API verbs/paths/CRDs the extension calls
│   ├── pg-introspection.md  # pg_catalog query shapes per tree node
│   ├── webview-protocol.md  # Message protocol between extension host and webviews
│   ├── commands.md      # VS Code command IDs the extension contributes
│   └── settings.md      # VS Code configuration keys the extension contributes
├── checklists/
│   └── requirements.md  # Already complete
└── tasks.md             # Phase 2 — generated by /speckit-tasks (NOT here)
```

### Source Code (repository root)

```text
package.json             # VS Code extension manifest + commands/views/settings
tsconfig.json
.eslintrc.cjs            # incl. rule forbidding persistence outside state/history.ts
esbuild.config.mjs
.vscode/                 # launch.json for F5 debugging

src/
├── extension.ts         # activate/deactivate; wires up the modules below

├── k8s/                 # Kubernetes layer
│   ├── kubeconfig.ts        # context discovery, watch for changes
│   ├── cnpg.ts              # list Clusters via CustomObjectsApi
│   ├── secrets.ts           # discover & decode CNPG Secrets (in-memory only)
│   ├── port-forward.ts      # TunnelController FSM (research §14)
│   └── errors.ts            # upstream-error shaping (RBAC vs net vs auth)

├── pg/                  # PostgreSQL layer
│   ├── connection.ts        # per-(cluster,secret,db) connection pool
│   ├── cursor.ts            # pg-cursor wrapper for paged result sets
│   ├── introspect.ts        # pg_catalog queries per Schema Tree Node type
│   ├── readonly-gate.ts     # AST allowlist + session SET LOCAL guard
│   └── redact.ts            # credential-literal ruleset (research §10)

├── sql/                 # SQL-execution surface (shared helpers; notebook
│                       # cell execution lives under src/notebook/)
│   ├── statement-split.ts   # split a buffer into statements at top-level ;
│   ├── update-builder.ts    # generate UPDATE/DELETE from a row edit
│   └── migration.ts         # migration wizard orchestration

├── notebook/            # cnpg-sql Notebook implementation (FR-035)
│   ├── serializer.ts        # NotebookSerializer (JSON-on-disk format)
│   ├── controller.ts        # NotebookController per Database Connection
│   ├── output.ts            # Format pg.QueryResult as NotebookCellOutput
│   └── append-cell.ts       # Helpers for tree actions that add cells

├── ui/
│   ├── tree-clusters.ts     # Kubeconfig→Context→Namespace→Cluster TreeProvider
│   ├── tree-schema.ts       # Database→Schema→Tables/... TreeProvider
│   ├── status-bar.ts        # Active connection + mode indicator
│   ├── confirm.ts           # typed-name confirmation modal helper
│   ├── webview-grid/        # Result grid webview
│   │   ├── host.ts             # extension-side controller
│   │   └── media/              # built React bundle (glide-data-grid)
│   ├── webview-er/          # ER diagram webview
│   │   ├── host.ts
│   │   └── media/              # built D3 + elkjs bundle
│   └── editors/             # visual index/constraint editors (webviews)

├── state/
│   ├── history.ts           # SQLite (better-sqlite3) + FTS5 — ONLY persistence module
│   ├── session.ts           # in-memory: open connections, picked secret per cluster
│   └── tabs.ts              # multi-tab restore state

├── logging/
│   └── channel.ts           # LogOutputChannel wrapper with redact()

└── commands/
    └── index.ts             # cnpg.* command registrations

test/
├── unit/                 # Vitest, no VS Code host
│   ├── redact.test.ts
│   ├── readonly-gate.test.ts
│   ├── update-builder.test.ts
│   └── statement-split.test.ts
├── contract/             # Vitest, no VS Code host
│   ├── k8s/              # nock fixtures (recorded from kind+CNPG)
│   └── pg/               # pg-mem driven SQL-shape tests
├── e2e/                  # @vscode/test-electron
│   ├── tree.test.ts
│   ├── connect-and-query.test.ts
│   ├── grid-edit.test.ts
│   └── history-restore.test.ts
└── fixtures/
    ├── kubeconfig/
    ├── secrets/
    └── redaction/        # *.in.sql / *.out.sql pairs
```

**Structure Decision**: Single-project layout (a VS Code extension is a
single deliverable). Source under `src/`, organized by domain layer
(`k8s/`, `pg/`, `sql/`, `ui/`, `state/`, `logging/`) rather than by user
story — the user-story boundary is enforced at the tasks/test level, not
at the file level, because most stories touch the same modules.

## Phase 0 — Outline & Research

All NEEDS CLARIFICATION items from Technical Context have been resolved
by the research consolidated in [research.md](research.md). Highlights:

- VS Code engine `^1.85.0` chosen to access stable `LogOutputChannel`
  while keeping ~18 months of back-compat.
- `pg` (node-postgres) over `postgres` (porsager) — better COPY support
  and parameterized-query shape for the read-only gate.
- Read-only gate is a three-layer hybrid (AST allowlist +
  `SET LOCAL transaction_read_only` + role recommendation).
- Result grid is a webview using glide-data-grid backed by a React
  bundle, fed by `pg-cursor` 1k-row pages.
- ER diagram uses ELK.js (layered layout) + D3 SVG.
- Persistent history is SQLite (`better-sqlite3`) with FTS5; never
  stores credentials (always-redacted SQL only).
- Native module (`better-sqlite3`) ships via per-platform VSIXs.

## Phase 1 — Design & Contracts

Generated artefacts (see files):

- [data-model.md](data-model.md) — formal entities, attributes,
  relationships, state transitions, and validation rules derived from
  the spec's Key Entities section plus the FSMs introduced in research
  (tunnel lifecycle, connection mode, row-edit lifecycle).
- [contracts/k8s-api.md](contracts/k8s-api.md) — every K8s API verb/
  path/CRD the extension calls; used to record nock fixtures and write
  contract tests.
- [contracts/pg-introspection.md](contracts/pg-introspection.md) —
  per-node `pg_catalog` query shape for each Schema Tree Node type.
- [contracts/webview-protocol.md](contracts/webview-protocol.md) —
  the typed message protocol between the extension host and the two
  webviews (result grid, ER diagram).
- [contracts/commands.md](contracts/commands.md) — every VS Code
  command ID the extension contributes via `package.json`.
- [contracts/settings.md](contracts/settings.md) — every
  `cnpg4vscode.*` configuration key the extension contributes.
- [quickstart.md](quickstart.md) — local-development quickstart
  (clone → install → F5 → kind cluster with CNPG → see your first
  cluster in the tree).

Agent context update: the `CLAUDE.md` SPECKIT block now points to this
plan (per Outline step 3.3).

### Re-evaluation of Constitution Check Post-Design

| Principle | Re-check result | Notes |
|---|---|---|
| I. VS Code UX | ✅ PASS | Webviews limited to two surfaces; both bind `--vscode-*` variables and have snapshot tests against Light+/Dark+/HC. |
| II. K8s-Native | ✅ PASS | All API verbs documented in contracts/k8s-api.md; nock fixtures planned per verb. |
| III. Test-First | ✅ PASS | Test pyramid concretized in test/ tree; SC-008..SC-012 traced to specific test files. |
| IV. Observability | ✅ PASS | Single `LogOutputChannel`; redact chokepoint enforced by ESLint rule; "Report a problem" command in contracts/commands.md. |
| V. Simplicity | ⚠ JUSTIFIED | See Complexity Tracking. Sub-capabilities are independently togglable. |
| Security | ✅ PASS | SQLite contains only redacted text; ESLint rule blocks persistence elsewhere; destructive ops gated. |

No new violations introduced by the design.

## Complexity Tracking

> Filled because Constitution Check flagged Principle V (Simplicity & YAGNI) as ⚠ JUSTIFIED.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| *(Removed 2026-05-15)* ~~One webview (ER diagram)~~ — Mermaid `erDiagram` rendered via VS Code's native markdown preview now ships in v1; no webviews are required for the v1 surface. The Result-grid renderer lands as a `NotebookRendererProvider` (also native). The ELK+D3+webview path remains the documented upgrade target for >50-table schemas (research §7 revised banner). Constitution Principle I (VS Code UX Consistency) is now satisfied without exception. The Complexity Tracking section is kept for the remaining justified items below. | — | — |
| *(Added 2026-05-16)* **One webview reintroduced: the Grid Editor** (FR-037 / FR-038 / FR-039). After landing the no-webview migration / index / constraint editors and the pure cell-edit orchestrator, it became clear that the cell-editing acceptance scenario (US6 §1) cannot be delivered through the NotebookRendererProvider alone — the bounded ~400px output area, the renderer's inability to own keystrokes against the surrounding notebook UI, and the loss of state on cell re-execution are all structural blockers, not polish gaps. Every serious DB IDE (DBeaver / DataGrip / TablePlus / Beekeeper / Postico) ships a dedicated grid tab for exactly this reason. The NotebookRenderer remains as the inline lightweight view for the 95% "just scanning results" case; the Grid Editor opens on demand for editing workflows. | A no-webview QuickPick-driven "edit row by PK" flow was considered — same pattern that delivered the migration / index / constraint editors. It works as a stopgap but visibly under-delivers vs the DB-IDE peer set: no virtualized scrolling, no cell-tab keystrokes, no FK navigation, no bulk operations, no column-header filters. For a feature called "full SQL management" it would be a permanent caveat. | Building a custom canvas grid from scratch (no library) was rejected as both larger and worse: glide-data-grid is ~150 KB gzipped, MIT, used by Hex / PostHog at production scale, with the cell-editor protocol already built. The webview surface is bounded (one `dist/webviews/grid/` directory, gated by the existing CSP audit script which becomes load-bearing) and isolated (zero impact on activation cost — the bundle loads only when a Grid Editor panel opens). |
| Native binary dependency (`better-sqlite3`) requires per-platform VSIXs and a multi-target publish step | Per-workspace persistent history at 10k+ entries (SC scaling target) cannot be served by `workspaceState` (whole-memento rewrite on every update, O(n) search in JS). FTS5 gives sub-100ms full-text search at scale. | Tried mentally: JSON file + linear scan = >1s search at 10k entries, fails SC-007 expectations; `lowdb` = same JSON underneath; `workspaceState` = size cap and slow. The persistence module is isolated to one file (`src/state/history.ts`) so the native-dep blast radius is contained. |
| Three SQL-layer write gates (client AST + session read-only + role recommendation) where one might seem enough | An AST gate alone is bypassable via dynamic SQL (`DO $$ ... $$`); a session flag alone allows the user to send a script that fails halfway through with partial side effects. Spec FR-020 and SC-008 require *client-side* rejection ("rejection happens client-side before the statement is sent") AND robust runtime safety. | Single-layer approaches were considered and rejected: AST-only fails SC-008's "user cannot trivially bypass" intent; session-flag-only fails the spec's client-side-rejection wording. Hybrid is the minimum that satisfies both. |
| Cluster TreeProvider plus a separate Schema TreeProvider (instead of one) | The two trees have different refresh cadences (cluster: kubeconfig polling at 30s; schema: lazy on expand, cached 60s per OID), different data sources (Kubernetes API vs PostgreSQL pg_catalog), and different action sets. Sharing a provider would entangle two unrelated state machines and obscure the test boundary. | Considered a single provider with mixed nodes; rejected because it would force every refresh to walk both data sources, violating the lazy-loading requirement (FR-022) and complicating the contract tests. |

## Output

| Artefact | Path |
|---|---|
| Plan | [plan.md](plan.md) |
| Spec | [spec.md](spec.md) |
| Research | [research.md](research.md) |
| Data model | [data-model.md](data-model.md) |
| K8s API contract | [contracts/k8s-api.md](contracts/k8s-api.md) |
| PG introspection contract | [contracts/pg-introspection.md](contracts/pg-introspection.md) |
| Webview protocol | [contracts/webview-protocol.md](contracts/webview-protocol.md) |
| Commands contract | [contracts/commands.md](contracts/commands.md) |
| Settings contract | [contracts/settings.md](contracts/settings.md) |
| Quickstart | [quickstart.md](quickstart.md) |

Ready for `/speckit-tasks`.
