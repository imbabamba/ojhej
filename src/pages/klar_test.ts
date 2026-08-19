import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderKlar } from "./klar.ts";
import type { CodeRecord } from "../store/shirts.ts";
import { SYFTE_ORDER, SYFTEN } from "../syfte.ts";

const T0 = Date.parse("2026-08-12T10:00:00Z");
const SLUG = "K7M4NPQR8TVWXYZ2ABCD";

function code(extra: Partial<CodeRecord> = {}): CodeRecord {
  return {
    slug: SLUG,
    emailEnc: "x",
    status: "active",
    createdAt: T0,
    verifiedAt: T0,
    msgCount: 0,
    msgToday: 0,
    msgDay: 0,
    ...extra,
  };
}

/**
 * The picker writes to the record, and `/klar?kod=` is reachable by anyone who has seen the
 * garment, because the slug is printed on a chest in public. So the picker appears only behind a
 * token, and the read-only page keeps the print controls, which only ever build a URL.
 * Anders' call, 2026-08-15.
 */
Deno.test("without a token there is no picker", async () => {
  const html = await renderKlar(code(), "https://ojhej.se", null).text();

  assert(!html.includes('id="syfte"'), "no purpose picker for a stranger holding the slug");
  assert(!html.includes('data-atgard="syfte"'), "and nothing that could save one");
  assertStringIncludes(html, 'id="designer"', "the print controls are still there");
  assert(!html.includes("OJHEJ_T"), "and no token is invented for the page");
});

Deno.test("with a token the picker is there, with every purpose", async () => {
  const html = await renderKlar(code(), "https://ojhej.se", "t0ken").text();

  assertStringIncludes(html, 'id="syfte"');
  for (const key of SYFTE_ORDER) {
    assertStringIncludes(html, `data-syfte="${key}"`);
    assertStringIncludes(html, SYFTEN[key].namn);
  }
  assertStringIncludes(html, 'window.OJHEJ_T="t0ken"');
});

/** Which chip is pressed, read out of the markup the way a browser would. */
function vald(html: string): string | null {
  for (const key of SYFTE_ORDER) {
    const start = html.indexOf(`data-syfte="${key}"`);
    if (start < 0) continue;
    // Only this chip's own tag, or the next chip's attributes bleed into the answer.
    const chip = html.slice(start, html.indexOf(">", start));
    if (chip.includes('aria-pressed="true"')) return key;
  }
  return null;
}

Deno.test("the purpose the code already has is the one selected", async () => {
  const html = await renderKlar(code({ syfte: "fest" }), "https://ojhej.se", "t0ken").text();
  assertEquals(vald(html), "fest");
});

Deno.test("a code nobody has designed yet starts on the ordinary one", async () => {
  const html = await renderKlar(code(), "https://ojhej.se", "t0ken").text();
  assertEquals(vald(html), "hej");
});

/** The client reads its presets off the chips, so the chips have to carry them. */
Deno.test("each chip carries the preset it stands for", async () => {
  const html = await renderKlar(code(), "https://ojhej.se", "t0ken").text();

  assertStringIncludes(html, `data-etikett="HITTAT?"`);
  assertStringIncludes(html, `data-rad="${SYFTEN.borttappat.rad}"`);
  assertStringIncludes(html, `data-tom="Ingenting extra`);
});

Deno.test("the preview shows what a stranger will actually read", async () => {
  const set = await renderKlar(code({ syfte: "borttappat" }), "https://ojhej.se", "t").text();
  assertStringIncludes(set, SYFTEN.borttappat.rad);

  const plain = await renderKlar(code(), "https://ojhej.se", "t").text();
  assertStringIncludes(plain, "Ingenting extra", "and says so when there is nothing extra");
});

Deno.test("an own line comes back into the field it was written in", async () => {
  const html = await renderKlar(
    code({ syfte: "eget", rad: "Väskan är min. Hör av dig." }),
    "https://ojhej.se",
    "t0ken",
  ).text();

  assertStringIncludes(html, "Väskan är min. Hör av dig.</textarea>");
  assert(!html.includes('id="egetfalt" hidden'), "and its field is open, because it is in use");
});

Deno.test("the own-line field is folded away until it is the one in use", async () => {
  const html = await renderKlar(code({ syfte: "hej" }), "https://ojhej.se", "t0ken").text();
  assertStringIncludes(html, 'id="egetfalt" hidden');
});

Deno.test("the printed label is the stored one, on the page and in the preview", async () => {
  const html = await renderKlar(
    code({ syfte: "borttappat", etikett: "VÄSKA" }),
    "https://ojhej.se",
    "t0ken",
  ).text();

  assertStringIncludes(html, 'value="VÄSKA"');
  assertStringIncludes(html, "text=V%C3%84SKA", "so the code on screen is the one that was saved");
});

Deno.test("a code printed with no text says so rather than showing the default", async () => {
  const html = await renderKlar(code({ etikett: "" }), "https://ojhej.se", "t0ken").text();
  assertStringIncludes(html, 'value=""');
});

Deno.test("what the owner typed cannot become markup on their own page", async () => {
  const html = await renderKlar(
    code({ syfte: "eget", rad: `</textarea><script>alert(1)</script>`, etikett: `" onerror="x` }),
    "https://ojhej.se",
    "t0ken",
  ).text();

  assert(!html.includes("<script>alert(1)"), "the line must not escape its field");
  assert(!html.includes(`" onerror="x`), "nor the label its attribute");
});

Deno.test("the page never says we mailed something we did not", async () => {
  const html = await renderKlar(code(), "https://ojhej.se", "t0ken").text();
  assert(!html.includes("Vi mailar en hantera-länk"), "no promise the service does not keep");
  // One name for this destination everywhere, and it is a link now. See the notice test below.
  assertStringIncludes(html, "Hantera koder", "it points at where a new link is asked for");
});

Deno.test("the address is the code's own, and the slug is not in a query string", async () => {
  const html = await renderKlar(code(), "https://ojhej.se", "t0ken").text();

  assertStringIncludes(html, `ojhej.se/s/${SLUG}`);
  assertEquals(html.includes(`/klar?kod=${SLUG}`), false, "the token is what carries the code now");
});

/**
 * The notice told an owner what to do and gave them no way to do it.
 *
 * "en ny länk hit begär du under Hantera dina koder" was flat text naming a label the footer had
 * stopped using, on the one page where somebody has just made a code and is about to close the
 * tab. Describing a route is not offering one.
 */
Deno.test("the page you land on after activation links to the way back", async () => {
  for (const token of ["t0ken", null]) {
    const html = await renderKlar(code(), "https://ojhej.se", token).text();
    const notice = html.slice(html.indexOf('class="notice"'));

    assertStringIncludes(
      notice.slice(0, notice.indexOf("</div>")),
      'href="/hantera"',
      `the notice describes the way back without offering it (token: ${token})`,
    );
    // The one name for this destination, so the notice and the footer say the same thing.
    assertStringIncludes(notice.slice(0, notice.indexOf("</div>")), "Hantera koder");
  }
});
