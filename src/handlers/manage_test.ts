import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createChallenge, recordChallenge } from "../antispam/altcha.ts";
import { MIN_FILL_MS } from "../antispam/form.ts";
import { importKey, sha256Hex } from "../store/crypto.ts";
import { createMemoryStore, type MemoryStoreHandle } from "../store/storage.ts";
import {
  claimSignupSlot,
  codesForEmail,
  emailHash,
  linkCodeToEmail,
  MAX_CODES_PER_EMAIL,
  MAX_MANAGE_LINKS_PER_DAY,
} from "../store/emails.ts";
import {
  createCode,
  deleteCode,
  getCode,
  readOwnerEmail,
  setDesign,
  setStatus,
} from "../store/shirts.ts";
import { readActivations } from "../store/stats.ts";
import { MANAGE_TTL_MS, mintEmailToken, mintToken } from "../store/tokens.ts";
import type { AppContext } from "./context.ts";
import { handleManageAction, handleManageRequest } from "./manage.ts";

const KEY = "3q2+796tvu/erb7v3q2+796tvu/erb7v3q2+796tvu8=";
const HMAC = "altcha-test-secret";
const OWNER = "anders@exempel.se";
const T0 = Date.parse("2026-08-12T10:00:00Z");
const LATER = T0 + MIN_FILL_MS + 1000;

interface Harness {
  ctx: AppContext;
  handle: MemoryStoreHandle;
  sent: { url: string; body: Record<string, unknown> }[];
  now: number;
}

async function harness(options: { failMail?: boolean } = {}): Promise<Harness> {
  const handle = createMemoryStore();
  const sent: { url: string; body: Record<string, unknown> }[] = [];

  const h: Harness = {
    handle,
    sent,
    now: T0,
    ctx: {
      store: handle.store,
      emailKey: await importKey(KEY),
      config: {
        baseUrl: "https://ojhej.se",
        altchaHmacKey: HMAC,
        smtp2go: {
          apiKey: "api-test",
          baseUrl: "https://api.smtp2go.com/v3",
          sender: "Oj hej <hej@ojhej.se>",
        },
      },
      fetch: ((url: string, init: RequestInit) => {
        sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: { succeeded: options.failMail ? 0 : 1, email_id: "e1" } }),
            { status: 200 },
          ),
        );
      }) as unknown as typeof fetch,
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

