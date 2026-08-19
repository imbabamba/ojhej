/**
 * The version stamped onto the asset URLs in every page.
 *
 * The CDN serves `style.css`, `fonts.css` and `app.js` straight from the Storage Zone with
 * `Cache-Control: max-age=25600000`, which is nine and a half months, while the HTML naming them
 * is `no-store`. Those two headers are both right on their own and a trap together: a returning
 * visitor gets today's markup and the script they downloaded the first time they came, for the
 * rest of the year.
 *
 * It is not a hypothetical. The purpose picker shipped, and for anybody who had visited before,
 * the chips rendered and did nothing: the markup was new, the `app.js` holding the chip handler
 * was months old, and there was no reason for any browser to ask for it again. It looked exactly
 * like a broken feature and was a cache doing precisely what it had been told.
 *
 * So the URL carries the contents. `?v=<hash>` changes when the files change, which is the whole
 * mechanism: a browser keys its cache on the full URL, so a new stamp is a new file to ask for,
 * and an unchanged stamp keeps the long cache that made these headers worth having.
 *
 * The fonts are deliberately not in here. They are content-addressed by family, style and subset
 * already, they are the only assets big enough for the cache to matter, and they change roughly
 * never.
 */

/** The assets whose URLs carry the stamp. Everything else the CDN serves is versioned by name. */
export const VERSIONED_ASSETS = ["fonts.css", "style.css", "app.js"] as const;

/**
 * A hash of the contents of every file in `VERSIONED_ASSETS`.
 *
 * Generated, not written: `deno task asset-version` stamps it and a test fails the build when
 * `public/` has moved on without it. It is a constant because the edge isolate has no `public/`
 * to hash at startup, and a constant a person has to remember to bump is a constant that goes
 * stale on the change that mattered.
 */
export const ASSET_VERSION = "2b12243c5e9a081b";

/** The URL a page should ask for an asset by. */
export function assetUrl(name: string): string {
  return `/${name}?v=${ASSET_VERSION}`;
}

/**
 * The only paths the CDN is allowed to answer.
 *
 * The pull zone's origin is the Storage Zone, and this application writes `shirts/`, `tokens/`,
 * `emails/`, `altcha/`, `probe/` and `stats/` into that same zone, beside the files
 * `upload-assets` puts there. So "hand anything we do not recognise to the CDN" was not a
 * fall-through to a 404, it was a public unauthenticated read of every record the service holds.
 * Confirmed against production on 2026-08-19: `/shirts/<slug>.json` returned a whole record and
 * `/stats/koder.json` returned the counter, neither of which ever reached the edge script.
 *
 * An allowlist rather than a denylist of those six prefixes, for the same reason `serveAsset`
 * gives for not walking a directory: a denylist has to be updated by whoever adds the next
 * prefix, and the price of forgetting once is this bug again. This list is exactly what
 * `upload-assets` uploads.
 *
 * The real fix is two zones, so that a mistake here cannot expose anything at all. See
 * `specs/ojhej/deploy.md`. This is the part that does not need a dashboard.
 */
export const PUBLIC_ASSET =
  /^\/(?:style\.css|fonts\.css|app\.js|mark\.png|fonts\/[a-z0-9-]+\.woff2)$/;
