/**
 * Grid Editor row export (US6 Phase 8.5 — T157).
 *
 * Pure module — three serializers (`toCsv`, `toJson`, `toInserts`) that
 * take the loaded page rows + column metadata and produce a string
 * blob the host writes via `vscode.workspace.fs.writeFile`. No DOM,
 * no `vscode`, no `pg` — fully unit-testable.
 *
 * Format details:
 *
 *   - CSV is RFC 4180: CRLF line endings, double-quoted fields,
 *     embedded `"` doubled. The header row carries column names.
 *     `null` becomes the empty field (NOT the literal string "null"),
 *     matching `pg_dump`'s COPY default and DBeaver's CSV export.
 *
 *   - JSON is a top-level array of `{column: value}` objects, indented
 *     two spaces. `null` is JSON null. `Date` is ISO 8601.
 *
 *   - INSERT emits one `INSERT INTO "schema"."table" (...) VALUES (...);`
 *     statement per row with literals inlined (NOT parameterised) so the
 *     output is a runnable script. Every string cell value passes
 *     through `redact()` BEFORE the single-quote-doubling SQL escape —
 *     defense in depth against an exported row carrying a credential
 *     literal in a text column (e.g. a migration row capturing a
 *     `CREATE ROLE ... PASSWORD '...'` audit entry). The redact step
 *     must run on the raw string, not the SQL-escaped form: after
 *     escaping, the wrapping `'…'` quotes are doubled, which breaks
 *     the redact rules' `'[^']*'` patterns mid-payload and leaves the
 *     secret exposed in the gap.
 *
 * Why inlined literals instead of `$1, $2, ...`: an exported `.sql` is
 * meant to be runnable in `psql`, DataGrip, pgAdmin, etc. — none of
 * which carry the binding sidecar a parameterised form would need.
 * Mirrors `pg_dump --inserts` and the DBeaver "Export INSERT" format.
 *
 * Safety: identifiers come from `quoteIdent()` / `qualifyIdent()`
 * (same as every other SQL builder in this codebase), so an attacker-
 * controlled schema / table / column name with embedded `"` cannot
 * smuggle SQL through the identifier slot. Cell values are quoted as
 * literals — a payload containing `'); DROP TABLE users;--` round-trips
 * as `'''); DROP TABLE users;--'` (an inert string literal).
 */

import { redact } from "../pg/redact.js";
import { quoteIdent, qualifyIdent } from "../pg/introspect.js";

export interface ExportColumn {
  readonly name: string;
  /** Optional PG type — currently unused by the serializers, accepted
   *  for future per-type literal formatting (e.g. `jsonb` → `'...'::jsonb`). */
  readonly pgType?: string;
}

const CSV_SEP = ",";
const CSV_EOL = "\r\n"; // RFC 4180

/**
 * Render `rows` as RFC 4180 CSV. The first row is the header (column
 * names); subsequent rows are the cell values. The output is terminated
 * with a trailing CRLF so concatenating two CSV blobs round-trips.
 */
export function toCsv(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  columns: ReadonlyArray<ExportColumn>,
): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => csvField(c.name)).join(CSV_SEP));
  for (const row of rows) {
    const fields: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      fields.push(csvField(formatCsvValue(row[i])));
    }
    lines.push(fields.join(CSV_SEP));
  }
  return lines.join(CSV_EOL) + CSV_EOL;
}

function csvField(s: string): string {
  // Quote any field containing the separator, a quote, CR, or LF.
  // The empty string is fine bare (CSV `,,` is two empty cells).
  if (/["\r\n,]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatCsvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  // Objects (jsonb), arrays, etc — stable JSON projection.
  return JSON.stringify(v);
}

/**
 * Render `rows` as a JSON array of `{column: value}` objects, indented
 * two spaces and terminated with a newline so the file ends cleanly.
 */
export function toJson(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  columns: ReadonlyArray<ExportColumn>,
): string {
  const objects: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      o[columns[i]!.name] = jsonValue(row[i]);
    }
    objects.push(o);
  }
  return JSON.stringify(objects, null, 2) + "\n";
}

function jsonValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v ?? null;
}

/**
 * Render `rows` as a sequence of `INSERT INTO …;` statements suitable
 * for re-execution in `psql`. Each statement is routed through
 * `redact()` (defense in depth — see module header). A `BEGIN;` /
 * `COMMIT;` envelope wraps the script so a mid-batch failure rolls back
 * cleanly instead of leaving a half-applied state.
 */
export function toInserts(
  schema: string,
  table: string,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  columns: ReadonlyArray<ExportColumn>,
): string {
  const qualified = qualifyIdent(schema, table);
  const colList = columns.map((c) => quoteIdent(c.name)).join(", ");
  const lines: string[] = ["BEGIN;"];
  for (const row of rows) {
    const literals: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      literals.push(sqlLiteral(row[i]));
    }
    lines.push(`INSERT INTO ${qualified} (${colList}) VALUES (${literals.join(", ")});`);
  }
  lines.push("COMMIT;");
  return lines.join("\n") + "\n";
}

/**
 * Render a JS value as a PG SQL literal:
 *   - null/undefined → `NULL`
 *   - finite number  → bare number
 *   - boolean        → `TRUE` / `FALSE`
 *   - Date           → `'<ISO 8601>'`
 *   - everything else → single-quoted string with `'` doubled.
 *     Objects/arrays serialize via `JSON.stringify` first so jsonb
 *     columns round-trip as `'{"k":"v"}'` (the user can append
 *     `::jsonb` if their target schema needs the cast).
 */
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "NULL";
    return String(v);
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  const raw = typeof v === "string" ? v : JSON.stringify(v);
  // Redact on the RAW string — after SQL escaping doubles the wrapping
  // quotes, the `'[^']*'`-shaped redact patterns can no longer match
  // (see module header for the worked example).
  const scrubbed = redact(raw);
  return `'${scrubbed.replace(/'/g, "''")}'`;
}
