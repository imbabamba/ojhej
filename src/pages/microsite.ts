/**
 * GET /s/<slug>, the page a stranger reaches by scanning.
 *
 * Rendered from the real record, so it shows the truth about that code rather than a fixed
 * design. Four states, and the differences between them are deliberate:
 *
 *   active    the form
 *   pending   says plainly it is not activated yet. The owner already printed this address
 *             on something they carry, so there is nothing to hide, and the message saves
 *             them wondering why nothing arrives.
 *   paused    a friendly no
 *   unknown   identical to a deleted code, so nobody can probe whether a code ever existed
 *
 * Nothing on this page ever names the owner. No address, no name, no identifier. The only
 * thing a visitor learns is that the code exists.
 */

import { escapeHtml, MARK, page, siteFooter } from "./layout.ts";
import { radFor } from "../syfte.ts";
import { MAX_ANSWER, surveyOf } from "../survey.ts";
import type { CodeRecord } from "../store/shirts.ts";

/*
 * No owner navigation here, deliberately.
 *
 * Everything under this footer was reached by scanning a garment. That reader is not managing
 * a code and may never have heard of the service; offering them "Hantera koder" is noise, and
 * it frames a stranger's first contact as an account screen. A quiet way to the pitch is all
 * that belongs.
 */
/*
 * A function, not a constant.
 *
 * As a module-level constant this was evaluated at import time, which happens before the
 * entrypoint calls `setContactCode`, so the footer here was baked with whatever the value was
 * at load: nothing. The scan pages would have silently lacked the contact code forever, in
 * production only, where nobody would think to look.
 */
function foot(slugHere: string | null): string {
  return `<div class="wrap pad-bottom"><div class="foot">${siteFooter(null, slugHere)}</div></div>`;
}

/**
 * `slugHere` is the code this page is about, where there is one.
 *
 * It exists so the footer can tell whether its own contact code is the page being rendered.
 * Our contact code is a real code with a real scan page, and on that one page the footer's
 * "say hej to us" pointed at itself. The states with no slug to name pass null: an unknown code
 * is deliberately told nothing, and the sent page belongs to no code by then.
 */
function shell(inner: string, slugHere: string | null = null): string {
  return `<div class="screen">
<div class="wrap pad-top grow" style="display:flex;flex-direction:column;justify-content:center">
${inner}
</div>
${foot(slugHere)}
</div>`;
}

/** The states where there is nothing to say but a sentence. */
function statement(
  title: string,
  lede: string,
  dry?: string,
  slugHere: string | null = null,
): string {
  return shell(
    `<div class="stack stack-xl">
<div class="reveal">${MARK}</div>
<div class="reveal stack stack-l">
<h1 class="statement">${escapeHtml(title)}</h1>
<p class="lede">${escapeHtml(lede)}</p>
${dry ? `<p class="dry">${escapeHtml(dry)}</p>` : ""}
</div>
</div>`,
    slugHere,
  );
}

export function renderUnknown(): Response {
  // Byte-identical to a deleted code. Probing this endpoint must teach an attacker nothing.
  return page({
    title: "Oj hej.",
    body: statement(
      "Ingen kod här.",
      "Adressen finns inte. Kolla att kameran fick med hela koden och testa igen.",
    ),
  });
}

export function renderPending(slugHere: string | null = null): Response {
  return page({
    title: "Oj hej.",
    body: statement(
      "Nästan igång.",
      "Koden är skapad men inte aktiverad än. Meddelanden kan inte tas emot ännu.",
      undefined,
      slugHere,
    ),
  });
}

export function renderPaused(slugHere: string | null = null): Response {
  return page({
    title: "Oj hej.",
    body: statement(
      "Pausad.",
      "Den som står bakom koden tar en paus från hej just nu. Prova gärna en annan dag.",
      undefined,
      slugHere,
    ),
  });
}

export function renderCapped(): Response {
  return page({
    title: "Oj hej.",
    body: statement(
      "Fullt för idag.",
      "Koden har tagit emot ovanligt många meddelanden idag. Prova igen imorgon.",
    ),
  });
}

/**
 * The one that matters: statement first, form on tap.
 *
 * A code with a purpose swaps one line and drops one, which is variant A from
 * `mockups/14-syfte-varianter.html` and Anders' call on 2026-08-15.
 *
 * The page has three lines of core copy rather than one, and that is the whole reason the
 * variants were drawn. "Du skannade den faktiskt" and "Eller gå vidare. Ingen märker något" are
 * both written about a person you have just walked past. Replacing only the lede would leave the
 * dry line joking about a suitcase, so a purpose takes both. The brand moment above stays, and
 * the button stays "Säg hej", which fits every case: saying hej to someone who lost a bag is
 * exactly what a finder is doing.
 *
 * The `hej` preset carries an empty line on purpose, so the ordinary code renders byte for byte
 * what it rendered before purposes existed. Breadth costs nothing where it is not used.
 */
