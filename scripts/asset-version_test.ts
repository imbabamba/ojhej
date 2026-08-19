import { assertEquals, assertNotEquals } from "@std/assert";
import { assetVersionOf, computeAssetVersion } from "./asset-version.ts";
import { ASSET_VERSION, VERSIONED_ASSETS } from "../src/assets.ts";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A reader over made-up content, so the hash can be tested without touching `public/`. */
function from(content: Record<string, string>): (name: string) => Promise<Uint8Array> {
  return (name) => Promise.resolve(bytes(content[name] ?? ""));
}

const LF = { "fonts.css": "a\nb\n", "style.css": "c\nd\n", "app.js": "e\nf\n" };
const CRLF = { "fonts.css": "a\r\nb\r\n", "style.css": "c\r\nd\r\n", "app.js": "e\r\nf\r\n" };

/**
 * The stamp must not depend on which machine computed it.
 *
 * This is the bug that shipped: `.gitattributes` stores LF and this checkout had CRLF, which git
 * calls clean because its own filter normalises them. Hashing the raw working-tree bytes turned
 * that invisible difference into a different stamp, so a Windows machine stamped one value, CI
 * hashed another, and `deno task verify` failed on a difference that changes nothing for a
 * browser. The `.gitattributes` comment in this repo warns about exactly this shape of failure:
 * it looks like the Windows machine is broken.
 *
 * LF is the canonical form. It is what git stores, what CI checks out, and what the deploy
 * uploads, so it is what the stamp is taken over.
 */
Deno.test("the stamp is the same whatever the line endings are", async () => {
  assertEquals(await assetVersionOf(from(CRLF)), await assetVersionOf(from(LF)));
});

/** It still has to be a hash of the contents, or it stamps nothing. */
Deno.test("the stamp changes when the bytes that matter change", async () => {
  const changed = { ...LF, "app.js": "e\nf\ng\n" };

  assertNotEquals(await assetVersionOf(from(LF)), await assetVersionOf(from(changed)));
});

/** Swapping two files' contents is a change, which is why the name is hashed beside the bytes. */
Deno.test("the stamp is bound to which file the bytes came from", async () => {
  const swapped = { ...LF, "fonts.css": LF["style.css"], "style.css": LF["fonts.css"] };

  assertNotEquals(await assetVersionOf(from(LF)), await assetVersionOf(from(swapped)));
});

/** The real thing, against the real files. Guards the same drift `layout_test.ts` checks. */
Deno.test("the stamped constant matches public/", async () => {
  assertEquals(ASSET_VERSION, await computeAssetVersion());
  assertEquals(VERSIONED_ASSETS.length, 3);
});
