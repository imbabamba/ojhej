import { assert, assertEquals, assertRejects } from "@std/assert";
import { createMemoryStore, type ObjectStore } from "./storage.ts";
import { hashToken } from "./crypto.ts";
import {
  CHANGE_TTL_MS,
  consumeToken,
  KODER_TTL_MS,
  MANAGE_TTL_MS,
  mintEmailToken,
  mintToken,
  peekToken,
  type TokenClaim,
  VERIFY_TTL_MS,
} from "./tokens.ts";

const SLUG = "K7M4NPQR8TVWXYZ2ABCD";
const OTHER = "ZZ11223344556677889A";
/** A SHA-256 of an address, which is exactly what the email index is keyed on. */
const EPOST = "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8";
const ANNAN_EPOST = "6b3a55e0261b0304143f805a24924d0c1c44524821305f31d9277843b8a10f4e";
const T0 = Date.parse("2026-08-12T10:00:00Z");

/** The claim is a union on purpose, so a test that wants a slug has to say so out loud. */
function slugOf(claim: TokenClaim | null): string | null {
  return claim !== null && "slug" in claim ? claim.slug : null;
}

Deno.test("mintToken returns a token and stores only its hash", async () => {
  const { store, keys } = createMemoryStore();
  const { token } = await mintToken(store, SLUG, "manage", T0);

  assert(token.length >= 43, "should be a 256-bit token");
  const written = keys();
  assertEquals(written.length, 1);
  assert(!written[0]!.includes(token), "the raw token must never appear in a key");

  const raw = await store.get(written[0]!);
  assert(raw && !raw.includes(token), "nor in the stored value");
});

Deno.test("consumeToken returns the slug and purpose it was minted for", async () => {
  const { store } = createMemoryStore();
  const { token } = await mintToken(store, SLUG, "verify", T0);

  const claim = await consumeToken(store, token, T0 + 1000);
  assertEquals(claim, { slug: SLUG, purpose: "verify" });
});

Deno.test("a token works exactly once", async () => {
  const { store, size } = createMemoryStore();
  const { token } = await mintToken(store, SLUG, "manage", T0);

  assert(await consumeToken(store, token, T0 + 1000), "first use should succeed");
  assertEquals(await consumeToken(store, token, T0 + 2000), null, "second use must fail");
  assertEquals(size(), 0, "a consumed token leaves nothing behind");
});

Deno.test("manage tokens expire in 30 minutes", async () => {
  const { store } = createMemoryStore();
  const { token } = await mintToken(store, SLUG, "manage", T0);

  assertEquals(MANAGE_TTL_MS, 30 * 60_000);
  assertEquals(await consumeToken(store, token, T0 + MANAGE_TTL_MS + 1), null);
});

Deno.test("verification tokens last a week", async () => {
  const { store } = createMemoryStore();
  const { token } = await mintToken(store, SLUG, "verify", T0);

  assertEquals(VERIFY_TTL_MS, 7 * 86_400_000);
  assert(await consumeToken(store, token, T0 + VERIFY_TTL_MS - 1), "valid just inside");

  const fresh = await mintToken(store, SLUG, "verify", T0);
  assertEquals(await consumeToken(store, fresh.token, T0 + VERIFY_TTL_MS + 1), null);
});

Deno.test("an expired token is cleared out rather than left lying around", async () => {
  const { store, size } = createMemoryStore();
  const { token } = await mintToken(store, SLUG, "manage", T0);

  await consumeToken(store, token, T0 + MANAGE_TTL_MS + 1);
  assertEquals(size(), 0);
});

Deno.test("an unknown or malformed token is refused without throwing", async () => {
  const { store } = createMemoryStore();
  await mintToken(store, SLUG, "manage", T0);

  for (const hostile of ["", "nonsense", "../../shirts/K7M4NPQR8TVWXYZ2ABCD", "a".repeat(200)]) {
    assertEquals(await consumeToken(store, hostile, T0), null, `should refuse ${hostile}`);
  }
});

Deno.test("two tokens for the same code are independent", async () => {
  const { store } = createMemoryStore();
  const first = await mintToken(store, SLUG, "manage", T0);
  const second = await mintToken(store, SLUG, "manage", T0);

  assert(first.token !== second.token);
  assert(await consumeToken(store, first.token, T0 + 1000));
  assert(
    await consumeToken(store, second.token, T0 + 1000),
    "consuming one must not kill the other",
  );
});