async function goodBody(h: Harness | null, overrides: Record<string, unknown> = {}) {
  const issuedAt = h ? h.now : T0;
  const challenge = await createChallenge(HMAC, issuedAt, { maxnumber: 300 });
  if (h) await recordChallenge(h.ctx.store, challenge, issuedAt);

  let solved = "";
  for (let n = 0; n <= challenge.maxnumber; n++) {
    if (await sha256Hex(challenge.salt + n) === challenge.challenge) {
      solved = btoa(JSON.stringify({ ...challenge, number: n }));
      break;
    }
  }

  return { epost: OWNER, hemsida: "", startedAt: T0, altcha: solved, ...overrides };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://ojhej.se${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ask = (body: unknown) => post("/api/hantera", body);
const act = (body: unknown) => post("/api/hantera/atgard", body);

/** The link in the mail, which is the only way to reach the action endpoint. */
function tokenFromMail(h: Harness, index = 0): string {
  const entry = h.sent[index];
  assert(entry, `expected at least ${index + 1} mail, saw ${h.sent.length}`);

  const match = String(entry.body.text_body).match(/\/hantera\?t=([A-Za-z0-9_-]+)/);
  const token = match?.[1];
  assert(token, "the mail must carry a management link");
  return token;
}

/** The plain-text part, split into lines, because the code list is one line per code. */
function lines(text: string): string[] {
  return text.split(String.fromCharCode(10)).map((line) => line.trimEnd());
}

/** The nth mail we handed to SMTP2GO, with a readable failure if it was never sent. */
function mailBody(h: Harness, index = 0): Record<string, unknown> {
  const entry = h.sent[index];
  assert(entry, `expected at least ${index + 1} mail, saw ${h.sent.length}`);
  return entry.body;
}

/* ---------- asking for a link ---------- */

/**
 * The half of the 2026-08-14 defect that the owner actually feels. A single bad entry in the
 * reverse index used to throw out of `getCode` and take the whole request with it, so the codes
 * that were perfectly fine became unreachable too.
 */
Deno.test("a bad entry in the index does not cost the owner their real codes", async () => {
  const h = await harness();
  await ownedCode(h);
  await linkCodeToEmail(h.ctx.store, OWNER, "not-a-slug");
  h.now = LATER;

  const response = await handleManageRequest(h.ctx, ask(await goodBody(h)));

  assertEquals(response.status, 200);
  assertEquals(h.sent.length, 1, "the good code still gets its link");
  assertStringIncludes(String(mailBody(h).text_body), "/hantera?t=");
});

/**
 * One mail, however many codes. The old shape minted a token per code and sent a mail per code,
 * which is three identical mails at three codes and unusable at eight.
 */
Deno.test("a known address gets one link, whatever the code count", async () => {
  const h = await harness();
  for (let n = 0; n < 3; n++) await ownedCode(h);
  h.now = LATER;

  const response = await handleManageRequest(h.ctx, ask(await goodBody(h)));

  assertEquals(response.status, 200);
  assertEquals(h.sent.length, 1, "three codes, one mail");
  assertEquals(mailBody(h).to, [OWNER]);
  assertStringIncludes(String(mailBody(h).text_body), "https://ojhej.se/hantera?t=");
});

Deno.test("the mail names the codes it is about, by their printed text", async () => {
  const h = await harness();
  const first = await ownedCode(h);
  const second = await ownedCode(h);
  await setDesign(h.ctx.store, first, { syfte: "hej", rad: "", etikett: "DEJTA" }, T0);
  await setDesign(h.ctx.store, second, {
    syfte: "borttappat",
    rad: "",
    etikett: "HITTAT?",
  }, T0);
  h.now = LATER;

  await handleManageRequest(h.ctx, ask(await goodBody(h)));

  const body = String(mailBody(h).text_body);
  assertStringIncludes(body, "DEJTA");
  assertStringIncludes(body, "HITTAT?");
  assertStringIncludes(body, "Borttappat");
});

/** The index can name a code that is gone. Listing it would be a mail about nothing. */
Deno.test("a code deleted since the index was written is not listed", async () => {
  const h = await harness();
  const kept = await ownedCode(h);
  const gone = await ownedCode(h);
  await deleteCode(h.ctx.store, gone);
  await setDesign(h.ctx.store, kept, { syfte: "hej", rad: "", etikett: "KVAR" }, T0);
  h.now = LATER;

  await handleManageRequest(h.ctx, ask(await goodBody(h)));

  assertEquals(h.sent.length, 1);
  const body = String(mailBody(h).text_body);
  assertStringIncludes(body, "KVAR");
  assertEquals(lines(body).filter((line) => line.startsWith("- ")).length, 1);
});

Deno.test("an address whose codes have all been deleted gets no mail at all", async () => {
  const h = await harness();
  const gone = await ownedCode(h);
  await deleteCode(h.ctx.store, gone);
  h.now = LATER;

  const response = await handleManageRequest(h.ctx, ask(await goodBody(h)));

  assertEquals(response.status, 200, "and still answers exactly like every other case");
  assertEquals(h.sent.length, 0);
});

/**
 * The oracle this endpoint must not become. If a known address answered differently from an
 * unknown one, anybody could ask "does this person use ojhej" about anyone they like.
 */
Deno.test("known, unknown and malformed addresses are one single answer", async () => {
  const answers = new Set<string>();

  for (const epost of [OWNER, "ingen@exempel.se", "inte en adress", "", "  "]) {
    const h = await harness();
    if (epost === OWNER) await ownedCode(h);
    h.now = LATER;

    const response = await handleManageRequest(h.ctx, ask(await goodBody(h, { epost })));
    answers.add(`${response.status}:${await response.text()}`);
  }

  assertEquals(answers.size, 1, "the answer must not depend on whether the address is known");
});

Deno.test("a code belonging to someone else is never mailed about", async () => {
  const h = await harness();
  await ownedCode(h, "nagon.annan@exempel.se");
  h.now = LATER;

  await handleManageRequest(h.ctx, ask(await goodBody(h, { epost: OWNER })));

  assertEquals(h.sent.length, 0, "the reverse index must be keyed to the asking address");
});

/** R9 again: this endpoint sends mail, so one solve must not buy a burst of it. */
Deno.test("one proof of work buys exactly one link request", async () => {
  const h = await harness();
  await ownedCode(h);
  h.now = LATER;
  const body = await goodBody(h);

  await Promise.all(Array.from({ length: 20 }, () => handleManageRequest(h.ctx, ask(body))));

  assertEquals(h.sent.length, 1, "20 concurrent requests must yield one mail");
});

Deno.test("the anti-abuse layers refuse identically and send nothing", async () => {
  const answers = new Set<string>();

  for (const bad of [{ hemsida: "spam" }, { altcha: "garbage" }, { altcha: "" }]) {
    const h = await harness();
    await ownedCode(h);
    h.now = LATER;

    const response = await handleManageRequest(h.ctx, ask(await goodBody(h, bad)));
    assertEquals(h.sent.length, 0, JSON.stringify(bad));
    answers.add(`${response.status}:${await response.text()}`);
  }

  assertEquals(answers.size, 1);
});

Deno.test("a mail that was accepted but not sent is reported as a failure", async () => {
  const h = await harness({ failMail: true });
  await ownedCode(h);
  h.now = LATER;

  const response = await handleManageRequest(h.ctx, ask(await goodBody(h)));
  assertEquals(response.status, 502);
});

/* ---------- acting on a link ---------- */

async function linkFor(h: Harness, slug: string): Promise<string> {
  const { token } = await mintToken(h.ctx.store, slug, "manage", h.now);
  return token;
}

Deno.test("pausing stops the code, and resuming starts it again", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;

  const paused = await handleManageAction(
    h.ctx,
    act({ t: await linkFor(h, slug), atgard: "pausa" }),
  );
  assertEquals(paused.status, 200);
  assertEquals((await getCode(h.ctx.store, slug, h.now))?.status, "paused");

  const back = await handleManageAction(
    h.ctx,
    act({ t: await linkFor(h, slug), atgard: "ateruppta" }),
  );
  assertEquals(back.status, 200);
  assertEquals((await getCode(h.ctx.store, slug, h.now))?.status, "active");
});

