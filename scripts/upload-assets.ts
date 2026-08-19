// deno-lint-ignore-file no-console -- a deploy step whose whole output is its console log

/**
 * Upload the static site to a Bunny Storage Zone.
 *
 * These are the only files the CDN serves directly: two stylesheets, one script, and the fonts.
 * Everything else is rendered by the edge script. The list is explicit rather than a directory
 * walk, so a stray file in `public/` cannot quietly become public.
 *
 * Content types are set here because Bunny serves what it is given, and a woff2 sent as
 * `application/octet-stream` is a font the browser refuses to use.
 *
 *   deno task upload-assets            # needs BUNNY_STORAGE_* in the environment
 *   deno task upload-assets --dry-run  # list the files, touch nothing, no credentials needed
 *   deno task upload-assets --check    # test the credentials only, upload nothing
 */

const CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  woff2: "font/woff2",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
};

/** Correct only for a zone in Bunny's default region. Every other zone needs its own host. */
export const DEFAULT_HOST = "storage.bunnycdn.com";

export interface UploadTarget {
  zone: string;
  accessKey: string;
  host: string;
}

/** Everything under `public/` that the site actually loads, found rather than hardcoded. */
export async function assetPaths(root = "public"): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) await walk(path, key);
      else if (CONTENT_TYPES[entry.name.split(".").pop() ?? ""]) found.push(key);
    }
  }

  await walk(root, "");
  return found.sort();
}

export async function uploadAsset(
  target: UploadTarget,
  key: string,
  body: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const type = CONTENT_TYPES[key.split(".").pop() ?? ""] ?? "application/octet-stream";

  const response = await fetchImpl(`https://${target.host}/${target.zone}/${key}`, {
    method: "PUT",
    headers: { AccessKey: target.accessKey, "Content-Type": type },
    body: body.slice().buffer as ArrayBuffer,
  });
  await response.body?.cancel();

  // Bunny answers 201 on a successful upload. Anything else is a failed deploy, and a deploy
  // that half-uploaded is worse than one that stopped, because the site keeps serving.
  if (!response.ok) {
    throw new Error(
      `upload of ${key} failed with ${response.status} ` +
        `(${target.host}/${target.zone})${hint(response.status, target)}`,
    );
  }
}

/**
 * Say what a 401 probably means, because the two causes are indistinguishable from the status.
 *
 * A wrong storage key and a wrong regional host both answer 401. Neither can be told from the
 * other by the response, so the message names both rather than guessing. It used to lead with
 * the host, which misdirected the one time it mattered: that zone was in the default region and
 * the host was right all along.
 */
function hint(status: number, target: UploadTarget): string {
  if (status !== 401 && status !== 403) return "";

  const said = [
    "",
    `  The zone is addressed by NAME, and this used "${target.zone}". Bunny's storage API`,
    "  takes the zone name, which is the FTP username, not the numeric Storage Zone ID.",
    "  A wrong name answers 401 too, because Bunny will not say whether a zone exists.",
    "",
    "  The key must be the storage zone PASSWORD, from the zone's FTP & API Access page.",
    "  Not the account API key, and not the read-only password: a read-only password",
    "  authenticates and then refuses to write.",
    "",
  ];

  if (target.host === DEFAULT_HOST) {
    said.push(
      `  The host is ${DEFAULT_HOST}, Bunny's default region. Correct for a zone in`,
      "  Falkenstein, wrong for any other, and a wrong host answers 401 exactly like a",
      "  wrong key. Check the zone's Storage Zone Region Endpoint in the dashboard and",
      "  set BUNNY_STORAGE_HOST if it shows anything else.",
    );
  } else {
    said.push(
      `  The host is ${target.host}. Check it matches the zone's Storage Zone Region`,
      "  Endpoint in the dashboard, because a wrong host answers 401 like a wrong key.",
    );
  }

  return said.join("\n");
}

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

if (import.meta.main) {
  const dryRun = Deno.args.includes("--dry-run");
  const checkOnly = Deno.args.includes("--check");

  const keys = await assetPaths();
  if (keys.length === 0) throw new Error("no assets found under public/, refusing to continue");

  if (dryRun) {
    console.log(`would upload ${keys.length} files:`);
    for (const key of keys) console.log(`  ${key}`);
    Deno.exit(0);
  }

  const target: UploadTarget = {
    zone: required("BUNNY_STORAGE_ZONE"),
    accessKey: required("BUNNY_STORAGE_KEY"),
    host: Deno.env.get("BUNNY_STORAGE_HOST") || DEFAULT_HOST,
  };

  // One cheap request before twelve real ones. Checking the credentials up front means the
  // failure reads as "storage refused the credentials" rather than "upload of app.js failed",
  // which is the same fact told badly: the file was never the problem.
  //
  // `--check` stops here. Testing a credential should not require a deploy, and finding out
  // through a failed pipeline is a slow way to learn you pasted the read-only password.
  const probe = await fetch(`https://${target.host}/${target.zone}/`, {
    headers: { AccessKey: target.accessKey },
  });
  await probe.body?.cancel();

  if (probe.status === 401 || probe.status === 403) {
    throw new Error(
      `storage refused the credentials with ${probe.status} ` +
        `(${target.host}/${target.zone})${hint(probe.status, target)}`,
    );
  }

  if (checkOnly) {
    console.log(`ok: ${target.host}/${target.zone} accepted the key (${probe.status})`);
    console.log(`    ${keys.length} files ready to upload`);
    Deno.exit(0);
  }

  console.log(`uploading ${keys.length} files to ${target.host}/${target.zone}\n`);
  for (const key of keys) {
    const body = await Deno.readFile(`public/${key}`);
    await uploadAsset(target, key, body);
    console.log(`  ${key.padEnd(48)} ${Math.round(body.length / 1024)} KB`);
  }
  console.log(`\ndone`);
}
