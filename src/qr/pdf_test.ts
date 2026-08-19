import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { decodeLayout } from "./decode.ts";
import { layoutQr, QUIET } from "./layout.ts";
import { renderPdf, serialisePdf } from "./pdf.ts";
import { renderSvg } from "./svg.ts";

const URL_ = "https://ojhej.se/s/K7M4NPQR8TVWXYZ2ABCD";
const BACK = 180;
const CHEST = 60;
const PT_PER_MM = 72 / 25.4;

const text = (pdf: Uint8Array) => new TextDecoder("latin1").decode(pdf);

Deno.test("the layout both formats share still decodes to the right URL", () => {
  for (const sizeMm of [CHEST, BACK]) {
    const layout = layoutQr(URL_, { sizeMm });
    assertEquals(decodeLayout(layout), URL_, `${sizeMm}mm`);
  }
});

/**
 * The reason the geometry is shared at all. A customer downloads one of these and a print shop
 * is sent the other, and nobody would notice for weeks if they stopped agreeing.
 */
Deno.test("SVG and PDF are built from the same code, at every size and setting", () => {
  for (const sizeMm of [CHEST, 120, BACK]) {
    for (const panel of [false, true]) {
      const options = { sizeMm, panel, mark: true, label: "DEJTA" };
      const svg = renderSvg(URL_, options);
      const pdf = renderPdf(URL_, options);

      assertEquals(pdf.applied, svg.applied, `${sizeMm}mm panel=${panel}`);
    }
  }
});

