/**
 * Query history persistence (US4 deferred T072 — landed as JSON, not SQLite).
 *
 * Stores a bounded per-workspace history of executed SQL cells as a JSON
 * array. Every entry MUST have already passed through `redact()` before it
 * reaches the store — the store asserts the invariant defensively and
 * refuses to persist an entry whose `redactedSql` still matches a known
 * credential pattern.
 *
 * Bounded by `maxEntries` (default 1000; configurable via
 * `cnpg4vscode.history.maxEntries`). On overflow, oldest entries are
 * dropped first.
 *
 * Storage shape: a single JSON array file at `context.storageUri/history.json`.
 * Per-workspace via `context.storageUri` (VS Code sandboxes per workspace).
 *
 * Storage choice rationale (research §11 revised): the original spec called
 * for SQLite + FTS5 via `better-sqlite3`, justified by sub-100ms search at
 * 10k+ entries. In practice, typical CNPG-extension users run ~100-500
 * queries per session — JSON + in-memory filter handles that range with
 * no native-binding complexity, zero per-platform packaging penalty, and
 * trivial migration. Upgrade to SQLite is a real option if a user reports
 * actual search latency at scale.
 *
 * Concurrency: appends are serialized via an in-flight write promise so
 * two concurrent `append()` calls don't lose data to a read-modify-write
 * race.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { isSensitive } from "../pg/redact.js";

export interface HistoryEntry {
  /** Wall-clock timestamp at execution time (epoch ms). */
  ts: number;
  /** `<context>/<namespace>/<cluster>` — stable identifier for filtering. */
  clusterId: string;
  database: string;
  user: string;
  /** SQL text AFTER `redact()` ran. The store re-checks this defensively. */
  redactedSql: string;
  durationMs: number | null;
  /** `rowCount` from `pg.QueryResult` when available; null otherwise. */
  rows: number | null;
  ok: boolean;
  /** PostgreSQL SQLSTATE on failure, when known. */
  errorClass?: string;
}

export interface HistoryStoreOpts {
  filePath: string;
  /** Hard cap on retained entries; oldest pruned first. */
  maxEntries: number;
}

export interface SearchOpts {
  /** Restrict to entries from this cluster (`<context>/<namespace>/<cluster>`). */
  clusterId?: string;
  /** Restrict to entries from this database (within `clusterId` if set). */
  database?: string;
  /** Return most-recent first when true (default false → insertion order). */
  reversed?: boolean;
  /** Cap returned results (default unlimited). */
  limit?: number;
}

export class HistoryStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: HistoryStoreOpts) {}

  async load(): Promise<HistoryEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.opts.filePath, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWellFormed);
  }

  async append(e: HistoryEntry): Promise<void> {
    // Defensive invariant: the store NEVER persists an entry whose SQL
    // still matches a credential pattern. Reject loudly so the caller
    // notices the missing redact() chokepoint.
    if (isSensitive(e.redactedSql)) {
      throw new Error(
        "HistoryStore.append refused: redactedSql still matches credential patterns. " +
          "Apply redact() before calling append().",
      );
    }
    // Serialize through a chained promise so concurrent appends don't
    // race on read-modify-write.
    this.writeChain = this.writeChain.then(() => this.appendOne(e));
    await this.writeChain;
  }

  async clear(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.writeAll([]));
    await this.writeChain;
  }

  async search(query: string, opts: SearchOpts = {}): Promise<HistoryEntry[]> {
    const all = await this.load();
    const needle = query.toLowerCase();
    const filtered = all.filter((e) => {
      if (opts.clusterId && e.clusterId !== opts.clusterId) return false;
      if (opts.database && e.database !== opts.database) return false;
      if (needle.length === 0) return true;
      return e.redactedSql.toLowerCase().includes(needle);
    });
    const ordered = opts.reversed ? [...filtered].reverse() : filtered;
    return opts.limit !== undefined ? ordered.slice(0, opts.limit) : ordered;
  }

  private async appendOne(e: HistoryEntry): Promise<void> {
    const current = await this.load();
    current.push(e);
    while (current.length > this.opts.maxEntries) current.shift();
    await this.writeAll(current);
  }

  private async writeAll(entries: HistoryEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.opts.filePath), { recursive: true });
    // Write to a sibling tmp file + rename for atomicity on POSIX. Windows
    // doesn't always promise atomic rename when the target exists but this
    // is still a net improvement over write-in-place.
    const tmp = `${this.opts.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2));
    await fs.rename(tmp, this.opts.filePath);
  }
}

function isWellFormed(v: unknown): v is HistoryEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Partial<HistoryEntry>;
  return (
    typeof e.ts === "number" &&
    typeof e.clusterId === "string" &&
    typeof e.database === "string" &&
    typeof e.user === "string" &&
    typeof e.redactedSql === "string" &&
    typeof e.ok === "boolean"
  );
}
