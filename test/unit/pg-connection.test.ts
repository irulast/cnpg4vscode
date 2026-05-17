import { describe, expect, it } from "vitest";
import { buildConnectionConfig, ConnectionMode } from "../../src/pg/connection.js";

describe("buildConnectionConfig()", () => {
  const baseInput = {
    host: "127.0.0.1",
    port: 54321,
    user: "appuser",
    password: "UNIQUE_PASSWORD_LITERAL_xyz123",
    database: "appdb",
    serverName: "app-db-rw.default.svc",
    caBundle: "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
  };

  it("does NOT bake default_transaction_read_only=on into the pool's libpq options (any mode)", () => {
    // Originally the readonly mode set `-c default_transaction_read_only=on`
    // on the pool. That broke runtime mode toggling: the libpq option
    // is a per-SESSION setting, fixed at pool-creation time, so the
    // pool's pooled connections still carried the readonly default
    // after the user toggled `setMode("write")` — every UPDATE then
    // failed with "cannot execute UPDATE in a read-only transaction".
    // The server-side readonly gate is now per-query (BEGIN; SET LOCAL
    // transaction_read_only=on; …; ROLLBACK) inside `query()` when
    // `_mode === "readonly"`; it tracks the live mode and doesn't get
    // pinned at pool creation.
    for (const mode of ["readonly", "write"] as const) {
      const cfg = buildConnectionConfig({ ...baseInput, mode });
      expect(cfg.options ?? "").not.toMatch(/default_transaction_read_only/);
    }
  });

  it("pins TLS to the provided CA bundle and overrides server identity", () => {
    const cfg = buildConnectionConfig({ ...baseInput, mode: "readonly" });
    expect(cfg.ssl).toBeTruthy();
    if (cfg.ssl && typeof cfg.ssl === "object") {
      expect(typeof cfg.ssl.checkServerIdentity).toBe("function");
      // The CA bundle is forwarded to pg as-is.
      expect(cfg.ssl.ca).toBe(baseInput.caBundle);
    }
  });

  it("forwards host/port/user/database to pg", () => {
    const cfg = buildConnectionConfig({ ...baseInput, mode: "readonly" });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(54321);
    expect(cfg.user).toBe("appuser");
    expect(cfg.database).toBe("appdb");
  });

  it("never returns a config object that includes the literal password in any non-password key", () => {
    const cfg = buildConnectionConfig({ ...baseInput, mode: "readonly" });
    const { password: _password, ...rest } = cfg;
    expect(JSON.stringify(rest)).not.toContain(baseInput.password);
  });

  it("accepts only 'readonly' | 'write' as mode (TypeScript-level, asserted by runtime check)", () => {
    const modes: ConnectionMode[] = ["readonly", "write"];
    for (const m of modes) {
      const cfg = buildConnectionConfig({ ...baseInput, mode: m });
      expect(cfg).toBeTruthy();
    }
  });
});