/**
 * The owner can act again without going back to their inbox. The convenience is only sound if
 * the handed-back link is itself short-lived and single-use, so this checks it behaves like
 * any other management token rather than becoming a standing key.
 */
Deno.test("the link handed back after an action works once and no more", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;

  const first = await handleManageAction(
    h.ctx,
    act({ t: await linkFor(h, slug), atgard: "pausa" }),
  );
  const next = String((await first.json()).next);
  const fresh = next.slice(next.indexOf("t=") + 2);

  const second = await handleManageAction(h.ctx, act({ t: fresh, atgard: "ateruppta" }));
  assertEquals(second.status, 200);

  const replay = await handleManageAction(h.ctx, act({ t: fresh, atgard: "pausa" }));
  assertEquals(replay.status, 403, "the fresh link is single-use too");
});

/**
 * Deleting is the destructive one, and deliberately has no soft-delete: an owner who asks us
 * to forget them must not leave an encrypted address behind in storage.
 */
Deno.test("deleting removes the record, and the address with it", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;

  const response = await handleManageAction(
    h.ctx,
    act({ t: await linkFor(h, slug), atgard: "radera" }),
  );

  assertEquals(response.status, 200);
  assertEquals((await response.json()).next, "/raderad");
  assertEquals(await getCode(h.ctx.store, slug, h.now), null);

  for (const key of h.handle.keys()) {
    const raw = await h.handle.store.get(key);
    assert(!String(raw).includes(OWNER), `the address survived in ${key}`);
  }
});

Deno.test("a deleted code stops accepting anything", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;

  await handleManageAction(h.ctx, act({ t: await linkFor(h, slug), atgard: "radera" }));

  const after = await handleManageAction(
    h.ctx,
    act({ t: await linkFor(h, slug), atgard: "pausa" }),
  );
  assertEquals(after.status, 404);
});

Deno.test("a management link is spent by the action and cannot be replayed", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;
  const token = await linkFor(h, slug);

  assertEquals((await handleManageAction(h.ctx, act({ t: token, atgard: "pausa" }))).status, 200);
  assertEquals((await handleManageAction(h.ctx, act({ t: token, atgard: "radera" }))).status, 403);
  assert(await getCode(h.ctx.store, slug, h.now), "the replayed delete must not have run");
});

/**
 * The property that makes the two-step shape safe under mail gateway prefetching, measured
 * where it counts: a burst of identical actions must resolve to exactly one.
 */
Deno.test("concurrent actions on one link yield exactly one winner", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;
  const token = await linkFor(h, slug);

  const responses = await Promise.all(
    Array.from(
      { length: 20 },
      () => handleManageAction(h.ctx, act({ t: token, atgard: "radera" })),
    ),
  );

  assertEquals(responses.filter((r) => r.status === 200).length, 1);
});

