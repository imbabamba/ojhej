// deno-lint-ignore-file no-console -- a publishing step whose entire output is its console log

/**
 * Publish this repo's code to the public mirror at `imbabamba/ojhej`.
 *
 * The mirror is the AGPL-3.0 source of the service running at ojhej.se, published so the privacy
 * claims on that page can be checked rather than believed. It is this repo with the private
 * material held back: the decision log in `specs/`, the approved screen designs in `mockups/`, and
 * the local agent tooling in `.claude/`.
 *
 * Keeping it current used to be a step someone had to remember, and it was forgotten: the mirror
 * sat twelve days behind, missing a whole feature and carrying 27 stale files, while claiming to
 * be the source of the running service. See `specs/ojhej/plan-publish-mirror.md`.
 *
 * This script publishes itself, and that is deliberate rather than an oversight. `deno task check`
 * covers `src/ edge/ scripts/` and `deno.json` is mirrored, so moving it to a `tools/` directory
 * would need a `deno.json` change that breaks the public repo's CI. Living in `scripts/` keeps
 * both repos' CI byte-identical.
 */

/**
 * Directory roots that cross to the mirror, whole.
 *
 * Matching is on the `/` boundary, never on the prefix, so a future `publications/` is not swept
 * in by `public`.
 */
const PUBLISHED_DIRS = ["src", "public", "scripts", "edge"];

/**
 * Individual files that cross. Exact matches only.
 *
 * `.env.example` is here and `.env` is not, which is the difference between a documented set of
 * variable names and every live secret the service holds.
 *
 * Two of the three workflows are here. `storage-probe.yml` is not: its comments cite
 * `specs/ojhej/status.md`, which is not published. The probe script and its `deno task` are
 * already public, so the omission looks arbitrary from the outside, and `publish_test.ts` pins it
 * so nobody tidies it away.
 */
const PUBLISHED_FILES = [
  "deno.json",
  "deno.lock",
  "package.json",
  ".gitattributes",
  ".env.example",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",
];

/**
 * Whether a repo-relative path is allowed to reach the public mirror.
 *
 * This is one of the two locks on what crosses. The other is `git ls-files`, which means only
 * tracked files are ever offered here, so anything gitignored or untracked is already gone before
 * this function sees it. Neither lock is trusted to be the only one: this one rejects traversal
 * and absolute paths even though its caller would never produce them, because it is the last thing
 * standing between a path and a repository that cannot be unpublished.
 *
 * Paths are git's own form: repo-relative, `/` separated. A backslash is not a separator to be
 * normalised, it is a sign the path did not come from git, and on Windows `src\..\..\secret` is a
 * real traversal that a forward-slash-only check would read as an innocent filename. So it is
 * refused outright rather than cleaned up.
 */
export function isPublishable(path: string): boolean {
  if (path === "" || path.includes("\\")) return false;

  // A drive letter is an absolute path that carries no leading slash to catch it below.
  if (/^[A-Za-z]:/.test(path)) return false;

  // An empty segment means a leading, trailing or doubled slash; `.` and `..` mean traversal.
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;

  if (PUBLISHED_FILES.includes(path)) return true;

  return PUBLISHED_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

/** What a publish would do to the mirror's working tree. */
export interface SyncPlan {
  /** Publishable source files, all of them. The caller skips the ones whose bytes already match. */
  write: string[];
  /** Files to delete from the mirror, because the source no longer has them. */
  remove: string[];
}

/**
 * Work out what to write into the mirror and what to delete from it.
 *
 * Pure on purpose. It takes two lists of paths rather than reading either repo, so it runs under
 * the mirror's own CI where there is no source checkout to look at.
 *
 * The delete set is the part worth reading twice, because it is the only thing here that removes a
 * file from a public repository. It is built out of mirror files that are *publishable* and absent
 * from the source, which means the mirror's own `README.md`, `LICENSE`, `CONTRIBUTING.md`,
 * `SECURITY.md` and `.gitignore` can never enter it: `isPublishable` says no to all five, so they
 * are not eligible to be deleted any more than they are eligible to be written. The licence is
 * held in place by the same rule that keeps `specs/` private, rather than by a special case anyone
 * has to remember.
 *
 * `write` is every publishable source file, not only the changed ones. Telling changed from
 * unchanged needs the bytes on both sides, and that is the shell's job.
 *
 * Both lists come back sorted. A publish ends in a person approving a diff by eye, and an order
 * that shifts between runs makes "this is the same as last time" impossible to see.
 */
export function planSync(sourceFiles: string[], mirrorFiles: string[]): SyncPlan {
  // Filtered again even though the caller already did it. Two locks on the same door.
  const write = sourceFiles.filter(isPublishable).sort();
  const wanted = new Set(write);

  return {
    write,
    remove: mirrorFiles.filter((path) => isPublishable(path) && !wanted.has(path)).sort(),
  };
}

/** Where the mirror is checked out, unless `--mirror` says otherwise. */
const DEFAULT_MIRROR = "../ojhej";

export type Options =
  | { ok: true; mode: "check" | "publish"; message: string; mirror: string }
  | { ok: false; error: string };

/**
 * Read the command line.
 *
 * Everything questionable is a refusal rather than a default, because the two mistakes available
 * here are publishing with a message nobody wrote and publishing into the wrong repository, and a
 * helpful default is exactly how both of those happen. In particular a value that looks like a
 * flag is refused: `-m --check` is a typo that would otherwise commit to a public repo with
 * "--check" as the message and no `--check` behaviour.
 */
export function parseArgs(args: string[]): Options {
  let check = false;
  let message: string | null = null;
  let mirror = DEFAULT_MIRROR;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "--check") {
      check = true;
      continue;
    }

    if (arg === "-m" || arg === "--message") {
      const value = args[++i];
      if (value === undefined || value.startsWith("-") || value.trim() === "") {
        return { ok: false, error: `${arg} needs a message` };
      }
      message = value;
      continue;
    }

    if (arg === "--mirror") {
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) {
        return { ok: false, error: "--mirror needs a path" };
      }
      mirror = value;
      continue;
    }

    return { ok: false, error: `unknown argument: ${arg}` };
  }

  if (check && message !== null) {
    return { ok: false, error: "--check reports, it does not commit, so it takes no message" };
  }
  if (check) return { ok: true, mode: "check", message: "", mirror };
  if (message === null) {
    return { ok: false, error: "a publish needs -m <message>, or --check to report only" };
  }

  return { ok: true, mode: "publish", message, mirror };
}

