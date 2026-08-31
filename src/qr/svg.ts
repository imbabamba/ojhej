/**
 * SVG serialiser for a QR layout.
 *
 * All the geometry lives in `layout.ts`, shared with the PDF writer, so the file a customer
 * downloads and the file a print shop is sent can never be different codes. This module only
 * decides how those shapes are spelled in XML.
 *
 * `shape-rendering="crispEdges"` matters more than it looks: without it a renderer antialiases
 * module edges into grey, and grey modules are what make a code that scans on screen fail on
 * fabric.
 */

import { layoutQr, type QrLayout, type QrOptions, type Shape } from "./layout.ts";

export type { QrOptions as SvgOptions };
export { PLAIN_BELOW_MM, QUIET } from "./layout.ts";

export interface RenderedQr {
  svg: string;
  /** What was actually used, which is not always what was asked for. */
  applied: QrLayout["applied"];
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const n = (value: number) => value.toFixed(3);

function draw(shape: Shape): string {
  switch (shape.kind) {
    case "rect": {
      // The dark-garment background carries its own fill; modules inherit the layout ink.
      const fill = shape.fill ? ` fill="${escapeXml(shape.fill)}"` : "";
      return `<rect x="${n(shape.x)}" y="${n(shape.y)}" width="${n(shape.w)}" ` +
        `height="${n(shape.h)}" rx="${n(shape.radius)}"${fill}/>`;
    }
    case "ring":
      return `<rect x="${n(shape.x)}" y="${n(shape.y)}" width="${n(shape.w)}" ` +
        `height="${n(shape.h)}" rx="${n(shape.radius)}" fill="none" stroke="currentColor" ` +
        `stroke-width="${n(shape.stroke)}"/>`;
    case "text": {
      // A dark-garment label is explicitly white.
      const fill = shape.fill ? ` fill="${escapeXml(shape.fill)}"` : "";
      return `<text x="${n(shape.cx)}" y="${n(shape.baseline)}" ` +
        `text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-weight="700" ` +
        `font-size="${n(shape.size)}"${fill} ` +
        `letter-spacing="${n(shape.letterSpacing)}">${escapeXml(shape.value)}</text>`;
    }
  }
}

export function serialiseSvg(layout: QrLayout): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${layout.widthMm}mm" height="${n(layout.heightMm)}mm" ` +
    `viewBox="0 0 ${layout.widthUnits} ${layout.heightUnits}" shape-rendering="crispEdges" ` +
    `color="${escapeXml(layout.colour)}" fill="${escapeXml(layout.colour)}" ` +
    `role="img" aria-label="QR-kod till ${escapeXml(layout.url)}">` +
    layout.shapes.map(draw).join("") +
    `</svg>`;
}

export function renderSvg(url: string, options: QrOptions): RenderedQr {
  const layout = layoutQr(url, options);
  return { svg: serialiseSvg(layout), applied: layout.applied };
}
