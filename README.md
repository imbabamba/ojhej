# ojhej.se

En kod att bära. Någon skannar den. Sen får vi se.

Anyone can sign up and get an unguessable QR code to print on a garment. A stranger who scans it
lands on a page where they can send one message, relayed by email. The wearer never publishes an
address, a handle or a phone number, and the sender never learns one.

Swedish-language, EU-hosted, no cookies, no analytics, no accounts.

This is the source of a service that is actually running, at <https://ojhej.se>, not a template
or a demo. It is published so that the privacy claims on that page can be checked rather than
believed: whether an address really is encrypted at rest, whether a message really is not stored,
whether the code really does hold no accounts and set no cookies. All of that is in here.

**Licensed [AGPL-3.0](LICENSE).** Read it, learn from it, run your own. If you run a modified
version as a network service, the licence requires you to publish your changes. See
[CONTRIBUTING.md](CONTRIBUTING.md) to work on it and [SECURITY.md](SECURITY.md) to report
something.

## Running it locally

You need nothing but the repo. No cloud account, no API keys, no database.

```bash
npm install          # installs a project-local Deno, nothing global
npx deno task dev    # http://localhost:8787
```

Mail is written to `.devmail/` instead of being sent, and the verification link is printed to
the console, so the whole loop is clickable without a mail provider.

```bash
npx deno task flow          # signup -> proof of work -> mail -> verify -> pick a purpose
npx deno task change-flow   # the change-of-address flow, including prefetch safety
npx deno task koder-flow    # several codes on one address: list, make, pause, delete
npx deno task verify        # fmt check, lint, typecheck, 490 tests
```

`deno task flow` is the fastest way to see whether something is broken: it drives the real
server and asserts on outcomes rather than printing them.

### Print files

```bash
npx deno task print-pack <KOD>     # e.g. K7M4NPQR8TVWXYZ2ABCD
```

Add `--platta` for a dark garment. Emits chest 60 mm and back 180 mm as SVG and PDF, plus the
mark on its own, into `tryck/<KOD>/`.
Every file is decoded and checked against the 0.4 mm module floor **before anything is written**,
so a pack that appears is a pack that scans. It shares the renderer with the site, so the file a
customer downloads and the file a print shop gets cannot become different codes.

## Configuration

Nothing is required to run locally. `--dev` mints throwaway keys and captures mail.

To send real mail, or to deploy:

```bash
cp .env.example .env
npx deno task keygen     # mints OJHEJ_EMAIL_KEY and OJHEJ_ALTCHA_HMAC
```

| Variable | What it is |
|---|---|
| `OJHEJ_BASE_URL` | Absolute, no trailing slash. Every link in outgoing mail is built from it. |
| `OJHEJ_EMAIL_KEY` | AES-256 key, base64. Encrypts owner addresses at rest. |
| `OJHEJ_ALTCHA_HMAC` | Signs proof-of-work challenges. 16 characters minimum. |
| `OJHEJ_SMTP2GO_KEY` | SMTP2GO API key with send permission. |
| `OJHEJ_SENDER` | `Oj hej <hej@ojhej.se>`, on a domain verified in SMTP2GO. |
| `OJHEJ_SMTP2GO_URL` | Optional. Defaults to `https://api.smtp2go.com/v3`. |
| `OJHEJ_MAIL` | `capture` (default) or `send`. Real sending is opt-in. |

Each is a separate variable with that exact name; there is no combined one and no wildcard. A
missing value fails at startup and the error names **all** of them at once, never their values.

Two things about `OJHEJ_EMAIL_KEY`. Use a different key in production than locally, or your
laptop can decrypt production addresses. And rotating it is a migration, not a config edit:
every address already stored becomes unreadable, and the first symptom is the relay returning
502 for every existing code.

Real sending is opt-in because a stray `.env` should never quietly turn a local experiment into
mail arriving in a stranger's inbox.

## How it fits together

```
ojhej.se ──▶ Bunny Pull Zone ──▶ Bunny Storage Zone (EU)
                  │                  static assets, and the JSON records
                  └─▶ Bunny Edge Script (edge/main.ts)
                        every dynamic route, from src/route.ts
```

```
src/
  route.ts     the routing table, imported by both entrypoints
  main.ts      local dev server
  handlers/    signup, verify, message, manage, change of address
  store/       crypto, tokens, records, the email index, storage adapters
  qr/          layout, then SVG and PDF serialisers over it, plus a decoder
  pages/       server-rendered HTML
  mail/        SMTP2GO client and templates
  antispam/    ALTCHA proof of work, honeypot, fill timing
edge/main.ts   production entrypoint, Bunny middleware
scripts/       flows, print pack, keygen, fonts, asset upload
```

