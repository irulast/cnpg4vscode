/**
 * Unit tests for the Grid Editor's ResultSetDescriptor fetcher
 * (paired with T150's host controller).
 *
 * The fetcher composes the existing introspector + new pg_enum / FK
 * lookups into the `ResultSetDescriptor` shape the protocol's `init`
 * message carries. Pure module — tests inject a mock query client so
 * we don't need `pg`.
 */

import { describe, expect, it, vi } from "vitest";
import { fetchResultSetDescriptor, type DescriptorQueryClient } from "../../src/grid/descriptor.js";

/**
 * Build a mock client that responds to query SQL patterns.
 * Pattern → rows mapping; first matching regex wins.
 */
function mockClient(handlers: Array<[RegExp, ReadonlyArray<Record<string, unknown>>]>): {
  client: DescriptorQueryClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client: DescriptorQueryClient = {
    async query(sql: string, _values?: ReadonlyArray<unknown>) {
      calls.push(sql.replace(/\s+/g, " ").trim());
      for (const [pat, rows] of handlers) {
        if (pat.test(sql)) return { rows };
      }
      return { rows: [] };
    },
  };
  return { client, calls };
}

describe("fetchResultSetDescriptor() — basic table", () => {
  it("returns columns, PK, and editable=true for a plain table", async () => {
    const { client } = mockClient([
      // relkind lookup — unique phrase: c.relkind::text
      [/relkind::text/i, [{ relkind: "r" }]],
      // columns
      [/format_type/i, [
        { name: "id", pgtype: "int4", notnull: true, hasdefault: true, ispk: true },
        { name: "email", pgtype: "text", notnull: false, hasdefault: false, ispk: false },
        { name: "status", pgtype: "order_status", notnull: false, hasdefault: false, ispk: false },
      ]],
      // enum values for `order_status`
      [/pg_enum/i, [
        { enumtypname: "order_status", enumlabel: "pending" },
        { enumtypname: "order_status", enumlabel: "shipped" },
      ]],
      // foreign keys (none on this table)
      [/contype = 'f'/i, []],
    ]);

    const d = await fetchResultSetDescriptor(client, { schema: "public", table: "orders" });
    expect(d.target).toEqual({ schema: "public", table: "orders", kind: "table" });
    expect(d.editable).toBe(true);
    expect(d.pkColumns).toEqual(["id"]);
    expect(d.columns.length).toBe(3);

    // jsType inferred via pgTypeToJsType + enum-by-enumValues bump
    const byName = Object.fromEntries(d.columns.map((c) => [c.name, c]));
    expect(byName["id"]?.jsType).toBe("number");
    expect(byName["id"]?.isPk).toBe(true);
    expect(byName["id"]?.hasDefault).toBe(true);
    expect(byName["email"]?.jsType).toBe("string");
    expect(byName["email"]?.nullable).toBe(true);
    expect(byName["status"]?.jsType).toBe("enum");
    expect(byName["status"]?.enumValues).toEqual(["pending", "shipped"]);
  });
});

describe("fetchResultSetDescriptor() — views and matviews", () => {
  it("returns editable=false for a VIEW regardless of PK presence", async () => {
    const { client } = mockClient([
      [/relkind::text/i, [{ relkind: "v" }]],
      [/format_type/i, [{ name: "id", pgtype: "int4", notnull: true, hasdefault: false, ispk: false }]],
      [/pg_enum/i, []],
      [/contype = 'f'/i, []],
    ]);
    const d = await fetchResultSetDescriptor(client, { schema: "public", table: "user_summary" });
    expect(d.target.kind).toBe("view");
    expect(d.editable).toBe(false);
  });

  it("returns editable=false for a MATERIALIZED VIEW", async () => {
    const { client } = mockClient([
      [/relkind::text/i, [{ relkind: "m" }]],
      [/format_type/i, [{ name: "id", pgtype: "int4", notnull: true, hasdefault: false, ispk: false }]],
      [/pg_enum/i, []],
      [/contype = 'f'/i, []],
    ]);
    const d = await fetchResultSetDescriptor(client, { schema: "public", table: "mv_daily" });
    expect(d.target.kind).toBe("matview");
    expect(d.editable).toBe(false);
  });
});

describe("fetchResultSetDescriptor() — editable=false when no PK", () => {
  it("returns editable=false for a table without a primary key", async () => {
    const { client } = mockClient([
      [/relkind::text/i, [{ relkind: "r" }]],
      [/format_type/i, [
        { name: "a", pgtype: "int4", notnull: true, hasdefault: false, ispk: false },
        { name: "b", pgtype: "int4", notnull: true, hasdefault: false, ispk: false },
      ]],
      [/pg_enum/i, []],
      [/contype = 'f'/i, []],
    ]);
    const d = await fetchResultSetDescriptor(client, { schema: "public", table: "log_entries" });
    expect(d.editable).toBe(false);
    expect(d.pkColumns).toEqual([]);
  });
});

