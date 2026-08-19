import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { importKey } from "../store/crypto.ts";
import { createMemoryStore, type MemoryStoreHandle } from "../store/storage.ts";
import { createCode, getCode } from "../store/shirts.ts";
import { mintToken, peekToken, VERIFY_TTL_MS } from "../store/tokens.ts";
import { readActivations } from "../store/stats.ts";
import type { AppContext } from "./context.ts";
import { handleVerify } from "./verify.ts";

const KEY = "3q2+796tvu/erb7v3q2+796tvu/erb7v3q2+796tvu8=";
const T0 = Date.parse("2026-08-12T10:00:00Z");

interface Harness {
  ctx: AppContext;
  handle: MemoryStoreHandle;
  now: number;
}

async function harness(): Promise<Harness> {
  const handle = createMemoryStore();
  const h: Harness = {
    handle,
    now: T0,
    ctx: {
      store: handle.store,
      emailKey: await importKey(KEY),
      config: {
        baseUrl: "https://ojhej.se",
        altchaHmacKey: "unused-here",
        smtp2go: { apiKey: "api-test", baseUrl: "https://x", sender: "hej@ojhej.se" },
      },
      fetch:
        (() => Promise.reject(new Error("verify must not send mail"))) as unknown as typeof fetch,
      now: () => h.now,
    },
  };
  return h;
}

/** What a mail client, or a scanner, does when it meets the link. */
function open(token: string | null): Request {
  const url = token === null
    ? "https://ojhej.se/verifiera"
    : `https://ojhej.se/verifiera?t=${encodeURIComponent(token)}`;
  return new Request(url);
}

/** What the button on the confirmation page does. */
function confirm(token: string): Request {
  return new Request("https://ojhej.se/verifiera", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ t: token }),
  });
}

async function pendingCode(h: Harness) {
  const record = await createCode(h.ctx.store, h.ctx.emailKey, "anders@exempel.se", T0);
  const { token } = await mintToken(h.ctx.store, record.slug, "verify", T0);
  return { slug: record.slug, token };
}

/**
 * The property this whole two-step shape exists for. Mail security gateways fetch every link
 * at delivery, so opening the link must change nothing at all. If this ever regresses, real
 * users silently lose the ability to activate and it looks like an unreproducible bug.
 */
Deno.test("opening the link does not spend it, however many times", async () => {
  const h = await harness();
  const { slug, token } = await pendingCode(h);
  h.now = T0 + 60_000;

  for (let scanner = 0; scanner < 5; scanner++) {
    const response = await handleVerify(h.ctx, open(token));
    assertEquals(response.status, 200, "a prefetch must get a page, not a redirect");
    assertStringIncludes(await response.text(), "Aktivera koden");
  }

  assertEquals(
    (await getCode(h.ctx.store, slug, h.now))?.status,
    "pending",
    "nothing may be written by a GET",
  );

  // And after all that scanning, the owner's click still works.
  const done = await handleVerify(h.ctx, confirm(token));
  assertEquals(done.status, 303);
  assertEquals((await getCode(h.ctx.store, slug, h.now))?.status, "active");
});

Deno.test("confirming activates the code and hands over the slug", async () => {
  const h = await harness();
  const { slug, token } = await pendingCode(h);
  h.now = T0 + 60_000;

  const response = await handleVerify(h.ctx, confirm(token));

  assertEquals(response.status, 303);
  // A management link for this code, which is what authorises the purpose picker on the page it
  // lands on. The slug is no longer in the URL: it comes off the record behind the token.
  const location = response.headers.get("location")!;
  assertStringIncludes(location, "/klar?t=");
  const handed = location.slice(location.indexOf("t=") + 2);
  assertEquals((await peekToken(h.ctx.store, handed, h.now))?.purpose, "manage");

  const record = await getCode(h.ctx.store, slug, h.now);
  assertEquals(record?.status, "active");
  assertEquals(record?.verifiedAt, h.now);
});

/**
 * The slug reaches the owner here and nowhere earlier. Signup deliberately withholds it, so
 * clicking a link in the mailbox is the only way to learn which code is yours.
 */
