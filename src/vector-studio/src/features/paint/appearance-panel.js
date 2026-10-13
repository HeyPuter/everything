/**
 * Appearance panel (Shift+F6) and Graphic Styles panel.
 *
 * Appearance lists the selected object's appearance stack top first (see
 * model/appearance.js): every fill and stroke with its swatch (click to
 * edit the paint in place), stroke weight, eye and a disclosure showing its
 * own effects and opacity, the Contents (groups, layers) or Characters
 * (type) entry, the object's effects and its Opacity, under a header with
 * the object kind and its linked graphic style. Picking a fill or stroke
 * makes it the one the Color, Swatches, Gradient and Stroke panels and new
 * effects edit. Items reorder by dragging or Alt+Up/Down; Add New Fill /
 * Add New Stroke place the new item above the picked one. The panel menu
 * adds New Art Has Basic Appearance, Show All Hidden Attributes, Show/Hide
 * Thumbnail and Redefine Graphic Style.
 *
 * Graphic Styles shows the document's styles in thumbnail or list views;
 * clicking applies and links a style (Alt+click adds it to the current
 * appearance). Its menu duplicates, merges, deletes, breaks links, selects
 * unused styles, sorts, opens or saves style libraries, and sets whether
 * styles override the character colors of type.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton, paintSwatch, numberField, selectField } from '../../ui/widgets.js';
import { icon } from '../../ui/icons.js';
import { openPaintPopover, openPopover, closePopover } from '../../ui/popover.js';
import { applyStyle, commonStyle } from '../../ops/paint-ops.js';
import { selectionKind, BLEND_LABELS } from '../../ui/panels/properties.js';
import { EFFECTS, effectLabel } from './effects-model.js';
import { effectDialog, effectTargets } from './effects-ui.js';
import { drawThumbnail, standaloneDoc } from './thumbs.js';
import { graphicStylesOf, setGraphicStyles, styleOfNode, applyGraphicStyle, applyStyleTo, newStyleId, linkedStyle, styleUsers, unusedGraphicStyleIds, mergeStyles, sortStylesByName, overridesCharColor, OVERRIDE_CHAR_COLOR } from './graphic-styles.js';
import { graphicStyleLibraries } from './graphic-style-libraries.js';
import { userLibraryMenu, saveLibraryDialog, exportLibraryFile, pickTextFile } from './user-libraries.js';
import { MENUS } from '../../ui/menus.js';
import { createPath } from '../../model/nodes.js';
import { rectangle } from '../../model/shapes.js';
import { gestureKey } from './ui-common.js';
import { BLEND_MODES } from '../../render/draw.js';
import { stackItems, itemPaint, itemStrokeAttrs } from '../../model/appearance.js';
import { appearanceOwners, stackOwners, sharedStack, setAppearanceTarget, addItem, duplicateItem, removeItem, moveItem, setItemAttrs, toggleItem, clearStacks, reduceStacks, showAllHidden } from './appearance-ops.js';

export class AppearancePanel extends Panel {
  static id = 'appearance';
  static title = 'Appearance';
  static icon = 'sparkles';
  static placement = 'strip';
  static shortcut = 'Shift+F6';

  build() {
    const app = this.app;
    /** The picked row: an object effect index, 'item:i', 'item:i:fx:j', 'item:i:opacity', 'opacity' or null. */
    this.selectedRow = null;
    /** Stack items (indices) whose effects and opacity are shown. */
    this.expanded = new Set();
    this.thumb = h('canvas.ap-thumb', { width: 32, height: 32, 'aria-hidden': 'true' });
    this.kind = h('span.ap-kind');
    this.list = h('div.ap-list', { role: 'list', 'aria-label': 'Appearance attributes' });
    const btn = (ic, label, fn) => iconButton(ic, label, fn, { className: 'small' });
    this.footer = h(
      'div.ap-footer',
      btn('add-stroke', 'Add New Stroke', () => this.addPaint('stroke')),
      btn('add-fill', 'Add New Fill', () => this.addPaint('fill')),
      btn('fx', 'Add New Effect', (e) => this.effectMenu(e.currentTarget)),
      h('span.sw-spacer'),
      btn('ban', 'Clear Appearance', () => this.clearAppearance()),
      btn('reduce-basic', 'Reduce to Basic Appearance', () => this.reduceBasic()),
      (this.dupBtn = btn('copy', 'Duplicate Selected Item', () => this.duplicateItem())),
      (this.delBtn = btn('trash', 'Delete Selected Item', () => this.deleteItem())),
    );
    this.styleName = h('span.ap-style');
    this.head = h('div.ap-head', this.thumb, h('div.ap-head-text', this.kind, this.styleName));
    this.el.append(this.head, this.list, this.footer);
    this.thumbShown = app.prefs.get('appearanceThumb') !== false;
    this.thumb.hidden = !this.thumbShown;
  }

  menu() {
    const app = this.app;
    const ed = app.editor;
    const has = Boolean(ed);
    const linked = ed ? this.linkedStyle() : null;
    const gsPanel = app.dock?.panels?.get('graphicStyles');
    const gsId = linked?.id || (gsPanel?.picked?.size === 1 ? [...gsPanel.picked][0] : null);
    const gsName = gsId && ed ? graphicStylesOf(ed.doc).find((g) => g.id === gsId)?.name : null;
    return [
      { label: 'Add New Fill', enabled: has, run: () => this.addPaint('fill') },
      { label: 'Add New Stroke', enabled: has, run: () => this.addPaint('stroke') },
      { label: 'Add New Effect', submenu: this.effectItems() },
      '-',
      { label: 'Duplicate Item', enabled: this.canDuplicate(), run: () => this.duplicateItem() },
      { label: 'Remove Item', enabled: this.canRemove(), run: () => this.deleteItem() },
      { label: 'Clear Appearance', enabled: has, run: () => this.clearAppearance() },
      { label: 'Reduce to Basic Appearance', enabled: has, run: () => this.reduceBasic() },
      '-',
      { label: 'New Art Has Basic Appearance', checked: app.prefs.get('newArtBasic') !== false, run: () => app.prefs.set('newArtBasic', app.prefs.get('newArtBasic') === false) },
      { label: 'Show All Hidden Attributes', enabled: has && this.hasHidden(), run: () => showAllHidden(ed) },
      { label: this.thumbShown ? 'Hide Thumbnail' : 'Show Thumbnail', run: () => this.setThumbShown(!this.thumbShown) },
      '-',
      { label: gsName ? `Redefine Graphic Style "${gsName}"` : 'Redefine Graphic Style', enabled: Boolean(gsId) && Boolean(ed?.topSelection().length), run: () => redefineGraphicStyle(app, gsId) },
    ];
  }

  setThumbShown(on) {
    this.thumbShown = on;
    this.app.prefs.set('appearanceThumb', on);
    this.thumb.hidden = !on;
  }

  /** The graphic style the whole selection is linked to, or null. */
  linkedStyle() {
    const ed = this.app.editor;
    const t = ed ? ed.topSelection().map((id) => ed.doc.get(id)).filter(Boolean) : [];
    if (!t.length) return null;
    const first = linkedStyle(ed.doc, t[0]);
    return first && t.every((n) => linkedStyle(ed.doc, n)?.id === first.id) ? first : null;
  }

  /** Add New Effect entries: the Effect menu's effect commands, or the built-in effects. */
  effectItems() {
    const skip = new Set(['effect.applyLast', 'effect.last', 'effect.rasterSettings']);
    const effectMenu = (MENUS.find((m) => m.label === 'Effect')?.submenu || []).filter((x) => !(typeof x === 'string' && skip.has(x)));
    if (effectMenu.some((x) => typeof x === 'string' ? this.app.commands.get(x) : true)) return effectMenu;
    return Object.entries(EFFECTS).map(([type, def]) => ({ label: `${def.label}...`, enabled: this.targets().length > 0, run: () => effectDialog(this.app, type) }));
  }

  targets() {
    return this.app.editor ? effectTargets(this.app.editor) : [];
  }

  /** The stack item a row belongs to ('item:2', 'item:2:fx:0', ...), or null. */
  rowItem(r = this.selectedRow) {
    const m = typeof r === 'string' ? /^item:(\d+)/.exec(r) : null;
    return m ? Number(m[1]) : null;
  }

  /** The item effect a row names: [item, effect index], or null. */
  rowItemEffect(r = this.selectedRow) {
    const m = typeof r === 'string' ? /^item:(\d+):fx:(\d+)$/.exec(r) : null;
    return m ? [Number(m[1]), Number(m[2])] : null;
  }

  /** The shown stack: { owners, items, same } (a stand-in for the new-art style without a selection). */
  stack() {
    const ed = this.app.editor;
    if (!ed) return null;
    const st = sharedStack(ed);
    if (st) return st;
    if (appearanceOwners(ed).length) return null;
    const pseudo = { type: 'path', ...ed.style };
    return { owners: [], items: stackItems(pseudo), same: true, pseudo };
  }

  /** Pick a row: the fill or stroke it belongs to becomes the target of the paint panels and effects. */
  pick(id) {
    const ed = this.app.editor;
    this.selectedRow = id;
    if (ed) {
      const i = this.rowItem(id);
      const st = this.stack();
      const it = i != null ? st?.items[i] : null;
      if (st?.owners.length) setAppearanceTarget(ed, it && it.type !== 'contents' ? i : null);
      if (it && (it.type === 'fill' || it.type === 'stroke') && ed.focusPaint !== it.type) {
        ed.focusPaint = it.type;
        ed.emit('style');
      }
    }
    this.update(true);
  }

  canDuplicate() {
    const r = this.selectedRow;
    if (typeof r === 'number') return true;
    const i = this.rowItem(r);
    if (i == null || r.endsWith(':opacity')) return false;
    const it = this.stack()?.items[i];
    return Boolean(it && it.type !== 'contents' && this.stack().owners.length);
  }

  canRemove() {
    const r = this.selectedRow;
    if (r == null || r === 'opacity' || r === 'contents') return false;
    if (typeof r === 'number') return true;
    if (r.endsWith(':opacity')) return false;
    const it = this.stack()?.items[this.rowItem(r)];
    return Boolean(it && it.type !== 'contents');
  }

  hasHidden() {
    const ed = this.app.editor;
    return stackOwners(ed).some((n) => n.effects?.some((e) => e.hidden) || stackItems(n).some((it) => it.hidden || it.effects?.some((e) => e.hidden)));
  }

  /** Effects shown in the list: the single object's, or the shared list when all match. */
  sharedEffects() {
    const t = this.targets();
    if (!t.length) return { effects: this.app.editor?.style.effects || [], mixed: false };
    const first = JSON.stringify(t[0].effects || []);
    if (t.every((n) => JSON.stringify(n.effects || []) === first)) return { effects: t[0].effects || [], mixed: false };
    return { effects: [], mixed: true };
  }

  setEffects(fn, label) {
    const ed = this.app.editor;
    const t = this.targets();
    if (!ed) return;
    if (!t.length) {
      ed.setStyle({ effects: fn(ed.style.effects || []) });
      return;
    }
    ed.doc.transact(label, () => {
      for (const n of t) ed.doc.update(n.id, { effects: fn(n.effects || []) });
    });
  }

  /** Change one stack item's effects on every owner. */
  setItemEffects(i, fn, label) {
    setItemAttrs(this.app.editor, i, { effects: (list) => fn(list || []) }, label);
  }

  addPaint(key) {
    const ed = this.app.editor;
    if (!ed) return;
    const st = this.stack();
    if (st?.owners.length) {
      const i = addItem(ed, key, this.rowItem());
      if (i != null) {
        this.selectedRow = `item:${i}`;
        ed.focusPaint = key;
        ed.emit('style');
      }
      this.update(true);
      return;
    }
    // New-art style (no selection), or objects without stacks: the single fill or stroke turns on.
    const cur = commonStyle(ed, key);
    if (!cur) {
      const patch = { [key]: { type: 'solid', color: key === 'fill' ? '#ffffff' : '#000000' } };
      if (key === 'stroke' && !(commonStyle(ed, 'strokeWidth') > 0)) patch.strokeWidth = 1;
      applyStyle(ed, patch, key === 'fill' ? 'Add New Fill' : 'Add New Stroke');
    }
    ed.focusPaint = key;
    ed.emit('style');
    this.selectedRow = st ? `item:${st.items.findIndex((it) => it.type === key)}` : null;
  }

  effectMenu(anchor) {
    // The effects feature offers the whole Effect menu here when installed.
    if (this.app.showEffectMenu) return this.app.showEffectMenu(anchor);
    const items = Object.entries(EFFECTS).map(([type, def]) => ({
      label: `${def.label}...`,
      enabled: this.targets().length > 0,
      run: () => effectDialog(this.app, type),
    }));
    this.app.showMenuAt(anchor, items, 'Add New Effect');
  }

  clearAppearance() {
    const ed = this.app.editor;
    if (!ed) return;
    const t = this.targets();
    if (stackOwners(ed).length) clearStacks(ed);
    else {
      applyStyle(ed, { fill: null, stroke: null }, 'Clear Appearance');
      if (t.length) {
        ed.doc.transact('Clear Appearance', () => {
          for (const n of t) ed.doc.update(n.id, { effects: [], opacity: 1, blendMode: 'normal' });
        });
      } else ed.setStyle({ effects: [], opacity: 1, blendMode: 'normal', appearance: undefined });
    }
    this.selectedRow = null;
  }

  reduceBasic() {
    const ed = this.app.editor;
    if (ed && stackOwners(ed).length) reduceStacks(ed);
    else this.setEffects(() => [], 'Reduce to Basic Appearance');
    this.selectedRow = null;
  }

  duplicateItem() {
    const r = this.selectedRow;
    const ed = this.app.editor;
    if (typeof r === 'number') {
      this.setEffects((list) => (list[r] ? [...list.slice(0, r + 1), { ...list[r] }, ...list.slice(r + 1)] : list), 'Duplicate Effect');
      this.selectedRow = r + 1;
      return;
    }
    const fx = this.rowItemEffect(r);
    if (fx) {
      const [i, j] = fx;
      this.setItemEffects(i, (list) => (list[j] ? [...list.slice(0, j + 1), { ...list[j] }, ...list.slice(j + 1)] : list), 'Duplicate Effect');
      this.selectedRow = `item:${i}:fx:${j + 1}`;
      return;
    }
    const i = this.rowItem(r);
    if (i != null && ed && duplicateItem(ed, i)) this.selectedRow = `item:${i + 1}`;
  }

  deleteItem() {
    const r = this.selectedRow;
    const ed = this.app.editor;
    if (!ed || r == null) return;
    if (typeof r === 'number') {
      this.setEffects((list) => list.filter((_, i) => i !== r), 'Delete Effect');
      this.selectedRow = null;
      return;
    }
    const fx = this.rowItemEffect(r);
    if (fx) {
      this.setItemEffects(fx[0], (list) => list.filter((_, j) => j !== fx[1]), 'Delete Effect');
      this.selectedRow = `item:${fx[0]}`;
      return;
    }
    const i = this.rowItem(r);
    if (i == null) return;
    const st = this.stack();
    const it = st?.items[i];
    if (!it || it.type === 'contents') return;
    if (st.owners.length) removeItem(ed, i);
    else applyStyle(ed, { [it.type]: null }, it.type === 'fill' ? 'Delete Fill' : 'Delete Stroke');
    this.selectedRow = null;
  }

  editEffect(i) {
    const t = this.targets();
    const ed = this.app.editor;
    if (!ed) return;
    const fx = (t[0]?.effects || [])[i];
    if (!fx) return;
    if (t.length === 1) effectDialog(this.app, fx.type, { edit: { id: t[0].id, index: i } });
    else effectDialog(this.app, fx.type, { params: fx });
  }

  editItemEffect(i, j) {
    const st = this.stack();
    const fx = st?.items[i]?.effects?.[j];
    if (!fx || !st.owners.length) return;
    if (st.owners.length === 1) effectDialog(this.app, fx.type, { edit: { id: st.owners[0].id, index: j, item: i } });
    else effectDialog(this.app, fx.type, { params: fx });
  }

  /** Object effect rows reorder by dragging (Alt+Up/Down from the keyboard). */
  draggable(r, i, count) {
    if (count < 2) return;
    this.dragRow(r, `fx:${i}`, (from, after) => {
      if (!from.startsWith('fx:')) return;
      const f = Number(from.slice(3));
      let to = i + (after ? 1 : 0);
      if (f < to) to--;
      if (to === f) return;
      this.setEffects((list) => {
        const out = list.slice();
        const [fx] = out.splice(f, 1);
        out.splice(to, 0, fx);
        return out;
      }, 'Reorder Effects');
      this.selectedRow = to;
    });
  }

  /** Drag-and-drop between rows of one kind: drop(fromKey, droppedBelowTheRow). */
  dragRow(r, key, drop) {
    r.draggable = true;
    const kind = key.split(':')[0];
    const clear = () => this.list.querySelectorAll('.fx-drop-before, .fx-drop-after').forEach((el) => el.classList.remove('fx-drop-before', 'fx-drop-after'));
    r.addEventListener('dragstart', (e) => {
      this.dragFrom = key;
      e.dataTransfer?.setData('text/plain', key);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });
    r.addEventListener('dragover', (e) => {
      if (!this.dragFrom || this.dragFrom.split(':')[0] !== kind) return;
      e.preventDefault();
      clear();
      r.classList.add(e.offsetY > r.offsetHeight / 2 ? 'fx-drop-after' : 'fx-drop-before');
    });
    r.addEventListener('dragleave', clear);
    r.addEventListener('dragend', () => {
      this.dragFrom = null;
      clear();
    });
    r.addEventListener('drop', (e) => {
      const from = this.dragFrom;
      this.dragFrom = null;
      clear();
      if (!from || from.split(':')[0] !== kind) return;
      e.preventDefault();
      drop(from, e.offsetY > r.offsetHeight / 2);
    });
  }

  /** Move stack item i up (+1) or down (-1) in paint order. */
  moveStackItem(i, dir) {
    const st = this.stack();
    const j = i + dir;
    if (!st?.owners.length || j < 0 || j >= st.items.length) return;
    moveItem(this.app.editor, i, j);
    this.expanded = new Set([...this.expanded].map((k) => (k === i ? j : k === j ? i : k)));
    this.selectedRow = `item:${j}`;
    this.update(true);
    this.list.querySelector(`[data-row="item:${j}"]`)?.focus();
  }

  row({ id, label, swatch, extra, eye, eyeLabel, onEye, onActivate, onDelete, hiddenFx = false, level = 1, disclosure = null, onMove = null, onToggle = null }) {
    const selected = this.selectedRow === id;
    const text = typeof label === 'string' ? label : label.textContent;
    const r = h('div.ap-row', { role: 'listitem', tabindex: '0', 'aria-label': text, 'aria-current': selected ? 'true' : null, 'data-row': String(id) });
    r.classList.toggle('selected', selected);
    r.classList.toggle('fx-hidden', hiddenFx);
    r.classList.toggle('ap-sub', level > 1);
    const tw = disclosure == null ? h('span.ap-tw-pad') : iconButton(disclosure ? 'chevron-down' : 'chevron-right', disclosure ? `Collapse ${text}` : `Expand ${text}`, (e) => {
      e.stopPropagation();
      onToggle?.();
    }, { className: 'small ap-tw' });
    if (disclosure != null) tw.setAttribute('aria-expanded', String(disclosure));
    const eyeBtn = eye != null ? iconButton(eye ? 'eye' : 'eye-off', eyeLabel || (eye ? 'Hide' : 'Show'), (e) => {
      e.stopPropagation();
      onEye();
    }, { className: 'small ap-eye' }) : h('span.ap-eye-pad');
    r.append(tw, eyeBtn, swatch || h('span.ap-sw-pad'), h('span.ap-label', label));
    if (extra) r.append(...[].concat(extra).filter(Boolean));
    if (onDelete) r.append(iconButton('x', `Delete ${text}`, (e) => {
      e.stopPropagation();
      onDelete();
    }, { className: 'small ap-del' }));
    r.addEventListener('click', () => this.pick(id));
    r.addEventListener('keydown', (e) => {
      if (e.target !== r) return;
      const rows = [...this.list.querySelectorAll('.ap-row')];
      const i = rows.indexOf(r);
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.altKey && onMove) {
        e.preventDefault();
        e.stopPropagation();
        onMove(e.key === 'ArrowUp' ? 1 : -1);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && disclosure != null) {
        e.preventDefault();
        e.stopPropagation();
        if (disclosure !== (e.key === 'ArrowRight')) onToggle?.();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        onActivate?.(r);
      } else if (e.key === ' ' && onEye) {
        e.preventDefault();
        e.stopPropagation();
        onEye();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && onDelete) {
        e.preventDefault();
        e.stopPropagation();
        onDelete();
      }
    });
    return r;
  }

  /** An item value across the owners: the value, or 'mixed'. */
  itemValue(st, i, fn) {
    if (!st.owners.length) return fn(st.pseudo, st.items[i]);
    const vals = st.owners.map((n) => fn(n, stackItems(n)[i]));
    const first = JSON.stringify(vals[0] ?? null);
    return vals.every((v) => JSON.stringify(v ?? null) === first) ? vals[0] ?? null : 'mixed';
  }

  /** Opacity and blending of one item in a popover. */
  openItemOpacity(anchor, i) {
    const ed = this.app.editor;
    const st = this.stack();
    if (!ed || !st?.owners.length) return;
    const it = st.items[i];
    const key = gestureKey('ap-item-opacity');
    const op = numberField({ label: 'Opacity', kind: 'percent', value: (it.opacity ?? 1) * 100, min: 0, max: 100, width: '72px', onCommit: (v) => setItemAttrs(ed, i, { opacity: v / 100 }, 'Item Opacity', key) });
    const mode = selectField('Blending mode', BLEND_MODES.map((m) => ({ value: m, label: BLEND_LABELS[m] || m })), it.blendMode || 'normal', (v) => setItemAttrs(ed, i, { blendMode: v }, 'Item Blending Mode'));
    openPopover(anchor, h('div.ap-item-opacity', h('h3.popover-title', `${it.type === 'fill' ? 'Fill' : 'Stroke'} Opacity`), op.el, mode.el), { label: 'Item opacity' });
  }

  /** Rows of one fill or stroke item (and, when expanded, its effects and opacity). */
  paintRows(st, i, rows) {
    const app = this.app;
    const ed = app.editor;
    const it = st.items[i];
    const type = it.type;
    const name = type === 'fill' ? 'Fill' : 'Stroke';
    const paint = this.itemValue(st, i, (n, x) => itemPaint(n, x));
    const owned = st.owners.length > 0;
    const id = `item:${i}`;
    const target = () => {
      if (this.selectedRow !== id && this.rowItem() !== i) this.pick(id);
      else if (owned) setAppearanceTarget(ed, i);
      ed.focusPaint = type;
      ed.emit('style');
    };
    const sw = paintSwatch(paint === 'mixed' ? null : paint, { mixed: paint === 'mixed' });
    const swBtn = h('button.swatch-btn.small', { type: 'button', 'aria-label': `${name} color`, 'aria-haspopup': 'dialog', onclick: (e) => {
      e.stopPropagation();
      const anchor = e.currentTarget;
      target();
      openPaintPopover(app, anchor.isConnected ? anchor : this.el, type);
    } }, sw);
    const extra = [];
    if (type === 'stroke' && paint) {
      const w = this.itemValue(st, i, (n, x) => itemStrokeAttrs(n, x).strokeWidth ?? 0);
      const field = numberField({
        label: 'Stroke weight',
        ariaLabel: `${name} weight`,
        value: w === 'mixed' ? 'mixed' : w,
        min: 0,
        width: '64px',
        unit: ed.doc.root.units,
        onCommit: (v, o) => {
          if (!o?.live) this.wkey = gestureKey('ap-weight');
          if (owned) setItemAttrs(ed, i, { strokeWidth: v }, 'Stroke Weight', this.wkey);
          else applyStyle(ed, { strokeWidth: v }, 'Stroke Weight', this.wkey);
        },
      });
      field.el.querySelector('label').textContent = '';
      extra.push(field.el);
    }
    const fxCount = it.effects?.length || 0;
    const op = it.opacity ?? 1;
    const open = this.expanded.has(i);
    if (!open && (fxCount || op !== 1 || (it.blendMode && it.blendMode !== 'normal'))) extra.push(h('span.ap-badge', { 'aria-hidden': 'true', 'data-tip': 'Has its own effects or opacity' }, icon('fx', 12)));
    const label = h('button.link-label', { type: 'button', onclick: (e) => {
      e.stopPropagation();
      target();
      if (type === 'stroke') app.openPanel('stroke');
      else app.openPanel('color');
    } }, `${name}:`);
    const remove = owned ? () => this.removeRow(i) : paint ? () => applyStyle(ed, { [type]: null }, `Delete ${name}`) : null;
    rows.push(
      this.row({
        id,
        label,
        swatch: swBtn,
        extra,
        eye: owned ? !it.hidden : null,
        eyeLabel: it.hidden ? `Show ${name}` : `Hide ${name}`,
        hiddenFx: Boolean(it.hidden),
        onEye: owned ? () => toggleItem(ed, i) : null,
        onActivate: () => swBtn.click(),
        onDelete: remove,
        disclosure: owned ? open : null,
        onToggle: () => this.toggleOpen(i),
        onMove: owned ? (dir) => this.moveStackItem(i, dir) : null,
      }),
    );
    if (owned) this.dragRow(rows[rows.length - 1], `item:${i}`, (from, after) => this.dropItem(from, i, after));
    if (!open || !owned) return;
    (it.effects || []).forEach((fx, j) => {
      const fid = `item:${i}:fx:${j}`;
      const lbl = h('button.link-label', { type: 'button', onclick: (e) => {
        e.stopPropagation();
        this.selectedRow = fid;
        this.editItemEffect(i, j);
      } }, effectLabel(fx));
      rows.push(
        this.row({
          id: fid,
          level: 2,
          label: lbl,
          swatch: h('span.ap-fx', { 'aria-hidden': 'true' }, icon('fx', 14)),
          eye: !fx.hidden,
          eyeLabel: fx.hidden ? 'Show effect' : 'Hide effect',
          hiddenFx: Boolean(fx.hidden),
          onEye: () => this.setItemEffects(i, (list) => list.map((e, k) => (k === j ? toggleHidden(e) : e)), fx.hidden ? 'Show Effect' : 'Hide Effect'),
          onActivate: () => this.editItemEffect(i, j),
          onDelete: () => this.setItemEffects(i, (list) => list.filter((_, k) => k !== j), 'Delete Effect'),
        }),
      );
    });
    const bm = it.blendMode || 'normal';
    const opText = `Opacity: ${op === 1 ? 'Default' : `${Math.round(op * 100)}%`}${bm !== 'normal' ? ` ${BLEND_LABELS[bm] || bm}` : ''}`;
    const oid = `item:${i}:opacity`;
    const olbl = h('button.link-label', { type: 'button', onclick: (e) => {
      e.stopPropagation();
      this.selectedRow = oid;
      this.openItemOpacity(e.currentTarget, i);
    } }, opText);
    rows.push(this.row({ id: oid, level: 2, label: olbl, onActivate: (r) => this.openItemOpacity(r, i) }));
  }

  toggleOpen(i) {
    if (this.expanded.has(i)) this.expanded.delete(i);
    else this.expanded.add(i);
    this.update(true);
    this.list.querySelector(`[data-row="item:${i}"]`)?.focus();
  }

  removeRow(i) {
    removeItem(this.app.editor, i);
    this.expanded = new Set([...this.expanded].filter((k) => k !== i).map((k) => (k > i ? k - 1 : k)));
    this.selectedRow = null;
  }

  /** A stack item row dropped on item `to`'s row (above it, or below with `after`). */
  dropItem(from, to, after) {
    const f = this.rowItem(from);
    if (f == null) return;
    // Rows list the top of the stack first: above a row is later in paint order.
    let at = after ? to : to + 1;
    if (f < at) at--;
    if (at === f) return;
    moveItem(this.app.editor, f, at);
    this.expanded.clear();
    this.selectedRow = `item:${at}`;
  }

  contentsRow(st, i, rows) {
    const ed = this.app.editor;
    const it = st.items[i];
    const owner = st.owners[0];
    const label = owner?.type === 'text' ? 'Characters' : 'Contents';
    rows.push(
      this.row({
        id: `item:${i}`,
        label,
        eye: st.owners.length ? !it.hidden : null,
        eyeLabel: it.hidden ? `Show ${label}` : `Hide ${label}`,
        hiddenFx: Boolean(it.hidden),
        onEye: () => toggleItem(ed, i),
        // Contents: the group's (or layer's) objects become the selection.
        onActivate: () => {
          if (owner && (owner.type === 'group' || owner.type === 'layer') && st.owners.length === 1) ed.select(owner.children.filter((c) => !ed.doc.get(c)?.hidden && !ed.doc.get(c)?.locked));
        },
        onMove: st.owners.length ? (dir) => this.moveStackItem(i, dir) : null,
      }),
    );
    if (st.owners.length) this.dragRow(rows[rows.length - 1], `item:${i}`, (from, after) => this.dropItem(from, i, after));
  }

  update(force = false) {
    const ed = this.app.editor;
    this.el.classList.toggle('disabled', !ed);
    if (!ed) {
      this.list.replaceChildren();
      return;
    }
    const app = this.app;
    const t = this.targets();
    const owners = appearanceOwners(ed);
    const st = this.stack();
    const ownerKey = owners.map((n) => n.id).join(',');
    if (ownerKey !== this.ownerKey) {
      // Another selection: start from its own target (none picked, nothing expanded).
      this.ownerKey = ownerKey;
      this.expanded.clear();
      if (this.selectedRow != null && typeof this.selectedRow !== 'number') this.selectedRow = null;
    }
    const { effects, mixed } = this.sharedEffects();
    const op = t.length ? (t.every((n) => (n.opacity ?? 1) === (t[0].opacity ?? 1)) ? t[0].opacity ?? 1 : 'mixed') : ed.style.opacity ?? 1;
    const bm = t.length ? (t.every((n) => (n.blendMode || 'normal') === (t[0].blendMode || 'normal')) ? t[0].blendMode || 'normal' : 'mixed') : ed.style.blendMode || 'normal';
    const stackKey = st ? (st.owners.length ? st.owners.map((n) => [n.id, n.appearance, n.fill, n.stroke, pickStroke(n)]) : [st.pseudo.fill, st.pseudo.stroke, st.pseudo.strokeWidth, st.same]) : null;
    const key = JSON.stringify([ownerKey, stackKey, st?.same, effects, mixed, op, bm, this.selectedRow, [...this.expanded], ed.focusPaint, ed.doc.root.units, t.map((n) => n.graphicStyle), ed.doc.root.graphicStyles?.length]);
    if (!force && key === this.renderKey) return;
    this.renderKey = key;
    const layerTarget = owners.length === 1 && owners[0].type === 'layer';
    this.kind.textContent = layerTarget ? 'Layer' : t.length ? selectionKind(ed) : 'No Selection';
    const gs = this.linkedStyle();
    this.styleName.textContent = gs ? gs.name : '';
    this.styleName.hidden = !gs;
    const tctx = this.thumb.getContext('2d');
    if (tctx) {
      tctx.clearRect(0, 0, 32, 32);
      if (t.length === 1) drawThumbnail(tctx, ed.doc, t[0], 32, 2);
    }
    const rows = [];
    if (st && st.same) {
      for (let i = st.items.length - 1; i >= 0; i--) {
        const it = st.items[i];
        if (it.type === 'contents') this.contentsRow(st, i, rows);
        else if (it.type === 'fill' || it.type === 'stroke') this.paintRows(st, i, rows);
      }
    } else if (st) rows.push(h('p.ap-mixed.muted', 'Mixed Appearances'));
    if (mixed) rows.push(h('p.ap-mixed.muted', 'Mixed Effects'));
    effects.forEach((fx, i) => {
      const lbl = h('button.link-label', { type: 'button', onclick: (e) => {
        e.stopPropagation();
        this.selectedRow = i;
        this.editEffect(i);
      } }, effectLabel(fx));
      rows.push(
        this.row({
          id: i,
          label: lbl,
          swatch: h('span.ap-fx', { 'aria-hidden': 'true' }, icon('fx', 14)),
          eye: !fx.hidden,
          eyeLabel: fx.hidden ? 'Show effect' : 'Hide effect',
          hiddenFx: Boolean(fx.hidden),
          onEye: () => this.setEffects((list) => list.map((e, j) => (j === i ? toggleHidden(e) : e)), fx.hidden ? 'Show Effect' : 'Hide Effect'),
          onActivate: () => this.editEffect(i),
          onDelete: () => this.setEffects((list) => list.filter((_, j) => j !== i), 'Delete Effect'),
          onMove: effects.length > 1 ? (dir) => this.moveEffect(i, -dir) : null,
        }),
      );
      this.draggable(rows[rows.length - 1], i, effects.length);
    });
    const opText = `Opacity: ${op === 'mixed' ? 'Mixed' : op === 1 ? 'Default' : `${Math.round(op * 100)}%`}${bm !== 'normal' && bm !== 'mixed' ? ` ${BLEND_LABELS[bm] || bm}` : ''}`;
    rows.push(this.row({ id: 'opacity', label: h('button.link-label', { type: 'button', onclick: (e) => {
      e.stopPropagation();
      app.openPanel('transparency');
    } }, opText), onActivate: () => app.openPanel('transparency') }));
    const focused = this.list.contains(document.activeElement) ? document.activeElement.closest?.('.ap-row')?.dataset.row : null;
    this.list.replaceChildren(...rows);
    if (focused) this.list.querySelector(`[data-row="${CSS.escape(focused)}"]`)?.focus();
    this.dupBtn.disabled = !this.canDuplicate();
    this.delBtn.disabled = !this.canRemove();
  }

  /** Object effect i one place later (+1) or earlier (-1) in the effect order. */
  moveEffect(i, dir) {
    const j = i + dir;
    this.setEffects((list) => {
      if (j < 0 || j >= list.length) return list;
      const out = list.slice();
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    }, 'Reorder Effects');
    this.selectedRow = Math.max(0, j);
  }
}

