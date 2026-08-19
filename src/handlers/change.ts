/**
 * GET and POST /byt-epost
 *
 * The second half of changing an owner address. The first half, in `manage.ts`, only asks: it
 * mints a change token carrying the proposed address and mails a link to that address. Nothing
 * has moved when that happens.
 *
 * This is where it moves, and only for someone who can read mail at the new address. That split
 * is the whole security of the feature. A management link lives in an inbox, so if asking were
 * enough, one compromised mailbox would be enough to redirect every future message to an address
 * of an attacker's choosing. Making the new address answer for itself means an attacker has to
 * hold both the old inbox and the new one, and the warning mail to the old address means the
 * real owner hears about the attempt either way.
 *
 * GET peeks and POST consumes, for the same reason as `/verifiera`: mail security gateways fetch
 * every link at delivery, and a change completed by a scanner would be a change nobody chose.
 *
 * Every failure looks identical from outside: unknown, spent, expired, wrong purpose, deleted
 * code, or a payload that will not decrypt all land on the same page.
 */

import { decrypt } from "../store/crypto.ts";
import { codesForEmailHash, linkCodeToEmail, unlinkCodeFromEmail } from "../store/emails.ts";
import { type CodeRecord, getCode, readOwnerEmail, setOwnerEmail } from "../store/shirts.ts";
import { consumeToken, peekToken } from "../store/tokens.ts";
import { normalizeEmail } from "../mail/address.ts";
import { error, info } from "../log.ts";
import { renderBytEpostConfirm, renderBytEpostFailed } from "../pages/byt-epost.ts";
import { type AppContext, methodNotAllowed } from "./context.ts";

/** Same-origin path only. A redirect built from user input is an open redirect. */
function go(path: string): Response {
  return new Response(null, { status: 303, headers: { location: path } });
}

async function tokenFrom(request: Request): Promise<string> {
  if (request.method === "GET") return new URL(request.url).searchParams.get("t") ?? "";

  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    return String(form.get("t") ?? "");
  }
  try {
    const body = await request.json();
    return typeof body?.t === "string" ? body.t : "";
  } catch {
    return "";
  }
}

export async function handleEmailChange(ctx: AppContext, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }

  const token = await tokenFrom(request);
  const now = ctx.now();

  if (request.method === "GET") {
    const claim = await peekToken(ctx.store, token, now);
    if (!claim || claim.purpose !== "change") {
      info("email change refused", { reason: claim ? "wrong-purpose" : "no-claim" });
      return renderBytEpostFailed();
    }
    // Nothing is spent and nothing is written, so a scanner fetching this changes nothing.
    return renderBytEpostConfirm(token);
  }

  const claim = await consumeToken(ctx.store, token, now);
  if (!claim || claim.purpose !== "change") {
    info("email change refused", { reason: claim ? "wrong-purpose" : "no-claim" });
    return renderBytEpostFailed();
  }

  // Every code on the address moves, because the address is what is moving. The button that
  // starts this is not attached to a code, so "which one" has no answer to give.
  const slugs = await codesForEmailHash(ctx.store, claim.epost);
  const records: CodeRecord[] = [];
  for (const slug of slugs) {
    // A code may have been deleted since the mail went out, which is exactly what the warning
    // to the old address tells a suspicious owner to do. The others still move.
    const record = await getCode(ctx.store, slug, now);
    if (record) records.push(record);
  }
  if (records.length === 0) {
    info("email change refused", { reason: "no-code" });
    return renderBytEpostFailed();
  }

  let nyAdress: string;
  let gammalAdress: string;
  try {
    // Corrupt, truncated, or encrypted under a different key. In every case we do not know
    // where this was meant to go, and guessing points a code at the wrong inbox forever.
    nyAdress = normalizeEmail(await decrypt(ctx.emailKey, claim.data)) ?? "";
    gammalAdress = await readOwnerEmail(ctx.emailKey, records[0]!);
  } catch (cause) {
    error("email change payload unreadable", { message: String(cause) });
    return renderBytEpostFailed();
  }
  if (!nyAdress) return renderBytEpostFailed();

  for (const record of records) {
    await setOwnerEmail(ctx.store, ctx.emailKey, record.slug, nyAdress, now);

    // Index second, and unlink before link. If this half fails the address has still moved, so
    // the code is reachable from the new inbox through the address's own management link either
    // way, and the worst case is a stale entry rather than an old owner keeping a route in.
    await unlinkCodeFromEmail(ctx.store, gammalAdress, record.slug);
    await linkCodeToEmail(ctx.store, nyAdress, record.slug);
  }

  info("owner address changed", { codes: records.length });
  return go("/bytt");
}
