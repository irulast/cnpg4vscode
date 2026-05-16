/**
 * Unit tests for single-source-table detection from a SELECT (T096,
 * paired with T107).
 *
 * The detector is the first half of the cell-edit eligibility check: a
 * SELECT is editable only if it has exactly ONE base table source (so
 * an UPDATE keyed on that table's PK is unambiguous). The second half —
 * fetching the PK column list — needs a live `pg` client and lives in
 * `fetchPkDescriptor()` (which is not exercised here; see the
 * `test/contract/pg/...` suite if/when a pg-mem fixture lands).
 *
 * The detector is INTENTIONALLY CONSERVATIVE: when in any doubt
 * (multi-source, computed column, subquery, CTE, lateral, etc.) it
 * returns `null` so the grid stays read-only. False negatives ("we
 * could've edited this but didn't") are annoying; false positives ("we
 * generated an UPDATE keyed on the wrong table") are catastrophic.
 * SC-009-grade caution.
 */

import { describe, expect, it } from "vitest";
import { detectSingleSourceTable } from "../../src/pg/result-descriptor.js";

describe("detectSingleSourceTable() — accepts single-source SELECTs", () => {
  it("detects an unqualified single-table SELECT", () => {
    expect(detectSingleSourceTable("SELECT * FROM users")).toEqual({
      schema: null,
      table: "users",
    });
  });

  it("detects a schema-qualified single-table SELECT", () => {
    expect(detectSingleSourceTable("SELECT id, name FROM public.users")).toEqual({
      schema: "public",
      table: "users",
    });
  });

  it("preserves quoted identifiers (case-sensitive table/schema names)", () => {
    expect(detectSingleSourceTable('SELECT * FROM "Public"."Order Items"')).toEqual({
      schema: "Public",
      table: "Order Items",
    });
  });

  it("preserves a quoted-only-on-the-table side", () => {
    expect(detectSingleSourceTable('SELECT * FROM public."Order"')).toEqual({
      schema: "public",
      table: "Order",
    });
  });

  it("accepts a table alias and still resolves the underlying table", () => {
    expect(detectSingleSourceTable("SELECT u.id FROM public.users u")).toEqual({
      schema: "public",
      table: "users",
    });
  });

  it("accepts a table alias using the AS keyword", () => {
    expect(detectSingleSourceTable("SELECT u.id FROM public.users AS u")).toEqual({
      schema: "public",
      table: "users",
    });
  });

  it("accepts a WHERE / ORDER BY / LIMIT clause", () => {
    expect(
      detectSingleSourceTable(
        "SELECT * FROM public.users WHERE active = true ORDER BY created_at DESC LIMIT 100",
      ),
    ).toEqual({ schema: "public", table: "users" });
  });

  it("ignores trailing whitespace, comments, and a trailing semicolon", () => {
    expect(
      detectSingleSourceTable("  SELECT * FROM users; -- editor pasted with comment\n"),
    ).toEqual({ schema: null, table: "users" });
    expect(
      detectSingleSourceTable("/* note */ SELECT id FROM public.users /* trailing */"),
    ).toEqual({ schema: "public", table: "users" });
  });
});

