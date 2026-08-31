/**
 * The interstitial that makes verification safe to prefetch.
 *
 * A verification link is clicked once, from an inbox, and it used to be consumed by the GET
 * that loaded it. Mail security gateways fetch every link in a message at delivery time, so
 * that design let a scanner burn the token before the owner ever saw it. The owner would then
 * click, meet a generic failure, and have no way to activate at all. It would look like an
 * unreproducible bug and would hit corporate mail hardest.
 *
 * So the GET only asks. A form POST does the work, and scanners do not submit forms. This is
 * a plain HTML form rather than a fetch call: verification is the one step that must survive a
 * mail client's odd in-app browser with JavaScript disabled or blocked.
 */

import { escapeHtml, MARK, page, siteFooter } from "./layout.ts";

function shell(inner: string, foot: string): string {
  return `<div class="screen screen--center">
<div class="wrap">${inner}</div>
<div class="wrap pad-bottom"><div class="foot">${foot}</div></div>
</div>`;
}

export function renderVerifieraConfirm(token: string): Response {
  const body = shell(
    `<div class="stack stack-xl">
<div class="reveal">${MARK}</div>

<div class="reveal stack stack-l">
<h1 class="headline">Nästan igång.</h1>
<p class="lede">Ett klick till, så kan din kod ta emot svar.</p>
</div>

<form class="reveal stack stack-s" method="post" action="/verifiera">
<input type="hidden" name="t" value="${escapeHtml(token)}">
<button class="btn" type="submit">Aktivera koden</button>
<p class="aside">Länken används upp när du klickar, och fungerar bara en gång.</p>
</form>
</div>`,
    siteFooter("hem"),
  );

  // No referrer, because the token is in this page's own URL.
  return page({ title: "Aktivera din kod · Oj hej.", body, noReferrer: true });
}

/** Unknown, spent, expired or the wrong kind of link. Never says which. */
export function renderVerifieraFailed(): Response {
  const body = shell(
    `<div class="stack stack-xl">
<div class="reveal">${MARK}</div>

<div class="reveal stack stack-l">
<h1 class="headline">Länken funkade inte.</h1>
<p class="lede">
Den kan vara använd redan, eller för gammal. Skapa en ny kod så skickar vi en ny länk.
</p>
</div>

<div class="reveal"><a class="btn" href="/skapa">Skapa en kod</a></div>
</div>`,
    siteFooter("hem"),
  );

  return page({ title: "Länken funkade inte · Oj hej.", body });
}
