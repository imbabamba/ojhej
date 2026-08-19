/**
 * Email validation, kept deliberately strict rather than RFC-complete.
 *
 * This address is the only personal data the service holds, it goes into a mail header, and
 * it is the thing an attacker would love to bend. Rejecting a handful of exotic but legal
 * addresses is a far cheaper mistake than accepting one that carries a newline.
 */

const MAX_LENGTH = 254;
const MAX_LOCAL = 64;

/**
 * No whitespace anywhere, exactly one @, a local part that does not start or end with a dot,
 * and a domain with at least one dot and a real TLD.
 */
const PATTERN = /^[^\s@.][^\s@]*(?<!\.)@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/iu;

/**
 * Returns the address in its canonical form, or null if it is not one we will accept.
 * Callers must treat null as "reject", never as "use the original".
 */
export function normalizeEmail(candidate: string): string | null {
  // Trimming happens before validation, but a line break is never merely whitespace here:
  // an address that contained one is hostile, not untidy, so it is refused outright.
  if (/[\r\n\t]/.test(candidate)) return null;

  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) return null;

  // No internal whitespace survives. Surrounding whitespace was already trimmed above.
  if (/\s/.test(trimmed)) return null;

  const at = trimmed.indexOf("@");
  if (at < 0 || trimmed.indexOf("@", at + 1) !== -1) return null;
  if (at > MAX_LOCAL) return null;

  const lowered = trimmed.toLowerCase();
  return PATTERN.test(lowered) ? lowered : null;
}

/**
 * The address as the management page shows it: `an•••@exempel.se`.
 *
 * Enough for the owner to recognise which mailbox they are looking at, and not enough for
 * somebody reading over their shoulder to learn one. The domain is kept whole, because that is
 * the half that says "this is my work address, not my private one", and it is rarely the secret.
 *
 * Returns null for anything that is not an address, so a caller cannot accidentally render a
 * half-masked something else.
 */
export function maskEmail(address: string): string | null {
  const normalised = normalizeEmail(address);
  if (!normalised) return null;

  const at = normalised.indexOf("@");
  const local = normalised.slice(0, at);
  const visible = local.slice(0, local.length > 2 ? 2 : 1);
  return `${visible}•••${normalised.slice(at)}`;
}
