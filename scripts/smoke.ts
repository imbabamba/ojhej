// deno-lint-ignore-file no-console -- a deploy gate whose whole output is its console log

/**
 * Check a deployed ojhej against the things that have actually broken.
 *
 * Every check here failed for real at some point in this project's life. None of them are
 * hypothetical, and none of them are "does the server respond": that is the check people write
 * and it passes while the site is unusable.
 *
 * Two deliberate properties.
 *
 * It runs every check even after one fails, then exits non-zero at the end. Stopping at the
 * first failure tells you one thing is wrong when five might be, and a deploy where five things
 * are wrong is a different problem from one where one is.
 *
 * It reports what it actually got. The version of this that lived in the workflow was a chain of
 * `grep -q`, which produces a red X and no information, and left whoever was on the other end
 * rerunning the pipeline to learn anything.
 *
 *   deno task smoke https://ojhej.se
 *   deno task smoke                    # defaults to OJHEJ_BASE_URL, then localhost
 */

import { assetVersionOf } from "./asset-version.ts";

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}`);
  if (!ok) console.log(`        ${detail}`);
}

async function get(url: string): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(url, { redirect: "manual" });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

/** A page that must render, and must contain something only the real page contains. */
async function page(base: string, path: string, name: string, needle: string): Promise<void> {
  try {
    const { status, body } = await get(`${base}${path}`);
    if (status !== 200) {
      record(name, false, `${path} answered ${status}, expected 200`);
      return;
    }
    if (!body.includes(needle)) {
      record(name, false, `${path} did not contain ${JSON.stringify(needle)}`);
      return;
    }
    record(name, true, "");
  } catch (cause) {
    record(name, false, `${path} could not be reached: ${cause}`);
  }
}

/**
 * A static file, which must come back with a content type a browser will act on.
 *
 * Several spellings are accepted where several are correct. `/app.js` is the case that matters:
 * the Storage Zone labels it `application/javascript` and the dev server sends `text/javascript`,
 * and a browser executes either. Insisting on one of them failed the deploy gate on a difference
 * that changes nothing for a visitor, and a gate that is red for a reason nobody acts on is a gate
 * people stop reading. What this check is actually for is a file served as `text/plain` or
 * `application/octet-stream`, which a browser fetches and then refuses to use.
 */
async function asset(base: string, path: string, ...accepted: string[]): Promise<void> {
  const wanted = accepted.join(" or ");
  const name = `${path} is served as ${wanted}`;
  try {
    const { status, headers } = await get(`${base}${path}`);
    const got = headers.get("content-type") ?? "(none)";
    if (status !== 200) {
      record(name, false, `answered ${status}. Were the assets uploaded to the storage zone?`);
      return;
    }
    if (!accepted.some((type) => got.startsWith(type))) {
      record(name, false, `content-type was ${got}, expected ${wanted}`);
      return;
    }
    record(name, true, "");
  } catch (cause) {
    record(name, false, `could not be reached: ${cause}`);
  }
}

const base = (Deno.args[0] ?? Deno.env.get("OJHEJ_BASE_URL") ?? "http://localhost:8787")
  .replace(/\/+$/, "");

console.log(`\nsmoke test against ${base}\n`);

// The cold start ran and survived. This is the check that fails when a secret is missing or the
// storage delete semantics are wrong, and both of those are refusals to serve rather than bugs.
try {
  const { status, body } = await get(`${base}/health`);
  record(
    "the script is alive and its cold start succeeded",
    status === 200 && body.includes('"ok":true'),
    `/health answered ${status} with ${body.slice(0, 120)}. A 500 here means the cold start ` +
      `threw: check the script's log pane for a missing variable or the delete-semantics check.`,
  );
} catch (cause) {
  record("the script is alive and its cold start succeeded", false, `unreachable: ${cause}`);
}

await page(base, "/", "the landing page renders", "Oj hej");
await page(base, "/skapa", "signup renders", "Din mailadress");
await page(base, "/hantera", "the manage page asks for an address", "Mailadressen");

// Static files come from the storage zone, not the script. A 404 here is an upload that did not
// happen; a wrong content type is a file the browser fetches and then refuses to use.
await asset(base, "/style.css", "text/css");
await asset(base, "/fonts.css", "text/css");
await asset(base, "/app.js", "text/javascript", "application/javascript");
await asset(base, "/mark.png", "image/png");
await asset(base, "/fonts/instrument-serif-normal-400-latin.woff2", "font/woff2");

/*
 * The stamp on the asset URLs is the stamp of the files actually being served.
 *
 * The edge script carries `ASSET_VERSION` compiled in; the files it names live in the Storage
 * Zone and are uploaded separately. Deploy them in the wrong order and the two disagree in the
 * worst possible direction: the page asks for `/app.js?v=<new>`, the zone hands back the old
 * file, and every browser pins that answer under the new URL for nine months. That is the same
 * failure this stamp exists to prevent, made permanent instead of temporary.
 *
 * So it is checked against the bytes rather than trusted: fetch what the page names, hash it the
 * way `asset-version.ts` does, and require the answer the page claims. Upload the assets first,
 * then deploy the script.
 */
