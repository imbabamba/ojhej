import { assert, assertEquals, assertRejects } from "@std/assert";
import { assertDeleteSemantics, createBunnyStore, deleteAfter } from "./bunny.ts";
import { createMemoryStore } from "./storage.ts";

const CONFIG = { zone: "ojhej", accessKey: "zone-password", host: "se.storage.bunnycdn.com" };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A fetch that records what it was asked and answers with whatever the test wants. */
function fakeFetch(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const impl = ((url: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body === undefined || init.body === null ? null : String(init.body),
    };
    calls.push(call);
    return Promise.resolve(reply(call));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (body = "", status = 200) => new Response(body, { status });

Deno.test("a read addresses the zone and authenticates with the zone password", async () => {
  const { impl, calls } = fakeFetch(() => ok('{"slug":"X"}'));
  const store = createBunnyStore(CONFIG, impl);

  assertEquals(await store.get("shirts/K7M4NPQR8TVWXYZ2ABCD.json"), '{"slug":"X"}');
  assertEquals(
    calls[0]!.url,
    "https://se.storage.bunnycdn.com/ojhej/shirts/K7M4NPQR8TVWXYZ2ABCD.json",
  );
  assertEquals(calls[0]!.headers.AccessKey, "zone-password");
});

Deno.test("a missing object reads as absent rather than as an error", async () => {
  const { impl } = fakeFetch(() => ok("Not found", 404));
  assertEquals(await createBunnyStore(CONFIG, impl).get("shirts/missing.json"), null);
});

Deno.test("a read fault is thrown, never mistaken for absence", async () => {
  for (const status of [401, 403, 429, 500, 502, 503]) {
    const { impl } = fakeFetch(() => ok("", status));
    const store = createBunnyStore(CONFIG, impl);
    await assertRejects(() => store.get("shirts/x.json"), Error, "storage read failed");
  }
});

Deno.test("a write sends the body and is checked for success", async () => {
  const { impl, calls } = fakeFetch(() => ok("", 201));
  await createBunnyStore(CONFIG, impl).put("tokens/abc.json", '{"slug":"X"}');

  assertEquals(calls[0]!.method, "PUT");
  assertEquals(calls[0]!.body, '{"slug":"X"}');

  const failing = fakeFetch(() => ok("", 500));
  await assertRejects(
    () => createBunnyStore(CONFIG, failing.impl).put("tokens/abc.json", "{}"),
    Error,
    "storage write failed",
  );
});

/* ---------- the part the ownership model rests on ---------- */

/**
 * `delete` answers "did my call remove it", not "is it gone now". Single-use tokens and the
 * proof-of-work claim both work by racing deletes and letting exactly one win, so an adapter
 * that said true for an object that was not there would hand every racer a win.
 */
Deno.test("only a real removal counts as a win", async () => {
  const { impl } = fakeFetch(() => ok('{"status":"Deleted"}', 200));
  assertEquals(await createBunnyStore(CONFIG, impl).delete("tokens/abc.json"), true);
});

Deno.test("an object that was already gone is a loss, not a win", async () => {
  // 404 is the obvious case. 400 is the one Bunny documents as "object delete failed", which
  // is what a racer sees when another request removed the object a moment earlier.
  for (const status of [404, 400]) {
    const { impl } = fakeFetch(() => ok("", status));
    assertEquals(
      await createBunnyStore(CONFIG, impl).delete("tokens/abc.json"),
      false,
      `status ${status}`,
    );
  }
});

/**
 * A 500 is not a lost race. Treating it as one would silently drop a legitimate claim: the
 * owner clicks their verification link, the storage hiccups, and they are told the link was
 * already used. Thrown instead, so it surfaces as a failure rather than a lie.
 */
Deno.test("a delete fault is thrown rather than reported as a lost race", async () => {
  for (const status of [401, 403, 500, 503]) {
    const { impl } = fakeFetch(() => ok("", status));
    const store = createBunnyStore(CONFIG, impl);
    await assertRejects(() => store.delete("tokens/abc.json"), Error, "storage delete failed");
  }
});

/* ---------- refusing to build a path that addresses somewhere else ---------- */

Deno.test("a key that could escape the zone is refused before it becomes a URL", async () => {
  const store = createBunnyStore(CONFIG, fakeFetch(() => ok()).impl);

  for (
    const hostile of [
      "../../etc/passwd",
      "shirts/../../other-zone/x.json",
      "/absolute/path.json",
      "shirts//double.json",
      "",
      "shirts/x.json?query=1",
      "shirts/x.json#fragment",
      "http://elsewhere.example/x",
    ]
  ) {
    await assertRejects(() => store.get(hostile), Error, "refusing", hostile);
    await assertRejects(() => store.put(hostile, "{}"), Error, "refusing", hostile);
    await assertRejects(() => store.delete(hostile), Error, "refusing", hostile);
  }
});

Deno.test("the keys this application actually builds are all accepted", async () => {
  const { impl, calls } = fakeFetch(() => ok("{}"));
  const store = createBunnyStore(CONFIG, impl);

  for (
    const key of [
      "shirts/K7M4NPQR8TVWXYZ2ABCD.json",
      `tokens/${"a".repeat(64)}.json`,
      `emails/${"b".repeat(64)}.json`,
      `altcha/${"c".repeat(64)}.json`,
      "probe/3f2b1c4d-0000-4000-8000-000000000000.json",
    ]
  ) {
    await store.get(key);
  }
  assertEquals(calls.length, 5);
  for (const call of calls) assert(call.url.startsWith(`https://${CONFIG.host}/${CONFIG.zone}/`));
});

/* ---------- the startup check ---------- */

/**
 * The whole reason this exists: Bunny documents 200 and 400 for DELETE and says nothing about
 * a missing object. That is the one assumption single-use tokens rest on, so it is proven
 * against the real store at boot rather than believed.
 */
Deno.test("a store with correct semantics passes the startup check", async () => {
  const { store } = createMemoryStore();
  await assertDeleteSemantics(store);
});

Deno.test("a store that always says yes is caught at startup", async () => {
  const alwaysWins = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
    delete: () => Promise.resolve(true),
  };

  await assertRejects(
    () => assertDeleteSemantics(alwaysWins),
    Error,
    "already gone",
  );
});

Deno.test("a store that cannot delete at all is caught at startup", async () => {
  const neverWins = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
    delete: () => Promise.resolve(false),
  };

  await assertRejects(
    () => assertDeleteSemantics(neverWins),
    Error,
    "did not report removing",
  );
});

