/**
 * Sheet tabs along the bottom: click to switch, double-click (or the menu)
 * to rename, drag a tab to reorder it (Ctrl or Option copies it),
 * the menu's move actions, and an add button. Shift-click groups the sheets
 * from the active one to the one clicked, Ctrl-click (⌘-click on a Mac) adds
 * or removes one sheet: grouped sheets take the same edits (see core/sheet-group.js).
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { customColorRows } from './colorpicker.js';
import { confirmDialog, promptDialog } from './modal.js';
import { openMoveSheetDialog } from './movesheet.js';
import { placeSheet } from '../core/sheet-placement.js';

const TAB_COLORS = ['#c22a2a', '#eb6834', '#eda100', '#1baf7a', '#0a63f0', '#4a3aa7', '#e87ba4', '#6b6964'];

/** How far the options button's left edge sits in from the active chip's right edge: its 24px plus the 4px chip padding beyond it. */
const MENU_BTN_INSET = 28;

/** Charts, images, text boxes, notes, and tables are work too, not only cells: a sheet holding any is asked about before it goes. */
export const sheetHoldsWork = (sheet) => sheet.cells.size > 0 || sheet.charts.length > 0 || sheet.notes.size > 0 || sheet.comments?.size > 0 || sheet.tables.length > 0;

