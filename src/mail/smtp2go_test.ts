import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { sendMail, type Smtp2goConfig } from "./smtp2go.ts";

const CONFIG: Smtp2goConfig = {
  apiKey: "api-secret-key-do-not-leak",
  baseUrl: "https://api.smtp2go.com/v3",
  sender: "Oj hej <hej@ojhej.se>",
};

const MESSAGE = {
  to: "anders@exempel.se",
  subject: "Någon skannade din kod",
  textBody: "Oj hej.",
  htmlBody: "<p>Oj hej.</p>",
};

function stubFetch(
  handler: (url: string, init: RequestInit) => Response,
): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function ok(succeeded = 1, failures: unknown[] = []): Response {
  return new Response(
    JSON.stringify({ request_id: "abc", data: { succeeded, failed: failures.length, failures } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body));
}

Deno.test("posts to the configured endpoint with the API key header", async () => {
  const stub = stubFetch(() => ok());
  await sendMail(CONFIG, MESSAGE, stub.fetch);

  assertEquals(stub.calls.length, 1);
  assertEquals(stub.calls[0]!.url, "https://api.smtp2go.com/v3/email/send");
  assertEquals(stub.calls[0]!.init.method, "POST");

  const headers = new Headers(stub.calls[0]!.init.headers);
  assertEquals(headers.get("X-Smtp2go-Api-Key"), CONFIG.apiKey);
  assertEquals(headers.get("Content-Type"), "application/json");
});

Deno.test("the API key travels in the header, never in the body", async () => {
  const stub = stubFetch(() => ok());
  await sendMail(CONFIG, MESSAGE, stub.fetch);

  const raw = String(stub.calls[0]!.init.body);
  assert(!raw.includes(CONFIG.apiKey), "a logged request body must not carry the key");
});

Deno.test("sends both a text and an HTML part", async () => {
  const stub = stubFetch(() => ok());
  await sendMail(CONFIG, MESSAGE, stub.fetch);

  const body = bodyOf(stub.calls[0]!.init);
  assertEquals(body.sender, CONFIG.sender);
  assertEquals(body.to, ["anders@exempel.se"]);
  assertEquals(body.subject, "Någon skannade din kod");
  assertEquals(body.text_body, "Oj hej.");
  assertEquals(body.html_body, "<p>Oj hej.</p>");
});

/**
 * The trap this client exists for. SMTP2GO answers 200 with `succeeded: 0` when it accepted
 * the request but not the mail. Treating `response.ok` as success would silently drop
 * messages, and the user would never know a stranger wrote to them.
 */
Deno.test("HTTP 200 with succeeded 0 is a failure, not a success", async () => {
  const stub = stubFetch(() => ok(0, [{ email: "anders@exempel.se", error: "bounced" }]));

  await assertRejects(
    () => sendMail(CONFIG, MESSAGE, stub.fetch),
    Error,
    "succeeded",
  );
});

Deno.test("a non-200 response is a failure", async () => {
  const stub = stubFetch(() => new Response("nope", { status: 500 }));
  await assertRejects(() => sendMail(CONFIG, MESSAGE, stub.fetch), Error);
});

Deno.test("an unparseable body is a failure rather than an assumed success", async () => {
  const stub = stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
  await assertRejects(() => sendMail(CONFIG, MESSAGE, stub.fetch), Error);
});

Deno.test("a thrown error never contains the API key", async () => {
  const stub = stubFetch(() => ok(0));
  const error = await assertRejects(() => sendMail(CONFIG, MESSAGE, stub.fetch), Error);

  assert(!String(error.message).includes(CONFIG.apiKey));
  assert(!String(error.stack ?? "").includes(CONFIG.apiKey));
});

/**
 * Everything below the subject line is attacker-controlled text from a stranger's form.
 * A bare CR or LF in a header is how you turn one mail into two.
 */
Deno.test("CR and LF are stripped from the subject", async () => {
  const stub = stubFetch(() => ok());
  await sendMail(
    CONFIG,
    { ...MESSAGE, subject: "Hej\r\nBcc: offer@spam.example\nX-Evil: yes" },
    stub.fetch,
  );

  const subject = String(bodyOf(stub.calls[0]!.init).subject);
  assert(!subject.includes("\r"), "no carriage return may survive");
  assert(!subject.includes("\n"), "no line feed may survive");
  assertStringIncludes(subject, "Hej");
});

Deno.test("CR and LF are stripped from the recipient and reply-to", async () => {
  const stub = stubFetch(() => ok());
  await sendMail(
    CONFIG,
    { ...MESSAGE, to: "anders@exempel.se\r\nBcc: spam@example.com", replyTo: "a@b.se\nX: y" },
    stub.fetch,
  );

  const body = bodyOf(stub.calls[0]!.init);
  const recipients = body.to as string[];
  assert(!recipients[0]!.includes("\n") && !recipients[0]!.includes("\r"));
  assert(!JSON.stringify(body.custom_headers).includes("\\n"));
});

Deno.test("the body keeps its newlines, only headers are stripped", async () => {
  const stub = stubFetch(() => ok());
  await sendMail(CONFIG, { ...MESSAGE, textBody: "Rad ett\nRad två" }, stub.fetch);

  assertEquals(bodyOf(stub.calls[0]!.init).text_body, "Rad ett\nRad två");
});

Deno.test("reply-to is sent as a custom header when given", async () => {
  const stub = stubFetch(() => ok());
  await sendMail(CONFIG, { ...MESSAGE, replyTo: "anders@exempel.se" }, stub.fetch);

  assertEquals(bodyOf(stub.calls[0]!.init).custom_headers, [
    { header: "Reply-To", value: "anders@exempel.se" },
  ]);
});

Deno.test("no custom headers are sent when there is no reply-to", async () => {
  const stub = stubFetch(() => ok());
  await sendMail(CONFIG, MESSAGE, stub.fetch);

  assertEquals(bodyOf(stub.calls[0]!.init).custom_headers, undefined);
});

/**
 * U+2028 and U+2029 are line terminators to JavaScript but plain whitespace to String.trim,
 * so an embedded one would otherwise ride into a header untouched. This scrub was recorded
 * as done in status.md while the code still only matched CR and LF; a review caught the
 * false claim. The test exists so the claim can never drift from the code again.
 */
Deno.test("unicode line separators are stripped from headers too", async () => {
  const stub = stubFetch(() => ok());
  const SEP = "\u2028";
  const PARA = "\u2029";

  await sendMail(
    CONFIG,
    { ...MESSAGE, subject: `Hej${SEP}Bcc: spam@example.com${PARA}X-Evil: yes` },
    stub.fetch,
  );

  const subject = String(bodyOf(stub.calls[0]!.init).subject);
  assert(!subject.includes(SEP), "U+2028 must not survive into a header");
  assert(!subject.includes(PARA), "U+2029 must not survive into a header");
  assertStringIncludes(subject, "Hej");
});

/* ---------- R18: an outbound call that cannot hang forever ---------- */

/**
 * Without a timeout the call waits for whatever the runtime defaults to, which on an edge
 * isolate is not a thing to leave to chance. A stalled send holds the request open and the
 * person waiting sees a spinner rather than an error they can do something about.
 */
Deno.test("a send that never answers fails as a timeout rather than hanging", async () => {
  const hangs =
    ((_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        // Exactly what fetch does: reject when the caller's signal aborts.
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;

  const failure = await assertRejects(
    () => sendMail({ ...CONFIG, timeoutMs: 20 }, MESSAGE, hangs),
    Error,
  );
  assertStringIncludes(String(failure.message), "did not answer within");
});

Deno.test("a successful send leaves no timer holding the runtime awake", async () => {
  // Deno fails a test that ends with a pending timer, so this passing is the assertion:
  // the abort timer must be cleared on the way out, not left to fire ten seconds later.
  const { fetch: stub, calls } = stubFetch(() => ok());
  await sendMail(CONFIG, MESSAGE, stub);
  assertEquals(calls.length, 1);
});

/** A real network failure keeps its own message rather than being relabelled a timeout. */
Deno.test("a network failure is reported as itself", async () => {
  const refuses =
    (() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;

  const failure = await assertRejects(() => sendMail(CONFIG, MESSAGE, refuses), Error);
  assertStringIncludes(String(failure.message), "connection refused");
});
