/**
 * The brand mark as standalone artwork.
 *
 * It is a QR finder pattern, which is the whole joke: the thing that makes a code findable,
 * used as the thing that makes us recognisable. The same shape appears inline on every page
 * (`MARK` in `pages/layout.ts`, sized for a text line) and in the centre of a large print.
 *
 * This module exists so a printer can be sent the mark on its own, at a stated physical size,
 * in either format. It shares the PDF writer with the codes rather than carrying its own, so
 * there is one place where "how a shape becomes a file" is decided.
 */

import type { QrLayout, Shape } from "./layout.ts";
import { serialisePdf } from "./pdf.ts";
import { serialiseSvg } from "./svg.ts";

/** Seven units square, matching the finder pattern it imitates. */
const UNITS = 7;

function shapes(): Shape[] {
  return [
    // The frame, drawn as one stroked square on its centre line rather than four bars, so it
    // stays a single path in both formats.
    { kind: "ring", x: 0.5, y: 0.5, w: 6, h: 6, radius: 0, stroke: 1 },
    { kind: "rect", x: 2, y: 2, w: 3, h: 3, radius: 0 },
  ];
}

export function markLayout(sizeMm: number, colour = "#000000"): QrLayout {
  return {
    url: "https://ojhej.se",
    shapes: shapes(),
    widthUnits: UNITS,
    heightUnits: UNITS,
    widthMm: sizeMm,
    heightMm: sizeMm,
    colour,
    applied: { mark: false, panel: false, ec: "Q", moduleMm: sizeMm / UNITS },
  };
}

export function markSvg(sizeMm: number, colour?: string): string {
  return serialiseSvg(markLayout(sizeMm, colour));
}

export function markPdf(sizeMm: number, colour?: string): Uint8Array {
  return serialisePdf(markLayout(sizeMm, colour));
}
