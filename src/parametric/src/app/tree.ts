// FeatureManager design tree: part, material, default planes, origin and the
// feature history with absorbed sketches, error badges, rename, context
// menus, keyboard navigation and a draggable rollback bar.

import type { Feature, Id } from '../model/types';
import { consumedSketches, featureIcon } from '../model/features';
import { BASE_PLANE_ALIASES, BASE_PLANE_NAMES } from '../model/planes';
import type { BasePlane } from '../model/types';
import { h, titleWhenClipped } from '../ui/dom';
import { icon } from '../ui/icons';
import type { App } from './app';
import type { SelItem } from './selection';
import { sheetMetalTreeRows } from './sheetmetal-panels';

interface Row {
  key: string;
  item: SelItem | null;
  label: string;
  icon: string;
  depth: number;
  feature?: Feature;
  children?: boolean;
  expanded?: boolean;
  muted?: string;
  action?: () => void;
}

export class FeatureTree {
  el: HTMLElement;
  private list: HTMLElement;
  private filter = '';
  private expanded = new Set<Id>();
  private focusKey: string | null = null;
  private renaming: Id | null = null;
  private renameEl: HTMLInputElement | null = null;
  private rendering = false;
  private draggingBar = false;
  /** The rows last drawn, and the row a Shift range selection starts from. */
  private shown: Row[] = [];
  private anchor: string | null = null;
  /** Said when the filter matches no feature or plane (only the part row is left). */
  private noMatch = h('div', { class: 'pm-msg info', role: 'status', style: { margin: '0 8px 4px' }, hidden: true }, 'Nothing in the design tree matches the filter.');

