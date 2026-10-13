/**
 * A small code editor for scripts: a plain textarea, so typing, selection, input methods, the clipboard, spell
 * checking off and the browser's own undo all behave natively, laid over a highlighted copy of the text and a layer
 * of marks (search matches, the bracket matching the one at the caret, the line an error points at), with line
 * numbers beside it. On top of the textarea: indentation that follows the code, closing brackets and quotes typed
 * for you, Find and Replace, line comments, and completions for the script API.
 *
 * Keys: Tab indents (Escape first lets Tab move on, out of the editor), Shift+Tab outdents, Ctrl/Cmd+F finds,
 * Ctrl/Cmd+H replaces, F3 / Ctrl/Cmd+G finds again, Ctrl/Cmd+/ comments lines, Ctrl+Space completes,
 * Ctrl/Cmd+Enter runs.
 */
import { el, isComposing, isMod, IS_MAC } from './dom.js';
import { icon } from './icons.js';
import { SCRIPT_API, SCRIPT_API_RETURNS, JS_KEYWORDS, JS_LITERALS, JS_GLOBALS } from '../core/script-api-docs.js';

const INDENT = '  ';
const KEYWORDS = new Set(JS_KEYWORDS);
const LITERALS = new Set(JS_LITERALS);
const API_NAMES = new Set(Object.values(SCRIPT_API).flat().map(([name]) => name));
const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };
const QUOTES = new Set(['"', "'", '`']);
const MAX_COMPLETIONS = 60;

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The tokens of JavaScript source, enough to colour it and to tell brackets in code from brackets in text:
 * [{ type, start, end }], types comment, string, number, keyword, literal, api, func, punct, word, regex.
 */
export function tokenizeScript(src) {
  const out = [];
  let i = 0;
  let prev = null; // the last significant token, to tell a regular expression from a division
  const push = (type, start, end) => { const t = { type, start, end }; out.push(t); if (type !== 'comment') prev = t; return t; };
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { const end = src.indexOf('\n', i); push('comment', i, end < 0 ? n : end); i = end < 0 ? n : end; continue; }
    if (ch === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); const stop = end < 0 ? n : end + 2; push('comment', i, stop); i = stop; continue; }
    if (QUOTES.has(ch)) {
      let j = i + 1;
      while (j < n && src[j] !== ch) {
        if (src[j] === '\\') j++;
        else if (ch !== '`' && src[j] === '\n') break;
        j++;
      }
      push('string', i, Math.min(n, j + 1));
      i = Math.min(n, j + 1);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/.exec(src.slice(i, i + 64));
      const len = m ? m[0].length : 1;
      push('number', i, i + len);
      i += len;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const afterDot = prev && prev.type === 'punct' && src[prev.start] === '.';
      let k = j;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      const type = KEYWORDS.has(word) && !afterDot ? 'keyword' : LITERALS.has(word) && !afterDot ? 'literal'
        : afterDot && API_NAMES.has(word) ? 'api' : src[k] === '(' ? 'func' : 'word';
      push(type, i, j);
      i = j;
      continue;
    }
    if (ch === '/') {
      // A slash where a value is expected starts a regular expression.
      const before = prev ? src.slice(prev.start, prev.end) : '';
      const valueExpected = !prev || (prev.type === 'punct' && !/[)\]}]/.test(before)) || (prev.type === 'keyword' && /^(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(before));
      if (valueExpected) {
        let j = i + 1, cls = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') j++;
          else if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
          j++;
        }
        if (src[j] === '/') {
          j++;
          while (j < n && /[a-z]/i.test(src[j])) j++;
          push('regex', i, j);
          i = j;
          continue;
        }
      }
    }
    push('punct', i, i + 1);
    i++;
  }
  return out;
}

/** The highlighted HTML of `src`. */
function highlight(src, tokens) {
  let html = '';
  let at = 0;
  for (const t of tokens) {
    if (t.start > at) html += escapeHtml(src.slice(at, t.start));
    const text = escapeHtml(src.slice(t.start, t.end));
    html += t.type === 'word' || t.type === 'punct' && !OPEN[src[t.start]] && !CLOSE[src[t.start]] ? text : `<span class="ce-${t.type === 'punct' ? 'bracket' : t.type}">${text}</span>`;
    at = t.end;
  }
  return html + escapeHtml(src.slice(at)) + '\n';
}

