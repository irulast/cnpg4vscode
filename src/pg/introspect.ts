/**
 * pg_catalog introspection (US5; FR-022, contracts/pg-introspection.md).
 *
 * Each function is one pg_catalog query, parameterized where the caller
 * supplies a namespace or relation oid. All names returned are
 * un-quoted; the tree provider quotes for display via quoteIdent().
 *
 * 60-second TTL cache wraps each query so re-expanding a tree node is
 * instant; the user's manual refresh action invalidates the relevant key.
 */

import type { DatabaseConnection } from "./connection.js";
import { TtlCache } from "./introspect-cache.js";

export type RelKind = "table" | "view" | "materializedView" | "foreign";

export interface DatabaseRow {
  oid: number;
  name: string;
  owner: string;
  encoding: string;
  isTemplate: boolean;
}
export interface SchemaRow {
  oid: number;
  name: string;
  owner: string;
  isSystem: boolean;
}
export interface RelationRow {
  oid: number;
  name: string;
  kind: RelKind;
  owner: string;
  estRows: number;
  sizeBytes: number | null;
}
export interface ColumnRow {
  attnum: number;
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  isPk: boolean;
}
export interface IndexRow {
  oid: number;
  name: string;
  isUnique: boolean;
  isPrimary: boolean;
  isPartial: boolean;
  columns: string[];
}
export interface ConstraintRow {
  oid: number;
  name: string;
  kind: string;
  definition: string;
}
export interface ForeignKeyRow {
  fromOid: number;
  toOid: number;
  fromColumns: string[];
  toColumns: string[];
  name: string;
}
export interface SequenceRow {
  oid: number;
  name: string;
}
export interface FunctionRow {
  oid: number;
  name: string;
  kind: string;
  args: string;
  returns: string;
  language: string;
}
export interface TriggerRow {
  oid: number;
  name: string;
  definition: string;
}
export interface TypeRow {
  oid: number;
  name: string;
  kind: string;
}
export interface ExtensionRow {
  oid: number;
  name: string;
  version: string;
}
export interface RoleRow {
  oid: number;
  name: string;
  super: boolean;
  canLogin: boolean;
  inherit: boolean;
}

/** Cache shared across one Database Connection's lifetime. */
export class Introspector {
  private readonly cache = new TtlCache<string, unknown>(60_000);

  constructor(private readonly conn: DatabaseConnection) {}

  invalidate(prefix?: string): void {
    if (!prefix) {
      this.cache.clear();
      return;
    }
    // No bulk-by-prefix delete on Map — caller should clear when scope is broad.
    this.cache.clear();
  }

  async databases(): Promise<DatabaseRow[]> {
    return this.cache.getOrLoad("dbs", async () => {
      const r = await this.conn.query(`
        SELECT d.oid, d.datname AS name, r.rolname AS owner,
               pg_encoding_to_char(d.encoding) AS encoding, d.datistemplate AS is_template
          FROM pg_database d
          JOIN pg_roles r ON r.oid = d.datdba
         WHERE has_database_privilege(d.oid, 'CONNECT')
         ORDER BY d.datname
      `);
      return r.rows.map((row) => ({
        oid: Number(row.oid),
        name: String(row.name),
        owner: String(row.owner),
        encoding: String(row.encoding),
        isTemplate: Boolean(row.is_template),
      }));
    }) as Promise<DatabaseRow[]>;
  }

  async schemas(): Promise<SchemaRow[]> {
    return this.cache.getOrLoad("schemas", async () => {
      const r = await this.conn.query(`
        SELECT n.oid, n.nspname AS name, r.rolname AS owner,
               (n.nspname = 'information_schema' OR n.nspname LIKE 'pg_%') AS is_system
          FROM pg_namespace n
          JOIN pg_roles r ON r.oid = n.nspowner
         WHERE has_schema_privilege(n.oid, 'USAGE')
         ORDER BY n.nspname
      `);
      return r.rows.map((row) => ({
        oid: Number(row.oid),
        name: String(row.name),
        owner: String(row.owner),
        isSystem: Boolean(row.is_system),
      }));
    }) as Promise<SchemaRow[]>;
  }

