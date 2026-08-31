import { assert, assertEquals, assertRejects } from "@std/assert";
import { importKey } from "./crypto.ts";
import { createMemoryStore } from "./storage.ts";
import { radFor, syfteOf } from "../syfte.ts";
import {
  bumpMessageCount,
  createCode,
  deleteCode,
  getCode,
  PENDING_TTL_MS,
  readOwnerEmail,
  setCodeSetup,
  setDesign,
  setOwnerEmail,
  setStatus,
} from "./shirts.ts";
import { DEFAULT_SURVEY_QUESTIONS, surveyOf } from "../survey.ts";

const KEY = "3q2+796tvu/erb7v3q2+796tvu/erb7v3q2+796tvu8=";
const DAY = 86_400_000;
const T0 = Date.parse("2026-08-12T10:00:00Z");

async function setup() {
  return { ...createMemoryStore(), key: await importKey(KEY) };
}

Deno.test("createCode mints a pending record and stores the email encrypted", async () => {
  const { store, key } = await setup();
  const record = await createCode(store, key, "anders@exempel.se", T0);

  assertEquals(record.status, "pending");
  assertEquals(record.msgCount, 0);
  assertEquals(record.createdAt, T0);
  assertEquals(record.verifiedAt, null);

  const raw = await store.get(`shirts/${record.slug}.json`);
  assert(raw, "the record should be stored under its slug");
  assert(!raw.includes("anders@exempel.se"), "the address must not be readable in the store");
  assert(!raw.includes("exempel"), "not even partially");
});

Deno.test("createCode writes exactly one object, under a slug-derived key", async () => {
  const { store, key, keys } = await setup();
  const record = await createCode(store, key, "anders@exempel.se", T0);
  assertEquals(keys(), [`shirts/${record.slug}.json`]);
});

Deno.test("readOwnerEmail recovers the address for sending", async () => {
  const { store, key } = await setup();
  const record = await createCode(store, key, "anders@exempel.se", T0);
  assertEquals(await readOwnerEmail(key, record), "anders@exempel.se");
});

Deno.test("getCode returns null for a slug that was never issued", async () => {
  const { store, key } = await setup();
  await createCode(store, key, "anders@exempel.se", T0);
  assertEquals(await getCode(store, "K7M4NPQR8TVWXYZ2ABCD", T0), null);
});

Deno.test("getCode rejects a malformed slug before touching the store", async () => {
  const { store } = await setup();
  for (const hostile of ["../../secrets", "K7M4", "", "K7M4NPQR8TVWXYZ2ABC/"]) {
    await assertRejects(
      () => getCode(store, hostile, T0),
      Error,
      "slug",
      `should have refused ${JSON.stringify(hostile)}`,
    );
  }
});

Deno.test("setStatus activates, pauses and resumes", async () => {
  const { store, key } = await setup();
  const created = await createCode(store, key, "anders@exempel.se", T0);

  const active = await setStatus(store, created.slug, "active", T0 + 1000);
  assertEquals(active.status, "active");
  assertEquals(active.verifiedAt, T0 + 1000);

  const paused = await setStatus(store, created.slug, "paused", T0 + 2000);
  assertEquals(paused.status, "paused");
  assertEquals(paused.verifiedAt, T0 + 1000, "verification survives a pause");

  const resumed = await setStatus(store, created.slug, "active", T0 + 3000);
  assertEquals(resumed.verifiedAt, T0 + 1000, "resuming must not re-stamp verification");
});

/**
 * A code nobody verified is a code somebody may have created with a stranger's address.
 * After a week it stops existing, so an unwanted signup cannot linger.
 */
Deno.test("an unverified code stops existing after the pending window", async () => {
  const { store, key } = await setup();
  const created = await createCode(store, key, "anders@exempel.se", T0);

  assert(await getCode(store, created.slug, T0 + PENDING_TTL_MS - 1), "still valid just inside");
  assertEquals(
    await getCode(store, created.slug, T0 + PENDING_TTL_MS + 1),
    null,
    "expired just outside",
  );
});

