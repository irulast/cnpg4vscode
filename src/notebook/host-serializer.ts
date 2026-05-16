/**
 * VS Code-host wrapper for the cnpg-sql notebook serializer. Adapts the
 * pure serialize/deserialize functions in `serializer.ts` to VS Code's
 * `NotebookSerializer` interface.
 */

import * as vscode from "vscode";
import {
  deserializeNotebookBytes,
  serializeNotebookData,
  SerializableCell,
  SerializableNotebook,
} from "./serializer.js";

export class CnpgNotebookSerializer implements vscode.NotebookSerializer {
  async deserializeNotebook(
    content: Uint8Array,
    _token: vscode.CancellationToken,
  ): Promise<vscode.NotebookData> {
    const parsed = deserializeNotebookBytes(content);
    const cells = parsed.cells.map((c) => {
      const cell = new vscode.NotebookCellData(
        c.kind === 1 ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
        c.value,
        c.languageId,
      );
      if (c.metadata) cell.metadata = c.metadata;
      return cell;
    });
    const data = new vscode.NotebookData(cells);
    if (parsed.metadata) data.metadata = parsed.metadata;
    return data;
  }

  async serializeNotebook(
    data: vscode.NotebookData,
    _token: vscode.CancellationToken,
  ): Promise<Uint8Array> {
    const serializable: SerializableNotebook = {
      cells: data.cells.map((c): SerializableCell => {
        const cell: SerializableCell = {
          kind: c.kind === vscode.NotebookCellKind.Markup ? 1 : 2,
          value: c.value,
          languageId: c.languageId,
        };
        if (c.metadata) cell.metadata = c.metadata;
        return cell;
      }),
    };
    if (data.metadata) serializable.metadata = data.metadata;
    return serializeNotebookData(serializable);
  }
}

export const CNPG_NOTEBOOK_TYPE = "cnpg-sql";
