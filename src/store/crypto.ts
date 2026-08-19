/**
 * Every secret in this service is minted here.
 *
 * Three distinct things live in this file, and they are deliberately different sizes because
 * they defend against different attacks:
 *
 *   slug   96 bits, public. It is printed on a chest, so it is not a secret. Its job is that
 *          nobody can *enumerate* codes: at a million guesses a second against a million
 *          registered codes, the first hit is roughly 2.5 billion years out.
 *   token  256 bits, secret, single-use, short-lived. This is what actually proves ownership.
 *          Only its SHA-256 is ever stored, so a dump of the store grants nothing.
 *   email  encrypted at rest with AES-GCM. A leaked storage key must not also hand over
 *          every address we hold.
 *
 * The one mistake that would undo all of it is a weak entropy source, so randomness comes
 * from crypto.getRandomValues and there is a test that fails loudly if Math.random creeps in.
 */

/** Crockford base32: no I, L, O or U, because those are the ones people misread. */
export const SLUG_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SLUG_LENGTH = 20;
const SLUG_BYTES = 12; // 96 bits
const TOKEN_BYTES = 32; // 256 bits

const SLUG_PATTERN = new RegExp(`^[${SLUG_ALPHABET}]{${SLUG_LENGTH}}$`);

function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

/**
 * WebCrypto wants a BufferSource. Recent TypeScript parameterises Uint8Array by its backing
 * buffer, which makes a bare Uint8Array unassignable, but Bunny's edge runtime is on Deno 1.x
 * where that type parameter does not exist. Copying to a plain ArrayBuffer satisfies both
 * without version-specific syntax, and the payloads here are tens of bytes.
 */
function asBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Encode bytes as Crockford base32, five bits at a time. Not the shared base64 helper,
 * because the slug is the one value a human might read off a garment.
 */
function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += SLUG_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += SLUG_ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

export function newSlug(): string {
  return toBase32(randomBytes(SLUG_BYTES)).slice(0, SLUG_LENGTH);
}

/**
 * The gate in front of every storage read. A slug arrives from a URL, so it is attacker
 * input until proven otherwise: this must run before the value is ever used to build a
 * storage key, or a crafted slug could walk out of its own tenant.
 */
export function isValidSlug(candidate: string): boolean {
  return SLUG_PATTERN.test(candidate);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function newToken(): string {
  return toBase64Url(randomBytes(TOKEN_BYTES));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    asBuffer(new TextEncoder().encode(text)),
  );
  return toHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    asBuffer(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    asBuffer(new TextEncoder().encode(message)),
  );
  return toHex(new Uint8Array(signature));
}

/**
 * Compare without leaking, through timing, how much of a secret an attacker guessed right.
 * Length is not secret here (all our comparands are fixed-width hex), so an early length
 * exit is fine; what matters is that content comparison does not stop at the first mismatch.
 */
export function equalsConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

const IV_BYTES = 12;

/** Import the AES-256-GCM key held as a Bunny Edge Scripting secret. */
export async function importKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = fromBase64(base64Key);
  } catch {
    throw new Error("encryption key is not valid base64");
  }
  if (raw.length !== 32) {
    throw new Error(`encryption key must be 256 bits, got ${raw.length * 8}`);
  }
  return await crypto.subtle.importKey("raw", asBuffer(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Returns `iv.ciphertext`, both base64url. A fresh IV per call is what stops two users
 * with the same address producing identical ciphertext, which would otherwise leak that
 * they are the same person.
 */
export async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asBuffer(iv) },
    key,
    asBuffer(new TextEncoder().encode(plaintext)),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
}

export async function decrypt(key: CryptoKey, payload: string): Promise<string> {
  const [ivPart, dataPart] = payload.split(".");
  if (!ivPart || !dataPart) throw new Error("ciphertext is malformed");

  const iv = fromBase64Url(ivPart);
  if (iv.length !== IV_BYTES) throw new Error("ciphertext has a bad IV");

  // GCM authenticates as it decrypts, so tampering throws here rather than returning garbage.
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asBuffer(iv) },
    key,
    asBuffer(fromBase64Url(dataPart)),
  );
  return new TextDecoder().decode(opened);
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}
