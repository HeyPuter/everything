// The design tree of an assembly: the assembly, its planes and origin, the
// components (with (f) for fixed and (-) for under-defined ones, as in other
// CAD systems), the Mates folder and the exploded view steps. Same rows,
// keys and menus as the part tree.

import type { Id } from '../../model/types';
import { BASE_PLANE_NAMES } from '../../model/planes';
import type { BasePlane } from '../../model/types';
import type { AssemblyDocument } from '../../model/assembly';
import { h, titleWhenClipped } from '../../ui/dom';
import { icon } from '../../ui/icons';
import type { App } from '../app';
import type { SelItem } from '../selection';
import type { AssemblyMode } from './mode';

interface Row {
  key: string;
  item: SelItem | null;
  label: string;
  icon: string;
  depth: number;
  kind: 'root' | 'plane' | 'origin' | 'component' | 'folder' | 'mate' | 'step';
  children?: boolean;
  expanded?: boolean;
  muted?: string;
  suppressed?: boolean;
  error?: string;
  warning?: string;
  /** Renamable item id. */
  id?: Id;
}

export class AssemblyTree {
  el: HTMLElement;
  private list: HTMLElement;
  private filter = '';
  private collapsed = new Set<string>();
  private focusKey: string | null = null;
  private renaming: Id | null = null;
  private renameEl: HTMLInputElement | null = null;
  private rendering = false;
  private shown: Row[] = [];
  private anchor: string | null = null;

