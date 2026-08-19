/**
 * The page shell every server-rendered page shares.
 *
 * These are real pages at real URLs, not mock files served by filename. The markup matches
 * the approved mocks in `mockups/`, which stay as the design reference the mocks-vs-reality
 * gate compares against.
 *
 * Everything interpolated here is escaped. Some of it (a slug in a URL, a message from a
 * stranger) is attacker-influenced, and a page is a worse place to get that wrong than an
 * email, because it executes in the visitor's browser on our origin.
 */

import { isValidSlug } from "../store/crypto.ts";
import { assetUrl } from "../assets.ts";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 7 7'%3E%3Crect width='7' height='1'/%3E%3Crect y='6' width='7' height='1'/%3E%3Crect width='1' height='7'/%3E%3Crect x='6' width='1' height='7'/%3E%3Crect x='2' y='2' width='3' height='3'/%3E%3C/svg%3E";

/** The finder pattern, which is both the brand mark and a hint at what the product is. */
export const MARK = `<svg class="mark mark--accent" viewBox="0 0 7 7" aria-hidden="true">
<rect x="0" y="0" width="7" height="1"/><rect x="0" y="6" width="7" height="1"/>
<rect x="0" y="0" width="1" height="7"/><rect x="6" y="0" width="1" height="7"/>
<rect x="2" y="2" width="3" height="3"/></svg>`;

/**
 * Where the reader is, for the footer navigation. `null` means a page a stranger reached by
 * scanning a garment, which gets no owner navigation at all.
 */
export type NavHere = "hem" | "skapa" | "hantera" | null;

/**
 * Two destinations, not three. Home is the mark and the name at the top of the footer, which is
 * where a reader looks for it anyway, and listing it again produced the site's name twice in
 * four centimetres.
 */
const NAV: { href: string; label: string; key: Exclude<NavHere, null> }[] = [
  { href: "/skapa", label: "Skapa en kod", key: "skapa" },
  // "Hantera koder" rather than "din kod": an address can hold ten of them now, and the
  // singular quietly told an owner with several that this was not the door to the rest.
  { href: "/hantera", label: "Hantera koder", key: "hantera" },
];

/**
 * The footer navigation, and the only navigation there is.
 *
 * Three destinations, because there are three: the pitch, the way in, and the way back in.
 * Everything else in this product is reached from a link in a mailbox and cannot be navigated
 * to, by design, so putting it in a menu would only offer people doors that do not open.
 *
 * The way back in is the point. `/hantera` without a token asks for an address and mails a
 * link, which is how somebody who printed a shirt months ago pauses it. Until this existed
 * nothing anywhere pointed at that page, so the only way to find it was to already know.
 *
 * The current page is marked rather than linked, which is what tells you where you are.
 */
export function siteNav(here: NavHere): string {
  // A stranger who scanned a garment gets the footer's brand link and nothing else.
  if (here === null) return "";

  return `<nav class="nav" aria-label="Sidor">${
    NAV.map(({ href, label, key }) =>
      key === here
        ? `<span class="nav-here" aria-current="page">${label}</span>`
        : `<a href="${href}">${label}</a>`
    ).join("")
  }</nav>`;
}

/**
 * The code the footer QR points at, or null for none.
 *
 * Set once at startup from `OJHEJ_KONTAKT_KOD`, the same shape as `setMailBaseUrl`, because
 * these render functions take no config and threading one through every page for a footer
 * decoration would be a poor trade.
 *
 * It is a real ojhej code owned by us. The plan always said Anders' own shirt is account number
 * one, and this is that: reaching us goes through the same form, the same relay and the same
 * daily cap as reaching anyone else. If the product is not good enough for our own contact
 * address it is not good enough.
 */
let contactCode: string | null = null;

export function setContactCode(slug: string | null): void {
  // A malformed value renders a broken image on every page, so it is dropped rather than shown.
  contactCode = slug && isValidSlug(slug) ? slug : null;
}

