/**
 * File and document naming: untitled numbering, extensions, safe file
 * names and paths. Pure functions so they are easy to test.
 */

export const NATIVE_EXT = '.vstudio';
export const NATIVE_MIME = 'application/x-vector-studio';

/** Extensions we strip when suggesting a native file name for a document. */
const KNOWN_EXT = /\.(vstudio|svg|svgz|ai|eps|epsf|ps|pdf|dxf|json|png|jpe?g|webp|gif|tiff?|bmp|psd)$/i;

/** "Untitled-N" with N one past both the session counter and any open untitled document. */
export function nextUntitled(counter = 0, openNames = []) {
  let n = Number.isFinite(counter) ? counter : 0;
  for (const name of openNames) {
    const m = /^Untitled-(\d+)(?:\.vstudio)?$/i.exec(String(name || ''));
    if (m) n = Math.max(n, Number(m[1]));
  }
  n += 1;
  return { name: `Untitled-${n}`, counter: n };
}

/** The last path segment. */
export function baseName(path) {
  const s = String(path || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Directory part of a path ('' for a bare name). */
export function dirName(path) {
  const s = String(path || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : i === 0 ? '/' : '';
}

export function joinPath(dir, name) {
  if (!dir) return name;
  return `${dir.replace(/\/+$/, '')}/${String(name).replace(/^\/+/, '')}`;
}

/** Lower-case extension with the dot ('.svg'), or ''. */
export function extensionOf(name) {
  const m = /\.[^./\\]+$/.exec(String(name || ''));
  return m ? m[0].toLowerCase() : '';
}

export function stripExtension(name) {
  return String(name || '').replace(KNOWN_EXT, '');
}

/** Replace characters file systems reject and trim; never returns an empty stem. */
export function sanitizeStem(stem) {
  const s = String(stem || '')
    .replace(/[\u0000-\u001f/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return s || 'Untitled';
}

/**
 * Ensure a file name ends with `ext`. A different known extension (an
 * imported "logo.svg") is replaced; anything else is kept and the extension
 * appended ("v1.2" -> "v1.2.vstudio").
 */
export function ensureExtension(name, ext = NATIVE_EXT) {
  const raw = String(name || '').trim();
  if (raw.toLowerCase().endsWith(ext.toLowerCase())) {
    const stem = raw.slice(0, raw.length - ext.length);
    return `${sanitizeStem(stem)}${ext}`;
  }
  return `${sanitizeStem(stripExtension(raw))}${ext}`;
}

/** The native file name to suggest in Save As for a document or file name. */
export function suggestFileName(name) {
  return ensureExtension(name || 'Untitled', NATIVE_EXT);
}

/** A name not in `existing` (case-insensitive): "Logo.vstudio" -> "Logo 2.vstudio". */
export function uniqueName(name, existing) {
  const taken = new Set([...existing].map((n) => String(n).toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const ext = extensionOf(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const base = stem.replace(/ \d+$/, '');
  for (let i = 2; i < 10000; i++) {
    const candidate = `${base} ${i}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}${ext}`;
}

/** What kind of file a name or leading bytes describe: 'native' | 'svg' | 'unknown'. */
export function fileKind(name, head = null) {
  const ext = extensionOf(name);
  if (ext === NATIVE_EXT) return 'native';
  if (ext === '.svg' || ext === '.svgz') return 'svg';
  if (head && head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return ext === '.svgz' ? 'svg' : 'native';
  if (head) {
    const text = new TextDecoder().decode(head.subarray(0, 256)).replace(/^﻿/, '').trimStart();
    if (text.startsWith('{')) return 'native';
    if (text.startsWith('<')) return /<svg[\s>]/i.test(text) || text.startsWith('<?xml') ? 'svg' : 'unknown';
  }
  return 'unknown';
}

/** Short relative time for lists ("Just now", "5 min ago", "Yesterday", a date). */
export function relativeTime(ms, now = Date.now()) {
  if (!ms) return '';
  const d = Math.max(0, now - ms);
  const min = 60 * 1000;
  if (d < min) return 'Just now';
  if (d < 60 * min) return `${Math.floor(d / min)} min ago`;
  if (d < 24 * 60 * min) return `${Math.floor(d / (60 * min))} h ago`;
  if (d < 48 * 60 * min) return 'Yesterday';
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