There is one routing table and both entrypoints import it. A second one in production is how a
project works perfectly in development and 404s on a route nobody remembered to copy.

## The security model, briefly

**The slug is not a secret.** It is printed on a chest in public. Its 96 bits buy enumeration
resistance, not authentication: it routes to a form and nothing else, and the page it serves
never renders the owner's name, address or any identifier.

**Ownership is the email.** A 256-bit token, stored only as SHA-256, single-use, 30 minutes for
a management link and 7 days for the initial verification. Owner addresses are AES-GCM encrypted
at rest, so a leaked storage key does not dump every mailbox.

**A management link names an address, and the code is checked against it.** One mail reaches every
code an address owns, so the caller names which code an action is for, and the server verifies
that code belongs to that address before doing anything. "Not yours" and "never existed" are one
answer, so the endpoint cannot be asked whether a slug photographed off a jacket is real. The
check runs before the token is spent as well as after, so a refusal costs an honest owner nothing.

**Tenant isolation is structural.** Every read is a direct key lookup derived from a validated
slug or a token hash, and the `ObjectStore` interface has **no list operation**. Not "we don't
call it" — it does not exist, so a cross-tenant read cannot be written.

**Single use is decided by the delete, not by a preceding read.** There is no compare-and-swap
in this stack, but an object store serialises deletes on one key, so "did my delete remove it"
is real mutual exclusion and "was it there a moment ago" is not. The same primitive makes each
proof of work spendable exactly once, which is what stops one solve being fired at a stranger's
address in a burst.

**GET peeks, POST consumes.** Mail security gateways fetch every link at delivery. Consuming on
GET meant a scanner could burn a verification link before the owner ever clicked it, which
presents as an unreproducible bug and hits corporate mail hardest.

## Deploying

Production is a Bunny Edge Script in front of a Bunny Storage Zone, driven by the workflows in
`.github/workflows/`. The detailed runbook is specific to that account and is not published; the
table above is the whole configuration surface, and `edge/main.ts` is a hundred lines, so the
shape ports to any object store and any edge runtime with a `fetch` handler.

**One thing about the storage, and it is the sharpest edge in the deployment.** The service writes
its records into the same object store the CDN serves static files from. If the CDN is pointed at
that store without restriction, every record is world readable to anyone who has photographed a
code. `src/route.ts` answers 404 for anything outside the published asset list rather than handing
it on, and `scripts/smoke.ts` checks a running deployment for exactly this. Run it after deploying.
Better still, use two stores: one public, one reachable only by the service.

The other thing worth knowing before you start: the script runs a delete-semantics check against
the live storage at cold start and **refuses to serve if it fails**. Bunny does not document what
DELETE returns for a missing object, and the entire ownership model rests on that answer. If a
deploy fails with *"storage delete reported success for an object that was already gone"*, do not
work around it.

## Where the thinking is written down

**In the comments, mostly.** The comment-to-code ratio here is deliberately high: nearly every
non-obvious decision was made after something went wrong, and the comment records what went wrong
so the next person does not undo the fix. If you want to know why something is shaped the way it
is, the answer is usually directly above it.

Some comments cite material that is not in this repository, in two forms: a decision log by
section, as "R9 in status.md", and an approved design, as "mockups/13-klar-syfte.html". The log
records outages, wrong turns and the reasoning behind reversals; the mockups are the dated screen
designs the markup was built to match. Both are kept privately, along with the research notes and
the deploy runbook.

Those citations will not resolve here, and that is a papercut rather than a gap: the reasoning is
always in the comment itself, and the citation is a footnote saying where the decision was taken,
not where the argument lives.

## What it runs on

ojhej.se runs on three [bunny.net](https://bunny.net/) products: **Edge Scripting** for the service itself
(`edge/main.ts`), a **CDN pull zone** in front of it, and an **Edge Storage** zone in the EU
holding both the encrypted records and the static assets. Mail is relayed through
[SMTP2GO](https://www.smtp2go.com). All of them are paid accounts, and the service they run is free
for the people who use it.

This repository is the code, and only the code. Running your own means your own bunny.net and
SMTP2GO accounts, and your own bill.

## Licence

[GNU Affero General Public License v3.0](LICENSE).

The Affero clause is the point rather than an accident. This is a privacy product, and its whole
claim is that you can check what it does with your address. Someone running a modified copy as a
service, with the checking removed, would be making the same promise on weaker ground. So the
licence asks that if you run it for other people, you show them what you changed.

Using it privately, reading it, learning from it and self-hosting it for yourself carry no such
obligation. Neither do the ideas: nothing here is patented and nothing is meant to be.

The name **ojhej.se**, the mark and the Swedish copy are the identity of the running service, not
part of the grant. Please run your own under your own name.