/** Reads a file's bytes, or answers `null` when it is not there. */
export type ReadFile = (path: string) => Promise<Uint8Array | null>;

/**
 * Narrow the plan's `write` list to the files whose bytes actually differ.
 *
 * Two reasons to bother. The mirror's mtimes stay put, and the diffstat a person is asked to
 * approve shows the files that changed rather than every file in the repo, which is the difference
 * between a diff someone reads and a diff someone waves through.
 *
 * Takes its readers rather than touching the filesystem, the same shape `asset-version.ts` uses,
 * which is what lets it be tested and still run under the mirror's own CI.
 */
export async function changedFiles(
  paths: string[],
  readSource: ReadFile,
  readMirror: ReadFile,
): Promise<string[]> {
  const changed: string[] = [];

  for (const path of paths) {
    const [source, mirror] = await Promise.all([readSource(path), readMirror(path)]);

    // git listed it as tracked, so it is there. If it is not, something is racing us and the
    // honest move is to leave it out rather than write an empty file into a public repo.
    if (source === null) continue;

    if (mirror === null || !sameBytes(source, mirror)) changed.push(path);
  }

  return changed;
}

/**
 * Byte-for-byte. Comparing lengths alone is the obvious shortcut and it would skip most real
 * edits: a changed constant, a corrected URL, a flipped flag.
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

// ---------------------------------------------------------------------------------------------
// Everything below is the shell: git, the filesystem, and the person being asked to approve a
// push. It runs only under `import.meta.main`, so importing this module for its pure functions,
// which is what `publish_test.ts` does and what the mirror's own CI ends up doing, touches none
// of it.
// ---------------------------------------------------------------------------------------------

/** The mirror, and only the mirror. `project-ojhej` must not match. */
const MIRROR_ORIGIN = /[/:]imbabamba\/ojhej(\.git)?\/?$/;

/** This repo, and only this repo. */
const SOURCE_ORIGIN = /[/:]imbabamba\/project-ojhej(\.git)?\/?$/;

interface GitResult {
  code: number;
  out: string;
  err: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const decoder = new TextDecoder();
  return { code, out: decoder.decode(stdout).trim(), err: decoder.decode(stderr).trim() };
}

async function readOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

/**
 * The checks that run before anything is read or written, split by what a wrong answer costs.
 *
 * **Identity** is a refusal in both modes. If this is not the repo we think it is, or the mirror
 * is not the mirror, the report is not merely unhelpful, it is describing two repositories nobody
 * asked about.
 *
 * **State** is a refusal when publishing and a warning when checking. Publishing from a dirty tree
 * ships uncommitted work to a public repo, so it is refused. But `--check` exists to be run in the
 * middle of ordinary work, which is exactly when the tree is dirty, and a `--check` that refuses
 * to run then is a `--check` nobody runs. In that state it over-reports rather than under-reports,
 * because uncommitted edits show up as drift, and that is the safe direction to be wrong in.
 */