  constructor(private app: App, private mode: AssemblyMode, flyout = false) {
    const filterInput = h('input', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter the design tree' }) as HTMLInputElement;
    filterInput.addEventListener('input', () => { this.filter = filterInput.value.trim().toLowerCase(); this.render(); });
    this.list = h('div', { class: 'tree', role: 'tree', 'aria-label': flyout ? 'Assembly design tree (flyout)' : 'Assembly design tree', 'aria-multiselectable': 'true' });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.el = flyout ? h('div', {}, this.list) : h('div', {}, h('div', { class: 'tree-filter' }, icon('search', 14), filterInput), this.list);
  }

  private get doc(): AssemblyDocument {
    return this.mode.doc;
  }

  private rows(): Row[] {
    const doc = this.doc;
    const mode = this.mode;
    const rows: Row[] = [{ key: 'part', item: null, label: doc.name, icon: 'assembly', depth: 0, kind: 'root' }];
    for (const k of ['front', 'top', 'right'] as BasePlane[]) rows.push({ key: `plane:${k}`, item: { kind: 'plane', ref: { kind: 'base', plane: k } }, label: BASE_PLANE_NAMES[k], icon: 'plane', depth: 1, kind: 'plane' });
    rows.push({ key: 'origin', item: { kind: 'origin' }, label: 'Origin', icon: 'origin', depth: 1, kind: 'origin' });
    for (const c of doc.components) {
      const prefix = c.suppressed ? '' : c.fixed ? '(f) ' : mode.isDefined(c.id) ? '' : '(-) ';
      const err = mode.componentError(c.id);
      rows.push({
        key: c.id, id: c.id, item: { kind: 'feature', id: c.id }, label: `${prefix}${c.name}`, icon: 'part', depth: 1, kind: 'component',
        suppressed: c.suppressed, muted: c.hidden ? ' (hidden)' : '', error: err?.kind === 'error' ? err.text : undefined, warning: err?.kind === 'warning' ? err.text : undefined,
      });
    }
    const matesOpen = !this.collapsed.has('mates');
    rows.push({ key: 'mates', item: null, label: 'Mates', icon: 'mate', depth: 1, kind: 'folder', children: doc.mates.length > 0, expanded: matesOpen, muted: doc.mates.length ? '' : ' (none)' });
    if (matesOpen || this.filter) for (const m of doc.mates) {
      const err = mode.mateError(m.id);
      const names = mode.mateLabel(m);
      rows.push({ key: m.id, id: m.id, item: { kind: 'feature', id: m.id }, label: m.name, muted: names ? ` (${names})` : '', icon: `mate:${m.type}`, depth: 2, kind: 'mate', suppressed: m.suppressed, error: err ?? undefined });
    }
    if (doc.explode.length) {
      const open = !this.collapsed.has('explode');
      rows.push({ key: 'explode', item: null, label: 'Exploded View', icon: 'explode', depth: 1, kind: 'folder', children: true, expanded: open, muted: doc.exploded ? ' (exploded)' : ' (collapsed)' });
      if (open || this.filter) for (const s of doc.explode) rows.push({ key: s.id, id: s.id, item: { kind: 'feature', id: s.id }, label: s.name, icon: 'explode', depth: 2, kind: 'step', muted: ` (${s.comps.length} ${s.comps.length === 1 ? 'component' : 'components'})` });
    }
    if (!this.filter) return rows;
    return rows.filter((r) => r.depth === 0 || r.label.toLowerCase().includes(this.filter));
  }

  render() {
    if (!this.app.assembly) return;
    const app = this.app;
    const rows = this.rows();
    this.shown = rows;
    const sel = app.selection;
    const active = document.activeElement;
    const hadFocus = !!active && this.list.contains(active);
    const tabKey = this.focusKey && rows.some((r) => r.key === this.focusKey) ? this.focusKey : 'part';
    this.rendering = true;
    this.list.textContent = '';
    this.rendering = false;
    for (const r of rows) {
      const selected = r.item ? sel.has(r.item) : false;
      const el = h('div', {
        class: `ti${r.suppressed ? ' suppressed' : ''}${r.error ? ' error' : ''}${app.panel?.editingId && app.panel.editingId === r.id ? ' editing' : ''}`,
        role: 'treeitem',
        tabindex: r.key === tabKey ? '0' : '-1',
        'aria-selected': r.item ? String(selected) : null,
        'aria-level': String(r.depth + 1),
        'aria-expanded': r.children ? String(!!r.expanded) : null,
        'data-key': r.key,
        style: { paddingLeft: `${4 + r.depth * 14}px` },
      });
      const twisty = h('span', { class: r.children ? 'twisty' : 'twisty empty', 'aria-hidden': 'true' }, r.children ? icon(r.expanded ? 'chevronDown' : 'chevronRight', 12) : null);
      twisty.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(r.key); });
      el.append(twisty, icon(r.icon, 16));
      if (this.renaming && this.renaming === r.id) el.append(this.renameInput(r));
      else {
        const label = h('span', { class: 'label' }, r.label, r.muted ? h('span', { class: 'muted' }, r.muted) : null);
        titleWhenClipped(label);
        el.append(label);
      }
      const states: string[] = [];
      if (r.suppressed) states.push('Suppressed');
      if (r.kind === 'component' && r.label.startsWith('(f)')) states.push('Fixed');
      if (r.kind === 'component' && r.label.startsWith('(-)')) states.push('Under defined');
      if (r.error) {
        el.append(h('span', { class: 'badge', title: r.error }, icon('error', 14)));
        states.push(`Error: ${r.error}`);
      } else if (r.warning) {
        el.append(h('span', { class: 'badge warn', title: r.warning }, icon('warning', 14)));
        states.push(`Warning: ${r.warning}`);
      }
      if (states.length) el.setAttribute('aria-description', states.join('. '));
      el.addEventListener('click', (e) => this.onClick(r, e));
      el.addEventListener('dblclick', () => this.onDouble(r));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (r.item && !sel.has(r.item)) sel.set([r.item]);
        if (r.id) app.openFeatureMenu(r.id, e.clientX, e.clientY);
        else if (r.item) app.openReferenceMenu(r.item, e.clientX, e.clientY);
        else if (r.key === 'part') app.openCommandMenu(['properties', 'rename', 'equations', 'insertComponent', 'billOfMaterials'], e.clientX, e.clientY, 'Assembly menu');
        else if (r.key === 'mates') app.openCommandMenu(['mate'], e.clientX, e.clientY, 'Mates menu');
        else if (r.key === 'explode') app.openCommandMenu(['explodedView', 'toggleExplode'], e.clientX, e.clientY, 'Exploded view menu');
      });
      el.addEventListener('pointerenter', () => { if (r.item) sel.setHover(r.item); });
      el.addEventListener('pointerleave', () => { if (r.item) sel.setHover(null); });
      el.addEventListener('focus', () => { this.focusKey = r.key; });
      this.list.append(el);
    }
    if (hadFocus) {
      const target = this.renaming && this.renameEl?.isConnected ? this.renameEl : this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(tabKey)}"]`);
      target?.focus({ preventScroll: true });
    }
  }

  private renameInput(r: Row): HTMLInputElement {
    const id = r.id!;
    if (this.renameEl?.dataset.id === id) return this.renameEl;
    const current = this.mode.itemName(id) ?? '';
    const input = h('input', { class: 'rename', value: current, 'aria-label': 'Name', 'data-id': id }) as HTMLInputElement;
    this.renameEl = input;
    const refusal = (name: string) => this.mode.nameRefusal(id, name);
    const finish = (save: boolean) => {
      if (this.renaming !== id) return;
      this.renaming = null;
      this.renameEl = null;
      const name = input.value.trim();
      const msg = save && name ? refusal(name) : null;
      if (msg) this.app.setStatus(msg, true);
      if (save && name && name !== current && !msg) this.mode.rename(id, name);
      else this.render();
      this.focus(id);
    };
    input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); input.removeAttribute('title'); });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      e.stopPropagation();
      if (e.key === 'Enter') {
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
    if (!this.mode.itemName(id)) return;
    this.renaming = id;
    this.renameEl = null;
    this.render();
    const input = this.renameEl as HTMLInputElement | null;
    if (input?.isConnected) { input.focus(); input.select(); }
  }

  targets(id: Id): Id[] {
    const sel = this.app.selection.ofKind('feature').map((x) => x.id);
    return sel.includes(id) ? sel : [id];
  }

  private toggle(key: string) {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    this.render();
  }

  private onClick(r: Row, e: MouseEvent) {
    this.focusKey = r.key;
    if (!r.item) { if (r.children) this.toggle(r.key); return; }
    const app = this.app;
    if (app.panel && app.panel.onPick(r.item, true)) { this.render(); return; }
    if (e.shiftKey && this.selectRange(r.key)) return;
    this.anchor = r.key;
    if (e.ctrlKey || e.metaKey) app.selection.toggle(r.item);
    else app.selection.set([r.item]);
  }

  private selectRange(key: string): boolean {
    const rows = this.shown;
    const a = rows.findIndex((r) => r.key === this.anchor && r.item);
    const b = rows.findIndex((r) => r.key === key);
    if (a < 0 || b < 0) return false;
    this.app.selection.set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).flatMap((r) => (r.item ? [r.item] : [])));
    return true;
  }

  private onDouble(r: Row) {
    if (r.id) this.mode.edit(r.id);
    else if (r.key === 'part') this.app.commands.run('properties');
  }

  focus(key: string) {
    this.focusKey = key;
    const row = () => this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    row()?.focus();
    requestAnimationFrame(() => {
      if (this.renameEl?.isConnected) return;
      const now = document.activeElement;
      if (now && now !== document.body && now.isConnected && this.list.contains(now)) return;
      if (!now || now === document.body) row()?.focus();
    });
  }

  private onKey(e: KeyboardEvent) {
    const items = [...this.list.querySelectorAll<HTMLElement>('.ti')];
    const cur = items.findIndex((x) => x === document.activeElement);
    if (cur < 0) return;
    const key = items[cur].dataset.key ?? '';
    const row = this.shown.find((r) => r.key === key);
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
      case 'ArrowRight': {
        const expanded = items[cur].getAttribute('aria-expanded');
        if (expanded === 'false') { e.preventDefault(); this.toggle(key); this.focus(key); }
        else if (expanded === 'true') { e.preventDefault(); go(cur + 1); }
        break;
      }
      case 'ArrowLeft': {
        if (items[cur].getAttribute('aria-expanded') === 'true') { e.preventDefault(); this.toggle(key); this.focus(key); break; }
        const level = Number(items[cur].getAttribute('aria-level'));
        const parent = items.slice(0, cur).findLastIndex((x) => Number(x.getAttribute('aria-level')) < level);
        if (parent >= 0) { e.preventDefault(); go(parent); }
        break;
      }
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (row?.id) this.mode.edit(row.id);
        else if (key === 'part') this.app.commands.run('properties');
        else if (row?.children) { this.toggle(key); this.focus(key); }
        break;
      case ' ':
        e.preventDefault();
        e.stopPropagation();
        items[cur].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey }));
        break;
      case 'F10':
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          const r = items[cur].getBoundingClientRect();
          items[cur].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.bottom }));
        }
        break;
      case 'F2':
        if (row?.id) { e.preventDefault(); e.stopPropagation(); this.startRename(row.id); }
        break;
      case 'Delete':
      case 'Backspace':
        if (row?.id) {
          e.preventDefault();
          e.stopPropagation();
          const keys = items.map((x) => x.dataset.key);
          const order = [...keys.slice(cur + 1), ...keys.slice(0, cur).reverse()];
          void this.mode.deleteItems(this.targets(row.id)).then(() => {
            if (this.mode.itemName(key) || !this.list.contains(document.activeElement)) return;
            const next = order.find((k) => k && this.list.querySelector(`[data-key="${CSS.escape(k)}"]`));
            if (next) this.focus(next);
          });
        }
        break;
    }
  }
}
