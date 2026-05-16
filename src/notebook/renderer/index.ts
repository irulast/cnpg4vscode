/// <reference lib="dom" />
/**
 * cnpg-result notebook renderer entrypoint (FR-035 amended for the
 * notebook architecture).
 *
 * Runs inside VS Code's notebook-renderer iframe. Receives an
 * OutputItem of mime type `application/x-cnpg-result+json` and mounts
 * an interactive HTML table by setting `element.innerHTML = buildTableHtml(payload)`.
 *
 * The pure HTML builder lives in `build-table.ts` so it can be
 * unit-tested without a DOM.
 */

import type { ActivationFunction, OutputItem } from "vscode-notebook-renderer";
import { buildTableHtml, ResultGridPayload } from "./build-table.js";

export const activate: ActivationFunction = () => {
  return {
    renderOutputItem(outputItem: OutputItem, element: HTMLElement) {
      try {
        const payload = outputItem.json() as ResultGridPayload;
        element.innerHTML = buildTableHtml(payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        element.innerHTML = `<pre style="color: var(--vscode-editorError-foreground);">Failed to render result: ${escapeHtml(message)}</pre>`;
      }
    },
  };
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
