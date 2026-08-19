// deno-lint-ignore-file no-console -- a CLI whose whole output is its console log

/**
 * Everything a print shop needs for one code, in one folder.
 *
 * Reuses `src/qr` rather than carrying its own renderer. That is the point of the module: the
 * file a customer downloads from the site and the file we hand a printer come off the same
 * layout, so they cannot quietly become different codes. A separate print path would look
 * identical for months and then not be.
 *
 * Nothing is written until every output has been decoded and checked. A pack that cannot be
 * scanned is worse than no pack, because it looks finished.
 *
 *   deno task print-pack MDJ8K0ZNTBKYBH63AVFG
 *   deno task print-pack MDJ8K0ZNTBKYBH63AVFG --text "SÄG HEJ" --platta --ut ./tryck
 */

import { isValidSlug } from "../src/store/crypto.ts";
import { decodeLayout } from "../src/qr/decode.ts";
import { DEFAULT_LABEL, layoutQr } from "../src/qr/layout.ts";
import { markPdf, markSvg } from "../src/qr/mark.ts";
import { serialisePdf } from "../src/qr/pdf.ts";
import { serialiseSvg } from "../src/qr/svg.ts";

/** Chest and back, the two sizes the plan settled on. */
const SIZES = [
  { mm: 60, name: "brost", label: "", mark: false, note: "60 mm, raka rutor" },
  { mm: 180, name: "rygg", label: null, mark: true, note: "180 mm, med text" },
] as const;

interface Options {
  slug: string;
  baseUrl: string;
  text: string;
  /** A light panel behind the code, for a dark garment. Never white ink; see the qr research. */
  panel: boolean;
  colour: string;
  out: string;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  // Boolean flags take no value. Without this list the parser eats the next argument as
  // `--platta`'s value, and `--ut ./somewhere` silently writes to the default folder instead.
  const BOOLEAN = new Set(["platta"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN.has(name)) flags.set(name, "ja");
    else flags.set(name, argv[++i] ?? "");
  }

  const slug = positional[0] ?? "";
  if (!isValidSlug(slug)) {
    throw new Error(
      `"${slug}" is not a code. Usage: deno task print-pack <KOD> ` +
        `[--text T] [--platta] [--farg #000000] [--ut DIR]`,
    );
  }

  const colour = flags.get("farg") ?? "#000000";
  if (!/^#[0-9a-fA-F]{6}$/.test(colour)) {
    throw new Error(`--farg must be a six-digit hex colour, got "${colour}"`);
  }

  return {
    slug,
    baseUrl: flags.get("bas") ?? Deno.env.get("OJHEJ_BASE_URL") ?? "https://ojhej.se",
    text: flags.get("text") ?? DEFAULT_LABEL,
    panel: flags.get("platta") === "ja",
    colour,
    out: flags.get("ut") ?? `tryck/${slug}`,
  };
}

const options = parseArgs(Deno.args);
const target = `${options.baseUrl}/s/${options.slug}`;

console.log(`\nkod    ${options.slug}`);
console.log(`länk   ${target}`);
console.log(
  `tryck  ${options.panel ? "svart på vit platta" : "svart direkt på tyget"}, ${options.colour}\n`,
);

/** Build and check everything before a single file is written. */
const pack: { name: string; bytes: Uint8Array | string; note: string }[] = [];

