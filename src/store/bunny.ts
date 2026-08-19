/**
 * Bunny Storage as an ObjectStore.
 *
 * Three operations, and one of them carries the whole ownership model.
 *
 * `delete` must answer "did *my* delete remove this object", not "is it gone now". Single-use
 * tokens, and the proof-of-work claim that closed the mail-bombing hole, both work by racing
 * concurrent deletes and letting exactly one win. There is no compare-and-swap in Bunny
 * Storage, so this is the only mutual exclusion available. An adapter that returned true for
 * an object that was never there would hand every racer a win, and every test would still pass
 * because they run against the in-memory store.
 *
 * Bunny's own documentation does not say what DELETE returns for a missing object. It lists
 * 200 "object was successfully deleted" and 400 "object delete failed", and stops there. That
 * is not something to guess at, so `assertDeleteSemantics` below checks it against the live
 * zone at startup and refuses to serve if the answer is wrong. Better a service that will not
 * boot than one that quietly lets a token be spent twice.
 *
 * Keys are paths inside the zone. Every key this application builds comes from a validated slug
 * or a hex digest, and `encodeKey` refuses anything else, so a traversal cannot be constructed
 * even if some future caller forgets to validate.
 */

import type { ObjectStore } from "./storage.ts";

export interface BunnyConfig {
  /** Storage zone name, which is the first path segment. */
  zone: string;
  /** Zone password, sent as `AccessKey`. Never the account API key. */
  accessKey: string;
  /**
   * Regional endpoint host, for example `storage.bunnycdn.com` or `se.storage.bunnycdn.com`.
   * In config rather than hardcoded because the region is chosen per zone and an EU account
   * may not be on the default host.
   */
  host: string;
}

/**
 * Keys are built from validated slugs and hex digests, never from anything a visitor typed.
 * This is the belt to that braces: a key containing a traversal, a leading slash or a query
 * would otherwise become a URL that addresses somewhere else in the zone.
 */
const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

function encodeKey(key: string): string {
  if (!SAFE_KEY.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error(`refusing to build a storage path from ${JSON.stringify(key)}`);
  }
  return key.split("/").map(encodeURIComponent).join("/");
}

export function createBunnyStore(
  config: BunnyConfig,
  fetchImpl: typeof fetch = fetch,
): ObjectStore {
  const base = `https://${config.host}/${config.zone}`;
  const headers = { AccessKey: config.accessKey };

  return {
    async get(key: string): Promise<string | null> {
      const response = await fetchImpl(`${base}/${encodeKey(key)}`, { headers });

      // A missing object is documented as 404 and is an ordinary answer here, not a fault.
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`storage read failed: ${response.status}`);
      }
      return await response.text();
    },

    async put(key: string, value: string): Promise<void> {
      const response = await fetchImpl(`${base}/${encodeKey(key)}`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: value,
      });
      await response.body?.cancel();

      if (!response.ok) throw new Error(`storage write failed: ${response.status}`);
    },

    /**
     * True only when this call is the one that removed the object.
     *
     * 404 and 400 both mean somebody else got there first, or it never existed. Either way this
     * caller did not win and must not proceed. Anything else is a real fault and is thrown,
     * because treating a 500 as "you lost the race" would silently drop a legitimate claim.
     */
    async delete(key: string): Promise<boolean> {
      const response = await fetchImpl(`${base}/${encodeKey(key)}`, {
        method: "DELETE",
        headers,
      });
      await response.body?.cancel();

      if (response.status === 404 || response.status === 400) return false;
      if (!response.ok) throw new Error(`storage delete failed: ${response.status}`);
      return true;
    },
  };
}

/**
 * A store whose deletes wait for the probe, and whose reads do not.
 *
 * `assertDeleteSemantics` used to be awaited at cold start before the isolate would answer
 * anything, which meant a put and two deletes in front of the first byte of every page,
 * including pages that never delete anything: the landing page, a scan page, a QR, a stylesheet
 * handed to the CDN. That is three network round trips charged to the reader standing in front
 * of a stranger's jacket, for a property their request does not rely on.
 *
 * Deferring it by hand would mean remembering to await the probe in every handler that spends a
 * token, and the cost of forgetting one is a replay hole that no test would catch, because tests
 * run against the memory store where the probe is not the thing keeping them honest. So the wait
 * goes where it cannot be forgotten: on `delete` itself. Delete-as-claim is the only thing the
 * probe guarantees, `consumeToken`, `claimChallenge` and `deleteCode` are the only callers, and
 * all three go through here.
 *
 * A failed probe therefore no longer takes the whole isolate down. Reads keep working and every
 * delete throws, so verification, proof of work and deletion refuse while the pages a stranger
 * scanned still answer. That is a deliberate change from "refuse to serve at all", and it is the
 * better failure: on 2026-08-14 a cold-start failure was a total outage.
 */
export function deleteAfter(store: ObjectStore, probe: Promise<unknown>): ObjectStore {
  return {
    get: (key) => store.get(key),
    put: (key, value) => store.put(key, value),
    async delete(key) {
      // Rejects if the probe rejected, which is what keeps this failing closed.
      await probe;
      return store.delete(key);
    },
  };
}

/**
 * Prove the store really gives single-use semantics, before anything depends on it.
 *
 * Writes a probe object, deletes it twice, and requires the first delete to win and the second
 * to lose. If a missing object were reported as a successful delete, every racer would win and
 * a verification link could be redeemed any number of times. That would be invisible in tests
 * and catastrophic in production, so it is checked against the real thing at startup.
 *
 * The probe key is per-boot so two instances starting together cannot fail each other.
 */
export async function assertDeleteSemantics(
  store: ObjectStore,
  probeKey = `probe/${crypto.randomUUID()}.json`,
): Promise<void> {
  await store.put(probeKey, JSON.stringify({ probe: true }));

  const first = await store.delete(probeKey);
  const second = await store.delete(probeKey);

  if (first !== true) {
    throw new Error(
      `storage delete did not report removing an object that existed. ` +
        `Single-use tokens cannot be made safe on this store.`,
    );
  }
  if (second !== false) {
    throw new Error(
      `storage delete reported success for an object that was already gone. ` +
        `Delete-as-claim is not mutual exclusion here, so single-use tokens and the ` +
        `proof-of-work claim would both silently allow replays. Refusing to start.`,
    );
  }
}