/** A node's own stroke options (for change detection). */
function pickStroke(n) {
  return [n.strokeWidth, n.strokeCap, n.strokeJoin, n.dash, n.strokeAlign, n.hidden];
}

function toggleHidden(e) {
  const out = { ...e };
  if (out.hidden) delete out.hidden;
  else out.hidden = true;
  return out;
}

// ---- Graphic Styles ----

const previewShape = (() => {
  let node = null;
  return (style) => {
    if (!node) node = createPath(rectangle(4, 4, 40, 40, 0), true);
    return { ...node, ...style, id: 'gs-preview' };
  };
})();

/** A canvas preview of a style on a square. */
export function styleThumb(style, size = 48) {
  const c = h('canvas', { width: size, height: size, 'aria-hidden': 'true' });
  const node = previewShape(style);
  const ctx = c.getContext('2d');
  if (ctx) drawThumbnail(ctx, standaloneDoc([node]), node, size, Math.round(size / 8));
  return c;
}

export const GRAPHIC_STYLE_VIEWS = [
  { id: 'thumbnail', label: 'Thumbnail View' },
  { id: 'smallList', label: 'Small List View' },
  { id: 'largeList', label: 'Large List View' },
];

const GS_FORMAT = 'vector-studio-graphic-styles';

/** Menu spec for opening graphic style libraries (built-in, user defined, from a file). */
export function graphicStyleLibraryMenu(app, open) {
  return [
    ...graphicStyleLibraries().map((lib) => ({ label: lib.name, run: () => open(lib) })),
    '-',
    { label: 'User Defined', submenu: userLibraryMenu(app, 'graphicStyles', (l) => open({ id: l.id, name: l.name, styles: l.items })) },
    { label: 'Other Library...', run: () => importGraphicStyleLibrary(app).then((lib) => lib && open(lib)) },
  ];
}

