/**
 * SmartArt in the editor: the Insert ▸ SmartArt gallery, the contextual SmartArt Design and Format tabs,
 * the commands they run (`run('smartArt', { action, ... })`), and which of a diagram's shapes are selected
 * (a click on a shape, or the item the Text Pane's cursor is in). The diagrams themselves are drawing
 * objects of the sheet (see core/smartart.js); every change here is one undoable workbook step.
 */
import { el } from './dom.js';
import { openModal } from './modal.js';
import { closeMenu, lazySubmenu } from './menu.js';
import { toast } from './toast.js';
import { themeColorBlock } from './themes.js';
import { customColorRows } from './colorpicker.js';
import { arrangeGroup } from './arrange-ribbon.js';
import { workbookTheme } from '../core/workbook-theme.js';
import { fontKeyFor, fontStack } from '../core/format.js';
import {
  SMARTART_LAYOUTS, SMARTART_CATEGORIES, SMARTART_COLOR_SCHEMES, SMARTART_STYLES, CHANGEABLE_SHAPES, layoutById, newSmartArt,
  smartArtSvg, smartArtShapes, smartArtTree, addSmartArtItem, promoteSmartArtItem, demoteSmartArtItem, moveSmartArtItem,
  themePalette, smartArtPaint, smartArtShapeCommands, normalizeSmartArtItems,
} from '../core/smartart.js';
import { pathData } from '../core/smartart-geometry.js';

/** The SmartArt diagram selected on the sheet, if the selection is one. */
export function activeSmartArt(ctx) {
  const id = ctx?.grid?.selectedChart;
  const obj = id ? ctx.wb.chartById(ctx.sheetId(), id) : null;
  return obj?.type === 'smartart' ? obj : null;
}

/** The theme's colours and body face, as a diagram is drawn with. */
export function smartArtLook(wb) {
  const theme = workbookTheme(wb);
  return { colors: theme.colors, fontFamily: fontStack(fontKeyFor(theme.minor, { literal: true })) || 'Calibri, Carlito, Arial, sans-serif' };
}

/** The picture another program drew for a diagram, placed over the object's box (its edges may reach past it). */
export function fallbackPicture(fallback) {
  const [px, py] = fallback.pad || [0, 0];
  const pct = (n) => `${Math.round(n * 10000) / 100}%`;
  return `<img class="smartart-fallback" alt="" draggable="false" src="${fallback.src}" style="position:absolute;left:${pct(-px)};top:${pct(-py)};width:${pct(1 + 2 * px)};height:${pct(1 + 2 * py)}">`;
}

/* ---------- The gallery (Insert ▸ SmartArt, and More Layouts) ---------- */

const THUMB_W = 96, THUMB_H = 64;
const thumbnail = (layout, look, extra = {}) => smartArtSvg({ ...newSmartArt(layout.id), ...extra }, THUMB_W * 2, THUMB_H * 2,
  { ...look, thumbnail: true, idPrefix: `sat-${layout.id}` });

/**
 * The layout gallery: categories down the side, the layouts of the one chosen in the middle, and the one picked
 * shown large with its description. `onPick(layoutId)` gets the choice (OK, Enter or a double-click).
 */
