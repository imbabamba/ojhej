/**
 * POST /api/meddelande
 *
 * The point of the whole product: a stranger's message, relayed to an owner who never had to
 * publish an address.
 *
 * Order is load-bearing here for a different reason than signup. The daily cap is checked
 * and taken *before* the SMTP2GO call, so a capped code costs no quota. And the owner's
 * address is decrypted at the last possible moment, held only for the duration of the send.
 *
 * Every field here is typed by a stranger into a public form. None of it goes into a header,
 * the subject is static, and the mail templates escape everything they interpolate.
 */

import { spendSolution } from "../antispam/altcha.ts";
import { guardForm } from "../antispam/form.ts";
import { isValidSlug } from "../store/crypto.ts";
import { bumpMessageCountOn, getCode, readOwnerEmail } from "../store/shirts.ts";
import { sendMail } from "../mail/smtp2go.ts";
import { type ContactChannel, renderMessageMail } from "../mail/templates.ts";
import { error, info } from "../log.ts";
import { type AppContext, json, methodNotAllowed, refuse } from "./context.ts";

/** Protects the SMTP2GO quota even if every other layer is defeated. */
export const MAX_MESSAGES_PER_DAY = 20;

const LIMITS = { namn: 80, var: 120, meddelande: 600, kontakt: 120 };

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

export async function handleMessage(ctx: AppContext, request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refuse();
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse();
  }

  const now = ctx.now();

  // Cheap, pure checks first, before any storage read or send.
  const rejection = guardForm({
    honeypot: typeof body.hemsida === "string" ? body.hemsida : "",
    startedAt: typeof body.startedAt === "number" ? body.startedAt : Number.NaN,
  }, now);
  if (rejection) {
    info("message refused", { reason: rejection });
    return refuse();
  }

  if (!await spendSolution(ctx.store, ctx.config.altchaHmacKey, String(body.altcha ?? ""), now)) {
    info("message refused", { reason: "altcha" });
    return refuse();
  }

  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!isValidSlug(slug)) return refuse();

  const namn = text(body.namn, LIMITS.namn);
  const varSags = text(body.var, LIMITS.var);
  const meddelande = text(body.meddelande, LIMITS.meddelande);
  const kontakt = text(body.kontakt, LIMITS.kontakt);
  const kanal = body.kanal;
  const validChannel = kanal === "mail" || kanal === "instagram" || kanal === "telefon";

  if (!namn || !varSags || !meddelande || !kontakt || !validChannel) {
    return json({ fel: "Fyll i alla fält." }, 400);
  }

  const record = await getCode(ctx.store, slug, now);
  // Unknown, pending and paused all answer the same way. A sender must not be able to probe
  // a code's state through this endpoint when the page already tells them what they need.
  if (!record || record.status !== "active") {
    info("message refused", { reason: record ? record.status : "no-code" });
    return json({ fel: "Den här koden tar inte emot meddelanden just nu." }, 409);
  }

  const today = Math.floor(now / 86_400_000);
  const usedToday = record.msgDay === today ? record.msgToday : 0;
  if (usedToday >= MAX_MESSAGES_PER_DAY) {
    // Before the send, deliberately: a capped code must cost no SMTP2GO quota.
    info("message capped", { slug });
    return json({ fel: "Koden har tagit emot många meddelanden idag. Prova imorgon." }, 429);
  }

  // Written from the record read six lines up rather than re-read. The cap decision above was
  // made from that same read, so a fresher base moves nothing but the increment, and these
  // counters race under burst regardless. One round trip saved on every message sent.
  const counted = await bumpMessageCountOn(ctx.store, record, now);

  let mail;
  try {
    // Decrypted at the last possible moment and never held anywhere else.
    const to = await readOwnerEmail(ctx.emailKey, record);
    mail = renderMessageMail({
      namn,
      var: varSags,
      meddelande,
      kanal: kanal as ContactChannel,
      kontakt,
      antalIdag: counted.today,
      maxPerDag: MAX_MESSAGES_PER_DAY,
      slugKort: `ojhej.se/s/${slug.slice(0, 4)}…${slug.slice(-4)}`,
      hanteraUrl: `${ctx.config.baseUrl}/hantera`,
    });

    await sendMail(ctx.config.smtp2go, {
      to,
      subject: mail.subject,
      textBody: mail.text,
      htmlBody: mail.html,
      // The owner's own address. Never the visitor's, whatever they typed.
      replyTo: to,
    }, ctx.fetch);
  } catch (cause) {
    error("message relay failed", { slug, message: String(cause) });
    return json({ fel: "Vi kunde inte skicka meddelandet just nu. Försök igen." }, 502);
  }

  info("message relayed", { slug, today: counted.today });
  return json({ ok: true });
}
