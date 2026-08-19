import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { captureLines, error, errorFields, info, log, setLevel } from "./log.ts";

Deno.test("log emits one parseable JSON line per call", () => {
  const lines = captureLines(() => {
    log("info", "kod skapad", { slug: "K7M4NPQR8TVWXYZ2ABCD" });
  });

  assertEquals(lines.length, 1);
  const entry = JSON.parse(lines[0]!);
  assertEquals(entry.level, "info");
  assertEquals(entry.msg, "kod skapad");
  assertEquals(entry.slug, "K7M4NPQR8TVWXYZ2ABCD");
});

Deno.test("log stamps every line with an ISO timestamp", () => {
  const lines = captureLines(() => log("info", "nu"));
  const entry = JSON.parse(lines[0]!);
  assert(typeof entry.ts === "string");
  assert(!Number.isNaN(Date.parse(entry.ts)), `ts not parseable: ${entry.ts}`);
});

Deno.test("log filters below the configured level", () => {
  const lines = captureLines(() => {
    setLevel("warn");
    log("debug", "brus");
    log("info", "mer brus");
    log("warn", "något att titta på");
    log("error", "något att göra åt");
    setLevel("info");
  });

  assertEquals(lines.length, 2);
  assertEquals(JSON.parse(lines[0]!).level, "warn");
  assertEquals(JSON.parse(lines[1]!).level, "error");
});

/* The whole point of routing every line through one place: a field that looks
   like a secret can never reach the log, however careless the call site is. */
Deno.test("log redacts fields whose names look sensitive", () => {
  const lines = captureLines(() =>
    log("info", "skickar mail", {
      email: "anders@exempel.se",
      apiKey: "api-abc123",
      manageToken: "b41f7c2e9a08d5",
      storageAccessKey: "zzz",
      passwordHash: "nope",
      slug: "K7M4NPQR8TVWXYZ2ABCD",
    })
  );

  const entry = JSON.parse(lines[0]!);
  assertEquals(entry.email, "[redacted]");
  assertEquals(entry.apiKey, "[redacted]");
  assertEquals(entry.manageToken, "[redacted]");
  assertEquals(entry.storageAccessKey, "[redacted]");
  assertEquals(entry.passwordHash, "[redacted]");
  assertEquals(entry.slug, "K7M4NPQR8TVWXYZ2ABCD", "slug is public, it must survive");
});

Deno.test("log never lets a value break the JSON line", () => {
  const lines = captureLines(() =>
    log("warn", 'trasigt "citat"\noch radbrytning', { note: 'x"\ny' })
  );

  assertEquals(lines.length, 1, "a newline in the payload must not split the line");
  const entry = JSON.parse(lines[0]!);
  assertStringIncludes(entry.msg, "radbrytning");
});

/* ---------- R21: redaction that does not stop at the surface ---------- */

/**
 * The bug this closes: redaction inspected only top-level keys, so `info("x", { record })`
 * walked straight past an encrypted address or a token sitting one level in. The field names
 * are the same at every depth, so the check has to be too.
 */
Deno.test("sensitive fields are redacted however deeply they are nested", () => {
  const lines = captureLines(() =>
    info("code read", {
      record: {
        slug: "K7M4NPQR8TVWXYZ2ABCD",
        emailEnc: "ciphertext",
        owner: { epost: "anders@exempel.se", namn: "Anders" },
      },
    })
  );

  const line = lines[0]!;
  assert(!line.includes("anders@exempel.se"), "an address one level down leaked");
  assert(!line.includes("Anders"), "a name leaked");
  assertStringIncludes(line, "K7M4NPQR8TVWXYZ2ABCD", "the slug is public and stays readable");
});

Deno.test("a list of records is walked rather than logged whole", () => {
  const lines = captureLines(() =>
    info("codes", {
      items: [
        { slug: "AAAA", epost: "en@exempel.se" },
        { slug: "BBBB", epost: "tva@exempel.se" },
      ],
    })
  );

  assert(!lines[0]!.includes("@exempel.se"), "addresses inside an array leaked");
  assertStringIncludes(lines[0]!, "AAAA");
});

/** A cyclic or absurdly deep structure must not turn one log line into a hang. */
Deno.test("depth is bounded rather than followed forever", () => {
  const deep: Record<string, unknown> = {};
  let node = deep;
  for (let i = 0; i < 50; i++) {
    node.next = {};
    node = node.next as Record<string, unknown>;
  }
  node.epost = "anders@exempel.se";

  const lines = captureLines(() => info("deep", deep));
  assertStringIncludes(lines[0]!, "[too deep]");
  assert(!lines[0]!.includes("anders@exempel.se"));
});

Deno.test("a cycle does not hang the logger", () => {
  const cyclic: Record<string, unknown> = { slug: "AAAA" };
  cyclic.self = cyclic;

  const lines = captureLines(() => info("cyclic", cyclic));
  assertStringIncludes(lines[0]!, "[too deep]");
});

/* ---------- what an unhandled failure has to say for itself ---------- */

/**
 * `String(cause)` was everything an unhandled 500 recorded, which gives the message and quietly
 * drops the stack.
 *
 * 2026-08-15: an isolate refused to start because the delete-semantics probe would not vouch for
 * the store, and the only trace was one `unhandled` line carrying the message and nothing else.
 * Nothing said which request, nothing said it was a cold start rather than a handler, and nothing
 * said where in the code it came from. The investigation started in the wrong place as a result.
 */
Deno.test("an error is logged with its name, message and stack", () => {
  const cause = new Error("storage delete failed: 500");

  const lines = captureLines(() => error("unhandled", errorFields(cause)));
  const entry = JSON.parse(lines[0]!);

  assertEquals(entry.err, "Error");
  assertEquals(entry.errMessage, "storage delete failed: 500");
  assertStringIncludes(
    entry.stack,
    "log_test.ts",
    "the stack is what says where a throw came from",
  );
});

/** A throw is not always an Error, and whatever it is must not land as "[object Object]". */
Deno.test("a thrown non-error still says something useful", () => {
  const lines = captureLines(() => error("unhandled", errorFields({ odd: true })));
  const entry = JSON.parse(lines[0]!);

  assertEquals(entry.err, "unknown");
  assertEquals(entry.errMessage, "[object Object]");
});

/**
 * Bounded, because an edge platform's log pane truncates, and half a JSON line is a parse error
 * rather than a log line. The frames that identify a throw are at the top of the stack anyway.
 */
Deno.test("a very long stack is bounded rather than allowed to break the line", () => {
  const cause = new Error("deep");
  cause.stack = "Error: deep\n" + "    at somewhere (file.ts:1:1)\n".repeat(500);

  const lines = captureLines(() => error("unhandled", errorFields(cause)));
  const entry = JSON.parse(lines[0]!);

  assert(entry.stack.length <= 2000, `stack was ${entry.stack.length} characters`);
  assertStringIncludes(
    entry.stack,
    "Error: deep",
    "the top of the stack is the half worth keeping",
  );
});

/** Values that are not plain objects keep the behaviour they always had. */
Deno.test("dates and errors are not mangled by the walk", () => {
  const lines = captureLines(() => info("shapes", { when: new Date(0), count: 7, flag: true }));
  assertStringIncludes(lines[0]!, "1970-01-01");
  assertStringIncludes(lines[0]!, '"count":7');
  assertStringIncludes(lines[0]!, '"flag":true');
});
