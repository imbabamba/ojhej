// deno-lint-ignore-file no-console
// Local dev entrypoint: the console IS the interface here (startup banner, captured mail
// links, unhandled-error dump). Structured JSON lines are for the edge runtime, where there
// is no human watching a terminal. Application logging still goes through log.ts.

/**
 * Local development entrypoint.
 *
 * Not the Bunny edge script. On Bunny the shape is a middleware attached to a Pull Zone
 * (`BunnySDK.net.http.servePullZone(...).onOriginRequest(...)`) and static files come from a
 * Storage Zone. This file exists so the same handlers can be run and driven on a laptop with
 * no cloud account: `Deno.serve` in front, filesystem storage underneath, and mail captured
 * to disk instead of sent. The routing table below is the contract the edge script will
 * implement, so both stay in step.
 *
 * Run with:  deno task dev
 */

import {
  contactCodeProblem,
  devConfig,
  importEmailKey,
  loadConfig,
  parseEnvFile,
} from "./config.ts";
import { createFsStore } from "./store/fs.ts";
import { type AppContext, json } from "./handlers/context.ts";
import { route } from "./route.ts";
import { setMailBaseUrl } from "./mail/templates.ts";
import { getCode } from "./store/shirts.ts";
import { setContactCode } from "./pages/layout.ts";
import { info, warn } from "./log.ts";

const DEV = Deno.args.includes("--dev");
const PORT = Number(Deno.env.get("PORT") ?? 8787);
const DATA_DIR = Deno.env.get("OJHEJ_DATA") ?? ".devdata";
const MAIL_DIR = Deno.env.get("OJHEJ_MAILBOX") ?? ".devmail";

/**
 * Dev mail transport. `sendMail` takes its `fetch` by injection, so capturing mail needs no
 * production code change at all: this simply answers the SMTP2GO endpoint with the success
 * shape and writes what would have been sent to disk. The verification URL is echoed to the
 * console, which is what makes the flow clickable without a mail account.
 */
/** Monotonic within a run, which is all the uniqueness a filename needs here. */
let captured = 0;

function mailCapturingFetch(realFetch: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.includes("/email/send")) return realFetch(input as string, init);

    const mail = JSON.parse(String(init.body)) as {
      to: string[];
      subject: string;
      text_body: string;
      html_body: string;
    };

    await Deno.mkdir(MAIL_DIR, { recursive: true });
    // A sequence number after the timestamp, because the timestamp alone is not unique.
    //
    // Two mails sent in the same millisecond produced the same filename and the second
    // overwrote the first, silently losing a message. The change-of-address flow sends two back
    // to back, so it was the one that caught it: locally the pair landed 1 ms apart and passed,
    // on CI they landed together and the flow reported one mail where it expected two.
    //
    // The counter is zero padded so filenames still sort chronologically as strings, which is
    // how the flow scripts read them back.
    const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${
      String(++captured).padStart(4, "0")
    }`;
    await Deno.writeTextFile(`${MAIL_DIR}/${stamp}.html`, mail.html_body);
    // A short header ahead of the body, so a flow script can assert who a mail actually
    // reached. Several of these templates deliberately never name the recipient, which is
    // right for the mail and useless for checking delivery.
    await Deno.writeTextFile(
      `${MAIL_DIR}/${stamp}.txt`,
      `To: ${mail.to.join(", ")}
Subject: ${mail.subject}

