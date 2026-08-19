/**
 * GET /klar?kod=<slug>
 *
 * Where verification lands, and the only place the owner is handed their code.
 *
 * The slug arrives in a URL, so it is untrusted input: validated before use, escaped before
 * rendering, and looked up so the page tells the truth rather than echoing back whatever was
 * in the query string. The page also renders `?fel=lank` for a verification link that was
 * already used, expired, or never valid.
 *
 * The code shown here is real and scannable, rendered by `src/qr`. It is deliberately the
 * same endpoint the download uses, so what is on screen and what reaches a print shop cannot
 * drift apart. An earlier version of this page showed a convincing fake, which cost a real
 * scan attempt; the fix was to build the encoder, not to draw a better picture.
 */

import { MAX_LABEL } from "../qr/layout.ts";
import { escapeHtml, MARK, page, siteFooter } from "./layout.ts";
import { etikettFor, MAX_RAD, radFor, SYFTE_ORDER, SYFTEN, syfteOf } from "../syfte.ts";
import type { CodeRecord } from "../store/shirts.ts";

function shell(inner: string, foot: string): string {
  return `<div class="screen">
<div class="wrap pad-top grow">${inner}</div>
<div class="wrap pad-bottom"><div class="foot">${foot}</div></div>
</div>`;
}

/** A verification link that did not work. Deliberately says nothing about why. */
export function renderKlarFailed(): Response {
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

/**
 * The purpose picker, from `mockups/13-klar-syfte.html`.
 *
 * It sits above the print controls because it drives them: picking a purpose sets the text that
 * gets printed and the line a stranger reads, and the preview underneath shows the second one so
 * the choice is not made blind.
 *
 * Rendered only for a caller holding a token. The slug is printed on a chest in public, so a
 * page reachable with the slug alone must not be able to rewrite what a stranger reads.
 */
/** What the preview says when the purpose adds nothing, which is the ordinary case. */
const TOM = "Ingenting extra. Sidan ser ut precis som den gör idag.";

function picker(record: CodeRecord): string {
  const valt = syfteOf(record);
  const rad = radFor(record);
  const egen = valt === "eget" ? (record.rad ?? "") : "";

  // Each chip carries its own preset, so the client holds no second copy of the list. A copy
  // there would be another thing to reword, and the one that got forgotten would be the one a
  // stranger reads.
  const chips = SYFTE_ORDER.map((key) =>
    `<button class="chip" type="button" data-syfte="${key}" data-etikett="${
      escapeHtml(SYFTEN[key].etikett)
    }" data-rad="${escapeHtml(SYFTEN[key].rad)}" aria-pressed="${
      key === valt ? "true" : "false"
    }">${escapeHtml(SYFTEN[key].namn)}</button>`
  ).join("\n");

  return `<div class="field">
<span class="legend">Vad är koden till?</span>
<div class="chips" id="syfte">
${chips}
</div>
<p class="hint">
Styr två saker: texten på trycket, och raden den som skannar möts av. Går att ändra när du vill.
</p>
</div>

<div class="field" id="egetfalt"${valt === "eget" ? "" : " hidden"}>
<label for="egenrad">Din egen rad <span class="counter" id="radcount"></span></label>
<textarea class="textarea" id="egenrad" rows="2" maxlength="${MAX_RAD}"
  placeholder="En mening. Den som skannar läser den innan formuläret.">${
    escapeHtml(egen)
  }</textarea>
<p class="hint">
Raden visas som text och blir aldrig en länk. Vi ber dig hålla den kort av samma skäl: sidan ska
säga varför någon står där, inte bli en plats att publicera på.
</p>
</div>

<div class="forhands">
<p class="eyebrow">Så möts den som skannar</p>
<p class="rad${rad ? "" : " rad--tom"}" id="forhandsrad" data-tom="${escapeHtml(TOM)}">${
    escapeHtml(rad || TOM)
  }</p>
</div>`;
}

export function renderKlar(
  record: CodeRecord,
  baseUrl: string,
  /** A management link for this code, or null when the page was reached with the slug alone. */
  token: string | null,
): Response {
  const safe = escapeHtml(record.slug);
  const address = `${baseUrl.replace(/^https?:\/\//, "")}/s/${record.slug}`;
  const etikett = etikettFor(record);

  const body = shell(
    `<div class="stack stack-xl">
<div class="reveal stack stack-l">
<p class="eyebrow">Klart</p>
<h1 class="headline">Din kod<br>är klar.</h1>
<p class="lede">
Det här är din adress. Den går inte att gissa sig till, så ingen hittar den utan att se din kod.
</p>
</div>

<div class="reveal stack stack-s">
<div class="slug">
<code id="adress">${escapeHtml(address)}</code>
<button class="copy" type="button" data-copy="#adress">Kopiera</button>
</div>
</div>

<div class="reveal stack stack-s">
<div class="qr-frame" id="forhandsvisning">
<img id="preview" src="/api/qr/${safe}.svg?mm=180&amp;platta=nej&amp;text=${
      encodeURIComponent(etikett)
    }" alt="Din QR-kod" width="240" height="290">
</div>
<p class="aside">Skanna den med telefonen. Den leder hit, till din egen sida.</p>
</div>

<div class="reveal stack stack-l" id="designer">
${token === null ? "" : picker(record)}

<div class="field">
<label for="text">Text ovanför koden <span class="counter" id="count"></span></label>
<input class="input" id="text" type="text" maxlength="${MAX_LABEL}"
  value="${escapeHtml(etikett)}" autocomplete="off" spellcheck="false">
<p class="hint">Lämna tomt om du hellre vill ha bara koden.</p>
</div>

<div class="field">
<span class="legend">Vilken färg</span>
<div class="chips" id="underlag">
<button class="chip" type="button" data-platta="nej" aria-pressed="true">Bakgrund: vit</button>
<button class="chip" type="button" data-platta="ja" aria-pressed="false">Bakgrund: svart</button>
</div>
<p class="hint" id="underlagshint"></p>
</div>
${
      token === null ? "" : `
<div class="stack stack-s" id="spara">
<button class="btn" type="button" data-atgard="syfte">Spara</button>
<p class="aside" id="sparat" style="display:none">Sparat.</p>
<p class="aside" id="fel" style="color:var(--accent);display:none"></p>
</div>`
    }
</div>

<div class="reveal stack stack-s">
<p class="aside">Ladda ner och ta med till tryckeriet. SVG är originalet, PDF om de hellre vill ha det.</p>
<div id="downloads"></div>
</div>

<div class="reveal">
<div class="notice">
Spara inte den här sidan som ditt enda minne. Adressen finns på trycket, och en ny länk hit
begär du under <a href="/hantera">Hantera koder</a>, med mailadressen du skapade koden med.
</div>
</div>

</div>`,
    siteFooter("hem"),
  );

  return page({
    title: "Din kod är klar · Oj hej.",
    body,
    script: `window.OJHEJ_KOD=${JSON.stringify(record.slug)};` +
      (token === null ? "" : `window.OJHEJ_T=${JSON.stringify(token)};`),
    noReferrer: true,
  });
}
