import { describe, expect, it } from "vitest";
import { toCsv, toJson, toInserts, type ExportColumn } from "../../src/grid/export.js";

const COLS: ReadonlyArray<ExportColumn> = [
  { name: "id", pgType: "int4" },
  { name: "name", pgType: "text" },
  { name: "active", pgType: "bool" },
  { name: "meta", pgType: "jsonb" },
];

describe("toCsv()", () => {
  it("emits a header row + one line per data row with CRLF endings", () => {
    const out = toCsv(
      [
        [1, "Alice", true, { score: 9 }],
        [2, "Bob", false, null],
      ],
      COLS,
    );
    const lines = out.split("\r\n");
    expect(lines[0]).toBe("id,name,active,meta");
    expect(lines[1]).toBe('1,Alice,true,"{""score"":9}"');
    expect(lines[2]).toBe("2,Bob,false,");
    // Trailing CRLF means split produces one empty tail element.
    expect(lines[3]).toBe("");
  });

  it("quotes fields containing commas, quotes, CR, LF and doubles embedded quotes", () => {
    const out = toCsv(
      [["1", `has "quote" + comma, sep`], ["2", "two\nlines"], ["3", "carriage\rreturn"]],
      [{ name: "k" }, { name: "v" }],
    );
    const lines = out.split("\r\n");
    expect(lines[1]).toBe('1,"has ""quote"" + comma, sep"');
    expect(lines[2]).toBe('2,"two\nlines"');
    expect(lines[3]).toBe('3,"carriage\rreturn"');
  });

  it("renders null/undefined as empty cells (not the literal 'null')", () => {
    const out = toCsv([[null, undefined, "x"]], [
      { name: "a" }, { name: "b" }, { name: "c" },
    ]);
    expect(out.split("\r\n")[1]).toBe(",,x");
  });

  it("renders dates as ISO 8601", () => {
    const d = new Date("2026-01-02T03:04:05.678Z");
    const out = toCsv([[d]], [{ name: "ts" }]);
    expect(out.split("\r\n")[1]).toBe("2026-01-02T03:04:05.678Z");
  });

  it("renders non-finite numbers as empty (NaN, Infinity are non-portable in CSV)", () => {
    const out = toCsv([[Number.NaN, Number.POSITIVE_INFINITY, 42]], [
      { name: "a" }, { name: "b" }, { name: "c" },
    ]);
    expect(out.split("\r\n")[1]).toBe(",,42");
  });

  it("emits a header-only file when rows is empty", () => {
    const out = toCsv([], COLS);
    expect(out).toBe("id,name,active,meta\r\n");
  });

  it("escapes the header itself when a column name contains a comma or quote", () => {
    const out = toCsv([], [{ name: 'odd"col,name' }]);
    expect(out).toBe('"odd""col,name"\r\n');
  });
});

describe("toJson()", () => {
  it("produces an array of {column: value} objects, pretty-printed", () => {
    const out = toJson(
      [
        [1, "Alice", true, { score: 9 }],
        [2, "Bob", false, null],
      ],
      COLS,
    );
    const parsed = JSON.parse(out) as unknown;
    expect(parsed).toEqual([
      { id: 1, name: "Alice", active: true, meta: { score: 9 } },
      { id: 2, name: "Bob", active: false, meta: null },
    ]);
    // Pretty-printed (2-space indent).
    expect(out).toContain('  "id": 1');
    // Terminating newline.
    expect(out.endsWith("\n")).toBe(true);
  });

  it("converts Date instances to ISO 8601 strings", () => {
    const d = new Date("2026-01-02T03:04:05.678Z");
    const out = toJson([[d]], [{ name: "ts" }]);
    expect(JSON.parse(out)).toEqual([{ ts: "2026-01-02T03:04:05.678Z" }]);
  });

  it("emits [] (with trailing newline) for an empty row list", () => {
    expect(toJson([], COLS)).toBe("[]\n");
  });
});

describe("toInserts()", () => {
  it("wraps the script in BEGIN; / COMMIT;", () => {
    const out = toInserts("public", "users", [[1, "Alice"]], [
      { name: "id" }, { name: "name" },
    ]);
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("BEGIN;");
    expect(lines[lines.length - 1]).toBe("COMMIT;");
  });

  it("emits one INSERT per row with literals inlined (NOT $N parameters)", () => {
    const out = toInserts("public", "users", [
      [1, "Alice", true],
      [2, "Bob", false],
    ], [
      { name: "id" }, { name: "name" }, { name: "active" },
    ]);
    const lines = out.trimEnd().split("\n");
    expect(lines[1]).toBe(`INSERT INTO "public"."users" ("id", "name", "active") VALUES (1, 'Alice', TRUE);`);
    expect(lines[2]).toBe(`INSERT INTO "public"."users" ("id", "name", "active") VALUES (2, 'Bob', FALSE);`);
    // No leftover $N anywhere — this is exported SQL, not a prepared statement.
    expect(out).not.toMatch(/\$\d+/);
  });

  it("renders nulls as NULL, dates as ISO strings, objects as JSON-stringified literals", () => {
    const d = new Date("2026-03-04T05:06:07.890Z");
    const out = toInserts("s", "t", [[null, d, { k: "v" }]], [
      { name: "n" }, { name: "ts" }, { name: "meta" },
    ]);
    expect(out).toContain(`VALUES (NULL, '2026-03-04T05:06:07.890Z', '{"k":"v"}')`);
  });

  it("escapes embedded single quotes by doubling them (SQL string-literal escape)", () => {
    const out = toInserts("public", "users", [
      ["Robert'); DROP TABLE users;--"],
    ], [{ name: "name" }]);
    // The whole payload survives intact as an inert quoted literal —
    // the embedded ' is doubled, so the literal terminates at the
    // closing quote we control, not in the middle of the payload.
    expect(out).toContain(`VALUES ('Robert''); DROP TABLE users;--');`);
  });

  it("quotes schema/table identifiers and embedded \" in them", () => {
    const out = toInserts(`weird"schema`, `t"bl`, [[1]], [{ name: "id" }]);
    expect(out).toContain(`INSERT INTO "weird""schema"."t""bl" ("id") VALUES (1);`);
  });

  it("routes every emitted statement through redact() — credential literals in cell values are scrubbed", () => {
    // A migration audit row capturing a CREATE ROLE statement would
    // otherwise leak the literal password into the export.
    const out = toInserts("public", "audit", [
      [1, `CREATE ROLE deploy WITH PASSWORD 'super-secret-1234'`],
    ], [{ name: "id" }, { name: "stmt" }]);
    expect(out).not.toContain("super-secret-1234");
    expect(out).toContain("***REDACTED***");
  });

  it("treats non-finite numbers as NULL (Postgres has no NaN literal for numeric types)", () => {
    const out = toInserts("s", "t", [[Number.NaN, Number.POSITIVE_INFINITY, 42]], [
      { name: "a" }, { name: "b" }, { name: "c" },
    ]);
    expect(out).toContain("VALUES (NULL, NULL, 42);");
  });

  it("emits BEGIN; / COMMIT; even when rows is empty (still a valid no-op transaction)", () => {
    const out = toInserts("public", "t", [], [{ name: "id" }]);
    expect(out).toBe("BEGIN;\nCOMMIT;\n");
  });
});
