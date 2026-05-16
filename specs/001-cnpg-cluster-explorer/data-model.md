# Phase 1 — Data Model: cnpg4vscode

**Feature**: CloudNativePG Cluster Explorer + SQL Management
**Date**: 2026-05-15

This document expands the spec's Key Entities into a formal model with
attributes, identity, relationships, lifecycle / state transitions, and
validation rules. It is the source the tests assert against and the
shape that `data-model.md` references in tasks.md will quote.

Notation: each entity has **Identity**, **Attributes**, **Relationships**,
and where applicable a **Lifecycle** state machine.

---

## Kubeconfig Context

- **Identity**: `(kubeconfigPath, contextName)` — a context name within
  the resolved kubeconfig file. Stable across sessions.
- **Attributes**:
  - `name: string`
  - `cluster: string` (kubeconfig cluster ref)
  - `user: string` (kubeconfig user ref)
  - `server: string` (API server URL — *not logged*)
  - `authMode: 'token' | 'exec' | 'authProvider' | 'cert' | 'basic'`
  - `cnpgPresent: 'unknown' | 'present' | 'absent' | 'forbidden'`
  - `lastError?: string` (verbatim upstream error if cnpgPresent ===
    `unknown` due to network / auth failure)
- **Relationships**: parent of zero-or-more **Namespace** nodes (filtered
  by "namespace contains ≥ 1 CNPG Cluster").
- **Lifecycle**: `unknown → present | absent | forbidden`. Refreshes on
  manual refresh, the 30 s timer (FR-006), and on detected kubeconfig
  mtime change (FR-014).

## Namespace

- **Identity**: `(contextName, namespaceName)`.
- **Attributes**: `name: string`.
- **Relationships**: parent of one-or-more **CNPG Cluster**.
- **Filter**: only surfaced when `cnpg list` returns at least one
  cluster in the namespace.

## CNPG Cluster

- **Identity**: `(contextName, namespace, name)`.
- **Attributes** (sourced from `postgresql.cnpg.io/v1 Cluster`):
  - `name: string`
  - `namespace: string`
  - `phase: 'Cluster in healthy state' | 'Setting up primary' | ...`
    (verbatim from `.status.phase`)
  - `instances: number` (`.spec.instances`)
  - `primary: string | null` (`.status.currentPrimary`)
  - `pgMajorVersion: number` (parsed from `.spec.imageName` or
    `.status.pgVersion` if present)
  - `storageSize: string` (`.spec.storage.size`)
  - `lastCondition: { type: string; status: string; message: string;
    lastTransitionTime: string } | null`
  - `readWriteService: string` (`<name>-rw` by convention; overridable
    by annotation if upstream changes)
  - `caSecretName: string` (`<name>-ca` by convention)
- **Relationships**: has one **Operator Presence** (per its context);
  has zero-or-more **CNPG Secret**; has at most one **Port-Forward
  Tunnel** at any moment.
- **Lifecycle**: external — the operator owns CR state. The extension
  observes via `list` + 30 s refresh.

## Operator Presence

- **Identity**: `contextName`.
- **Attributes**: `installed: boolean`, `crdVersion: string | null`.
- **Detection**: GET on the CRD `clusters.postgresql.cnpg.io`; not-found
  ⇒ `installed: false`, forbidden ⇒ `cnpgPresent='forbidden'` on the
  parent Context.

## CNPG Secret (Database Credential)

- **Identity**: `(contextName, namespace, secretName)`.
- **Attributes**:
  - `secretName: string`
  - `kind: 'app' | 'superuser' | 'other'` (heuristic: matches
    `<cluster>-app` / `<cluster>-superuser`; else `other`)
  - `username: string` (decoded from `.data.username`, in-memory only)
  - `password: string` (decoded from `.data.password`, in-memory only)
  - `databaseName: string | null` (`.data.dbname` if present)
- **Relationships**: belongs to one **CNPG Cluster** (via ownerReference
  or naming convention).
- **Lifecycle**: never persisted to disk; refetched per session.
- **Validation rules**:
  - Both `username` and `password` keys MUST be present, otherwise the
    secret is shown in the picker with raw key names and a warning
    (Edge Cases §"CNPG secret format changes").

## Port-Forward Tunnel

- **Identity**: `(contextName, namespace, clusterName)` — at most one
  per cluster.
