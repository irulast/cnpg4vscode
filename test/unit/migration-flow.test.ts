/**
 * Unit tests for the migration wizard's pure flow orchestrator.
 *
 * Drives `runMigrationFlow()` with stubbed callbacks so every branch
 * (cancel-at-preview, no-statements, transactional success + export,
 * transactional success + decline export, mid-set failure with rollback,
 * partial-apply for non-transactional set) is exercised without the
 * VS Code host.
 *
 * The state machine itself defers all SQL execution to the
 * already-tested `executeMigration()` from src/sql/migration.ts; this
 * suite only verifies the orchestration (split → classify → confirm →
 * execute → export?).
 */

import { describe, expect, it } from "vitest";
import {
  runMigrationFlow,
  type MigrationFlowConn,
  type MigrationFlowDeps,
  type MigrationPreview,
} from "../../src/sql/migration-flow.js";
import type { MigrationResult } from "../../src/sql/migration.js";

function makeConn(): MigrationFlowConn {
  return {
    id: "ctx/ns/app-db/postgres/postgres",
    cluster: {
      namespace: "ns",
      clusterName: "app-db",
    },
    database: "postgres",
    connection: { mode: "write" },
  };
}

interface Recorder {
  confirms: MigrationPreview[];
  asks: number;
  writes: Array<{ relPath: string; body: string }>;
  executed: ReadonlyArray<string> | null;
}

function makeDeps(
  overrides: Partial<MigrationFlowDeps> & {
    /** Default behavior for `executeViaClient`. */
    executeResult?: MigrationResult;
    /** Default decision for the confirm modal. */
    confirmDecision?: "confirmed" | "cancelled";
    /** Default answer for the export prompt. */
    exportAnswer?: "yes" | "no";
  } = {},
): { deps: MigrationFlowDeps; recorder: Recorder } {
  const recorder: Recorder = { confirms: [], asks: 0, writes: [], executed: null };
  const deps: MigrationFlowDeps = {
    conn: makeConn(),
    sqlBuffer: "",
    confirmRun: async (preview) => {
      recorder.confirms.push(preview);
      return overrides.confirmDecision ?? "confirmed";
    },
    askExport: async () => {
      recorder.asks++;
      return overrides.exportAnswer ?? "no";
    },
    writeExport: async (relPath, body) => {
      recorder.writes.push({ relPath, body });
      return relPath;
    },
    executeViaClient: async (statements) => {
      recorder.executed = statements;
      return overrides.executeResult ?? { kind: "ok" };
    },
    ...overrides,
  };
  return { deps, recorder };
}

describe("runMigrationFlow() — empty / cancel paths", () => {
  it("returns no-statements when the buffer contains no SQL", async () => {
    const { deps, recorder } = makeDeps();
    const out = await runMigrationFlow({ ...deps, sqlBuffer: "-- just a comment\n" });
    expect(out.kind).toBe("no-statements");
    expect(recorder.confirms.length).toBe(0);
    expect(recorder.executed).toBeNull();
  });

  it("returns no-statements when the buffer is whitespace-only", async () => {
    const { deps } = makeDeps();
    const out = await runMigrationFlow({ ...deps, sqlBuffer: "   \n\t" });
    expect(out.kind).toBe("no-statements");
  });

  it("returns cancelled when the user dismisses the confirm modal", async () => {
    const { deps, recorder } = makeDeps({ confirmDecision: "cancelled" });
    const out = await runMigrationFlow({
      ...deps,
      sqlBuffer: "CREATE TABLE t (id int);",
    });
    expect(out.kind).toBe("cancelled");
    expect(recorder.executed).toBeNull(); // never reaches the executor
    expect(recorder.asks).toBe(0); // never asks about export
  });
});

