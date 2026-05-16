/**
 * Unit tests for the pure cell-edit orchestrator (partial T109).
 *
 * The orchestrator is the state machine the future cell-edit renderer
 * channel will call into. It composes the already-landed pieces:
 *
 *   - validateEditRequest() / buildUpdate() / buildDelete() from update-builder
 *   - resolveEditEligibility() (PK descriptor) from result-descriptor
 *   - host-injected presentPreview() + executeStatement() callbacks
 *
 * Tests cover every outcome the host needs to render: applied, cancelled
 * (user said no on the preview modal), rejected (write-mode / PK gate),
 * and failed (the SQL execution itself blew up). The orchestrator also
 * logs every state transition through an injected logger so the
 * cnpg.reportProblem command's recent-buffer surfaces the apply flow.
 */

import { describe, expect, it, vi } from "vitest";
import {
  handleCellEditRequest,
  type CellEditHostDeps,
  type CellEditRequest,
} from "../../src/sql/cell-edit-orchestrator.js";
import type { BuiltStatement, PreviewMeta } from "../../src/sql/update-builder.js";
import type { PkDescriptor } from "../../src/pg/result-descriptor.js";

function makeDeps(overrides: Partial<CellEditHostDeps> = {}): {
  deps: CellEditHostDeps;
  calls: {
    eligibility: number;
    preview: Array<{ stmt: BuiltStatement; meta: PreviewMeta }>;
    execute: Array<BuiltStatement>;
    logs: Array<{ level: "info" | "warn" | "error"; event: string; fields: Record<string, unknown> }>;
  };
} {
  const calls = {
    eligibility: 0,
    preview: [] as Array<{ stmt: BuiltStatement; meta: PreviewMeta }>,
    execute: [] as Array<BuiltStatement>,
    logs: [] as Array<{ level: "info" | "warn" | "error"; event: string; fields: Record<string, unknown> }>,
  };
  const baseDescriptor: PkDescriptor = {
    schema: "public",
    table: "users",
    pkColumns: ["id"],
  };
  const deps: CellEditHostDeps = {
    resolveEligibility: vi.fn(async () => {
      calls.eligibility++;
      return baseDescriptor;
    }),
    presentPreview: vi.fn(async (stmt, meta) => {
      calls.preview.push({ stmt, meta });
      return "confirmed" as const;
    }),
    executeStatement: vi.fn(async (stmt) => {
      calls.execute.push(stmt);
      return { rowsAffected: 1 };
    }),
    logger: {
      info: (event, fields = {}) => calls.logs.push({ level: "info", event, fields }),
      warn: (event, fields = {}) => calls.logs.push({ level: "warn", event, fields }),
      error: (event, fields = {}) => calls.logs.push({ level: "error", event, fields }),
    },
    ...overrides,
  };
  return { deps, calls };
}

const baseRequest: CellEditRequest = {
  sql: "SELECT * FROM public.users",
  mode: "write",
  rowPkValues: [42],
  changes: { name: "Alice" },
  meta: { operation: "UPDATE", target: "public.users" },
};

describe("handleCellEditRequest() — happy path (UPDATE)", () => {
  it("validates → resolves PK → previews → executes → returns applied", async () => {
    const { deps, calls } = makeDeps();
    const out = await handleCellEditRequest(deps, baseRequest);
    expect(out).toEqual({ kind: "applied", rowsAffected: 1 });
    expect(calls.eligibility).toBe(1);
    expect(calls.preview.length).toBe(1);
    expect(calls.execute.length).toBe(1);
    // The preview and execute statements must be IDENTICAL — the user
    // confirms exactly what runs. (Substituting parameters between
    // preview and execute would be a security regression.)
    expect(calls.preview[0]!.stmt).toEqual(calls.execute[0]);
  });

  it("emits a parameterized UPDATE with the PK in the WHERE", async () => {
    const { deps, calls } = makeDeps();
    await handleCellEditRequest(deps, baseRequest);
    const stmt = calls.execute[0]!;
    expect(stmt.text).toBe(
      'UPDATE "public"."users" SET "name" = $1 WHERE "id" = $2',
    );
    expect(stmt.values).toEqual(["Alice", 42]);
  });

  it("logs info events for each state transition", async () => {
    const { deps, calls } = makeDeps();
    await handleCellEditRequest(deps, baseRequest);
    const events = calls.logs.map((l) => l.event);
    expect(events).toContain("cell.edit.start");
    expect(events).toContain("cell.edit.previewing");
    expect(events).toContain("cell.edit.executing");
    expect(events).toContain("cell.edit.applied");
  });
});