- **Attributes**:
  - `state: 'idle' | 'opening' | 'open' | 'retrying' | 'closing' |
    'closed' | 'error'`
  - `localPort: number | null` (OS-assigned)
  - `bindAddress: '127.0.0.1'` (constant)
  - `targetService: string` (the cluster's `-rw` service)
  - `targetPort: 5432` (PostgreSQL)
  - `attempt: number` (current retry counter; reset on `open`)
  - `lastError: string | null`
- **Relationships**: belongs to one **CNPG Cluster**; has zero-or-more
  **Database Connection**.
- **Lifecycle** (see also research.md §14):

```text
   idle ──expand──▶ opening ──ok──▶ open ──collapse──▶ closing ──▶ closed
                       │              │
                  fail (no retry)     │ probeFail×2 / sockErr
                       ▼              ▼
                     error          retrying ──ok──▶ open
                                       │
                                  fail×5
                                       ▼
                                     error
```

- **Validation rules**:
  - `localPort` is set only in `open` / `retrying` / `closing`.
  - Teardown (`closing`) MUST close every dependent **Database
    Connection** before transitioning to `closed`.

## Database Connection

- **Identity**: `(tunnelId, secretName, databaseName)`.
- **Attributes**:
  - `tunnelId: TunnelId`
  - `secretName: string`
  - `databaseName: string`
  - `mode: 'readonly' | 'write'` (default: `readonly`)
  - `pgClient: pg.Pool` (in-memory; not persisted)
  - `status: 'connecting' | 'idle' | 'in-use' | 'failed' | 'closed'`
- **Relationships**: depends on one **Tunnel**; surfaced via exactly one
  **Notebook Controller**; produces zero-or-more **Query History Entry**
  per executed cell.
- **Lifecycle**:
  - `connecting → idle` on first successful connect + `SELECT 1` probe.
  - `idle ↔ in-use` per query.
  - `idle → closed` on user disconnect.
  - `* → closed` on tunnel teardown.
- **Validation rules** (FR-020):
  - When `mode === 'readonly'`, the read-only gate runs on every
    cell text before send; rejection is a client-side error rendered
    inline as the cell's output, nothing reaches the server.
  - Switching `readonly → write` requires explicit user action; the
    state transition updates the controller's label AND the status bar.
  - `mode` MUST NOT be persisted across VS Code restarts.

## Notebook Controller

- **Identity**: matches the backing Database Connection's id.
- **Attributes**:
  - `id: string` (matches `Connection.id`)
  - `notebookType: 'cnpg-sql'`
  - `label: string` (e.g., `app-db/postgres (read-only)`)
  - `supportedLanguages: ['postgres', 'sql']`
  - `supportsExecutionOrder: true`
- **Relationships**: 1:1 with **Database Connection**. Many-to-many with
  **CNPG SQL Notebook** (any open notebook can pick any registered
  controller).
- **Lifecycle**: created when the connection is registered with the
  session; disposed when the connection is removed. The notebook's
  selected controller updates on user pick or on restore via the
  notebook's metadata.
- **Validation rules** (FR-035):
  - The label MUST be recomputed on mode toggle so the notebook UI
    reflects the current read-only / write state.
  - Cell execution MUST route through the same read-only gate (FR-020)
    and history-recording pipeline (FR-033) as any other query.

## CNPG SQL Notebook

- **Identity**: file URI (saved) or `untitled:` URI (unsaved).
- **Attributes**:
  - `uri: vscode.Uri`
  - `cells: NotebookCellData[]` — code (`postgres` by default; `sql`
    accepted for backwards-compatibility with hand-edited notebooks)
    or markdown
  - `metadata: { boundControllerId?: string }` — recorded so the
    controller can be re-selected on restore
- **Persistence**: serialised to a JSON-on-disk format by the
  `cnpg-sql` `NotebookSerializer`. Native VS Code notebook persistence
  handles open / save / restore; the extension does not maintain a
  parallel tab-restore state machine.
- **Validation rules** (FR-033, FR-034):
  - On serialize, cell text MUST pass through `redact()` so saved
    notebooks never contain credential literals.
  - Cell outputs MUST be discarded from disk serialisation (kept only
    in-memory) so result row values are not accidentally persisted to a
    workspace file.

## Per-Cluster Notebook Folder

- **Identity**: `<workspaceRoot>/<base>/<context>/<namespace>/<cluster>/`
  where `<base>` is the `cnpg4vscode.notebooks.location` setting.
- **Attributes**:
  - `workspaceRoot: vscode.Uri`
  - `clusterKey: string` (`context/namespace/cluster`)
  - `path: vscode.Uri` (the folder URI)
- **Relationships**: 0..1 per **CNPG Cluster** per workspace folder.
  Holds zero-or-more **CNPG SQL Notebook** files.
- **Lifecycle**: created lazily on first "Save to cluster"; never
  auto-removed by the extension (the user owns the file system).
- **Validation rules** (FR-037):
  - Path segments derived from the cluster identifier MUST be filesystem-
    safe (cluster names are RFC 1123 DNS labels, so they're safe by
    construction; the context segment may contain `/` or `:` which the
    extension MUST URL-encode before joining).
  - The extension MUST NOT write outside the resolved `<workspaceRoot>`;
    when no workspace is open, "Save to cluster" surfaces an error and
    refuses to write.
  - The Clusters tree MUST refresh the cluster's subtree on
    add/remove/rename events under the folder, without polling.

## Result Grid Row Edit

- **Identity**: `(resultSetId, rowIndex, columnIndex)`.
- **Attributes**:
  - `originalValues: Record<column, value>`
  - `newValue: value`
  - `pkColumns: string[]`
  - `pkValues: Record<column, value>`
  - `status: 'staged' | 'previewed' | 'applied' | 'rolledback'`
- **Relationships**: belongs to one result set served by a single
  **Database Connection**.
- **Validation rules** (FR-025):
  - Edits only stage when `connection.mode === 'write'` AND
    `pkColumns.length >= 1`.
  - `applied` requires explicit confirmation after seeing the generated
    UPDATE/DELETE preview.
  - If the underlying tunnel transitions to `closing` while edits are
    `staged`, all stages are dropped with a user-visible warning.

## Schema Tree Node

- **Identity**: `(connectionId, oid)`.
- **Attributes**:
  - `oid: number` (PostgreSQL object identifier — stable across
    renames)
  - `kind: 'schema' | 'table' | 'view' | 'materializedView' | 'index'
    | 'sequence' | 'function' | 'procedure' | 'trigger' | 'type'
    | 'extension' | 'role'`
  - `qualifiedName: string` (schema-qualified identifier)
  - `parent: oid | null`
  - `metadata: object` (kind-specific — column list, columns of an
    index, etc.; fetched lazily)
- **Relationships**: parent → children via standard PG containment
  (schema contains tables, table contains columns/indexes/constraints
  /triggers, etc.).
- **Caching**: 60 s TTL keyed by `(connectionId, oid)`. Invalidated on
  manual refresh of the affected subtree.

## Saved Script

- **Identity**: workspace-relative path to a `.sql` file.
- **Attributes**:
  - `path: string`
  - `displayName: string` (filename without extension by default)
  - `lastModified: number`
- **Relationships**: no extension-owned relationships; first-class
  workspace artefact.
- **Validation rules**: extension MUST NOT auto-create scripts; user
  initiates "Save as script". Default storage root:
  `${workspaceRoot}/.cnpg/scripts/`, overridable via the
  `cnpg4vscode.scripts.location` setting.

## Query History Entry

- **Identity**: `id INTEGER` (SQLite auto-increment).
- **Attributes**:
  - `id: number`
  - `ts: number` (epoch ms)
  - `cluster_id: string` (qualified `context/namespace/name`)
  - `db: string`
  - `user: string`
  - `redacted_sql: string` (post-redaction; FR-033)
  - `duration_ms: number | null`
  - `rows: number | null`
  - `ok: boolean`
  - `error_class: string | null` (PG SQLSTATE if any)
- **Storage**: SQLite `queries` table + FTS5 virtual table over
  `redacted_sql`. Per-workspace, `context.storageUri/history.db`.
- **Validation rules** (FR-033):
  - `redacted_sql` MUST pass `redact()` before insert.
  - Inserts are wrapped in a single transaction with the FTS update.
  - No credential-shaped string (any of the §10 patterns matched on
    the *original* SQL) may survive into the stored value.

## Migration Script

- **Identity**: ephemeral (only persisted when the user exports).
- **Attributes**:
  - `statements: { id: number; sql: string }[]` (user-authored, ordered)
  - `transactional: boolean` (true unless the statement set contains
    non-transactional DDL like `CREATE INDEX CONCURRENTLY`)
  - `dryRunOk: boolean | null` (after preview)
- **Lifecycle**:
  - `assembling → previewed → running → succeeded | partiallyApplied |
    rolledback`.
  - `partiallyApplied` only reachable when `transactional === false`
    AND a statement after the first non-transactional one fails.
- **Validation rules** (FR-027):
  - Running MUST require explicit confirmation after preview.
  - `BEGIN; … ; COMMIT;` wraps the statement set when `transactional`;
    `ROLLBACK` on any failure.

## ER Diagram

- **Identity**: `(connectionId, scope)` where `scope` is either a
  single schema OID or a user-chosen set of table OIDs.
- **Attributes**:
  - `tables: { oid; name; columns: { name; type; pk: boolean }[] }[]`
  - `foreignKeys: { fromOid; toOid; columns: string[] }[]`
  - `layoutVersion: number` (incremented when scope changes to force
    re-layout)
- **Relationships**: derived from **Schema Tree Node**s; not persisted.
- **Validation rules** (FR-028): read-only render; node click selects
  but never edits.

---

## Cross-entity invariants

1. **No credential ever leaves memory** — Secret material, decoded
   passwords, and bearer-shaped strings produced from kubeconfig
   `exec` calls MUST NOT be written to any path that hits disk or any
   surface visible outside the extension process (logs, stored
   workspace state, telemetry — telemetry is off, but the invariant
   stands). Verified by the property-based test described in
   research.md §15 risk 2.
2. **Read-only gate is total** — for every `DatabaseConnection` where
   `mode === 'readonly'`, every statement MUST be classified by the
   AST allowlist (§9 layer 1) before any byte reaches `pg.query`.
   Verified by SC-008 across a corpus of ≥ 50 statements.
3. **Destructive ops are double-gated** — every entry point that emits
   `DROP`, `TRUNCATE`, `REINDEX` or destructive `ALTER` MUST flow
   through the `confirm.ts` typed-name modal (FR-024 / SC-009).
4. **Tunnel teardown is total** — closing a Tunnel MUST close every
   dependent DatabaseConnection within ≤ 2 s (SC-012), rolling back
   any in-flight transaction.
5. **History writes are idempotent under redaction** —
   `redact(redact(x)) === redact(x)` for every input x in the test
   corpus (research.md §10).
