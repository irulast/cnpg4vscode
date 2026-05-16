import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HistoryEntry, HistoryStore } from "../../src/state/history-store.js";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tmpFile(): string {
  const d = mkdtempSync(path.join(tmpdir(), "cnpg-history-"));
  tmps.push(d);
  return path.join(d, "history.json");
}

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    ts: 1_700_000_000_000,
    clusterId: "ctx/ns/cluster",
    database: "appdb",
    user: "app",
    redactedSql: "SELECT 1",
    durationMs: 12,
    rows: 1,
    ok: true,
    ...overrides,
  };
}

describe("HistoryStore", () => {
  it("append + load round-trip preserves entries in insertion order", async () => {
    const store = new HistoryStore({ filePath: tmpFile(), maxEntries: 100 });
    await store.append(entry({ ts: 1, redactedSql: "SELECT 1" }));
    await store.append(entry({ ts: 2, redactedSql: "SELECT 2" }));
    await store.append(entry({ ts: 3, redactedSql: "SELECT 3" }));
    const loaded = await store.load();
    expect(loaded.map((e) => e.redactedSql)).toEqual([
      "SELECT 1",
      "SELECT 2",
      "SELECT 3",
    ]);
  });

  it("load() on a missing file returns []", async () => {
    const store = new HistoryStore({ filePath: tmpFile(), maxEntries: 100 });
    expect(await store.load()).toEqual([]);
  });

  it("load() on a malformed file returns [] (defensive, does not throw)", async () => {
    const file = tmpFile();
    writeFileSync(file, "not json");
    const store = new HistoryStore({ filePath: file, maxEntries: 100 });
    expect(await store.load()).toEqual([]);
  });

  it("load() on a file with non-array JSON returns []", async () => {
    const file = tmpFile();
    writeFileSync(file, "{}");
    const store = new HistoryStore({ filePath: file, maxEntries: 100 });
    expect(await store.load()).toEqual([]);
  });

  it("prunes to maxEntries on append (oldest first)", async () => {
    const store = new HistoryStore({ filePath: tmpFile(), maxEntries: 3 });
    for (let i = 0; i < 5; i++) await store.append(entry({ ts: i, redactedSql: `q${i}` }));
    const loaded = await store.load();
    expect(loaded.length).toBe(3);
    expect(loaded.map((e) => e.redactedSql)).toEqual(["q2", "q3", "q4"]);
  });

  it("clear() removes all entries (file persists as []) ", async () => {
    const file = tmpFile();
    const store = new HistoryStore({ filePath: file, maxEntries: 100 });
    await store.append(entry({ redactedSql: "SELECT 1" }));
    await store.clear();
    expect(await store.load()).toEqual([]);
    // File should still exist with an empty array — atomicity friendly.
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("search() filters by substring match against redactedSql", async () => {
    const store = new HistoryStore({ filePath: tmpFile(), maxEntries: 100 });
    await store.append(entry({ redactedSql: "SELECT * FROM users" }));
    await store.append(entry({ redactedSql: "SELECT * FROM orders" }));
    await store.append(entry({ redactedSql: "SELECT count(*) FROM users" }));
    const hits = await store.search("users");
    expect(hits.length).toBe(2);
    expect(hits.every((e) => e.redactedSql.includes("users"))).toBe(true);
  });

  it("search() is case-insensitive", async () => {
    const store = new HistoryStore({ filePath: tmpFile(), maxEntries: 100 });
    await store.append(entry({ redactedSql: "SELECT * FROM Users" }));
    const hits = await store.search("users");
    expect(hits.length).toBe(1);
  });

  it("search('') returns every entry", async () => {
    const store = new HistoryStore({ filePath: tmpFile(), maxEntries: 100 });
    await store.append(entry({ redactedSql: "a" }));
    await store.append(entry({ redactedSql: "b" }));
    const hits = await store.search("");
    expect(hits.length).toBe(2);
  });

  it("search() can filter by clusterId in addition to substring", async () => {
    const store = new HistoryStore({ filePath: tmpFile(), maxEntries: 100 });
    await store.append(entry({ clusterId: "a/b/c", redactedSql: "SELECT 1" }));
    await store.append(entry({ clusterId: "x/y/z", redactedSql: "SELECT 2" }));
    const hits = await store.search("", { clusterId: "a/b/c" });
    expect(hits.length).toBe(1);
    expect(hits[0]!.clusterId).toBe("a/b/c");
  });

  it("returns entries most-recent-first when reversed=true (default for the picker)", async () => {
    const store = new HistoryStore({ filePath: tmpFile(), maxEntries: 100 });
    await store.append(entry({ ts: 1, redactedSql: "first" }));
    await store.append(entry({ ts: 2, redactedSql: "second" }));
    const hits = await store.search("", { reversed: true });
    expect(hits.map((e) => e.redactedSql)).toEqual(["second", "first"]);
  });

  it("concurrent appends do not corrupt the file (sequenced via in-flight write lock)", async () => {
    const store = new HistoryStore({ filePath: tmpFile(), maxEntries: 100 });
    const writes = Array.from({ length: 20 }, (_, i) =>
      store.append(entry({ ts: i, redactedSql: `q${i}` })),
    );
    await Promise.all(writes);
    const loaded = await store.load();
    expect(loaded.length).toBe(20);
    expect(new Set(loaded.map((e) => e.redactedSql)).size).toBe(20);
  });

  it("refuses to persist an entry whose redactedSql still contains an obvious credential literal", async () => {
    const store = new HistoryStore({ filePath: tmpFile(), maxEntries: 100 });
    await expect(
      store.append(entry({ redactedSql: "CREATE ROLE x WITH PASSWORD 'leak'" })),
    ).rejects.toThrow(/redact/i);
    expect(await store.load()).toEqual([]);
  });
});
