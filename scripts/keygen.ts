// deno-lint-ignore-file no-console
// A CLI whose entire output is meant to be pasted into a .env file.

/**
 * Mints the two secrets .env needs.
 *
 * Both come from crypto.getRandomValues rather than anything convenient, for the same
 * reason the slug does: a secret generated from a weak source is worse than no secret,
 * because it looks exactly like a real one.
 *
 * Usage:  deno task keygen
 */

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const emailKey = base64(crypto.getRandomValues(new Uint8Array(32)));
const altchaHmac = base64(crypto.getRandomValues(new Uint8Array(32)))
  .replaceAll("+", "")
  .replaceAll("/", "")
  .replaceAll("=", "");

console.log(`
Two secrets, both 256 bits from crypto.getRandomValues.

Locally, paste into .env:

OJHEJ_EMAIL_KEY=${emailKey}
OJHEJ_ALTCHA_HMAC=${altchaHmac}

In production, paste the values into the bunny.net dashboard under
Edge Platform > Scripting > your script > Env Configuration > Environment Secrets.
Add them one at a time and click Save Secret for each. A secret cannot be read back
afterwards, only replaced.

OJHEJ_EMAIL_KEY protects stored addresses. Change it and every address already stored
becomes unreadable, so rotating it is a migration, not a config edit. Use a different
key in production than locally, and never commit either.
`);
