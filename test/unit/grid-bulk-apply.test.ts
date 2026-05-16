/**
 * Unit tests for the Grid Editor's bulk-apply orchestration (T141,
 * paired with T151).
 *
 * `runBulkApply()` is a thin layer over the existing single-row
 * cell-edit orchestrator. It:
 *
 *   1. Builds all parameterized statements UP FRONT (so the preview
 *      shows every UPDATE before any run).
 *   2. Hands the full set to an injected `presentBulkPreview()` once.
 *   3. On confirm, iterates per-row WITH continue-on-failure: a single
 *      bad row does NOT halt the rest (each row is independent).
 *   4. Streams per-row outcomes via an injected `onRowResult()`
 *      callback so the renderer can clear dirty marks incrementally.
 *   5. Returns the summary `{applied, failed, cancelled}`.
 *
 * Pure module — no `vscode`, no `pg`. Same pattern as the migration-
 * wizard flow orchestrator: host wires the callbacks; tests stub them.
 */

import { describe, expect, it, vi } from "vitest";
import { runBulkApply, type BulkApplyDeps, type DirtyRowRequest } from "../../src/grid/bulk-apply.js";
import type { PkDescriptor } from "../../src/pg/result-descriptor.js";
import type { BuiltStatement, ColumnChange } from "../../src/sql/update-builder.js";

const PK: PkDescriptor = { schema: "public", table: "users", pkColumns: ["id"] };

function row(pkValue: number, changes: Record<string, ColumnChange>): DirtyRowRequest {
  return {
    rowKey: `r${pkValue}`,
    pkValues: [pkValue],
    changes,
  };
}

interface PreviewEntry {
  readonly rowKey: string;
  readonly stmt: BuiltStatement;
}

