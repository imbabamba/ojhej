import { assert, assertEquals } from "@std/assert";
import { DEFAULT_LABEL, MAX_LABEL } from "./qr/layout.ts";
import {
  cleanDesign,
  DEFAULT_SYFTE,
  etikettFor,
  isSyfte,
  MAX_RAD,
  radFor,
  SYFTE_ORDER,
  SYFTEN,
  syfteOf,
  visningsnamn,
} from "./syfte.ts";

Deno.test("every preset key is a syfte and nothing else is", () => {
  for (const key of SYFTE_ORDER) {
    assert(isSyfte(key), `${key} is a preset and must be recognised as one`);
  }

  for (const junk of ["", "HEJ", "hej ", "borttappad", "__proto__", "toString", null, 7, {}, []]) {
    assert(!isSyfte(junk), `${JSON.stringify(junk)} must not pass as a syfte`);
  }
});

Deno.test("the default is hej, and hej is the empty line", () => {
  assertEquals(DEFAULT_SYFTE, "hej");
  assertEquals(SYFTEN.hej.rad, "", "an empty line is what keeps the scan page exactly as it is");
  assertEquals(radFor({}), "", "a record from before this feature reads as hej");
  assertEquals(radFor({ syfte: "hej" }), "");
});

Deno.test("a preset's line comes from the preset, never from the record", () => {
  // Storing the key rather than the sentence is what lets a preset be reworded later without
  // rewriting anybody's code. A stored line on a preset code would quietly defeat that.
  assertEquals(
    radFor({ syfte: "borttappat", rad: "något annat" }),
    SYFTEN.borttappat.rad,
  );
});

Deno.test("eget is the one that reads the record", () => {
  assertEquals(radFor({ syfte: "eget", rad: "Vi ses på torget." }), "Vi ses på torget.");
  assertEquals(radFor({ syfte: "eget" }), "", "eget with nothing written is the unchanged page");
  assertEquals(radFor({ syfte: "eget", rad: "   " }), "", "whitespace is not a line");
});

Deno.test("a record carrying a syfte this version does not know reads as the default", () => {
  // Storage is not trusted, and a value written by a later version must not reach a template.
  assertEquals(syfteOf({ syfte: "kattutställning" }), "hej");
  assertEquals(radFor({ syfte: "kattutställning", rad: "x" }), "");
});

Deno.test("hej prints the label the rest of the code already defaults to", () => {
  assertEquals(SYFTEN.hej.etikett, DEFAULT_LABEL, "one default label, defined once");
});

Deno.test("cleanDesign refuses a syfte it does not know", () => {
  for (const junk of ["", "HEJ", "kattutställning", null, 7, {}]) {
    assertEquals(cleanDesign({ syfte: junk }), null, `${JSON.stringify(junk)} is not a syfte`);
  }
});

Deno.test("picking a preset takes that preset's label unless one is given", () => {
  assertEquals(cleanDesign({ syfte: "borttappat" })?.etikett, "HITTAT?");
  assertEquals(cleanDesign({ syfte: "borttappat", etikett: "VÄSKA" })?.etikett, "VÄSKA");
});

Deno.test("an empty label is a choice and survives as one", () => {
  // Absent means never chosen, so it reads as the preset. Empty means the owner wants the code
  // and nothing above it. Collapsing the two would silently reprint a label they removed.
  assertEquals(cleanDesign({ syfte: "hej", etikett: "" })?.etikett, "");
  assertEquals(cleanDesign({ syfte: "eget", etikett: "" })?.etikett, "");
});

Deno.test("only eget keeps a line, and the others cannot smuggle one in", () => {
  assertEquals(cleanDesign({ syfte: "hej", rad: "hej hej" })?.rad, "");
  assertEquals(cleanDesign({ syfte: "fest", rad: "hej hej" })?.rad, "");
  assertEquals(cleanDesign({ syfte: "eget", rad: "Vi ses på torget." })?.rad, "Vi ses på torget.");
});

Deno.test("a line is refused rather than truncated when it is too long", () => {
  const justRight = "a".repeat(MAX_RAD);
  const oneTooMany = "a".repeat(MAX_RAD + 1);

  assertEquals(cleanDesign({ syfte: "eget", rad: justRight })?.rad, justRight, "at the limit");
  assertEquals(cleanDesign({ syfte: "eget", rad: oneTooMany }), null, "one past it");

  // Truncating would publish half a sentence the owner never wrote, on a stranger's screen.
  assertEquals(cleanDesign({ syfte: "hej", etikett: "A".repeat(MAX_LABEL) })?.etikett?.length, 14);
  assertEquals(cleanDesign({ syfte: "hej", etikett: "A".repeat(MAX_LABEL + 1) }), null);
});

Deno.test("line terminators never survive, in either field", () => {
  // U+2028 and U+2029 are line terminators to a JavaScript parser and ordinary whitespace to
  // String.trim, which is how one hid in a test file here once. Both fields end up in HTML and
  // one of them ends up in an SVG we generate.
  const design = cleanDesign({
    syfte: "eget",
    rad: "Hej\u2028\u2029\r\n\tdär",
    etikett: "A\u2028B",
  });

  assertEquals(design?.rad, "Hej där", "collapsed to a single space, not deleted outright");
  assertEquals(design?.etikett, "A B");
  for (const value of [design?.rad ?? "", design?.etikett ?? ""]) {
    for (const bad of ["\r", "\n", "\t", "\u2028", "\u2029"]) {
      assert(!value.includes(bad), `${JSON.stringify(bad)} must not survive`);
    }
  }
});

Deno.test("a line is trimmed and its inner runs collapsed", () => {
  assertEquals(cleanDesign({ syfte: "eget", rad: "  Vi   ses  " })?.rad, "Vi ses");
});

Deno.test("no preset can produce a print or a line that does not fit", () => {
  for (const key of SYFTE_ORDER) {
    const { etikett, rad, namn } = SYFTEN[key];
    assert(
      etikett.length <= MAX_LABEL,
      `${key}: the label ${etikett} is longer than the band can carry`,
    );
    assert(rad.length <= MAX_RAD, `${key}: the line is longer than an owner is allowed to write`);
    assert(namn.length > 0, `${key}: needs a name the owner sees in the picker`);
    assert(!rad.includes("—"), `${key}: no em dashes`);
  }
});

Deno.test("the printed label falls back to the purpose, and an empty one is respected", () => {
  assertEquals(etikettFor({}), DEFAULT_LABEL, "a code from before purposes prints the default");
  assertEquals(etikettFor({ syfte: "borttappat" }), "HITTAT?");
  assertEquals(etikettFor({ syfte: "borttappat", etikett: "VÄSKA" }), "VÄSKA");
  assertEquals(etikettFor({ syfte: "hej", etikett: "" }), "", "no text above the code");
});

/**
 * The code list names codes by what is printed on them, because that is how their owner tells
 * them apart in a drawer. A code with nothing printed on it still needs a name in a list.
 */
Deno.test("a code with no printed text is still called something in a list", () => {
  assertEquals(visningsnamn({ syfte: "eget" }), "Utan text");
  assertEquals(visningsnamn({ syfte: "hej", etikett: "" }), "Utan text");
  assertEquals(visningsnamn({ syfte: "hej", etikett: "DEJTA" }), "DEJTA");
  assertEquals(visningsnamn({}), DEFAULT_LABEL);
});
