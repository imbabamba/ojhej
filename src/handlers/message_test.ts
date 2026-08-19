import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createChallenge, recordChallenge } from "../antispam/altcha.ts";
import { MIN_FILL_MS } from "../antispam/form.ts";
import { importKey, sha256Hex } from "../store/crypto.ts";
import { createMemoryStore, type MemoryStoreHandle } from "../store/storage.ts";
import { bumpMessageCount, createCode, setStatus } from "../store/shirts.ts";
import type { AppContext } from "./context.ts";
import { handleMessage, MAX_MESSAGES_PER_DAY } from "./message.ts";

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

/** An active code, which is the only state that accepts anything. */
async function activeCode(h: Harness): Promise<string> {
  const record = await createCode(h.ctx.store, h.ctx.emailKey, OWNER, T0);
  await setStatus(h.ctx.store, record.slug, "active", T0);
  return record.slug;
}

/**
 * A body carrying a genuinely solved challenge, recorded first because a solution is spendable
 * only once and only if it was really issued. Pass null when the request should be rejected
 * before the proof is ever spent.
 */
async function goodBody(h: Harness | null, overrides: Record<string, unknown> = {}) {
  // Minted at the harness clock, not T0: a challenge carries its own expiry, so a test that
  // moves time forward needs a challenge from that moment rather than one that has aged out.
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

  return {
    namn: "Kim",
    var: "På pendeln mot Uppsala",
    meddelande: "Du hade en fin jacka. Hej!",
    kanal: "mail",
    kontakt: "kim@exempel.se",
    hemsida: "",
    startedAt: T0,
    altcha: solved,
    ...overrides,
  };
}

/** The nth mail we handed to SMTP2GO, with a readable failure if it was never sent. */
function mail(h: Harness, index = 0): Record<string, unknown> {
  const entry = h.sent[index];
  assert(entry, `expected at least ${index + 1} mail, saw ${h.sent.length}`);
  return entry.body;
}

function post(body: unknown): Request {
  return new Request("https://ojhej.se/api/meddelande", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("a message reaches the owner, who never published the address", async () => {
  const h = await harness();
  const slug = await activeCode(h);
  h.now = LATER;

  const response = await handleMessage(h.ctx, post(await goodBody(h, { slug })));

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });
  assertEquals(h.sent.length, 1);
  assertEquals(mail(h).to, [OWNER], "decrypted at the last moment, and delivered");

  const text = String(mail(h).text_body);
  assertStringIncludes(text, "Kim");
  assertStringIncludes(text, "På pendeln mot Uppsala");
  assertStringIncludes(text, "kim@exempel.se");
});

/**
 * Reply-To is the owner's own address. Pointing it at the visitor would look like a courtesy
 * and would in fact hand a stranger a way to make our mail carry their reply path.
 */
Deno.test("reply-to is the owner, never anything the visitor typed", async () => {
  const h = await harness();
  const slug = await activeCode(h);
  h.now = LATER;

  await handleMessage(h.ctx, post(await goodBody(h, { slug, kontakt: "angripare@exempel.se" })));

  assertEquals(mail(h).custom_headers, [{ header: "Reply-To", value: OWNER }]);
});

/**
 * The classic relay bug: a newline in a field a stranger controls turns one mail into two.
 * The subject is static and contact details ride in the body, so there is nothing to inject
 * into, but this pins that shape rather than trusting it.
 */
Deno.test("no visitor field can reach a mail header", async () => {
  const h = await harness();
  const slug = await activeCode(h);
  h.now = LATER;

  const injection = "Kim\r\nBcc: alla@exempel.se X-Spam: no";
  await handleMessage(
    h.ctx,
    post(await goodBody(h, { slug, namn: injection, kontakt: injection })),
  );

  const headers = [
    String(mail(h).subject),
    String(mail(h).sender),
    JSON.stringify(mail(h).to),
    JSON.stringify(mail(h).custom_headers),
  ];
  for (const header of headers) {
    // Written as escapes, never literal: a raw U+2028 inside a regex or string terminates it.
    for (const breakChar of ["\r", "\n", "\u2028", "\u2029"]) {
      assert(!header.includes(breakChar), `a line break survived into ${header}`);
    }
    assert(!header.includes("Bcc:"), `visitor text reached a header: ${header}`);
  }
});