export function openSmartArtGallery(ctx, { title = 'Choose a SmartArt Graphic', current = null, okLabel = 'Insert', onPick }) {
  const look = smartArtLook(ctx.wb);
  let category = current ? layoutById(current)?.category || 'all' : 'all';
  let chosen = current || SMARTART_LAYOUTS[0].id;
  const cats = [['all', 'All'], ...SMARTART_CATEGORIES];
  const catList = el('div.sa-gallery-cats', { role: 'tablist', 'aria-label': 'Categories', 'aria-orientation': 'vertical' });
  const grid = el('div.sa-gallery-grid', { role: 'listbox', 'aria-label': 'Layouts' });
  const previewPic = el('div.sa-gallery-preview-pic', { 'aria-hidden': 'true' });
  const previewName = el('h3.sa-gallery-name');
  const previewText = el('p.sa-gallery-desc');
  const ok = el('button.btn.btn-primary', { type: 'submit' }, okLabel);
  const tiles = new Map();
  const choose = (id, { focus = false } = {}) => {
    chosen = id;
    for (const [lid, tile] of tiles) { tile.setAttribute('aria-selected', String(lid === id)); tile.tabIndex = lid === id ? 0 : -1; }
    const layout = layoutById(id);
    previewPic.innerHTML = smartArtSvg(newSmartArt(id), 300, 200, { ...look, idPrefix: 'sap' });
    previewName.textContent = layout.name;
    previewText.textContent = layout.description;
    if (focus) tiles.get(id)?.focus();
  };
  const showCategory = (key) => {
    category = key;
    for (const b of catList.children) { b.setAttribute('aria-selected', String(b.dataset.key === key)); b.tabIndex = b.dataset.key === key ? 0 : -1; }
    const list = SMARTART_LAYOUTS.filter((l) => key === 'all' || l.category === key);
    tiles.clear();
    grid.replaceChildren(...list.map((l) => {
      const tile = el('button.sa-gallery-tile', {
        type: 'button', role: 'option', 'aria-selected': 'false', tabindex: -1, title: l.name, 'aria-label': l.name, dataset: { id: l.id },
        onclick: () => choose(l.id), ondblclick: () => { choose(l.id); submit(); },
      }, el('span.sa-gallery-thumb', { html: thumbnail(l, look) }), el('span.sa-gallery-label', {}, l.name));
      tiles.set(l.id, tile);
      return tile;
    }));
    if (!list.some((l) => l.id === chosen)) chosen = list[0].id;
    choose(chosen);
  };
  for (const [key, label] of cats) {
    catList.append(el('button.sa-gallery-cat', { type: 'button', role: 'tab', 'aria-selected': 'false', tabindex: -1, dataset: { key },
      onclick: () => showCategory(key),
      onkeydown: (e) => {
        const all = [...catList.children], at = all.indexOf(e.currentTarget);
        const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[e.key];
        if (next == null || !all[next]) return;
        e.preventDefault(); showCategory(all[next].dataset.key); all[next].focus();
      } }, label));
  }
  grid.addEventListener('keydown', (e) => {
    const ids = [...tiles.keys()], at = ids.indexOf(chosen);
    const cols = Math.max(1, Math.round(grid.clientWidth / 112) || 3);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (step && ids[at + step]) { e.preventDefault(); choose(ids[at + step], { focus: true }); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); choose(ids[e.key === 'Home' ? 0 : ids.length - 1], { focus: true }); }
  });
  const submit = () => { modal.close(); onPick(chosen); };
  const content = el('form.sa-gallery', { onsubmit: (e) => { e.preventDefault(); submit(); } },
    el('div.sa-gallery-body', {}, catList, grid,
      el('div.sa-gallery-preview', {}, previewPic, previewName, previewText)),
    el('div.row.row-end.sa-gallery-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), ok));
  showCategory(category);
  const modal = openModal({ title, content, wide: true, className: 'sa-gallery-modal', initialFocus: tiles.get(chosen) || grid, onClose: () => ctx.grid?.focus?.() });
  return modal;
}

/* ---------- Commands ---------- */

/** The items a command acts on: the shapes selected in the diagram, or none. */
const pickedItems = (ctx, obj) => [...(ctx.smartArt?.selected(obj.id) || [])].filter((i) => i < obj.items.length).sort((a, b) => a - b);

/** Items for a new diagram from the selected cells: each non-empty cell an item, its column within the range its level. */
export function itemsFromCells(wb, sheetId, range) {
  if (!range || (range.r1 === range.r2 && range.c1 === range.c2)) return null;
  const items = [];
  for (let r = range.r1; r <= Math.min(range.r2, range.r1 + 300); r++) for (let c = range.c1; c <= Math.min(range.c2, range.c1 + 6); c++) {
    const text = String(wb.getDisplay(sheetId, r, c) ?? '').trim();
    if (text) items.push({ text, level: c - range.c1 });
  }
  return items.length > 1 ? normalizeSmartArtItems(items) : null;
}

/** Convert to Shapes: the diagram's shapes as separate objects in one group, text in text boxes where the shape is a plain box. */
function convertToShapes(ctx, obj) {
  const { wb } = ctx, sheetId = ctx.sheetId(), look = smartArtLook(wb), P = themePalette(look.colors);
  const { shapes, colorPlaces } = smartArtShapes(obj, obj.w, obj.h);
  const at = wb.objectRect(sheetId, obj.id);
  const ids = [];
  wb.transaction('Convert to Shapes', () => {
    const index = wb.sheet(sheetId).charts.findIndex((o) => o.id === obj.id);
    shapes.forEach((s, k) => {
      const p = smartArtPaint(s, obj, P, colorPlaces);
      const plain = s.kind === 'rect' && !s.rot && s.lines?.length && s.paras.every((q) => !q.bullet);
      let id, x = s.x, y = s.y;
      if (plain) {
        const box = s.textBox;
        id = wb.addChart(sheetId, { type: 'text', text: s.paras.map((q) => q.text).join('\n'), anchor: { r: 0, c: 0 }, dx: 0, dy: 0, w: Math.max(1, s.w), h: Math.max(1, s.h), nativeSize: true,
          style: { size: s.fontSize, color: p.text, bg: p.fill || null, border: false, align: s.align === 'left' || s.align === 'right' ? s.align : 'center',
            valign: s.valign === 'top' || s.valign === 'bottom' ? s.valign : 'middle',
            padding: [box.y - s.y, s.x + s.w - box.x - box.w, s.y + s.h - box.y - box.h, box.x - s.x].map((n) => Math.max(0, Math.round(n))) } });
      } else {
        const m = Math.max(4, (p.lineWidth || 0) + (p.shadow ? 6 : 0)), r = rotatedBox(s);
        const vb = [r.x - m, r.y - m, r.w + 2 * m, r.h + 2 * m];
        const svg = smartArtSvg(obj, obj.w, obj.h, { ...look, only: k, viewBox: vb, idPrefix: `cv${k}` });
        id = wb.addChart(sheetId, { type: 'image', src: `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`, title: s.paras?.map((q) => q.text).join(' ') || 'Shape',
          anchor: { r: 0, c: 0 }, dx: 0, dy: 0, w: vb[2], h: vb[3], nativeSize: true, border: false });
        [x, y] = vb;
      }
      if (!id) return;
      ids.push(id);
      wb.placeObjects(sheetId, [{ id, x: at.x + x, y: at.y + y }], 'Convert to Shapes');
    });
    wb.deleteChart(sheetId, obj.id);
    if (ids.length > 1) wb.groupObjects(sheetId, ids);
    // The shapes take the diagram's place in the stacking order.
    if (index >= 0 && ids.length) wb.moveObjectInOrder(sheetId, ids[0], index);
  });
  return ids;
}

/** The box round a shape once it is turned. */
function rotatedBox(s) {
  if (!s.rot) return { x: s.x, y: s.y, w: s.w, h: s.h };
  const a = (s.rot * Math.PI) / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
  const w = s.w * c + s.h * sn, h = s.w * sn + s.h * c;
  return { x: s.x + s.w / 2 - w / 2, y: s.y + s.h / 2 - h / 2, w, h };
}

const ADD_LABELS = { after: 'Add Shape After', before: 'Add Shape Before', above: 'Add Shape Above', below: 'Add Shape Below' };

/** Run a SmartArt command; `arg.action` names it. Returns true when something changed. */
export function runSmartArtAction(ctx, arg = {}) {
  const { wb } = ctx, sheetId = ctx.sheetId(), action = arg.action;
  if (action === 'insertDialog') {
    if (ctx.refused?.('insert SmartArt')) return false;
    openSmartArtGallery(ctx, { onPick: (layout) => runSmartArtAction(ctx, { action: 'insert', layout }) });
    return false;
  }
  if (action === 'insert') {
    if (ctx.refused?.('insert SmartArt')) return false;
    const fromCells = itemsFromCells(wb, sheetId, ctx.range?.());
    const model = newSmartArt(arg.layout, fromCells);
    const active = ctx.active?.() || { r: 0, c: 0 };
    const id = wb.addChart(sheetId, { ...model, anchor: { r: active.r, c: active.c }, dx: 8, dy: 6, w: 480, h: 300 });
    if (!id) return false;
    ctx.grid.selectChart(id);
    ctx.smartArt?.select(id, []);
    ctx.smartArt?.showPane({ focus: true });
    ctx.announce?.(`${layoutById(model.layout).name} SmartArt inserted. Type its text in the Text Pane`);
    return true;
  }
  const obj = arg.id ? wb.chartById(sheetId, arg.id) : activeSmartArt(ctx);
  if (!obj || obj.type !== 'smartart') { toast('Select a SmartArt graphic first', { icon: 'info', duration: 2400 }); return false; }
  if (ctx.refused?.('change the SmartArt graphic')) return false;
  const update = (patch, label, opts) => wb.updateSmartArt(sheetId, obj.id, patch, label, opts);
  const picked = pickedItems(ctx, obj);
  const target = picked.length ? picked.at(-1) : null;
  const say = (text) => ctx.announce?.(text);
  switch (action) {
    case 'pick': ctx.smartArt?.select(obj.id, arg.item == null ? [] : arg.add ? toggle(picked, arg.item) : [arg.item]); ctx.notify?.(); return false;
    case 'textPane': ctx.smartArt?.togglePane(); return false;
    case 'layoutDialog':
      openSmartArtGallery(ctx, { title: 'Change Layout', current: obj.layout, okLabel: 'OK', onPick: (layout) => runSmartArtAction(ctx, { action: 'layout', layout, id: obj.id }) });
      return false;
    case 'layout': {
      if (!layoutById(arg.layout) || arg.layout === obj.layout) return false;
      const ok = update({ layout: arg.layout }, 'Change SmartArt layout');
      const layout = layoutById(arg.layout), roots = smartArtTree(obj.items).length;
      if (ok) say(`Layout: ${layout.name}${layout.maxRoots && roots > layout.maxRoots ? `. It shows ${layout.maxRoots} of the ${roots} top-level items; the rest stay in the text` : ''}`);
      return ok;
    }
    case 'colors': return update({ colors: arg.colors }, 'Change SmartArt colors');
    case 'style': return update({ style: arg.style }, 'SmartArt style');
    case 'rtl': return update({ rtl: !obj.rtl }, 'Right to Left');
    case 'reset': {
      const ok = update({ style: 'flat', items: obj.items.map(({ fmt, ...it }) => it) }, 'Reset SmartArt graphic');
      if (ok) say('Graphic reset: shape formatting and style cleared');
      return ok;
    }
    case 'convert': {
      const ids = convertToShapes(ctx, obj);
      if (ids.length) { ctx.grid.selectCharts(ids); say(`Converted to ${ids.length} shapes`); }
      return !!ids.length;
    }
    case 'add': {
      const where = arg.where || 'after';
      // With no shape selected, a new top-level item goes at the end.
      const res = addSmartArtItem(obj.items, target ?? (where === 'after' ? lastRoot(obj.items) : null), where);
      if (!res) { toast('No room for another shape there', { icon: 'info', duration: 2200 }); return false; }
      update({ items: res.items }, ADD_LABELS[where] || 'Add Shape');
      ctx.smartArt?.select(obj.id, [res.at]);
      ctx.smartArt?.focusItem?.(res.at);
      say(`${ADD_LABELS[where] || 'Add Shape'}: item ${res.at + 1}`);
      return true;
    }
    case 'promote': case 'demote': case 'moveUp': case 'moveDown': {
      if (target == null) { toast('Select a shape, or put the cursor in an item of the Text Pane', { icon: 'info', duration: 2600 }); return false; }
      const res = action === 'promote' ? promoteSmartArtItem(obj.items, target) : action === 'demote' ? demoteSmartArtItem(obj.items, target)
        : moveSmartArtItem(obj.items, target, action === 'moveUp' ? -1 : 1);
      if (!res) { say({ promote: 'Already at the top level', demote: 'Cannot demote this item further', moveUp: 'Already first', moveDown: 'Already last' }[action]); return false; }
      update({ items: res.items }, { promote: 'Promote', demote: 'Demote', moveUp: 'Move Up', moveDown: 'Move Down' }[action]);
      ctx.smartArt?.select(obj.id, [res.at]);
      ctx.smartArt?.focusItem?.(res.at);
      say(`${{ promote: 'Promoted', demote: 'Demoted', moveUp: 'Moved up', moveDown: 'Moved down' }[action]}: level ${res.items[res.at].level + 1}`);
      return true;
    }
    case 'format': case 'scale': case 'shape': case 'resetShape': {
      if (!picked.length) { toast('Select one or more shapes in the diagram first', { icon: 'info', duration: 2600 }); return false; }
      const items = obj.items.map((it, i) => {
        if (!picked.includes(i)) return it;
        let fmt = { ...(it.fmt || {}) };
        if (action === 'format') for (const k of ['fill', 'line', 'color']) if (Object.hasOwn(arg, k)) { if (arg[k] == null) delete fmt[k]; else fmt[k] = arg[k]; }
        if (action === 'scale') fmt.scale = Math.max(0.4, Math.min(2.5, Math.round((fmt.scale || 1) * (arg.dir > 0 ? 1.1 : 1 / 1.1) * 100) / 100));
        if (action === 'shape') fmt.shape = arg.shape;
        if (action === 'resetShape') fmt = {};
        const { fmt: _drop, ...rest } = it;
        return Object.keys(fmt).length ? { ...rest, fmt } : rest;
      });
      return update({ items }, { format: 'Format shape', scale: arg.dir > 0 ? 'Larger' : 'Smaller', shape: 'Change Shape', resetShape: 'Reset Shape' }[action]);
    }
    default: return false;
  }
}

const toggle = (list, i) => (list.includes(i) ? list.filter((x) => x !== i) : [...list, i]);
/** The last top-level item, after which Add Shape puts a new one when none is selected. */
function lastRoot(items) {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].level === 0) return i;
  return null;
}

