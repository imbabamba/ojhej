// deno-lint-ignore-file no-console -- a flow script whose whole output is its console log
/**
 * Several codes on one address, end to end, against a running dev server.
 *
 * Sign up, activate, ask for a management link, and prove the things the multi-code design
 * turns on: one mail rather than one per code, a list that reaches every code the address owns,
 * a new code made without another mail, and a refusal when the link is pointed at somebody
 * else's code.
 *
 * Run it with `deno task koder-flow` while `deno task dev` is up in capture mode.
 */

const BASE = Deno.env.get("OJHEJ_BASE") ?? "http://localhost:8787";
const MAILBOX = Deno.env.get("OJHEJ_MAILBOX") ?? ".devmail";

const MIN = `min+${Date.now()}@exempel.se`;
const ANNAN = `annan+${Date.now()}@exempel.se`;

function step(title: string): void {
  console.log(`\n${title}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`   ok: ${message}`);
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
  to: string;
  body: string;
}

async function since(marker: string | undefined): Promise<Captured[]> {
  const fresh = (await mails()).filter((name) => marker === undefined || name > marker);
  return await Promise.all(fresh.map(async (name) => {
    const raw = await Deno.readTextFile(`${MAILBOX}/${name}`);
    const split = raw.indexOf("\n\n");
    return {
      to: raw.slice(0, split).match(/^To: (.*)$/m)?.[1] ?? "",
      body: raw.slice(split + 2),
    };
  }));
}

function linkIn(body: string): string {
  const link = body.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error("no link in that mail");
  return link;
}

/** Sign up an address, activate the code, and hand back its slug. */
async function nyKod(epost: string): Promise<string> {
  const marker = (await mails()).at(-1);
  const signup = await fetch(`${BASE}/api/skapa`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      epost,
      hemsida: "",
      startedAt: Date.now() - 5000,
      altcha: await altcha(),
    }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${signup.status}`);
  await signup.body?.cancel();

  const link = linkIn((await since(marker))[0]!.body);
  const activated = await fetch(link, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ t: new URL(link).searchParams.get("t")! }),
    redirect: "manual",
  });

  const token = activated.headers.get("location")?.split("t=")[1];
  if (!token) throw new Error("verification handed over no link");
  const page = await (await fetch(`${BASE}/klar?t=${token}`)).text();
  const slug = (page.match(/\/s\/([A-Z0-9]{20})/) ?? [])[1];
  if (!slug) throw new Error("the page never showed the code's address");
  return slug;
}

/** Ask for a management link and read the token out of the mail it sends. */
async function hanteraLank(epost: string): Promise<{ token: string; brev: Captured[] }> {
  const marker = (await mails()).at(-1);
  const asked = await fetch(`${BASE}/api/hantera`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      epost,
      hemsida: "",
      startedAt: Date.now() - 5000,
      altcha: await altcha(),
    }),
  });
  await asked.body?.cancel();

  const brev = await since(marker);
  const token = brev.length > 0 ? new URL(linkIn(brev[0]!.body)).searchParams.get("t")! : "";
  return { token, brev };
}

interface Utfall {
  status: number;
  json: { ok?: boolean; next?: string; t?: string; fel?: string };
}

async function act(body: Record<string, unknown>): Promise<Utfall> {
  const response = await fetch(`${BASE}/api/hantera/atgard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

step("1. one address, one code");
const forst = await nyKod(MIN);
console.log(`   ${forst}`);

step("2. asking for a management link");
let { token, brev } = await hanteraLank(MIN);
assert(brev.length === 1, "one mail arrived");
assert(brev[0]!.to === MIN, "at the address that asked");
assert(!brev[0]!.body.includes(forst), "and it names no code address, only printed labels");

step("3. the link opens the list");
let lista = await (await fetch(`${BASE}/hantera?t=${token}`)).text();
assert(lista.includes("Skapa en till"), "which offers making another");
assert(lista.includes("av 10"), "and counts them against the cap");

step("4. making a second code from the list, with no mail at all");
const marker = (await mails()).at(-1);
const skapad = await act({ t: token, atgard: "skapa" });
assert(skapad.status === 200, "the code was made");
assert(String(skapad.json.next).startsWith("/klar?t="), "and lands on its own page to be designed");
assert((await since(marker)).length === 0, "no mail, because the address is verified already");

const andraSidan = await (await fetch(`${BASE}${skapad.json.next}`)).text();
const andra = (andraSidan.match(/\/s\/([A-Z0-9]{20})/) ?? [])[1]!;
assert(andra !== forst, `the new code is its own: ${andra}`);
assert(
  (await (await fetch(`${BASE}/s/${andra}`)).text()).includes("Säg hej"),
  "and it is live at once, taking messages without a second verification",
);

step("5. one mail names both codes");
({ token, brev } = await hanteraLank(MIN));
assert(brev.length === 1, "still one mail, not one per code");
assert(
  brev[0]!.body.split("\n").filter((line) => line.startsWith("- ")).length === 2,
  "listing two",
);

step("6. pausing one code leaves the other alone");
const pausad = await act({ t: token, atgard: "pausa", slug: forst });
assert(pausad.status === 200, "the pause went through");
assert(
  (await (await fetch(`${BASE}/s/${forst}`)).text()).includes("Pausad."),
  "and a stranger scanning it meets a friendly no",
);
assert(
  (await (await fetch(`${BASE}/s/${andra}`)).text()).includes("Säg hej"),
  "while the other code still takes messages",
);

step("7. a link for one address cannot touch another address's code");
const deras = await nyKod(ANNAN);
token = String(pausad.json.next).split("t=")[1]!;
const stulen = await act({ t: token, atgard: "radera", slug: deras });
assert(stulen.status === 404, "the refusal is a plain not-found");
assert(
  (await (await fetch(`${BASE}/s/${deras}`)).text()).includes("Säg hej"),
  "and the stranger's code is untouched",
);

step("8. the refusal did not cost the owner their link");
const igen = await act({ t: token, atgard: "ateruppta", slug: forst });
assert(igen.status === 200, "the same link still worked on a code the owner owns");
token = String(igen.json.next).split("t=")[1]!;

step("9. deleting one code, then the other");
const enBort = await act({ t: token, atgard: "radera", slug: forst });
assert(enBort.status === 200, "the first delete went through");
assert(
  String(enBort.json.next).startsWith("/hantera?t="),
  "and returns to the list, one row lighter",
);

token = String(enBort.json.next).split("t=")[1]!;
lista = await (await fetch(`${BASE}/hantera?t=${token}`)).text();
assert(!lista.includes(forst), "the deleted code is gone from the list");
assert(lista.includes(andra), "and the survivor is still on it");

const sistaBort = await act({ t: token, atgard: "radera", slug: andra });
assert(sistaBort.json.next === "/raderad", "deleting the last one says goodbye properly");
assert(
  (await (await fetch(`${BASE}/s/${andra}`)).text()).includes("Ingen kod här."),
  "and the address stops leading anywhere",
);

console.log("\nseveral codes on one address, end to end, works.");
