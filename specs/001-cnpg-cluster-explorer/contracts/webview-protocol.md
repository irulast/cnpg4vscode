# Contract — Webview message protocol

> **REVISED 2026-05-16**: Reintroduces the Grid Editor webview
> protocol after the FR-035 detour. The NotebookRendererProvider from
> T104 remains as the inline lightweight view; the Grid Editor is a
> separate dedicated webview tab (FR-037 / FR-038 / FR-039) that
> delivers IDE-parity cell editing. Both consume the same
> `application/x-cnpg-result+json` shape for the underlying result
> set, but the Grid Editor adds a full bidirectional message protocol
> for editing, FK navigation, paging, export, and layout-state
> persistence.
>
> The ER diagram remains a Mermaid + markdown-preview path (see
> research §7 and the T115/T118 entries in tasks.md). The ELK+D3
> webview is still the documented upgrade path if Mermaid's
> ~50-table ceiling becomes a real constraint, but it's not in
> scope for this revision.

The Grid Editor webview is hosted via `vscode.window.createWebviewPanel`
with `enableScripts: true`, a strict CSP (see Security posture below),
and `retainContextWhenHidden: true` (so an unfocused tab keeps its
dirty edits + scroll position in memory without re-rendering on
focus).

The renderer is a small React + glide-data-grid bundle (see research
§6, REVISED 2026-05-16). It owns the canvas grid, the per-type cell
editors, sort/filter/hide UI, and dirty-row tracking. The host owns
SQL execution, schema introspection, persistence, and the
cell-edit-orchestrator.

## Shared envelope

All messages between host and grid carry a `type` discriminator and an
optional client-supplied correlation id. The host MUST treat every
inbound message as untrusted: validate `type`, validate every payload
field's type and bounds, drop unknown types at `warn`.

```ts
type Message<TPayload, TType extends string> = {
  type: TType;
  id?: string;          // optional correlation id; the responder echoes
  payload?: TPayload;   // omitted on no-arg messages (e.g. "ready")
};
```

Correlation ids: when the host sends a request that expects a single
response (e.g. `loadPage`), it MUST set `id`; the grid's response
message MUST echo the same `id` so the host can resolve the pending
promise. Fire-and-forget messages (e.g. `themeChanged`) omit `id`.

---

## Lifecycle

```
HOST                          RENDERER
 │                              │
 │  ─── init ──────────────────►│
 │  payload: { descriptor,      │   (renderer mounts the grid,
 │             theme,           │    requests first page)
 │             persistedState } │
 │                              │
 │  ◄──────────────── ready ────│
 │                              │
 │  ◄──────────── loadPage ─────│
 │            payload: { offset, limit, sort?, filters? }
 │  ─── page ──────────────────►│
 │  payload: { offset, rows, totalRows, truncated }
 │                              │
 │     … editing / scrolling …  │
 │                              │
 │  ◄──────── applyRequested ───│
 │  payload: { dirtyRows: [{ pkValues, changes }, …] }
 │                              │
 │  ─── applyPreview ──────────►│   (renderer shows the modal preview)
 │  ◄──────── applyConfirmed ───│
 │  ─── applyResult ───────────►│   (per-row succeed/fail)
 │                              │
 │     … FK navigation …        │
 │                              │
 │  ◄──── openReferencedRow ────│
 │            payload: { fromColumn, value }
 │  (host opens a new Grid Editor tab — no direct reply on this channel)
 │                              │
 │     … persistence …          │
 │                              │
 │  ◄──── layoutChanged ────────│
 │            payload: GridEditorState
 │  (host persists to workspaceState; no reply needed)
 │                              │
 │  ─── modeChanged ───────────►│   (connection toggled read-only ↔ write)
 │                              │
 │  ─── disposed ──────────────►│   (panel closed; cleanup; grid stops)
```

---

## Host → Grid messages

### `init`

Sent once on `webview.onDidReceiveMessage('ready')` and on
`onDidChangeViewState(visible=true)` after a hibernation. Carries the
column descriptor (types + PK + FK targets + enum allowed values), the
theme tokens, and the persisted layout state.

