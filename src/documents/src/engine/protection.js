// Original document-protection model (ECMA-376 Part 1 §17.15.1.29
// documentProtection, §17.13.7 permStart/permEnd). The password
// verifier is the specification's iterated, salted hash. Writers that follow
// the legacy-compatible procedure first reduce the password to a 32-bit key
// (the spec's high-order/low-order word construction) and hash that key's
// hexadecimal text; verification accepts either input so files from both
// kinds of writer can be unlocked.
import { digest } from './sha.js';
import { columnBookmarkResolver } from './column-bookmarks.js';

/** Editing restrictions (§17.18.18 ST_DocProtect) offered by the Restrict Editing pane. */
export const EDIT_RESTRICTIONS = ['none', 'readOnly', 'comments', 'trackedChanges', 'forms'];
/** Legacy cryptAlgorithmSid values (§17.15.1.29) for the hash algorithms supported here. */
export const ALGORITHM_SIDS = { 4: 'SHA-1', 12: 'SHA-256', 13: 'SHA-384', 14: 'SHA-512' };
export const DEFAULT_SPIN_COUNT = 100000;

// The key-derivation tables of the legacy procedure. Each row of the matrix
// is a 16-bit linear-feedback sequence (shift left, fold the carry back with
// 0x1021), so only its first value needs stating; the rest are generated.
const INITIAL_CODES = [0xE1F0, 0x1D0F, 0xCC9C, 0x84C0, 0x110C, 0x0E10, 0xF1CE, 0x313E, 0x1872, 0xE139, 0xD40F, 0x84F9, 0x280C, 0xA96A, 0x4EC3];
const MATRIX_SEEDS = [0xAEFC, 0x7B61, 0x4563, 0x0375, 0xD849, 0x6F45, 0xEB23, 0x47D3, 0xB861, 0x45A0, 0xAA51, 0x76B4, 0x3730, 0x3331, 0x1021];
const step = value => ((value << 1) & 0xFFFF) ^ (value & 0x8000 ? 0x1021 : 0);
export const ENCRYPTION_MATRIX = MATRIX_SEEDS.map(seed => { const row = [seed]; while (row.length < 7) row.push(step(row.at(-1))); return row; });

/** The password's single-byte form: each UTF-16 unit's low byte, or its high byte when the low byte is zero. At most 15 characters count. */
export function legacyPasswordBytes(password) {
  const units = String(password).slice(0, 15);
  return [...Array(units.length)].map((_, i) => { const code = units.charCodeAt(i); return code & 0xFF || code >> 8; });
}

/** The legacy 32-bit key: high-order word from the code tables, low-order word from a rotating checksum. */
export function legacyPasswordKey(password) {
  const bytes = legacyPasswordBytes(password);
  if (!bytes.length) return 0;
  let high = INITIAL_CODES[bytes.length - 1];
  bytes.forEach((byte, i) => {
    const row = ENCRYPTION_MATRIX[15 - bytes.length + i];
    for (let bit = 0; bit < 7; bit++) if (byte & (1 << bit)) high ^= row[bit];
  });
  const rotate = word => ((word >> 14) & 1) | ((word << 1) & 0x7FFF);
  let low = 0;
  for (let i = bytes.length - 1; i >= 0; i--) low = rotate(low) ^ bytes[i];
  low = rotate(low) ^ bytes.length ^ 0xCE4B;
  return ((high << 16) | low) >>> 0;
}

/** The key's bytes in reversed (little-endian) order as uppercase hexadecimal, e.g. 0x64CEED7E → "7EEDCE64". */
export function legacyKeyText(key) {
  return [0, 8, 16, 24].map(shift => ((key >>> shift) & 0xFF).toString(16).toUpperCase().padStart(2, '0')).join('');
}

const utf16le = text => { const bytes = new Uint8Array(text.length * 2); for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); bytes[2 * i] = c & 0xFF; bytes[2 * i + 1] = c >> 8; } return bytes; };
export const bytesToBase64 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
export const base64ToBytes = text => Uint8Array.from(atob(String(text).trim()), c => c.charCodeAt(0));
const concat = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

/**
 * The iterated hash: H0 = H(salt ‖ input), then H(n+1) = H(Hn ‖ n as a 32-bit little-endian integer)
 * for n = 0 … spinCount−1. With `legacy` the input is the legacy key text, otherwise the password, both
 * as UTF-16LE. Returns the digest bytes.
 */
