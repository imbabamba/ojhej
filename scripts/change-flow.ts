// deno-lint-ignore-file no-console -- a flow script whose whole output is its console log
/**
 * The change-of-address flow, end to end, against a running dev server.
 *
 * Sign up, activate, ask to move the code to a different address, prove the change does not
 * happen until the new address confirms, and prove a mail scanner opening the link cannot
 * complete it. Run it with `deno task change-flow` while `deno task dev` is up in capture mode.
 */

const BASE = Deno.env.get("OJHEJ_BASE") ?? "http://localhost:8787";
const MAILBOX = Deno.env.get("OJHEJ_MAILBOX") ?? ".devmail";

const GAMMAL = `gammal+${Date.now()}@exempel.se`;
const NY = `ny+${Date.now()}@exempel.se`;

function step(title: string): void {
  console.log(`\n${title}`);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Solve a challenge exactly as the browser does. Each one is spendable once. */
async function altcha(): Promise<string> {
  const challenge = await (await fetch(`${BASE}/api/altcha`)).json();
  for (let n = 0; n <= challenge.maxnumber; n++) {
    if (await sha256Hex(challenge.salt + n) === challenge.challenge) {
      return btoa(JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        number: n,
        salt: challenge.salt,
        signature: challenge.signature,
      }));
    }
  }
  throw new Error("unsolvable challenge");
}

async function mails(): Promise<string[]> {
  const names: string[] = [];
  // The directory does not exist until the first mail is captured, and the marker is read
  // before any mail is sent. Missing means empty here, not broken.
  try {
    for await (const entry of Deno.readDir(MAILBOX)) {
      if (entry.name.endsWith(".txt")) names.push(entry.name);
    }
  } catch {
    return [];
  }
  return names.sort();
}

interface Captured {
  name: string;
  /** Who it reached. Several templates never name the recipient, which is why this is separate. */
  to: string;
  body: string;
}

/** Everything captured since the given filename, oldest first. */
async function since(marker: string | undefined): Promise<Captured[]> {
  const fresh = (await mails()).filter((name) => marker === undefined || name > marker);
  return await Promise.all(fresh.map(async (name) => {
    const raw = await Deno.readTextFile(`${MAILBOX}/${name}`);
    // Blank line separates the dev capture's headers from the body it would have sent.
    const split = raw.indexOf("\n\n");
    const headers = raw.slice(0, split);
    return {
      name,
      to: headers.match(/^To: (.*)$/m)?.[1] ?? "",
      body: raw.slice(split + 2),
    };
  }));
}

function linkIn(body: string): string {
  const link = body.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error("no link in that mail");
  return link;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`   ok: ${message}`);
}

step("1. signing up and activating a code");
let marker = (await mails()).at(-1);
const signup = await fetch(`${BASE}/api/skapa`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    epost: GAMMAL,
    hemsida: "",
    startedAt: Date.now() - 5000,
    altcha: await altcha(),
  }),
});
if (!signup.ok) throw new Error(`signup failed: ${signup.status}`);
await signup.body?.cancel();

const verifyLink = linkIn((await since(marker))[0]!.body);
const activated = await fetch(verifyLink, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ t: new URL(verifyLink).searchParams.get("t")! }),
  redirect: "manual",
});
// The redirect hands over a management link for the new code. The slug comes off the page it
// opens, which is also where the purpose picker lives.
const klarToken = activated.headers.get("location")?.split("t=")[1];
assert(klarToken, "verification handed over a link to the code's own page");
const slug = ((await (await fetch(`${BASE}/klar?t=${klarToken}`)).text())
  .match(/\/s\/([A-Z0-9]{20})/) ?? [])[1];
assert(slug, `the code is active: ${slug}`);

step("2. asking for a management link");
marker = (await mails()).at(-1);
const asked = await fetch(`${BASE}/api/hantera`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    epost: GAMMAL,
    hemsida: "",
    startedAt: Date.now() - 5000,
    altcha: await altcha(),
  }),
});
await asked.body?.cancel();
const manageToken = new URL(linkIn((await since(marker))[0]!.body)).searchParams.get("t")!;
assert(manageToken, "a management link arrived");