/* ---------- Ribbon: SmartArt Design and Format ---------- */

const flags = (ctx) => ctx?.flags?.() || {};
const cannot = (ctx) => !!flags(ctx).editing || !activeSmartArt(ctx) || !!ctx.wb.sheet(ctx.sheetId())?.protected;
const noTarget = (ctx) => { const obj = activeSmartArt(ctx); return !obj || !pickedItems(ctx, obj).length; };
const cmd = (label, glyph, arg, extra = {}) => ({ label, glyph, ariaLabel: extra.ariaLabel || label, ...extra,
  resolve: (menus, ctx) => ({ label, cmd: 'smartArt', arg, disabled: cannot(ctx) || !!extra.unavailable?.(ctx), checked: extra.isChecked?.(ctx) }) });
const menu = (label, glyph, build, extra = {}) => ({ label, glyph, ariaLabel: extra.ariaLabel || label, ...extra,
  resolve: (menus, ctx) => { const disabled = cannot(ctx) || !!extra.unavailable?.(ctx); return lazySubmenu({ label, disabled }, () => (disabled ? [] : build(ctx))); } });

/** A grid of pictures inside a menu; a pick closes the menu and runs `onPick`. */
function tiles(label, list, { columns = 4, className = '' } = {}) {
  const grid = el(`div.chart-gallery-grid.sa-menu-grid${className ? `.${className}` : ''}`, { role: 'group', 'aria-label': label, style: { gridTemplateColumns: `repeat(${columns}, auto)` } },
    ...list.map((t) => el('button.chart-gallery-tile', {
      type: 'button', role: t.checked == null ? 'menuitem' : 'menuitemradio', tabindex: -1, title: t.label, 'aria-label': t.label,
      ...(t.checked == null ? {} : { 'aria-checked': String(!!t.checked) }),
      onclick: () => { closeMenu(); t.onPick(); },
    }, el('span.chart-gallery-picture', { html: t.html, 'aria-hidden': 'true' }))));
  grid.addEventListener('keydown', (e) => {
    const all = [...grid.querySelectorAll('button')], at = all.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[e.key];
    if (at < 0 || !step || !all[at + step]) return;
    e.preventDefault(); e.stopPropagation(); all[at + step].focus();
  });
  return grid;
}

