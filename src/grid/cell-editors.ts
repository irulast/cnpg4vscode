/**
 * Per-type cell-editor registry for the Grid Editor (US6 Phase 8.5 — T149).
 *
 * Pure module — no `vscode`, no React, no glide-data-grid. The renderer
 * (T153) maps the `CellEditorChoice.kind` to a concrete glide-data-grid
 * cell-kind + editor; this module decides WHICH kind to mount based on
 * the column descriptor.
 *
 * Two layers:
 *
 *   1. `pgTypeToJsType(pgType)` — pure string-to-string mapping from
 *      PostgreSQL's `format_type()` output to the protocol's JS-type
 *      enum. Used at descriptor-load time to populate
 *      `ColumnDescriptor.jsType`.
 *
 *   2. `pickEditor(descriptor)` — given a fully-populated descriptor,
 *      returns the editor choice the renderer should mount, with the
 *      knobs that vary by PG sub-type (date precision, number
 *      precision, enum choices, etc).
 *
 * Defensive default: anything we don't recognise renders read-only.
 * The user can still SEE the cell (it's a string); they just can't
 * edit it. Once a real edit case appears we add a row to the type
 * table here.
 */

import type { ColumnDescriptor } from "../webviews/grid/protocol.js";

export type CellEditorChoice = (
  | { readonly kind: "text"; readonly allowEmpty: boolean }
  | { readonly kind: "number"; readonly precision: "integer" | "decimal" }
  | { readonly kind: "boolean" }
  | { readonly kind: "date"; readonly includeTime: boolean; readonly includeZone: boolean }
  | { readonly kind: "json"; readonly popout: boolean }
  | { readonly kind: "enum"; readonly choices: ReadonlyArray<string> }
  | { readonly kind: "readonly" }
) & {
  readonly allowSetNull: boolean;
  readonly allowResetDefault: boolean;
};

// ---------------------------------------------------------------------------
// PG type → JS type
// ---------------------------------------------------------------------------

// Conservative: only types where free-text editing is unambiguous and
// the server will safely validate on apply. Network types (inet/cidr/
// macaddr), XML, and other structured-but-stringly types fall to
// 'unknown' → readonly until we wire in specialised editors that can
// validate locally.
const STRING_TYPES: ReadonlySet<string> = new Set([
  "text",
  "varchar",
  "character varying",
  "character",
  "char",
  "name",
  "citext",
  "bpchar",
  "uuid",
]);

const INT_TYPES: ReadonlySet<string> = new Set([
  "int", "int2", "int4", "int8",
  "smallint", "integer", "bigint",
  "smallserial", "serial", "bigserial",
]);

const DECIMAL_TYPES: ReadonlySet<string> = new Set([
  "real",
  "float4",
  "double precision",
  "float8",
  "numeric",
  "decimal",
  "money",
]);

const BOOL_TYPES: ReadonlySet<string> = new Set(["bool", "boolean"]);

const DATE_TYPES: ReadonlySet<string> = new Set([
  "date",
  "time",
  "timetz",
  "time with time zone",
  "time without time zone",
  "timestamp",
  "timestamptz",
  "timestamp with time zone",
  "timestamp without time zone",
]);

const JSON_TYPES: ReadonlySet<string> = new Set(["json", "jsonb"]);

export function pgTypeToJsType(
  pgType: string,
): "string" | "number" | "boolean" | "date" | "json" | "unknown" {
  const t = pgType.toLowerCase();
  if (STRING_TYPES.has(t)) return "string";
  if (INT_TYPES.has(t)) return "number";
  if (DECIMAL_TYPES.has(t)) return "number";
  if (BOOL_TYPES.has(t)) return "boolean";
  if (DATE_TYPES.has(t)) return "date";
  if (JSON_TYPES.has(t)) return "json";
  return "unknown";
}

// ---------------------------------------------------------------------------
// pickEditor
// ---------------------------------------------------------------------------

export function pickEditor(descriptor: ColumnDescriptor): CellEditorChoice {
  const base = {
    allowSetNull: descriptor.nullable,
    allowResetDefault: descriptor.hasDefault,
  };

  // PK columns are never editable — mutating a PK would change the row's
  // identity, breaking every subsequent UPDATE/DELETE keyed on the old PK.
  if (descriptor.isPk) {
    return { kind: "readonly", ...base };
  }

  switch (descriptor.jsType) {
    case "string":
      return { kind: "text", allowEmpty: true, ...base };

    case "number": {
      const t = descriptor.pgType.toLowerCase();
      const precision: "integer" | "decimal" = INT_TYPES.has(t) ? "integer" : "decimal";
      return { kind: "number", precision, ...base };
    }

    case "boolean":
      return { kind: "boolean", ...base };

    case "date": {
      const t = descriptor.pgType.toLowerCase();
      const includeTime = t !== "date";
      const includeZone = t.includes("timestamptz") || t.includes("with time zone") || t === "timetz";
      return { kind: "date", includeTime, includeZone, ...base };
    }

    case "json":
      return { kind: "json", popout: true, ...base };

    case "enum": {
      if (descriptor.enumValues && descriptor.enumValues.length > 0) {
        return { kind: "enum", choices: descriptor.enumValues, ...base };
      }
      // Defensive — descriptor said enum but supplied no choices.
      // Fall back to a free-text editor; the server will enum-validate
      // on apply.
      return { kind: "text", allowEmpty: true, ...base };
    }

    case "unknown":
    default:
      return { kind: "readonly", ...base };
  }
}
