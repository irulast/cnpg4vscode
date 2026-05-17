/**
 * GridEditorHost — the per-table webview controller (US6 Phase 8.5 — T150).
 *
 * One `GridEditorHost` instance per open Grid Editor tab. Owns the
 * `vscode.WebviewPanel`, builds + sends `init`, validates + routes
 * every inbound message via `validateInbound()` from the protocol
 * module, persists layout changes via `grid-editor-state.ts`, and
 * threads cell-edit requests through the already-built bulk-apply
 * orchestrator + cell-edit-orchestrator.
 *
 * Not unit-tested in this round — exercised by future e2e tests
 * (T142–T145) once the harness exists. The pure pieces it composes
 * (descriptor / SELECT-builder / bulk-apply / orchestrator / state
 * serializer / cell-editors / HTML template) ARE all unit-tested,
 * which is where the safety lives.
 *
 * Lifecycle:
 *   1. `GridEditorHost.create(deps)` → creates the panel, loads HTML.
 *   2. Renderer sends `ready` → host sends `init` with descriptor +
 *      theme + persisted state.
 *   3. Steady-state: renderer issues `loadPage` / `applyRequested` /
 *      etc.; host validates, dispatches, and responds.
 *   4. On `connection.onModeChanged` → host sends `modeChanged`.
 *   5. On `window.onDidChangeActiveColorTheme` → host sends
 *      `themeChanged`.
 *   6. On `panel.onDidDispose` → host sends `disposed`, releases
 *      every subscription, removes itself from the registry.
 */

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";

import {
  buildApplyPreview,
  buildApplyResult,
  buildInit,
  buildModeChanged,
  buildPage,
  buildThemeChanged,
  validateInbound,
  type InboundMessage,
  type ResultSetDescriptor,
} from "../webviews/grid/protocol.js";
import { buildGridWebviewHtml } from "./html-template.js";
import { snapshotThemeTokens } from "./theme.js";
import { fetchResultSetDescriptor } from "./descriptor.js";
import { buildSelectPage, buildSelectCount } from "../sql/select-builder.js";
import { toCsv, toJson, toInserts } from "./export.js";
import { runBulkApply, type DirtyRowRequest } from "./bulk-apply.js";
import { buildDelete, buildInsert, type BuiltStatement, type ColumnChange } from "../sql/update-builder.js";
import {
  applyDefaults,
  deserialize,
  loadGridState,
  saveGridState,
  serialize,
  type GridEditorState,
  type GridStateKey,
} from "../state/grid-editor-state.js";
import { type ActiveConnection, getSession } from "../state/session.js";
import { log } from "../logging/channel.js";

export interface GridEditorHostDeps {
  readonly extensionUri: vscode.Uri;
  readonly workspaceState: vscode.Memento;
  readonly conn: ActiveConnection;
  readonly schema: string;
  readonly table: string;
  /** Optional initial filters (used by FK navigation to seed a filtered view). */
  readonly initialFilters?: ReadonlyArray<{ column: string; op: "eq"; value: string }>;
  /**
   * Optional pre-existing panel to adopt. VS Code passes one of these to
   * the `WebviewPanelSerializer` (T158) when restoring a hibernated tab;
   * the host re-uses it rather than opening a new tab. When omitted, the
   * host creates its own panel.
   */
  readonly existingPanel?: vscode.WebviewPanel;
  /** Called when the user requests opening another table (FK drill-down). */
  readonly openReferenced: (target: {
    conn: ActiveConnection;
    schema: string;
    table: string;
    initialFilters: ReadonlyArray<{ column: string; op: "eq"; value: string }>;
  }) => Promise<void>;
}

const DEFAULT_PAGE_SIZE = 1000;

