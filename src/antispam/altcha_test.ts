import { assert, assertEquals } from "@std/assert";
import { sha256Hex } from "../store/crypto.ts";
import { createMemoryStore } from "../store/storage.ts";
import { claimChallenge, createChallenge, recordChallenge, verifySolution } from "./altcha.ts";

const HMAC_KEY = "test-hmac-secret-not-the-real-one";
const T0 = Date.parse("2026-08-12T10:00:00Z");

/** Do what the widget does: brute-force the number that reproduces the challenge hash. */
async function solve(
  challenge: Awaited<ReturnType<typeof createChallenge>>,
): Promise<string> {
  for (let n = 0; n <= challenge.maxnumber; n++) {
    if (await sha256Hex(challenge.salt + n) === challenge.challenge) {
      return btoa(JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        number: n,
        salt: challenge.salt,
        signature: challenge.signature,
      }));
    }
  }
  throw new Error("unsolvable challenge, the generator is broken");
}

function tamper(payload: string, change: (parsed: Record<string, unknown>) => void): string {
  const parsed = JSON.parse(atob(payload));
  change(parsed);
  return btoa(JSON.stringify(parsed));
}

Deno.test("challenge has the shape the ALTCHA widget expects", async () => {
  const challenge = await createChallenge(HMAC_KEY, T0, { maxnumber: 500 });

  assertEquals(challenge.algorithm, "SHA-256");
  assert(/^[0-9a-f]{64}$/.test(challenge.challenge), "challenge is a sha-256 hex digest");
  assert(/^[0-9a-f]{64}$/.test(challenge.signature), "signature is an hmac hex digest");
  assert(challenge.maxnumber > 0);
  assert(challenge.salt.includes("?expires="), "expiry rides along in the salt");
});

Deno.test("challenge is solvable and the solution verifies", async () => {
  const challenge = await createChallenge(HMAC_KEY, T0, { maxnumber: 500 });
  const payload = await solve(challenge);

  assert(await verifySolution(HMAC_KEY, payload, T0 + 1000));
});

Deno.test("two challenges are never the same", async () => {
  const first = await createChallenge(HMAC_KEY, T0, { maxnumber: 500 });
  const second = await createChallenge(HMAC_KEY, T0, { maxnumber: 500 });
  assert(first.challenge !== second.challenge);
  assert(first.salt !== second.salt);
});

/* Every failure below must return false rather than throw: this runs on a public endpoint. */

Deno.test("a wrong number is refused", async () => {
  const challenge = await createChallenge(HMAC_KEY, T0, { maxnumber: 500 });
  const payload = await solve(challenge);
  const wrong = tamper(payload, (p) => {
    p.number = (p.number as number) + 1;
  });

  assertEquals(await verifySolution(HMAC_KEY, wrong, T0 + 1000), false);
});

Deno.test("a tampered signature is refused", async () => {
  const challenge = await createChallenge(HMAC_KEY, T0, { maxnumber: 500 });
  const payload = await solve(challenge);
  const wrong = tamper(payload, (p) => {
    p.signature = "0".repeat(64);
  });

  assertEquals(await verifySolution(HMAC_KEY, wrong, T0 + 1000), false);
});

/**
 * The interesting attack: forge a challenge you already know the answer to. It fails only
 * because the signature is checked, which is the entire reason the HMAC exists.
 */
Deno.test("a self-minted challenge is refused without the server key", async () => {
  const salt = `deadbeef?expires=${Math.floor((T0 + 600_000) / 1000)}`;
  const forged = btoa(JSON.stringify({
    algorithm: "SHA-256",
    challenge: await sha256Hex(salt + "7"),
    number: 7,
    salt,
    signature: "f".repeat(64),
  }));

  assertEquals(await verifySolution(HMAC_KEY, forged, T0), false);
});

Deno.test("a solution signed with a different key is refused", async () => {
  const challenge = await createChallenge("some-other-key", T0, { maxnumber: 500 });
  const payload = await solve(challenge);

  assertEquals(await verifySolution(HMAC_KEY, payload, T0 + 1000), false);
});

