import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createChallenge, recordChallenge } from "../antispam/altcha.ts";
import { MIN_FILL_MS } from "../antispam/form.ts";
import { importKey, sha256Hex } from "../store/crypto.ts";
import { createMemoryStore, type MemoryStoreHandle } from "../store/storage.ts";
import { MAX_SIGNUPS_PER_DAY } from "../store/emails.ts";
import { DEFAULT_SURVEY_QUESTIONS } from "../survey.ts";
import type { AppContext } from "./context.ts";
import { handleSignup } from "./signup.ts";

const KEY = "3q2+796tvu/erb7v3q2+796tvu/erb7v3q2+796tvu8=";
const HMAC = "altcha-test-secret";
const T0 = Date.parse("2026-08-12T10:00:00Z");

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

/**
 * A body carrying a genuinely solved challenge. The challenge is recorded against the harness
 * store first, because a solution is spendable only once and only if it was actually issued.
 * Pass null when the request is meant to be rejected before the proof is ever spent.
 */
async function goodBody(h: Harness | null, overrides: Record<string, unknown> = {}) {
  const challenge = await createChallenge(HMAC, T0, { maxnumber: 300 });
  if (h) await recordChallenge(h.ctx.store, challenge, T0);
  let solved = "";
  for (let n = 0; n <= challenge.maxnumber; n++) {
    if (await sha256Hex(challenge.salt + n) === challenge.challenge) {
      solved = btoa(JSON.stringify({ ...challenge, number: n }));
      break;
    }
  }
  return {
    epost: "anders@exempel.se",
    hemsida: "",
    startedAt: T0,
    altcha: solved,
    ...overrides,
  };
}