/**
 * A verification link lives for seven days and only activates. If it could also delete, the
 * long lifetime and the destructive action would meet in whichever way suits an attacker.
 */
Deno.test("a verification token cannot perform a management action", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;
  const { token } = await mintToken(h.ctx.store, slug, "verify", h.now);

  const response = await handleManageAction(h.ctx, act({ t: token, atgard: "radera" }));

  assertEquals(response.status, 403);
  assert(await getCode(h.ctx.store, slug, h.now), "the code must still be there");
});

Deno.test("an expired link is refused", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;
  const token = await linkFor(h, slug);

  h.now = LATER + MANAGE_TTL_MS + 1000;
  const response = await handleManageAction(h.ctx, act({ t: token, atgard: "radera" }));

  assertEquals(response.status, 403);
  assert(await getCode(h.ctx.store, slug, h.now), "the code must still be there");
});

Deno.test("a missing, empty or unknown token is refused", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;

  for (const t of [undefined, "", "nonsense", "../../shirts/x", 7, null]) {
    const response = await handleManageAction(h.ctx, act({ t, atgard: "radera" }));
    assertEquals(response.status, 403, String(t));
  }
  assert(await getCode(h.ctx.store, slug, h.now));
});

Deno.test("an unknown action is refused before the token is spent", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;
  const token = await linkFor(h, slug);

  for (const atgard of ["radera-allt", "", "PAUSA", 7, null]) {
    assertEquals((await handleManageAction(h.ctx, act({ t: token, atgard }))).status, 400);
  }

  // The token survived, so a typo in the action does not cost the owner their link.
  assertEquals((await handleManageAction(h.ctx, act({ t: token, atgard: "pausa" }))).status, 200);
});

Deno.test("a malformed body is refused without throwing", async () => {
  const h = await harness();
  h.now = LATER;

  for (const raw of ["", "not json", "[]", "null", "7"]) {
    for (const path of ["/api/hantera", "/api/hantera/atgard"]) {
      const request = new Request(`https://ojhej.se${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      const handler = path.endsWith("atgard") ? handleManageAction : handleManageRequest;
      assertEquals((await handler(h.ctx, request)).status, 400, `${path} ${raw}`);
    }
  }
  assertEquals(h.sent.length, 0);
});

Deno.test("other methods are refused on both endpoints", async () => {
  const h = await harness();

  for (const path of ["/api/hantera", "/api/hantera/atgard"]) {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const handler = path.endsWith("atgard") ? handleManageAction : handleManageRequest;
      const response = await handler(h.ctx, new Request(`https://ojhej.se${path}`, { method }));
      assertEquals(response.status, 405, `${method} ${path}`);
    }
  }
});

/** Neither endpoint may hand back the slug or the address to whoever is asking. */
Deno.test("no response leaks the address, and the link mail carries no slug", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;

  const asked = await handleManageRequest(h.ctx, ask(await goodBody(h)));
  const text = await asked.text();
  assert(!text.includes(OWNER), "the address came back in the answer");
  assert(!text.includes(slug), "the slug came back in the answer");

  const body = String(mailBody(h).text_body) + String(mailBody(h).html_body);
  assert(!body.includes(slug), "a mail that names the code turns an inbox leak into a takeover");

  const acted = await handleManageAction(
    h.ctx,
    act({ t: tokenFromMail(h), atgard: "pausa" }),
  );
  assert(!(await acted.text()).includes(OWNER));
});

/* ---------- changing the owner address ---------- */

/**
 * The change cannot take effect when it is asked for. A management link lives in an inbox, so
 * treating "asked from a valid link" as "prove you own the new address" would make a single
 * compromised mailbox enough to redirect every future message to an address of someone else's
 * choosing. Asking only starts the request; the new address has to answer for itself.
 */
Deno.test("asking to change the address moves nothing yet", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;

  const response = await handleManageAction(
    h.ctx,
    act({ t: await koderLink(h), atgard: "byt-epost", epost: "ny@exempel.se" }),
  );

  assertEquals(response.status, 200);
  const record = await getCode(h.ctx.store, slug, h.now);
  assertEquals(
    await readOwnerEmail(h.ctx.emailKey, record!),
    OWNER,
    "the address must not move until the new one confirms",
  );
  assertEquals(await codesForEmail(h.ctx.store, OWNER), [slug], "nor the index");
});

