// Edit > Keyboard Shortcuts. The top half draws a keyboard: each key shows
// the command it runs with the modifier layer in view (click a modifier key,
// or hold it down, to switch layers), coloured for application shortcuts,
// editor-panel shortcuts and keys the browser keeps. Clicking a key lists
// what it does with every modifier combination; clicking a command there or
// in the command tree selects it. The tree groups every command by category
// and is searchable by name or key; clicking a shortcut (or +) and pressing
// keys changes it. Presets save and restore whole keymaps (the default set is
// read-only), Undo steps back through this session's changes, Copy to
// Clipboard exports the keymap as text, and Cancel restores the keymap the
// dialog opened with.

import '../styles/shortcuts.css';
import { h, announce } from '../lib/dom.js';
import { icon } from './icons.js';
import { openDialog, promptDialog, confirmDialog } from './dialog.js';
import { formatShortcut, eventShortcut, normalizeShortcut, browserReserved, IS_MAC } from '../commands/registry.js';
import { commandMenuPaths, contextLabel } from './menus.js';

/** Category of a command for the tree and the copied list. */
const PREFIX_CATEGORY = {
  analysis: 'Analysis',
  channel: 'Edit',
  clip: 'Clip',
  edit: 'Edit',
  export: 'File',
  fav: 'Favorites',
  file: 'File',
  fx: 'Effects',
  gen: 'Effects',
  help: 'Help',
  marker: 'Edit',
  meter: 'Metering',
  mt: 'Multitrack',
  prefs: 'Preferences',
  snap: 'Edit',
  spectral: 'View',
  status: 'View',
  theme: 'View',
  tool: 'Tools',
  transport: 'Transport',
  video: 'Multitrack',
  view: 'View',
  window: 'Window',
  workspace: 'Workspace',
  zero: 'Edit',
};
const ID_CATEGORY = {
  'edit.preferences': 'Preferences',
  'edit.keyboardShortcuts': 'Preferences',
  'transport.meterInput': 'Metering',
  'spectral.brushSmaller': 'Tools',
  'spectral.brushLarger': 'Tools',
  'spectral.opacityDown': 'Tools',
  'spectral.opacityUp': 'Tools',
  'fx.analysis': 'Analysis',
};

export function categoryOf(id) {
  if (ID_CATEGORY[id]) return ID_CATEGORY[id];
  const p = id.split('.')[0];
  return PREFIX_CATEGORY[p] || p.charAt(0).toUpperCase() + p.slice(1);
}

/**
 * Keys handled by the focused editor panel before the application keymap
 * sees them: { keys, panel, label }.
 */
export const PANEL_KEYS = [
  { keys: 'Escape', panel: 'Editor', label: 'Clear Selection' },
  { keys: 'Shift+ArrowLeft', panel: 'Editor', label: 'Extend Selection Left' },
  { keys: 'Shift+ArrowRight', panel: 'Editor', label: 'Extend Selection Right' },
  { keys: 'Alt+ArrowLeft', panel: 'Waveform Editor', label: 'Move Playhead One Sample Left' },
  { keys: 'Alt+ArrowRight', panel: 'Waveform Editor', label: 'Move Playhead One Sample Right' },
  { keys: 'Tab', panel: 'Multitrack Editor', label: 'Focus Next Clip' },
  { keys: 'Shift+Tab', panel: 'Multitrack Editor', label: 'Focus Previous Clip' },
];

const MOD_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'];

