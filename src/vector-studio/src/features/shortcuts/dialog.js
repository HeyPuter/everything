/**
 * Edit > Keyboard Shortcuts: view and change the shortcuts of tools and
 * menu commands, in named sets.
 *
 * Click a shortcut (or press Enter on it) and type the new key combination;
 * Escape cancels, the x button removes it. When the keys are already in use,
 * a bar names the other command and offers to go to it or undo the change;
 * the other command loses the keys. Changing the Default set starts a new
 * set named "Custom". Changes apply when the dialog is closed with OK.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { formatShortcut, IS_MAC } from '../../commands/registry.js';
import { MENUS } from '../../ui/menus.js';
import { readSets, writeSets, DEFAULT_SET, effective, conflictsFor, shortcutFromEvent, applyChanges, reservedKey } from './sets.js';

/** Menu path for every command id in the menu bar ("Object > Path"). */
function menuPaths() {
  const out = new Map();
  const walk = (items, path) => {
    for (const it of items) {
      if (typeof it === 'string') {
        if (it !== '-' && !out.has(it)) out.set(it, path);
      } else if (it?.submenu) walk(it.submenu, `${path} > ${it.label}`);
      else if (it?.id && !out.has(it.id)) out.set(it.id, path);
    }
  };
  for (const m of MENUS) walk(m.submenu, m.label);
  return out;
}