export function iteratedHash(password, { algorithm = 'SHA-512', salt, spinCount = DEFAULT_SPIN_COUNT, legacy = true } = {}) {
  if (!Object.values(ALGORITHM_SIDS).includes(algorithm)) throw new Error(`Unsupported protection hash algorithm: ${algorithm}.`);
  if (!Number.isInteger(spinCount) || spinCount < 0 || spinCount > 10000000) throw new Error('Invalid protection spin count.');
  const input = utf16le(legacy ? legacyKeyText(legacyPasswordKey(password)) : String(password));
  let hash = digest(algorithm, concat(salt || new Uint8Array(), input));
  const buffer = new Uint8Array(hash.length + 4), view = new DataView(buffer.buffer);
  for (let i = 0; i < spinCount; i++) {
    buffer.set(hash); view.setUint32(hash.length, i, true);
    hash = digest(algorithm, buffer);
  }
  return hash;
}

/** A fresh verifier for a password: { algorithmName, hashValue, saltValue, spinCount } (§17.15.1.29 AG_Password). */
export async function createPasswordVerifier(password, { algorithm = 'SHA-512', spinCount = DEFAULT_SPIN_COUNT, salt } = {}) {
  if (!password) return null;
  salt ||= globalThis.crypto.getRandomValues(new Uint8Array(16));
  const hash = iteratedHash(password, { algorithm, salt, spinCount, legacy: true });
  return { algorithmName: algorithm, hashValue: bytesToBase64(hash), saltValue: bytesToBase64(salt), spinCount };
}

/** Whether a protection record has a password verifier at all. */
export const hasPassword = protection => !!(protection?.hashValue || protection?.hash);

/** Check a password against a protection record's verifier (either attribute form). */
export async function verifyPassword(password, protection) {
  if (!hasPassword(protection)) return true;
  const algorithm = protection.algorithmName ? normalizedAlgorithm(protection.algorithmName) : ALGORITHM_SIDS[protection.cryptAlgorithmSid];
  if (!algorithm) throw new Error('This document uses a protection hash this editor cannot check.');
  const salt = base64ToBytes(protection.saltValue ?? protection.salt ?? '');
  const spinCount = Number(protection.spinCount ?? protection.cryptSpinCount ?? 0);
  const expected = protection.hashValue ?? protection.hash;
  for (const legacy of [true, false]) {
    if (bytesToBase64(iteratedHash(password, { algorithm, salt, spinCount, legacy })) === String(expected).trim()) return true;
  }
  return false;
}
function normalizedAlgorithm(name) {
  const key = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512' }[key] || null;
}

/* ---- Editing permissions (§17.13.7 permStart / permEnd) ---- */

const length = p => p.runs.reduce((n, r) => n + r.text.length, 0);
export const isPermissionMarker = marker => !!marker?.perm;

/**
 * Permission ranges as { id, start, end, ed, edGrp } absolute positions, in document order. A range opened in a
 * table cell with colFirst/colLast (§17.13.7.2) covers only those columns of the rows it spans: given the
 * document's `tables`, it is listed once for each of those cells, over the cell's paragraphs.
 */
export function permissionRanges(paragraphs, tables = null) {
  const found = new Map(); let at = 0;
  for (const p of paragraphs) {
    for (const marker of p.bookmarks || []) {
      if (!marker.perm) continue;
      const entry = found.get(marker.permId) || { id: marker.permId };
      const position = at + Math.min(marker.offset, length(p));
      if (marker.edge === 'start') Object.assign(entry, { start: position, ed: marker.ed || null, edGrp: marker.edGrp || null, startMarker: marker, startParagraph: p.id });
      else Object.assign(entry, { end: position, endMarker: marker, endParagraph: p.id });
      found.set(marker.permId, entry);
    }
    at += length(p) + 1;
  }
  const ranges = [];
  let resolve, cells;
  for (const { startMarker, endMarker, startParagraph, endParagraph, ...range } of found.values()) {
    if (range.start === undefined || range.end === undefined || range.end < range.start) continue;
    let columns = null;
    if (startMarker.tableColumns && tables?.length) {
      resolve ||= columnBookmarkResolver(paragraphs, tables);
      try { columns = resolve({ ...range, startMarker, endMarker, startParagraph, endParagraph }); } catch { columns = null; }
    }
    if (!columns) { ranges.push(range); continue; }
    // One range per selected cell, from its first paragraph to its last, so the marks between them are inside.
    cells ||= new Map(paragraphs.map(p => [p.id, p.cellId]));
    let last = null;
    for (const piece of columns.ranges) {
      const cell = cells.get(piece.paragraphId);
      if (last && last.cell === cell && last.end + 1 === piece.start) { last.end = piece.end; continue; }
      ranges.push(last = { ...range, start: piece.start, end: piece.end, cell });
    }
  }
  for (const range of ranges) delete range.cell;
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}
/** Whether a user may edit a permission range: everyone, or a named editor that matches the user. */
export function permissionApplies(range, user = {}) {
  if (range.edGrp === 'everyone') return true;
  if (range.edGrp && !range.ed) return range.edGrp === 'current' || range.edGrp === 'editors' && !!user.editor;
  if (!range.ed) return false;
  const who = String(range.ed).trim().toLowerCase();
  return [user.name, user.email].some(id => id && String(id).trim().toLowerCase() === who);
}

