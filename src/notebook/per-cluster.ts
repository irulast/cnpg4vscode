/**
 * Per-cluster notebook organization (FR-037).
 *
 * Pure helpers — no `vscode` import — so they're unit-testable. The VS
 * Code-host glue (workspace folder lookup, save command, tree integration)
 * lives in `extension.ts`, `commands/index.ts`, and `ui/tree-clusters.ts`.
 *
 * Path convention: `<workspaceRoot>/<base>/<context>/<namespace>/<cluster>/<name>.cnpg-sql`
 * where `<base>` is the `cnpg4vscode.notebooks.location` setting (default
 * `.cnpg/notebooks`). Context segments may contain `/` or `:` (kubeconfig
 * is permissive), so we URL-encode each path component before joining to
 * guarantee filesystem-safety and prevent traversal.
 */

import * as path from "node:path";

export interface ResolveClusterFolderInput {
  /** Absolute path to the workspace folder, or null when no workspace is open. */
  workspaceRoot: string | null;
  /** `cnpg4vscode.notebooks.location` value (default `.cnpg/notebooks`). */
  base: string;
  contextName: string;
  namespace: string;
  clusterName: string;
}

/**
 * Encode a single path segment for safe filesystem use. URL-encodes the
 * filesystem-significant characters that can legitimately appear in
 * kubeconfig context names (`/`, `:`) plus `.` at the start of the segment
 * so traversal is impossible.
 */
export function encodeClusterSegment(s: string): string {
  // Replace each character that's unsafe for a single segment.
  return s.replace(/[./\\:?*"<>|\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * Resolve the per-cluster notebook folder. Returns null when no workspace is
 * open or when `base` would escape the workspace.
 */
export function resolveClusterFolder(input: ResolveClusterFolderInput): string | null {
  if (input.workspaceRoot === null) return null;

  // Reject an absolute base or one that begins with `..` — base must stay
  // inside the workspace.
  if (path.isAbsolute(input.base)) return null;
  const baseNormalized = path.normalize(input.base);
  if (baseNormalized.startsWith("..") || baseNormalized.split(path.sep).includes("..")) {
    return null;
  }

  const ctx = encodeClusterSegment(input.contextName);
  const ns = encodeClusterSegment(input.namespace);
  const cluster = encodeClusterSegment(input.clusterName);
  const joined = path.posix.join(
    input.workspaceRoot.replace(/\\/g, "/"),
    baseNormalized.replace(/\\/g, "/"),
    ctx,
    ns,
    cluster,
  );
  return joined;
}

/**
 * Validate a user-supplied notebook name. Returns an error message if
 * invalid, else null.
 */
export function validateNotebookName(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "Name is required.";
  if (trimmed.length !== input.length) {
    return "Name must not have leading or trailing whitespace.";
  }
  if (trimmed.startsWith(".")) return "Name must not start with '.' (hidden file).";
  if (trimmed.endsWith(".")) return "Name must not end with '.'.";
  if (/[\\/]/.test(trimmed)) return "Name must not contain path separators.";
  // Windows-reserved characters.
  if (/[:*?"<>|]/.test(trimmed)) {
    return "Name must not contain reserved characters (: * ? \" < > |).";
  }
  return null;
}

/** Ensure the name ends in `.cnpg-sql`. */
export function normalizeNotebookName(name: string): string {
  return name.endsWith(".cnpg-sql") ? name : `${name}.cnpg-sql`;
}