function makeDeps(over: Partial<BulkApplyDeps> = {}): {
  deps: BulkApplyDeps;
  recorder: {
    previews: { count: number; statements: ReadonlyArray<PreviewEntry> }[];
    confirms: number;
    rowResults: Array<{ rowKey: string; outcome: string }>;
    executed: BuiltStatement[];
  };
} {
  const recorder = {
    previews: [] as { count: number; statements: ReadonlyArray<PreviewEntry> }[],
    confirms: 0,
    rowResults: [] as Array<{ rowKey: string; outcome: string }>,
    executed: [] as BuiltStatement[],
  };
  const deps: BulkApplyDeps = {
    descriptor: PK,
    mode: "write",
    presentBulkPreview: vi.fn(async (statements) => {
      recorder.previews.push({ count: statements.length, statements });
      recorder.confirms++;
      return "confirmed";
    }),
    executeStatement: vi.fn(async (stmt) => {
      recorder.executed.push(stmt);
      return { rowsAffected: 1 };
    }),
    onRowResult: (rowKey, outcome) => {
      recorder.rowResults.push({ rowKey, outcome: outcome.kind });
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...over,
  };
  return { deps, recorder };
}

describe("runBulkApply() — happy path", () => {
  it("builds all statements UP FRONT, previews them as a set, executes per-row on confirm", async () => {
    const { deps, recorder } = makeDeps();
    const summary = await runBulkApply(deps, [
      row(1, { name: "Alice" }),
      row(2, { name: "Bob" }),
      row(3, { name: "Carol" }),
    ]);
    expect(summary).toEqual({ applied: 3, failed: 0, cancelled: false });

    // Exactly ONE preview, containing ALL three statements (not three
    // separate previews — the user confirms the whole set at once).
    expect(recorder.previews.length).toBe(1);
    expect(recorder.previews[0]!.count).toBe(3);

    // Per-row executions preserve input order.
    expect(recorder.executed.length).toBe(3);
    expect(recorder.executed[0]!.values).toEqual(["Alice", 1]);
    expect(recorder.executed[1]!.values).toEqual(["Bob", 2]);
    expect(recorder.executed[2]!.values).toEqual(["Carol", 3]);

    // Per-row outcomes streamed in order.
    expect(recorder.rowResults).toEqual([
      { rowKey: "r1", outcome: "applied" },
      { rowKey: "r2", outcome: "applied" },
      { rowKey: "r3", outcome: "applied" },
    ]);
  });

  it("preview statements EQUAL the executed statements (security: user confirms what runs)", async () => {
    const { deps, recorder } = makeDeps();
    await runBulkApply(deps, [row(1, { name: "Alice" }), row(2, { name: "Bob" })]);
    // Preview entries carry a `{rowKey, stmt}` envelope; the inner
    // BuiltStatement reference is the one passed to executeStatement.
    // No rebuild between confirm and run — the user confirms exactly
    // the bytes that run.
    const previewed = recorder.previews[0]!.statements;
    expect(previewed[0]!.stmt).toBe(recorder.executed[0]);
    expect(previewed[1]!.stmt).toBe(recorder.executed[1]);
  });
});

describe("runBulkApply() — partial failure (continue-on-failure)", () => {
  it("a mid-set failure does NOT halt subsequent rows", async () => {
    const boom = new Error("violates check constraint");
    const { deps, recorder } = makeDeps({
      executeStatement: async (stmt) => {
        // Reject row 2 only.
        if (String(stmt.values[1]) === "2") throw boom;
        return { rowsAffected: 1 };
      },
    });
    const summary = await runBulkApply(deps, [
      row(1, { name: "Alice" }),
      row(2, { name: "Bob" }),
      row(3, { name: "Carol" }),
    ]);
    expect(summary).toEqual({ applied: 2, failed: 1, cancelled: false });
    expect(recorder.rowResults).toEqual([
      { rowKey: "r1", outcome: "applied" },
      { rowKey: "r2", outcome: "failed" },
      { rowKey: "r3", outcome: "applied" },
    ]);
  });
});

describe("runBulkApply() — cancel", () => {
  it("returns cancelled and runs NO statements when the user dismisses the preview", async () => {
    const { deps, recorder } = makeDeps({
      presentBulkPreview: async () => "cancelled",
    });
    const summary = await runBulkApply(deps, [
      row(1, { name: "Alice" }),
      row(2, { name: "Bob" }),
    ]);
    expect(summary).toEqual({ applied: 0, failed: 0, cancelled: true });
    expect(recorder.rowResults.length).toBe(0);
  });
});

describe("runBulkApply() — gate rejections (skipped per-row, never executed)", () => {
  it("rejects the entire batch when the connection is read-only", async () => {
    const { deps, recorder } = makeDeps({ mode: "readonly" });
    const summary = await runBulkApply(deps, [row(1, { x: "a" })]);
    expect(summary).toEqual({ applied: 0, failed: 1, cancelled: false });
    expect(recorder.rowResults).toEqual([{ rowKey: "r1", outcome: "rejected" }]);
    // No preview either — the gate rejected before assembling statements.
    expect(recorder.previews.length).toBe(0);
  });

  it("rejects per-row when a row's PK arity doesn't match the descriptor", async () => {
    const compositeDeps = makeDeps({
      descriptor: { schema: "s", table: "t", pkColumns: ["a", "b"] },
    });
    const summary = await runBulkApply(compositeDeps.deps, [
      {
        rowKey: "r1",
        pkValues: [1], // arity mismatch: descriptor wants 2
        changes: { x: 1 },
      },
      {
        rowKey: "r2",
        pkValues: [1, 2], // OK
        changes: { x: 1 },
      },
    ]);
    expect(summary).toEqual({ applied: 1, failed: 1, cancelled: false });
    expect(compositeDeps.recorder.rowResults).toEqual([
      { rowKey: "r1", outcome: "rejected" },
      { rowKey: "r2", outcome: "applied" },
    ]);
  });
});

describe("runBulkApply() — empty input", () => {
  it("no-ops cleanly on an empty dirty-row list", async () => {
    const { deps, recorder } = makeDeps();
    const summary = await runBulkApply(deps, []);
    expect(summary).toEqual({ applied: 0, failed: 0, cancelled: false });
    expect(recorder.previews.length).toBe(0);
    expect(recorder.confirms).toBe(0);
    expect(recorder.executed.length).toBe(0);
  });
});

describe("runBulkApply() — logging", () => {
  it("emits info events for start / preview / per-row / summary", async () => {
    const events: string[] = [];
    const { deps } = makeDeps({
      logger: {
        info: (event) => events.push(`info:${event}`),
        warn: (event) => events.push(`warn:${event}`),
        error: (event) => events.push(`error:${event}`),
      },
    });
    await runBulkApply(deps, [row(1, { x: "a" }), row(2, { x: "b" })]);
    expect(events).toContain("info:grid.bulkApply.start");
    expect(events).toContain("info:grid.bulkApply.previewing");
    expect(events).toContain("info:grid.bulkApply.applied");
  });

  it("logs an error event for each row failure (so cnpg.reportProblem buffer captures it)", async () => {
    const events: string[] = [];
    const { deps } = makeDeps({
      executeStatement: async () => {
        throw new Error("boom");
      },
      logger: {
        info: () => {},
        warn: () => {},
        error: (event) => events.push(event),
      },
    });
    await runBulkApply(deps, [row(1, { x: "a" }), row(2, { x: "b" })]);
    const failed = events.filter((e) => e === "grid.bulkApply.row.failed");
    expect(failed.length).toBe(2);
  });
});