/** The next unused permission identifier. */
export function nextPermissionId(paragraphs) {
  const used = new Set(paragraphs.flatMap(p => (p.bookmarks || []).filter(m => m.perm).map(m => Number(m.permId))));
  let id = 1; while (used.has(id)) id++;
  return String(id);
}

/** The protected content as a flat token list: text outside editable ranges, and each protected paragraph mark. */
export function protectedSignature(paragraphs, editable) {
  const tokens = []; let at = 0;
  // A character or mark at p is editable inside a range with start <= p < end, a marker at p with start <= p <= end.
  // The ranges are merged once: asking every range about every character made each keystroke in a long protected
  // document with many editable regions take a large fraction of a second.
  const merge = closed => {
    const out = [];
    for (const r of [...editable].sort((a, b) => a.start - b.start)) {
      if (!closed && r.end <= r.start) continue;
      const last = out.at(-1);
      if (last && r.start <= last[1]) last[1] = Math.max(last[1], r.end); else out.push([r.start, r.end]);
    }
    return out;
  };
  const spans = merge(false), points = merge(true);
  // Positions are asked about in increasing order, so the first span not yet passed is kept.
  let next = 0;
  const outside = (from, text) => {
    const to = from + text.length;
    while (next < spans.length && spans[next][1] <= from) next++;
    let out = '', position = from;
    for (let k = next; position < to; k++) {
      const span = spans[k];
      if (!span || span[0] >= to) { out += text.slice(position - from); break; }
      if (span[0] > position) out += text.slice(position - from, span[0] - from);
      position = Math.max(position, span[1]);
    }
    return out;
  };
  const pointInside = position => {
    let low = 0, high = points.length - 1;
    while (low <= high) { const middle = (low + high) >> 1; if (points[middle][1] < position) low = middle + 1; else if (points[middle][0] > position) high = middle - 1; else return true; }
    return false;
  };
  const push = token => {
    const last = tokens.at(-1);
    if (token[0] === 't' && last?.[0] === 't' && last[2] === token[2] && last[3] === token[3]) last[1] += token[1]; else tokens.push(token);
  };
  for (const p of paragraphs) {
    const { id, runs, bookmarks, fieldMarkers, markRevision, formatRevision, ...rest } = p;
    let offset = at;
    for (const run of runs) {
      const text = outside(offset, run.text);
      if (text) { const { text: _, revision, formatRevision: f, ...format } = run; push(['t', text, JSON.stringify(format), revision?.type || null]); }
      offset += run.text.length;
    }
    const markers = (bookmarks || []).filter(m => !m.perm && !m.comment && !pointInside(at + m.offset)).map(m => [m.id, m.edge]);
    if (outside(offset, '\n')) push(['p', JSON.stringify(rest), markers, markRevision?.type || null]);
    at = offset + 1;
  }
  return JSON.stringify(tokens);
}

/** Text as it was before any tracked change: insertions removed, deletions kept (marks included). */
export function originalText(paragraphs) {
  let out = '';
  for (const p of paragraphs) {
    for (const run of p.runs) if (run.revision?.type !== 'ins') out += run.text;
    if (p.markRevision?.type !== 'ins') out += '\n';
  }
  return out;
}

/**
 * The content of the drawings tracking cannot record changes to (text in text boxes, shapes and diagrams, a chart's
 * series, categories and values), in document order. A drawing that is itself a tracked insertion is left out: its
 * content is part of that insertion. Formatting (size, position, fill, a chart's colors) is not content.
 */
