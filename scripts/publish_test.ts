import { assert, assertEquals, assertFalse } from "@std/assert";
import { changedFiles, isPublishable, parseArgs, planSync } from "./publish.ts";

/**
 * These tests are the lock on what reaches a public repository, so they are written as the
 * question "could this file end up on github.com/imbabamba/ojhej", not as the question "does the
 * allowlist contain this string". A wrong answer here is not a failing build, it is a private
 * document published under an AGPL licence with no way to unpublish it.
 *
 * They run in the mirror too. `scripts/` is published, so this file and `publish.ts` both land in
 * the public repo and its CI runs them, where `../ojhej` does not exist. That is why everything
 * here is pure: no filesystem, no git, no network.
 */

Deno.test("the private material never crosses", () => {
  // The decision log, the research and the deploy runbook. Comments in the source cite these by
  // name, and the mirror's own .gitignore says why they stay behind.
  assertFalse(isPublishable("specs/ojhej/status.md"));
  assertFalse(isPublishable("specs/ojhej/plan-publish-mirror.md"));
  assertFalse(isPublishable("specs/ojhej/research-2026-08-12-bunny.md"));

  // The approved screen designs.
  assertFalse(isPublishable("mockups/13-klar-syfte.html"));
  assertFalse(isPublishable("mockups/mail/04-hantera-flera.html"));

  // Local agent tooling, nothing to do with the service.
  assertFalse(isPublishable(".claude/settings.json"));
  assertFalse(isPublishable(".claude/skills/backman-developer/SKILL.md"));
});

Deno.test("the code that runs the service crosses", () => {
  assert(isPublishable("src/route.ts"));
  assert(isPublishable("src/survey.ts"));
  assert(isPublishable("src/survey_test.ts"));
  assert(isPublishable("src/store/bunny.ts"));
  assert(isPublishable("public/app.js"));
  assert(isPublishable("scripts/publish.ts"));
  assert(isPublishable("edge/main.ts"));

  assert(isPublishable("deno.json"));
  assert(isPublishable("deno.lock"));
  assert(isPublishable("package.json"));
  assert(isPublishable(".gitattributes"));
  assert(isPublishable(".env.example"));
});

/**
 * Two of the three workflows cross. `storage-probe.yml` does not, and the reason is in the
 * workflow itself: its comments cite `specs/ojhej/status.md`, which is not published. The probe
 * *script* and its `deno task` are already public, so this looks arbitrary from the outside and is
 * pinned here so nobody tidies it away.
 */
Deno.test("only the two workflows that carry no private citation cross", () => {
  assert(isPublishable(".github/workflows/ci.yml"));
  assert(isPublishable(".github/workflows/deploy.yml"));

  assertFalse(isPublishable(".github/workflows/storage-probe.yml"));
  assertFalse(isPublishable(".github/dependabot.yml"));
});

/**
 * The mirror's own five files. These are not "not yet copied", they are deliberately absent from
 * this repo: the public README differs from the developer one, and the licence and the two policy
 * documents exist only over there.
 *
 * This test is doing double duty. Because `planSync` builds its delete set out of mirror files
 * that *are* publishable, these five being unpublishable is what stops a publish from deleting the
 * licence off a public repository. That safety is a consequence of this test, not of a special
 * case somewhere in the sync.
 */
Deno.test("the mirror's own files are never touched", () => {
  assertFalse(isPublishable("README.md"));
  assertFalse(isPublishable("LICENSE"));
  assertFalse(isPublishable("CONTRIBUTING.md"));
  assertFalse(isPublishable("SECURITY.md"));
  assertFalse(isPublishable(".gitignore"));
});

/**
 * Path traversal. `git ls-files` will not hand us any of these, but the allowlist is the thing
 * standing between a path and a public repository, so it does not get to assume its caller is
 * honest. Backslashes are here because this is developed on Windows, where `src\..\..\secret` is
 * a real traversal that a forward-slash-only check reads as an innocent filename.
 */
