/**
 * UPDATE / DELETE statement builder for the cell-edit apply flow
 * (US6; T108, FR-026). Pure functions only — no `pg`, no `vscode`.
 *
 * Consumed by the notebook result-grid host once the renderer reports a
 * dirty cell. The PK descriptor that drives `pkColumns`/`pkValues` comes
 * from contracts/pg-introspection.md § Result-set descriptor for
 * cell-edit eligibility; the host fetches it once per result set and
 * passes it in here unchanged.
 *
 * Two-layer safety, mirroring the spec's defense-in-depth posture:
 *
 *   1. `validateEditRequest()` rejects edits when the connection is in
 *      read-only mode OR when no PK is available (the result set is not
 *      edit-eligible — the grid should already be read-only in that
 *      state, but the gate is here too as a belt-and-braces check).
 *
 *   2. The generated statement is *parameterized* — string values are
 *      bound via `$N` placeholders, never interpolated. NULL handling
 *      uses SQL keywords (`= NULL` in SET means "set to NULL"; `IS NULL`
 *      in WHERE is the only way to match NULL).
 *
 * The generated text is also human-readable so the preview-before-apply
 * MarkdownString shows the user exactly what's about to execute.
 */

import { quoteIdent, qualifyIdent } from "../pg/introspect.js";

/** Connection mode visible to the builder. Matches DatabaseConnection.mode. */
export type ConnectionMode = "readonly" | "write";

/**
 * A change to apply to a single column. The plain-JS-value form binds via
 * `$N`. The object forms cover the two specials the binder can't express:
 *
 *   - `{ sql: "DEFAULT" }` — emit the literal SQL keyword DEFAULT (resets
 *     to the column default expression).
 *   - `{ value, typeHint }` — bind via `$N::<typeHint>` so the server-side
 *     type resolution is unambiguous for jsonb/uuid/etc. without inferring
 *     from the JS value's runtime type.
 */
export type ColumnChange =
  | string
  | number
  | boolean
  | null
  | { readonly sql: "DEFAULT" }
  | { readonly value: unknown; readonly typeHint: string };

export interface BuildOptions {
  readonly schema: string;
  readonly table: string;
  readonly pkColumns: ReadonlyArray<string>;
  readonly pkValues: ReadonlyArray<unknown>;
}

export interface BuildUpdateOptions extends BuildOptions {
  readonly changes: Readonly<Record<string, ColumnChange>>;
}

export interface BuiltStatement {
  readonly text: string;
  readonly values: ReadonlyArray<unknown>;
}

/**
 * Build a parameterized UPDATE statement. Caller is responsible for
 * having validated the request via `validateEditRequest()`; this function
 * does not re-check write-mode or PK presence (an empty `pkColumns`
 * array here would produce an unsafe statement-wide UPDATE — the
 * validator's job to refuse).
 */
export function buildUpdate(opts: BuildUpdateOptions): BuiltStatement {
  const target = qualifyIdent(opts.schema, opts.table);
  const values: unknown[] = [];
  let nextParam = 1;

  // Deterministic column order keeps `text` stable across calls so the
  // preview is repeatable and snapshot-friendly.
  const cols = Object.keys(opts.changes).sort();
  const setClauses: string[] = [];
  for (const col of cols) {
    const change = opts.changes[col]!;
    const lhs = quoteIdent(col);
    if (change === null) {
      setClauses.push(`${lhs} = NULL`);
      continue;
    }
    if (
      typeof change === "object" &&
      change !== null &&
      "sql" in change &&
      change.sql === "DEFAULT"
    ) {
      setClauses.push(`${lhs} = DEFAULT`);
      continue;
    }
    if (typeof change === "object" && change !== null && "typeHint" in change) {
      values.push(change.value);
      setClauses.push(`${lhs} = $${nextParam}::${change.typeHint}`);
      nextParam++;
      continue;
    }
    values.push(change);
    setClauses.push(`${lhs} = $${nextParam}`);
    nextParam++;
  }

  const where = buildPkWhere(opts.pkColumns, opts.pkValues, values, nextParam);

  const text = `UPDATE ${target} SET ${setClauses.join(", ")} WHERE ${where}`;
  return { text, values };
}

