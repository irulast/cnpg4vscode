/**
 * Time-to-live cache for pg_catalog introspection results (US5; FR-022).
 *
 * Keys are typically `(connectionId, oid)`-derived strings; values are the
 * full result of one catalog query so re-expanding a tree node is instant.
 * Default TTL is 60 seconds (research.md §8); the user can force re-load
 * by invoking the refresh action on the tree.
 *
 * Pure module — injectable clock for tests.
 */

interface CacheEntry<V> {
  expiresAt: number;
  value: V;
}

export class TtlCache<K, V> {
  private readonly map = new Map<K, CacheEntry<V>>();
  private readonly inFlight = new Map<K, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async getOrLoad(key: K, load: () => Promise<V>): Promise<V> {
    const now = this.nowMs();
    const hit = this.map.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    // De-duplicate concurrent loads for the same key.
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const p = (async () => {
      try {
        const v = await load();
        this.map.set(key, { value: v, expiresAt: this.nowMs() + this.ttlMs });
        return v;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, p);
    return p;
  }

  invalidate(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