export function createSheetTabs(ctx, { excelLayout = false } = {}) {
  const strip = el('div.tab-strip', { role: 'tablist', 'aria-label': 'Sheets' });
  // A tablist may own nothing but tabs, so the active sheet's options button is the tablist's
  // neighbour: next in reading order, and laid over the end of the active tab's chip on screen.
  const menuBtn = el('button.tab-menu-btn', {
    type: 'button', html: icon('chevD', 14, 2.2), 'aria-haspopup': 'menu',
    onclick: (e) => { e.stopPropagation(); const s = ctx.wb.sheet(ctx.wb.activeSheetId); if (s) tabMenu(s, e.currentTarget); },
  });
  const list = el('div.tab-list', {}, strip, menuBtn);
  // The strip hides its scrollbar, so with a mouse there is nothing to drag: a plain wheel over it, which
  // would scroll nothing, moves the tabs sideways when they overflow (a sideways wheel or a trackpad swipe
  // scrolls it as it is, and Ctrl+wheel stays the zoom gesture).
  list.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey || !e.deltaY || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    if (list.scrollWidth <= list.clientWidth) return;
    e.preventDefault();
    list.scrollLeft += e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * list.clientWidth : e.deltaY;
  }, { passive: false });
  // Structural actions go through the editor's commands, which commit an open cell edit first
  // so the edit is not lost by the undo of the sheet change; without an editor the workbook is called directly.
  const act = (cmd, arg, direct) => (ctx.run ? ctx.run(cmd, arg) : direct());
  const addBtn = el('button.icon-btn.tab-add', {
    type: 'button', html: icon('plus', 18, 2), 'aria-label': 'Add sheet', title: 'Add sheet',
    onclick: () => act('newSheet', null, () => ctx.wb.addSheet()),
  });
  const openAllSheets = (anchor) => {
      const hidden = ctx.wb.sheets.filter((s) => s.hidden);
      openMenu({
        anchor, label: 'Sheets', focusChecked: true,
        search: ctx.wb.sheets.length >= 8 ? 'Search sheets' : null,
        minWidth: ctx.wb.sheets.length >= 8 ? 280 : null,
        items: [
          // The active sheet is one choice of several: a radio item, not a checkbox.
          ...ctx.wb.visibleSheets.map((s) => ({ label: s.name, checked: s.id === ctx.wb.activeSheetId, radio: true, onSelect: () => ctx.wb.setActiveSheet(s.id) })),
          hidden.length && { separator: true },
          hidden.length && { header: 'Hidden' },
          ...hidden.map((s) => ({ label: s.name, icon: 'eyeOff', onSelect: () => act('showSheet', s.id, () => ctx.wb.setSheetHidden(s.id, false)) })),
        ],
      });
  };
  const allBtn = el('button.icon-btn.tab-all', {
    type: 'button', html: icon('layers', 18), 'aria-label': 'All sheets', title: 'All sheets',
    onclick: (e) => openAllSheets(e.currentTarget),
  });
  // Ctrl/Cmd+click goes to the first or last tab.
  const scrollTabs = (direction, toEnd = false) => {
    const button = direction < 0 ? scrollLeft : scrollRight;
    if (button.getAttribute('aria-disabled') === 'true') return;
    // Overlap each page a little so the next group of names keeps its context.
    if (toEnd) list.scrollLeft = direction < 0 ? 0 : list.scrollWidth;
    else list.scrollLeft += direction * Math.max(80, list.clientWidth * 0.8);
    updateOverflow();
  };
  const scrollLeft = el('button.icon-btn.tab-scroll-btn', {
    type: 'button', html: icon('chevL', 16, 2), 'aria-label': 'Scroll sheets left', title: 'Scroll sheets left (Ctrl+click: first sheet; right-click: all sheets)',
    onclick: (e) => scrollTabs(-1, e.ctrlKey || e.metaKey),
  });
  const scrollRight = el('button.icon-btn.tab-scroll-btn', {
    type: 'button', html: icon('chevR', 16, 2), 'aria-label': 'Scroll sheets right', title: 'Scroll sheets right (Ctrl+click: last sheet; right-click: all sheets)',
    onclick: (e) => scrollTabs(1, e.ctrlKey || e.metaKey),
  });
  const navigation = el('div.tab-navigation', { hidden: true, role: 'group', 'aria-label': 'Scroll sheets' }, scrollLeft, scrollRight);
  navigation.addEventListener('pointerdown', (e) => { if (e.button === 0) e.preventDefault(); });
  // Right-clicking the scroll arrows lists every sheet to go to.
  navigation.addEventListener('contextmenu', (e) => { e.preventDefault(); openAllSheets(e.target.closest('button') || navigation); });
  const root = el('div.sheet-tabs', {}, ...(excelLayout ? [navigation, allBtn, list, addBtn] : [addBtn, allBtn, list, navigation]));
  root.classList.toggle('excel-layout', excelLayout);

  function updateOverflow() {
    // Compare against the space available WITHOUT the controls, so their own width cannot keep
    // them visible after a resize makes all the tabs fit. Observe both the strip and its viewport.
    const style = getComputedStyle(list);
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const gap = parseFloat(getComputedStyle(root).columnGap) || 0;
    // This layout always shows the scroll arrows (disabled when every tab fits), so they take no room from the tabs' share.
    const available = list.clientWidth + (navigation.hidden || excelLayout ? 0 : navigation.offsetWidth + gap);
    const overflow = strip.scrollWidth + padding > available + 1;
    const appearing = overflow && (navigation.hidden || excelLayout && !root.classList.contains('overflowing'));
    if (!overflow && !excelLayout && navigation.contains(document.activeElement)) allBtn.focus({ preventScroll: true });
    navigation.hidden = !overflow && !excelLayout;
    root.classList.toggle('overflowing', overflow);
    if (appearing) strip.querySelector('.tab-item.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // aria-disabled keeps keyboard focus on a control when it reaches the end of the strip.
    scrollLeft.setAttribute('aria-disabled', String(list.scrollLeft <= (parseFloat(style.paddingLeft) || 0) + 1));
    scrollRight.setAttribute('aria-disabled', String(list.scrollLeft >= list.scrollWidth - list.clientWidth - (parseFloat(style.paddingRight) || 0) - 1));
  }
  list.addEventListener('scroll', updateOverflow, { passive: true });

  async function rename(sheet) {
    const name = await promptDialog({
      title: 'Rename sheet', label: 'Sheet name', value: sheet.name, confirmLabel: 'Rename', trim: false,
      validate: (v) => ctx.wb.validateSheetName(v, sheet.id),
    });
    if (name != null) ctx.wb.renameSheet(sheet.id, name);
  }

  const holdsWork = sheetHoldsWork;
  // With an editor, its Rename sheet command asks (committing an open edit first); alone, the tabs ask.
  const renameVia = (sheet) => act('renameSheet', sheet.id, () => rename(sheet));

  /** The question before a sheet holding work goes; the editor's Delete sheet command asks it too. */
  const confirmDelete = (sheet) => confirmDialog({ title: `Delete "${sheet.name}"?`, message: 'The sheet and everything on it will be removed. You can undo this.', confirmLabel: 'Delete sheet' });

  // Without an editor the tabs ask and delete; with one, its command does both, committing an open edit first.
  async function remove(sheet) {
    if (ctx.wb.visibleSheets.length <= 1) return;
    if (holdsWork(sheet) && !await confirmDelete(sheet)) return;
    ctx.wb.deleteSheet(sheet.id);
  }

  // When a key last opened a tab's menu: the contextmenu event some browsers synthesise for the same key
  // is the same request, not a second one (which, on the same anchor, would close the menu just opened).
  let keyMenuAt = 0;

  function tabMenu(sheet, anchor, x = null, y = null) {
    // Neighbours among the tabs on show: swapping with a hidden sheet would not move the tab visibly.
    const visible = ctx.wb.visibleSheets;
    const before = visible[visible.indexOf(sheet) - 1];
    const after = visible[visible.indexOf(sheet) + 1];
    openMenu({
      anchor, x, y, label: `${sheet.name} options`,
      items: [
        // The tab menu, in order: Insert, Delete, Rename, Move or Copy…, Protect, Tab Color, Hide, Unhide; the app's
        // own tab tools follow. The ellipsis marks the items that open a dialog first.
        { label: 'Insert Sheet', icon: 'insertSheet', onSelect: () => act('newSheet', null, () => ctx.wb.addSheet()) },
        { label: holdsWork(sheet) ? 'Delete…' : 'Delete', icon: 'deleteSheet', danger: true, disabled: ctx.wb.visibleSheets.length <= 1, onSelect: () => act('deleteSheet', sheet.id, () => remove(sheet)) },
        { label: 'Rename…', icon: 'pencil', onSelect: () => renameVia(sheet) },
        { label: 'Move or Copy…', icon: 'layers', onSelect: () => act('moveOrCopySheet', sheet.id, () => openMoveSheetDialog(ctx, sheet.id)) },
        sheet.protected
          ? { label: 'Unprotect Sheet', icon: 'unprotect', onSelect: () => ctx.wb.setSheetProtected(sheet.id, false) }
          : { label: 'Protect Sheet', icon: 'protectSheet', onSelect: () => ctx.wb.setSheetProtected(sheet.id, true) },
        { label: 'Tab Color', icon: 'fill', onSelect: () => colorMenu(sheet, anchor, x, y) },
        { label: 'Hide', icon: 'hideEye', disabled: ctx.wb.visibleSheets.length <= 1, onSelect: () => act('hideSheet', sheet.id, () => ctx.wb.setSheetHidden(sheet.id, true)) },
        // Unhide lists the hidden sheets.
        { label: 'Unhide', icon: 'showHide', disabled: !hiddenSheets().length, submenu: hiddenSheets().map((h) => ({ label: h.name, icon: 'showHide', onSelect: () => act('showSheet', h.id, () => ctx.wb.setSheetHidden(h.id, false)) })) },
        { separator: true },
        { label: 'Duplicate', icon: 'duplicate', onSelect: () => act('duplicateSheet', sheet.id, () => ctx.wb.duplicateSheet(sheet.id)) },
        ctx.run && { label: 'Copy to another spreadsheet…', icon: 'copy', onSelect: () => ctx.run('copySheetTo', sheet.id) },
        { label: 'Move left', icon: 'chevL', disabled: !before, onSelect: () => ctx.wb.moveSheet(sheet.id, ctx.wb.sheets.indexOf(before)) },
        { label: 'Move right', icon: 'chevR', disabled: !after, onSelect: () => ctx.wb.moveSheet(sheet.id, ctx.wb.sheets.indexOf(after)) },
        { separator: true },
        // Grouping: every sheet on show at once, or back to the one in view.
        { label: 'Select All Sheets', icon: 'layers', disabled: visible.length <= 1, onSelect: () => act('selectAllSheets', null, () => ctx.wb.groupSheets(visible.map((v) => v.id))) },
        ctx.wb.sheetGroup && { label: 'Ungroup Sheets', icon: 'layers', onSelect: () => act('ungroupSheets', null, () => ctx.wb.ungroupSheets()) },
      ].filter(Boolean),
    });
  }

  // Sheets a user hid (not the very hidden ones a file can carry, which stay out of every list).
  const hiddenSheets = () => ctx.wb.sheets.filter((h) => h.hidden && !h.veryHidden);

  function colorMenu(sheet, anchor, x, y) {
    // Compared with the swatches in their lower case: a colour from a file may be spelt in upper case.
    const current = sheet.color ? String(sheet.color).toLowerCase() : null;
    const swatches = el('div.swatches', { role: 'group', 'aria-label': 'Tab colors', 'data-cols': 6 },
      el('button.swatch.none', { type: 'button', role: 'menuitemradio', 'aria-checked': String(!current), 'aria-label': 'No color', title: 'No color', onclick: () => { menu.close(); ctx.wb.setSheetColor(sheet.id, null); } }),
      ...TAB_COLORS.map((hex) => el('button.swatch', {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(current === hex), 'aria-label': hex, title: hex, style: { background: hex },
        onclick: () => { menu.close(); ctx.wb.setSheetColor(sheet.id, hex); },
      })));
    const extra = customColorRows({ current, label: 'tab color', onPick: (hex) => { menu.close(); ctx.wb.setSheetColor(sheet.id, hex); } });
    const menu = openMenu({ anchor, x, y, label: 'Tab color', items: [{ custom: swatches }, ...extra.map((custom) => ({ custom }))] });
    swatches.querySelector('[aria-checked="true"]')?.focus();
  }

  /** Lay the options button over the end of the active chip. Offsets are 0 until the strip has a layout; the observer places it then. */
  function placeMenuButton() {
    const chip = strip.querySelector('.tab-item.active');
    if (chip) menuBtn.style.left = `${chip.offsetLeft + chip.offsetWidth - MENU_BTN_INSET}px`;
  }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { placeMenuButton(); updateOverflow(); }) : null;
  observer?.observe(list);
  observer?.observe(strip);

  // In a shared workbook, a dot in each person's colour on the tab of the sheet they are on.
  let peers = new Map(); // sheetId → [{ name, color }]
  function peerMarks(sheetId) {
    const here = peers.get(sheetId);
    if (!here?.length) return null;
    const names = here.map((p) => p.name).join(', ');
    return el('span.tab-peers', { role: 'img', 'aria-label': `Here: ${names}`, title: `Here: ${names}` },
      ...here.slice(0, 3).map((p) => el('span.tab-peer', { style: { '--peer': p.color } })),
      here.length > 3 && el('span.tab-peer-more', {}, `+${here.length - 3}`));
  }
  function setPeers(next) {
    const before = JSON.stringify([...peers]);
    peers = next instanceof Map ? next : new Map();
    if (JSON.stringify([...peers]) !== before) refresh();
  }

  function refresh() {
    const active = ctx.wb.activeSheetId;
    allBtn.setAttribute('aria-haspopup', ctx.wb.sheets.length >= 8 ? 'dialog' : 'menu');
    // The grid is the panel these tabs control: each tab points at it, and it is named by the active tab.
    const panel = ctx.grid?.el || null;
    if (panel) { panel.setAttribute('role', 'tabpanel'); if (!panel.id) panel.id = 'sheet-panel'; }
    // Rebuilding the tabs removes the focused one; the keyboard must not fall through to the page.
    const hadFocus = list.contains(document.activeElement);
    const group = ctx.wb.sheetGroup;
    // Grouped sheets are all selected tabs at once.
    strip.setAttribute('aria-multiselectable', String(!!group));
    root.classList.toggle('grouped', !!group);
    strip.replaceChildren(...ctx.wb.visibleSheets.map((s) => {
      const isActive = s.id === active;
      const grouped = !!group?.includes(s.id);
      const tab = el('div.tab', {
        id: `sheet-tab-${s.id}`, role: 'tab', tabindex: isActive ? 0 : -1, 'aria-selected': String(isActive || grouped), 'aria-controls': panel?.id || null,
        className: `tab${isActive ? ' active' : ''}${grouped ? ' grouped' : ''}${s.color ? ' colored' : ''}`,
        style: s.color ? { '--tab-color': s.color } : null,
        onclick: (e) => { if (Date.now() - draggedAt > 300) clickTab(s, e); },
        ondblclick: () => renameVia(s),
        oncontextmenu: (e) => {
          e.preventDefault();
          if (Date.now() - keyMenuAt < 500) return;
          // A right-click opens the menu at the pointer; an event without a pointer position (a browser's own
          // answer to the menu key) opens it at the tab, not in the window's corner.
          if (e.clientX || e.clientY) tabMenu(s, null, e.clientX, e.clientY); else tabMenu(s, e.currentTarget);
        },
        onkeydown: (e) => {
          const visible = ctx.wb.visibleSheets;
          const i = visible.indexOf(s);
          if (e.key === 'ArrowRight' && visible[i + 1]) { e.preventDefault(); ctx.wb.setActiveSheet(visible[i + 1].id); focusActive(); }
          if (e.key === 'ArrowLeft' && visible[i - 1]) { e.preventDefault(); ctx.wb.setActiveSheet(visible[i - 1].id); focusActive(); }
          // As in a tab list, Home and End reach the first and the last tab.
          if (e.key === 'Home' && visible[0] !== s) { e.preventDefault(); ctx.wb.setActiveSheet(visible[0].id); focusActive(); }
          if (e.key === 'End' && visible.at(-1) !== s) { e.preventDefault(); ctx.wb.setActiveSheet(visible.at(-1).id); focusActive(); }
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.wb.setActiveSheet(s.id); }
          if (e.key === 'F2') { e.preventDefault(); renameVia(s); }
          // The keyboard's menu key opens the tab's menu at the tab, as it opens the cell menu at the cell in the grid.
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); keyMenuAt = Date.now(); tabMenu(s, e.currentTarget); }
        },
      },
        s.protected && el('span.tab-lock', { role: 'img', html: icon('lock', 12, 2.2), 'aria-label': 'Protected', title: 'Protected sheet' }),
        // In a sheet view of one's own (View ▸ Sheet View), the tab says which.
        s.personalView && (() => {
          const name = s.sheetViews?.find((v) => v.id === s.personalView.id)?.name || 'Sheet view';
          return el('span.tab-view', { role: 'img', html: icon('eye', 12, 2), 'aria-label': `In sheet view ${name}`, title: `Sheet view: ${name}` });
        })(),
        // A name in a right-to-left script is laid out that way, its number and full stop at its own end, as a cell is.
        el('span.tab-name', { dir: 'auto' }, s.name),
        peerMarks(s.id));
      if (!isActive) return tab;
      // The active tab's chip: the surface fill and accent line, with room at its end for the options button.
      return el('div.tab-item', {
        className: `tab-item active${s.color ? ' colored' : ''}`,
        style: s.color ? { '--tab-color': s.color } : null,
      }, tab);
    }));
    const chip = strip.querySelector('.tab-item.active');
    if (panel) panel.setAttribute('aria-labelledby', `sheet-tab-${active}`);
    menuBtn.hidden = !chip;
    menuBtn.setAttribute('aria-label', `${ctx.wb.sheet(active)?.name ?? 'Sheet'} options`);
    placeMenuButton();
    updateOverflow();
    chip?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // The options button survives a rebuild; only a tab that went away hands focus to the active one.
    if (hadFocus && !list.contains(document.activeElement)) focusActive();
  }

  function focusActive() {
    strip.querySelector('.tab.active')?.focus();
  }

  /**
   * A click on a tab. Plain: go to that sheet (a sheet outside the group ends it; with every sheet grouped, any
   * click ends it). Shift: group the sheets from the active one to this one. Ctrl or ⌘: add this sheet to the
   * group, or take it out (the active one hands over to its neighbour in the group first).
   */
  function clickTab(s, e) {
    const wb = ctx.wb;
    const visible = wb.visibleSheets;
    const group = wb.sheetGroup;
    if (e?.shiftKey) {
      const from = visible.findIndex((v) => v.id === wb.activeSheetId);
      const to = visible.indexOf(s);
      if (from < 0 || to < 0) return;
      wb.groupSheets(visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((v) => v.id));
      return;
    }
    if (e?.ctrlKey || e?.metaKey) {
      const ids = group || [wb.activeSheetId];
      if (!ids.includes(s.id)) { wb.groupSheets([...ids, s.id]); return; }
      if (!group) return;
      const rest = ids.filter((id) => id !== s.id);
      if (s.id === wb.activeSheetId) wb.setActiveSheet(rest[0]);
      wb.groupSheets(rest);
      return;
    }
    if (group && group.length >= visible.length) { wb.ungroupSheets(); if (s.id !== wb.activeSheetId) wb.setActiveSheet(s.id); return; }
    if (s.id !== wb.activeSheetId) wb.setActiveSheet(s.id);
  }

  // Dragging a tab moves the sheet to where it is dropped; with Ctrl (Option on a Mac) held at the drop it is copied there.
  // Touch keeps its swipe for scrolling the strip, so only a mouse or a pen drags.
  const marker = el('div.tab-drop-marker', { hidden: true, 'aria-hidden': 'true' });
  list.append(marker);
  let drag = null;
  let draggedAt = 0;
  const dropSlot = (x) => {
    const tabs = [...strip.querySelectorAll('.tab')];
    const index = tabs.findIndex((t) => { const r = t.getBoundingClientRect(); return x < r.left + r.width / 2; });
    return index < 0 ? tabs.length : index;
  };
  const endDrag = () => {
    if (!drag) return;
    marker.hidden = true; root.classList.remove('tab-dragging', 'tab-copying');
    try { drag.tab.releasePointerCapture?.(drag.pointerId); } catch { /* already released */ }
    drag = null;
  };
  strip.addEventListener('pointerdown', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || e.button !== 0 || e.pointerType === 'touch') return;
    drag = { tab, id: tab.id.replace('sheet-tab-', ''), x: e.clientX, pointerId: e.pointerId, moved: false };
  });
  strip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x) < 6) return;
    if (!drag.moved) { drag.moved = true; try { drag.tab.setPointerCapture?.(e.pointerId); } catch { /* capture is optional */ } }
    root.classList.add('tab-dragging');
    root.classList.toggle('tab-copying', e.ctrlKey || e.altKey);
    const tabs = [...strip.querySelectorAll('.tab')];
    const slot = dropSlot(e.clientX);
    const listRect = list.getBoundingClientRect();
    const edge = slot < tabs.length ? tabs[slot].getBoundingClientRect().left : (tabs.at(-1)?.getBoundingClientRect().right ?? listRect.left);
    marker.style.left = `${edge - listRect.left + list.scrollLeft - 1}px`;
    marker.hidden = false;
  });
  strip.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { id, moved } = drag;
    const copy = e.ctrlKey || e.altKey;
    const slot = moved ? dropSlot(e.clientX) : -1;
    endDrag();
    if (!moved) return;
    draggedAt = Date.now(); // the click that ends a drag is not a tab switch of its own
    const visible = ctx.wb.visibleSheets;
    const from = visible.findIndex((sh) => String(sh.id) === id);
    if (from < 0) return;
    const sheetId = visible[from].id;
    // Dropped where it already is: nothing moves (a copy still lands there).
    if (!copy && (slot === from || slot === from + 1)) return;
    const before = visible[slot]?.id ?? null;
    act('placeSheet', { id: sheetId, before, copy }, () => placeSheet(ctx.wb, sheetId, { before, copy }));
  });
  strip.addEventListener('pointercancel', endDrag);
  strip.addEventListener('keydown', (e) => { if (drag && e.key === 'Escape') { e.preventDefault(); endDrag(); } });

  const onChange = (e) => {
    const t = e.detail?.type;
    // Not on 'history': every edit records an undo step, and whatever changes a tab (a rename or colour, a
    // sheet added, moved, hidden or restored by undo) already arrives as a structure or active-sheet change.
    if (t === 'structure' || t === 'active-sheet' || t === 'load' || t === 'sheet-group') refresh();
  };
  ctx.wb.addEventListener('change', onChange);
  refresh();
  // The editor's Sheet commands (menu bar, palette) ask and pick through the same dialogs and swatches as the tab menu.
  return { el: root, refresh, rename, confirmDelete, colorMenu, setPeers, destroy: () => { observer?.disconnect(); ctx.wb.removeEventListener('change', onChange); } };
}