Deno.test("an expired solution is refused", async () => {
  const challenge = await createChallenge(HMAC_KEY, T0, { maxnumber: 500, ttlMs: 60_000 });
  const payload = await solve(challenge);

  assert(await verifySolution(HMAC_KEY, payload, T0 + 59_000), "valid just inside");
  assertEquals(await verifySolution(HMAC_KEY, payload, T0 + 61_000), false, "dead just outside");
});

Deno.test("a solution for the wrong algorithm is refused", async () => {
  const challenge = await createChallenge(HMAC_KEY, T0, { maxnumber: 500 });
  const payload = await solve(challenge);
  const wrong = tamper(payload, (p) => {
    p.algorithm = "SHA-1";
  });

  assertEquals(await verifySolution(HMAC_KEY, wrong, T0 + 1000), false);
});

Deno.test("garbage input is refused without throwing", async () => {
  for (
    const hostile of [
      "",
      "not base64",
      btoa("not json"),
      btoa(JSON.stringify({})),
      btoa(JSON.stringify({ algorithm: "SHA-256" })),
      btoa(JSON.stringify({ algorithm: "SHA-256", number: "seven", salt: "x", challenge: "y" })),
      btoa(JSON.stringify([1, 2, 3])),
      "a".repeat(10_000),
    ]
  ) {
    assertEquals(
      await verifySolution(HMAC_KEY, hostile, T0),
      false,
      `should have refused ${hostile.slice(0, 24)}`,
    );
  }
});

Deno.test("a solution with a hostile number is refused rather than hanging", async () => {
  const challenge = await createChallenge(HMAC_KEY, T0, { maxnumber: 500 });
  const payload = await solve(challenge);

  for (const number of [-1, 1e12, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY]) {
    const wrong = tamper(payload, (p) => {
      p.number = number;
    });
    assertEquals(await verifySolution(HMAC_KEY, wrong, T0 + 1000), false, `number ${number}`);
  }
});

/* ---------- single use, which is the R9 fix ---------- */

/**
 * The dangerous half of R9 was that one solved challenge could be fired at a stranger's
 * address many times over, because the signup cap races and cannot be made correct without a
 * compare-and-swap this storage does not offer. Claiming closes it from the other end: an
 * attacker now needs one proof of work per request rather than one per burst.
 */
Deno.test("a solved challenge can be spent exactly once, even concurrently", async () => {
  for (const racers of [2, 20, 100]) {
    const { store } = createMemoryStore();
    const challenge = await createChallenge(HMAC_KEY, T0, { maxnumber: 300 });
    await recordChallenge(store, challenge, T0);
    const payload = await solve(challenge);

    // Every racer holds a genuinely valid solution. Only one may get through.
    for (const one of [payload]) {
      assert(await verifySolution(HMAC_KEY, one, T0 + 1000), "the solution is valid");
    }

    const claims = await Promise.all(
      Array.from({ length: racers }, () => claimChallenge(store, payload)),
    );
    assertEquals(claims.filter(Boolean).length, 1, `${racers} racers must yield one winner`);
  }
});

Deno.test("an unrecorded or already spent challenge cannot be claimed", async () => {
  const { store } = createMemoryStore();
  const challenge = await createChallenge(HMAC_KEY, T0, { maxnumber: 300 });
  const payload = await solve(challenge);

  assertEquals(await claimChallenge(store, payload), false, "never recorded");

  await recordChallenge(store, challenge, T0);
  assertEquals(await claimChallenge(store, payload), true);
  assertEquals(await claimChallenge(store, payload), false, "spent");
});

Deno.test("claiming refuses garbage without throwing", async () => {
  const { store } = createMemoryStore();
  for (const hostile of ["", "not base64", btoa("{}"), btoa(JSON.stringify({ challenge: 7 }))]) {
    assertEquals(await claimChallenge(store, hostile), false, hostile.slice(0, 16));
  }
});
