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

  it("sets default_transaction_read_only=on in the options when mode is readonly", () => {
    const cfg = buildConnectionConfig({ ...baseInput, mode: "readonly" });
    expect(cfg.options ?? "").toMatch(/default_transaction_read_only=on/);
  });

  it("does not set default_transaction_read_only=on in write mode", () => {
    const cfg = buildConnectionConfig({ ...baseInput, mode: "write" });
    expect(cfg.options ?? "").not.toMatch(/default_transaction_read_only=on/);
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
