/**
 * Pure migration-wizard flow orchestrator. Split off from the host
 * glue in `src/commands/migration.ts` so vitest can exercise every
 * branch without resolving `vscode` or `pg` at module load.
 *
 * Composes:
 *   - splitStatements()         from src/sql/statement-split.ts
 *   - classifyMigration()       from src/sql/migration.ts
 *   - exportMigrationToSql()    from src/sql/migration.ts
 *   - and the host-injected confirm/ask/write/execute callbacks
 *
 * No vscode, no pg. The host wires the four callbacks; tests stub them.
 */

import { splitStatements } from "./statement-split.js";
import {
  classifyMigration,
  exportMigrationToSql,
  type MigrationResult,
} from "./migration.js";
import { redact } from "../pg/redact.js";

/**
 * Identifying surface the orchestrator pulls from the host's
 * `ActiveConnection` — duck-typed so this module stays vscode-free.
 */
export interface MigrationFlowConn {
  readonly id: string;
  readonly cluster: {
    readonly namespace: string;
    readonly clusterName: string;
  };
  readonly database: string;
  readonly connection: { readonly mode: "readonly" | "write" };
}

export interface MigrationFlowDeps {
  readonly conn: MigrationFlowConn;
  readonly sqlBuffer: string;
  confirmRun(preview: MigrationPreview): Promise<"confirmed" | "cancelled">;
  askExport(): Promise<"yes" | "no">;
  writeExport(relativePath: string, body: string): Promise<string | null>;
  executeViaClient(statements: ReadonlyArray<string>): Promise<MigrationResult>;
  /** Injected so tests can pin the timestamped filename. */
  now?: () => Date;
  /** Injected so tests can verify redactor pass-through. Defaults to the real redact(). */
  redactor?: (sql: string) => string;
  /** Logger sink. Defaults to no-op so the pure module stays test-friendly. */
  logger?: {
    info(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
    error(event: string, fields?: Record<string, unknown>): void;
  };
}

export interface MigrationPreview {
  readonly statements: ReadonlyArray<string>;
  readonly transactional: boolean;
  readonly nonTransactionalIndexes: ReadonlyArray<number>;
  /** Connection identity for the modal header. */
  readonly target: string;
}

export type MigrationFlowOutcome =
  | { kind: "cancelled" }
  | { kind: "no-statements" }
  | { kind: "ok"; statements: ReadonlyArray<string>; exportedTo: string | null }
  | {
      kind: "partiallyApplied";
      statements: ReadonlyArray<string>;
      failedIndex: number;
      completedIndexes: ReadonlyArray<number>;
      error: Error;
    }
  | {
      kind: "failed";
      statements: ReadonlyArray<string>;
      failedIndex: number;
      error: Error;
      rolledBack: boolean;
    };

const NOOP_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export async function runMigrationFlow(deps: MigrationFlowDeps): Promise<MigrationFlowOutcome> {
  const logger = deps.logger ?? NOOP_LOGGER;
  const statements = splitStatements(deps.sqlBuffer);
  if (statements.length === 0) return { kind: "no-statements" };

  const classification = classifyMigration(statements);
  logger.info("migration.classified", {
    connection: deps.conn.id,
    count: statements.length,
    transactional: classification.transactional,
  });

  const preview: MigrationPreview = {
    statements,
    transactional: classification.transactional,
    nonTransactionalIndexes: classification.nonTransactionalIndexes,
    target: `${deps.conn.cluster.namespace}/${deps.conn.cluster.clusterName}/${deps.conn.database}`,
  };
  const decision = await deps.confirmRun(preview);
  if (decision === "cancelled") {
    logger.warn("migration.cancelled", { connection: deps.conn.id });
    return { kind: "cancelled" };
  }

  logger.info("migration.executing", {
    connection: deps.conn.id,
    transactional: classification.transactional,
    count: statements.length,
  });
  const result = await deps.executeViaClient(statements);

  if (result.kind === "failed") {
    logger.error("migration.failed", {
      connection: deps.conn.id,
      failedIndex: result.failedIndex,
      reason: result.error.message,
    });
    return {
      kind: "failed",
      statements,
      failedIndex: result.failedIndex,
      error: result.error,
      rolledBack: result.rolledBack,
    };
  }
  if (result.kind === "partiallyApplied") {
    logger.error("migration.partiallyApplied", {
      connection: deps.conn.id,
      failedIndex: result.failedIndex,
      completed: result.completedIndexes.length,
    });
    return {
      kind: "partiallyApplied",
      statements,
      failedIndex: result.failedIndex,
      completedIndexes: result.completedIndexes,
      error: result.error,
    };
  }

  // Success — offer export.
  logger.info("migration.applied", {
    connection: deps.conn.id,
    count: statements.length,
  });
  const wantExport = await deps.askExport();
  if (wantExport !== "yes") return { kind: "ok", statements, exportedTo: null };
  const { filename, body } = exportMigrationToSql({
    statements,
    now: (deps.now ?? (() => new Date()))(),
    redactor: deps.redactor ?? redact,
  });
  const writtenTo = await deps.writeExport(`migrations/${filename}`, body);
  logger.info("migration.exported", { connection: deps.conn.id, path: writtenTo });
  return { kind: "ok", statements, exportedTo: writtenTo };
}
