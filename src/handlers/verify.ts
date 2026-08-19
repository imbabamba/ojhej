/**
 * GET and POST /verifiera
 *
 * The moment a code becomes real. Two things happen here and nowhere else: the record flips
 * from pending to active, and the slug is handed to the owner. Signup deliberately withholds
 * it, so clicking a link in the mailbox is the only way to learn which code is yours. That is
 * what stops someone signing up with a stranger's address, printing the code, and having every
 * reply land in the stranger's inbox.
 *
 * The GET only looks. It peeks at the token and renders a confirmation page; the POST behind
 * that page's button is what spends it. That split exists because mail security gateways fetch
 * every link in a message at delivery: consuming on GET meant a scanner could burn the token
 * before the owner ever clicked, leaving them unable to activate and with nothing to explain
 * why. Scanners do not submit forms.
 *
 * Every failure looks the same from outside: unknown token, spent token, expired token, a
 * manage token used in the wrong place, or a code deleted in the meantime all land on the same
 * page. Probing this endpoint teaches an attacker nothing.
 */

import { consumeToken, mintToken, peekToken } from "../store/tokens.ts";
import { getCode, setStatusOn } from "../store/shirts.ts";
import { countActivation } from "../store/stats.ts";
import { info } from "../log.ts";
import { renderVerifieraConfirm, renderVerifieraFailed } from "../pages/verifiera.ts";
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

export async function handleVerify(ctx: AppContext, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }

  const token = await tokenFrom(request);
  const now = ctx.now();

  // A verification link may only verify. Management links are short-lived and gate deletion,
  // so letting one act here would collapse the two lifetimes into whichever suits an attacker.
  if (request.method === "GET") {
    const claim = await peekToken(ctx.store, token, now);
    if (!claim || claim.purpose !== "verify") {
      info("verification refused", { reason: claim ? "wrong-purpose" : "no-claim" });
      return renderVerifieraFailed();
    }
    // Nothing is spent and nothing is written, so a scanner fetching this changes nothing.
    return renderVerifieraConfirm(token);
  }

  const claim = await consumeToken(ctx.store, token, now);
  if (!claim || claim.purpose !== "verify") {
    info("verification refused", { reason: claim ? "wrong-purpose" : "no-claim" });
    return renderVerifieraFailed();
  }

  // The code may have been deleted, or aged out of its pending window, since the mail went.
  const record = await getCode(ctx.store, claim.slug, now);
  if (!record) {
    info("verification refused", { reason: "no-code" });
    return renderVerifieraFailed();
  }

  // Written from the record already in hand rather than re-read: this runs on an edge isolate
  // talking to object storage over the network, where a wasted round trip is real latency.
  // verifiedAt is stamped only on first activation, so a second valid link is a no-op rather
  // than a rewrite of when this code came to life.
  // Only the first activation counts. A second valid link for the same code is a no-op here
  // exactly as it is for verifiedAt, so the landing page figure counts codes rather than clicks.
  const firstTime = record.verifiedAt === null;

  await setStatusOn(ctx.store, record, "active", now);
  if (firstTime) await countActivation(ctx.store);

  info("code activated");

  // A management link for this code alone, minted here and handed over in the redirect.
  //
  // That is what authorises the purpose picker on the page it lands on. `/klar?kod=` is
  // reachable by anyone who has seen the garment, since the slug is printed in public, so the
  // controls that write to the record cannot live behind the slug. Anders' call, 2026-08-15.
  //
  // The slug leaves the URL as a side effect, which is a small improvement: it used to sit in a
  // query string that a browser keeps in history and a person can read over a shoulder.
  const nyckel = await mintToken(ctx.store, claim.slug, "manage", now);
  return go(`/klar?t=${nyckel.token}`);
}
