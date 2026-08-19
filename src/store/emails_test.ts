import { assert, assertEquals } from "@std/assert";
import { sha256Hex } from "./crypto.ts";
import { createMemoryStore } from "./storage.ts";
import {
  claimSignupSlot,
  codesForEmail,
  codesForEmailHash,
  emailHash,
  linkCodeToEmail,
  MAX_CODES_PER_EMAIL,
  MAX_SIGNUPS_PER_DAY,
  unlinkCodeFromEmail,
} from "./emails.ts";

const T0 = Date.parse("2026-08-12T10:00:00Z");
const SLUG = "K7M4NPQR8TVWXYZ2ABCD";
const OTHER = "ZZ11223344556677889A";
const ADDRESS = "anders@exempel.se";
const DAY = 86_400_000;

Deno.test("the first signup for an address is allowed", async () => {
  const { store } = createMemoryStore();
  assertEquals(await claimSignupSlot(store, "anders@exempel.se", T0), { allowed: true, used: 1 });
});

Deno.test("the daily cap is enforced per address", async () => {
  const { store } = createMemoryStore();

  for (let i = 1; i <= MAX_SIGNUPS_PER_DAY; i++) {
    const result = await claimSignupSlot(store, "anders@exempel.se", T0);
    assertEquals(result, { allowed: true, used: i }, `signup ${i} should be allowed`);
  }

  const overflow = await claimSignupSlot(store, "anders@exempel.se", T0);
  assertEquals(overflow.allowed, false, "one past the cap must be refused");
});

Deno.test("a refused attempt does not inflate the counter further", async () => {
  const { store } = createMemoryStore();
  for (let i = 0; i < MAX_SIGNUPS_PER_DAY + 5; i++) {
    await claimSignupSlot(store, "anders@exempel.se", T0);
  }
  const result = await claimSignupSlot(store, "anders@exempel.se", T0);
  assertEquals(result.used, MAX_SIGNUPS_PER_DAY, "the count stops at the cap");
});

Deno.test("the cap resets the next day", async () => {
  const { store } = createMemoryStore();
  for (let i = 0; i < MAX_SIGNUPS_PER_DAY; i++) {
    await claimSignupSlot(store, "anders@exempel.se", T0);
  }
  assertEquals((await claimSignupSlot(store, "anders@exempel.se", T0)).allowed, false);

  const tomorrow = await claimSignupSlot(store, "anders@exempel.se", T0 + DAY);
  assertEquals(tomorrow, { allowed: true, used: 1 });
});

Deno.test("addresses are counted independently", async () => {
  const { store } = createMemoryStore();
  for (let i = 0; i < MAX_SIGNUPS_PER_DAY; i++) {
    await claimSignupSlot(store, "anders@exempel.se", T0);
  }

  assertEquals((await claimSignupSlot(store, "anders@exempel.se", T0)).allowed, false);
  assertEquals((await claimSignupSlot(store, "elin@exempel.se", T0)).allowed, true);
});

/**
 * The counter has to key on the address, but the address is the one piece of personal data
 * this service holds. Hashing means the bucket works without the store ever seeing it.
 */
Deno.test("the address never appears in the store, in any form", async () => {
  const { store, keys } = createMemoryStore();
  await claimSignupSlot(store, "anders@exempel.se", T0);

  const written = keys();
  assertEquals(written.length, 1);
  assert(!written[0]!.includes("anders"), "not in the key");
  assert(!written[0]!.includes("exempel"), "not even the domain");
  assert(/^emails\/[0-9a-f]{64}\.json$/.test(written[0]!), `unexpected key ${written[0]}`);

  const raw = await store.get(written[0]!);
  assert(raw && !raw.includes("anders") && !raw.includes("@"), "nor in the value");
});

Deno.test("case and surrounding space land in the same bucket", async () => {
  const { store, keys } = createMemoryStore();
  await claimSignupSlot(store, "anders@exempel.se", T0);
  const second = await claimSignupSlot(store, "  Anders@Exempel.SE  ", T0);

  assertEquals(second.used, 2, "the same person must not get a fresh allowance by shouting");
  assertEquals(keys().length, 1);
});

/**
 * When an address changes, the code has to leave the old index or the previous owner keeps a
 * way to ask for management links to a code that is no longer theirs.
 */
Deno.test("a code can be moved from one address to another", async () => {
  const { store } = createMemoryStore();

  await linkCodeToEmail(store, "gammal@exempel.se", SLUG);
  await linkCodeToEmail(store, "gammal@exempel.se", OTHER);

  await unlinkCodeFromEmail(store, "gammal@exempel.se", SLUG);
  await linkCodeToEmail(store, "ny@exempel.se", SLUG);

  assertEquals(await codesForEmail(store, "gammal@exempel.se"), [OTHER], "only the moved one left");
  assertEquals(await codesForEmail(store, "ny@exempel.se"), [SLUG]);
});