const run = (ctx, arg) => ctx.run('smartArt', arg);

/** Change Layout's menu: the layouts of the diagram's own category, then the whole gallery. */
function layoutMenu(ctx) {
  const obj = activeSmartArt(ctx), look = smartArtLook(ctx.wb), cat = layoutById(obj.layout)?.category;
  const list = SMARTART_LAYOUTS.filter((l) => l.category === cat);
  return [{ header: `${SMARTART_CATEGORIES.find(([k]) => k === cat)?.[1] || 'Layouts'} layouts` },
    { custom: tiles('Layouts', list.map((l) => ({ label: l.name, checked: l.id === obj.layout, html: smartArtSvg({ ...obj, layout: l.id, fallback: null }, 160, 106, { ...look, thumbnail: true, idPrefix: `sal-${l.id}` }),
      onPick: () => run(ctx, { action: 'layout', layout: l.id }) })), { columns: 3, className: 'sa-layout-tiles' }) },
    { separator: true }, { label: 'More Layouts…', icon: 'smartArt', cmd: 'smartArt', arg: { action: 'layoutDialog' } }];
}

/** Change Colors: the theme's schemes, a row of swatches each, under their headings. */
function colorsMenu(ctx) {
  const obj = activeSmartArt(ctx), look = smartArtLook(ctx.wb), P = themePalette(look.colors);
  const groups = [...new Set(SMARTART_COLOR_SCHEMES.map((s) => s.group))];
  return groups.flatMap((g) => [{ header: g }, { custom: tiles(g, SMARTART_COLOR_SCHEMES.filter((s) => s.group === g).map((s) => ({
    label: s.name, checked: s.id === obj.colors,
    html: swatchPicture({ ...obj, colors: s.id }, P),
    onPick: () => run(ctx, { action: 'colors', colors: s.id }) })), { columns: 4, className: 'sa-color-tiles' }) }]);
}