/** Shortcut text for a key with modifiers ('Mod', 'Shift', 'Alt', 'Ctrl'). */
export function comboFor(key, mods) {
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/** Modifier names as the platform writes them: "⌥⇧⌘" or "Ctrl+Alt+Shift"; "None" without any. */
export function modsLabel(mods) {
  const list = [...mods];
  if (!list.length) return 'None';
  if (IS_MAC) {
    const sym = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
    return ['Ctrl', 'Alt', 'Shift', 'Mod'].filter((m) => mods.has(m)).map((m) => sym[m]).join('');
  }
  const name = { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
  return ['Mod', 'Alt', 'Shift'].filter((m) => mods.has(m)).map((m) => name[m]).join('+');
}

/** Modifier combinations listed for one key, in the order people reach for them. */
export const MOD_COMBOS = [[], ['Mod'], ['Alt'], ['Shift'], ['Mod', 'Alt'], ['Mod', 'Shift'], ['Alt', 'Shift'], ['Mod', 'Alt', 'Shift'], ...(IS_MAC ? [['Ctrl'], ['Ctrl', 'Mod'], ['Ctrl', 'Alt'], ['Ctrl', 'Shift']] : [])];

/**
 * Keyboard layout: rows of [key as in shortcuts, cap label, width in key
 * units, modifier]. Modifier keys have no shortcut key (null) and name the
 * modifier they switch on; null-key entries without one are gaps. The main
 * block is 15 units wide; the navigation block follows each row.
 */
const MAC_MODS = [[null, '⌃ control', 1.25, 'Ctrl'], [null, '⌥ option', 1.25, 'Alt'], [null, '⌘ command', 1.5, 'Mod'], ['Space', 'Space', 7], [null, '⌘ command', 1.5, 'Mod'], [null, '⌥ option', 1.25, 'Alt'], [null, '⌃ control', 1.25, 'Ctrl']];
const PC_MODS = [[null, 'Ctrl', 1.5, 'Mod'], [null, '', 1.25], [null, 'Alt', 1.25, 'Alt'], ['Space', 'Space', 7], [null, 'Alt', 1.25, 'Alt'], [null, '', 1.25], [null, 'Ctrl', 1.5, 'Mod']];
const fRow = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => [`F${from + i}`, `F${from + i}`]);
const chars = (s) => [...s].map((c) => [c, c]);

export const KEY_ROWS = [
  [['Escape', 'Esc'], [null, '', 1], ...fRow(1, 4), [null, '', 0.5], ...fRow(5, 8), [null, '', 0.5], ...fRow(9, 12)],
  [...chars('`1234567890-='), ['Backspace', '⌫ delete', 2]],
  [['Tab', 'Tab ⇥', 1.5], ...chars('QWERTYUIOP[]'), ['\\', '\\', 1.5]],
  [[null, 'caps', 1.75], ...chars("ASDFGHJKL;'"), ['Enter', 'return ↵', 2.25]],
  [[null, '⇧ shift', 2.25, 'Shift'], ...chars('ZXCVBNM,./'), [null, '⇧ shift', 2.75, 'Shift']],
  IS_MAC ? MAC_MODS : PC_MODS,
];

/** Navigation block beside each main row (three keys wide). */
export const NAV_ROWS = [
  [],
  [[null, '', 1], ['Home', 'Home'], ['PageUp', 'Page Up']],
  [['Delete', IS_MAC ? 'Fwd Del' : 'Del'], ['End', 'End'], ['PageDown', 'Page Down']],
  [],
  [[null, '', 1], ['ArrowUp', '↑'], [null, '', 1]],
  [['ArrowLeft', '←'], ['ArrowDown', '↓'], ['ArrowRight', '→']],
];

/** The shortcut list as text: commands with keys, by category, then by name. */
export function shortcutListText(C, label, category = null) {
  const rows = [];
  for (const id of C.commands.keys()) {
    const keys = C.keysFor(id);
    if (keys.length) rows.push({ cat: category ? category(id) : '', text: `${label(id)}\t${keys.map(formatShortcut).join(', ')}` });
  }
  rows.sort((a, b) => a.cat.localeCompare(b.cat) || a.text.localeCompare(b.text));
  if (!category) return rows.map((r) => r.text).join('\n');
  const out = [];
  let cat = null;
  for (const r of rows) {
    if (r.cat !== cat) {
      if (cat !== null) out.push('');
      out.push(r.cat);
      cat = r.cat;
    }
    out.push(`  ${r.text}`);
  }
  return out.join('\n');
}

const snapshot = (C) => Object.fromEntries([...C.overrides].map(([id, keys]) => [id, keys.slice()]));
const sameMap = (a, b) => JSON.stringify(sortedEntries(a)) === JSON.stringify(sortedEntries(b));
const sortedEntries = (m) => Object.entries(m || {}).sort(([x], [y]) => x.localeCompare(y));

export function shortcutsDialog(app) {
  const C = app.commands;
  const prefs = app.prefs;
  const paths = commandMenuPaths();
  const label = (id) => contextLabel(id, C.label(id), paths);
  const opened = { overrides: snapshot(C), set: prefs.get('shortcutSet') || '' };
  const undoStack = [];
  let selectedId = null;
  let selectedKey = null;
  let capturing = null;
  const latched = new Set();
  const held = new Set();
  const layer = () => new Set([...latched, ...held]);
  const status = h('div.sc-status', { role: 'status' });
  const say = (text) => {
    status.textContent = text;
  };

  // Records the keymap before a change so Undo can return to it.
  const change = (fn) => {
    undoStack.push(snapshot(C));
    fn();
    refreshAll();
  };

  // ------------------------------------------------------------ presets
  const sets = () => ({ ...(prefs.get('shortcutSets') || {}) });
  const presetSel = h('select.select.sc-preset', { 'aria-label': 'Shortcut preset' });
  const saveBtn = h('button.icon-btn', { type: 'button', title: 'Save as Preset', 'aria-label': 'Save these shortcuts as a preset' }, icon('save', 15));
  const delBtn = h('button.icon-btn', { type: 'button', title: 'Delete Preset', 'aria-label': 'Delete this preset' }, icon('trash-2', 15));
  const currentSet = () => {
    const name = prefs.get('shortcutSet') || '';
    return sets()[name] ? name : '';
  };
  const modified = () => !sameMap(snapshot(C), currentSet() ? sets()[currentSet()] : {});
  function fillPresets() {
    const name = currentSet();
    const mod = modified();
    const suffix = (n) => (n === name && mod ? ' (modified)' : '');
    presetSel.replaceChildren(h('option', { value: '' }, `Default Set${name === '' && mod ? ' (modified)' : ' (read-only)'}`), ...Object.keys(sets()).sort((a, b) => a.localeCompare(b)).map((n) => h('option', { value: n }, n + suffix(n))));
    presetSel.value = name;
    delBtn.disabled = !name;
    saveBtn.disabled = !mod && !name;
  }
  presetSel.addEventListener('change', () => {
    const name = presetSel.value;
    change(() => {
      C.replaceOverrides(name ? sets()[name] : {});
      prefs.set('shortcutSet', name);
    });
    say(name ? `Using the "${name}" preset.` : 'Using the default shortcuts.');
  });
  saveBtn.addEventListener('click', async () => {
    const name = await promptDialog({
      title: 'Save Shortcut Preset',
      label: 'Name:',
      value: currentSet() || 'My Shortcuts',
      confirm: 'Save',
      validate: (v) => (!v.trim() ? 'Enter a name.' : /^default( set)?$/i.test(v.trim()) ? 'The default set cannot be replaced. Choose another name.' : ''),
    });
    if (!name) return;
    const n = name.trim();
    prefs.set('shortcutSets', { ...sets(), [n]: snapshot(C) });
    prefs.set('shortcutSet', n);
    fillPresets();
    say(`Saved the "${n}" preset.`);
  });
  delBtn.addEventListener('click', async () => {
    const name = currentSet();
    if (!name || !(await confirmDialog({ title: 'Delete Shortcut Preset', message: `Delete the "${name}" preset? The shortcuts in use now stay as they are.`, confirm: 'Delete', danger: true }))) return;
    const next = sets();
    delete next[name];
    prefs.set('shortcutSets', next);
    prefs.set('shortcutSet', '');
    fillPresets();
    say(`Deleted the "${name}" preset.`);
  });
  const copyBtn = h('button.btn', { type: 'button' }, icon('copy', 14), 'Copy to Clipboard');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shortcutListText(C, label, categoryOf));
      say('Every shortcut was copied to the clipboard as text.');
    } catch {
      say('The clipboard is not available here.');
    }
  });

  // ------------------------------------------------------------ keyboard map
  const panelAt = (combo) => {
    const n = normalizeShortcut(combo);
    return PANEL_KEYS.find((p) => normalizeShortcut(p.keys) === n) || null;
  };
  const shortName = (id) => String(C.label(id)).replace(/\.\.\.$/, '');
  const keyEls = [];
  const modEls = [];
  const capEl = (key, cap, w = 1, mod = null) => {
    const span = Math.round(w * 4);
    if (!key && !mod) return h('span.sc-gap', { style: { gridColumn: `span ${span}` }, 'aria-hidden': 'true' }, cap ? h('span.sc-key-name', cap) : null);
    if (mod) {
      const b = h('button.sc-key.sc-mod', { type: 'button', style: { gridColumn: `span ${span}` }, 'aria-pressed': 'false', title: `Show the shortcuts that use ${modsLabel(new Set([mod]))}` }, h('span.sc-key-cmd'), h('span.sc-key-name', cap));
      b.addEventListener('click', () => {
        if (latched.has(mod)) latched.delete(mod);
        else latched.add(mod);
        renderKeyboard();
      });
      modEls.push({ el: b, mod });
      return b;
    }
    const b = h('button.sc-key', { type: 'button', style: { gridColumn: `span ${span}` }, dataset: { key } }, h('span.sc-key-cmd'), h('span.sc-key-name', cap));
    b.addEventListener('click', () => selectKey(key, true));
    keyEls.push({ el: b, key });
    return b;
  };
  const board = h('div.sc-board', { role: 'group', 'aria-label': 'Keyboard map' });
  KEY_ROWS.forEach((row, r) => {
    for (const [key, cap, w, mod] of row) board.append(capEl(key, cap, w, mod));
    board.append(h('span.sc-gap', { style: { gridColumn: 'span 2' }, 'aria-hidden': 'true' }));
    const nav = NAV_ROWS[r];
    if (nav.length) for (const [key, cap, w] of nav) board.append(capEl(key, cap, w));
    else board.append(h('span.sc-gap', { style: { gridColumn: 'span 12' }, 'aria-hidden': 'true' }));
  });
  const layerNote = h('span.sc-layer');
  const swatch = (kind, text) => h('span.sc-legend-item', h(`span.sc-swatch.${kind}`, { 'aria-hidden': 'true' }), text);
  const legend = h(
    'div.sc-legend',
    swatch('k-app', 'Application shortcut'),
    swatch('k-panel', 'Editor shortcut (while the editor has focus)'),
    swatch('k-held', 'Modifier in use'),
    swatch('k-reserved', 'Kept by the browser'),
    h('span.spacer'),
    layerNote,
  );

  function renderKeyboard() {
    const mods = layer();
    layerNote.textContent = mods.size ? `Showing ${modsLabel(mods)} shortcuts` : 'Hold or click a modifier key to see its shortcuts';
    for (const { el, mod } of modEls) {
      el.classList.toggle('k-held', mods.has(mod));
      el.setAttribute('aria-pressed', String(latched.has(mod)));
    }
    const mine = new Set(selectedId ? C.keysFor(selectedId).map(normalizeShortcut) : []);
    for (const { el, key } of keyEls) {
      const combo = comboFor(key, mods);
      const id = C.commandFor(combo);
      const panel = panelAt(combo);
      const reserved = browserReserved(combo);
      const name = id ? shortName(id) : panel ? panel.label : '';
      el.classList.toggle('k-app', Boolean(id));
      el.classList.toggle('k-panel', !id && Boolean(panel));
      el.classList.toggle('k-reserved', reserved);
      el.classList.toggle('k-selected', selectedKey === key);
      el.classList.toggle('k-mine', mine.has(normalizeShortcut(combo)));
      el.querySelector('.sc-key-cmd').textContent = name;
      const what = id ? name : panel ? `${panel.label} (${panel.panel})` : 'not assigned';
      el.title = `${formatShortcut(combo)}: ${what}${reserved ? '. The browser keeps this key.' : ''}`;
      el.setAttribute('aria-label', `${formatShortcut(combo)}, ${what}`);
    }
  }

  // Holding a modifier shows its layer (not while typing or recording a shortcut).
  const MOD_KEYS = { Shift: 'Shift', Alt: 'Alt', Meta: IS_MAC ? 'Mod' : null, Control: IS_MAC ? 'Ctrl' : 'Mod' };
  const typingIn = (t) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  const onModKey = (e) => {
    const m = MOD_KEYS[e.key];
    if (!m || capturing) return;
    if (e.type === 'keydown' && typingIn(e.target)) return;
    if (e.type === 'keydown' ? held.has(m) : !held.has(m)) return;
    if (e.type === 'keydown') held.add(m);
    else held.delete(m);
    renderKeyboard();
  };
  const onBlur = () => {
    if (!held.size) return;
    held.clear();
    renderKeyboard();
  };
  window.addEventListener('keydown', onModKey, true);
  window.addEventListener('keyup', onModKey, true);
  window.addEventListener('blur', onBlur);

  // ------------------------------------------------------------ per-key list
  const keyTitle = h('h3.sc-pane-title', 'Key');
  const keyRows = h('div.sc-key-rows', { role: 'list' });
  function renderKeyList() {
    if (!selectedKey) {
      keyTitle.textContent = 'Key';
      keyRows.replaceChildren(h('p.sc-empty', 'Click a key on the keyboard to see everything it does.'));
      return;
    }
    keyTitle.textContent = `Key: ${formatShortcut(selectedKey)}`;
    keyRows.replaceChildren(
      ...MOD_COMBOS.map((list) => {
        const mods = new Set(list);
        const combo = comboFor(selectedKey, mods);
        const id = C.commandFor(combo);
        const panel = panelAt(combo);
        const reserved = browserReserved(combo);
        const text = id ? label(id) : panel ? `${panel.label} (${panel.panel})` : reserved ? 'Kept by the browser' : '';
        const row = h(
          `button.sc-key-row${id ? '.k-app' : panel ? '.k-panel' : ''}${id && id === selectedId ? '.k-selected' : ''}`,
          { type: 'button', role: 'listitem', disabled: !id, title: id ? 'Show this command in the list' : '' },
          h('span.sc-key-mods', modsLabel(mods)),
          h('span.sc-key-what', text || '—'),
        );
        if (id) row.addEventListener('click', () => selectCommand(id, { reveal: true }));
        return row;
      }),
    );
  }

  function selectKey(key, fromBoard = false) {
    selectedKey = key;
    const id = C.commandFor(comboFor(key, layer()));
    if (fromBoard && id) selectCommand(id, { reveal: true, keepKey: true });
    else {
      renderKeyboard();
      renderKeyList();
    }
  }

  // ------------------------------------------------------------ command tree
  const search = h('input.input.sc-search', { type: 'search', placeholder: 'Search commands or keys', 'aria-label': 'Search commands or keys', autocomplete: 'off' });
  const tree = h('div.sc-tree', { role: 'tree', 'aria-label': 'Commands' });
  const expanded = new Set();
  const byCategory = () => {
    const groups = new Map();
    for (const id of C.commands.keys()) {
      const cat = categoryOf(id);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(id);
    }
    for (const list of groups.values()) list.sort((a, b) => label(a).localeCompare(label(b)));
    return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
  };
  const matches = (id, q) => {
    if (!q) return true;
    const keys = C.keysFor(id);
    return label(id).toLowerCase().includes(q) || categoryOf(id).toLowerCase().includes(q) || keys.some((k) => formatShortcut(k).toLowerCase().includes(q) || k.toLowerCase().includes(q));
  };

  /** A button in the command's current row (after a rebuild), focused. */
  function freshChip(id, pick) {
    const row = tree.querySelector(`.sc-row[data-id="${CSS.escape(id)}"]`);
    const chip = row && pick(row);
    chip?.focus({ preventScroll: true });
    return chip || null;
  }

  function shortcutCell(id) {
    const cell = h('span.sc-keys');
    C.keysFor(id).forEach((k, i) => {
      const chip = h(`button.sc-chip${browserReserved(k) ? '.k-reserved' : ''}`, { type: 'button', title: browserReserved(k) ? 'The browser keeps this key, so it only works where the browser passes it on. Click to change it.' : 'Click, then press the new keys', 'aria-label': `Change shortcut ${formatShortcut(k)} of ${label(id)}` }, formatShortcut(k));
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        selectCommand(id);
        // Selecting rebuilds the tree: capture on this chip's replacement, which shows "Press keys…".
        capture(id, i, freshChip(id, (row) => row.querySelectorAll('.sc-chip:not(.sc-add)')[i]));
      });
      cell.append(chip);
    });
    const add = h('button.sc-chip.sc-add', { type: 'button', title: 'Add a shortcut', 'aria-label': `Add a shortcut to ${label(id)}` }, icon('plus', 12));
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      selectCommand(id);
      capture(id, C.keysFor(id).length, freshChip(id, (row) => row.querySelector('.sc-add')));
    });
    cell.append(add);
    return cell;
  }

  function renderTree() {
    const q = search.value.trim().toLowerCase();
    const frag = [];
    let total = 0;
    for (const [cat, ids] of byCategory()) {
      const shown = ids.filter((id) => matches(id, q));
      if (!shown.length) continue;
      total += shown.length;
      const open = Boolean(q) || expanded.has(cat);
      const head = h(
        'button.sc-cat',
        { type: 'button', role: 'treeitem', 'aria-expanded': String(open), dataset: { cat } },
        icon(open ? 'chevron-down' : 'chevron-right', 14),
        h('span.sc-cat-name', cat),
        h('span.sc-count', String(shown.length)),
      );
      head.addEventListener('click', () => {
        if (expanded.has(cat)) expanded.delete(cat);
        else expanded.add(cat);
        renderTree();
      });
      frag.push(head);
      if (!open) continue;
      for (const id of shown) {
        const custom = C.overrides.has(id);
        const row = h(
          `div.sc-row${id === selectedId ? '.k-selected' : ''}`,
          { role: 'treeitem', 'aria-selected': String(id === selectedId), tabindex: id === selectedId ? '0' : '-1', dataset: { id } },
          h('span.sc-name', label(id), custom ? h('span.sc-custom', { title: 'Changed from the default' }, '•') : null),
          shortcutCell(id),
        );
        row.addEventListener('click', () => selectCommand(id));
        row.addEventListener('keydown', (e) => {
          if (e.target !== row) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            capture(id, 0, row.querySelector('.sc-chip'));
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const rows = [...tree.querySelectorAll('.sc-row')];
            const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
            if (next) selectCommand(next.dataset.id, { focus: true });
          }
        });
        frag.push(row);
      }
    }
    tree.replaceChildren(...frag);
    if (!total) tree.append(h('p.sc-empty', 'No matching commands.'));
  }

  function selectCommand(id, { reveal = false, focus = false, keepKey = false } = {}) {
    selectedId = id;
    if (!keepKey) {
      const k = C.keysFor(id)[0];
      if (k) selectedKey = keyOf(k);
    }
    if (reveal) {
      const cat = categoryOf(id);
      if (!expanded.has(cat) && !search.value) expanded.add(cat);
      if (search.value && !matches(id, search.value.trim().toLowerCase())) search.value = '';
    }
    refreshAll();
    const row = tree.querySelector(`.sc-row[data-id="${id}"]`);
    // Scroll the tree only (scrollIntoView would also move the dialog body).
    if (row && (reveal || focus)) {
      const top = row.offsetTop;
      if (top < tree.scrollTop || top + row.offsetHeight > tree.scrollTop + tree.clientHeight) tree.scrollTop = top - (reveal ? tree.clientHeight / 2 : 0);
    }
    if (focus) row?.focus({ preventScroll: true });
    actions();
  }

  // Keeps keyboard focus on a command's row after the tree was rebuilt.
  const focusRow = (id) => tree.querySelector(`.sc-row[data-id="${id}"]`)?.focus({ preventScroll: true });

  // The keyboard key of a shortcut ("Mod+Shift+K" -> "K"), as the board names it.
  const boardKeys = new Map(keyEls.map(({ key }) => [normalizeShortcut(key), key]));
  const keyOf = (s) => boardKeys.get(normalizeShortcut(s).split(/\+(?!$)/).pop()) || null;

  // ------------------------------------------------------------ capture
  function capture(id, index, button) {
    capturing?.cancel();
    if (button) {
      button.textContent = 'Press keys…';
      button.classList.add('capturing');
    }
    say(`Press the new shortcut for "${label(id)}", or Escape to cancel.`);
    const onKey = (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      if (e.key === 'Escape' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        say('');
        refreshAll();
        return focusRow(id);
      }
      const combo = eventShortcut(e);
      // Tab and Shift+Tab move keyboard focus: bound to a command, they would trap it.
      if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        say(`${formatShortcut(combo)} can't be used: it moves keyboard focus.`);
        refreshAll();
        return focusRow(id);
      }
      if (browserReserved(combo)) {
        say(`${formatShortcut(combo)} can't be used: the browser keeps it for itself.`);
        refreshAll();
        return focusRow(id);
      }
      const other = C.commandFor(combo);
      const current = C.keysFor(id);
      const next = index < current.length ? current.map((k, i) => (i === index ? combo : k)) : [...current, combo];
      const keys = next.filter((k, i) => next.findIndex((x) => normalizeShortcut(x) === normalizeShortcut(k)) === i);
      change(() => C.setShortcuts(id, keys));
      selectedKey = keyOf(combo);
      const panel = panelAt(combo);
      say(
        other && other !== id
          ? `${formatShortcut(combo)} now runs "${label(id)}" instead of "${label(other)}".`
          : `${label(id)}: ${formatShortcut(combo)}${panel ? `. While the ${panel.panel.toLowerCase()} has focus this key still does "${panel.label}".` : ''}`,
      );
      announce(status.textContent);
      renderKeyboard();
      renderKeyList();
      focusRow(id);
    };
    const cleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      capturing = null;
    };
    window.addEventListener('keydown', onKey, true);
    capturing = {
      cancel: () => {
        cleanup();
        refreshAll();
      },
    };
  }

  // ------------------------------------------------------------ actions
  const undoBtn = h('button.btn', { type: 'button' }, icon('undo-2', 14), 'Undo');
  const clearBtn = h('button.btn', { type: 'button', title: 'Remove every shortcut of the selected command' }, 'Clear');
  const resetBtn = h('button.btn', { type: 'button', title: 'Give the selected command its default shortcuts again' }, 'Reset');
  undoBtn.addEventListener('click', () => {
    const prev = undoStack.pop();
    if (!prev) return;
    C.replaceOverrides(prev);
    refreshAll();
    say('Undid the last change.');
  });
  clearBtn.addEventListener('click', () => {
    if (!selectedId) return;
    change(() => C.setShortcuts(selectedId, []));
    say(`Removed the shortcuts of "${label(selectedId)}".`);
  });
  resetBtn.addEventListener('click', () => {
    if (!selectedId) return;
    change(() => C.resetShortcuts(selectedId));
    say(`"${label(selectedId)}" has its default shortcuts again.`);
  });
  function actions() {
    undoBtn.disabled = !undoStack.length;
    clearBtn.disabled = !selectedId || !C.keysFor(selectedId).length;
    resetBtn.disabled = !selectedId || !C.overrides.has(selectedId);
  }

  function refreshAll() {
    fillPresets();
    renderKeyboard();
    renderTree();
    renderKeyList();
    actions();
  }

  search.addEventListener('input', () => renderTree());
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      const first = tree.querySelector('.sc-row');
      if (first) {
        e.preventDefault();
        selectCommand(first.dataset.id, { focus: true });
      }
    }
  });

  const resetAll = h('button.btn', { type: 'button' }, 'Reset All');
  resetAll.addEventListener('click', () => {
    change(() => {
      C.resetShortcuts();
      prefs.set('shortcutSet', '');
    });
    say('Every shortcut is back to its default.');
  });

  refreshAll();

  const body = h(
    'div.sc',
    { 'data-own-enter': '' },
    h('div.sc-bar', h('label.sc-label', { for: 'sc-preset' }, 'Preset:'), presetSel, saveBtn, delBtn, h('span.sc-sep'), copyBtn, h('span.spacer'), status),
    h('div.sc-board-wrap', board),
    legend,
    h(
      'div.sc-split',
      h('section.sc-pane.sc-commands', { 'aria-label': 'Commands' }, h('div.sc-pane-head', search, h('span.sc-col', 'Shortcuts')), tree),
      h('section.sc-pane.sc-keypane', { 'aria-label': 'Key details' }, h('div.sc-pane-head', keyTitle), h('div.sc-key-head', h('span', 'Modifiers'), h('span', 'Command')), keyRows, h('div.sc-actions', undoBtn, clearBtn, resetBtn)),
    ),
  );
  presetSel.id = 'sc-preset';

  return openDialog({
    title: 'Keyboard Shortcuts',
    wide: true,
    className: 'shortcuts-dialog',
    initialFocus: '.sc-search',
    body,
    footerStart: h('div.sc-foot', resetAll, h('span.sc-hint', icon('info', 14), 'Click a shortcut, or +, then press the keys you want.')),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: true, primary: true },
    ],
  }).then((ok) => {
    capturing?.cancel();
    window.removeEventListener('keydown', onModKey, true);
    window.removeEventListener('keyup', onModKey, true);
    window.removeEventListener('blur', onBlur);
    if (!ok) {
      C.replaceOverrides(opened.overrides);
      prefs.set('shortcutSet', opened.set);
    }
    return ok;
  });
}