/**
 * Unknown, pending and paused must be indistinguishable. The scan page already tells a visitor
 * what they need to know, so answering differently here only helps someone map which codes
 * exist and which are live.
 */
Deno.test("unknown, pending and paused all answer identically and send nothing", async () => {
  const answers = new Set<string>();

  for (const state of ["unknown", "pending", "paused"] as const) {
    const h = await harness();
    h.now = LATER;

    let slug = "ZZZZZZZZZZZZZZZZZZZZ";
    if (state !== "unknown") {
      const record = await createCode(h.ctx.store, h.ctx.emailKey, OWNER, T0);
      slug = record.slug;
      if (state === "paused") await setStatus(h.ctx.store, slug, "paused", T0);
    }

    const response = await handleMessage(h.ctx, post(await goodBody(h, { slug })));
    assertEquals(response.status, 409, state);
    assertEquals(h.sent.length, 0, `${state} must cost no mail`);
    answers.add(`${response.status}:${await response.text()}`);
  }

  assertEquals(answers.size, 1, "the three states must be one answer");
});

Deno.test("the daily cap holds, and the capped attempt costs no quota", async () => {
  const h = await harness();
  const slug = await activeCode(h);
  h.now = LATER;

  for (let i = 0; i < MAX_MESSAGES_PER_DAY; i++) {
    const response = await handleMessage(h.ctx, post(await goodBody(h, { slug })));
    assertEquals(response.status, 200, `message ${i}`);
  }

  const capped = await handleMessage(h.ctx, post(await goodBody(h, { slug })));
  assertEquals(capped.status, 429);
  assertEquals(
    h.sent.length,
    MAX_MESSAGES_PER_DAY,
    "the cap is taken before the send, so a capped code costs nothing",
  );
});

Deno.test("the cap is per day, so tomorrow starts fresh", async () => {
  const h = await harness();
  const slug = await activeCode(h);
  h.now = LATER;

  for (let i = 0; i < MAX_MESSAGES_PER_DAY; i++) {
    await bumpMessageCount(h.ctx.store, slug, h.now);
  }
  assertEquals((await handleMessage(h.ctx, post(await goodBody(h, { slug })))).status, 429);

  // A new day means a new page load, so startedAt moves with it. A form claiming to be a day
  // old is stale, which MAX_FILL_MS refuses on its own.
  h.now = LATER + 86_400_000;
  const tomorrow = await goodBody(h, { slug, startedAt: h.now - MIN_FILL_MS - 1000 });
  assertEquals((await handleMessage(h.ctx, post(tomorrow))).status, 200);
});

/**
 * R9 at this endpoint. The per-code cap races exactly like the signup cap, so without
 * single-use proofs one solve could fill an owner's inbox in a single burst.
 */
Deno.test("one proof of work buys exactly one message", async () => {
  for (const burst of [2, 20]) {
    const h = await harness();
    const slug = await activeCode(h);
    h.now = LATER;
    const body = await goodBody(h, { slug });

    const responses = await Promise.all(
      Array.from({ length: burst }, () => handleMessage(h.ctx, post(body))),
    );

    assertEquals(responses.filter((r) => r.status === 200).length, 1, `${burst} concurrent`);
    assertEquals(h.sent.length, 1, `${burst} concurrent requests must yield one mail`);
  }
});

Deno.test("the anti-abuse layers all refuse identically and send nothing", async () => {
  const answers = new Set<string>();

  for (
    const bad of [
      { hemsida: "spam" },
      { altcha: "garbage" },
      { altcha: "" },
      { slug: "inte-en-slug" },
      { slug: "IOUL0000000000000000" }, // the letters Crockford base32 leaves out
    ]
  ) {
    const h = await harness();
    const slug = await activeCode(h);
    h.now = LATER;

    const response = await handleMessage(h.ctx, post(await goodBody(h, { slug, ...bad })));
    assertEquals(h.sent.length, 0, `${JSON.stringify(bad)} must cost no mail`);
    answers.add(`${response.status}:${await response.text()}`);
  }

  assertEquals(answers.size, 1, "a bot must not learn which layer caught it");
});