Deno.test("a token only ever names the code it was minted for", async () => {
  const { store } = createMemoryStore();
  const mine = await mintToken(store, SLUG, "manage", T0);
  await mintToken(store, OTHER, "manage", T0);

  const claim = await consumeToken(store, mine.token, T0 + 1000);
  assertEquals(slugOf(claim), SLUG, "must never resolve to the other code");
});

/**
 * The test the old implementation could not pass. Sequential redemption always looked
 * single-use because the first delete landed before the second get; a review proved that
 * twenty concurrent redemptions yielded three valid claims. Single use is now decided by
 * the delete, so exactly one racer may win.
 */
Deno.test("a token survives exactly one winner under concurrent redemption", async () => {
  for (const racers of [2, 20, 100]) {
    const { store, size } = createMemoryStore();
    const { token } = await mintToken(store, SLUG, "manage", T0);

    const claims = await Promise.all(
      Array.from({ length: racers }, () => consumeToken(store, token, T0 + 1000)),
    );

    const winners = claims.filter((claim) => claim !== null);
    assertEquals(winners.length, 1, `${racers} concurrent redemptions must yield one claim`);
    assertEquals(slugOf(winners[0] ?? null), SLUG);
    assertEquals(size(), 0, "the token is gone afterwards");
  }
});

Deno.test("a corrupt token record reads as absent rather than throwing", async () => {
  for (
    const corrupt of [
      '{"slug":',
      "",
      "null",
      "[]",
      '{"slug":"../etc","purpose":"manage","expiresAt":9e99}',
      '{"slug":"K7M4NPQR8TVWXYZ2ABCD","purpose":"admin","expiresAt":9e99}',
      '{"slug":"K7M4NPQR8TVWXYZ2ABCD","purpose":"manage","expiresAt":"soon"}',
    ]
  ) {
    const { store } = createMemoryStore();
    const { token } = await mintToken(store, SLUG, "manage", T0);
    await store.put(`tokens/${await hashToken(token)}.json`, corrupt);

    assertEquals(await consumeToken(store, token, T0 + 1000), null, `corrupt: ${corrupt}`);
  }
});

/**
 * Peeking exists so a GET can stay safe against mail-scanner prefetch. It must not become a
 * way to use a token twice, so these two tests pin both halves of that.
 */
Deno.test("peeking reads a token without spending it", async () => {
  const { store, size } = createMemoryStore();
  const { token } = await mintToken(store, SLUG, "manage", T0);

  assertEquals(slugOf(await peekToken(store, token, T0 + 1000)), SLUG);
  assertEquals(slugOf(await peekToken(store, token, T0 + 2000)), SLUG, "still there");
  assertEquals(size(), 1, "peeking must not delete");

  assertEquals(slugOf(await consumeToken(store, token, T0 + 3000)), SLUG);
  assertEquals(size(), 0);
});

Deno.test("peeking respects expiry and refuses the unknown", async () => {
  const { store } = createMemoryStore();
  const { token } = await mintToken(store, SLUG, "manage", T0);

  assertEquals(await peekToken(store, token, T0 + MANAGE_TTL_MS + 1), null, "expired");
  assertEquals(await peekToken(store, "nonsense", T0), null);
  assertEquals(await peekToken(store, "", T0), null);
});

Deno.test("a peeked token is still single use once consumed", async () => {
  const { store } = createMemoryStore();
  const { token } = await mintToken(store, SLUG, "manage", T0);

  await peekToken(store, token, T0 + 100);
  const claims = await Promise.all(
    Array.from({ length: 20 }, () => consumeToken(store, token, T0 + 200)),
  );
  assertEquals(claims.filter((c) => c !== null).length, 1, "peeking must not create a second use");
});

/* ---------- carrying a pending email change ---------- */

/**
 * A change of address cannot take effect when it is requested, or a stolen management link
 * would be a silent takeover. The new address has to prove it can receive mail first, so the
 * pending address rides inside the token record until the new inbox confirms it.
 *
 * It rides encrypted, with the same key as the owner record, because a leaked storage key must
 * not dump addresses whichever object they happen to be sitting in.
 */