/** A colour scheme's sample: three shapes as the scheme paints them. */
function swatchPicture(model, P) {
  const shapes = [0, 1, 2].map((ci) => ({ kind: 'roundRect', role: 'node', ci, x: 4 + ci * 22, y: 6, w: 20, h: 20, adj: { r: 0.18 } }));
  return `<svg viewBox="0 0 74 32" width="74" height="32" aria-hidden="true">${shapes.map((s) => {
    const p = smartArtPaint(s, { ...model, style: 'flat', items: [] }, P, 3);
    return `<path d="${pathData(smartArtShapeCommands(s), s.x, s.y)}" fill="${p.fill || 'none'}" stroke="${p.line || 'none'}" stroke-width="${p.line ? 1.5 : 0}"/>`;
  }).join('')}</svg>`;
}

function stylesMenu(ctx) {
  const obj = activeSmartArt(ctx), look = smartArtLook(ctx.wb);
  const sample = { ...obj, items: normalizeSmartArtItems([{ text: '', level: 0 }, { text: '', level: 0 }, { text: '', level: 0 }]), layout: 'basicProcess', fallback: null };
  return [{ custom: tiles('Styles', SMARTART_STYLES.map((s) => ({ label: `${s.name}: ${s.description}`, checked: s.id === obj.style,
    html: smartArtSvg({ ...sample, style: s.id }, 120, 60, { ...look, idPrefix: `sas-${s.id}` }), onPick: () => run(ctx, { action: 'style', style: s.id }) })), { columns: 3, className: 'sa-style-tiles' }) }];
}

