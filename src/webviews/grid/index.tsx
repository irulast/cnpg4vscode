/**
 * Grid Editor webview entry point (US6 Phase 8.5 — T136 setup stub).
 *
 * The full React + glide-data-grid implementation lands in T153. This
 * stub exists so the esbuild target compiles and so the bundle's CSP +
 * nonce wiring (T154) can be validated end-to-end before the real grid
 * component is built.
 *
 * When the host (T150) loads this bundle into a webview, the stub
 * mounts a loading placeholder and posts `ready` so the host knows it
 * can send `init`. The placeholder is replaced wholesale by T153.
 */

import { createRoot } from "react-dom/client";

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function acquireVsCodeApi(): VsCodeApi;
}

const vscode = acquireVsCodeApi();

function Placeholder(): JSX.Element {
  return (
    <div
      style={{
        padding: "16px",
        fontFamily: "var(--vscode-font-family)",
        color: "var(--vscode-foreground)",
      }}
    >
      <h1>CNPG Grid Editor</h1>
      <p>Loading… (T153 will replace this placeholder with the real grid).</p>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<Placeholder />);
  vscode.postMessage({ type: "ready" });
}
