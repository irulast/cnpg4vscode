/**
 * Bulk-apply orchestration for the Grid Editor (US6 Phase 8.5 — T151).
 *
 * Wraps the existing single-row `buildUpdate()` + per-row execution so
 * the user confirms ALL dirty rows in ONE preview, then statements run
 * with continue-on-failure semantics. Per-row outcomes stream via the
 * injected `onRowResult` callback so the renderer can clear dirty
 * marks incrementally.
 *
 * Pure module — no `vscode`, no `pg`. The host wires:
 *   - `presentBulkPreview` → opens the modal showing all UPDATE statements
 *   - `executeStatement`   → `pg.PoolClient.query` (one client per row;
 *                            the orchestrator doesn't manage transactions
 *                            because per-row independence is the point)
 *   - `onRowResult`        → posts `applyResult` messages to the renderer
 *
 * Security invariant: each `BuiltStatement` reference handed to
 * `presentBulkPreview` is the SAME object reference passed to
 * `executeStatement`. The user confirms exactly the bytes that run —
 * no rebuild between confirm and run. Locked in by a dedicated test.
 */

import {
  buildUpdate,
  type BuiltStatement,
  type ColumnChange,
  type ConnectionMode,
} from "../sql/update-builder.js";
import type { PkDescriptor } from "../pg/result-descriptor.js";

export interface DirtyRowRequest {
  readonly rowKey: string;
  readonly pkValues: ReadonlyArray<unknown>;
  readonly changes: Readonly<Record<string, ColumnChange>>;
}

export type RowOutcome =
  | { readonly kind: "applied"; readonly rowsAffected: number }
  | { readonly kind: "rejected"; readonly code: string; readonly reason: string }
  | { readonly kind: "failed"; readonly error: Error };

export interface BulkApplyDeps {
  readonly descriptor: PkDescriptor;
  readonly mode: ConnectionMode;
  presentBulkPreview(
    statements: ReadonlyArray<{ readonly rowKey: string; readonly stmt: BuiltStatement }>,
  ): Promise<"confirmed" | "cancelled">;
  executeStatement(stmt: BuiltStatement): Promise<{ rowsAffected: number }>;
  onRowResult(rowKey: string, outcome: RowOutcome): void;
  readonly logger: {
    info(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
    error(event: string, fields?: Record<string, unknown>): void;
  };
}

export interface BulkApplySummary {
  readonly applied: number;
  readonly failed: number;
  readonly cancelled: boolean;
}

export async function runBulkApply(
  deps: BulkApplyDeps,
  rows: ReadonlyArray<DirtyRowRequest>,
): Promise<BulkApplySummary> {
  if (rows.length === 0) {
    return { applied: 0, failed: 0, cancelled: false };
  }

  deps.logger.info("grid.bulkApply.start", {
    rows: rows.length,
    target: `${deps.descriptor.schema ?? "public"}.${deps.descriptor.table}`,
    mode: deps.mode,
  });

  // Connection-mode gate (FR-020). Reject every row up front — no
  // preview because there's nothing to confirm.
  if (deps.mode !== "write") {
    for (const r of rows) {
      const outcome: RowOutcome = {
        kind: "rejected",
        code: "READ_ONLY",
        reason: "Connection is in read-only mode. Toggle to Write mode to apply edits.",
      };
      deps.onRowResult(r.rowKey, outcome);
    }
    return { applied: 0, failed: rows.length, cancelled: false };
  }

  // PK descriptor available? (The descriptor is required for buildUpdate().)
  if (deps.descriptor.pkColumns.length === 0) {
    for (const r of rows) {
      const outcome: RowOutcome = {
        kind: "rejected",
        code: "NO_PK",
        reason:
          "Result set has no detectable primary key — cell edits require a single-source SELECT against a PK'd table.",
      };
      deps.onRowResult(r.rowKey, outcome);
    }
    return { applied: 0, failed: rows.length, cancelled: false };
  }

  // Per-row arity check — build a list of "ready to preview" entries
  // and a list of "pre-rejected" entries.
  const ready: { rowKey: string; stmt: BuiltStatement }[] = [];
  const preRejected: string[] = [];
  for (const r of rows) {
    if (r.pkValues.length !== deps.descriptor.pkColumns.length) {
      const outcome: RowOutcome = {
        kind: "rejected",
        code: "PK_ARITY",
        reason: `Expected ${deps.descriptor.pkColumns.length} primary-key value(s), got ${r.pkValues.length}.`,
      };
      deps.onRowResult(r.rowKey, outcome);
      preRejected.push(r.rowKey);
      continue;
    }
    const stmt = buildUpdate({
      schema: deps.descriptor.schema ?? "public",
      table: deps.descriptor.table,
      pkColumns: deps.descriptor.pkColumns,
      pkValues: r.pkValues,
      changes: r.changes,
    });
    ready.push({ rowKey: r.rowKey, stmt });
  }

  // Nothing left to preview — every row was rejected on arity.
  if (ready.length === 0) {
    return { applied: 0, failed: preRejected.length, cancelled: false };
  }

  deps.logger.info("grid.bulkApply.previewing", {
    rows: ready.length,
    target: `${deps.descriptor.schema ?? "public"}.${deps.descriptor.table}`,
  });
  const decision = await deps.presentBulkPreview(ready);
  if (decision === "cancelled") {
    deps.logger.warn("grid.bulkApply.cancelled", {});
    return { applied: 0, failed: preRejected.length, cancelled: true };
  }

  // Execute per-row with continue-on-failure. A single bad row does
  // NOT halt subsequent rows — each is independent.
  let applied = 0;
  let failed = preRejected.length;
  for (const r of ready) {
    try {
      const { rowsAffected } = await deps.executeStatement(r.stmt);
      deps.onRowResult(r.rowKey, { kind: "applied", rowsAffected });
      applied++;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      deps.logger.error("grid.bulkApply.row.failed", {
        rowKey: r.rowKey,
        reason: error.message,
      });
      deps.onRowResult(r.rowKey, { kind: "failed", error });
      failed++;
    }
  }

  deps.logger.info("grid.bulkApply.applied", { applied, failed });
  return { applied, failed, cancelled: false };
}