const addMenu = () => ['after', 'before', 'above', 'below'].map((where) => ({ label: ADD_LABELS[where], icon: 'addShape', cmd: 'smartArt', arg: { action: 'add', where } }));

const STANDARD = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'];
function colorMenu(ctx, key) {
  const pick = (hex) => run(ctx, { action: 'format', [key]: hex });
  const noun = { fill: 'fill color', line: 'outline color', color: 'text color' }[key];
  const block = themeColorBlock(ctx.wb, { onPick: (c) => { closeMenu(); pick(c.rgb.toLowerCase()); } });
  const standard = el('div.swatches', { role: 'group', 'aria-label': 'Standard Colors', 'data-cols': 10 },
    ...STANDARD.map((c) => el('button.swatch', { type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': c, title: c, style: { background: c }, onclick: () => { closeMenu(); pick(c); } })));
  const custom = customColorRows({ onPick: (hex) => { closeMenu(); pick(hex); }, role: 'menuitem', label: noun });
  return [...block.map((c) => ({ custom: c })), { header: 'Standard Colors' }, { custom: standard }, ...custom.map((c) => ({ custom: c })), { separator: true },
    ...(key === 'color' ? [] : [{ label: key === 'fill' ? 'No Fill' : 'No Outline', cmd: 'smartArt', arg: { action: 'format', [key]: 'none' } }]),
    { label: 'Automatic', cmd: 'smartArt', arg: { action: 'format', [key]: null }, hint: 'The colour scheme’s own' }];
}

function shapeMenu(ctx) {
  return [{ custom: tiles('Shapes', CHANGEABLE_SHAPES.map(([kind, label]) => ({ label, onPick: () => run(ctx, { action: 'shape', shape: kind }),
    html: `<svg viewBox="-2 -2 44 32" width="44" height="32" aria-hidden="true"><path d="${pathData(smartArtShapeCommands({ kind, w: 40, h: 28, adj: {} }))}" fill="var(--accent-wash, #dbe7fb)" stroke="currentColor" stroke-width="1.5"/></svg>` })), { columns: 4, className: 'sa-shape-tiles' }) }];
}

export function smartArtDesignGroups() {
  return [
    ['Create Graphic',
      { ...cmd('Add Shape', 'addShape', { action: 'add', where: 'after' }), split: () => addMenu() },
      cmd('Text Pane', 'textPane', { action: 'textPane' }, { isChecked: (ctx) => !!ctx.smartArt?.paneOpen }),
      cmd('Promote', 'indentLess', { action: 'promote' }, { unavailable: noTarget }), cmd('Demote', 'indentMore', { action: 'demote' }, { unavailable: noTarget }),
      cmd('Move Up', 'arrowUp', { action: 'moveUp' }, { unavailable: noTarget }), cmd('Move Down', 'arrowDown', { action: 'moveDown' }, { unavailable: noTarget }),
      cmd('Right to Left', 'rightToLeft', { action: 'rtl' }, { isChecked: (ctx) => !!activeSmartArt(ctx)?.rtl })],
    ['Layouts', { ...menu('Change Layout', 'smartArt', layoutMenu), large: true }],
    ['SmartArt Styles', { ...menu('Change Colors', 'changeColors', colorsMenu), large: true }, { ...menu('Styles', 'chartStyles', stylesMenu, { ariaLabel: 'SmartArt Styles' }), large: true }],
    ['Reset', { ...cmd('Reset Graphic', 'resetStyle', { action: 'reset' }), large: true }, { ...cmd('Convert to Shapes', 'convertShapes', { action: 'convert' }), large: true }],
  ];
}

export function smartArtFormatGroups() {
  return [
    ['Shapes', { ...menu('Change Shape', 'changeShape', shapeMenu, { unavailable: noTarget }), large: true },
      cmd('Larger', 'shapeLarger', { action: 'scale', dir: 1 }, { unavailable: noTarget }), cmd('Smaller', 'shapeSmaller', { action: 'scale', dir: -1 }, { unavailable: noTarget })],
    ['Shape Styles', menu('Shape Fill', 'shapeFill', (ctx) => colorMenu(ctx, 'fill'), { unavailable: noTarget }),
      menu('Shape Outline', 'shapeOutline', (ctx) => colorMenu(ctx, 'line'), { unavailable: noTarget }),
      menu('Text Fill', 'textColor', (ctx) => colorMenu(ctx, 'color'), { unavailable: noTarget }),
      cmd('Reset Shape', 'resetStyle', { action: 'resetShape' }, { unavailable: noTarget })],
    ['Accessibility', { label: 'Alt Text', glyph: 'altText', ariaLabel: 'Alt Text', large: true,
      resolve: (menus, ctx) => ({ label: 'Alt Text', cmd: 'altText', arg: activeSmartArt(ctx)?.id, disabled: cannot(ctx) }) }],
    arrangeGroup({ large: false }),
  ];
}

/* ---------- Selection of shapes, and the editor's wiring ---------- */

/**
 * The editor's SmartArt state: which shapes of which diagram are selected, and the Text Pane. `pane` is the
 * Text Pane (smartart-pane.js), made by the editor and handed in.
 */
export function createSmartArtUi(ctx) {
  let current = { id: null, items: new Set() };
  const api = {
    pane: null,
    selected: (id) => (current.id === id ? current.items : new Set()),
    select(id, items) {
      const next = new Set(items);
      if (current.id === id && next.size === current.items.size && [...next].every((i) => current.items.has(i))) return;
      current = { id, items: next };
      ctx.grid?.refresh?.();
      api.pane?.syncSelection?.();
    },
    /** The sheet's selection moved: shapes of a diagram no longer selected are let go. */
    chartSelected(id) {
      if (current.id && current.id !== id) { current = { id: null, items: new Set() }; ctx.grid?.refresh?.(); }
      api.pane?.refresh?.();
    },
    get paneOpen() { return !!api.pane?.open; },
    showPane: (opts) => api.pane?.show(opts),
    togglePane: () => (api.pane?.open ? api.pane.hide() : api.pane?.show({ focus: true })),
    focusItem: (i) => api.pane?.focusItem?.(i),
  };
  return api;
}

