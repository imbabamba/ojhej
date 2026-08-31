/**
 * Codes: the one record per user this service keeps.
 *
 * Tenant isolation is enforced structurally rather than by convention. Every function here
 * derives its storage key from a slug that has already passed `isValidSlug`, and the store
 * interface has no list operation, so there is no reachable path from a request to a record
 * other than the one the caller named. See storage.ts.
 *
 * The owner's address is never held in the clear: it goes in encrypted at creation and is
 * only opened at the moment a mail is sent.
 */

import { decrypt, encrypt, isValidSlug, newSlug } from "./crypto.ts";
import { type Design, isSyfte, type SyfteKey } from "../syfte.ts";
import {
  DEFAULT_SURVEY_QUESTIONS,
  isScanMode,
  type ScanMode,
  surveyOf,
  type SurveySetup,
} from "../survey.ts";
import type { ObjectStore } from "./storage.ts";

export type CodeStatus = "pending" | "active" | "paused";

export interface CodeRecord {
  slug: string;
  /** AES-GCM ciphertext. Never log this, never render it. */
  emailEnc: string;
  status: CodeStatus;
  createdAt: number;
  verifiedAt: number | null;
  /** Lifetime messages relayed. */
  msgCount: number;
  /** Messages relayed on `msgDay`, for the daily cap. */
  msgToday: number;
  /** Midnight-anchored day key the counter belongs to. */
  msgDay: number;
  /**
   * What the code is for. Absent on every record made before purposes existed, and absent is
   * `hej`, which renders the scan page exactly as it always was. See `src/syfte.ts`.
   */
  syfte?: SyfteKey;
  /** The owner's own line, for `eget` only. */
  rad?: string;
  /**
   * The text printed above the code.
   *
   * Absent and empty are different and stay different: absent means the owner never chose, so
   * the default applies, and empty means they chose to print the code with nothing above it.
   */
  etikett?: string;
  /** What the scanner meets: absent is the original open greeting. */
  mode?: ScanMode;
  /** Owner-written prompts. Responses are relayed and never stored here. */
  questions?: string[];
}

/** An unverified code disappears after a week, so an unwanted signup cannot linger. */
export const PENDING_TTL_MS = 7 * 86_400_000;

const DAY_MS = 86_400_000;

function keyFor(slug: string): string {
  if (!isValidSlug(slug)) {
    // Thrown, not returned, because reaching here means input skipped validation upstream.
    throw new Error(`refusing to build a storage key from an invalid slug`);
  }
  return `shirts/${slug}.json`;
}

function dayOf(now: number): number {
  return Math.floor(now / DAY_MS);
}

/**
 * Stored content is not trusted. A truncated or corrupt object reads as "no such record"
 * rather than throwing, so one bad object cannot take down the request that finds it.
 */
function parseRecord(raw: string): CodeRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as CodeRecord;
    if (typeof record.slug !== "string" || !isValidSlug(record.slug)) return null;
    if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return null;

    // The three design fields are rendered: one into a stranger's page, one into an SVG this
    // service generates. A record written by a later version, or corrupted, must not carry a
    // number or an object into a template, so anything of the wrong shape reads as unset rather
    // than failing the whole record. Losing a label costs a label; refusing the record costs the
    // owner their code.
    const survey = surveyOf(record);
    return {
      ...record,
      syfte: isSyfte(record.syfte) ? record.syfte : undefined,
      rad: typeof record.rad === "string" ? record.rad : undefined,
      etikett: typeof record.etikett === "string" ? record.etikett : undefined,
      mode: isScanMode(record.mode) && survey.mode === "survey" ? "survey" : undefined,
      questions: survey.mode === "survey" ? survey.questions : undefined,
    };
  } catch {
    return null;
  }
}

export async function createCode(
  store: ObjectStore,
  key: CryptoKey,
  email: string,
  now: number = Date.now(),
  mode: ScanMode = "greeting",
): Promise<CodeRecord> {
  // A blind put would silently overwrite an existing owner's record. At 96 bits a collision
  // is vanishingly unlikely, but this is also the failure mode a weakened entropy source
  // would produce, and that is worth failing loudly rather than destroying someone's code.
  let slug = newSlug();
  for (let attempt = 0; await store.get(keyFor(slug)) !== null; attempt++) {
    if (attempt >= 4) throw new Error("could not mint an unused slug");
    slug = newSlug();
  }

  const record: CodeRecord = {
    slug,
    emailEnc: await encrypt(key, email),
    status: "pending",
    createdAt: now,
    verifiedAt: null,
    msgCount: 0,
    msgToday: 0,
    msgDay: dayOf(now),
    ...(mode === "survey" ? { mode, questions: [...DEFAULT_SURVEY_QUESTIONS] } : {}),
  };
  await store.put(keyFor(slug), JSON.stringify(record));
  return record;
}

/**
 * Returns null for anything the caller should treat as "no such code": never issued,
 * deleted, or an unverified record that has aged out. Callers cannot tell those apart,
 * which is deliberate.
 */
export async function getCode(
  store: ObjectStore,
  slug: string,
  now: number = Date.now(),
): Promise<CodeRecord | null> {
  const raw = await store.get(keyFor(slug));
  if (raw === null) return null;

  const record = parseRecord(raw);
  if (!record) return null;
  if (record.status === "pending" && now - record.createdAt > PENDING_TTL_MS) return null;
  return record;
}

async function mutate(
  store: ObjectStore,
  slug: string,
  change: (record: CodeRecord) => CodeRecord,
  now: number,
): Promise<CodeRecord> {
  const record = await getCode(store, slug, now);
  if (!record) throw new Error("no such code");

  const updated = change(record);
  await store.put(keyFor(slug), JSON.stringify(updated));
  return updated;
}

