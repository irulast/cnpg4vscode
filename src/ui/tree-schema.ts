/**
 * SchemaTreeProvider (US5; FR-022, FR-023, FR-024).
 *
 * Renders Connection → Database → Schema → (Tables / Views / MViews /
 * Indexes / Sequences / Functions / Triggers / Types / Extensions / Roles).
 * Every node is lazy-loaded via the Introspector.
 *
 * Reactive: re-emits onDidChangeTreeData when the active Session reports a
 * connection added/removed, so connecting to a database immediately reveals
 * its schemas without a manual refresh.
 */

import * as vscode from "vscode";
import {
  ColumnRow,
  ConstraintRow,
  ExtensionRow,
  FunctionRow,
  IndexRow,
  Introspector,
  qualifyIdent,
  quoteIdent,
  RelationRow,
  RoleRow,
  SchemaRow,
  SequenceRow,
  TriggerRow,
  TypeRow,
} from "../pg/introspect.js";
import { ActiveConnection, getSession } from "../state/session.js";
import { log } from "../logging/channel.js";

export type SchemaNode =
  | { kind: "connection"; conn: ActiveConnection }
  | { kind: "schema"; conn: ActiveConnection; schema: SchemaRow }
  | { kind: "group"; conn: ActiveConnection; schema: SchemaRow; group: GroupKind }
  | { kind: "relation"; conn: ActiveConnection; schema: SchemaRow; relation: RelationRow }
  | { kind: "column"; conn: ActiveConnection; schema: SchemaRow; relation: RelationRow; column: ColumnRow }
  | { kind: "index"; conn: ActiveConnection; schema: SchemaRow; relation: RelationRow; index: IndexRow }
  | { kind: "constraint"; conn: ActiveConnection; schema: SchemaRow; relation: RelationRow; constraint: ConstraintRow }
  | { kind: "trigger"; conn: ActiveConnection; schema: SchemaRow; relation: RelationRow; trigger: TriggerRow }
  | { kind: "sequence"; conn: ActiveConnection; schema: SchemaRow; sequence: SequenceRow }
  | { kind: "function"; conn: ActiveConnection; schema: SchemaRow; function: FunctionRow }
  | { kind: "type"; conn: ActiveConnection; schema: SchemaRow; type: TypeRow }
  | { kind: "extension"; ext: ExtensionRow }
  | { kind: "role"; role: RoleRow }
  | { kind: "info"; label: string; description?: string; iconId: string }
  | { kind: "relchildren"; conn: ActiveConnection; schema: SchemaRow; relation: RelationRow; childKind: "columns" | "indexes" | "constraints" | "triggers" };

type GroupKind = "tables" | "views" | "mviews" | "foreign" | "sequences" | "functions" | "types";

const GROUP_LABELS: Record<GroupKind, string> = {
  tables: "Tables",
  views: "Views",
  mviews: "Materialized Views",
  foreign: "Foreign Tables",
  sequences: "Sequences",
  functions: "Functions & Procedures",
  types: "Types",
};