async function importGraphicStyleLibrary(app) {
  const file = await pickTextFile('.json,application/json');
  if (!file) return null;
  try {
    const data = JSON.parse(file.text);
    const list = (Array.isArray(data.styles) ? data.styles : Array.isArray(data.items) ? data.items : []).filter((s) => s && typeof s.style === 'object');
    if (list.length) return { id: `file-${data.name || file.name}`, name: String(data.name || file.name.replace(/\.[^.]+$/, '')), styles: list.map((s) => ({ id: newStyleId(), name: String(s.name || 'Graphic Style'), style: s.style })) };
  } catch {
    // Not JSON: reported below.
  }
  app.notify('That file has no graphic styles this app can read.');
  return null;
}

export class GraphicStylesPanel extends Panel {
  static id = 'graphicStyles';
  static title = 'Graphic Styles';
  static icon = 'graphic-styles';
  static placement = 'strip';
  static shortcut = 'Shift+F5';

  build() {
    const app = this.app;
    /** The style last clicked (used by the symbol styler too) and the multi-selection. */
    this.selected = null;
    this.picked = new Set();
    this.view = GRAPHIC_STYLE_VIEWS.some((v) => v.id === app.prefs.get('graphicStylesView')) ? app.prefs.get('graphicStylesView') : 'thumbnail';
    this.grid = h('div.gst-grid', { role: 'listbox', 'aria-label': 'Graphic styles', 'aria-multiselectable': 'true' });
    this.grid.addEventListener('keydown', (e) => this.onKey(e));
    const btn = (ic, label, fn) => iconButton(ic, label, fn, { className: 'small' });
    this.libBtn = btn('library', 'Graphic Style Libraries Menu', (e) => app.showMenuAt(e.currentTarget, graphicStyleLibraryMenu(app, (lib) => this.openLibrary(lib)), 'Graphic style libraries'));
    this.libBtn.setAttribute('aria-haspopup', 'menu');
    this.breakBtn = btn('unlink', 'Break Link to Graphic Style', () => this.breakLink());
    this.footer = h(
      'div.ap-footer',
      this.libBtn,
      h('span.sw-spacer'),
      this.breakBtn,
      btn('plus', 'New Graphic Style', () => this.newStyle()),
      (this.delBtn = btn('trash', 'Delete Graphic Style', () => this.deleteSelected())),
    );
    this.el.append(this.grid, this.footer);
  }