Deno.test("the slug is revealed only through the mailbox", async () => {
  const h = await harness();
  const { slug, token } = await pendingCode(h);
  h.now = T0 + 60_000;

  // The confirmation page must not leak it either: a scanner sees that page.
  const page = await handleVerify(h.ctx, open(token));
  assert(!(await page.text()).includes(slug), "the code must not appear before confirmation");

  const response = await handleVerify(h.ctx, confirm(token));
  const location = response.headers.get("location")!;

  // The redirect now carries a token rather than the slug, and the code comes back through the
  // record behind it. That is a small improvement on the way past: a slug in a query string
  // sits in browser history and can be read over a shoulder.
  assertEquals(location.includes(slug), false, "the slug does not travel in the URL");
  const handed = location.slice(location.indexOf("t=") + 2);
  const claim = await peekToken(h.ctx.store, handed, h.now);
  assertEquals(
    claim?.purpose === "manage" ? claim.slug : null,
    slug,
    "but it does reach the owner",
  );
});

Deno.test("confirming works exactly once", async () => {
  const h = await harness();
  const { token } = await pendingCode(h);
  h.now = T0 + 60_000;

  assertEquals((await handleVerify(h.ctx, confirm(token))).status, 303);

  const replay = await handleVerify(h.ctx, confirm(token));
  assertEquals(replay.status, 200, "a spent link renders the failure page");
  assertStringIncludes(await replay.text(), "funkade inte");
});

Deno.test("an expired link is refused, on both steps", async () => {
  const h = await harness();
  const { slug, token } = await pendingCode(h);
  h.now = T0 + VERIFY_TTL_MS + 1000;

  assertStringIncludes(await (await handleVerify(h.ctx, open(token))).text(), "funkade inte");
  assertStringIncludes(await (await handleVerify(h.ctx, confirm(token))).text(), "funkade inte");

  assertEquals(
    (await getCode(h.ctx.store, slug, T0 + 1000))?.status,
    "pending",
    "an expired link must not activate anything",
  );
});

Deno.test("a missing, empty or unknown token is refused", async () => {
  for (const token of [null, "", "nonsense", "../../shirts/x"]) {
    const h = await harness();
    await pendingCode(h);
    h.now = T0 + 60_000;

    const response = await handleVerify(h.ctx, open(token));
    assertStringIncludes(await response.text(), "funkade inte", `token ${token}`);
  }
});

/**
 * A management link is 30 minutes long and gates pause and delete. If it could also verify,
 * the two lifetimes would collapse into whichever is more useful to an attacker.
 */
Deno.test("a management token cannot be used to verify", async () => {
  const h = await harness();
  const record = await createCode(h.ctx.store, h.ctx.emailKey, "anders@exempel.se", T0);
  const { token } = await mintToken(h.ctx.store, record.slug, "manage", T0);
  h.now = T0 + 60_000;

  assertStringIncludes(await (await handleVerify(h.ctx, open(token))).text(), "funkade inte");
  assertStringIncludes(await (await handleVerify(h.ctx, confirm(token))).text(), "funkade inte");
  assertEquals((await getCode(h.ctx.store, record.slug, h.now))?.status, "pending");
});

Deno.test("verifying a code that has since been deleted fails gracefully", async () => {
  const h = await harness();
  const { slug, token } = await pendingCode(h);
  await h.ctx.store.delete(`shirts/${slug}.json`);
  h.now = T0 + 60_000;

  assertStringIncludes(await (await handleVerify(h.ctx, confirm(token))).text(), "funkade inte");
});

Deno.test("verifying an already active code is harmless", async () => {
  const h = await harness();
  const record = await createCode(h.ctx.store, h.ctx.emailKey, "anders@exempel.se", T0);
  const first = await mintToken(h.ctx.store, record.slug, "verify", T0);
  const second = await mintToken(h.ctx.store, record.slug, "verify", T0);
  h.now = T0 + 60_000;

  await handleVerify(h.ctx, confirm(first.token));
  const again = await handleVerify(h.ctx, confirm(second.token));

  assertEquals(again.status, 303);
  const stored = await getCode(h.ctx.store, record.slug, h.now);
  assertEquals(stored?.status, "active");
  assertEquals(stored?.verifiedAt, T0 + 60_000, "the first verification time stands");
});