Deno.test("a change token carries the pending address and hands it back once", async () => {
  const { store } = createMemoryStore();
  const pending = "krypterat-nytt-epost";

  const { token } = await mintEmailToken(store, EPOST, "change", T0, pending);

  const peeked = await peekToken(store, token, T0 + 1000);
  assertEquals(peeked?.purpose, "change");
  assertEquals(
    peeked?.purpose === "change" ? peeked.data : null,
    pending,
    "peeking reads the pending address without spending it",
  );

  const consumed = await consumeToken(store, token, T0 + 1000);
  assertEquals(consumed?.purpose === "change" ? consumed.data : null, pending);
  assertEquals(await consumeToken(store, token, T0 + 1000), null, "and only once");
});

Deno.test("a change token expires faster than a verification link", async () => {
  const { store } = createMemoryStore();

  const { token } = await mintEmailToken(store, EPOST, "change", T0, "x");

  assert(await peekToken(store, token, T0 + CHANGE_TTL_MS - 1000), "valid just inside");
  assertEquals(await peekToken(store, token, T0 + CHANGE_TTL_MS + 1000), null, "dead outside");
  assert(CHANGE_TTL_MS < VERIFY_TTL_MS, "a takeover window must not last a week");
});

/** The purposes must stay separate, or the shortest-lived link becomes the most useful one. */
Deno.test("the four purposes are never interchangeable", async () => {
  const { store } = createMemoryStore();

  for (const purpose of ["verify", "manage"] as const) {
    const { token } = await mintToken(store, SLUG, purpose, T0);
    assertEquals((await peekToken(store, token, T0 + 1000))?.purpose, purpose);
  }

  for (const purpose of ["koder", "change"] as const) {
    const { token } = await mintEmailToken(store, EPOST, purpose, T0, "x");
    assertEquals((await peekToken(store, token, T0 + 1000))?.purpose, purpose);
  }
});

/* ---------- a token that names an address rather than a code ---------- */

/**
 * The manage mail used to mint one token per code and send one mail per code, which is three
 * identical mails at three codes and unusable at eight. A `koder` token names the address, so
 * one link reaches every code on it, including a code created after the link was minted.
 *
 * It carries the SHA-256 of the address, which is what the email index is already keyed on, so
 * nothing here holds an address in the clear.
 */
Deno.test("a koder token names an address, never a code", async () => {
  const { store } = createMemoryStore();
  const { token } = await mintEmailToken(store, EPOST, "koder", T0);

  const claim = await consumeToken(store, token, T0 + 1000);
  assertEquals(claim, { purpose: "koder", epost: EPOST });
  assert(!JSON.stringify(claim).includes(SLUG), "a code cannot come out of an address token");
});

Deno.test("a koder token lives exactly as long as a manage link", async () => {
  const { store } = createMemoryStore();
  const { token, expiresAt } = await mintEmailToken(store, EPOST, "koder", T0);

  assertEquals(KODER_TTL_MS, MANAGE_TTL_MS, "one number, so the copy in the mail stays true");
  assertEquals(expiresAt, T0 + KODER_TTL_MS);
  assert(await peekToken(store, token, expiresAt), "alive at its expiry");
  assertEquals(await peekToken(store, token, expiresAt + 1), null, "dead a millisecond later");
});

Deno.test("a koder token is single use under concurrency, like every other", async () => {
  for (const racers of [2, 20, 100]) {
    const { store, size } = createMemoryStore();
    const { token } = await mintEmailToken(store, EPOST, "koder", T0);

    const claims = await Promise.all(
      Array.from({ length: racers }, () => consumeToken(store, token, T0 + 1000)),
    );

    assertEquals(claims.filter((claim) => claim !== null).length, 1, `${racers} racers, one claim`);
    assertEquals(size(), 0);
  }
});

Deno.test("one address's token never resolves to another address", async () => {
  const { store } = createMemoryStore();
  const mine = await mintEmailToken(store, EPOST, "koder", T0);
  await mintEmailToken(store, ANNAN_EPOST, "koder", T0);

  const claim = await consumeToken(store, mine.token, T0 + 1000);
  assertEquals(claim?.purpose === "koder" ? claim.epost : null, EPOST);
});

/**
 * The subject of a token decides which storage key gets built from it downstream, so it is
 * validated on the way out of storage as well as on the way in. A slug where a hash belongs, or
 * a hash where a slug belongs, is a record this version did not write.
 */
