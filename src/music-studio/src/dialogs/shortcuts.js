// Keyboard shortcuts: every command that has keys, read live from the
// command registry, plus the keys the editing surfaces handle themselves
// (KEYBOARD_EDITING), grouped by area and filterable by name or key.

import { h } from '../lib/dom.js';
import { openDialog } from '../ui/dialog.js';
import { formatKeys } from '../commands/registry.js';

const SCOPES = { playlist: 'Playlist', pianoRoll: 'Piano roll', rack: 'Channel rack', mixer: 'Mixer', browser: 'Browser', typingKeyboard: 'Typing keyboard' };
const PREFIXES = {
  file: 'File', edit: 'Edit', transport: 'Transport', view: 'Windows', patterns: 'Patterns', add: 'Add',
  options: 'Options', theme: 'Options', tools: 'Tools', help: 'Help', project: 'File',
};
const ORDER = ['File', 'Edit', 'Transport', 'Windows', 'Patterns', 'Add', 'Options', 'Tools', 'Help', 'Other', 'Menus and windows', ...Object.values(SCOPES)];

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

/** Keys handled by the editing surfaces and the shell rather than by commands: { scope, label, keys }. */
export const KEYBOARD_EDITING = [
  { scope: 'Menus and windows', label: 'Focus the menu bar', keys: ['F10'] },
  { scope: 'Menus and windows', label: 'Open the context menu of the focused item', keys: ['Shift+F10'] },
  { scope: 'Menus and windows', label: 'Close a menu, dialog or editor window; cancel a drag', keys: ['Escape'] },
  { scope: 'pianoRoll', label: 'Move the cursor or the selected notes', keys: ARROWS },
  { scope: 'pianoRoll', label: 'Move the selected notes by an octave', keys: ['Shift+ArrowUp', 'Shift+ArrowDown'] },
  { scope: 'pianoRoll', label: 'Change the length of the selected notes', keys: ['Shift+ArrowLeft', 'Shift+ArrowRight'] },
  { scope: 'pianoRoll', label: 'Change the velocity of the selected notes', keys: ['Alt+ArrowUp', 'Alt+ArrowDown'] },
  { scope: 'pianoRoll', label: 'Add a note at the cursor, or edit the selected note', keys: ['Enter'] },
  { scope: 'pianoRoll', label: 'Select the next or previous note', keys: ['Tab', 'Shift+Tab'] },
  { scope: 'rack', label: 'Move between steps and controls', keys: ARROWS },
  { scope: 'rack', label: 'Move between cells from a knob', keys: ['Mod+ArrowLeft', 'Mod+ArrowRight', 'Mod+ArrowUp', 'Mod+ArrowDown'] },
  { scope: 'rack', label: 'Toggle the focused step', keys: ['Space', 'Enter'] },
  { scope: 'rack', label: 'Change the velocity of the focused step', keys: ['Shift+ArrowUp', 'Shift+ArrowDown'] },
  { scope: 'rack', label: 'Open the instrument editor (on a channel name)', keys: ['Enter'] },
  { scope: 'rack', label: 'First or last step of the row', keys: ['Home', 'End'] },
  { scope: 'playlist', label: 'Select the next or previous clip', keys: ['Tab', 'Shift+Tab'] },
  { scope: 'playlist', label: 'Move the selected clips, or the cursor', keys: ARROWS },
  { scope: 'playlist', label: 'Move the cursor', keys: ['Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+ArrowUp', 'Alt+ArrowDown'] },
  { scope: 'playlist', label: 'Change the length of the selected clips', keys: ['Shift+ArrowLeft', 'Shift+ArrowRight'] },
  { scope: 'playlist', label: 'Open the clip at the cursor, or place the selected source', keys: ['Enter'] },
  { scope: 'typingKeyboard', label: 'Play notes: Z to M (lower octave), Q to P (upper octave)', keys: ['Z', 'Q'] },
];

/** Groups [{ title, items: [{ id, label, keys: string[] }] }] for a search query (pure). */
export function shortcutGroups(commands, query = '', extras = []) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map();
  const add = (title, id, label, combos) => {
    const keys = combos.map(formatKeys);
    const hay = `${label} ${title} ${keys.join(' ')} ${combos.join(' ')}`.toLowerCase();
    if (words.length && !words.every((w) => hay.includes(w))) return;
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push({ id, label, keys });
  };
  for (const c of commands.all()) {
    if (!c.keys?.length) continue;
    const title = c.scope && c.scope !== 'global' ? SCOPES[c.scope] || c.scope : PREFIXES[c.id.split('.')[0]] || 'Other';
    add(title, c.id, c.longLabel || commands.label(c.id), c.keys);
  }
  extras.forEach((x, i) => add(SCOPES[x.scope] || x.scope, `keys.${i}`, x.label, x.keys));
  return [...groups.entries()]
    .sort((a, b) => (ORDER.indexOf(a[0]) + 1 || 99) - (ORDER.indexOf(b[0]) + 1 || 99))
    .map(([title, items]) => ({ title, items }));
}

export async function openShortcuts(app) {
  const search = h('input.input.sc-search', { type: 'search', placeholder: 'Search shortcuts', 'aria-label': 'Search shortcuts', autocomplete: 'off', spellcheck: false });
  const list = h('div.sc-list');
  const count = h('div.sr-only', { 'aria-live': 'polite' });
  const render = () => {
    const groups = shortcutGroups(app.commands, search.value, KEYBOARD_EDITING);
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
