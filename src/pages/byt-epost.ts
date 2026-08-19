/**
 * The interstitial that makes a change of address safe to prefetch.
 *
 * Same shape as `verifiera.ts` and for the same reason: mail security gateways fetch every link
 * in a message at delivery, and a change of owner address completed by a scanner would be a
 * change nobody chose. The GET only asks. The form POST does the work, and scanners do not
 * submit forms.
 *
 * Plain HTML rather than a fetch call, because this arrives in a mail client's own browser.
 *
 * Neither page names the code or either address. A scanner sees this page, and so does anyone
 * the link is forwarded to.
 */

import { escapeHtml, MARK, page, siteFooter } from "./layout.ts";

function shell(inner: string, foot: string): string {
  return `<div class="screen screen--center">
<div class="wrap">${inner}</div>
<div class="wrap pad-bottom"><div class="foot">${foot}</div></div>
</div>`;
}

export function renderBytEpostConfirm(token: string): Response {
  const body = shell(
    `<div class="stack stack-xl">
<div class="reveal">${MARK}</div>

<div class="reveal stack stack-l">
<h1 class="headline">Är det här din adress?</h1>
<p class="lede">Bekräfta så flyttar vi koden hit. Meddelanden slutar samtidigt gå till den gamla adressen.</p>
</div>

<form class="reveal stack stack-s" method="post" action="/byt-epost">
<input type="hidden" name="t" value="${escapeHtml(token)}">
<button class="btn" type="submit">Bekräfta adressen</button>
<p class="aside">Länken används upp när du klickar, och fungerar bara en gång.</p>
</form>
</div>`,
    siteFooter("hem"),
  );

  // No referrer, because the token is in this page's own URL.
  return page({ title: "Bekräfta din adress · Oj hej.", body, noReferrer: true });
}

/** Unknown, spent, expired, the wrong kind of link, or a code that is gone. Never says which. */
export function renderBytEpostFailed(): Response {
  const body = shell(
    `<div class="stack stack-xl">
<div class="reveal">${MARK}</div>

<div class="reveal stack stack-l">
<h1 class="headline">Länken funkade inte.</h1>
<p class="lede">
Den kan vara använd redan, eller för gammal. Begär en ny hantera-länk så kan du försöka igen.
</p>
</div>

<div class="reveal"><a class="btn" href="/hantera">Till hantera</a></div>
</div>`,
    siteFooter("hem"),
  );

  return page({ title: "Länken funkade inte · Oj hej.", body });
}

/** After the change. Deliberately says which inbox things arrive in from now on. */
export function renderBytt(): Response {
  const body = shell(
    `<div class="stack stack-xl">
<div class="reveal">${MARK}</div>

<div class="reveal stack stack-l">
<h1 class="headline">Klart. Adressen är bytt.</h1>
<p class="lede">
Meddelanden till din kod landar från och med nu i den här inkorgen. Själva koden är samma som
förut, så du behöver inte trycka om någonting.
</p>
</div>

<div class="reveal"><a class="btn" href="/hantera">Hantera koden</a></div>
</div>`,
    siteFooter("hem"),
  );

  return page({ title: "Adressen är bytt · Oj hej.", body });
}
