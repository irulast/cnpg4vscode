/**
 * ResultSetDescriptor fetcher for the Grid Editor (US6 Phase 8.5,
 * supports T150's host controller).
 *
 * Composes existing pg_catalog queries into the
 * `ResultSetDescriptor` shape the protocol's `init` message carries
 * (see `src/webviews/grid/protocol.ts`).
 *
 * Pure module — accepts a tiny `DescriptorQueryClient` interface so
 * tests can inject a mock; the host wraps `DatabaseConnection.query`
 * to satisfy it.
 *
 * Three queries per table:
 *   1. `pg_class.relkind` to determine `table | view | matview`
 *      (drives the `editable` flag).
 *   2. `pg_attribute` join to get column names / pg types / nullable /
 *      hasDefault / isPk (the last via a sub-correlated EXISTS on
 *      `pg_index` where `indisprimary`).
 *   3. `pg_enum` for any column whose pg_type is an enum (one batch
 *      query rather than N round-trips).
 *   4. `pg_constraint` where `contype = 'f'` to discover single-column
 *      FKs that should get the right-click "Go to referenced row"
 *      affordance.
 */

import {
  type ColumnDescriptor,
  type ResultSetDescriptor,
} from "../webviews/grid/protocol.js";
import { pgTypeToJsType } from "./cell-editors.js";

/** Minimal query client surface. Satisfied by `DatabaseConnection.query`. */
export interface DescriptorQueryClient {
  query(sql: string, values?: ReadonlyArray<unknown>): Promise<{
    rows: ReadonlyArray<Record<string, unknown>>;
  }>;
}

export interface FetchDescriptorOpts {
  readonly schema: string;
  readonly table: string;
}

const RELKIND_TO_TARGET: Record<string, "table" | "view" | "matview" | null> = {
  r: "table",
  p: "table", // partitioned table — editable in the same way as a regular table
  v: "view",
  m: "matview",
};

