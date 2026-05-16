/**
 * Cell-output formatting for the cnpg-sql notebook (US4 notebook refactor;
 * FR-035).
 *
 * Pure functions — no `vscode` import — so they're unit-testable. The
 * controller wraps these in `vscode.NotebookCellOutputItem` instances.
 *
 * Output strategy:
 *   - Successful SELECT: a `text/plain` aligned-table + a `text/markdown`
 *     table (the latter is what the result-grid renderer will subscribe
 *     to when it lands in US6).
 *   - Successful side-effect statement: a `text/plain` `OK (n rows)` line.
 *   - Error: a single `application/vnd.code.notebook.error` item.
 */

import type { QueryResult } from "pg";

export interface OutputItem {
  mime: string;
  text: string;
}

export interface FormatOptions {
  /** Hard cap on rendered rows in the preview (default 1000). */
  previewRows?: number;
}

/** Stable mime type for the structured result payload consumed by our notebook renderer. */
export const CNPG_RESULT_MIME = "application/x-cnpg-result+json";

export function formatSuccessOutput(
  result: QueryResult,
  opts: FormatOptions = {},
): OutputItem[] {
  const previewRows = opts.previewRows ?? 1000;
  const columns = (result.fields ?? []).map((f) => f.name);

  if (columns.length === 0) {
    // Side-effect-only statement (INSERT/UPDATE/DELETE/DDL). No grid.
    const rows = result.rowCount ?? 0;
    return [
      {
        mime: "text/plain",
        text: `${result.command ?? "OK"} (${rows} row${rows === 1 ? "" : "s"})`,
      },
    ];
  }

  const allRows = result.rows ?? [];
  const sliced = allRows.slice(0, previewRows);
  const overflow = allRows.length - sliced.length;
  const truncated = overflow > 0;

  // Raw rows for the renderer (untouched values — the renderer stringifies
  // for display while preserving the original types in the payload for
  // future cell-edit work).
  const rawRows = sliced.map((r) =>
    columns.map((c) => (r as Record<string, unknown>)[c] ?? null),
  );

  // String rows for the text/plain + text/markdown fallbacks.
  const stringRows = sliced.map((r) =>
    columns.map((c) => stringifyCell((r as Record<string, unknown>)[c])),
  );

  const aligned = renderAlignedTable(columns, stringRows);
  const summary = `\n\n-- ${result.command ?? "OK"} (${allRows.length} row${allRows.length === 1 ? "" : "s"})${
    truncated ? ` — ${overflow} more row${overflow === 1 ? "" : "s"} not rendered` : ""
  }`;

  const md = renderMarkdownTable(columns, stringRows);

  const payload = {
    command: result.command ?? "OK",
    columns,
    rows: rawRows,
    totalRows: allRows.length,
    truncated,
  };

  // Order matters: VS Code picks the FIRST mime type for which it has a
  // matching renderer. Our renderer claims application/x-cnpg-result+json
  // and falls through to text/plain when the user (or another extension)
  // disables it.
  return [
    { mime: CNPG_RESULT_MIME, text: JSON.stringify(payload) },
    { mime: "text/plain", text: aligned + summary },
    { mime: "text/markdown", text: md },
  ];
}

export function formatErrorOutput(message: string, sqlstate?: string): OutputItem {
  return {
    mime: "application/vnd.code.notebook.error",
    text: sqlstate ? `[${sqlstate}] ${message}` : message,
  };
}

export function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function renderAlignedTable(
  columns: string[],
  rows: ReadonlyArray<ReadonlyArray<string | null | undefined>>,
): string {
  const normalized = rows.map((r) =>
    columns.map((_, i) => stringifyCell(r[i])),
  );
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...normalized.map((r) => r[i]!.length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  const header = fmt(columns);
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const body = normalized.map(fmt);
  return [header, sep, ...body].join("\n");
}

export function renderMarkdownTable(
  columns: string[],
  rows: ReadonlyArray<ReadonlyArray<string | null | undefined>>,
): string {
  const esc = (s: string | null | undefined) =>
    stringifyCell(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = `| ${columns.map(esc).join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${columns.map((_, i) => esc(r[i])).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}
