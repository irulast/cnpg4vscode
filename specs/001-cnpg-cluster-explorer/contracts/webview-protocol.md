# Contract — Webview message protocol

> **REVISED 2026-05-15**: The "Result grid webview" was replaced by a
> NotebookRendererProvider in the Phase 7.5 notebook refactor (see
> spec.md § Clarifications and amended `FR-035`). The renderer consumes
> a typed JSON payload of mime type `application/x-cnpg-result+json`
> emitted by `src/notebook/output.ts`; no bidirectional messaging is
> needed for view-only rendering. The cell-editing flow (FR-025) would
> reintroduce a renderer↔host channel when it lands. For now, the only
> remaining webview in scope is the ER diagram (US6).

**No webviews are bundled with the extension in v1** (revised
2026-05-15). The two surfaces that originally required webviews have
been re-scoped to native VS Code surfaces:

1. **Result grid** → NotebookRendererProvider consuming
   `application/x-cnpg-result+json`. See spec.md § Clarifications and
   amended `FR-035`.
2. **ER diagram** → Mermaid `erDiagram` rendered via VS Code's native
   `markdown.showPreview`. See research.md §7 (REVISED banner) and the
   T115/T118 entries in tasks.md. ELK+D3+webview remains the
   documented upgrade target if a user hits Mermaid's ~50-table soft
   limit.

This file is kept for the cell-edit reintroduction case (FR-025): when
cell editing lands it will need a renderer↔host channel, at which
point the protocol below gets reinstated. Until then, the contracts
described here are aspirational.

The result-grid `application/x-cnpg-result+json` payload shape is:

```ts
interface ResultGridPayload {
  command: string;                                // e.g. "SELECT"
  columns: string[];                              // field names from pg
  rows: ReadonlyArray<ReadonlyArray<unknown>>;    // raw cell values (after preview cap)
  totalRows: number;                              // full result-set size
  truncated: boolean;                             // true when `rows.length < totalRows`
}
```

Producer: `src/notebook/output.ts`. Consumer:
`src/notebook/renderer/index.ts` + `build-table.ts`. The renderer is
mounted inside VS Code's notebook-renderer iframe; the iframe is
sandboxed by VS Code and receives the payload via
`OutputItem.json()` — no `postMessage` channel is wired up. Until the
cell-editing flow lands, render is one-shot per output.

Both communicate with the extension host via `Webview.postMessage` /
`acquireVsCodeApi().postMessage`. All messages are JSON-serializable
TypeScript discriminated unions tagged with `type`. The host MUST
treat the webview as untrusted and validate every inbound message.

## Shared envelope

```ts
type Message<TPayload, TType extends string> = {
  type: TType;
  id?: string;        // optional client-supplied correlation id
  payload?: TPayload;
};
```

---

## Result grid protocol *(SUPERSEDED by the NotebookRendererProvider)*

This section originally specified a bidirectional message protocol
between a result-grid webview host and a React + glide-data-grid bundle.
Phase 7.5 replaced that surface with a NotebookRendererProvider that
consumes the typed JSON payload above. There is no host↔renderer
channel today; the renderer reads `OutputItem.json()` and produces a
self-contained HTML table. When the cell-editing flow (FR-025) lands,
it will need a host channel — at that point this section gets
reintroduced (or the cell-edit messages are added as a single new
mime-type-targeted message bus). Until then, the protocol below stays
deleted to keep the contract honest.

---

## ER diagram protocol *(SUPERSEDED by the Mermaid markdown-preview path)*

This section originally specified a bidirectional message protocol
between an ER-diagram webview host and an ELK+D3 SVG renderer. The v1
implementation generates a `mermaid erDiagram` markdown document and
opens it via VS Code's native markdown preview — no webview, no
postMessage channel. The host computes the full diagram once via the
pure `buildMermaidErDiagram()` function (`src/ui/er-diagram-render.ts`)
and writes it to an untitled markdown document. Refresh is just
re-running the command.

The ELK+D3 protocol below is preserved here as the **upgrade target**
for when a user reports the Mermaid ~50-table soft limit hurting them
in practice. At that point, the protocol gets reintroduced behind a
setting and the existing tree-action stays as the default.

---

## Theme tokens (both webviews)

```ts
type ThemeTokens = {
  // Mapped from VS Code's --vscode-* CSS variables, snapshot at init
  // and refreshed via *.themeChanged on workbench.colorTheme change.
  background: string;     // --vscode-editor-background
  foreground: string;     // --vscode-editor-foreground
  border: string;         // --vscode-panel-border
  accent: string;         // --vscode-focusBorder
  headerBg: string;       // --vscode-editorGroupHeader-tabsBackground
  headerFg: string;       // --vscode-foreground
  selectionBg: string;    // --vscode-editor-selectionBackground
  fontFamily: string;     // editor.fontFamily
  fontSize: number;       // editor.fontSize
};
```

Hard-coded hex values inside a webview are forbidden and fail the
theme-contrast snapshot test.

---

## Security posture

- The webview HTML is loaded from `dist/webviews/<name>/index.html`
  with a strict CSP: `default-src 'none'; style-src ${cspSource}
  'unsafe-inline'; script-src ${cspSource}; img-src ${cspSource} data:`.
- No `<script src="https://...">` from any external CDN.
- `Webview.localResourceRoots` limited to the bundled webview
  directory.
- All messages from the webview are JSON-parsed and discriminated by
  `type`; unknown types are logged at `warn` and dropped.
