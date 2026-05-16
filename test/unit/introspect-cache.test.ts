import { describe, expect, it } from "vitest";
import { TtlCache } from "../../src/pg/introspect-cache.js";

function fakeClock() {
  let now = 1000;
  return {
    now: () => now,
    advance: (ms: number) => (now += ms),
  };
}

describe("TtlCache", () => {
  it("returns the cached value within the TTL", async () => {
    const clock = fakeClock();
    const cache = new TtlCache<string, number>(60_000, clock.now);
    let loadCount = 0;
    const load = async () => ++loadCount;
    expect(await cache.getOrLoad("k", load)).toBe(1);
    clock.advance(30_000);
    expect(await cache.getOrLoad("k", load)).toBe(1); // cached
    expect(loadCount).toBe(1);
  });

  it("reloads after the TTL elapses", async () => {
    const clock = fakeClock();
    const cache = new TtlCache<string, number>(60_000, clock.now);
    let n = 0;
    const load = async () => ++n;
    await cache.getOrLoad("k", load);
    clock.advance(60_001);
    expect(await cache.getOrLoad("k", load)).toBe(2);
  });

  it("invalidate(key) forces a reload on next access", async () => {
    const clock = fakeClock();
    const cache = new TtlCache<string, number>(60_000, clock.now);
    let n = 0;
    await cache.getOrLoad("k", async () => ++n);
    cache.invalidate("k");
    await cache.getOrLoad("k", async () => ++n);
    expect(n).toBe(2);
  });

  it("clear() drops every entry", async () => {
    const clock = fakeClock();
    const cache = new TtlCache<string, number>(60_000, clock.now);
    let n = 0;
    await cache.getOrLoad("a", async () => ++n);
    await cache.getOrLoad("b", async () => ++n);
    cache.clear();
    await cache.getOrLoad("a", async () => ++n);
    expect(n).toBe(3);
  });

  it("treats distinct keys independently", async () => {
    const clock = fakeClock();
    const cache = new TtlCache<string, number>(60_000, clock.now);
    let n = 0;
    expect(await cache.getOrLoad("a", async () => ++n)).toBe(1);
    expect(await cache.getOrLoad("b", async () => ++n)).toBe(2);
    expect(await cache.getOrLoad("a", async () => ++n)).toBe(1); // still cached
    expect(n).toBe(2);
  });
});
