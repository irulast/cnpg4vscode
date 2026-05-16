/**
 * Migration wizard engine (US6; T113 + T114; FR-027).
 *
 * Pure module — no `pg`, no `vscode`. Consumed by the future migration
 * wizard webview host (T112) which:
 *   1. Collects an ordered statement list from the user.
 *   2. Calls `classifyMigration()` to surface a warning when the set is
 *      non-transactional (`CREATE INDEX CONCURRENTLY` and friends can't
 *      run inside `BEGIN/COMMIT`, so a mid-set failure leaves the
 *      already-applied prefix in place).
 *   3. Calls `executeMigration()` against a thin client adapter wrapping
 *      `pg.Pool.query` to run the set, with `BEGIN/COMMIT/ROLLBACK`
 *      protocol enforced HERE (the wizard never speaks SQL protocol
 *      verbs directly).
 *   4. Calls `exportMigrationToSql()` to persist the assembled SQL —
 *      every statement is routed through the injected redactor so
 *      credential literals in CREATE ROLE / CREATE SUBSCRIPTION
 *      statements never land on disk (Constitution §IV).
 *
 * The client adapter is a single-method interface so tests can drive the
 * full transactional protocol without pulling in `pg`. The notebook
 * controller layer wraps `pg.PoolClient.query` to satisfy this contract.
 */

/**
 * Minimal client surface the migration engine needs. The notebook
 * controller satisfies this via `pg.PoolClient.query`. Tests provide
 * an in-memory stub. The engine assumes `query()` rejects when the
 * statement fails — exactly the `pg` driver's behavior.
 */
export interface MigrationClient {
  query(sql: string, values?: ReadonlyArray<unknown>): Promise<{ rowCount?: number }>;
}

/**
 * Detects statements that cannot run inside an explicit transaction
 * block. PostgreSQL's list is small but load-bearing — running these
 * inside `BEGIN/COMMIT` fails with `ERROR: <stmt> cannot run inside a
 * transaction block`. The full set (per PG docs):
 *
 *   - CREATE / DROP INDEX CONCURRENTLY
 *   - REINDEX … CONCURRENTLY
 *   - VACUUM (any form)
 *   - CLUSTER (without args)
 *   - ALTER SYSTEM
 *   - ALTER TYPE … ADD VALUE  (unless IF NOT EXISTS form is used and
 *     PG ≥ 12 — we conservatively treat all forms as non-transactional)
 *   - CREATE DATABASE / DROP DATABASE / CREATE TABLESPACE / DROP
 *     TABLESPACE (also non-txn, but the wizard would reject these on
 *     the schema-tree side; included here for completeness)
 *
 * The classifier strips comments and leading whitespace before matching
 * — the upstream wizard accepts pasted SQL that may have explanatory
 * leading comments.
 */
export function isNonTransactional(sql: string): boolean {
  const stripped = stripLeadingNoise(sql).toUpperCase();
  // Order matters: more-specific patterns first.
  if (/^\s*(CREATE|DROP)\s+INDEX\s+CONCURRENTLY\b/.test(stripped)) return true;
  if (/^\s*REINDEX\s+\w+\s+CONCURRENTLY\b/.test(stripped)) return true;
  if (/^\s*VACUUM\b/.test(stripped)) return true;
  if (/^\s*CLUSTER\b/.test(stripped)) return true;
  if (/^\s*ALTER\s+SYSTEM\b/.test(stripped)) return true;
  if (/^\s*ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE\b/.test(stripped)) return true;
  if (/^\s*(CREATE|DROP)\s+DATABASE\b/.test(stripped)) return true;
  if (/^\s*(CREATE|DROP)\s+TABLESPACE\b/.test(stripped)) return true;
  return false;
}

function stripLeadingNoise(sql: string): string {
  // Drop leading -- line comments, /* block comments */, and whitespace
  // until we hit something else. This keeps the per-rule regexes
  // anchored to the actual first keyword.
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "");
    s = s.replace(/^--[^\n]*\n?/, "");
    s = s.replace(/^\/\*[\s\S]*?\*\//, "");
    if (s === before) break;
  }
  return s;
}

export interface MigrationClassification {
  transactional: boolean;
  /** Indexes (into the input array) of statements that are non-transactional. */
  nonTransactionalIndexes: number[];
}

export function classifyMigration(
  statements: ReadonlyArray<string>,
): MigrationClassification {
  const nonTransactionalIndexes: number[] = [];
  for (let i = 0; i < statements.length; i++) {
    if (isNonTransactional(statements[i]!)) nonTransactionalIndexes.push(i);
  }
  return {
    transactional: nonTransactionalIndexes.length === 0,
    nonTransactionalIndexes,
  };
}