```ts
interface InitPayload {
  descriptor: {
    columns: ColumnDescriptor[];
    pkColumns: string[];                    // empty if no PK detected → grid is read-only
    totalRowsEstimate: number | null;       // for pagination UI; null if unknown
    target: { schema: string; table: string; kind: 'table' | 'view' | 'matview' };
    editable: boolean;                      // false for views / no-PK / read-only conn
  };
  theme: ThemeTokens;                       // see Theme tokens below
  persistedState: GridEditorState | null;   // restored from workspaceState; null = defaults
  connection: { mode: 'readonly' | 'write'; database: string; cluster: string };
}

interface ColumnDescriptor {
  name: string;
  pgType: string;                           // 'text', 'int4', 'jsonb', 'timestamptz', …
  jsType: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'enum' | 'unknown';
  nullable: boolean;
  hasDefault: boolean;
  isPk: boolean;
  enumValues?: ReadonlyArray<string>;       // populated for jsType='enum'
  fk?: {                                    // populated for FK columns
    refSchema: string;
    refTable: string;
    refColumn: string;
  };
}
```

### `page` (response to `loadPage`)

```ts
interface PagePayload {
  offset: number;
  rows: ReadonlyArray<ReadonlyArray<unknown>>;  // cell values, raw from pg
  totalRows: number | null;                      // updated when the count() finishes
  truncated: boolean;                            // true when the result set capped
}
```

### `applyPreview`

In response to `applyRequested`. The host hands back the assembled
parameterized UPDATE statements (one per dirty row) so the renderer
can render them in the modal preview. Statement order matches the
request's row order.

```ts
interface ApplyPreviewPayload {
  statements: ReadonlyArray<{
    rowKey: string;
    text: string;                            // 'UPDATE "s"."t" SET "x" = $1 WHERE "id" = $2'
    values: ReadonlyArray<unknown>;
  }>;
}
```

### `applyResult`

After `applyConfirmed`, the host runs the statements via the cell-edit
orchestrator and reports per-row outcomes. Sent one message per row so
the renderer can clear the dirty-mark on each as it succeeds (or mark
it as failed inline if the statement rejected).

```ts
interface ApplyResultPayload {
  rowKey: string;
  outcome:
    | { kind: 'applied'; rowsAffected: number }
    | { kind: 'rejected'; code: string; reason: string }    // gate rejection (READ_ONLY, NO_PK, …)
    | { kind: 'failed'; sqlstate?: string; reason: string }; // pg-side failure
}
```

### `themeChanged`

Sent when `workbench.colorTheme` changes. Renderer rebuilds glide-
data-grid's theme tokens without losing state.

```ts
interface ThemeChangedPayload { theme: ThemeTokens }
```

### `modeChanged`

Sent when the bound connection toggles read-only ↔ Write. The renderer
enables/disables edit affordances; dirty edits are preserved on a
write→readonly toggle but cannot be applied until the user toggles
back to Write.

```ts
interface ModeChangedPayload { mode: 'readonly' | 'write' }
```

### `disposed`

Sent when the panel is about to close (host received
`onDidDispose`). Renderer drops any background state.

---

## Grid → Host messages

### `ready`

Fire-and-forget. Renderer signals it has mounted; host responds with
`init`.

### `loadPage`

Renderer asks for a window of rows. Includes the current sort + filter
state so the host can include them in the SELECT (the host builds the
SELECT — the renderer never composes SQL).

```ts
interface LoadPagePayload {
  offset: number;
  limit: number;                              // typically 1000
  sort?: ReadonlyArray<{ column: string; dir: 'asc' | 'desc' }>;
  filters?: ReadonlyArray<{
    column: string;
    op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'like' | 'ilike' | 'is_null' | 'is_not_null';
    value?: string;
  }>;
}
```

### `applyRequested`

Renderer asks the host to commit the current dirty-edit set. The host
runs validation gates, builds parameterized statements, returns
`applyPreview`, awaits user confirmation in the renderer's modal, then
runs each statement and streams `applyResult` messages back.

```ts
interface ApplyRequestedPayload {
  dirtyRows: ReadonlyArray<{
    rowKey: string;                             // stable id assigned by the renderer
    pkValues: ReadonlyArray<unknown>;
    changes: Record<string, ColumnChange>;      // ColumnChange shape from update-builder.ts
  }>;
}
```

### `applyConfirmed` / `applyCancelled`

Renderer reports the user's decision on the modal preview.

### `deleteRequested`

Renderer asks the host to delete one or more selected rows. Same
preview-then-confirm flow as `applyRequested`, but routes through
`buildDelete()` instead of `buildUpdate()`. Includes the table's
fully-qualified name so the host can drive the typed-name confirm gate
that DROP / TRUNCATE already use.

```ts
interface DeleteRequestedPayload {
  rows: ReadonlyArray<{ rowKey: string; pkValues: ReadonlyArray<unknown> }>;
}
```

### `insertRequested`

Renderer asks the host to insert one new row. Same preview-then-
confirm flow; routes through a new `buildInsert()` helper.

```ts
interface InsertRequestedPayload {
  values: Record<string, ColumnChange>;        // unspecified columns left to DEFAULT
}
```

