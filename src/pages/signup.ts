/**
 * The signup funnel: landing, create, check your mail.
 *
 * Real pages at real URLs. These replace the mock files that were being served here, which
 * broke the moment they were served from `/` rather than as files in a folder: they asked
 * for a relative `mock.css` that does not exist at the site root, so the landing rendered
 * with no stylesheet at all.
 *
 * Copy is the approved variant B, including Anders' rewrite of the folded explainer to lead
 * with mechanics rather than reassurance.
 */

import { STATS_FLOOR } from "../store/stats.ts";
import { MARK, page, siteFooter } from "./layout.ts";

const FOOT_PRIVACY = "Meddelanden skickas vidare till dig och sparas inte hos oss.";

/**
 * The landing page.
 *
 * Two doors, and deliberately not two buttons. The page had one action and it was written for
 * somebody who has never been here, so a returning owner met "Gör en egen kod" and had to scroll
 * past the fold, the explainer and the privacy line to reach the footer link that was actually
 * theirs. The way back in is now a line under the call to action, subordinate to it: a second
 * button would ask a first-time visitor to choose between two things when only one of them can
 * possibly apply to them. It is not a header either, for the reason in `siteNav`: the footer
 * carries the only navigation, because everything else here is reached from a link in a mailbox.
 *
 * `aktiverade` is how many codes have been activated, or null when the figure could not be
 * read. It sits in the corner as a folio, and appears from the first code: only zero and
 * unreadable are hidden, because those are the two figures that say nobody is here. See
 * `STATS_FLOOR` for why that floor used to be ten and what that cost. Never a reason to fail:
 * an unreadable counter simply means the line is absent, and nobody misses a sentence they
 * never saw.
 */
export function renderLanding(aktiverade: number | null = null): Response {
  const show = aktiverade !== null && aktiverade >= STATS_FLOOR;
  // A stat block rather than another faint aside. As `.dry` it sat directly under a line in the
  // same faint italic and read as a continuation of the small print, which is a good way to
  // print a number nobody sees. The number takes the display face and the ink; the label takes
  // the eyebrow treatment used elsewhere for spec labels.
  // A corner mark rather than a stat block under the call to action. It is a small pleasing
  // fact, not an argument, and putting it in the corner lets it be found rather than presented.
  // Swedish will not let you fudge the singular, and the number lives in its own span so it can
  // take the display face, which puts the noun and its agreement out here rather than in
  // `text.ts` beside the other counted things. One surface says this, so it says it locally.
  const ord = aktiverade === 1 ? "kod skapad" : "koder skapade";
  const räknare = show
    ? `<p class="folio"><span class="folio-number">${aktiverade}</span> ${ord}</p>`
    : "";

  const body = `<div class="screen screen--folio">
${räknare}
<div class="wrap pad-top grow" style="display:flex;flex-direction:column;justify-content:center">
<div class="stack stack-xl">
<div class="reveal">${MARK}</div>

<div class="reveal stack stack-l">
<h1 class="statement">Oj&nbsp;hej.</h1>
<p class="lede">Någon skannar. Sen får vi se.</p>
</div>

<div class="reveal stack stack-s">
<a class="btn" href="/skapa">Gör en egen kod</a>
<p class="dry">Det tar en halv minut och kostar ingenting.</p>
<p class="aside"><a href="/hantera">Har du redan en kod?</a></p>
</div>
</div>
</div>

<div class="wrap pad-bottom">
<details class="fold">
<summary>Hur funkar det?</summary>
<div class="fold-body stack">
<p class="aside">
Du får en QR-kod med en egen adress. Tryck den på vad du vill: tröja, keps, tygkasse.
Någon skannar den, skriver några rader, och meddelandet landar i din mail.
</p>
<p class="aside">
Du lämnar aldrig ut nummer, mail eller Instagram. Ingen ser vem du är förrän du svarar,
och du måste inte svara.
</p>
</div>
</details>
<div class="foot" style="border:0;padding-top:1rem">${FOOT_PRIVACY}</div>
<div class="foot" style="border:0;padding-top:0">${siteFooter("hem")}</div>
</div>
</div>`;

  return page({ title: "Oj hej.", body });
}