try {
  const name = "the asset stamp matches the files being served";
  const { body } = await get(base);
  const stamped = [...body.matchAll(/(?:href|src)="\/([a-z0-9.]+\.(?:css|js))\?v=([0-9a-f]+)"/g)];

  if (stamped.length === 0) {
    record(name, false, "the page names no stamped assets at all");
  } else {
    const claimed = [...new Set(stamped.map((match) => match[2]))];
    // One stamp covers all three files, so more than one means a half-deployed page.
    if (claimed.length !== 1) {
      record(
        name,
        false,
        `the page names ${claimed.length} different stamps: ${claimed.join(", ")}`,
      );
    } else {
      // The same function the stamp is generated with, handed the bytes the CDN served instead
      // of the bytes on disk. Two implementations of one hash would be two things to keep in
      // step, and them agreeing is the entire check.
      const served = await assetVersionOf(async (file) =>
        new Uint8Array(await (await fetch(`${base}/${file}`)).arrayBuffer())
      );

      record(
        name,
        served === claimed[0],
        `the page asks for ?v=${claimed[0]} but the served files hash to ${served}. ` +
          `The assets and the script were deployed out of order: run \`deno task upload-assets\` ` +
          `and redeploy, or every browser will cache the wrong file under the new URL.`,
      );
    }
  }
} catch (cause) {
  record("the asset stamp matches the files being served", false, `could not be checked: ${cause}`);
}

/*
 * The application's own records must not be readable over the CDN.
 *
 * The pull zone's origin is the Storage Zone this service writes into, so for as long as the
 * script handed unrecognised paths to the CDN, every record was a public unauthenticated read.
 * Confirmed against production on 2026-08-19: `/shirts/<slug>.json` returned a whole record and
 * `/stats/koder.json` returned the counter. See status.md.
 *
 * Checked here rather than trusted to a unit test, because the unit test proves the script
 * refuses and this proves nothing else answers: a cached copy from before the fix, or a second
 * route into the zone, would pass one and fail the other. `/stats/koder.json` is the sharpest
 * probe available without a real slug, since it exists on every deployment.
 */
for (
  const path of [
    "/stats/koder.json",
    "/emails/" + "a".repeat(64) + ".json",
    "/tokens/probe.json",
    "/shirts/AAAAAAAAAAAAAAAAAAAA.json",
  ]
) {
  const name = `${path} is not readable`;
  try {
    const { status } = await get(`${base}${path}`);
    record(
      name,
      status === 404,
      `answered ${status}. The Storage Zone is being served through the pull zone, so every ` +
        `record this service holds is public. Purge the zone if this was just fixed, and see ` +
        `the two-zone split in deploy.md.`,
    );
  } catch (cause) {
    record(name, false, `could not be checked: ${cause}`);
  }
}

// The whole no-cookie-banner claim rests on this.
try {
  const { body } = await get(base);
  const external = [...body.matchAll(/(?:href|src)="(https?:)?\/\/([^"/]+)/g)].map((m) => m[2]);
  record(
    "no page reaches out to a third party",
    external.length === 0,
    `the landing page loads from ${external.join(", ")}`,
  );
} catch (cause) {
  record("no page reaches out to a third party", false, `unreachable: ${cause}`);
}

// Proof of work is issued and recorded, which is also a storage write, so this exercises the
// storage path that every signup depends on.
try {
  const { status, body } = await get(`${base}/api/altcha`);
  record(
    "proof of work is issued",
    status === 200 && body.includes('"challenge"'),
    `/api/altcha answered ${status} with ${body.slice(0, 120)}`,
  );
} catch (cause) {
  record("proof of work is issued", false, `unreachable: ${cause}`);
}

/**
 * The challenge must be different every time, or the proof of work proves nothing.
 *
 * 2026-08-14: the pull zone overrode the script's `no-cache` with a 30 day expiry and served one
 * cached challenge to everybody. `spendSolution` is single use on purpose, so the first person to
 * submit won and every visitor after them got "signup refused, reason: altcha". The deploy was
 * green throughout, because the check above only asks whether *a* challenge comes back.
 */
try {
  const first = await get(`${base}/api/altcha`);
  const second = await get(`${base}/api/altcha`);
  record(
    "each visitor gets their own proof of work",
    first.body !== second.body,
    "two requests in a row returned an identical challenge, so /api/altcha is being cached. " +
      "Make the pull zone respect the origin's cache-control, then purge.",
  );
} catch (cause) {
  record("each visitor gets their own proof of work", false, `unreachable: ${cause}`);
}

