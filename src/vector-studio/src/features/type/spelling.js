/**
 * Spelling: Edit > Spelling > Check Spelling (Mod+I), Auto Spell Check
 * (wavy underlines under unknown words on the canvas) and Edit Custom
 * Dictionary. The word list loads on first use (spell-dict.js).
 *
 * Words the user adds live in the preferences (`spellingWords`); Ignore All
 * lasts for the session. Changes made from the dialog are ordinary undoable
 * document edits.
 */
import { h } from '../../lib/dom.js';
import { setListItems } from '../../ui/panels/panel.js';
import { layoutText, selectionPolygons } from '../../model/text-layout.js';
import { replaceRange, styleAt, styledRuns } from '../../model/text-runs.js';
import { canSpellCheck } from '../../model/languages.js';
import { overlayHooks } from '../../render/overlay.js';
import { nodeBounds, rectsIntersect } from '../../model/geometry.js';
import { multiply } from '../../lib/matrix.js';
import { loadSpeller, loadedSpeller, dictionaryKey, DICTIONARIES } from './spell-dict.js';
import { selectedTextNodes } from './outlines.js';

export const DEFAULT_SPELL_OPTIONS = Object.freeze({
  repeated: true, // flag a word typed twice in a row
  matchCase: true, // names need their capital
  ignoreUpper: false, // skip words in UPPERCASE
  ignoreNumbers: true, // skip words that contain digits
  ignoreRoman: true, // skip Roman numerals
});

