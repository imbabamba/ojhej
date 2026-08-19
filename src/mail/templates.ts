/**
 * The three mails, ported from the approved mocks in mockups/mail/.
 *
 * Email-safe markup only: table layout, inline styles, web-safe fonts. Mail clients strip
 * external stylesheets and webfonts, so Georgia stands in for Instrument Serif and Helvetica
 * for Familjen Grotesk. Both a text and an HTML part are always produced, because HTML-only
 * mail lands in spam far more often.
 *
 * Four values in the message mail are typed by a stranger into a public form and then
 * rendered as HTML in the owner's mail client. That is the highest-value injection surface
 * in this product, so everything interpolated into HTML goes through `escapeHtml`, and the
 * contact link is *built* from a validated value rather than pasted in. The subject is
 * static: a subject assembled from visitor text is a header-injection risk for no benefit.
 */

import { normalizeEmail } from "./address.ts";
import { type SyfteKey, SYFTEN } from "../syfte.ts";
import type { CodeStatus } from "../store/shirts.ts";

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export type ContactChannel = "mail" | "instagram" | "telefon";

export interface MessageMailData {
  namn: string;
  var: string;
  meddelande: string;
  kanal: ContactChannel;
  kontakt: string;
  antalIdag: number;
  maxPerDag: number;
  slugKort: string;
  hanteraUrl: string;
}

/**
 * R14. Derived from the configured base URL rather than hardcoded, so a preview deploy does not
 * mail images pointing at production. Set once at startup because every template reads it and
 * threading it through each signature would be noise.
 */
let markUrl = "https://ojhej.se/mark.png";

/**
 * The site itself, for the one mail that has to point at a page rather than carry a token.
 *
 * Kept beside `markUrl` and set by the same call, so a preview deploy cannot mail an image from
 * one origin and a way home to another.
 */
let siteUrl = "https://ojhej.se";

export function setMailBaseUrl(baseUrl: string): void {
  siteUrl = baseUrl.replace(/\/+$/, "");
  markUrl = `${siteUrl}/mark.png`;
}

const INK = "#12100e";
const SOFT = "rgba(18,16,14,0.56)";
const FAINT = "rgba(18,16,14,0.34)";
const PAPER = "#f7f6f2";
const SUNK = "#efeee8";
const RULE = "rgba(18,16,14,0.14)";

const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "Helvetica,Arial,sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Turn a contact detail into a safe href, or null when it cannot be made into one.
 * Returning null is a normal outcome, not an error: the detail is then shown as plain
 * escaped text, which still tells the owner how to get in touch.
 */
export function contactHref(kanal: ContactChannel, kontakt: string): string | null {
  const value = kontakt.trim();

  if (kanal === "mail") {
    const address = normalizeEmail(value);
    return address ? `mailto:${address}` : null;
  }

  if (kanal === "instagram") {
    const handle = value.replace(/^@/, "");
    // Instagram's own rule: letters, digits, dots and underscores, up to 30.
    return /^[A-Za-z0-9._]{1,30}$/.test(handle) ? `https://instagram.com/${handle}` : null;
  }

  const digits = value.replace(/[\s-]/g, "");
  if (!/^\+?\d{6,15}$/.test(digits)) return null;
  // Swedish national form to E.164, so the link still works from abroad.
  const e164 = digits.startsWith("+")
    ? digits
    : digits.startsWith("0")
    ? `+46${digits.slice(1)}`
    : `+${digits}`;
  return `tel:${e164}`;
}

function shell(inner: string, preheader: string): string {
  return `<!doctype html>
<html lang="sv"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<style>
@media (prefers-color-scheme: dark){
.bg{background:#12100e!important}.card{background:#1a1815!important;border-color:#2e2b27!important}
.ink{color:#f2f0ea!important}.soft{color:rgba(242,240,234,.6)!important}
.faint{color:rgba(242,240,234,.42)!important}.rule{border-color:#2e2b27!important}
.btn td{background:#f2f0ea!important}.btn a{color:#12100e!important}}
@media only screen and (max-width:620px){.pad{padding-left:24px!important;padding-right:24px!important}
.h1{font-size:34px!important}}
</style></head>
<body class="bg" style="margin:0;padding:0;background:${PAPER}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${PAPER}">
<tr><td align="center" style="padding:40px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%">
<tr><td class="pad" style="padding:0 40px 28px">
<img src="${markUrl}" width="20" height="20" alt="ojhej.se" style="display:block;border:0"></td></tr>
${inner}
</table></td></tr></table></body></html>`;
}

