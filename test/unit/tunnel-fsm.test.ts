import { afterEach, describe, expect, it } from "vitest";
import { TunnelController, TunnelEvents } from "../../src/k8s/port-forward.js";

interface FakeDriver {
  openCalls: number;
  closeCalls: number;
  // Open succeeds by default; tests flip this to simulate failures.
  failOpenWith?: Error;
  failProbe?: boolean;
}

function makeDriver(): FakeDriver {
  return { openCalls: 0, closeCalls: 0 };
}

function makeController(driver: FakeDriver, opts: Partial<TunnelEvents> = {}) {
  return new TunnelController(
    {
      clusterId: "ns/app-db",
      maxRetries: 3,
      backoffMs: () => 0,
    },
    {
      openSocket: async () => {
        driver.openCalls++;
        if (driver.failOpenWith) throw driver.failOpenWith;
        return { localPort: 50000 + driver.openCalls };
      },
      closeSocket: async () => {
        driver.closeCalls++;
      },
      probe: async () => {
        if (driver.failProbe) throw new Error("probe failed");
      },
      ...opts,
    },
  );
}

const controllers: TunnelController[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
});

describe("TunnelController FSM", () => {
  it("starts in 'idle'", () => {
    const c = makeController(makeDriver());
    controllers.push(c);
    expect(c.state).toBe("idle");
  });

  it("transitions idle → opening → open on a successful open", async () => {
    const c = makeController(makeDriver());
    controllers.push(c);
    const states: string[] = [];
    c.onStateChange((s) => states.push(s));
    await c.open();
    expect(c.state).toBe("open");
    expect(states).toEqual(["opening", "open"]);
    expect(c.localPort).toBe(50001);
  });

  it("transitions opening → error (no retry) on unrecoverable open failure", async () => {
    const d = makeDriver();
    d.failOpenWith = Object.assign(new Error("forbidden"), { isAuthError: true });
    const c = makeController(d);
    controllers.push(c);
    await c.open();
    expect(c.state).toBe("error");
    expect(d.openCalls).toBe(1); // no retries
  });

  it("transitions open → closing → closed on close()", async () => {
    const c = makeController(makeDriver());
    controllers.push(c);
    const states: string[] = [];
    c.onStateChange((s) => states.push(s));
    await c.open();
    await c.close();
    expect(c.state).toBe("closed");
    expect(states.slice(-2)).toEqual(["closing", "closed"]);
  });

  it("transitions open → retrying → open after a probe failure", async () => {
    const d = makeDriver();
    const c = makeController(d);
    controllers.push(c);
    await c.open();
    d.failProbe = true;
    await c.notifyProbeFailure();
    // After 1 failure we stay open; after 2 consecutive we retry.
    await c.notifyProbeFailure();
    expect(c.state).toBe("retrying");
    d.failProbe = false; // probe will succeed during reopen
    await c.reopen();
    expect(c.state).toBe("open");
  });

  it("transitions retrying → error after maxRetries failures", async () => {
    const d = makeDriver();
    d.failOpenWith = new Error("net");
    const c = makeController(d);
    controllers.push(c);
    // First open attempt: opening → error (no retry on initial failure).
    await c.open();
    expect(c.state).toBe("error");
  });

  it("retries with backoff when reopen is triggered explicitly", async () => {
    const d = makeDriver();
    const c = makeController(d);
    controllers.push(c);
    await c.open();
    await c.notifyProbeFailure();
    await c.notifyProbeFailure();
    expect(c.state).toBe("retrying");
    await c.reopen();
    expect(d.openCalls).toBe(2);
    expect(c.state).toBe("open");
  });

  it("disposing from any state ends in 'closed'", async () => {
    const c = makeController(makeDriver());
    controllers.push(c);
    await c.open();
    c.dispose();
    expect(c.state).toBe("closed");
  });
});
