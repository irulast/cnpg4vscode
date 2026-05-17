/**
 * Grid Editor webview entry — full glide-data-grid integration
 * (US6 Phase 8.5 — T153).
 *
 * Mounts a canvas-rendered virtualized grid via `@glideapps/glide-
 * data-grid`. Wires the host's protocol end-to-end:
 *
 *   - `init` → builds columns + theme + restores persisted state
 *   - `page` → populates row data; getCellContent reads from it
 *   - user edits → buffered in `dirtyEdits`, surfaced via gutter + footer
 *   - Apply → posts `applyRequested` → renders `applyPreview` modal →
 *     posts `applyConfirmed`/`applyCancelled` → consumes `applyResult`
 *     stream to clear dirty marks incrementally
 *   - FK cell right-click → posts `openReferencedRow`
 *   - column resize / move / sort changes → posts `layoutChanged`
 *
 * Theme: canvas can't resolve `--vscode-*` CSS variables, so we read
 * the resolved RGB values via `getComputedStyle(document.body)` and
 * pass them to glide-data-grid's theme prop. A MutationObserver on
 * `<body class>` re-snapshots when VS Code switches themes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type Item,
  type Theme,
} from "@glideapps/glide-data-grid";

// Note: glide-data-grid's CSS is loaded by the webview HTML via a
// `<link rel="stylesheet" href="bundle.css">` tag (see
// `src/grid/html-template.ts`). The bundled CSS file is built by a
// separate esbuild target that follows @import chains so every
// sub-stylesheet glide-data-grid needs (markdown-container, overlay
// editors, etc.) is inlined into one file.

// ---------------------------------------------------------------------------
// VS Code API
// ---------------------------------------------------------------------------

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare global {
  function acquireVsCodeApi(): VsCodeApi;
}
const vscode = acquireVsCodeApi();

// Surface uncaught errors to the webview console so the user can see
// them via "Developer: Open Webview Developer Tools". Without this the
// errors are invisible.
window.addEventListener("error", (e) => {
  // eslint-disable-next-line no-console
  console.error("[cnpg-grid] uncaught", e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  // eslint-disable-next-line no-console
  console.error("[cnpg-grid] unhandledrejection", e.reason);
});

// ---------------------------------------------------------------------------
// Inbound protocol shapes (mirror src/webviews/grid/protocol.ts host types).
// We don't re-import the host's protocol module here because the webview
// bundle is browser-only and the protocol module imports node-specific
// helpers; the shapes are stable contract surfaces.
// ---------------------------------------------------------------------------

interface ColumnLike {
  name: string;
  pgType: string;
  jsType: "string" | "number" | "boolean" | "date" | "json" | "enum" | "unknown";
  nullable: boolean;
  hasDefault: boolean;
  isPk: boolean;
  enumValues?: ReadonlyArray<string>;
  fk?: { refSchema: string; refTable: string; refColumn: string };
}

interface InitPayload {
  descriptor: {
    columns: ColumnLike[];
    pkColumns: string[];
    totalRowsEstimate: number | null;
    target: { schema: string; table: string; kind: "table" | "view" | "matview" };
    editable: boolean;
  };
  theme: Record<string, string | number>;
  persistedState: {
    columnOrder: string[];
    hiddenColumns: string[];
    columnWidths: Record<string, number>;
    sort: Array<{ column: string; dir: "asc" | "desc" }>;
    filters: Array<{ column: string; op: string; value?: string }>;
    frozenColumnCount: number;
    scrollTop: number;
    lastOpenedAt: number;
  } | null;
  connection: { mode: "readonly" | "write"; database: string; cluster: string };
}

interface PagePayload {
  offset: number;
  rows: unknown[][];
  totalRows: number | null;
  truncated: boolean;
}

interface ApplyPreviewPayload {
  statements: Array<{ rowKey: string; text: string; values: unknown[] }>;
}

interface ApplyResultPayload {
  rowKey: string;
  outcome:
    | { kind: "applied"; rowsAffected: number }
    | { kind: "rejected"; code: string; reason: string }
    | { kind: "failed"; reason: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable rowKey for dirty-tracking — JSON-encoded PK values for the row. */