Deno.test("a token record whose subject is the wrong shape reads as absent", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["a koder token naming a slug", { purpose: "koder", slug: SLUG, expiresAt: T0 + 60_000 }],
    ["a koder token with no subject at all", { purpose: "koder", expiresAt: T0 + 60_000 }],
    ["a koder token whose hash is short", {
      purpose: "koder",
      epost: "abc123",
      expiresAt: T0 + 60_000,
    }],
    ["a koder token whose hash is not hex", {
      purpose: "koder",
      epost: "z".repeat(64),
      expiresAt: T0 + 60_000,
    }],
    ["a manage token naming an address", {
      purpose: "manage",
      epost: EPOST,
      expiresAt: T0 + 60_000,
    }],
    ["a change token with no address", {
      purpose: "change",
      data: "x",
      expiresAt: T0 + 60_000,
    }],
    ["a change token with no pending address", {
      purpose: "change",
      epost: EPOST,
      expiresAt: T0 + 60_000,
    }],
  ];

  for (const [name, record] of cases) {
    const { store } = createMemoryStore();
    const token = "c".repeat(64);
    await store.put(`tokens/${await hashToken(token)}.json`, JSON.stringify(record));

    assertEquals(await peekToken(store, token, T0), null, name);
    assertEquals(await consumeToken(store, token, T0), null, name);
  }
});

Deno.test("a change token cannot be minted without the address it is moving to", async () => {
  const { store, size } = createMemoryStore();

  await assertRejects(
    () => mintEmailToken(store, EPOST, "change", T0),
    Error,
    "change",
  );
  assertEquals(size(), 0, "nothing is written when the mint is refused");
});

Deno.test("a token record naming an unknown purpose reads as absent", async () => {
  const { store } = createMemoryStore();
  const token = "a".repeat(64);

  await store.put(
    `tokens/${await hashToken(token)}.json`,
    JSON.stringify({ slug: SLUG, purpose: "radera-allt", expiresAt: T0 + 60_000 }),
  );

  assertEquals(await peekToken(store, token, T0), null);
  assertEquals(await consumeToken(store, token, T0), null);
});

Deno.test("a non-string data field is refused rather than handed on", async () => {
  const { store } = createMemoryStore();
  const token = "b".repeat(64);

  await store.put(
    `tokens/${await hashToken(token)}.json`,
    JSON.stringify({
      epost: EPOST,
      purpose: "change",
      expiresAt: T0 + 60_000,
      data: { nested: true },
    }),
  );

  assertEquals(await peekToken(store, token, T0), null);
});

/* ---------- the exact boundary, which is where off-by-one lives ---------- */

/**
 * R16. Every expiry test here probed the limit plus or minus a second, which means flipping
 * any `>` to `>=` would have passed the whole suite. The moment a token expires is a decision,
 * not an accident, so it is pinned: a token is alive *at* its expiry instant and dead one
 * millisecond later.
 *
 * The direction matters more than which way it went. A link that dies a millisecond early is a
 * user staring at a failure page for no reason they can see.
 */
Deno.test("a token is alive at exactly its expiry, and dead one millisecond after", async () => {
  const mints: [
    string,
    number,
    (store: ObjectStore) => Promise<{ expiresAt: number; token: string }>,
  ][] = [
    ["verify", VERIFY_TTL_MS, (store) => mintToken(store, SLUG, "verify", T0)],
    ["manage", MANAGE_TTL_MS, (store) => mintToken(store, SLUG, "manage", T0)],
    ["koder", KODER_TTL_MS, (store) => mintEmailToken(store, EPOST, "koder", T0)],
    ["change", CHANGE_TTL_MS, (store) => mintEmailToken(store, EPOST, "change", T0, "x")],
  ];

  for (const [purpose, ttl, mint] of mints) {
    const { store } = createMemoryStore();
    const { token, expiresAt } = await mint(store);

    assertEquals(expiresAt, T0 + ttl, `${purpose} expiry is minted from the TTL`);
    assert(await peekToken(store, token, expiresAt), `${purpose} must be alive at its expiry`);
    assertEquals(
      await peekToken(store, token, expiresAt + 1),
      null,
      `${purpose} must be dead one millisecond later`,
    );
  }
});

/** Consuming has its own comparison, and must agree with peeking to the millisecond. */
Deno.test("consuming and peeking expire at the same instant", async () => {
  for (const offset of [-1, 0, 1]) {
    const { store } = createMemoryStore();
    const { token, expiresAt } = await mintToken(store, SLUG, "manage", T0);

    const peeked = await peekToken(store, token, expiresAt + offset);
    const consumed = await consumeToken(store, token, expiresAt + offset);

    assertEquals(
      peeked === null,
      consumed === null,
      `at expiry${offset >= 0 ? "+" : ""}${offset} peek and consume disagree`,
    );
  }
});
