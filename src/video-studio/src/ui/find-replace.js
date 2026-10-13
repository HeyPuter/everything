/**
 * Find and replace dialog for captions and titles: live matches with their
 * time and context, jump to a match, replace one or all in one undo step.
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { clock } from '../lib/time.js';
import { findMatches, replaceOne, replaceAll } from '../model/find-replace.js';
import { findClip } from '../model/timeline.js';
import { openDialog } from './dialog.js';
import { prefs, setPref } from './prefs.js';
import '../styles/find-replace.css';

const CONTEXT = 28;

/** A match in its line: a little text either side, the match itself marked. */
function snippet(m) {
  const from = Math.max(0, m.index - CONTEXT);
  const to = Math.min(m.text.length, m.index + m.length + CONTEXT);
  return h('span.fr-snippet',
    from > 0 ? '…' : '', m.text.slice(from, m.index),
    h('mark', m.text.slice(m.index, m.index + m.length)),
    m.text.slice(m.index + m.length, to), to < m.text.length ? '…' : '');
}

export function openFindReplace(ctx, { query = '' } = {}) {
  const { store } = ctx;
  const saved = prefs().findReplace || {};
  const opts = { matchCase: Boolean(saved.matchCase), wholeWord: Boolean(saved.wholeWord), captionsOnly: Boolean(saved.captionsOnly) };
  const find = h('input.input', { type: 'search', value: query, placeholder: 'Find', 'aria-label': 'Find', autofocus: true, spellcheck: false });
  const repl = h('input.input', { type: 'text', placeholder: 'Replace with', 'aria-label': 'Replace with', spellcheck: false });
  const toggle = (key, label, glyph) => {
    const b = h('button.fr-opt', { type: 'button', 'aria-pressed': String(opts[key]), 'data-tip': label, 'aria-label': label }, glyph);
    b.addEventListener('click', () => {
      opts[key] = !opts[key];
      b.setAttribute('aria-pressed', String(opts[key]));
      setPref('findReplace', { ...opts });
      render();
    });
    return b;
  };
  const optRow = h('div.fr-opts', { role: 'group', 'aria-label': 'Search options' },
    toggle('matchCase', 'Match case', 'Aa'),
    toggle('wholeWord', 'Whole words', h('span.fr-word', 'ab')),
    toggle('captionsOnly', 'Captions only', icon('captions', 14)));
  const count = h('p.fr-count', { role: 'status', 'aria-live': 'polite' });
  const list = h('ul.fr-list', { 'aria-label': 'Matches' });
  const allBtn = h('button.btn.primary', { type: 'button' }, 'Replace all');
  const closeBtn = h('button.btn', { type: 'button' }, 'Done');
  const body = h('div.fr',
    h('div.fr-fields', h('div.fr-find', icon('search', 14), find, optRow), h('div.fr-replace', icon('replace', 14), repl)),
    count, list);
  const d = openDialog({ title: 'Find and replace', body, actions: [closeBtn, allBtn], className: 'find-replace' });
  closeBtn.addEventListener('click', () => d.close());

  let matches = [];
  function render() {
    matches = findMatches(store.project, find.value, opts);
    const clips = new Set(matches.map((m) => m.clipId)).size;
    count.textContent = !find.value ? 'Type to search captions and text.' : matches.length ? `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${clips} clip${clips === 1 ? '' : 's'}` : 'No matches';
    allBtn.disabled = !matches.some((m) => !m.locked);
    list.replaceChildren(...matches.slice(0, 500).map((m) => {
      const go = h('button.fr-go', { type: 'button', 'aria-label': `Go to match at ${clock(m.at)}: ${m.text}` }, h('span.fr-time', clock(m.at)), snippet(m));
      go.addEventListener('click', () => jump(m));
      const one = h('button.icon-btn.small.fr-one', { type: 'button', 'aria-label': 'Replace this match', 'data-tip': m.locked ? 'Track is locked' : 'Replace', disabled: m.locked }, icon('replace', 14));
      one.addEventListener('click', () => replaceMatch(m));
      return h('li.fr-item', go, one);
    }));
  }

  function jump(m) {
    store.seek(m.at);
    // Clips inside compound clips can't be selected from here; the playhead goes to them.
    if (findClip(store.project, m.clipId)) store.select(m.clipId);
  }

  function replaceMatch(m) {
    const ok = store.update('Replace text', (p) => replaceOne(findClipDeep(p, m.clipId), m, repl.value), { structural: false });
    if (ok) announce('Replaced');
    render();
  }

  allBtn.addEventListener('click', () => {
    let n = 0;
    store.update('Replace all', (p) => {
      n = replaceAll(p, find.value, repl.value, opts);
      return n > 0;
    }, { structural: false });
    announce(n ? `Replaced ${n} match${n === 1 ? '' : 'es'}` : 'Nothing replaced');
    render();
  });

  find.addEventListener('input', render);
  for (const input of [find, repl]) {
    input.addEventListener('keydown', (e) => {
      // Keep editor shortcuts out of the fields.
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        if (matches[0]) jump(matches[0]);
      }
    });
  }
  const off = store.on('change', (e) => {
    if (!e.restore) return;
    render();
  });
  d.result.then(off);
  render();
  return d;
}

/** A clip anywhere on the open timeline, inside compound clips too. */
function findClipDeep(project, id) {
  const walk = (tracks) => {
    for (const t of tracks) for (const c of t.clips) {
      if (c.id === id) return c;
      if (c.type === 'compound') {
        const inner = walk(c.sequence.tracks);
        if (inner) return inner;
      }
    }
    return null;
  };
  return walk(project.tracks);
}
