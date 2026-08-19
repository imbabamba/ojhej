// deno-lint-ignore-file no-console -- a diagnostic whose entire output is its console log

/**
 * Measure what Bunny Storage actually guarantees about DELETE, because the documentation does not
 * say and the whole ownership model rests on the answer.
 *
 * Single-use verification links and the proof-of-work claim in `claimChallenge` both work by
 * racing concurrent deletes and letting exactly one win. There is no compare-and-swap in Bunny
 * Storage, so that is the only mutual exclusion available. The API reference lists 200 "object was
 * successfully deleted" and 400 "object delete failed" and stops: it does not say what comes back
 * for an object that is not there, and it gives no consistency model for geo-replication beyond
 * "close to real-time".
 *
 * On 2026-08-15 the startup probe caught a second delete answering success, twice, and every
 * request to that isolate 500ed until one booted cleanly. This script exists to find out whether
 * that was a blip or the truth.
 *
 * Three things are measured, and the third is the one that matters:
 *
 *   1. DELETE on a key that never existed. If that is ever 200, delete-as-claim is not mutual
 *      exclusion and a verification link can be redeemed any number of times.
 *   2. put, delete, delete in sequence. Exactly what `assertDeleteSemantics` does at every cold
 *      start, so its failure rate here is the site's unprompted-outage rate.
 *   3. put, then N deletes at once. This is the property the application actually depends on and
 *      the one nothing has ever checked: sequential success does not imply that a burst yields a
 *      single winner. `deploy.md` lists these semantics under "not verified anywhere in this repo".
 *
 * Each of 2 and 3 runs twice, immediately and after a settle, because replication lag is the
 * leading explanation and a delay is what tells the two apart.
 *
 * Raw status codes throughout, deliberately. Going through `createBunnyStore` would collapse the
 * answer into the boolean whose correctness is the open question.
 *
 *   deno task storage-probe
 */

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set. This script needs the real storage zone.`);
  return value;
}

const ZONE = required("BUNNY_STORAGE_ZONE");
const KEY = required("BUNNY_STORAGE_KEY");
const HOST = Deno.env.get("BUNNY_STORAGE_HOST") || "storage.bunnycdn.com";
const API_KEY = Deno.env.get("BUNNY_API_KEY");

const BASE = `https://${HOST}/${ZONE}`;

/** Tunable so a suspicious result can be re-run harder without editing the file. */
const MISSING_TRIALS = Number(Deno.env.get("PROBE_MISSING") ?? 100);
const SEQUENTIAL_ROUNDS = Number(Deno.env.get("PROBE_SEQUENTIAL") ?? 20);
const CONCURRENT_ROUNDS = Number(Deno.env.get("PROBE_ROUNDS") ?? 10);
const FANOUT = Number(Deno.env.get("PROBE_FANOUT") ?? 20);
const SETTLE_MS = Number(Deno.env.get("PROBE_SETTLE_MS") ?? 3000);

/** Everything this script writes lives under one prefix, and nothing else is ever touched. */
const probeKey = () => `probe/${crypto.randomUUID()}.json`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function put(key: string): Promise<number> {
  const response = await fetch(`${BASE}/${key}`, {
    method: "PUT",
    headers: { AccessKey: KEY, "content-type": "application/json" },
    body: JSON.stringify({ probe: true }),
  });
  await response.body?.cancel();
  return response.status;
}

async function del(key: string): Promise<number> {
  const response = await fetch(`${BASE}/${key}`, { method: "DELETE", headers: { AccessKey: KEY } });
  await response.body?.cancel();
  return response.status;
}

function bump<T>(counts: Map<T, number>, value: T): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function report<T>(counts: Map<T, number>, indent = "    "): void {
  for (const [value, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`${indent}${String(value).padEnd(24)} ${n}`);
  }
}

const problems: string[] = [];
let leaked = 0;

console.log(`\nstorage probe against ${HOST}, zone ${ZONE}\n`);

/* ---------- 1. how the zone is configured ---------- */

/**
 * Read-only, and only ever these fields.
 *
 * The storage zone API returns the zone password and the read-only password in the same object,
 * and this output goes to a CI log that anyone with repo read access can open. Picking fields by
 * name rather than dumping the response is the difference between a diagnostic and a leak.
 */
