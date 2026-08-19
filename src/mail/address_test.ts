import { assert, assertEquals } from "@std/assert";
import { maskEmail, normalizeEmail } from "./address.ts";

/** U+2028, written as an escape so it can never be mistaken for a space in this file again. */
const SEP = " ";

Deno.test("accepts ordinary addresses and normalises them", () => {
  assertEquals(normalizeEmail("anders@exempel.se"), "anders@exempel.se");
  assertEquals(normalizeEmail("  Anders@Exempel.SE  "), "anders@exempel.se");
  assertEquals(
    normalizeEmail("anders.backman+troja@mail.exempel.co.uk"),
    "anders.backman+troja@mail.exempel.co.uk",
  );
  assertEquals(normalizeEmail("a@b.se"), "a@b.se");
});

Deno.test("rejects addresses that are not addresses", () => {
  const bad = [
    "",
    "   ",
    "anders",
    "@exempel.se",
    "anders@",
    "anders@exempel",
    "anders@@exempel.se",
    "anders exempel@se.se",
    "anders@exempel .se",
    "anders@.se",
    "anders@exempel.",
    ".anders@exempel.se",
    "anders.@exempel.se",
  ];
  for (const value of bad) {
    assertEquals(normalizeEmail(value), null, `should have rejected ${JSON.stringify(value)}`);
  }
});

/** An address goes into a mail header. A newline in one is a header injection. */
Deno.test("rejects anything carrying a line break", () => {
  for (
    const value of [
      "anders@exempel.se\n",
      "anders@exempel.se\r\nBcc: spam@example.com",
      "anders\n@exempel.se",
      "anders@exempel.se\tBcc: spam@example.com",
    ]
  ) {
    assertEquals(normalizeEmail(value), null, `should have rejected ${JSON.stringify(value)}`);
  }
});

/**
 * U+2028 and U+2029 are line terminators to JavaScript but ordinary whitespace to
 * String.trim, so a trailing one vanishes silently while an embedded one must not.
 * Found the hard way: a stray U+2028 had crept into this very test file and read as a space,
 * which is exactly how such a character gets past a review.
 */
Deno.test("unicode line separators are handled deliberately, not by accident", () => {
  assertEquals(
    normalizeEmail(`anders@exempel.se${SEP}`),
    "anders@exempel.se",
    "trailing: trimmed like any other surrounding whitespace",
  );
  assertEquals(
    normalizeEmail(`anders@${SEP}exempel.se`),
    null,
    "embedded: refused, no real address contains one",
  );
});

/* Surrounding whitespace is untidy, not hostile: people paste addresses out of other apps.
   It is trimmed, which is why a trailing space belongs here and not in the list above. */
Deno.test("surrounding whitespace is trimmed rather than refused", () => {
  assertEquals(normalizeEmail("anders@exempel.se "), "anders@exempel.se");
  assertEquals(normalizeEmail(" anders@exempel.se"), "anders@exempel.se");
});

Deno.test("rejects absurd lengths rather than storing them", () => {
  assertEquals(normalizeEmail(`${"a".repeat(250)}@exempel.se`), null);
  assertEquals(normalizeEmail(`anders@${"a".repeat(250)}.se`), null);
});

/* ---------- showing an address without giving it away ---------- */

Deno.test("masking keeps enough to recognise and not enough to learn", () => {
  assertEquals(maskEmail("anders@exempel.se"), "an•••@exempel.se");
  assertEquals(maskEmail("ANDERS@Exempel.SE"), "an•••@exempel.se", "normalised first");
  assertEquals(maskEmail("  anders@exempel.se  "), "an•••@exempel.se");
});

Deno.test("a short local part gives away less, not more", () => {
  assertEquals(maskEmail("ab@exempel.se"), "a•••@exempel.se");
  assertEquals(maskEmail("a@exempel.se"), "a•••@exempel.se");
});

Deno.test("the masked form never contains the whole local part", () => {
  for (const address of ["anders@exempel.se", "ab@exempel.se", "a.b.c@exempel.se"]) {
    const masked = maskEmail(address)!;
    const local = address.slice(0, address.indexOf("@"));
    if (local.length > 2) {
      assert(!masked.includes(local), `${masked} still carries ${local}`);
    }
  }
});

Deno.test("anything that is not an address masks to nothing at all", () => {
  for (const junk of ["", "inte en adress", "a@b@c.se", "anders@", "@exempel.se"]) {
    assertEquals(maskEmail(junk), null, junk);
  }
});
