import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderKollaMailen, renderLanding, renderSkapa } from "./signup.ts";
import { setContactCode } from "./layout.ts";
import { ASSET_VERSION, VERSIONED_ASSETS } from "../assets.ts";
import { computeAssetVersion } from "../../scripts/asset-version.ts";
import { STATS_FLOOR } from "../store/stats.ts";
import { renderVerifieraConfirm, renderVerifieraFailed } from "./verifiera.ts";
import { renderBytEpostConfirm, renderBytEpostFailed, renderBytt } from "./byt-epost.ts";
import { renderHanteraLocked, renderRaderad } from "./hantera.ts";
import { renderActive, renderSent, renderUnknown } from "./microsite.ts";

/** Every page a visitor can reach without a token, plus the token pages with a dummy one. */
function everyPage(): Promise<{ name: string; html: string }[]> {
  const pages: [string, Response][] = [
    ["landing", renderLanding()],
    ["skapa", renderSkapa()],
    ["verifiera-confirm", renderVerifieraConfirm("t0ken")],
    ["verifiera-failed", renderVerifieraFailed()],
    ["byt-epost-confirm", renderBytEpostConfirm("t0ken")],
    ["byt-epost-failed", renderBytEpostFailed()],
    ["bytt", renderBytt()],
    ["raderad", renderRaderad()],
  ];
  return Promise.all(pages.map(async ([name, response]) => ({
    name,
    html: await response.text(),
  })));
}

/**
 * The property that makes "no cookie banner" true rather than merely claimed.
 *
 * Every third-party request a page makes hands that party the visitor's IP address and the page
 * they were on. For this product that is not a technicality: the whole promise is that someone
 * can say hello without anybody's details travelling anywhere. Fonts used to come from Google's
 * CDN, which meant the promise was broken on first paint, before a single word was typed.
 *
 * This is written as an origin sweep rather than a check for the specific hosts that used to be
 * here, because the next regression will be some other CDN nobody thought to look for.
 *
 * What counts is what the browser *fetches*: `src`, and `href` on a `<link>`, which between them
 * cover scripts, images, stylesheets, fonts and preloads. Those happen on load, without the
 * reader choosing, and each one hands a third party their IP and the page they were on.
 *
 * A plain `<a href>` is not that. It fetches nothing until somebody decides to click, and this
 * site sends `referrer-policy: no-referrer`, so even the click carries no page. The footer's
 * source link is one, and the fence below is what keeps that the only kind of exception.
 */
Deno.test("no page loads anything from a third party", async () => {
  for (const { name, html } of await everyPage()) {
    const loaded = [
      ...html.matchAll(/src="(?:https?:)?\/\/([^"/]+)/g),
      ...html.matchAll(/<link[^>]*?href="(?:https?:)?\/\/([^"/]+)/g),
    ].map((match) => match[1]);

    assertEquals(loaded, [], `${name} loads from ${loaded.join(", ")}`);
  }
});

/**
 * The fence around that loosening.
 *
 * The sweep above no longer fails on any cross-origin `href`, which is a real weakening of a test
 * written to keep a privacy promise. So this pins the remaining surface: every cross-origin
 * reference on every page is a link a reader chooses to follow, to exactly one host, and never
 * something the browser fetches on its own.
 */
Deno.test("the only thing pointing off-site is a link the reader chooses", async () => {
  for (const { name, html } of await everyPage()) {
    const offSite = [...html.matchAll(/<(\w+)[^>]*?(?:href|src)="(?:https?:)?\/\/([^"/]+)/g)];

    for (const [, tag, host] of offSite) {
      assertEquals(tag, "a", `${name} points off-site from a <${tag}>, which loads on its own`);
      assertEquals(host, "github.com", `${name} points at ${host}`);
    }
  }
});

Deno.test("every page loads the self-hosted fonts", async () => {
  for (const { name, html } of await everyPage()) {
    // The stamp is asserted on its own below. Here it is only in the way, and pinning it would
    // make every stylesheet edit fail a test about where the fonts come from.
    assert(html.includes('href="/fonts.css?v='), `${name} is missing the font stylesheet`);
  }
});

/**
 * A page that declares no charset renders å, ä and ö as mojibake in any client that guesses
 * wrong, which on a Swedish site is most of the words that carry feeling.
 */
Deno.test("every page declares its charset and viewport", async () => {
  for (const { name, html } of await everyPage()) {
    assert(html.includes('<meta charset="utf-8">'), `${name} declares no charset`);
    assert(html.includes('name="viewport"'), `${name} declares no viewport`);
  }
});

