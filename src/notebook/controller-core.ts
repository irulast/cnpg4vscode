/**
 * Pure execution logic for the cnpg-sql notebook controller (US4 notebook
 * refactor; FR-020, FR-035). Lives separately from controller.ts so unit
 * tests can exercise it without the VS Code runtime.
 */

import type { ActiveConnection } from "../state/session.js";
import { classify } from "../pg/readonly-gate.js";

export type ExecuteResult =
  | { kind: "ok"; result: import("pg").QueryResult }
  | { kind: "rejected"; code: string; reason: string }
  | { kind: "error"; message: string; sqlstate: string | undefined };

export function controllerLabel(conn: ActiveConnection): string {
  const mode = conn.connection.mode === "write" ? "write" : "read-only";
  return `${conn.cluster.clusterName}/${conn.database} (${mode})`;
}

export async function executeCellSql(
  conn: ActiveConnection,
  sql: string,
): Promise<ExecuteResult> {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return { kind: "rejected", code: "EMPTY", reason: "Empty cell." };
  }
  if (conn.connection.mode === "readonly") {
    const c = classify(trimmed);
    if (c.kind === "rejected") {
      return { kind: "rejected", code: c.code, reason: `${c.reason} (Toggle Write mode to permit this statement.)` };
    }
  }
  try {
    const result = await conn.connection.query(trimmed);
    return { kind: "ok", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const sqlstate = (err as { code?: string } | null)?.code;
    return { kind: "error", message, sqlstate };
  }
}
