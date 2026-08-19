/**
 * ALTCHA proof-of-work, server side.
 *
 * Chosen because Cloudflare, and therefore Turnstile, is out on EU grounds, and Bunny's
 * per-IP rate limiting sits behind a paid tier. ALTCHA is self-hosted, makes no third-party
 * requests, sets no cookies, and needs no shared state, which is what makes it usable from a
 * stateless edge script.
 *
 * The protocol itself comes from `altcha-lib`, the reference implementation, rather than
 * from our own reading of the specification. An earlier version here implemented the hashing
 * and HMAC by hand; that is the class of mistake that produced a QR code no phone could read.
 * The library is also what the official widget is written against, so interoperability is a
 * property of using it rather than something we hope we got right.
 *
 * What stays ours is the policy around it, because that is product judgement rather than
 * protocol: how much work to demand, how long a challenge lives, that verification takes an
 * injected clock so expiry is testable, and above all that every failure returns false rather
 * than throwing, because this runs on a public endpoint.
 *
 * Replay used to be the accepted gap here, and it was the dangerous half of R9: one solve
 * could be fired at a stranger's address many times over, because the signup cap races and
 * cannot be made correct without a compare-and-swap the storage does not offer.
 *
 * `claimChallenge` closes it. The trick is that a challenge object is written by *us* when the
 * challenge is issued, in a single request with no concurrency, so claiming it by delete is
 * race-free in a way the counters can never be: exactly one caller's delete removes the
 * object, and only that caller may proceed. An attacker now needs one proof of work per
 * request rather than one per burst.
 */

import {
  createChallenge as libCreateChallenge,
  verifySolution as libVerifySolution,
} from "altcha-lib";
import type { ObjectStore } from "../store/storage.ts";

export interface Challenge {
  algorithm: string;
  challenge: string;
  maxnumber: number;
  salt: string;
  signature: string;
}

export interface ChallengeOptions {
  /** Upper bound on the client's search. Higher costs bots more, and honest phones too. */
  maxnumber?: number;
  ttlMs?: number;
}

/** Enough work to be a nuisance in bulk, and unnoticed once on a phone. */
const DEFAULT_MAXNUMBER = 200_000;
const DEFAULT_TTL_MS = 10 * 60_000;

export async function createChallenge(
  hmacKey: string,
  now: number = Date.now(),
  options: ChallengeOptions = {},
): Promise<Challenge> {
  const maxNumber = options.maxnumber ?? DEFAULT_MAXNUMBER;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  const challenge = await libCreateChallenge({
    hmacKey,
    maxNumber,
    // The expiry rides inside the salt, so it is covered by the signature.
    expires: new Date(now + ttlMs),
  });

  return {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    maxnumber: challenge.maxnumber ?? maxNumber,
    salt: challenge.salt,
    signature: challenge.signature,
  };
}

function expiryFrom(salt: string): number | null {
  const query = salt.split("?")[1];
  if (!query) return null;
  const expires = new URLSearchParams(query).get("expires");
  if (!expires) return null;
  const seconds = Number(expires);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Returns a boolean and never throws. Every malformed, hostile or merely unlucky input has to
 * fail closed rather than surface as a 500.
 *
 * Expiry is checked here against the caller's clock rather than delegated, so that tests can
 * drive time. The signature and hash checks are the library's.
 */
function keyFor(challenge: string): string {
  return `altcha/${challenge}.json`;
}

/**
 * Record an issued challenge so it can be spent exactly once.
 *
 * Abandoned challenges are never swept, because the store deliberately has no list operation.
 * They are a couple of hundred bytes each, so a million forgotten form loads is a fraction of
 * a cent per month. Cheap enough to prefer over reintroducing enumeration.
 */
export async function recordChallenge(
  store: ObjectStore,
  challenge: Challenge,
  now: number = Date.now(),
): Promise<void> {
  await store.put(
    keyFor(challenge.challenge),
    JSON.stringify({ issuedAt: now }),
  );
}

/**
 * Spend a verified solution. Returns false if this challenge was already used, so a burst of
 * concurrent requests carrying one solved challenge yields exactly one winner.
 *
 * Must be called only after `verifySolution` has passed: this proves single use, not
 * authenticity.
 */
export async function claimChallenge(store: ObjectStore, payload: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(atob(payload)) as { challenge?: unknown };
    if (typeof parsed.challenge !== "string") return false;
    // The delete decides the winner, exactly as it does for single-use tokens.
    return await store.delete(keyFor(parsed.challenge));
  } catch {
    return false;
  }
}

export async function verifySolution(
  hmacKey: string,
  payload: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (!payload || payload.length > 4096) return false;

  try {
    // Decoded here only to read the expiry the salt carries. Trusting nothing in it: the
    // library still has to agree that the whole payload is authentic.
    const parsed = JSON.parse(atob(payload)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;

    const salt = (parsed as { salt?: unknown }).salt;
    if (typeof salt !== "string") return false;

    const expiresAt = expiryFrom(salt);
    if (expiresAt === null || now > expiresAt) return false;

    // `false` disables the library's own wall-clock expiry check, which the line above has
    // already done against the injected clock.
    return await libVerifySolution(payload, hmacKey, false);
  } catch {
    return false;
  }
}

/**
 * What the endpoints actually call: check the proof, then spend it. Kept as one function so a
 * handler cannot verify and forget to claim, which would quietly reopen R9.
 */
export async function spendSolution(
  store: ObjectStore,
  hmacKey: string,
  payload: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (!await verifySolution(hmacKey, payload, now)) return false;
  return await claimChallenge(store, payload);
}
