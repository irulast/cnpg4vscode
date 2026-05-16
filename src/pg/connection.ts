/**
 * pg connection layer (US4; FR-020, FR-021).
 *
 * Builds the libpq-compatible client config from a (host, port, secret,
 * database, CA bundle) tuple. TLS is pinned to the CNPG-issued CA from the
 * `<cluster>-ca` Secret; the server-name check is overridden because the
 * upstream certificate's CN is the in-cluster service name, not the
 * loopback host the tunnel binds to.
 *
 * The read-only gate's server-side layer (research.md §9 layer 2) is set
 * here via the libpq `options` parameter so EVERY connection in readonly
 * mode rejects writes regardless of what code path is sending the SQL.
 */

import type { PoolConfig, Pool, PoolClient } from "pg";
import pg from "pg";

export type ConnectionMode = "readonly" | "write";

export interface ConnectionInput {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** In-cluster service hostname the certificate was issued for. */
  serverName: string;
  /** CA bundle (PEM) from the cluster's `<cluster>-ca` Secret. */
  caBundle: string;
  mode: ConnectionMode;
}

export function buildConnectionConfig(input: ConnectionInput): PoolConfig {
  const options =
    input.mode === "readonly" ? "-c default_transaction_read_only=on" : undefined;

  return {
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password,
    database: input.database,
    options,
    ssl: {
      ca: input.caBundle,
      // Hostname mismatch is expected (cert CN = service name, host = 127.0.0.1).
      // We've already pinned the CA, so accepting the server's identity here
      // is safe.
      checkServerIdentity: (): undefined => undefined,
      servername: input.serverName,
    },
    max: 4,
    idleTimeoutMillis: 30_000,
    application_name: "cnpg4vscode",
  };
}

export interface DatabaseConnectionOpts extends ConnectionInput {
  clusterId: string;
}

/**
 * Thin wrapper around `pg.Pool` that carries the connection mode and the
 * cluster identity. Enforces the read-only server-side guard by wrapping
 * every readonly query in `BEGIN; SET LOCAL transaction_read_only=on; … ; ROLLBACK;`.
 *
 * (`default_transaction_read_only=on` in the connection options is the
 * baseline; SET LOCAL inside an explicit transaction provides the second
 * server-side gate the spec requires.)
 */
export class DatabaseConnection {
  private readonly pool: Pool;
  private _mode: ConnectionMode;

  constructor(public readonly opts: DatabaseConnectionOpts) {
    const config = buildConnectionConfig(opts);
    this.pool = new pg.Pool(config);
    this._mode = opts.mode;
  }

  get mode(): ConnectionMode {
    return this._mode;
  }

  /** Toggle write mode at runtime. Never persisted (FR-020). */
  setMode(mode: ConnectionMode): void {
    this._mode = mode;
  }

  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<pg.QueryResult> {
    const client = await this.pool.connect();
    try {
      if (this._mode === "readonly") {
        await client.query("BEGIN");
        await client.query("SET LOCAL transaction_read_only = on");
        try {
          const result = await client.query(sql, params as unknown[]);
          return result;
        } finally {
          // Never COMMIT — even if the statement succeeded the wrapping
          // transaction is rolled back to undo any session-scoped state.
          await client.query("ROLLBACK").catch(() => {});
        }
      }
      return await client.query(sql, params as unknown[]);
    } finally {
      client.release();
    }
  }

  /**
   * Borrow a single client from the pool and pass it to `cb`. The
   * client is released back to the pool on return (success or throw).
   * Use this when a single logical operation needs multiple
   * `query()` calls to land on the same backend session — e.g. an
   * explicit BEGIN/COMMIT-managed migration where the wrap and the
   * statements MUST share a session, which `query()` cannot guarantee
   * because it acquires a fresh client per call.
   *
   * The cb sees the raw `pg.PoolClient` so it can speak the full
   * protocol; the read-only `SET LOCAL` gate is NOT auto-applied here
   * (the caller is expected to manage its own transaction discipline).
   */
  async withClient<T>(cb: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await cb(client);
    } finally {
      client.release();
    }
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}