  async relations(schemaOid: number): Promise<RelationRow[]> {
    return this.cache.getOrLoad(`rels:${schemaOid}`, async () => {
      const r = await this.conn.query(
        `
        SELECT c.oid, c.relname AS name,
               CASE c.relkind WHEN 'r' THEN 'table'
                              WHEN 'p' THEN 'table'
                              WHEN 'v' THEN 'view'
                              WHEN 'm' THEN 'materializedView'
                              WHEN 'f' THEN 'foreign'
               END AS kind,
               r.rolname AS owner,
               c.reltuples::bigint AS est_rows,
               CASE WHEN has_table_privilege(c.oid, 'SELECT')
                    THEN pg_table_size(c.oid) END AS size_bytes
          FROM pg_class c
          JOIN pg_roles r ON r.oid = c.relowner
         WHERE c.relnamespace = $1
           AND c.relkind IN ('r','p','v','m','f')
         ORDER BY c.relname
        `,
        [schemaOid],
      );
      return r.rows.map((row) => ({
        oid: Number(row.oid),
        name: String(row.name),
        kind: row.kind as RelKind,
        owner: String(row.owner),
        estRows: Number(row.est_rows ?? 0),
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      }));
    }) as Promise<RelationRow[]>;
  }

  async columns(relOid: number): Promise<ColumnRow[]> {
    return this.cache.getOrLoad(`cols:${relOid}`, async () => {
      const r = await this.conn.query(
        `
        SELECT a.attnum, a.attname AS name,
               format_type(a.atttypid, a.atttypmod) AS type,
               a.attnotnull AS not_null,
               pg_get_expr(d.adbin, d.adrelid) AS default,
               EXISTS (
                 SELECT 1 FROM pg_index i
                  WHERE i.indrelid = a.attrelid
                    AND i.indisprimary
                    AND a.attnum = ANY (i.indkey)
               ) AS is_pk
          FROM pg_attribute a
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = $1
           AND a.attnum > 0
           AND NOT a.attisdropped
         ORDER BY a.attnum
        `,
        [relOid],
      );
      return r.rows.map((row) => ({
        attnum: Number(row.attnum),
        name: String(row.name),
        type: String(row.type),
        notNull: Boolean(row.not_null),
        default: row.default === null ? null : String(row.default),
        isPk: Boolean(row.is_pk),
      }));
    }) as Promise<ColumnRow[]>;
  }

  async indexes(relOid: number): Promise<IndexRow[]> {
    return this.cache.getOrLoad(`idx:${relOid}`, async () => {
      const r = await this.conn.query(
        `
        SELECT i.indexrelid AS oid, c.relname AS name,
               i.indisunique AS is_unique,
               i.indisprimary AS is_primary,
               (i.indpred IS NOT NULL) AS is_partial,
               (
                 SELECT array_agg(a.attname::text ORDER BY ord)
                   FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
               ) AS columns
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = $1
         ORDER BY c.relname
        `,
        [relOid],
      );
      return r.rows.map((row) => ({
        oid: Number(row.oid),
        name: String(row.name),
        isUnique: Boolean(row.is_unique),
        isPrimary: Boolean(row.is_primary),
        isPartial: Boolean(row.is_partial),
        columns: toStringArray(row.columns),
      }));
    }) as Promise<IndexRow[]>;
  }