Deno.test("a verified code does not expire", async () => {
  const { store, key } = await setup();
  const created = await createCode(store, key, "anders@exempel.se", T0);
  await setStatus(store, created.slug, "active", T0 + 1000);

  const later = await getCode(store, created.slug, T0 + 400 * DAY);
  assert(later, "an active code must survive indefinitely");
  assertEquals(later.status, "active");
});

Deno.test("bumpMessageCount counts within a day and rolls over", async () => {
  const { store, key } = await setup();
  const created = await createCode(store, key, "anders@exempel.se", T0);
  await setStatus(store, created.slug, "active", T0);

  const first = await bumpMessageCount(store, created.slug, T0);
  assertEquals(first.today, 1);

  const second = await bumpMessageCount(store, created.slug, T0 + 3600_000);
  assertEquals(second.today, 2, "same day keeps counting");

  const nextDay = await bumpMessageCount(store, created.slug, T0 + DAY);
  assertEquals(nextDay.today, 1, "a new day resets the counter");
  assertEquals(nextDay.total, 3, "the lifetime total keeps climbing");
});

Deno.test("deleteCode removes the object entirely", async () => {
  const { store, key, size } = await setup();
  const created = await createCode(store, key, "anders@exempel.se", T0);
  await deleteCode(store, created.slug);

  assertEquals(size(), 0);
  assertEquals(await getCode(store, created.slug, T0), null);
});

/**
 * Changing the owner address replaces the ciphertext outright. There is no history kept: an
 * address someone asked us to stop using should not survive in the record that replaced it.
 */
Deno.test("the owner address can be replaced, and the old one does not survive", async () => {
  const { store } = createMemoryStore();
  const key = await importKey(KEY);
  const record = await createCode(store, key, "gammal@exempel.se", T0);

  const updated = await setOwnerEmail(store, key, record.slug, "ny@exempel.se", T0 + 60_000);

  assertEquals(await readOwnerEmail(key, updated), "ny@exempel.se");
  assertEquals(
    await readOwnerEmail(key, (await getCode(store, record.slug, T0 + 60_000))!),
    "ny@exempel.se",
  );

  const raw = (await store.get(`shirts/${record.slug}.json`))!;
  assert(!raw.includes("gammal@exempel.se"), "the old address must not be in the clear");
  assert(!raw.includes("ny@exempel.se"), "and neither is the new one");
  assert(!raw.includes(record.emailEnc), "the old ciphertext is gone, not archived alongside");
});

Deno.test("changing the address leaves everything else about the code alone", async () => {
  const { store } = createMemoryStore();
  const key = await importKey(KEY);
  const record = await createCode(store, key, "gammal@exempel.se", T0);
  await setStatus(store, record.slug, "active", T0);
  await bumpMessageCount(store, record.slug, T0);

  const before = (await getCode(store, record.slug, T0))!;
  const after = await setOwnerEmail(store, key, record.slug, "ny@exempel.se", T0 + 60_000);

  assertEquals(after.status, before.status);
  assertEquals(after.slug, before.slug);
  assertEquals(after.createdAt, before.createdAt);
  assertEquals(after.verifiedAt, before.verifiedAt);
  assertEquals(after.msgCount, before.msgCount, "a change of address is not a fresh start");
});

Deno.test("changing the address of a code that is gone fails rather than recreating it", async () => {
  const { store, keys } = createMemoryStore();
  const key = await importKey(KEY);

  await assertRejects(() => setOwnerEmail(store, key, "K7M4NPQR8TVWXYZ2ABCD", "ny@exempel.se", T0));
  assertEquals(keys().length, 0);
});

Deno.test("a new code has no purpose written down, and reads as the default", async () => {
  const { store, key } = await setup();
  const record = await createCode(store, key, "anders@exempel.se", T0);

  assertEquals(record.syfte, undefined, "nothing is written until the owner picks one");
  assertEquals(record.etikett, undefined);
  assertEquals(syfteOf(record), "hej");
  assertEquals(radFor(record), "", "so the scan page is exactly what it was");
});

