import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { markLayout, markPdf, markSvg } from "./mark.ts";

const text = (pdf: Uint8Array) => new TextDecoder("latin1").decode(pdf);

/**
 * The mark is a QR finder pattern, and the proportions are the joke: 1:1:3:1:1 across the
 * middle is exactly what makes a real finder findable. Drawn wrong it stops reading as one.
 */
Deno.test("the mark keeps the proportions it is imitating", () => {
  const { shapes, widthUnits } = markLayout(20);

  assertEquals(widthUnits, 7);
  const ring = shapes.find((s) => s.kind === "ring")!;
  const core = shapes.find((s) => s.kind === "rect")!;

  assert(ring.kind === "ring" && core.kind === "rect");
  assertEquals(ring.stroke, 1, "the frame is one unit thick");
  assertEquals(core.w, 3, "the core is three units");
  assertEquals(core.x, 2, "with one unit of gap on each side");
});

Deno.test("the mark is square at the size that was asked for", () => {
  for (const sizeMm of [10, 20, 50]) {
    assertStringIncludes(markSvg(sizeMm), `width="${sizeMm}mm" height="${sizeMm}.000mm"`);

    const box = text(markPdf(sizeMm)).match(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/)!;
    assertEquals(box[1], box[2], `${sizeMm}mm should be square`);
  }
});

Deno.test("the mark honours a colour, in both formats", () => {
  assertStringIncludes(markSvg(20, "#ff0000"), 'fill="#ff0000"');
  assertStringIncludes(text(markPdf(20, "#ff0000")), "1 0 0 rg");
});

Deno.test("both formats draw the mark from the same shapes", () => {
  const layout = markLayout(20);
  // One stroked frame plus one filled core, and nothing else to get out of step.
  assertEquals(layout.shapes.length, 2);
  assertStringIncludes(markSvg(20), "stroke-width");
  assertStringIncludes(text(markPdf(20)), " S");
});
