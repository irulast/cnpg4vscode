import { describe, expect, it } from "vitest";
import {
  buildMermaidErDiagram,
  ErTable,
  ErForeignKey,
  sanitizeIdent,
  sanitizeMermaidType,
  sanitizeColumnName,
} from "../../src/ui/er-diagram-render.js";

const usersTable: ErTable = {
  oid: 1,
  name: "users",
  schema: "public",
  columns: [
    { name: "id", type: "bigserial", isPk: true, notNull: true },
    { name: "name", type: "varchar(64)", isPk: false, notNull: true },
    { name: "created_at", type: "timestamptz", isPk: false, notNull: true },
  ],
};

const ordersTable: ErTable = {
  oid: 2,
  name: "orders",
  schema: "public",
  columns: [
    { name: "id", type: "bigserial", isPk: true, notNull: true },
    { name: "user_id", type: "bigint", isPk: false, notNull: true },
    { name: "amount", type: "numeric(10,2)", isPk: false, notNull: false },
  ],
};

const fkOrdersUser: ErForeignKey = {
  fromOid: 2,
  toOid: 1,
  fromColumns: ["user_id"],
  toColumns: ["id"],
  name: "orders_user_id_fkey",
};

describe("buildMermaidErDiagram()", () => {
  it("starts with an erDiagram header", () => {
    const md = buildMermaidErDiagram([usersTable], []);
    expect(md.split("\n")[0]).toMatch(/```mermaid/);
    expect(md).toContain("erDiagram");
  });

  it("emits one entity block per table with column rows", () => {
    const md = buildMermaidErDiagram([usersTable, ordersTable], []);
    expect(md).toMatch(/public_users\s*\{[\s\S]*?\}/);
    expect(md).toMatch(/public_orders\s*\{[\s\S]*?\}/);
    expect(md).toContain("bigserial id PK");
    // Non-attribute-word types (varchar(64), numeric(10,2), etc.) are
    // normalized in the type slot and preserved as a Mermaid comment.
    expect(md).toContain('varchar name "varchar(64)"');
    expect(md).toContain("bigint user_id");
  });

  it("emits a relationship line per foreign key, defaulting to one-to-many", () => {
    const md = buildMermaidErDiagram([usersTable, ordersTable], [fkOrdersUser]);
    // users (parent / target) ||--o{ orders (child / source)
    expect(md).toMatch(/public_users\s+\|\|--o\{\s+public_orders\s*:\s*"user_id"/);
  });

  it("escapes PG identifiers that Mermaid cannot parse raw (camelCase, dots, hyphens)", () => {
    const tricky: ErTable = {
      oid: 3,
      schema: "weird-schema",
      name: "Quote\"Name",
      columns: [{ name: "id", type: "int", isPk: true, notNull: true }],
    };
    const md = buildMermaidErDiagram([tricky], []);
    // No raw dots, hyphens, or quotes leak into the entity name.
    const entityName = sanitizeIdent("weird-schema", 'Quote"Name');
    expect(md).toContain(entityName);
    expect(md).not.toMatch(/weird-schema\s*\{/);
  });

  it("renders a 'no tables' message when given an empty table set", () => {
    const md = buildMermaidErDiagram([], []);
    expect(md.toLowerCase()).toContain("no tables");
  });

  it("renders an isolated table even with no FKs (no orphan relationships)", () => {
    const md = buildMermaidErDiagram([usersTable], []);
    expect(md).not.toMatch(/\|\|--/);
    expect(md).toContain("public_users");
  });

  it("orders entities and FKs deterministically for snapshot-friendly output", () => {
    const a = buildMermaidErDiagram([usersTable, ordersTable], [fkOrdersUser]);
    const b = buildMermaidErDiagram([ordersTable, usersTable], [fkOrdersUser]);
    expect(a).toBe(b);
  });

  it("includes the cnpg4vscode source comment so users know what generated the diagram", () => {
    const md = buildMermaidErDiagram([usersTable], []);
    expect(md).toMatch(/cnpg4vscode/);
  });

  it("surfaces a friendly warning when over the configured table threshold", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...usersTable,
      oid: 100 + i,
      name: `table_${i}`,
    }));
    const md = buildMermaidErDiagram(many, [], { warnOverTables: 50 });
    expect(md.toLowerCase()).toContain("60 tables");
    expect(md.toLowerCase()).toMatch(/scope|limit|narrow/);
  });
});

describe("sanitizeIdent()", () => {
  it("joins schema + table with underscore and replaces unsafe chars", () => {
    expect(sanitizeIdent("public", "users")).toBe("public_users");
    expect(sanitizeIdent("weird-schema", "Quote\"Name")).toMatch(/^weird_schema_Quote_+Name$/);
  });

  it("prefixes leading digits so Mermaid accepts the identifier", () => {
    expect(sanitizeIdent("1schema", "table")).toMatch(/^_1schema_table$/);
  });
});

describe("sanitizeMermaidType() — PG type normalization", () => {
  it("passes simple types through unchanged", () => {
    expect(sanitizeMermaidType("text")).toBe("text");
    expect(sanitizeMermaidType("bigint")).toBe("bigint");
    expect(sanitizeMermaidType("uuid")).toBe("uuid");
  });

  it("normalizes multi-word types (the actual ER-render bug)", () => {
    // These all crashed Mermaid's erDiagram parser when quoted.
    expect(sanitizeMermaidType("timestamp with time zone")).toBe("timestamp_with_time_zone");
    expect(sanitizeMermaidType("timestamp without time zone")).toBe("timestamp_without_time_zone");
    expect(sanitizeMermaidType("double precision")).toBe("double_precision");
    expect(sanitizeMermaidType("character varying")).toBe("character_varying");
  });

  it("drops parenthesized precision modifiers", () => {
    expect(sanitizeMermaidType("varchar(64)")).toBe("varchar");
    expect(sanitizeMermaidType("numeric(10,2)")).toBe("numeric");
    expect(sanitizeMermaidType("numeric(12,2)")).toBe("numeric");
    expect(sanitizeMermaidType("character varying(255)")).toBe("character_varying");
    expect(sanitizeMermaidType("geometry(Point,4326)")).toBe("geometry");
  });

  it("converts array notation to an _array suffix", () => {
    expect(sanitizeMermaidType("text[]")).toBe("text_array");
    expect(sanitizeMermaidType("int4[]")).toBe("int4_array");
    expect(sanitizeMermaidType("uuid[]")).toBe("uuid_array");
  });

  it("prefixes leading-digit results so Mermaid accepts the type", () => {
    // (Unlikely in PG but defensive.)
    expect(sanitizeMermaidType("1custom_type")).toMatch(/^_1custom_type$/);
  });

  it("falls back to `unknown` for empty / all-symbol input", () => {
    expect(sanitizeMermaidType("")).toBe("unknown");
    expect(sanitizeMermaidType("()")).toBe("unknown");
    expect(sanitizeMermaidType("---")).toBe("unknown");
  });
});

describe("sanitizeColumnName()", () => {
  it("passes normal PG identifiers through", () => {
    expect(sanitizeColumnName("user_id")).toBe("user_id");
    expect(sanitizeColumnName("CamelCase")).toBe("CamelCase");
  });

  it("normalizes spaces and punctuation in quoted PG identifiers", () => {
    // PG allows `CREATE TABLE t ("My Col" text)` — attname returns `My Col`.
    expect(sanitizeColumnName("My Col")).toBe("My_Col");
    expect(sanitizeColumnName("weird-col")).toBe("weird_col");
  });

  it("falls back to `column` for all-symbol input", () => {
    expect(sanitizeColumnName("")).toBe("column");
    expect(sanitizeColumnName("---")).toBe("column");
  });
});

describe("buildMermaidErDiagram() — regression: real-world type names", () => {
  it("renders timestamp/varchar/numeric/array types without parse errors", () => {
    const wide: ErTable = {
      oid: 99,
      schema: "labrant_warehouse",
      name: "dim_actor",
      columns: [
        { name: "id", type: "uuid", isPk: true, notNull: true },
        { name: "name", type: "text", isPk: false, notNull: false },
        { name: "loaded_at", type: "timestamp with time zone", isPk: false, notNull: false },
        { name: "amount", type: "numeric(10,2)", isPk: false, notNull: false },
        { name: "tags", type: "text[]", isPk: false, notNull: false },
        { name: "location", type: "geometry(Point,4326)", isPk: false, notNull: false },
        { name: "lat", type: "double precision", isPk: false, notNull: false },
      ],
    };
    const md = buildMermaidErDiagram([wide], []);
    // Type slot is an alphanumeric ATTRIBUTE_WORD.
    expect(md).toMatch(/timestamp_with_time_zone loaded_at/);
    expect(md).toMatch(/numeric amount/);
    expect(md).toMatch(/text_array tags/);
    expect(md).toMatch(/geometry location/);
    expect(md).toMatch(/double_precision lat/);
    // No quoted multi-word type leaks into the column-definition position.
    expect(md).not.toMatch(/^\s+"timestamp with time zone"/m);
    expect(md).not.toMatch(/^\s+"numeric\(10,2\)"/m);
    // Original types preserved as Mermaid comments.
    expect(md).toContain('"timestamp with time zone"');
    expect(md).toContain('"numeric(10,2)"');
    expect(md).toContain('"text[]"');
  });
});
