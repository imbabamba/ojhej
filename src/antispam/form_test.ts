import { assert, assertEquals } from "@std/assert";
import { guardForm, MAX_FILL_MS, MIN_FILL_MS } from "./form.ts";

const T0 = Date.parse("2026-08-12T10:00:00Z");

Deno.test("an untouched honeypot and a human pace pass", () => {
  assertEquals(guardForm({ honeypot: "", startedAt: T0 }, T0 + MIN_FILL_MS + 1), null);
});

Deno.test("a filled honeypot is refused", () => {
  assertEquals(
    guardForm({ honeypot: "https://spam.example", startedAt: T0 }, T0 + 30_000),
    "honeypot",
  );
});

Deno.test("whitespace in the honeypot still counts as untouched", () => {
  assertEquals(guardForm({ honeypot: "   ", startedAt: T0 }, T0 + 30_000), null);
});

/** Nobody reads a page, decides to write to a stranger, and types it in under two seconds. */
Deno.test("an impossibly fast submission is refused", () => {
  assertEquals(guardForm({ honeypot: "", startedAt: T0 }, T0 + MIN_FILL_MS - 1), "too-fast");
  assertEquals(guardForm({ honeypot: "", startedAt: T0 }, T0), "too-fast");
});

Deno.test("a submission from the future is refused rather than trusted", () => {
  assertEquals(guardForm({ honeypot: "", startedAt: T0 + 60_000 }, T0), "too-fast");
});

Deno.test("a missing or nonsense timestamp fails closed", () => {
  for (const startedAt of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
    assertEquals(
      guardForm({ honeypot: "", startedAt }, T0 + 60_000),
      "bad-timing",
      `startedAt ${startedAt}`,
    );
  }
});

Deno.test("a stale form is refused, because a parked tab is a bot's friend", () => {
  assertEquals(guardForm({ honeypot: "", startedAt: T0 }, T0 + 25 * 3600_000), "stale");
});

Deno.test("the honeypot is checked before the clock", () => {
  assertEquals(guardForm({ honeypot: "x", startedAt: Number.NaN }, T0), "honeypot");
});

/* ---------- the exact boundaries (R16) ---------- */

/**
 * The fill-time window is a judgement about human speed, so its edges should be a decision
 * rather than whatever the comparison happened to be. Probing only at plus or minus a second
 * meant flipping `<` to `<=` passed the whole suite.
 *
 * Both edges are inclusive: a form submitted at exactly the minimum is accepted, and one at
 * exactly the maximum is still accepted. Erring outward matters because both failures land on
 * a real person who did nothing wrong and gets a refusal with no explanation.
 */
Deno.test("a submission at exactly the minimum fill time is accepted", () => {
  assertEquals(guardForm({ honeypot: "", startedAt: T0 }, T0 + MIN_FILL_MS), null);
  assertEquals(guardForm({ honeypot: "", startedAt: T0 }, T0 + MIN_FILL_MS - 1), "too-fast");
});

Deno.test("a submission at exactly the maximum age is still accepted", () => {
  assertEquals(guardForm({ honeypot: "", startedAt: T0 }, T0 + MAX_FILL_MS), null);
  assertEquals(guardForm({ honeypot: "", startedAt: T0 }, T0 + MAX_FILL_MS + 1), "stale");
});

/**
 * R17. The indistinguishability check compared two of the three layers. A bot that can tell
 * "too fast" from "wrong proof" learns exactly how to tune itself, so all three must be one
 * answer, and the third one is added here.
 */
Deno.test("every rejection reason is reported the same way to the caller", () => {
  const reasons = [
    guardForm({ honeypot: "spam", startedAt: T0 }, T0 + MIN_FILL_MS + 1),
    guardForm({ honeypot: "", startedAt: T0 }, T0 + 10),
    guardForm({ honeypot: "", startedAt: T0 }, T0 + MAX_FILL_MS + 10_000),
    guardForm({ honeypot: "", startedAt: Number.NaN }, T0 + MIN_FILL_MS + 1),
  ];

  // Distinct internally, so a log line can say which layer caught it.
  assertEquals(new Set(reasons).size, 4, "the reasons must stay distinguishable in logs");
  // And every one of them is a rejection, which is all a caller may learn.
  for (const reason of reasons) assert(reason !== null);
});