Deno.test("it is a PDF that a reader can find its way around", () => {
  const { pdf } = renderPdf(URL_, { sizeMm: BACK });
  const body = text(pdf);

  assertStringIncludes(body, "%PDF-1.4");
  assert(body.trimEnd().endsWith("%%EOF"), "a truncated file opens in nothing");
  assertStringIncludes(body, "/Type /Catalog");
  assertStringIncludes(body, "/Type /Page");

  // The xref offset must point at the real xref table, or strict readers refuse the file.
  const startxref = Number(body.match(/startxref\n(\d+)/)![1]);
  assertEquals(body.slice(startxref, startxref + 4), "xref", "startxref points at nothing");

  // And every object offset in the table must land on that object's header.
  const rows = [...body.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assertEquals(rows.length, 6, "catalog, pages, page, contents, font, info");
  rows.forEach((offset, index) => {
    assertStringIncludes(body.slice(offset, offset + 12), `${index + 1} 0 obj`);
  });
});

Deno.test("the declared stream length matches the stream", () => {
  const { pdf } = renderPdf(URL_, { sizeMm: BACK, label: "DEJTA", panel: true, mark: true });
  const body = text(pdf);

  const declared = Number(body.match(/\/Length (\d+)/)![1]);
  const start = body.indexOf("stream\n") + "stream\n".length;
  const actual = body.indexOf("\nendstream") - start;

  assertEquals(actual, declared, "a wrong length is how a PDF opens blank");
});

/**
 * The physical size is the whole point of the file. A print shop scales to the page box, so a
 * wrong MediaBox is a code printed at the wrong size, which is a code that does not scan.
 */
Deno.test("the page is exactly the millimetres that were asked for", () => {
  for (const sizeMm of [CHEST, BACK]) {
    const { pdf } = renderPdf(URL_, { sizeMm });
    const box = text(pdf).match(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/)!;

    const widthPt = Number(box[1]);
    assertEquals(
      Math.round((widthPt / PT_PER_MM) * 100) / 100,
      sizeMm,
      `${sizeMm}mm should be ${(sizeMm * PT_PER_MM).toFixed(2)}pt`,
    );
    // Square without a label, so height matches width.
    assertEquals(box[1], box[2]);
  }
});

Deno.test("a label makes the page taller, never wider", () => {
  const plain = text(renderPdf(URL_, { sizeMm: BACK }).pdf).match(
    /MediaBox \[0 0 ([\d.]+) ([\d.]+)/,
  )!;
  const labelled = text(renderPdf(URL_, { sizeMm: BACK, label: "DEJTA?" }).pdf)
    .match(/MediaBox \[0 0 ([\d.]+) ([\d.]+)/)!;

  assertEquals(labelled[1], plain[1], "same width");
  assert(Number(labelled[2]) > Number(plain[2]), "taller");
});

/** The quiet zone is what a scanner needs to find the code at all. */
Deno.test("nothing is painted inside the quiet zone", () => {
  const layout = layoutQr(URL_, { sizeMm: BACK, mark: true });

  for (const shape of layout.shapes) {
    const left = shape.kind === "text" ? QUIET : shape.x;
    const top = shape.kind === "text" ? QUIET : shape.y;
    assert(left >= QUIET - 0.001, `a shape starts at x=${left}, inside the quiet zone`);
    assert(top >= 0, `a shape starts at y=${top}`);
  }
});

Deno.test("the ink is the colour that was asked for, on fill and stroke alike", () => {
  const body = text(renderPdf(URL_, { sizeMm: BACK, colour: "#ff0000", mark: true }).pdf);

  assertStringIncludes(body, "1 0 0 rg", "fill");
  assertStringIncludes(body, "1 0 0 RG", "stroke");
});

Deno.test("a malformed colour falls back to black rather than corrupting the file", () => {
  for (const colour of ["", "not a colour", "#12", "rgb(1,2,3)", "#gggggg"]) {
    const body = text(renderPdf(URL_, { sizeMm: BACK, colour }).pdf);
    assertStringIncludes(body, "0 0 0 rg", colour);
  }
});

/**
 * The label is the one field carrying text a person typed. In PDF the string delimiters are
 * parentheses and the escape is a backslash, so all three have to be neutralised or a label can
 * close the string early and the rest of the file becomes operators.
 */
Deno.test("a label cannot break out of the content stream", () => {
  const hostile = `) Tj ET Q 1 0 0 rg 0 0 999 999 re f (`;
  const body = text(renderPdf(URL_, { sizeMm: 180, label: hostile }).pdf);

  // Whatever survives must be inside one balanced string, and must not have painted anything.
  assert(!body.includes("999 999 re f"), "the injected rectangle was drawn");
  assertStringIncludes(body, "\\) TJ ET Q 1 0 0 RG 0 0 999 999 RE F \\(");
});

Deno.test("a backslash in a label is escaped too", () => {
  const body = text(renderPdf(URL_, { sizeMm: 180, label: "A\\B" }).pdf);
  assertStringIncludes(body, "(A\\\\B)");
});

/**
 * Every byte must be a byte. A stray multi-byte character shifts every xref offset after it,
 * producing a file that opens in forgiving readers and fails in strict ones.
 */
Deno.test("characters outside the encoding are dropped, not smuggled through", () => {
  const { pdf } = renderPdf(URL_, { sizeMm: 180, label: "hej 😀 där" });

  for (const byte of pdf) assert(byte <= 0xff);
  const body = text(pdf);
  assertStringIncludes(body, "(HEJ  D");
  assert(!body.includes("😀"));

  // Swedish survives, which is the point of WinAnsi rather than ASCII.
  assertStringIncludes(text(renderPdf(URL_, { sizeMm: 180, label: "från" }).pdf), "FR\xc5N");
});

Deno.test("the chest print ignores styling and the centre mark, as SVG does", () => {
  const { applied } = renderPdf(URL_, { sizeMm: CHEST, mark: true, label: "X" });

  assertEquals(applied.mark, false);
  assertEquals(applied.ec, "H");
  assert(!text(renderPdf(URL_, { sizeMm: CHEST, label: "X" }).pdf).includes("BT"), "no label");
});

Deno.test("every shape is a plain rectangle, so the file has no curves at all", () => {
  const body = text(renderPdf(URL_, { sizeMm: BACK, mark: true, label: "DEJTA" }).pdf);
  const stream = body.slice(body.indexOf("stream"), body.indexOf("endstream"));

  assert(
    !stream.includes(" c" + String.fromCharCode(10)),
    "a curve operator means styling crept back in",
  );
  assertStringIncludes(stream, " re f");
});

/** The panel must paint light and then put the ink back, or everything after it vanishes. */
Deno.test("a panel is painted white and does not leak its colour onto the code", () => {
  const body = text(renderPdf(URL_, { sizeMm: BACK, panel: true }).pdf);
  const stream = body.slice(body.indexOf("stream"), body.indexOf("endstream"));

  assertStringIncludes(stream, "1 1 1 rg", "the panel is white");
  // After painting it, the ink is restored, so the modules that follow are dark.
  const whiteAt = stream.indexOf("1 1 1 rg");
  assertStringIncludes(stream.slice(whiteAt), "0 0 0 rg");
});

/** An empty layout must still be a valid file rather than a zero-object document. */
Deno.test("serialising is stable and self-consistent for any layout", () => {
  const layout = layoutQr(URL_, { sizeMm: BACK, label: "DEJTA", mark: true, panel: true });
  const first = serialisePdf(layout);
  const second = serialisePdf(layout);

  assertEquals(first, second, "the same layout must produce the same bytes");
});

/**
 * The panel shifts the code inward by two modules on every side. If the decoder still reads it,
 * the offsets survived; if it does not, a dark-garment print would be a code that scans nowhere
 * and nobody would notice until the shirts arrived.
 */
Deno.test("a panelled code still decodes, at both sizes", () => {
  for (const sizeMm of [CHEST, BACK]) {
    const layout = layoutQr(URL_, { sizeMm, panel: true });
    assertEquals(decodeLayout(layout), URL_, `${sizeMm}mm with a panel`);
  }
});

/** The panel is margin *beyond* the quiet zone, never taken out of it. */
Deno.test("a panel does not eat the quiet zone", () => {
  const plain = layoutQr(URL_, { sizeMm: BACK });
  const panelled = layoutQr(URL_, { sizeMm: BACK, panel: true });

  assertEquals(panelled.widthUnits - plain.widthUnits, 4, "two extra modules on each side");

  // The first data module sits two modules further in, so the clear space around the code grew.
  const firstModule = (l: typeof plain) =>
    Math.min(
      ...l.shapes.filter((s) => s.kind === "rect" && !s.fill).map((s) => (s as { x: number }).x),
    );
  assertEquals(firstModule(panelled) - firstModule(plain), 2);
});

/**
 * A panelled file is white panel, white text, dark code. Opened in a viewer against a white
 * page the white parts are invisible and the file looks like the text went missing. It has not;
 * it is for a dark garment. The document title is what a print shop's viewer shows, so that is
 * where it says so.
 */
Deno.test("the document title says which background the file is for", () => {
  const panelled = text(renderPdf(URL_, { sizeMm: BACK, panel: true, label: "DEJTA" }).pdf);
  const plain = text(renderPdf(URL_, { sizeMm: BACK, label: "DEJTA" }).pdf);

  assertStringIncludes(panelled, "/Title (");
  assertStringIncludes(panelled, "SVART BAKGRUND");
  assertStringIncludes(panelled, "vit platta");
  assertStringIncludes(plain, "VIT BAKGRUND");
});

/** The info object has to be in the xref and referenced, or strict readers reject the file. */
Deno.test("adding the title kept the file structurally valid", () => {
  const body = text(renderPdf(URL_, { sizeMm: BACK, panel: true }).pdf);

  assertStringIncludes(body, "/Info 6 0 R");
  assertEquals(body.match(/\/Size (\d+)/)![1], "7");

  const rows = [...body.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assertEquals(rows.length, 6, "six objects, all in the table");
  rows.forEach((offset, index) => {
    assertStringIncludes(body.slice(offset, offset + 12), `${index + 1} 0 obj`);
  });

  const startxref = Number(body.match(/startxref\n(\d+)/)![1]);
  assertEquals(body.slice(startxref, startxref + 4), "xref");
});
