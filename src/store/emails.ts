/**
 * Per-address signup cap.
 *
 * Signup is the expensive public endpoint: it sends mail to an address the *submitter*
 * chose, which is the classic mail-bombing shape. ALTCHA makes each attempt cost CPU, and
 * this makes a flood of attempts pointless even if that is defeated.
 *
 * The counter is keyed on a SHA-256 of the normalised address, so the bucket works without
 * the store ever holding the address itself. That matters twice over: the address is the
 * only personal data here, and unlike a code record there is no ciphertext to hide behind.
 */

import { isValidSlug, sha256Hex } from "./crypto.ts";
import type { ObjectStore } from "./storage.ts";

/** Enough for a person with a few garments, nowhere near enough to farm. */
export const MAX_SIGNUPS_PER_DAY = 3;

/**
 * How many codes one address may own at a time.
 *
 * A different limit from the daily one and for a different reason. The daily cap protects a
 * stranger's inbox from a flood of verification mail; this one bounds what a single verified
 * owner can accumulate, including through the manage page, where no mail is sent and no proof of
 * work is asked for. Ten is what the manage page counts down from, so it is defined once.
 */
export const MAX_CODES_PER_EMAIL = 10;

/**
 * How many management links one address may be mailed in a day.
 *
 * Generous for the honest case it exists for, which is somebody who lost the link or whose mail
 * client ate it, and small enough that the endpoint stops being a way to fill an inbox with
 * live tokens.
 */
export const MAX_MANAGE_LINKS_PER_DAY = 5;

const DAY_MS = 86_400_000;

interface EmailRecord {
  day: number;
  count: number;
  /**
   * The manage-link counter, kept separate from `count` on purpose.
   *
   * Sharing one budget would mean an owner who lost their link could burn the allowance that
   * stops a stranger mail-bombing them, and the reverse. They limit different things: `count`
   * protects an inbox from mail the *submitter* asked for, this protects it from a flood of
   * live management links.
   */
  lankDag?: number;
  lankAntal?: number;
  /**
   * Codes belonging to this address, so a manage link can be requested by email instead of
   * by remembering a 20-character slug printed on a garment that may be in the wash.
   *
   * This is a reverse index, and worth being honest about: it links an address to its codes.
   * The linkage already exists in the other direction, since the code record holds the
   * encrypted address, and the key here is a hash rather than the address itself. Slugs are
   * semi-public by design. Net new exposure is small, and the alternative is an owner who
   * cannot reach their own controls.
   */
  slugs?: string[];
}

/**
 * Normalised the same way `normalizeEmail` does, so shouting an address or padding it with
 * spaces cannot buy a fresh allowance. Deliberately not importing from mail/address.ts:
 * that function *validates*, and by the time we get here the address is already valid.
 */
async function keyFor(email: string): Promise<string> {
  return keyForHash(await emailHash(email));
}

/**
 * The address, as this store knows it: a SHA-256 of the normalised form and nothing else.
 *
 * Exported because a `koder` token carries this rather than the address, so a token record is
 * not somewhere an address can leak from. It has to be the same hash the index is keyed on, or a
 * management link would open on an empty list while the owner's codes sat one key away, which is
 * why `keyFor` is written in terms of it rather than the two computing it separately.
 */
export function emailHash(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

/** A SHA-256, written out. Anything else did not come from `emailHash`. */
function isHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function keyForHash(hash: string): string {
  return `emails/${hash}.json`;
}

/**
 * Take one slot for this address today. Returns whether it was granted and how many are
 * now used. Refusals do not keep climbing, so the number stays meaningful in a log.
 */
export async function claimSignupSlot(
  store: ObjectStore,
  email: string,
  now: number = Date.now(),
): Promise<{ allowed: boolean; used: number }> {
  const key = await keyFor(email);
  const today = Math.floor(now / DAY_MS);

  const raw = await store.get(key);
  // Corrupt content reads as "no attempts yet" rather than throwing. Failing open on a
  // counter is the right trade here: the alternative is a broken object locking a real
  // person out of signing up at all.
  let existing: EmailRecord | null = null;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as EmailRecord;
      if (typeof parsed?.day === "number" && typeof parsed?.count === "number") existing = parsed;
    } catch {
      existing = null;
    }
  }
  const used = existing && existing.day === today ? existing.count : 0;

  if (used >= MAX_SIGNUPS_PER_DAY) {
    return { allowed: false, used: MAX_SIGNUPS_PER_DAY };
  }

  const count = used + 1;
  // Spread, not rebuilt. This used to write `{day, count, slugs}` literally, which silently
  // dropped every other field on the record: the moment a second counter landed beside it, a
  // signup would have reset it.
  await store.put(
    key,
    JSON.stringify(
      {
        ...(existing ?? {}),
        day: today,
        count,
        slugs: existing?.slugs ?? [],
      } satisfies EmailRecord,
    ),
  );
  return { allowed: true, used: count };
}

