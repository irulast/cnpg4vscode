import { describe, expect, it } from "vitest";
import { splitStatements, statementAtOffset } from "../../src/sql/statement-split.js";

describe("splitStatements()", () => {
  it("splits on top-level semicolons", () => {
    expect(splitStatements("SELECT 1; SELECT 2; SELECT 3")).toEqual([
      "SELECT 1",
      "SELECT 2",
      "SELECT 3",
    ]);
  });

  it("preserves trailing whitespace inside statements but trims outer", () => {
    expect(splitStatements("  SELECT 1  ;  SELECT 2  ")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("ignores semicolons inside single-quoted strings", () => {
    expect(splitStatements("SELECT 'a;b';")).toEqual(["SELECT 'a;b'"]);
  });

  it("ignores semicolons inside double-quoted identifiers", () => {
    expect(splitStatements('SELECT "a;b" FROM users;')).toEqual([
      'SELECT "a;b" FROM users',
    ]);
  });

  it("ignores semicolons inside dollar-quoted bodies", () => {
    const sql = "CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql;";
    expect(splitStatements(sql)).toEqual([
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql",
    ]);
  });

  it("ignores semicolons inside dollar-tagged bodies", () => {
    const sql = "DO $body$ BEGIN PERFORM 1; END $body$;";
    expect(splitStatements(sql)).toEqual(["DO $body$ BEGIN PERFORM 1; END $body$"]);
  });

  it("ignores semicolons inside line comments", () => {
    expect(splitStatements("SELECT 1; -- ; comment\nSELECT 2")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("ignores semicolons inside block comments (including nested)", () => {
    expect(splitStatements("SELECT 1 /* x; /* nested; */ y; */; SELECT 2")).toEqual([
      "SELECT 1 /* x; /* nested; */ y; */",
      "SELECT 2",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("  ")).toEqual([]);
    expect(splitStatements(";")).toEqual([]);
  });

  it("handles a trailing statement without a semicolon", () => {
    expect(splitStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });
});

describe("statementAtOffset()", () => {
  it("returns the statement containing the cursor offset", () => {
    const sql = "SELECT 1; SELECT 2; SELECT 3";
    const at = statementAtOffset(sql, 12); // cursor inside SELECT 2
    expect(at?.text).toBe("SELECT 2");
    expect(at?.start).toBe(10);
    expect(at?.end).toBe(18);
  });

  it("returns null for an offset between statements", () => {
    const sql = "SELECT 1; SELECT 2";
    // The semicolon at offset 8 is a delimiter — caller should fall back.
    expect(statementAtOffset(sql, 8)).toBeNull();
  });

  it("returns the only statement when there's one and the cursor is anywhere in it", () => {
    expect(statementAtOffset("SELECT 1", 0)?.text).toBe("SELECT 1");
    expect(statementAtOffset("SELECT 1", 4)?.text).toBe("SELECT 1");
  });
});
