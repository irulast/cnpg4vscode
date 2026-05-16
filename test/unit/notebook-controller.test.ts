import { describe, expect, it } from "vitest";
import { controllerLabel, executeCellSql } from "../../src/notebook/controller-core.js";

function fakeConn(opts: {
  mode: "readonly" | "write";
  result?: unknown;
  error?: Error;
}) {
  return {
    id: "test",
    cluster: { contextName: "c", namespace: "ns", clusterName: "x" },
    database: "d",
    user: "u",
    connection: {
      mode: opts.mode,
      query: async (_sql: string, _params?: ReadonlyArray<unknown>): Promise<unknown> => {
        if (opts.error) throw opts.error;
        return opts.result ?? { command: "SELECT", rowCount: 1, fields: [{ name: "x" }], rows: [{ x: 1 }] };
      },
    },
  };
}

describe("controllerLabel()", () => {
  it("composes cluster/db (mode)", () => {
    expect(
      controllerLabel({
        cluster: { clusterName: "app-db", namespace: "default", contextName: "kind" },
        database: "postgres",
        connection: { mode: "readonly" } as never,
      } as never),
    ).toBe("app-db/postgres (read-only)");
  });

  it("uses 'write' when in write mode", () => {
    expect(
      controllerLabel({
        cluster: { clusterName: "x", namespace: "ns", contextName: "c" },
        database: "d",
        connection: { mode: "write" } as never,
      } as never),
    ).toBe("x/d (write)");
  });
});

describe("executeCellSql() — read-only mode", () => {
  it("rejects a write statement before sending to the server", async () => {
    let queries = 0;
    const base = fakeConn({ mode: "readonly" });
    const conn = {
      ...base,
      connection: {
        ...base.connection,
        query: async () => {
          queries++;
          return { command: "DELETE", rowCount: 0, fields: [], rows: [] } as never;
        },
      },
    };
    const out = await executeCellSql(conn as never, "DELETE FROM users");
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toMatch(/Write mode/i);
    expect(queries).toBe(0);
  });

  it("accepts a SELECT and returns the QueryResult", async () => {
    const out = await executeCellSql(fakeConn({ mode: "readonly" }) as never, "SELECT 1");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.result.rowCount).toBe(1);
  });

  it("surfaces upstream errors as 'error' results", async () => {
    const out = await executeCellSql(
      fakeConn({ mode: "readonly", error: Object.assign(new Error("boom"), { code: "42601" }) }) as never,
      "SELECT 1",
    );
    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.message).toContain("boom");
      expect(out.sqlstate).toBe("42601");
    }
  });
});

describe("executeCellSql() — write mode", () => {
  it("passes any statement through to the server", async () => {
    const out = await executeCellSql(
      fakeConn({ mode: "write", result: { command: "CREATE", rowCount: 0, fields: [], rows: [] } }) as never,
      "CREATE TABLE t (id int)",
    );
    expect(out.kind).toBe("ok");
  });
});

describe("executeCellSql() — empty / blank input", () => {
  it("returns rejected on empty input without hitting the server", async () => {
    let queries = 0;
    const base = fakeConn({ mode: "readonly" });
    const conn = {
      ...base,
      connection: {
        ...base.connection,
        query: async () => {
          queries++;
          return {} as never;
        },
      },
    };
    const out = await executeCellSql(conn as never, "   \n   ");
    expect(out.kind).toBe("rejected");
    expect(queries).toBe(0);
  });
});
