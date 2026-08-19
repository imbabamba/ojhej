import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { encrypt, hashToken, importKey } from "../store/crypto.ts";
import { createMemoryStore, type MemoryStoreHandle } from "../store/storage.ts";
import { codesForEmail, emailHash, linkCodeToEmail } from "../store/emails.ts";
import { createCode, deleteCode, getCode, readOwnerEmail, setStatus } from "../store/shirts.ts";
import { CHANGE_TTL_MS, mintEmailToken, mintToken } from "../store/tokens.ts";
import type { AppContext } from "./context.ts";
import { handleEmailChange } from "./change.ts";

const KEY = "3q2+796tvu/erb7v3q2+796tvu/erb7v3q2+796tvu8=";
const OWNER = "gammal@exempel.se";
const NEW = "ny@exempel.se";
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
      fetch: (() =>
        Promise.reject(
          new Error("confirming a change must not send mail"),
        )) as unknown as typeof fetch,
      now: () => h.now,
    },
  };
  return h;
}

/** A code owned by OWNER and reachable through the reverse index, as signup leaves it. */
async function ownedCode(h: Harness, email = OWNER): Promise<string> {
  const record = await createCode(h.ctx.store, h.ctx.emailKey, email, T0);
  await setStatus(h.ctx.store, record.slug, "active", T0);
  await linkCodeToEmail(h.ctx.store, email, record.slug);
  return record.slug;
}

/**
 * OWNER's codes with a change to NEW already pending, as the manage action leaves it.
 *
 * The token names the address rather than a code, because the change moves everything that
 * address owns. One code is the ordinary case and the default here.
 */
async function pending(
  h: Harness,
  options: { to?: string; codes?: number } = {},
): Promise<{ slug: string; slugs: string[]; token: string }> {
  const slugs: string[] = [];
  for (let n = 0; n < (options.codes ?? 1); n++) slugs.push(await ownedCode(h));

  const { token } = await mintEmailToken(
    h.ctx.store,
    await emailHash(OWNER),
    "change",
    T0,
    await encrypt(h.ctx.emailKey, options.to ?? NEW),
  );
  return { slug: slugs[0]!, slugs, token };
}

/** What a mail client, or a security scanner, does when it meets the link. */
function open(token: string | null): Request {
  const url = token === null
    ? "https://ojhej.se/byt-epost"
    : `https://ojhej.se/byt-epost?t=${encodeURIComponent(token)}`;
  return new Request(url);
}

/** What the button on the confirmation page does. */
function confirm(token: string): Request {
  return new Request("https://ojhej.se/byt-epost", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ t: token }),
  });
}

/**
 * The same prefetch protection as verification, and it matters more here. Mail gateways fetch
 * every link at delivery, so consuming on GET would let a scanner complete a change of owner
 * address before the person ever saw the mail.
 */
Deno.test("opening the link does not perform the change, however many times", async () => {
  const h = await harness();
  const { slug, token } = await pending(h);
  h.now = T0 + 60_000;

  for (let scanner = 0; scanner < 5; scanner++) {
    const response = await handleEmailChange(h.ctx, open(token));
    assertEquals(response.status, 200, "a prefetch must get a page, not a redirect");
  }

  const record = await getCode(h.ctx.store, slug, h.now);
  assertEquals(await readOwnerEmail(h.ctx.emailKey, record!), OWNER, "nothing moved");

  // And after all that scanning, the real click still works.
  assertEquals((await handleEmailChange(h.ctx, confirm(token))).status, 303);
});

Deno.test("confirming moves the address and the index together", async () => {
  const h = await harness();
  const { slug, token } = await pending(h);
  h.now = T0 + 60_000;

  const response = await handleEmailChange(h.ctx, confirm(token));

  assertEquals(response.status, 303);
  const record = await getCode(h.ctx.store, slug, h.now);
  assertEquals(await readOwnerEmail(h.ctx.emailKey, record!), NEW);
  assertEquals(await codesForEmail(h.ctx.store, NEW), [slug], "the new address can manage it");
  assertEquals(await codesForEmail(h.ctx.store, OWNER), [], "and the old one no longer can");
});