export function drawingContent(paragraphs, assets = {}) {
  const seen = new Set();
  const textOf = list => (list || []).map(p => p.runs.map(r => r.image ? `[${content(r.image)}]` : r.text).join('')).join('\n');
  const scene = node => [node?.text ? textOf(node.text.paragraphs) : '', ...(node?.children || []).map(scene)].filter(Boolean).join('\n');
  function content(image) {
    const asset = assets[image.assetId];
    if (!asset || seen.has(asset)) return '';
    seen.add(asset);
    try {
      if (asset.chart) return JSON.stringify([asset.chart.title ?? null, (asset.chart.series || []).map(s => [s.name ?? null, s.categories ?? null, s.values ?? null, s.xValues ?? null, s.sizes ?? null])]);
      return asset.scene ? scene(asset.scene) : '';
    } finally { seen.delete(asset); }
  }
  return JSON.stringify(paragraphs.flatMap(p => p.runs.filter(r => r.image && r.revision?.type !== 'ins').map(r => content(r.image))));
}

export class ProtectionError extends Error {}

/**
 * A guard for story transactions under enforced protection. It returns null when nothing is
 * restricted, otherwise check(beforeState, model) which throws a ProtectionError for a change
 * the restriction does not allow. Editable regions are the permission ranges that apply to the
 * user, plus content controls for forms.
 */
export function protectionGuard(protection, user = {}, { contentControlRanges } = {}) {
  if (!protection?.enforcement) return null;
  const edit = protection.edit || 'none', formatting = !!protection.formatting;
  if (edit === 'none' && !formatting) return null;
  return function check(before, model, path = null) {
    const after = model.paragraphs;
    if (path !== null) {
      // Headers, footers and notes carry no permission ranges of their own here, and cannot hold tracked
      // changes: where every change must be tracked, they cannot be changed at all.
      if (edit === 'trackedChanges') throw new ProtectionError('Changes to this document are tracked, and headers, footers and notes cannot be changed with tracking here.');
      if (edit !== 'none') throw new ProtectionError(edit === 'comments' ? 'This document is protected: only comments can be added.' : 'This part of the document is protected.');
    } else if (edit === 'trackedChanges') {
      // Track Changes stays on while tracking is locked (restrict-editing.js): what gets here is a change tracking
      // cannot record, such as field results renumbered in place (captions, citations, a table of contents) or a
      // table's structure.
      // Text in a text box, shape, chart or diagram is replaced with the drawing (drawing-text.js), untracked.
      if (originalText(before.paragraphs) !== originalText(after) || JSON.stringify(before.tables) !== JSON.stringify(model.tables)
        || drawingContent(before.paragraphs, model.assets) !== drawingContent(after, model.assets)) throw new ProtectionError('This change can’t be tracked, and tracking is locked. Unlock tracking to make it.');
    } else if (edit !== 'none') {
      const regions = (state, tables) => [...permissionRanges(state, tables).filter(r => permissionApplies(r, user)), ...(edit === 'forms' && contentControlRanges ? contentControlRanges(state) : [])];
      const changed = protectedSignature(before.paragraphs, regions(before.paragraphs, before.tables)) !== protectedSignature(after, regions(after, model.tables));
      if (changed) throw new ProtectionError(edit === 'comments' ? 'This document is protected: only comments can be added.' : edit === 'forms' ? 'This document is protected: only form fields can be filled in.' : 'This part of the document is protected. Edit only in the highlighted regions.');
      if (edit === 'readOnly' || edit === 'forms') {
        if (JSON.stringify(before.comments || []) !== JSON.stringify(model.comments || [])) throw new ProtectionError('This document is protected: comments cannot be changed.');
      }
      if (JSON.stringify(before.tables) !== JSON.stringify(model.tables)) throw new ProtectionError('This document is protected: tables cannot be restructured.');
    }
    if (JSON.stringify(before.pageSettings) !== JSON.stringify(model.pageSettings)) throw new ProtectionError('This document is protected: page setup cannot be changed.');
    if (formatting) {
      if (JSON.stringify(before.styles) !== JSON.stringify(model.styles)) throw new ProtectionError('Formatting is restricted: styles cannot be changed.');
      const locked = new Set(protection.lockedStyles || []);
      const directFormats = paragraphs => new Set(paragraphs.flatMap(p => [JSON.stringify(p.formatOverrides || {}), ...p.runs.map(r => JSON.stringify(r.overrides || {}))]));
      const known = directFormats(before.paragraphs);
      for (const key of directFormats(after)) if (!known.has(key)) throw new ProtectionError('Formatting is restricted: apply one of the allowed styles instead.');
      const beforeStyles = new Set(before.paragraphs.flatMap(p => [p.styleId || '', ...p.runs.map(r => r.styleId || '')]));
      for (const p of after) for (const id of [p.styleId || '', ...p.runs.map(r => r.styleId || '')]) if (!beforeStyles.has(id) && locked.has(id)) throw new ProtectionError('Formatting is restricted: that style is not allowed.');
    }
  };
}
