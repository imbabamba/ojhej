/**
 * PDF serialiser for a QR layout.
 *
 * Written by hand rather than pulled in as a dependency, because a QR code is rectangles and
 * one line of text. A PDF library would be several megabytes to emit a file this simple, and
 * this has to run on an edge runtime with no filesystem.
 *
 * It exists because print shops vary in what they accept. SVG is the better interchange format
 * and several will take it happily; PDF is the one nobody turns away, and finding that out at
 * the counter with a garment order waiting is a bad afternoon.
 *
 * The geometry comes from `layout.ts`, shared with the SVG writer, so the two formats cannot
 * describe different codes. This module only decides how those shapes are spelled in PDF.
 *
 * Two coordinate facts drive everything below. PDF measures in points, 72 to the inch, so
 * millimetres are scaled by 72/25.4. And its origin is the bottom left with Y increasing
 * upward, the opposite of the layout's top left, so every Y is flipped once on the way out.
 */

import { layoutQr, type QrLayout, type QrOptions } from "./layout.ts";

const PT_PER_MM = 72 / 25.4;

/**
 * Helvetica-Bold advance widths, in 1/1000 em, from the standard AFM metrics.
 *
 * Needed only to centre the label: PDF has no "text-anchor: middle", so the text is placed at a
 * measured offset. Restricted to what an uppercased label can actually contain. Anything absent
 * falls back to a middling width, which shifts centring by a hair rather than breaking the file.
 */
const WIDTHS: Record<string, number> = {
  " ": 278,
  "!": 333,
  '"': 474,
  "#": 556,
  $: 556,
  "%": 889,
  "&": 722,
  "'": 238,
  "(": 333,
  ")": 333,
  "*": 389,
  "+": 584,
  ",": 278,
  "-": 333,
  ".": 278,
  "/": 278,
  ":": 333,
  ";": 333,
  "<": 584,
  "=": 584,
  ">": 584,
  "?": 611,
  "@": 975,
  A: 722,
  B: 722,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 556,
  K: 722,
  L: 611,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  "Å": 722,
  "Ä": 722,
  "Ö": 778,
  "É": 667,
  "Ü": 722,
  "0": 556,
  "1": 556,
  "2": 556,
  "3": 556,
  "4": 556,
  "5": 556,
  "6": 556,
  "7": 556,
  "8": 556,
  "9": 556,
};

const FALLBACK_WIDTH = 600;

/**
 * WinAnsi is a single-byte encoding, so anything outside it has no representation in this font.
 * Dropped rather than substituted: a print carrying a row of question marks where someone's
 * word should be is worse than a print without the word.
 */
function encodeText(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code > 255) continue;
    // Escape the three characters that would otherwise end the string or the escape itself.
    if (char === "(" || char === ")" || char === "\\") out += "\\";
    out += char;
  }
  return out;
}

/** Width of a string at a given font size, in the same units as the size. */
function textWidth(value: string, size: number, letterSpacing: number): number {
  let width = 0;
  for (const char of value) {
    if (char.codePointAt(0)! > 255) continue;
    width += ((WIDTHS[char] ?? FALLBACK_WIDTH) / 1000) * size + letterSpacing;
  }
  // Letter spacing is applied after every glyph including the last, which is not part of the
  // visible run. Removing it is what keeps a spaced label optically centred rather than
  // sitting slightly left.
  return width - (value.length > 0 ? letterSpacing : 0);
}

function hexToRgb(colour: string): [number, number, number] {
  const hex = colour.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0, 0, 0];
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

const n = (value: number) => {
  const rounded = value.toFixed(4);
  // Trim trailing zeros so the content stream stays readable and small.
  return rounded.replace(/\.?0+$/, "") || "0";
};

/** Every shape here is a plain rectangle, so one operator covers the lot. */
function rectPath(x: number, y: number, w: number, h: number): string {
  return `${n(x)} ${n(y)} ${n(w)} ${n(h)} re`;
}

