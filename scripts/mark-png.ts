// deno-lint-ignore-file no-console -- a generator whose whole output is its console log

/**
 * Draw the mark as a PNG, for email.
 *
 * Every outgoing mail opens with this image. It cannot be the inline SVG the site uses, because
 * mail clients do not render SVG, and it cannot be a data URI, because several clients strip
 * those. So it is a real file at a real URL, served from the same Storage Zone as the rest of
 * the static site.
 *
 * The geometry is the finder pattern, the same seven-by-seven the favicon and `MARK` draw: a
 * one-unit frame with a three-unit core. Written out by hand rather than rasterised from the
 * SVG, because at this size hand-placing five rectangles is exact and a rasteriser is a
 * dependency.
 *
 * Run `deno task mark` if the mark or the accent colour ever changes. The output is committed.
 */

import { PNG } from "pngjs";

/** The brick accent, matching `--accent` in style.css and the mark on the site. */
const INK: [number, number, number] = [0xd8, 0x45, 0x2b];

/** Seven modules, at 32 pixels each. Displayed at 20px, so this survives any retina mail app. */
const MODULE = 32;
const UNITS = 7;
const SIZE = UNITS * MODULE;

/** Module coordinates that are inked: the frame, then the core. */
function isInked(x: number, y: number): boolean {
  const frame = x === 0 || y === 0 || x === UNITS - 1 || y === UNITS - 1;
  const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
  return frame || core;
}

/**
 * Two casts, both at the same seam: pngjs ships types that do not describe what it does under
 * Deno. `data` is always allocated by the constructor but typed nullable, and `sync` exists at
 * runtime but is absent from the declarations. Narrowed here rather than sprinkled through the
 * loop below.
 */
const png = new PNG({ width: SIZE, height: SIZE });
const pixels = png.data as unknown as Uint8Array;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const at = (y * SIZE + x) << 2;
    const inked = isInked(Math.floor(x / MODULE), Math.floor(y / MODULE));

    pixels[at] = INK[0];
    pixels[at + 1] = INK[1];
    pixels[at + 2] = INK[2];
    // Transparent everywhere else, so the mail's paper background shows through and a client
    // in dark mode does not get a white tile.
    pixels[at + 3] = inked ? 255 : 0;
  }
}

const bytes = (PNG as unknown as { sync: { write(png: unknown): Uint8Array } })
  .sync.write(png);
await Deno.writeFile("public/mark.png", bytes);

console.log(`public/mark.png  ${SIZE}x${SIZE}  ${Math.round(bytes.length / 1024)} KB`);