Deno.test("asking sends a confirmation to the new address and a warning to the old", async () => {
  const h = await harness();
  await ownedCode(h);
  h.now = LATER;

  await handleManageAction(
    h.ctx,
    act({ t: await koderLink(h), atgard: "byt-epost", epost: "ny@exempel.se" }),
  );

  assertEquals(h.sent.length, 2, "both inboxes hear about it");

  const confirm = h.sent.find((m) => JSON.stringify(m.body.to).includes("ny@exempel.se"));
  const notice = h.sent.find((m) => JSON.stringify(m.body.to).includes(OWNER));
  assert(confirm, "the new address gets the confirmation");
  assert(notice, "the old address gets the warning");

  assertStringIncludes(String(confirm.body.text_body), "https://ojhej.se/byt-epost?t=");
  assert(
    !String(notice.body.text_body).includes("http"),
    "the warning carries no link, because whoever asked chose its timing",
  );
  assertStringIncludes(String(notice.body.text_body), "ny@exempel.se");
});

Deno.test("a malformed new address is refused without costing the owner their link", async () => {
  const h = await harness();
  await ownedCode(h);
  h.now = LATER;
  const token = await koderLink(h);

  for (const epost of ["inte en adress", "", "  ", undefined, 7, "a@b@c.se"]) {
    const response = await handleManageAction(
      h.ctx,
      act({ t: token, atgard: "byt-epost", epost }),
    );
    assertEquals(response.status, 400, String(epost));
  }
  assertEquals(h.sent.length, 0);

  // The link survived every one of those, so a typo does not send the owner back to their inbox.
  const good = await handleManageAction(
    h.ctx,
    act({ t: token, atgard: "byt-epost", epost: "ny@exempel.se" }),
  );
  assertEquals(good.status, 200);
});

Deno.test("one management link buys one change request, not a burst of warnings", async () => {
  const h = await harness();
  await ownedCode(h);
  h.now = LATER;
  const token = await koderLink(h);

  const responses = await Promise.all(
    Array.from(
      { length: 20 },
      () => handleManageAction(h.ctx, act({ t: token, atgard: "byt-epost", epost: "ny@x.se" })),
    ),
  );

  assertEquals(responses.filter((r) => r.status === 200).length, 1);
  assertEquals(h.sent.length, 2, "one confirmation and one warning, however hard it is pushed");
});

/* ---------- one link, several codes ---------- */

/** The link the mail actually carries: one token naming the address, not a code. */
async function koderLink(h: Harness, email = OWNER): Promise<string> {
  const { token } = await mintEmailToken(h.ctx.store, await emailHash(email), "koder", h.now);
  return token;
}

Deno.test("an address link can act on any code that address owns", async () => {
  const h = await harness();
  const first = await ownedCode(h);
  const second = await ownedCode(h);
  h.now = LATER;

  const paused = await handleManageAction(
    h.ctx,
    act({ t: await koderLink(h), atgard: "pausa", slug: second }),
  );

  assertEquals(paused.status, 200);
  assertEquals((await getCode(h.ctx.store, second, h.now))?.status, "paused");
  assertEquals((await getCode(h.ctx.store, first, h.now))?.status, "active", "and only that one");
});

/**
 * The check this whole change turns on. Before it a token named one code and a caller could not
 * ask for another; now the caller names the code, so every action has to verify that the code
 * belongs to the address the token was minted for. OWASP API1:2023, and the reason these tests
 * were written before the endpoint learned to take a slug.
 */
Deno.test("an address link cannot touch a code belonging to somebody else", async () => {
  const h = await harness();
  const mine = await ownedCode(h);
  const theirs = await ownedCode(h, "nagon.annan@exempel.se");
  h.now = LATER;

  const response = await handleManageAction(
    h.ctx,
    act({ t: await koderLink(h), atgard: "radera", slug: theirs }),
  );

  assert(await getCode(h.ctx.store, theirs, h.now), "the stranger's code must survive");
  assert(await getCode(h.ctx.store, mine, h.now));
  assertEquals(response.status, 404);
});

/**
 * "Not yours" and "never existed" must be one answer. Two answers turn this endpoint into a way
 * to ask whether a slug photographed off a jacket is a real code.
 */
Deno.test("a code that is not yours answers exactly like a code that does not exist", async () => {
  const h = await harness();
  await ownedCode(h);
  const theirs = await ownedCode(h, "nagon.annan@exempel.se");
  h.now = LATER;

  const answers = new Set<string>();
  for (const slug of [theirs, "ZZ11223344556677889A", "inte-en-slug", "", undefined]) {
    const response = await handleManageAction(
      h.ctx,
      act({ t: await koderLink(h), atgard: "pausa", slug }),
    );
    answers.add(`${response.status}:${await response.text()}`);
  }

  assertEquals(answers.size, 1, "the refusals must be indistinguishable");
});

