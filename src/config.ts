/**
 * Turning environment into a validated AppConfig, in one place.
 *
 * This exists because of R11 in status.md: without validation a missing
 * `OJHEJ_ALTCHA_HMAC` does not fail, it *fails open*. `hmacSha256Hex` will happily import
 * an empty string as a key and keep producing signatures, so proof-of-work verification
 * would go on "working" against a secret anybody can guess. A missing base URL is nearly as
 * bad in a different way: it mails `undefined/verifiera?t=...` to real people.
 *
 * So every value is required and checked at load, and load happens once per isolate rather
 * than per request. The only exception is dev mode, which mints throwaway values so the
 * service can be run locally with no secrets at all.
 */

import type { AppConfig } from "./handlers/context.ts";
import { importKey, isValidSlug, SLUG_LENGTH } from "./store/crypto.ts";

export interface LoadedConfig {
  config: AppConfig;
  emailKeyRaw: string;
}

/**
 * Minimal .env parser, for local development only.
 *
 * Hand-rolled rather than pulled from a library because the rules that matter here are few
 * and the failure modes are specific: a base64 key ends in `=` padding and a URL carries
 * `=` in its query string, so splitting on anything but the *first* equals corrupts both.
 * Malformed lines are skipped rather than thrown on, since a stray line in someone's local
 * file should not stop the server from starting.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;

    const equals = line.indexOf("=");
    if (equals <= 0) continue;

    const name = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();

    // Surrounding quotes are a convention for values with spaces; inner quotes are content.
    const quoted = value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);

    out[name] = value;
  }

  return out;
}

/**
 * Report every missing variable at once, not just the first one found.
 *
 * Failing on the first turns a first deploy into one redeploy per variable, each costing a
 * build and a cold start to learn a single name. Names only, never values: this message ends
 * up in a log.
 */
export function missingEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string[] {
  return names.filter((name) => !env[name]);
}

const REQUIRED = [
  "OJHEJ_BASE_URL",
  "OJHEJ_ALTCHA_HMAC",
  "OJHEJ_EMAIL_KEY",
  "OJHEJ_SMTP2GO_KEY",
  "OJHEJ_SENDER",
] as const;

/**
 * Optional, and optional has to keep meaning optional.
 *
 * Both entrypoints probe this code against storage at cold start, and `getCode` throws on an
 * invalid slug rather than returning null. That throw is right where it lives: reaching it
 * with a bad slug means validation was skipped upstream. Upstream here is a variable a human
 * typed into a dashboard, and nothing validated it, so a bad value was not a missing footer QR
 * but a script that refused to boot and answered every request with a 500.
 *
 * That is not hypothetical. On 2026-08-14 production served nothing but `unhandled` 500s
 * because the variable existed and was blank: `?? null` in the entrypoints catches `undefined`
 * and never `""`, so an empty string went the whole way into a storage key.
 *
 * Strict on case and length rather than forgiving, because `isValidSlug` is the same gate that
 * stands in front of every storage read, and a second, looser idea of "valid code" living here
 * is exactly how the two drift apart.
 */
function contactCode(raw: string | undefined): string | undefined {
  return raw !== undefined && isValidSlug(raw) ? raw : undefined;
}

export type ContactCodeProblem = "empty" | "whitespace" | "lowercase" | "length" | "characters";

/**
 * Why a contact code was rejected, rather than merely that it was.
 *
 * `warn("contact code is not a valid code", { reason: "malformed" })` was the whole diagnostic,
 * and blank, stray whitespace, lowercase and wrong length all produced that one identical line.
 * They are four different mistakes with four different fixes, and on 2026-08-15 one of these
 * warnings sat in the log while the footer QR rendered perfectly, with nothing in the line to say
 * whether it was current or what had actually been wrong.
 *
 * The reason and the length are both safe to log. A slug is public, it is printed on a garment,
 * and `log_test.ts` pins that slugs survive redaction. The length is what separates the cases at
 * a glance: 0 is a blank variable, 21 is a newline from a copy-paste, 20 with a failure is the
 * wrong characters. Note that the value itself must not be logged under a field name containing
 * "kontakt", which `log.ts` redacts.
 */
