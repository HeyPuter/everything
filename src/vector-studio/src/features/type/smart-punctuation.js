/**
 * Type > Smart Punctuation: typographer's quotes, dashes, ellipses,
 * fractions, single spaces after sentences and ligature characters, in the
 * selected text or the whole document, with a summary of what changed.
 *
 * smartEdits() is a pure function returning the replacements for a text;
 * applying them goes through replaceRange so character styles and
 * paragraph settings stay with their characters.
 */
import { h } from '../../lib/dom.js';
import { replaceRange, overridesAt, applyRunStyle } from '../../model/text-runs.js';
import { selectedTextNodes } from './outlines.js';

export const PUNCT_KINDS = {
  quotes: 'Smart quotes',
  dashes: 'En and em dashes',
  ellipses: 'Ellipses',
  fractions: 'Fractions',
  spaces: 'Single spaces after sentences',
  ligatures: 'Ligature characters',
};

export const DEFAULT_PUNCT_OPTIONS = Object.freeze({ quotes: true, dashes: true, ellipses: true, fractions: false, spaces: true, ligatures: false });

const FRACTIONS = {
  '1/2': '\u00bd',
  '1/3': '\u2153',
  '2/3': '\u2154',
  '1/4': '\u00bc',
  '3/4': '\u00be',
  '1/5': '\u2155',
  '2/5': '\u2156',
  '3/5': '\u2157',
  '4/5': '\u2158',
  '1/6': '\u2159',
  '5/6': '\u215a',
  '1/7': '\u2150',
  '1/8': '\u215b',
  '3/8': '\u215c',
  '5/8': '\u215d',
  '7/8': '\u215e',
  '1/9': '\u2151',
  '1/10': '\u2152',
};

const LIGATURES = [
  ['ffi', '\ufb03'],
  ['ffl', '\ufb04'],
  ['ff', '\ufb00'],
  ['fi', '\ufb01'],
  ['fl', '\ufb02'],
];