Deno.test("confirming works exactly once", async () => {
  const h = await harness();
  const { token } = await pending(h);
  h.now = T0 + 60_000;

  assertEquals((await handleEmailChange(h.ctx, confirm(token))).status, 303);

  const replay = await handleEmailChange(h.ctx, confirm(token));
  assertEquals(replay.status, 200, "a spent link renders the failure page");
  assertStringIncludes(await replay.text(), "funkade inte");
});

Deno.test("concurrent confirmations yield exactly one change", async () => {
  const h = await harness();
  const { slug, token } = await pending(h);
  h.now = T0 + 60_000;

  const responses = await Promise.all(
    Array.from({ length: 20 }, () => handleEmailChange(h.ctx, confirm(token))),
  );

  assertEquals(responses.filter((r) => r.status === 303).length, 1);
  const record = await getCode(h.ctx.store, slug, h.now);
  assertEquals(await readOwnerEmail(h.ctx.emailKey, record!), NEW);
});

Deno.test("an expired link is refused, on both steps", async () => {
  const h = await harness();
  const { slug, token } = await pending(h);
  h.now = T0 + CHANGE_TTL_MS + 1000;

  assertStringIncludes(await (await handleEmailChange(h.ctx, open(token))).text(), "funkade inte");
  assertStringIncludes(
    await (await handleEmailChange(h.ctx, confirm(token))).text(),
    "funkade inte",
  );

  const record = await getCode(h.ctx.store, slug, T0 + 1000);
  assertEquals(await readOwnerEmail(h.ctx.emailKey, record!), OWNER);
});

/**
 * A management link is the key to the whole code and a verification link lasts a week. If
 * either could confirm a change of address, the shortest-lived link in the system would stop
 * being the one that gates the most dangerous action.
 */
Deno.test("only a change token can confirm a change", async () => {
  for (const purpose of ["verify", "manage"] as const) {
    const h = await harness();
    const record = await createCode(h.ctx.store, h.ctx.emailKey, OWNER, T0);
    const { token } = await mintToken(h.ctx.store, record.slug, purpose, T0);
    h.now = T0 + 60_000;

    const response = await handleEmailChange(h.ctx, confirm(token));
    assertStringIncludes(await response.text(), "funkade inte", purpose);

    const after = await getCode(h.ctx.store, record.slug, h.now);
    assertEquals(await readOwnerEmail(h.ctx.emailKey, after!), OWNER, purpose);
  }
});

Deno.test("a missing, empty or unknown token is refused", async () => {
  for (const token of [null, "", "nonsense", "../../shirts/x"]) {
    const h = await harness();
    await pending(h);
    h.now = T0 + 60_000;

    assertStringIncludes(
      await (await handleEmailChange(h.ctx, open(token))).text(),
      "funkade inte",
      `token ${token}`,
    );
  }
});

Deno.test("confirming a change for a code that has been deleted fails gracefully", async () => {
  const h = await harness();
  const { slug, token } = await pending(h);
  await h.ctx.store.delete(`shirts/${slug}.json`);
  h.now = T0 + 60_000;

  const response = await handleEmailChange(h.ctx, confirm(token));
  assertStringIncludes(await response.text(), "funkade inte");
});

/**
 * A change token whose payload cannot be decrypted is either corrupt or from another key. Both
 * mean we do not know what address to move to, and guessing is how a code ends up pointed at
 * the wrong inbox forever.
 */
Deno.test("an undecryptable pending address is refused rather than guessed at", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  const { token } = await mintEmailToken(
    h.ctx.store,
    await emailHash(OWNER),
    "change",
    T0,
    "inte-krypterat",
  );
  h.now = T0 + 60_000;

  const response = await handleEmailChange(h.ctx, confirm(token));

  assertStringIncludes(await response.text(), "funkade inte");
  const after = await getCode(h.ctx.store, slug, h.now);
  assertEquals(await readOwnerEmail(h.ctx.emailKey, after!), OWNER);
});

