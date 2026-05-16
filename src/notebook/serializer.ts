/**
 * cnpg-sql notebook serializer (US4 notebook refactor; FR-033, FR-034, FR-035).
 *
 * Disk format: a JSON document with the shape below. Cell outputs are
 * INTENTIONALLY dropped on serialize — query result rows are run-time
 * state, not persisted artefacts, and including them risks leaking row
 * values into workspace files. Cell text passes through `redact()` so
 * credential literals like `PASSWORD 'literal'` never reach disk.
 *
 * The pure functions exported here are unit-testable without the
 * `vscode` runtime; the VS Code-host wrapper lives in
 * `src/notebook/host-serializer.ts`.
 *
 *   {
 *     "version": 1,
 *     "metadata": { "boundControllerId": "..." },
 *     "cells": [
 *       { "kind": 2, "languageId": "sql", "value": "SELECT 1",
 *         "metadata": { ... } }
 *     ]
 *   }
 */

import { redact } from "../pg/redact.js";

/** Mirrors `vscode.NotebookCellKind` (Markup=1, Code=2). */
export type CellKindNumeric = 1 | 2;

export interface SerializableCell {
  kind: CellKindNumeric;
  value: string;
  languageId: string;
  metadata?: Record<string, unknown>;
  /** Accepted on input; dropped on serialize (security). */
  outputs?: unknown;
}

export interface SerializableNotebook {
  metadata?: Record<string, unknown>;
  cells: SerializableCell[];
}

interface DiskFormatV1 {
  version: 1;
  metadata?: Record<string, unknown>;
  cells: Array<{
    kind: CellKindNumeric;
    languageId: string;
    value: string;
    metadata?: Record<string, unknown>;
  }>;
}

export function serializeNotebookData(data: SerializableNotebook): Uint8Array {
  const disk: DiskFormatV1 = {
    version: 1,
    ...(data.metadata ? { metadata: data.metadata } : {}),
    cells: data.cells.map((cell) => {
      const out: DiskFormatV1["cells"][number] = {
        kind: cell.kind,
        languageId: cell.languageId,
        value: redact(cell.value),
      };
      if (cell.metadata) out.metadata = cell.metadata;
      return out;
    }),
  };
  const json = JSON.stringify(disk, null, 2);
  return new TextEncoder().encode(json);
}

export function deserializeNotebookBytes(bytes: Uint8Array): SerializableNotebook {
  const text = new TextDecoder().decode(bytes);
  if (text.trim().length === 0) {
    return { cells: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { cells: [] };
  }
  if (!parsed || typeof parsed !== "object") return { cells: [] };
  const p = parsed as Partial<DiskFormatV1>;
  if (!Array.isArray(p.cells)) return { cells: [] };
  const cells: SerializableCell[] = p.cells.flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const kind = (c.kind === 1 || c.kind === 2 ? c.kind : 2) as CellKindNumeric;
    const value = typeof c.value === "string" ? c.value : "";
    const languageId =
      typeof c.languageId === "string" ? c.languageId : kind === 1 ? "markdown" : "postgres";
    const cell: SerializableCell = { kind, value, languageId };
    if (c.metadata && typeof c.metadata === "object") cell.metadata = c.metadata;
    return [cell];
  });
  const result: SerializableNotebook = { cells };
  if (p.metadata && typeof p.metadata === "object") result.metadata = p.metadata;
  return result;
}
