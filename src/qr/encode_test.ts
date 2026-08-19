import { assert, assertEquals, assertThrows } from "@std/assert";
import jsQRImport from "jsqr";

/** CommonJS interop: the callable arrives as the module or as its default, depending. */
const jsQR = ((jsQRImport as unknown as { default?: unknown }).default ??
  jsQRImport) as (
    data: Uint8ClampedArray,
    width: number,
    height: number,
  ) => { data: string } | null;
import { encodeQr } from "./encode.ts";

/**
 * Decode with a third-party decoder rather than comparing bytes to another encoder.
 *
 * A byte-for-byte diff would be invalid: two conforming encoders legitimately pick different
 * mask patterns for the same input. The only claim worth testing is the one a phone makes,
 * which is that pointing a decoder at this thing yields the URL we put in. The mocks drew a
 * structurally plausible grid that no decoder could read, and that is exactly the failure
 * this test exists to prevent.
 */
function decode(text: string, ec: "Q" | "H" = "Q"): string | null {
  const code = encodeQr(text, ec);

  // Render to RGBA with a 4-module quiet zone and several pixels per module. One pixel per
  // module leaves a decoder almost nothing to lock onto, which says more about the render
  // than the code, so the scale here mirrors a real scan rather than a minimal bitmap.
  const QUIET = 4;
  const SCALE = 4;
  const modulesWide = code.size + QUIET * 2;
  const width = modulesWide * SCALE;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);

  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.modules[y]![x]) continue;
      for (let py = 0; py < SCALE; py++) {
        for (let px = 0; px < SCALE; px++) {
          const at = (((y + QUIET) * SCALE + py) * width + ((x + QUIET) * SCALE + px)) * 4;
          pixels[at] = 0;
          pixels[at + 1] = 0;
          pixels[at + 2] = 0;
        }
      }
    }
  }

  return jsQR(pixels, width, width)?.data ?? null;
}

Deno.test("a real code decodes back to the URL it was given", () => {
  const url = "https://ojhej.se/s/K7M4NPQR8TVWXYZ2ABCD";
  assertEquals(decode(url), url);
});

Deno.test("decodes at both error correction levels", () => {
  const url = "https://ojhej.se/s/K7M4NPQR8TVWXYZ2ABCD";
  assertEquals(decode(url, "Q"), url);
  assertEquals(decode(url, "H"), url);
});

Deno.test("every slug shape this service can mint decodes", () => {
  // Crockford base32, so the extremes are all digits and all letters.
  for (
    const slug of [
      "00000000000000000000",
      "ZZZZZZZZZZZZZZZZZZZZ",
      "K7M4NPQR8TVWXYZ2ABCD",
      "0R3D2359QSJ9Y5NSQC4G",
    ]
  ) {
    const url = `https://ojhej.se/s/${slug}`;
    assertEquals(decode(url), url, `failed for ${slug}`);
  }
});

Deno.test("decodes across the payload sizes that select different versions", () => {
  for (const length of [1, 10, 30, 60, 100, 150, 200]) {
    const text = "A".repeat(length);
    assertEquals(decode(text), text, `failed at ${length} bytes`);
  }
});

Deno.test("non-ASCII survives, since the wordmark and copy are Swedish", () => {
  const text = "Oj hej. Åäö på tröjan.";
  assertEquals(decode(text), text);
});

Deno.test("a real shirt URL lands on version 4, which is what the print sizes assume", () => {
  // 39 bytes. This number matters physically, not just numerically: version 4 is 33 modules,
  // so at the 180 mm back print a module is about 5.5 mm and at the 60 mm chest print about
  // 1.8 mm, both above the 0.4 mm floor recorded in the QR research file. A denser version
  // would quietly shrink those.
  const url = "https://ojhej.se/s/K7M4NPQR8TVWXYZ2ABCD";
  assertEquals(new TextEncoder().encode(url).length, 39);

  for (const ec of ["Q", "H"] as const) {
    const code = encodeQr(url, ec);
    assertEquals(code.version, 4, `unexpected version at level ${ec}`);
    assertEquals(code.size, 33);
  }
});

Deno.test("module size at the two print sizes stays above the 0.4 mm floor", () => {
  const code = encodeQr("https://ojhej.se/s/K7M4NPQR8TVWXYZ2ABCD", "H");
  // The printed square includes a 4-module quiet zone on each side.
  const across = code.size + 8;
  const back = 180 / across;
  const chest = 60 / across;

  assert(back > 4, `back print module ${back.toFixed(2)} mm`);
  assert(chest > 1.4, `chest print module ${chest.toFixed(2)} mm`);
  assert(chest > 0.4, "below the printable floor");
});

Deno.test("the three finder patterns are exactly where a decoder looks", () => {
  const code = encodeQr("https://ojhej.se/s/K7M4NPQR8TVWXYZ2ABCD");
  const corners = [[0, 0], [0, code.size - 7], [code.size - 7, 0]];

  for (const [row, col] of corners) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const onRing = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assertEquals(
          code.modules[row! + r]![col! + c],
          onRing || core,
          `finder at ${row},${col} wrong at ${r},${c}`,
        );
      }
    }
  }
});

Deno.test("the module that must always be dark is dark", () => {
  const code = encodeQr("https://ojhej.se/s/K7M4NPQR8TVWXYZ2ABCD");
  assert(code.modules[code.size - 8]![8], "the fixed dark module is missing");
});

Deno.test("an impossible payload throws rather than truncating", () => {
  // Silently dropping characters would produce a code that scans and goes somewhere wrong,
  // which is far worse than refusing outright.
  assertThrows(() => encodeQr("A".repeat(4000), "H"), Error);
});

Deno.test("an empty payload is refused", () => {
  // A blank code would print and scan to nothing, which is the worst kind of shirt.
  assertThrows(() => encodeQr("", "Q"), Error);
});

Deno.test("encoding is deterministic", () => {
  const url = "https://ojhej.se/s/K7M4NPQR8TVWXYZ2ABCD";
  assertEquals(JSON.stringify(encodeQr(url)), JSON.stringify(encodeQr(url)));
});
