/**
 * Edit > Find and Replace across the document's text objects. Matches are
 * shown by editing the text object with the match selected.
 */
import { h } from '../../lib/dom.js';
import { replaceRange } from '../../model/text-runs.js';

/**
 * Special characters typed as caret codes in Find and Replace (^t is a tab,
 * ^p a paragraph return, ^^ a caret, ...); `label` names them in the
 * Insert Special Character menu.
 */
export const SPECIAL_CHARS = [
  { code: '^t', char: '\t', label: 'Tab' },
  { code: '^p', char: '\n', label: 'Paragraph Return' },
  { code: '^n', char: '\u2028', label: 'Forced Line Break' },
  { code: '^8', char: '\u2022', label: 'Bullet' },
  { code: '^e', char: '\u2026', label: 'Ellipsis' },
  { code: '^_', char: '\u2014', label: 'Em Dash' },
  { code: '^=', char: '\u2013', label: 'En Dash' },
  { code: '^-', char: '\u00ad', label: 'Discretionary Hyphen' },
  { code: '^{', char: '\u201c', label: 'Double Left Quotation Mark' },
  { code: '^}', char: '\u201d', label: 'Double Right Quotation Mark' },
  { code: '^[', char: '\u2018', label: 'Single Left Quotation Mark' },
  { code: '^]', char: '\u2019', label: 'Single Right Quotation Mark' },
  { code: '^2', char: '\u00a9', label: 'Copyright Symbol' },
  { code: '^r', char: '\u00ae', label: 'Registered Trademark Symbol' },
  { code: '^d', char: '\u2122', label: 'Trademark Symbol' },
  { code: '^6', char: '\u00a7', label: 'Section Symbol' },
  { code: '^7', char: '\u00b6', label: 'Paragraph Symbol' },
  { code: '^m', char: '\u2003', label: 'Em Space' },
  { code: '^>', char: '\u2002', label: 'En Space' },
  { code: '^<', char: '\u2009', label: 'Thin Space' },
  { code: '^|', char: '\u200a', label: 'Hair Space' },
  { code: '^s', char: '\u00a0', label: 'Nonbreaking Space' },
  { code: '^^', char: '^', label: 'Caret' },
];
const CODES = new Map(SPECIAL_CHARS.map((c) => [c.code, c.char]));