Deno.test("nothing escapes the allowlist", () => {
  assertFalse(isPublishable("../escape.txt"));
  assertFalse(isPublishable("../../etc/passwd"));
  assertFalse(isPublishable("src/../specs/ojhej/status.md"));
  assertFalse(isPublishable("src/../../escape.txt"));
  assertFalse(isPublishable("src\\..\\..\\escape.txt"));
  assertFalse(isPublishable("/etc/passwd"));
  assertFalse(isPublishable("C:/Windows/system32/config/SAM"));
  assertFalse(isPublishable(""));
  assertFalse(isPublishable("."));
  assertFalse(isPublishable(".."));
});

/**
 * A directory root matches on the separator, never on the prefix. `srcret/` is not `src/`, and a
 * repo that grew a `publications/` directory must not have it published because it starts with
 * the four letters of `public`.
 */
Deno.test("a directory root matches on the boundary, not the prefix", () => {
  assertFalse(isPublishable("srcret/leak.ts"));
  assertFalse(isPublishable("publications/leak.md"));
  assertFalse(isPublishable("scripts-private/leak.ts"));
  assertFalse(isPublishable("edgecase/leak.ts"));

  // The roots themselves are directories, not files, so a bare name is not a file to copy.
  assertFalse(isPublishable("src"));
  assertFalse(isPublishable("public"));
});

/**
 * An exact-file entry is exact. `deno.jsonc` is not `deno.json`, and `.env` is emphatically not
 * `.env.example`: that one is the live secret, and it is the single worst file in the tree to get
 * wrong. It is gitignored as well, so this is the second of the two locks, but the allowlist is
 * not entitled to lean on that.
 */
Deno.test("an exact-file entry does not match by prefix", () => {
  assertFalse(isPublishable(".env"));
  assertFalse(isPublishable(".env.local"));
  assertFalse(isPublishable("deno.jsonc"));
  assertFalse(isPublishable("package-lock.json"));
  assertFalse(isPublishable("deno.lock.bak"));
});

/**
 * `planSync` decides two things: what to write into the mirror, and what to delete from it.
 *
 * The delete side is the dangerous one. It is the only part of this tool that removes a file from
 * a public repository, and the thing it must never remove is the mirror's own material: the
 * licence, the public README, and the two policy documents that do not exist in this repo at all.
 * The protection is not a special case in here, it is `isPublishable` returning false for those
 * five names, which means the test above is what holds the licence in place.
 */
Deno.test("everything publishable in the source is written", () => {
  const plan = planSync(["src/route.ts", "src/survey.ts"], ["src/route.ts"]);

  // Both, not just the new one. Deciding which files actually changed needs their bytes, and that
  // is the shell's job; this stays pure so it can run in the mirror's CI.
  assertEquals(plan.write, ["src/route.ts", "src/survey.ts"]);
});

Deno.test("a publishable file the source no longer has is removed", () => {
  const plan = planSync(["src/route.ts"], ["src/route.ts", "src/dead.ts"]);

  assertEquals(plan.remove, ["src/dead.ts"]);
});

Deno.test("the mirror's own files are in neither set", () => {
  const plan = planSync(
    ["src/route.ts"],
    ["src/route.ts", "README.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", ".gitignore"],
  );

  assertEquals(plan.remove, []);
  assertEquals(plan.write, ["src/route.ts"]);
});

/**
 * The caller filters through `isPublishable` before it gets here. This asserts `planSync` does it
 * again anyway. Two locks on the same door, and this is the cheaper one to keep honest.
 */
Deno.test("a path that should never have been offered is not written", () => {
  const plan = planSync(["src/route.ts", "specs/ojhej/status.md", ".env"], []);

  assertEquals(plan.write, ["src/route.ts"]);
});

/**
 * Sorted, so the printed plan and the confirmation prompt read the same way twice. A publish is a
 * thing a person is being asked to approve by eye, and an order that shifts between runs makes
 * "the same as last time" impossible to see.
 */
Deno.test("the plan is sorted, so two runs read identically", () => {
  const plan = planSync(
    ["src/route.ts", "edge/main.ts", "public/app.js"],
    ["src/zz.ts", "edge/aa.ts"],
  );

  assertEquals(plan.write, ["edge/main.ts", "public/app.js", "src/route.ts"]);
  assertEquals(plan.remove, ["edge/aa.ts", "src/zz.ts"]);
});