function post(body: unknown): Request {
  return new Request("https://ojhej.se/api/skapa", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const LATER = T0 + MIN_FILL_MS + 500;

Deno.test("a good signup creates a pending code and sends the verification mail", async () => {
  const h = await harness();
  h.now = LATER;

  const response = await handleSignup(h.ctx, post(await goodBody(h)));
  assertEquals(response.status, 200);

  const codes = h.handle.keys().filter((k) => k.startsWith("shirts/"));
  assertEquals(codes.length, 1, "exactly one code");

  const record = JSON.parse((await h.handle.store.get(codes[0]!))!);
  assertEquals(record.status, "pending");

  assertEquals(h.sent.length, 1, "one mail");
  assertEquals(h.sent[0]!.body.to, ["anders@exempel.se"]);
  assertEquals(h.sent[0]!.body.subject, "Aktivera din kod");
  assertStringIncludes(String(h.sent[0]!.body.text_body), "https://ojhej.se/verifiera?t=");
});

Deno.test("choosing a survey creates a code with a useful editable draft", async () => {
  const h = await harness();
  h.now = LATER;

  const response = await handleSignup(h.ctx, post(await goodBody(h, { mode: "survey" })));
  assertEquals(response.status, 200);

  const key = h.handle.keys().find((one) => one.startsWith("shirts/"));
  const record = JSON.parse((await h.handle.store.get(key!))!);
  assertEquals(record.mode, "survey");
  assertEquals(record.questions, DEFAULT_SURVEY_QUESTIONS);
});

Deno.test("an unknown scan mode is refused rather than guessed", async () => {
  const h = await harness();
  h.now = LATER;

  const response = await handleSignup(h.ctx, post(await goodBody(h, { mode: "horoscope" })));
  assertEquals(response.status, 400);
  assertStringIncludes(await response.text(), "skanningen");
  assertEquals(h.sent.length, 0);
  assertEquals(h.handle.keys().filter((key) => !key.startsWith("altcha/")), []);
});

/**
 * The hole this closes: without it, someone could sign up with a stranger's address, keep
 * the slug, print it, and have every reply land in the stranger's inbox. The slug is only
 * ever handed to whoever controls the mailbox.
 */
Deno.test("the signup response never reveals the slug", async () => {
  const h = await harness();
  h.now = LATER;

  const response = await handleSignup(h.ctx, post(await goodBody(h)));
  const text = await response.text();

  const slug = h.handle.keys()[0]!.replace("shirts/", "").replace(".json", "");
  assert(!text.includes(slug), "the code must not come back in the response body");
});

Deno.test("the address is stored encrypted, never in the clear", async () => {
  const h = await harness();
  h.now = LATER;
  await handleSignup(h.ctx, post(await goodBody(h)));

  const raw = (await h.handle.store.get(h.handle.keys().find((k) => k.startsWith("shirts/"))!))!;
  assert(!raw.includes("anders@exempel.se"));
});

/* Every anti-abuse rejection below must cost the attacker a mail send of exactly zero. */

Deno.test("a filled honeypot is refused and sends nothing", async () => {
  const h = await harness();
  h.now = LATER;

  const response = await handleSignup(h.ctx, post(await goodBody(h, { hemsida: "spam" })));
  assertEquals(response.status, 400);
  assertEquals(h.sent.length, 0);
  // The issued challenge is recorded, and stays recorded: a bot must not be able to burn a
  // stranger's slot by tripping the honeypot. Nothing else may be written.
  assertEquals(
    h.handle.keys().filter((k) => !k.startsWith("altcha/")),
    [],
    "no code, token or email record either",
  );
});

Deno.test("an impossibly fast submission is refused and sends nothing", async () => {
  const h = await harness();
  h.now = T0 + 100;

  const response = await handleSignup(h.ctx, post(await goodBody(h)));
  assertEquals(response.status, 400);
  assertEquals(h.sent.length, 0);
});

Deno.test("a missing or bad proof of work is refused and sends nothing", async () => {
  for (const altcha of ["", "garbage", btoa(JSON.stringify({ algorithm: "SHA-256" }))]) {
    const h = await harness();
    h.now = LATER;

    const response = await handleSignup(h.ctx, post(await goodBody(h, { altcha })));
    assertEquals(response.status, 400, `altcha ${altcha.slice(0, 12)}`);
    assertEquals(h.sent.length, 0);
  }
});

Deno.test("the anti-abuse rejections are indistinguishable from each other", async () => {
  const bodies = [
    await goodBody(null, { hemsida: "spam" }),
    await goodBody(null, { altcha: "garbage" }),
  ];

  const responses: string[] = [];
  for (const body of bodies) {
    const h = await harness();
    h.now = LATER;
    const response = await handleSignup(h.ctx, post(body));
    responses.push(`${response.status}:${await response.text()}`);
  }

  assertEquals(responses[0], responses[1], "a bot must not learn which layer caught it");
});

Deno.test("an invalid address is refused with a message the user can act on", async () => {
  const h = await harness();
  h.now = LATER;

  const response = await handleSignup(h.ctx, post(await goodBody(h, { epost: "inte en adress" })));
  assertEquals(response.status, 400);
  assertStringIncludes((await response.json()).fel, "mailadress");
  assertEquals(h.sent.length, 0);
});

Deno.test("the daily cap for one address is enforced", async () => {
  const h = await harness();
  h.now = LATER;

  for (let i = 0; i < MAX_SIGNUPS_PER_DAY; i++) {
    assertEquals((await handleSignup(h.ctx, post(await goodBody(h)))).status, 200, `signup ${i}`);
  }

  const capped = await handleSignup(h.ctx, post(await goodBody(h)));
  assertEquals(capped.status, 429);
  assertEquals(h.sent.length, MAX_SIGNUPS_PER_DAY, "the capped attempt sent no mail");
});

Deno.test("only POST is accepted", async () => {
  const h = await harness();
  const response = await handleSignup(
    h.ctx,
    new Request("https://ojhej.se/api/skapa", { method: "GET" }),
  );
  assertEquals(response.status, 405);
});

Deno.test("a malformed body is refused rather than throwing", async () => {
  const h = await harness();
  h.now = LATER;

  for (
    const body of ["not json", JSON.stringify(null), JSON.stringify([1, 2]), JSON.stringify("x")]
  ) {
    const response = await handleSignup(
      h.ctx,
      new Request("https://ojhej.se/api/skapa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    assertEquals(response.status, 400, `body ${body}`);
  }
});

/**
 * If the mail does not go, saying "check your mail" would be a lie. The pending record is
 * left to expire on its own after seven days rather than deleted, because the send may in
 * fact have happened and only the acknowledgement failed.
 */
Deno.test("a failed mail send is reported rather than claimed as success", async () => {
  const h = await harness({ failMail: true });
  h.now = LATER;

  const response = await handleSignup(h.ctx, post(await goodBody(h)));
  assertEquals(response.status, 502);
});

/**
 * R9, the mail-bombing amplifier, measured where it actually mattered.
 *
 * The signup cap counts, and counters race: Bunny Storage offers no compare-and-swap, so a
 * burst of concurrent requests could all read the same count and all pass. That made one solved
 * challenge worth many verification mails to a stranger's address, which is a mail bomb with our
 * return address on it. The cap still races and always will. What closes the hole is the other
 * end: one proof of work now buys exactly one request, so an attacker must pay CPU per mail
 * rather than per burst.
 */
Deno.test("one proof of work buys exactly one mail, however many requests carry it", async () => {
  for (const burst of [2, 20, 50]) {
    const h = await harness();
    h.now = LATER;
    const body = await goodBody(h);

    const responses = await Promise.all(
      Array.from({ length: burst }, () => handleSignup(h.ctx, post(body))),
    );

    assertEquals(
      responses.filter((r) => r.status === 200).length,
      1,
      `${burst} concurrent requests must yield one signup`,
    );
    assertEquals(h.sent.length, 1, `${burst} concurrent requests must yield one mail`);
  }
});