function heading(title: string, lede: string): string {
  return `<tr><td class="pad" style="padding:0 40px 8px">
<h1 class="h1 ink" style="margin:0;font-family:${SERIF};font-size:42px;line-height:1.02;font-weight:400;letter-spacing:-.5px;color:${INK}">${
    escapeHtml(title)
  }</h1></td></tr>
<tr><td class="pad" style="padding:0 40px 32px">
<p class="soft" style="margin:0;font-family:${SANS};font-size:17px;line-height:1.45;color:${SOFT}">${
    escapeHtml(lede)
  }</p></td></tr>`;
}

function button(href: string, label: string): string {
  return `<tr><td class="pad" style="padding:0 40px 24px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn"><tr>
<td style="background:${INK}"><a href="${
    escapeHtml(href)
  }" style="display:inline-block;padding:18px 36px;font-family:${SANS};font-size:17px;font-weight:bold;color:${PAPER};text-decoration:none">${
    escapeHtml(label)
  }</a></td></tr></table></td></tr>`;
}

function fallbackLink(href: string): string {
  return `<tr><td class="pad" style="padding:0 40px">
<p class="faint" style="margin:0;font-family:${SANS};font-size:13px;line-height:1.5;color:${FAINT}">
Funkar inte knappen, klistra in den här adressen i webbläsaren:<br>
<span style="word-break:break-all">${escapeHtml(href)}</span></p></td></tr>`;
}

function footer(html: string): string {
  return `<tr><td class="pad" style="padding:40px 40px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="rule" style="border-top:1px solid ${RULE};padding-top:20px">${html}</td></tr></table></td></tr>`;
}

function field(label: string, value: string, serif = false): string {
  return `<tr><td style="padding:20px 28px 8px">
<p class="faint" style="margin:0 0 6px;font-family:${SANS};font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:${FAINT}">${
    escapeHtml(label)
  }</p>
<p class="ink" style="margin:0;font-family:${serif ? SERIF : SANS};font-size:${
    serif ? 19 : 17
  }px;line-height:1.5;color:${INK}">${escapeHtml(value)}</p></td></tr>`;
}

export function renderMessageMail(data: MessageMailData): RenderedMail {
  const href = contactHref(data.kanal, data.kontakt);
  const kanalNamn = { mail: "mail", instagram: "Instagram", telefon: "telefon" }[data.kanal];

  const contactHtml = href
    ? `<a href="${escapeHtml(href)}" class="ink" style="color:${INK};text-decoration:underline">${
      escapeHtml(data.kontakt)
    }</a>`
    : escapeHtml(data.kontakt);

  const inner = heading("Oj hej.", "Någon skannade din kod och skrev några rader.") +
    `<tr><td class="pad" style="padding:0 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="background:${SUNK};border:1px solid ${RULE}">
${field("Från", data.namn)}${field("Såg dig", data.var)}${
      field("Meddelande", data.meddelande, true)
    }</table></td></tr>` +
    `<tr><td class="pad" style="padding:32px 40px 0">
<p class="faint" style="margin:0 0 6px;font-family:${SANS};font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:${FAINT}">Vill nås via ${
      escapeHtml(kanalNamn)
    }</p>
<p style="margin:0;font-family:${SANS};font-size:19px">${contactHtml}</p></td></tr>` +
    `<tr><td class="pad" style="padding:24px 40px 0">
<p class="soft" style="margin:0;font-family:${SERIF};font-style:italic;font-size:17px;line-height:1.4;color:${SOFT}">Du bestämmer om du svarar. Gör du inget händer ingenting.</p></td></tr>` +
    footer(
      `<p class="faint" style="margin:0 0 8px;font-family:${SANS};font-size:13px;line-height:1.5;color:${FAINT}">Det här är meddelande ${data.antalIdag} av ${data.maxPerDag} idag på ${
        escapeHtml(data.slugKort)
      }. Vi sparar varken meddelandet eller avsändarens uppgifter.</p>
<p style="margin:0;font-family:${SANS};font-size:13px"><a href="${
        escapeHtml(data.hanteraUrl)
      }" class="faint" style="color:${FAINT};text-decoration:underline">Pausa eller radera din kod</a></p>`,
    );

  const text = `Oj hej.

Någon skannade din kod och skrev några rader.

FRÅN
${data.namn}

SÅG DIG
${data.var}

MEDDELANDE
${data.meddelande}

VILL NÅS VIA ${kanalNamn.toUpperCase()}
${data.kontakt}

Du bestämmer om du svarar. Gör du inget händer ingenting.

--
Det här är meddelande ${data.antalIdag} av ${data.maxPerDag} idag på ${data.slugKort}.
Vi sparar varken meddelandet eller avsändarens uppgifter.

Pausa eller radera din kod: ${data.hanteraUrl}
`;

  return {
    // Static on purpose. Visitor text in a subject line buys nothing and risks a header.
    subject: "Någon skannade din kod",
    text,
    html: shell(inner, `${data.namn} såg dig ${data.var} och skrev några rader.`),
  };
}