Deno.test("a code can start as a survey without changing the original default", async () => {
  const { store, key } = await setup();
  const greeting = await createCode(store, key, "anders@exempel.se", T0);
  const survey = await createCode(store, key, "anders@exempel.se", T0, "survey");

  assertEquals(surveyOf(greeting), { mode: "greeting", questions: [] });
  assertEquals(surveyOf(survey), {
    mode: "survey",
    questions: [...DEFAULT_SURVEY_QUESTIONS],
  });
});

Deno.test("the scanner setup saves purpose and survey atomically", async () => {
  const { store, key } = await setup();
  const record = await createCode(store, key, "anders@exempel.se", T0);

  const updated = await setCodeSetup(
    store,
    record.slug,
    { syfte: "eget", rad: "Svara om du vill.", etikett: "FRÅGOR?" },
    { mode: "survey", questions: ["Vad läser du?", "Kaffe eller te?"] },
    T0,
  );

  assertEquals(updated.syfte, "eget");
  assertEquals(updated.mode, "survey");
  assertEquals(updated.questions, ["Vad läser du?", "Kaffe eller te?"]);
  assertEquals(updated.msgCount, 0);
});

Deno.test("setDesign stores the purpose, the line and the printed label", async () => {
  const { store, key } = await setup();
  const record = await createCode(store, key, "anders@exempel.se", T0);

  await setDesign(
    store,
    record.slug,
    { syfte: "eget", rad: "Vi ses på torget.", etikett: "TORGET" },
    T0 + 60_000,
  );

  const stored = (await getCode(store, record.slug, T0 + 60_000))!;
  assertEquals(stored.syfte, "eget");
  assertEquals(stored.rad, "Vi ses på torget.");
  assertEquals(stored.etikett, "TORGET");
  assertEquals(radFor(stored), "Vi ses på torget.");
});

Deno.test("setDesign touches nothing else about the code", async () => {
  const { store, key } = await setup();
  const record = await createCode(store, key, "anders@exempel.se", T0);
  await setStatus(store, record.slug, "active", T0);
  await bumpMessageCount(store, record.slug, T0);

  const before = (await getCode(store, record.slug, T0))!;
  const after = await setDesign(
    store,
    record.slug,
    { syfte: "fest", rad: "", etikett: "SÄG HEJ" },
    T0 + 60_000,
  );

  assertEquals(after.status, before.status);
  assertEquals(after.createdAt, before.createdAt);
  assertEquals(after.verifiedAt, before.verifiedAt);
  assertEquals(after.msgCount, before.msgCount);
  assertEquals(after.emailEnc, before.emailEnc, "the owner is not re-encrypted by a design change");
});

Deno.test("an empty label is stored as empty, not dropped back to the default", async () => {
  const { store, key } = await setup();
  const record = await createCode(store, key, "anders@exempel.se", T0);

  const after = await setDesign(store, record.slug, { syfte: "hej", rad: "", etikett: "" }, T0);
  assertEquals(after.etikett, "", "the owner asked for no text above the code");
  assertEquals((await getCode(store, record.slug, T0))!.etikett, "");
});

Deno.test("designing a code that is gone fails rather than recreating it", async () => {
  const { store, keys } = await setup();
  await assertRejects(() =>
    setDesign(store, "K7M4NPQR8TVWXYZ2ABCD", { syfte: "hej", rad: "", etikett: "X" }, T0)
  );
  assertEquals(keys().length, 0);
});

/**
 * Storage is not trusted, and these two fields are rendered: one into a stranger's page and one
 * into an SVG. A record written by a later version, or corrupted, must not carry a number or an
 * object into a template.
 */
Deno.test("a stored design of the wrong shape reads as no design at all", async () => {
  const { store, key } = await setup();
  const record = await createCode(store, key, "anders@exempel.se", T0);

  await store.put(
    `shirts/${record.slug}.json`,
    JSON.stringify({ ...record, syfte: 7, rad: { toString: "x" }, etikett: ["A"] }),
  );

  const stored = (await getCode(store, record.slug, T0))!;
  assertEquals(stored.rad, undefined);
  assertEquals(stored.etikett, undefined);
  assertEquals(syfteOf(stored), "hej");
  assertEquals(radFor(stored), "");
});
