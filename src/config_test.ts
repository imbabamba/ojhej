import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { contactCodeProblem, devConfig, loadConfig, missingEnv, parseEnvFile } from "./config.ts";

Deno.test("parses plain assignments", () => {
  assertEquals(parseEnvFile("A=1\nB=two\n"), { A: "1", B: "two" });
});

Deno.test("ignores comments and blank lines", () => {
  const text = `
# a comment
OJHEJ_SENDER=hej@ojhej.se

  # indented comment
OJHEJ_BASE_URL=https://ojhej.se
`;
  assertEquals(parseEnvFile(text), {
    OJHEJ_SENDER: "hej@ojhej.se",
    OJHEJ_BASE_URL: "https://ojhej.se",
  });
});

Deno.test("keeps everything after the first equals sign", () => {
  // Base64 keys end in "=" padding, and URLs carry query strings. Splitting on every
  // equals rather than the first would quietly corrupt both.
  assertEquals(
    parseEnvFile("OJHEJ_EMAIL_KEY=3q2+796tvu/erb7v3q2+796tvu/erb7v3q2+796tvu8="),
    { OJHEJ_EMAIL_KEY: "3q2+796tvu/erb7v3q2+796tvu/erb7v3q2+796tvu8=" },
  );
  assertEquals(parseEnvFile("U=https://x.se/a?b=c&d=e"), { U: "https://x.se/a?b=c&d=e" });
});

Deno.test("strips surrounding quotes but not inner ones", () => {
  assertEquals(parseEnvFile(`A="Oj hej <hej@ojhej.se>"`), { A: "Oj hej <hej@ojhej.se>" });
  assertEquals(parseEnvFile("B='single'"), { B: "single" });
  assertEquals(parseEnvFile(`C=say "hi"`), { C: `say "hi"` });
});

Deno.test("tolerates the export prefix and surrounding space", () => {
  assertEquals(parseEnvFile("export A=1\n  B = 2 \n"), { A: "1", B: "2" });
});

Deno.test("ignores malformed lines rather than throwing", () => {
  assertEquals(parseEnvFile("VALID=1\nnonsense line\n=novalue\n"), { VALID: "1" });
});

Deno.test("a value may be empty, which is not the same as absent", () => {
  assertEquals(parseEnvFile("A=\n"), { A: "" });
});

/* loadConfig is the R11 fix: a missing secret must fail loudly, never fail open. */

const COMPLETE = {
  OJHEJ_BASE_URL: "https://ojhej.se",
  OJHEJ_ALTCHA_HMAC: "a-secret-of-sufficient-length",
  OJHEJ_EMAIL_KEY: "3q2+796tvu/erb7v3q2+796tvu/erb7v3q2+796tvu8=",
  OJHEJ_SMTP2GO_KEY: "api-xxx",
  OJHEJ_SENDER: "Oj hej <hej@ojhej.se>",
};

Deno.test("a complete environment loads", () => {
  const { config } = loadConfig(COMPLETE);
  assertEquals(config.baseUrl, "https://ojhej.se");
  assertEquals(config.smtp2go.baseUrl, "https://api.smtp2go.com/v3", "documented default");
});

Deno.test("every required variable is named when it is missing", () => {
  for (const missing of Object.keys(COMPLETE)) {
    const env: Record<string, string | undefined> = { ...COMPLETE };
    delete env[missing];
    assertThrows(() => loadConfig(env), Error, missing, `should have named ${missing}`);
  }
});

/**
 * The specific failure this exists to stop: an empty HMAC secret does not throw anywhere in
 * WebCrypto, so proof-of-work verification would keep "working" against a key anyone can
 * guess. Silent weakening is worse than a crash.
 */
Deno.test("a too-short altcha secret is refused rather than accepted quietly", () => {
  assertThrows(
    () => loadConfig({ ...COMPLETE, OJHEJ_ALTCHA_HMAC: "short" }),
    Error,
    "OJHEJ_ALTCHA_HMAC",
  );
});

Deno.test("a base URL that is not absolute is refused", () => {
  // Otherwise verification mails carry links that go nowhere.
  assertThrows(() => loadConfig({ ...COMPLETE, OJHEJ_BASE_URL: "ojhej.se" }), Error, "absolute");
});

