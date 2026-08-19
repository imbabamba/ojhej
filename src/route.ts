/**
 * The routing table, and the only one there is.
 *
 * Both entry points read this: the dev server in `main.ts` and the Bunny edge script in
 * `edge/main.ts`. That is deliberate. A separate production routing table is the classic way
 * for a project to work perfectly in development and 404 on a route nobody remembered to copy,
 * and the failure shows up on a stranger's phone rather than in a test.
 *
 * Returning `null` means "not mine". The dev server then looks for a static file; the edge
 * script hands the request to the CDN. Nothing here knows or cares which.
 */

import { AppContext } from "./handlers/context.ts";
import { json } from "./handlers/context.ts";
import { handleSignup } from "./handlers/signup.ts";
import { handleVerify } from "./handlers/verify.ts";
import { handleEmailChange } from "./handlers/change.ts";
import { handleMessage } from "./handlers/message.ts";
import { handleManageAction, handleManageRequest } from "./handlers/manage.ts";
import { getCode, readOwnerEmail } from "./store/shirts.ts";
import { codesForEmailHash } from "./store/emails.ts";
import { maskEmail } from "./mail/address.ts";
import { cleanLabel, etikettFor } from "./syfte.ts";
import { isValidSlug } from "./store/crypto.ts";
import { renderKollaMailen, renderLanding, renderSkapa } from "./pages/signup.ts";
import { renderKlar, renderKlarFailed } from "./pages/klar.ts";
import { renderPdf } from "./qr/pdf.ts";
import { readActivationsCached } from "./store/stats.ts";
import { PUBLIC_ASSET } from "./assets.ts";
import { renderSvg } from "./qr/svg.ts";
import { renderHanteraLocked, renderKoder, renderRaderad } from "./pages/hantera.ts";
import { renderBytt } from "./pages/byt-epost.ts";
import { peekToken } from "./store/tokens.ts";
import {
  renderActive,
  renderPaused,
  renderPending,
  renderSent,
  renderUnknown,
} from "./pages/microsite.ts";
import { createChallenge, recordChallenge } from "./antispam/altcha.ts";
/** Same-origin redirect. Never built from user input, so it cannot become an open redirect. */
function seeOther(path: string): Response {
  return new Response(null, { status: 303, headers: { location: path } });
}

/**
 * The CDN must never keep a copy of anything answered here.
 *
 * Everything this module produces is either specific to one visitor, like a proof-of-work
 * challenge or a management page behind a token, or a page rendered from data that changes.
 * None of it is a file. A CDN caches on its own defaults when the origin expresses no opinion,
 * and on 2026-08-14 Bunny's default was thirty days: one challenge was handed to every visitor
 * until it expired, and signup and messaging both stopped working. See status.md.
 *
 * That was recorded as the zone overriding the script's `no-cache`, but the script had never
 * sent one, which is why correcting the zone did not hold. There was nothing to respect.
 *
 * Set at the one boundary both entrypoints share rather than in each handler, so a route added
 * later gets it without anyone remembering to ask. Same reason `spendSolution` is one function
 * rather than a verify and a claim a caller can do half of.
 */
/**
 * A year, which is the value that makes the header worth setting at all.
 *
 * No `preload` and no `includeSubDomains`. Preloading is a list baked into browser binaries and
 * getting off it takes months, and subdomains would commit hostnames that do not exist yet to
 * TLS this project has not issued. Both are one-way doors, and neither buys anything for a single
 * apex domain serving one site.
 */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * The one exception to `no-store`, and the reasoning for why it is safe to be one.
 *
 * The footer QR is on every page of the site and was uncacheable, so every page view cost an
 * isolate invocation and a storage read for a picture that is the same for everybody. It is
 * generated from a public slug printed on a garment: there is no visitor in it, no token, and no
 * secret. It is also deterministic, with no timestamp, nonce or random mask anywhere in the
 * renderer, so two isolates produce the same bytes.
 *
 * A day rather than a year, because the label and the panel are rendered into the file and an
 * owner who changes them should not wait out a long cache to see it. Every knob lives in the
 * query string, so this is only safe while the pull zone keeps the query string in the cache
 * key: without that, `?mm=40` and `?mm=180&platta=ja` collapse onto one entry and a print shop
 * is sent the wrong artwork. `scripts/smoke.ts` checks exactly that, and it is checked on
 * production rather than assumed, because the zone was misconfigured for it once already.
 */