function buildRowKey(
  pkColumns: string[],
  columns: ColumnLike[],
  row: unknown[],
): string {
  const pkIdxs = pkColumns.map((p) => columns.findIndex((c) => c.name === p));
  return JSON.stringify(pkIdxs.map((i) => (i >= 0 ? row[i] ?? null : null)));
}

function pkValuesFor(
  pkColumns: string[],
  columns: ColumnLike[],
  row: unknown[],
): unknown[] {
  return pkColumns
    .map((p) => columns.findIndex((c) => c.name === p))
    .map((i) => (i >= 0 ? row[i] ?? null : null));
}

/** Read VS Code's resolved theme colors via getComputedStyle. */
function snapshotCanvasTheme(): Partial<Theme> {
  const cs = getComputedStyle(document.body);
  const v = (name: string, fallback: string): string =>
    cs.getPropertyValue(name).trim() || fallback;
  const fontFamily = v("--vscode-font-family", "system-ui, sans-serif");
  const fontSize = v("--vscode-editor-font-size", "13") + "px";
  return {
    bgCell: v("--vscode-editor-background", "#1e1e1e"),
    bgCellMedium: v("--vscode-editor-background", "#1e1e1e"),
    bgHeader: v("--vscode-editorGroupHeader-tabsBackground", "#2d2d2d"),
    bgHeaderHasFocus: v("--vscode-list-activeSelectionBackground", "#04395e"),
    bgHeaderHovered: v("--vscode-list-hoverBackground", "#2a2d2e"),
    textHeader: v("--vscode-foreground", "#cccccc"),
    textGroupHeader: v("--vscode-foreground", "#cccccc"),
    textDark: v("--vscode-editor-foreground", "#cccccc"),
    textMedium: v("--vscode-foreground", "#cccccc"),
    textLight: v("--vscode-descriptionForeground", "#8c8c8c"),
    accentColor: v("--vscode-focusBorder", "#007fd4"),
    accentLight: v("--vscode-editor-selectionBackground", "#264f78"),
    borderColor: v("--vscode-panel-border", "#2b2b2b"),
    horizontalBorderColor: v("--vscode-panel-border", "#2b2b2b"),
    drilldownBorder: v("--vscode-panel-border", "#2b2b2b"),
    linkColor: v("--vscode-textLink-foreground", "#3794ff"),
    headerFontStyle: `600 ${fontSize}`,
    baseFontStyle: fontSize,
    fontFamily,
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App(): JSX.Element {
  const [init, setInit] = useState<InitPayload | null>(null);
  const [page, setPage] = useState<PagePayload | null>(null);
  const [gridSize, setGridSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [theme, setTheme] = useState<Partial<Theme>>(() => snapshotCanvasTheme());
  // dirtyEdits maps rowKey → {pkValues, changes}.
  const [dirtyEdits, setDirtyEdits] = useState<
    Map<string, { pkValues: unknown[]; changes: Record<string, unknown> }>
  >(new Map());
  const [applyPreview, setApplyPreview] = useState<ApplyPreviewPayload | null>(null);
  const [applyInFlight, setApplyInFlight] = useState(false);
  const [applyErrors, setApplyErrors] = useState<Map<string, string>>(new Map());
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    column: ColumnLike;
    value: unknown;
  } | null>(null);
  /** Surfaces page-load failures the host reports via a `loadFailed` message. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const editorRef = useRef<DataEditorRef>(null);

  // Layout primitives — column widths persist across reloads.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});

  // Receive messages from the host. Every message is also logged to
  // the webview console — open "Developer: Open Webview Developer
  // Tools" (cmd palette) to see the trace when debugging.
  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const msg = event.data as { type: string; payload?: unknown };
      // eslint-disable-next-line no-console
      console.log("[cnpg-grid] inbound", msg.type, msg.payload);
      if (msg.type === "init") {
        const p = msg.payload as InitPayload;
        setInit(p);
        if (p.persistedState?.columnWidths) {
          setColumnWidths({ ...p.persistedState.columnWidths });
        }
      } else if (msg.type === "page") {
        setPage(msg.payload as PagePayload);
        setLoadError(null);
      } else if (msg.type === "loadFailed") {
        const reason = (msg.payload as { reason: string }).reason;
        setLoadError(reason);
        setPage({ offset: 0, rows: [], totalRows: 0, truncated: false });
      } else if (msg.type === "themeChanged") {
        setTheme(snapshotCanvasTheme());
      } else if (msg.type === "modeChanged") {
        setInit((prev) =>
          prev
            ? {
                ...prev,
                connection: { ...prev.connection, mode: (msg.payload as { mode: "readonly" | "write" }).mode },
              }
            : prev,
        );
      } else if (msg.type === "applyPreview") {
        setApplyPreview(msg.payload as ApplyPreviewPayload);
      } else if (msg.type === "applyResult") {
        const r = msg.payload as ApplyResultPayload;
        if (r.outcome.kind === "applied") {
          // Clear dirty mark for this row.
          setDirtyEdits((prev) => {
            const next = new Map(prev);
            next.delete(r.rowKey);
            return next;
          });
          setApplyErrors((prev) => {
            const next = new Map(prev);
            next.delete(r.rowKey);
            return next;
          });
        } else {
          // Keep dirty + surface the error inline. Both rejected and
          // failed outcomes carry a `reason`.
          const reason = r.outcome.reason;
          setApplyErrors((prev) => new Map(prev).set(r.rowKey, reason));
        }
      }
    }
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return (): void => window.removeEventListener("message", onMessage);
  }, []);

  // VS Code theme switches don't always fire a `themeChanged` from
  // the host (e.g. when the user toggles in-tab); watch the body class
  // and re-snapshot when it changes.
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(snapshotCanvasTheme()));
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return (): void => observer.disconnect();
  }, []);

  // Dismiss context menu on outside click.
  useEffect(() => {
    if (!contextMenu) return;
    const onClick = (): void => setContextMenu(null);
    window.addEventListener("click", onClick, { once: true });
    return (): void => window.removeEventListener("click", onClick);
  }, [contextMenu]);

  // Build glide-data-grid columns from the descriptor + persisted widths.
  const columns: GridColumn[] = useMemo(() => {
    if (!init) return [];
    return init.descriptor.columns.map((c) => ({
      id: c.name,
      title: c.name,
      width: columnWidths[c.name] ?? 160,
      hasMenu: false,
    }));
  }, [init, columnWidths]);

  // Pull cell content for the visible window. The grid asks for one
  // cell at a time during paint.
  const getCellContent = useCallback(
    (cell: Item): GridCell => {
      if (!init || !page) return blankCell();
      const [colIdx, rowIdx] = cell;
      const col = init.descriptor.columns[colIdx];
      const row = page.rows[rowIdx];
      if (!col || !row) return blankCell();

      const rowKey = buildRowKey(init.descriptor.pkColumns, init.descriptor.columns, row);
      const dirty = dirtyEdits.get(rowKey);
      const raw = dirty?.changes[col.name] !== undefined ? dirty.changes[col.name] : row[colIdx];
      const isReadonly =
        !init.descriptor.editable ||
        init.connection.mode !== "write" ||
        col.isPk;

      if (raw === null || raw === undefined) {
        return {
          kind: GridCellKind.Text,
          data: "",
          displayData: "NULL",
          allowOverlay: !isReadonly,
          readonly: isReadonly,
          style: "faded",
        };
      }

      if (col.jsType === "boolean") {
        return {
          kind: GridCellKind.Boolean,
          data: Boolean(raw),
          allowOverlay: false,
          readonly: isReadonly,
        };
      }
      if (col.jsType === "number") {
        const n = Number(raw);
        return {
          kind: GridCellKind.Number,
          data: Number.isFinite(n) ? n : undefined,
          displayData: String(raw),
          allowOverlay: !isReadonly,
          readonly: isReadonly,
        };
      }
      // text / date / json / enum / unknown all render as text. The
      // host validates on apply; complex editors land in the next
      // round (date picker, jsonb popout, enum dropdown).
      const display = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
      return {
        kind: GridCellKind.Text,
        data: display,
        displayData: display,
        allowOverlay: !isReadonly,
        readonly: isReadonly,
      };
    },
    [init, page, dirtyEdits],
  );

  const onCellEdited = useCallback(
    (cell: Item, newValue: EditableGridCell) => {
      if (!init || !page) return;
      const [colIdx, rowIdx] = cell;
      const col = init.descriptor.columns[colIdx];
      const row = page.rows[rowIdx];
      if (!col || !row || col.isPk) return;

      let value: unknown;
      if (newValue.kind === GridCellKind.Boolean) {
        value = newValue.data;
      } else if (newValue.kind === GridCellKind.Number) {
        value = newValue.data;
      } else {
        const text = (newValue as { data?: unknown }).data;
        // Empty text on a nullable column sets NULL.
        if (text === "" && col.nullable) value = null;
        else value = text;
      }

      const rowKey = buildRowKey(init.descriptor.pkColumns, init.descriptor.columns, row);
      const pkValues = pkValuesFor(init.descriptor.pkColumns, init.descriptor.columns, row);
      setDirtyEdits((prev) => {
        const next = new Map(prev);
        const existing = next.get(rowKey) ?? { pkValues, changes: {} };
        next.set(rowKey, {
          pkValues,
          changes: { ...existing.changes, [col.name]: value },
        });
        return next;
      });
      // Clear any prior failure on this row — user is trying again.
      setApplyErrors((prev) => {
        if (!prev.has(rowKey)) return prev;
        const next = new Map(prev);
        next.delete(rowKey);
        return next;
      });
    },
    [init, page],
  );

  const onApply = useCallback(() => {
    if (!init || dirtyEdits.size === 0) return;
    setApplyInFlight(true);
    const dirtyRows = [...dirtyEdits.entries()].map(([rowKey, { pkValues, changes }]) => ({
      rowKey,
      pkValues,
      changes,
    }));
    vscode.postMessage({ type: "applyRequested", payload: { dirtyRows } });
  }, [init, dirtyEdits]);

  const onRevert = useCallback(() => {
    setDirtyEdits(new Map());
    setApplyErrors(new Map());
  }, []);

  const onRefresh = useCallback(() => {
    vscode.postMessage({ type: "refreshRequested" });
  }, []);

  const onApplyConfirm = useCallback(() => {
    vscode.postMessage({ type: "applyConfirmed" });
    setApplyPreview(null);
  }, []);

  const onApplyCancel = useCallback(() => {
    vscode.postMessage({ type: "applyCancelled" });
    setApplyPreview(null);
    setApplyInFlight(false);
  }, []);

  const onCellContextMenu = useCallback(
    (cell: Item, e: { localEventX: number; localEventY: number; preventDefault: () => void }) => {
      if (!init || !page) return;
      const [colIdx, rowIdx] = cell;
      const col = init.descriptor.columns[colIdx];
      const row = page.rows[rowIdx];
      if (!col?.fk || !row) return;
      e.preventDefault();
      const value = row[colIdx];
      // Position the menu near the cell — glide-data-grid passes local
      // coords; offset to viewport-absolute.
      const rect = (e as unknown as { bounds?: { x: number; y: number } }).bounds;
      setContextMenu({
        x: rect?.x ?? e.localEventX,
        y: rect?.y ?? e.localEventY,
        column: col,
        value,
      });
    },
    [init, page],
  );

  const onOpenFk = useCallback(() => {
    if (!contextMenu) return;
    vscode.postMessage({
      type: "openReferencedRow",
      payload: {
        fromColumn: contextMenu.column.name,
        value: contextMenu.value,
      },
    });
    setContextMenu(null);
  }, [contextMenu]);

  const onColumnResize = useCallback(
    (col: GridColumn, newSize: number) => {
      const name = col.id;
      if (!name || !init) return;
      setColumnWidths((prev) => {
        const next = { ...prev, [name]: newSize };
        // Persist via host.
        vscode.postMessage({
          type: "layoutChanged",
          payload: {
            state: {
              columnOrder: init.persistedState?.columnOrder ?? init.descriptor.columns.map((c) => c.name),
              hiddenColumns: init.persistedState?.hiddenColumns ?? [],
              columnWidths: next,
              sort: init.persistedState?.sort ?? [],
              filters: init.persistedState?.filters ?? [],
              frozenColumnCount: init.persistedState?.frozenColumnCount ?? 0,
              scrollTop: init.persistedState?.scrollTop ?? 0,
              lastOpenedAt: Date.now(),
            },
          },
        });
        return next;
      });
    },
    [init],
  );

  if (!init) {
    return (
      <div style={{ padding: 16 }}>
        <p>Loading descriptor…</p>
      </div>
    );
  }

  const dirtyCount = dirtyEdits.size;
  // Distinguish the two read-only reasons. The user can fix one
  // (toggle Write mode); the other is structural (no PK on the table).
  // Misreporting "toggle Write to edit" when toggling can't help is
  // worse than no message at all.
  const isReadonly = !init.descriptor.editable || init.connection.mode !== "write";
  let readonlyReason: string | null = null;
  if (init.descriptor.target.kind !== "table") {
    readonlyReason = `${init.descriptor.target.kind === "view" ? "Views" : "Materialized views"} are read-only — open the source table to edit.`;
  } else if (init.descriptor.pkColumns.length === 0) {
    readonlyReason = "Read-only — no primary key on this table (cell editing requires a PK to generate safe UPDATEs).";
  } else if (init.connection.mode !== "write") {
    readonlyReason = "Read-only mode — toggle Write to edit.";
  }

  const showEmpty = page !== null && page.rows.length === 0 && loadError === null;

  return (
    <div
      // CSS grid with `1fr` for the middle row is more deterministic
      // than flex: 1 for filling vertical space — glide-data-grid uses
      // canvas and relies on a ResizeObserver against a parent with a
      // DEFINITE height. flex: 1 in a column-flex container without
      // `min-height: 0` can collapse to 0px on first paint and leave
      // the canvas invisible (no rows appear, no error surfaces). Grid
      // sidesteps the flex-basis dance entirely.
      style={{
        display: "grid",
        gridTemplateRows: "auto auto 1fr auto",
        height: "100vh",
        width: "100vw",
      }}
    >
      <Header init={init} page={page} loadError={loadError} gridSize={gridSize} />
      <Toolbar
        dirtyCount={dirtyCount}
        readonlyReason={readonlyReason}
        onApply={onApply}
        onRevert={onRevert}
        onRefresh={onRefresh}
      />
      <SizedDataEditor
        editorRef={editorRef}
        columns={columns}
        rows={page?.rows.length ?? 0}
        getCellContent={getCellContent}
        {...(isReadonly ? {} : { onCellEdited })}
        onColumnResize={onColumnResize}
        onCellContextMenu={onCellContextMenu}
        theme={theme}
        onSizeChanged={setGridSize}
      >
        {loadError !== null ? (
          <CenterBanner
            kind="error"
            title="Failed to load rows"
            body={loadError}
            actionLabel="Retry"
            onAction={onRefresh}
          />
        ) : page === null ? (
          <CenterBanner
            kind="info"
            title="Loading rows…"
            body="Querying the database for this table's contents. If this hangs, open the CNPG output channel for diagnostics."
            actionLabel="Reload"
            onAction={onRefresh}
          />
        ) : showEmpty ? (
          <CenterBanner
            kind="info"
            title="No rows"
            body={
              init.persistedState?.filters && init.persistedState.filters.length > 0
                ? "No rows match the current filters."
                : "This table is empty."
            }
            actionLabel="Refresh"
            onAction={onRefresh}
          />
        ) : null}
        {applyErrors.size > 0 ? (
          <ErrorBanner
            errors={applyErrors}
            onDismiss={() => setApplyErrors(new Map())}
          />
        ) : null}
      </SizedDataEditor>
      <StatusBar
        page={page}
        init={init}
        dirtyCount={dirtyCount}
        applyInFlight={applyInFlight}
      />
      {applyPreview ? (
        <ApplyModal
          preview={applyPreview}
          onConfirm={onApplyConfirm}
          onCancel={onApplyCancel}
        />
      ) : null}
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          fk={contextMenu.column.fk!}
          value={contextMenu.value}
          onOpen={onOpenFk}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Wrapper that measures its container with ResizeObserver and passes
 * **literal pixel dimensions** to DataEditor. glide-data-grid with
 * `width="100%" height="100%"` has a known race where the canvas
 * measures itself before the layout resolves and gets 0x0 — it then
 * paints nothing and doesn't always recover. Passing pixel dims that
 * track a live measurement avoids the race.
 */
function SizedDataEditor({
  editorRef,
  columns,
  rows,
  getCellContent,
  onCellEdited,
  onColumnResize,
  onCellContextMenu,
  theme,
  onSizeChanged,
  children,
}: {
  editorRef: React.RefObject<DataEditorRef>;
  columns: GridColumn[];
  rows: number;
  getCellContent: (cell: Item) => GridCell;
  onCellEdited?: (cell: Item, newValue: EditableGridCell) => void;
  onColumnResize: (col: GridColumn, newSize: number) => void;
  onCellContextMenu: (
    cell: Item,
    e: { localEventX: number; localEventY: number; preventDefault: () => void },
  ) => void;
  theme: Partial<Theme>;
  onSizeChanged: (size: { width: number; height: number }) => void;
  children?: React.ReactNode;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const apply = (w: number, h: number): void => {
      const wi = Math.floor(w);
      const hi = Math.floor(h);
      setSize((prev) => {
        if (prev.width === wi && prev.height === hi) return prev;
        // eslint-disable-next-line no-console
        console.log("[cnpg-grid] container resize", { width: wi, height: hi });
        onSizeChanged({ width: wi, height: hi });
        return { width: wi, height: hi };
      });
    };
    // Measure synchronously on mount so the first paint has real
    // dimensions — don't wait for the first ResizeObserver tick.
    const rect = el.getBoundingClientRect();
    apply(rect.width, rect.height);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const cr = entry.contentRect;
      apply(cr.width, cr.height);
    });
    ro.observe(el);
    return (): void => ro.disconnect();
  }, [onSizeChanged]);

  // Render the DataEditor even at 0×0 — glide-data-grid will re-paint
  // when its internal observer fires. The prior gate-on-positive-size
  // strategy could trap us in a "never renders" loop if the container
  // measured 0 on the first synchronous read.
  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        overflow: "hidden",
        minHeight: 0,
        height: "100%",
        width: "100%",
        // Defensive minimum so even if the grid layout collapses, we
        // still get *something* visible the user can see.
        minWidth: 100,
      }}
    >
      <DataEditor
        ref={editorRef}
        columns={columns}
        rows={rows}
        getCellContent={getCellContent}
        {...(onCellEdited ? { onCellEdited } : {})}
        onColumnResize={onColumnResize}
        onCellContextMenu={onCellContextMenu}
        theme={theme}
        smoothScrollX
        smoothScrollY
        rowMarkers="number"
        width={size.width || 800}
        height={size.height || 400}
      />
      {children}
    </div>
  );
}

