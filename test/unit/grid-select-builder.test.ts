/**
 * Unit tests for the Grid Editor's SELECT-builder driver (T139, paired with T148).
 *
 * The Grid Editor host owns SQL composition for its page loads. Given a
 * structured request (schema/table + optional sort + optional filters +
 * limit + offset), the builder emits a parameterized SELECT and a
 * parallel `count(*)` for the totalRows footer. Pure module, no `pg`,
 * no `vscode`.
 *
 * Critical security invariant: filter values bind as `$N` parameters,
 * NEVER concatenate into SQL text. Filter `op` is matched against a
 * frozen enum — anything else is rejected. The grid's renderer can't
 * smuggle SQL through the persisted state's filter list.
 */

import { describe, expect, it } from "vitest";
import {
  buildSelectPage,
  buildSelectCount,
  type SelectPageRequest,
} from "../../src/sql/select-builder.js";

const BASE: Pick<SelectPageRequest, "schema" | "table" | "columns"> = {
  schema: "public",
  table: "users",
  columns: ["id", "email", "name"],
};

describe("buildSelectPage() — basics", () => {
  it("emits a SELECT with quoted identifiers and a deterministic column list", () => {
    const r = buildSelectPage({ ...BASE, limit: 100, offset: 0 });
    expect(r.text).toBe(
      'SELECT "id", "email", "name" FROM "public"."users" LIMIT 100 OFFSET 0',
    );
    expect(r.values).toEqual([]);
  });

  it("preserves column-list order (does NOT alphabetise — order matters for the grid)", () => {
    const r = buildSelectPage({
      ...BASE,
      columns: ["name", "email", "id"], // reversed
      limit: 100,
      offset: 0,
    });
    expect(r.text).toMatch(/^SELECT "name", "email", "id" FROM/);
  });

  it("quotes case-sensitive and whitespace-y identifiers", () => {
    const r = buildSelectPage({
      schema: "My Schema",
      table: "Order Items",
      columns: ['Order ID', 'Total"Price'],
      limit: 100,
      offset: 0,
    });
    expect(r.text).toBe(
      'SELECT "Order ID", "Total""Price" FROM "My Schema"."Order Items" LIMIT 100 OFFSET 0',
    );
  });

  it("uses SELECT * when columns is omitted (initial load before descriptor lands)", () => {
    const r = buildSelectPage({
      schema: "public",
      table: "users",
      limit: 100,
      offset: 0,
    });
    expect(r.text).toBe('SELECT * FROM "public"."users" LIMIT 100 OFFSET 0');
  });
});

describe("buildSelectPage() — sort", () => {
  it("emits a single-column ORDER BY", () => {
    const r = buildSelectPage({
      ...BASE,
      sort: [{ column: "created_at", dir: "desc" }],
      limit: 100,
      offset: 0,
    });
    expect(r.text).toContain('ORDER BY "created_at" DESC');
  });

  it("emits a multi-column ORDER BY preserving precedence", () => {
    const r = buildSelectPage({
      ...BASE,
      sort: [
        { column: "tenant_id", dir: "asc" },
        { column: "created_at", dir: "desc" },
      ],
      limit: 100,
      offset: 0,
    });
    expect(r.text).toContain(
      'ORDER BY "tenant_id" ASC, "created_at" DESC',
    );
  });

  it("ORDER BY appears BEFORE LIMIT/OFFSET", () => {
    const r = buildSelectPage({
      ...BASE,
      sort: [{ column: "id", dir: "asc" }],
      limit: 50,
      offset: 100,
    });
    const orderIdx = r.text.indexOf("ORDER BY");
    const limitIdx = r.text.indexOf("LIMIT");
    expect(orderIdx).toBeGreaterThan(-1);
    expect(limitIdx).toBeGreaterThan(orderIdx);
  });

  it("emits no ORDER BY clause when sort is empty", () => {
    const r = buildSelectPage({ ...BASE, sort: [], limit: 100, offset: 0 });
    expect(r.text).not.toContain("ORDER BY");
  });

  it("quotes case-sensitive sort columns", () => {
    const r = buildSelectPage({
      ...BASE,
      sort: [{ column: 'Created At', dir: "asc" }],
      limit: 100,
      offset: 0,
    });
    expect(r.text).toContain('ORDER BY "Created At" ASC');
  });
});