step(`3. asking to move the code from ${GAMMAL} to ${NY}`);
marker = (await mails()).at(-1);
const change = await fetch(`${BASE}/api/hantera/atgard`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ t: manageToken, atgard: "byt-epost", epost: NY }),
});
const changed = await change.json();
console.log(`   ${change.status} ${JSON.stringify(changed)}`);
assert(changed.next === "/kolla-mailen?byte", "and points at the wording written for a change");

const both = await since(marker);
assert(both.length === 2, "two mails went out, one to each address");

// The capture file holds the body only, so each mail is identified by what it says. That the
// confirmation never names the address is itself deliberate: it is the mail most likely to be
// forwarded, so it carries the link and nothing else worth having.
const confirmMail = both.find((m) => m.to === NY);
const noticeMail = both.find((m) => m.to === GAMMAL);
assert(confirmMail, "the new address got a confirmation link");
assert(noticeMail, "the old address got a warning");
assert(confirmMail.body.includes("byt-epost?t="), "the confirmation carries the link");
assert(
  !confirmMail.body.includes(NY),
  "and names no address, being the mail most likely forwarded",
);
assert(noticeMail.body.includes(NY), "the warning says where the code would go");
assert(!noticeMail.body.includes("http"), "the warning carries no link to click");

step("4. opening the confirmation link the way a mail scanner does");
const confirmLink = linkIn(confirmMail.body);
for (let scan = 1; scan <= 3; scan++) {
  const peek = await fetch(confirmLink, { redirect: "manual" });
  const body = await peek.text();
  assert(peek.status === 200, `scan ${scan} got a page, not a redirect`);
  assert(!body.includes(slug), `scan ${scan} saw no code on the page`);
  assert(!body.includes(GAMMAL), `scan ${scan} saw no address on the page`);
}

step("5. checking the address really has not moved yet");
marker = (await mails()).at(-1);
const stillOld = await fetch(`${BASE}/api/hantera`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    epost: GAMMAL,
    hemsida: "",
    startedAt: Date.now() - 5000,
    altcha: await altcha(),
  }),
});
await stillOld.body?.cancel();
const stillReaches = await since(marker);
assert(stillReaches.length === 1, "the old address can still manage the code");
assert(stillReaches[0]!.to === GAMMAL, "and the link went to the old address");

step("6. confirming from the new address");
const confirmed = await fetch(confirmLink, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ t: new URL(confirmLink).searchParams.get("t")! }),
  redirect: "manual",
});
assert(confirmed.status === 303, "the confirmation redirected");
assert(confirmed.headers.get("location") === "/bytt", "to the done page");

step("7. the code now answers to the new address, and only to it");
marker = (await mails()).at(-1);
const newAsks = await fetch(`${BASE}/api/hantera`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    epost: NY,
    hemsida: "",
    startedAt: Date.now() - 5000,
    altcha: await altcha(),
  }),
});
await newAsks.body?.cancel();
const nowReaches = await since(marker);
assert(nowReaches.length === 1, "the new address can manage the code");
assert(nowReaches[0]!.to === NY, "and the link went there");

marker = (await mails()).at(-1);
const oldAsks = await fetch(`${BASE}/api/hantera`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    epost: GAMMAL,
    hemsida: "",
    startedAt: Date.now() - 5000,
    altcha: await altcha(),
  }),
});
await oldAsks.body?.cancel();
assert((await since(marker)).length === 0, "the old address no longer can");

step("8. the confirmation link is spent");
const replay = await fetch(confirmLink, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ t: new URL(confirmLink).searchParams.get("t")! }),
  redirect: "manual",
});
const replayBody = await replay.text();
assert(replayBody.includes("funkade inte"), "replaying it fails");

step("9. a message to the code now reaches the new address");
marker = (await mails()).at(-1);
const message = await fetch(`${BASE}/api/meddelande`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    slug,
    namn: "Kim",
    var: "På pendeln",
    meddelande: "Hej! Fin jacka.",
    kanal: "mail",
    kontakt: "kim@exempel.se",
    hemsida: "",
    startedAt: Date.now() - 5000,
    altcha: await altcha(),
  }),
});
console.log(`   ${message.status} ${JSON.stringify(await message.json())}`);
const relayed = await since(marker);
assert(relayed.length === 1, "the message was relayed");
assert(relayed[0]!.to === NY, "to the new address");
assert(relayed[0]!.to !== GAMMAL, "and not the old one");

console.log("\nthe whole change-of-address flow works.");
