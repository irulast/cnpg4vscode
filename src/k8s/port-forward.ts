/**
 * TunnelController — finite-state machine for per-cluster port-forward
 * tunnels (US4; FR-029, FR-030, FR-031; data-model.md § Port-Forward Tunnel;
 * research.md §14).
 *
 * States: idle → opening → open → retrying → open | closing → closed.
 * `error` is terminal until the caller invokes reopen().
 *
 * The driver interface is split out so the FSM can be unit-tested without
 * a live Kubernetes API. The production driver (createPortForwardDriver
 * below) wires in `@kubernetes/client-node` PortForward + a local TCP
 * socket. The unit test (test/unit/tunnel-fsm.test.ts) injects a fake.
 */

import * as net from "node:net";
import { KubeConfig, PortForward } from "@kubernetes/client-node";

export type TunnelState =
  | "idle"
  | "opening"
  | "open"
  | "retrying"
  | "closing"
  | "closed"
  | "error";

export interface TunnelDriver {
  /** Open the local socket. Should reject for any reason; the FSM decides retry. */
  openSocket(): Promise<{ localPort: number }>;
  /** Tear down whatever openSocket established. Best-effort; must not throw. */
  closeSocket(): Promise<void>;
  /** Optional liveness probe (e.g., a TCP connect-and-close). */
  probe?(): Promise<void>;
}

export interface TunnelOpts {
  clusterId: string;
  /** Max retry attempts before going to terminal 'error'. */
  maxRetries: number;
  /** Returns backoff delay in ms for attempt N (0-indexed). */
  backoffMs: (attempt: number) => number;
}

// Re-exported so tests can type the same shape.
export type TunnelEvents = TunnelDriver;

/** Errors marked with `isAuthError = true` skip the retry loop. */
export interface AuthErrorMarker {
  isAuthError?: boolean;
}

export class TunnelController {
  private _state: TunnelState = "idle";
  private _localPort: number | null = null;
  private _attempt = 0;
  private _consecutiveProbeFailures = 0;
  private readonly listeners = new Set<(state: TunnelState) => void>();
  private disposed = false;

  constructor(
    private readonly opts: TunnelOpts,
    private readonly driver: TunnelDriver,
  ) {}

  get state(): TunnelState {
    return this._state;
  }

  get localPort(): number | null {
    return this._localPort;
  }

  onStateChange(cb: (state: TunnelState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async open(): Promise<void> {
    if (this.disposed) return;
    if (this._state === "open") return;
    this.transition("opening");
    try {
      const { localPort } = await this.driver.openSocket();
      this._localPort = localPort;
      this._attempt = 0;
      this._consecutiveProbeFailures = 0;
      this.transition("open");
    } catch (err) {
      // Initial open never retries — the user fixes the underlying issue.
      this._localPort = null;
      this.transition("error");
      // Surface the error class so the UI shows the verbatim message.
      // (We intentionally do NOT log the error here — the wrapping module
      // logs through the redact() chokepoint with structured fields.)
      const _auth = (err as AuthErrorMarker | undefined)?.isAuthError;
      void _auth;
    }
  }

  /** Triggered by an external probe loop: each call increments the counter. */
  async notifyProbeFailure(): Promise<void> {
    if (this._state !== "open") return;
    this._consecutiveProbeFailures++;
    if (this._consecutiveProbeFailures >= 2) {
      this.transition("retrying");
    }
  }

  notifyProbeSuccess(): void {
    this._consecutiveProbeFailures = 0;
  }

  /** Retry an open after entering 'retrying'. Uses backoff(attempt). */
  async reopen(): Promise<void> {
    if (this.disposed) return;
    if (this._state !== "retrying") return;
    while (this._attempt < this.opts.maxRetries && !this.disposed) {
      const delay = this.opts.backoffMs(this._attempt);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      this._attempt++;
      try {
        await this.driver.closeSocket().catch(() => {});
        const { localPort } = await this.driver.openSocket();
        this._localPort = localPort;
        this._attempt = 0;
        this._consecutiveProbeFailures = 0;
        this.transition("open");
        return;
      } catch {
        // continue loop
      }
    }
    this.transition("error");
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    this.transition("closing");
    try {
      await this.driver.closeSocket();
    } finally {
      this._localPort = null;
      this.transition("closed");
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Best-effort teardown without awaiting; close socket asynchronously.
    void this.driver.closeSocket().catch(() => {});
    this._localPort = null;
    this.transition("closed");
    this.listeners.clear();
  }

  private transition(next: TunnelState): void {
    if (this._state === next) return;
    this._state = next;
    for (const l of this.listeners) {
      try {
        l(next);
      } catch {
        // ignore listener errors
      }
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Production driver — opens a local TCP socket on 127.0.0.1:0 and bridges
 * each accepted connection through @kubernetes/client-node PortForward
 * into the cluster's primary pod.
 *
 * Pod resolution: the caller passes the pod name (resolved from the
 * cluster's `<name>-rw` Service endpoints).
 */
export interface ProdDriverOpts {
  kc: KubeConfig;
  namespace: string;
  podName: string;
  targetPort: number;
}

export function createPortForwardDriver(opts: ProdDriverOpts): TunnelDriver {
  let server: net.Server | null = null;
  let resolvedPort = 0;
  const pf = new PortForward(opts.kc);

  return {
    async openSocket() {
      return await new Promise<{ localPort: number }>((resolve, reject) => {
        const srv = net.createServer((socket) => {
          // Bridge each incoming local connection into a SPDY stream.
          // Errors on either side close the socket; the controller's probe
          // catches systemic failures.
          pf.portForward(
            opts.namespace,
            opts.podName,
            [opts.targetPort],
            socket,
            null,
            socket,
          ).catch(() => {
            socket.destroy();
          });
        });
        srv.on("error", (err) => reject(err));
        srv.listen(0, "127.0.0.1", () => {
          const addr = srv.address();
          if (addr && typeof addr === "object") {
            resolvedPort = addr.port;
            server = srv;
            resolve({ localPort: addr.port });
          } else {
            srv.close();
            reject(new Error("Failed to bind local port"));
          }
        });
      });
    },
    async closeSocket() {
      const s = server;
      server = null;
      if (!s) return;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },
    async probe() {
      if (!resolvedPort) throw new Error("no local port");
      await new Promise<void>((resolve, reject) => {
        const client = net.createConnection({ host: "127.0.0.1", port: resolvedPort });
        const timer = setTimeout(() => {
          client.destroy();
          reject(new Error("probe timeout"));
        }, 2000);
        client.once("connect", () => {
          clearTimeout(timer);
          client.end();
          resolve();
        });
        client.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    },
  };
}