describe("handleCellEditRequest() — DELETE flow", () => {
  it("builds a DELETE when the request omits changes (semantics: delete-the-row)", async () => {
    const { deps, calls } = makeDeps();
    const out = await handleCellEditRequest(deps, {
      ...baseRequest,
      meta: { operation: "DELETE", target: "public.users" },
      changes: {},
    });
    expect(out).toEqual({ kind: "applied", rowsAffected: 1 });
    const stmt = calls.execute[0]!;
    expect(stmt.text).toBe('DELETE FROM "public"."users" WHERE "id" = $1');
    expect(stmt.values).toEqual([42]);
  });

  it("rejects an UPDATE with an empty change set as a misuse (NO_CHANGES)", async () => {
    const { deps } = makeDeps();
    const out = await handleCellEditRequest(deps, { ...baseRequest, changes: {} });
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.code).toBe("NO_CHANGES");
  });
});

describe("handleCellEditRequest() — gate rejections", () => {
  it("rejects when the connection is read-only (does NOT call eligibility/preview/execute)", async () => {
    const { deps, calls } = makeDeps();
    const out = await handleCellEditRequest(deps, { ...baseRequest, mode: "readonly" });
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.code).toBe("READ_ONLY");
    expect(calls.eligibility).toBe(0);
    expect(calls.preview.length).toBe(0);
    expect(calls.execute.length).toBe(0);
  });

  it("rejects when eligibility returns null (NO_PK) — does NOT call preview/execute", async () => {
    const { deps, calls } = makeDeps({
      resolveEligibility: async () => null,
    });
    const out = await handleCellEditRequest(deps, baseRequest);
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.code).toBe("NO_PK");
    expect(calls.preview.length).toBe(0);
    expect(calls.execute.length).toBe(0);
  });

  it("rejects when the PK value count doesn't match the descriptor's pkColumns (PK_ARITY)", async () => {
    const { deps, calls } = makeDeps({
      resolveEligibility: async () => ({
        schema: "public",
        table: "users",
        pkColumns: ["tenant_id", "user_id"], // 2-column composite
      }),
    });
    const out = await handleCellEditRequest(deps, {
      ...baseRequest,
      rowPkValues: [42], // only 1 value supplied
    });
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.code).toBe("PK_ARITY");
    expect(calls.execute.length).toBe(0);
  });
});

describe("handleCellEditRequest() — user-side outcomes", () => {
  it("returns cancelled when the user dismisses the preview modal", async () => {
    const { deps, calls } = makeDeps({
      presentPreview: async () => "cancelled",
    });
    const out = await handleCellEditRequest(deps, baseRequest);
    expect(out).toEqual({ kind: "cancelled" });
    expect(calls.execute.length).toBe(0); // NEVER execute on cancel
  });

  it("logs a warn event on cancel so the cnpg.reportProblem buffer captures it", async () => {
    const { deps, calls } = makeDeps({
      presentPreview: async () => "cancelled",
    });
    await handleCellEditRequest(deps, baseRequest);
    const cancelLogs = calls.logs.filter((l) => l.event === "cell.edit.cancelled");
    expect(cancelLogs.length).toBe(1);
  });
});

describe("handleCellEditRequest() — execution failure", () => {
  it("returns failed when the underlying executor throws", async () => {
    const boom = new Error("violates check constraint");
    const { deps, calls } = makeDeps({
      executeStatement: async () => {
        throw boom;
      },
    });
    const out = await handleCellEditRequest(deps, baseRequest);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.error).toBe(boom);
    }
    // An error log MUST appear (so cnpg.reportProblem surfaces it).
    const errorLogs = calls.logs.filter((l) => l.level === "error");
    expect(errorLogs.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves the original error even if the executor throws a non-Error", async () => {
    const { deps } = makeDeps({
      executeStatement: async () => {
        throw "string error"; // eslint-disable-line @typescript-eslint/only-throw-error
      },
    });
    const out = await handleCellEditRequest(deps, baseRequest);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.error).toBeInstanceOf(Error);
      expect(out.error.message).toContain("string error");
    }
  });
});

describe("handleCellEditRequest() — preview-execute identity invariant", () => {
  it("the user never sees a different SQL than what executes (parameter-tampering guard)", async () => {
    // The orchestrator builds the BuiltStatement once and hands the SAME
    // object reference to presentPreview AND executeStatement. Any
    // refactor that breaks this (e.g. rebuilding the statement after
    // confirm) is a security regression — the user must confirm the
    // exact bytes that run.
    const { deps, calls } = makeDeps();
    await handleCellEditRequest(deps, baseRequest);
    expect(calls.preview[0]!.stmt).toBe(calls.execute[0]);
  });
});
