/**
 * Active-connection status-bar item (contracts/commands.md § Status-bar items).
 *
 * The item is hidden until a connection is bound to the active editor.
 * Filled in further by US4.
 */

import * as vscode from "vscode";

let item: vscode.StatusBarItem | null = null;

export function initStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
  item = vscode.window.createStatusBarItem("cnpg.activeConnection", vscode.StatusBarAlignment.Right, 100);
  item.name = "CNPG Active Connection";
  item.command = "cnpg.connection.actions";
  context.subscriptions.push(item);
  return item;
}

export function setStatusBar(text: string | null, options: { writeMode?: boolean; tooltip?: string } = {}): void {
  if (!item) return;
  if (text === null) {
    item.hide();
    return;
  }
  item.text = text;
  item.tooltip = options.tooltip ?? text;
  item.backgroundColor = options.writeMode
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
  item.show();
}