Deno.test("an empty mirror takes the whole source and removes nothing", () => {
  const plan = planSync(["src/route.ts", "deno.json"], []);

  assertEquals(plan.write, ["deno.json", "src/route.ts"]);
  assertEquals(plan.remove, []);
});

/**
 * Argument parsing is pure so the refusals can be tested. Every one of them is a refusal rather
 * than a default, because the two mistakes available here are publishing with a message nobody
 * wrote and publishing into the wrong repository, and a helpful default is how both happen.
 */
Deno.test("--check needs nothing else and defaults to the sibling clone", () => {
  const parsed = parseArgs(["--check"]);

  assert(parsed.ok);
  assertEquals(parsed.mode, "check");
  assertEquals(parsed.mirror, "../ojhej");
});

Deno.test("a publish carries a message, and is refused without one", () => {
  const withMessage = parseArgs(["-m", "sync survey and layout"]);
  assert(withMessage.ok);
  assertEquals(withMessage.mode, "publish");
  assertEquals(withMessage.message, "sync survey and layout");

  assertEquals(parseArgs(["--message", "x"]).ok, true);

  // Bare, no message: there is no sensible default for a public commit message.
  assertFalse(parseArgs([]).ok);
  assertFalse(parseArgs(["-m", ""]).ok);
  assertFalse(parseArgs(["-m", "   "]).ok);
});

Deno.test("a flag missing its value is refused, never treated as absent", () => {
  assertFalse(parseArgs(["-m"]).ok);
  assertFalse(parseArgs(["--mirror"]).ok);

  // The dangerous shape: `-m` swallowing the next flag and publishing with "--check" as the
  // commit message.
  assertFalse(parseArgs(["-m", "--check"]).ok);
});

Deno.test("the mirror path can be pointed somewhere else", () => {
  const parsed = parseArgs(["--mirror", "/tmp/ojhej-test", "-m", "sync"]);

  assert(parsed.ok);
  assertEquals(parsed.mirror, "/tmp/ojhej-test");
});

Deno.test("check and publish are not combined, and unknown flags stop the run", () => {
  assertFalse(parseArgs(["--check", "-m", "sync"]).ok);
  assertFalse(parseArgs(["--bogus"]).ok);
  assertFalse(parseArgs(["stray"]).ok);
});

/**
 * `changedFiles` narrows the plan's `write` list to the files whose bytes actually differ, so the
 * mirror's mtimes stay put and the diffstat a person is asked to approve is honest.
 *
 * It takes two readers rather than touching the filesystem, the same shape `asset-version.ts`
 * uses, which is what lets it be tested here and still run in the mirror's CI.
 */
function reader(files: Record<string, string>): (path: string) => Promise<Uint8Array | null> {
  const encoder = new TextEncoder();
  return (path) => Promise.resolve(path in files ? encoder.encode(files[path]!) : null);
}

Deno.test("a file with identical bytes is not rewritten", async () => {
  const changed = await changedFiles(
    ["src/route.ts", "src/survey.ts"],
    reader({ "src/route.ts": "same", "src/survey.ts": "new" }),
    reader({ "src/route.ts": "same", "src/survey.ts": "old" }),
  );

  assertEquals(changed, ["src/survey.ts"]);
});

Deno.test("a file absent from the mirror counts as changed", async () => {
  const changed = await changedFiles(
    ["src/survey.ts"],
    reader({ "src/survey.ts": "new" }),
    reader({}),
  );

  assertEquals(changed, ["src/survey.ts"]);
});

/**
 * A one-byte difference is a difference. Length-only comparison is the obvious shortcut and it
 * would ship a file whose content changed but whose size did not, which is most edits to a
 * constant, a URL or a flag.
 */
Deno.test("same length, different bytes, still changed", async () => {
  const changed = await changedFiles(
    ["src/assets.ts"],
    reader({ "src/assets.ts": "aaaa" }),
    reader({ "src/assets.ts": "aaab" }),
  );

  assertEquals(changed, ["src/assets.ts"]);
});

Deno.test("nothing changed reads as nothing to do", async () => {
  const changed = await changedFiles(
    ["src/route.ts"],
    reader({ "src/route.ts": "same" }),
    reader({ "src/route.ts": "same" }),
  );

  assertEquals(changed, []);
});
