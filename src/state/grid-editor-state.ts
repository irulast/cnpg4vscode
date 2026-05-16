/**
 * Grid Editor State serializer (US6 Phase 8.5 — T147; FR-039).
 *
 * Persists Grid Editor LAYOUT primitives — column order, widths, sort,
 * filters, frozen-column count, scroll position — keyed by the
 * (context, namespace, cluster, database, schema, table) 6-tuple.
 *
 * **NEVER persists cell data.** Per FR-039 + Constitution §Security
 * the write path is gated by a defense-in-depth field allowlist
 * (same shape as the redaction-store guard in
 * `src/state/history-store.ts`). The serializer drops any field on
 * the input object that isn't in the enumerated layout-primitive
 * allowlist; the deserializer applies the same filter on read. So
 * even a corrupt persisted blob can't surface arbitrary fields back
 * into the runtime.
 *
 * Pure module — no `vscode`. The host writes the serialized string
 * via `context.workspaceState` (the same chokepoint as query
 * history; permitted by the eslint rule `no-state-write-outside-history`).
 */

import type { Memento } from "vscode";

/** Bumped when the on-disk schema changes incompatibly. */
export const CURRENT_VERSION = 1;

const STORAGE_KEY_PREFIX = "cnpg.grid.layout.";

/**
 * Persist Grid Editor layout primitives via VS Code's workspace
 * Memento. Centralised here so the eslint `no-state-write-outside-
 * history` chokepoint rule (which guards writes to `workspaceState`)
 * permits it — the defense-in-depth allowlist in `serialize()` is
 * the redaction-equivalent for layout state (FR-039 + Constitution
 * §Security: NEVER persists cell data).
 */
export async function saveGridState(
  memento: Memento,
  key: GridStateKey,
  state: GridEditorState,
): Promise<void> {
  const json = serialize({ ...state, lastOpenedAt: Date.now() });
  await memento.update(`${STORAGE_KEY_PREFIX}${gridStateKey(key)}`, json);
}

/**
 * Load a previously persisted Grid Editor layout. Returns null when
 * nothing is persisted or the persisted blob is corrupt (the host
 * falls back to `applyDefaults()` in that case).
 */
export function loadGridState(
  memento: Memento,
  key: GridStateKey,
): GridEditorState | null {
  const raw = memento.get<string>(`${STORAGE_KEY_PREFIX}${gridStateKey(key)}`);
  if (!raw) return null;
  return deserialize(raw);
}

/** The 6-tuple that uniquely identifies a Grid Editor target. */
export interface GridStateKey {
  readonly contextName: string;
  readonly namespace: string;
  readonly clusterName: string;
  readonly database: string;
  readonly schema: string;
  readonly table: string;
}

export type FilterOp =
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "like"
  | "ilike"
  | "is_null"
  | "is_not_null";

const ALLOWED_OPS: ReadonlySet<FilterOp> = new Set<FilterOp>([
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "like",
  "ilike",
  "is_null",
  "is_not_null",
]);

export interface GridSort {
  readonly column: string;
  readonly dir: "asc" | "desc";
}

export interface GridFilter {
  readonly column: string;
  readonly op: FilterOp;
  readonly value?: string;
}

/**
 * The persisted layout. Fields NOT in this interface are dropped by the
 * serializer's allowlist (FR-039). Adding a new field requires (a)
 * extending this interface, (b) extending the allowlist in
 * `serializeState()`, and (c) extending the test corpus.
 */
export interface GridEditorState {
  readonly columnOrder: ReadonlyArray<string>;
  readonly hiddenColumns: ReadonlyArray<string>;
  readonly columnWidths: Readonly<Record<string, number>>;
  readonly sort: ReadonlyArray<GridSort>;
  readonly filters: ReadonlyArray<GridFilter>;
  readonly frozenColumnCount: number;
  readonly scrollTop: number;
  readonly lastOpenedAt: number;
}

/**
 * Build the persistence key from the 6-tuple. Slashes inside any
 * component (legal in PG quoted identifiers) are escaped as `%2F` so
 * `("prod", "default", "app/db", …)` and `("prod/default", "app",
 * "db", …)` produce DIFFERENT keys — alias-free.
 */
export function gridStateKey(k: GridStateKey): string {
  return [
    k.contextName,
    k.namespace,
    k.clusterName,
    k.database,
    k.schema,
    k.table,
  ]
    .map(encodeComponent)
    .join("/");
}

