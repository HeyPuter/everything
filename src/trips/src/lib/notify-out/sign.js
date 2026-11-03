// Webhook signatures: `Trips-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
// Receivers recompute the HMAC over the raw body and reject timestamps more than 5 minutes old.
const encoder = new TextEncoder();
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export async function hmacHex(secret, message, subtle = globalThis.crypto.subtle) {
  const key = await subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await subtle.sign('HMAC', key, encoder.encode(message)));
}

export async function signatureHeader(secret, body, at, subtle) {
  const seconds = Math.floor(at / 1000);
  return `t=${seconds},v1=${await hmacHex(secret, `${seconds}.${body}`, subtle)}`;
}

/** Receiver-side check, also used by tests: true when `header` signs `body` within `tolerance` ms of `now`. */
export async function verifySignature(secret, body, header, { now = Date.now(), tolerance = 300_000, subtle } = {}) {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header ?? ''));
  if (!match) return false;
  const seconds = Number(match[1]);
  if (Math.abs(now - seconds * 1000) > tolerance) return false;
  const expected = await hmacHex(secret, `${seconds}.${body}`, subtle);
  let diff = 0;
  for (let index = 0; index < expected.length; index++) diff |= expected.charCodeAt(index) ^ match[2].charCodeAt(index);
  return diff === 0;
}
