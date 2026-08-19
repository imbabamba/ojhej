# Contributing

This is a small, opinionated project run by one person. Contributions are welcome, and it is
worth reading this first, because a few things here are deliberate that usually are not.

## Running it

You need nothing but the repo. No cloud account, no API keys, no database.

```bash
npm install          # installs a project-local Deno, nothing global
npx deno task dev    # http://localhost:8787
```

Mail is written to `.devmail/` instead of being sent and the verification link is printed to the
console, so the whole loop is clickable without a mail provider. Storage is `.devdata/` on disk.

## Before you open a pull request

```bash
npx deno task verify   # fmt, lint, typecheck, and the full test suite
```

CI runs exactly this and nothing else, so a green run locally is a green run there. It needs no
secrets, so it runs on pull requests from forks.

For anything touching a flow rather than a single function, drive it:

```bash
npx deno task flow          # signup, proof of work, mail, verify, pick a purpose
npx deno task change-flow   # change of address, including prefetch safety
npx deno task koder-flow    # several codes on one address
```

These drive a real running server and assert on outcomes. They catch the class of bug the unit
tests cannot, which is every seam at once: HTTP, storage on disk, a real mail render, and the
redirect that finally reveals the slug.

## The house style, and why

**Comments explain why, at length.** This codebase has an unusually high comment-to-code ratio
and that is on purpose. Nearly every non-obvious decision here was made after something went
wrong, and the comment records what went wrong so the next person does not undo the fix. If you
change something a comment defends, change the comment too, or say in the pull request why the
reason no longer holds. A comment that has quietly become false is worse than no comment.

Several comments cite a decision log by section ("R9 in status.md"). That log is kept privately,
so those references will not resolve for you. The reasoning is always in the comment itself; the
citation is a footnote, not the argument.

**Tests come first, and they assert behaviour rather than shape.** Look at the existing ones
before writing new ones. They are written as sentences about what the system must do, and the
test name is the claim.

**Refuse rather than truncate**, for anything a person typed. A truncated line publishes half a
sentence somebody never wrote.

**Validate at the boundary the value arrived through.** Storage is not trusted; a value read back
out is validated as carefully as one that arrived in a request.

**There is no `list` on the object store, deliberately.** It is the one operation that could turn
a bug into a cross-tenant read, and its absence is what makes that impossible to write rather
than merely unwritten. Please do not add one.

## What is likely to be turned down

- A dependency, unless it earns its place loudly. The runtime dependency list is deliberately
  almost empty.
- A framework, a build step, or a bundler beyond `deno bundle`.
- Analytics, cookies, or anything that phones a third party. The privacy claims on the landing
  page are load-bearing and there is a test asserting no page reaches out to another origin.
- Accounts, passwords or sessions. The absence of them is the product.
- Reformatting or renaming passes unrelated to a change you are making.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under the AGPL-3.0, the same as the
rest of the project. See [LICENSE](LICENSE).