### `openReferencedRow`

Renderer asks the host to open a new Grid Editor tab for the FK
target. The host walks the column descriptor's `fk` field to resolve
the referenced table, then opens a new panel filtered to the target
value.

```ts
interface OpenReferencedRowPayload {
  fromColumn: string;
  value: unknown;
}
```

### `layoutChanged`

Renderer reports a change in the persistable layout primitives.
Throttled to one message per 500 ms during active resizes / scrolls.
Host persists to `context.workspaceState` keyed by `(context, ns,
cluster, db, schema, table)`.

```ts
interface LayoutChangedPayload {
  state: GridEditorState;                      // see data-model.md § Grid Editor State
}
```

### `exportRequested`

Renderer asks the host to export the current selection (or all rows
when nothing is selected) as CSV / JSON / INSERT statements. Host
writes to a user-chosen workspace path; SQL exports route through
`redact()` so credential literals never land on disk.

```ts
interface ExportRequestedPayload {
  format: 'csv' | 'json' | 'sql-insert';
  scope: 'selection' | 'allRows';
}
```

### `refreshRequested`

Renderer asks the host to re-run the underlying SELECT (e.g. user
clicked Refresh after an external change). The host issues a fresh
`loadPage` cycle keyed by the renderer's current sort / filter state.

---

## Theme tokens (both webviews)

```ts
type ThemeTokens = {
  // Mapped from VS Code's --vscode-* CSS variables, snapshot at init
  // and refreshed via *.themeChanged on workbench.colorTheme change.
  background: string;     // --vscode-editor-background
  foreground: string;     // --vscode-editor-foreground
  border: string;         // --vscode-panel-border
  accent: string;         // --vscode-focusBorder
  headerBg: string;       // --vscode-editorGroupHeader-tabsBackground
  headerFg: string;       // --vscode-foreground
  selectionBg: string;    // --vscode-editor-selectionBackground
  errorFg: string;        // --vscode-editorError-foreground
  warningFg: string;      // --vscode-editorWarning-foreground
  fontFamily: string;     // editor.fontFamily
  fontSize: number;       // editor.fontSize
};
```

Hard-coded hex values inside the webview bundle are forbidden and
fail the theme-contrast snapshot test (T103, revived).

---

## Security posture

- The webview HTML is loaded from `dist/webviews/grid/index.html` with
  a strict CSP set on the response: `default-src 'none'; style-src
  ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-…';
  img-src ${cspSource} data:; font-src ${cspSource};
  connect-src 'none'`. No external CDNs; the React + glide-data-grid
  bundle is built into `dist/webviews/grid/bundle.js` at extension
  build time.
- `Webview.localResourceRoots` is limited to the bundled
  `dist/webviews/grid/` directory.
- The nonce is per-panel-load (`crypto.randomUUID()`); the
  `<script nonce="…">` tag is the only way to load JS, and the
  `script-src` directive in the CSP locks it down.
- Every inbound message from the renderer is JSON-parsed by VS Code's
  bridge and then validated by the host: `type` is matched against the
  enumerated union; every payload field has its type and bounds
  checked; unknown types are logged at `warn` and dropped.
- Cell values handed back from the renderer (in `applyRequested` /
  `insertRequested`) are passed unchanged to `pg.Pool.query()` as
  PARAMETERIZED values — they NEVER concatenate into SQL text. SQL
  composition lives entirely in `src/sql/update-builder.ts` and the
  forthcoming `buildInsert()` helper.
- The exported `.sql` path routes every emitted statement through
  `redact()` from `src/pg/redact.ts` so credential literals in
  user-authored data can't survive to disk.
- The CSP audit script (`scripts/audit-webview-csp.mjs`, T130) checks
  `dist/webviews/**/*.html` on every build and fails on missing CSP,
  external `<script src>`, `unsafe-eval`, or wildcard `default-src *`.
  This was a no-op gate previously; with the Grid Editor it becomes
  load-bearing.

---

## Notebook renderer payload *(unchanged from T104)*

The lightweight inline view used by notebook cell outputs continues
to consume the same shape. The Grid Editor's `init` message reuses
the column descriptor + row shapes for consistency.

```ts
interface ResultGridPayload {
  command: string;
  columns: string[];
  rows: ReadonlyArray<ReadonlyArray<unknown>>;
  totalRows: number;
  truncated: boolean;
}
```

Producer: `src/notebook/output.ts`. Consumer:
`src/notebook/renderer/index.ts` + `build-table.ts`. No
`postMessage` channel — the notebook renderer is render-only by
design. To edit, the user opens the Grid Editor surface via the
schema-tree menu or the command palette.
