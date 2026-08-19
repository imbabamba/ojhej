# Security

ojhej.se relays messages between strangers without either of them learning the other's contact
details. Nearly every bug that matters here is a privacy bug, so please read the second section
before deciding something is not worth reporting.

## Reporting

**Please do not open a public issue for a vulnerability.**

Use GitHub's [private vulnerability reporting](https://github.com/imbabamba/ojhej/security/advisories/new)
on this repository. That opens a private thread with the maintainer and is the fastest route.

If that is not available to you, send a message through the service itself: scan the QR code in
the site footer, or go to <https://ojhej.se>. That reaches a real inbox and goes through the same
relay as every other message, which is either reassuring or the first thing you should test.

Please include what you did, what happened, and what you expected. A rough description of a real
problem is worth more than a polished description of a theoretical one. If you have a proof of
concept, say so and hold it until we have talked.

You will get an acknowledgement. This is one person on European time, not a security team, so
allow a few days before assuming the message went nowhere.

## What counts

The properties this service is built to hold, roughly in order of how badly it would matter:

- **An owner's email address never reaches anybody.** Not the sender, not a page, not a log, not
  a URL, not an error message. It is encrypted at rest and decrypted only to hand to the mail
  provider.
- **A sender's contact details are never stored.** They pass through in one email and are gone.
- **A code cannot be linked to a person** by anyone who has only seen the code.
- **Single-use links are single-use.** Verification links, management links and proof-of-work
  solutions must not be replayable.
- **A code's slug is not guessable.** Codes are printed in public, so they are semi-public by
  design, but the space must be large enough that scanning for valid ones is pointless.
- **Nobody can send mail through this service to an address they do not control**, beyond the
  documented per-address daily caps.
- **Nothing is served to a stranger that reveals whether an address is registered.** An unknown
  code and a deleted code answer identically, on purpose.

Also in scope: anything that lets a message reach the wrong person, XSS or injection anywhere a
stranger's text is rendered, and any way to read the service's own stored records.

## What does not count

- Missing security headers with no demonstrated impact.
- Rate limiting on endpoints that send no mail and write nothing.
- Reports from automated scanners with no working proof.
- Volumetric denial of service. It is a small service on a CDN, this is understood.
- The activation counter being wrong. It races on purpose and gates nothing.
- The daily caps being approximate under concurrency. This is documented and accepted: the
  object store offers no compare-and-swap, so the caps bound rather than enforce.

## If you run your own

This is AGPL-3.0 and you are welcome to. The properties above are ones the code tries to hold,
not ones your deployment inherits for free. Two things in particular are configuration rather
than code:

- **The object store must not be reachable from the public internet.** The service writes its
  records into an object store; if a CDN is pointed at that store, every record is world
  readable. `scripts/smoke.ts` checks this against a running deployment and it is worth running.
- **Secrets are secrets.** `OJHEJ_EMAIL_KEY` decrypts every owner address you hold. Losing it is
  worse than losing the database, because the database is useless without it.
