/**
 * Host ↔ Grid Editor message protocol (US6 Phase 8.5 — T138).
 *
 * Pure module — no `vscode`, no `pg`, no DOM. Both sides import from
 * here so the wire shape stays in lockstep. The host imports the
 * builders + validator from its `src/grid/host.ts` (T150); the
 * renderer imports the same types from its `src/webviews/grid/` code
 * (T153).
 *
 * Three roles for this module:
 *
 *   1. **Type tag enums** (`HOST_TO_GRID`, `GRID_TO_HOST`) — single
 *      source of truth for the message-type strings, exported so tests
 *      can assert completeness against `contracts/webview-protocol.md`.
 *
 *   2. **Builders** — host-side message constructors that return the
 *      wire-shape `{type, id?, payload?}` envelope. Builders don't
 *      validate input; the host is trusted.
 *
 *   3. **Validator** — `validateInbound(unknown)` checks an inbound
 *      grid→host message against the protocol contract and either
 *      narrows the type or returns `{ok: false, code, reason}`. The
 *      renderer is UNTRUSTED, so every inbound goes through here
 *      before reaching the orchestrator.
 *
 * Defense-in-depth: filter ops + export format/scope + every numeric
 * bound are checked against frozen enums. Unknown values are dropped
 * at the protocol boundary, so the SELECT builder (T148) and bulk-
 * apply (T151) never see garbage.
 */

import type { GridEditorState } from "../../state/grid-editor-state.js";

// ---------------------------------------------------------------------------
// Type tags
// ---------------------------------------------------------------------------

export const HOST_TO_GRID = {
  init: "init",
  page: "page",
  applyPreview: "applyPreview",
  applyResult: "applyResult",
  themeChanged: "themeChanged",
  modeChanged: "modeChanged",
  disposed: "disposed",
} as const;
export type HostToGridType = (typeof HOST_TO_GRID)[keyof typeof HOST_TO_GRID];

export const GRID_TO_HOST = {
  ready: "ready",
  loadPage: "loadPage",
  applyRequested: "applyRequested",
  applyConfirmed: "applyConfirmed",
  applyCancelled: "applyCancelled",
  deleteRequested: "deleteRequested",
  insertRequested: "insertRequested",
  openReferencedRow: "openReferencedRow",
  layoutChanged: "layoutChanged",
  exportRequested: "exportRequested",
  refreshRequested: "refreshRequested",
} as const;
export type GridToHostType = (typeof GRID_TO_HOST)[keyof typeof GRID_TO_HOST];

// ---------------------------------------------------------------------------
// Shared envelope
// ---------------------------------------------------------------------------

interface Envelope<TType extends string, TPayload = undefined> {
  readonly type: TType;
  readonly id?: string;
  readonly payload: TPayload;
}

interface BareEnvelope<TType extends string> {
  readonly type: TType;
  readonly id?: string;
}

// ---------------------------------------------------------------------------
// Host → grid payload types
// ---------------------------------------------------------------------------

export interface ColumnDescriptor {
  readonly name: string;
  readonly pgType: string;
  readonly jsType: "string" | "number" | "boolean" | "date" | "json" | "enum" | "unknown";
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly isPk: boolean;
  readonly enumValues?: ReadonlyArray<string>;
  readonly fk?: {
    readonly refSchema: string;
    readonly refTable: string;
    readonly refColumn: string;
  };
}

export interface ResultSetDescriptor {
  readonly columns: ReadonlyArray<ColumnDescriptor>;
  readonly pkColumns: ReadonlyArray<string>;
  readonly totalRowsEstimate: number | null;
  readonly target: { readonly schema: string; readonly table: string; readonly kind: "table" | "view" | "matview" };
  readonly editable: boolean;
}

export interface ThemeTokens {
  readonly background: string;
  readonly foreground: string;
  readonly border: string;
  readonly accent: string;
  readonly headerBg: string;
  readonly headerFg: string;
  readonly selectionBg: string;
  readonly errorFg: string;
  readonly warningFg: string;
  readonly fontFamily: string;
  readonly fontSize: number;
}

export interface ConnectionInfo {
  readonly mode: "readonly" | "write";
  readonly database: string;
  readonly cluster: string;
}

export interface InitPayload {
  readonly descriptor: ResultSetDescriptor;
  readonly theme: ThemeTokens;
  readonly persistedState: GridEditorState | null;
  readonly connection: ConnectionInfo;
}

export interface PagePayload {
  readonly offset: number;
  readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly totalRows: number | null;
  readonly truncated: boolean;
}

