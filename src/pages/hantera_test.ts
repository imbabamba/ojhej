import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderKoder } from "./hantera.ts";
import type { CodeRecord } from "../store/shirts.ts";

const T0 = Date.parse("2026-08-12T10:00:00Z");

function code(extra: Partial<CodeRecord> = {}): CodeRecord {
  return {
    slug: "K7M4NPQR8TVWXYZ2ABCD",
    emailEnc: "x",
    status: "active",
    createdAt: T0,
    verifiedAt: T0,
    msgCount: 4,
    msgToday: 0,
    msgDay: 0,
    ...extra,
  };
}

function view(extra: Partial<Parameters<typeof renderKoder>[0]> = {}) {
  return {
    koder: [code()],
    baseUrl: "https://ojhej.se",
    token: "t0ken",
    epost: "an•••@exempel.se",
    helaListan: true,
    ...extra,
  };
}

Deno.test("every code gets a row, named by what is printed on it", async () => {
  const html = await renderKoder(view({
    koder: [
      code({ slug: "K7M4NPQR8TVWXYZ2ABCD", etikett: "DEJTA", syfte: "hej" }),
      code({ slug: "R4XT9WPM2KQNBVCD7HJE", etikett: "HITTAT?", syfte: "borttappat" }),
      code({ slug: "8TVW2ABCDK7M4NPQRXYZ", etikett: "SÄG HEJ", syfte: "fest", status: "paused" }),
    ],
  })).text();

  assertEquals(html.match(/class="kod"/g)?.length, 3);
  for (const namn of ["DEJTA", "HITTAT?", "SÄG HEJ"]) assertStringIncludes(html, namn);
  assertStringIncludes(html, "Borttappat", "the purpose is named on the row");
});

Deno.test("a code with nothing printed on it is still called something", async () => {
  const html = await renderKoder(view({ koder: [code({ syfte: "eget", etikett: "" })] })).text();
  assertStringIncludes(html, "Utan text");
});

Deno.test("the address is shown masked, and never in full", async () => {
  const html = await renderKoder(view()).text();

  assertStringIncludes(html, "an•••@exempel.se");
  assert(!html.includes("anders@exempel.se"), "the page must not carry the address in the clear");
});

Deno.test("the page counts the codes against the cap", async () => {
  const html = await renderKoder(view({ koder: [code(), code(), code()] })).text();
  assertStringIncludes(html, "3 av 10");
  assertStringIncludes(html, "Sju kvar", "and says what is left, as the mock does");
});

Deno.test("messages are totalled across the codes", async () => {
  const html = await renderKoder(view({
    koder: [code({ msgCount: 4 }), code({ msgCount: 1 }), code({ msgCount: 11 })],
  })).text();

  assertStringIncludes(html, "<dd>16</dd>");
});

Deno.test("a paused code says so, and offers the way back", async () => {
  const html = await renderKoder(view({ koder: [code({ status: "paused" })] })).text();

  assertStringIncludes(html, "dot--off");
  assertStringIncludes(html, "Pausad");
  assertStringIncludes(html, "Återuppta");
  assert(!html.includes(">Pausa<"), "a paused code is not offered a pause");
});

Deno.test("every action carries the code it acts on", async () => {
  const html = await renderKoder(view({
    koder: [code({ slug: "K7M4NPQR8TVWXYZ2ABCD" }), code({ slug: "R4XT9WPM2KQNBVCD7HJE" })],
  })).text();

  for (const atgard of ["pausa", "oppna", "radera"]) {
    assertStringIncludes(html, `data-atgard="${atgard}"`);
  }
  assertEquals(html.match(/data-slug="K7M4NPQR8TVWXYZ2ABCD"/g)?.length, 3, "three that act");
  assertEquals(html.match(/data-slug="R4XT9WPM2KQNBVCD7HJE"/g)?.length, 3);
});

/**
 * The fourth control is a link rather than an action, and deliberately. The print controls build
 * a URL from a slug that is printed on the garment, so reaching them needs no token and must not
 * spend one: an owner fetching files for three codes would otherwise spend their link on the
 * first and have to ask for a new one by mail to reach the second.
 */
Deno.test("looking at the print files costs no link", async () => {
  const html = await renderKoder(view()).text();

  assertStringIncludes(html, '<a class="btn btn--ghost btn--tiny" href="/klar?kod=');
  assertEquals(
    html.match(/data-atgard="oppna"/g)?.length,
    1,
    "one code, one action that opens a page, and it is the purpose editor",
  );
});

Deno.test("deleting asks first, and pausing does not", async () => {
  const html = await renderKoder(view()).text();

  const radera = html.slice(html.indexOf('data-atgard="radera"'));
  assertStringIncludes(radera.slice(0, 400), "data-bekrafta=");
  const pausa = html.slice(html.indexOf('data-atgard="pausa"'));
  assert(!pausa.slice(0, 200).includes("data-bekrafta="), "pausing is reversible, so it just does");
});

/**
 * A link that names one code opens the same page with one row on it. What it must not offer is
 * the two things that belong to the address rather than to a code: making another, and moving
 * all of them.
 */
Deno.test("a single-code link offers nothing that belongs to the address", async () => {
  const html = await renderKoder(view({ helaListan: false })).text();

  assert(!html.includes("Skapa en till"));
  assert(!html.includes("Byt mailadress"));
  assertStringIncludes(html, 'data-atgard="pausa"', "but the code's own controls are there");
});

Deno.test("the full list offers making another, and moving them all", async () => {
  const html = await renderKoder(view()).text();

  assertStringIncludes(html, "Skapa en till");
  assertStringIncludes(html, "Byt mailadress");
  assertStringIncludes(html, 'data-atgard="skapa"');
});

Deno.test("a label an owner typed cannot become markup on their own page", async () => {
  const html = await renderKoder(view({
    koder: [code({ etikett: `<script>alert(1)</script>`, syfte: "eget" })],
  })).text();

  assert(!html.includes("<script>alert(1)"), "the label must not become an element");
  assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
});

Deno.test("the token travels to the client once, and not in a link", async () => {
  const html = await renderKoder(view({ token: "t0ken" })).text();

  assertStringIncludes(html, 'window.OJHEJ_T="t0ken"');
  assert(!html.includes('href="/hantera?t=t0ken"'), "no link carries it back into a page");
});

Deno.test("the page says how long the link lasts and what an action does to it", async () => {
  const html = await renderKoder(view()).text();
  assertStringIncludes(html, "30 minuter");
});

Deno.test("the scan address of each code is shown, because it is the owner's own", async () => {
  const html = await renderKoder(view()).text();
  assertStringIncludes(html, "ojhej.se/s/K7M4NPQR8TVWXYZ2ABCD");
});

Deno.test("when there is nothing to mask, the address row is left out rather than faked", async () => {
  const html = await renderKoder(view({ epost: null })).text();

  assert(!html.includes("<dt>Mail</dt>"));
  assertStringIncludes(html, "<dt>Koder</dt>", "the rest of the block still renders");
});