/**
 * A refusal must not cost an honest owner their link. The membership check therefore runs on a
 * peek, before the token is spent, exactly as the unknown-action and malformed-address checks
 * already do.
 */
Deno.test("naming the wrong code does not spend the link", async () => {
  const h = await harness();
  const mine = await ownedCode(h);
  const theirs = await ownedCode(h, "nagon.annan@exempel.se");
  h.now = LATER;
  const token = await koderLink(h);

  assertEquals(
    (await handleManageAction(h.ctx, act({ t: token, atgard: "pausa", slug: theirs }))).status,
    404,
  );

  const good = await handleManageAction(h.ctx, act({ t: token, atgard: "pausa", slug: mine }));
  assertEquals(good.status, 200, "the link still worked for a code the owner does own");
});

Deno.test("a single-code link cannot be pointed at another code", async () => {
  const h = await harness();
  const first = await ownedCode(h);
  const second = await ownedCode(h);
  h.now = LATER;

  const response = await handleManageAction(
    h.ctx,
    act({ t: await linkFor(h, first), atgard: "radera", slug: second }),
  );

  assertEquals(response.status, 404);
  assert(await getCode(h.ctx.store, second, h.now), "a token for one code grants exactly one code");
});

Deno.test("deleting one of several returns to the list, and the last to the goodbye", async () => {
  const h = await harness();
  const first = await ownedCode(h);
  const second = await ownedCode(h);
  h.now = LATER;

  const one = await handleManageAction(
    h.ctx,
    act({ t: await koderLink(h), atgard: "radera", slug: first }),
  );
  assertStringIncludes(String((await one.json()).next), "/hantera?t=");

  const last = await handleManageAction(
    h.ctx,
    act({ t: await koderLink(h), atgard: "radera", slug: second }),
  );
  assertEquals((await last.json()).next, "/raderad");
});

Deno.test("deleting a code takes it out of the address's list", async () => {
  const h = await harness();
  const first = await ownedCode(h);
  const second = await ownedCode(h);
  h.now = LATER;

  await handleManageAction(h.ctx, act({ t: await koderLink(h), atgard: "radera", slug: first }));

  assertEquals(
    await codesForEmail(h.ctx.store, OWNER),
    [second],
    "a deleted code must not keep a place in the list it no longer belongs to",
  );
});

/* ---------- what a code is for ---------- */

Deno.test("setting a purpose stores it and hands back a link to that code", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;

  const response = await handleManageAction(
    h.ctx,
    act({ t: await linkFor(h, slug), atgard: "syfte", syfte: "borttappat", etikett: "HITTAT?" }),
  );

  assertEquals(response.status, 200);
  const record = (await getCode(h.ctx.store, slug, h.now))!;
  assertEquals(record.syfte, "borttappat");
  assertEquals(record.etikett, "HITTAT?");

  const fresh = String((await response.json()).t);
  assert(fresh.length > 0, "the page keeps working without a trip back to the inbox");
});

Deno.test("an own line is stored only for eget", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;

  await handleManageAction(
    h.ctx,
    act({
      t: await linkFor(h, slug),
      atgard: "syfte",
      syfte: "eget",
      rad: "Väskan är min. Hör av dig.",
      etikett: "HITTAT?",
    }),
  );

  assertEquals((await getCode(h.ctx.store, slug, h.now))?.rad, "Väskan är min. Hör av dig.");
});

Deno.test("a purpose that does not exist is refused before the token is spent", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;
  const token = await linkFor(h, slug);

  for (const syfte of ["kattutställning", "", 7, null, undefined]) {
    const response = await handleManageAction(h.ctx, act({ t: token, atgard: "syfte", syfte }));
    assertEquals(response.status, 400, String(syfte));
  }

  const good = await handleManageAction(h.ctx, act({ t: token, atgard: "syfte", syfte: "fest" }));
  assertEquals(good.status, 200, "the link survived every one of those");
});

Deno.test("a line longer than the limit is refused rather than trimmed", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;

  const response = await handleManageAction(
    h.ctx,
    act({ t: await linkFor(h, slug), atgard: "syfte", syfte: "eget", rad: "a".repeat(91) }),
  );

  assertEquals(response.status, 400);
  assertEquals((await getCode(h.ctx.store, slug, h.now))?.rad, undefined);
});