Deno.test("unlinking is forgiving about codes and addresses it has never seen", async () => {
  const { store } = createMemoryStore();
  await linkCodeToEmail(store, "gammal@exempel.se", SLUG);

  await unlinkCodeFromEmail(store, "gammal@exempel.se", OTHER);
  await unlinkCodeFromEmail(store, "okand@exempel.se", SLUG);

  assertEquals(await codesForEmail(store, "gammal@exempel.se"), [SLUG], "nothing was disturbed");
});

/* ---------- the index is storage, and storage is not trusted ---------- */

/**
 * 2026-08-14, from production. `shirts.ts` states the rule and keeps it in `parseRecord`:
 * stored content is not trusted, and a corrupt object reads as absent rather than throwing, so
 * one bad object cannot take down the request that finds it. This file read the same untrusted
 * storage and checked only that `slugs` was an array.
 *
 * One malformed entry therefore reached `keyFor` through `manage.ts:87` and threw "refusing to
 * build a storage key from an invalid slug". Asking for a management link answered 500, and it
 * kept answering 500, because the bad object is read again on every attempt. The owner locked
 * out of their own controls permanently, by one entry nobody validated.
 */
Deno.test("a poisoned index yields only the entries that are really slugs", async () => {
  const { store } = createMemoryStore();
  await store.put(
    `emails/${await sha256Hex(ADDRESS)}.json`,
    JSON.stringify({
      day: 0,
      count: 0,
      slugs: [SLUG, "", "not-a-slug", null, 42, SLUG.toLowerCase(), `shirts/${SLUG}.json`, OTHER],
    }),
  );

  assertEquals(await codesForEmail(store, ADDRESS), [SLUG, OTHER]);
});

Deno.test("a slugs field that is not a list reads as no codes rather than throwing", async () => {
  const { store } = createMemoryStore();
  await store.put(
    `emails/${await sha256Hex(ADDRESS)}.json`,
    JSON.stringify({ day: 0, count: 0, slugs: SLUG }),
  );

  assertEquals(await codesForEmail(store, ADDRESS), []);
});

/** The signup counter must survive, or unlinking would hand back a fresh daily allowance. */
Deno.test("unlinking does not reset the daily signup count", async () => {
  const { store } = createMemoryStore();
  await claimSignupSlot(store, "gammal@exempel.se", T0);
  await linkCodeToEmail(store, "gammal@exempel.se", SLUG);

  await unlinkCodeFromEmail(store, "gammal@exempel.se", SLUG);

  const next = await claimSignupSlot(store, "gammal@exempel.se", T0);
  assertEquals(next.used, 2, "the count carried on rather than starting over");
});

/* ---------- reading the index by hash, for a token that carries one ---------- */

/**
 * A `koder` token carries the SHA-256 of the address rather than the address, so the page behind
 * it has a hash and needs the codes. These two have to agree exactly, or a manage link would
 * open on an empty list while the owner's codes sat one key away.
 */
Deno.test("the hash a token carries is the key the index already uses", async () => {
  const { store } = createMemoryStore();
  await linkCodeToEmail(store, ADDRESS, SLUG);

  assertEquals(await emailHash(ADDRESS), await sha256Hex(ADDRESS));
  assertEquals(await codesForEmailHash(store, await emailHash(ADDRESS)), [SLUG]);
  assertEquals(
    await codesForEmailHash(store, await emailHash(ADDRESS)),
    await codesForEmail(store, ADDRESS),
    "both ways in must answer the same",
  );
});

Deno.test("shouting or padding an address does not change its hash", async () => {
  assertEquals(await emailHash("  ANDERS@Exempel.SE  "), await emailHash(ADDRESS));
});

Deno.test("an address nobody has ever used has no codes and no object", async () => {
  const { store, size } = createMemoryStore();
  assertEquals(await codesForEmailHash(store, await emailHash(ADDRESS)), []);
  assertEquals(size(), 0, "reading must not create the index it failed to find");
});

Deno.test("a garbled entry is dropped by hash exactly as it is by address", async () => {
  const { store } = createMemoryStore();
  await store.put(
    `emails/${await sha256Hex(ADDRESS)}.json`,
    JSON.stringify({ day: 0, count: 0, slugs: [SLUG, "../../etc", null, OTHER] }),
  );

  assertEquals(await codesForEmailHash(store, await emailHash(ADDRESS)), [SLUG, OTHER]);
});

Deno.test("a hash that is not a hash reads as no codes rather than building a key", async () => {
  const { store } = createMemoryStore();
  await linkCodeToEmail(store, ADDRESS, SLUG);

  for (const hostile of ["", "../../shirts/K7M4NPQR8TVWXYZ2ABCD", "abc", "Z".repeat(64)]) {
    assertEquals(await codesForEmailHash(store, hostile), [], `should refuse ${hostile}`);
  }
});

/** Ten is what the manage page counts down from, and it has to mean the same thing everywhere. */
Deno.test("an address may own ten codes", () => {
  assertEquals(MAX_CODES_PER_EMAIL, 10);
  assert(MAX_CODES_PER_EMAIL > MAX_SIGNUPS_PER_DAY, "the daily cap is the tighter of the two");
});