/** Minting refuses it, so the only way one exists is a record nobody here wrote. */
Deno.test("a change token carrying no address at all is refused", async () => {
  const h = await harness();
  await ownedCode(h);
  const token = "d".repeat(64);
  await h.ctx.store.put(
    `tokens/${await hashToken(token)}.json`,
    JSON.stringify({
      purpose: "change",
      epost: await emailHash(OWNER),
      expiresAt: T0 + CHANGE_TTL_MS,
    }),
  );
  h.now = T0 + 60_000;

  assertStringIncludes(
    await (await handleEmailChange(h.ctx, confirm(token))).text(),
    "funkade inte",
  );
});

/* ---------- the change moves every code on the address ---------- */

/**
 * The button that starts this is not attached to a code, so there is no answer to "which one".
 * It moves the address, and everything that address owns goes with it. Mock 15 says so out loud:
 * "Flyttar alla tre koderna."
 */
Deno.test("confirming moves every code the address owns", async () => {
  const h = await harness();
  const { slugs, token } = await pending(h, { codes: 3 });
  h.now = T0 + 60_000;

  assertEquals((await handleEmailChange(h.ctx, confirm(token))).status, 303);

  for (const slug of slugs) {
    const record = await getCode(h.ctx.store, slug, h.now);
    assertEquals(await readOwnerEmail(h.ctx.emailKey, record!), NEW, slug);
  }
  assertEquals((await codesForEmail(h.ctx.store, NEW)).sort(), [...slugs].sort());
  assertEquals(await codesForEmail(h.ctx.store, OWNER), []);
});

Deno.test("a code deleted between asking and confirming does not hold up the rest", async () => {
  const h = await harness();
  const { slugs, token } = await pending(h, { codes: 3 });
  await deleteCode(h.ctx.store, slugs[1]!);
  h.now = T0 + 60_000;

  assertEquals((await handleEmailChange(h.ctx, confirm(token))).status, 303);

  for (const slug of [slugs[0]!, slugs[2]!]) {
    const record = await getCode(h.ctx.store, slug, h.now);
    assertEquals(await readOwnerEmail(h.ctx.emailKey, record!), NEW, slug);
  }
  assertEquals((await codesForEmail(h.ctx.store, NEW)).sort(), [slugs[0]!, slugs[2]!].sort());
});

/** Somebody else's codes are on another key entirely, and the token names one address. */
Deno.test("a change never touches a code belonging to another address", async () => {
  const h = await harness();
  const { token } = await pending(h);
  const theirs = await ownedCode(h, "nagon.annan@exempel.se");
  h.now = T0 + 60_000;

  await handleEmailChange(h.ctx, confirm(token));

  const record = await getCode(h.ctx.store, theirs, h.now);
  assertEquals(await readOwnerEmail(h.ctx.emailKey, record!), "nagon.annan@exempel.se");
});

/** A scanner sees the confirmation page, so it must not name the address or the code. */
Deno.test("the confirmation page reveals neither address nor slug", async () => {
  const h = await harness();
  const { slug, token } = await pending(h);
  h.now = T0 + 60_000;

  const page = await (await handleEmailChange(h.ctx, open(token))).text();

  assert(!page.includes(slug), "the code must not appear on a page a scanner can fetch");
  assert(!page.includes(OWNER), "nor the old address");
  assertStringIncludes(page, 'method="post"');
  assertStringIncludes(page, 'action="/byt-epost"');
});

Deno.test("other methods are refused", async () => {
  const h = await harness();
  const { token } = await pending(h);

  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const response = await handleEmailChange(
      h.ctx,
      new Request(`https://ojhej.se/byt-epost?t=${token}`, { method }),
    );
    assertEquals(response.status, 405, method);
  }
});

Deno.test("the redirect is relative, so it cannot be pointed elsewhere", async () => {
  const h = await harness();
  const { token } = await pending(h);
  h.now = T0 + 60_000;

  const location = (await handleEmailChange(h.ctx, confirm(token))).headers.get("location")!;
  assert(location.startsWith("/"), `expected a same-origin path, got ${location}`);
  assert(!location.startsWith("//"), "a protocol-relative URL would leave the site");
});