Deno.test("opening a code hands back a link to its own page", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  const other = await ownedCode(h);
  h.now = LATER;

  const response = await handleManageAction(
    h.ctx,
    act({ t: await koderLink(h), atgard: "oppna", slug: other }),
  );

  assertEquals(response.status, 200);
  const next = String((await response.json()).next);
  assertStringIncludes(next, "/klar?t=");
  assert(!next.includes(other), "the code goes in the token, not in the URL");
  assert(!next.includes(slug));
});

/* ---------- one more code, without another mail ---------- */

/**
 * The address is already verified, and the link that authorised this was single-use and has just
 * been spent. There is nothing left to prove by mailing another link, so the new code is active
 * immediately. The cap is what bounds it.
 */
Deno.test("an owner can make another code, and it is live at once", async () => {
  const h = await harness();
  const first = await ownedCode(h);
  h.now = LATER;

  const response = await handleManageAction(h.ctx, act({ t: await koderLink(h), atgard: "skapa" }));

  assertEquals(response.status, 200);
  assertEquals(h.sent.length, 0, "no mail, because there is nothing left to prove");

  const slugs = await codesForEmail(h.ctx.store, OWNER);
  assertEquals(slugs.length, 2);
  const fresh = (await getCode(h.ctx.store, slugs.find((slug) => slug !== first)!, h.now))!;
  assertEquals(fresh.status, "active");
  assertEquals(
    await readOwnerEmail(h.ctx.emailKey, fresh),
    OWNER,
    "and it belongs to the address that asked",
  );
});

Deno.test("a new code lands on its own page, ready to design", async () => {
  const h = await harness();
  await ownedCode(h);
  h.now = LATER;

  const response = await handleManageAction(h.ctx, act({ t: await koderLink(h), atgard: "skapa" }));
  assertStringIncludes(String((await response.json()).next), "/klar?t=");
});

Deno.test("the tenth code is allowed and the eleventh is not", async () => {
  const h = await harness();
  for (let n = 0; n < MAX_CODES_PER_EMAIL; n++) await ownedCode(h);
  h.now = LATER;

  const response = await handleManageAction(h.ctx, act({ t: await koderLink(h), atgard: "skapa" }));

  assertEquals(response.status, 429);
  assertEquals((await codesForEmail(h.ctx.store, OWNER)).length, MAX_CODES_PER_EMAIL);
});

/** The landing figure counts codes that came to life, and this is one of the ways they do. */
Deno.test("a code made from the list counts as an activation, exactly once", async () => {
  const h = await harness();
  await ownedCode(h);
  h.now = LATER;
  const before = await readActivations(h.ctx.store);

  await handleManageAction(h.ctx, act({ t: await koderLink(h), atgard: "skapa" }));

  assertEquals(await readActivations(h.ctx.store), (before ?? 0) + 1);
});

Deno.test("making a code needs a link to the address, not to one code", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  h.now = LATER;

  const response = await handleManageAction(
    h.ctx,
    act({ t: await linkFor(h, slug), atgard: "skapa" }),
  );

  assertEquals(response.status, 403);
  assertEquals((await codesForEmail(h.ctx.store, OWNER)).length, 1);
});

Deno.test("one link buys one new code, however hard it is pushed", async () => {
  const h = await harness();
  await ownedCode(h);
  h.now = LATER;
  const token = await koderLink(h);

  const responses = await Promise.all(
    Array.from({ length: 20 }, () => handleManageAction(h.ctx, act({ t: token, atgard: "skapa" }))),
  );

  assertEquals(responses.filter((r) => r.status === 200).length, 1);
  assertEquals((await codesForEmail(h.ctx.store, OWNER)).length, 2);
});

/**
 * A code link opens one code. Moving the address moves every code the address owns, so a link
 * that grants one of them must not be able to start it: that would be a token quietly acting
 * beyond what it names, which is the shape of the bug this whole change is trying not to have.
 */
Deno.test("a single-code link cannot start a change of address", async () => {
  const h = await harness();
  const slug = await ownedCode(h);
  await ownedCode(h);
  h.now = LATER;

  const response = await handleManageAction(
    h.ctx,
    act({ t: await linkFor(h, slug), atgard: "byt-epost", epost: "ny@exempel.se" }),
  );

  assertEquals(response.status, 403);
  assertEquals(h.sent.length, 0, "and nobody is mailed about it");
});