describe("buildSelectPage() — filters (every op)", () => {
  it("emits = with a parameter binding", () => {
    const r = buildSelectPage({
      ...BASE,
      filters: [{ column: "active", op: "eq", value: "true" }],
      limit: 100,
      offset: 0,
    });
    expect(r.text).toContain('WHERE "active" = $1');
    expect(r.values).toEqual(["true"]);
  });

  it("emits all comparison ops correctly", () => {
    const ops = [
      ["ne", "!="],
      ["lt", "<"],
      ["le", "<="],
      ["gt", ">"],
      ["ge", ">="],
    ] as const;
    for (const [op, sqlOp] of ops) {
      const r = buildSelectPage({
        ...BASE,
        filters: [{ column: "x", op, value: "5" }],
        limit: 100,
        offset: 0,
      });
      expect(r.text).toContain(`WHERE "x" ${sqlOp} $1`);
      expect(r.values).toEqual(["5"]);
    }
  });

  it("emits LIKE and ILIKE", () => {
    const r1 = buildSelectPage({
      ...BASE,
      filters: [{ column: "email", op: "like", value: "%@x.com" }],
      limit: 100,
      offset: 0,
    });
    expect(r1.text).toContain('WHERE "email" LIKE $1');
    expect(r1.values).toEqual(["%@x.com"]);

    const r2 = buildSelectPage({
      ...BASE,
      filters: [{ column: "email", op: "ilike", value: "%@X.com" }],
      limit: 100,
      offset: 0,
    });
    expect(r2.text).toContain('WHERE "email" ILIKE $1');
    expect(r2.values).toEqual(["%@X.com"]);
  });

  it("emits IS NULL / IS NOT NULL without binding a parameter", () => {
    const r1 = buildSelectPage({
      ...BASE,
      filters: [{ column: "deleted_at", op: "is_null" }],
      limit: 100,
      offset: 0,
    });
    expect(r1.text).toContain('WHERE "deleted_at" IS NULL');
    expect(r1.values).toEqual([]);

    const r2 = buildSelectPage({
      ...BASE,
      filters: [{ column: "deleted_at", op: "is_not_null" }],
      limit: 100,
      offset: 0,
    });
    expect(r2.text).toContain('WHERE "deleted_at" IS NOT NULL');
    expect(r2.values).toEqual([]);
  });

  it("AND-joins multiple filters with correct placeholder numbering", () => {
    const r = buildSelectPage({
      ...BASE,
      filters: [
        { column: "tenant_id", op: "eq", value: "1" },
        { column: "active", op: "eq", value: "true" },
        { column: "deleted_at", op: "is_null" },
      ],
      limit: 100,
      offset: 0,
    });
    expect(r.text).toContain(
      'WHERE "tenant_id" = $1 AND "active" = $2 AND "deleted_at" IS NULL',
    );
    expect(r.values).toEqual(["1", "true"]);
  });

  it("WHERE appears BEFORE ORDER BY", () => {
    const r = buildSelectPage({
      ...BASE,
      filters: [{ column: "active", op: "eq", value: "true" }],
      sort: [{ column: "created_at", dir: "desc" }],
      limit: 100,
      offset: 0,
    });
    const whereIdx = r.text.indexOf("WHERE");
    const orderIdx = r.text.indexOf("ORDER BY");
    expect(whereIdx).toBeGreaterThan(-1);
    expect(orderIdx).toBeGreaterThan(whereIdx);
  });
});

