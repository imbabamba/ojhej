/**
 * GET /hantera
 *
 * Owner controls, behind a single-use magic link.
 *
 * Two real states, and the difference matters. Without a valid token there is nothing to
 * show and nothing to ask: the page offers to send a link to the address on the code. With
 * a valid token the controls appear, showing what the record actually says.
 *
 * The slug is never accepted from the URL here. It comes only from a consumed token, because
 * the slug is printed on a garment and anyone who has seen it could otherwise open this page.
 * That is the whole point of the two-secret model.
 */

import { escapeHtml, MARK, page, siteFooter } from "./layout.ts";
import { kortDatum, meddelanden, Rakneord, rakneord } from "../text.ts";
import { SYFTEN, syfteOf, visningsnamn } from "../syfte.ts";
import { MAX_CODES_PER_EMAIL } from "../store/emails.ts";
import type { CodeRecord } from "../store/shirts.ts";

function shell(inner: string, foot: string): string {
  return `<div class="screen">
<div class="wrap pad-top grow">${inner}</div>
<div class="wrap pad-bottom"><div class="foot">${foot}</div></div>
</div>`;
}

/** No token, or a spent one. Offers a new link rather than explaining which it was. */
export function renderHanteraLocked(): Response {
  const body = shell(
    `<div class="stack stack-xl">
<div class="reveal">${MARK}</div>

<div class="reveal stack stack-l">
<h1 class="headline">Hantera dina koder.</h1>
<p class="lede">
Den här sidan öppnas med en länk vi mailar till dig. Adressen på tröjan räcker inte, för den
kan vem som helst ha sett.
</p>
</div>

<form class="reveal stack stack-l" id="form" data-endpoint="/api/hantera" data-next="/kolla-mailen">
<div class="field">
<label for="epost">Mailadressen på koden</label>
<input class="input" id="epost" name="epost" type="email" inputmode="email"
  autocomplete="email" placeholder="du@exempel.se" maxlength="254" required>
<p class="hint">Vi skickar en länk som gäller i 30 minuter.</p>
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
<button class="btn" type="submit" id="skicka" disabled>Skicka hantera-länk</button>
<p class="aside" id="fel" style="color:var(--accent);display:none"></p>
<p class="aside">
Finns det ingen kod på adressen händer ingenting, och vi säger inte vilket det blev.
</p>
</div>
</form>
</div>`,
    siteFooter("hantera"),
  );

  return page({ title: "Hantera koder · Oj hej.", body });
}

/** After a delete. Says plainly that it is gone, because it is. */
export function renderRaderad(): Response {
  return page({
    title: "Raderad · Oj hej.",
    body: shell(
      `<div class="stack stack-xl">
<div class="reveal">${MARK}</div>
<div class="reveal stack stack-l">
<h1 class="statement">Borta.</h1>
<p class="lede">
Koden, din mailadress och räknaren är raderade. Adressen slutar fungera direkt, så trycket
leder ingenstans nu.
</p>
<p class="dry">Vill du ha en ny får du göra en ny.</p>
</div>
<div class="reveal"><a class="btn btn--ghost" href="/skapa">Skapa en ny kod</a></div>
</div>`,
      siteFooter("hantera"),
    ),
  });
}

const STATUS_TEXT: Record<CodeRecord["status"], string> = {
  pending: "Inte aktiverad",
  active: "Aktiv",
  paused: "Pausad",
};

export interface KoderVy {
  /** Every code this link reaches. Never empty: an empty list renders the locked page instead. */
  koder: CodeRecord[];
  baseUrl: string;
  token: string;
  /** Already masked. The page never receives the address in the clear. */
  epost: string | null;
  /**
   * Whether this link reaches the address or a single code.
   *
   * It decides whether the two address-level things are offered: making another code, and moving
   * every code to a new address. A link that grants one code must not show controls it could not
   * carry out, and the endpoint refuses them anyway.
   */
  helaListan: boolean;
}

/**
 * One code in the list, from mock 15: what it is called, what it is for, what it is doing.
 *
 * Three of the four controls are actions and spend the link. **Tryckfiler is a plain link**, and
 * that is the point of it: the print controls only ever build a URL from a slug that is printed
 * on the garment anyway, so fetching them needs no token and must not cost one. Making it an
 * action meant an owner who wanted files for three codes spent their link on the first and had to
 * ask for a new one by mail to reach the second.
 */
