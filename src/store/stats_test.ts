import { assert, assertEquals } from "@std/assert";
import { createMemoryStore } from "./storage.ts";
import { countActivation, readActivations } from "./stats.ts";

Deno.test("counting starts at zero and goes up", async () => {
  const { store } = createMemoryStore();

  assertEquals(await readActivations(store), 0, "never written is zero, not missing");

  await countActivation(store);
  await countActivation(store);
  assertEquals(await readActivations(store), 2);
});

/**
 * The counter races, because there is no compare-and-swap in this storage. That is accepted:
 * unlike the signup cap, which races the same way and had to be worked around, a wrong answer
 * here is a number on a page being short. This test records the property rather than asserting
 * an exact total, so nobody later reads an exact count as a guarantee.
 */
Deno.test("concurrent counting may undercount, and never overcounts", async () => {
  const { store } = createMemoryStore();

  await Promise.all(Array.from({ length: 20 }, () => countActivation(store)));

  const total = await readActivations(store)!;
  assert(total !== null && total >= 1, "at least one must land");
  assert(total !== null && total <= 20, `counted ${total}, which is more than happened`);
});

/** Nothing on the verification path may be broken by a counter. */
Deno.test("a broken store never breaks counting or reading", async () => {
  const broken = {
    get: () => Promise.reject(new Error("storage down")),
    put: () => Promise.reject(new Error("storage down")),
    delete: () => Promise.resolve(false),
  };

  await countActivation(broken);
  assertEquals(await readActivations(broken), null, "unreadable is null, not a throw");
});

Deno.test("a corrupt counter reads as zero rather than throwing", async () => {
  for (const junk of ["", "not json", "[]", '{"aktiverade":"many"}', '{"aktiverade":-5}', "null"]) {
    const { store } = createMemoryStore();
    await store.put("stats/koder.json", junk);
    const read = await readActivations(store);
    assert(read !== null && read >= 0, `${junk} should read as a number, got ${read}`);
  }
});

/** The counter lives outside every tenant's namespace and names nobody. */
Deno.test("the counter holds no personal data and no slugs", async () => {
  const { store, keys } = createMemoryStore();
  await countActivation(store);

  assertEquals(keys(), ["stats/koder.json"]);
  assertEquals(await store.get("stats/koder.json"), '{"aktiverade":1}');
});