function contentStream(layout: QrLayout): string {
  // One module in points, and the page height, so the Y flip has something to flip about.
  const unit = (layout.widthMm * PT_PER_MM) / layout.widthUnits;
  const pageHeight = layout.heightUnits * unit;

  const [r, g, b] = hexToRgb(layout.colour);
  const ops: string[] = [`${n(r)} ${n(g)} ${n(b)} rg`, `${n(r)} ${n(g)} ${n(b)} RG`];

  /** Layout Y grows downward, PDF Y grows upward. */
  const flip = (y: number) => pageHeight - y * unit;

  for (const shape of layout.shapes) {
    switch (shape.kind) {
      case "rect": {
        // The flipped Y is the shape's *bottom*, so it is measured from its far edge.
        const path = rectPath(
          shape.x * unit,
          flip(shape.y + shape.h),
          shape.w * unit,
          shape.h * unit,
        );
        // Only the panel carries its own fill. Set it, paint, and set the ink back, so a
        // later shape cannot inherit white and vanish.
        if (shape.fill) {
          const [pr, pg, pb] = hexToRgb(shape.fill);
          ops.push(`${n(pr)} ${n(pg)} ${n(pb)} rg`, `${path} f`, `${n(r)} ${n(g)} ${n(b)} rg`);
        } else {
          ops.push(`${path} f`);
        }
        break;
      }
      case "ring": {
        // Both formats stroke on the centre line, so the geometry carries over unchanged.
        const path = rectPath(
          shape.x * unit,
          flip(shape.y + shape.h),
          shape.w * unit,
          shape.h * unit,
        );
        ops.push(`${n(shape.stroke * unit)} w`, `${path} S`);
        break;
      }
      case "text": {
        const size = shape.size * unit;
        const spacing = shape.letterSpacing * unit;
        const width = textWidth(shape.value, size, spacing);
        // PDF has no centred text, so the run is measured and placed from its left edge.
        const x = shape.cx * unit - width / 2;
        // A panelled label is painted light, because it sits on the garment, not the panel.
        if (shape.fill) {
          const [tr, tg, tb] = hexToRgb(shape.fill);
          ops.push(`${n(tr)} ${n(tg)} ${n(tb)} rg`);
        }
        ops.push(
          "BT",
          `/F1 ${n(size)} Tf`,
          `${n(spacing)} Tc`,
          `${n(x)} ${n(flip(shape.baseline))} Td`,
          `(${encodeText(shape.value)}) Tj`,
          "ET",
        );
        // Put the ink back, so nothing drawn afterwards inherits the label colour.
        if (shape.fill) ops.push(`${n(r)} ${n(g)} ${n(b)} rg`);
        break;
      }
    }
  }

  return ops.join("\n");
}

/**
 * Assemble the file.
 *
 * Built as a string in which every character is one byte, so the xref offsets can be counted in
 * characters. A multi-byte character anywhere in here would silently shift every offset after
 * it and produce a file that opens in forgiving readers and fails in strict ones, which is the
 * worst of both. `encodeText` is what keeps that true for the one field carrying user input.
 */
export function serialisePdf(layout: QrLayout): Uint8Array {
  const unit = (layout.widthMm * PT_PER_MM) / layout.widthUnits;
  const width = layout.widthUnits * unit;
  const height = layout.heightUnits * unit;

  const stream = contentStream(layout);

  // A panelled file is white panel, white text, dark code. Opened in a viewer against a white
  // page the white parts are invisible and the file looks like the text went missing. It has
  // not; it is for a dark garment. The document title is what a print shop's viewer shows, so
  // that is where it says so. ASCII only, because this string is WinAnsi like any other.
  const title = layout.applied.panel
    ? "ojhej.se SVART BAKGRUND - vit platta och vit text, svart kod"
    : "ojhej.se VIT BAKGRUND - svart kod, genomskinlig bakgrund";

  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(width)} ${n(height)}] ` +
    `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
    `<< /Title (${encodeText(title)}) /Producer (ojhej.se) >>`,
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefAt = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`;

  const document = body + xref + trailer;

  // Latin-1, one char to one byte, which is what makes the offsets above correct.
  const bytes = new Uint8Array(document.length);
  for (let i = 0; i < document.length; i++) bytes[i] = document.charCodeAt(i) & 0xff;
  return bytes;
}

export interface RenderedPdf {
  pdf: Uint8Array;
  applied: QrLayout["applied"];
}

export function renderPdf(url: string, options: QrOptions): RenderedPdf {
  const layout = layoutQr(url, options);
  return { pdf: serialisePdf(layout), applied: layout.applied };
}
