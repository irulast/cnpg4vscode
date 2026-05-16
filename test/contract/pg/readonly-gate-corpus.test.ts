/**
 * Contract corpus — read-only SQL gate (T126, SC-008).
 *
 * Backs the spec's success criterion: "100% of attempted write statements
 * issued from a read-only console are intercepted before reaching the
 * database, across a representative corpus of ≥50 SQL statements covering
 * DML, DDL, transaction control, vendor-specific, and edge-case bypass
 * attempts."
 *
 * This file is intentionally redundant with `test/unit/readonly-gate-ast.test.ts`:
 * the unit test guards individual rules as the gate evolves; this contract
 * test asserts that the *combined* corpus reaches the SC-008 size bar and
 * fully partitions into expected allow/deny verdicts. If a future change
 * relaxes the gate, the corpus must be revisited explicitly here — that
 * surface-area review is the point of the contract layer.
 *
 * No DB connection is involved. The gate is a pure function; the contract
 * is "given this representative corpus, the classifier returns the right
 * verdict for every entry."
 */

import { describe, expect, it } from "vitest";
import { classify } from "../../../src/pg/readonly-gate.js";

const ALLOWED: ReadonlyArray<string> = [
  // Plain reads
  "SELECT 1",
  "SELECT * FROM users",
  "SELECT id, name FROM public.users WHERE id = $1",
  "SELECT u.id, p.title FROM users u JOIN posts p ON p.user_id = u.id",
  "SELECT COUNT(*) FROM big_table",
  "SELECT * FROM users LIMIT 100 OFFSET 0",
  "SELECT * FROM users ORDER BY created_at DESC NULLS LAST",
  "SELECT now(), current_user, current_database()",
  "SELECT pg_size_pretty(pg_database_size('postgres'))",
  "SELECT json_build_object('id', id, 'name', name) FROM users",
  // CTE reads
  "WITH t AS (SELECT 1) SELECT * FROM t",
  "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < 10) SELECT * FROM r",
  // EXPLAIN (non-ANALYZE) is read-only.
  "EXPLAIN SELECT * FROM users",
  "EXPLAIN (FORMAT JSON) SELECT * FROM users",
  "EXPLAIN (VERBOSE, COSTS OFF) SELECT * FROM users WHERE id = 1",
  // SHOW is read-only.
  "SHOW search_path",
  "SHOW ALL",
  "SHOW transaction_read_only",
  // VALUES & TABLE shorthand
  "VALUES (1), (2), (3)",
  "TABLE users",
  // Comment-only / leading-comment variants — still read.
  "/* leading block comment */ SELECT 1",
  "-- inline comment\nSELECT 1",
  "/* multi\n line\n block */ SELECT id FROM users",
  // Whitespace robustness
  "   select   1   ",
  "\n\tSELECT\n\t1\n",
  // Quoted string containing an INSERT-like body — must NOT be mistaken for a write.
  "SELECT 'INSERT INTO users VALUES (1)' AS not_a_write",
  // NOTE on quoted identifiers: the current gate intentionally biases toward
  // false-positive rejects rather than false-negative allows, so a query
  // whose quoted identifier *happens* to spell a write keyword (e.g.
  // `SELECT "Update" FROM "Order"`) is rejected. That's a known conservative
  // miss — SC-008 only requires "no writes pass" (no false negatives); over-
  // rejecting an exotic identifier is annoying but safe. Tracked as a future
  // gate-upgrade target if libpg_query is adopted.
  // Dollar-quoted body in a SELECT (e.g. format()) — body is stripped before keyword scan.
  "SELECT format($fmt$INSERT INTO foo VALUES (%L)$fmt$, 'x')",
  // EXPLAIN of a SELECT containing the word UPDATE inside a quoted body.
  "EXPLAIN SELECT 'UPDATE users' AS s",
];

