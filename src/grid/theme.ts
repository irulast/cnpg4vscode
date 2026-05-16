/**
 * Theme-token snapshot for the Grid Editor webview (US6 Phase 8.5 — T150).
 *
 * Builds a `ThemeTokens` payload from `vscode.window.activeColorTheme`
 * + `editor.fontFamily` / `editor.fontSize` config. Sent on `init` and
 * again every time the color theme changes (`themeChanged` outbound).
 *
 * VS Code doesn't expose `--vscode-*` values to extension code
 * directly — the webview iframe reads them from CSS. So this function
 * returns the CSS variable EXPRESSIONS (e.g. `"var(--vscode-editor-
 * background)"`) rather than concrete hex values. The renderer
 * embeds them inline in `style={{}}` or in `<style>` blocks, and the
 * iframe resolves them at paint time.
 *
 * Font family and size are real config reads — they need to be raw
 * strings/numbers so glide-data-grid can use them in its measurement
 * pass.
 */

import * as vscode from "vscode";
import type { ThemeTokens } from "../webviews/grid/protocol.js";

export function snapshotThemeTokens(): ThemeTokens {
  const editorCfg = vscode.workspace.getConfiguration("editor");
  return {
    background: "var(--vscode-editor-background)",
    foreground: "var(--vscode-editor-foreground)",
    border: "var(--vscode-panel-border)",
    accent: "var(--vscode-focusBorder)",
    headerBg: "var(--vscode-editorGroupHeader-tabsBackground)",
    headerFg: "var(--vscode-foreground)",
    selectionBg: "var(--vscode-editor-selectionBackground)",
    errorFg: "var(--vscode-editorError-foreground)",
    warningFg: "var(--vscode-editorWarning-foreground)",
    fontFamily: editorCfg.get<string>("fontFamily") ?? "monospace",
    fontSize: editorCfg.get<number>("fontSize") ?? 13,
  };
}