const QR_CACHE_CONTROL = "public, max-age=86400";

export async function route(ctx: AppContext, request: Request): Promise<Response | null> {
  const response = await answer(ctx, request);
  // `null` is the static passthrough, and those files are the ones the CDN *should* keep.
  if (response === null) return null;

  // A default, not an override. The one handler allowed an opinion is the QR renderer, which
  // produces a picture of a public slug: no visitor in it, no token, no secret, byte-identical
  // for everybody and across isolates. Everything else gets `no-store` without having to ask,
  // which is the property this blanket exists for and the reason it is set here rather than in
  // each handler. `answer` must therefore never set this header on anything visitor-specific.
  if (!response.headers.has("cache-control")) {
    response.headers.set("cache-control", "no-store");
  }

  /**
   * The pull zone redirects plain HTTP, so this is not what gets a visitor onto TLS. It is what
   * stops the plaintext request from being made the next time, which is the part a 301 cannot do:
   * `/hantera?t=...` carries a single-use token in the query string, and by the time a redirect
   * answers it, that token has already crossed the network in the clear.
   */
  if (!isLocal(request)) {
    response.headers.set("strict-transport-security", `max-age=${HSTS_MAX_AGE_SECONDS}`);
  }

  return response;
}

/**
 * Whether this request came from a developer's own machine, which is the only place the header
 * must not go.
 *
 * The obvious rule was `new URL(request.url).protocol === "https:"`, and it was wrong in the way
 * that costs a deploy: this module runs as a Bunny middleware on the *origin* request rather than
 * the visitor's, so the protocol read `http:` for every real request and the header went out on
 * none of them. `cache-control` on the very same response arrived intact, which is what made it
 * confusing, and only the deploy gate caught it.
 *
 * A browser ignores HSTS on a plaintext response anyway (RFC 6797), so the scheme was never the
 * question. Not pinning `localhost` to HTTPS for a year is, because that outlives the checkout
 * that caused it and takes every other project on the same port with it.
 */
function isLocal(request: Request): boolean {
  const { hostname } = new URL(request.url);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" ||
    hostname === "::1";
}