async function preflight(source: string, mirror: string, publishing: boolean): Promise<string[]> {
  const fatal: string[] = [];
  const warn = (message: string) => {
    if (publishing) fatal.push(message);
    else console.warn(`  warning: ${message}`);
  };

  const sourceOrigin = await git(source, ["remote", "get-url", "origin"]);
  if (!SOURCE_ORIGIN.test(sourceOrigin.out)) {
    fatal.push(`this is not project-ojhej: origin is ${sourceOrigin.out || "unset"}`);
  }

  if ((await git(mirror, ["rev-parse", "--git-dir"])).code !== 0) {
    fatal.push(`no git repository at ${mirror}`);
    return fatal; // Nothing below can mean anything without one.
  }

  const mirrorOrigin = await git(mirror, ["remote", "get-url", "origin"]);
  if (!MIRROR_ORIGIN.test(mirrorOrigin.out)) {
    fatal.push(`${mirror} is not the ojhej mirror: origin is ${mirrorOrigin.out || "unset"}`);
  }

  if ((await git(source, ["status", "--porcelain"])).out !== "") {
    warn("this repo's worktree is dirty, so the comparison includes uncommitted work");
  }

  if ((await git(mirror, ["status", "--porcelain"])).out !== "") {
    warn(`${mirror} has uncommitted changes of its own`);
  }

  const branch = await git(mirror, ["branch", "--show-current"]);
  if (branch.out !== "main") warn(`${mirror} is on ${branch.out || "a detached head"}, not main`);

  // Fetch before judging: "up to date" against a stale remote ref is worth nothing.
  const fetched = await git(mirror, ["fetch", "origin", "main"]);
  if (fetched.code !== 0) {
    warn(`could not fetch ${mirror}: ${fetched.err}`);
  } else {
    const counts = await git(mirror, ["rev-list", "--left-right", "--count", "main...origin/main"]);
    const [ahead, behind] = counts.out.split(/\s+/).map(Number);
    // Behind means somebody pushed to the public repo directly and a human needs to look. Ahead
    // means the mirror carries local commits that a push would take along unread.
    if (behind) warn(`${mirror} is ${behind} commit(s) behind origin/main`);
    if (ahead) warn(`${mirror} is ${ahead} commit(s) ahead of origin/main, unpushed`);
  }

  return fatal;
}

/** Remove directories left empty by a delete, up to but never including the mirror root. */
async function pruneEmptyDirs(root: string, path: string): Promise<void> {
  const parts = path.split("/");
  parts.pop();

  while (parts.length > 0) {
    try {
      // Throws unless the directory is empty, which is exactly the test we want.
      await Deno.remove(`${root}/${parts.join("/")}`);
    } catch {
      return;
    }
    parts.pop();
  }
}

async function main(): Promise<number> {
  const options = parseArgs(Deno.args);
  if (!options.ok) {
    console.error(`publish: ${options.error}`);
    return 2;
  }

  const source = Deno.cwd();
  const { mirror, mode } = options;
  const publishing = mode === "publish";

  const problems = await preflight(source, mirror, publishing);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`publish: ${problem}`);
    return 1;
  }

  const tracked = await git(source, ["ls-files"]);
  const mirrorTracked = await git(mirror, ["ls-files"]);
  if (tracked.code !== 0 || mirrorTracked.code !== 0) {
    console.error(`publish: could not list tracked files: ${tracked.err || mirrorTracked.err}`);
    return 1;
  }

  const plan = planSync(tracked.out.split("\n"), mirrorTracked.out.split("\n"));
  const changed = await changedFiles(
    plan.write,
    (path) => readOrNull(`${source}/${path}`),
    (path) => readOrNull(`${mirror}/${path}`),
  );

  if (changed.length === 0 && plan.remove.length === 0) {
    console.log("The mirror is up to date.");
    return 0;
  }

  console.log(`\n${changed.length} to update, ${plan.remove.length} to delete:\n`);
  for (const path of changed) console.log(`  update  ${path}`);
  for (const path of plan.remove) console.log(`  delete  ${path}`);

  if (!publishing) {
    console.log("\nRun again with -m <message> to publish.");
    return 1;
  }

  for (const path of changed) {
    const bytes = await readOrNull(`${source}/${path}`);
    if (bytes === null) continue;
    const target = `${mirror}/${path}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(target, bytes);
  }

  for (const path of plan.remove) {
    await Deno.remove(`${mirror}/${path}`).catch(() => {});
    await pruneEmptyDirs(mirror, path);
  }

  await git(mirror, ["add", "-A"]);

  const staged = await git(mirror, ["diff", "--cached", "--stat"]);
  if (staged.out === "") {
    console.log("\nNothing staged after all. Nothing published.");
    return 0;
  }

  console.log(`\n${staged.out}\n`);

  // The last gate, and the reason this is a command rather than a git hook. Everything above is
  // reversible on this machine. The push after it is not, once anybody has fetched.
  if (!confirm(`Commit this to ${mirror} and push to the public repo?`)) {
    console.log("Left staged in the mirror, nothing committed.");
    return 1;
  }

  const committed = await git(mirror, ["commit", "-m", options.message]);
  if (committed.code !== 0) {
    console.error(`publish: commit failed: ${committed.err}`);
    return 1;
  }

  const pushed = await git(mirror, ["push", "origin", "main"]);
  if (pushed.code !== 0) {
    console.error(`publish: push failed: ${pushed.err}`);
    return 1;
  }

  console.log("Published.");
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