const REJECTED: ReadonlyArray<[string, string]> = [
  // DML — direct writes
  ["INSERT INTO users (id, name) VALUES (1, 'x')", "INSERT"],
  ["UPDATE users SET name = 'x' WHERE id = 1", "UPDATE"],
  ["DELETE FROM users WHERE id = 1", "DELETE"],
  ["MERGE INTO target USING source ON true WHEN MATCHED THEN UPDATE SET x=1", "MERGE"],
  ["COPY users FROM stdin", "COPY"],
  ["COPY users TO STDOUT", "COPY"],

  // DDL
  ["CREATE TABLE t (id int)", "CREATE"],
  ["CREATE INDEX ix ON users(name)", "CREATE"],
  ["CREATE INDEX CONCURRENTLY ix2 ON users(email)", "CREATE"],
  ["CREATE OR REPLACE VIEW v AS SELECT 1", "CREATE"],
  ["CREATE MATERIALIZED VIEW mv AS SELECT * FROM users", "CREATE"],
  ["ALTER TABLE users ADD COLUMN x int", "ALTER"],
  ["ALTER INDEX ix RENAME TO ix2", "ALTER"],
  ["ALTER SCHEMA s OWNER TO postgres", "ALTER"],
  ["DROP TABLE users", "DROP"],
  ["DROP INDEX ix", "DROP"],
  ["DROP MATERIALIZED VIEW mv", "DROP"],
  ["DROP SCHEMA s CASCADE", "DROP"],
  ["TRUNCATE users", "TRUNCATE"],
  ["TRUNCATE TABLE a, b RESTART IDENTITY", "TRUNCATE"],
  ["REFRESH MATERIALIZED VIEW mv", "REFRESH"],
  ["REFRESH MATERIALIZED VIEW CONCURRENTLY mv", "REFRESH"],
  ["COMMENT ON TABLE users IS 'people'", "COMMENT"],

  // Maintenance
  ["VACUUM users", "VACUUM"],
  ["VACUUM (ANALYZE) users", "VACUUM"],
  ["ANALYZE users", "ANALYZE"],
  ["REINDEX TABLE users", "REINDEX"],
  ["REINDEX INDEX ix", "REINDEX"],
  ["CLUSTER users USING ix", "CLUSTER"],
  ["CHECKPOINT", "CHECKPOINT"],
  ["DISCARD ALL", "DISCARD"],
  ["LOCK TABLE users IN ACCESS EXCLUSIVE MODE", "LOCK"],

  // AuthZ
  ["GRANT SELECT ON users TO role", "GRANT"],
  ["REVOKE SELECT ON users FROM role", "REVOKE"],
  ["SECURITY LABEL ON TABLE users IS 'public'", "SECURITY"],

  // Procedural / NOTIFY family
  ["CALL my_proc()", "CALL"],
  ["DO $$ BEGIN PERFORM 1; END; $$", "DO"],
  ["NOTIFY chan", "NOTIFY"],
  ["LISTEN chan", "LISTEN"],
  ["UNLISTEN chan", "UNLISTEN"],

  // Prepared-stmt management — DEALLOCATE/PREPARE shape server state.
  ["PREPARE p AS SELECT 1", "PREPARE"],
  ["DEALLOCATE p", "DEALLOCATE"],

  // Transaction control — managed by the host.
  ["BEGIN", "BEGIN"],
  ["BEGIN ISOLATION LEVEL SERIALIZABLE", "BEGIN"],
  ["START TRANSACTION", "START"],
  ["COMMIT", "COMMIT"],
  ["ROLLBACK", "ROLLBACK"],
  ["SAVEPOINT s1", "SAVEPOINT"],
  ["RELEASE SAVEPOINT s1", "RELEASE"],
  ["END", "END"],

  // SET — connection layer issues its own SET LOCALs.
  ["SET search_path = public", "SET"],
  ["SET LOCAL statement_timeout = 1000", "SET"],

  // Row-lock variants on a SELECT
  ["SELECT * FROM users FOR UPDATE", "FOR UPDATE"],
  ["SELECT * FROM users FOR SHARE", "FOR SHARE"],
  ["SELECT * FROM users FOR NO KEY UPDATE", "FOR"],
  ["SELECT * FROM users FOR KEY SHARE", "FOR"],

  // EXPLAIN ANALYZE — actually executes.
  ["EXPLAIN ANALYZE SELECT * FROM users", "EXPLAIN ANALYZE"],
  ["EXPLAIN (ANALYZE, BUFFERS) SELECT 1", "EXPLAIN ANALYZE"],

  // CTE-with-write bypass attempts
  ["WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d", "CTE DELETE"],
  ["WITH ins AS (INSERT INTO logs SELECT 1 RETURNING *) SELECT * FROM ins", "CTE INSERT"],
  ["WITH u AS (UPDATE users SET x=1 RETURNING id) SELECT * FROM u", "CTE UPDATE"],

  // Mutating functions on a SELECT
  ["SELECT nextval('seq')", "nextval"],
  ["SELECT setval('seq', 100)", "setval"],
  ["SELECT pg_advisory_lock(1)", "advisory_lock"],
  ["SELECT pg_advisory_xact_lock(1)", "advisory_xact_lock"],
  ["SELECT lo_unlink(1234)", "lo_unlink"],
  ["SELECT lo_create(0)", "lo_create"],

  // Multi-statement smuggling
  ["SELECT 1; UPDATE users SET id=1", "multi"],
  ["SELECT 1;\nDROP TABLE users", "multi"],

  // Empty / whitespace-only
  ["", "empty"],
  ["   \n\t  ", "empty"],
];

describe("SC-008 — read-only gate corpus (≥50 representative statements)", () => {
  it("the corpus is large enough to satisfy SC-008's representativeness bar", () => {
    expect(ALLOWED.length + REJECTED.length).toBeGreaterThanOrEqual(50);
  });

  for (const sql of ALLOWED) {
    it(`allows: ${preview(sql)}`, () => {
      const c = classify(sql);
      if (c.kind !== "allowed") {
        throw new Error(
          `expected allowed but got rejected (${c.code}: ${c.reason}) for: ${sql}`,
        );
      }
    });
  }

  for (const [sql, label] of REJECTED) {
    it(`rejects (${label}): ${preview(sql)}`, () => {
      const c = classify(sql);
      if (c.kind !== "rejected") {
        throw new Error(`expected rejected (${label}) but got allowed for: ${sql}`);
      }
      // Stable rejection code is part of the contract — the UI keys off it
      // for localised messages and telemetry buckets.
      expect(typeof c.code).toBe("string");
      expect(c.code.length).toBeGreaterThan(0);
      expect(typeof c.reason).toBe("string");
      expect(c.reason.length).toBeGreaterThan(0);
    });
  }
});

function preview(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > 50 ? `${flat.slice(0, 50)}…` : flat;
}
