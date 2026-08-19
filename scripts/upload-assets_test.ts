import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { assetPaths, DEFAULT_HOST, uploadAsset, type UploadTarget } from "./upload-assets.ts";

const TARGET: UploadTarget = {
  zone: "ojhej",
  accessKey: "zone-password",
  host: "se.storage.bunnycdn.com",
};

function fakeFetch(status = 201) {
  const calls: { url: string; type: string; key: string }[] = [];
  const impl = ((url: string | URL, init: RequestInit = {}) => {
    const headers = init.headers as Record<string, string>;
    calls.push({
      url: String(url),
      type: headers["Content-Type"] ?? "",
      key: headers.AccessKey ?? "",
    });
    return Promise.resolve(new Response("", { status }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/**
 * The list is discovered from disk rather than hardcoded, so a font added by `deno task fonts`
 * is deployed without anyone remembering to add it. The filter is on extension, so a stray
 * README or .DS_Store in public/ cannot quietly become part of the site.
 */
Deno.test("every asset the site loads is found, and nothing else", async () => {
  const keys = await assetPaths();

  assert(keys.includes("style.css"), "the stylesheet");
  assert(keys.includes("fonts.css"), "the font stylesheet");
  assert(keys.includes("app.js"), "the script");
  assert(keys.some((k) => k.startsWith("fonts/") && k.endsWith(".woff2")), "the fonts");

  for (const key of keys) {
    assert(/\.(css|js|woff2|svg|png|ico)$/.test(key), `${key} is not an asset the site loads`);
  }
});

/** A woff2 served as octet-stream is a font the browser refuses to use. */
Deno.test("each file is uploaded with the content type it needs", async () => {
  const { impl, calls } = fakeFetch();

  await uploadAsset(TARGET, "fonts/x.woff2", new Uint8Array([1]), impl);
  await uploadAsset(TARGET, "style.css", new Uint8Array([1]), impl);
  await uploadAsset(TARGET, "app.js", new Uint8Array([1]), impl);

  assertEquals(calls.map((c) => c.type), [
    "font/woff2",
    "text/css; charset=utf-8",
    "text/javascript; charset=utf-8",
  ]);
});

Deno.test("uploads address the zone and authenticate", async () => {
  const { impl, calls } = fakeFetch();
  await uploadAsset(TARGET, "style.css", new Uint8Array([1]), impl);

  assertEquals(calls[0]!.url, "https://se.storage.bunnycdn.com/ojhej/style.css");
  assertEquals(calls[0]!.key, "zone-password");
});

/**
 * A half-finished upload is worse than a stopped one, because the site keeps serving with a
 * stylesheet that no longer matches the markup. Fail loudly on the first refusal.
 */
Deno.test("a refused upload stops the deploy rather than being skipped", async () => {
  for (const status of [400, 401, 403, 500]) {
    const { impl } = fakeFetch(status);
    await assertRejects(
      () => uploadAsset(TARGET, "style.css", new Uint8Array([1]), impl),
      Error,
      "failed with",
    );
  }
});

/**
 * A wrong regional host and a wrong password both answer 401, and the code alone cannot tell
 * them apart. The message has to, because the difference is where you go to fix it. This cost
 * one deploy already.
 */
Deno.test("a 401 on the default host says the host is the likely cause", async () => {
  const { impl } = fakeFetch(401);
  const onDefault: UploadTarget = { ...TARGET, host: DEFAULT_HOST };

  const failure = await assertRejects(
    () => uploadAsset(onDefault, "app.js", new Uint8Array([1]), impl),
    Error,
  );

  assertStringIncludes(failure.message, "401");
  assertStringIncludes(failure.message, DEFAULT_HOST, "the message names the host it used");
  assertStringIncludes(failure.message, "BUNNY_STORAGE_HOST", "and the variable that fixes it");
});

/** On a regional host the host is not the suspect, so the message points at the key instead. */
Deno.test("a 401 on a regional host points at the key, not the host", async () => {
  const { impl } = fakeFetch(401);

  const failure = await assertRejects(
    () => uploadAsset(TARGET, "app.js", new Uint8Array([1]), impl),
    Error,
  );

  assertStringIncludes(failure.message, "FTP & API Access");
  assert(
    !failure.message.includes("BUNNY_STORAGE_HOST"),
    "a correct host should not be blamed",
  );
});

/** Anything that is not an auth failure keeps a plain message rather than a misleading guess. */
Deno.test("other failures are not blamed on credentials", async () => {
  for (const status of [404, 500, 503]) {
    const { impl } = fakeFetch(status);
    const failure = await assertRejects(
      () => uploadAsset(TARGET, "app.js", new Uint8Array([1]), impl),
      Error,
    );
    assert(!failure.message.includes("FTP & API Access"), `status ${status}`);
    assertStringIncludes(failure.message, String(status));
  }
});