export function renderSkapa(): Response {
  const body = `<div class="screen">
<div class="wrap pad-top grow">
<div class="stack stack-xl">
<div class="reveal"><p class="eyebrow">Steg 1 av 2</p></div>

<div class="reveal stack stack-l">
<h1 class="headline">Skapa din kod.</h1>
<p class="lede">
Vi behöver bara en mailadress. Den används för att skicka vidare meddelanden till dig, och
visas aldrig för någon annan.
</p>
</div>

<form class="reveal stack stack-l" id="form" data-endpoint="/api/skapa" data-next="/kolla-mailen">
<div class="field">
<label for="epost">Din mailadress</label>
<input class="input" id="epost" name="epost" type="email" inputmode="email"
  autocomplete="email" placeholder="du@exempel.se" maxlength="254" required>
<p class="hint">Hit skickas meddelanden. Byt eller radera när du vill.</p>
</div>

<div class="hp" aria-hidden="true">
<label for="hemsida">Lämna tomt</label>
<input id="hemsida" name="hemsida" type="text" tabindex="-1" autocomplete="off">
</div>

<div class="altcha" id="altcha-box">
<span class="tick" id="altcha-tick">·</span>
<span id="altcha-text">Förbereder …</span>
<span class="brand">Altcha</span>
</div>

<div class="stack stack-s">
<button class="btn" type="submit" id="skicka" disabled>Skicka verifieringslänk</button>
<p class="aside" id="fel" style="color:var(--accent);display:none"></p>
<p class="aside">
Genom att fortsätta godkänner du att vi lagrar din mailadress krypterat, tills du raderar den.
</p>
</div>
</form>
</div>
</div>

<div class="wrap pad-bottom"><div class="foot">${siteFooter("skapa")}</div></div>
</div>`;

  return page({ title: "Skapa din kod · Oj hej.", body });
}

/**
 * Shown after signup, and after asking to move a code to another address. Deliberately does not
 * name the address that was submitted: the page is reachable by anyone who knows the URL, and
 * echoing back whatever was typed would turn it into a reflection of arbitrary text.
 *
 * The two cases say different things because they promise different things. A signup link runs
 * for seven days and activates a code; a change link runs for an hour, activates nothing, and
 * lands in an inbox the reader may not have open. Reusing one wording would have told half the
 * people who see this page something untrue.
 */
export function renderKollaMailen(variant: "signup" | "byte" = "signup"): Response {
  const byte = variant === "byte";

  const body = `<div class="screen screen--center">
<div class="wrap">
<div class="stack stack-xl">
<div class="reveal"><p class="eyebrow">${byte ? "Nästan bytt" : "Steg 2 av 2"}</p></div>

<div class="reveal stack stack-l">
<h1 class="headline">${byte ? "Kolla den nya mailen." : "Kolla mailen."}</h1>
<p class="lede">${
    byte
      ? "Vi skickade en länk dit. Klicka i den så flyttas koden. Tills dess går allt till den gamla adressen."
      : "Vi skickade en länk. Klicka i den så aktiveras din kod."
  }</p>
<p class="dry">Titta i skräpposten också. Det gör vi alla.</p>
</div>

<div class="reveal stack stack-s">
<a class="btn btn--ghost" href="${byte ? "/hantera" : "/skapa"}">${
    byte ? "Tillbaka till hantera" : "Skicka länken igen"
  }</a>
<p class="aside">${
    byte
      ? "Länken gäller i en timme. Vi har också sagt till den gamla adressen att någon frågat."
      : "Länken gäller i sju dagar. Efter det försvinner koden av sig själv."
  }</p>
</div>
</div>
<div class="foot">${siteFooter(byte ? "hantera" : "skapa")}</div>
</div>
</div>`;

  return page({ title: byte ? "Kolla den nya mailen · Oj hej." : "Kolla mailen · Oj hej.", body });
}