/** Rows for the list: [{ kind, id, label, group }] sorted by menu order or label. */
function rowsFor(app, kind) {
  if (kind === 'tools') {
    return [...app.toolClasses.entries()].map(([id, T]) => ({ kind, id, label: T.label, group: 'Tools' }));
  }
  const paths = menuPaths();
  const order = [...paths.keys()];
  const rows = [];
  for (const [id] of app.commands.commands) {
    const label = app.commands.label(id);
    if (!label) continue;
    rows.push({ kind, id, label: String(label).replace(/\.\.\.$/, '…'), group: paths.get(id) || 'Other Commands' });
  }
  const rank = (r) => {
    const i = order.indexOf(r.id);
    return i < 0 ? 1e9 : i;
  };
  return rows.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

function labelOf(app, kind, id) {
  return kind === 'tools' ? app.toolClasses.get(id)?.label || id : String(app.commands.label(id) || id);
}

export function keyboardShortcutsDialog(app) {
  const stored = readSets(app.prefs);
  const sets = JSON.parse(JSON.stringify(stored.sets));
  let active = stored.active;
  let changes = active === DEFAULT_SET ? { commands: {}, tools: {} } : { commands: { ...(sets[active]?.commands || {}) }, tools: { ...(sets[active]?.tools || {}) } };
  let kind = 'tools';
  let capturing = null; // row being edited
  let lastEdit = null; // { kind, id, before, taken: [{ kind, id, before }] } for Undo

  const setSelect = h('select.ks-set', { 'aria-label': 'Shortcut set' });
  const fillSets = () => {
    setSelect.replaceChildren(...[DEFAULT_SET, ...Object.keys(sets).sort()].map((n) => h('option', { value: n, selected: n === active }, n)));
    deleteBtn.disabled = active === DEFAULT_SET;
  };
  const saveBtn = h('button.btn.small', { type: 'button', onclick: () => saveAs() }, 'Save As…');
  const deleteBtn = h('button.btn.small', { type: 'button', onclick: () => deleteSet() }, 'Delete Set');
  const tabTools = h('button.ks-tab', { type: 'button', role: 'tab', 'aria-selected': 'true', onclick: () => switchKind('tools') }, 'Tools');
  const tabCmds = h('button.ks-tab', { type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => switchKind('commands') }, 'Menu Commands');
  const search = h('input.ks-search', { type: 'search', placeholder: 'Search commands or keys', 'aria-label': 'Search shortcuts', oninput: () => render() });
  const list = h('div.ks-list', { role: 'table', 'aria-label': 'Shortcuts' });
  const status = h('div.ks-status', { role: 'status', 'aria-live': 'polite' });

  const switchKind = (k) => {
    kind = k;
    tabTools.setAttribute('aria-selected', String(k === 'tools'));
    tabCmds.setAttribute('aria-selected', String(k === 'commands'));
    capturing = null;
    render();
  };

  /** Changing the Default set starts a "Custom" set. */
  const ensureEditableSet = () => {
    if (active !== DEFAULT_SET) return;
    let name = 'Custom';
    for (let i = 2; sets[name]; i++) name = `Custom ${i}`;
    sets[name] = { commands: {}, tools: {} };
    active = name;
    fillSets();
    status.replaceChildren(`Started a new set, “${name}”, for your changes.`);
  };

  const setShortcut = (row, value) => {
    ensureEditableSet();
    const before = effective(app, row.kind, row.id, changes);
    const taken = conflictsFor(app, value, changes, row).map((c) => ({ ...c, before: effective(app, c.kind, c.id, changes) }));
    changes[row.kind][row.id] = value;
    for (const c of taken) changes[c.kind][c.id] = '';
    lastEdit = { kind: row.kind, id: row.id, before, taken };
    if (taken.length) {
      const names = taken.map((c) => `${labelOf(app, c.kind, c.id)}${c.kind === 'tools' ? ' (tool)' : ''}`).join(', ');
      status.replaceChildren(
        h('span', `${formatShortcut(value)} was used by ${names}; it no longer has a shortcut.`),
        h('button.btn.small', { type: 'button', onclick: () => goTo(taken[0]) }, 'Go to Conflict'),
        h('button.btn.small', { type: 'button', onclick: () => undoLast() }, 'Undo'),
      );
    } else if (value) status.replaceChildren(`${labelOf(app, row.kind, row.id)}: ${formatShortcut(value)}`);
    else status.replaceChildren(`${labelOf(app, row.kind, row.id)} has no shortcut now.`);
    render();
  };

  const undoLast = () => {
    const e = lastEdit;
    if (!e) return;
    changes[e.kind][e.id] = e.before;
    for (const c of e.taken) changes[c.kind][c.id] = c.before;
    lastEdit = null;
    status.replaceChildren('Change undone.');
    render();
  };

  const goTo = (c) => {
    if (c.kind !== kind) switchKind(c.kind);
    search.value = '';
    render();
    list.querySelector(`[data-key="${c.kind}:${CSS.escape(c.id)}"] .ks-key`)?.focus();
  };

  const startCapture = (row, btn) => {
    capturing = row;
    btn.textContent = 'Type keys…';
    btn.classList.add('capturing');
    btn.setAttribute('aria-label', `New shortcut for ${row.label}. Type the keys, or Escape to cancel.`);
  };

  const onKey = (row, btn, e) => {
    if (capturing !== row) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        startCapture(row, btn);
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      capturing = null;
      render();
      list.querySelector(`[data-key="${row.kind}:${CSS.escape(row.id)}"] .ks-key`)?.focus();
      return;
    }
    const sc = shortcutFromEvent(e, IS_MAC);
    if (!sc) return;
    if (row.kind === 'tools' && /(^|\+)(Mod|Ctrl)\+/.test(sc)) {
      status.replaceChildren(`Tool shortcuts can't use ${IS_MAC ? '⌘ or ⌃' : 'Ctrl'}. Use a key, optionally with Shift or ${IS_MAC ? '⌥' : 'Alt'}.`);
      return;
    }
    const reserved = reservedKey(sc);
    if (reserved) {
      status.replaceChildren(`${formatShortcut(sc)} is kept for ${reserved}. Type other keys, or Escape to cancel.`);
      return;
    }
    capturing = null;
    setShortcut(row, sc);
    list.querySelector(`[data-key="${row.kind}:${CSS.escape(row.id)}"] .ks-key`)?.focus();
  };

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const rows = rowsFor(app, kind).filter((r) => {
      if (!q) return true;
      const s = effective(app, r.kind, r.id, changes);
      return r.label.toLowerCase().includes(q) || r.group.toLowerCase().includes(q) || (s && (formatShortcut(s).toLowerCase().includes(q) || s.toLowerCase().includes(q)));
    });
    const out = [];
    let group = null;
    for (const r of rows) {
      if (r.group !== group && kind === 'commands') {
        group = r.group;
        out.push(h('div.ks-group', { role: 'row' }, h('span', { role: 'rowheader' }, group)));
      }
      const sc = effective(app, r.kind, r.id, changes);
      const changed = r.id in changes[r.kind];
      const keyBtn = h(
        'button.ks-key',
        {
          type: 'button',
          'aria-label': `${r.label} shortcut: ${sc ? formatShortcut(sc) : 'none'}. Press Enter to change.`,
          onclick: (e) => startCapture(r, e.currentTarget),
        },
        sc ? formatShortcut(sc) : '—',
      );
      keyBtn.addEventListener('keydown', (e) => onKey(r, keyBtn, e));
      keyBtn.addEventListener('blur', () => {
        if (capturing === r) {
          capturing = null;
          render();
        }
      });
      out.push(
        h(
          `div.ks-row${changed ? '.changed' : ''}`,
          { role: 'row', dataset: { key: `${r.kind}:${r.id}` } },
          h('span.ks-label', { role: 'cell' }, r.label),
          h('span.ks-cell', { role: 'cell' }, keyBtn, sc ? h('button.icon-btn.ks-clear', { type: 'button', 'aria-label': `Remove the shortcut of ${r.label}`, 'data-tip': 'Remove shortcut', onclick: () => setShortcut(r, '') }, icon('x', 12)) : h('span.ks-clear-space', { 'aria-hidden': 'true' })),
        ),
      );
    }
    if (!rows.length) out.push(h('p.ks-empty', 'No matching commands.'));
    list.replaceChildren(...out);
  };

  const saveAs = async () => {
    const v = await app.dialogs.form({ title: 'Save Shortcut Set', fields: [{ key: 'name', label: 'Name', type: 'text', value: active === DEFAULT_SET ? 'My Shortcuts' : `${active} copy` }] });
    const name = v?.name?.trim();
    if (!name) return;
    if (name === DEFAULT_SET) {
      status.replaceChildren('“Default” is the built-in set; choose another name.');
      return;
    }
    sets[name] = { commands: { ...changes.commands }, tools: { ...changes.tools } };
    active = name;
    fillSets();
    status.replaceChildren(`Saved “${name}”.`);
  };

  const deleteSet = () => {
    if (active === DEFAULT_SET) return;
    delete sets[active];
    active = DEFAULT_SET;
    changes = { commands: {}, tools: {} };
    fillSets();
    render();
    status.replaceChildren('Set deleted; Default is active.');
  };

  setSelect.addEventListener('change', () => {
    // Keep unsaved edits of the set being left.
    if (active !== DEFAULT_SET) sets[active] = { commands: { ...changes.commands }, tools: { ...changes.tools } };
    active = setSelect.value;
    changes = active === DEFAULT_SET ? { commands: {}, tools: {} } : { commands: { ...(sets[active]?.commands || {}) }, tools: { ...(sets[active]?.tools || {}) } };
    deleteBtn.disabled = active === DEFAULT_SET;
    lastEdit = null;
    status.replaceChildren('');
    render();
  });

  const exportText = () => {
    const lines = [`Vector Studio keyboard shortcuts: ${active}`, ''];
    for (const k of ['tools', 'commands']) {
      lines.push(k === 'tools' ? 'TOOLS' : 'MENU COMMANDS');
      let group = null;
      for (const r of rowsFor(app, k)) {
        if (k === 'commands' && r.group !== group) {
          group = r.group;
          lines.push('', `  ${group}`);
        }
        const sc = effective(app, r.kind, r.id, changes);
        lines.push(`    ${r.label.padEnd(44)} ${sc ? formatShortcut(sc) : ''}`);
      }
      lines.push('');
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    const a = h('a', { href: url, download: `${active} shortcuts.txt` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  fillSets();
  render();
  const body = h(
    'div.ks',
    h('div.ks-top', h('label.ks-set-label', 'Set', setSelect), saveBtn, deleteBtn),
    h('div.ks-tabs', { role: 'tablist', 'aria-label': 'Shortcut kind' }, tabTools, tabCmds),
    search,
    list,
    status,
  );
  return openDialog({
    title: 'Keyboard Shortcuts',
    className: 'wide keyboard-shortcuts',
    body,
    initialFocus: () => search,
    buttons: [
      { label: 'Export Text…', value: undefined, left: true, validate: () => (exportText(), false) },
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, value: () => true },
    ],
  }).then((ok) => {
    if (!ok) return false;
    if (active !== DEFAULT_SET) sets[active] = { commands: { ...changes.commands }, tools: { ...changes.tools } };
    writeSets(app.prefs, { active, sets });
    applyChanges(app, active === DEFAULT_SET ? { commands: {}, tools: {} } : changes);
    return true;
  });
}
