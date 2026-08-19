/**
 * Small pieces of Swedish that more than one surface needs to say the same way.
 *
 * Two places count codes out loud: the management page and the mail that links to it. They are
 * describing the same set of things to the same person minutes apart, so "alla tre" in one and
 * "3 st" in the other reads as two systems talking.
 */

/** Nothing here counts past ten, because ten codes is the cap. */
const RAKNEORD = ["noll", "en", "två", "tre", "fyra", "fem", "sex", "sju", "åtta", "nio", "tio"];

/** The number as a person would say it, falling back to digits above the cap. */
export function rakneord(antal: number): string {
  return RAKNEORD[antal] ?? String(antal);
}

/** Capitalised, for the start of a sentence. */
export function Rakneord(antal: number): string {
  const ord = rakneord(antal);
  return ord.charAt(0).toUpperCase() + ord.slice(1);
}

const MANADER = [
  "jan",
  "feb",
  "mar",
  "apr",
  "maj",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
];

/**
 * "12 aug", which is how a date is written when it is a detail rather than a fact.
 *
 * The year is left off deliberately: this appears next to a code somebody made recently, and the
 * one place a full date matters is the record itself, which nobody is reading.
 */
export function kortDatum(millis: number): string {
  const date = new Date(millis);
  return `${date.getUTCDate()} ${MANADER[date.getUTCMonth()]}`;
}

/** "1 meddelande" against "4 meddelanden", which Swedish will not let you fudge. */
export function meddelanden(antal: number): string {
  return antal === 1 ? "1 meddelande" : `${antal} meddelanden`;
}
