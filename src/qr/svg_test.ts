import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import jsQRImport from "jsqr";
import { encodeQr } from "./encode.ts";
import { layoutQr } from "./layout.ts";
import { renderSvg } from "./svg.ts";

const jsQR = ((jsQRImport as unknown as { default?: unknown }).default ?? jsQRImport) as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

const URL_ = "https://ojhej.se/s/K7M4NPQR8TVWXYZ2ABCD";
const BACK = 180;
const CHEST = 60;

/**
 * Rebuild a module grid from the rendered SVG and decode it.
 *
 * The encoder already has its own decode test, so this one exists to catch the renderer:
 * a wrong offset, a swapped axis, a quiet zone eaten by the label band. Reading the geometry
 * back out of the file is the only way to prove the thing we hand a print shop is the thing
 * the encoder produced.
 */
function decodeRendered(url: string, sizeMm: number): string | null {
  const { svg } = renderSvg(url, { sizeMm });
  const code = encodeQr(url, "Q");
  const QUIET = 4;
  const across = code.size + QUIET * 2;

  const grid: boolean[][] = Array.from({ length: across }, () => new Array(across).fill(false));

  // Data modules, straight from the file.
  for (const match of svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="1\.\d+"/g)) {
    grid[Math.round(Number(match[2]))]![Math.round(Number(match[1]))] = true;
  }

  // The three finders are emitted as a frame plus a core, so expand them from their known
  // shape at the positions the renderer claims to use.
  for (const [row, col] of [[0, 0], [0, code.size - 7], [code.size - 7, 0]]) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[row! + r + QUIET]![col! + c + QUIET] = ring || core;
      }
    }
  }

  const SCALE = 4;
  const width = across * SCALE;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < across; y++) {
    for (let x = 0; x < across; x++) {
      if (!grid[y]![x]) continue;
      for (let a = 0; a < SCALE; a++) {
        for (let b = 0; b < SCALE; b++) {
          const at = ((y * SCALE + a) * width + (x * SCALE + b)) * 4;
          pixels[at] = 0;
          pixels[at + 1] = 0;
          pixels[at + 2] = 0;
        }
      }
    }
  }

  return jsQR(pixels, width, width)?.data ?? null;
}

Deno.test("what we hand the print shop still decodes to the right URL", () => {
  assertEquals(decodeRendered(URL_, BACK), URL_);
  assertEquals(decodeRendered(URL_, CHEST), URL_);
});

Deno.test("the quiet zone is exactly four modules and nothing intrudes on it", () => {
  const { svg } = renderSvg(URL_, { sizeMm: BACK });
  for (const match of svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="1\.\d+"/g)) {
    assert(Number(match[1]) >= 4, `module at x=${match[1]} sits inside the quiet zone`);
    assert(Number(match[2]) >= 4, `module at y=${match[2]} sits inside the quiet zone`);
  }
});

Deno.test("the physical size is in the file, so it cannot be scaled below the module floor", () => {
  const { svg, applied } = renderSvg(URL_, { sizeMm: BACK });
  assertStringIncludes(svg, `width="180mm"`);
  // 41 modules across including the quiet zone, so about 4.4 mm each. Well over 0.4 mm.
  assert(applied.moduleMm > 4, `module is ${applied.moduleMm.toFixed(2)} mm`);

  const chest = renderSvg(URL_, { sizeMm: CHEST });
  assert(chest.applied.moduleMm > 1.4, `chest module is ${chest.applied.moduleMm.toFixed(2)} mm`);
  assert(chest.applied.moduleMm > 0.4, "below the printable floor");
});

/* The small print is deliberately not what the user asked for, and that is the point. */

Deno.test("the chest print drops the label and the centre mark", () => {
  const asked = { sizeMm: CHEST, mark: true, label: "DEJTA?" };
  const { svg, applied } = renderSvg(URL_, asked);

  assertEquals(applied.mark, false, "no room for a centre mark at 60 mm");
  assertEquals(applied.ec, "H", "every print gets the highest redundancy, see below");
  assert(!svg.includes("<text"), "no room for a label at 60 mm");
});

/**
 * There used to be rounded and dotted variants. They were removed on 2026-08-13: a QR code is a
 * machine-readable thing first, and styling it trades scan reliability for decoration nobody
 * asked for. This pins the absence, because "make it prettier" is a recurring idea.
 */
