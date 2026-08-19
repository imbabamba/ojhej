/**
 * Single-use, expiring tokens. This is the real ownership boundary.
 *
 * The slug is printed on a garment and is therefore public. A token is the opposite: it is
 * secret, it is used once, and it dies quickly. Only the SHA-256 of a token is ever written
 * down, so an attacker holding a copy of the entire store still cannot manage anyone's code.
 *
 * Single use is decided by the DELETE, not by the earlier GET. An earlier version checked
 * `get` for presence and then deleted, which a review proved was not single-use at all:
 * twenty concurrent redemptions of one token yielded three valid claims, because they all
 * ran their `get` before any `delete` landed. There is no compare-and-swap in this stack,
 * but an object store serialises deletes on a single key, so "did my delete remove it"
 * is a real mutual exclusion and "was it there a moment ago" is not.
 */

import { hashToken, isValidSlug, newToken } from "./crypto.ts";
import type { ObjectStore } from "./storage.ts";

/**
 * What a token is allowed to do, and what it names.
 *
 * Two of them name a code and two name an address. The split is not cosmetic: an address token
 * reaches every code on that address, including one created after the token was minted, so the
 * check that a named code belongs to the address happens at every action rather than once here.
 * See `research-2026-08-15-flera-koder.md`.
 */
export type CodePurpose = "verify" | "manage";
export type EmailPurpose = "koder" | "change";
export type TokenPurpose = CodePurpose | EmailPurpose;

/** A week to click the link in a signup mail. */
export const VERIFY_TTL_MS = 7 * 86_400_000;
/** Half an hour to use a management link, because it is the key to the whole code. */
export const MANAGE_TTL_MS = 30 * 60_000;
/**
 * The same half hour for a link that reaches every code on an address.
 *
 * One number rather than two, because both are the same promise made in the same sentence in the
 * same mail, and two numbers is how the copy stops being true.
 */
export const KODER_TTL_MS = MANAGE_TTL_MS;
/**
 * An hour to confirm a new address from the new inbox.
 *
 * Deliberately far shorter than a verification link. Confirming a change moves every future
 * message to a different mailbox, so a leaked change link is a takeover rather than a nuisance,
 * and the window it stays useful in should be small. An hour is still ample for someone who has
 * to open a different inbox, which is the whole point of the step.
 */
export const CHANGE_TTL_MS = 60 * 60_000;

const TTL: Record<TokenPurpose, number> = {
  verify: VERIFY_TTL_MS,
  manage: MANAGE_TTL_MS,
  koder: KODER_TTL_MS,
  change: CHANGE_TTL_MS,
};

interface TokenRecord {
  purpose: TokenPurpose;
  expiresAt: number;
  /** For the code purposes. Always a slug that has passed `isValidSlug`. */
  slug?: string;
  /**
   * For the address purposes: the SHA-256 of the normalised owner address, which is exactly what
   * the email index is keyed on. A hash rather than the address itself, so a token record is not
   * somewhere an address can leak from.
   */
  epost?: string;
  /**
   * Only for "change": the address waiting to take over, already encrypted with the same key
   * as the owner record. A pending change is an address we hold on someone's behalf, so it is
   * no less sensitive than the one it would replace.
   */
  data?: string;
}

/**
 * What a caller gets back, shaped so the compiler makes the distinction for them.
 *
 * A claim never carries both a slug and an address. Reading `claim.slug` off a token that names
 * an address is the bug this union exists to make unwriteable.
 */
export type TokenClaim =
  | { purpose: "verify"; slug: string }
  | { purpose: "manage"; slug: string }
  | { purpose: "koder"; epost: string }
  | { purpose: "change"; epost: string; data: string };

/** A SHA-256, written out. Anything else did not come from `emailHash`. */
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Expiry is the caller's business; everything else about the record is not. */
function asClaim(record: TokenRecord): TokenClaim | null {
  if (record.purpose === "verify" || record.purpose === "manage") {
    return record.slug === undefined ? null : { purpose: record.purpose, slug: record.slug };
  }
  if (record.epost === undefined) return null;
  if (record.purpose === "koder") return { purpose: "koder", epost: record.epost };
  return record.data === undefined
    ? null
    : { purpose: "change", epost: record.epost, data: record.data };
}

function keyFor(hash: string): string {
  return `tokens/${hash}.json`;
}

/**
 * Stored content is not trusted. A truncated or corrupt object must read as "no such token"
 * rather than throwing, or a malformed record would take down the request that found it.
 *
 * The subject is validated by purpose, in both directions: a code token carrying an address, or
 * an address token carrying a slug, is a record this version did not write and must not act on.
 * The value decides which storage key gets built downstream, which is why it is checked here as
 * well as at the boundary it arrived through.
 */