/** The token pages carry a secret in their own URL, so they must not leak it in a referrer. */
Deno.test("pages holding a token in the URL send no referrer", async () => {
  const withToken = [
    ["verifiera", await renderVerifieraConfirm("t0ken").text()],
    ["byt-epost", await renderBytEpostConfirm("t0ken").text()],
  ];

  for (const [name, html] of withToken) {
    assert(
      html!.includes('name="referrer" content="no-referrer"'),
      `${name} would hand its token to whatever it links to`,
    );
  }
});

/**
 * A slug lives in the URL of several of these pages and is printed on a garment, so it is not
 * a secret; a token is. Neither should travel to anything a page embeds. The meta tag covers
 * clients that ignore the header and vice versa, which is why both are here.
 */
Deno.test("every page sends the security headers it depends on", async () => {
  const responses: [string, Response][] = [
    ["landing", renderLanding()],
    ["skapa", renderSkapa()],
    ["verifiera", renderVerifieraConfirm("t0ken")],
    ["byt-epost", renderBytEpostConfirm("t0ken")],
    ["bytt", renderBytt()],
  ];

  for (const [name, response] of responses) {
    assertEquals(response.headers.get("referrer-policy"), "no-referrer", name);
    assertEquals(response.headers.get("x-content-type-options"), "nosniff", name);
    assertEquals(response.headers.get("content-type"), "text/html; charset=utf-8", name);
    await response.body?.cancel();
  }
});

/* ---------- finding your way ---------- */

/**
 * Until this existed nothing anywhere pointed at `/hantera`, so somebody who printed a shirt
 * months ago and wanted to pause it had to already know the URL. That page without a token asks
 * for an address and mails a link, which is the whole way back in.
 */
Deno.test("every owner-facing page offers a way to the manage page", async () => {
  const pages: [string, Response][] = [
    ["landing", renderLanding()],
    ["skapa", renderSkapa()],
    ["kolla-mailen", renderKollaMailen()],
    ["verifiera", renderVerifieraConfirm("t0ken")],
    ["byt-epost", renderBytEpostConfirm("t0ken")],
    ["bytt", renderBytt()],
    ["raderad", renderRaderad()],
    ["hantera-locked", renderHanteraLocked()],
  ];

  for (const [name, response] of pages) {
    const html = await response.text();
    assert(
      html.includes('href="/hantera"') || html.includes('aria-current="page">Hantera koder'),
      `${name} offers no route to the manage page`,
    );
    assert(html.includes('class="nav"'), `${name} has no footer navigation`);
  }
});

/** The current page is marked rather than linked: a link to where you already are is a lie. */
Deno.test("the page you are on is marked, not linked", async () => {
  const html = await renderHanteraLocked().text();

  assertStringIncludes(html, '<span class="nav-here" aria-current="page">Hantera koder</span>');
  assert(!html.includes('<a href="/hantera"'), "the current page must not link to itself");
  assertStringIncludes(html, 'href="/skapa"', "but the others are still reachable");
});

/**
 * The other half of the rule. Everything a stranger sees was reached by scanning a garment;
 * they are not managing a code and may never have heard of the service. Offering them
 * "Hantera koder" frames a first contact as an account screen.
 */
Deno.test("pages a stranger reaches by scanning carry no owner navigation", async () => {
  const strangerPages: [string, Response][] = [
    [
      "scan",
      renderActive({
        slug: "K7M4NPQR8TVWXYZ2ABCD",
        emailEnc: "x",
        status: "active",
        createdAt: 0,
        verifiedAt: 0,
        msgCount: 0,
        msgToday: 0,
        msgDay: 0,
      }),
    ],
    ["scan-unknown", renderUnknown()],
    ["sent", renderSent()],
  ];

  for (const [name, response] of strangerPages) {
    const html = await response.text();
    assert(!html.includes('href="/hantera"'), `${name} offers manage to a stranger`);
    assert(!html.includes('href="/skapa"'), `${name} pushes signup at a stranger`);
    assertStringIncludes(html, 'href="/"', `${name} should still offer a quiet way to the pitch`);
  }
});

/**
 * The footer line goes everywhere, including the pages a stranger reaches by scanning a
 * garment. That reader is exactly who it is addressed to: somebody who just scanned something
 * and is deciding whether to say anything. The navigation above it stays owner-only.
 */