export function setStatus(
  store: ObjectStore,
  slug: string,
  status: CodeStatus,
  now: number = Date.now(),
): Promise<CodeRecord> {
  return mutate(
    store,
    slug,
    (record) => ({
      ...record,
      status,
      // Stamped once, on first activation. Pausing and resuming must not rewrite history.
      verifiedAt: record.verifiedAt ?? (status === "active" ? now : null),
    }),
    now,
  );
}

export async function bumpMessageCount(
  store: ObjectStore,
  slug: string,
  now: number = Date.now(),
): Promise<{ today: number; total: number }> {
  const today = dayOf(now);
  const updated = await mutate(
    store,
    slug,
    (record) => ({
      ...record,
      msgCount: record.msgCount + 1,
      msgToday: record.msgDay === today ? record.msgToday + 1 : 1,
      msgDay: today,
    }),
    now,
  );
  return { today: updated.msgToday, total: updated.msgCount };
}

/**
 * The same count, written from a record already in hand.
 *
 * `bumpMessageCount` goes through `mutate`, which re-reads `shirts/<slug>.json`. The relay had
 * just read that object to decide whether the daily cap allowed the message at all, so every
 * message cost two GETs and a PUT where one GET and a PUT would do, on the product's core
 * action. status.md called this shot when the same shape was fixed for status writes: "one
 * wasted round trip; matters mainly because Phase 4's relay would inherit the shape". It did.
 *
 * The re-read bought nothing it looked like it bought. The cap decision was already made from
 * the older read, so the fresher base only moved the increment, and these counters are
 * documented as racy under burst either way: there is no compare-and-swap in this store.
 *
 * Same shape as `setStatusOn`, and for the same reason.
 */
export async function bumpMessageCountOn(
  store: ObjectStore,
  record: CodeRecord,
  now: number = Date.now(),
): Promise<{ today: number; total: number }> {
  const today = dayOf(now);
  const updated: CodeRecord = {
    ...record,
    msgCount: record.msgCount + 1,
    msgToday: record.msgDay === today ? record.msgToday + 1 : 1,
    msgDay: today,
  };
  await store.put(keyFor(record.slug), JSON.stringify(updated));
  return { today: updated.msgToday, total: updated.msgCount };
}

/**
 * Store what the code is for, and what it prints.
 *
 * Takes an already-validated `Design` rather than raw fields, so the washing happens once, in
 * `cleanDesign`, at the boundary the values arrived through. Nothing else about the code moves:
 * a purpose is not a fresh start, so the counters, the status and the activation date carry over
 * exactly as they do through a change of address.
 */
export function setDesign(
  store: ObjectStore,
  slug: string,
  design: Design,
  now: number = Date.now(),
): Promise<CodeRecord> {
  return mutate(
    store,
    slug,
    (record) => ({ ...record, syfte: design.syfte, rad: design.rad, etikett: design.etikett }),
    now,
  );
}

/**
 * Save the complete scanner experience in one object-store write.
 *
 * Purpose, printed text and form type are one save button in the UI. Writing them separately
 * would let a remote-storage failure leave the preview describing a survey while the scanner
 * still meets a greeting, or vice versa.
 */
export function setCodeSetup(
  store: ObjectStore,
  slug: string,
  design: Design,
  survey: SurveySetup,
  now: number = Date.now(),
): Promise<CodeRecord> {
  return mutate(
    store,
    slug,
    (record) => ({
      ...record,
      syfte: design.syfte,
      rad: design.rad,
      etikett: design.etikett,
      mode: survey.mode === "survey" ? "survey" : undefined,
      questions: survey.mode === "survey" ? survey.questions : undefined,
    }),
    now,
  );
}

/**
 * Point a code at a different owner address.
 *
 * The ciphertext is replaced rather than appended to. Someone who asks us to stop using an
 * address has asked us to stop holding it, so keeping the old one beside the new would be a
 * quiet refusal of exactly what they requested.
 *
 * Everything else is untouched: a change of address is not a fresh start, so the message count,
 * the status and the activation date all carry over.
 */
export async function setOwnerEmail(
  store: ObjectStore,
  key: CryptoKey,
  slug: string,
  email: string,
  now: number = Date.now(),
): Promise<CodeRecord> {
  const emailEnc = await encrypt(key, email);
  return mutate(store, slug, (record) => ({ ...record, emailEnc }), now);
}

/** Returns whether a record was actually there to remove. */
export function deleteCode(store: ObjectStore, slug: string): Promise<boolean> {
  return store.delete(keyFor(slug));
}

/**
 * Write a status onto a record already in hand.
 *
 * R15: the caller has usually just read this record to decide whether to touch it at all, and
 * `setStatus` would read the same key again. One wasted round trip is cheap on a laptop and
 * not on an edge isolate talking to object storage over the network.
 *
 * Last write wins, exactly as `mutate` does. These records are read-mostly and the only
 * concurrent writer is the message counter, which is why the counter has its own path.
 */
export async function setStatusOn(
  store: ObjectStore,
  record: CodeRecord,
  status: CodeStatus,
  now: number = Date.now(),
): Promise<CodeRecord> {
  const updated: CodeRecord = {
    ...record,
    status,
    // Stamped once, on first activation. Pausing and resuming must not rewrite history.
    verifiedAt: record.verifiedAt ?? (status === "active" ? now : null),
  };
  await store.put(keyFor(record.slug), JSON.stringify(updated));
  return updated;
}

/** Opened only at the moment a mail is sent, never held anywhere else. */
export function readOwnerEmail(key: CryptoKey, record: CodeRecord): Promise<string> {
  return decrypt(key, record.emailEnc);
}