Deno.test("the code is drawn in plain squares, always", () => {
  for (const sizeMm of [CHEST, BACK]) {
    const { svg } = renderSvg(URL_, { sizeMm, mark: true, label: "DEJTA" });
    assert(!svg.includes("<circle"), `${sizeMm}mm should have no dots`);
    assert(!/rx="[1-9]/.test(svg), `${sizeMm}mm should have no rounded corners`);
  }
});

/** The black field covers the full file, so white text stays visible in a PDF or SVG viewer. */
Deno.test("the dark-garment background covers the code and label", () => {
  const layout = layoutQr(URL_, { sizeMm: BACK, panel: true, label: "DEJTA" });
  const background = layout.shapes.find((s) => s.kind === "rect" && s.fill === "#000000")!;
  const text = layout.shapes.find((s) => s.kind === "text")!;

  assert(background.kind === "rect" && text.kind === "text");
  assertEquals(background.y, 0);
  assertEquals(background.w, layout.widthUnits);
  assertEquals(background.h, layout.heightUnits);
  assert(text.baseline < background.h, "the label sits on the black field");
});

Deno.test("a dark-garment label is white, a light-garment label uses the black ink", () => {
  const panelled = renderSvg(URL_, { sizeMm: BACK, panel: true, label: "DEJTA" }).svg;
  const plain = renderSvg(URL_, { sizeMm: BACK, label: "DEJTA" }).svg;

  const textOf = (svg: string) => svg.slice(svg.indexOf("<text"), svg.indexOf("</text>"));
  assertStringIncludes(textOf(panelled), 'fill="#ffffff"');
  assert(!textOf(plain).includes("fill="), "without a panel the label just uses the ink");
});

Deno.test("a dark garment gets a black field with white modules", () => {
  const plain = renderSvg(URL_, { sizeMm: BACK });
  const panelled = renderSvg(URL_, { sizeMm: BACK, panel: true });

  assertEquals(plain.applied.panel, false);
  assertEquals(panelled.applied.panel, true);

  assertStringIncludes(panelled.svg, 'fill="#000000"', "the background is black");
  assertStringIncludes(panelled.svg, 'color="#ffffff"', "the code is white");
  assertStringIncludes(panelled.svg, 'fill="#ffffff"', "the modules inherit white");
  assert(!plain.svg.includes('fill="#ffffff"'), "the light-garment code stays black");

  // The dark field adds margin beyond the quiet zone, so the same code occupies a larger canvas.
  const box = (svg: string) => Number(svg.match(/viewBox="0 0 ([\d.]+)/)![1]);
  assert(box(panelled.svg) > box(plain.svg), "a panel makes the artwork wider");
});

Deno.test("one ink for the code and the text, when there is no panel", () => {
  const { svg } = renderSvg(URL_, { sizeMm: BACK, colour: "#4B2E83", label: "OJ HEJ" });
  assertStringIncludes(svg, `color="#4B2E83"`);
  assertStringIncludes(svg, `fill="#4B2E83"`);
  // The finder strokes follow the same ink rather than carrying their own colour.
  assertStringIncludes(svg, `stroke="currentColor"`);
});

Deno.test("the background stays transparent so the garment shows through", () => {
  const { svg } = renderSvg(URL_, { sizeMm: BACK });
  assert(!/<rect[^>]*width="4[01]"/.test(svg), "no full-bleed background rectangle");
});

Deno.test("a label cannot break out of the markup", () => {
  const { svg } = renderSvg(URL_, { sizeMm: BACK, label: '"><script>x</script>' });
  assert(!svg.includes("<script>"), "the label is user text and must be escaped");
  assertStringIncludes(svg, "&lt;SCRIPT&gt;");
});

Deno.test("a label makes the file taller, never wider", () => {
  const without = renderSvg(URL_, { sizeMm: BACK });
  const with_ = renderSvg(URL_, { sizeMm: BACK, label: "DEJTA?" });

  assertStringIncludes(without.svg, `width="180mm"`);
  assertStringIncludes(with_.svg, `width="180mm"`);

  const heightOf = (svg: string) => Number(/height="([\d.]+)mm"/.exec(svg)![1]);
  assert(heightOf(with_.svg) > heightOf(without.svg), "the label needs its own band");
});

/**
 * Level H on every print, not only when the centre mark needs the headroom.
 *
 * A garment is heavy use, and the research recommends H for exactly that case. What made it an
 * easy decision is that it is free: for our URL length H needs the same 33 modules as Q, so the
 * module size does not move and the redundancy goes from 25 to 30 percent for nothing. That
 * redundancy is what buys wash cycles, and a dark garment loses contrast roughly twice as fast
 * as a light one. See research-2026-08-13-dark-garments.md.
 */
Deno.test("every print carries the highest error correction, and it costs no module size", () => {
  for (const sizeMm of [CHEST, BACK]) {
    for (const panel of [false, true]) {
      const { applied } = renderSvg(URL_, { sizeMm, panel });
      assertEquals(applied.ec, "H", `${sizeMm}mm panel=${panel}`);
      assert(
        applied.moduleMm >= 0.4,
        `${sizeMm}mm modules are ${applied.moduleMm}mm, under the fabric floor`,
      );
    }
  }
});

/** The chest print is the one where module size could bite, so it is pinned. */
Deno.test("the chest print stays well clear of the 0.4 mm fabric floor", () => {
  const plain = renderSvg(URL_, { sizeMm: CHEST }).applied.moduleMm;
  const panelled = renderSvg(URL_, { sizeMm: CHEST, panel: true }).applied.moduleMm;

  assert(plain > 1.0, `60 mm plain is ${plain}mm per module`);
  assert(panelled > 1.0, `60 mm panelled is ${panelled}mm per module`);
});
