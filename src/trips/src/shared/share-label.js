// The label Puter shows a KV share's holder. The platform refuses control, formatting and line-separator characters,
// more than 3 combining marks on one character, and more than 128 characters or 512 bytes.
const encoder = new TextEncoder();

/** A label Puter accepts, or null when nothing is left. */
export function shareLabel(text) {
  const clean = String(text ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/(\p{M}{3})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...clean].slice(0, 128);
  while (chars.length && encoder.encode(chars.join('')).length > 512) chars.pop();
  return chars.join('').trim() || null;
}