function blankCell(): GridCell {
  return {
    kind: GridCellKind.Text,
    data: "",
    displayData: "",
    allowOverlay: false,
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Header({
  init,
  page,
  loadError,
  gridSize,
}: {
  init: InitPayload;
  page: PagePayload | null;
  loadError: string | null;
  gridSize: { width: number; height: number };
}): JSX.Element {
  // Render the renderer's internal state as a one-line debug chip so
  // the user can self-diagnose without needing webview dev tools.
  // The `gridSize` part is critical for diagnosing canvas-sizing
  // issues: if it shows `0×0`, the CSS grid `1fr` row isn't taking
  // any space and glide-data-grid is being painted onto a 0-pixel
  // canvas.
  const sizeChip = `${gridSize.width}×${gridSize.height}px`;
  const stateChip = loadError
    ? `error · ${loadError.slice(0, 60)}${loadError.length > 60 ? "…" : ""}`
    : page === null
      ? "loading…"
      : `${page.rows.length} of ${page.totalRows ?? "?"} rows · ${init.descriptor.columns.length} cols · ${sizeChip}`;
  return (
    <header
      style={{
        padding: "6px 12px",
        borderBottom: "1px solid var(--vscode-panel-border)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "var(--vscode-editor-background)",
        color: "var(--vscode-foreground)",
      }}
    >
      <strong>
        {init.descriptor.target.schema}.{init.descriptor.target.table}
      </strong>
      <span style={{ opacity: 0.7, fontSize: "0.9em" }}>
        {init.descriptor.target.kind} · {init.connection.cluster}/
        {init.connection.database} · {init.connection.mode}
      </span>
      <span
        style={{
          opacity: 0.6,
          fontSize: "0.8em",
          fontFamily: "var(--vscode-editor-font-family, monospace)",
          padding: "1px 6px",
          border: "1px solid var(--vscode-panel-border)",
          borderRadius: 3,
        }}
      >
        {stateChip}
      </span>
      <span style={{ marginLeft: "auto", opacity: 0.7, fontSize: "0.9em" }}>
        {init.descriptor.editable
          ? `🔑 ${init.descriptor.pkColumns.join(", ")}`
          : "Read-only"}
      </span>
    </header>
  );
}

function Toolbar({
  dirtyCount,
  readonlyReason,
  onApply,
  onRevert,
  onRefresh,
}: {
  dirtyCount: number;
  /** Null when fully editable; otherwise the reason editing is unavailable. */
  readonlyReason: string | null;
  onApply: () => void;
  onRevert: () => void;
  onRefresh: () => void;
}): JSX.Element {
  const readonly = readonlyReason !== null;
  return (
    <div
      style={{
        padding: "4px 12px",
        borderBottom: "1px solid var(--vscode-panel-border)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "var(--vscode-editor-background)",
      }}
    >
      <button
        onClick={onApply}
        disabled={readonly || dirtyCount === 0}
        style={btnStyle(dirtyCount > 0 && !readonly)}
      >
        Apply {dirtyCount > 0 ? `(${dirtyCount})` : ""}
      </button>
      <button onClick={onRevert} disabled={dirtyCount === 0} style={btnStyle(dirtyCount > 0)}>
        Revert
      </button>
      <button onClick={onRefresh} style={btnStyle(true)}>
        Refresh
      </button>
      {readonlyReason !== null ? (
        <span style={{ marginLeft: "auto", opacity: 0.6, fontSize: "0.85em" }}>
          {readonlyReason}
        </span>
      ) : null}
    </div>
  );
}

function btnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "3px 12px",
    fontSize: "0.9em",
    background: active
      ? "var(--vscode-button-background)"
      : "var(--vscode-button-secondaryBackground)",
    color: active
      ? "var(--vscode-button-foreground)"
      : "var(--vscode-button-secondaryForeground)",
    border: "1px solid var(--vscode-button-border, transparent)",
    cursor: active ? "pointer" : "default",
    opacity: active ? 1 : 0.5,
  };
}