Deno.test("the footer says what this is for, on every page including the scan pages", async () => {
  const everywhere: [string, Response][] = [
    ["landing", renderLanding()],
    ["skapa", renderSkapa()],
    ["hantera-locked", renderHanteraLocked()],
    ["bytt", renderBytt()],
    ["verifiera", renderVerifieraConfirm("t0ken")],
    ["sent", renderSent()],
    ["scan-unknown", renderUnknown()],
  ];

  for (const [name, response] of everywhere) {
    const html = await response.text();
    assertStringIncludes(html, "ojhej.se", `${name} does not name the site`);
    assertStringIncludes(html, "sätt att få kontakt", `${name} is missing the line`);
    assert(html.includes('class="site-foot-brand"'), `${name} has no footer mark`);
  }
});

/** The site is named once per footer. It was briefly twice, as brand and again as a nav item. */
Deno.test("the footer names the site exactly once, and the name is the way home", async () => {
  const pages: [string, Response][] = [
    ["landing", renderLanding()],
    ["hantera-locked", renderHanteraLocked()],
    ["sent", renderSent()],
    ["scan-unknown", renderUnknown()],
  ];

  for (const [name, response] of pages) {
    const html = await response.text();
    const footer = html.slice(html.indexOf('class="site-foot"'));

    assertEquals(
      (footer.match(/ojhej\.se/g) ?? []).length,
      1,
      `${name} names the site more than once in its footer`,
    );
    assertStringIncludes(
      html,
      '<a class="site-foot-brand" href="/"',
      `${name} brand is not a link`,
    );
  }
});

/* ---------- the contact code in the footer ---------- */

/**
 * Reaching us goes through the same form, relay and daily cap as reaching anyone else. If the
 * product is not good enough for our own contact address it is not good enough.
 */
Deno.test("the footer code links as well as scans", async () => {
  setContactCode("K7M4NPQR8TVWXYZ2ABCD");
  try {
    const html = await renderLanding().text();

    assertStringIncludes(html, 'href="/s/K7M4NPQR8TVWXYZ2ABCD"');
    assertStringIncludes(html, 'src="/api/qr/K7M4NPQR8TVWXYZ2ABCD.svg?mm=40"');
    // Nobody can scan their own phone screen, so the link is how it works for most readers.
    assert(
      html.includes('<a class="site-foot-qr" href="/s/'),
      "the code must be tappable, not only scannable",
    );
    assertStringIncludes(html, 'alt="', "a decorative-looking image still needs a label");
  } finally {
    setContactCode(null);
  }
});

Deno.test("no configured code means no QR, not a broken one", async () => {
  setContactCode(null);
  const html = await renderLanding().text();

  assert(!html.includes("site-foot-qr"), "an unset code must render nothing at all");
  assertStringIncludes(html, "site-foot-line", "the rest of the footer is unaffected");
});

/**
 * A malformed value would put a broken image on every page of the site. Dropped instead: the
 * footer is decoration and must never be able to take the whole site's appearance down.
 */
Deno.test("a malformed contact code is ignored rather than rendered", async () => {
  for (const bad of ["", "not-a-slug", "IOUL0000000000000000", "../../etc/passwd", "K7M4"]) {
    setContactCode(bad);
    const html = await renderLanding().text();
    assert(!html.includes("site-foot-qr"), `"${bad}" should not have rendered`);
  }
  setContactCode(null);
});

/** It belongs on the scan pages too: that reader has just met the product for the first time. */
Deno.test("the contact code reaches the pages a stranger lands on", async () => {
  setContactCode("K7M4NPQR8TVWXYZ2ABCD");
  try {
    for (const [name, response] of [["sent", renderSent()], ["scan", renderUnknown()]] as const) {
      assertStringIncludes(await response.text(), "site-foot-qr", name);
    }
  } finally {
    setContactCode(null);
  }
});

/**
 * The small code is not scannable and is not meant to be: at 56px it is about 1.4 screen pixels
 * per module. Enlarging is what makes it readable, and the markup has to carry both the small
 * one and the large one for that to work without a round trip.
 */
Deno.test("the footer ships both a small code and an enlargeable one", async () => {
  setContactCode("K7M4NPQR8TVWXYZ2ABCD");
  try {
    const html = await renderLanding().text();

    assertStringIncludes(html, 'width="56"', "the footer code is small on purpose");
    assertStringIncludes(html, '<dialog class="qr-dialog"', "and there is a larger one to open");
    assertStringIncludes(html, 'width="260"', "the enlarged one is big enough to photograph");

    // A link first, enhanced second: with no JavaScript the tap still opens our page.
    assertStringIncludes(html, '<a class="site-foot-qr" href="/s/K7M4NPQR8TVWXYZ2ABCD"');
    // And the dialog offers the same destination, for anyone who opened it and would rather read.
    assertStringIncludes(html, '<a href="/s/K7M4NPQR8TVWXYZ2ABCD">Öppna sidan i stället</a>');
  } finally {
    setContactCode(null);
  }
});

