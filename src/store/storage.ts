/**
 * The object store behind everything, and the narrowest interface that does the job.
 *
 * Note what is missing: there is no `list`. Bunny's Storage API offers one, and it is the
 * single operation that could turn a bug into a cross-tenant leak, because a listing is the
 * only way to reach a record you were not already asking for by name. Leaving it off the
 * interface means no handler can call it by accident, and no future refactor can quietly
 * add a code path that walks other people's records. The isolation tests lean on this.
 *
 * Keys are always derived from validated input. See crypto.isValidSlug.
 */
export interface ObjectStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  /**
   * Returns whether this call is the one that removed the object.
   *
   * This return value is load-bearing, not a convenience. There is no compare-and-swap in
   * this stack, so a get-then-delete pair cannot be made atomic: two concurrent redemptions
   * of one single-use token can both see it present. Letting the *delete* decide the winner
   * closes that race with no new primitive, because an object store serialises deletes on a
   * single key even when it exposes no conditional write. See tokens.consumeToken.
   *
   * A Bunny-backed implementation must map "already gone" to false, not to a thrown error and
   * not to true. `createBunnyStore` maps both 404 and Bunny's documented 400 that way.
   *
   * Bunny does not document what DELETE returns for an object that is not there, and it cannot
   * be settled from the docs, so it is not assumed: `assertDeleteSemantics` proves it against
   * the live zone at cold start and refuses to serve if the answer is wrong. Every test here
   * runs against the memory store, so this is the one property tests can never confirm.
   */
  delete(key: string): Promise<boolean>;
}

/**
 * Inspection for tests, deliberately kept *beside* the store rather than on it.
 *
 * An earlier version put `keys()` on the memory store itself. The isolation test caught
 * that: the object handed to production code then carried an enumeration method at
 * runtime, even though the interface hid it, which is exactly the shape of thing that
 * later gets reached for. Now the `store` handed out has nothing but get, put and delete.
 */
export interface MemoryStoreHandle {
  readonly store: ObjectStore;
  keys(): string[];
  size(): number;
}

/** In-memory store for tests. Never used at the edge. */
export function createMemoryStore(): MemoryStoreHandle {
  const objects = new Map<string, string>();

  const store: ObjectStore = {
    get(key) {
      return Promise.resolve(objects.get(key) ?? null);
    },
    put(key, value) {
      objects.set(key, value);
      return Promise.resolve();
    },
    delete(key) {
      // Map.delete already reports whether anything was removed. Returning it is what
      // gives consumeToken a real single-use guarantee.
      return Promise.resolve(objects.delete(key));
    },
  };

  return {
    store,
    keys: () => [...objects.keys()].sort(),
    size: () => objects.size,
  };
}