export function contactCodeProblem(
  raw: string | undefined,
): { reason: ContactCodeProblem; length: number } | null {
  // Not set at all is a choice rather than a mistake. No variable means no footer QR, on purpose.
  if (raw === undefined) return null;

  const length = raw.length;

  // Checked first, because this is the case that used to be silent. The guard read
  // `if (env.OJHEJ_KONTAKT_KOD && kontakt === null)`, and an empty string is falsy, so a variable
  // that existed and was blank warned about nothing: no QR, and no line saying why. A blank value
  // of this exact variable is what served nothing but 500s on 2026-08-14.
  if (length === 0) return { reason: "empty", length };

  // Before the validity check, so "the code is right and has a newline stuck to it" is not
  // reported as bad characters. It is the likeliest mistake here and the easiest one to act on.
  if (raw.trim() !== raw) return { reason: "whitespace", length };

  if (isValidSlug(raw)) return null;

  // Its own reason, because the fix is the shift key rather than a new code.
  if (isValidSlug(raw.toUpperCase())) return { reason: "lowercase", length };

  if (length !== SLUG_LENGTH) return { reason: "length", length };

  return { reason: "characters", length };
}

export function loadConfig(env: Record<string, string | undefined>): LoadedConfig {
  const missing = missingEnv(env, REQUIRED);
  if (missing.length > 0) {
    throw new Error(
      `missing required environment variable${missing.length > 1 ? "s" : ""}: ` +
        `${missing.join(", ")}. Each is a separate variable; there is no combined one.`,
    );
  }

  const baseUrl = env.OJHEJ_BASE_URL!.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error("OJHEJ_BASE_URL must be an absolute http(s) URL");
  }

  const altchaHmacKey = env.OJHEJ_ALTCHA_HMAC!;
  if (altchaHmacKey.length < 16) {
    throw new Error("OJHEJ_ALTCHA_HMAC must be at least 16 characters");
  }

  return {
    emailKeyRaw: env.OJHEJ_EMAIL_KEY!,
    config: {
      baseUrl,
      altchaHmacKey,
      // Optional everywhere. A missing or malformed value means no footer QR, never a broken one.
      kontaktKod: contactCode(env.OJHEJ_KONTAKT_KOD),
      smtp2go: {
        apiKey: env.OJHEJ_SMTP2GO_KEY!,
        // A variable rather than a secret on Bunny, because the EU account may use a
        // different hostname and that question is still open. See plan.md task 7.6.
        baseUrl: env.OJHEJ_SMTP2GO_URL ?? "https://api.smtp2go.com/v3",
        sender: env.OJHEJ_SENDER!,
      },
    },
  };
}

/** Validates eagerly, so a bad key fails at startup rather than on someone's first signup. */
export async function importEmailKey(raw: string): Promise<CryptoKey> {
  try {
    return await importKey(raw);
  } catch (cause) {
    throw new Error(`OJHEJ_EMAIL_KEY is not a usable AES-256 key: ${cause}`);
  }
}

function randomKey(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of random) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Config for local runs. Never reachable in production: main.ts requires --dev.
 *
 * Prefers anything the environment actually provides and only invents what is missing.
 * That matters most for the AES key: an earlier version minted a fresh one on every boot,
 * which meant every stored address became undecryptable the moment the server restarted,
 * and the first symptom was a 502 on the message relay with "Decryption failed". Rotating
 * that key is a migration, not a config change, and dev is no exception.
 */
export function devConfig(
  port: number,
  env: Record<string, string | undefined> = {},
): LoadedConfig & { ephemeralKey: boolean } {
  const emailKeyRaw = env.OJHEJ_EMAIL_KEY || randomKey();

  return {
    emailKeyRaw,
    // Signals to the caller that stored data will not survive a restart, so it can say so.
    ephemeralKey: !env.OJHEJ_EMAIL_KEY,
    config: {
      baseUrl: env.OJHEJ_BASE_URL?.replace(/\/+$/, "") || `http://localhost:${port}`,
      kontaktKod: contactCode(env.OJHEJ_KONTAKT_KOD),
      altchaHmacKey: env.OJHEJ_ALTCHA_HMAC || "dev-only-altcha-secret-not-for-production",
      smtp2go: {
        apiKey: env.OJHEJ_SMTP2GO_KEY || "dev-no-real-key",
        baseUrl: env.OJHEJ_SMTP2GO_URL || "https://api.smtp2go.com/v3",
        sender: env.OJHEJ_SENDER || "Oj hej <hej@ojhej.se>",
      },
    },
  };
}
