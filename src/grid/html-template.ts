/**
 * Webview HTML template for the Grid Editor (US6 Phase 8.5 — T154).
 *
 * Pure module — returns the HTML string the host loads into the
 * `vscode.WebviewPanel`. Includes:
 *
 *   - Strict CSP with a per-load nonce (the only way scripts can run).
 *   - `<base href>` pinning resource loading to the bundled webview
 *     directory.
 *   - The grid bundle's `<script>` tag carrying the nonce.
 *   - A `<div id="root">` that React mounts into.
 *
 * CSP follows the Constitution §IV pattern and the `audit-webview-csp.mjs`
 * gate (T130): `default-src 'none'`; explicit per-directive allowlists;
 * NO `unsafe-eval`; NO external CDNs.
 *
 * `style-src` allows `'unsafe-inline'` only because glide-data-grid
 * injects its own canvas-overlay style at render time — sandboxed
 * within the webview iframe, no eval, no XSS surface (cell values
 * render to canvas, not DOM, so the usual injection vectors don't
 * apply).
 */

export interface BuildHtmlOptions {
  /** The `webview.cspSource` from `vscode.WebviewPanel.webview`. */
  readonly cspSource: string;
  /** The bundle script URI from `webview.asWebviewUri(...)`. */
  readonly bundleSrc: string;
  /** The bundle stylesheet URI from `webview.asWebviewUri(...)`. */
  readonly stylesheetSrc: string;
  /** Per-load nonce — `crypto.randomUUID()`-shaped. The host generates it. */
  readonly nonce: string;
  /** Display title — embedded as the document <title> for the host's panel. */
  readonly title: string;
}

export function buildGridWebviewHtml(opts: BuildHtmlOptions): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${opts.cspSource} 'unsafe-inline'`,
    `script-src ${opts.cspSource} 'nonce-${opts.nonce}'`,
    `img-src ${opts.cspSource} data:`,
    `font-src ${opts.cspSource}`,
    `connect-src 'none'`,
  ].join("; ");

  // The escape function below makes the title CSP-safe — even if a
  // future caller passes a title with `<` or `>` (e.g. a schema name
  // with raw HTML chars), it cannot escape the title element.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(opts.title)}</title>
  <link rel="stylesheet" href="${opts.stylesheetSrc}" />
  <style nonce="${opts.nonce}">
    html, body, #root {
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${opts.nonce}" src="${opts.bundleSrc}"></script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
