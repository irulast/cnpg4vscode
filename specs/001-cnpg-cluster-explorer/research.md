# Phase 0 — Research: cnpg4vscode

**Feature**: CloudNativePG Cluster Explorer + SQL Management
**Date**: 2026-05-15

This document consolidates all NEEDS CLARIFICATION items from the plan's
Technical Context and the technology decisions that back them. Each entry
records the **Decision**, **Rationale**, and **Alternatives considered**.

---

## 1. Extension language, build, and packaging

- **Decision**: TypeScript 5.4+ targeting ES2022, bundled with **esbuild**
  ^0.20, packaged with **`@vscode/vsce`** ^2.24. VS Code engine
  `^1.85.0` (Nov 2023). Single entrypoint `src/extension.ts`. Activation
  events: `onView:cnpg.clusters`, `onCommand:cnpg.*`, `onLanguage:sql`.
  Strict TS, no `*` activation events.
- **Rationale**: esbuild builds the extension in <500 ms with sourcemaps
  and tree-shaking; vsce is the only supported Marketplace/OpenVSX
  packager. Engine `^1.85` is broad (≈ 18 months back) and unlocks the
  modern `LogOutputChannel`, TreeView checkboxes, and stable webview
  view APIs the design depends on.
- **Alternatives considered**:
  - *Webpack* — slower, more config, no real gain for a single bundle.
  - *Rollup* — great for libraries, poor CommonJS interop with
    `@kubernetes/client-node`.
  - *SWC* — fine, but esbuild has stronger VS Code ecosystem alignment.

## 2. Kubernetes client library

- **Decision**: **`@kubernetes/client-node`** ^0.21.0 — official, only
  client that exposes both `KubeConfig` (with `exec` / auth-provider
  plugins) and the SPDY `PortForward` primitive.
- **Rationale**: Constitution §II forbids shelling out to `kubectl` for
  parseable output. This library reads kubeconfig natively, runs exec
  credential plugins for EKS / GKE / AKS, watches CRs, and provides
  port-forward. CNPG CRs (`postgresql.cnpg.io/v1` Cluster, Backup,
  Pooler) are reachable via `CustomObjectsApi`.
- **Known gotchas** (plan-level):
  - `exec`-based auth (EKS `aws eks get-token`, GKE
    `gke-gcloud-auth-plugin`) requires the binary on PATH — surface a
    clear error; do **not** log token output.
  - OIDC token refresh is not automatic; use `makeApiClient` per-call.
  - `loadFromDefault()` ignores `KUBECONFIG` colon-lists on Windows —
    merge manually.
  - SPDY uses `Upgrade` headers — incompatible with some corporate
    HTTPS proxies that strip them; surface a diagnostic.
- **Alternatives considered**: `kubernetes-client/javascript` fork
  (unmaintained); raw `node-fetch` (would reimplement SPDY — non-starter);
  kubectl shellout (constitution violation).

## 3. PostgreSQL driver

- **Decision**: **`pg`** (node-postgres) ^8.11 with **`pg-cursor`** for
  streamed result pages.
- **Rationale**: Mature, audited, parameterized queries via `$1`,
  `COPY` via `pg-copy-streams` (future), TLS via `ssl: { ca, servername }`.
  Over a port-forwarded `127.0.0.1` socket, the cert CN is the in-
  cluster service name; we override `checkServerIdentity` and pin the
  CNPG-issued CA from the `<cluster>-ca` Secret. `pg-cursor` enables
  result-grid pagination without buffering huge result sets.
- **Alternatives considered**:
  - *`postgres` (porsager)* — elegant, but implicit parameter inlining
    complicates the AST-based read-only gate; COPY support less
    ergonomic.
  - *`pg-promise`* — adds an opinionated layer unneeded here.

## 4. Port-forward mechanics

- **Decision**: `@kubernetes/client-node` `PortForward` bound to a
  `net.Server` on `127.0.0.1:0` (OS-assigned port). One tunnel per
  expanded cluster, owned by the tree node. Liveness combines TCP
  keepalive on the local socket plus a `SELECT 1` probe every 30 s
  issued by the connection pool. Reconnect backoff: 1 s, 2 s, 4 s, 8 s,
  16 s, then error after 5 attempts.
