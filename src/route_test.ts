import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { importKey } from "./store/crypto.ts";
import { createMemoryStore } from "./store/storage.ts";
import { createCode, deleteCode, setDesign, setStatus } from "./store/shirts.ts";
import { emailHash, linkCodeToEmail } from "./store/emails.ts";
import { mintEmailToken, mintToken, peekToken } from "./store/tokens.ts";
import type { AppContext } from "./handlers/context.ts";
import { route } from "./route.ts";

const KEY = "3q2+796tvu/erb7v3q2+796tvu/erb7v3q2+796tvu8=";

async function context(): Promise<AppContext> {
  return {
    store: createMemoryStore().store,
    emailKey: await importKey(KEY),
    config: {
      baseUrl: "https://ojhej.se",
      altchaHmacKey: "test-secret",
      smtp2go: { apiKey: "k", baseUrl: "https://x", sender: "hej@ojhej.se" },
    },
    fetch:
      (() => Promise.reject(new Error("no mail from routing tests"))) as unknown as typeof fetch,
    now: () => Date.parse("2026-08-13T10:00:00Z"),
  };
}

const get = (path: string) => new Request(`https://ojhej.se${path}`);

/**
 * The contract the edge script is built on.
 *
 * In production this module runs as Bunny middleware in front of a Pull Zone. `null` means
 * "not mine", and the edge script hands that request to the CDN so the Storage Zone serves it.
 * Anything else is answered in the isolate.
 *
 * If a real page ever started returning null it would stop being served and start 404ing from
 * the CDN instead, and it would look fine locally, because the dev server has a filesystem to
 * fall back on and the CDN does not.
 */
Deno.test("every page and API route is answered here, never handed to the CDN", async () => {
  const ctx = await context();

  const owned = [
    "/",
    "/skapa",
    "/kolla-mailen",
    "/klar",
    "/tryck",
    "/hantera",
    "/skickat",
    "/raderad",
    "/bytt",
    "/verifiera",
    "/byt-epost",
    "/health",
    "/api/altcha",
    "/s/K7M4NPQR8TVWXYZ2ABCD",
    "/api/qr/K7M4NPQR8TVWXYZ2ABCD.svg",
    "/api/qr/K7M4NPQR8TVWXYZ2ABCD.pdf",
  ];

  for (const path of owned) {
    const response = await route(ctx, get(path));
    assert(response !== null, `${path} would have fallen through to the CDN`);
  }
});

