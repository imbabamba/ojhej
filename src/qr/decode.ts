/**
 * Read a layout back the way a scanner would.
 *
 * Tooling and tests only. Nothing the server serves imports this, and it must stay that way:
 * it pulls in a decoder that has no business on a request path.
 *
 * It exists because "the encoder is correct" and "the artwork we hand a print shop is correct"
 * are different claims. An encoder test cannot catch a wrong offset, a swapped axis, or a quiet
 * zone eaten by the label band. This rebuilds the module grid from the geometry that will
 * actually be printed and decodes that, which is the only way to check the second claim.
 *
 * Kept in one place because it was briefly in three, and three copies of a verification routine
 * is how a project ends up with two that agree and one that quietly does not.
 */

import jsQRImport from "jsqr";
import type { QrLayout } from "./layout.ts";

const jsQR = ((jsQRImport as unknown as { default?: unknown }).default ?? jsQRImport) as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

/** Enough pixels per module for the decoder to lock on, without making a large image. */
const SCALE = 4;

export function layoutToGrid(layout: QrLayout): boolean[][] {
  const across = layout.widthUnits;
  // A label band sits above the code, so the code starts lower than the origin.
  const offsetY = layout.heightUnits - across;
  const grid: boolean[][] = Array.from({ length: across }, () => new Array(across).fill(false));

  const paint = (x: number, y: number) => {
    const row = Math.round(y - offsetY);
    const col = Math.round(x);
    if (grid[row] && col >= 0 && col < across) grid[row]![col] = true;
  };

  for (const shape of layout.shapes) {
    switch (shape.kind) {
      case "rect": {
        // The explicit garment background is not a QR module. Painting it into this logical
        // matrix would fill the grid solid and decode as nothing at all.
        if (shape.fill) break;
        for (let y = Math.round(shape.y); y < Math.round(shape.y + shape.h); y++) {
          for (let x = Math.round(shape.x); x < Math.round(shape.x + shape.w); x++) paint(x, y);
        }
        break;
      }
      case "ring": {
        // A stroked square: fill the border it paints, leaving the middle clear.
        const half = shape.stroke / 2;
        const x0 = Math.round(shape.x - half);
        const y0 = Math.round(shape.y - half);
        const x1 = Math.round(shape.x + shape.w + half);
        const y1 = Math.round(shape.y + shape.h + half);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const border = y < y0 + shape.stroke || y >= y1 - shape.stroke ||
              x < x0 + shape.stroke || x >= x1 - shape.stroke;
            if (border) paint(x, y);
          }
        }
        break;
      }
      case "text":
        // Sits in the label band, outside the code entirely.
        break;
    }
  }

  return grid;
}

/** What a scanner would read off this artwork, or null if it could not read anything. */
export function decodeLayout(layout: QrLayout): string | null {
  const grid = layoutToGrid(layout);
  const across = grid.length;
  const size = across * SCALE;
  const inverted = layout.applied.panel;

  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  if (inverted) {
    // Reproduce the real dark-garment polarity: black field, opaque white modules. This makes
    // the test exercise inversion support rather than silently checking a conventional black
    // code built from the same geometry.
    for (let at = 0; at < pixels.length; at += 4) {
      pixels[at] = 0;
      pixels[at + 1] = 0;
      pixels[at + 2] = 0;
      pixels[at + 3] = 255;
    }
  }
  for (let y = 0; y < across; y++) {
    for (let x = 0; x < across; x++) {
      if (!grid[y]![x]) continue;
      for (let a = 0; a < SCALE; a++) {
        for (let b = 0; b < SCALE; b++) {
          const at = ((y * SCALE + a) * size + (x * SCALE + b)) * 4;
          pixels[at] = inverted ? 255 : 0;
          pixels[at + 1] = inverted ? 255 : 0;
          pixels[at + 2] = inverted ? 255 : 0;
        }
      }
    }
  }

  return jsQR(pixels, size, size)?.data ?? null;
}