/** The bracket that pairs with the one at `index` (by tokens, so brackets in strings and comments do not count). */
export function matchingBracket(src, tokens, index) {
  const ch = src[index];
  if (!OPEN[ch] && !CLOSE[ch]) return null;
  const brackets = tokens.filter((t) => t.type === 'punct' && (OPEN[src[t.start]] || CLOSE[src[t.start]]));
  const at = brackets.findIndex((t) => t.start === index);
  if (at < 0) return null;
  let depth = 0;
  if (OPEN[ch]) {
    for (let k = at; k < brackets.length; k++) {
      const c = src[brackets[k].start];
      if (OPEN[c]) depth++; else depth--;
      if (depth === 0) return OPEN[ch] === c ? brackets[k].start : -1;
    }
  } else {
    for (let k = at; k >= 0; k--) {
      const c = src[brackets[k].start];
      if (CLOSE[c]) depth++; else depth--;
      if (depth === 0) return CLOSE[ch] === c ? brackets[k].start : -1;
    }
  }
  return -1;
}

/** The object a member completion is for, from the text before the dot: 'Worksheet', 'Range'… or null. */
export function receiverType(code, before) {
  const text = before.replace(/\s+$/, '');
  if (text.endsWith(')')) {
    let depth = 0;
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === ')') depth++;
      else if (text[i] === '(' && --depth === 0) {
        const m = /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(0, i));
        return m ? SCRIPT_API_RETURNS[m[1]] || null : null;
      }
    }
    return null;
  }
  const m = /([A-Za-z_$][\w$]*)$/.exec(text);
  if (!m) return null;
  const name = m[1];
  if (name === 'workbook') return 'Workbook';
  if (name === 'console') return 'console';
  const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(?:await\\s+)?([^;\\n]+)`).exec(code);
  if (decl) {
    const call = /([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*$/.exec(decl[1].trim());
    if (call && SCRIPT_API_RETURNS[call[1]]) return SCRIPT_API_RETURNS[call[1]];
    if (/^workbook$/.test(decl[1].trim())) return 'Workbook';
  }
  const guess = { sheet: 'Worksheet', worksheet: 'Worksheet', ws: 'Worksheet', range: 'Range', cell: 'Range', cells: 'Range', used: 'Range', format: 'Format', font: 'Font', fill: 'Fill', table: 'Table', wb: 'Workbook', book: 'Workbook' };
  const lower = name.toLowerCase();
  return guess[lower] || Object.entries(guess).find(([k]) => lower.endsWith(k))?.[1] || null;
}

/** The completions for the text before the caret: { from, items: [{ label, detail, doc, kind, call }] } or null. */
export function completionsAt(code, caret, { explicit = false } = {}) {
  const lineStart = code.lastIndexOf('\n', caret - 1) + 1;
  const before = code.slice(lineStart, caret);
  const tokens = tokenizeScript(code);
  // Never inside a comment or text.
  if (tokens.some((t) => (t.type === 'comment' || t.type === 'string' || t.type === 'regex') && t.start < caret && caret < t.end + (t.type === 'comment' && code[t.end - 1] !== '/' ? 1 : 0))) return null;
  const m = /([A-Za-z_$][\w$]*)?$/.exec(before);
  const prefix = m[1] || '';
  const from = caret - prefix.length;
  const member = before.slice(0, before.length - prefix.length).endsWith('.');
  if (!member && !prefix && !explicit) return null;
  const lower = prefix.toLowerCase();
  const matches = (name) => !lower || name.toLowerCase().startsWith(lower);
  let items = [];
  if (member) {
    const type = receiverType(code, code.slice(lineStart, from - 1));
    const groups = type && SCRIPT_API[type] ? [[type, SCRIPT_API[type]]] : Object.entries(SCRIPT_API);
    const seen = new Set();
    for (const [owner, list] of groups) {
      for (const [name, sig, doc, flags] of list) {
        if (!matches(name) || seen.has(name)) continue;
        seen.add(name);
        items.push({ label: name, detail: type ? sig : `${owner} ${sig}`, doc, kind: flags === 'async' ? 'async' : 'method', call: sig !== '()' ? 'args' : 'empty' });
      }
    }
  } else {
    const words = new Set();
    for (const t of tokens) if (t.type === 'word' || t.type === 'func') { const w = code.slice(t.start, t.end); if (w.length > 2 && !(t.start <= caret && caret <= t.end)) words.add(w); }
    for (const k of JS_KEYWORDS) if (matches(k)) items.push({ label: k, detail: 'keyword', kind: 'keyword' });
    for (const g of JS_GLOBALS) if (matches(g)) items.push({ label: g, detail: g === 'workbook' ? 'the workbook passed to main' : 'global', kind: 'global' });
    for (const w of words) if (matches(w) && !KEYWORDS.has(w) && !JS_GLOBALS.includes(w)) items.push({ label: w, detail: 'in this script', kind: 'word' });
    if (!explicit && items.length === 1 && items[0].label === prefix) items = [];
  }
  items.sort((a, b) => (a.label.toLowerCase().startsWith(lower) === b.label.toLowerCase().startsWith(lower) ? 0 : a.label.toLowerCase().startsWith(lower) ? -1 : 1));
  return items.length ? { from, items: items.slice(0, MAX_COMPLETIONS) } : null;
}

let editors = 0;

/**
 * options: { value, label, onChange(text), onRun(), onSave(), readOnly }. Returns { el, textarea, getValue(),
 * setValue(text), focus(), goToLine(n), setErrorLine(n | null), setReadOnly(on), openFind(replace), destroy() }.
 */
export function createCodeEditor({ value = '', label = 'Script code', onChange = null, onRun = null, onSave = null, readOnly = false } = {}) {
  const id = `ce${++editors}`;
  const gutter = el('div.ce-gutter', { 'aria-hidden': 'true' });
  const marks = el('pre.ce-layer.ce-marks', { 'aria-hidden': 'true' });
  const code = el('pre.ce-layer.ce-code', { 'aria-hidden': 'true' });
  const activeLine = el('div.ce-active-line', { 'aria-hidden': 'true' });
  const errorLine = el('div.ce-error-line', { 'aria-hidden': 'true', hidden: true });
  const listbox = el('div.ce-complete', { id: `${id}-complete`, role: 'listbox', 'aria-label': 'Completions', hidden: true });
  const textarea = el('textarea.ce-input', {
    spellcheck: false, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', wrap: 'off',
    'aria-label': label, 'aria-multiline': 'true', 'aria-autocomplete': 'list', 'aria-controls': listbox.id, 'aria-expanded': 'false',
    'aria-keyshortcuts': IS_MAC ? 'Meta+F Meta+Alt+F Control+Space Meta+Enter' : 'Control+F Control+H Control+Space Control+Enter',
    'aria-description': 'Tab indents; press Escape, then Tab, to move out of the editor.',
  });
  textarea.value = value;
  const view = el('div.ce-view', {}, activeLine, errorLine, marks, code, textarea);
  const measure = el('span.ce-measure', { 'aria-hidden': 'true' }, 'MMMMMMMMMM');

  // Find and Replace, over the top right of the code.
  const findInput = el('input.input.ce-find-input', { type: 'text', 'aria-label': 'Find in script', placeholder: 'Find', spellcheck: false });
  const replaceInput = el('input.input.ce-find-input', { type: 'text', 'aria-label': 'Replace with', placeholder: 'Replace', spellcheck: false });
  const findCount = el('span.ce-find-count', { 'aria-live': 'polite' });
  const caseButton = el('button.icon-btn.ce-find-case', { type: 'button', 'aria-label': 'Match case', 'aria-pressed': 'false', title: 'Match case' }, 'Aa');
  const findBtn = (name, glyph, fn) => el('button.icon-btn', { type: 'button', 'aria-label': name, title: name, html: icon(glyph, 14), onclick: fn });
  const replaceRow = el('div.ce-find-row', { hidden: true }, replaceInput,
    el('button.btn.btn-sm', { type: 'button', onclick: () => replaceOne() }, 'Replace'),
    el('button.btn.btn-sm', { type: 'button', onclick: () => replaceAll() }, 'All'));
  const findBar = el('div.ce-find', { role: 'search', 'aria-label': 'Find in script', hidden: true },
    el('div.ce-find-row', {}, findInput, findCount, caseButton,
      findBtn('Previous match', 'chevU', () => findNext(-1)), findBtn('Next match', 'chevD', () => findNext(1)), findBtn('Close find', 'x', () => closeFind())),
    replaceRow);
  const root = el('div.code-editor', {}, measure, gutter, el('div.ce-scroll', {}, view), findBar, listbox);

  let tokens = [];
  let tabMoves = false; // Escape was pressed: the next Tab leaves the editor
  let errorAt = null;
  let matches = [];
  let current = -1;
  let completion = null; // { from, items, index }
  let charWidth = 7.5;
  let lineHeight = 18;
  let rendered = null;
  let frame = 0;

  const lineOf = (index) => { let n = 0; for (let i = textarea.value.indexOf('\n'); i >= 0 && i < index; i = textarea.value.indexOf('\n', i + 1)) n++; return n; };
  const lineStartOf = (text, index) => text.lastIndexOf('\n', index - 1) + 1;

  function metrics() {
    const w = measure.getBoundingClientRect().width;
    if (w > 0) charWidth = w / 10;
    const lh = parseFloat(getComputedStyle(code).lineHeight);
    if (lh > 0) lineHeight = lh;
  }

  function render() {
    frame = 0;
    const text = textarea.value;
    if (rendered !== text) {
      rendered = text;
      tokens = tokenizeScript(text);
      code.innerHTML = highlight(text, tokens);
      const lines = text.split('\n').length;
      if (gutter.childElementCount !== lines) {
        gutter.replaceChildren(...Array.from({ length: lines }, (_, i) => el('div.ce-line-number', {}, String(i + 1))));
      }
      if (matches.length || !findBar.hidden) computeMatches();
    }
    renderMarks();
    sync();
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };

  /** The marks layer: search matches, the bracket pair at the caret. */
  function renderMarks() {
    const text = textarea.value;
    const spans = [];
    matches.forEach(([s, e], i) => spans.push([s, e, i === current ? 'ce-find-hit ce-find-current' : 'ce-find-hit']));
    const caret = textarea.selectionStart;
    if (textarea.selectionStart === textarea.selectionEnd && document.activeElement === textarea) {
      for (const at of [caret - 1, caret]) {
        if (at < 0 || !(OPEN[text[at]] || CLOSE[text[at]])) continue;
        const other = matchingBracket(text, tokens, at);
        if (other == null) continue;
        if (other < 0) spans.push([at, at + 1, 'ce-bracket-bad']);
        else { spans.push([at, at + 1, 'ce-bracket-match']); spans.push([other, other + 1, 'ce-bracket-match']); }
        break;
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    let html = '';
    let at = 0;
    for (const [s, e, cls] of spans) {
      if (s < at) continue;
      html += escapeHtml(text.slice(at, s)) + `<mark class="${cls}">${escapeHtml(text.slice(s, e))}</mark>`;
      at = e;
    }
    marks.innerHTML = html + escapeHtml(text.slice(at)) + '\n';
    const line = lineOf(caret);
    activeLine.style.top = `${line * lineHeight}px`;
    for (const n of gutter.querySelectorAll('.ce-current')) n.classList.remove('ce-current');
    gutter.children[line]?.classList.add('ce-current');
  }

  /** The layers follow the textarea's scrolling. */
  function sync() {
    const x = textarea.scrollLeft, y = textarea.scrollTop;
    view.style.setProperty('--ce-x', `${-x}px`);
    view.style.setProperty('--ce-y', `${-y}px`);
    gutter.style.transform = `translateY(${-y}px)`;
    if (completion) placeCompletion();
  }

  function setErrorLine(line) {
    errorAt = Number.isInteger(line) && line > 0 ? line : null;
    for (const n of gutter.querySelectorAll('.ce-error')) n.classList.remove('ce-error');
    errorLine.hidden = !errorAt;
    if (errorAt) {
      errorLine.style.top = `${(errorAt - 1) * lineHeight}px`;
      render();
      gutter.children[errorAt - 1]?.classList.add('ce-error');
    }
  }

  /* ---------- Editing ---------- */

  /** Replace [start, end) with `text`, through the browser's editing so its undo keeps it; select [selStart, selEnd]. */
  function edit(start, end, text, selStart = start + text.length, selEnd = selStart) {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    let done = false;
    try { done = document.execCommand?.('insertText', false, text); } catch { done = false; }
    if (!done || textarea.value.slice(start, start + text.length) !== text) {
      textarea.setRangeText(text, start, end, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    textarea.setSelectionRange(selStart, selEnd);
  }

  /** Each selected line's start, for indenting and commenting a selection. */
  function selectedLines() {
    const text = textarea.value;
    const s = textarea.selectionStart;
    let e = textarea.selectionEnd;
    if (e > s && text[e - 1] === '\n') e--;
    const first = lineStartOf(text, s);
    const starts = [first];
    for (let i = text.indexOf('\n', first); i >= 0 && i < e; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    const last = text.indexOf('\n', e);
    return { first, end: last < 0 ? text.length : last, starts };
  }

  function rewriteLines(fn) {
    const text = textarea.value;
    const { first, end } = selectedLines();
    const block = text.slice(first, end);
    const next = block.split('\n').map(fn).join('\n');
    if (next === block) return;
    const s = textarea.selectionStart, e = textarea.selectionEnd;
    edit(first, end, next);
    const shift = next.length - block.length;
    const firstShift = next.split('\n')[0].length - block.split('\n')[0].length;
    textarea.setSelectionRange(Math.max(first, s + firstShift), Math.max(first, e + shift));
  }
  const indent = () => rewriteLines((line) => (line.trim() ? INDENT + line : line));
  const outdent = () => rewriteLines((line) => line.replace(/^( {1,2}|\t)/, ''));
  function toggleComment() {
    const text = textarea.value;
    const { first, end } = selectedLines();
    const lines = text.slice(first, end).split('\n');
    const all = lines.filter((l) => l.trim()).every((l) => /^\s*\/\//.test(l));
    const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
    rewriteLines((line) => (!line.trim() ? line : all ? line.replace(/^(\s*)\/\/ ?/, '$1') : `${line.slice(0, pad)}// ${line.slice(pad)}`));
  }

  function onEnter() {
    const text = textarea.value;
    const s = textarea.selectionStart, e = textarea.selectionEnd;
    const start = lineStartOf(text, s);
    const indentNow = /^[ \t]*/.exec(text.slice(start, s))[0];
    const before = text.slice(start, s).replace(/\s+$/, '');
    const after = text[e];
    const opens = /[{([]$/.test(before);
    const inner = opens ? indentNow + INDENT : indentNow;
    if (opens && after && CLOSE[after] && OPEN[before.at(-1)] === after) {
      edit(s, e, `\n${inner}\n${indentNow}`, s + 1 + inner.length);
    } else edit(s, e, `\n${inner}`);
  }

  function onKeyDown(e) {
    if (isComposing(e)) return;
    const mod = isMod(e);
    if (completion) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveCompletion(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); moveCompletion(e.key === 'PageDown' ? 8 : -8); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptCompletion(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCompletion(); return; }
    }
    if (mod && e.key === 'Enter') { e.preventDefault(); onRun?.(); return; }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); onSave?.(); return; }
    // Replace is Ctrl+H, or Cmd+Option+F on a Mac, where Cmd+H hides the app.
    if (mod && !e.shiftKey && (IS_MAC ? e.altKey && e.code === 'KeyF' : e.key.toLowerCase() === 'h')) { e.preventDefault(); openFind(true); return; }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(false); return; }
    if ((mod && e.key.toLowerCase() === 'g') || e.key === 'F3') { e.preventDefault(); if (findInput.value) findNext(e.shiftKey ? -1 : 1); else openFind(false); return; }
    if (e.ctrlKey && (e.key === ' ' || e.code === 'Space')) { e.preventDefault(); openCompletion(true); return; }
    if (mod && e.key === '/') { e.preventDefault(); if (!textarea.readOnly) toggleComment(); return; }
    if (e.key === 'Escape') {
      if (!findBar.hidden) { e.preventDefault(); e.stopPropagation(); closeFind(); return; }
      tabMoves = true;
      return;
    }
    if (textarea.readOnly) return;
    if (e.key === 'Tab' && !mod && !e.altKey) {
      if (tabMoves) { tabMoves = false; return; }
      e.preventDefault();
      const s = textarea.selectionStart, en = textarea.selectionEnd;
      if (e.shiftKey) outdent();
      else if (s !== en && textarea.value.slice(s, en).includes('\n')) indent();
      else {
        const col = s - lineStartOf(textarea.value, s);
        edit(s, en, ' '.repeat(INDENT.length - (col % INDENT.length)));
      }
      return;
    }
    tabMoves = false;
    if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey) { e.preventDefault(); onEnter(); return; }
    const s = textarea.selectionStart, en = textarea.selectionEnd, text = textarea.value;
    if (e.key === 'Backspace' && s === en && s > 0 && !mod && !e.altKey) {
      // A pair typed together goes together; indentation goes a level at a time.
      if ((OPEN[text[s - 1]] === text[s] || (QUOTES.has(text[s - 1]) && text[s - 1] === text[s]))) { e.preventDefault(); edit(s - 1, s + 1, ''); return; }
      const lead = text.slice(lineStartOf(text, s), s);
      if (lead.length >= INDENT.length && /^ +$/.test(lead)) { e.preventDefault(); edit(s - (lead.length % INDENT.length || INDENT.length), s, ''); return; }
    }
    if (mod || e.altKey || e.key.length !== 1) return;
    const next = text[en];
    if (CLOSE[e.key] && s === en && next === e.key) { e.preventDefault(); textarea.setSelectionRange(s + 1, s + 1); schedule(); return; }
    if (e.key === '}' && /^\s+$/.test(text.slice(lineStartOf(text, s), s))) {
      // A closing brace on a line of its own steps back to the indentation of its block.
      e.preventDefault();
      const start = lineStartOf(text, s);
      const lead = text.slice(start, s);
      edit(start, en, `${lead.slice(INDENT.length)}}`);
      return;
    }
    const free = !next || /[\s)\]};,]/.test(next);
    if (OPEN[e.key] && free) { e.preventDefault(); edit(s, en, e.key + (s !== en ? text.slice(s, en) : '') + OPEN[e.key], s + 1, s + 1 + (en - s)); return; }
    if (QUOTES.has(e.key)) {
      if (s === en && next === e.key) { e.preventDefault(); textarea.setSelectionRange(s + 1, s + 1); schedule(); return; }
      const prevCh = text[s - 1];
      if ((free && !/[\w$]/.test(prevCh || '')) || s !== en) { e.preventDefault(); edit(s, en, e.key + text.slice(s, en) + e.key, s + 1, en + 1); }
    }
  }

  /* ---------- Find and Replace ---------- */

  function computeMatches() {
    const needle = findInput.value;
    matches = [];
    if (needle) {
      const hay = caseButton.getAttribute('aria-pressed') === 'true' ? textarea.value : textarea.value.toLowerCase();
      const n = caseButton.getAttribute('aria-pressed') === 'true' ? needle : needle.toLowerCase();
      for (let i = hay.indexOf(n); i >= 0 && matches.length < 5000; i = hay.indexOf(n, i + Math.max(1, n.length))) matches.push([i, i + n.length]);
    }
    if (current >= matches.length) current = matches.length - 1;
    findCount.textContent = !needle ? '' : matches.length ? `${current < 0 ? 0 : current + 1} of ${matches.length}` : 'No results';
  }
  function findNext(step) {
    computeMatches();
    if (!matches.length) { renderMarks(); return; }
    const caret = step > 0 ? textarea.selectionEnd : textarea.selectionStart;
    if (step > 0) { current = matches.findIndex(([s]) => s >= caret); if (current < 0) current = 0; }
    else { current = -1; for (let i = matches.length - 1; i >= 0; i--) if (matches[i][1] <= caret) { current = i; break; } if (current < 0) current = matches.length - 1; }
    const [s, e] = matches[current];
    textarea.setSelectionRange(s, e);
    revealLine(lineOf(s));
    findCount.textContent = `${current + 1} of ${matches.length}`;
    renderMarks();
  }
  function replaceOne() {
    if (textarea.readOnly || !findInput.value) return;
    computeMatches();
    const s = textarea.selectionStart, e = textarea.selectionEnd;
    const hit = matches.find(([a, b]) => a === s && b === e);
    if (hit) edit(s, e, replaceInput.value);
    findNext(1);
  }
  function replaceAll() {
    if (textarea.readOnly || !findInput.value) return;
    computeMatches();
    if (!matches.length) return;
    const text = textarea.value;
    let out = '', at = 0;
    for (const [s, e] of matches) { out += text.slice(at, s) + replaceInput.value; at = e; }
    out += text.slice(at);
    const count = matches.length;
    edit(0, text.length, out, 0);
    computeMatches();
    findCount.textContent = `Replaced ${count}`;
  }
  function openFind(withReplace) {
    findBar.hidden = false;
    replaceRow.hidden = !withReplace && replaceRow.hidden;
    if (withReplace) replaceRow.hidden = false;
    const s = textarea.selectionStart, e = textarea.selectionEnd;
    if (e > s && e - s < 200 && !textarea.value.slice(s, e).includes('\n')) findInput.value = textarea.value.slice(s, e);
    computeMatches();
    renderMarks();
    findInput.focus();
    findInput.select();
  }
  function closeFind() {
    findBar.hidden = true;
    matches = [];
    current = -1;
    renderMarks();
    textarea.focus();
  }
  findInput.addEventListener('input', () => { current = -1; computeMatches(); renderMarks(); });
  const findKeys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
    else if (e.key === 'Enter' && e.target === findInput) { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Enter' && e.target === replaceInput) { e.preventDefault(); if (isMod(e)) replaceAll(); else replaceOne(); }
  };
  findInput.addEventListener('keydown', findKeys);
  replaceInput.addEventListener('keydown', findKeys);
  caseButton.addEventListener('click', () => { caseButton.setAttribute('aria-pressed', String(caseButton.getAttribute('aria-pressed') !== 'true')); computeMatches(); renderMarks(); });

  /* ---------- Completions ---------- */

  function caretPoint() {
    const text = textarea.value;
    const s = textarea.selectionStart;
    const start = lineStartOf(text, s);
    const col = text.slice(start, completion ? completion.from : s).replace(/\t/g, INDENT).length;
    const pad = parseFloat(getComputedStyle(textarea).paddingLeft) || 0;
    const padTop = parseFloat(getComputedStyle(textarea).paddingTop) || 0;
    return { x: pad + col * charWidth - textarea.scrollLeft + gutter.offsetWidth, y: padTop + (lineOf(s) + 1) * lineHeight - textarea.scrollTop };
  }
  function placeCompletion() {
    const { x, y } = caretPoint();
    const box = root.getBoundingClientRect();
    const width = Math.min(320, Math.max(160, box.width - 12));
    listbox.style.width = `${width}px`;
    listbox.style.left = `${Math.max(4, Math.min(x, box.width - width - 6))}px`;
    // Below the line, or above it when the list would run off the bottom.
    const below = y + 2, height = Math.min(236, listbox.scrollHeight || 236);
    listbox.style.top = `${below + height > box.height && y - lineHeight - height - 2 > 0 ? y - lineHeight - height - 2 : below}px`;
  }
  function openCompletion(explicit = false) {
    if (textarea.readOnly || textarea.selectionStart !== textarea.selectionEnd) { closeCompletion(); return; }
    const found = completionsAt(textarea.value, textarea.selectionStart, { explicit });
    if (!found) { closeCompletion(); return; }
    completion = { ...found, index: 0 };
    listbox.replaceChildren(...found.items.map((item, i) => el('div.ce-option', {
      id: `${id}-opt-${i}`, role: 'option', 'aria-selected': String(i === 0),
      onmousedown: (ev) => { ev.preventDefault(); completion.index = i; acceptCompletion(); },
    }, el('span.ce-option-kind', { dataset: { kind: item.kind } }, item.kind === 'async' ? 'await' : item.kind === 'method' ? 'fn' : item.kind === 'keyword' ? 'kw' : item.kind === 'global' ? 'g' : 'ab'),
    el('span.ce-option-label', {}, item.label),
    el('span.ce-option-detail', {}, item.detail || ''))));
    listbox.hidden = false;
    textarea.setAttribute('aria-expanded', 'true');
    showCompletionDoc();
    placeCompletion();
  }
  function showCompletionDoc() {
    const item = completion.items[completion.index];
    for (const [i, node] of [...listbox.children].entries()) node.setAttribute('aria-selected', String(i === completion.index));
    const node = listbox.children[completion.index];
    textarea.setAttribute('aria-activedescendant', node?.id || '');
    node?.scrollIntoView?.({ block: 'nearest' });
    listbox.title = item?.doc || '';
    let doc = listbox.querySelector('.ce-option-doc');
    if (item?.doc) {
      if (!doc) { doc = el('div.ce-option-doc', { role: 'presentation' }); listbox.append(doc); }
      doc.textContent = item.doc;
    } else doc?.remove();
  }
  function moveCompletion(step) {
    const n = completion.items.length;
    completion.index = Math.max(0, Math.min(n - 1, completion.index + step));
    showCompletionDoc();
  }
  function acceptCompletion() {
    const item = completion?.items[completion.index];
    const { from } = completion || {};
    closeCompletion();
    if (!item) return;
    const s = textarea.selectionStart;
    const text = textarea.value;
    let insert = item.label;
    let caret = from + insert.length;
    if ((item.kind === 'method' || item.kind === 'async') && text[s] !== '(') {
      insert += '()';
      caret = from + item.label.length + (item.call === 'args' ? 1 : 2);
    }
    edit(from, s, insert, caret);
  }
  function closeCompletion() {
    completion = null;
    listbox.hidden = true;
    textarea.setAttribute('aria-expanded', 'false');
    textarea.removeAttribute('aria-activedescendant');
  }

  function revealLine(line) {
    const top = line * lineHeight;
    if (top < textarea.scrollTop) textarea.scrollTop = top;
    else if (top + lineHeight * 2 > textarea.scrollTop + textarea.clientHeight) textarea.scrollTop = top - textarea.clientHeight + lineHeight * 3;
    sync();
  }

  textarea.addEventListener('keydown', onKeyDown);
  textarea.addEventListener('input', (e) => {
    schedule();
    onChange?.(textarea.value);
    if (errorAt) setErrorLine(null);
    // Completions follow typing a name or a dot; anything else closes them.
    const typed = e.data;
    if (typed && /^[\w$.]$/.test(typed)) openCompletion(false);
    else if (completion) openCompletion(false);
  });
  textarea.addEventListener('scroll', sync, { passive: true });
  textarea.addEventListener('blur', () => { closeCompletion(); renderMarks(); });
  textarea.addEventListener('focus', () => renderMarks());
  const onSelection = () => { if (document.activeElement === textarea) renderMarks(); };
  document.addEventListener('selectionchange', onSelection);
  textarea.addEventListener('click', () => { closeCompletion(); renderMarks(); });
  textarea.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) renderMarks(); });
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { metrics(); sync(); }) : null;
  resize?.observe(root);
  if (readOnly) textarea.readOnly = true;
  render();
  requestAnimationFrame(() => { metrics(); render(); });

  return {
    el: root,
    textarea,
    getValue: () => textarea.value,
    setValue(text) {
      textarea.value = String(text ?? '');
      textarea.setSelectionRange(0, 0);
      textarea.scrollTop = 0;
      textarea.scrollLeft = 0;
      setErrorLine(null);
      closeCompletion();
      render();
    },
    focus() { textarea.focus(); },
    /** Put the caret at the start of line `n` (from 1) and bring it into view. */
    goToLine(n) {
      const lines = textarea.value.split('\n');
      const line = Math.max(1, Math.min(lines.length, n | 0));
      const at = lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0) + (/^\s*/.exec(lines[line - 1])[0].length);
      textarea.focus();
      textarea.setSelectionRange(at, at);
      revealLine(line - 1);
      renderMarks();
    },
    setErrorLine,
    setReadOnly(on) { textarea.readOnly = !!on; root.classList.toggle('ce-readonly', !!on); },
    openFind,
    destroy() { resize?.disconnect(); document.removeEventListener('selectionchange', onSelection); cancelAnimationFrame(frame); root.remove(); },
  };
}