/**
 * The footer, on every page.
 *
 * The mark, the name, and one line saying what this is for.
 *
 * The line names the feeling rather than the user or the mechanic. The landing page already
 * says what the thing does; a brand line that repeats it is a wasted sentence. This one is the
 * reason somebody wants it, and the product is the answer to it.
 *
 * The line goes everywhere, including the pages a stranger reaches by scanning a garment,
 * because that reader is exactly who it is addressed to: somebody who just scanned a stranger's
 * garment, or a bag, or a dog's collar, and is deciding whether to say anything. The navigation
 * above it is owner-only, see `siteNav`.
 */
export function siteFooter(here: NavHere, slugHere: string | null = null): string {
  return `<div class="site-foot">
<a class="site-foot-brand" href="/">${MARK}<span class="site-foot-name">ojhej.se</span></a>
<p class="site-foot-line">Ett annat sätt att få kontakt.</p>
${contactQr(slugHere)}
${siteNav(here)}
</div>`;
}

/**
 * A small code that reaches us the same way a stranger reaches anyone else.
 *
 * Small on purpose: at 56px it is a mark rather than a feature, and it is not scannable at that
 * size. Enlarging is what makes it scannable, and enlarging is only useful on a device that is
 * not the one doing the scanning. So the two cases are split by pointer, in `app.js`: a mouse
 * opens the code big enough to photograph, a finger follows the link, because nobody can scan
 * their own phone screen.
 *
 * It is a link first and enhanced second. With no JavaScript at all, tapping it opens our page,
 * which is the useful thing rather than a dead control.
 *
 * `slugHere` is the code whose scan page this is, when it is one. On our own contact page that
 * link points at the page the reader is already standing on, so the whole control is dropped
 * rather than rendered as a tap that reloads. It hid behind the pointer split for as long as it
 * existed: a mouse never follows the link, because the dialog intercepts the click first, so the
 * only reader who ever met the dead link was the one on a phone, which is also the only reader
 * the link is there for. The dialog goes with it, since it offers the same destination twice.
 *
 * An `<img>` rather than inline SVG: this code is 40 KB of vector, fine as one cached request
 * and not fine inlined into every page on the site.
 *
 * The enlarged copy carries `data-src` rather than `src`, and `app.js` promotes it the first
 * time the dialog opens. It used to be a plain `src` with no `loading` attribute, which browsers
 * fetch at parse time even inside a closed `<dialog>`: that defeated the `loading="lazy"` on the
 * small one above, so the code was pulled on every page load. On a phone it was pulled for a
 * dialog that can never open, since the pointer split means a finger follows the link instead.
 * With this, the footer sits below a full-height hero and most phone loads never fetch it at all.
 */
function contactQr(slugHere: string | null): string {
  if (!contactCode || contactCode === slugHere) return "";

  const src = `/api/qr/${contactCode}.svg?mm=40`;

  return `<a class="site-foot-qr" href="/s/${contactCode}" data-qr-open>
<img src="${src}" width="56" height="56" loading="lazy" alt="">
<span>Säg hej till oss<br><span class="site-foot-qr-meta">Skanna eller tryck</span></span>
</a>

<dialog class="qr-dialog" id="qr-dialog">
<img data-src="${src}" width="260" height="260" alt="QR-kod till vår sida">
<p class="qr-dialog-text">Skanna med telefonen.</p>
<div class="qr-dialog-actions">
<a href="/s/${contactCode}">Öppna sidan i stället</a>
<button type="button" data-qr-close>Stäng</button>
</div>
</dialog>`;
}

export interface PageOptions {
  title: string;
  body: string;
  /** Extra page-specific script, already trusted (never built from user input). */
  script?: string;
  /** Sent on pages that carry a slug, so it cannot leak to a third party via Referer. */
  noReferrer?: boolean;
}

export function page({ title, body, script, noReferrer }: PageOptions): Response {
  const html = `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${FAVICON}">
${noReferrer ? '<meta name="referrer" content="no-referrer">' : ""}
<link rel="stylesheet" href="${assetUrl("fonts.css")}">
<link rel="stylesheet" href="${assetUrl("style.css")}">
<script src="${assetUrl("app.js")}" defer></script>
</head>
<body>
${body}
${script ? `<script>${script}</script>` : ""}
</body>
</html>`;

  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    // A slug in a URL should not travel to any third party that a page happens to embed.
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };

  return new Response(html, { headers });
}
