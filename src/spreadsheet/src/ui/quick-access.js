/**
 * The Quick Access Toolbar: the AutoSave switch, then the commands the person keeps there (Save, Undo and Redo
 * to begin with), then the arrow that customizes it. It sits in the title row, or in a row of its own under the
 * ribbon, with or without the commands' names (lib/customize.js keeps the choice for the person).
 *
 * Save, Undo and Redo are the editor's own buttons (Undo's history arrow included); any other command is a
 * button made here from the command catalog, greyed and pressed as the menus have it.
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { menubarMenus, menuLeaves } from './menubar.js';
import { commandCatalog } from './command-catalog.js';
import { effectiveShortcut } from './custom-shortcuts.js';
import { quickAccessStore, commandId, parseCommandId, addToQuickAccess, removeFromQuickAccess } from '../lib/customize.js';

/** Commands that open a menu of their own beside the button that ran them. */
const MENU_COMMANDS = new Set(['functionMenu', 'cellStylesMenu', 'shapesMenu', 'formatAsTableMenu', 'themesMenu', 'themeColorsMenu', 'themeFontsMenu', 'themeEffectsMenu', 'wordArtMenu', 'pasteSpecialMenu']);

/** The commands offered with a tick in the customize menu, for adding or removing at once. */
const COMMON = [
  ['new', 'New Spreadsheet'], ['open', 'Open'], ['save', 'Save'], ['print', 'Print'], ['spelling', 'Spelling'],
  ['undo', 'Undo'], ['redo', 'Redo'], [commandId('sort', 'asc'), 'Sort Ascending'], [commandId('sort', 'desc'), 'Sort Descending'],
  ['find', 'Find'], ['insertChart', 'Insert Chart'], ['filter', 'Filter'],
];

/**
 * `root` is the toolbar element (already holding the AutoSave switch, Save, and the Undo and Redo the ribbon put
 * there); `place(below)` moves it above or below the ribbon. Returns { el, refresh, render, destroy }.
 */