async function answer(ctx: AppContext, request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname;

  // --- API ---
  if (path === "/api/altcha") {
    // Issued fresh per form load, and recorded so it can be spent exactly once. Recording is
    // what stops one solve being fired at a stranger's address in a burst, see R9 in status.md.
    const challenge = await createChallenge(ctx.config.altchaHmacKey, ctx.now());
    await recordChallenge(ctx.store, challenge, ctx.now());
    return json(challenge);
  }
  if (path === "/api/skapa") return await handleSignup(ctx, request);
  if (path === "/api/meddelande") return await handleMessage(ctx, request);
  if (path === "/api/hantera") return await handleManageRequest(ctx, request);
  if (path === "/api/hantera/atgard") return await handleManageAction(ctx, request);
  if (path === "/verifiera") return await handleVerify(ctx, request);
  // GET peeks and POST confirms, same prefetch-safe split as verification.
  if (path === "/byt-epost") return await handleEmailChange(ctx, request);

  if (path === "/health") return json({ ok: true });

  // The code itself, as print-ready vector. The slug comes from the path, so it is validated
  // before it is used to build either a storage key or a URL that goes into the file.
  const qr = path.match(/^\/api\/qr\/([^/]+)\.(svg|pdf)$/);
  if (qr) {
    const slug = decodeURIComponent(qr[1]!);
    const format = qr[2] as "svg" | "pdf";
    if (!isValidSlug(slug)) return json({ fel: "Okänd kod." }, 404);
    const record = await getCode(ctx.store, slug, ctx.now());
    if (!record) return json({ fel: "Okänd kod." }, 404);

    const params = new URL(request.url).searchParams;
    const sizeMm = Math.min(400, Math.max(20, Number(params.get("mm") ?? 180)));

    // Two knobs, and that is the whole design surface. There were once three shapes and a
    // colour picker; they were removed because a QR code is a machine-readable thing first and
    // every one of those settings traded scan reliability for decoration.
    const options = {
      sizeMm: Number.isFinite(sizeMm) ? sizeMm : 180,
      // The designer sends the text it is showing. Without one, the code prints what it was
      // saved as, so a link mailed months ago reproduces the file the owner actually ordered
      // rather than the default. An empty `?text=` is a choice and survives as one.
      //
      // Washed through the same rule a stored label goes through, rather than trusted because it
      // came from our own page. A query string is not our own page: unbounded, this served
      // arbitrary text of arbitrary length as an image from our origin, while a label the owner
      // actually saved was capped at MAX_LABEL and forced onto one line. Two rules for one
      // field is how the looser one gets found.
      label: cleanLabel(params.get("text") ?? etikettFor(record)),
      // A light panel is how a dark garment is served. Not white ink: inverted codes are read
      // by only 80 to 90 percent of scanners. See the print research.
      panel: params.get("platta") === "ja",
      mark: params.get("marke") !== "nej",
    };

    // `attachment` when the caller asks to download, so saving the file does not depend on a
    // browser honouring the `download` attribute, which not all of them do consistently. PDF is
    // always an attachment: nobody wants a print file taking over the tab.
    const download = params.get("ladda") !== null || format === "pdf";
    // The garment belongs in the name, and this header has to agree with the `download`
    // attribute on the link. When they disagree the saved name depends on which one the
    // browser honours, which is how a file ends up named after the wrong garment.
    const background = options.panel ? "svart" : "vit";
    const name = `ojhej-${slug}-${Math.round(sizeMm)}mm-${background}.${format}`;
    const disposition = `${download ? "attachment" : "inline"}; filename="${name}"`;

    // Both formats come off one shared layout, so a customer's download and anything a print
    // shop is sent are the same code by construction rather than by care.
    const target = `${ctx.config.baseUrl}/s/${slug}`;

    if (format === "pdf") {
      const { pdf } = renderPdf(target, options);
      return new Response(pdf.slice().buffer, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": disposition,
          "cache-control": QR_CACHE_CONTROL,
        },
      });
    }

    return new Response(renderSvg(target, options).svg, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "content-disposition": disposition,
        "cache-control": QR_CACHE_CONTROL,
      },
    });
  }

  // --- Real pages, rendered from real data ---

  // The scanned page. Rendered from the record, so what a stranger sees is the truth about
  // that code rather than a fixed design.
  const scanned = path.match(/^\/s\/([^/]+)$/);
  if (scanned) {
    const slug = decodeURIComponent(scanned[1]!);
    // Validated before it is ever used to build a storage key.
    if (!isValidSlug(slug)) return renderUnknown();

    const record = await getCode(ctx.store, slug, ctx.now());
    if (!record) return renderUnknown();
    // The slug goes with it so the footer can tell this is the page its own contact code
    // points at, and drop the link rather than offer a tap that reloads.
    if (record.status === "pending") return renderPending(record.slug);
    if (record.status === "paused") return renderPaused(record.slug);
    return renderActive(record);
  }

  if (path === "/") {
    // Cached per isolate for a minute, so the most requested page on the site does not make a
    // storage round trip for a number that changes a few times a day.
    return renderLanding(await readActivationsCached(ctx.store, ctx.now()));
  }
  if (path === "/skapa") return renderSkapa();
  if (path === "/kolla-mailen") {
    // The change-of-address flow lands here too, and promises a different thing.
    const byte = new URL(request.url).searchParams.has("byte");
    return renderKollaMailen(byte ? "byte" : "signup");
  }
  if (path === "/skickat") return renderSent();
  if (path === "/raderad") return renderRaderad();
  if (path === "/bytt") return renderBytt();

  if (path === "/tryck") {
    // The designer used to live here. It is on /klar now, under the preview, because a
    // separate page meant nobody could tell where the design was changed. Kept as a redirect
    // so links already mailed or bookmarked still land somewhere useful.
    const kod = new URL(request.url).searchParams.get("kod") ?? "";
    return seeOther(isValidSlug(kod) ? `/klar?kod=${kod}` : "/skapa");
  }

  if (path === "/hantera") {
    // The slug is never taken from the URL here: it comes only from a token, because anyone
    // who has seen the garment knows the slug.
    const token = new URL(request.url).searchParams.get("t") ?? "";
    if (!token) return renderHanteraLocked();

    // Peek, never consume. A mail gateway prefetching this link must not burn the token
    // before the owner clicks it. The action endpoint is what spends it.
    const claim = await peekToken(ctx.store, token, ctx.now());
    if (!claim || (claim.purpose !== "manage" && claim.purpose !== "koder")) {
      return renderHanteraLocked();
    }

    // One page, two reaches. An address link fills it with every code that address owns; a code
    // link fills it with the one it names.
    const slugs = claim.purpose === "manage"
      ? [claim.slug]
      : await codesForEmailHash(ctx.store, claim.epost);

    // In parallel, and that is not a micro-optimisation here: this runs on an edge isolate
    // talking to object storage over the network, and an address may own ten codes. Ten round
    // trips one after another is ten times the latency of ten at once, on the page an owner
    // opens from their inbox.
    const koder = (await Promise.all(
      slugs.map((slug) => getCode(ctx.store, slug, ctx.now())),
    )).filter((record) => record !== null);
    // Nothing left to manage reads as no link at all, which is also what a deleted last code
    // leaves behind. The page offers to mail a new one, which is the only useful next step.
    if (koder.length === 0) return renderHanteraLocked();

    // Read back from a code rather than from the token, which carries only a hash. Masked here,
    // at the boundary that decrypts it, so the page never receives an address in the clear.
    let epost: string | null = null;
    try {
      epost = maskEmail(await readOwnerEmail(ctx.emailKey, koder[0]!));
    } catch {
      // An undecryptable record must not cost the owner their controls. The row is left out.
      epost = null;
    }

    return renderKoder({
      koder,
      baseUrl: ctx.config.baseUrl,
      token,
      epost,
      helaListan: claim.purpose === "koder",
    });
  }

  if (path === "/klar") {
    const params = new URL(request.url).searchParams;

    // A token means the owner just verified, or came here from their own list. That is what
    // authorises the purpose picker, which writes to the record. Peeked, never spent: the page
    // is safe to reload, and only saving costs the link.
    const token = params.get("t") ?? "";
    if (token) {
      const claim = await peekToken(ctx.store, token, ctx.now());
      if (!claim || claim.purpose !== "manage") return renderKlarFailed();
      const record = await getCode(ctx.store, claim.slug, ctx.now());
      if (!record) return renderKlarFailed();
      return renderKlar(record, ctx.config.baseUrl, token);
    }

    // Without one, the print controls and nothing else. They only ever build a URL, and the
    // slug they build it from is printed on the garment anyway.
    const kod = params.get("kod") ?? "";
    // From a query string, so untrusted: validated and looked up rather than echoed back.
    if (!isValidSlug(kod)) return renderKlarFailed();
    const record = await getCode(ctx.store, kod, ctx.now());
    if (!record) return renderKlarFailed();
    return renderKlar(record, ctx.config.baseUrl, null);
  }

  // Not a route this application owns, and the caller decides what that means: the dev server
  // looks for a static file, and the edge script hands the request to the CDN, which is where
  // every real static asset lives in production.
  //
  // Only the files we uploaded get that treatment. The CDN's origin is the same Storage Zone the
  // application writes its records into, so handing over anything unrecognised published every
  // one of them. See `PUBLIC_ASSET`.
  if (PUBLIC_ASSET.test(path)) return null;
  return json({ fel: "Finns inte." }, 404);
}