/**
 * The header itself, which is the half that was missing and the reason the CDN check below is not
 * enough on its own.
 *
 * A `cdn-cache` check only reports what the zone did with the last request. The deploy workflow
 * purges immediately before this script runs, so a first request reads MISS and passes happily on
 * a zone that caches everything. This asks the question that does not depend on cache state at
 * all: did the response forbid caching in the first place?
 *
 * 2026-08-15: no route sent `cache-control` at all, so Bunny applied its own thirty day default
 * and served one proof-of-work challenge to every visitor until it expired, at which point nobody
 * could sign up or send a message. It had been recorded as the zone overriding a `no-cache` the
 * script never sent, so the fix went to the dashboard and the cause stayed in the code.
 */
for (const path of ["/", "/api/altcha", "/hantera", "/verifiera", "/health"]) {
  const name = `${path} forbids caching at the origin`;
  try {
    const { headers } = await get(`${base}${path}`);
    const cc = headers.get("cache-control") ?? "";
    record(
      name,
      cc.toLowerCase().includes("no-store"),
      `cache-control came back as ${cc || "(none)"}, expected no-store. A response that does not ` +
        `forbid caching gets whatever the pull zone's default is, and that default was 30 days.`,
    );
  } catch (cause) {
    record(name, false, `could not be reached: ${cause}`);
  }
}

/**
 * And what the zone actually did with it. `route()` sends `no-store` on every dynamic response, so
 * a HIT means the zone is overriding the origin, and a zone that caches `/hantera` is a zone that
 * can hand one owner's page to somebody else.
 *
 * Absent header is a pass: run against localhost there is no CDN in front, and this check is about
 * what the CDN does when there is one.
 */
for (const path of ["/api/altcha", "/hantera", "/verifiera"]) {
  const name = `${path} is not cached by the CDN`;
  try {
    const { headers } = await get(`${base}${path}`);
    const cdn = headers.get("cdn-cache") ?? "";
    record(
      name,
      cdn.toUpperCase() !== "HIT",
      `cdn-cache was ${cdn} and cache-control came back as ` +
        `${headers.get("cache-control") ?? "(none)"}. The origin sends no-store, so a HIT means ` +
        `the zone is overriding it: make it respect the origin's cache-control, then purge.`,
    );
  } catch (cause) {
    record(name, false, `could not be reached: ${cause}`);
  }
}

/**
 * The security half, and the reason the one above is not enough on its own.
 *
 * Management and verification links carry their token in the query string. A cache that leaves the
 * query string out of its key collapses every `/hantera?t=...` onto a single entry and serves
 * whatever landed there first to whoever asks next, which is one owner's controls handed to a
 * stranger. A value never requested before must never answer from cache.
 */
try {
  const { headers } = await get(`${base}/hantera?t=smoke-${crypto.randomUUID()}`);
  const cdn = headers.get("cdn-cache") ?? "";
  record(
    "a token in the query string is part of the cache key",
    cdn.toUpperCase() !== "HIT",
    `a token never requested before answered from cache (cdn-cache ${cdn}), so every ` +
      `/hantera?t=... and /verifiera?t=... share one cached response. Put the query string in ` +
      `the zone's cache key and purge.`,
  );
} catch (cause) {
  record("a token in the query string is part of the cache key", false, `unreachable: ${cause}`);
}

/**
 * Plain HTTP must not serve the site.
 *
 * The redirect is the pull zone's Force SSL, which means it is a dashboard setting that anyone
 * with the login can switch off without a deploy. That is precisely the class of change behind the
 * 2026-08-14 outage, so it gets a check rather than trust.
 *
 * The query string has to survive it. `/hantera?t=...` and `/verifiera?t=...` carry a single-use
 * token, and a redirect that drops the query sends an owner to a locked page instead of theirs.
 *
 * Skipped against a local base URL, which has neither TLS nor a CDN to do any of this.
 */
if (base.startsWith("https://")) {
  const plain = base.replace(/^https:/, "http:");
  const target = `${base}/hantera?t=smoke-redirect`;
  const redirect = "plain http redirects to https, with the query string intact";

  try {
    const { status, headers } = await get(`${plain}/hantera?t=smoke-redirect`);
    const location = headers.get("location") ?? "";
    record(
      redirect,
      (status === 301 || status === 308) && location === target,
      `http answered ${status} with location ${location || "(none)"}, expected a permanent ` +
        `redirect to ${target}. Turn Force SSL back on for the pull zone.`,
    );
  } catch (cause) {
    record(redirect, false, `could not be reached: ${cause}`);
  }

  /**
   * And the header that stops the second visit touching HTTP at all. A redirect only helps once
   * the token has already crossed the network in the clear, which is too late to be the whole
   * answer for a URL that carries one.
   */
  const hstsName = "https asks the browser to stay on https";
  try {
    const { headers } = await get(base);
    const hsts = headers.get("strict-transport-security") ?? "";
    record(
      hstsName,
      /max-age=\d+/.test(hsts),
      `strict-transport-security was ${hsts || "(none)"}. route() sets it on every https ` +
        `response, so a missing one means this deploy predates that, or something stripped it.`,
    );
  } catch (cause) {
    record(hstsName, false, `could not be reached: ${cause}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `, ${failed.length} failed\n` : "\n"),
);

if (failed.length) Deno.exit(1);