Deno.test("other methods are refused", async () => {
  const h = await harness();
  const { token } = await pendingCode(h);

  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const response = await handleVerify(
      h.ctx,
      new Request(`https://ojhej.se/verifiera?t=${token}`, { method }),
    );
    assertEquals(response.status, 405, method);
  }
});

Deno.test("the redirect is relative, so it cannot be pointed elsewhere", async () => {
  const h = await harness();
  const { token } = await pendingCode(h);
  h.now = T0 + 60_000;

  const location = (await handleVerify(h.ctx, confirm(token))).headers.get("location")!;
  assert(location.startsWith("/"), `expected a same-origin path, got ${location}`);
  assert(!location.startsWith("//"), "a protocol-relative URL would leave the site");
});

Deno.test("the confirmation form posts back to the same path", async () => {
  const h = await harness();
  const { token } = await pendingCode(h);
  h.now = T0 + 60_000;

  const html = await (await handleVerify(h.ctx, open(token))).text();
  assertStringIncludes(html, 'method="post"');
  assertStringIncludes(html, 'action="/verifiera"');
  // Plain HTML, no fetch: verification must survive a mail client's in-app browser.
  assertStringIncludes(html, `name="t"`);
});

/**
 * R19. A 405 that does not say what would have worked is a 405 that costs someone an hour.
 * The spec calls `Allow` a MUST; more usefully, it is the difference between "you guessed
 * wrong" and "here is the answer".
 */
Deno.test("a refused method is told which methods would work", async () => {
  const h = await harness();
  const { token } = await pendingCode(h);

  const response = await handleVerify(
    h.ctx,
    new Request(`https://ojhej.se/verifiera?t=${token}`, { method: "DELETE" }),
  );

  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "GET, POST");
});

/**
 * R15. Activation used to read the record, discard it, and have `setStatus` read the same key
 * again. Harmless on a laptop; on an edge isolate talking to object storage over the network
 * it is a wasted round trip on the one request a new user is watching.
 *
 * Counted rather than inspected, because the cheapest way for this to regress is someone
 * reaching for the convenient helper that re-reads.
 */
Deno.test("activation reads the code once, not twice", async () => {
  const h = await harness();
  const { slug, token } = await pendingCode(h);
  h.now = T0 + 60_000;

  const reads: string[] = [];
  const underlying = h.ctx.store;
  h.ctx = {
    ...h.ctx,
    store: {
      get: (key: string) => {
        reads.push(key);
        return underlying.get(key);
      },
      put: underlying.put.bind(underlying),
      delete: underlying.delete.bind(underlying),
    },
  };

  await handleVerify(h.ctx, confirm(token));

  const codeReads = reads.filter((key) => key === `shirts/${slug}.json`);
  assertEquals(codeReads.length, 1, `read the code ${codeReads.length} times`);
});

/**
 * The landing page shows how many codes exist. It should count codes, not clicks: a second
 * valid verification link for the same code is already a no-op for verifiedAt, and it has to be
 * one here too or the figure drifts upward every time somebody clicks an old mail.
 */
Deno.test("activation is counted once per code, not once per click", async () => {
  const h = await harness();
  const record = await createCode(h.ctx.store, h.ctx.emailKey, "anders@exempel.se", T0);
  const first = await mintToken(h.ctx.store, record.slug, "verify", T0);
  const second = await mintToken(h.ctx.store, record.slug, "verify", T0);
  h.now = T0 + 60_000;

  await handleVerify(h.ctx, confirm(first.token));
  assertEquals(await readActivations(h.ctx.store), 1);

  await handleVerify(h.ctx, confirm(second.token));
  assertEquals(await readActivations(h.ctx.store), 1, "the same code must not count twice");
});

Deno.test("a code that never activates is never counted", async () => {
  const h = await harness();
  await pendingCode(h);
  h.now = T0 + 60_000;

  assertEquals(await readActivations(h.ctx.store), 0, "signing up is not activating");
});
