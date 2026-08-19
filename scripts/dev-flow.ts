// deno-lint-ignore-file no-console
// A CLI whose entire output is meant for a human reading a terminal.

/**
 * Drives a running dev server through the whole signup flow, the way the browser will:
 * fetch a challenge, solve the proof of work, post the form, then follow the verification
 * link out of the captured mail.
 *
 * This is the "does it actually work" check that the unit tests deliberately cannot be,
 * because it crosses every seam at once: HTTP, the ALTCHA round trip, real storage on disk,
 * a real mail render, and the redirect that finally reveals the slug.
 *
 * Usage:  deno task dev        (in one terminal)
 *         deno task flow       (in another)
 */

const BASE = Deno.env.get("OJHEJ_BASE_URL") ?? "http://localhost:8787";
const ADDRESS = Deno.args[0] ??
  // Unique per run: the per-address signup cap is three a day, and a fixed address turns
  // "run the flow again" into a 429 that looks like a broken script.
  `flow+${Date.now()}@exempel.se`;

function step(label: string) {
  console.log(`\n${label}`);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

step("1. asking for a proof-of-work challenge");
const challenge = await (await fetch(`${BASE}/api/altcha`)).json();
console.log(`   maxnumber ${challenge.maxnumber}, expires in the salt`);

step("2. solving it, the way the widget does");
const started = Date.now();
let number = -1;
for (let n = 0; n <= challenge.maxnumber; n++) {
  if (await sha256Hex(challenge.salt + n) === challenge.challenge) {
    number = n;
    break;
  }
}
if (number < 0) throw new Error("unsolvable challenge");
console.log(`   found ${number} in ${Date.now() - started}ms`);

const altcha = btoa(JSON.stringify({ ...challenge, number }));

step("3. posting the signup");
// startedAt is backdated past MIN_FILL_MS: a real person spends longer than this reading.
const signup = await fetch(`${BASE}/api/skapa`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    epost: ADDRESS,
    hemsida: "",
    startedAt: Date.now() - 5000,
    altcha,
  }),
});
console.log(`   ${signup.status} ${JSON.stringify(await signup.json())}`);
if (!signup.ok) throw new Error("signup failed");

step("4. reading the verification link out of the captured mail");
const mailbox = Deno.env.get("OJHEJ_MAILBOX") ?? ".devmail";
const files: string[] = [];
// Missing means empty: the directory only exists once something has been captured.
try {
  for await (const entry of Deno.readDir(mailbox)) {
    if (entry.name.endsWith(".txt")) files.push(entry.name);
  }
} catch { /* no mail yet */ }
files.sort();
const latest = files.at(-1);
if (!latest) throw new Error("no mail was captured");
const body = await Deno.readTextFile(`${mailbox}/${latest}`);
const link = body.match(/https?:\/\/\S+/)?.[0];
if (!link) throw new Error("no link in the mail");
console.log(`   ${latest}`);
console.log(`   ${link}`);

step("5. opening it twice, the way a mail scanner does before the owner clicks");
for (let scan = 1; scan <= 2; scan++) {
  const peek = await fetch(link, { redirect: "manual" });
  const body = await peek.text();
  console.log(
    `   fetch ${scan}: ${peek.status}, still offering to activate: ${
      body.includes("Aktivera koden")
    }`,
  );
  if (peek.status !== 200) throw new Error("opening the link should not redirect");
}

step("6. pressing the button, which is what actually activates");
const token = new URL(link).searchParams.get("t") ?? "";
const verified = await fetch(`${BASE}/verifiera`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ t: token }),
  redirect: "manual",
});
const location = verified.headers.get("location");
console.log(`   ${verified.status} -> ${location}`);
// The redirect hands over a management link for the new code rather than the slug itself. That
// link is what authorises the purpose picker on the page it lands on.
if (verified.status !== 303 || !location?.includes("/klar?t=")) {
  throw new Error(`verification did not hand over a link: ${location}`);
}

step("7. checking the link is single use");
const replay = await fetch(`${BASE}/verifiera`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ t: token }),
  redirect: "manual",
});
console.log(
  `   replay ${replay.status}, activated again: ${
    replay.headers.get("location")?.includes("/klar?t=") ?? false
  }`,
);
if (replay.headers.get("location")?.includes("/klar?t=")) {
  throw new Error("the verification link worked twice");
}

const manageToken = location.split("t=")[1]!;

step("8. the page it lands on, which is where the purpose is picked");
const klar = await fetch(`${BASE}/klar?t=${manageToken}`);
const klarBody = await klar.text();
console.log(
  `   ${klar.status}, picker: ${klarBody.includes('id="syfte"')}, ` +
    `preview: ${klarBody.includes("Så möts den som skannar")}`,
);
if (!klarBody.includes('id="syfte"')) throw new Error("the purpose picker never rendered");

const slug = (klarBody.match(/\/s\/([A-Z0-9]{20})/) ?? [])[1];
if (!slug) throw new Error("the page did not show the code's own address");

step("9. picking a purpose, and reading it back off the scan page");
const saved = await fetch(`${BASE}/api/hantera/atgard`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    t: manageToken,
    atgard: "syfte",
    syfte: "borttappat",
    etikett: "HITTAT?",
  }),
});
const savedBody = await saved.json();
console.log(`   ${saved.status}, fresh link: ${Boolean(savedBody.t)}`);
if (!saved.ok || !savedBody.t) throw new Error("saving the purpose failed");

const scanned = await (await fetch(`${BASE}/s/${slug}`)).text();
const line = "Den här kom bort. Skriv så hämtar jag den.";
console.log(
  `   scan page carries the line: ${scanned.includes(line)}, ` +
    `dry line gone: ${!scanned.includes("Ingen märker något")}`,
);
if (!scanned.includes(line)) throw new Error("the purpose never reached the scan page");
if (scanned.includes("Ingen märker något")) {
  throw new Error("the dry line survived a purpose, which variant A removes");
}

console.log(`\nflow complete`);
console.log(`   code   ${slug}`);
console.log(`   sida   ${BASE}/s/${slug}`);
