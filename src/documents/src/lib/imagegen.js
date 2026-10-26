/**
 * A picture from a description, through Puter AI (`puter.ai.txt2img`). The
 * SDK answers with an <img> element; its source (a data URL, or a web
 * address) becomes a File so the picture goes onto the page the same way
 * an uploaded one does, and is stored in the document.
 */

import { MAX_IMAGE_BYTES, readImageBlob } from './images.js';

const tooLarge = () => new Error('Images must be under 15 MB');

/**
 * The readable message for a picture Puter AI could not make. The SDK rejects with an Error or with its
 * own { error: { code, message } } object, whose wording is the provider's; the provider's error stays on
 * the readable one as its cause.
 */
export function generationError(e) {
  const detail = `${e?.message || ''} ${e?.error?.message || ''} ${e?.error?.code || e?.code || ''} ${typeof e === 'string' ? e : ''}`;
  const message = /insufficient|balance|credit|funds|quota|allowance|402/i.test(detail) ? 'Your Puter AI allowance has run out for now.'
    : /sign.?in|unauthori[sz]ed|401/i.test(detail) ? 'Sign in to Puter to generate pictures.'
      : /network|failed to fetch|offline|timed? ?out/i.test(detail) ? 'The AI service could not be reached. Check your connection.'
        : /moderat|safety|content.?policy|flagged|inappropriate/i.test(detail) ? 'That description cannot be made into a picture. Try describing it differently.'
          : 'The picture could not be generated. Try again in a moment.';
  return new Error(message, { cause: e });
}

/** A short, safe file stem from the description: "a red fox in snow" -> "a-red-fox-in-snow". */
export function fileNameForPrompt(prompt, ext = 'png') {
  const stem = String(prompt || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${stem || 'picture'}.${ext}`;
}

/** Parse a data URL into { type, bytes }; null when it is not one. */
export function parseDataUrl(src, { maxBytes = Infinity } = {}) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(String(src || ''));
  if (!m) return null;
  const type = m[1] || 'application/octet-stream';
  let bytes;
  if (m[2]) {
    const encoded = m[3].replace(/\s/g, '');
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    if (Math.floor(encoded.length * 3 / 4) - padding > maxBytes) throw tooLarge();
    let bin;
    try { bin = atob(encoded); } catch { throw new Error('The answer was not a picture'); }
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    // Percent escapes are raw bytes, including values that are not UTF-8.
    // Encode only literal text, into a buffer bounded by the image limit.
    const source = m[3];
    if (source.length > maxBytes * 3) throw tooLarge();
    bytes = new Uint8Array(Math.min(source.length * 3, maxBytes));
    const encoder = new TextEncoder();
    let at = 0, size = 0;
    while (at < source.length) {
      const hex = source.slice(at + 1, at + 3);
      if (source[at] === '%' && /^[\da-f]{2}$/i.test(hex)) {
        if (size === bytes.length) throw tooLarge();
        bytes[size++] = Number.parseInt(hex, 16);
        at += 3;
      } else {
        const next = source.indexOf('%', at + 1);
        const literal = source.slice(at, next < 0 ? source.length : next);
        const { read, written } = encoder.encodeInto(literal, bytes.subarray(size));
        if (read !== literal.length) throw tooLarge();
        at += read;
        size += written;
      }
    }
    bytes = bytes.subarray(0, size);
  }
  if (bytes.length > maxBytes) throw tooLarge();
  return { type, bytes };
}

/**
 * The File for a generated image element (or a bare source string), named
 * after the description. Data URLs are decoded here; web addresses are
 * fetched. Throws when the answer is not a picture.
 */
export async function imageFileFromSource(source, prompt, { fetchFn = globalThis.fetch, maxBytes = MAX_IMAGE_BYTES, signal } = {}) {
  const src = typeof source === 'string' ? source : (source?.currentSrc || source?.src || source?.getAttribute?.('src') || '');
  if (!src) throw new Error('No picture came back');
  let blob;
  const data = parseDataUrl(src, { maxBytes });
  if (data) {
    if (!data.type.startsWith('image/')) throw new Error('The answer was not a picture');
    blob = new Blob([data.bytes], { type: data.type });
  } else {
    let res;
    try { res = await fetchFn(src, { mode: 'cors', credentials: 'omit', ...(signal ? { signal } : {}) }); } catch { throw new Error('The picture could not be read back'); }
    if (!res?.ok) throw new Error(`The picture could not be read back (${res?.status || 'no response'})`);
    blob = await readImageBlob(res, maxBytes);
    if (!String(blob.type).startsWith('image/')) throw new Error('The answer was not a picture');
  }
  if (blob.size > maxBytes) throw new Error('Images must be under 15 MB');
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*$/, '');
  return new File([blob], fileNameForPrompt(prompt, ext), { type: blob.type });
}