/**
 * Take one manage-link slot for this address today.
 *
 * `POST /api/hantera` was the one mail-sending endpoint with no cap. Signup has
 * `claimSignupSlot`, the relay has its daily cap, code creation has `MAX_CODES_PER_EMAIL`, and
 * this had only the proof of work. That is worse than the signup hole it resembles rather than
 * better: the mail goes to a *confirmed* owner and carries a live 30-minute token reaching every
 * code they own, so a flood is both more credible to the reader and more valuable to the sender.
 *
 * Races exactly as the signup cap does, and for the same reason: there is no compare-and-swap in
 * this store. The point is to turn unbounded into bounded, not to be exact. See status.md on R8.
 */
export async function claimManageLinkSlot(
  store: ObjectStore,
  hash: string,
  now: number = Date.now(),
): Promise<{ allowed: boolean; used: number }> {
  // Not a hash means not an address we issued, and must never become a storage key.
  if (!isHash(hash)) return { allowed: false, used: MAX_MANAGE_LINKS_PER_DAY };

  const key = keyForHash(hash);
  const today = Math.floor(now / DAY_MS);

  const raw = await store.get(key);
  let existing: EmailRecord | null = null;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as EmailRecord;
      if (typeof parsed?.day === "number") existing = parsed;
    } catch {
      // Corrupt reads as "no attempts yet", the same trade `claimSignupSlot` makes: a broken
      // object must not lock an owner out of their own controls.
      existing = null;
    }
  }

  // An address with no record at all has never signed up, so there is nothing to mail about.
  // Answering "not allowed" here costs an honest owner nothing and saves a write per probe.
  if (existing === null) return { allowed: false, used: 0 };

  const used = existing.lankDag === today ? (existing.lankAntal ?? 0) : 0;
  if (used >= MAX_MANAGE_LINKS_PER_DAY) return { allowed: false, used };

  const lankAntal = used + 1;
  await store.put(key, JSON.stringify({ ...existing, lankDag: today, lankAntal }));
  return { allowed: true, used: lankAntal };
}

/** Record that a code belongs to this address, once the code exists. */
export async function linkCodeToEmail(
  store: ObjectStore,
  email: string,
  slug: string,
): Promise<void> {
  const key = await keyFor(email);
  const raw = await store.get(key);

  let record: EmailRecord = { day: 0, count: 0, slugs: [] };
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as EmailRecord;
      if (typeof parsed?.day === "number") record = parsed;
    } catch {
      // A corrupt counter must not stop a code being reachable by its owner.
    }
  }

  const slugs = record.slugs ?? [];
  if (!slugs.includes(slug)) slugs.push(slug);
  await store.put(key, JSON.stringify({ ...record, slugs }));
}

/**
 * Stop a code belonging to this address.
 *
 * The daily signup count is deliberately left alone. It is a rate limit on the address, not a
 * property of the codes, and clearing it here would turn "change your address twice" into a way
 * to mint more codes than the cap allows.
 *
 * Silent about codes and addresses it has never seen: this runs as one half of a move, and the
 * half that matters is the link to the new address.
 */
export async function unlinkCodeFromEmail(
  store: ObjectStore,
  email: string,
  slug: string,
): Promise<void> {
  const key = await keyFor(email);
  const raw = await store.get(key);
  if (raw === null) return;

  let record: EmailRecord;
  try {
    const parsed = JSON.parse(raw) as EmailRecord;
    if (typeof parsed?.day !== "number") return;
    record = parsed;
  } catch {
    return;
  }

  const slugs = (record.slugs ?? []).filter((one) => one !== slug);
  await store.put(key, JSON.stringify({ ...record, slugs }));
}

/**
 * Which codes belong to this address. Empty when the address is unknown to us.
 *
 * Every entry is validated on the way out, because this is storage and storage is not trusted.
 * `shirts.ts` keeps the same rule in `parseRecord` for the same reason: callers feed these
 * straight into `getCode`, which builds a storage key and throws on anything that is not a
 * slug. Handing back one bad entry therefore did not lose one code, it threw out of the
 * request and lost every code the address owns, on every attempt, for as long as the object
 * sat there. A garbled entry is not worth someone's access to their own controls, so it is
 * dropped and the rest are returned.
 */
export async function codesForEmail(store: ObjectStore, email: string): Promise<string[]> {
  return await codesForEmailHash(store, await emailHash(email));
}

/**
 * The same read, for a caller holding the hash rather than the address.
 *
 * That caller is the manage flow: a `koder` token carries the hash, and the page and every action
 * behind it resolve their set of codes through here. A value that is not a hash reads as no codes
 * rather than building a storage key from it, on the rule the rest of this repo follows after two
 * outages caused by exactly that: validate at the boundary the value arrived through.
 */
export async function codesForEmailHash(store: ObjectStore, hash: string): Promise<string[]> {
  if (!isHash(hash)) return [];

  const raw = await store.get(keyForHash(hash));
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as EmailRecord;
    if (!Array.isArray(parsed?.slugs)) return [];
    return parsed.slugs.filter((slug): slug is string =>
      typeof slug === "string" && isValidSlug(slug)
    );
  } catch {
    return [];
  }
}