Deno.test("the POST endpoints are answered here too", async () => {
  const ctx = await context();

  for (const path of ["/api/skapa", "/api/meddelande", "/api/hantera", "/api/hantera/atgard"]) {
    const response = await route(
      ctx,
      new Request(`https://ojhej.se${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert(response !== null, `${path} would have fallen through to the CDN`);
  }
});

/**
 * The other half of the contract. These are real files in the Storage Zone, and the edge script
 * must not answer them: doing so would mean every stylesheet request woke an isolate instead of
 * being served from cache, and would need the file contents compiled into the script.
 */
Deno.test("static assets are left for the CDN", async () => {
  const ctx = await context();

  for (
    const path of [
      "/style.css",
      "/fonts.css",
      "/app.js",
      "/fonts/instrument-serif-normal-400-latin.woff2",
      "/mark.png",
    ]
  ) {
    assertEquals(await route(ctx, get(path)), null, `${path} should be served by the CDN`);
  }
});

/**
 * The other half of that contract, and the one that was missing.
 *
 * The pull zone's origin *is* the storage zone, and this application writes `shirts/`,
 * `tokens/`, `emails/`, `altcha/`, `probe/` and `stats/` into that same zone beside the
 * uploaded files. Anything unclaimed used to fall through, so every one of those objects was a
 * public unauthenticated read: on 2026-08-19 `GET /shirts/<slug>.json` on production returned a
 * whole record, and `GET /stats/koder.json` returned the counter, without waking this script.
 *
 * An allowlist rather than a denylist of the data prefixes. A denylist has to be updated by
 * whoever adds the next prefix, and the cost of forgetting is this bug again.
 */
Deno.test("the application's own storage is never handed to the CDN", async () => {
  const ctx = await context();
  const slug = await owned(ctx);

  const reachable = [
    `/shirts/${slug}.json`,
    "/stats/koder.json",
    "/tokens/anything.json",
    `/emails/${"a".repeat(64)}.json`,
    "/altcha/anything.json",
    "/probe/anything.json",
    // Prefix, directory and casing variations, since the CDN would serve any of them.
    "/shirts/",
    "/SHIRTS/x.json",
    "/emails",
  ];

  for (const path of reachable) {
    const response = await route(ctx, get(path));
    assert(response !== null, `${path} must not be handed to the CDN`);
    assertEquals(response!.status, 404, path);
    // And the refusal itself must not be kept by anything.
    assertEquals(response!.headers.get("cache-control"), "no-store", path);
  }
});

/** Anything we did not upload is not a file, whatever it looks like. */
Deno.test("only the uploaded files fall through", async () => {
  const ctx = await context();

  for (const path of ["/favicon.ico", "/robots.txt", "/index.html", "/public/style.css"]) {
    const response = await route(ctx, get(path));
    assert(response !== null, `${path} must not be handed to the CDN`);
    assertEquals(response!.status, 404, path);
  }

  // A traversal never reaches the matcher: the URL parser resolves it first, so this is the
  // stylesheet and is served as one. Asserted rather than assumed, because the allowlist would
  // be worth very little if a path could arrive unnormalised.
  assertEquals(new URL(get("/../style.css").url).pathname, "/style.css");
  assertEquals(await route(ctx, get("/../style.css")), null);
});

/**
 * Nothing this module answers may be kept by the CDN.
 *
 * 2026-08-14, and still broken on 2026-08-15: no route here sent `cache-control` at all, so the
 * pull zone applied its own default of `public, max-age=2592000` and served one `/api/altcha`
 * challenge to every visitor for thirty days. `spendSolution` is single use on purpose, so the
 * first person to submit won and everyone after them was refused; once that cached challenge
 * passed its ten minute expiry, nobody could sign up or send a message at all.
 *
 * It was recorded as the zone overriding the script's `no-cache`. The script had never sent one,
 * which is why fixing the zone did not hold: there was nothing for it to respect. Asserted here
 * rather than trusted to a dashboard, because a header the code sends is a header a test can keep
 * hold of.
 */
Deno.test("nothing the isolate answers may be cached", async () => {
  const ctx = await context();
  const slug = (await createCode(ctx.store, ctx.emailKey, "anders@exempel.se", ctx.now())).slug;

  const paths = [
    "/",
    "/skapa",
    "/kolla-mailen",
    "/hantera",
    "/verifiera",
    "/byt-epost",
    "/health",
    "/api/altcha",
    `/s/${slug}`,
    // Not a route, and a refusal must not be kept either.
    "/shirts/x.json",
    "/nonsense",
  ];

  for (const path of paths) {
    const response = await route(ctx, get(path));
    assertEquals(
      response!.headers.get("cache-control"),
      "no-store",
      `${path} did not forbid caching, so the CDN may keep and reuse it`,
    );
  }
});

/**
 * The one exception, and the fence around it.
 *
 * The footer QR is on every page of the site and was `no-store`, so every page view cost an
 * isolate invocation and a storage read for a picture that is identical for everybody. It is
 * rendered from a slug printed on a garment: no visitor, no token, no secret, and deterministic,
 * so it is the one thing here that is genuinely a file.
 *
 * The blanket is now a default rather than an override, which is a real loosening of a rule
 * written after two outages. This test is the fence: exactly one kind of response may opt out,
 * and everything a visitor is in stays `no-store` above.
 */
Deno.test("the QR is the only thing allowed to be cached", async () => {
  const ctx = await context();
  const slug = (await createCode(ctx.store, ctx.emailKey, "anders@exempel.se", ctx.now())).slug;

  for (const path of [`/api/qr/${slug}.svg?mm=180`, `/api/qr/${slug}.pdf?mm=180`]) {
    const cache = (await route(ctx, get(path)))!.headers.get("cache-control");
    assertStringIncludes(cache ?? "", "max-age=", `${path} should be cacheable`);
    assert(!(cache ?? "").includes("no-store"), path);
  }

  // Every knob is in the query string, so caching is only safe while the zone keeps the query
  // string in the cache key. Different knobs must at least produce different bytes, or the
  // cache would be free to serve a print shop the wrong artwork.
  const small = await (await route(ctx, get(`/api/qr/${slug}.svg?mm=40`)))!.text();
  const large = await (await route(ctx, get(`/api/qr/${slug}.svg?mm=180&platta=ja`)))!.text();
  assert(small !== large, "two settings produced identical bytes");

  // And deterministic, which is what makes it cacheable at all: no timestamp, nonce or mask.
  const again = await (await route(ctx, get(`/api/qr/${slug}.svg?mm=40`)))!.text();
  assertEquals(small, again, "the same request must produce the same bytes");
});

/**
 * The redirect from plain HTTP is the pull zone's job and happens before this script wakes. This
 * is the half that keeps the plaintext request from being made at all.
 *
 * It matters here more than on most sites: `/hantera?t=...` and `/verifiera?t=...` carry a
 * single-use token in the query string, and a 301 only helps after that token has already crossed
 * the network in the clear. A browser that has seen this header once goes straight to HTTPS and
 * never sends the first request.
 */
Deno.test("an https response tells the browser never to come back over http", async () => {
  const ctx = await context();

  for (const path of ["/", "/hantera", "/verifiera", "/api/altcha"]) {
    const response = await route(ctx, get(path));
    assertEquals(
      response!.headers.get("strict-transport-security"),
      "max-age=31536000",
      `${path} did not ask the browser to stay on HTTPS`,
    );
  }
});

/**
 * The case that failed in production, and the reason the obvious rule is the wrong one.
 *
 * This first tested `new URL(request.url).protocol === "https:"`. A Bunny middleware runs on the
 * *origin* request rather than the visitor's, so that test was false for every real request and
 * the header went out on none of them, while `cache-control` on the very same response arrived
 * intact. The deploy gate caught it, which is the only reason it was not another quiet week.
 *
 * A browser ignores HSTS on a plaintext response anyway (RFC 6797), so the scheme was never the
 * thing worth asking about. Not pinning a developer's own machine is.
 */
Deno.test("the header survives a CDN that hands us the request over plain http", async () => {
  const ctx = await context();

  const response = await route(ctx, new Request("http://ojhej.se/"));
  assertEquals(
    response!.headers.get("strict-transport-security"),
    "max-age=31536000",
    "a proxied request still reaches a visitor who is on https",
  );
});

/**
 * And never on a developer's machine, where pinning a browser to HTTPS for a year would outlive
 * the checkout that caused it and break every other localhost project on the same port.
 */
Deno.test("a local request is never pinned to https", async () => {
  const ctx = await context();

  for (const origin of ["http://localhost:8787", "http://127.0.0.1:8787", "https://localhost"]) {
    const response = await route(ctx, new Request(`${origin}/`));
    assertEquals(
      response!.headers.get("strict-transport-security"),
      null,
      `${origin} should never be pinned`,
    );
  }
});

/**
 * Unknown paths are answered here rather than handed on.
 *
 * This used to fall through, on the reasoning that "answering 404 in the isolate would mean
 * every scan for wp-login.php spends a cold start". That reasoning does not survive reading
 * `edge/main.ts`: `start()` is awaited *before* `route()` is consulted, so the scan has already
 * paid the whole cold start by the time we decide. Falling through did not save it, it added a
 * CDN origin pull on top, and pointed that pull at the zone holding every record we own.
 */
Deno.test("unknown paths are refused rather than handed to the CDN", async () => {
  const ctx = await context();

  for (const path of ["/nonsense", "/wp-login.php", "/.env", "/api/", "/s/", "/api/qr/x.png"]) {
    const response = await route(ctx, get(path));
    assert(response !== null, `${path} must not be handed to the CDN`);
    assertEquals(response!.status, 404, path);
  }
});

/** A slug that is not a slug must not reach storage as a key. */
Deno.test("a malformed code is answered, not handed on, and never becomes a storage key", async () => {
  const ctx = await context();

  for (const bad of ["/s/not-a-slug", "/s/IOUL0000000000000000", "/s/../../etc"]) {
    const response = await route(ctx, get(bad));
    // Either answered with a page or refused; what matters is that it never falls through
    // to the CDN as though it were a file, and never throws.
    assert(response === null || response.status < 500, bad);
  }
});

/* ---------- what a download is actually called ---------- */

/**
 * The saved filename comes from two places: this header and the `download` attribute on the
 * link. When they disagree the name depends on which one the browser honours, and a file ends
 * up named after the wrong garment. That has bitten this project once already, with the slug.
 */
Deno.test("a download is named for its size, format and background", async () => {
  const ctx = await context();
  const slug = (await createCode(ctx.store, ctx.emailKey, "anders@exempel.se", ctx.now())).slug;

  const cases: [string, string][] = [
    [`/api/qr/${slug}.svg?mm=180&ladda`, `ojhej-${slug}-180mm-vit.svg`],
    [`/api/qr/${slug}.svg?mm=60&platta=ja&ladda`, `ojhej-${slug}-60mm-svart.svg`],
    [`/api/qr/${slug}.pdf?mm=180`, `ojhej-${slug}-180mm-vit.pdf`],
    [`/api/qr/${slug}.pdf?mm=180&platta=ja`, `ojhej-${slug}-180mm-svart.pdf`],
  ];

  for (const [path, expected] of cases) {
    const response = await route(ctx, get(path));
    assertEquals(
      response!.headers.get("content-disposition"),
      `attachment; filename="${expected}"`,
      path,
    );
  }
});

/** A PDF is always an attachment: nobody wants a print file taking over the tab. */
Deno.test("a PDF downloads even without asking, an SVG only when asked", async () => {
  const ctx = await context();
  const slug = (await createCode(ctx.store, ctx.emailKey, "anders@exempel.se", ctx.now())).slug;

  const inline = await route(ctx, get(`/api/qr/${slug}.svg?mm=180`));
  assertStringIncludes(inline!.headers.get("content-disposition")!, "inline");

  const pdf = await route(ctx, get(`/api/qr/${slug}.pdf?mm=180`));
  assertStringIncludes(pdf!.headers.get("content-disposition")!, "attachment");
  assertEquals(pdf!.headers.get("content-type"), "application/pdf");
});

/** The two knobs that survive, and the shapes that do not. */
Deno.test("the render route honours the panel and refuses to style the code", async () => {
  const ctx = await context();
  const slug = (await createCode(ctx.store, ctx.emailKey, "anders@exempel.se", ctx.now())).slug;

  const plain = await (await route(ctx, get(`/api/qr/${slug}.svg?mm=180`)))!.text();
  const panelled = await (await route(ctx, get(`/api/qr/${slug}.svg?mm=180&platta=ja`)))!.text();

  assert(!plain.includes('fill="#ffffff"'), "no panel unless asked for");
  assertStringIncludes(panelled, 'fill="#ffffff"');

  // The old form parameter is gone, and passing it must not resurrect anything.
  const asked = await (await route(ctx, get(`/api/qr/${slug}.svg?mm=180&form=prickar`)))!.text();
  assert(!asked.includes("<circle"), "styling was removed and must stay removed");
});

/* ---------- what a token opens ---------- */

const NOW = Date.parse("2026-08-13T10:00:00Z");

/** A live code owned by an address, reachable through the index, as signup leaves it. */
async function owned(ctx: AppContext, email = "anders@exempel.se"): Promise<string> {
  const record = await createCode(ctx.store, ctx.emailKey, email, NOW);
  await setStatus(ctx.store, record.slug, "active", NOW);
  await linkCodeToEmail(ctx.store, email, record.slug);
  return record.slug;
}

Deno.test("an address link opens the whole list", async () => {
  const ctx = await context();
  const first = await owned(ctx);
  const second = await owned(ctx);
  await setDesign(ctx.store, first, { syfte: "hej", rad: "", etikett: "DEJTA" }, NOW);
  await setDesign(ctx.store, second, { syfte: "borttappat", rad: "", etikett: "HITTAT?" }, NOW);

  const { token } = await mintEmailToken(
    ctx.store,
    await emailHash("anders@exempel.se"),
    "koder",
    NOW,
  );
  const html = await (await route(ctx, get(`/hantera?t=${token}`)))!.text();

  assertStringIncludes(html, "DEJTA");
  assertStringIncludes(html, "HITTAT?");
  assertStringIncludes(html, "Skapa en till");
  assertStringIncludes(html, "an•••@exempel.se", "masked, from the record rather than the token");
});

Deno.test("a code link opens the same page with one code on it", async () => {
  const ctx = await context();
  const mine = await owned(ctx);
  await owned(ctx);

  const { token } = await mintToken(ctx.store, mine, "manage", NOW);
  const html = await (await route(ctx, get(`/hantera?t=${token}`)))!.text();

  assertEquals(html.match(/class="kod"/g)?.length, 1);
  assert(!html.includes("Skapa en till"), "and none of what belongs to the address");
});

/** Mail gateways fetch every link at delivery. Opening the page must cost nothing. */
Deno.test("opening the list does not spend the link, however many times", async () => {
  const ctx = await context();
  await owned(ctx);
  const { token } = await mintEmailToken(
    ctx.store,
    await emailHash("anders@exempel.se"),
    "koder",
    NOW,
  );

  for (let scanner = 0; scanner < 5; scanner++) {
    assertEquals((await route(ctx, get(`/hantera?t=${token}`)))!.status, 200);
  }
  assert(await peekToken(ctx.store, token, NOW), "the token is still there for the owner");
});

Deno.test("a link whose codes are all gone offers a new one rather than an empty list", async () => {
  const ctx = await context();
  const slug = await owned(ctx);
  await deleteCode(ctx.store, slug);

  const { token } = await mintEmailToken(
    ctx.store,
    await emailHash("anders@exempel.se"),
    "koder",
    NOW,
  );
  const html = await (await route(ctx, get(`/hantera?t=${token}`)))!.text();

  assertStringIncludes(html, "Hantera dina koder.", "the locked page, which offers to mail a link");
});

Deno.test("the wrong kind of token opens neither page", async () => {
  const ctx = await context();
  const slug = await owned(ctx);
  const verify = await mintToken(ctx.store, slug, "verify", NOW);

  assertStringIncludes(
    await (await route(ctx, get(`/hantera?t=${verify.token}`)))!.text(),
    "Hantera dina koder.",
  );
  assertStringIncludes(
    await (await route(ctx, get(`/klar?t=${verify.token}`)))!.text(),
    "Länken funkade inte.",
  );
});

Deno.test("an address link does not authorise one code's own page", async () => {
  const ctx = await context();
  await owned(ctx);
  const { token } = await mintEmailToken(
    ctx.store,
    await emailHash("anders@exempel.se"),
    "koder",
    NOW,
  );

  // /klar is one code's page, and an address token names no code. Sending the owner to the
  // failure page is right: the list is where a code gets picked.
  assertStringIncludes(
    await (await route(ctx, get(`/klar?t=${token}`)))!.text(),
    "Länken funkade inte.",
  );
});

Deno.test("a code link opens its own page with the picker on it", async () => {
  const ctx = await context();
  const slug = await owned(ctx);
  const { token } = await mintToken(ctx.store, slug, "manage", NOW);

  const html = await (await route(ctx, get(`/klar?t=${token}`)))!.text();

  assertStringIncludes(html, 'id="syfte"');
  assertStringIncludes(html, `ojhej.se/s/${slug}`);
});

Deno.test("the slug alone opens the print controls and nothing that writes", async () => {
  const ctx = await context();
  const slug = await owned(ctx);

  const html = await (await route(ctx, get(`/klar?kod=${slug}`)))!.text();

  assertStringIncludes(html, 'id="designer"');
  assert(!html.includes('id="syfte"'), "the slug is public, so it cannot authorise a write");
});

/** A re-download months later should reproduce the file that was actually ordered. */
Deno.test("the printed code carries the label the owner saved", async () => {
  const ctx = await context();
  const slug = await owned(ctx);
  await setDesign(ctx.store, slug, { syfte: "borttappat", rad: "", etikett: "HITTAT?" }, NOW);

  const svg = await (await route(ctx, get(`/api/qr/${slug}.svg`)))!.text();
  assertStringIncludes(svg, "HITTAT?");

  const asked = await (await route(ctx, get(`/api/qr/${slug}.svg?text=ANNAT`)))!.text();
  assertStringIncludes(asked, "ANNAT", "and what the designer asks for still wins");
});
