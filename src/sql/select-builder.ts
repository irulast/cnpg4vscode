/**
 * Pure SELECT-builder driver for the Grid Editor host's page loads
 * (US6 Phase 8.5 — T148; supports FR-037/FR-038).
 *
 * No `pg`, no `vscode`. Given a structured request (schema/table +
 * optional sort + optional filters + limit + offset), emits a
 * parameterised SELECT plus a parallel `count(*)` for the totalRows
 * footer.
 *
 * **Critical security invariant**: filter values bind as `$N`, NEVER
 * concatenate into SQL text. Filter `op` is matched against a frozen
 * enum — anything else is silently dropped (defense in depth on top
 * of the persisted-state allowlist in
 * `src/state/grid-editor-state.ts`). Column identifiers are always
 * quoted via `quoteIdent()` so embedded `"` cannot escape.
 *
 * LIMIT/OFFSET are emitted as literal integers (not parameterised —
 * they're not user input; they're computed by the host from the
 * grid's visible window). They're clamped to sane bounds to prevent
 * runaway page sizes.
 */

import { quoteIdent, qualifyIdent } from "../pg/introspect.js";
import type { BuiltStatement } from "./update-builder.js";
import type { FilterOp, GridFilter, GridSort } from "../state/grid-editor-state.js";

/** Page-size hard cap. Above this the grid window would be unrenderable. */
const MAX_LIMIT = 10_000;
/** Page-size floor — a request for 0 makes no sense; coerce up. */
const MIN_LIMIT = 1;
const DEFAULT_LIMIT = 1000;

export interface SelectPageRequest {
  readonly schema: string;
  readonly table: string;
  /** Column list to project. Omit for `SELECT *`. */
  readonly columns?: ReadonlyArray<string>;
  readonly sort?: ReadonlyArray<GridSort>;
  readonly filters?: ReadonlyArray<GridFilter>;
  readonly limit: number;
  readonly offset: number;
}

export interface SelectCountRequest {
  readonly schema: string;
  readonly table: string;
  readonly filters?: ReadonlyArray<GridFilter>;
}

const SQL_OP: Readonly<Record<FilterOp, string>> = {
  eq: "=",
  ne: "!=",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
  like: "LIKE",
  ilike: "ILIKE",
  is_null: "IS NULL",
  is_not_null: "IS NOT NULL",
};

export function buildSelectPage(req: SelectPageRequest): BuiltStatement {
  const target = qualifyIdent(req.schema, req.table);
  const projection =
    req.columns && req.columns.length > 0
      ? req.columns.map((c) => quoteIdent(c)).join(", ")
      : "*";
  const values: unknown[] = [];
  const whereClause = buildWhere(req.filters, values, 1);
  const orderClause = buildOrderBy(req.sort);
  const limit = clamp(req.limit, MIN_LIMIT, MAX_LIMIT, DEFAULT_LIMIT);
  const offset = Math.max(0, Math.floor(req.offset));

  const parts = [`SELECT ${projection} FROM ${target}`];
  if (whereClause) parts.push(whereClause);
  if (orderClause) parts.push(orderClause);
  parts.push(`LIMIT ${limit}`);
  parts.push(`OFFSET ${offset}`);
  return { text: parts.join(" "), values };
}

export function buildSelectCount(req: SelectCountRequest): BuiltStatement {
  const target = qualifyIdent(req.schema, req.table);
  const values: unknown[] = [];
  const whereClause = buildWhere(req.filters, values, 1);
  const parts = [`SELECT count(*) AS total FROM ${target}`];
  if (whereClause) parts.push(whereClause);
  return { text: parts.join(" "), values };
}

function buildWhere(
  filters: ReadonlyArray<GridFilter> | undefined,
  values: unknown[],
  startParam: number,
): string | null {
  if (!filters || filters.length === 0) return null;
  let nextParam = startParam;
  const predicates: string[] = [];
  for (const f of filters) {
    // Defense-in-depth: the persisted-state serializer already drops
    // unknown ops, but check again here so the builder is safe even
    // when called from non-persisted code paths.
    const sqlOp = SQL_OP[f.op];
    if (!sqlOp) continue;
    const col = quoteIdent(f.column);
    if (f.op === "is_null" || f.op === "is_not_null") {
      predicates.push(`${col} ${sqlOp}`);
      continue;
    }
    // All other ops bind a single parameter. Skip the filter when the
    // value is missing (the renderer shouldn't send these but the
    // builder defends anyway).
    if (f.value === undefined) continue;
    values.push(f.value);
    predicates.push(`${col} ${sqlOp} $${nextParam}`);
    nextParam++;
  }
  if (predicates.length === 0) return null;
  return `WHERE ${predicates.join(" AND ")}`;
}

function buildOrderBy(sort: ReadonlyArray<GridSort> | undefined): string | null {
  if (!sort || sort.length === 0) return null;
  const parts: string[] = [];
  for (const s of sort) {
    const dir = s.dir === "desc" ? "DESC" : "ASC";
    parts.push(`${quoteIdent(s.column)} ${dir}`);
  }
  if (parts.length === 0) return null;
  return `ORDER BY ${parts.join(", ")}`;
}

function clamp(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}