${mail.text_body}`,
    );

    const link = mail.text_body.match(/https?:\/\/\S+/)?.[0];
    info("dev mail captured", {
      subject: mail.subject,
      to: mail.to,
      file: `${MAIL_DIR}/${stamp}.html`,
    });
    if (link) console.log(`\n  -> ${mail.subject}\n     ${link}\n`);

    return new Response(JSON.stringify({ data: { succeeded: 1, email_id: "dev" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  woff2: "font/woff2",
  png: "image/png",
};

/**
 * Static assets that make up the real site: two stylesheets, one script, and the fonts.
 *
 * An allowlist rather than a directory walk. `public/` is not a document root and never becomes
 * one by accident: anything not matched here is simply not served, so no traversal or dotfile
 * question arises at all. In production the CDN serves these and this path is unused.
 */
const ASSET = /^(style\.css|fonts\.css|app\.js|mark\.png|fonts\/[a-z0-9-]+\.woff2)$/;

async function serveAsset(path: string): Promise<Response | null> {
  const name = path.replace(/^\/+/, "");
  if (!ASSET.test(name)) return null;
  try {
    const body = await Deno.readFile(`public/${name}`);
    const type = CONTENT_TYPES[name.split(".").pop() ?? ""] ?? "text/plain";
    return new Response(body, {
      headers: {
        "content-type": type,
        // Fonts are content-addressed by family, style and subset, so they may be held a
        // long time. They are also the one asset a repeat visitor should never refetch.
        ...(name.endsWith(".woff2")
          ? { "cache-control": "public, max-age=31536000, immutable" }
          : {}),
      },
    });
  } catch {
    return null;
  }
}

/** Reads .env if present, without overriding anything already set in the real environment. */
async function readEnvFile(path = ".env"): Promise<Record<string, string | undefined>> {
  const env = Deno.env.toObject() as Record<string, string | undefined>;
  try {
    for (const [name, value] of Object.entries(parseEnvFile(await Deno.readTextFile(path)))) {
      if (env[name] === undefined) env[name] = value;
    }
    console.log(`  config  ${path}`);
  } catch {
    // No .env is normal: --dev mints throwaway values and captures mail instead.
  }
  return env;
}

async function main() {
  if (!DEV) {
    throw new Error("main.ts is the local dev entrypoint; production runs the Bunny edge script");
  }

  const env = await readEnvFile();

  // Real sending is opt-in and explicit. Defaulting to it would mean a stray .env turns a
  // local experiment into mail landing in a stranger's inbox.
  const sendForReal = env.OJHEJ_MAIL === "send";

  // With real sending the full config is required and validated, exactly as in production.
  // Otherwise throwaway values, so the server runs with no secrets at all.
  const loaded = sendForReal ? loadConfig(env) : devConfig(PORT, env);
  const emailKey = await importEmailKey(loaded.emailKeyRaw);

  // R14: images in mail follow the deploy, so a local run does not hotlink production.
  setMailBaseUrl(loaded.config.baseUrl);

  const store = createFsStore(DATA_DIR);

  // Checked against storage, not just validated. A well-formed code that does not exist
  // puts a broken image in the footer of every page on the site, forever, and a footer
  // decoration must never be able to do that. Dropped with a log line instead.
  const kontakt = loaded.config.kontaktKod ?? null;
  // Set, but not to a code. `loadConfig` drops it so it can never reach a storage key again,
  // and this says which way it was wrong, because silence would leave a typo looking like a
  // working deploy and "malformed" alone never said whether it was blank, lowercase or spaced.
  const problem = contactCodeProblem(env.OJHEJ_KONTAKT_KOD);
  if (problem) {
    warn("contact code is not a valid code, footer QR disabled", problem);
  }
  const kontaktFinns = kontakt !== null && await getCode(store, kontakt, Date.now()) !== null;
  if (kontakt !== null && !kontaktFinns) {
    warn("contact code not found, footer QR disabled", { reason: "no-code" });
  }
  setContactCode(kontaktFinns ? kontakt : null);

  const ctx: AppContext = {
    store,
    emailKey,
    config: loaded.config,
    fetch: sendForReal ? globalThis.fetch : mailCapturingFetch(globalThis.fetch),
    now: () => Date.now(),
  };

  console.log(`\nojhej.se dev server`);
  console.log(`  http://localhost:${PORT}/          landing`);
  console.log(`  data    ${DATA_DIR}/`);
  if (sendForReal) {
    console.log(`  mail    SENDING FOR REAL via ${loaded.config.smtp2go.baseUrl}`);
    console.log(`          from ${loaded.config.smtp2go.sender}`);
    console.log(`          links point at ${loaded.config.baseUrl}`);
  } else {
    console.log(`  mail    captured to ${MAIL_DIR}/, nothing is really sent`);
    console.log(`          set OJHEJ_MAIL=send in .env to use SMTP2GO`);
    if ("ephemeralKey" in loaded && loaded.ephemeralKey) {
      // Without a stable key, every address stored by this run becomes unreadable on the
      // next one, and the first symptom is a 502 from the relay. Say so up front.
      console.log(`  WARNING no OJHEJ_EMAIL_KEY set, using a throwaway key.`);
      console.log(`          codes created now stop working when this server restarts.`);
      console.log(`          run: npx deno task keygen`);
    }
  }
  console.log("");

  Deno.serve({ port: PORT }, (request) =>
    handle(ctx, request).catch((cause) => {
      // Fail closed. No stack, no internal detail, ever, to the client.
      console.error("unhandled", cause);
      return json({ fel: "Något gick fel." }, 500);
    }));
}

if (import.meta.main) await main();

/** Routes first, then the handful of static files the dev server stands in for a CDN to serve. */
async function handle(ctx: AppContext, request: Request): Promise<Response> {
  const routed = await route(ctx, request);
  if (routed) return routed;

  const asset = await serveAsset(new URL(request.url).pathname);
  if (asset) return asset;

  return json({ fel: "Finns inte." }, 404);
}
