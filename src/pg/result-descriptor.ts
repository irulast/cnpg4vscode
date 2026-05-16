/**
 * Result-set descriptor — cell-edit eligibility (US6; T107).
 *
 * Two halves, kept tightly coupled here:
 *
 *   1. `detectSingleSourceTable(sql)` — a pure function that decides
 *      whether a SELECT comes from exactly one base table (the
 *      necessary-but-not-sufficient condition for cell editing). The
 *      detector is INTENTIONALLY CONSERVATIVE: when in any doubt it
 *      returns `null` and the grid stays read-only. False negatives are
 *      annoying; false positives risk generating an UPDATE keyed on the
 *      wrong table.
 *
 *   2. `fetchPkDescriptor(client, schema, table)` — issues the
 *      result-set-descriptor query from
 *      `contracts/pg-introspection.md § Result-set descriptor for
 *      cell-edit eligibility` and returns the ordered PK column list.
 *      Returns `null` for tables without a primary key.
 *
 * The composed `resolveEditEligibility(client, sql)` is the
 * grid host's one-call entrypoint.
 *
 * The task spec mentions `@pg-query/parser` (libpg_query in WASM) as
 * the canonical AST source. We're starting with a hand-rolled
 * conservative scanner instead — same trade-off documented in
 * `src/pg/readonly-gate.ts` and Constitution §V (Simplicity & YAGNI):
 * start with the simplest enforcement that captures the common edit-
 * eligible shape, upgrade to libpg_query when a real edge case demands
 * it. The contract test corpus protects us from a relaxation
 * regression.
 */

import { stripCommentsAndQuotesForScan, containsTopLevelSemicolon } from "./sql-scan.js";

/**
 * Source-table reference detected from a SELECT's FROM clause. `schema`
 * is `null` for unqualified references (the caller resolves via
 * search_path when needed for the PK descriptor query).
 */
export interface SingleSourceTable {
  readonly schema: string | null;
  readonly table: string;
}

/**
 * Returns the single base table sourced by the SELECT, or `null` when
 * the SELECT cannot be unambiguously mapped to one table. See file
 * header for the conservatism rationale.
 *
 * Algorithm:
 *   1. Strip comments and quoted-string bodies so keywords inside
 *      `'SELECT … FROM foo'` literals don't confuse the scanner.
 *   2. Reject multi-statement input outright.
 *   3. Require the first keyword to be SELECT.
 *   4. Reject any CTE (`WITH …`), UNION/INTERSECT/EXCEPT, JOIN, comma-
 *      separated FROM list, LATERAL, VALUES, function call source, or
 *      parenthesised subquery in FROM.
 *   5. Parse the single FROM target — accepting `schema.table`,
 *      `"Schema"."Table"`, `schema.table alias`, `schema.table AS
 *      alias` — and return it.
 *
 * Catalog tables (pg_catalog.pg_*) are accepted as sources because they
 * are real tables; the higher-layer fetchPkDescriptor will return null
 * for those that lack a primary key (most catalogs).
 */
export function detectSingleSourceTable(sql: string): SingleSourceTable | null {
  const trimmed = sql.trim();
  if (!trimmed) return null;

  // Reject multi-statement up front — caller must split.
  if (containsTopLevelSemicolon(trimmed)) return null;

  // Strip comments AND quoted-string bodies, but preserve quoted
  // IDENTIFIERS verbatim (so `"Order"` doesn't collapse into `Order`).
  // We pass `keepQuotedIdentifiers: true` to the shared scanner.
  // After scrubbing, drop a trailing `;` — `containsTopLevelSemicolon`
  // already ruled out multi-statement input, so any surviving `;` is
  // the conventional terminator we can ignore.
  const scrubbed = stripCommentsAndQuotesForScan(trimmed, {
    keepQuotedIdentifiers: true,
  })
    .trim()
    .replace(/;\s*$/, "")
    .trim();
  if (!scrubbed) return null;

  // CTEs are not single-source for cell-edit purposes — the FROM target
  // is the CTE name, not a base table the planner can route UPDATEs to.
  if (/^\s*WITH\b/i.test(scrubbed)) return null;

  // Reject UNION / INTERSECT / EXCEPT at the top level.
  if (/\b(UNION|INTERSECT|EXCEPT)\b/i.test(scrubbed)) return null;

  // Must be a SELECT.
  if (!/^\s*SELECT\b/i.test(scrubbed)) return null;

  // Find the FROM clause boundary. The scrubbed input has comments and
  // string bodies removed, so a top-level `FROM` keyword search is
  // safe — quoted identifiers are still in place but they're enclosed
  // in `"…"`, which our split regex tolerates.
  const fromMatch = scrubbed.match(/\bFROM\b/i);
  if (!fromMatch || fromMatch.index === undefined) return null;

  // Slice from the FROM keyword to the next clause-terminator at the
  // top level. We accept WHERE / GROUP BY / HAVING / ORDER BY / LIMIT /
  // OFFSET / FETCH / FOR / RETURNING (the last shouldn't appear in a
  // SELECT but doesn't hurt) — or end-of-string.
  const afterFrom = scrubbed.slice(fromMatch.index + 4); // skip "FROM"
  const clauseEndRe = /\b(WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|FETCH|FOR|RETURNING|WINDOW)\b/i;
  const endMatch = afterFrom.match(clauseEndRe);
  const fromClause = (endMatch && endMatch.index !== undefined
    ? afterFrom.slice(0, endMatch.index)
    : afterFrom
  ).trim();
  if (!fromClause) return null;

  // Hard rejects on multi-source / subquery / function source / VALUES /
  // LATERAL — these are the load-bearing safety checks.
  if (/[(,]/.test(fromClause)) return null; // any `(` or `,` means subquery, function call, or join list
  if (/\bJOIN\b/i.test(fromClause)) return null;
  if (/\bLATERAL\b/i.test(fromClause)) return null;
  if (/\bVALUES\b/i.test(fromClause)) return null;
  if (/\bUSING\b/i.test(fromClause)) return null;
  if (/\bON\b/i.test(fromClause)) return null;
  if (/\bCROSS\b/i.test(fromClause)) return null;

  // What's left should be `schema.table [AS] alias?` — strip alias.
  const stripped = fromClause.replace(/\s+(AS\s+)?[A-Za-z_][A-Za-z0-9_]*\s*$/i, "").trim();
  return parseTableRef(stripped || fromClause);
}

/**
 * Parses a single table reference of the form:
 *   - `table`
 *   - `"Table"`
 *   - `schema.table`
 *   - `"Schema".table`
 *   - `schema."Table"`
 *   - `"Schema"."Table"`
 *
 * Returns null if the input doesn't match.
 */
function parseTableRef(input: string): SingleSourceTable | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Two-part: schema.table
  const dot = findTopLevelDot(trimmed);
  if (dot !== -1) {
    const schema = parseIdent(trimmed.slice(0, dot));
    const table = parseIdent(trimmed.slice(dot + 1));
    if (schema === null || table === null) return null;
    return { schema, table };
  }
  const table = parseIdent(trimmed);
  if (table === null) return null;
  return { schema: null, table };
}

