/**
 * Typed-name destructive-confirmation modal (US5; FR-024, SC-009).
 *
 * Opens a `window.showInputBox` whose OK button is disabled until the user
 * types the exact fully-qualified target name. Bypass setting
 * `cnpg4vscode.confirmation.requireTypedName=false` still requires a
 * yes/no modal AND logs a WARN line on every destructive action
 * (contracts/settings.md § Validation).
 */

import * as vscode from "vscode";
import { validateTypedName } from "./confirm-validate.js";
import { log } from "../logging/channel.js";

export interface ConfirmOpts {
  operation: string;
  target: string;
  requireTypedName: boolean;
}

export async function confirmDestructive(opts: ConfirmOpts): Promise<boolean> {
  if (!opts.requireTypedName) {
    const choice = await vscode.window.showWarningMessage(
      `Confirm ${opts.operation} on ${opts.target}?`,
      { modal: true },
      "Yes, proceed",
    );
    if (choice === "Yes, proceed") {
      log.warn("confirm.bypassed.typedName", {
        operation: opts.operation,
        target: opts.target,
      });
      return true;
    }
    return false;
  }

  const typed = await vscode.window.showInputBox({
    title: `Confirm ${opts.operation}`,
    prompt: `Type the fully-qualified target name (${opts.target}) to proceed.`,
    placeHolder: opts.target,
    ignoreFocusOut: true,
    validateInput: (value) => validateTypedName(value, opts.target) ?? "",
  });
  return typed === opts.target;
}