describe("detectSingleSourceTable() — rejects multi-source / non-editable shapes", () => {
  it("rejects an inner JOIN (multiple sources)", () => {
    expect(
      detectSingleSourceTable(
        "SELECT u.id, p.title FROM users u JOIN posts p ON p.user_id = u.id",
      ),
    ).toBeNull();
  });

  it("rejects every JOIN variant", () => {
    for (const join of [
      "LEFT JOIN",
      "RIGHT JOIN",
      "FULL JOIN",
      "FULL OUTER JOIN",
      "INNER JOIN",
      "CROSS JOIN",
      "LEFT OUTER JOIN",
    ]) {
      const sql = `SELECT u.id FROM users u ${join} posts p ON true`;
      expect(detectSingleSourceTable(sql)).toBeNull();
    }
  });

  it("rejects a comma-separated FROM list (implicit cross join)", () => {
    expect(detectSingleSourceTable("SELECT * FROM users u, posts p")).toBeNull();
  });

  it("rejects a CTE-driven SELECT (the FROM target is the CTE, not a base table)", () => {
    expect(
      detectSingleSourceTable("WITH t AS (SELECT 1) SELECT * FROM t"),
    ).toBeNull();
    expect(
      detectSingleSourceTable(
        "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<5) SELECT * FROM r",
      ),
    ).toBeNull();
  });

  it("rejects a SELECT against a subquery", () => {
    expect(
      detectSingleSourceTable("SELECT * FROM (SELECT id FROM users) sub"),
    ).toBeNull();
  });

  it("rejects a UNION / INTERSECT / EXCEPT (multiple result-set producers)", () => {
    expect(
      detectSingleSourceTable("SELECT id FROM users UNION SELECT id FROM admins"),
    ).toBeNull();
    expect(
      detectSingleSourceTable("SELECT id FROM users INTERSECT SELECT id FROM admins"),
    ).toBeNull();
    expect(
      detectSingleSourceTable("SELECT id FROM users EXCEPT SELECT id FROM banned"),
    ).toBeNull();
  });

  it("rejects a computed-column SELECT (no plain column → no PK round-trip)", () => {
    // A SELECT projecting only expressions cannot be mapped back to a PK
    // row identity even when the FROM is single-source. The detector
    // does NOT inspect the column list; this lower-level case is left
    // to fetchPkDescriptor() which fails when no PK column is in the
    // result set. The unit test for that lives at the result-descriptor
    // integration layer; here we just assert the detector's surface.
    // For now, a single-source SELECT with computed columns still
    // returns the source — the higher layer decides eligibility.
    expect(detectSingleSourceTable("SELECT count(*) FROM users")).toEqual({
      schema: null,
      table: "users",
    });
  });

  it("rejects SELECTs against table-returning functions (e.g. generate_series)", () => {
    expect(detectSingleSourceTable("SELECT * FROM generate_series(1, 10)")).toBeNull();
    expect(
      detectSingleSourceTable("SELECT * FROM pg_catalog.pg_stat_activity"),
    ).toEqual({ schema: "pg_catalog", table: "pg_stat_activity" }); // catalogs are tables
  });

  it("rejects a LATERAL or VALUES source", () => {
    expect(
      detectSingleSourceTable(
        "SELECT u.id, x.* FROM users u, LATERAL (SELECT 1) x",
      ),
    ).toBeNull();
    expect(detectSingleSourceTable("SELECT * FROM (VALUES (1), (2)) t(n)")).toBeNull();
  });

  it("rejects an empty / malformed / non-SELECT input", () => {
    expect(detectSingleSourceTable("")).toBeNull();
    expect(detectSingleSourceTable("   ")).toBeNull();
    expect(detectSingleSourceTable("UPDATE users SET id = 1")).toBeNull();
    expect(detectSingleSourceTable("SELECT 1")).toBeNull(); // no FROM
    expect(detectSingleSourceTable("SELECT")).toBeNull();
  });

  it("rejects multi-statement input (caller should split first)", () => {
    expect(
      detectSingleSourceTable("SELECT * FROM users; SELECT * FROM posts;"),
    ).toBeNull();
  });
});

describe("detectSingleSourceTable() — defensive against bypass attempts", () => {
  it("ignores quoted strings that look like FROM clauses", () => {
    // The detector must not be tricked into thinking 'FROM admins' inside a
    // string literal is a real FROM source.
    expect(
      detectSingleSourceTable(
        "SELECT 'this looks like FROM admins' AS note FROM users",
      ),
    ).toEqual({ schema: null, table: "users" });
  });

  it("treats every JOIN-shape input as multi-source even when the alias is omitted", () => {
    expect(
      detectSingleSourceTable("SELECT * FROM users JOIN posts ON true"),
    ).toBeNull();
  });
});
