/**
 * POST /api/skapa
 *
 * The expensive public endpoint: it sends mail to an address the submitter chose, which is
 * the classic mail-bombing shape. Order matters here. Every cheap check runs before anything
 * is written and long before anything is sent, so a rejected attempt costs us a few
 * microseconds and costs the attacker a proof of work.
 *
 * The response never contains the slug. Without that rule, someone could sign up with a
 * stranger's address, keep the code, print it on a garment, and have every reply land in the
 * stranger's inbox. The code is revealed only after the verification link is clicked, which
 * means only to whoever controls the mailbox.
 */

import { spendSolution } from "../antispam/altcha.ts";
import { guardForm } from "../antispam/form.ts";
import { normalizeEmail } from "../mail/address.ts";
import { sendMail } from "../mail/smtp2go.ts";
import { renderVerifyMail } from "../mail/templates.ts";
import { claimSignupSlot, linkCodeToEmail } from "../store/emails.ts";
import { createCode } from "../store/shirts.ts";
import { mintToken } from "../store/tokens.ts";
import { isScanMode } from "../survey.ts";
import { error, info } from "../log.ts";
import { type AppContext, json, methodNotAllowed, refuse } from "./context.ts";

interface SignupBody {
  epost?: unknown;
  hemsida?: unknown;
  startedAt?: unknown;
  altcha?: unknown;
  mode?: unknown;
}

async function readBody(request: Request): Promise<SignupBody | null> {
  try {
    const parsed = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as SignupBody;
  } catch {
    return null;
  }
}

export async function handleSignup(ctx: AppContext, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const body = await readBody(request);
  if (!body) return refuse();

  const now = ctx.now();

  // Cheapest first, and all of them before a single byte is written or sent.
  const rejection = guardForm({
    honeypot: typeof body.hemsida === "string" ? body.hemsida : "",
    startedAt: typeof body.startedAt === "number" ? body.startedAt : Number.NaN,
  }, now);
  if (rejection) {
    info("signup refused", { reason: rejection });
    return refuse();
  }

  const altcha = typeof body.altcha === "string" ? body.altcha : "";
  if (!await spendSolution(ctx.store, ctx.config.altchaHmacKey, altcha, now)) {
    info("signup refused", { reason: "altcha" });
    return refuse();
  }

  // A malformed address is the user's own typo, so unlike the checks above it earns a
  // message they can act on. It still reaches this point having done the proof of work.
  const email = normalizeEmail(typeof body.epost === "string" ? body.epost : "");
  if (!email) {
    return json({ fel: "Det där ser inte ut som en mailadress." }, 400);
  }

  // Missing means the original greeting for forms cached before surveys shipped. A value that
  // names neither option is a user-correctable bad request, not something to guess at.
  const submittedMode = body.mode === undefined ? "greeting" : body.mode;
  if (!isScanMode(submittedMode)) {
    return json({ fel: "Välj vad som ska hända efter skanningen." }, 400);
  }

  const slot = await claimSignupSlot(ctx.store, email, now);
  if (!slot.allowed) {
    // Says plainly that the cap was hit. It reveals that this address has codes today,
    // which is a small disclosure to someone who already knows the address, and the
    // alternative is telling people to check a mailbox nothing will ever arrive in.
    info("signup capped");
    return json({ fel: "Den här adressen har skapat för många koder idag. Försök imorgon." }, 429);
  }

  // The store is a remote HTTP service, so any of these writes can fail. Previously only
  // the mail send was guarded, which meant a storage blip surfaced as an uncaught throw
  // after the user's daily slot had already been taken.
  let record;
  let token;
  try {
    record = await createCode(ctx.store, ctx.emailKey, email, now, submittedMode);
    // Recorded now so the owner can ask for a manage link by address later, without having
    // to remember a 20-character slug that lives on a garment.
    await linkCodeToEmail(ctx.store, email, record.slug);
    token = (await mintToken(ctx.store, record.slug, "verify", now)).token;
  } catch (cause) {
    error("could not create code", { message: String(cause) });
    return json({ fel: "Vi kunde inte skapa koden just nu. Försök igen om en stund." }, 502);
  }

  const mail = renderVerifyMail({
    verifieraUrl: `${ctx.config.baseUrl}/verifiera?t=${token}`,
  });

  try {
    await sendMail(
      ctx.config.smtp2go,
      { to: email, subject: mail.subject, textBody: mail.text, htmlBody: mail.html },
      ctx.fetch,
    );
  } catch (cause) {
    // Saying "check your mail" when no mail went would be a lie. The pending record is left
    // to expire on its own after seven days rather than deleted here, because the send may
    // have happened and only the acknowledgement failed.
    error("verification mail failed", { slug: record.slug, message: String(cause) });
    return json({ fel: "Vi kunde inte skicka mailet just nu. Försök igen om en stund." }, 502);
  }

  info("code created", { used: slot.used });
  return json({ ok: true });
}
