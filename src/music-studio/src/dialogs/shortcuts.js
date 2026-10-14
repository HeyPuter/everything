// Keyboard shortcuts: every command that has keys, read live from the
// command registry, grouped by area and filterable by name or key.

import { h } from '../lib/dom.js';
import { openDialog } from '../ui/dialog.js';
import { formatKeys } from '../commands/registry.js';

const SCOPES = { playlist: 'Playlist', pianoRoll: 'Piano roll', rack: 'Channel rack', mixer: 'Mixer', browser: 'Browser' };
const PREFIXES = {
  file: 'File', edit: 'Edit', transport: 'Transport', view: 'Windows', patterns: 'Patterns', add: 'Add',
  options: 'Options', theme: 'Options', tools: 'Tools', help: 'Help', project: 'File',
};
const ORDER = ['File', 'Edit', 'Transport', 'Windows', 'Patterns', 'Add', 'Options', 'Tools', 'Help', 'Other', ...Object.values(SCOPES)];

/** Groups [{ title, items: [{ id, label, keys: string[] }] }] for a search query (pure). */
export function shortcutGroups(commands, query = '') {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map();
  for (const c of commands.all()) {
    if (!c.keys?.length) continue;
    const title = c.scope && c.scope !== 'global' ? SCOPES[c.scope] || c.scope : PREFIXES[c.id.split('.')[0]] || 'Other';
    const label = c.longLabel || commands.label(c.id);
    const keys = c.keys.map(formatKeys);
    const hay = `${label} ${title} ${keys.join(' ')} ${c.keys.join(' ')}`.toLowerCase();
    if (words.length && !words.every((w) => hay.includes(w))) continue;
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push({ id: c.id, label, keys });
  }
  return [...groups.entries()]
    .sort((a, b) => (ORDER.indexOf(a[0]) + 1 || 99) - (ORDER.indexOf(b[0]) + 1 || 99))
    .map(([title, items]) => ({ title, items }));
}

export async function openShortcuts(app) {
  const search = h('input.input.sc-search', { type: 'search', placeholder: 'Search shortcuts', 'aria-label': 'Search shortcuts', autocomplete: 'off', spellcheck: false });
  const list = h('div.sc-list');
  const count = h('div.sr-only', { 'aria-live': 'polite' });
  const render = () => {
    const groups = shortcutGroups(app.commands, search.value);
    list.replaceChildren();
    if (!groups.length) list.append(h('p.faint.sc-empty', 'No shortcuts match.'));
    for (const g of groups) {
      list.append(
        h(
          'section.sc-group',
          h('h3.dlg-section', g.title),
          h(
            'dl.sc-items',
            g.items.map((it) => [h('dt', it.label), h('dd', it.keys.map((k, i) => [i ? h('span.faint', ' or ') : null, h('kbd.kbd', k)]))]),
          ),
        ),
      );
    }
    const n = groups.reduce((s, g) => s + g.items.length, 0);
    count.textContent = `${n} shortcut${n === 1 ? '' : 's'}`;
  };
  search.addEventListener('input', render);
  render();
  await openDialog({
    title: 'Keyboard shortcuts',
    wide: true,
    className: 'dlg-shortcuts',
    body: h(
      'div.shortcuts',
      search,
      count,
      h('p.faint.sc-note', 'Shortcuts for a window work while it is active (click in it or press its window key). Hover any button to see its shortcut.'),
      list,
    ),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}