/** Find the dot separating schema.table, skipping any inside `"…"`. */
function findTopLevelDot(s: string): number {
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && c === ".") return i;
  }
  return -1;
}

/** Parse an identifier, stripping `"…"` quotes if present. */
function parseIdent(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  // Unquoted identifier — must be a single token of word chars (PG normally
  // folds these to lower-case, but we preserve the user's case; the catalog
  // query will see it as-is).
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// PK descriptor fetch
// ---------------------------------------------------------------------------

/**
 * Minimal pg client surface — single `query()` method. The notebook
 * connection layer (and `pg.PoolClient`) both satisfy this without
 * adapting.
 */
export interface DescriptorClient {
  query(sql: string, values?: ReadonlyArray<unknown>): Promise<{
    rows: ReadonlyArray<Record<string, unknown>>;
  }>;
}

export interface PkDescriptor {
  readonly schema: string | null;
  readonly table: string;
  /** Ordered by index position — caller MUST preserve this order when building UPDATE WHERE. */
  readonly pkColumns: ReadonlyArray<string>;
}

const PK_DESCRIPTOR_QUERY = `
  SELECT i.indrelid::regclass::text AS rel,
         array_agg(a.attname::text ORDER BY ord) AS pk_columns
    FROM pg_index i
    JOIN unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
   WHERE i.indrelid = $1::regclass
     AND i.indisprimary
   GROUP BY i.indrelid
`;

/**
 * Fetch the primary-key column list for a given table. Returns `null`
 * when the table has no PK (a common case for catalog views and for
 * tables the user hasn't gotten around to adding a PK to — both are
 * unsupported for cell editing).
 */
export async function fetchPkDescriptor(
  client: DescriptorClient,
  source: SingleSourceTable,
): Promise<PkDescriptor | null> {
  const regclassArg = source.schema
    ? `"${source.schema.replace(/"/g, '""')}"."${source.table.replace(/"/g, '""')}"`
    : `"${source.table.replace(/"/g, '""')}"`;
  let res;
  try {
    res = await client.query(PK_DESCRIPTOR_QUERY, [regclassArg]);
  } catch {
    // 42P01 (undefined_table), 42704 (undefined_object), or any other
    // catalog-resolution failure → treat as "no PK detectable".
    return null;
  }
  if (res.rows.length === 0) return null;
  const row = res.rows[0]!;
  const raw = row["pk_columns"];
  // pg returns text[] as a JS string[] when the column is array-typed;
  // defensively coerce if a future driver hands back a string.
  const pkColumns = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? parsePgTextArray(raw)
      : [];
  if (pkColumns.length === 0) return null;
  return { schema: source.schema, table: source.table, pkColumns };
}

/**
 * One-call entrypoint used by the grid host. Returns the descriptor or
 * `null` (which the host interprets as "render read-only").
 */
export async function resolveEditEligibility(
  client: DescriptorClient,
  sql: string,
): Promise<PkDescriptor | null> {
  const src = detectSingleSourceTable(sql);
  if (!src) return null;
  return fetchPkDescriptor(client, src);
}

/** Parse a pg `text[]` literal like `{a,b,"with,comma"}` defensively. */
function parsePgTextArray(s: string): string[] {
  const trimmed = s.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  const inner = trimmed.slice(1, -1);
  if (inner === "") return [];
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inQuote) {
      if (c === '\\' && i + 1 < inner.length) {
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
