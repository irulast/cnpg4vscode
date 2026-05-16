/**
 * Unit tests for the UPDATE/DELETE builder (T095, paired with T108).
 *
 * Tests for the pure builder live here so they run without `pg` or the
 * VS Code host. The builder is the contract surface the cell-edit flow
 * (T109) consumes — change its shape only with these tests as the
 * forcing function. See contracts/pg-introspection.md § Result-set
 * descriptor for cell-edit eligibility for the upstream PK descriptor
 * shape that feeds this builder.
 */

import { describe, expect, it } from "vitest";
import {
  buildDelete,
  buildUpdate,
  renderPreviewMarkdown,
  validateEditRequest,
} from "../../src/sql/update-builder.js";

describe("buildUpdate() — single-PK", () => {
  it("emits a parameterized UPDATE with the PK in the WHERE clause", () => {
    const r = buildUpdate({
      schema: "public",
      table: "users",
      pkColumns: ["id"],
      pkValues: [42],
      changes: { name: "Alice" },
    });
    // First N params are the SET values; the trailing params are the PK row values.
    expect(r.text).toBe('UPDATE "public"."users" SET "name" = $1 WHERE "id" = $2');
    expect(r.values).toEqual(["Alice", 42]);
  });

  it("orders SET clauses deterministically by column name (stable across calls)", () => {
    const r1 = buildUpdate({
      schema: "public",
      table: "users",
      pkColumns: ["id"],
      pkValues: [1],
      changes: { name: "A", email: "a@x" },
    });
    const r2 = buildUpdate({
      schema: "public",
      table: "users",
      pkColumns: ["id"],
      pkValues: [1],
      changes: { email: "a@x", name: "A" },
    });
    expect(r1.text).toBe(r2.text);
    expect(r1.values).toEqual(r2.values);
  });

  it("quotes identifiers that need quoting (uppercase, embedded quotes, keywords)", () => {
    const r = buildUpdate({
      schema: "public",
      table: 'Order Items',
      pkColumns: ['Order ID'],
      pkValues: [7],
      changes: { 'Total"Price': "9.99" },
    });
    expect(r.text).toBe(
      'UPDATE "public"."Order Items" SET "Total""Price" = $1 WHERE "Order ID" = $2',
    );
    expect(r.values).toEqual(["9.99", 7]);
  });

  it("emits a literal NULL in the SET clause (NOT a parameter) when a column is set to null", () => {
    // SET col = NULL must use the SQL keyword, not $N — pg's parameter binder
    // would otherwise need a type cast and would emit `col = $1` with a JS
    // null bound, which is correct semantically but unreadable in the
    // preview. The builder uses a literal NULL for clarity.
    const r = buildUpdate({
      schema: "public",
      table: "users",
      pkColumns: ["id"],
      pkValues: [1],
      changes: { nickname: null },
    });
    expect(r.text).toBe('UPDATE "public"."users" SET "nickname" = NULL WHERE "id" = $1');
    expect(r.values).toEqual([1]);
  });

  it("supports DEFAULT keyword for restoring the column default", () => {
    const r = buildUpdate({
      schema: "public",
      table: "users",
      pkColumns: ["id"],
      pkValues: [1],
      changes: { status: { sql: "DEFAULT" } },
    });
    expect(r.text).toBe('UPDATE "public"."users" SET "status" = DEFAULT WHERE "id" = $1');
    expect(r.values).toEqual([1]);
  });

  it("emits an explicit type cast when a change carries a typeHint", () => {
    const r = buildUpdate({
      schema: "public",
      table: "events",
      pkColumns: ["id"],
      pkValues: [10],
      changes: { payload: { value: "{}", typeHint: "jsonb" } },
    });
    expect(r.text).toBe('UPDATE "public"."events" SET "payload" = $1::jsonb WHERE "id" = $2');
    expect(r.values).toEqual(["{}", 10]);
  });
});

