/**
 * The Bunny Edge Script. This is production.
 *
 * A middleware in front of a Pull Zone: `onOriginRequest` gets every request before the CDN
 * does. Returning a `Response` answers it here; returning the request lets it fall through to
 * the Storage Zone, which is where the stylesheet, the script and the fonts live. So the
 * dynamic routes are handled in this isolate and every static byte is served by the CDN
 * without waking it.
 *
 * The routing table is imported, not restated. `src/route.ts` is the same module the dev server
 * runs, which is the only way to be sure that what was driven on a laptop is what a stranger
 * meets on their phone. A second copy here would diverge on the first route somebody forgot.
 *
 * Two things happen once, at cold start, and they fail differently on purpose:
 *
 *  - `loadConfig` refuses to run without every secret, fatally. A missing ALTCHA key would
 *    otherwise import an empty HMAC secret quite happily and leave the proof of work forgeable.
 *  - `assertDeleteSemantics` proves the storage really gives single-use deletes. Bunny does not
 *    document what DELETE returns for a missing object, and the entire ownership model rests on
 *    that answer. It is started here and awaited by `delete` rather than by the isolate, so a
 *    store that cannot vouch for itself refuses verification, proof of work and deletion while
 *    the pages a stranger scanned keep answering. See `deleteAfter`. It used to block the first
 *    byte of every response, which put three storage round trips in front of a landing page that
 *    deletes nothing, and turned one bad boot into a total outage.
 *
 * Deno on Bunny is 1.x, older than the toolchain here. That is why nothing in `src/` uses
 * Deno-2-only syntax and every WebCrypto call goes through `asBuffer` in `store/crypto.ts`.
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { contactCodeProblem, importEmailKey, loadConfig, missingEnv } from "../src/config.ts";
import { assertDeleteSemantics, createBunnyStore, deleteAfter } from "../src/store/bunny.ts";
import { json } from "../src/handlers/context.ts";
import type { AppContext } from "../src/handlers/context.ts";
import { route } from "../src/route.ts";
import { setMailBaseUrl } from "../src/mail/templates.ts";
import { getCode } from "../src/store/shirts.ts";
import { setContactCode } from "../src/pages/layout.ts";
import { error, errorFields, info, warn } from "../src/log.ts";

/**
 * Built once per isolate rather than per request.
 *
 * A failure here must not be cached as a working context, so the promise is thrown away on
 * rejection and the next request tries again. Otherwise a transient storage blip at cold start
 * would poison the isolate for its whole life.
 */
let starting: Promise<AppContext> | null = null;

