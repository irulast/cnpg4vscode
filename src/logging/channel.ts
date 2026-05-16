/**
 * Single LogOutputChannel for the extension (Constitution §IV).
 *
 * Every log line passes through redact() before reaching VS Code; the channel
 * is never written to directly from other modules — all callers must use the
 * helpers below.
 *
 * Format: human-readable KV pairs (research.md §13). Values are stringified
 * with quotes around any value containing whitespace.
 */

import * as vscode from "vscode";
import { redact } from "../pg/redact.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

let channel: vscode.LogOutputChannel | null = null;

/**
 * Bounded ring buffer of the most recent log lines. Used by
 * `cnpg.reportProblem` to surface a copyable diagnostic snapshot. Each
 * entry stores the already-redacted line so we never re-leak credentials.
 * Capacity matches the constitution's "200 lines" reference.
 */
const RECENT_BUFFER_CAP = 200;
const recentBuffer: Array<{ ts: number; level: LogLevel; line: string }> = [];

export function initLog(): vscode.LogOutputChannel {
  if (channel) return channel;
  channel = vscode.window.createOutputChannel("cnpg4vscode", { log: true });
  return channel;
}

export function disposeLog(): void {
  channel?.dispose();
  channel = null;
  recentBuffer.length = 0;
}

/** Snapshot the buffer for the report-problem command. Returns redacted lines. */
export function snapshotRecentLog(): ReadonlyArray<{ ts: number; level: LogLevel; line: string }> {
  return recentBuffer.slice();
}

function fmtValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") {
    return /\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function fmtLine(event: string, fields: Record<string, unknown>): string {
  const parts = [`event=${event}`];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${k}=${fmtValue(v)}`);
  }
  return redact(parts.join(" "));
}

function write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  const ch = channel;
  if (!ch) return; // Pre-activation logging is silently dropped.
  const line = fmtLine(event, fields);
  // Record into the bounded recent-buffer for the report-problem command.
  recentBuffer.push({ ts: Date.now(), level, line });
  if (recentBuffer.length > RECENT_BUFFER_CAP) recentBuffer.shift();
  switch (level) {
    case "trace":
      ch.trace(line);
      return;
    case "debug":
      ch.debug(line);
      return;
    case "info":
      ch.info(line);
      return;
    case "warn":
      ch.warn(line);
      return;
    case "error":
      ch.error(line);
      return;
  }
}

export const log = {
  trace: (event: string, fields: Record<string, unknown> = {}) => write("trace", event, fields),
  debug: (event: string, fields: Record<string, unknown> = {}) => write("debug", event, fields),
  info: (event: string, fields: Record<string, unknown> = {}) => write("info", event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => write("warn", event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => write("error", event, fields),
};
