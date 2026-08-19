/**
 * The cheap layers: a field bots cannot resist, and a clock they cannot beat.
 *
 * Neither is strong alone. Together with unguessable slugs, ALTCHA's proof of work and the
 * per-code daily cap, they make the endpoints tedious enough not to be worth farming. See
 * specs/ojhej/research-2026-08-12-altcha.md for why the defence is layered rather than one
 * strong wall: Cloudflare is out on EU grounds and per-IP limiting is a paid Bunny tier.
 */

/** Reading a page, deciding to write to a stranger and typing it takes longer than this. */
export const MIN_FILL_MS = 2_500;

/** A form open for a day is a parked tab or a harvested token, not a person mid-thought. */
export const MAX_FILL_MS = 24 * 3600_000;

export type FormRejection = "honeypot" | "too-fast" | "stale" | "bad-timing";

export interface FormSignals {
  /** A field hidden from humans. Anything in it came from something automated. */
  honeypot: string;
  /** When the form was rendered, in epoch ms. */
  startedAt: number;
}

/**
 * Returns null when the submission looks human, otherwise the reason it does not.
 * A reason is returned rather than thrown because the caller answers every rejection
 * identically: the user must never learn which layer caught them.
 */
export function guardForm(signals: FormSignals, now: number = Date.now()): FormRejection | null {
  // Checked first and cheapest. A bot that fills hidden fields is not worth timing.
  if (signals.honeypot.trim() !== "") return "honeypot";

  if (!Number.isFinite(signals.startedAt) || signals.startedAt <= 0) return "bad-timing";

  const elapsed = now - signals.startedAt;
  if (elapsed < MIN_FILL_MS) return "too-fast";
  if (elapsed > MAX_FILL_MS) return "stale";

  return null;
}