for (const size of SIZES) {
  const layout = layoutQr(target, {
    sizeMm: size.mm,
    panel: options.panel,
    colour: options.colour,
    label: size.label === null ? options.text : "",
    mark: size.mark,
  });

  const read = decodeLayout(layout);
  if (read !== target) {
    console.error(`\n  ${size.mm} mm does not decode.`);
    console.error(`  expected ${target}`);
    console.error(`  got      ${read ?? "nothing at all"}`);
    console.error(`\nNothing written. Fix the renderer before sending anything to print.`);
    Deno.exit(1);
  }

  // The garment is in the filename, so a dark-garment file cannot be mistaken for a broken one.
  const stem = `ojhej-${options.slug}-${size.name}-${size.mm}mm-${options.panel ? "svart" : "vit"}`;
  pack.push({ name: `${stem}.svg`, bytes: serialiseSvg(layout), note: size.note });
  pack.push({ name: `${stem}.pdf`, bytes: serialisePdf(layout), note: size.note });

  const moduleMm = layout.applied.moduleMm;
  // Below about 0.4 mm a module stops surviving fabric and ink spread. Verified in
  // specs/ojhej/research-2026-08-12-qr-print.md.
  const floor = moduleMm >= 0.4 ? "ok" : "TOO SMALL";
  console.log(
    `  ${String(size.mm).padStart(3)} mm  decodes  modul ${moduleMm.toFixed(2)} mm ${floor}  ` +
      `nivå ${layout.applied.ec}${layout.applied.mark ? ", märke" : ""}`,
  );
  if (moduleMm < 0.4) {
    console.error(`\n  ${size.mm} mm puts modules under the 0.4 mm floor. Nothing written.`);
    Deno.exit(1);
  }
}

// The mark on its own, for anywhere the code itself does not go: a label, a neck print, a card.
pack.push({ name: "ojhej-marke-20mm.svg", bytes: markSvg(20), note: "märket, 20 mm" });
pack.push({ name: "ojhej-marke-20mm.pdf", bytes: markPdf(20), note: "märket, 20 mm" });

const readme = `ojhej.se tryckfiler
${"=".repeat(19)}

Kod:    ${options.slug}
Länk:   ${target}
Färg:   ${options.colour}
Bakgrund: ${
  options.panel ? "svart, koden ligger på en vit platta" : "vit, koden trycks direkt på tyget"
}

${pack.map((file) => `  ${file.name.padEnd(44)} ${file.note}`).join("\n")}

Att tänka på vid tryck
----------------------
Skriv ut i exakt angiven storlek. Skala inte.
Bakgrunden är genomskinlig. Koden måste vara mörk mot ljust, aldrig tvärtom.
Marginalen runt koden är fyra moduler och är en del av filen. Beskär den inte.
Varje fil är kontrollerad och avkodad till länken ovan innan den skrevs.
Felkorrigering nivå H, alltså 30 procent redundans. Det är det som köper tvättar.

SVG är originalet. PDF finns för tryckerier som hellre vill ha det.
${
  options.panel
    ? `
OBS, filerna är gjorda för en svart bakgrund
------------------------------------------
Koden ligger på en vit platta och texten ovanför är vit. Öppnar du filen mot en vit
bakgrund ser texten ut att saknas. Den gör inte det, den är vit. Två färger ska tryckas:
vitt för plattan och texten, svart för själva koden.

Plattan är inte dekoration. Svarta rutor på vit botten läses av alla skannrar, medan en
vit kod direkt på tyget missas av äldre telefoner och av många skannerappar. Plattan
håller dessutom kontrasten ungefär dubbelt så länge i tvätten.

Screentryck håller bättre än DTG på mörka plagg. Ett DTG-tryck på mörkt tyg tappar
läsbarheten ungefär dubbelt så fort, eftersom den vita bottenplattan ska överleva samma
tvättar som färgen ovanpå. Se specs/ojhej/research-2026-08-13-dark-garments.md.
`
    : ""
}`;

await Deno.mkdir(options.out, { recursive: true });
for (const file of pack) {
  await (typeof file.bytes === "string"
    ? Deno.writeTextFile(`${options.out}/${file.name}`, file.bytes)
    : Deno.writeFile(`${options.out}/${file.name}`, file.bytes));
}
await Deno.writeTextFile(`${options.out}/LÄSMIG.txt`, readme);

console.log(`\n  ${pack.length + 1} filer i ${options.out}/\n`);