export function createQuickAccess(ctx, { root, place = () => {} }) {
  const fixed = new Map(); // id → the editor's own elements for it
  const autoSave = root.querySelector('.autosave-switch');
  for (const node of root.children) {
    const id = node.dataset.qat || (node.getAttribute('aria-label') === 'Save' ? 'save' : null);
    if (!id) continue;
    if (!fixed.has(id)) fixed.set(id, []);
    fixed.get(id).push(node);
  }
  const customize = el('button.icon-btn.qat-btn.qat-customize', {
    type: 'button', html: icon('chevD', 12, 2), 'aria-label': 'Customize Quick Access Toolbar', title: 'Customize Quick Access Toolbar', 'aria-haspopup': 'menu',
    onclick: () => openCustomizeMenu(customize),
  });
  const made = new Map(); // id → button made here
  let catalog = null;
  const entry = (id) => {
    catalog ??= commandCatalog(ctx.flags?.() || {}, ctx.ribbon?.el || null);
    return catalog.find((e) => e.id === id) || null;
  };

  function button(id) {
    const { cmd, arg } = parseCommandId(id);
    const e = entry(id);
    const label = e?.label || cmd;
    const b = el('button.icon-btn.qat-btn.qat-command', {
      type: 'button', 'aria-label': label, dataset: { qatCommand: id },
      onclick: () => ctx.run(cmd, MENU_COMMANDS.has(cmd) ? b : arg),
      oncontextmenu: (ev) => { ev.preventDefault(); openItemMenu(b, id); },
    }, el('span.qat-icon', { 'aria-hidden': 'true', html: e?.icon ? icon(e.icon, 18) : '' }, e?.icon ? null : label.charAt(0).toUpperCase()), el('span.qat-label', {}, label));
    b._command = { cmd, arg, label, glyph: e?.icon || null };
    b.addEventListener('pointerenter', () => { const keys = effectiveShortcut({ cmd, arg, shortcut: e?.shortcut }); b.title = keys ? `${label} (${keys})` : label; });
    return b;
  }

  function render() {
    catalog = null;
    const qat = quickAccessStore.get();
    const kids = [autoSave].filter(Boolean);
    for (const id of qat.items) {
      if (fixed.has(id)) { kids.push(...fixed.get(id)); continue; }
      if (!made.has(id)) made.set(id, button(id));
      kids.push(made.get(id));
    }
    for (const id of [...made.keys()]) if (!qat.items.includes(id)) made.delete(id);
    kids.push(customize);
    root.replaceChildren(...kids);
    root.classList.toggle('qat-labels', qat.labels);
    root.classList.toggle('qat-below', qat.below);
    place(qat.below);
    refresh();
  }

  /** Grey and press the commands as the menus would. */
  function refresh() {
    if (!made.size) return;
    const f = ctx.flags?.() || {};
    const items = new Map(menubarMenus(f).flatMap((m) => menuLeaves(m.items)).filter((i) => i.cmd).map((i) => [commandId(i.cmd, i.arg ?? null), i]));
    for (const [id, b] of made) {
      const item = items.get(id);
      b.disabled = item ? !!item.disabled : !!f.editing;
      if (item?.checked !== undefined) b.setAttribute('aria-pressed', String(!!item.checked)); else b.removeAttribute('aria-pressed');
    }
  }

  function openItemMenu(anchor, id) {
    const qat = quickAccessStore.get();
    openMenu({
      anchor, label: 'Quick Access Toolbar', minWidth: 240,
      items: [
        { label: 'Remove from Quick Access Toolbar', icon: 'x', onSelect: () => removeFromQuickAccess(id) },
        { separator: true },
        ...placementItems(qat),
      ],
      onClose: (reason) => { if (reason === 'select') ctx.grid?.focus?.(); },
    });
  }

  function placementItems(qat) {
    return [
      { label: 'Customize Quick Access Toolbar…', icon: 'customizeQuickAccess', onSelect: () => ctx.run('options', 'quickAccess') },
      { label: qat.below ? 'Show Above the Ribbon' : 'Show Below the Ribbon', onSelect: () => quickAccessStore.set({ ...qat, below: !qat.below }) },
      { label: 'Show Command Labels', checked: qat.labels, onSelect: () => quickAccessStore.set({ ...qat, labels: !qat.labels }) },
    ];
  }

  function openCustomizeMenu(anchor) {
    const qat = quickAccessStore.get();
    const canOpen = !!ctx.flags?.()?.pick;
    openMenu({
      anchor, label: 'Customize Quick Access Toolbar', minWidth: 250,
      items: [
        { header: 'Customize Quick Access Toolbar' },
        ...COMMON.filter(([id]) => id !== 'open' || canOpen).map(([id, label]) => ({
          label, checked: qat.items.includes(id),
          onSelect: () => (qat.items.includes(id) ? removeFromQuickAccess(id) : addToQuickAccess(id)),
        })),
        { separator: true },
        { label: 'More Commands…', onSelect: () => ctx.run('options', 'quickAccess') },
        ...placementItems(qat).slice(1),
      ],
      onClose: (reason) => { if (reason === 'select') ctx.grid?.focus?.(); },
    });
  }

  const unsubscribe = quickAccessStore.subscribe(render);
  render();
  return { el: root, render, refresh, destroy() { unsubscribe(); } };
}

/** The menu a right-click on a ribbon button opens: put its command on the Quick Access Toolbar, or take it off. */
export function ribbonButtonMenuItems(ctx, command, { collapsed = false, toggleCollapsed = null } = {}) {
  const id = command ? commandId(command.cmd, command.arg ?? null) : null;
  const on = id && quickAccessStore.get().items.includes(id);
  return [
    id && (on
      ? { label: 'Remove from Quick Access Toolbar', icon: 'x', onSelect: () => removeFromQuickAccess(id) }
      : { label: 'Add to Quick Access Toolbar', icon: 'customizeQuickAccess', onSelect: () => addToQuickAccess(id) }),
    id && { separator: true },
    { label: 'Customize Quick Access Toolbar…', onSelect: () => ctx.run('options', 'quickAccess') },
    { label: 'Customize the Ribbon…', icon: 'customizeRibbon', onSelect: () => ctx.run('options', 'ribbon') },
    toggleCollapsed && { label: collapsed ? 'Expand the Ribbon' : 'Collapse the Ribbon', onSelect: toggleCollapsed },
  ].filter(Boolean);
}