function StatusBar({
  page,
  init,
  dirtyCount,
  applyInFlight,
}: {
  page: PagePayload | null;
  init: InitPayload;
  dirtyCount: number;
  applyInFlight: boolean;
}): JSX.Element {
  return (
    <footer
      style={{
        padding: "4px 12px",
        borderTop: "1px solid var(--vscode-panel-border)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        opacity: 0.85,
        fontSize: "0.85em",
        background: "var(--vscode-statusBar-background, var(--vscode-editor-background))",
        color: "var(--vscode-statusBar-foreground, var(--vscode-foreground))",
      }}
    >
      <span>
        {page ? `${page.rows.length} of ${page.totalRows ?? "?"} rows` : "—"}
      </span>
      {dirtyCount > 0 ? (
        <span>
          {dirtyCount} unsaved {dirtyCount === 1 ? "edit" : "edits"}
          {applyInFlight ? " · applying…" : ""}
        </span>
      ) : null}
      <span style={{ marginLeft: "auto", opacity: 0.7 }}>
        PK: {init.descriptor.pkColumns.length > 0 ? init.descriptor.pkColumns.join(", ") : "(none — read-only)"}
      </span>
    </footer>
  );
}

function ApplyModal({
  preview,
  onConfirm,
  onCancel,
}: {
  preview: ApplyPreviewPayload;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 800,
          maxHeight: "80vh",
          overflow: "auto",
          padding: 16,
          background: "var(--vscode-editor-background)",
          color: "var(--vscode-foreground)",
          border: "1px solid var(--vscode-panel-border)",
          borderRadius: 4,
        }}
      >
        <h3 style={{ marginTop: 0 }}>
          Apply {preview.statements.length} row
          {preview.statements.length === 1 ? "" : "s"}?
        </h3>
        <p style={{ opacity: 0.8 }}>
          Review the generated UPDATE statements. Confirm to run them in order.
        </p>
        <div
          style={{
            maxHeight: "50vh",
            overflow: "auto",
            border: "1px solid var(--vscode-panel-border)",
            padding: 8,
            fontFamily: "var(--vscode-editor-font-family)",
            fontSize: "0.85em",
          }}
        >
          {preview.statements.map((s, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div style={{ opacity: 0.6, marginBottom: 2 }}>
                Row {i + 1} · key {s.rowKey}
              </div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{s.text}</pre>
              <div style={{ opacity: 0.7, marginTop: 4 }}>
                Bindings: {s.values.map((v, j) => `$${j + 1}=${formatBinding(v)}`).join(", ")}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={btnStyle(true)}>Cancel</button>
          <button onClick={onConfirm} style={btnStyle(true)}>Run</button>
        </div>
      </div>
    </div>
  );
}

function formatBinding(v: unknown): string {
  if (v === null) return "NULL";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

function CenterBanner({
  kind,
  title,
  body,
  actionLabel,
  onAction,
}: {
  kind: "info" | "error";
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        zIndex: 50,
      }}
    >
      <div
        style={{
          pointerEvents: "auto",
          maxWidth: 480,
          padding: "16px 20px",
          background:
            kind === "error"
              ? "var(--vscode-inputValidation-errorBackground)"
              : "var(--vscode-editorWidget-background)",
          color:
            kind === "error"
              ? "var(--vscode-inputValidation-errorForeground)"
              : "var(--vscode-editorWidget-foreground, var(--vscode-foreground))",
          border: `1px solid ${kind === "error" ? "var(--vscode-inputValidation-errorBorder)" : "var(--vscode-editorWidget-border, var(--vscode-panel-border))"}`,
          borderRadius: 4,
          boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          textAlign: "center",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
        <div style={{ opacity: 0.85, fontSize: "0.9em", marginBottom: 12, whiteSpace: "pre-wrap" }}>
          {body}
        </div>
        <button onClick={onAction} style={btnStyle(true)}>
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

function ErrorBanner({
  errors,
  onDismiss,
}: {
  errors: Map<string, string>;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        maxWidth: 480,
        padding: "8px 12px",
        background: "var(--vscode-inputValidation-errorBackground)",
        color: "var(--vscode-inputValidation-errorForeground)",
        border: "1px solid var(--vscode-inputValidation-errorBorder)",
        borderRadius: 4,
        fontSize: "0.85em",
        zIndex: 100,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong>{errors.size} edit{errors.size === 1 ? "" : "s"} failed</strong>
        <button onClick={onDismiss} style={{ marginLeft: "auto", ...btnStyle(true) }}>
          Dismiss
        </button>
      </div>
      <div style={{ maxHeight: 200, overflow: "auto", marginTop: 6 }}>
        {[...errors.entries()].map(([rowKey, reason]) => (
          <div key={rowKey} style={{ marginBottom: 4 }}>
            <code style={{ opacity: 0.7 }}>{rowKey}</code>: {reason}
          </div>
        ))}
      </div>
    </div>
  );
}

function ContextMenu({
  x,
  y,
  fk,
  value,
  onOpen,
  onClose,
}: {
  x: number;
  y: number;
  fk: { refSchema: string; refTable: string; refColumn: string };
  value: unknown;
  onOpen: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        position: "fixed",
        top: y,
        left: x,
        zIndex: 1100,
        background: "var(--vscode-menu-background)",
        color: "var(--vscode-menu-foreground)",
        border: "1px solid var(--vscode-menu-border, var(--vscode-panel-border))",
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
        padding: 4,
        minWidth: 240,
      }}
    >
      <button
        onClick={onOpen}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: "6px 10px",
          background: "transparent",
          color: "inherit",
          border: "none",
          cursor: "pointer",
        }}
      >
        → Go to {fk.refSchema}.{fk.refTable} where {fk.refColumn} = {formatBinding(value)}
      </button>
      <button
        onClick={onClose}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: "6px 10px",
          background: "transparent",
          color: "inherit",
          border: "none",
          cursor: "pointer",
        }}
      >
        Cancel
      </button>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