Deno.test("an impossibly fast submission is refused and sends nothing", async () => {
  const h = await harness();
  const slug = await activeCode(h);
  h.now = T0 + 100;

  const response = await handleMessage(h.ctx, post(await goodBody(h, { slug })));
  assertEquals(response.status, 400);
  assertEquals(h.sent.length, 0);
});

Deno.test("an incomplete message is refused with something the sender can act on", async () => {
  for (const missing of ["namn", "var", "meddelande", "kontakt", "kanal"]) {
    const h = await harness();
    const slug = await activeCode(h);
    h.now = LATER;

    const response = await handleMessage(
      h.ctx,
      post(await goodBody(h, { slug, [missing]: "" })),
    );
    assertEquals(response.status, 400, missing);
    assertStringIncludes(await response.text(), "Fyll i alla fält", missing);
    assertEquals(h.sent.length, 0);
  }
});

Deno.test("whitespace alone does not count as a filled field", async () => {
  const h = await harness();
  const slug = await activeCode(h);
  h.now = LATER;

  const response = await handleMessage(
    h.ctx,
    post(await goodBody(h, { slug, meddelande: "   \n\t  " })),
  );
  assertEquals(response.status, 400);
  assertEquals(h.sent.length, 0);
});

Deno.test("an over-long field is refused rather than truncated into the owner's inbox", async () => {
  const limits = [["namn", 80], ["var", 120], ["meddelande", 600], ["kontakt", 120]] as const;
  for (const [field, max] of limits) {
    const h = await harness();
    const slug = await activeCode(h);
    h.now = LATER;

    const atLimit = await handleMessage(
      h.ctx,
      post(await goodBody(h, { slug, [field]: "x".repeat(max) })),
    );
    assertEquals(atLimit.status, 200, `${field} at the limit is allowed`);

    const over = await handleMessage(
      h.ctx,
      post(await goodBody(h, { slug, [field]: "x".repeat(max + 1) })),
    );
    assertEquals(over.status, 400, `${field} over the limit is refused`);
  }
});

Deno.test("an unknown contact channel is refused", async () => {
  const h = await harness();
  const slug = await activeCode(h);
  h.now = LATER;

  for (const kanal of ["fax", "", "MAIL", 7, null]) {
    const response = await handleMessage(h.ctx, post(await goodBody(h, { slug, kanal })));
    assertEquals(response.status, 400, String(kanal));
  }
  assertEquals(h.sent.length, 0);
});

/**
 * SMTP2GO answers 200 with `succeeded: 0` when it took the request but not the message. If
 * that were reported as success the sender would walk away believing they had said hello.
 */
Deno.test("a mail that was accepted but not sent is reported as a failure", async () => {
  const h = await harness({ failMail: true });
  const slug = await activeCode(h);
  h.now = LATER;

  const response = await handleMessage(h.ctx, post(await goodBody(h, { slug })));

  assertEquals(response.status, 502);
  assertStringIncludes(await response.text(), "kunde inte skicka");
});

Deno.test("a malformed body is refused without throwing", async () => {
  const h = await harness();
  h.now = LATER;

  for (const raw of ["", "not json", "[]", "null", '"a string"', "7"]) {
    const request = new Request("https://ojhej.se/api/meddelande", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    assertEquals((await handleMessage(h.ctx, request)).status, 400, raw);
  }
  assertEquals(h.sent.length, 0);
});

Deno.test("other methods are refused", async () => {
  const h = await harness();

  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const response = await handleMessage(
      h.ctx,
      new Request("https://ojhej.se/api/meddelande", { method }),
    );
    assertEquals(response.status, 405, method);
  }
});

/** The owner's address is the one thing this endpoint must never hand back to a visitor. */
Deno.test("no response ever contains the owner address", async () => {
  const h = await harness();
  const slug = await activeCode(h);
  h.now = LATER;

  const bodies = [
    await goodBody(h, { slug }),
    await goodBody(h, { slug, meddelande: "" }),
    await goodBody(h, { slug: "ZZZZZZZZZZZZZZZZZZZZ" }),
    await goodBody(null, { slug, altcha: "garbage" }),
  ];

  for (const body of bodies) {
    const text = await (await handleMessage(h.ctx, post(body))).text();
    assert(!text.includes(OWNER), `the owner address leaked: ${text}`);
    assert(!text.includes("emailEnc"), "the ciphertext leaked");
  }
});