Deno.test("the startup check leaves nothing behind", async () => {
  const { store, keys } = createMemoryStore();
  await assertDeleteSemantics(store);
  assertEquals(keys(), [], "the probe object must not survive the check");
});

/** Two instances booting together must not fail each other. */
Deno.test("concurrent startup checks do not collide", async () => {
  const { store } = createMemoryStore();
  await Promise.all(Array.from({ length: 10 }, () => assertDeleteSemantics(store)));
});

/**
 * The probe guarantees delete-as-claim, and nothing else, so it gates deletes and nothing else.
 *
 * It used to be awaited before the isolate would answer at all, which charged three storage
 * round trips to every landing page, scan page and stylesheet. Deferring it by hand would have
 * meant remembering to await it in each handler that spends a token, and a forgotten one is a
 * replay hole no test would catch. Putting the wait on `delete` is what makes forgetting
 * impossible.
 */
Deno.test("deleteAfter lets reads and writes through while the probe is still running", async () => {
  const handle = createMemoryStore();
  let settle = () => {};
  const probe = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const store = deleteAfter(handle.store, probe);

  await store.put("shirts/A.json", "{}");
  assertEquals(await store.get("shirts/A.json"), "{}", "a read must not wait for the probe");

  let deleted = false;
  const pending = store.delete("shirts/A.json").then((won) => {
    deleted = won;
  });

  // The delete is still parked, which is the whole point.
  await Promise.resolve();
  assertEquals(deleted, false);
  assertEquals(await handle.store.get("shirts/A.json"), "{}", "and nothing has been removed yet");

  settle();
  await pending;
  assertEquals(deleted, true);
  assertEquals(await handle.store.get("shirts/A.json"), null);
});

/** A store that cannot vouch for itself must refuse every claim, not quietly allow them. */
Deno.test("deleteAfter fails closed when the probe rejects", async () => {
  const handle = createMemoryStore();
  const store = deleteAfter(handle.store, Promise.reject(new Error("delete semantics are wrong")));
  await handle.store.put("tokens/x.json", "{}");

  await assertRejects(() => store.delete("tokens/x.json"));
  assertEquals(await handle.store.get("tokens/x.json"), "{}", "the object must survive a refusal");
  // Reads still work, which is what keeps a bad boot from being a total outage.
  assertEquals(await store.get("tokens/x.json"), "{}");
});