export interface ApplyPreviewPayload {
  readonly statements: ReadonlyArray<{
    readonly rowKey: string;
    readonly text: string;
    readonly values: ReadonlyArray<unknown>;
  }>;
}

export type ApplyResultOutcome =
  | { readonly kind: "applied"; readonly rowsAffected: number }
  | { readonly kind: "rejected"; readonly code: string; readonly reason: string }
  | { readonly kind: "failed"; readonly sqlstate?: string; readonly reason: string };

export interface ApplyResultPayload {
  readonly rowKey: string;
  readonly outcome: ApplyResultOutcome;
}

export interface ThemeChangedPayload {
  readonly theme: ThemeTokens;
}

export interface ModeChangedPayload {
  readonly mode: "readonly" | "write";
}

// ---------------------------------------------------------------------------
// Host → grid builders
// ---------------------------------------------------------------------------

export function buildInit(payload: InitPayload): Envelope<"init", InitPayload> {
  return { type: HOST_TO_GRID.init, payload };
}

export function buildPage(payload: PagePayload): Envelope<"page", PagePayload> {
  return { type: HOST_TO_GRID.page, payload };
}

export function buildApplyPreview(payload: ApplyPreviewPayload): Envelope<"applyPreview", ApplyPreviewPayload> {
  return { type: HOST_TO_GRID.applyPreview, payload };
}

export function buildApplyResult(payload: ApplyResultPayload): Envelope<"applyResult", ApplyResultPayload> {
  return { type: HOST_TO_GRID.applyResult, payload };
}

export function buildThemeChanged(
  payload: ThemeChangedPayload,
): Envelope<"themeChanged", ThemeChangedPayload> {
  return { type: HOST_TO_GRID.themeChanged, payload };
}

export function buildModeChanged(
  payload: ModeChangedPayload,
): Envelope<"modeChanged", ModeChangedPayload> {
  return { type: HOST_TO_GRID.modeChanged, payload };
}

export function buildDisposed(): BareEnvelope<"disposed"> {
  return { type: HOST_TO_GRID.disposed };
}

// ---------------------------------------------------------------------------
// Grid → host payload types
// ---------------------------------------------------------------------------

type FilterOp =
  | "eq" | "ne" | "lt" | "le" | "gt" | "ge"
  | "like" | "ilike" | "is_null" | "is_not_null";

const ALLOWED_FILTER_OPS: ReadonlySet<string> = new Set<FilterOp>([
  "eq", "ne", "lt", "le", "gt", "ge",
  "like", "ilike", "is_null", "is_not_null",
]);

const ALLOWED_EXPORT_FORMATS: ReadonlySet<string> = new Set(["csv", "json", "sql-insert"]);
const ALLOWED_EXPORT_SCOPES: ReadonlySet<string> = new Set(["selection", "allRows"]);

export interface LoadPagePayload {
  readonly offset: number;
  readonly limit: number;
  readonly sort?: ReadonlyArray<{ readonly column: string; readonly dir: "asc" | "desc" }>;
  readonly filters?: ReadonlyArray<{ readonly column: string; readonly op: FilterOp; readonly value?: string }>;
}

export interface DirtyRow {
  readonly rowKey: string;
  readonly pkValues: ReadonlyArray<unknown>;
  readonly changes: Readonly<Record<string, unknown>>;
}

export interface ApplyRequestedPayload {
  readonly dirtyRows: ReadonlyArray<DirtyRow>;
}

export interface DeleteRequestedPayload {
  readonly rows: ReadonlyArray<{
    readonly rowKey: string;
    readonly pkValues: ReadonlyArray<unknown>;
  }>;
}

export interface InsertRequestedPayload {
  readonly values: Readonly<Record<string, unknown>>;
}

export interface OpenReferencedRowPayload {
  readonly fromColumn: string;
  readonly value: unknown;
}

export interface LayoutChangedPayload {
  readonly state: GridEditorState;
}

export interface ExportRequestedPayload {
  readonly format: "csv" | "json" | "sql-insert";
  readonly scope: "selection" | "allRows";
}

// ---------------------------------------------------------------------------
// Validator — narrows inbound messages or returns a rejection.
// ---------------------------------------------------------------------------

export type InboundMessage =
  | BareEnvelope<"ready">
  | Envelope<"loadPage", LoadPagePayload>
  | Envelope<"applyRequested", ApplyRequestedPayload>
  | BareEnvelope<"applyConfirmed">
  | BareEnvelope<"applyCancelled">
  | Envelope<"deleteRequested", DeleteRequestedPayload>
  | Envelope<"insertRequested", InsertRequestedPayload>
  | Envelope<"openReferencedRow", OpenReferencedRowPayload>
  | Envelope<"layoutChanged", LayoutChangedPayload>
  | Envelope<"exportRequested", ExportRequestedPayload>
  | BareEnvelope<"refreshRequested">;