export function renderActive(record: CodeRecord): Response {
  const slug = escapeHtml(record.slug);
  const rad = radFor(record);
  const survey = surveyOf(record);

  // Escaped, and rendered as text rather than as anything clickable. An owner's line that could
  // become a working link would make this page a place to publish one, and a stranger who
  // scanned a jacket should not be one tap from an address nobody checked.
  const spoken = rad
    ? `<p class="lede">${escapeHtml(rad)}</p>`
    : `<p class="lede">Du skannade den faktiskt.</p>`;
  const dry = rad ? "" : `\n<p class="dry">Eller gå vidare. Ingen märker något.</p>`;

  const surveyFields = survey.mode === "survey"
    ? `<div class="survey-progress">
<p class="eyebrow">${survey.questions.length} frågor · ungefär 2 minuter</p>
<p class="aside">Svara som dig själv. Personen bakom koden får allt samlat i ett mail.</p>
</div>
${
      survey.questions.map((question, index) =>
        `<div class="field survey-answer">
<label class="survey-question" for="svar-${index + 1}"><span>${index + 1}</span>${
          escapeHtml(question)
        }</label>
<textarea class="textarea" id="svar-${index + 1}" rows="3" maxlength="${MAX_ANSWER}"
  data-survey-answer placeholder="Ditt svar" required></textarea>
</div>`
      ).join("\n")
    }`
    : `<div class="field">
<label for="var">Var såg du mig?</label>
<input class="input" id="var" name="var" type="text" maxlength="120"
  placeholder="Pendeltåget, kön till kaffet …" required>
</div>

<div class="field">
<label for="meddelande">Meddelande <span class="counter" id="count">0 / 600</span></label>
<textarea class="textarea" id="meddelande" name="meddelande" rows="4" maxlength="600"
  placeholder="Säg något. Vad som helst är bättre än ingenting." required></textarea>
</div>`;

  const action = survey.mode === "survey" ? "Svara på frågorna" : "Säg hej";
  const privacy = survey.mode === "survey"
    ? "Dina svar går direkt till personen bakom koden. Vi sparar varken svaren eller dina kontaktuppgifter."
    : `Meddelandet går direkt till personen bakom koden. Vi sparar det inte, och du får inte veta
  om hen läser det.`;

  const body = shell(
    `<div class="stack stack-xl">
<div class="reveal">${MARK}</div>

<div class="reveal stack stack-l">
<h1 class="statement">Oj&nbsp;hej.</h1>
${spoken}
</div>

<div class="reveal stack stack-s" id="cta">
<button class="btn" type="button" id="open">${action}</button>${dry}
</div>
</div>

<div class="panel" id="panel"><div>
<form class="stack stack-l" id="form" data-endpoint="/api/meddelande" data-next="/skickat${
      survey.mode === "survey" ? "?typ=enkat" : ""
    }" style="padding-top:3rem">
<hr class="rule">
<input type="hidden" name="slug" value="${slug}">

<div class="field">
<label for="namn">Vad heter du?</label>
<input class="input" id="namn" name="namn" type="text" autocomplete="given-name"
  placeholder="Förnamn räcker" maxlength="80" required>
</div>

${surveyFields}

<fieldset style="border:0;padding:0;margin:0">
<legend class="legend">Hur når jag dig?</legend>
<div class="seg">
<input type="radio" id="k-mail" name="kanal" value="mail" checked><label for="k-mail">Mail</label>
<input type="radio" id="k-insta" name="kanal" value="instagram"><label for="k-insta">Instagram</label>
<input type="radio" id="k-tel" name="kanal" value="telefon"><label for="k-tel">Telefon</label>
</div>
<input class="input" id="kontakt" name="kontakt" type="email" inputmode="email"
  autocomplete="email" maxlength="120"
  placeholder="du@exempel.se" required style="margin-top:1rem">
</fieldset>

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
<button class="btn" type="submit" id="skicka" disabled>Skicka</button>
<p class="aside" id="fel" style="color:var(--accent);display:none"></p>
<p class="aside">
  ${privacy}
</p>
</div>
</form>
</div></div>`,
    record.slug,
  );

  return page({
    title: "Oj hej.",
    body,
    script: `window.OJHEJ_SLUG=${JSON.stringify(record.slug)};`,
    noReferrer: true,
  });
}

export function renderSent(kind: "greeting" | "survey" = "greeting"): Response {
  const survey = kind === "survey";
  return page({
    title: "Skickat · Oj hej.",
    body: shell(`<div class="stack stack-xl">
<div class="reveal">${MARK}</div>
<div class="reveal stack stack-l">
<h1 class="statement">${survey ? "Svarat." : "Skickat."}</h1>
<p class="lede">${
      survey
        ? "Dina svar är på väg. Vill hen höra av sig gör hen det på sättet du angav."
        : "Meddelandet är på väg. Vill hen svara så hör hen av sig, på det sätt du angav."
    }</p>
<p class="dry">Nu ligger bollen inte längre hos dig.</p>
</div>
<div class="reveal"><p class="aside">
Vi sparar varken ${survey ? "svaren" : "meddelandet"} eller dina kontaktuppgifter. Det här är
enda gången sidan nämner det.
</p></div>
</div>`),
  });
}
