/**
 * Everything a handler is allowed to reach.
 *
 * Passed in rather than imported, so tests drive real code paths with a memory store, a
 * stubbed fetch and a clock they control, and so no handler can quietly acquire a
 * dependency the tests do not know about. `now` is a function because a request that spans
 * a day boundary should read the clock when it needs it, not when the context was built.
 */

import type { Smtp2goConfig } from "../mail/smtp2go.ts";
import type { ObjectStore } from "../store/storage.ts";

export interface AppConfig {
  /** Origin the service is served from, with no trailing slash. */
  baseUrl: string;
  /**
   * Our own code, for the footer QR. Optional: without it the footer simply has no QR, which
   * is what a local run and a preview deploy both want.
   */
  kontaktKod?: string;
  altchaHmacKey: string;
  smtp2go: Smtp2goConfig;
}

export interface AppContext {
  store: ObjectStore;
  /** AES-GCM key for the owner address at rest. */
  emailKey: CryptoKey;
  config: AppConfig;
  fetch: typeof fetch;
  now(): number;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * The single response every anti-abuse layer returns. Identical status and body whether the
 * honeypot was filled, the clock looked wrong or the proof of work failed, so a bot cannot
 * tell which wall it hit and tune around it.
 */
export function refuse(): Response {
  return json({ fel: "Det gick inte att skicka just nu. Försök igen." }, 400);
}

/**
 * R19. A 405 with no `Allow` header tells a client it guessed wrong without telling it what
 * would have worked, which the HTTP spec calls a MUST and every debugging session calls rude.
 */
export function methodNotAllowed(allow: string[]): Response {
  return new Response(JSON.stringify({ fel: "Fel metod." }), {
    status: 405,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "allow": allow.join(", "),
    },
  });
}