export type MigrationResult =
  | { kind: "ok" }
  | {
      kind: "failed";
      /** Index (into the input array) of the statement that threw. */
      failedIndex: number;
      error: Error;
      /** True when ROLLBACK ran cleanly; false when ROLLBACK itself blew up. */
      rolledBack: boolean;
    }
  | {
      kind: "partiallyApplied";
      /** Index of the statement that threw. */
      failedIndex: number;
      /** Indexes of statements that completed successfully before the failure. */
      completedIndexes: number[];
      error: Error;
    };

/**
 * Run an ordered statement list against the client. Decides BEGIN/COMMIT
 * wrapping based on `classifyMigration()`:
 *
 *   - All-transactional: BEGIN → each stmt → COMMIT. Any failure → ROLLBACK,
 *     return `{kind:"failed"}`.
 *   - Contains non-transactional DDL: NO transaction wrap. Any failure →
 *     return `{kind:"partiallyApplied"}` (the already-applied prefix
 *     stays applied — PG can't undo committed CREATE INDEX CONCURRENTLY).
 *
 * Empty statement set → `{kind:"ok"}` with no protocol verbs issued.
 */
export async function executeMigration(
  client: MigrationClient,
  statements: ReadonlyArray<string>,
): Promise<MigrationResult> {
  if (statements.length === 0) return { kind: "ok" };

  const { transactional } = classifyMigration(statements);

  if (!transactional) {
    const completed: number[] = [];
    for (let i = 0; i < statements.length; i++) {
      try {
        await client.query(statements[i]!);
        completed.push(i);
      } catch (err) {
        return {
          kind: "partiallyApplied",
          failedIndex: i,
          completedIndexes: completed,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
    return { kind: "ok" };
  }

  // Transactional path.
  await client.query("BEGIN");
  for (let i = 0; i < statements.length; i++) {
    try {
      await client.query(statements[i]!);
    } catch (err) {
      const original = err instanceof Error ? err : new Error(String(err));
      let rolledBack = true;
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original failure remains the user-facing one; the rollback
        // failure is implicit in `rolledBack: false`.
        rolledBack = false;
      }
      return { kind: "failed", failedIndex: i, error: original, rolledBack };
    }
  }
  await client.query("COMMIT");
  return { kind: "ok" };
}

// ---------------------------------------------------------------------------
// Export-to-.sql (T114)
// ---------------------------------------------------------------------------

export interface ExportMigrationOptions {
  readonly statements: ReadonlyArray<string>;
  /** Injected clock for deterministic filenames in tests. */
  readonly now: Date;
  /**
   * Redactor applied to every emitted statement — typically the
   * `redact()` chokepoint from src/pg/redact.ts. Injected so the engine
   * stays test-friendly and the production wiring is explicit at the
   * call site (Constitution §IV: every persisted artifact MUST flow
   * through the redactor).
   */
  readonly redactor: (sql: string) => string;
}

export interface ExportedMigration {
  /** Basename only — caller joins against `${scriptsRoot}` to write. */
  readonly filename: string;
  readonly body: string;
}

/**
 * Render the assembled migration as a self-documenting `.sql` file. The
 * caller writes the body to `${scriptsRoot}/${filename}` — the engine
 * doesn't touch the filesystem so it remains pure / testable.
 *
 * Format:
 *
 *   - Leading comment header with the generated-at ISO timestamp.
 *   - `BEGIN;` / `COMMIT;` wrap iff `classifyMigration().transactional`.
 *   - Each statement on its own line, redacted, terminated with `;` if
 *     the user's text didn't already end with one.
 */
export function exportMigrationToSql(opts: ExportMigrationOptions): ExportedMigration {
  const cls = classifyMigration(opts.statements);
  const generatedAt = opts.now.toISOString();
  const lines: string[] = [
    `-- Migration exported by cnpg4vscode at ${generatedAt}`,
    `-- ${opts.statements.length} statement(s); ${cls.transactional ? "transactional" : "non-transactional"} execution mode.`,
    "",
  ];
  if (cls.transactional) lines.push("BEGIN;", "");
  for (const raw of opts.statements) {
    const safe = opts.redactor(raw).trimEnd();
    lines.push(safe.endsWith(";") ? safe : `${safe};`);
  }
  if (cls.transactional) lines.push("", "COMMIT;");
  return {
    filename: filenameFor(opts.now),
    body: lines.join("\n") + "\n",
  };
}

function filenameFor(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const min = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}-migration.sql`;
}