  constructor(private app: App, flyout = false) {
    const filterInput = h('input', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter the design tree' }) as HTMLInputElement;
    filterInput.addEventListener('input', () => { this.filter = filterInput.value.trim().toLowerCase(); this.render(); });
    // Down from the filter goes to the first row it matches (the part row stays first).
    filterInput.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' || e.isComposing) return;
      const rows = [...this.list.querySelectorAll<HTMLElement>('.ti')];
      const target = (this.filter ? rows[1] : null) ?? rows[0];
      if (!target) return;
      e.preventDefault();
      this.focus(target.dataset.key!);
    });
    this.list = h('div', { class: 'tree', role: 'tree', 'aria-label': 'Design tree', 'aria-multiselectable': 'true' });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    if (flyout) this.list.setAttribute('aria-label', 'Design tree (flyout)');
    this.el = flyout ? h('div', {}, this.list) : h('div', {}, h('div', { class: 'tree-filter' }, icon('search', 14), filterInput), this.noMatch, this.list);
  }

  private rows(): Row[] {
    const app = this.app;
    const doc = app.store.doc;
    const rows: Row[] = [];
    rows.push({ key: 'part', item: null, label: doc.name, icon: 'part', depth: 0 });
    rows.push({
      key: 'material', item: null, label: doc.material ? doc.material.name : 'Material', muted: doc.material ? '' : ' <not specified>', icon: 'material', depth: 1,
      action: () => app.commands.run('material'),
    });
    for (const k of ['front', 'top', 'right'] as BasePlane[]) rows.push({ key: `plane:${k}`, item: { kind: 'plane', ref: { kind: 'base', plane: k } }, label: BASE_PLANE_NAMES[k], icon: 'plane', depth: 1 });
    rows.push({ key: 'origin', item: { kind: 'origin' }, label: 'Origin', icon: 'origin', depth: 1 });
    rows.push(...sheetMetalTreeRows(app));
    const consumedBy = new Map<Id, Id>();
    for (const f of doc.features) for (const s of consumedSketches(f)) if (!consumedBy.has(s)) consumedBy.set(s, f.id);
    for (const f of doc.features) {
      if (f.type === 'sketch' && consumedBy.has(f.id)) {
        const owner = doc.features.find((x) => x.id === consumedBy.get(f.id));
        // Show absorbed sketches only under their (later) owner.
        if (owner && doc.features.indexOf(owner) > doc.features.indexOf(f)) continue;
      }
      const kids = consumedSketches(f).map((id) => doc.features.find((x) => x.id === id)).filter((x): x is Feature => !!x && x.type === 'sketch' && doc.features.indexOf(x) < doc.features.indexOf(f));
      const expanded = this.expanded.has(f.id);
      rows.push({ key: f.id, item: { kind: 'feature', id: f.id }, label: f.name, icon: featureIcon(f), depth: 1, feature: f, children: kids.length > 0, expanded });
      // A filter also searches the sketches nested under collapsed features.
      if (expanded || this.filter) for (const k of kids) rows.push({ key: k.id, item: { kind: 'feature', id: k.id }, label: k.name, icon: featureIcon(k), depth: 2, feature: k });
    }
    if (!this.filter) return rows;
    return rows.filter((r) => r.depth === 0 || r.label.toLowerCase().includes(this.filter));
  }

  render() {
    const app = this.app;
    const doc = app.store.doc;
    const built = app.store.builtCount;
    const rows = this.rows();
    this.shown = rows;
    const sel = app.selection;
    // Rows are rebuilt; keyboard focus inside the tree moves to the new rows.
    const active = document.activeElement;
    const hadFocus = !!active && this.list.contains(active);
    const barFocused = hadFocus && active.classList.contains('rollback-bar');
    const tabKey = this.focusKey && rows.some((r) => r.key === this.focusKey) ? this.focusKey : 'part';
    this.rendering = true;
    this.list.textContent = '';
    this.rendering = false;
    let rollbackPlaced = false;
    const editingId = app.editingFeatureId;
    for (const r of rows) {
      const f = r.feature;
      const index = f ? doc.features.indexOf(f) : -1;
      // Rollback bar sits after the last built top-level feature.
      if (f && r.depth === 1 && !rollbackPlaced && index >= built) {
        this.list.append(this.rollbackBar());
        rollbackPlaced = true;
      }
      const status = f ? app.featureStatus(f.id) : null;
      const selected = r.item ? sel.has(r.item) : false;
      const el = h('div', {
        class: `ti${f?.suppressed || status?.suppressed ? ' suppressed' : ''}${f && index >= built ? ' rolled' : ''}${status && !status.ok ? ' error' : ''}${editingId === f?.id ? ' editing' : ''}`,
        role: 'treeitem',
        tabindex: r.key === tabKey ? '0' : '-1',
        'aria-selected': r.item ? String(selected) : null,
        'aria-level': String(r.depth + 1),
        'aria-expanded': r.children ? String(!!r.expanded) : null,
        'data-key': r.key,
        style: { paddingLeft: `${4 + r.depth * 14}px` },
      });
      // Expansion is announced through aria-expanded and done with the arrow keys.
      const twisty = h('span', { class: r.children ? 'twisty' : 'twisty empty', 'aria-hidden': 'true' }, r.children ? icon(r.expanded ? 'chevronDown' : 'chevronRight', 12) : null);
      twisty.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(r.key); });
      el.append(twisty, icon(r.icon, 16));
      if (this.renaming && this.renaming === f?.id) el.append(this.renameInput(f));
      else {
        const label = h('span', { class: 'label' }, r.label, r.muted ? h('span', { class: 'muted' }, r.muted) : null);
        titleWhenClipped(label);
        el.append(label);
      }
      // What grey text and badges show is told to screen readers too.
      const states: string[] = [];
      if (f?.suppressed || status?.suppressed) states.push('Suppressed');
      if (f && index >= built) states.push('Rolled back');
      if (status && !status.ok) {
        const b = h('span', { class: 'badge', title: status.error ?? 'Error' }, icon('error', 14));
        el.append(b);
        states.push(`Error: ${status.error ?? ''}`);
      } else if (f && app.featureWarning(f.id)) {
        el.append(h('span', { class: 'badge warn', title: app.featureWarning(f.id)! }, icon('warning', 14)));
        states.push(`Warning: ${app.featureWarning(f.id)}`);
      }
      if (states.length) el.setAttribute('aria-description', states.join('. '));
      el.addEventListener('click', (e) => this.onClick(r, e));
      el.addEventListener('dblclick', () => this.onDouble(r));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (r.item && !sel.has(r.item)) sel.set([r.item]);
        if (f) app.openFeatureMenu(f.id, e.clientX, e.clientY);
        else if (r.item) app.openReferenceMenu(r.item, e.clientX, e.clientY);
        // The part and Material rows have menus too (Shift+F10 on them did nothing).
        else if (r.key === 'part') app.openCommandMenu(['properties', 'rename', 'equations', 'appearance'], e.clientX, e.clientY, 'Part menu');
        else if (r.key === 'material') app.openCommandMenu(['material'], e.clientX, e.clientY, 'Material menu');
      });
      el.addEventListener('pointerenter', () => { if (r.item) sel.setHover(r.item); });
      el.addEventListener('pointerleave', () => { if (r.item) sel.setHover(null); });
      el.addEventListener('focus', () => { this.focusKey = r.key; });
      this.list.append(el);
    }
    if (!rollbackPlaced) this.list.append(this.rollbackBar());
    this.noMatch.hidden = !this.filter || rows.length > 1;
    if (hadFocus) {
      const target = this.renaming && this.renameEl?.isConnected ? this.renameEl
        : barFocused ? this.list.querySelector<HTMLElement>('.rollback-bar')
        : this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(tabKey)}"]`);
      target?.focus({ preventScroll: true });
    }
  }

  private rollbackBar(): HTMLElement {
    const bar = h('div', { class: 'rollback-bar', role: 'treeitem', tabindex: '-1', 'aria-level': '2', 'aria-label': 'Rollback bar. Drag up or down, or press Shift with the arrow keys, to roll the model back.' });
    bar.addEventListener('keydown', (e) => {
      if (!e.shiftKey) return;
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); this.app.setRollback(this.app.store.builtCount - 1); this.focusBar(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); this.app.setRollback(this.app.store.builtCount + 1); this.focusBar(); }
    });
    if (this.draggingBar) bar.classList.add('dragging');
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      this.draggingBar = true;
      // One undo step for the whole drag.
      this.app.store.beginBatch('Rollback', () => {
        this.draggingBar = false;
        this.list.querySelector('.rollback-bar')?.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      });
      // Every roll re-renders the tree and replaces this bar, so the drag
      // follows the pointer on the window rather than on the bar.
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        // Released where no pointerup arrives (outside the window, after the
        // redrawn bar lost the capture): the drag ends instead of following the pointer.
        if (e.pointerType === 'mouse' && !(ev.buttons & 1)) { this.app.store.endBatch(); return; }
        // Find the feature row under the pointer.
        const items = [...this.list.querySelectorAll<HTMLElement>('.ti[aria-level="2"]')].filter((x) => this.app.store.feature(x.dataset.key!));
        let idx = this.app.store.doc.features.length;
        for (const it of items) {
          const r = it.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) { idx = this.app.store.indexOf(it.dataset.key!); break; }
        }
        if (idx !== this.app.store.builtCount) this.app.setRollback(idx);
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        this.app.store.endBatch();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    return bar;
  }

  private focusBar() {
    requestAnimationFrame(() => this.list.querySelector<HTMLElement>('.rollback-bar')?.focus());
  }

  private renameInput(f: Feature): HTMLInputElement {
    // Re-renders during a rename (rebuilds, selection) keep the text typed so far.
    if (this.renameEl?.dataset.id === f.id) return this.renameEl;
    const input = h('input', { class: 'rename', value: f.name, 'aria-label': 'Feature name', 'data-id': f.id }) as HTMLInputElement;
    this.renameEl = input;
    // Another feature's name or id (in any case), or a base plane's name, is
    // refused, as the assistant refuses it: references by name would find that one instead.
    const refusal = (name: string): string | null => {
      const low = name.toLowerCase();
      if (!low || low === f.name.toLowerCase()) return null;
      const plane = BASE_PLANE_ALIASES[low];
      if (plane) return `"${name}" names the ${BASE_PLANE_NAMES[plane]}. Choose another name.`;
      const other = this.app.store.doc.features.find((x) => x.id !== f.id && (x.name.toLowerCase() === low || x.id.toLowerCase() === low));
      return other ? `"${other.name.toLowerCase() === low ? other.name : name}" is already the name of another feature. Choose another name.` : null;
    };
    const finish = (save: boolean) => {
      if (this.renaming !== f.id) return;
      this.renaming = null;
      this.renameEl = null;
      const name = input.value.trim();
      const msg = save && name ? refusal(name) : null;
      if (msg) this.app.setStatus(msg, true);
      if (save && name && name !== f.name && !msg) this.app.renameFeature(f.id, name);
      else this.render();
      this.focus(f.id);
    };
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('title');
    });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      e.stopPropagation();
      if (e.key === 'Enter') {
        // Enter keeps the field open to choose another name; leaving it keeps the old one.
        const msg = refusal(input.value.trim());
        if (msg) {
          input.setAttribute('aria-invalid', 'true');
          input.title = msg;
          this.app.setStatus(msg, true);
          input.select();
          return;
        }
        finish(true);
      }
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => { if (!this.rendering && input.isConnected) finish(true); });
    input.addEventListener('click', (e) => e.stopPropagation());
    requestAnimationFrame(() => { if (document.activeElement !== input) { input.focus(); input.select(); } });
    return input;
  }

  startRename(id: Id) {
    this.renaming = id;
    this.renameEl = null;
    this.render();
    const input = this.renameEl as HTMLInputElement | null;
    if (input?.isConnected) { input.focus(); input.select(); }
  }

  private toggle(key: string) {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    this.render();
  }

  private onClick(r: Row, e: MouseEvent) {
    this.focusKey = r.key;
    if (r.action) { r.action(); return; }
    if (!r.item) return;
    const app = this.app;
    if (app.panel && app.panel.onPick(r.item, true)) { this.render(); return; }
    if (e.shiftKey && this.selectRange(r.key)) return;
    this.anchor = r.key;
    if (e.ctrlKey || e.metaKey) app.selection.toggle(r.item);
    else app.selection.set([r.item]);
  }

  /** Shift selects the rows from the last one clicked to this one, as in a file list. */
  private selectRange(key: string): boolean {
    const rows = this.shown;
    const a = rows.findIndex((r) => r.key === this.anchor && r.item);
    const b = rows.findIndex((r) => r.key === key);
    if (a < 0 || b < 0) return false;
    this.app.selection.set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).flatMap((r) => (r.item ? [r.item] : [])));
    return true;
  }

  private onDouble(r: Row) {
    if (r.feature) this.app.editFeature(r.feature.id);
    else if (r.key === 'part') this.app.commands.run('properties');
  }

  /**
   * The features a row's Delete or context-menu command acts on: the whole
   * selection when the row is part of it (as in a file manager), else the row.
   */
  targets(id: Id): Id[] {
    const sel = this.app.selection.ofKind('feature').map((x) => x.id);
    return sel.includes(id) ? sel : [id];
  }

  focus(key: string) {
    this.focusKey = key;
    const row = () => this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    // At once when the row is there, and again on the next frame for a tree
    // redrawn meanwhile (its focused row replaced, focus fallen to the page).
    row()?.focus();
    const at = document.activeElement;
    requestAnimationFrame(() => {
      // A rename started meanwhile (F2 straight after the last one) keeps its field,
      // and a key pressed meanwhile (a second arrow) keeps the row it moved to.
      if (this.renameEl?.isConnected) return;
      const now = document.activeElement;
      if (now !== at && now && now !== document.body && now.isConnected) return;
      row()?.focus();
    });
  }

  private onKey(e: KeyboardEvent) {
    const items = [...this.list.querySelectorAll<HTMLElement>('.ti, .rollback-bar')];
    const cur = items.findIndex((x) => x === document.activeElement);
    if (cur < 0) return;
    const key = items[cur].dataset.key ?? '';
    const go = (i: number) => {
      const t = items[Math.max(0, Math.min(items.length - 1, i))];
      this.focusKey = t.dataset.key!;
      items.forEach((x) => x.setAttribute('tabindex', x === t ? '0' : '-1'));
      t.focus();
    };
    // Shift with Up or Down extends the selection from the row it started at.
    const extend = (i: number) => {
      const from = this.shown.find((r) => r.key === key);
      const anchor = this.shown.find((r) => r.key === this.anchor);
      if (from?.item && !(anchor?.item && this.app.selection.has(anchor.item))) this.anchor = key;
      go(i);
      const to = this.focusKey;
      if (!this.app.panel && to && this.shown.some((r) => r.key === to && r.item)) this.selectRange(to);
    };
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (e.shiftKey) extend(cur + 1); else go(cur + 1); break;
      case 'ArrowUp': e.preventDefault(); if (e.shiftKey) extend(cur - 1); else go(cur - 1); break;
      case 'Home': e.preventDefault(); go(0); break;
      case 'End': e.preventDefault(); go(items.length - 1); break;
      // As in any tree: Right opens a row, then moves to its first child; Left
      // closes it, or moves from a child to its parent.
      case 'ArrowRight': {
        const expanded = items[cur].getAttribute('aria-expanded');
        if (expanded === 'false') { e.preventDefault(); this.toggle(key); this.focus(key); }
        else if (expanded === 'true') { e.preventDefault(); go(cur + 1); }
        break;
      }
      case 'ArrowLeft': {
        if (items[cur].getAttribute('aria-expanded') === 'true') { e.preventDefault(); this.toggle(key); this.focus(key); break; }
        const level = Number(items[cur].getAttribute('aria-level'));
        const parent = items.slice(0, cur).findLastIndex((x) => x.classList.contains('ti') && Number(x.getAttribute('aria-level')) < level);
        if (parent >= 0) { e.preventDefault(); go(parent); }
        break;
      }
      // These re-render the rows, so the app-wide shortcut handler would see a
      // detached target and treat the key as a global shortcut (Space opening
      // the view menu, Enter closing the panel just opened).
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (this.app.store.feature(key)) this.app.editFeature(key);
        // As a click on Material or a double click on the part does.
        else if (key === 'material') this.app.commands.run('material');
        else if (key === 'part') this.app.commands.run('properties');
        break;
      case ' ':
        e.preventDefault();
        e.stopPropagation();
        // Ctrl (Command) adds the row to the selection or takes it out, Shift selects up to it, as a click does.
        items[cur].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey }));
        break;
      // The keyboard context menu: browsers on macOS never fire contextmenu for Shift+F10.
      case 'F10':
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          const r = items[cur].getBoundingClientRect();
          items[cur].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.bottom }));
        }
        break;
      case 'F2':
        if (this.app.store.feature(key)) { e.preventDefault(); e.stopPropagation(); this.startRename(key); }
        break;
      case 'Delete':
      case 'Backspace':
        if (this.app.store.feature(key)) {
          e.preventDefault();
          e.stopPropagation();
          // Focus moves on to the row after the deleted ones (else before), not back to the top.
          const keys = items.map((x) => x.dataset.key);
          const order = [...keys.slice(cur + 1), ...keys.slice(0, cur).reverse()];
          void this.app.deleteFeatures(this.targets(key)).then(() => {
            if (this.app.store.feature(key) || !this.list.contains(document.activeElement)) return;
            const next = order.find((k) => k && this.list.querySelector(`[data-key="${CSS.escape(k)}"]`));
            if (next) this.focus(next);
          });
        }
        break;
    }
  }
}
