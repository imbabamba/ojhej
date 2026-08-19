/**
 * QR encoding.
 *
 * A thin, deliberate wrapper around a proven encoder rather than our own implementation.
 *
 * The rule recorded in the QR research file was "one encoder, not two": the print pack and
 * the self-serve download must come from the same source, or the file a print shop receives
 * can drift from the one the site hands out. That rule ruled out adding Python's segno
 * alongside TypeScript. It does not require writing the encoder ourselves, and a first
 * attempt at that produced a matrix with correct codewords, correct Reed-Solomon and correct
 * format information that no decoder could read. Reimplementing the specification is not
 * where this product's value lies; the styling, sizing and quiet zone are.
 *
 * What stays ours is everything downstream: the module matrix is the boundary, and the
 * renderers, print sizes and scan-safety rules are built on top of it.
 *
 * Level Q by default, H whenever a centre mark is placed, because H recovers ~30% and the
 * mark costs ~11%. Researched numbers, not guesses.
 */

import QRCode from "qrcode";

export type EcLevel = "Q" | "H";

export interface QrCode {
  size: number;
  version: number;
  ec: EcLevel;
  /** Row-major, true where the module is dark. */
  modules: boolean[][];
}

export function encodeQr(text: string, ec: EcLevel = "Q"): QrCode {
  if (text.length === 0) throw new Error("refusing to encode an empty payload");

  // deno-lint-ignore no-explicit-any
  const created = QRCode.create(text, { errorCorrectionLevel: ec }) as any;
  const size: number = created.modules.size;

  const modules: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    const line: boolean[] = [];
    for (let col = 0; col < size; col++) line.push(Boolean(created.modules.get(row, col)));
    modules.push(line);
  }

  return { size, version: created.version, ec, modules };
}