export type ValidationResult =
  | { readonly ok: true; readonly message: InboundMessage }
  | { readonly ok: false; readonly code: "BAD_INPUT" | "UNKNOWN_TYPE" | "BAD_PAYLOAD"; readonly reason: string };

export function validateInbound(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return reject("BAD_INPUT", "Inbound message is not an object.");
  }
  const env = raw as { type?: unknown; id?: unknown; payload?: unknown };
  const type = env.type;
  if (typeof type !== "string") return reject("BAD_INPUT", "Inbound message has no string `type` field.");
  const id = typeof env.id === "string" ? env.id : undefined;

  switch (type) {
    case "ready":
    case "applyConfirmed":
    case "applyCancelled":
    case "refreshRequested":
      return ok(id !== undefined ? { type, id } : { type });

    case "loadPage": {
      const p = env.payload;
      if (!isObj(p)) return reject("BAD_PAYLOAD", "loadPage payload missing.");
      const offset = (p as { offset?: unknown }).offset;
      const limit = (p as { limit?: unknown }).limit;
      if (!isNonNegInt(offset)) return reject("BAD_PAYLOAD", "loadPage.offset must be a non-negative integer.");
      if (!isPosInt(limit)) return reject("BAD_PAYLOAD", "loadPage.limit must be a positive integer.");
      const sortRaw = (p as { sort?: unknown }).sort;
      const filtersRaw = (p as { filters?: unknown }).filters;
      const sort = validateSort(sortRaw);
      if (sortRaw !== undefined && sort === null) return reject("BAD_PAYLOAD", "loadPage.sort malformed.");
      const filters = validateFilters(filtersRaw);
      if (filtersRaw !== undefined && filters === null) return reject("BAD_PAYLOAD", "loadPage.filters malformed.");
      const payload: LoadPagePayload = {
        offset,
        limit,
        ...(sort !== null ? { sort } : {}),
        ...(filters !== null ? { filters } : {}),
      };
      return ok(id !== undefined ? { type, id, payload } : { type, payload });
    }

    case "applyRequested": {
      const p = env.payload;
      if (!isObj(p)) return reject("BAD_PAYLOAD", "applyRequested payload missing.");
      const dirtyRowsRaw = (p as { dirtyRows?: unknown }).dirtyRows;
      if (!Array.isArray(dirtyRowsRaw) || dirtyRowsRaw.length === 0) {
        return reject("BAD_PAYLOAD", "applyRequested.dirtyRows must be a non-empty array.");
      }
      const dirtyRows: DirtyRow[] = [];
      for (const r of dirtyRowsRaw) {
        if (!isObj(r)) return reject("BAD_PAYLOAD", "applyRequested.dirtyRows[] entries must be objects.");
        const rr = r as { rowKey?: unknown; pkValues?: unknown; changes?: unknown };
        if (typeof rr.rowKey !== "string") return reject("BAD_PAYLOAD", "applyRequested row missing rowKey.");
        if (!Array.isArray(rr.pkValues)) return reject("BAD_PAYLOAD", "applyRequested row missing pkValues.");
        if (!isObj(rr.changes)) return reject("BAD_PAYLOAD", "applyRequested row missing changes.");
        dirtyRows.push({
          rowKey: rr.rowKey,
          pkValues: rr.pkValues as ReadonlyArray<unknown>,
          changes: rr.changes as Readonly<Record<string, unknown>>,
        });
      }
      const payload: ApplyRequestedPayload = { dirtyRows };
      return ok(id !== undefined ? { type, id, payload } : { type, payload });
    }

    case "deleteRequested": {
      const p = env.payload;
      if (!isObj(p)) return reject("BAD_PAYLOAD", "deleteRequested payload missing.");
      const rowsRaw = (p as { rows?: unknown }).rows;
      if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
        return reject("BAD_PAYLOAD", "deleteRequested.rows must be a non-empty array.");
      }
      const rows: { rowKey: string; pkValues: ReadonlyArray<unknown> }[] = [];
      for (const r of rowsRaw) {
        if (!isObj(r)) return reject("BAD_PAYLOAD", "deleteRequested.rows[] entries must be objects.");
        const rr = r as { rowKey?: unknown; pkValues?: unknown };
        if (typeof rr.rowKey !== "string") return reject("BAD_PAYLOAD", "deleteRequested row missing rowKey.");
        if (!Array.isArray(rr.pkValues)) return reject("BAD_PAYLOAD", "deleteRequested row missing pkValues.");
        rows.push({ rowKey: rr.rowKey, pkValues: rr.pkValues as ReadonlyArray<unknown> });
      }
      const payload: DeleteRequestedPayload = { rows };
      return ok(id !== undefined ? { type, id, payload } : { type, payload });
    }

    case "insertRequested": {
      const p = env.payload;
      if (!isObj(p)) return reject("BAD_PAYLOAD", "insertRequested payload missing.");
      const valuesRaw = (p as { values?: unknown }).values;
      if (!isObj(valuesRaw)) return reject("BAD_PAYLOAD", "insertRequested.values must be an object.");
      const payload: InsertRequestedPayload = { values: valuesRaw as Readonly<Record<string, unknown>> };
      return ok(id !== undefined ? { type, id, payload } : { type, payload });
    }

    case "openReferencedRow": {
      const p = env.payload;
      if (!isObj(p)) return reject("BAD_PAYLOAD", "openReferencedRow payload missing.");
      const fromColumn = (p as { fromColumn?: unknown }).fromColumn;
      if (typeof fromColumn !== "string") return reject("BAD_PAYLOAD", "openReferencedRow.fromColumn must be a string.");
      const value = (p as { value?: unknown }).value;
      const payload: OpenReferencedRowPayload = { fromColumn, value };
      return ok(id !== undefined ? { type, id, payload } : { type, payload });
    }

    case "layoutChanged": {
      const p = env.payload;
      if (!isObj(p)) return reject("BAD_PAYLOAD", "layoutChanged payload missing.");
      const state = (p as { state?: unknown }).state;
      if (!isObj(state)) return reject("BAD_PAYLOAD", "layoutChanged.state missing.");
      // The state object is round-tripped opaquely here — the host
      // runs it through `deserialize()` from grid-editor-state.ts on
      // arrival, which is where the defense-in-depth allowlist lives.
      // Treating it as `GridEditorState` here is the contract; the
      // double cast is just to silence TS's overlap check.
      const payload: LayoutChangedPayload = { state: state as unknown as GridEditorState };
      return ok(id !== undefined ? { type, id, payload } : { type, payload });
    }

    case "exportRequested": {
      const p = env.payload;
      if (!isObj(p)) return reject("BAD_PAYLOAD", "exportRequested payload missing.");
      const format = (p as { format?: unknown }).format;
      const scope = (p as { scope?: unknown }).scope;
      if (typeof format !== "string" || !ALLOWED_EXPORT_FORMATS.has(format)) {
        return reject("BAD_PAYLOAD", "exportRequested.format must be csv | json | sql-insert.");
      }
      if (typeof scope !== "string" || !ALLOWED_EXPORT_SCOPES.has(scope)) {
        return reject("BAD_PAYLOAD", "exportRequested.scope must be selection | allRows.");
      }
      const payload: ExportRequestedPayload = {
        format: format as ExportRequestedPayload["format"],
        scope: scope as ExportRequestedPayload["scope"],
      };
      return ok(id !== undefined ? { type, id, payload } : { type, payload });
    }

    default:
      return { ok: false, code: "UNKNOWN_TYPE", reason: `Unknown inbound message type: ${type}` };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ok(message: InboundMessage): ValidationResult {
  return { ok: true, message };
}

