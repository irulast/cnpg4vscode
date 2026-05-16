/**
 * Grid Editor webview entry (US6 Phase 8.5 — T153 minimal shell).
 *
 * This is the messaging-aware shell that wires the host's `init` →
 * `loadPage` → `page` cycle end-to-end. The actual glide-data-grid
 * mounting + cell-editor wiring + dirty-row tracking is the next
 * iteration of T153 — this shell exists so the host integration
 * (T150) can be exercised end-to-end against a real DB once an e2e
 * harness lands, and so the CSP/bundle/protocol path is validated.
 *
 * Renders a basic table of the loaded rows + a status bar showing
 * row count, target, connection mode. Edit affordances ship in the
 * follow-up T153 expansion.
 */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare global {
  function acquireVsCodeApi(): VsCodeApi;
}

const vscode = acquireVsCodeApi();

interface ColumnLike {
  name: string;
  pgType: string;
  isPk: boolean;
}

interface InitMessage {
  type: "init";
  payload: {
    descriptor: {
      columns: ColumnLike[];
      pkColumns: string[];
      target: { schema: string; table: string; kind: string };
      editable: boolean;
    };
    connection: { mode: "readonly" | "write"; database: string; cluster: string };
  };
}

interface PageMessage {
  type: "page";
  payload: {
    offset: number;
    rows: unknown[][];
    totalRows: number | null;
    truncated: boolean;
  };
}

type IncomingMessage = InitMessage | PageMessage | { type: string };

function App(): JSX.Element {
  const [init, setInit] = useState<InitMessage["payload"] | null>(null);
  const [page, setPage] = useState<PageMessage["payload"] | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const msg = event.data as IncomingMessage;
      if (msg.type === "init") setInit((msg as InitMessage).payload);
      else if (msg.type === "page") setPage((msg as PageMessage).payload);
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return (): void => window.removeEventListener("message", onMessage);
  }, []);

  if (!init) {
    return (
      <div style={{ padding: 16 }}>
        <p>Loading descriptor…</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid var(--vscode-panel-border)",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <strong>
          {init.descriptor.target.schema}.{init.descriptor.target.table}
        </strong>
        <span style={{ opacity: 0.7 }}>
          {init.descriptor.target.kind} · {init.connection.cluster}/
          {init.connection.database} · {init.connection.mode}
        </span>
        {init.descriptor.editable ? (
          <span style={{ marginLeft: "auto", opacity: 0.6 }}>
            Editable · PK: {init.descriptor.pkColumns.join(", ")}
          </span>
        ) : (
          <span style={{ marginLeft: "auto", opacity: 0.6 }}>Read-only</span>
        )}
      </header>
      <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
        <table
          style={{
            borderCollapse: "collapse",
            fontFamily: "var(--vscode-editor-font-family)",
            fontSize: "var(--vscode-editor-font-size)",
            width: "100%",
          }}
        >
          <thead style={{ position: "sticky", top: 0 }}>
            <tr style={{ background: "var(--vscode-editorGroupHeader-tabsBackground)" }}>
              {init.descriptor.columns.map((c) => (
                <th
                  key={c.name}
                  style={{
                    padding: "4px 8px",
                    textAlign: "left",
                    borderBottom: "1px solid var(--vscode-panel-border)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.isPk ? "🔑 " : ""}
                  {c.name}
                  <span style={{ opacity: 0.5, marginLeft: 6 }}>{c.pgType}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(page?.rows ?? []).map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    style={{
                      padding: "4px 8px",
                      borderBottom: "1px solid var(--vscode-editorIndentGuide-background)",
                      whiteSpace: "nowrap",
                      maxWidth: 400,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      opacity: cell === null || cell === undefined ? 0.5 : 1,
                      fontStyle: cell === null || cell === undefined ? "italic" : "normal",
                    }}
                  >
                    {cell === null || cell === undefined ? "NULL" : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {page && page.rows.length === 0 ? (
          <div style={{ padding: 16, opacity: 0.6 }}>No rows.</div>
        ) : null}
      </div>
      <footer
        style={{
          padding: "4px 16px",
          borderTop: "1px solid var(--vscode-panel-border)",
          display: "flex",
          gap: 16,
          opacity: 0.75,
        }}
      >
        <span>
          {page ? `${page.rows.length} of ${page.totalRows ?? "?"}` : "—"}
        </span>
        <span style={{ marginLeft: "auto", opacity: 0.5 }}>
          Full grid (glide-data-grid + cell editing) shipping next.
        </span>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