/** The small code is decorative, so it must not be announced twice to a screen reader. */
Deno.test("the small code has an empty alt and the enlarged one is described", async () => {
  setContactCode("K7M4NPQR8TVWXYZ2ABCD");
  try {
    const html = await renderLanding().text();
    const small = html.slice(html.indexOf("site-foot-qr"), html.indexOf("<dialog"));

    assertStringIncludes(small, 'alt=""', "the small code repeats the link text beside it");
    assertStringIncludes(html, 'alt="QR-kod till vår sida"', "the enlarged one stands alone");
  } finally {
    setContactCode(null);
  }
});

/* ---------- the figure on the landing page ---------- */

/**
 * Nothing and zero are the only figures worth hiding.
 *
 * The floor used to be ten, on the reasoning that a small number reads as nobody being here.
 * What it actually did was hide the figure on the site it was written for: production sat under
 * ten and the corner was empty for everybody, which is the one outcome the folio cannot survive.
 * A real count is a better sentence than no sentence, so the floor is now the first code.
 */
Deno.test("the figure appears as soon as there is a code to count", async () => {
  for (const value of [null, 0]) {
    const html = await renderLanding(value).text();
    assert(!html.includes("skapad"), `${value} should not have been shown`);
  }

  const shown = await renderLanding(STATS_FLOOR).text();
  assertStringIncludes(shown, `<span class="folio-number">${STATS_FLOOR}</span>`);
});

/** Swedish will not let you fudge this, and the number sits in its own span away from the noun. */
Deno.test("the figure agrees with its own number", async () => {
  assertStringIncludes(await renderLanding(1).text(), "</span> kod skapad</p>");

  for (const many of [2, 14, 1234]) {
    assertStringIncludes(await renderLanding(many).text(), "</span> koder skapade</p>");
  }
});

/** An unreadable counter costs a sentence, never a page. */
Deno.test("the landing page renders fully when the figure cannot be read", async () => {
  const html = await renderLanding(null).text();

  assertStringIncludes(html, "Oj&nbsp;hej.");
  assertStringIncludes(html, "Gör en egen kod");
  assertStringIncludes(html, "site-foot");
});

Deno.test("the figure is rendered as a number, not as markup", async () => {
  const html = await renderLanding(1234).text();
  assertStringIncludes(html, ">1234</span>");
  // It comes from our own counter, never from a request, but the page must still be plain.
  assert(!html.includes("<script>1234"), "no interpolation into anything executable");
});

/**
 * The footer code must never point at the page it is sitting on.
 *
 * Our own contact page is the one place where "/s/<contactCode>" is where the reader already
 * is, and a link to here is a link to nowhere. On a desktop pointer nobody noticed, because the
 * dialog intercepts the click and the link is never followed. On a finger the link is the whole
 * behaviour, so the tap reloaded the page and looked like a dead control.
 */
Deno.test("the footer code is absent on the page it would link to", async () => {
  setContactCode("K7M4NPQR8TVWXYZ2ABCD");
  try {
    const ours = await renderActive({
      slug: "K7M4NPQR8TVWXYZ2ABCD",
      emailEnc: "x",
      status: "active",
      createdAt: 0,
      verifiedAt: 0,
      msgCount: 0,
      msgToday: 0,
      msgDay: 0,
    }).text();

    assert(!ours.includes("site-foot-qr"), "a link to the current page is not a link");
    assert(!ours.includes("qr-dialog"), "and the dialog it opens has nothing left to offer");
    assertStringIncludes(ours, "site-foot-line", "the rest of the footer is untouched");

    // Somebody else's code is a different page, so the way to reach us still belongs there.
    const theirs = await renderActive({
      slug: "TFKC0A11RFAWHN8TX5A0",
      emailEnc: "x",
      status: "active",
      createdAt: 0,
      verifiedAt: 0,
      msgCount: 0,
      msgToday: 0,
      msgDay: 0,
    }).text();

    assertStringIncludes(theirs, 'href="/s/K7M4NPQR8TVWXYZ2ABCD"');
  } finally {
    setContactCode(null);
  }
});

/* ---------- asset versioning ---------- */

/**
 * The stylesheet and the script must be requested at a URL that changes when they do.
 *
 * The CDN hands these to a browser with `Cache-Control: max-age=25600000`, which is nine and a
 * half months, while the HTML that references them is `no-store`. Unversioned, that combination
 * ships new markup to a returning visitor and leaves them running the script they downloaded
 * the first time they came. It is not theoretical: it shipped the purpose picker to everybody
 * and left it dead for anybody who had been to the site before, because the chip handler lived
 * in an `app.js` their browser was not going to ask for again until 2027.
 */