function kodRad(record: CodeRecord, baseUrl: string): string {
  const slug = escapeHtml(record.slug);
  const paused = record.status === "paused";
  const address = `${baseUrl.replace(/^https?:\/\//, "")}/s/${record.slug}`;
  const sedan = kortDatum(record.verifiedAt ?? record.createdAt);

  return `<div class="kod">
<div class="kod-head">
<h2 class="kod-namn">${escapeHtml(visningsnamn(record))}</h2>
<span class="kod-status"><span class="dot${paused ? " dot--off" : ""}"></span>${
    escapeHtml(STATUS_TEXT[record.status])
  }</span>
</div>
<p class="aside" style="margin-top:0.45rem">${escapeHtml(SYFTEN[syfteOf(record)].namn)} · ${
    escapeHtml(meddelanden(record.msgCount))
  } · sedan ${escapeHtml(sedan)}</p>
<p class="kod-adress">${escapeHtml(address)}</p>
<div class="kod-actions">
<button class="btn btn--ghost btn--tiny" type="button" data-slug="${slug}"
  data-atgard="${paused ? "ateruppta" : "pausa"}">${paused ? "Återuppta" : "Pausa"}</button>
<button class="btn btn--ghost btn--tiny" type="button" data-slug="${slug}" data-atgard="oppna"
  data-hash="#syfte">Ändra syfte</button>
<a class="btn btn--ghost btn--tiny" href="/klar?kod=${slug}">Tryckfiler</a>
<button class="btn btn--ghost btn--tiny btn--danger" type="button" data-slug="${slug}"
  data-atgard="radera"
  data-bekrafta="Radera koden för alltid? Adressen slutar fungera direkt och kan inte återskapas.">
  Radera</button>
</div>
</div>`;
}

/**
 * A valid token was peeked, so this is the owner. Shows what the records actually say.
 *
 * One page for both kinds of link. An address link fills it with every code that address owns; a
 * code link fills it with one. The difference shows up in what is offered rather than in a second
 * template, because two templates is how two pages drift apart.
 */
export function renderKoder(view: KoderVy): Response {
  const { koder, baseUrl, token, epost, helaListan } = view;
  const flera = koder.length > 1;
  const kvar = MAX_CODES_PER_EMAIL - koder.length;
  const meddelandenTotalt = koder.reduce((sum, record) => sum + record.msgCount, 0);

  const spec = [
    epost === null
      ? ""
      : `<div class="spec"><dt>Mail</dt><span class="leader"></span><dd>${
        escapeHtml(epost)
      }</dd></div>`,
    helaListan
      ? `<div class="spec"><dt>Koder</dt><span class="leader"></span><dd>${koder.length} av ${MAX_CODES_PER_EMAIL}</dd></div>`
      : "",
    `<div class="spec"><dt>Meddelanden</dt><span class="leader"></span><dd>${meddelandenTotalt}</dd></div>`,
  ].filter(Boolean).join("\n");

  const skapa = helaListan
    ? `<div class="reveal stack stack-s">
${
      kvar > 0
        ? `<button class="btn" type="button" data-atgard="skapa">Skapa en till</button>
<p class="aside">
Din adress är redan verifierad, så en ny kod blir aktiv direkt. Inget mail, ingen länk att vänta
på. ${Rakneord(kvar)} kvar av ${rakneord(MAX_CODES_PER_EMAIL)}.
</p>`
        : `<p class="aside">
Du har ${rakneord(MAX_CODES_PER_EMAIL)} koder, vilket är så många vi tillåter per adress. Radera
en om du vill göra en ny.
</p>`
    }
</div>

<div class="reveal stack stack-s">
<button class="btn btn--ghost" type="button" data-visa="#byt">Byt mailadress</button>
<p class="aside">
Flyttar ${
      flera ? `alla ${rakneord(koder.length)} koderna` : "koden"
    }. Den nya adressen får bekräfta själv innan
något ändras, och den gamla får ett varsel.
</p>
</div>

<div class="reveal panel" id="byt">
<div class="stack stack-s">
<div class="field">
<label for="ny-epost">Ny mailadress</label>
<input class="input" id="ny-epost" name="epost" type="email" inputmode="email"
  autocomplete="email" placeholder="du@exempel.se" maxlength="254">
<p class="hint">
Vi mailar dit en länk. Inget byts förrän du klickar på den, och den gamla adressen får veta
att någon frågat.
</p>
</div>
<button class="btn" type="button" data-atgard="byt-epost" data-epost="#ny-epost">
  Skicka bekräftelse
</button>
</div>
</div>`
    : "";

  const body = shell(
    `<div class="stack stack-xl" id="atgarder">
<div class="reveal stack stack-l">
<p class="eyebrow">Hantera</p>
<h1 class="headline">${flera ? "Dina koder." : "Din kod."}</h1>
<p class="lede">
${
      flera
        ? `${Rakneord(koder.length)} stycken. `
        : ""
    }Namnet är texten du tryckte ovanför koden, så du känner igen dem på samma sätt som du gör i
verkligheten.
</p>
</div>

<div class="reveal">
<dl class="stack" style="--s:0">
${spec}
</dl>
</div>

<div class="reveal">
${koder.map((record) => kodRad(record, baseUrl)).join("\n")}
<p class="aside" id="fel" style="color:var(--accent);display:none"></p>
</div>

${skapa}

<div class="reveal">
<div class="notice">
Pausar du slutar den koden ta emot meddelanden direkt. Trycket fungerar fortfarande, och den som
skannar möts av ett vänligt nej. Raderar du är den koden borta på riktigt och adressen slutar
leda någonstans.
</div>
</div>
</div>`,
    `Länken gäller i 30 minuter. Varje åtgärd förnyar den, så du kan pausa en kod och radera en ` +
      `annan utan att gå tillbaka till inkorgen.<br>${siteFooter("hantera")}`,
  );

  return page({
    title: flera ? "Dina koder · Oj hej." : "Din kod · Oj hej.",
    body,
    script: `window.OJHEJ_T=${JSON.stringify(token)};`,
    noReferrer: true,
  });
}