const WORD_RE = /[\p{L}\p{N}]+(?:['\u2019][\p{L}]+)*/gu;
const ROMAN = /^(?=[MDCLXVI])M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

const ignoredAll = new Set(); // Ignore All, for this session
let customVersion = 0;

export function customWords(prefs) {
  const w = prefs?.get('spellingWords');
  return Array.isArray(w) ? w : [];
}

export function setCustomWords(prefs, words) {
  const clean = [...new Set(words.map((w) => String(w).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  prefs.set('spellingWords', clean);
  customVersion++;
}

export function spellOptions(prefs) {
  return { ...DEFAULT_SPELL_OPTIONS, ...(prefs?.get('spellingOptions') || {}) };
}

/** Words of a text: [{ start, end, word }]. Apostrophes inside words belong to them. */
export function wordsOf(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(WORD_RE)) out.push({ start: m.index, end: m.index + m[0].length, word: m[0] });
  return out;
}

/**
 * Spelling issues in a text: [{ start, end, word, kind: 'spelling' | 'repeated' }].
 * `accept(word)` lets custom and ignored words through.
 */
export function findIssues(text, speller, opts = DEFAULT_SPELL_OPTIONS, accept = () => false) {
  const s = String(text ?? '');
  const o = { ...DEFAULT_SPELL_OPTIONS, ...opts };
  const out = [];
  let prev = null;
  for (const w of wordsOf(s)) {
    const word = w.word;
    const skip =
      (o.ignoreNumbers && /\p{N}/u.test(word)) ||
      (o.ignoreUpper && word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase()) ||
      (o.ignoreRoman && ROMAN.test(word)) ||
      /^\p{N}+$/u.test(word);
    if (o.repeated && prev && prev.word.toLowerCase() === word.toLowerCase() && /^[ \t\u00a0]+$/.test(s.slice(prev.end, w.start)) && !/\p{N}/u.test(word)) {
      out.push({ start: w.start, end: w.end, word, kind: 'repeated', from: prev.end });
    } else if (!skip && !accept(word) && !speller.correct(word, { matchCase: o.matchCase })) {
      out.push({ ...w, kind: 'spelling' });
    }
    prev = w;
  }
  return out;
}

/** Issues in a text node, leaving out words in languages the dictionary does not cover. */
export function nodeIssues(node, issues) {
  if (!issues.length || (!node.runs && canSpellCheck(node.char?.language))) return issues;
  return issues.filter((is) => canSpellCheck(styleAt(node, is.start).language));
}

/** Stretches of a text node by spelling dictionary: [{ start, end, dict }] (dict null: not checked). */
export function dictionarySegments(node) {
  const out = [];
  for (const r of styledRuns(node)) {
    const dict = dictionaryKey(r.style.language);
    const last = out[out.length - 1];
    if (last && last.dict === dict && last.end === r.start) last.end = r.end;
    else out.push({ start: r.start, end: r.end, dict });
  }
  return out;
}

/**
 * Spelling issues in a text node, each stretch checked with the dictionary
 * of its language (`spellerFor(dict)`, null while it loads: that stretch
 * is skipped). Issues carry `dict`.
 */
export function spellIssues(node, spellerFor, opts = DEFAULT_SPELL_OPTIONS, accept = () => false) {
  const text = String(node.text ?? '');
  const out = [];
  for (const seg of dictionarySegments(node)) {
    if (!seg.dict || seg.end <= seg.start) continue;
    const sp = spellerFor(seg.dict);
    if (!sp) continue;
    for (const is of findIssues(text.slice(seg.start, seg.end), sp, opts, accept)) {
      out.push({ ...is, start: is.start + seg.start, end: is.end + seg.start, ...(is.from != null ? { from: is.from + seg.start } : {}), dict: seg.dict });
    }
  }
  return out;
}

/** accept() for findIssues from the custom dictionary and Ignore All. */
export function acceptor(prefs) {
  const custom = new Set(customWords(prefs).map((w) => w.toLowerCase()));
  return (word) => ignoredAll.has(word) || custom.has(word.toLowerCase()) || custom.has(word.replace(/\u2019/g, "'").toLowerCase());
}

// ---- auto spell check (overlay) ----

let issueCache = new WeakMap(); // text node -> issues
let cacheKey = '';

function cachedIssues(node, spellerFor, prefs, loadedKey) {
  const key = `${customVersion}|${ignoredAll.size}|${JSON.stringify(spellOptions(prefs))}|${loadedKey}`;
  if (key !== cacheKey) {
    issueCache = new WeakMap();
    cacheKey = key;
  }
  let v = issueCache.get(node);
  if (!v) {
    v = spellIssues(node, spellerFor, spellOptions(prefs), acceptor(prefs));
    issueCache.set(node, v);
  }
  return v;
}

function wave(ctx, a, b, amp = 1.4, period = 4) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len;
  const uy = dy / len;
  const steps = Math.max(2, Math.ceil(len / (period / 2)));
  for (let k = 0; k <= steps; k++) {
    const t = (k / steps) * len;
    const off = k % 2 ? amp : -amp;
    const x = a.x + ux * t - uy * off;
    const y = a.y + uy * t + ux * off;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

/** Overlay hook: underline unknown words in visible type objects. */
export function spellOverlay(app) {
  const requested = new Set();
  return (ctx, editor) => {
    if (!app.prefs.get('autoSpellCheck')) return;
    // Dictionaries load the first time text in their language shows.
    const loaded = [];
    const spellerFor = (dict) => {
      const sp = loadedSpeller(dict);
      if (sp) return sp;
      if (!requested.has(dict)) {
        requested.add(dict);
        loadSpeller(dict).then(
          () => editor.emit('overlay'),
          () => requested.delete(dict),
        );
      }
      return null;
    };
    for (const k of Object.keys(DICTIONARIES)) if (loadedSpeller(k)) loaded.push(k);
    const { doc, view } = editor;
    const visible = view.visibleRect(20 / view.zoom);
    const edit = editor.textEdit;
    ctx.save();
    ctx.strokeStyle = '#e5242a';
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let drawn = 0;
    for (const n of doc.leaves()) {
      if (n.type !== 'text' || doc.isHidden(n.id)) continue;
      const b = nodeBounds(doc, n);
      if (!b || !rectsIntersect(b, visible)) continue;
      const lay = layoutText(n);
      if (!lay.text) continue;
      const issues = cachedIssues(lay.source || n, spellerFor, app.prefs, loaded.join());
      if (!issues.length) continue;
      const m = multiply(view.matrix, n.transform);
      const toScreen = (p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
      for (const is of issues) {
        // The word being typed is not flagged until the caret leaves it.
        if (edit && edit.caret === edit.anchor && edit.caret >= is.start && edit.caret <= is.end && (edit.id === n.id || lay.node?.id === edit.id)) continue;
        for (const poly of selectionPolygons(lay, is.start, is.end)) {
          const k = poly.length / 2;
          const bottom = poly.slice(k).reverse().map(toScreen);
          for (let i = 0; i + 1 < bottom.length; i++) wave(ctx, bottom[i], bottom[i + 1]);
          if (++drawn > 2000) break;
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  };
}

// ---- Check Spelling dialog ----

/** Text objects to check: the selection's type when there is some, else every unlocked, visible one. */
function scopeNodes(app, selectedOnly) {
  const ed = app.editor;
  const doc = ed.doc;
  const s = app.typeSession && !app.typeSession.ended ? app.typeSession : null;
  let nodes;
  if (selectedOnly) nodes = s ? [s.node()].filter(Boolean) : selectedTextNodes(ed);
  else nodes = doc.leaves().filter((n) => n.type === 'text');
  return nodes.filter((n) => n.text && !doc.isLocked(n.id) && !doc.isHidden(n.id)).map((n) => n.id);
}

function contextOf(text, start, end) {
  const a = Math.max(0, start - 60);
  const b = Math.min(text.length, end + 60);
  const before = text.slice(a, start).replace(/^\S*\s/, a > 0 ? '' : '$&');
  const after = text.slice(end, b).replace(/\s\S*$/, b < text.length ? '' : '$&');
  return { before: (a > 0 ? '\u2026' : '') + before, word: text.slice(start, end), after: after + (b < text.length ? '\u2026' : '') };
}

export async function openCheckSpelling(app) {
  const ed = app.editor;
  if (!ed) return;
  const status = h('p.sp-status', { role: 'status', 'aria-live': 'polite' }, 'Loading the dictionary\u2026');
  const context = h('p.sp-context', { role: 'status', 'aria-label': 'Word in context' });
  const changeTo = h('input#sp-change', { type: 'text', autocomplete: 'off', spellcheck: false });
  const list = h('div.sp-suggestions', { role: 'listbox', 'aria-label': 'Suggestions', tabindex: '0' });
  const hasSel = Boolean((app.typeSession && !app.typeSession.ended) || selectedTextNodes(ed).length);
  const scopeSel = h(
    'select#sp-scope',
    h('option', { value: 'doc' }, 'Entire Document'),
    h('option', { value: 'sel', disabled: !hasSel }, 'Selected Text Objects'),
  );
  scopeSel.value = hasSel && app.typeSession?.ended === false ? 'sel' : 'doc';
  const opts = spellOptions(app.prefs);
  const box = (key, label) => {
    const el = h('input', { type: 'checkbox', id: `sp-${key}`, checked: Boolean(opts[key]) });
    el.addEventListener('change', () => {
      app.prefs.set('spellingOptions', { ...spellOptions(app.prefs), [key]: el.checked });
      restart();
    });
    return h('div.form-row.check', el, h('label', { for: `sp-${key}` }, label));
  };
  const btn = (label, fn, extra = {}) => h('button.btn', { type: 'button', onclick: fn, ...extra }, label);
  const bIgnore = btn('Ignore', () => skip());
  const bIgnoreAll = btn('Ignore All', () => ignoreAll());
  const bChange = btn('Change', () => change(false));
  const bChangeAll = btn('Change All', () => change(true));
  const bAdd = btn('Add to Dictionary', () => addWord());
  const actions = [bIgnore, bIgnoreAll, bChange, bChangeAll, bAdd];
  const body = h(
    'div.spell-check',
    status,
    h('div.sp-main', context, h('div.sp-actions', bIgnore, bIgnoreAll)),
    h('div.form-row', h('label', { for: 'sp-change' }, 'Change To'), changeTo),
    h('div.sp-main', list, h('div.sp-actions', bChange, bChangeAll, bAdd)),
    h(
      'details.sp-options',
      h('summary', 'Options'),
      h('div.form-row', h('label', { for: 'sp-scope' }, 'Check'), scopeSel),
      box('repeated', 'Find repeated words'),
      box('matchCase', 'Names must be capitalized'),
      box('ignoreUpper', 'Ignore words in UPPERCASE'),
      box('ignoreNumbers', 'Ignore words with numbers'),
      box('ignoreRoman', 'Ignore Roman numerals'),
    ),
  );
  scopeSel.addEventListener('change', () => restart());

  let speller = null;
  let ids = [];
  let at = { k: 0, pos: 0 }; // node index and text position to search from
  let current = null; // { id, start, end, word, kind, from }
  let changes = 0;

  const show = (issue) => {
    current = issue;
    actions.forEach((b) => (b.disabled = !issue));
    if (!issue) return;
    const n = ed.doc.get(issue.id);
    const c = contextOf(n.text, issue.start, issue.end);
    context.replaceChildren(c.before, h('mark', c.word), c.after);
    if (issue.kind === 'repeated') {
      status.textContent = `Repeated word: \u201c${issue.word}\u201d`;
      list.replaceChildren(h('div.sp-item', { role: 'option', 'aria-selected': 'true', 'data-value': '' }, 'Delete the repeated word'));
      changeTo.value = '';
      bAdd.disabled = true;
      bIgnoreAll.disabled = true;
      bChangeAll.disabled = true;
    } else {
      status.textContent = `Not in the dictionary: \u201c${issue.word}\u201d`;
      const sug = (loadedSpeller(issue.dict) || speller).suggest(issue.word);
      list.replaceChildren(...(sug.length ? sug.map((w, i) => h('div.sp-item', { role: 'option', 'aria-selected': String(i === 0), 'data-value': w }, w)) : [h('div.sp-empty', 'No suggestions')]));
      changeTo.value = sug[0] || issue.word;
    }
    // Show the word on the canvas.
    const tool = app.getTool('type');
    if (tool) {
      if (app.toolId !== 'type') app.setTool('type');
      const sess = tool.editText(issue.id, null);
      sess?.setSelection(issue.start, issue.end);
    }
  };

  const finish = () => {
    show(null);
    context.replaceChildren();
    list.replaceChildren();
    changeTo.value = '';
    status.textContent = changes ? `Spelling check complete. ${changes} ${changes === 1 ? 'change' : 'changes'} made.` : 'Spelling check complete. No more unknown words.';
  };

  const next = () => {
    const accept = acceptor(app.prefs);
    const o = spellOptions(app.prefs);
    for (; at.k < ids.length; at.k++, at.pos = 0) {
      const n = ed.doc.get(ids[at.k]);
      if (!n) continue;
      const found = spellIssues(n, loadedSpeller, o, accept).find((is) => is.start >= at.pos);
      if (found) {
        show({ id: n.id, ...found });
        return;
      }
    }
    finish();
  };

  const restart = () => {
    if (!speller) return;
    ids = scopeNodes(app, scopeSel.value === 'sel');
    at = { k: 0, pos: 0 };
    if (!ids.length) {
      show(null);
      status.textContent = 'There is no text to check.';
      return;
    }
    next();
  };

  const skip = () => {
    if (!current) return;
    at.pos = current.end;
    next();
  };

  const ignoreAll = () => {
    if (!current) return;
    ignoredAll.add(current.word);
    app.editor?.emit('overlay');
    at.pos = current.start;
    next();
  };

  const addWord = () => {
    if (!current) return;
    setCustomWords(app.prefs, [...customWords(app.prefs), current.word]);
    app.editor?.emit('overlay');
    at.pos = current.start;
    next();
  };

  const change = (all) => {
    if (!current) return;
    const to = changeTo.value;
    const doc = ed.doc;
    if (current.kind === 'repeated') {
      const n = doc.get(current.id);
      doc.transact('Delete Repeated Word', () => doc.update(n.id, replaceRange(n, current.from, current.end, '')));
      changes++;
      at.pos = current.from;
      next();
      return;
    }
    if (!all) {
      const n = doc.get(current.id);
      doc.transact('Change Spelling', () => doc.update(n.id, replaceRange(n, current.start, current.end, to)));
      changes++;
      at.pos = current.start + to.length;
      next();
      return;
    }
    const word = current.word;
    doc.transact('Change All Spelling', () => {
      for (const id of ids) {
        let n = doc.get(id);
        if (!n) continue;
        const hits = wordsOf(n.text).filter((w) => w.word === word);
        if (!hits.length) continue;
        for (let i = hits.length - 1; i >= 0; i--) {
          n = { ...n, ...replaceRange(n, hits[i].start, hits[i].end, to) };
          changes++;
        }
        doc.update(id, { text: n.text, runs: n.runs, paras: n.paras, char: n.char, fill: n.fill, stroke: n.stroke, strokeWidth: n.strokeWidth });
      }
    });
    // Positions before the current word did not move.
    at.pos = current.start + to.length;
    next();
  };

  const pick = (el) => {
    if (!el || el.dataset.value === undefined) return;
    for (const o of list.querySelectorAll('[role=option]')) o.setAttribute('aria-selected', String(o === el));
    changeTo.value = el.dataset.value;
  };
  list.addEventListener('click', (e) => pick(e.target.closest('[role=option]')));
  list.addEventListener('dblclick', (e) => {
    pick(e.target.closest('[role=option]'));
    change(false);
  });
  list.addEventListener('keydown', (e) => {
    const items = [...list.querySelectorAll('[role=option]')];
    if (!items.length) return;
    const i = items.findIndex((o) => o.getAttribute('aria-selected') === 'true');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const el = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      pick(el);
      el.scrollIntoView?.({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      change(false);
    }
  });
  changeTo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      change(false);
    }
  });
  actions.forEach((b) => (b.disabled = true));

  const done = app.dialogs.open({ title: 'Check Spelling', body, className: 'spell-dialog', buttons: [{ label: 'Done', value: true, primary: true }] });
  try {
    // The dictionaries of every language the document's text is in.
    const dicts = new Set(['en-US']);
    for (const n of ed.doc.leaves()) if (n.type === 'text') for (const seg of dictionarySegments(n)) if (seg.dict) dicts.add(seg.dict);
    const all = await Promise.all([...dicts].map((d) => loadSpeller(d)));
    speller = all[0];
    restart();
  } catch (err) {
    status.textContent = err.message || 'The spelling dictionary could not be loaded.';
  }
  return done;
}

// ---- custom dictionary ----

export function openCustomDictionary(app) {
  const entry = h('input#cd-entry', { type: 'text', autocomplete: 'off', spellcheck: false });
  const list = h('div.cd-list', { role: 'listbox', 'aria-label': 'Words in the dictionary', tabindex: '0' });
  const status = h('p.cd-status', { role: 'status', 'aria-live': 'polite' });
  let selected = null;
  const words = () => customWords(app.prefs);
  const render = () => {
    const q = entry.value.trim().toLowerCase();
    const all = words();
    const shown = all.filter((w) => !q || w.toLowerCase().includes(q));
    setListItems(list, shown.map((w) => h('div.cd-item', { role: 'option', 'aria-selected': String(w === selected), 'data-word': w }, w)), h('p.panel-empty', all.length ? 'No words match.' : 'No words yet. Type a word and choose Add.'));
    bDelete.disabled = !selected;
    bChange.disabled = !selected || !entry.value.trim() || entry.value.trim() === selected;
    bAdd.disabled = !entry.value.trim() || all.includes(entry.value.trim());
  };
  const commit = (next, msg) => {
    setCustomWords(app.prefs, next);
    status.textContent = msg;
    app.editor?.emit('overlay');
    render();
  };
  const bAdd = h('button.btn', { type: 'button', onclick: () => {
    const w = entry.value.trim();
    if (!w || /\s/.test(w)) {
      status.textContent = 'Enter a single word.';
      return;
    }
    selected = w;
    entry.value = '';
    commit([...words(), w], `Added \u201c${w}\u201d.`);
  } }, 'Add');
  const bDelete = h('button.btn', { type: 'button', onclick: () => {
    if (!selected) return;
    const w = selected;
    selected = null;
    commit(words().filter((x) => x !== w), `Deleted \u201c${w}\u201d.`);
  } }, 'Delete');
  const bChange = h('button.btn', { type: 'button', onclick: () => {
    const w = entry.value.trim();
    if (!selected || !w || /\s/.test(w)) return;
    const old = selected;
    selected = w;
    entry.value = '';
    commit([...words().filter((x) => x !== old), w], `Changed \u201c${old}\u201d to \u201c${w}\u201d.`);
  } }, 'Change');
  entry.addEventListener('input', render);
  entry.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!bAdd.disabled) bAdd.click();
    }
  });
  list.addEventListener('click', (e) => {
    const el = e.target.closest('[data-word]');
    if (!el) return;
    selected = el.dataset.word;
    entry.value = selected;
    render();
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      bDelete.click();
    }
  });
  const body = h(
    'div.custom-dictionary',
    h('div.form-row', h('label', { for: 'cd-entry' }, 'Word'), entry),
    h('div.sp-main', list, h('div.sp-actions', bAdd, bDelete, bChange)),
    status,
    app.commands.get('type.hyphenationExceptions') ? h('div.form-row', h('span'), h('button.btn', { type: 'button', onclick: () => app.commands.run('type.hyphenationExceptions') }, 'Hyphenation Exceptions...')) : null,
  );
  render();
  return app.dialogs.open({ title: 'Custom Dictionary', body, className: 'spell-dialog', buttons: [{ label: 'Done', value: true, primary: true }] });
}

export function installSpelling(app) {
  overlayHooks.add(spellOverlay(app));
  app.commands.register([
    { id: 'type.spelling.check', label: 'Check Spelling...', shortcut: 'Mod+I', enabled: (a) => Boolean(a.editor), run: openCheckSpelling },
    {
      id: 'type.spelling.auto',
      label: 'Auto Spell Check',
      enabled: (a) => Boolean(a.editor),
      checked: (a) => Boolean(a.prefs.get('autoSpellCheck')),
      run: (a) => {
        a.prefs.set('autoSpellCheck', !a.prefs.get('autoSpellCheck'));
        a.editor?.emit('overlay');
      },
    },
    { id: 'type.spelling.dictionary', label: 'Edit Custom Dictionary...', run: openCustomDictionary },
  ]);
}
