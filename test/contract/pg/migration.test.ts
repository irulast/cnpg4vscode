/**
 * Contract — migration wizard transactional execution (T097, paired with T113 + T114).
 *
 * Backs spec FR-027 and the third US6 acceptance scenario: "Given the
 * migration wizard with two DDL statements queued, when the user runs the
 * migration and the second statement fails, then the first statement is
 * rolled back (where the storage engine permits) and the failure is
 * reported with the offending statement highlighted."
 *
 * Strategy — drive `executeMigration()` against a thin in-memory client
 * stub that records every protocol verb (`BEGIN`, individual statements,
 * `COMMIT`, `ROLLBACK`). The stub can be primed to reject the Nth call
 * with a specific error, letting us assert the exact protocol sequence
 * for the success, mid-transaction-failure, and non-transactional paths.
 *
 * The contract under test is:
 *
 *   - All-transactional set, all succeed:
 *       BEGIN → stmt[0] → stmt[1] → … → COMMIT
 *
 *   - All-transactional set, stmt[N] fails:
 *       BEGIN → stmt[0..N] → ROLLBACK
 *       Result.failedIndex === N, Result.rolledBack === true
 *
 *   - Set containing non-transactional DDL (e.g. CREATE INDEX CONCURRENTLY):
 *       NO `BEGIN` / `COMMIT` / `ROLLBACK` issued; each statement runs
 *       independently. A mid-set failure leaves prior statements applied
 *       (Result.kind === "partiallyApplied", per data-model.md).
 *
 * Plus the static classifier:
 *
 *   - isNonTransactional("CREATE INDEX CONCURRENTLY ix ON t(x)") === true
 *   - isNonTransactional("VACUUM") === true
 *   - isNonTransactional("CREATE TABLE t (id int)") === false
 *
 * And the export-to-sql renderer:
 *
 *   - returns a body wrapping all statements (BEGIN/COMMIT when txn'l;
 *     bare statements otherwise);
 *   - routes every emitted statement through the injected redactor so
 *     credential literals in the migration text never land on disk.
 */

import { describe, expect, it } from "vitest";
import {
  classifyMigration,
  executeMigration,
  exportMigrationToSql,
  isNonTransactional,
  type MigrationClient,
} from "../../../src/sql/migration.js";

interface RecordedCall {
  sql: string;
  values?: ReadonlyArray<unknown>;
}

interface StubOptions {
  /** When the Nth recorded call's sql matches the predicate, reject with `error`. */
  failOn?: (sql: string, callIndex: number) => Error | null;
}

function makeStub(opts: StubOptions = {}): {
  client: MigrationClient;
  calls: ReadonlyArray<RecordedCall>;
} {
  const calls: RecordedCall[] = [];
  const client: MigrationClient = {
    async query(sql, values) {
      const idx = calls.length;
      calls.push({ sql, ...(values !== undefined ? { values } : {}) });
      const err = opts.failOn?.(sql, idx);
      if (err) throw err;
      return { rowCount: 0 };
    },
  };
  return { client, calls };
}

describe("isNonTransactional()", () => {
  it("recognises CREATE INDEX CONCURRENTLY", () => {
    expect(isNonTransactional("CREATE INDEX CONCURRENTLY ix ON t(x)")).toBe(true);
    expect(isNonTransactional("create index  concurrently  ix on t(x)")).toBe(true);
  });
  it("recognises DROP INDEX CONCURRENTLY", () => {
    expect(isNonTransactional("DROP INDEX CONCURRENTLY ix")).toBe(true);
  });
  it("recognises REINDEX … CONCURRENTLY", () => {
    expect(isNonTransactional("REINDEX TABLE CONCURRENTLY t")).toBe(true);
    expect(isNonTransactional("REINDEX INDEX CONCURRENTLY ix")).toBe(true);
  });
  it("recognises VACUUM and CLUSTER", () => {
    expect(isNonTransactional("VACUUM t")).toBe(true);
    expect(isNonTransactional("VACUUM (ANALYZE) t")).toBe(true);
    expect(isNonTransactional("CLUSTER t USING ix")).toBe(true);
  });
  it("recognises ALTER SYSTEM (cannot run in a transaction block)", () => {
    expect(isNonTransactional("ALTER SYSTEM SET work_mem = '64MB'")).toBe(true);
  });
  it("recognises ALTER TYPE … ADD VALUE (non-txn unless IF NOT EXISTS)", () => {
    expect(isNonTransactional("ALTER TYPE color ADD VALUE 'purple'")).toBe(true);
  });
  it("returns false for ordinary DDL", () => {
    expect(isNonTransactional("CREATE TABLE t (id int)")).toBe(false);
    expect(isNonTransactional("ALTER TABLE t ADD COLUMN x int")).toBe(false);
    expect(isNonTransactional("CREATE INDEX ix ON t(x)")).toBe(false);
    expect(isNonTransactional("DROP TABLE t")).toBe(false);
  });
  it("strips leading comments / whitespace before classifying", () => {
    expect(
      isNonTransactional("-- backfill\n/* note */ CREATE INDEX CONCURRENTLY ix ON t(x)"),
    ).toBe(true);
    expect(isNonTransactional("   \n  CREATE TABLE t (id int)")).toBe(false);
  });
});

