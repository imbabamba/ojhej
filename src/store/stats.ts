/**
 * How many codes have come to life, for the one number shown on the landing page.
 *
 * A counter object, because the alternative is counting `shirts/` and there is no way to do
 * that: `ObjectStore` has no `list`, deliberately, and that absence is what makes a
 * cross-tenant read impossible to write rather than merely unwritten. A vanity figure is not a
 * good enough reason to open that door.
 *
 * **This counter races, and that is fine.** Two activations in the same instant can both read
 * the same value and write the same increment, losing one. Bunny Storage offers no
 * compare-and-swap, so the only way to make a counter exact is a compare-and-swap that does not
 * exist. The difference from the signup cap, which races the same way, is what a wrong answer
 * costs: there it was a mail bomb, here it is a number on a page being one short. It never
 * gates anything.
 *
 * Counted at activation, not at signup. An unverified code is a form somebody abandoned, and
 * counting those would inflate the figure with people who never arrived. It is also never
 * decremented on delete: "sedan start" is a cumulative total and pretending otherwise would be
 * a stranger claim than the honest one.
 */

import type { ObjectStore } from "./storage.ts";

const KEY = "stats/koder.json";

interface StatsRecord {
  /** Codes that have been activated since the counter started. */
  aktiverade: number;
}

function parse(raw: string | null): StatsRecord {
  if (raw === null) return { aktiverade: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<StatsRecord>;
    // A corrupt or truncated counter reads as zero rather than throwing. Nothing depends on
    // this number, so it must never be able to break a page or a signup.
    return typeof parsed?.aktiverade === "number" && Number.isFinite(parsed.aktiverade)
      ? { aktiverade: Math.max(0, Math.floor(parsed.aktiverade)) }
      : { aktiverade: 0 };
  } catch {
    return { aktiverade: 0 };
  }
}

/**
 * Count one more activated code.
 *
 * Never throws. This runs on the verification path, and a failed counter write must not be able
 * to stop somebody's code coming to life over a number nobody is waiting for.
 */
export async function countActivation(store: ObjectStore): Promise<void> {
  try {
    const current = parse(await store.get(KEY));
    await store.put(KEY, JSON.stringify({ aktiverade: current.aktiverade + 1 }));
  } catch {
    // Deliberately silent. See above.
  }
}

/** How many codes have been activated, or null if the number cannot be read right now. */
export async function readActivations(store: ObjectStore): Promise<number | null> {
  try {
    const raw = await store.get(KEY);
    // Never written yet is a real answer of zero, not a failure.
    return parse(raw).aktiverade;
  } catch {
    return null;
  }
}

/**
 * The same figure, read at most once a minute per isolate.
 *
 * The landing page is the most requested page on the site, and a storage read on every render
 * would put a network round trip in front of the first thing anybody sees, for a number that
 * changes a few times a day. A minute stale is invisible to a reader and free to us.
 *
 * Cached per isolate, so several edge nodes can hold slightly different values. Nobody is
 * comparing.
 */
let cached: { value: number | null; at: number } | null = null;

/** How long a cached figure stays good. */
export const STATS_TTL_MS = 60_000;

export async function readActivationsCached(
  store: ObjectStore,
  now: number = Date.now(),
): Promise<number | null> {
  if (cached && now - cached.at < STATS_TTL_MS) return cached.value;

  const value = await readActivations(store);
  cached = { value, at: now };
  return value;
}

/** Tests share an isolate, so they need to be able to forget. */
export function forgetCachedActivations(): void {
  cached = null;
}

/**
 * Below this the figure is hidden rather than shown.
 *
 * It was ten, on the reasoning that "1 kod skapad sedan start" reads as nobody being here, on
 * the page whose job is to suggest otherwise, and that ten would arrive within the first
 * evening if the thing worked at all. It did not. Production sat under ten and the corner was
 * empty for every visitor, which is the one outcome a folio cannot survive: the argument for
 * hiding a small number assumes a large one turns up to replace it.
 *
 * So it is one. Zero and unreadable are still hidden, because "0 koder skapade" is the sentence
 * the old floor was really written against, and it is the only one that says nobody is here
 * while claiming to count. Everything above it is a true thing about the site, and a true small
 * number read in the corner is worth more than a blank the reader never knows was there.
 *
 * The copy agrees with the number, so one code reads "1 kod skapad" rather than "1 koder
 * skapade". See `renderLanding`.
 */
export const STATS_FLOOR = 1;
