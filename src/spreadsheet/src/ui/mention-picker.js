/**
 * The people picker of a comment box: typing @ at the start of a word lists the people who can be mentioned
 * (the co-authors of a shared workbook, the people the file is shared with, the workbook's other commenters),
 * narrowed as more is typed; an email address or a Puter username typed in full is offered too. Choosing one
 * (Enter, Tab or a click) writes "@Name " into the text and remembers the person, so the comment can say whom
 * it mentions when it is posted (findMentions in core/mentions.js).
 */
import { el } from './dom.js';
import { authorInitials } from '../core/comments.js';
import { isEmail, isUsername } from '../core/mentions.js';

const MAX_SHOWN = 8;
const open = new Map(); // close() -> the box it belongs to

/** Close the open picker lists of the boxes inside `root` (a card or the pane about to redraw), or all of them. */
export function closeMentionPickers(root = null) {
  for (const [close, area] of [...open]) if (!root || root.contains(area) || !area.isConnected) close();
}

/** The "@query" being typed just before the caret, or null. */
export function mentionQuery(text, caret) {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])@([^\s@()]*(?:@[^\s()]*)?)$/.exec(before);
  return m ? { start: before.length - m[2].length - 1, query: m[2] } : null;
}

/** The people matching what was typed, best first, and an offer for a typed address or username. */
export function matchPeople(people, query) {
  const q = query.toLowerCase();
  const score = (p) => {
    const fields = [p.name, p.user, p.email].filter(Boolean).map((s) => s.toLowerCase());
    if (!q) return 1;
    if (fields.some((f) => f.startsWith(q))) return 2;
    if (fields.some((f) => f.split(/[\s._@-]+/).some((w) => w.startsWith(q)))) return 1;
    return 0;
  };
  const list = people.map((p) => ({ p, s: score(p) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name)).map((x) => x.p).slice(0, MAX_SHOWN);
  const known = (pred) => people.some(pred);
  if (isEmail(query) && !known((p) => p.email === q)) list.push({ name: q, email: q, typed: true, hint: 'Email address' });
  // A username is offered once nobody listed matches: until then they are the likelier pick.
  else if (query.length >= 2 && isUsername(query) && !list.length) {
    list.push({ name: query, user: query, typed: true, hint: 'Puter username' });
  }
  return list;
}

let idSeq = 0;

/**
 * Wire a picker to a comment textarea. `people()` resolves the people who can be mentioned ([{ name, user?,
 * email?, hint? }]). Attach it before the box's own key handlers: while its list is open it takes the keys
 * that move in and choose from it. Returns { picked, close, destroy }; `picked` lists the people chosen.
 */
export function attachMentionPicker(area, { people }) {
  const picked = [];
  const listId = `mention-list-${++idSeq}`;
  const list = el('ul.mention-list', { id: listId, role: 'listbox', 'aria-label': 'People to mention' });
  let items = [];
  let active = 0;
  let query = null;
  let cache = null;
  let loading = null;

  area.setAttribute('aria-autocomplete', 'list');
  area.setAttribute('aria-haspopup', 'listbox');
  area.setAttribute('aria-expanded', 'false');

  async function load() {
    if (cache) return cache;
    loading ??= Promise.resolve().then(people).then((list) => (cache = list || []), () => (cache = []));
    return loading;
  }

  function close() {
    open.delete(close);
    list.remove();
    query = null;
    items = [];
    area.setAttribute('aria-expanded', 'false');
    area.removeAttribute('aria-controls');
    area.removeAttribute('aria-activedescendant');
  }

  function place() {
    const rect = area.getBoundingClientRect();
    const h = list.offsetHeight || 200;
    const below = rect.bottom + 4 + h <= window.innerHeight - 8;
    list.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - (list.offsetWidth || 260) - 8)))}px`;
    list.style.top = `${Math.round(below ? rect.bottom + 4 : Math.max(8, rect.top - h - 4))}px`;
  }

  function render() {
    list.replaceChildren(...items.map((p, i) => el('li.mention-option', {
      id: `${listId}-${i}`, role: 'option', 'aria-selected': String(i === active),
      onpointerdown: (e) => { e.preventDefault(); choose(i); },
      onpointermove: () => { if (active !== i) { active = i; render(); } },
    },
    el('span.mention-avatar', { 'aria-hidden': 'true' }, p.typed ? '@' : authorInitials(p.name)),
    el('span.mention-who', {}, el('span.mention-name', {}, p.typed ? `Mention ${p.name}` : p.name),
      el('span.mention-hint', {}, p.hint || (p.email && p.email !== p.name ? p.email : p.user && p.user !== p.name ? `@${p.user}` : ''))))));
    if (!items.length) list.append(el('li.mention-empty', { role: 'presentation' }, 'Type a Puter username or an email address'));
    area.setAttribute('aria-activedescendant', items.length ? `${listId}-${active}` : '');
  }

  async function update() {
    const q = mentionQuery(area.value, area.selectionStart ?? area.value.length);
    if (!q) { close(); return; }
    query = q;
    const all = await load();
    if (query !== q || !area.isConnected || document.activeElement !== area) return;
    const next = matchPeople(all, q.query);
    items = next;
    active = Math.min(active, Math.max(0, items.length - 1));
    if (!list.isConnected) {
      document.body.append(list);
      open.set(close, area);
      area.setAttribute('aria-expanded', 'true');
      area.setAttribute('aria-controls', listId);
    }
    render();
    place();
  }

  function choose(i) {
    const person = items[i];
    if (!person || !query) return;
    const name = person.name;
    const caret = area.selectionStart ?? area.value.length;
    const before = area.value.slice(0, query.start), after = area.value.slice(caret);
    const insert = `@${name}${/^\s/.test(after) ? '' : ' '}`;
    area.value = before + insert + after;
    const at = before.length + insert.length;
    area.setSelectionRange(at, at);
    const { typed: _t, hint: _h, ...who } = person;
    if (!picked.some((p) => p.name === who.name && p.user === who.user && p.email === who.email)) picked.push(who);
    close();
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.focus();
  }

  const onKey = (e) => {
    if (!list.isConnected || e.isComposing) return;
    const move = (step) => { if (items.length) { active = (active + step + items.length) % items.length; render(); } };
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') { if (!items.length) { close(); return; } choose(active); }
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onInput = () => { active = 0; update(); };
  const onBlur = () => setTimeout(() => { if (document.activeElement !== area) close(); }, 0);
  area.addEventListener('keydown', onKey);
  area.addEventListener('input', onInput);
  area.addEventListener('click', onInput);
  area.addEventListener('blur', onBlur);

  return {
    picked,
    close,
    get isOpen() { return list.isConnected; },
    destroy() {
      close();
      area.removeEventListener('keydown', onKey);
      area.removeEventListener('input', onInput);
      area.removeEventListener('click', onInput);
      area.removeEventListener('blur', onBlur);
    },
  };
}
