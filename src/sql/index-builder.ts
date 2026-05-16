/**
 * Pure CREATE INDEX builder (US6; T110 — consumed by the visual index
 * editor's host glue at `src/commands/editors.ts`).
 *
 * No `pg`, no `vscode`. The host gathers user input through QuickPicks
 * + InputBoxes, hands a structured spec here, gets back a `BuiltStatement`
 * + a preview-friendly markdown render, then routes through the modal
 * preview / execute / "save to migration" path the same way the
 * migration wizard does.
 *
 * Keyword order matches the PG grammar:
 *   CREATE [UNIQUE] INDEX [CONCURRENTLY] [name] ON schema.table (cols) [WHERE expr]
 */

import { quoteIdent, qualifyIdent } from "../pg/introspect.js";
import type { BuiltStatement } from "./update-builder.js";

export interface IndexSpec {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
  readonly unique: boolean;
  /** Optional partial-index predicate (verbatim, must be validated). */
  readonly where?: string;
  /** CONCURRENTLY — non-transactional; can't be wrapped in BEGIN. */
  readonly concurrent?: boolean;
}

export function buildCreateIndex(spec: IndexSpec): BuiltStatement {
  const parts: string[] = ["CREATE"];
  if (spec.unique) parts.push("UNIQUE");
  parts.push("INDEX");
  if (spec.concurrent) parts.push("CONCURRENTLY");
  parts.push(quoteIdent(spec.name));
  parts.push("ON");
  parts.push(qualifyIdent(spec.schema, spec.table));
  parts.push(`(${spec.columns.map((c) => quoteIdent(c)).join(", ")})`);
  if (spec.where && spec.where.trim().length > 0) {
    parts.push("WHERE", spec.where);
  }
  return { text: parts.join(" "), values: [] };
}

export interface SuggestNameOpts {
  readonly table: string;
  readonly columns: ReadonlyArray<string>;
  readonly unique: boolean;
}

/**
 * Produce a sensible default index name following the `ix_<table>_<col1>_<col2>`
 * (or `ux_` for UNIQUE) convention. Result is normalised to lower-case
 * snake_case and truncated to 63 chars (PostgreSQL's NAMEDATALEN limit).
 */
export function suggestIndexName(opts: SuggestNameOpts): string {
  const prefix = opts.unique ? "ux" : "ix";
  const slug = [opts.table, ...opts.columns]
    .map(slugify)
    .filter((s) => s.length > 0)
    .join("_");
  const full = `${prefix}_${slug}`;
  return full.slice(0, 63);
}

function slugify(s: string): string {
  return s
    .replace(/"/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export type ValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "NO_COLUMNS"
        | "DUPLICATE_COLUMN"
        | "EMPTY_NAME"
        | "NAME_TOO_LONG"
        | "BAD_WHERE";
      readonly reason: string;
    };

export function validateIndexSpec(spec: IndexSpec): ValidationResult {
  if (spec.columns.length === 0) {
    return {
      ok: false,
      code: "NO_COLUMNS",
      reason: "Index needs at least one column.",
    };
  }
  const seen = new Set<string>();
  for (const c of spec.columns) {
    if (seen.has(c)) {
      return {
        ok: false,
        code: "DUPLICATE_COLUMN",
        reason: `Column "${c}" appears more than once in the index.`,
      };
    }
    seen.add(c);
  }
  if (!spec.name || spec.name.trim().length === 0) {
    return {
      ok: false,
      code: "EMPTY_NAME",
      reason: "Index name is required.",
    };
  }
  // PostgreSQL truncates identifiers to NAMEDATALEN-1 (63 bytes by default).
  // We reject up front so the user sees their own name, not a silent truncation.
  if (spec.name.length > 63) {
    return {
      ok: false,
      code: "NAME_TOO_LONG",
      reason: `Index name exceeds the 63-character PostgreSQL limit.`,
    };
  }
  if (spec.where !== undefined && spec.where.length > 0) {
    // The WHERE clause is verbatim user-authored SQL; we can't safely
    // parameterise it (it references columns and operators). The minimum
    // bar is "no second statement smuggled past the gate": reject any
    // `;` that survives a comment + quote scrub. Anything else falls to
    // the planner's own diagnostics on EXECUTE.
    if (containsBareSemicolon(spec.where)) {
      return {
        ok: false,
        code: "BAD_WHERE",
        reason:
          "Partial-index WHERE clause must be a single predicate — no semicolons or additional statements.",
      };
    }
  }
  return { ok: true };
}

/**
 * Returns true if the input contains a `;` outside of a string / quoted
 * identifier / line comment / block comment. Mirrors the readonly-gate's
 * defense — the simpler standalone check is fine here because the WHERE
 * clause cannot contain dollar-quoted bodies in normal SQL syntax.
 */
function containsBareSemicolon(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "-" && s[i + 1] === "-") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (s[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      while (i < s.length) {
        if (s[i] === '"' && s[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (s[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === ";") return true;
    i++;
  }
  return false;
}