if (API_KEY) {
  try {
    const response = await fetch("https://api.bunny.net/storagezone", {
      headers: { AccessKey: API_KEY, accept: "application/json" },
    });
    if (!response.ok) {
      console.log(`  zone config unavailable: the API answered ${response.status}\n`);
    } else {
      const zones = await response.json() as Array<Record<string, unknown>>;
      const zone = zones.find((z) => z.Name === ZONE);
      if (!zone) {
        console.log(`  no storage zone named ${ZONE} on this account\n`);
      } else {
        const replicas = zone.ReplicationRegions;
        const list = Array.isArray(replicas) ? replicas : [];
        console.log(`  primary region      ${zone.Region ?? "(not reported)"}`);
        console.log(`  replication regions ${list.length ? list.join(", ") : "(none)"}`);
        console.log(`  storage hostname    ${zone.StorageHostname ?? "(not reported)"}`);
        console.log(`  configured host     ${HOST}`);
        const reported = typeof zone.StorageHostname === "string" ? zone.StorageHostname : "";
        if (reported && reported !== HOST) {
          console.log(
            `\n  The configured host is not the one this zone reports. A regional zone reached on\n` +
              `  the wrong hostname fails as 401s that read exactly like a bad password, which\n` +
              `  deploy.md already warns about. Set BUNNY_STORAGE_HOST to ${reported}.`,
          );
        }
        if (list.length > 0) {
          console.log(
            `\n  Replication is ON, and it cannot be turned off once a zone has been created.\n` +
              `  Two separate consequences. Bunny documents uploads as going to the primary region\n` +
              `  and replicating outward as a background process, with no consistency guarantee\n` +
              `  beyond "close to real-time", which is one candidate explanation for a delete\n` +
              `  answering success twice. And every replication region holds a copy of this data\n` +
              `  outside the primary, which is a residency question when the primary region was\n` +
              `  chosen precisely for where it is.`,
          );
        }
        console.log("");
      }
    }
  } catch (cause) {
    console.log(`  zone config unavailable: ${cause}\n`);
  }
} else {
  console.log("  BUNNY_API_KEY not set, skipping the zone configuration read\n");
}

/* ---------- 2. DELETE on something that was never there ---------- */

console.log(`deleting ${MISSING_TRIALS} keys that never existed`);
{
  const counts = new Map<number, number>();
  for (let i = 0; i < MISSING_TRIALS; i++) bump(counts, await del(probeKey()));
  report(counts);

  const succeeded = counts.get(200) ?? 0;
  if (succeeded > 0) {
    problems.push(
      `${succeeded}/${MISSING_TRIALS} deletes of a non-existent key reported 200. ` +
        `Delete-as-claim hands every racer a win, so verification links and the proof of work ` +
        `can both be replayed.`,
    );
  }
  console.log("");
}

/* ---------- 3. put, delete, delete: what every cold start does ---------- */

async function sequential(label: string, settleMs: number, rounds: number): Promise<void> {
  console.log(`put then two deletes, ${label}, ${rounds} rounds`);
  const counts = new Map<string, number>();

  for (let i = 0; i < rounds; i++) {
    const key = probeKey();
    await put(key);
    if (settleMs) await sleep(settleMs);
    const first = await del(key);
    const second = await del(key);
    bump(counts, `${first} then ${second}`);
    if (first !== 200 && second !== 200) leaked++;
  }

  report(counts);
  let bad = 0;
  for (const [pair, n] of counts) if (!/^200 then (404|400)$/.test(pair)) bad += n;
  if (bad > 0) {
    problems.push(
      `${bad}/${rounds} sequential rounds (${label}) did not read "200 then 404". That is the ` +
        `check every cold start runs, so this is how often the site refuses to boot.`,
    );
  }
  console.log("");
}

await sequential("immediately", 0, SEQUENTIAL_ROUNDS);
await sequential(`after ${SETTLE_MS}ms`, SETTLE_MS, Math.max(1, Math.floor(SEQUENTIAL_ROUNDS / 2)));

/* ---------- 4. the one that actually matters ---------- */

async function concurrent(label: string, settleMs: number, rounds: number): Promise<void> {
  console.log(`put then ${FANOUT} deletes at once, ${label}, ${rounds} rounds`);
  const winners = new Map<number, number>();

  for (let i = 0; i < rounds; i++) {
    const key = probeKey();
    await put(key);
    if (settleMs) await sleep(settleMs);

    const statuses = await Promise.all(Array.from({ length: FANOUT }, () => del(key)));
    const won = statuses.filter((status) => status === 200).length;
    bump(winners, won);
    if (won === 0) leaked++;
  }

  console.log("    winners per round:");
  report(winners, "      ");

  let bad = 0;
  for (const [won, n] of winners) if (won !== 1) bad += n;
  if (bad > 0) {
    problems.push(
      `${bad}/${rounds} concurrent rounds (${label}) did not yield exactly one winner. ` +
        `Delete-as-claim is not mutual exclusion on this store, so a single verification link ` +
        `can be redeemed more than once and one proof of work can be spent more than once.`,
    );
  }
  console.log("");
}

await concurrent("immediately", 0, CONCURRENT_ROUNDS);
await concurrent(`after ${SETTLE_MS}ms`, SETTLE_MS, Math.max(1, Math.floor(CONCURRENT_ROUNDS / 2)));

/* ---------- verdict ---------- */

if (leaked > 0) {
  console.log(
    `note: ${leaked} probe object(s) may still be in the zone under probe/. The store has no ` +
      `list operation by design, so they are unreachable rather than tidy.\n`,
  );
}

if (problems.length === 0) {
  console.log("no violations observed.");
  console.log(
    "Delete-as-claim held for every trial here. That is evidence, not a proof: this ran for a\n" +
      "few minutes against one region at one moment.\n",
  );
} else {
  console.log(`${problems.length} problem${problems.length > 1 ? "s" : ""}:\n`);
  for (const problem of problems) console.log(`  - ${problem}\n`);
  Deno.exit(1);
}