Deno.test("a trailing slash on the base URL is tolerated, not doubled", () => {
  const { config } = loadConfig({ ...COMPLETE, OJHEJ_BASE_URL: "https://ojhej.se/" });
  assertEquals(config.baseUrl, "https://ojhej.se");
});

Deno.test("an error never contains the value of the thing it is complaining about", () => {
  const secret = "super-secret-value-do-not-print";
  const error = assertThrows(
    () => loadConfig({ ...COMPLETE, OJHEJ_ALTCHA_HMAC: secret.slice(0, 4) }),
    Error,
  );
  assertEquals(String(error.message).includes(secret.slice(0, 4)), false);
});

/* ---------- reporting every missing name at once ---------- */

/**
 * Failing on the first missing variable turns a first deploy into one redeploy per variable,
 * each costing a build and a cold start to learn a single name. This came from a real
 * misconfiguration: a shorthand `BUNNY_STORAGE_*` in the deploy notes was read as a literal
 * name, and the resulting error named one variable at a time.
 */
Deno.test("a config with nothing set names every missing variable at once", () => {
  const failure = assertThrows(() => loadConfig({}), Error);
  const message = String((failure as Error).message);

  for (
    const name of [
      "OJHEJ_BASE_URL",
      "OJHEJ_ALTCHA_HMAC",
      "OJHEJ_EMAIL_KEY",
      "OJHEJ_SMTP2GO_KEY",
      "OJHEJ_SENDER",
    ]
  ) {
    assertStringIncludes(message, name);
  }
});

Deno.test("a partly configured environment names only what is actually missing", () => {
  const failure = assertThrows(
    () =>
      loadConfig({
        OJHEJ_BASE_URL: "https://ojhej.se",
        OJHEJ_ALTCHA_HMAC: "a-secret-long-enough",
        OJHEJ_EMAIL_KEY: "irrelevant-here",
      }),
    Error,
  );
  const message = String((failure as Error).message);

  assertStringIncludes(message, "OJHEJ_SMTP2GO_KEY");
  assertStringIncludes(message, "OJHEJ_SENDER");
  assert(!message.includes("OJHEJ_BASE_URL"), "should not name what is already set");
});

/** The message ends up in a log, so it may name variables and never their values. */
Deno.test("the missing-variable message never contains a value", () => {
  const failure = assertThrows(
    () => loadConfig({ OJHEJ_BASE_URL: "https://ojhej.se", OJHEJ_EMAIL_KEY: "s3cr3t-key-value" }),
    Error,
  );

  assert(
    !String((failure as Error).message).includes("s3cr3t-key-value"),
    "a config error must never print the value it is complaining about",
  );
});

Deno.test("missingEnv reports names in the order given, and nothing when all are set", () => {
  assertEquals(missingEnv({}, ["A", "B"]), ["A", "B"]);
  assertEquals(missingEnv({ A: "x" }, ["A", "B"]), ["B"]);
  assertEquals(missingEnv({ A: "x", B: "y" }, ["A", "B"]), []);
  // An empty string is not a value: a secret saved blank is the same as one never set.
  assertEquals(missingEnv({ A: "" }, ["A"]), ["A"]);
});

/* ---------- the contact code, which is optional and must stay optional ---------- */

/**
 * 2026-08-14, production outage. `OJHEJ_KONTAKT_KOD` was set to something that is not a code,
 * and the edge script stopped answering: every request logged `unhandled` and returned 500.
 *
 * The path was `config.kontaktKod` → `getCode` → `keyFor` → `isValidSlug` → throw, at cold
 * start, before a single request was served. `getCode` throwing is correct and is pinned by
 * shirts_test.ts: anywhere it is reached with a bad slug, validation was skipped upstream.
 * Here upstream was an environment variable a human typed, and nothing validated it.
 *
 * So the rule lives here, where the comment above `kontaktKod` already promised it: a missing
 * or malformed value means no footer QR, never a broken one, and never a dead deploy.
 */
const VALID_KOD = "K7M4NPQR8TVWXYZ2ABCD";

Deno.test("a valid contact code is kept", () => {
  const { config } = loadConfig({ ...COMPLETE, OJHEJ_KONTAKT_KOD: VALID_KOD });
  assertEquals(config.kontaktKod, VALID_KOD);
});

Deno.test("an absent contact code stays absent", () => {
  assertEquals(loadConfig(COMPLETE).config.kontaktKod, undefined);
});

