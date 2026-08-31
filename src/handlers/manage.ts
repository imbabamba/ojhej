/**
 * Owner controls: request a link, then act on one of your codes.
 *
 * Two endpoints, and the split between them is the security design rather than tidiness.
 *
 * `POST /api/hantera` sends one magic link to the address on the codes. It answers identically
 * whether or not that address has any codes, because otherwise it becomes an oracle for
 * "does this person use ojhej".
 *
 * `POST /api/hantera/atgard` performs the action and is the only place the token is spent.
 * The page at `GET /hantera` merely peeks. That ordering exists because mail gateways
 * prefetch links: consuming on GET would burn the token before the owner ever clicked, and
 * they would meet a generic failure with no way to tell why.
 *
 * **The token names an address now, not a code**, so the caller names the code and this module
 * has to check that the code belongs to that address. That check is the feature's security
 * boundary rather than a detail of it: OWASP API1:2023 asks for exactly this in every function
 * that takes a record id from a client, and `research-2026-08-15-flera-koder.md` quotes it. It
 * runs on a peek first, so naming somebody else's code costs an honest owner nothing, and again
 * after the token is spent, because the peek proves only what was true a moment ago.
 *
 * Deleting is genuinely destructive and deliberately so. There is no soft delete to quietly
 * retain an address the owner asked us to forget.
 */

import { spendSolution } from "../antispam/altcha.ts";
import { guardForm } from "../antispam/form.ts";
import { normalizeEmail } from "../mail/address.ts";
import { sendMail } from "../mail/smtp2go.ts";
import {
  renderEmailChangeMail,
  renderEmailChangeNoticeMail,
  renderKoderMail,
} from "../mail/templates.ts";
import {
  claimManageLinkSlot,
  codesForEmailHash,
  emailHash,
  linkCodeToEmail,
  MAX_CODES_PER_EMAIL,
  unlinkCodeFromEmail,
} from "../store/emails.ts";
import {
  type CodeRecord,
  createCode,
  deleteCode,
  getCode,
  readOwnerEmail,
  setCodeSetup,
  setStatus,
  setStatusOn,
} from "../store/shirts.ts";
import { countActivation } from "../store/stats.ts";
import {
  consumeToken,
  mintEmailToken,
  mintToken,
  peekToken,
  type TokenClaim,
} from "../store/tokens.ts";
import { encrypt, isValidSlug } from "../store/crypto.ts";
import { cleanDesign, type Design, syfteOf, visningsnamn } from "../syfte.ts";
import { cleanSurveySetup, type SurveySetup } from "../survey.ts";
import { error, info } from "../log.ts";
import { type AppContext, json, methodNotAllowed, refuse } from "./context.ts";

/** The same answer whether or not the address is known here. */
const SENT = {
  ok: true,
  meddelande: "Om adressen har en kod har vi skickat en länk till den.",
};

/**
 * One answer for "not yours", "never existed" and "deleted a moment ago".
 *
 * Three answers would turn this endpoint into a way to ask whether a slug photographed off a
 * jacket is a real code, which is the one thing the two-secret model does not want to give away.
 */
function noSuchCode(): Response {
  return json({ fel: "Koden finns inte längre." }, 404);
}