/** Characters after which a quote opens. */
const OPENS_AFTER = /[\s([{\u2014\u2013\-/\u00a0\u2028]/;

/**
 * Replacements for a text: [{ start, end, insert, kind }] sorted by start
 * and not overlapping. Fractions without a single character come back as
 * { start, end, kind: 'fractions', attr: true } (set the fractions feature).
 */
export function smartEdits(text, opts = DEFAULT_PUNCT_OPTIONS) {
  const s = String(text ?? '');
  const o = { ...DEFAULT_PUNCT_OPTIONS, ...opts };
  const edits = [];
  const taken = new Uint8Array(s.length + 1);
  const push = (start, end, insert, kind, extra = {}) => {
    for (let i = start; i < end; i++) if (taken[i]) return;
    for (let i = start; i < end; i++) taken[i] = 1;
    edits.push({ start, end, insert, kind, ...extra });
  };
  if (o.ellipses) for (const m of s.matchAll(/(?<!\.)\.\.\.(?!\.)/g)) push(m.index, m.index + 3, '\u2026', 'ellipses');
  if (o.dashes) {
    for (const m of s.matchAll(/(?<!-)---(?!-)/g)) push(m.index, m.index + 3, '\u2014', 'dashes');
    for (const m of s.matchAll(/(?<!-)--(?!-)/g)) push(m.index, m.index + 2, '\u2013', 'dashes');
  }
  if (o.fractions) {
    for (const m of s.matchAll(/(?<![\d/.,])(\d{1,4})\/(\d{1,4})(?![\d/]|[.,]\d)/g)) {
      const ch = FRACTIONS[`${m[1]}/${m[2]}`];
      if (ch) push(m.index, m.index + m[0].length, ch, 'fractions');
      else if (Number(m[2]) > 0) push(m.index, m.index + m[0].length, null, 'fractions', { attr: true });
    }
  }
  if (o.spaces) for (const m of s.matchAll(/([.!?][\u201d\u2019"')\]]?)( {2,})/g)) push(m.index + m[1].length, m.index + m[0].length, ' ', 'spaces');
  if (o.ligatures) {
    for (const [seq, ch] of LIGATURES) {
      let i = s.indexOf(seq);
      while (i >= 0) {
        push(i, i + seq.length, ch, 'ligatures');
        i = s.indexOf(seq, i + seq.length);
      }
    }
  }
  if (o.quotes) {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '"' && c !== "'") continue;
      const prev = i > 0 ? s[i - 1] : '';
      const next = s[i + 1] || '';
      const opens = !prev || OPENS_AFTER.test(prev) || prev === '\u201c' || prev === '\u2018';
      let q;
      if (c === '"') {
        q = opens && next && !/\s/.test(next) ? '\u201c' : '\u201d';
      } else if (/[\p{L}\p{N}]/u.test(prev) && /[\p{L}]/u.test(next)) q = '\u2019'; // apostrophe in a word
      else if (opens && /^\d\d(s|\b)/.test(s.slice(i + 1, i + 4))) q = '\u2019'; // '90s
      else if (opens && next && !/\s/.test(next)) q = '\u2018';
      else q = '\u2019';
      push(i, i + 1, q, 'quotes');
    }
  }
  return edits.sort((a, b) => a.start - b.start);
}

/** Apply smart punctuation to [from, to) of a node. Returns { patch, counts } (patch null when nothing changed). */
export function smartPunctuateNode(node, opts, from = 0, to = String(node.text ?? '').length) {
  const counts = {};
  const edits = smartEdits(node.text.slice(from, to), opts).map((e) => ({ ...e, start: e.start + from, end: e.end + from }));
  if (!edits.length) return { patch: null, counts };
  let n = node;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    counts[e.kind] = (counts[e.kind] || 0) + 1;
    if (e.attr) n = { ...n, runs: applyRunStyle(n, e.start, e.end, { fractions: true }) };
    else n = { ...n, ...replaceRange(n, e.start, e.end, e.insert, overridesAt(n, e.start)) };
  }
  return { patch: { text: n.text, runs: n.runs, paras: n.paras, char: n.char, fill: n.fill, stroke: n.stroke, strokeWidth: n.strokeWidth }, counts };
}

/** Run Smart Punctuation; scope: 'selection' | 'document'. Returns per-kind counts. */
export function applySmartPunctuation(app, opts, scope) {
  const ed = app.editor;
  const doc = ed.doc;
  const s = app.typeSession && !app.typeSession.ended ? app.typeSession : null;
  const targets = [];
  if (scope === 'selection' && s) {
    const n = s.node();
    const [a, b] = s.range();
    if (n) targets.push({ id: n.id, from: a === b ? 0 : a, to: a === b ? n.text.length : b });
  } else {
    const nodes = scope === 'selection' ? selectedTextNodes(ed) : doc.leaves().filter((n) => n.type === 'text' && !doc.isLocked(n.id));
    for (const n of nodes) if (n.text) targets.push({ id: n.id, from: 0, to: n.text.length });
  }
  const total = {};
  const len0 = s?.node()?.text.length ?? 0;
  doc.transact('Smart Punctuation', () => {
    for (const t of targets) {
      const n = doc.get(t.id);
      if (!n) continue;
      const { patch, counts } = smartPunctuateNode(n, opts, t.from, t.to);
      if (!patch) continue;
      doc.update(n.id, patch);
      for (const k in counts) total[k] = (total[k] || 0) + counts[k];
    }
  });
  if (s && !s.ended) {
    // A selection keeps covering its text, which replacements may have made shorter or longer.
    const [a, b] = s.range();
    const delta = (s.node()?.text.length ?? len0) - len0;
    if (scope === 'selection' && a !== b && delta) s.setSelection(a, b + delta);
    else s.changed();
  }
  return total;
}

export async function openSmartPunctuation(app) {
  const ed = app.editor;
  if (!ed) return;
  const saved = { ...DEFAULT_PUNCT_OPTIONS, ...(app.prefs.get('smartPunctuation') || {}) };
  const s = app.typeSession && !app.typeSession.ended ? app.typeSession : null;
  const hasSel = Boolean(s ? s.range()[0] !== s.range()[1] || s.node() : selectedTextNodes(ed).length);
  const v = await app.dialogs.form({
    title: 'Smart Punctuation',
    fields: [
      { type: 'heading', label: 'Replace' },
      { key: 'quotes', type: 'checkbox', label: 'Smart quotes (\u201c \u201d \u2018 \u2019)', value: saved.quotes },
      { key: 'dashes', type: 'checkbox', label: 'En and em dashes (-- and ---)', value: saved.dashes },
      { key: 'ellipses', type: 'checkbox', label: 'Ellipses (...)', value: saved.ellipses },
      { key: 'spaces', type: 'checkbox', label: 'One space after sentences', value: saved.spaces },
      { key: 'fractions', type: 'checkbox', label: 'Fractions (1/2 becomes \u00bd)', value: saved.fractions },
      { key: 'ligatures', type: 'checkbox', label: 'Ligature characters (fi, fl, ff, ffi, ffl)', value: saved.ligatures },
      {
        key: 'scope',
        type: 'radio',
        label: 'Replace In',
        value: hasSel ? 'selection' : 'document',
        options: [
          ...(hasSel ? [{ value: 'selection', label: 'Selected Text' }] : []),
          { value: 'document', label: 'Entire Document' },
        ],
      },
      { key: 'report', type: 'checkbox', label: 'Report results', value: app.prefs.get('smartPunctuationReport') !== false },
    ],
  });
  if (!v) return;
  const opts = {};
  for (const k of Object.keys(PUNCT_KINDS)) opts[k] = Boolean(v[k]);
  app.prefs.set('smartPunctuation', opts);
  app.prefs.set('smartPunctuationReport', v.report);
  const counts = applySmartPunctuation(app, opts, v.scope);
  if (!v.report) return;
  const rows = Object.entries(PUNCT_KINDS).filter(([k]) => opts[k]).map(([k, label]) => h('tr', h('td', label), h('td.num', String(counts[k] || 0))));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  await app.dialogs.open({
    title: 'Smart Punctuation',
    body: h('div.punct-report', h('p', total ? `${total} ${total === 1 ? 'replacement' : 'replacements'} made.` : 'Nothing needed replacing.'), h('table.punct-table', h('tbody', rows))),
    buttons: [{ label: 'OK', value: true, primary: true }],
  });
}