export class GridEditorHost implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly stateKey: GridStateKey;
  private descriptor: ResultSetDescriptor | null = null;
  private layoutState: GridEditorState;
  private pendingApply: {
    rows: ReadonlyArray<DirtyRowRequest>;
    resolve: (decision: "confirmed" | "cancelled") => void;
  } | null = null;
  private disposed = false;

  static create(deps: GridEditorHostDeps): GridEditorHost {
    return new GridEditorHost(deps);
  }

  private constructor(private readonly deps: GridEditorHostDeps) {
    this.stateKey = {
      contextName: deps.conn.cluster.contextName,
      namespace: deps.conn.cluster.namespace,
      clusterName: deps.conn.cluster.clusterName,
      database: deps.conn.database,
      schema: deps.schema,
      table: deps.table,
    };
    this.layoutState = this.loadPersistedState();

    const title = `${deps.schema}.${deps.table}`;
    if (deps.existingPanel) {
      // Adopt the panel VS Code rebuilt during workspace restore (T158).
      // Re-set its options so the localResourceRoots + script enablement
      // match what we'd produce on a fresh create — VS Code persists the
      // view type and visibility, NOT the security knobs.
      this.panel = deps.existingPanel;
      this.panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(deps.extensionUri, "dist", "webviews", "grid"),
        ],
      };
      this.panel.title = title;
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "cnpg.gridEditor",
        title,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(deps.extensionUri, "dist", "webviews", "grid"),
          ],
        },
      );
    }

    const bundleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(deps.extensionUri, "dist", "webviews", "grid", "bundle.js"),
    );
    const stylesheetUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(deps.extensionUri, "dist", "webviews", "grid", "bundle.css"),
    );
    const nonce = randomBytes(16).toString("hex");
    this.panel.webview.html = buildGridWebviewHtml({
      cspSource: this.panel.webview.cspSource,
      bundleSrc: bundleUri.toString(),
      stylesheetSrc: stylesheetUri.toString(),
      nonce,
      title,
    });

    // Track the connection's mode across session-change events. The
    // session fires a single change event for any state transition;
    // we filter to mode flips by comparing against the last-seen
    // value.
    let lastMode = deps.conn.connection.mode;
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((raw) => this.onInbound(raw)),
      this.panel.onDidDispose(() => this.dispose()),
      vscode.window.onDidChangeActiveColorTheme(() =>
        this.send(buildThemeChanged({ theme: snapshotThemeTokens() })),
      ),
      getSession().onChanged(() => {
        const current = this.deps.conn.connection.mode;
        if (current !== lastMode) {
          log.info("grid.host.modeChanged", {
            connection: this.deps.conn.id,
            from: lastMode,
            to: current,
          });
          lastMode = current;
          this.send(buildModeChanged({ mode: current }));
        }
      }),
    );

    log.info("grid.host.opened", {
      connection: deps.conn.id,
      target: `${deps.schema}.${deps.table}`,
    });
  }

  /** Called by the registry when the user requests the same (conn, schema, table) again. */
  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposables.splice(0)) d.dispose();
    this.panel.dispose();
    log.info("grid.host.disposed", { connection: this.deps.conn.id });
  }

  // ---------------------------------------------------------------------------
  // Inbound dispatch
  // ---------------------------------------------------------------------------

  private async onInbound(raw: unknown): Promise<void> {
    const result = validateInbound(raw);
    if (!result.ok) {
      log.warn("grid.host.inbound.invalid", {
        code: result.code,
        reason: result.reason,
      });
      return;
    }
    const msg = result.message;
    try {
      await this.dispatch(msg);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("grid.host.inbound.failed", { type: msg.type, reason });
    }
  }

  private async dispatch(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.onReady();
        return;
      case "loadPage":
        await this.onLoadPage(msg.payload);
        return;
      case "applyRequested":
        await this.onApplyRequested(msg.payload.dirtyRows as DirtyRowRequest[]);
        return;
      case "applyConfirmed":
        this.resolvePending("confirmed");
        return;
      case "applyCancelled":
        this.resolvePending("cancelled");
        return;
      case "deleteRequested":
        await this.onDeleteRequested(msg.payload.rows);
        return;
      case "insertRequested":
        await this.onInsertRequested(msg.payload.values);
        return;
      case "openReferencedRow":
        await this.onOpenReferenced(msg.payload.fromColumn, msg.payload.value);
        return;
      case "layoutChanged":
        await this.onLayoutChanged(msg.payload.state);
        return;
      case "exportRequested":
        await this.onExportRequested(msg.payload.format, msg.payload.scope);
        return;
      case "refreshRequested":
        await this.onLoadPage({ offset: 0, limit: DEFAULT_PAGE_SIZE });
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Per-message handlers
  // ---------------------------------------------------------------------------

  private async onReady(): Promise<void> {
    log.info("grid.host.ready", {
      target: `${this.deps.schema}.${this.deps.table}`,
      mode: this.deps.conn.connection.mode,
    });
    try {
      this.descriptor = await fetchResultSetDescriptor(this.deps.conn.connection, {
        schema: this.deps.schema,
        table: this.deps.table,
      });
      log.info("grid.host.descriptor.ok", {
        target: `${this.deps.schema}.${this.deps.table}`,
        kind: this.descriptor.target.kind,
        editable: this.descriptor.editable,
        pkColumns: this.descriptor.pkColumns,
        columnCount: this.descriptor.columns.length,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("grid.host.descriptor.failed", { reason });
      vscode.window.showErrorMessage(
        `Cannot open Grid Editor for ${this.deps.schema}.${this.deps.table}: ${reason}`,
      );
      this.dispose();
      return;
    }

    // If layout state's columnOrder is empty (fresh open), seed it from
    // the descriptor.
    if (this.layoutState.columnOrder.length === 0) {
      this.layoutState = applyDefaults({ columns: this.descriptor.columns });
    }
    // Merge initial filters from FK navigation, if any.
    const filters = [
      ...this.layoutState.filters,
      ...(this.deps.initialFilters ?? []),
    ];
    this.layoutState = { ...this.layoutState, filters };

    this.send(
      buildInit({
        descriptor: this.descriptor,
        theme: snapshotThemeTokens(),
        persistedState: this.layoutState,
        connection: {
          id: this.deps.conn.id,
          mode: this.deps.conn.connection.mode,
          database: this.deps.conn.database,
          cluster: this.deps.conn.cluster.clusterName,
        },
      }),
    );

    // Auto-load the first page so the user sees data immediately.
    await this.onLoadPage({ offset: 0, limit: DEFAULT_PAGE_SIZE });
  }

  private async onLoadPage(payload: {
    offset: number;
    limit: number;
    sort?: ReadonlyArray<{ column: string; dir: "asc" | "desc" }>;
    filters?: ReadonlyArray<{ column: string; op: string; value?: string }>;
  }): Promise<void> {
    if (!this.descriptor) return;
    const sort = payload.sort ?? this.layoutState.sort;
    const rawFilters = payload.filters ?? this.layoutState.filters;
    // The protocol validator already constrained `op` to the enum, but
    // re-narrow here for the SELECT-builder's typed signature.
    const filters = rawFilters.map((f) =>
      f.value === undefined
        ? ({ column: f.column, op: f.op as never })
        : ({ column: f.column, op: f.op as never, value: f.value }),
    );

    const pageStmt = buildSelectPage({
      schema: this.deps.schema,
      table: this.deps.table,
      sort,
      filters,
      limit: payload.limit,
      offset: payload.offset,
    });
    const countStmt = buildSelectCount({
      schema: this.deps.schema,
      table: this.deps.table,
      filters,
    });

    log.info("grid.host.loadPage.start", {
      target: `${this.deps.schema}.${this.deps.table}`,
      offset: payload.offset,
      limit: payload.limit,
      filterCount: filters.length,
      mode: this.deps.conn.connection.mode,
    });
    try {
      const [pageRes, countRes] = await Promise.all([
        this.deps.conn.connection.query(pageStmt.text, pageStmt.values),
        this.deps.conn.connection.query(countStmt.text, countStmt.values),
      ]);
      const rows = pageRes.rows.map((r) =>
        this.descriptor!.columns.map((c) => (r as Record<string, unknown>)[c.name] ?? null),
      );
      const totalRows = Number((countRes.rows[0] as Record<string, unknown>)?.["total"] ?? 0);
      log.info("grid.host.loadPage.ok", { rows: rows.length, totalRows });
      this.send(
        buildPage({
          offset: payload.offset,
          rows,
          totalRows,
          truncated: false,
        }),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("grid.host.loadPage.failed", { reason });
      // Surface the failure to the renderer so the user sees a banner
      // instead of an indefinite "loading…" state. The renderer keys
      // off the message type `loadFailed`; the validator does not need
      // updating because this is HOST → renderer (outbound, not
      // validated on receive).
      this.send({ type: "loadFailed", payload: { reason } });
    }
  }

  private async onApplyRequested(rows: DirtyRowRequest[]): Promise<void> {
    if (!this.descriptor) return;
    const summary = await runBulkApply(
      {
        descriptor: {
          schema: this.descriptor.target.schema,
          table: this.descriptor.target.table,
          pkColumns: this.descriptor.pkColumns,
        },
        mode: this.deps.conn.connection.mode,
        presentBulkPreview: async (statements) => {
          // Hand the preview off to the renderer's modal, then await
          // applyConfirmed / applyCancelled on the inbound channel.
          this.send(
            buildApplyPreview({
              statements: statements.map(({ rowKey, stmt }) => ({
                rowKey,
                text: stmt.text,
                values: stmt.values,
              })),
            }),
          );
          return new Promise<"confirmed" | "cancelled">((resolve) => {
            this.pendingApply = { rows, resolve };
          });
        },
        executeStatement: (stmt) =>
          this.deps.conn.connection.query(stmt.text, stmt.values).then((r) => ({
            rowsAffected: r.rowCount ?? 0,
          })),
        onRowResult: (rowKey, outcome) => {
          this.send(
            buildApplyResult({
              rowKey,
              outcome:
                outcome.kind === "applied"
                  ? { kind: "applied", rowsAffected: outcome.rowsAffected }
                  : outcome.kind === "rejected"
                    ? { kind: "rejected", code: outcome.code, reason: outcome.reason }
                    : { kind: "failed", reason: outcome.error.message },
            }),
          );
        },
        logger: log,
      },
      rows,
    );
    log.info("grid.host.applyRequested.summary", { ...summary });
  }

  private resolvePending(decision: "confirmed" | "cancelled"): void {
    if (!this.pendingApply) return;
    const { resolve } = this.pendingApply;
    this.pendingApply = null;
    resolve(decision);
  }

  private async onDeleteRequested(
    rows: ReadonlyArray<{ rowKey: string; pkValues: ReadonlyArray<unknown> }>,
  ): Promise<void> {
    if (!this.descriptor || this.descriptor.pkColumns.length === 0) return;
    if (this.deps.conn.connection.mode !== "write") {
      vscode.window.showWarningMessage(
        "Toggle Write mode before deleting rows.",
      );
      return;
    }
    const target = `${this.descriptor.target.schema}.${this.descriptor.target.table}`;
    const choice = await vscode.window.showWarningMessage(
      `Delete ${rows.length} row(s) from ${target}? This cannot be undone.`,
      { modal: true, detail: `Type "${target}" in the next prompt to confirm.` },
      "Continue",
    );
    if (choice !== "Continue") return;
    const typed = await vscode.window.showInputBox({
      title: `Confirm DELETE on ${target}`,
      prompt: `Type the fully-qualified target name (${target}) to proceed.`,
      placeHolder: target,
      ignoreFocusOut: true,
    });
    if (typed !== target) {
      vscode.window.showInformationMessage("Delete cancelled — name did not match.");
      return;
    }

    for (const r of rows) {
      const stmt = buildDelete({
        schema: this.descriptor.target.schema,
        table: this.descriptor.target.table,
        pkColumns: this.descriptor.pkColumns,
        pkValues: r.pkValues,
      });
      try {
        await this.deps.conn.connection.query(stmt.text, stmt.values);
        this.send(
          buildApplyResult({
            rowKey: r.rowKey,
            outcome: { kind: "applied", rowsAffected: 1 },
          }),
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.send(
          buildApplyResult({
            rowKey: r.rowKey,
            outcome: { kind: "failed", reason },
          }),
        );
      }
    }
  }

  private async onInsertRequested(values: Readonly<Record<string, unknown>>): Promise<void> {
    if (!this.descriptor) return;
    if (this.deps.conn.connection.mode !== "write") {
      vscode.window.showWarningMessage("Toggle Write mode before adding rows.");
      return;
    }
    const safeValues = values as Readonly<Record<string, ColumnChange>>;
    const returning = this.descriptor.pkColumns.length > 0
      ? this.descriptor.pkColumns
      : "*" as const;
    const stmt: BuiltStatement = buildInsert({
      schema: this.descriptor.target.schema,
      table: this.descriptor.target.table,
      values: safeValues,
      returning,
    });
    try {
      await this.deps.conn.connection.query(stmt.text, stmt.values);
      vscode.window.showInformationMessage(
        `Inserted row into ${this.descriptor.target.schema}.${this.descriptor.target.table}.`,
      );
      // Reload so the new row appears.
      await this.onLoadPage({ offset: 0, limit: DEFAULT_PAGE_SIZE });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`INSERT failed: ${reason}`);
    }
  }

  private async onOpenReferenced(fromColumn: string, value: unknown): Promise<void> {
    if (!this.descriptor) return;
    const col = this.descriptor.columns.find((c) => c.name === fromColumn);
    if (!col?.fk) {
      vscode.window.showInformationMessage(
        `Column "${fromColumn}" has no foreign key to follow.`,
      );
      return;
    }
    const valueAsString = value === null || value === undefined ? "" : String(value);
    await this.deps.openReferenced({
      conn: this.deps.conn,
      schema: col.fk.refSchema,
      table: col.fk.refTable,
      initialFilters: [{ column: col.fk.refColumn, op: "eq", value: valueAsString }],
    });
  }

  private async onExportRequested(
    format: "csv" | "json" | "sql-insert",
    scope: "selection" | "allRows",
  ): Promise<void> {
    if (!this.descriptor) return;
    log.info("grid.host.exportRequested", { format, scope });

    // Selection-scoped export needs the renderer to forward the
    // selection range; today the protocol doesn't carry that, so we
    // fall back to all rows and surface the limitation.
    if (scope === "selection") {
      log.info("grid.host.export.selectionFallback", { reason: "selection scope not wired" });
    }

    const filters = this.layoutState.filters.map((f) =>
      f.value === undefined
        ? ({ column: f.column, op: f.op as never })
        : ({ column: f.column, op: f.op as never, value: f.value }),
    );
    const sort = this.layoutState.sort;
    // 10 000 is the SELECT builder's MAX_LIMIT — matches the largest
    // page the host will ever emit and avoids unbounded result sets.
    const pageStmt = buildSelectPage({
      schema: this.deps.schema,
      table: this.deps.table,
      sort,
      filters,
      limit: 10_000,
      offset: 0,
    });
    let rows: ReadonlyArray<ReadonlyArray<unknown>> = [];
    try {
      const res = await this.deps.conn.connection.query(pageStmt.text, pageStmt.values);
      rows = res.rows.map((r) =>
        this.descriptor!.columns.map((c) => (r as Record<string, unknown>)[c.name] ?? null),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("grid.host.export.queryFailed", { reason });
      vscode.window.showErrorMessage(`Export failed: ${reason}`);
      return;
    }

    const cols = this.descriptor.columns.map((c) => ({ name: c.name, pgType: c.pgType }));
    let blob: string;
    let defaultExt: string;
    switch (format) {
      case "csv":
        blob = toCsv(rows, cols);
        defaultExt = "csv";
        break;
      case "json":
        blob = toJson(rows, cols);
        defaultExt = "json";
        break;
      case "sql-insert":
        blob = toInserts(
          this.descriptor.target.schema,
          this.descriptor.target.table,
          rows,
          cols,
        );
        defaultExt = "sql";
        break;
    }

    const defaultName = `${this.deps.schema}.${this.deps.table}.${defaultExt}`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultName),
      filters: { [defaultExt.toUpperCase()]: [defaultExt] },
      saveLabel: `Export as ${defaultExt.toUpperCase()}`,
    });
    if (!target) return;
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(blob, "utf8"));
      vscode.window.showInformationMessage(
        `Exported ${rows.length} row(s) to ${target.fsPath}`,
      );
      log.info("grid.host.export.ok", { rows: rows.length, format, path: target.fsPath });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("grid.host.export.writeFailed", { reason });
      vscode.window.showErrorMessage(`Could not write export file: ${reason}`);
    }
  }

  private async onLayoutChanged(state: GridEditorState): Promise<void> {
    // The protocol validator passes the state through opaquely; the
    // grid-editor-state module's serializer applies the defense-in-
    // depth allowlist here, then writes via the centralised chokepoint.
    const json = serialize({ ...state, lastOpenedAt: Date.now() });
    const safe = deserialize(json);
    if (!safe) return;
    this.layoutState = safe;
    await saveGridState(this.deps.workspaceState, this.stateKey, safe);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private send(msg: unknown): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(msg);
  }

  private loadPersistedState(): GridEditorState {
    return (
      loadGridState(this.deps.workspaceState, this.stateKey) ?? {
        columnOrder: [],
        hiddenColumns: [],
        columnWidths: {},
        sort: [],
        filters: [],
        frozenColumnCount: 0,
        scrollTop: 0,
        lastOpenedAt: 0,
      }
    );
  }
}