/** Replace caret codes by the characters they stand for (unknown codes stay as typed). */
export function decodeSpecial(s) {
  return String(s ?? '').replace(/\^./g, (m) => CODES.get(m) ?? m);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All matches of `query` in `text`: [{ start, end }]. */
export function findMatches(text, query, { matchCase = false, wholeWord = false } = {}) {
  if (!query) return [];
  const re = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])${escapeRe(query)}(?![\\p{L}\\p{N}_])` : escapeRe(query), `g${matchCase ? '' : 'i'}u`);
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

function textNodes(doc, { includeLocked = false, includeHidden = false } = {}) {
  return doc.leaves().filter((n) => n.type === 'text' && (includeLocked || !doc.isLocked(n.id)) && (includeHidden || !doc.isHidden(n.id)));
}

/** The last Find and Replace settings, so Edit > Find Next can repeat the search. */
export const lastFind = { query: '', replace: '', matchCase: false, wholeWord: false, includeLocked: false, includeHidden: false, backwards: false, current: null };

function showMatch(app, m) {
  lastFind.current = m;
  const tool = app.getTool('type');
  if (app.toolId !== 'type') app.setTool('type');
  const sess = tool.editText(m.id, null);
  sess?.setSelection(m.start, m.end);
}

/**
 * Select the next match of the last query after the current match (or the
 * caret), wrapping around the document. Returns 'found', 'none' or 'empty'
 * (no query or no text objects).
 */
export function findNext(app) {
  const ed = app.editor;
  const q = decodeSpecial(lastFind.query);
  if (!ed || !q) return 'empty';
  const nodes = textNodes(ed.doc, lastFind);
  if (!nodes.length) return 'empty';
  const sess = app.typeSession && !app.typeSession.ended ? app.typeSession : null;
  let current = lastFind.current;
  // A match the caret has since moved away from no longer anchors the search.
  if (current && sess && (sess.id !== current.id || sess.range()[0] !== current.start)) current = null;
  const back = Boolean(lastFind.backwards);
  const at = nodes.findIndex((n) => n.id === (current?.id || sess?.id));
  // Without a caret, a backwards search starts at the end of the document.
  const startNode = at >= 0 ? at : back ? nodes.length - 1 : 0;
  const from = current ? (back ? current.start : current.end) : sess ? sess.range()[back ? 0 : 1] : back ? Infinity : 0;
  const opts = { matchCase: lastFind.matchCase, wholeWord: lastFind.wholeWord };
  const N = nodes.length;
  for (let k = 0; k <= N; k++) {
    const n = nodes[(((back ? startNode - k : startNode + k) % N) + N) % N];
    // The starting object is searched past the caret first, and on the other side of it last (after wrapping).
    let ms;
    if (back) ms = findMatches(n.text, q, opts).filter((m) => (k === 0 ? m.end <= from : k < N || m.start >= from)).reverse();
    else ms = findMatches(n.text, q, opts).filter((m) => (k === 0 ? m.start >= from : k < N || m.end <= from));
    if (ms.length) {
      showMatch(app, { id: n.id, ...ms[0] });
      return 'found';
    }
  }
  lastFind.current = null;
  return 'none';
}

export function openFindReplace(app) {
  const ed = app.editor;
  if (!ed) return;
  const s = app.typeSession;
  const selected = s && !s.ended ? s.selectedText() : '';
  const findIn = h('input', { type: 'text', id: 'fr-find', value: selected || lastFind.query, autocomplete: 'off', spellcheck: false });
  const replIn = h('input', { type: 'text', id: 'fr-repl', value: lastFind.replace, autocomplete: 'off', spellcheck: false });
  const caseBox = h('input', { type: 'checkbox', id: 'fr-case', checked: lastFind.matchCase });
  const wordBox = h('input', { type: 'checkbox', id: 'fr-word', checked: lastFind.wholeWord });
  const lockedBox = h('input', { type: 'checkbox', id: 'fr-locked', checked: lastFind.includeLocked });
  const hiddenBox = h('input', { type: 'checkbox', id: 'fr-hidden', checked: lastFind.includeHidden });
  const backBox = h('input', { type: 'checkbox', id: 'fr-back', checked: lastFind.backwards });
  // Insert Special Character: a menu next to each field that types its caret code at the cursor.
  const specialMenu = (input, label) => {
    const sel = h('select.select.fr-special', { 'aria-label': `Insert special character in ${label}` }, h('option', { value: '' }, 'Special...'), SPECIAL_CHARS.map((c) => h('option', { value: c.code }, `${c.label} (${c.code})`)));
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const a = input.selectionStart ?? input.value.length;
      const b = input.selectionEnd ?? a;
      input.value = input.value.slice(0, a) + sel.value + input.value.slice(b);
      input.setSelectionRange?.(a + sel.value.length, a + sel.value.length);
      sel.value = '';
      input.focus();
      input.dispatchEvent(new Event('change'));
    });
    return sel;
  };
  const status = h('p.fr-status', { role: 'status', 'aria-live': 'polite' });
  lastFind.current = null;

  const opts = () => ({ matchCase: caseBox.checked, wholeWord: wordBox.checked });
  const nodeOpts = () => ({ includeLocked: lockedBox.checked, includeHidden: hiddenBox.checked });
  const sync = () => Object.assign(lastFind, { query: findIn.value, replace: replIn.value, backwards: backBox.checked, ...opts(), ...nodeOpts() });

  const doFind = () => {
    sync();
    const r = findNext(app);
    status.textContent = r === 'found' ? '' : r === 'none' ? 'No matches found.' : findIn.value ? 'No text objects to search.' : 'Enter text to find.';
    return r === 'found';
  };

  const replace = () => {
    sync();
    const current = lastFind.current;
    if (!current) return false;
    const n = ed.doc.get(current.id);
    if (!n) return false;
    const found = n.text.slice(current.start, current.end);
    const ok = findMatches(found, decodeSpecial(findIn.value), opts()).length > 0;
    if (!ok) return false;
    const repl = decodeSpecial(replIn.value);
    ed.doc.transact('Replace', () => ed.doc.update(n.id, replaceRange(n, current.start, current.end, repl)));
    // Searching backwards continues before the replaced text.
    lastFind.current = backBox.checked ? { ...current, end: current.start } : { ...current, end: current.start + repl.length };
    app.typeSession?.setSelection(lastFind.current.start, lastFind.current.end);
    return true;
  };

  const replaceAll = () => {
    sync();
    const q = decodeSpecial(findIn.value);
    const repl = decodeSpecial(replIn.value);
    if (!q) return;
    let count = 0;
    app.getTool('type')?.endEditing?.({ select: false });
    ed.doc.transact('Replace All', () => {
      for (const n0 of textNodes(ed.doc, nodeOpts())) {
        let n = ed.doc.get(n0.id);
        const ms = findMatches(n.text, q, opts());
        for (let i = ms.length - 1; i >= 0; i--) {
          n = { ...n, ...replaceRange(n, ms[i].start, ms[i].end, repl) };
          count++;
        }
        if (ms.length) ed.doc.update(n.id, { text: n.text, runs: n.runs, paras: n.paras, char: n.char, fill: n.fill, stroke: n.stroke, strokeWidth: n.strokeWidth });
      }
    });
    lastFind.current = null;
    status.textContent = count ? `Replaced ${count} ${count === 1 ? 'match' : 'matches'}.` : 'No matches found.';
  };

  const btn = (label, fn) => h('button.btn', { type: 'button', onclick: fn }, label);
  const body = h(
    'div.find-replace',
    h('div.form-row', h('label', { for: 'fr-find' }, 'Find'), h('div.fr-field', findIn, specialMenu(findIn, 'Find'))),
    h('div.form-row', h('label', { for: 'fr-repl' }, 'Replace With'), h('div.fr-field', replIn, specialMenu(replIn, 'Replace With'))),
    h(
      'div.fr-checks',
      h('div.form-row.check', caseBox, h('label', { for: 'fr-case' }, 'Match Case')),
      h('div.form-row.check', wordBox, h('label', { for: 'fr-word' }, 'Find Whole Word')),
      h('div.form-row.check', lockedBox, h('label', { for: 'fr-locked' }, 'Check Locked Layers')),
      h('div.form-row.check', hiddenBox, h('label', { for: 'fr-hidden' }, 'Check Hidden Layers')),
      h('div.form-row.check', backBox, h('label', { for: 'fr-back' }, 'Search Backwards')),
    ),
    h(
      'div.fr-actions',
      btn('Find Next', doFind),
      btn('Replace', () => {
        if (!replace()) doFind();
      }),
      btn('Replace & Find', () => {
        replace();
        doFind();
      }),
      btn('Replace All', replaceAll),
    ),
    status,
  );
  findIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      doFind();
    }
  });
  for (const el of [findIn, replIn, caseBox, wordBox, lockedBox, hiddenBox, backBox]) el.addEventListener('change', sync);
  return app.dialogs.open({ title: 'Find and Replace', body, className: 'find-replace-dialog', buttons: [{ label: 'Done', value: true, primary: true }] });
}