  ids() {
    const ed = this.app.editor;
    if (!ed) return [];
    const valid = new Set(graphicStylesOf(ed.doc).map((g) => g.id));
    return [...this.picked].filter((id) => valid.has(id));
  }

  setView(v) {
    this.view = v;
    this.app.prefs.set('graphicStylesView', v);
    this.lastList = null;
    this.update();
  }

  /** Objects in the selection linked to a graphic style. */
  linkedTargets() {
    const ed = this.app.editor;
    if (!ed) return [];
    return ed.topSelection().map((id) => ed.doc.get(id)).filter((n) => n && linkedStyle(ed.doc, n));
  }

  menu() {
    const app = this.app;
    const ed = app.editor;
    const ids = this.ids();
    const has = Boolean(ed);
    const sel = ed ? ed.topSelection().length : 0;
    return [
      { label: 'New Graphic Style...', enabled: has, run: () => this.newStyle() },
      { label: 'Duplicate Graphic Style', enabled: ids.length > 0, run: () => this.duplicateSelected() },
      { label: 'Merge Graphic Styles', enabled: ids.length > 1, run: () => this.mergeSelected() },
      { label: 'Delete Graphic Style', enabled: ids.length > 0, run: () => this.deleteSelected() },
      '-',
      { label: 'Break Link to Graphic Style', enabled: this.linkedTargets().length > 0, run: () => this.breakLink() },
      { label: 'Redefine Graphic Style', enabled: ids.length === 1 && sel === 1, run: () => redefineGraphicStyle(app, ids[0]) },
      '-',
      { label: 'Override Character Color', checked: overridesCharColor(app.prefs), run: () => app.prefs.set(OVERRIDE_CHAR_COLOR, !overridesCharColor(app.prefs)) },
      '-',
      { label: 'Select All Unused', enabled: has, run: () => this.selectUnused() },
      { label: 'Sort by Name', enabled: has, run: () => this.sortByName() },
      '-',
      ...GRAPHIC_STYLE_VIEWS.map((v) => ({ label: v.label, checked: this.view === v.id, run: () => this.setView(v.id) })),
      '-',
      { label: 'Graphic Style Options...', enabled: ids.length === 1, run: () => this.rename(graphicStylesOf(ed.doc).find((g) => g.id === ids[0])) },
      '-',
      { label: 'Open Graphic Style Library', submenu: graphicStyleLibraryMenu(app, (lib) => this.openLibrary(lib)) },
      { label: 'Save Graphic Style Library...', enabled: has, run: () => this.saveLibrary() },
      { label: 'Export Graphic Style Library...', enabled: has, run: () => exportLibraryFile(GS_FORMAT, 'Graphic Styles', this.libraryItems(), 'styles') },
    ];
  }

