/**
 * Where every mark on a printed code goes, in module units, independent of file format.
 *
 * This exists so SVG and PDF cannot drift apart. The plan called for one encoder shared between
 * the self-serve download and the print pack precisely so the thing a customer downloads and the
 * thing we send a printer can never be different codes. Two renderers reading one layout makes
 * that structural rather than a promise: a change to the quiet zone, the label band or the
 * centre mark lands in both outputs or neither.
 *
 * Units are modules. The origin is the top left of the quiet zone. A serialiser scales to
 * millimetres and flips the Y axis if its format wants one.
 */

import { type EcLevel, encodeQr, type QrCode } from "./encode.ts";

export interface QrOptions {
  /** Physical width of the finished square, including the quiet zone. */
  sizeMm: number;
  /** One ink for the code and the wordmark, so the print stays single colour. */
  colour?: string;
  /** Uppercase text above the code. Dropped on small prints, where there is no room. */
  label?: string;
  /** The brand mark in the centre. Forces error correction H. */
  mark?: boolean;
  /**
   * Print the code inside a light panel instead of straight onto the garment.
   *
   * This is how a dark garment is served, and it is not the obvious answer. The obvious answer
   * is white ink, and it is wrong: inverted codes are read by only about 80 to 90 percent of
   * scanners, and recent iPhones re-invert the image before decoding, so testing one on your
   * own phone tells you nothing about everyone else's. A dark code on a light panel is read by
   * everything. See specs/ojhej/research-2026-08-12-qr-print.md.
   */
  panel?: boolean;
}

/** A filled rectangle, optionally with rounded corners. */
export interface RectShape {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  /** Overrides the layout ink. Only the panel uses this, and only ever to paint light. */
  fill?: string;
}

/** A stroked rectangle, drawn on its centre line the way both formats stroke. */
export interface RingShape {
  kind: "ring";
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  stroke: number;
}

/** Centred, uppercase, in whatever grotesque the format has to hand. */
export interface TextShape {
  kind: "text";
  cx: number;
  baseline: number;
  size: number;
  letterSpacing: number;
  value: string;
  /** Overrides the layout ink. Set when the label sits on the garment rather than the panel. */
  fill?: string;
}

export type Shape = RectShape | RingShape | TextShape;

export interface QrLayout {
  url: string;
  shapes: Shape[];
  /** Width and height of the whole artwork, in modules. */
  widthUnits: number;
  heightUnits: number;
  widthMm: number;
  heightMm: number;
  colour: string;
  /** What was actually used, which is not always what was asked for. */
  applied: { mark: boolean; panel: boolean; ec: EcLevel; moduleMm: number };
}

/** Below this, a print is too small to carry a label band as well as a code. */
export const PLAIN_BELOW_MM = 100;

/** Four modules of clear space, which is what a scanner needs to find the code at all. */
export const QUIET = 4;

/**
 * Two further modules of panel beyond the quiet zone, when a panel is used.
 *
 * Fabric edges are mangled by the weave, so a panel that stops exactly at the quiet zone
 * loses part of the quiet zone to a frayed edge. The extra two modules are the margin for
 * that. Also from the print research.
 */
export const PANEL_EXTRA = 2;

/** What the panel and, on a panelled print, the label are painted in. */
export const PANEL_FILL = "#ffffff";

/** What the text above the code says unless someone changes it. */
export const DEFAULT_LABEL = "DEJTA";

/** The longest label the band can carry before it starts shrinking the code. */
export const MAX_LABEL = 14;

function isFinder(code: QrCode, row: number, col: number): boolean {
  const n = code.size;
  return (row < 7 && col < 7) ||
    (row < 7 && col >= n - 7) ||
    (row >= n - 7 && col < 7);
}

/**
 * One frame plus one core.
 *
 * There used to be rounded and dotted variants of all of this. They were removed: a QR code is
 * a machine-readable thing first, styling it trades scan reliability for decoration, and the
 * decoration is not what anybody is here for. Plain squares are also what survives fabric.
 */
function finder(x: number, y: number, unit: number): Shape[] {
  return [
    {
      kind: "ring",
      x: x + unit * 0.5,
      y: y + unit * 0.5,
      w: unit * 6,
      h: unit * 6,
      radius: 0,
      stroke: unit,
    },
    { kind: "rect", x: x + unit * 2, y: y + unit * 2, w: unit * 3, h: unit * 3, radius: 0 },
  ];
}

function module(x: number, y: number, unit: number): Shape {
  // A hairline overlap, so neighbouring squares do not show seams when printed.
  const side = unit + unit * 0.02;
  return { kind: "rect", x, y, w: side, h: side, radius: 0 };
}

