/**
 * Contract — DatabaseConnection.withClient() resource-management.
 *
 * Locks in the guarantee the migration wizard depends on: a borrowed
 * client is ALWAYS released back to the pool, regardless of whether
 * the callback succeeds, throws synchronously, or rejects
 * asynchronously. A leaked client is a latent connection-pool
 * exhaustion bug — easy to write, hard to spot.
 *
 * The test mocks `pg` so it doesn't open a real socket. The mock
 * tracks `connect()` calls and the `release()` calls on the returned
 * client; assertions verify the pairing 1:1.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// Captured-call sinks — populated by every call into the mock.
const connectCalls: number[] = [];
const releaseCalls: number[] = [];

vi.mock("pg", () => {
  let nextId = 0;
  class MockPool {
    async connect(): Promise<unknown> {
      const id = ++nextId;
      connectCalls.push(id);
      return {
        release: () => {
          releaseCalls.push(id);
        },
        query: async () => ({ rows: [], rowCount: 0 }),
      };
    }
    async end(): Promise<void> {}
  }
  return { default: { Pool: MockPool }, Pool: MockPool };
});

// AFTER the mock — DatabaseConnection imports `pg.Pool` at module load.
import { DatabaseConnection } from "../../../src/pg/connection.js";

function makeConn(): DatabaseConnection {
  // Inputs are irrelevant for the resource-management test; the mock
  // pool ignores them.
  return new DatabaseConnection({
    host: "127.0.0.1",
    port: 0,
    user: "x",
    password: "x",
    database: "x",
    serverName: "x",
    caBundle: "",
    mode: "readonly",
    clusterId: "ctx/ns/cluster",
  });
}

describe("DatabaseConnection.withClient() — release on success", () => {
  afterEach(() => {
    connectCalls.length = 0;
    releaseCalls.length = 0;
  });

  it("borrows one client, hands it to the callback, releases it after success", async () => {
    const conn = makeConn();
    const seen: unknown[] = [];
    const result = await conn.withClient(async (c) => {
      seen.push(c);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(connectCalls.length).toBe(1);
    expect(releaseCalls).toEqual(connectCalls); // 1:1, same id
    expect(seen.length).toBe(1);
  });

  it("releases the same client multiple times across sequential calls", async () => {
    const conn = makeConn();
    for (let i = 0; i < 5; i++) await conn.withClient(async () => i);
    expect(connectCalls.length).toBe(5);
    expect(releaseCalls.length).toBe(5);
    // Every borrowed id is released — no leaks.
    for (const id of connectCalls) expect(releaseCalls).toContain(id);
  });
});

describe("DatabaseConnection.withClient() — release on throw", () => {
  afterEach(() => {
    connectCalls.length = 0;
    releaseCalls.length = 0;
  });

  it("releases the client even when the callback rejects with an Error", async () => {
    const conn = makeConn();
    const boom = new Error("inside the callback");
    await expect(
      conn.withClient(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(connectCalls.length).toBe(1);
    expect(releaseCalls).toEqual(connectCalls); // released despite the throw
  });

  it("releases the client even when the callback throws a non-Error", async () => {
    const conn = makeConn();
    await expect(
      conn.withClient(async () => {
        throw "string error"; // eslint-disable-line @typescript-eslint/only-throw-error
      }),
    ).rejects.toBe("string error");
    expect(releaseCalls).toEqual(connectCalls);
  });

  it("releases the client when the callback throws synchronously inside the async fn", async () => {
    const conn = makeConn();
    // Throwing synchronously inside an async function still wraps into a
    // rejection — the finally clause must fire either way.
    await expect(
      conn.withClient(async () => {
        // eslint-disable-next-line no-throw-literal
        throw new Error("sync throw");
      }),
    ).rejects.toThrow("sync throw");
    expect(releaseCalls).toEqual(connectCalls);
  });
});

describe("DatabaseConnection.withClient() — concurrent borrows", () => {
  afterEach(() => {
    connectCalls.length = 0;
    releaseCalls.length = 0;
  });

  it("each concurrent withClient borrows a distinct client and releases it", async () => {
    const conn = makeConn();
    await Promise.all([
      conn.withClient(async () => "a"),
      conn.withClient(async () => "b"),
      conn.withClient(async () => "c"),
    ]);
    expect(connectCalls.length).toBe(3);
    expect(releaseCalls.length).toBe(3);
    // All distinct ids — no client reused across overlapping borrows.
    expect(new Set(connectCalls).size).toBe(3);
    expect(new Set(releaseCalls).size).toBe(3);
  });
});
