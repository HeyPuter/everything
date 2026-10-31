import { decodeEntities } from './xml.js';

const HTML_NAMED = Object.freeze({ nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', deg: '°' });

/** Plain text from an HTML fragment (KML descriptions), without ever parsing it as markup. */
export function htmlToText(value) {
  const text = String(value ?? '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&([a-z]+);/gi, (match, name) => HTML_NAMED[name.toLowerCase()] ?? match);
  return decodeEntities(text).replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Trimmed single-line text capped at `max` characters, or '' for anything else. */
export function cleanLine(value, max = 500) {
  if (typeof value !== 'string') return '';
  return [...value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

/** Multi-line text with control characters removed, capped at `max` characters. */
export function cleanText(value, max = 100_000) {
  if (typeof value !== 'string') return '';
  return [...value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()].slice(0, max).join('');
}

/** An absolute http(s) URL without credentials, as the place schema accepts, or null. */
export function webUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000- ]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}

/** A short file-name stem: letters and digits joined by hyphens. */
export function slug(value, fallback = 'trip') {
  const stem = String(value ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return [...stem].slice(0, 60).join('').replace(/-+$/, '') || fallback;
}

/** `YYYY-MM-DD` of a local date, for file names. */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