  libraryItems() {
    const doc = this.app.editor.doc;
    const ids = new Set(this.ids());
    const list = graphicStylesOf(doc);
    return (ids.size ? list.filter((g) => ids.has(g.id)) : list).map((g) => ({ name: g.name, style: structuredClone(g.style) }));
  }

  saveLibrary() {
    return saveLibraryDialog(this.app, 'graphicStyles', { title: 'Save Graphic Style Library', items: this.libraryItems(), defaultName: 'My Graphic Styles' });
  }

  update() {
    const ed = this.app.editor;
    this.el.classList.toggle('disabled', !ed);
    if (!ed) {
      this.grid.replaceChildren();
      return;
    }
    const list = graphicStylesOf(ed.doc);
    const linked = this.linkedTargets();
    this.breakBtn.disabled = !linked.length;
    const key = [...this.picked].join() + this.view;
    if (list === this.lastList && key === this.lastKey) return;
    this.lastList = list;
    this.lastKey = key;
    for (const id of [...this.picked]) if (!list.some((g) => g.id === id)) this.picked.delete(id);
    const listView = this.view !== 'thumbnail';
    this.grid.className = `gst-grid view-${this.view}`;
    const size = this.view === 'smallList' ? 20 : this.view === 'largeList' ? 40 : 48;
    const focus = list.find((g) => g.id === this.selected) || list[0];
    this.grid.replaceChildren(
      ...list.map((gs) =>
        h(
          'button.gst-item',
          {
            type: 'button',
            role: 'option',
            tabindex: gs === focus ? '0' : '-1',
            'aria-selected': String(this.picked.has(gs.id)),
            'aria-label': gs.name,
            'data-tip': listView ? null : `${gs.name} (Alt+click to add to the appearance)`,
            'data-id': gs.id,
            onclick: (e) => this.onClick(gs, e),
            ondblclick: () => this.rename(gs),
          },
          styleThumb(gs.style, size),
          listView ? h('span.gst-name', gs.name) : null,
        ),
      ),
    );
    if (!list.length) this.grid.append(h('p.panel-empty', 'No graphic styles. Select styled artwork and choose New Graphic Style.'));
    this.delBtn.disabled = !this.picked.size;
  }