- **Rationale**: This is the documented pattern in the official
  examples. Binding to `127.0.0.1` (never `0.0.0.0`) keeps the tunnel
  local-only.
- **Known issues**: SPDY streams over long-lived API server connections
  drop silently behind corporate proxies; Node's SPDY does not always
  emit `error` on half-closed streams. Mitigation: probe-based liveness
  + treat ECONNRESET on `127.0.0.1` as tunnel-down.
- **Alternatives considered**: `kubectl port-forward` subprocess
  (constitution violation); raw WebSocket `/portforward` subprotocol
  (reimplements the client lib).

## 5. SQL editor surface

> **REVISED 2026-05-15**: The "untitled SQL document with per-tab
> binding" model below was **replaced** by a VS Code Notebook
> (`cnpg-sql` type) with one `NotebookController` per active connection.
> The original decision is preserved here for historical context; see
> [spec.md § Clarifications](spec.md#clarifications) (2026-05-15 entry on
> "What UI surface hosts the interactive SQL console") and `FR-035` /
> `FR-036` for the current architecture. The original reasoning below
> (reuse VS Code's `sql` language, no custom Monaco) still applies — but
> the *containing surface* is now a notebook rather than a text editor.
> Cells use the `sql` language; controllers replace per-editor binding;
> Shift+Enter (notebook-native) replaces Ctrl+Enter (custom keybinding).

- **Decision** *(superseded)*: Reuse VS Code's built-in `sql` language
  id; do **not** ship our own grammar. Provide `cnpg.runQuery` command
  bound to `Ctrl+Enter`/`Cmd+Enter` `when editorLangId == sql` that
  runs the selection-or-statement-under-cursor against the connection
  bound by the `cnpg.activeConnection` status-bar item. Multi-tab
  consoles are untitled `sql` documents, tagged via `Uri` query
  parameter (`untitled:console-1.sql?cnpg=<clusterId>`), restored on
  activation from `workspaceState`.
- **Why superseded**: Editor-binding state proved invisible and leaky.
  Browse Rows opened a new (unbound) preview document; running queries
  from anywhere but the original console failed; Ctrl+Enter was
  unreliable when focus drifted. Notebooks invert the model — cells
  know their controller, not the editor knows its connection — making
  the binding question disappear and unlocking native cell-output
  rendering for free.
- **Rationale (still valid)**: Reusing the built-in `sql` language is
  still correct; cells use it. A custom editor or webview-only console
  would still reimplement Monaco poorly. The notebook surface gives us
  the same Monaco benefits inside each cell.
- **Alternatives considered**: Custom editor with embedded Monaco
  (wasteful, theme drift); webview-only console (loses keybindings,
  accessibility, search). Notebook surface was not in the original
  evaluation but ranks above all of these for our use case.

## 6. Result grid with cell editing

> **REVISED 2026-05-16**: Reconfirms the original §6 decision
> (glide-data-grid in a webview) after the Phase 7.5 detour to a
> NotebookRendererProvider (T104). The NotebookRenderer remains as the
> **lightweight inline view** for the 95% "scan results, write next
> query" case; the full **Grid Editor** lands as a dedicated webview
> tab to deliver IDE-parity editing (FR-037 / FR-038 / FR-039). Both
> share the same `BuiltStatement` orchestrator at `src/sql/cell-edit-
> orchestrator.ts` — only the consumer surface differs. Spec
> divergence rationale: serious DB IDEs (DBeaver / DataGrip /
> TablePlus / Beekeeper / Postico) all use a dedicated grid tab, not
> inline-with-query output, because cell editing wants the entire
> tab's keystrokes, smooth virtualized scrolling for big result sets,
> and a sticky status bar — none of which a notebook cell output can
> do well.

- **Decision**: Webview hosting **glide-data-grid** ^6 in a small React
  ^18 bundle. Pagination via `pg-cursor` 1 k-row pages; the grid only
  retains the visible window plus dirty rows.
- **Rationale**: glide-data-grid renders to canvas, handles ≥1 M rows
  at 60 fps, has custom cell editors and selection semantics, MIT
  licensed. AG Grid Community is heavier and Enterprise features are
  not free. TanStack Table is headless (we'd still need a virtualizer
  and rendering layer). Tabulator is DOM-based and slows past ~100 k.
- **Bundle weight**: glide-data-grid + minimal React runtime is
  ~150 KB gzipped; budgeted against the current ~187 KB extension
  bundle (the React bundle is a separate `dist/webviews/grid/bundle.js`
  loaded only when the Grid Editor opens, so the activation-path cost
  is zero).
- **PK-based UPDATE/DELETE**: introspection attaches
  `pkColumns: string[]` to each result-set descriptor when the query is
  a simple `SELECT … FROM <single_table>` (detected via the conservative
  scanner from §6.5 / `src/pg/result-descriptor.ts`). Edits emit
  parameterized `UPDATE … WHERE pk = $1 [AND pk2 = $2]` via the
  already-landed `src/sql/update-builder.ts`. If no PK is detectable,
  the grid is read-only with a banner.
- **Per-type cell editors**: glide-data-grid's custom-cell-renderer
  protocol — text / number / boolean / date / timestamp use the
  built-in editors; `jsonb` / `json` open an in-grid popout textarea
  (Monaco-embedded considered but rejected as bundle weight); enum
  columns query `pg_enum` once on column-descriptor load and surface
  the allowed values as a dropdown.
- **Theme**: glide-data-grid theme tokens mapped from `--vscode-*` CSS
  variables; honor `editor.fontSize`, `editor.fontFamily`, and
  `workbench.colorTheme` contrast. Hard-coded hex values inside the
  webview bundle fail the theme-contrast snapshot test (T103, revived).
- **Persistence**: Grid layout state (visible columns, order, widths,
  sort, filter, scroll position) persists across reload via
  `context.workspaceState`. Keyed by `(contextName, namespace,
  clusterName, database, schema, table)`. NEVER includes cell data
  per Constitution §Security.
- **FK navigation**: Right-click an FK cell → **Go to referenced row**
  opens a NEW Grid Editor tab on the referenced table, filtered to the
  FK target value. Implementation: the result-descriptor query joins
  `pg_constraint` with `confrelid` to discover the referenced table on
  column-descriptor load.
- **Alternatives considered**: Notebook renderer (no in-place editing
  on large grids — kept as the lightweight inline view); custom editor
  (still needs a grid lib); AG Grid (~400 KB; range-selection and fill-
  handle behind the Enterprise paywall); Tabulator (DOM-based, slows
  past ~100 k); TanStack Table v8 (headless — ~30 KB but we'd build
  the renderer + virtualizer + cell-editor layer from scratch).

## 7. ER diagram rendering

> **REVISED 2026-05-15** *(amended same day after a bug report)*: We
> ship **Mermaid `erDiagram` in markdown + `bierner.markdown-mermaid`
> as an extension dependency** for v1, instead of the ELK+D3 webview
> originally chosen below.
>
> **The initial revision incorrectly claimed Mermaid was built into VS
> Code's markdown preview.** It isn't — VS Code's markdown preview
> ships without Mermaid; rendering requires
> [`bierner.markdown-mermaid`](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid)
> (Matt Bierner's "Markdown Preview Mermaid Support", 6.5M+ installs,
> by the VS Code markdown maintainer at Microsoft). The implementation
> declares that extension via `extensionDependencies` so Marketplace
> installs pull it in automatically, plus a runtime guard in
> `src/ui/er-diagram.ts` that prompts the user to install it via the
> "Install" / "Open in Marketplace" / "Not now" flow if it's somehow
> missing (e.g., dev-mode F5, VSIX install).
>
> Reason for sticking with Mermaid (vs the original ELK+D3 webview):
> most CNPG users manage application databases (handful of tables),
> not 1000-table data warehouses; Mermaid handles that scale cleanly
> via the standard markdown preview surface with no per-platform
> bundle work, theme-awareness for free, and standard copy/export
> semantics (Constitution §V Simplicity & YAGNI + §I VS Code UX
> Consistency). The 50-table soft limit is surfaced as a friendly
> preamble in the generated markdown when the threshold is exceeded,
> suggesting the user scope the diagram to a single schema. The
> ELK+D3+webview path remains the documented upgrade target for when
> a real user hits the wall — `FR-028` is generic about the rendering
> tech and accommodates either choice without amendment.

- **Decision** *(superseded)*: **ELK.js** (`elkjs` ^0.9) for layered
  graph layout inside a Worker, plus **D3** ^7 for SVG rendering inside
  a webview. Pan/zoom via `d3-zoom`; click to focus.
- **Why superseded**: ELK+D3+webview is the right answer for a 200+
  table data warehouse. For CNPG's typical "operator manages app
  databases" deployment, that's overengineering. The current
  implementation ships in ~200 lines of pure code (no bundle, no
  worker, no D3) and lets VS Code's markdown preview do the layout.
  Upgrade path: when a user reports the 50-table soft limit hurting
  them, ship the ELK+D3 renderer as a webview behind a setting.
- **Rationale (Mermaid path)**: VS Code's markdown preview ships with
  Mermaid built-in. Generating a fenced `mermaid` code block gives us
  a native VS Code surface, full theme-awareness, copyable markdown
  (export to docs trivially), and zero per-platform packaging
  concerns. Pure-function builder is unit-testable without a DOM.
- **Alternatives considered**: Cytoscape.js (heavier; layout quality
  lower for ER); custom canvas + layout algorithm (NIH); ELK+D3+webview
  as the documented upgrade; Graphviz/viz.js (works but SVG isn't
  ergonomic to make interactive, large WASM payload).

## 8. Schema introspection strategy

- **Decision**: Hand-written `pg_catalog` queries, lazy per tree node,
  with a 60 s in-memory TTL cache keyed by `(connectionId, oid)`. No
  introspection library.
- **Rationale**: `pg_catalog` is faster than `information_schema`,
  exposes OIDs (stable identity across renames), and lets us fetch
  exactly what the expanded node needs. `pg-structure` preloads the
  whole catalog — fine for small DBs, painful for 10 k-table multi-
  tenant schemas. `schemats` is codegen, not interactive. Each tree
  expand fires one query; results cached briefly so re-expand is
  instant.
- **Per-node query shape** (recorded in
  [contracts/pg-introspection.md](contracts/pg-introspection.md)):
  databases → `pg_database`; schemas → `pg_namespace`; tables →
  `pg_class WHERE relkind IN ('r','p')`; columns → `pg_attribute JOIN
  pg_type`; indexes → `pg_index JOIN pg_class`; constraints →
  `pg_constraint`; functions → `pg_proc`.
- **Alternatives considered**: `information_schema` (slower,
  portability tax); `pg-structure` (eager); `schemats` (codegen).

## 9. Read-only SQL gate

- **Decision**: Three-layer hybrid (a user cannot trivially bypass any
  one layer alone).
  1. **Client-side AST allowlist** using **`@pg-query/parser`**
     (libpg_query WASM). Allowed top-level node kinds: `SelectStmt`,
     `ExplainStmt` (no `ANALYZE`), `VariableShowStmt`, transaction-
     scope `VariableSetStmt`. Reject CTEs containing
     `INSERT/UPDATE/DELETE/MERGE`. Reject `SELECT … FOR UPDATE/SHARE`.
     Reject calls to a denylist of mutating functions (`nextval`,
     `setval`, `lo_*`, `pg_advisory_lock`, etc.) — list is extensible.
  2. **Server-side session guard**: every read-only query runs inside
     `BEGIN; SET LOCAL transaction_read_only = on; <stmt>; ROLLBACK;`
     on a connection that also sets `default_transaction_read_only=on`
     via the connection-string `options` parameter.
  3. **Role recommendation**: docs and UI strongly suggest the
     `<cluster>-app` user or a dedicated read-only role.
- **Rationale**: AST alone is bypassable via dynamic SQL (`DO $$ … $$`)
  — caught by allowlist. Session flag alone allows multi-statement
  scripts with partial side effects — AST catches them at pre-flight.
  Both must be defeated to mutate.
- **Alternatives considered**: `pgsql-ast-parser` (pure JS, diverges
  from real PG grammar); regex-only (hopeless).

## 10. Credential-literal redaction ruleset

- **Decision**: A `redact()` chokepoint applied **before every write to
  any persistent or log surface** (SQLite history, restored buffers,
  `LogOutputChannel`). Replacement token: `'***REDACTED***'`. Starting
  pattern set (case-insensitive, token-boundary anchored):
  1. `PASSWORD\s+'[^']*'` (CREATE/ALTER ROLE/USER)
  2. `IDENTIFIED\s+BY\s+'[^']*'`
  3. `ENCRYPTED\s+PASSWORD\s+'[^']*'`
  4. `WITH\s+PASSWORD\s+'[^']*'`
  5. `(connection_string|conninfo|dsn)\s*=\s*'[^']*'` (FDW/subscriptions
     /replication)
  6. `(SECRET|TOKEN|API[_-]?KEY|AUTHORIZATION)\s*[:=]\s*'[^']*'`
  7. `Bearer\s+[A-Za-z0-9._\-]+`
  8. `(postgres(?:ql)?:\/\/)[^:\s]+:[^@\s]+@` → keep scheme + user,
     redact password.
  9. PEM private-key blocks (`-----BEGIN ... PRIVATE KEY-----...END...`).
  10. Bodies of `CREATE FUNCTION … LANGUAGE plpgsql AS $$ … $$` —
      replace body entirely; functions frequently embed credentials in
      `dblink` calls.
- **Test corpus**: snapshot fixtures `test/fixtures/redaction/*.in.sql`
  paired with `*.out.sql`. Coverage matrix: each pattern ×
  {single-quoted, escape-quoted, $tag$-quoted, mixed-case, with
  whitespace/comments between keyword and literal}. Property test:
  `original ≠ redacted iff at least one pattern matched` and
  `redact(redact(x)) == redact(x)` (idempotent).

## 11. Per-workspace persistent storage

> **REVISED 2026-05-15**: Shipped as **JSON-on-disk + in-memory
> filter**, not SQLite+FTS5. Reason: in practice CNPG-extension users
> run ~100-500 queries per session — well below the scale where SQLite's
> indexing matters. JSON ships with zero native-binding complexity,
> zero per-platform packaging penalty (we still package per-target so
> the muscle memory is in place for future native deps, but the JSON
> store doesn't need it), and trivial migration. SQLite remains the
> documented upgrade target if a user reports actual search latency at
> scale; the storage interface (`HistoryStore`) is intentionally
> swappable. Constitution §V (Simplicity & YAGNI).

- **Decision** *(superseded)*: **SQLite via `better-sqlite3`** ^11 at
  `context.storageUri/history.db`. Schema:
  `queries(id INTEGER PRIMARY KEY, ts INTEGER, cluster_id TEXT, db TEXT,
   redacted_sql TEXT, duration_ms INTEGER, rows INTEGER, ok INTEGER)`
  plus an `FTS5` virtual table over `redacted_sql` for substring/
  keyword search.
- **What shipped instead**: a single JSON array at
  `context.storageUri/history.json`, bounded to
  `cnpg4vscode.history.maxEntries` (default 1000). Append-only with
  oldest-first pruning on overflow. Read on every search via
  `JSON.parse`; in-memory case-insensitive substring filter against
  the entry list. Concurrency-safe through a chained write-promise.
  The discovery surface is a `vscode.window.showQuickPick` (native VS
  Code; filter-as-you-type) — no webview required for the panel.
- **Rationale (JSON path)**: A 1000-entry history weighs ~200 KB
  on-disk, parses in <10 ms, and filters in <5 ms via native JS
  string-includes. SQLite's wins (O(log n) lookups, FTS5) start to
  matter past ~5k entries — not where typical users live.
- **Native module note** *(deferred)*: `better-sqlite3` would still
  need per-platform VSIXs via `vsce package --target`. The packaging
  pipeline (T131) is already wired for this case.
- **Alternatives considered**: `workspaceState` (size + perf cap;
  serializes the whole memento per write); `lowdb` (JSON underneath,
  no win over our own append); SQLite (deferred; upgrade target).

## 12. Testing strategy

- **Decision**:
  - *Unit*: **Vitest** ^1.5 on host Node (no VS Code host). Fast watch.
  - *Contract (k8s)*: Vitest + **`nock`**-replayed fixtures recorded
    from a real `kind` cluster with CNPG installed. Refreshed via a
    separate `pnpm record:fixtures` script gated by env var.
  - *Contract (PG)*: **`pg-mem`** for SQL-shape and redaction tests.
  - *E2E*: **`@vscode/test-electron`** + **`@vscode/test-cli`** against
    a testcontainers Postgres 16 plus nock-mocked Kubernetes API.
    Covers tree expand → connect → run query → grid edit → history
    persists.
- **Rationale**: Vitest's speed makes test-first viable; pg-mem covers
  90% of SQL-shape tests without a container; testcontainers gives
  realism for the 10% that needs a real server. nock recordings keep
  constitution §III's "HTTP-mocked" rule literal.
- **Alternatives considered**: Jest (slower, CJS friction); Mocha (no
  batteries-included assertions/mocks).

## 13. Logging

- **Decision**: One **`LogOutputChannel`** (stable since 1.74) named
  `cnpg4vscode`, level driven by `cnpg4vscode.log.level` setting.
  Format: human-readable single-line `key=value` pairs (e.g.,
  `event=tunnel.open cluster=ns/foo localPort=54321 durationMs=312`).
  Levels: trace (k8s URLs, headers stripped), debug (SQL plan info),
  info (lifecycle), warn (retries), error (failures). Every line
  passes through `redact()` before write.
- **Rationale**: `LogOutputChannel` is searchable, level-filtered, and
  honors user settings without extra code. KV text beats JSON for an
  output channel humans read; structured JSON would only matter if we
  shipped a log forwarder, and we won't (no telemetry).
- **Alternatives considered**: `OutputChannel` (dumb pipe; reimplement
  levels); structured JSON to file (against §IV "default" expectation).

## 14. Tunnel state machine

- **Decision**: Per-cluster `TunnelController` owned by the tree node,
  modeled as a typed FSM:
  - States: `idle` → `opening` → `open` → `retrying` → `open` |
    `closing` → `closed`. `error` is terminal until user-initiated
    retry.
  - Transitions:
    - `idle → opening` on tree-node expand.
    - `opening → open` when local socket listens AND first `SELECT 1`
      probe succeeds.
    - `opening → error` on kubeconfig / permission / CRD failure (no
      retry; user fix needed).
    - `open → retrying` on local-socket error or 2 consecutive probe
      failures.
    - `retrying → open` on success; `retrying → error` after 5 failed
      attempts (backoff 1/2/4/8/16 s).
    - `open → closing → closed` on tree collapse, workspace close, or
      explicit Disconnect.
    - `* → closed` on extension deactivation.
  - Every transition emits an event the tree provider consumes to
    update icons (idle = gray dot, open = green, retrying = yellow
    spinner, error = red). Every transition logged.
- **Rationale**: An explicit FSM keeps the icon/refresh logic simple,
  makes the integration tests express transitions directly (`expect
  controller.state).toBe('retrying')`), and isolates the SPDY weirdness
  to one module.

## 15. Constitution-aligned risks & mitigations

| # | Risk | Constitution principle | Mitigation |
|---|---|---|---|
| 1 | Webview color/contrast drift in custom themes (glide-data-grid, D3 SVG, React UIs default to their own palettes). | I. VS Code UX Consistency | Map every color via `--vscode-*` CSS variables (no hard-coded hex). Snapshot the webviews against the three default themes (Light+, Dark+, High Contrast). Automated contrast check using `@vscode/codicons` reference colors. |
| 2 | Credentials silently persisting through `workspaceState`, the SQLite DB, or the Output channel. | Security & Operational Constraints (§Security); IV. Observability | Single `redact()` chokepoint at every persistence/log boundary (§10). ESLint rule forbids `workspaceState.update` / `storageUri` writes outside `src/state/history.ts`. Property-based test: for any captured Secret bytes B, no persisted artifact contains B. |
| 3 | Transitive dependency telemetry or postinstall network calls (historically `node-ipc`, `core-js`, etc.). | IV. Observability (no default telemetry) | Lockfile + `pnpm audit` + `license-checker` allowlist in CI. Denylist of known-phoning-home packages. Refuse deps with postinstall network calls. Ship with `NO_TELEMETRY=1`-style env propagation. SBOM with each release. |

---

All Phase 0 NEEDS CLARIFICATION items are resolved. The plan's
Constitution Check passes with one justified complexity (Principle V),
documented in [plan.md § Complexity Tracking](plan.md#complexity-tracking).
