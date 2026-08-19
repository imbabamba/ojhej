// deno-lint-ignore-file no-console -- a build step whose entire output is its console log

/**
 * Stamp `ASSET_VERSION` with a hash of the files it stands for.
 *
 * The pull zone gives `style.css`, `fonts.css` and `app.js` a nine-and-a-half-month browser
 * cache and the HTML naming them is `no-store`, so an unversioned URL ships new markup against
 * an old script for the rest of the year. See `src/assets.ts` for the day that cost us.
 *
 * Run it after changing anything in `public/`, before deploying:
 *
 *   deno task asset-version           # rewrite the constant
 *   deno task asset-version --check   # say whether it is current, change nothing
 *
 * Nobody has to remember: `layout_test.ts` recomputes the hash and fails when the stamp and the
 * files disagree, so a forgotten run is a failed `deno task verify` rather than a silent deploy
 * of assets no browser will fetch.
 */

import { VERSIONED_ASSETS } from "../src/assets.ts";

const CONSTANT = /^export const ASSET_VERSION = "[0-9a-f]*";$/m;
const SOURCE = "src/assets.ts";

/**
 * CRLF is not a change, so it must not be a new stamp.
 *
 * `.gitattributes` stores LF and checks out LF, and git's own filter treats a CRLF working tree
 * as clean, which means the difference is invisible to `git status` and to a person. Hashing raw
 * bytes made it visible in the worst place: a Windows checkout stamped one value, CI hashed
 * another, and verify failed on a difference no browser can see. LF is the canonical form here,
 * it is what CI checks out and what `upload-assets` sends, so it is what gets hashed.
 */
function toLf(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (let at = 0; at < bytes.length; at++) {
    // A CR is dropped only when it is the LF's own, so a lone CR in a file survives as content.
    if (bytes[at] === 0x0d && bytes[at + 1] === 0x0a) continue;
    out[length++] = bytes[at]!;
  }
  return out.subarray(0, length);
}

/**
 * One stamp for all three files rather than one each.
 *
 * Changing `app.js` therefore also refetches two stylesheets, which is a few kilobytes on a
 * deploy. Per-file stamps would save that and cost a generated table plus the question of which
 * file a given page needs, for an asset budget already smaller than the fonts that are not
 * versioned at all.
 *
 * The name goes into the hash beside the bytes, so swapping two files' contents is a change.
 *
 * Takes a reader rather than a directory so the smoke test can hand it what the CDN actually
 * served and get a number comparable to this one. Two implementations of this hash would be two
 * things to keep in step, and the whole point of the check is that they agree.
 */
export async function assetVersionOf(
  read: (name: string) => Promise<Uint8Array>,
): Promise<string> {
  const parts: Uint8Array[] = [];

  for (const name of VERSIONED_ASSETS) {
    parts.push(new TextEncoder().encode(`${name}\n`));
    parts.push(toLf(await read(name)));
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }

  const digest = await crypto.subtle.digest("SHA-256", joined);
  // Sixteen hex characters. This is a cache key, not a signature: it has to change when the
  // bytes change, and nobody is attacking it by finding a collision with their own stylesheet.
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** The stamp for the files on disk. */
export function computeAssetVersion(root = "public"): Promise<string> {
  return assetVersionOf((name) => Deno.readFile(`${root}/${name}`));
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  const version = await computeAssetVersion();
  const source = await Deno.readTextFile(SOURCE);

  const current = source.match(/^export const ASSET_VERSION = "([0-9a-f]*)";$/m)?.[1];
  if (current === undefined) {
    throw new Error(`could not find the ASSET_VERSION constant in ${SOURCE}`);
  }

  if (current === version) {
    console.log(`asset version is current: ${version}`);
    Deno.exit(0);
  }

  if (check) {
    console.error(`asset version is stale: stamped ${current}, files hash to ${version}`);
    console.error(`run \`deno task asset-version\``);
    Deno.exit(1);
  }

  await Deno.writeTextFile(
    SOURCE,
    source.replace(CONSTANT, `export const ASSET_VERSION = "${version}";`),
  );
  console.log(`asset version ${current} -> ${version}`);
}