describe("runMigrationFlow() — successful transactional set", () => {
  it("splits, classifies as transactional, confirms, executes, asks for export, returns ok", async () => {
    const { deps, recorder } = makeDeps();
    const out = await runMigrationFlow({
      ...deps,
      sqlBuffer: "CREATE TABLE t (id int); ALTER TABLE t ADD COLUMN x int;",
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.statements).toEqual([
        "CREATE TABLE t (id int)",
        "ALTER TABLE t ADD COLUMN x int",
      ]);
      expect(out.exportedTo).toBeNull(); // default answer was "no"
    }
    expect(recorder.confirms.length).toBe(1);
    const preview = recorder.confirms[0]!;
    expect(preview.transactional).toBe(true);
    expect(preview.nonTransactionalIndexes).toEqual([]);
    expect(preview.target).toContain("app-db");
  });

  it("writes the exported .sql when the user confirms the export prompt", async () => {
    const { deps, recorder } = makeDeps({ exportAnswer: "yes" });
    const out = await runMigrationFlow({
      ...deps,
      sqlBuffer: "CREATE TABLE t (id int);",
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.exportedTo).toBe(recorder.writes[0]!.relPath);
      expect(recorder.writes[0]!.relPath).toMatch(
        /^migrations\/\d{8}-\d{6}-migration\.sql$/,
      );
      expect(recorder.writes[0]!.body).toContain("CREATE TABLE t (id int)");
      expect(recorder.writes[0]!.body).toContain("BEGIN;");
      expect(recorder.writes[0]!.body).toContain("COMMIT;");
    }
  });
});

describe("runMigrationFlow() — non-transactional set", () => {
  it("classifies as non-transactional and flags the non-txn statement indexes for the preview banner", async () => {
    const { deps, recorder } = makeDeps();
    await runMigrationFlow({
      ...deps,
      sqlBuffer:
        "CREATE TABLE t (id int); CREATE INDEX CONCURRENTLY ix ON t(id);",
    });
    const preview = recorder.confirms[0]!;
    expect(preview.transactional).toBe(false);
    expect(preview.nonTransactionalIndexes).toEqual([1]);
  });

  it("does NOT wrap the exported body in BEGIN/COMMIT when non-transactional", async () => {
    const { deps, recorder } = makeDeps({ exportAnswer: "yes" });
    await runMigrationFlow({
      ...deps,
      sqlBuffer:
        "CREATE TABLE t (id int); CREATE INDEX CONCURRENTLY ix ON t(id);",
    });
    expect(recorder.writes[0]!.body).not.toMatch(/^BEGIN;/m);
    expect(recorder.writes[0]!.body).not.toMatch(/^COMMIT;/m);
  });
});

describe("runMigrationFlow() — failure paths", () => {
  it("propagates a transactional failed result with the offending index + rollback flag", async () => {
    const boom = new Error("relation already exists");
    const { deps } = makeDeps({
      executeResult: {
        kind: "failed",
        failedIndex: 1,
        error: boom,
        rolledBack: true,
      },
    });
    const out = await runMigrationFlow({
      ...deps,
      sqlBuffer: "CREATE TABLE a (id int); CREATE TABLE b (id int);",
    });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.failedIndex).toBe(1);
      expect(out.error).toBe(boom);
      expect(out.rolledBack).toBe(true);
    }
  });

  it("propagates a partiallyApplied result with the completed-prefix indexes", async () => {
    const boom = new Error("could not acquire lock");
    const { deps } = makeDeps({
      executeResult: {
        kind: "partiallyApplied",
        failedIndex: 1,
        completedIndexes: [0],
        error: boom,
      },
    });
    const out = await runMigrationFlow({
      ...deps,
      sqlBuffer:
        "CREATE TABLE t (id int); CREATE INDEX CONCURRENTLY ix ON t(id);",
    });
    expect(out.kind).toBe("partiallyApplied");
    if (out.kind === "partiallyApplied") {
      expect(out.failedIndex).toBe(1);
      expect(out.completedIndexes).toEqual([0]);
    }
  });

  it("does NOT prompt for export when execution failed", async () => {
    const { deps, recorder } = makeDeps({
      executeResult: {
        kind: "failed",
        failedIndex: 0,
        error: new Error("boom"),
        rolledBack: true,
      },
    });
    await runMigrationFlow({
      ...deps,
      sqlBuffer: "CREATE TABLE t (id int);",
    });
    expect(recorder.asks).toBe(0);
    expect(recorder.writes.length).toBe(0);
  });
});

describe("runMigrationFlow() — preview content", () => {
  it("hands the splitter's exact output to the executor (no rebuild between confirm and run)", async () => {
    const { deps, recorder } = makeDeps();
    await runMigrationFlow({
      ...deps,
      sqlBuffer: "  CREATE TABLE t (id int)  ;  ALTER TABLE t ADD COLUMN x int;",
    });
    // The preview's statements list and the executor's statements list are
    // built from the same `splitStatements()` call — important for the
    // "user confirms exactly what runs" security invariant.
    const preview = recorder.confirms[0]!;
    expect(recorder.executed).toEqual(preview.statements);
  });
});