  async constraints(relOid: number): Promise<ConstraintRow[]> {
    return this.cache.getOrLoad(`con:${relOid}`, async () => {
      const r = await this.conn.query(
        `
        SELECT c.oid, c.conname AS name, c.contype AS kind,
               pg_get_constraintdef(c.oid, true) AS definition
          FROM pg_constraint c
         WHERE c.conrelid = $1
         ORDER BY c.contype, c.conname
        `,
        [relOid],
      );
      return r.rows.map((row) => ({
        oid: Number(row.oid),
        name: String(row.name),
        kind: String(row.kind),
        definition: String(row.definition),
      }));
    }) as Promise<ConstraintRow[]>;
  }

  async foreignKeys(schemaOid: number): Promise<ForeignKeyRow[]> {
    return this.cache.getOrLoad(`fk:${schemaOid}`, async () => {
      // Cast `attname::text` so array_agg returns text[] (OID 1009),
      // which node-postgres parses as a JS array. Raw `name[]` (OID 1003)
      // has no default parser and comes back as the string '{col1,col2}'.
      const r = await this.conn.query(
        `
        SELECT c.conrelid AS from_oid,
               c.confrelid AS to_oid,
               (SELECT array_agg(a.attname::text ORDER BY k.ord)
                  FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                 AS from_columns,
               (SELECT array_agg(a.attname::text ORDER BY k.ord)
                  FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
                 AS to_columns,
               c.conname AS name
          FROM pg_constraint c
          JOIN pg_class fc ON fc.oid = c.conrelid
         WHERE c.contype = 'f'
           AND fc.relnamespace = $1
        `,
        [schemaOid],
      );
      return r.rows.map((row) => ({
        fromOid: Number(row.from_oid),
        toOid: Number(row.to_oid),
        fromColumns: toStringArray(row.from_columns),
        toColumns: toStringArray(row.to_columns),
        name: String(row.name),
      }));
    }) as Promise<ForeignKeyRow[]>;
  }

  async sequences(schemaOid: number): Promise<SequenceRow[]> {
    return this.cache.getOrLoad(`seq:${schemaOid}`, async () => {
      const r = await this.conn.query(
        `
        SELECT c.oid, c.relname AS name
          FROM pg_class c
         WHERE c.relnamespace = $1
           AND c.relkind = 'S'
         ORDER BY c.relname
        `,
        [schemaOid],
      );
      return r.rows.map((row) => ({ oid: Number(row.oid), name: String(row.name) }));
    }) as Promise<SequenceRow[]>;
  }

  async functions(schemaOid: number): Promise<FunctionRow[]> {
    return this.cache.getOrLoad(`fn:${schemaOid}`, async () => {
      const r = await this.conn.query(
        `
        SELECT p.oid, p.proname AS name,
               p.prokind AS kind,
               pg_get_function_arguments(p.oid) AS args,
               pg_get_function_result(p.oid) AS returns,
               l.lanname AS language
          FROM pg_proc p
          JOIN pg_language l ON l.oid = p.prolang
         WHERE p.pronamespace = $1
         ORDER BY p.proname
        `,
        [schemaOid],
      );
      return r.rows.map((row) => ({
        oid: Number(row.oid),
        name: String(row.name),
        kind: String(row.kind),
        args: String(row.args ?? ""),
        returns: String(row.returns ?? ""),
        language: String(row.language),
      }));
    }) as Promise<FunctionRow[]>;
  }

  async triggers(relOid: number): Promise<TriggerRow[]> {
    return this.cache.getOrLoad(`trg:${relOid}`, async () => {
      const r = await this.conn.query(
        `
        SELECT t.oid, t.tgname AS name,
               pg_get_triggerdef(t.oid, true) AS definition
          FROM pg_trigger t
         WHERE t.tgrelid = $1
           AND NOT t.tgisinternal
         ORDER BY t.tgname
        `,
        [relOid],
      );
      return r.rows.map((row) => ({
        oid: Number(row.oid),
        name: String(row.name),
        definition: String(row.definition),
      }));
    }) as Promise<TriggerRow[]>;
  }