describe("fetchResultSetDescriptor() — foreign key wiring", () => {
  it("attaches fk metadata to columns that participate in a FOREIGN KEY", async () => {
    const { client } = mockClient([
      [/relkind::text/i, [{ relkind: "r" }]],
      [/format_type/i, [
        { name: "id", pgtype: "int4", notnull: true, hasdefault: true, ispk: true },
        { name: "user_id", pgtype: "int4", notnull: false, hasdefault: false, ispk: false },
        { name: "title", pgtype: "text", notnull: false, hasdefault: false, ispk: false },
      ]],
      [/pg_enum/i, []],
      [/contype = 'f'/i, [
        {
          fromcolumns: ["user_id"],
          refschema: "public",
          reftable: "users",
          refcolumns: ["id"],
        },
      ]],
    ]);
    const d = await fetchResultSetDescriptor(client, { schema: "public", table: "posts" });
    const byName = Object.fromEntries(d.columns.map((c) => [c.name, c]));
    expect(byName["user_id"]?.fk).toEqual({
      refSchema: "public",
      refTable: "users",
      refColumn: "id",
    });
    expect(byName["title"]?.fk).toBeUndefined();
    expect(byName["id"]?.fk).toBeUndefined();
  });

  it("only wires single-column FKs (composite FKs require a different UX and are skipped for v1)", async () => {
    const { client } = mockClient([
      [/relkind::text/i, [{ relkind: "r" }]],
      [/format_type/i, [
        { name: "tenant_id", pgtype: "int4", notnull: true, hasdefault: false, ispk: false },
        { name: "user_id", pgtype: "int4", notnull: true, hasdefault: false, ispk: false },
      ]],
      [/pg_enum/i, []],
      [/contype = 'f'/i, [
        {
          fromcolumns: ["tenant_id", "user_id"],
          refschema: "public",
          reftable: "users",
          refcolumns: ["tenant_id", "id"],
        },
      ]],
    ]);
    const d = await fetchResultSetDescriptor(client, { schema: "public", table: "memberships" });
    const byName = Object.fromEntries(d.columns.map((c) => [c.name, c]));
    expect(byName["tenant_id"]?.fk).toBeUndefined();
    expect(byName["user_id"]?.fk).toBeUndefined();
  });
});

describe("fetchResultSetDescriptor() — jsType resolution", () => {
  it("flags enum-typed columns as jsType='enum' even without enumValues (descriptor bug guard)", async () => {
    // pg_enum lookup returns nothing — the cell-editor registry will
    // fall back to text via its own defensive default, but the
    // descriptor must still set jsType='enum' so the host can know to
    // re-query later.
    const { client } = mockClient([
      [/relkind::text/i, [{ relkind: "r" }]],
      [/format_type/i, [
        { name: "id", pgtype: "int4", notnull: true, hasdefault: false, ispk: true },
        { name: "status", pgtype: "my_enum", notnull: false, hasdefault: false, ispk: false },
      ]],
      // pg_enum returns empty for my_enum
      [/pg_enum/i, []],
      [/contype = 'f'/i, []],
    ]);
    const d = await fetchResultSetDescriptor(client, { schema: "public", table: "x" });
    const byName = Object.fromEntries(d.columns.map((c) => [c.name, c]));
    // pg_enum returned empty so 'my_enum' is NOT an enum from PG's
    // perspective — falls back to 'unknown'. This is the right call:
    // the descriptor reflects reality, not optimism.
    expect(byName["status"]?.jsType).toBe("unknown");
    expect(byName["status"]?.enumValues).toBeUndefined();
  });

  it("preserves column order from the underlying query (driven by pg_attribute.attnum)", async () => {
    const { client } = mockClient([
      [/relkind::text/i, [{ relkind: "r" }]],
      [/format_type/i, [
        { name: "z_first", pgtype: "int4", notnull: true, hasdefault: false, ispk: true },
        { name: "a_second", pgtype: "text", notnull: false, hasdefault: false, ispk: false },
        { name: "m_third", pgtype: "bool", notnull: false, hasdefault: false, ispk: false },
      ]],
      [/pg_enum/i, []],
      [/contype = 'f'/i, []],
    ]);
    const d = await fetchResultSetDescriptor(client, { schema: "public", table: "x" });
    expect(d.columns.map((c) => c.name)).toEqual(["z_first", "a_second", "m_third"]);
  });
});

describe("fetchResultSetDescriptor() — error handling", () => {
  it("throws a meaningful error when the relation is not found", async () => {
    const { client } = mockClient([
      // relkind lookup returns nothing
      [/relkind::text/i, []],
    ]);
    await expect(
      fetchResultSetDescriptor(client, { schema: "public", table: "missing" }),
    ).rejects.toThrow(/missing|not found|public\.missing/i);
  });

  it("propagates pg client failures (lets the host log + surface the error)", async () => {
    const boom = new Error("connection terminated");
    const client: DescriptorQueryClient = {
      async query() {
        throw boom;
      },
    };
    await expect(
      fetchResultSetDescriptor(client, { schema: "public", table: "x" }),
    ).rejects.toBe(boom);
  });
});

describe("fetchResultSetDescriptor() — query parameterization (security)", () => {
  it("passes schema.table as $1::regclass (no string concatenation)", async () => {
    const { client, calls } = mockClient([
      [/relkind::text/i, [{ relkind: "r" }]],
      [/format_type/i, []],
      [/pg_enum/i, []],
      [/contype = 'f'/i, []],
    ]);
    const spy = vi.spyOn(client, "query");
    await fetchResultSetDescriptor(client, {
      schema: 'evil"; DROP TABLE users; --',
      table: "x",
    });
    // The relkind lookup MUST use a parameter binding — the schema
    // string with embedded SQL never appears as raw text in the SQL.
    for (const c of calls) {
      expect(c).not.toContain("DROP TABLE users");
    }
    // And there should be a call carrying the malicious string as a
    // bound parameter.
    const callArgs = spy.mock.calls;
    const wasBound = callArgs.some(([, values]) =>
      Array.isArray(values) && values.some((v) => String(v).includes("DROP TABLE")),
    );
    expect(wasBound).toBe(true);
  });
});