Deno.test("the change of address names every code it would move", async () => {
  const h = await harness();
  await ownedCode(h);
  await ownedCode(h);
  h.now = LATER;

  await handleManageAction(
    h.ctx,
    act({ t: await koderLink(h), atgard: "byt-epost", epost: "ny@exempel.se" }),
  );

  const confirm = h.sent.find((m) => JSON.stringify(m.body.to).includes("ny@exempel.se"))!;
  const notice = h.sent.find((m) => JSON.stringify(m.body.to).includes(OWNER))!;
  assertStringIncludes(String(confirm.body.text_body), "koderna");
  assertStringIncludes(String(notice.body.text_body), "dina koder");
});

/**
 * The one mail-sending endpoint that had no cap.
 *
 * Signup has `claimSignupSlot`, the relay has its daily cap, creation has MAX_CODES_PER_EMAIL.
 * This had only the proof of work, so a solved challenge bought one more mail carrying a live
 * 30-minute token reaching every code the address owns. Unbounded, aimed at a confirmed owner,
 * from a domain they trust, which is a worse shape than the signup hole it resembles.
 */
Deno.test("a manage link is capped per address per day", async () => {
  const h = await harness();
  await ownedCode(h);
  h.now = LATER;

  for (let attempt = 1; attempt <= MAX_MANAGE_LINKS_PER_DAY; attempt++) {
    const response = await handleManageRequest(h.ctx, ask(await goodBody(h)));
    assertEquals(response.status, 200, `attempt ${attempt}`);
    assertEquals(h.sent.length, attempt, `attempt ${attempt} should have mailed`);
  }

  // Byte-identical to a send. A cap that announced itself would turn this endpoint into the
  // registration oracle the matching answers exist to prevent.
  const sample = await handleManageRequest(
    h.ctx,
    ask(await goodBody(h, { epost: "ingen@exempel.se" })),
  );
  const over = await handleManageRequest(h.ctx, ask(await goodBody(h)));
  assertEquals(over.status, 200, "a refusal must look exactly like a send");
  assertEquals(await over.json(), await sample.json(), "and say exactly the same thing");
  assertEquals(h.sent.length, MAX_MANAGE_LINKS_PER_DAY, "the mail past the cap must not go");
});

/** A cap that never lifts is an owner locked out of their own controls. */
Deno.test("the manage-link cap is daily, not permanent", async () => {
  const h = await harness();
  await ownedCode(h);
  h.now = LATER;

  for (let attempt = 0; attempt < MAX_MANAGE_LINKS_PER_DAY; attempt++) {
    await handleManageRequest(h.ctx, ask(await goodBody(h)));
  }
  assertEquals(h.sent.length, MAX_MANAGE_LINKS_PER_DAY);

  // A day later, with a form filled in on that day: `goodBody` hardcodes `startedAt: T0`, and a
  // form older than MAX_FILL_MS is refused as stale before the cap is ever consulted.
  h.now = LATER + 86_400_000;
  await handleManageRequest(h.ctx, ask(await goodBody(h, { startedAt: h.now - MIN_FILL_MS * 2 })));
  assertEquals(h.sent.length, MAX_MANAGE_LINKS_PER_DAY + 1, "tomorrow is a fresh allowance");
});

/** Asking about an address nobody has ever signed up with must not write anything. */
Deno.test("the cap does not create a record for an address we do not know", async () => {
  const h = await harness();
  h.now = LATER;
  const before = h.handle.size();

  const response = await handleManageRequest(
    h.ctx,
    ask(await goodBody(h, { epost: "framling@exempel.se" })),
  );

  assertEquals(response.status, 200);
  assertEquals(h.sent.length, 0, "no mail for an address with no codes");
  assertEquals(h.handle.size(), before, "and no object written, so probing leaves no trace");
});

/** Signups and manage links limit different things and must not share a budget. */
Deno.test("asking for a manage link does not spend the signup allowance", async () => {
  const h = await harness();
  await ownedCode(h);
  h.now = LATER;

  for (let attempt = 0; attempt < MAX_MANAGE_LINKS_PER_DAY; attempt++) {
    await handleManageRequest(h.ctx, ask(await goodBody(h)));
  }

  const slot = await claimSignupSlot(h.ctx.store, OWNER, h.now);
  assertEquals(slot.allowed, true, "the signup cap is a different counter");
  assertEquals(slot.used, 1);

  // And the reverse: the codes this address owns survived both counters being written.
  assertEquals((await codesForEmail(h.ctx.store, OWNER)).length, 1);
});
