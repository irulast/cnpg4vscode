/**
 * Read-side configuration helpers for `cnpg4vscode.*` settings.
 *
 * Runtime invariant: `cnpg4vscode.connection.defaultMode` is forced to
 * 'readonly' regardless of user input (FR-020). Any other value emits a
 * warning that the caller logs through the LogOutputChannel.
 */

export type ConnectionMode = "readonly" | "write";

export interface ValidatedSetting<T> {
  value: T;
  /** Non-null when the user-supplied value was overridden. */
  warning: string | null;
}

export function validateConnectionMode(input: string | undefined): ValidatedSetting<ConnectionMode> {
  if (input === "readonly") return { value: "readonly", warning: null };
  return {
    value: "readonly",
    warning:
      `cnpg4vscode.connection.defaultMode='${String(input)}' is not permitted; ` +
      `forced to 'readonly' per FR-020 (connections always open read-only).`,
  };
}

export interface ResolvedConfig {
  logLevel: string;
  refreshIntervalSeconds: number;
  tunnelMaxRetries: number;
  tunnelProbeIntervalSeconds: number;
  defaultMode: ConnectionMode;
  defaultDatabase: string;
  pageSize: number;
  maxInMemoryRows: number;
  historyEnabled: boolean;
  historyRetentionDays: number;
  historyMaxEntries: number;
  extraRedactionPatterns: string[];
  requireTypedName: boolean;
  erWarnOverTables: number;
  erLayout: string;
  honorEditorFont: boolean;
}

interface ReadableConfig {
  get<T>(section: string): T | undefined;
}

export function resolveConfig(c: ReadableConfig): {
  resolved: ResolvedConfig;
  warnings: string[];
} {
  const warnings: string[] = [];

  const modeResult = validateConnectionMode(c.get<string>("connection.defaultMode"));
  if (modeResult.warning) warnings.push(modeResult.warning);

  const resolved: ResolvedConfig = {
    logLevel: c.get<string>("log.level") ?? "info",
    refreshIntervalSeconds: c.get<number>("refreshIntervalSeconds") ?? 30,
    tunnelMaxRetries: c.get<number>("tunnel.maxRetries") ?? 5,
    tunnelProbeIntervalSeconds: c.get<number>("tunnel.probeIntervalSeconds") ?? 30,
    defaultMode: modeResult.value,
    defaultDatabase: c.get<string>("connection.defaultDatabase") ?? "",
    pageSize: c.get<number>("results.pageSize") ?? 1000,
    maxInMemoryRows: c.get<number>("results.maxInMemoryRows") ?? 10000,
    historyEnabled: c.get<boolean>("history.enabled") ?? true,
    historyRetentionDays: c.get<number>("history.retentionDays") ?? 90,
    historyMaxEntries: c.get<number>("history.maxEntries") ?? 100000,
    extraRedactionPatterns: c.get<string[]>("redaction.extraPatterns") ?? [],
    requireTypedName: c.get<boolean>("confirmation.requireTypedName") ?? true,
    erWarnOverTables: c.get<number>("er.warnOverTables") ?? 100,
    erLayout: c.get<string>("er.layout") ?? "layered",
    honorEditorFont: c.get<boolean>("theme.honorEditorFont") ?? true,
  };

  return { resolved, warnings };
}
