/**
 * Pure HTML-builder for the cnpg result-grid notebook renderer
 * (US6; spec FR-035 amended). Lives in its own file so it's unit-testable
 * without a DOM or the vscode-notebook-renderer host. The mounting glue
 * in index.ts simply sets `element.innerHTML = buildTableHtml(payload)`.
 *
 * Theme: every color, border, and font reference uses a `--vscode-*` CSS
 * variable so the table follows the active VS Code theme (light, dark,
 * high-contrast) without per-theme work.
 */

export interface ResultGridPayload {
  command: string;
  columns: string[];
  rows: ReadonlyArray<ReadonlyArray<unknown>>;
  /** Total result-set size (may exceed `rows.length` when truncated). */
  totalRows: number;
  truncated: boolean;
}

/** Render the payload to a self-contained HTML string. Includes a `<style>` block. */
export function buildTableHtml(p: ResultGridPayload): string {
  const css = STYLE_BLOCK;
  if (p.rows.length === 0) {
    return [
      css,
      `<div class="cnpg-empty">`,
      `<span class="cnpg-empty-icon">∅</span>`,
      `<span>no rows · <code>${esc(p.command)}</code></span>`,
      `</div>`,
    ].join("");
  }
  const header = p.columns
    .map((c) => `<th title="${esc(c)}">${esc(c)}</th>`)
    .join("");
  const body = p.rows
    .map((row, idx) => {
      const cells = row
        .map((cell) => formatCellHtml(cell))
        .join("");
      return `<tr><td class="cnpg-rowidx">${idx + 1}</td>${cells}</tr>`;
    })
    .join("");
  const footer = footerText(p);
  return [
    css,
    `<div class="cnpg-result">`,
    `<div class="cnpg-result-wrap">`,
    `<table class="cnpg-table">`,
    `<thead><tr><th class="cnpg-rowidx"></th>${header}</tr></thead>`,
    `<tbody>${body}</tbody>`,
    `</table>`,
    `</div>`,
    `<div class="cnpg-footer">${footer}</div>`,
    `</div>`,
  ].join("");
}

function footerText(p: ResultGridPayload): string {
  const cmd = `<code>${esc(p.command)}</code>`;
  const count = `${p.totalRows.toLocaleString("en-US")} row${p.totalRows === 1 ? "" : "s"}`;
  if (p.truncated) {
    const shown = p.rows.length;
    const hidden = p.totalRows - shown;
    return `${cmd} · ${count} · <span class="cnpg-warn">truncated — ${hidden.toLocaleString("en-US")} row${hidden === 1 ? "" : "s"} not shown</span>`;
  }
  return `${cmd} · ${count}`;
}

function formatCellHtml(v: unknown): string {
  if (v === null || v === undefined) {
    return `<td class="cnpg-null">NULL</td>`;
  }
  if (typeof v === "boolean") {
    return `<td class="cnpg-bool">${v ? "true" : "false"}</td>`;
  }
  if (typeof v === "number") {
    return `<td class="cnpg-num">${v}</td>`;
  }
  if (typeof v === "string") {
    return `<td>${esc(v)}</td>`;
  }
  if (v instanceof Date) {
    return `<td class="cnpg-date">${esc(v.toISOString())}</td>`;
  }
  // Object / array — render compact JSON so structure is visible without
  // exploding row height.
  try {
    return `<td class="cnpg-json">${esc(JSON.stringify(v))}</td>`;
  } catch {
    return `<td>${esc(String(v))}</td>`;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE_BLOCK = `<style>
  .cnpg-result {
    font-family: var(--vscode-editor-font-family, var(--vscode-font-family), monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    display: flex;
    flex-direction: column;
    gap: 0.25em;
  }
  .cnpg-result-wrap {
    overflow: auto;
    max-height: 480px;
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 2px;
  }
  table.cnpg-table {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
  }
  .cnpg-table th,
  .cnpg-table td {
    padding: 2px 8px;
    border-right: 1px solid var(--vscode-panel-border, transparent);
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    text-align: left;
    white-space: nowrap;
    vertical-align: top;
    font-variant-numeric: tabular-nums;
  }
  .cnpg-table th {
    position: sticky;
    top: 0;
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    font-weight: 600;
    z-index: 1;
  }
  .cnpg-table tbody tr:hover td {
    background: var(--vscode-list-hoverBackground, transparent);
  }
  .cnpg-rowidx {
    color: var(--vscode-editorLineNumber-foreground);
    text-align: right;
    user-select: none;
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    border-right: 1px solid var(--vscode-panel-border, transparent);
  }
  .cnpg-null {
    color: var(--vscode-editorLineNumber-foreground);
    font-style: italic;
  }
  .cnpg-num,
  .cnpg-bool {
    text-align: right;
  }
  .cnpg-bool {
    color: var(--vscode-symbolIcon-booleanForeground, inherit);
  }
  .cnpg-num {
    color: var(--vscode-symbolIcon-numberForeground, inherit);
  }
  .cnpg-date {
    color: var(--vscode-symbolIcon-stringForeground, inherit);
  }
  .cnpg-json {
    color: var(--vscode-symbolIcon-objectForeground, inherit);
    max-width: 40em;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cnpg-footer {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    padding: 2px 4px;
  }
  .cnpg-footer code {
    color: var(--vscode-textPreformat-foreground);
    background: var(--vscode-textBlockQuote-background, transparent);
    padding: 0 4px;
    border-radius: 2px;
  }
  .cnpg-warn {
    color: var(--vscode-editorWarning-foreground);
  }
  .cnpg-empty {
    color: var(--vscode-descriptionForeground);
    display: flex;
    align-items: center;
    gap: 0.5em;
    padding: 4px 8px;
  }
  .cnpg-empty-icon {
    font-size: 1.4em;
    opacity: 0.6;
  }
</style>`;
