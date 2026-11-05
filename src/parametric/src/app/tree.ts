// FeatureManager design tree: part, material, default planes, origin and the
// feature history with absorbed sketches, error badges, rename, context
// menus, keyboard navigation and a draggable rollback bar.

import type { Feature, Id } from '../model/types';
import { consumedSketches, featureIcon } from '../model/features';
import { BASE_PLANE_NAMES } from '../model/planes';
import type { BasePlane } from '../model/types';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import type { App } from './app';
import type { SelItem } from './selection';

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

  constructor(private app: App, flyout = false) {
    const filterInput = h('input', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter the design tree' }) as HTMLInputElement;
    filterInput.addEventListener('input', () => { this.filter = filterInput.value.trim().toLowerCase(); this.render(); });
    this.list = h('div', { class: 'tree', role: 'tree', 'aria-label': 'Design tree', 'aria-multiselectable': 'true' });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    if (flyout) this.list.setAttribute('aria-label', 'Design tree (flyout)');
    this.el = flyout ? h('div', {}, this.list) : h('div', {}, h('div', { class: 'tree-filter' }, icon('search', 14), filterInput), this.list);
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
      if (expanded) for (const k of kids) rows.push({ key: k.id, item: { kind: 'feature', id: k.id }, label: k.name, icon: featureIcon(k), depth: 2, feature: k });
    }
    if (!this.filter) return rows;
    return rows.filter((r) => r.depth === 0 || r.label.toLowerCase().includes(this.filter));
  }

  render() {
    const app = this.app;
    const doc = app.store.doc;
    const built = app.store.builtCount;
    const rows = this.rows();
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
      const twisty = h('span', { class: 'twisty', 'aria-hidden': 'true' }, r.children ? icon(r.expanded ? 'chevronDown' : 'chevronRight', 12) : null);
      twisty.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(r.key); });
      el.append(twisty, icon(r.icon, 16));
      if (this.renaming && this.renaming === f?.id) el.append(this.renameInput(f));
      else el.append(h('span', { class: 'label' }, r.label, r.muted ? h('span', { class: 'muted' }, r.muted) : null));
      if (status && !status.ok) {
        const b = h('span', { class: 'badge', title: status.error ?? 'Error' }, icon('error', 14));
        el.append(b);
        el.setAttribute('aria-description', `Error: ${status.error ?? ''}`);
      } else if (f && app.featureWarning(f.id)) {
        el.append(h('span', { class: 'badge warn', title: app.featureWarning(f.id)! }, icon('warning', 14)));
      }
      el.addEventListener('click', (e) => this.onClick(r, e));
      el.addEventListener('dblclick', () => this.onDouble(r));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (r.item && !sel.has(r.item)) sel.set([r.item]);
        if (f) app.openFeatureMenu(f.id, e.clientX, e.clientY);
        else if (r.item) app.openReferenceMenu(r.item, e.clientX, e.clientY);
      });
      el.addEventListener('pointerenter', () => { if (r.item) sel.setHover(r.item); });
      el.addEventListener('pointerleave', () => { if (r.item) sel.setHover(null); });
      el.addEventListener('focus', () => { this.focusKey = r.key; });
      this.list.append(el);
    }
    if (!rollbackPlaced) this.list.append(this.rollbackBar());
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
      this.app.store.beginBatch('Rollback');
      // Every roll re-renders the tree and replaces this bar, so the drag
      // follows the pointer on the window rather than on the bar.
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
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
        this.draggingBar = false;
        this.app.store.endBatch();
        this.list.querySelector('.rollback-bar')?.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
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
    const finish = (save: boolean) => {
      if (this.renaming !== f.id) return;
      this.renaming = null;
      this.renameEl = null;
      const name = input.value.trim();
      if (save && name && name !== f.name) this.app.renameFeature(f.id, name);
      else this.render();
      this.focus(f.id);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
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
    if (e.ctrlKey || e.metaKey || e.shiftKey) app.selection.toggle(r.item);
    else app.selection.set([r.item]);
  }

  private onDouble(r: Row) {
    if (r.feature) this.app.editFeature(r.feature.id);
    else if (r.key === 'part') this.app.commands.run('properties');
  }

  focus(key: string) {
    this.focusKey = key;
    requestAnimationFrame(() => this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus());
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
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); go(cur + 1); break;
      case 'ArrowUp': e.preventDefault(); go(cur - 1); break;
      case 'Home': e.preventDefault(); go(0); break;
      case 'End': e.preventDefault(); go(items.length - 1); break;
      case 'ArrowRight':
        if (items[cur].getAttribute('aria-expanded') === 'false') { e.preventDefault(); this.toggle(key); this.focus(key); }
        break;
      case 'ArrowLeft':
        if (items[cur].getAttribute('aria-expanded') === 'true') { e.preventDefault(); this.toggle(key); this.focus(key); }
        break;
      // These re-render the rows, so the app-wide shortcut handler would see a
      // detached target and treat the key as a global shortcut (Space opening
      // the view menu, Enter closing the panel just opened).
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (this.app.store.feature(key)) this.app.editFeature(key);
        break;
      case ' ':
        e.preventDefault();
        e.stopPropagation();
        items[cur].click();
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
        if (this.app.store.feature(key)) { e.preventDefault(); e.stopPropagation(); this.app.deleteFeatures([key]); }
        break;
    }
  }
}