function encodeComponent(s: string): string {
  // Encode `/` and `%` (any other reserved chars are legal in PG idents).
  return s.replace(/%/g, "%25").replace(/\//g, "%2F");
}

/**
 * Width sanity bounds. Below `MIN_WIDTH` a column would be unclickable;
 * above `MAX_WIDTH` it'd flood the viewport. Values outside these
 * bounds are dropped from the persisted state (the renderer will
 * recompute a default on load).
 */
const MIN_WIDTH = 20;
const MAX_WIDTH = 4000;

/**
 * Serialize a state object to a JSON string, dropping any field that
 * isn't in the layout-primitive allowlist (FR-039 defense-in-depth).
 * The output shape is `{v: 1, state: GridEditorState}` so future
 * schema migrations can detect legacy payloads.
 */
export function serialize(input: GridEditorState): string {
  const safe = sanitiseForPersist(input);
  return JSON.stringify({ v: CURRENT_VERSION, state: safe });
}

/**
 * Deserialize a persisted blob, applying the same allowlist on the
 * read path (so a corrupt blob can't surface arbitrary fields back
 * into runtime). Returns null on any failure — unparseable JSON,
 * missing version, version newer than CURRENT_VERSION.
 */
export function deserialize(raw: string): GridEditorState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as { v?: unknown; state?: unknown };
  if (typeof payload.v !== "number") return null;
  if (payload.v > CURRENT_VERSION) return null;
  if (!payload.state || typeof payload.state !== "object") return null;
  return sanitiseForPersist(payload.state as Partial<GridEditorState>);
}

function sanitiseForPersist(input: Partial<GridEditorState>): GridEditorState {
  const columnOrder = asStringArray(input.columnOrder);
  const hiddenColumns = asStringArray(input.hiddenColumns);
  const columnWidths = sanitiseWidths(input.columnWidths);
  const sort = sanitiseSort(input.sort);
  const filters = sanitiseFilters(input.filters);
  const frozenColumnCount = asNonNegativeInt(input.frozenColumnCount) ?? 0;
  const scrollTop = asNonNegativeInt(input.scrollTop) ?? 0;
  const lastOpenedAt = asNonNegativeInt(input.lastOpenedAt) ?? 0;
  return {
    columnOrder,
    hiddenColumns,
    columnWidths,
    sort,
    filters,
    frozenColumnCount,
    scrollTop,
    lastOpenedAt,
  };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function asNonNegativeInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

function sanitiseWidths(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    if (raw < MIN_WIDTH || raw > MAX_WIDTH) continue;
    out[k] = Math.floor(raw);
  }
  return out;
}

function sanitiseSort(v: unknown): GridSort[] {
  if (!Array.isArray(v)) return [];
  const out: GridSort[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { column?: unknown; dir?: unknown };
    if (typeof r.column !== "string") continue;
    if (r.dir !== "asc" && r.dir !== "desc") continue;
    out.push({ column: r.column, dir: r.dir });
  }
  return out;
}

function sanitiseFilters(v: unknown): GridFilter[] {
  if (!Array.isArray(v)) return [];
  const out: GridFilter[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { column?: unknown; op?: unknown; value?: unknown };
    if (typeof r.column !== "string") continue;
    if (typeof r.op !== "string" || !ALLOWED_OPS.has(r.op as FilterOp)) continue;
    const filter: GridFilter =
      r.value === undefined
        ? { column: r.column, op: r.op as FilterOp }
        : typeof r.value === "string"
          ? { column: r.column, op: r.op as FilterOp, value: r.value }
          : { column: r.column, op: r.op as FilterOp };
    out.push(filter);
  }
  return out;
}

// ---------------------------------------------------------------------------
// applyDefaults
// ---------------------------------------------------------------------------

export interface ColumnDescriptorLike {
  readonly columns: ReadonlyArray<{ readonly name: string }>;
}

/**
 * Build a sensible default state from a column descriptor. Used when
 * the user opens a Grid Editor on a table with no persisted state yet.
 */
export function applyDefaults(descriptor: ColumnDescriptorLike): GridEditorState {
  return {
    columnOrder: descriptor.columns.map((c) => c.name),
    hiddenColumns: [],
    columnWidths: {},
    sort: [],
    filters: [],
    frozenColumnCount: 0,
    scrollTop: 0,
    lastOpenedAt: 0,
  };
}