describe("classifyMigration()", () => {
  it("returns transactional=true when every statement is transactional", () => {
    const c = classifyMigration([
      "CREATE TABLE t (id int)",
      "ALTER TABLE t ADD COLUMN x int",
    ]);
    expect(c.transactional).toBe(true);
    expect(c.nonTransactionalIndexes).toEqual([]);
  });
  it("returns transactional=false when any statement is non-transactional", () => {
    const c = classifyMigration([
      "CREATE TABLE t (id int)",
      "CREATE INDEX CONCURRENTLY ix ON t(id)",
      "VACUUM t",
    ]);
    expect(c.transactional).toBe(false);
    expect(c.nonTransactionalIndexes).toEqual([1, 2]);
  });
  it("handles an empty statement set", () => {
    const c = classifyMigration([]);
    expect(c.transactional).toBe(true);
    expect(c.nonTransactionalIndexes).toEqual([]);
  });
});

describe("executeMigration() — transactional set, all succeed", () => {
  it("wraps the statements in BEGIN/COMMIT and reports success", async () => {
    const { client, calls } = makeStub();
    const r = await executeMigration(client, [
      "CREATE TABLE t (id int)",
      "ALTER TABLE t ADD COLUMN x int",
    ]);
    expect(r.kind).toBe("ok");
    expect(calls.map((c) => c.sql)).toEqual([
      "BEGIN",
      "CREATE TABLE t (id int)",
      "ALTER TABLE t ADD COLUMN x int",
      "COMMIT",
    ]);
  });
});

describe("executeMigration() — transactional set, mid-set failure", () => {
  it("ROLLBACKs the transaction and reports the failed statement index", async () => {
    const boom = new Error("relation already exists");
    const { client, calls } = makeStub({
      failOn: (sql) => (sql.includes("FAILS_HERE") ? boom : null),
    });
    const r = await executeMigration(client, [
      "CREATE TABLE t (id int)",
      "CREATE TABLE FAILS_HERE (id int)",
      "ALTER TABLE t ADD COLUMN x int", // must NOT run after the failure
    ]);
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.failedIndex).toBe(1);
      expect(r.rolledBack).toBe(true);
      expect(r.error).toBe(boom);
    }
    // Protocol: BEGIN → stmt0 → stmt1 (which threw) → ROLLBACK; stmt2 never issued.
    expect(calls.map((c) => c.sql)).toEqual([
      "BEGIN",
      "CREATE TABLE t (id int)",
      "CREATE TABLE FAILS_HERE (id int)",
      "ROLLBACK",
    ]);
  });

  it("still records the original error even if ROLLBACK itself fails", async () => {
    const boom = new Error("primary stmt failure");
    const rollbackBoom = new Error("connection dropped");
    const { client } = makeStub({
      failOn: (sql) => {
        if (sql.includes("FAILS_HERE")) return boom;
        if (sql === "ROLLBACK") return rollbackBoom;
        return null;
      },
    });
    const r = await executeMigration(client, [
      "CREATE TABLE FAILS_HERE (id int)",
    ]);
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      // The original failure is the user-facing one; rolledBack should be
      // false because the rollback itself blew up.
      expect(r.error).toBe(boom);
      expect(r.rolledBack).toBe(false);
    }
  });
});

