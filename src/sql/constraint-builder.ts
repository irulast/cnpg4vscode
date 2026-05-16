/**
 * Pure ALTER TABLE ADD CONSTRAINT builder (US6; T111 — consumed by the
 * visual constraint editor's host glue at `src/commands/editors.ts`).
 *
 * No `pg`, no `vscode`. Supports four constraint kinds matching the
 * spec scope:
 *
 *   - PRIMARY KEY (single or composite)
 *   - UNIQUE      (single or composite)
 *   - FOREIGN KEY (with optional ON UPDATE / ON DELETE actions)
 *   - CHECK       (verbatim predicate, with a bare-`;` injection guard)
 *
 * The host gathers user input through QuickPick + InputBox steps, hands
 * a structured spec here, gets back a `BuiltStatement` and a
 * preview-friendly modal description. Same pattern as the index editor
 * at `src/sql/index-builder.ts`.
 */

import { quoteIdent, qualifyIdent } from "../pg/introspect.js";
import type { BuiltStatement } from "./update-builder.js";

export type FkAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";

export type ConstraintKind = "primaryKey" | "unique" | "foreignKey" | "check";

interface BaseSpec {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
}

export interface PrimaryKeySpec extends BaseSpec {
  readonly kind: "primaryKey";
  readonly columns: ReadonlyArray<string>;
}

export interface UniqueSpec extends BaseSpec {
  readonly kind: "unique";
  readonly columns: ReadonlyArray<string>;
}

export interface ForeignKeySpec extends BaseSpec {
  readonly kind: "foreignKey";
  readonly columns: ReadonlyArray<string>;
  readonly references: {
    readonly schema: string;
    readonly table: string;
    readonly columns: ReadonlyArray<string>;
    readonly onUpdate?: FkAction;
    readonly onDelete?: FkAction;
  };
}

export interface CheckSpec extends BaseSpec {
  readonly kind: "check";
  /** Predicate verbatim; validated against bare-`;` injection. */
  readonly expression: string;
}

export type ConstraintSpec = PrimaryKeySpec | UniqueSpec | ForeignKeySpec | CheckSpec;

export function buildAddConstraint(spec: ConstraintSpec): BuiltStatement {
  const target = qualifyIdent(spec.schema, spec.table);
  const head = `ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdent(spec.name)}`;
  switch (spec.kind) {
    case "primaryKey":
      return { text: `${head} PRIMARY KEY (${joinCols(spec.columns)})`, values: [] };
    case "unique":
      return { text: `${head} UNIQUE (${joinCols(spec.columns)})`, values: [] };
    case "foreignKey": {
      const ref = spec.references;
      const refTarget = qualifyIdent(ref.schema, ref.table);
      const parts = [
        head,
        "FOREIGN KEY",
        `(${joinCols(spec.columns)})`,
        "REFERENCES",
        refTarget,
        `(${joinCols(ref.columns)})`,
      ];
      // Action clauses are omitted when the value matches PG's default
      // ("NO ACTION") so the round-tripped DDL is minimal.
      if (ref.onUpdate && ref.onUpdate !== "NO ACTION") parts.push("ON UPDATE", ref.onUpdate);
      if (ref.onDelete && ref.onDelete !== "NO ACTION") parts.push("ON DELETE", ref.onDelete);
      return { text: parts.join(" "), values: [] };
    }
    case "check":
      return { text: `${head} CHECK (${spec.expression})`, values: [] };
  }
}

function joinCols(cols: ReadonlyArray<string>): string {
  return cols.map((c) => quoteIdent(c)).join(", ");
}

// ---------------------------------------------------------------------------
// Name suggestion
// ---------------------------------------------------------------------------

export type SuggestNameOpts =
  | { kind: "primaryKey"; table: string; columns: ReadonlyArray<string> }
  | { kind: "unique"; table: string; columns: ReadonlyArray<string> }
  | {
      kind: "foreignKey";
      table: string;
      columns: ReadonlyArray<string>;
      referencedTable: string;
    }
  | { kind: "check"; table: string; columns?: ReadonlyArray<string> };

const PREFIX: Record<ConstraintKind, string> = {
  primaryKey: "pk",
  unique: "uq",
  foreignKey: "fk",
  check: "ck",
};

export function suggestConstraintName(opts: SuggestNameOpts): string {
  const prefix = PREFIX[opts.kind];
  const parts: string[] = [opts.table];
  // PKs are typically named just `pk_<table>` — no need to enumerate
  // the column list (a table has at most one PK).
  if (opts.kind !== "primaryKey") {
    if (opts.kind === "foreignKey") parts.push(opts.referencedTable);
    else if (opts.columns && opts.columns.length > 0) parts.push(...opts.columns);
  }
  const slug = parts.map(slugify).filter((s) => s.length > 0).join("_");
  return `${prefix}_${slug}`.slice(0, 63);
}

function slugify(s: string): string {
  return s
    .replace(/"/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationCode =
  | "EMPTY_NAME"
  | "NAME_TOO_LONG"
  | "NO_COLUMNS"
  | "DUPLICATE_COLUMN"
  | "FK_ARITY_MISMATCH"
  | "EMPTY_EXPRESSION"
  | "BAD_EXPRESSION";

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ValidationCode; readonly reason: string };

export function validateConstraintSpec(spec: ConstraintSpec): ValidationResult {
  if (!spec.name || spec.name.trim().length === 0) {
    return { ok: false, code: "EMPTY_NAME", reason: "Constraint name is required." };
  }
  if (spec.name.length > 63) {
    return {
      ok: false,
      code: "NAME_TOO_LONG",
      reason: "Constraint name exceeds PostgreSQL's 63-character limit.",
    };
  }
  if (spec.kind === "check") {
    if (!spec.expression || spec.expression.trim().length === 0) {
      return {
        ok: false,
        code: "EMPTY_EXPRESSION",
        reason: "CHECK constraint needs a predicate expression.",
      };
    }
    if (containsBareSemicolon(spec.expression)) {
      return {
        ok: false,
        code: "BAD_EXPRESSION",
        reason: "CHECK predicate must be a single expression — no semicolons or additional statements.",
      };
    }
    return { ok: true };
  }
  // PK / UNIQUE / FK
  if (spec.columns.length === 0) {
    return {
      ok: false,
      code: "NO_COLUMNS",
      reason: `${humanKind(spec.kind)} constraint needs at least one column.`,
    };
  }
  const seen = new Set<string>();
  for (const c of spec.columns) {
    if (seen.has(c)) {
      return {
        ok: false,
        code: "DUPLICATE_COLUMN",
        reason: `Column "${c}" appears more than once in the constraint.`,
      };
    }
    seen.add(c);
  }
  if (spec.kind === "foreignKey") {
    if (spec.references.columns.length !== spec.columns.length) {
      return {
        ok: false,
        code: "FK_ARITY_MISMATCH",
        reason: `Foreign key has ${spec.columns.length} local column(s) but references ${spec.references.columns.length}; counts must match.`,
      };
    }
  }
  return { ok: true };
}

function humanKind(k: ConstraintKind): string {
  return k === "primaryKey"
    ? "PRIMARY KEY"
    : k === "unique"
      ? "UNIQUE"
      : k === "foreignKey"
        ? "FOREIGN KEY"
        : "CHECK";
}

/** Same bare-`;` detector pattern as `src/sql/index-builder.ts`. */
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
