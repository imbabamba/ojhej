/**
 * The one place this service writes a log line.
 *
 * Bunny's edge runtime gives us no OpenTelemetry, so structured JSON lines are the whole
 * observability story. That makes two things matter: every line must be machine-parseable,
 * and no line may ever carry a secret. Both are enforced here rather than at the call sites,
 * because a call site will eventually get it wrong.
 */

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Sink = (line: string) => void;

const defaultSink: Sink = (line) => {
  // deno-lint-ignore no-console
  console.log(line);
};

let sink: Sink = defaultSink;
let minLevel: Level = "info";

/**
 * Field names that must never reach a log. Matched loosely and case-insensitively, so
 * `apiKey`, `storageAccessKey` and `manageToken` are all caught without being enumerated.
 * Erring towards over-redaction is correct: a redacted field costs a debugging session,
 * a leaked one costs a user's mailbox.
 */
const SENSITIVE =
  /(key|token|secret|password|passwd|auth|cookie|session|mail|kontakt|epost|e-post|adress|meddelande|namn)/i;

/**
 * How deep to walk before giving up. Nothing this application logs is deeply nested, and a
 * bound means a cyclic or hostile structure cannot turn a log line into a hang.
 */
const MAX_DEPTH = 6;

/**
 * Redact by field name, all the way down.
 *
 * This used to inspect only top-level keys, which meant `info("x", { record })` walked straight
 * past an encrypted address or a token sitting one level in. The names are the same at every
 * depth, so the check should be too.
 *
 * Arrays are walked rather than stringified, because a list of records is exactly the shape
 * that would otherwise slip through whole.
 */
function redact(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[too deep]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  // Anything with a custom shape (Date, Error, Request) is not a plain bag of fields, and
  // walking it would produce nonsense. Let JSON.stringify handle it as it always has.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE.test(key) ? "[redacted]" : redact(inner, depth + 1);
  }
  return out;
}

export function setLevel(level: Level): void {
  minLevel = level;
}

export function log(
  level: Level,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  if (ORDER[level] < ORDER[minLevel]) return;

  const safe = redact(fields, 0) as Record<string, unknown>;

  // JSON.stringify escapes quotes and newlines, so one call can never produce two lines.
  sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...safe }));
}

/**
 * How long a stack may be before it is cut short.
 *
 * An edge platform's log pane truncates, and half a JSON line is a parse error rather than a log
 * line. The frames that identify a throw sit at the top, so cutting the tail costs nothing worth
 * having.
 */
const MAX_STACK_CHARS = 2000;

/**
 * Turn whatever was thrown into fields worth reading.
 *
 * The unhandled handler used to log `String(cause)`, which yields "Error: message" and silently
 * drops the stack. On 2026-08-15 an isolate refused to start because the delete-semantics probe
 * would not vouch for the store, and the whole record of it was one line carrying that message.
 * Nothing said which path, nothing said it was a cold start rather than a handler, and nothing
 * said where in the code it came from.
 *
 * Note what this does not do: `redact` inspects field names and never values, so neither the
 * message nor the stack is scrubbed. That is acceptable for what this application throws, where
 * storage keys are hashes and slugs are public. It is not a licence to interpolate an address or
 * a token into an error message.
 */
export function errorFields(cause: unknown): Record<string, unknown> {
  if (!(cause instanceof Error)) {
    return { err: "unknown", errMessage: String(cause) };
  }

  return {
    err: cause.name,
    errMessage: cause.message,
    stack: (cause.stack ?? "").slice(0, MAX_STACK_CHARS),
  };
}

export const debug = (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields);
export const info = (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields);
export const warn = (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields);
export const error = (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields);

/**
 * Collect the lines emitted while `fn` runs. Test-only, but it lives here so the sink itself
 * stays private and cannot be left swapped by a test that throws.
 */
export function captureLines(fn: () => void): string[] {
  const lines: string[] = [];
  const previousSink = sink;
  const previousLevel = minLevel;
  sink = (line) => lines.push(line);
  try {
    fn();
  } finally {
    sink = previousSink;
    minLevel = previousLevel;
  }
  return lines;
}
