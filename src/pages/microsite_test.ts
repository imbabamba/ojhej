import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderActive } from "./microsite.ts";
import type { CodeRecord } from "../store/shirts.ts";
import { SYFTEN } from "../syfte.ts";

function code(extra: Partial<CodeRecord> = {}): CodeRecord {
  return {
    slug: "K7M4NPQR8TVWXYZ2ABCD",
    emailEnc: "x",
    status: "active",
    createdAt: 0,
    verifiedAt: 0,
    msgCount: 0,
    msgToday: 0,
    msgDay: 0,
    ...extra,
  };
}

/**
 * The page a stranger reaches has three lines of core copy, not one: the statement, the lede,
 * and the dry line under the button. The last two are written about a person you have just
 * walked past. A purpose that only swapped the lede would leave the dry line joking about a
 * suitcase, which is why variant A removes it. See mockups/14-syfte-varianter.html.
 */
const CORE = `<h1 class="statement">Oj&nbsp;hej.</h1>
<p class="lede">Du skannade den faktiskt.</p>`;
const DRY = `<p class="dry">Eller gå vidare. Ingen märker något.</p>`;

Deno.test("a code with no purpose renders the page exactly as it always did", async () => {
  const html = await renderActive(code()).text();

  assertStringIncludes(html, CORE);
  assertStringIncludes(html, DRY);
});

Deno.test("a code whose purpose has no line is also unchanged", async () => {
  // `hej` is a purpose somebody picked on the picker, and it is deliberately the empty line.
  // Picking the ordinary case must cost the ordinary page nothing.
  const html = await renderActive(code({ syfte: "hej", etikett: "DEJTA" })).text();

  assertStringIncludes(html, CORE);
  assertStringIncludes(html, DRY);
});

Deno.test("a purpose with a line replaces the lede and takes the dry line with it", async () => {
  const html = await renderActive(code({ syfte: "borttappat" })).text();

  assertStringIncludes(html, `<h1 class="statement">Oj&nbsp;hej.</h1>`, "the brand moment stays");
  assertStringIncludes(html, `<p class="lede">${SYFTEN.borttappat.rad}</p>`);
  assert(!html.includes("Du skannade den faktiskt"), "the lede is replaced, not stacked");
  assert(!html.includes(DRY), "a line about a lost bag must not be followed by a joke about it");
  assertStringIncludes(html, "Säg hej", "the button is unchanged: saying hej fits every case");
});

Deno.test("a preset's line comes from the preset even if the record carries another", async () => {
  const html = await renderActive(code({ syfte: "fest", rad: "något annat" })).text();

  assertStringIncludes(html, SYFTEN.fest.rad);
  assert(!html.includes("något annat"), "only eget reads its words from the record");
});

Deno.test("an own line is the owner's words, and only theirs", async () => {
  const html = await renderActive(code({ syfte: "eget", rad: "Väskan är min. Hör av dig." }))
    .text();

  assertStringIncludes(html, `<p class="lede">Väskan är min. Hör av dig.</p>`);
  assert(!html.includes("Du skannade den faktiskt"));
});

Deno.test("the line is text, and cannot become markup", async () => {
  const html = await renderActive(
    code({ syfte: "eget", rad: `<img src=x onerror="alert(1)"> "quoted" & 'single'` }),
  ).text();

  assertEquals(html.match(/<img/g), null, "no element may come out of the owner's line");
  assertStringIncludes(html, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

/**
 * The line is deliberately not a link, and the picker says so to the owner. A scan page that can
 * publish a working URL is a page somebody will use to publish a working URL, and a stranger who
 * scanned a jacket should not be one tap from an address we never checked.
 */
Deno.test("the line never becomes a link, however it is written", async () => {
  const html = await renderActive(
    code({ syfte: "eget", rad: "Skriv till https://exempel.se eller hoppa in" }),
  ).text();

  assertStringIncludes(html, "https://exempel.se", "the text is shown as written");
  assert(!html.includes('href="https://exempel.se"'), "but never as an anchor");
  assert(!html.includes('<a href="http'), "and no external link is introduced anywhere");
});

Deno.test("the scan page still names nobody, whatever the purpose says", async () => {
  const html = await renderActive(
    code({ syfte: "eget", rad: "Hör av dig", etikett: "HITTAT?" }),
  ).text();

  assert(!html.includes("HITTAT?"), "the printed label is the owner's business, not a visitor's");
  assert(!html.includes("emailEnc"), "and nothing of the record leaks into the page");
});

Deno.test("a survey code asks the owner's questions instead of asking for an open message", async () => {
  const html = await renderActive(
    code({ mode: "survey", questions: ["Vad gör dig glad?", "Din perfekta söndag?"] }),
  ).text();

  assertStringIncludes(html, "Svara på frågorna");
  assertStringIncludes(html, "Vad gör dig glad?");
  assertStringIncludes(html, "Din perfekta söndag?");
  assertStringIncludes(html, "data-survey-answer");
  assert(!html.includes('id="meddelande"'));
  assert(!html.includes('id="var"'));
});

Deno.test("owner-written questions are text, never markup", async () => {
  const html = await renderActive(
    code({ mode: "survey", questions: ["Vanlig fråga?", `<img src=x onerror="alert(1)">?`] }),
  ).text();

  assertEquals(html.match(/<img/g), null);
  assertStringIncludes(html, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;?");
});