function reject(code: "BAD_INPUT" | "BAD_PAYLOAD", reason: string): ValidationResult {
  return { ok: false, code, reason };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && Math.floor(v) === v;
}

function validateSort(
  v: unknown,
): ReadonlyArray<{ column: string; dir: "asc" | "desc" }> | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return null;
  const out: { column: string; dir: "asc" | "desc" }[] = [];
  for (const item of v) {
    if (!isObj(item)) return null;
    const col = (item as { column?: unknown }).column;
    const dir = (item as { dir?: unknown }).dir;
    if (typeof col !== "string") return null;
    if (dir !== "asc" && dir !== "desc") return null;
    out.push({ column: col, dir });
  }
  return out;
}

function validateFilters(
  v: unknown,
): ReadonlyArray<{ column: string; op: FilterOp; value?: string }> | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return null;
  const out: { column: string; op: FilterOp; value?: string }[] = [];
  for (const item of v) {
    if (!isObj(item)) return null;
    const col = (item as { column?: unknown }).column;
    const op = (item as { op?: unknown }).op;
    if (typeof col !== "string") return null;
    if (typeof op !== "string" || !ALLOWED_FILTER_OPS.has(op)) return null;
    const value = (item as { value?: unknown }).value;
    const entry: { column: string; op: FilterOp; value?: string } = { column: col, op: op as FilterOp };
    if (typeof value === "string") entry.value = value;
    out.push(entry);
  }
  return out;
}