  async types(schemaOid: number): Promise<TypeRow[]> {
    return this.cache.getOrLoad(`type:${schemaOid}`, async () => {
      const r = await this.conn.query(
        `
        SELECT t.oid, t.typname AS name, t.typtype AS kind
          FROM pg_type t
         WHERE t.typnamespace = $1
           AND t.typtype IN ('c','e','d')
         ORDER BY t.typname
        `,
        [schemaOid],
      );
      return r.rows.map((row) => ({
        oid: Number(row.oid),
        name: String(row.name),
        kind: String(row.kind),
      }));
    }) as Promise<TypeRow[]>;
  }

  async extensions(): Promise<ExtensionRow[]> {
    return this.cache.getOrLoad("ext", async () => {
      const r = await this.conn.query(`
        SELECT e.oid, e.extname AS name, e.extversion AS version
          FROM pg_extension e
         ORDER BY e.extname
      `);
      return r.rows.map((row) => ({
        oid: Number(row.oid),
        name: String(row.name),
        version: String(row.version),
      }));
    }) as Promise<ExtensionRow[]>;
  }

  async roles(): Promise<RoleRow[]> {
    return this.cache.getOrLoad("roles", async () => {
      const r = await this.conn.query(`
        SELECT r.oid, r.rolname AS name, r.rolsuper, r.rolcanlogin, r.rolinherit
          FROM pg_roles r
         ORDER BY r.rolname
      `);
      return r.rows.map((row) => ({
        oid: Number(row.oid),
        name: String(row.name),
        super: Boolean(row.rolsuper),
        canLogin: Boolean(row.rolcanlogin),
        inherit: Boolean(row.rolinherit),
      }));
    }) as Promise<RoleRow[]>;
  }

  /** Top-N row browse for the result-grid preview (US5 T090). */
  async browseRows(fqIdent: string, limit: number, offset = 0): Promise<{
    columns: string[];
    rows: Record<string, unknown>[];
  }> {
    // Identifier interpolation is acceptable here because the caller built
    // `fqIdent` from quoteIdent() on catalog-sourced names.
    const r = await this.conn.query(
      `SELECT * FROM ${fqIdent} LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return {
      columns: r.fields.map((f) => f.name),
      rows: r.rows as Record<string, unknown>[],
    };
  }

  async countRows(fqIdent: string): Promise<number> {
    const r = await this.conn.query(`SELECT count(*) AS n FROM ${fqIdent}`);
    return Number((r.rows[0] as Record<string, unknown>)["n"] ?? 0);
  }
}

/** Quote a PostgreSQL identifier per the standard rules (FR-023). */
export function quoteIdent(name: string): string {
  // Conservative: always quote, doubling embedded double quotes.
  return `"${name.replace(/"/g, '""')}"`;
}

/** Build a schema-qualified, properly-quoted identifier. */
export function qualifyIdent(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/**
 * Coerce a pg-driver column value into a `string[]`. Defensive against
 * the three shapes a `text[]`-shaped column may arrive as:
 *   1. `null` / `undefined` — empty array.
 *   2. a real JS array (the happy path when pg has a parser for the
 *      element type; the introspection queries cast to `text` so this
 *      is what we expect).
 *   3. a Postgres array literal like `"{a,b,c}"` — happens when the
 *      element type's parser isn't registered (legacy fallback for
 *      `name[]`). Parsed defensively below.
 */
export function toStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((x) => String(x));
  if (typeof value === "string") {
    // Postgres array literal: "{a,b,c}" or "{}" — naive split that
    // does NOT handle quoted elements containing commas, which is fine
    // for our SQL-identifier inputs (identifiers can't contain commas
    // without being double-quoted, and we cast to text upstream so this
    // branch is only a defensive fallback).
    const trimmed = value.replace(/^\{|\}$/g, "");
    if (trimmed.length === 0) return [];
    return trimmed.split(",").map((s) => s.replace(/^"|"$/g, ""));
  }
  return [String(value)];
}
