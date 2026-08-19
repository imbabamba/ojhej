/**
 * SMTP2GO over its HTTPS JSON API.
 *
 * The API, not SMTP, because Bunny's edge runtime cannot open a socket. Verified shape in
 * specs/ojhej/research-2026-08-12-smtp2go.md: POST {base}/email/send, key in the
 * `X-Smtp2go-Api-Key` header, and a response of
 * `{ request_id, data: { succeeded, failed, failures, email_id } }`.
 *
 * Two things here are not incidental:
 *
 * 1. A 200 does not mean the mail was sent. SMTP2GO answers 200 with `succeeded: 0` when it
 *    took the request but not the message. Trusting `response.ok` would drop mail silently,
 *    and nobody would ever learn that a stranger had written to them.
 * 2. Header fields are scrubbed of CR and LF. Subject and reply-to are built from text a
 *    stranger typed into a public form, and a bare newline in a header is how one mail
 *    becomes two.
 */

export interface Smtp2goConfig {
  apiKey: string;
  /** Base URL without a trailing slash. In an env var because the EU account may differ. */
  baseUrl: string;
  sender: string;
  /** Optional override, mostly so tests need not sit through the real one. */
  timeoutMs?: number;
}

export interface MailMessage {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  /** Always the owner's own address. Never anything a visitor typed. */
  replyTo?: string;
}

/**
 * Everything that lands in a header gets flattened to a single line.
 *
 * U+2028 and U+2029 are included because they are line terminators to JavaScript while
 * reading as ordinary whitespace to String.trim, so a trailing one vanishes silently and an
 * embedded one would otherwise survive. A review caught that this scrub had been recorded
 * as done in status.md while the code still only matched CR and LF.
 */
function headerSafe(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

/**
 * R18. Without this the call hangs for whatever the runtime happens to default to, which on an
 * edge isolate is not something to leave to chance: a stalled mail send holds a request open
 * and the person waiting sees a spinner rather than an error they can act on.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export async function sendMail(
  config: Smtp2goConfig,
  message: MailMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<{ emailId: string }> {
  const payload: Record<string, unknown> = {
    sender: headerSafe(config.sender),
    to: [headerSafe(message.to)],
    subject: headerSafe(message.subject),
    // Both parts, always. HTML-only mail lands in spam far more often.
    text_body: message.textBody,
    html_body: message.htmlBody,
  };

  if (message.replyTo) {
    payload.custom_headers = [{ header: "Reply-To", value: headerSafe(message.replyTo) }];
  }

  const abort = new AbortController();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/email/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        // In the header, never the body, so a logged request body carries no secret.
        "X-Smtp2go-Api-Key": config.apiKey,
      },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
  } catch (cause) {
    // An abort here is the timeout firing, and it should read as one rather than as a
    // mysterious DOMException in a log three days later.
    if (abort.signal.aborted) {
      throw new Error(`smtp2go did not answer within ${timeoutMs}ms`);
    }
    throw cause;
  } finally {
    // Always, or a resolved request leaves a pending timer holding the isolate awake.
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`smtp2go refused the request with status ${response.status}`);
  }

  let parsed: { data?: { succeeded?: number; failures?: unknown[] } };
  try {
    parsed = await response.json();
  } catch {
    throw new Error("smtp2go returned a body that is not JSON");
  }

  const succeeded = parsed.data?.succeeded ?? 0;
  if (succeeded < 1) {
    // Deliberately does not interpolate the config: an error message is a thing that gets logged.
    throw new Error(
      `smtp2go accepted the request but succeeded=${succeeded}, so nothing was delivered`,
    );
  }

  return { emailId: String((parsed.data as { email_id?: string })?.email_id ?? "") };
}