export interface BuildDeleteOptions extends BuildOptions {}

/**
 * Build a parameterized DELETE statement. Same validation contract as
 * `buildUpdate` — caller must have run `validateEditRequest()` first.
 */
export function buildDelete(opts: BuildDeleteOptions): BuiltStatement {
  const target = qualifyIdent(opts.schema, opts.table);
  const values: unknown[] = [];
  const where = buildPkWhere(opts.pkColumns, opts.pkValues, values, 1);
  return { text: `DELETE FROM ${target} WHERE ${where}`, values };
}

/**
 * Compose the AND-joined PK WHERE clause, appending bindings to `values`
 * for every non-null PK component (NULLs are emitted as `IS NULL` and
 * consume no placeholder).
 */
function buildPkWhere(
  pkColumns: ReadonlyArray<string>,
  pkValues: ReadonlyArray<unknown>,
  values: unknown[],
  startParam: number,
): string {
  const parts: string[] = [];
  let nextParam = startParam;
  for (let i = 0; i < pkColumns.length; i++) {
    const col = quoteIdent(pkColumns[i]!);
    const v = pkValues[i];
    if (v === null || v === undefined) {
      parts.push(`${col} IS NULL`);
      continue;
    }
    values.push(v);
    parts.push(`${col} = $${nextParam}`);
    nextParam++;
  }
  return parts.join(" AND ");
}

export interface ValidateEditRequestOptions {
  readonly mode: ConnectionMode;
  readonly pkColumns: ReadonlyArray<string>;
}

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "READ_ONLY" | "NO_PK"; readonly reason: string };

/**
 * Decide whether an edit can be issued at all. Rejection codes are
 * stable so the UI can localise messages and the host can bucket
 * telemetry.
 */
export function validateEditRequest(opts: ValidateEditRequestOptions): ValidationResult {
  if (opts.mode !== "write") {
    return {
      ok: false,
      code: "READ_ONLY",
      reason: "Connection is in read-only mode. Toggle to Write mode to apply edits.",
    };
  }
  if (opts.pkColumns.length === 0) {
    return {
      ok: false,
      code: "NO_PK",
      reason:
        "Result set has no detectable primary key — cell edits require a single-source SELECT against a PK'd table.",
    };
  }
  return { ok: true };
}

export interface PreviewMeta {
  readonly operation: "UPDATE" | "DELETE";
  readonly target: string;
}

/**
 * Render a markdown preview string suitable for wrapping in a
 * `vscode.MarkdownString`. The format is intentionally compact and
 * mechanical: a heading naming the operation + target, then the SQL in
 * a fenced block, then a parameter-binding list. Hosts that need
 * structured access to the same data should consume `BuiltStatement`
 * directly rather than parsing this string.
 *
 * The renderer keeps the surface no-vscode-import so the same string can
 * also be rendered into a notebook cell output or a markdown document
 * if the host ever needs that flow (e.g., the migration export-to-`.sql`
 * path in T114).
 */
export function renderPreviewMarkdown(stmt: BuiltStatement, meta: PreviewMeta): string {
  const lines: string[] = [];
  lines.push(`### Confirm ${meta.operation} on \`${meta.target}\``);
  lines.push("");
  lines.push("```sql");
  lines.push(stmt.text);
  lines.push("```");
  if (stmt.values.length === 0) {
    lines.push("");
    lines.push("_No bound parameters._");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("**Parameter bindings**:");
  lines.push("");
  for (let i = 0; i < stmt.values.length; i++) {
    lines.push(`- \`$${i + 1}\` = ${formatValueForPreview(stmt.values[i])}`);
  }
  return lines.join("\n");
}

function formatValueForPreview(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") {
    // Wrap in a code span; escape any embedded backticks by bumping the
    // span to a double-backtick fence per the CommonMark backtick rules.
    if (v.includes("`")) return `\`\` ${v} \`\``;
    return `\`${v}\``;
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return `\`${String(v)}\``;
  }
  // Objects/arrays — render as compact JSON in a code span.
  try {
    return `\`${JSON.stringify(v)}\``;
  } catch {
    return "`<unserialisable>`";
  }
}
