/**
 * Pure cell-edit orchestrator (partial T109).
 *
 * The state machine the future cell-edit renderer channel will call
 * into. Composes already-landed pieces:
 *
 *   - validateEditRequest() / buildUpdate() / buildDelete() / renderPreviewMarkdown()
 *     from src/sql/update-builder.ts
 *   - resolveEditEligibility() result (the PK descriptor) supplied
 *     here as `resolveEligibility(sql)` so the orchestrator stays
 *     pg-free; the host wires it to the live client.
 *
 * No vscode, no pg. The host injects `presentPreview` (typically a
 * `vscode.window.showInformationMessage` over a MarkdownString built
 * from `renderPreviewMarkdown()`) and `executeStatement` (typically
 * `pg.PoolClient.query`). Tests fully exercise every outcome with
 * stubbed callbacks.
 *
 * Outcome shape mirrors the renderer's eventual on-screen state: the
 * grid reflects `applied` rows immediately; `cancelled` / `rejected`
 * leave the cell in edit-pending mode; `failed` reverts and surfaces
 * the error.
 */

import {
  buildDelete,
  buildUpdate,
  type BuiltStatement,
  type ColumnChange,
  type ConnectionMode,
  type PreviewMeta,
  validateEditRequest,
} from "./update-builder.js";
import type { PkDescriptor } from "../pg/result-descriptor.js";

export interface CellEditHostDeps {
  /** Look up the PK descriptor for the SELECT that produced this result set. */
  resolveEligibility(sql: string): Promise<PkDescriptor | null>;
  /**
   * Show the user the parameterized SQL + bindings and wait for them
   * to confirm or cancel. The host typically wraps `BuiltStatement` in
   * `renderPreviewMarkdown()` → `vscode.MarkdownString` →
   * `showInformationMessage`.
   */
  presentPreview(
    stmt: BuiltStatement,
    meta: PreviewMeta,
  ): Promise<"confirmed" | "cancelled">;
  /** Execute the statement against the live connection in Write mode. */
  executeStatement(stmt: BuiltStatement): Promise<{ rowsAffected: number }>;
  /** Logger — wire to `src/logging/channel.ts`'s `log` in production. */
  logger: {
    info(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
    error(event: string, fields?: Record<string, unknown>): void;
  };
}

export interface CellEditRequest {
  /** The SELECT that produced the result set being edited. */
  readonly sql: string;
  /** Connection mode at the moment of apply — re-checked here. */
  readonly mode: ConnectionMode;
  /** PK row values, ordered to match the descriptor's pkColumns. */
  readonly rowPkValues: ReadonlyArray<unknown>;
  /** Per-column changes. Empty record + DELETE operation = delete-the-row. */
  readonly changes: Readonly<Record<string, ColumnChange>>;
  /** Display metadata for the preview modal. */
  readonly meta: PreviewMeta;
}

export type CellEditOutcome =
  | { kind: "applied"; rowsAffected: number }
  | { kind: "cancelled" }
  | { kind: "rejected"; code: string; reason: string }
  | { kind: "failed"; error: Error };

export async function handleCellEditRequest(
  deps: CellEditHostDeps,
  req: CellEditRequest,
): Promise<CellEditOutcome> {
  deps.logger.info("cell.edit.start", {
    operation: req.meta.operation,
    target: req.meta.target,
  });

  // Gate 1 — connection mode + reject empty UPDATEs early.
  const validation = validateEditRequest({ mode: req.mode, pkColumns: ["_check"] });
  if (!validation.ok && validation.code === "READ_ONLY") {
    deps.logger.warn("cell.edit.rejected", {
      code: validation.code,
      target: req.meta.target,
    });
    return { kind: "rejected", code: validation.code, reason: validation.reason };
  }
  if (req.meta.operation === "UPDATE" && Object.keys(req.changes).length === 0) {
    const code = "NO_CHANGES";
    const reason = "No changes to apply.";
    deps.logger.warn("cell.edit.rejected", { code, target: req.meta.target });
    return { kind: "rejected", code, reason };
  }

  // Gate 2 — PK descriptor (drives the WHERE clause).
  const descriptor = await deps.resolveEligibility(req.sql);
  if (!descriptor) {
    const code = "NO_PK";
    const reason =
      "Result set has no detectable primary key — cell edits require a single-source SELECT against a PK'd table.";
    deps.logger.warn("cell.edit.rejected", { code, target: req.meta.target });
    return { kind: "rejected", code, reason };
  }

  // Gate 3 — PK arity. The renderer ships one value per descriptor
  // column for the row being edited; a mismatch is a host bug, surfaced
  // explicitly rather than producing a malformed UPDATE.
  if (req.rowPkValues.length !== descriptor.pkColumns.length) {
    const code = "PK_ARITY";
    const reason = `Expected ${descriptor.pkColumns.length} primary-key value(s), got ${req.rowPkValues.length}.`;
    deps.logger.error("cell.edit.rejected", { code, target: req.meta.target });
    return { kind: "rejected", code, reason };
  }

  // Build the statement ONCE — the same reference flows through
  // preview and execute so the user confirms exactly what runs.
  const stmt: BuiltStatement =
    req.meta.operation === "DELETE"
      ? buildDelete({
          schema: descriptor.schema ?? "public",
          table: descriptor.table,
          pkColumns: descriptor.pkColumns,
          pkValues: req.rowPkValues,
        })
      : buildUpdate({
          schema: descriptor.schema ?? "public",
          table: descriptor.table,
          pkColumns: descriptor.pkColumns,
          pkValues: req.rowPkValues,
          changes: req.changes,
        });

  deps.logger.info("cell.edit.previewing", {
    operation: req.meta.operation,
    target: req.meta.target,
    paramCount: stmt.values.length,
  });

  // User-side gate — they may cancel here even with everything validated.
  const decision = await deps.presentPreview(stmt, req.meta);
  if (decision === "cancelled") {
    deps.logger.warn("cell.edit.cancelled", { target: req.meta.target });
    return { kind: "cancelled" };
  }

  deps.logger.info("cell.edit.executing", {
    operation: req.meta.operation,
    target: req.meta.target,
  });
  try {
    const { rowsAffected } = await deps.executeStatement(stmt);
    deps.logger.info("cell.edit.applied", {
      operation: req.meta.operation,
      target: req.meta.target,
      rowsAffected,
    });
    return { kind: "applied", rowsAffected };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    deps.logger.error("cell.edit.failed", {
      operation: req.meta.operation,
      target: req.meta.target,
      reason: error.message,
    });
    return { kind: "failed", error };
  }
}
