import { describe, expect, it } from "vitest";
import { classify } from "../../src/pg/readonly-gate.js";

describe("read-only gate — allowed statements", () => {
  const allowed = [
    "SELECT 1",
    "  select 1  ",
    "SELECT * FROM users WHERE id = $1",
    "select id, name from public.users",
    "WITH t AS (SELECT 1) SELECT * FROM t",
    "EXPLAIN SELECT * FROM users",
    "explain (format json) select * from users",
    "SHOW search_path",
    "show all",
    "VALUES (1), (2), (3)",
    "TABLE users",
    "/* leading comment */ SELECT 1",
    "-- comment\nSELECT 1",
    "SELECT pg_size_pretty(pg_database_size('postgres'))",
  ];
  for (const sql of allowed) {
    it(`allows: ${sql.slice(0, 40)}`, () => {
      const c = classify(sql);
      expect(c.kind).toBe("allowed");
    });
  }
});

describe("read-only gate — rejected statements", () => {
  const rejected: Array<[string, string]> = [
    ["INSERT INTO users (id) VALUES (1)", "INSERT"],
    ["UPDATE users SET name = 'x'", "UPDATE"],
    ["DELETE FROM users WHERE id = 1", "DELETE"],
    ["MERGE INTO target USING source ON true WHEN MATCHED THEN UPDATE SET x=1", "MERGE"],
    ["TRUNCATE users", "TRUNCATE"],
    ["DROP TABLE users", "DROP"],
    ["DROP INDEX ix", "DROP"],
    ["CREATE TABLE t (id int)", "CREATE"],
    ["ALTER TABLE users ADD COLUMN x int", "ALTER"],
    ["GRANT SELECT ON users TO role", "GRANT"],
    ["REVOKE SELECT ON users FROM role", "REVOKE"],
    ["CALL my_proc()", "CALL"],
    ["VACUUM users", "VACUUM"],
    ["REINDEX TABLE users", "REINDEX"],
    ["CLUSTER users USING ix", "CLUSTER"],
    ["LOCK TABLE users", "LOCK"],
    ["NOTIFY chan", "NOTIFY"],
    ["LISTEN chan", "LISTEN"],
    ["UNLISTEN chan", "UNLISTEN"],
    ["COPY users FROM stdin", "COPY"],
    ["DO $$ BEGIN PERFORM 1; END; $$", "DO"],
    ["BEGIN", "transaction control"],
    ["COMMIT", "transaction control"],
    ["ROLLBACK", "transaction control"],
    ["SET search_path = public", "SET"],
    ["SELECT * FROM users FOR UPDATE", "FOR UPDATE"],
    ["SELECT * FROM users FOR SHARE", "FOR SHARE"],
    ["SELECT * FROM users FOR NO KEY UPDATE", "FOR"],
    ["WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d", "CTE write"],
    ["WITH ins AS (INSERT INTO logs SELECT 1 RETURNING *) SELECT * FROM ins", "CTE write"],
    ["SELECT nextval('seq')", "nextval"],
    ["SELECT setval('seq', 100)", "setval"],
    ["SELECT pg_advisory_lock(1)", "advisory lock"],
  ];
  for (const [sql, label] of rejected) {
    it(`rejects (${label}): ${sql.slice(0, 50)}`, () => {
      const c = classify(sql);
      expect(c.kind).toBe("rejected");
      if (c.kind === "rejected") expect(c.reason).toMatch(/./);
    });
  }
});

describe("read-only gate — edge cases", () => {
  it("rejects an empty / whitespace-only statement", () => {
    expect(classify("").kind).toBe("rejected");
    expect(classify("   \n\t  ").kind).toBe("rejected");
  });

  it("rejects multiple statements (caller must split first)", () => {
    const c = classify("SELECT 1; UPDATE users SET id = 1;");
    expect(c.kind).toBe("rejected");
  });

  it("provides a stable rejection code so the UI can localize messages", () => {
    const c = classify("UPDATE users SET id = 1");
    if (c.kind === "rejected") expect(typeof c.code).toBe("string");
  });
});