  onClick(gs, e) {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      if (e.shiftKey && this.selected) {
        const list = graphicStylesOf(this.app.editor.doc);
        const a = list.findIndex((g) => g.id === this.selected);
        const b = list.findIndex((g) => g.id === gs.id);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 0) this.picked.add(list[i].id);
      } else if (this.picked.has(gs.id)) this.picked.delete(gs.id);
      else this.picked.add(gs.id);
      this.selected = gs.id;
      this.update();
      return;
    }
    this.selected = gs.id;
    this.picked = new Set([gs.id]);
    this.apply(gs, e.altKey);
    this.update();
    this.grid.querySelector(`[data-id="${CSS.escape(gs.id)}"]`)?.focus();
  }

  /** Apply a style to the selection; `add` merges it into the current appearance instead. */
  apply(gs, add = false) {
    const ed = this.app.editor;
    if (!ed) return;
    if (!add) return applyGraphicStyle(ed, gs.style, gs.id);
    const top = ed.topSelection().map((id) => ed.doc.get(id)).filter((n) => n && n.type !== 'layer');
    if (!top.length) return applyGraphicStyle(ed, mergeStyles([ed.style, gs.style]));
    ed.doc.transact('Add Graphic Style', () => {
      for (const n of top) applyStyleTo(ed.doc, [ed.doc.get(n.id)], mergeStyles([styleOfNode(ed.doc, n), gs.style]), null, { keepCharColor: !overridesCharColor(this.app.prefs) });
    });
  }

  onKey(e) {
    const items = [...this.grid.querySelectorAll('[data-id]')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = this.view === 'thumbnail' ? Math.max(1, Math.floor((this.grid.clientWidth + 4) / 52)) : 1;
    let j = null;
    if (e.key === 'ArrowRight') j = i + 1;
    else if (e.key === 'ArrowLeft') j = i - 1;
    else if (e.key === 'ArrowDown') j = i + cols;
    else if (e.key === 'ArrowUp') j = i - cols;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      const gs = graphicStylesOf(this.app.editor.doc).find((g) => g.id === items[i].dataset.id);
      if (gs) this.onClick(gs, { altKey: e.altKey });
    } else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelected();
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (j == null) return;
    const t = items[Math.max(0, Math.min(items.length - 1, j))];
    items.forEach((x) => (x.tabIndex = -1));
    t.tabIndex = 0;
    t.focus();
    this.selected = t.dataset.id;
  }

  setList(label, list) {
    const ed = this.app.editor;
    ed.doc.transact(label, () => setGraphicStyles(ed.doc, list));
  }

  async newStyle() {
    const ed = this.app.editor;
    if (!ed) return;
    const top = ed.topSelection().map((id) => ed.doc.get(id)).filter(Boolean);
    const style = top.length ? styleOfNode(ed.doc, top[0]) : structuredClone(ed.style);
    const list = graphicStylesOf(ed.doc);
    const res = await this.app.dialogs.form({ title: 'Graphic Style Options', fields: [{ key: 'name', label: 'Style Name', type: 'text', value: `Graphic Style ${list.length + 1}` }] });
    if (!res) return;
    const gs = { id: newStyleId(), name: res.name.trim() || `Graphic Style ${list.length + 1}`, style };
    ed.doc.transact('New Graphic Style', () => {
      setGraphicStyles(ed.doc, [...list, gs]);
      // The object the style came from is linked to it.
      for (const n of top.slice(0, 1)) if (n.type !== 'layer') ed.doc.update(n.id, { graphicStyle: gs.id });
    });
    this.selected = gs.id;
    this.picked = new Set([gs.id]);
  }

  duplicateSelected() {
    const ed = this.app.editor;
    const ids = new Set(this.ids());
    if (!ed || !ids.size) return;
    const out = [];
    const fresh = [];
    for (const g of graphicStylesOf(ed.doc)) {
      out.push(g);
      if (!ids.has(g.id)) continue;
      const copy = { ...structuredClone(g), id: newStyleId(), name: `${g.name} copy` };
      out.push(copy);
      fresh.push(copy.id);
    }
    this.setList('Duplicate Graphic Style', out);
    this.picked = new Set(fresh);
    this.selected = fresh[0];
  }

  async mergeSelected() {
    const ed = this.app.editor;
    const ids = this.ids();
    if (!ed || ids.length < 2) return;
    const list = graphicStylesOf(ed.doc);
    const styles = list.filter((g) => ids.includes(g.id));
    const res = await this.app.dialogs.form({ title: 'Graphic Style Options', fields: [{ key: 'name', label: 'Style Name', type: 'text', value: styles.map((g) => g.name).join(' + ').slice(0, 60) }] });
    if (!res) return;
    const gs = { id: newStyleId(), name: res.name.trim() || 'Merged Style', style: mergeStyles(styles.map((g) => g.style)) };
    this.setList('Merge Graphic Styles', [...list, gs]);
    this.picked = new Set([gs.id]);
    this.selected = gs.id;
  }

  breakLink() {
    const ed = this.app.editor;
    const t = this.linkedTargets();
    if (!ed || !t.length) return;
    ed.doc.transact('Break Link to Graphic Style', () => t.forEach((n) => ed.doc.update(n.id, { graphicStyle: undefined })));
  }

  selectUnused() {
    const ed = this.app.editor;
    if (!ed) return;
    const ids = unusedGraphicStyleIds(ed.doc);
    this.picked = new Set(ids);
    this.selected = ids[0] || null;
    this.lastList = null;
    this.update();
    this.app.notify(ids.length ? `Selected ${ids.length} unused graphic ${ids.length === 1 ? 'style' : 'styles'}.` : 'Every graphic style is in use.', { polite: true });
  }

  sortByName() {
    const ed = this.app.editor;
    if (ed) this.setList('Sort Graphic Styles', sortStylesByName(graphicStylesOf(ed.doc)));
  }

  async rename(gs) {
    const ed = this.app.editor;
    if (!gs || !ed) return;
    const res = await this.app.dialogs.form({ title: 'Graphic Style Options', fields: [{ key: 'name', label: 'Style Name', type: 'text', value: gs.name }] });
    if (!res || !res.name.trim()) return;
    this.setList('Rename Graphic Style', graphicStylesOf(ed.doc).map((x) => (x.id === gs.id ? { ...x, name: res.name.trim() } : x)));
  }

  async deleteSelected() {
    const ed = this.app.editor;
    const ids = new Set(this.ids());
    if (!ed || !ids.size) return;
    const ok = await this.app.dialogs.confirm({ title: 'Delete Graphic Style', message: ids.size === 1 ? 'Delete the graphic style selection?' : `Delete ${ids.size} graphic styles?`, okLabel: 'Delete', danger: true });
    if (!ok) return;
    this.setList('Delete Graphic Style', graphicStylesOf(ed.doc).filter((x) => !ids.has(x.id)));
    this.picked.clear();
    this.selected = null;
  }

  /** A library's styles in a popover: click one to apply it (and add it to the document). */
  openLibrary(lib) {
    const app = this.app;
    const add = (items) => {
      const ed = app.editor;
      if (!ed) return [];
      const list = graphicStylesOf(ed.doc);
      const out = [];
      const next = list.slice();
      for (const s of items) {
        const existing = next.find((g) => g.name === s.name && JSON.stringify(g.style) === JSON.stringify(s.style));
        if (existing) out.push(existing);
        else {
          const gs = { id: newStyleId(), name: s.name, style: structuredClone(s.style) };
          next.push(gs);
          out.push(gs);
        }
      }
      if (next.length !== list.length) ed.doc.transact('Add Graphic Styles', () => setGraphicStyles(ed.doc, next));
      return out;
    };
    const grid = h('div.gst-grid.gst-lib-grid', { role: 'listbox', 'aria-label': `${lib.name} graphic styles` });
    for (const s of lib.styles) {
      grid.append(
        h('button.gst-item', {
          type: 'button',
          role: 'option',
          'aria-label': s.name,
          'data-tip': s.name,
          onclick: () => {
            const [gs] = add([s]);
            if (gs && app.editor) applyGraphicStyle(app.editor, gs.style, gs.id);
          },
        }, styleThumb(s.style, 48)),
      );
    }
    const addAll = h('button.btn.small', { type: 'button', onclick: () => {
      add(lib.styles);
      closePopover();
      app.notify(`Added ${lib.name} to Graphic Styles.`, { polite: true });
    } }, 'Add All to Graphic Styles');
    openPopover(this.libBtn.isConnected ? this.libBtn : this.el, h('div.gst-lib', h('h3.popover-title', lib.name), grid, h('div.popover-actions', addAll)), { label: `${lib.name} graphic style library` });
  }
}

/**
 * Redefine a style from the selected object's appearance; objects linked
 * to the style take the new appearance in the same undo step.
 */
export function redefineGraphicStyle(app, id) {
  const ed = app.editor;
  const node = ed && ed.topSelection().map((nid) => ed.doc.get(nid)).find((n) => n && n.type !== 'layer');
  if (!node) return;
  const doc = ed.doc;
  const users = styleUsers(doc, id).filter((n) => n.id !== node.id);
  const style = styleOfNode(doc, node);
  doc.transact('Redefine Graphic Style', () => {
    setGraphicStyles(doc, graphicStylesOf(doc).map((g) => (g.id === id ? { ...g, style } : g)));
    applyStyleTo(doc, users.map((n) => doc.get(n.id)), style, id);
    doc.update(node.id, { graphicStyle: id });
  });
  app.notify(`Redefined "${graphicStylesOf(doc).find((g) => g.id === id)?.name}"${users.length ? ` and ${users.length} linked ${users.length === 1 ? 'object' : 'objects'}` : ''}.`, { polite: true });
}