export async function fetchResultSetDescriptor(
  client: DescriptorQueryClient,
  opts: FetchDescriptorOpts,
): Promise<ResultSetDescriptor> {
  // The fully-qualified, properly-quoted regclass argument for the
  // three subsequent introspection queries. NOTE: we DON'T concat
  // this into SQL — it's passed as a bound `$1` parameter (security).
  const regclassArg = `"${opts.schema.replace(/"/g, '""')}"."${opts.table.replace(/"/g, '""')}"`;

  // (1) relkind — table / view / matview.
  const relkindRes = await client.query(
    `SELECT c.relkind::text AS relkind
       FROM pg_class c
      WHERE c.oid = $1::regclass`,
    [regclassArg],
  );
  if (relkindRes.rows.length === 0) {
    throw new Error(
      `Relation ${opts.schema}.${opts.table} not found (or not visible to the current connection).`,
    );
  }
  const relkindRaw = String(relkindRes.rows[0]!["relkind"] ?? "");
  const kind = RELKIND_TO_TARGET[relkindRaw];
  if (!kind) {
    throw new Error(
      `Unsupported relkind ${relkindRaw} for ${opts.schema}.${opts.table} — only tables and views can open in the Grid Editor.`,
    );
  }

  // (2) columns.
  const colsRes = await client.query(
    `
    SELECT a.attname::text AS name,
           format_type(a.atttypid, a.atttypmod) AS pgtype,
           a.attnotnull AS notnull,
           (d.adbin IS NOT NULL) AS hasdefault,
           EXISTS (
             SELECT 1
               FROM pg_index i
              WHERE i.indrelid = a.attrelid
                AND i.indisprimary
                AND a.attnum = ANY (i.indkey)
           ) AS ispk
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = $1::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum
    `,
    [regclassArg],
  );

  // (3) pg_enum values for every enum-typed column referenced by this
  // table. One batch query — joins pg_attribute → pg_type (typtype='e')
  // → pg_enum to get the labels in the correct order.
  const enumsRes = await client.query(
    `
    SELECT t.typname::text AS enumtypname,
           e.enumlabel::text AS enumlabel
      FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE a.attrelid = $1::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND t.typtype = 'e'
     ORDER BY e.enumsortorder
    `,
    [regclassArg],
  );
  const enumValuesByTypeName = new Map<string, string[]>();
  for (const row of enumsRes.rows) {
    const tname = String(row["enumtypname"] ?? "");
    const label = String(row["enumlabel"] ?? "");
    if (!tname) continue;
    const arr = enumValuesByTypeName.get(tname) ?? [];
    arr.push(label);
    enumValuesByTypeName.set(tname, arr);
  }

  // (4) single-column FKs from this table → other tables.
  const fkRes = await client.query(
    `
    SELECT (
             SELECT array_agg(a.attname::text ORDER BY ord)
               FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           ) AS fromcolumns,
           (
             SELECT array_agg(a.attname::text ORDER BY ord)
               FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
           ) AS refcolumns,
           ns.nspname::text AS refschema,
           refrel.relname::text AS reftable
      FROM pg_constraint c
      JOIN pg_class refrel ON refrel.oid = c.confrelid
      JOIN pg_namespace ns ON ns.oid = refrel.relnamespace
     WHERE c.conrelid = $1::regclass
       AND c.contype = 'f'
    `,
    [regclassArg],
  );

  const fkByColumn = new Map<
    string,
    { refSchema: string; refTable: string; refColumn: string }
  >();
  for (const row of fkRes.rows) {
    const fromColumns = toStringArray(row["fromcolumns"]);
    const refColumns = toStringArray(row["refcolumns"]);
    // Skip composite FKs — they need a different UX (multi-value drill-in)
    // that's not in scope for v1.
    if (fromColumns.length !== 1 || refColumns.length !== 1) continue;
    const refSchema = String(row["refschema"] ?? "");
    const refTable = String(row["reftable"] ?? "");
    if (!refSchema || !refTable) continue;
    fkByColumn.set(fromColumns[0]!, {
      refSchema,
      refTable,
      refColumn: refColumns[0]!,
    });
  }

  // Assemble columns.
  const columns: ColumnDescriptor[] = [];
  for (const r of colsRes.rows) {
    const name = String(r["name"] ?? "");
    if (!name) continue;
    const pgType = String(r["pgtype"] ?? "");
    const enumValues = enumValuesByTypeName.get(pgType);
    // If the column's pg_type is an enum, override jsType to "enum" so
    // the cell-editor registry picks a dropdown. Otherwise fall back to
    // the standard map.
    const baseJsType = pgTypeToJsType(pgType);
    const jsType = enumValues && enumValues.length > 0 ? "enum" : baseJsType;
    const nullable = !(r["notnull"] === true);
    const hasDefault = r["hasdefault"] === true;
    const isPk = r["ispk"] === true;
    const fk = fkByColumn.get(name);
    columns.push({
      name,
      pgType,
      jsType,
      nullable,
      hasDefault,
      isPk,
      ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
      ...(fk ? { fk } : {}),
    });
  }

  const pkColumns = columns.filter((c) => c.isPk).map((c) => c.name);
  // Editable iff (a) it's a real table (views/matviews are read-only via the grid)
  // AND (b) there's a primary key to key UPDATEs on.
  const editable = kind === "table" && pkColumns.length > 0;

  return {
    columns,
    pkColumns,
    totalRowsEstimate: null,
    target: { schema: opts.schema, table: opts.table, kind },
    editable,
  };
}

/** Defensive coercion of pg's array result to a JS string[]. */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    // PG `text[]` literal — `{a,b,"with,comma"}`. Same parser as in result-descriptor.
    const trimmed = v.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
    const inner = trimmed.slice(1, -1);
    if (inner === "") return [];
    const out: string[] = [];
    let buf = "";
    let inQuote = false;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (inQuote) {
        if (c === "\\" && i + 1 < inner.length) {
          buf += inner[i + 1];
          i++;
          continue;
        }
        if (c === '"') {
          inQuote = false;
          continue;
        }
        buf += c;
        continue;
      }
      if (c === '"') {
        inQuote = true;
        continue;
      }
      if (c === ",") {
        out.push(buf);
        buf = "";
        continue;
      }
      buf += c;
    }
    if (buf !== "") out.push(buf);
    return out;
  }
  return [];
}