Deno.test("every page asks for its assets by version", async () => {
  const version = await computeAssetVersion();

  for (const { name, html } of await everyPage()) {
    for (const asset of VERSIONED_ASSETS) {
      assertStringIncludes(html, `/${asset}?v=${version}`, `${name} loads ${asset} unversioned`);
    }
  }
});

/**
 * The stamp is a constant because the edge isolate has no `public/` to hash: it serves HTML and
 * the CDN serves the files. A constant somebody has to remember to bump is a constant that goes
 * stale, so this is the thing that remembers.
 */
Deno.test("the stamped version is the version of the files on disk", async () => {
  assertEquals(
    ASSET_VERSION,
    await computeAssetVersion(),
    "public/ has changed since the version was stamped: run `deno task asset-version`",
  );
});

/* ---------- the way back in ---------- */

/**
 * The landing page had one door, and it was for people who had never been here.
 *
 * A returning owner arrives by typing ojhej.se, meets "Gör en egen kod", and has to scroll past
 * the fold, the explainer and the privacy line to find the footer link that is actually theirs.
 * The footer nav fixed "nothing points at /hantera" and left "nobody can find it".
 *
 * Not a header and not a menu: the navigation rule here is that the footer carries the only nav,
 * because everything else is reached from a link in a mailbox and a menu would offer doors that
 * do not open. One subordinate line under the primary action is the whole change.
 */
Deno.test("the landing page offers the way back in without scrolling to the footer", async () => {
  const html = await renderLanding().text();

  const beforeFooter = html.slice(0, html.indexOf('class="site-foot"'));
  assertStringIncludes(
    beforeFooter,
    'href="/hantera"',
    "an owner who already has a code is offered nothing above the footer",
  );
  assertStringIncludes(beforeFooter, "Har du redan en kod?");

  // Subordinate to the primary action, not competing with it. Two buttons here would ask a
  // first-time visitor to make a choice they have no way to make.
  assert(
    !beforeFooter.includes('<a class="btn" href="/hantera"'),
    "the way back in must not be a second call to action",
  );
});

/**
 * The source link is provenance, not navigation, so it does not follow the owner-only rule.
 *
 * The scan page tells a stranger we store neither their message nor their details. That reader is
 * being asked to trust a claim, which makes them the person most entitled to check it, so the
 * link to the source belongs on their page too. The nav above it stays owner-only.
 */
Deno.test("every page links to the source, including the ones a stranger scans", async () => {
  const pages: [string, Response][] = [
    ["landing", renderLanding()],
    ["skapa", renderSkapa()],
    ["hantera-locked", renderHanteraLocked()],
    ["sent", renderSent()],
    ["scan-unknown", renderUnknown()],
    [
      "scan",
      renderActive({
        slug: "K7M4NPQR8TVWXYZ2ABCD",
        emailEnc: "x",
        status: "active",
        createdAt: 0,
        verifiedAt: 0,
        msgCount: 0,
        msgToday: 0,
        msgDay: 0,
      }),
    ],
  ];

  for (const [name, response] of pages) {
    const html = await response.text();
    assertStringIncludes(html, 'href="https://github.com/imbabamba/ojhej"', name);
    // Inline, so it costs no request and cannot hand a third party the visitor's IP.
    assertStringIncludes(html, '<svg class="gh-mark"', name);

    // Labelled, but the wording is not pinned. This asserted the exact sentence once and broke
    // the build the first time the label was shortened, which is a test failing on a change it
    // was never there to protect. What matters is that the link says where it goes rather than
    // being a bare mark somebody has to guess at.
    const link = html.slice(html.indexOf("site-foot-src"));
    const text = link.slice(0, link.indexOf("</a>")).replace(/<[^>]*>/g, "").trim();
    assertStringIncludes(text, "GitHub", `${name} links to the source without saying so`);
  }
});

/**
 * A stranger on the scan page is part-way through writing to somebody. A footer link that
 * navigated the tab away would throw that message out, which is why this one alone opens a tab.
 */
Deno.test("the source link opens away from a half-written message", async () => {
  const html = await renderActive({
    slug: "K7M4NPQR8TVWXYZ2ABCD",
    emailEnc: "x",
    status: "active",
    createdAt: 0,
    verifiedAt: 0,
    msgCount: 0,
    msgToday: 0,
    msgDay: 0,
  }).text();

  const link = html.slice(html.indexOf("site-foot-src"));
  const tag = link.slice(0, link.indexOf(">"));
  assertStringIncludes(tag, 'target="_blank"');
  assertStringIncludes(tag, "noopener", "a new tab must not get a handle on this one");
});
