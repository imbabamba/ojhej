/**
 * What a code is for.
 *
 * One choice, two consequences: the text printed above the code, and the line a stranger reads
 * on the scan page before the form. A lost bag, a market stall and someone on a bus all want the
 * same relay and none of them want the same sentence in front of it.
 *
 * The record stores the **key**, never the finished sentence. That is what lets a preset be
 * reworded later without rewriting anybody's code, and it is why `radFor` reads the preset for
 * every purpose except `eget`, which is the only one whose words belong to the owner.
 *
 * Nothing here imports the record type, deliberately: `shirts.ts` validates against this module,
 * so the dependency has to point one way.
 */

import { DEFAULT_LABEL, MAX_LABEL } from "./qr/layout.ts";

export type SyfteKey = "hej" | "borttappat" | "fest" | "verksamhet" | "eget";

export interface Syfte {
  /** What the owner sees this called, in the picker and in the code list. */
  namn: string;
  /** What gets printed above the code when this purpose is picked. */
  etikett: string;
  /** What a stranger reads on the scan page. Empty leaves that page exactly as it was. */
  rad: string;
}

/**
 * The order the picker shows them in, and the order this file should be read in: the ordinary
 * case first, the three that needed a reason for existing next, and the escape hatch last.
 */
export const SYFTE_ORDER: readonly SyfteKey[] = [
  "hej",
  "borttappat",
  "fest",
  "verksamhet",
  "eget",
];

export const SYFTEN: Record<SyfteKey, Syfte> = {
  // The empty line is not an oversight. It is what makes the core case render byte for byte as
  // it did before this feature existed, so breadth costs nothing where it is not used.
  hej: { namn: "Ett hej", etikett: DEFAULT_LABEL, rad: "" },
  borttappat: {
    namn: "Borttappat",
    etikett: "HITTAT?",
    rad: "Den här kom bort. Skriv så hämtar jag den.",
  },
  fest: {
    namn: "Fest",
    etikett: "SÄG HEJ",
    rad: "Vi är på samma fest. Det räcker som anledning.",
  },
  verksamhet: {
    namn: "Verksamhet",
    etikett: "HEJ",
    rad: "Undrar du något? Skriv så svarar jag.",
  },
  eget: { namn: "Eget", etikett: "", rad: "" },
};

export const DEFAULT_SYFTE: SyfteKey = "hej";

/**
 * One sentence, and short enough to be read at a glance by someone holding a phone in front of
 * a stranger's jacket. The cap is also what keeps the scan page from becoming a place to publish.
 */
export const MAX_RAD = 90;

export function isSyfte(value: unknown): value is SyfteKey {
  return typeof value === "string" && Object.hasOwn(SYFTEN, value) &&
    (SYFTE_ORDER as readonly string[]).includes(value);
}

/** Just enough of a record to answer. Structural, so this module stays a leaf. */
interface HasSyfte {
  syfte?: string;
  rad?: string;
  etikett?: string;
}

/**
 * The purpose a record actually has.
 *
 * Anything unrecognised reads as the default rather than throwing, on the same rule the rest of
 * the store follows: stored content is not trusted, and a value written by a later version must
 * not be able to reach a template.
 */
export function syfteOf(record: HasSyfte): SyfteKey {
  return isSyfte(record.syfte) ? record.syfte : DEFAULT_SYFTE;
}

/** The line a stranger reads. Empty means the scan page says what it has always said. */
export function radFor(record: HasSyfte): string {
  const syfte = syfteOf(record);
  if (syfte !== "eget") return SYFTEN[syfte].rad;
  return typeof record.rad === "string" ? record.rad.trim() : "";
}

/**
 * What actually gets printed above the code.
 *
 * A record that has never been designed carries no label, and takes its purpose's. A record
 * carrying an empty one is an owner who removed the text, and gets exactly that.
 */
export function etikettFor(record: HasSyfte): string {
  return typeof record.etikett === "string" ? record.etikett : SYFTEN[syfteOf(record)].etikett;
}

/**
 * What a code is called in a list of codes.
 *
 * The printed text, because that is how an owner tells their codes apart in a drawer: the one
 * that says HITTAT? is the one on the bag. A code printed with nothing above it still has to be
 * called something, and naming it by its slug would put a working address in a mail.
 */
export function visningsnamn(record: HasSyfte): string {
  return etikettFor(record) || "Utan text";
}

/** What an owner may store. Both strings are theirs, so both are washed before they land. */
export interface Design {
  syfte: SyfteKey;
  /** Empty for every preset. Only `eget` has words of its own. */
  rad: string;
  /** Empty means the code prints with nothing above it, which is a choice people make. */
  etikett: string;
}

/** LINE SEPARATOR and PARAGRAPH SEPARATOR, by number rather than by character. */
const SEPARATORS = new Set([0x2028, 0x2029]);

/**
 * One space, no line breaks, no control characters, nothing at either end.
 *
 * Written as code points on purpose. A literal U+2028 inside a regex literal terminates the
 * regex, because it is a line terminator to the JavaScript parser, and one has already hidden
 * inside a string in this repo where it read as an ordinary space (see status.md). Naming them
 * by number is the one form that cannot masquerade as anything.
 *
 * Both fields need it: one is rendered into HTML and the other into an SVG this service
 * generates, and neither wants a line break the owner did not ask for.
 */
function oneLine(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const separator = code < 0x20 || code === 0x7f || SEPARATORS.has(code) ||
      /\s/u.test(character);
    out += separator ? " " : character;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/**
 * A label, washed and bounded, wherever it came from.
 *
 * `cleanDesign` applies this to what an owner saves. `/api/qr/*.svg?text=` needed the same rule
 * and did not have it, so the stored label was capped at MAX_LABEL and one line while the
 * rendered one was neither: a URL on our own origin served arbitrary text of arbitrary length
 * as an image. Truncating rather than refusing, because this path has always had a fallback
 * rather than an error, and a print that is too long is a worse answer than a shorter one.
 */
export function cleanLabel(value: string): string {
  return oneLine(value).slice(0, MAX_LABEL);
}

/**
 * Validate what an owner sent into something storable, or refuse it.
 *
 * Refusing rather than truncating is deliberate for both fields. A truncated line publishes half
 * a sentence the owner never wrote, on a stranger's screen, and a truncated label prints it on a
 * garment. Neither is a thing to discover afterwards.
 *
 * An absent label means "never chosen" and takes the preset's. An empty one means the owner
 * removed it, and survives as empty, because collapsing the two would silently reprint a label
 * they had deleted.
 */
export function cleanDesign(
  input: { syfte?: unknown; rad?: unknown; etikett?: unknown },
): Design | null {
  if (!isSyfte(input.syfte)) return null;
  const syfte = input.syfte;

  // The line belongs to `eget` alone. Every other purpose reads its words from the preset, so a
  // line sent with one is dropped rather than stored where nothing would ever render it.
  let rad = "";
  if (syfte === "eget" && input.rad !== undefined) {
    if (typeof input.rad !== "string") return null;
    rad = oneLine(input.rad);
    if (rad.length > MAX_RAD) return null;
  }

  let etikett = SYFTEN[syfte].etikett;
  if (input.etikett !== undefined) {
    if (typeof input.etikett !== "string") return null;
    etikett = oneLine(input.etikett);
    if (etikett.length > MAX_LABEL) return null;
  }

  return { syfte, rad, etikett };
}