export function layoutQr(url: string, options: QrOptions): QrLayout {
  // Small prints carry no label and no centre mark. Decided here rather than at the call site,
  // so a caller cannot accidentally order an unscannable chest print.
  const small = options.sizeMm < PLAIN_BELOW_MM;
  const mark = small ? false : Boolean(options.mark);
  const label = small ? "" : (options.label ?? "").trim().toUpperCase();
  const panel = Boolean(options.panel);

  // Level H throughout, not just when the centre mark needs the headroom.
  //
  // A garment is heavy use by any reading, and the print research recommends H for exactly that.
  // What settles it is that it costs nothing: measured for our URL, H needs the same 33 modules
  // as Q, so the module size is unchanged and the redundancy goes from 25 to 30 percent for
  // free. That redundancy is what buys wash cycles, and a dark garment loses contrast about
  // twice as fast as a light one. See research-2026-08-13-dark-garments.md.
  //
  // A longer base URL could push H into a larger version and shrink the modules. The print pack
  // checks the 0.4 mm floor before it writes anything, so that would surface as a refusal rather
  // than as a code nobody can scan.
  const ec: EcLevel = "H";
  const code = encodeQr(url, ec);

  // A panel adds margin on every side, so the artwork grows and the code shifts inward. The
  // quiet zone is unchanged: the extra is panel *beyond* it, not quiet zone taken from it.
  const pad = panel ? PANEL_EXTRA : 0;
  const quiet = QUIET + pad;
  const across = code.size + quiet * 2;
  const labelBand = label ? across * 0.22 : 0;
  const totalHeight = across + labelBand;

  const unit = 1;
  const shapes: Shape[] = [];

  if (panel) {
    // Only the code sits on the panel. The label stays on the fabric above it, because a panel
    // big enough to hold both reads as a sticker stuck on a shirt rather than a print, and the
    // research is explicit that the text "never has to sit inside the panel and steal quiet
    // zone". Painted first so everything else lands on top of it.
    shapes.push({
      kind: "rect",
      x: 0,
      y: labelBand,
      w: across,
      h: across,
      radius: 0,
      fill: PANEL_FILL,
    });
  }

  const centreLo = Math.floor((code.size - 7) / 2);
  const centreHi = centreLo + 6;
  const inMark = (row: number, col: number) =>
    mark && row >= centreLo && row <= centreHi && col >= centreLo && col <= centreHi;

  for (let row = 0; row < code.size; row++) {
    for (let col = 0; col < code.size; col++) {
      if (isFinder(code, row, col) || inMark(row, col)) continue;
      if (!code.modules[row]![col]) continue;
      shapes.push(module(col + quiet, row + quiet + labelBand, unit));
    }
  }

  shapes.push(...finder(quiet, quiet + labelBand, unit));
  shapes.push(...finder(quiet + code.size - 7, quiet + labelBand, unit));
  shapes.push(...finder(quiet, quiet + code.size - 7 + labelBand, unit));

  if (mark) {
    // Deliberately not the 1:1:3:1:1 ratio of a real finder, so a decoder cannot mistake it
    // for a fourth one. Covers about 11% against level H's 25% practical ceiling.
    const size = 5;
    const x = quiet + centreLo + 1;
    const y = quiet + centreLo + 1 + labelBand;
    const thickness = size * 0.22;

    shapes.push({
      kind: "ring",
      x: x + thickness / 2,
      y: y + thickness / 2,
      w: size - thickness,
      h: size - thickness,
      radius: 0,
      stroke: thickness,
    });
    shapes.push({
      kind: "rect",
      x: x + size * 0.36,
      y: y + size * 0.36,
      w: size * 0.28,
      h: size * 0.28,
      radius: 0,
    });
  }

  if (label) {
    shapes.push({
      kind: "text",
      cx: across / 2,
      baseline: labelBand * 0.78,
      size: labelBand * 0.72,
      letterSpacing: labelBand * 0.03,
      value: label,
      // On a panelled print the text lands on dark fabric, so it is printed in the panel
      // colour rather than the ink. Two colours in one file, which is what a garment printer
      // expects: light for the panel and the word, dark for the code.
      ...(panel ? { fill: PANEL_FILL } : {}),
    });
  }

  return {
    url,
    shapes,
    widthUnits: across,
    heightUnits: totalHeight,
    widthMm: options.sizeMm,
    heightMm: (options.sizeMm / across) * totalHeight,
    colour: options.colour ?? "#000000",
    applied: { mark, panel, ec, moduleMm: options.sizeMm / across },
  };
}