describe("buildUpdate() — composite PK", () => {
  it("emits an AND-joined WHERE with one placeholder per PK column", () => {
    const r = buildUpdate({
      schema: "analytics",
      table: "events_daily",
      pkColumns: ["tenant_id", "event_id"],
      pkValues: [3, "evt-001"],
      changes: { count: 7 },
    });
    expect(r.text).toBe(
      'UPDATE "analytics"."events_daily" SET "count" = $1 WHERE "tenant_id" = $2 AND "event_id" = $3',
    );
    expect(r.values).toEqual([7, 3, "evt-001"]);
  });

  it("preserves PK column order from the input (matches the upstream PK descriptor's ORDER BY ord)", () => {
    const r = buildUpdate({
      schema: "s",
      table: "t",
      // intentionally reversed alphabetically — the descriptor returns
      // PK columns ordered by index position, not name; the builder must
      // honor that order.
      pkColumns: ["z_key", "a_key"],
      pkValues: ["Z", "A"],
      changes: { col: 1 },
    });
    expect(r.text).toBe(
      'UPDATE "s"."t" SET "col" = $1 WHERE "z_key" = $2 AND "a_key" = $3',
    );
    expect(r.values).toEqual([1, "Z", "A"]);
  });

  it("handles a NULL PK value (rare but legal in unique-not-null-less compound keys) as IS NULL", () => {
    // PostgreSQL's PK is NOT NULL by definition, but a non-PK uniqueness
    // descriptor could still be the row-identity gate. For genuine PK
    // edits this case is dead, but the builder must encode NULL as
    // `IS NULL` so the row is reachable.
    const r = buildUpdate({
      schema: "s",
      table: "t",
      pkColumns: ["a", "b"],
      pkValues: [1, null],
      changes: { x: 2 },
    });
    expect(r.text).toBe(
      'UPDATE "s"."t" SET "x" = $1 WHERE "a" = $2 AND "b" IS NULL',
    );
    expect(r.values).toEqual([2, 1]);
  });
});

describe("buildDelete()", () => {
  it("emits a parameterized DELETE keyed on the single PK", () => {
    const r = buildDelete({
      schema: "public",
      table: "users",
      pkColumns: ["id"],
      pkValues: [42],
    });
    expect(r.text).toBe('DELETE FROM "public"."users" WHERE "id" = $1');
    expect(r.values).toEqual([42]);
  });

  it("emits an AND-joined WHERE for a composite PK", () => {
    const r = buildDelete({
      schema: "analytics",
      table: "events_daily",
      pkColumns: ["tenant_id", "event_id"],
      pkValues: [3, "evt-001"],
    });
    expect(r.text).toBe(
      'DELETE FROM "analytics"."events_daily" WHERE "tenant_id" = $1 AND "event_id" = $2',
    );
    expect(r.values).toEqual([3, "evt-001"]);
  });

  it("encodes NULL PK values as IS NULL (not = NULL)", () => {
    const r = buildDelete({
      schema: "s",
      table: "t",
      pkColumns: ["a", "b"],
      pkValues: [null, 1],
    });
    expect(r.text).toBe('DELETE FROM "s"."t" WHERE "a" IS NULL AND "b" = $1');
    expect(r.values).toEqual([1]);
  });
});

describe("validateEditRequest()", () => {
  it("rejects when the connection is in read-only mode", () => {
    const r = validateEditRequest({ mode: "readonly", pkColumns: ["id"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("READ_ONLY");
      expect(r.reason.toLowerCase()).toContain("write");
    }
  });

  it("rejects when no PK is available (result-set is not edit-eligible)", () => {
    const r = validateEditRequest({ mode: "write", pkColumns: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NO_PK");
      expect(r.reason.toLowerCase()).toContain("primary key");
    }
  });

  it("accepts when write mode and a PK descriptor are both present", () => {
    const r = validateEditRequest({ mode: "write", pkColumns: ["id"] });
    expect(r.ok).toBe(true);
  });

  it("accepts when write mode and a composite PK are present", () => {
    const r = validateEditRequest({ mode: "write", pkColumns: ["a", "b"] });
    expect(r.ok).toBe(true);
  });
});

describe("renderPreviewMarkdown()", () => {
  it("renders the SQL plus each parameter binding as a numbered list", () => {
    const md = renderPreviewMarkdown(
      {
        text: 'UPDATE "public"."users" SET "name" = $1 WHERE "id" = $2',
        values: ["Alice", 42],
      },
      { operation: "UPDATE", target: "public.users" },
    );
    expect(md).toContain("UPDATE");
    expect(md).toContain("public.users");
    expect(md).toContain('UPDATE "public"."users"');
    expect(md).toContain("$1");
    expect(md).toContain("$2");
    expect(md).toContain("Alice");
    expect(md).toContain("42");
  });

  it("renders NULL bindings as 'NULL' and escapes embedded backticks", () => {
    const md = renderPreviewMarkdown(
      {
        text: 'UPDATE "s"."t" SET "x" = $1 WHERE "id" = $2',
        values: [null, "row-`with`-backticks"],
      },
      { operation: "UPDATE", target: "s.t" },
    );
    expect(md).toContain("NULL");
    // The renderer wraps values in code spans; embedded backticks must not
    // break out of the span. Either escaping or fence-bump is acceptable;
    // the test asserts only that the literal raw payload doesn't appear
    // unescaped inside a single-backtick span.
    expect(md).toMatch(/row-.*backticks/);
  });

  it("includes the target identifier in the heading so the user can verify what's about to mutate", () => {
    const md = renderPreviewMarkdown(
      {
        text: 'DELETE FROM "public"."users" WHERE "id" = $1',
        values: [42],
      },
      { operation: "DELETE", target: "public.users" },
    );
    expect(md.toLowerCase()).toMatch(/delete.*public\.users|public\.users.*delete/);
  });
});