describe("buildSelectPage() — filter values are NEVER concatenated into SQL (injection guard)", () => {
  it("a filter value containing SQL syntax binds as a parameter, not as text", () => {
    const r = buildSelectPage({
      ...BASE,
      filters: [
        { column: "name", op: "eq", value: "Robert'); DROP TABLE users;--" },
      ],
      limit: 100,
      offset: 0,
    });
    expect(r.text).toContain('WHERE "name" = $1');
    expect(r.text).not.toContain("DROP TABLE");
    expect(r.values).toEqual(["Robert'); DROP TABLE users;--"]);
  });

  it("an unrecognised filter op is silently dropped (defense in depth — the persisted-state allowlist already filters these, but the builder defends too)", () => {
    const r = buildSelectPage({
      ...BASE,
      filters: [
        { column: "x", op: "eq", value: "1" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { column: "x", op: "; DROP TABLE users" as any, value: "1" },
      ],
      limit: 100,
      offset: 0,
    });
    expect(r.text).toContain('WHERE "x" = $1');
    expect(r.text).not.toContain("DROP TABLE");
    expect(r.values).toEqual(["1"]);
  });

  it("an unquoted dangerous column identifier still gets quoted (the renderer can't smuggle SQL through the column-name field)", () => {
    const r = buildSelectPage({
      ...BASE,
      filters: [
        { column: 'x"; DROP TABLE users; --', op: "eq", value: "1" },
      ],
      limit: 100,
      offset: 0,
    });
    // quoteIdent doubles the embedded `"`, neutralising the close-quote.
    expect(r.text).toContain('"x""; DROP TABLE users; --"');
    // No bare DROP escapes the quoted identifier — outside the quotes
    // the only text is `WHERE … = $1`.
    expect(r.text).toMatch(/WHERE "x"".*?" = \$1 LIMIT 100 OFFSET 0$/);
  });
});

describe("buildSelectPage() — LIMIT / OFFSET", () => {
  it("emits LIMIT and OFFSET as literal integers (not parameterised — they're not user input)", () => {
    const r = buildSelectPage({ ...BASE, limit: 1000, offset: 5000 });
    expect(r.text).toContain("LIMIT 1000 OFFSET 5000");
  });

  it("rejects (returns sanitised values for) negative offset / non-positive limit", () => {
    const r = buildSelectPage({ ...BASE, limit: 0, offset: -5 });
    // Limit clamps to a sensible floor (the renderer would never ask for 0);
    // offset clamps to 0.
    expect(r.text).toMatch(/LIMIT \d+ OFFSET 0/);
  });

  it("caps limit at an upper bound to prevent runaway page sizes", () => {
    const r = buildSelectPage({ ...BASE, limit: 10_000_000, offset: 0 });
    // Spec: page size cap matches the existing `cnpg4vscode.results.pageSize`
    // setting's high-water (research §6 — grid retains current window only).
    // Hard cap is 10k.
    expect(r.text).toMatch(/LIMIT 10000 /);
  });
});

describe("buildSelectCount()", () => {
  it("emits a parallel count(*) with the same WHERE clause", () => {
    const r = buildSelectCount({
      ...BASE,
      filters: [{ column: "active", op: "eq", value: "true" }],
    });
    expect(r.text).toBe(
      'SELECT count(*) AS total FROM "public"."users" WHERE "active" = $1',
    );
    expect(r.values).toEqual(["true"]);
  });

  it("emits without WHERE when no filters", () => {
    const r = buildSelectCount({ ...BASE });
    expect(r.text).toBe('SELECT count(*) AS total FROM "public"."users"');
    expect(r.values).toEqual([]);
  });

  it("does NOT include ORDER BY or LIMIT — they're irrelevant for a count", () => {
    const r = buildSelectCount({
      ...BASE,
      filters: [{ column: "x", op: "eq", value: "1" }],
    });
    expect(r.text).not.toContain("ORDER BY");
    expect(r.text).not.toContain("LIMIT");
  });
});