function expired(): Response {
  return json({ fel: "Länken gäller inte längre. Begär en ny." }, 403);
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function handleManageRequest(ctx: AppContext, request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const body = await readBody(request);
  if (!body) return refuse();

  const now = ctx.now();

  const rejection = guardForm({
    honeypot: typeof body.hemsida === "string" ? body.hemsida : "",
    startedAt: typeof body.startedAt === "number" ? body.startedAt : Number.NaN,
  }, now);
  if (rejection) {
    info("manage link refused", { reason: rejection });
    return refuse();
  }

  if (!await spendSolution(ctx.store, ctx.config.altchaHmacKey, String(body.altcha ?? ""), now)) {
    info("manage link refused", { reason: "altcha" });
    return refuse();
  }

  const email = normalizeEmail(typeof body.epost === "string" ? body.epost : "");
  // Even a malformed address gets the same answer. Saying "that is not an address" is fine on
  // signup, where the user is creating something; here it would help someone probe.
  if (!email) return json(SENT);

  // Capped per address per day, and the cap is claimed before anything is read or sent.
  //
  // This was the one mail-sending endpoint with nothing but the proof of work in front of it.
  // Signup has `claimSignupSlot`, the relay has its daily cap, creation has MAX_CODES_PER_EMAIL;
  // this had none, so one solved challenge bought one more mail carrying a live 30-minute token
  // that reaches every code the address owns. Unbounded, to a confirmed owner, from a domain
  // they trust.
  //
  // Refusal answers SENT like every other outcome here. A cap that announced itself would turn
  // this endpoint into the registration oracle the identical answers exist to prevent.
  const hash = await emailHash(email);
  const slot = await claimManageLinkSlot(ctx.store, hash, now);
  if (!slot.allowed) {
    info("manage link refused", { reason: "capped" });
    return json(SENT);
  }

  const slugs = await codesForEmailHash(ctx.store, hash);
  if (slugs.length === 0) {
    info("manage link requested for an unknown address");
    return json(SENT);
  }

  // The index can name a code that has since been deleted or aged out. Listing one would be a
  // mail about nothing, and a link to a page that cannot show it.
  //
  // Read in parallel: this runs on an edge isolate against object storage over the network, and
  // an address may own ten codes, so ten sequential round trips is ten times the wait for the
  // person who just pressed the button.
  const records: CodeRecord[] = (await Promise.all(
    slugs.map((slug) => getCode(ctx.store, slug, now)),
  )).filter((record) => record !== null);
  if (records.length === 0) return json(SENT);

  try {
    // One mail and one token, however many codes. The old shape minted a token per code and sent
    // a mail per code: three identical mails at three codes, and unusable at eight.
    const { token } = await mintEmailToken(ctx.store, hash, "koder", now);
    const mail = renderKoderMail({
      hanteraUrl: `${ctx.config.baseUrl}/hantera?t=${token}`,
      // Printed labels, never addresses. This is the mail most likely to be forwarded.
      koder: records.map((record) => ({
        namn: visningsnamn(record),
        syfte: syfteOf(record),
        status: record.status,
      })),
    });

    await sendMail(ctx.config.smtp2go, {
      to: email,
      subject: mail.subject,
      textBody: mail.text,
      htmlBody: mail.html,
    }, ctx.fetch);
  } catch (cause) {
    error("manage link mail failed", { message: String(cause) });
    return json({ fel: "Vi kunde inte skicka mailet just nu. Försök igen om en stund." }, 502);
  }

  info("manage link sent", { codes: records.length });
  return json(SENT);
}

export type ManageAction =
  | "pausa"
  | "ateruppta"
  | "radera"
  | "byt-epost"
  | "syfte"
  | "oppna"
  | "skapa";

const ACTIONS: readonly string[] = [
  "pausa",
  "ateruppta",
  "radera",
  "byt-epost",
  "syfte",
  "oppna",
  "skapa",
];

/** The actions that operate on one named code. The rest belong to the address. */
const CODE_ACTIONS: readonly ManageAction[] = ["pausa", "ateruppta", "radera", "syfte", "oppna"];

/**
 * Every code this claim may act on.
 *
 * A code token grants exactly the one it names. An address token grants whatever the reverse
 * index says that address owns *now*, which is what lets a code created after the link was
 * minted still appear behind it.
 */
function grantedCodes(ctx: AppContext, claim: TokenClaim): Promise<string[]> {
  if (claim.purpose === "manage") return Promise.resolve([claim.slug]);
  if (claim.purpose === "koder") return codesForEmailHash(ctx.store, claim.epost);
  return Promise.resolve([]);
}

/**
 * The address behind an address token, read back from a code it owns.
 *
 * The token carries a hash, deliberately, so nothing about an address can be recovered from a
 * token record. When an action genuinely needs the address, to encrypt it into a new record or
 * to mail it, it comes from the ciphertext on a code that address already owns.
 */
async function ownerOf(ctx: AppContext, slugs: string[], now: number): Promise<string | null> {
  for (const slug of slugs) {
    const record = await getCode(ctx.store, slug, now);
    if (!record) continue;
    try {
      return await readOwnerEmail(ctx.emailKey, record);
    } catch {
      // An undecryptable record is not a reason to guess. Try the next code this address owns.
      continue;
    }
  }
  return null;
}

export async function handleManageAction(ctx: AppContext, request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const body = await readBody(request);
  if (!body) return refuse();

  const now = ctx.now();
  const action = body.atgard;
  if (typeof action !== "string" || !ACTIONS.includes(action)) {
    return json({ fel: "Okänd åtgärd." }, 400);
  }
  const atgard = action as ManageAction;

  // Everything above the token is a typo the owner can correct; sending them back to their inbox
  // for one would be its own small cruelty.
  const nyAdress = atgard === "byt-epost"
    ? normalizeEmail(typeof body.epost === "string" ? body.epost : "")
    : null;
  if (atgard === "byt-epost" && !nyAdress) {
    return json({ fel: "Det där ser inte ut som en mailadress." }, 400);
  }

  let design: Design | null = null;
  let survey: SurveySetup | null = null;
  if (atgard === "syfte") {
    design = cleanDesign({ syfte: body.syfte, rad: body.rad, etikett: body.etikett });
    if (!design) return json({ fel: "Det där syftet känner vi inte igen." }, 400);
    survey = cleanSurveySetup({ mode: body.mode, questions: body.questions });
    if (!survey) {
      return json({ fel: "En enkät behöver 2–5 korta frågor." }, 400);
    }
  }

  // Peek first. The membership check below decides whether this request is allowed at all, and a
  // refusal must not cost an honest owner the link they are holding.
  const peeked = await peekToken(ctx.store, String(body.t ?? ""), now);
  if (!peeked || (peeked.purpose !== "manage" && peeked.purpose !== "koder")) {
    info("manage action refused", { reason: peeked ? "wrong-purpose" : "no-claim" });
    return expired();
  }

  const named = typeof body.slug === "string" ? body.slug : null;
  const wanted = CODE_ACTIONS.includes(atgard)
    // A code token may leave the slug out: it names exactly one code and there is nothing to
    // choose. Naming a different one is refused rather than quietly ignored.
    ? (named ?? (peeked.purpose === "manage" ? peeked.slug : null))
    : null;

  if (CODE_ACTIONS.includes(atgard)) {
    if (wanted === null || !isValidSlug(wanted)) return noSuchCode();
    if (!(await grantedCodes(ctx, peeked)).includes(wanted)) {
      info("manage action refused", { reason: "not-granted" });
      return noSuchCode();
    }
    // A code deleted since the mail went out. Refused here so the link survives it.
    if (!await getCode(ctx.store, wanted, now)) return noSuchCode();
  }

  // The address actions need an address, which only an address token has.
  if ((atgard === "skapa" || atgard === "byt-epost") && peeked.purpose !== "koder") {
    info("manage action refused", { reason: "wrong-scope" });
    return expired();
  }

  if (atgard === "skapa" && (await grantedCodes(ctx, peeked)).length >= MAX_CODES_PER_EMAIL) {
    info("code creation capped");
    return json(
      { fel: `Du har ${MAX_CODES_PER_EMAIL} koder, vilket är så många vi tillåter per adress.` },
      429,
    );
  }

  // The token is spent here and nowhere else, so a prefetched GET cannot burn it and a
  // replayed action cannot happen twice.
  const claim = await consumeToken(ctx.store, String(body.t ?? ""), now);
  if (!claim || (claim.purpose !== "manage" && claim.purpose !== "koder")) {
    info("manage action refused", { reason: claim ? "wrong-purpose" : "no-claim" });
    return expired();
  }

  // Again, against the claim that was actually spent. The peek proved what was true a moment
  // ago, which is not the same as what is true now, and only this one is load-bearing.
  const granted = await grantedCodes(ctx, claim);
  if (wanted !== null && !granted.includes(wanted)) {
    info("manage action refused", { reason: "not-granted" });
    return noSuchCode();
  }

  /** A fresh link of the same reach, so the page keeps working without a trip to the inbox. */
  const renew = async (): Promise<string> => {
    if (claim.purpose === "koder") {
      return (await mintEmailToken(ctx.store, claim.epost, "koder", now)).token;
    }
    return (await mintToken(ctx.store, claim.slug, "manage", now)).token;
  };

  if (atgard === "skapa") {
    if (claim.purpose !== "koder") return expired();

    const email = await ownerOf(ctx, granted, now);
    if (!email) return expired();

    let record: CodeRecord;
    try {
      record = await createCode(ctx.store, ctx.emailKey, email, now);
      await linkCodeToEmail(ctx.store, email, record.slug);
      // Active at once. The address is verified already and the link that authorised this was
      // single-use and has just been spent, so there is nothing left for a mail to prove.
      await setStatusOn(ctx.store, record, "active", now);
    } catch (cause) {
      error("could not create code", { message: String(cause) });
      return json({ fel: "Vi kunde inte skapa koden just nu. Försök igen om en stund." }, 502);
    }

    // Counted here as well as at verification, because this is the other way a code comes alive.
    await countActivation(ctx.store);
    info("code created from the list");

    const { token } = await mintToken(ctx.store, record.slug, "manage", now);
    return json({ ok: true, next: `/klar?t=${token}` });
  }

  if (atgard === "byt-epost" && nyAdress) {
    if (claim.purpose !== "koder") return expired();

    // Nothing moves here. The proposed address rides inside the token, encrypted with the same
    // key as the owner record, and the change happens only when that address answers for
    // itself at /byt-epost. A management link lives in an inbox, so treating "asked from a
    // valid link" as proof of the new address would make one compromised mailbox enough to
    // redirect every future message.
    const gammalAdress = await ownerOf(ctx, granted, now);
    if (!gammalAdress) return expired();

    try {
      const { token } = await mintEmailToken(
        ctx.store,
        claim.epost,
        "change",
        now,
        await encrypt(ctx.emailKey, nyAdress),
      );

      const flera = granted.length > 1;
      const confirm = renderEmailChangeMail({
        bekraftaUrl: `${ctx.config.baseUrl}/byt-epost?t=${token}`,
        flera,
      });
      await sendMail(ctx.config.smtp2go, {
        to: nyAdress,
        subject: confirm.subject,
        textBody: confirm.text,
        htmlBody: confirm.html,
      }, ctx.fetch);

      // The old address hears about it either way. If someone reached that inbox and is moving
      // the codes, this notice is the only warning the real owner would ever get.
      const notice = renderEmailChangeNoticeMail({ nyAdress, flera });
      await sendMail(ctx.config.smtp2go, {
        to: gammalAdress,
        subject: notice.subject,
        textBody: notice.text,
        htmlBody: notice.html,
      }, ctx.fetch);
    } catch (cause) {
      error("email change request failed", { message: String(cause) });
      return json({ fel: "Vi kunde inte skicka mailet just nu. Försök igen om en stund." }, 502);
    }

    info("email change requested", { codes: granted.length });
    return json({ ok: true, next: "/kolla-mailen?byte" });
  }

  // Everything below names a code, and `wanted` has been checked against the claim twice.
  const slug = wanted;
  if (slug === null) return noSuchCode();

  if (atgard === "oppna") {
    const { token } = await mintToken(ctx.store, slug, "manage", now);
    return json({ ok: true, next: `/klar?t=${token}` });
  }

  if (atgard === "syfte" && design && survey) {
    try {
      await setCodeSetup(ctx.store, slug, design, survey, now);
    } catch {
      // Deleted between the check and here. Nothing was written.
      return noSuchCode();
    }
    info("code setup saved", { syfte: design.syfte, mode: survey.mode });
    // A code-scoped link back, because the page this answers is one code's own page.
    const { token } = await mintToken(ctx.store, slug, "manage", now);
    return json({ ok: true, t: token });
  }

  if (atgard === "radera") {
    // Read before the delete destroys it. Afterwards there is no way back to the address, and
    // the index would keep a row for a code that no longer exists, which every future mail
    // would then name.
    const email = await ownerOf(ctx, [slug], now);

    await deleteCode(ctx.store, slug);
    if (email) await unlinkCodeFromEmail(ctx.store, email, slug);
    info("code deleted");

    const left = granted.filter((one) => one !== slug);
    if (left.length === 0) return json({ ok: true, next: "/raderad" });
    return json({ ok: true, next: `/hantera?t=${await renew()}` });
  }

  const status = atgard === "pausa" ? "paused" : "active";
  await setStatus(ctx.store, slug, status, now);
  info("code status changed", { status });

  return json({ ok: true, next: `/hantera?t=${await renew()}` });
}