export function renderVerifyMail(data: { verifieraUrl: string }): RenderedMail {
  const inner = heading("Nästan igång.", "Ett klick så kan din kod ta emot meddelanden.") +
    button(data.verifieraUrl, "Aktivera koden") +
    fallbackLink(data.verifieraUrl) +
    footer(
      `<p class="faint" style="margin:0 0 8px;font-family:${SANS};font-size:13px;line-height:1.5;color:${FAINT}">Länken gäller i sju dagar och kan bara användas en gång. Har du inte bett om det här behöver du inte göra någonting: utan ett klick aktiveras ingenting, och koden raderar sig själv efter sju dagar.</p>
<p class="faint" style="margin:0;font-family:${SANS};font-size:13px;line-height:1.5;color:${FAINT}">Hittar du inte tillbaka sedan: gå till <a href="${siteUrl}/hantera" class="faint" style="color:${FAINT};text-decoration:underline">Hantera koder</a> och be om en ny länk till den här adressen. Spara gärna det här mailet.</p>`,
    );

  return {
    subject: "Aktivera din kod",
    text: `Nästan igång.

Ett klick så kan din kod ta emot meddelanden:

${data.verifieraUrl}

--
Länken gäller i sju dagar och kan bara användas en gång.
Har du inte bett om det här behöver du inte göra någonting: utan ett klick
aktiveras ingenting, och koden raderar sig själv efter sju dagar.

Hittar du inte tillbaka sedan: gå till Hantera koder och be om en ny länk
till den här adressen. Spara gärna det här mailet.
${siteUrl}/hantera
`,
    html: shell(inner, "Ett klick så är din kod igång."),
  };
}

/** How many, said the way a person would. The cap is ten, so the table stops there. */
const RAKNEORD = ["noll", "en", "två", "tre", "fyra", "fem", "sex", "sju", "åtta", "nio", "tio"];

const STATUS_ORD: Record<CodeStatus, string> = {
  pending: "inte aktiverad",
  active: "aktiv",
  paused: "pausad",
};

export interface KoderMailCode {
  /** The printed label, or the stand-in for a code printed with nothing above it. */
  namn: string;
  syfte: SyfteKey;
  status: CodeStatus;
}

/**
 * One mail for every code on an address, from `mockups/mail/04-hantera-flera.html`.
 *
 * It replaced a shape that minted a token per code and sent a mail per code, which is three
 * identical mails at three codes and unusable at eight. The token behind the button names the
 * address, so a code created after the link was minted still appears behind it.
 *
 * The codes are listed so the recipient can tell this is theirs before clicking, and the list
 * names printed labels and never addresses. This is the mail most likely to be forwarded to
 * somebody helping, and a slug in it is a working address for a code that is not theirs.
 */
