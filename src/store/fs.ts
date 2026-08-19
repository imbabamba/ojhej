/**
 * Filesystem-backed ObjectStore, for local development only.
 *
 * Stands in for Bunny Edge Storage so the service can be run and driven without cloud
 * credentials. Deliberately mirrors the two behaviours the real adapter must also have:
 * a missing object reads as null, and `delete` reports whether it actually removed
 * something (see R1 in status.md, which is what makes single-use tokens single-use).
 */

import type { ObjectStore } from "./storage.ts";

export function createFsStore(root: string): ObjectStore {
  const pathFor = (key: string) => `${root}/${key}`;

  return {
    async get(key) {
      try {
        return await Deno.readTextFile(pathFor(key));
      } catch (cause) {
        if (cause instanceof Deno.errors.NotFound) return null;
        throw cause;
      }
    },

    async put(key, value) {
      const path = pathFor(key);
      const dir = path.slice(0, path.lastIndexOf("/"));
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(path, value);
    },

    async delete(key) {
      try {
        await Deno.remove(pathFor(key));
        return true;
      } catch (cause) {
        // Already gone is false, not an error. The real Bunny adapter must map 404 the
        // same way, or concurrent token redemption silently stops being single-use.
        if (cause instanceof Deno.errors.NotFound) return false;
        throw cause;
      }
    },
  };
}