function parseRecord(raw: string): TokenRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { slug, purpose, expiresAt, epost, data } = parsed as Partial<TokenRecord>;
  if (purpose !== "verify" && purpose !== "manage" && purpose !== "koder" && purpose !== "change") {
    return null;
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  // A non-string here would be handed to a decrypt call, so refuse the record outright.
  if (data !== undefined && typeof data !== "string") return null;

  if (purpose === "verify" || purpose === "manage") {
    if (typeof slug !== "string" || !isValidSlug(slug)) return null;
    if (epost !== undefined) return null;
    return { purpose, slug, expiresAt };
  }

  if (!isHash(epost)) return null;
  if (slug !== undefined) return null;
  if (purpose === "change" && data === undefined) return null;

  return data === undefined ? { purpose, epost, expiresAt } : { purpose, epost, expiresAt, data };
}

/** A token for one code: activation, or the controls for that code alone. */
export async function mintToken(
  store: ObjectStore,
  slug: string,
  purpose: CodePurpose,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  if (!isValidSlug(slug)) throw new Error("refusing to mint a token for an invalid slug");

  const token = newToken();
  const expiresAt = now + TTL[purpose];
  await store.put(
    keyFor(await hashToken(token)),
    JSON.stringify({ purpose, slug, expiresAt } satisfies TokenRecord),
  );

  // The only moment the raw token exists. It goes straight into an email and is never stored.
  return { token, expiresAt };
}

/**
 * A token for an address: every code it owns, or a pending move of all of them.
 *
 * Takes the hash rather than the address, so no caller can hand this an address by accident and
 * no address ends up in a token record. `emailHash` in `emails.ts` is the one way to make one.
 */
export async function mintEmailToken(
  store: ObjectStore,
  epost: string,
  purpose: EmailPurpose,
  now: number = Date.now(),
  /** The proposed address, encrypted. Required for a change, meaningless for anything else. */
  data?: string,
): Promise<{ token: string; expiresAt: number }> {
  if (!isHash(epost)) throw new Error("refusing to mint a token for something that is not a hash");
  // A change token with nothing to change to would spend the owner's link and move nobody.
  if (purpose === "change" && data === undefined) {
    throw new Error("refusing to mint a change token with no pending address");
  }

  const token = newToken();
  const expiresAt = now + TTL[purpose];
  const record: TokenRecord = data === undefined
    ? { purpose, epost, expiresAt }
    : { purpose, epost, expiresAt, data };

  await store.put(keyFor(await hashToken(token)), JSON.stringify(record));
  return { token, expiresAt };
}

/**
 * Read a token without spending it.
 *
 * This exists so a GET can stay safe. Mail security gateways prefetch every link in an email
 * before the recipient sees it, so a page that consumes on GET burns the token before it is
 * ever clicked, and the user lands on a generic failure with no way to tell why. The page
 * peeks; the action that follows consumes.
 *
 * Peeking must never be mistaken for authorisation on its own: it proves the token existed a
 * moment ago, not that this caller gets to keep it. Only `consumeToken` decides that.
 */
export async function peekToken(
  store: ObjectStore,
  token: string,
  now: number = Date.now(),
): Promise<TokenClaim | null> {
  if (!token) return null;

  const raw = await store.get(keyFor(await hashToken(token)));
  if (raw === null) return null;

  const record = parseRecord(raw);
  if (!record || now > record.expiresAt) return null;

  return asClaim(record);
}

/**
 * Redeem a token, destroying it in the process. Returns null for every failure mode
 * (unknown, malformed, already used, lost the race, expired) so a caller cannot accidentally
 * treat "expired" as different from "never existed", and so probing tells an attacker nothing.
 */
export async function consumeToken(
  store: ObjectStore,
  token: string,
  now: number = Date.now(),
): Promise<TokenClaim | null> {
  if (!token) return null;

  const key = keyFor(await hashToken(token));

  // Read first, because the content is needed and the delete is about to destroy it.
  const raw = await store.get(key);
  if (raw === null) return null;

  // The claim step. Concurrent redeemers may all have read the record above, but exactly
  // one delete can be the one that removes it, and only that one is allowed to proceed.
  const claimed = await store.delete(key);
  if (!claimed) return null;

  const record = parseRecord(raw);
  if (!record) return null;

  if (now > record.expiresAt) return null;

  return asClaim(record);
}