describe("executeMigration() — non-transactional set", () => {
  it("does NOT issue BEGIN/COMMIT/ROLLBACK when any statement is non-transactional", async () => {
    const { client, calls } = makeStub();
    const r = await executeMigration(client, [
      "CREATE TABLE t (id int)",
      "CREATE INDEX CONCURRENTLY ix ON t(id)",
    ]);
    expect(r.kind).toBe("ok");
    expect(calls.map((c) => c.sql)).toEqual([
      "CREATE TABLE t (id int)",
      "CREATE INDEX CONCURRENTLY ix ON t(id)",
    ]);
  });

  it("returns partiallyApplied when a non-transactional set fails after the first statement", async () => {
    const boom = new Error("could not acquire lock");
    const { client, calls } = makeStub({
      failOn: (sql) => (sql.includes("FAILS_HERE") ? boom : null),
    });
    const r = await executeMigration(client, [
      "CREATE TABLE t (id int)",
      "CREATE INDEX CONCURRENTLY FAILS_HERE ON t(id)",
      "CREATE INDEX CONCURRENTLY second ON t(id)", // must NOT run after the failure
    ]);
    expect(r.kind).toBe("partiallyApplied");
    if (r.kind === "partiallyApplied") {
      expect(r.failedIndex).toBe(1);
      expect(r.completedIndexes).toEqual([0]);
      expect(r.error).toBe(boom);
    }
    expect(calls.map((c) => c.sql)).toEqual([
      "CREATE TABLE t (id int)",
      "CREATE INDEX CONCURRENTLY FAILS_HERE ON t(id)",
    ]);
  });
});

describe("exportMigrationToSql()", () => {
  it("emits a BEGIN/COMMIT wrapper for transactional sets", () => {
    const r = exportMigrationToSql({
      statements: [
        "CREATE TABLE t (id int);",
        "ALTER TABLE t ADD COLUMN x int;",
      ],
      now: new Date("2026-05-16T18:00:00Z"),
      redactor: (s) => s,
    });
    expect(r.body).toMatch(/BEGIN;/);
    expect(r.body).toMatch(/COMMIT;/);
    expect(r.body).toContain("CREATE TABLE t (id int);");
    expect(r.body).toContain("ALTER TABLE t ADD COLUMN x int;");
  });

  it("does NOT wrap a non-transactional set in BEGIN/COMMIT", () => {
    const r = exportMigrationToSql({
      statements: [
        "CREATE TABLE t (id int);",
        "CREATE INDEX CONCURRENTLY ix ON t(id);",
      ],
      now: new Date("2026-05-16T18:00:00Z"),
      redactor: (s) => s,
    });
    expect(r.body).not.toMatch(/^BEGIN;/m);
    expect(r.body).not.toMatch(/^COMMIT;/m);
    expect(r.body).toContain("CREATE INDEX CONCURRENTLY ix ON t(id);");
  });

  it("routes every emitted statement through the redactor (credential safety)", () => {
    const r = exportMigrationToSql({
      statements: [
        "CREATE ROLE alice WITH PASSWORD 'p@nic-CANARY';",
        "GRANT SELECT ON t TO alice;",
      ],
      now: new Date("2026-05-16T18:00:00Z"),
      // Real redact() lives in src/pg/redact.ts; the test pins behavior via a stub.
      redactor: (s) => s.replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD '***REDACTED***'"),
    });
    expect(r.body).not.toContain("p@nic-CANARY");
    expect(r.body).toContain("***REDACTED***");
  });

  it("generates a timestamped, sortable, conflict-resistant filename", () => {
    const r = exportMigrationToSql({
      statements: ["CREATE TABLE t (id int);"],
      now: new Date("2026-05-16T18:30:45Z"),
      redactor: (s) => s,
    });
    // Per ISO-ish convention: YYYYMMDD-HHMMSS-migration.sql. Sortable in
    // alphabetical file lists and unambiguous across daylight-savings shifts.
    expect(r.filename).toMatch(/^20260516-\d{6}-migration\.sql$/);
  });

  it("includes a generated-at comment header so the file is self-documenting", () => {
    const r = exportMigrationToSql({
      statements: ["CREATE TABLE t (id int);"],
      now: new Date("2026-05-16T18:00:00Z"),
      redactor: (s) => s,
    });
    expect(r.body).toMatch(/^-- /m); // has at least one leading comment line
    expect(r.body).toContain("2026-05-16T18:00:00");
  });
});