export class SchemaTreeProvider implements vscode.TreeDataProvider<SchemaNode>, vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<SchemaNode | undefined | void>();
  readonly onDidChangeTreeData = this._emitter.event;

  private readonly introspectors = new Map<string, Introspector>();
  private readonly sessionUnsubscribe: vscode.Disposable;

  constructor() {
    this.sessionUnsubscribe = getSession().onChanged(() => this._emitter.fire());
  }

  dispose(): void {
    this._emitter.dispose();
    this.sessionUnsubscribe.dispose();
  }

  /** Force a refresh of every introspector cache + tree node. */
  refresh(): void {
    for (const i of this.introspectors.values()) i.invalidate();
    this._emitter.fire();
  }

  /** Force-invalidate the cache for one connection (e.g., after a DDL action). */
  invalidateConnection(connId: string): void {
    this.introspectors.get(connId)?.invalidate();
    this._emitter.fire();
  }

  private introspectorFor(conn: ActiveConnection): Introspector {
    let i = this.introspectors.get(conn.id);
    if (!i) {
      i = new Introspector(conn.connection);
      this.introspectors.set(conn.id, i);
    }
    return i;
  }

  getTreeItem(node: SchemaNode): vscode.TreeItem {
    switch (node.kind) {
      case "connection": {
        const item = new vscode.TreeItem(
          `${node.conn.cluster.namespace}/${node.conn.cluster.clusterName}/${node.conn.database}`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.contextValue = "connection";
        item.description = `${node.conn.user} (${node.conn.connection.mode})`;
        item.iconPath = new vscode.ThemeIcon("database");
        item.tooltip = `Connection ${node.conn.id}`;
        return item;
      }
      case "schema": {
        const item = new vscode.TreeItem(node.schema.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "schema";
        item.iconPath = new vscode.ThemeIcon("symbol-namespace");
        if (node.schema.isSystem) item.description = "system";
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(GROUP_LABELS[node.group], vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = `group:${node.group}`;
        item.iconPath = new vscode.ThemeIcon("symbol-class");
        return item;
      }
      case "relation": {
        const item = new vscode.TreeItem(node.relation.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue =
          node.relation.kind === "table"
            ? "table"
            : node.relation.kind === "view"
              ? "view"
              : node.relation.kind === "materializedView"
                ? "materializedView"
                : "foreign";
        item.description = `${node.relation.estRows} rows`;
        item.iconPath = new vscode.ThemeIcon(
          node.relation.kind === "table" ? "table" : node.relation.kind === "view" ? "eye" : "symbol-class",
        );
        item.tooltip = `${node.schema.name}.${node.relation.name} (${node.relation.kind})`;
        return item;
      }
      case "relchildren": {
        const labels = { columns: "Columns", indexes: "Indexes", constraints: "Constraints", triggers: "Triggers" };
        const item = new vscode.TreeItem(labels[node.childKind], vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = `relgroup:${node.childKind}`;
        item.iconPath = new vscode.ThemeIcon("list-tree");
        return item;
      }
      case "column": {
        const item = new vscode.TreeItem(`${node.column.name}: ${node.column.type}`, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "column";
        const flags: string[] = [];
        if (node.column.isPk) flags.push("PK");
        if (node.column.notNull) flags.push("NOT NULL");
        if (flags.length > 0) item.description = flags.join(" ");
        item.iconPath = new vscode.ThemeIcon(node.column.isPk ? "key" : "symbol-field");
        return item;
      }
      case "index": {
        const item = new vscode.TreeItem(node.index.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "index";
        const flags = [
          node.index.isPrimary ? "primary" : null,
          node.index.isUnique ? "unique" : null,
          node.index.isPartial ? "partial" : null,
        ].filter(Boolean);
        item.description = `${node.index.columns.join(", ")}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
        item.iconPath = new vscode.ThemeIcon("symbol-key");
        return item;
      }
      case "constraint": {
        const item = new vscode.TreeItem(node.constraint.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "constraint";
        item.description = node.constraint.kind;
        item.tooltip = node.constraint.definition;
        item.iconPath = new vscode.ThemeIcon("law");
        return item;
      }
      case "trigger": {
        const item = new vscode.TreeItem(node.trigger.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "trigger";
        item.tooltip = node.trigger.definition;
        item.iconPath = new vscode.ThemeIcon("symbol-event");
        return item;
      }
      case "sequence": {
        const item = new vscode.TreeItem(node.sequence.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "sequence";
        item.iconPath = new vscode.ThemeIcon("symbol-numeric");
        return item;
      }
      case "function": {
        const item = new vscode.TreeItem(node.function.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "function";
        item.description = `${node.function.args} → ${node.function.returns}`;
        item.tooltip = `language ${node.function.language}`;
        item.iconPath = new vscode.ThemeIcon("symbol-method");
        return item;
      }
      case "type": {
        const item = new vscode.TreeItem(node.type.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "type";
        item.iconPath = new vscode.ThemeIcon("symbol-class");
        return item;
      }
      case "extension": {
        const item = new vscode.TreeItem(node.ext.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "extension";
        item.description = node.ext.version;
        item.iconPath = new vscode.ThemeIcon("extensions");
        return item;
      }
      case "role": {
        const item = new vscode.TreeItem(node.role.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "role";
        const flags = [
          node.role.super ? "super" : null,
          node.role.canLogin ? "login" : null,
        ].filter(Boolean);
        if (flags.length > 0) item.description = flags.join(", ");
        item.iconPath = new vscode.ThemeIcon("person");
        return item;
      }
      case "info": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.iconId);
        if (node.description) item.description = node.description;
        return item;
      }
    }
  }

  async getChildren(node?: SchemaNode): Promise<SchemaNode[]> {
    if (!node) {
      const conns = [...getSession().connections.values()];
      if (conns.length === 0) {
        return [{ kind: "info", label: "No active connections", iconId: "info" }];
      }
      return conns.map((conn) => ({ kind: "connection" as const, conn }));
    }
    try {
      return await this.childrenFor(node);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("schema.tree.load.failed", { node: node.kind, message });
      return [{ kind: "info", label: "Failed to load", description: message, iconId: "warning" }];
    }
  }

  private async childrenFor(node: SchemaNode): Promise<SchemaNode[]> {
    switch (node.kind) {
      case "connection": {
        const i = this.introspectorFor(node.conn);
        const schemas = await i.schemas();
        return schemas
          .filter((s) => !s.isSystem) // hide pg_* / information_schema by default
          .map((schema) => ({ kind: "schema" as const, conn: node.conn, schema }));
      }
      case "schema": {
        const groups: GroupKind[] = ["tables", "views", "mviews", "foreign", "sequences", "functions", "types"];
        return groups.map((group) => ({ kind: "group" as const, conn: node.conn, schema: node.schema, group }));
      }
      case "group": {
        const i = this.introspectorFor(node.conn);
        switch (node.group) {
          case "tables":
          case "views":
          case "mviews":
          case "foreign": {
            const targetKind: RelationRow["kind"] =
              node.group === "tables" ? "table" : node.group === "views" ? "view" : node.group === "mviews" ? "materializedView" : "foreign";
            const rels = await i.relations(node.schema.oid);
            return rels
              .filter((r) => r.kind === targetKind)
              .map((relation) => ({ kind: "relation" as const, conn: node.conn, schema: node.schema, relation }));
          }
          case "sequences": {
            const seqs = await i.sequences(node.schema.oid);
            return seqs.map((sequence) => ({ kind: "sequence" as const, conn: node.conn, schema: node.schema, sequence }));
          }
          case "functions": {
            const fns = await i.functions(node.schema.oid);
            return fns.map((fn) => ({ kind: "function" as const, conn: node.conn, schema: node.schema, function: fn }));
          }
          case "types": {
            const types = await i.types(node.schema.oid);
            return types.map((type) => ({ kind: "type" as const, conn: node.conn, schema: node.schema, type }));
          }
        }
        return [];
      }
      case "relation": {
        return [
          { kind: "relchildren", conn: node.conn, schema: node.schema, relation: node.relation, childKind: "columns" },
          { kind: "relchildren", conn: node.conn, schema: node.schema, relation: node.relation, childKind: "indexes" },
          { kind: "relchildren", conn: node.conn, schema: node.schema, relation: node.relation, childKind: "constraints" },
          { kind: "relchildren", conn: node.conn, schema: node.schema, relation: node.relation, childKind: "triggers" },
        ];
      }
      case "relchildren": {
        const i = this.introspectorFor(node.conn);
        switch (node.childKind) {
          case "columns": {
            const cols = await i.columns(node.relation.oid);
            return cols.map((column) => ({ kind: "column" as const, conn: node.conn, schema: node.schema, relation: node.relation, column }));
          }
          case "indexes": {
            const idxs = await i.indexes(node.relation.oid);
            return idxs.map((index) => ({ kind: "index" as const, conn: node.conn, schema: node.schema, relation: node.relation, index }));
          }
          case "constraints": {
            const cons = await i.constraints(node.relation.oid);
            return cons.map((constraint) => ({ kind: "constraint" as const, conn: node.conn, schema: node.schema, relation: node.relation, constraint }));
          }
          case "triggers": {
            const trgs = await i.triggers(node.relation.oid);
            return trgs.map((trigger) => ({ kind: "trigger" as const, conn: node.conn, schema: node.schema, relation: node.relation, trigger }));
          }
        }
        return [];
      }
      default:
        return [];
    }
  }
}

/** Convenience for action commands: derive the fully-qualified identifier from a tree node. */
export function nodeFullyQualifiedName(node: SchemaNode): string | null {
  switch (node.kind) {
    case "relation":
      return qualifyIdent(node.schema.name, node.relation.name);
    case "sequence":
      return qualifyIdent(node.schema.name, node.sequence.name);
    case "function":
      return qualifyIdent(node.schema.name, node.function.name);
    case "type":
      return qualifyIdent(node.schema.name, node.type.name);
    case "column":
      return `${qualifyIdent(node.schema.name, node.relation.name)}.${quoteIdent(node.column.name)}`;
    case "index":
      return qualifyIdent(node.schema.name, node.index.name);
    case "constraint":
      return node.constraint.name;
    case "trigger":
      return node.trigger.name;
    case "schema":
      return quoteIdent(node.schema.name);
    case "extension":
      return quoteIdent(node.ext.name);
    case "role":
      return quoteIdent(node.role.name);
    default:
      return null;
  }
}