export function renderKoderMail(
  data: { hanteraUrl: string; koder: KoderMailCode[] },
): RenderedMail {
  const antal = data.koder.length;
  const flera = antal > 1;
  const vilka = antal === 1 ? "din kod" : antal === 2 ? "båda" : `alla ${RAKNEORD[antal] ?? antal}`;
  const lede = `En länk till ${vilka}. Pausa, ändra syfte, hämta tryckfiler eller radera.`;

  const rader = data.koder.map((kod, index) => {
    const sist = index === data.koder.length - 1;
    return `<tr><td class="rule" style="border-top:1px solid ${RULE};${
      sist ? `border-bottom:1px solid ${RULE};` : ""
    }padding:12px 0">
<span class="ink" style="font-family:${SERIF};font-size:19px;color:${INK}">${
      escapeHtml(kod.namn)
    }</span>
<span class="faint" style="font-family:${SANS};font-size:13px;color:${FAINT}">&nbsp;· ${
      escapeHtml(SYFTEN[kod.syfte].namn)
    } · ${escapeHtml(STATUS_ORD[kod.status])}</span></td></tr>`;
  }).join("\n");

  const inner = heading("Här är nyckeln.", lede) +
    `<tr><td class="pad" style="padding:0 40px 32px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rader}
</table></td></tr>` +
    button(data.hanteraUrl, flera ? "Öppna dina koder" : "Öppna din kod") +
    fallbackLink(data.hanteraUrl) +
    footer(
      `<p class="faint" style="margin:0;font-family:${SANS};font-size:13px;line-height:1.5;color:${FAINT}">Länken gäller i 30 minuter. Bad du inte om den kan du strunta i det här mailet. Ingen kommer åt ${
        flera ? "dina koder" : "din kod"
      } utan länken, och den finns bara i din inkorg.</p>`,
    );

  const lista = data.koder
    .map((kod) => `- ${kod.namn} · ${SYFTEN[kod.syfte].namn} · ${STATUS_ORD[kod.status]}`)
    .join("\n");

  return {
    subject: flera ? "Dina koder" : "Din kod",
    text: `Här är nyckeln.

${lede}

${lista}

${data.hanteraUrl}

--
Länken gäller i 30 minuter. Bad du inte om den kan du strunta i det här
mailet. Ingen kommer åt ${flera ? "dina koder" : "din kod"} utan länken, och den
finns bara i din inkorg.
`,
    html: shell(inner, `Giltig i 30 minuter. Gäller ${flera ? "alla dina koder" : "din kod"}.`),
  };
}

/**
 * To the new address: prove you can read this before anything moves.
 *
 * The one link in the flow that a stranger must never be able to make useful. It goes only to
 * the address being proposed, so confirming it proves the person asking can read mail there.
 */
export function renderEmailChangeMail(
  data: { bekraftaUrl: string; flera?: boolean },
): RenderedMail {
  // The change moves every code on the address, so the mail has to say which it is talking
  // about. "Vi flyttar koden hit" to somebody with four of them is a promise about the wrong
  // number of things.
  const vad = data.flera ? "koderna" : "koden";
  const inner = heading("Är det här din adress?", `Bekräfta så flyttar vi ${vad} hit.`) +
    button(data.bekraftaUrl, "Bekräfta adressen") +
    fallbackLink(data.bekraftaUrl) +
    footer(
      `<p class="faint" style="margin:0;font-family:${SANS};font-size:13px;line-height:1.5;color:${FAINT}">Länken gäller i en timme och kan bara användas en gång. Tills du klickar går allt till den gamla adressen. Har du inte bett om det här ska du strunta i mailet, och då händer ingenting.</p>`,
    );

  return {
    subject: "Bekräfta din nya mailadress",
    text: `Är det här din adress?

Bekräfta så flyttar vi ${vad} hit:

${data.bekraftaUrl}

--
Länken gäller i en timme och kan bara användas en gång.
Tills du klickar går allt till den gamla adressen.
Har du inte bett om det här ska du strunta i mailet, och då händer ingenting.
`,
    html: shell(inner, `Bekräfta så flyttar vi ${vad} hit.`),
  };
}

/**
 * To the old address: a heads-up that costs nothing and catches everything.
 *
 * If someone gets into an inbox and moves a code to an address of their own, this is the only
 * mail the real owner would ever see about it. It carries no link and no action, because the
 * whole point is that it stays useful even when the recipient is the person being attacked.
 */
export function renderEmailChangeNoticeMail(
  data: { nyAdress: string; flera?: boolean },
): RenderedMail {
  const rubrik = data.flera ? "Någon vill flytta dina koder." : "Någon vill flytta din kod.";
  const rad = data.flera ? "radera koderna" : "radera koden";
  const inner = heading(rubrik, "En begäran om att byta adress har kommit in.") +
    field("Ny adress", data.nyAdress) +
    footer(
      `<p class="faint" style="margin:0;font-family:${SANS};font-size:13px;line-height:1.5;color:${FAINT}">Ingenting har hänt än. Bytet sker först när den nya adressen bekräftas, och då slutar den här adressen ta emot meddelanden. Var det inte du: begär en hantera-länk och ${rad}, så blir begäran värdelös.</p>`,
    );

  return {
    subject: data.flera ? "Någon vill flytta dina koder" : "Någon vill flytta din kod",
    text: `${rubrik}

En begäran om att byta adress har kommit in.

Ny adress: ${data.nyAdress}

--
Ingenting har hänt än. Bytet sker först när den nya adressen bekräftas,
och då slutar den här adressen ta emot meddelanden.
Var det inte du: begär en hantera-länk och ${rad}, så blir
begäran värdelös.
`,
    html: shell(inner, "Ingenting har hänt än."),
  };
}