function start(): Promise<AppContext> {
  if (starting) return starting;

  starting = (async () => {
    const env = Deno.env.toObject();

    // Checked before loadConfig so a first deploy learns about the storage variables and the
    // application ones in the same breath, rather than one redeploy at a time. Three separate
    // names, deliberately: there is no combined BUNNY_STORAGE.
    const missing = missingEnv(env, ["BUNNY_STORAGE_ZONE", "BUNNY_STORAGE_KEY"]);
    if (missing.length > 0) {
      throw new Error(
        `missing required environment variable${missing.length > 1 ? "s" : ""}: ` +
          `${missing.join(", ")}. BUNNY_STORAGE_HOST is optional and defaults to ` +
          `storage.bunnycdn.com, which is wrong for a regional zone.`,
      );
    }

    const loaded = loadConfig(env);

    const raw = createBunnyStore({
      zone: env.BUNNY_STORAGE_ZONE!,
      accessKey: env.BUNNY_STORAGE_KEY!,
      host: env.BUNNY_STORAGE_HOST ?? "storage.bunnycdn.com",
    });

    // Started here, awaited only by the deletes that depend on it. See `deleteAfter`: this used
    // to block the first byte of every response with a put and two deletes, including responses
    // that never delete anything.
    const probe = assertDeleteSemantics(raw);
    // Nothing must be able to reach the unguarded store by accident, so the guarded one takes
    // the name and the raw one is only ever handed to the probe above.
    const store = deleteAfter(raw, probe);

    // Images in mail follow this deploy rather than always pointing at production.
    setMailBaseUrl(loaded.config.baseUrl);
    // Checked against storage, not just validated. A well-formed code that does not exist
    // puts a broken image in the footer of every page on the site, forever, and a footer
    // decoration must never be able to do that. Dropped with a log line instead.
    const kontakt = loaded.config.kontaktKod ?? null;
    // Set, but not to a code. `loadConfig` drops it so it can never reach a storage key again,
    // and this says which way it was wrong, because silence would leave a typo looking like a
    // working deploy and "malformed" alone never said whether it was blank, lowercase or spaced.
    const problem = contactCodeProblem(env.OJHEJ_KONTAKT_KOD);
    if (problem) {
      warn("contact code is not a valid code, footer QR disabled", problem);
    }
    // The lookup and the key import run together: one is a network round trip and the other is
    // CPU, and they need nothing from each other. Sequential, this was the round trip plus the
    // import in front of every cold response.
    const [kontaktFinns, emailKey] = await Promise.all([
      kontakt !== null && await getCode(store, kontakt, Date.now()) !== null,
      importEmailKey(loaded.emailKeyRaw),
    ]);
    if (kontakt !== null && !kontaktFinns) {
      warn("contact code not found, footer QR disabled", { reason: "no-code" });
    }
    setContactCode(kontaktFinns ? kontakt : null);

    // Deliberately not awaited. A rejection here is caught by whichever delete waits on it, and
    // an unhandled rejection would otherwise be reported against the isolate rather than the
    // request that needed the guarantee.
    probe.catch((cause) => {
      error("delete semantics probe failed", errorFields(cause));
    });

    info("edge script started", { baseUrl: loaded.config.baseUrl });

    return {
      store,
      emailKey,
      config: loaded.config,
      fetch: globalThis.fetch,
      now: () => Date.now(),
    };
  })().catch((cause) => {
    starting = null;
    throw cause;
  });

  return starting;
}

/**
 * The path, and deliberately never the query string.
 *
 * `/verifiera?t=...` and `/hantera?t=...` carry a live single-use token. Logging `request.url`
 * would write those tokens into a log pane that outlives them, which is the same mistake as
 * mailing them to a third party.
 */
function pathOf(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "(unparseable)";
  }
}

async function onRequest(context: { request: Request }): Promise<Request | Response> {
  const request = context.request;

  /**
   * The cold start gets its own catch, because "this isolate never came up" and "this handler
   * threw" call for completely different responses and used to read identically in the log.
   *
   * A failure here means a missing secret or an unreadable key: every request to this isolate
   * answers 500 until one boots cleanly, so the line says so rather than leaving it to be
   * inferred. A failed delete probe no longer lands here, by design; it surfaces on the first
   * request that tries to spend a token, which is the only kind that depended on it.
   */
  let ctx: AppContext;
  try {
    ctx = await start();
  } catch (cause) {
    error("cold start failed", { path: pathOf(request), ...errorFields(cause) });
    return json({ fel: "Något gick fel." }, 500);
  }

  try {
    const response = await route(ctx, request);

    // Not one of ours: hand the request back and let the CDN serve it from the Storage Zone.
    if (!response) return request;
    return response;
  } catch (cause) {
    // Fail closed, and never leak a stack, a key name or a storage path to the client. The stack
    // goes to the log, where it is the difference between a fix and an afternoon.
    error("unhandled", {
      method: request.method,
      path: pathOf(request),
      ...errorFields(cause),
    });
    return json({ fel: "Något gick fel." }, 500);
  }
}

/**
 * The one cast in this file, and it is a typing seam rather than a hidden problem.
 *
 * The SDK declares the middleware as returning `Promise<Request> | Promise<Response>`, which no
 * `async` function can satisfy: an async function returns `Promise<Request | Response>`, and
 * those are different types. Returning either is exactly what the SDK documents and supports,
 * so the behaviour is right and only the declaration cannot express it.
 */
BunnySDK.net.http.servePullZone().onOriginRequest(
  onRequest as (context: { request: Request }) => Promise<Response>,
);