/**
 * The one that actually happened. A variable created in the dashboard and left blank is an
 * empty string, not an absent one, so `?? null` in both entrypoints passed it straight
 * through to a storage key.
 */
Deno.test("a blank contact code is dropped rather than taken as a code", () => {
  assertEquals(loadConfig({ ...COMPLETE, OJHEJ_KONTAKT_KOD: "" }).config.kontaktKod, undefined);
});

Deno.test("a malformed contact code is dropped, in every shape it arrives in", () => {
  for (
    const bad of [
      "not-a-slug",
      "k7m4npqr8tvwxyz2abcd", // right shape, wrong case
      "K7M4NPQR8TVWXYZ2ABC", // 19 characters
      "K7M4NPQR8TVWXYZ2ABCDE", // 21 characters
      "K7M4NPQR8TVWXYZ2ABCI", // I is not in the alphabet, because people misread it
      "shirts/K7M4NPQR8TVWXYZ2ABCD", // a storage path, not a code
      " K7M4NPQR8TVWXYZ2ABCD ", // pasted with the whitespace still attached
    ]
  ) {
    assertEquals(
      loadConfig({ ...COMPLETE, OJHEJ_KONTAKT_KOD: bad }).config.kontaktKod,
      undefined,
      `${JSON.stringify(bad)} should have been dropped, not passed to a storage key`,
    );
  }
});

/** Same rule locally, or the dev server dies on the value that killed production. */
Deno.test("devConfig applies the same rule", () => {
  assertEquals(devConfig(8000, { OJHEJ_KONTAKT_KOD: "" }).config.kontaktKod, undefined);
  assertEquals(devConfig(8000, { OJHEJ_KONTAKT_KOD: "nope" }).config.kontaktKod, undefined);
  assertEquals(devConfig(8000, { OJHEJ_KONTAKT_KOD: VALID_KOD }).config.kontaktKod, VALID_KOD);
});

/* ---------- why a contact code was rejected, not merely that it was ---------- */

/**
 * `warn("contact code is not a valid code", { reason: "malformed" })` was the whole diagnostic,
 * and blank, whitespace, lowercase and wrong-length all produced that identical line. They are
 * four different mistakes with four different fixes.
 *
 * 2026-08-15: a `malformed` warning sat in the log while the footer QR rendered perfectly, and
 * there was no way to tell from the line whether it was current, or what had actually been wrong.
 */
Deno.test("a contact code that is fine reports no problem", () => {
  assertEquals(contactCodeProblem("D5TPXRFKKX39VWNWC960"), null);
});

Deno.test("an unset contact code is not a problem, it is a choice", () => {
  assertEquals(contactCodeProblem(undefined), null);
});

/**
 * The case that used to be silent, and the one that matters most.
 *
 * The guard was `if (env.OJHEJ_KONTAKT_KOD && ...)`, and an empty string is falsy, so a variable
 * that existed and was blank produced no warning at all: no QR and nothing in the log to say why.
 * A blank value of this exact variable is what served nothing but 500s on 2026-08-14.
 */
Deno.test("a blank contact code is reported rather than passed over in silence", () => {
  assertEquals(contactCodeProblem(""), { reason: "empty", length: 0 });
});

/** The copy-paste failure. The value is right and the variable has a newline stuck to it. */
Deno.test("stray whitespace is named as whitespace", () => {
  assertEquals(contactCodeProblem("D5TPXRFKKX39VWNWC960 "), { reason: "whitespace", length: 21 });
  assertEquals(contactCodeProblem("\nD5TPXRFKKX39VWNWC960"), { reason: "whitespace", length: 21 });
});

/** Right code, wrong case. Worth its own reason, because the fix is to shift-lock it. */
Deno.test("a lowercased code says so rather than blaming the characters", () => {
  assertEquals(contactCodeProblem("d5tpxrfkkx39vwnwc960"), { reason: "lowercase", length: 20 });
});

Deno.test("a truncated code is reported by length", () => {
  assertEquals(contactCodeProblem("D5TPXRFKKX39"), { reason: "length", length: 12 });
});

/** I, L, O and U are not in the alphabet, because they are the ones people misread. */
Deno.test("the right length with the wrong characters is a character problem", () => {
  assertEquals(contactCodeProblem("IOUL5TPXRFKKX39VWNWC"), { reason: "characters", length: 20 });
});
