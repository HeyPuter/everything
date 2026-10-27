// PropertyManager: the left-pane panel used to create and edit features and
// to run tools (measure, relations...). Provides a small kit of controls:
// collapsible sections, unit-aware numeric fields with expression support,
// selection boxes, checkboxes, selects and segmented buttons.

import type { BuildResult } from '../kernel/protocol';
import type { ParamKind } from '../model/features';
import type { Feature, Id, Param, UnitSystem } from '../model/types';
import { UNIT_SYSTEMS, formatEditable, formatNumber } from '../model/units';
import { evaluate } from '../model/expr';
import { h, nextDomId } from '../ui/dom';
import { icon } from '../ui/icons';
import { attachTooltip } from '../ui/overlay';
import type { SelItem } from './selection';

export interface PickFilter {
  face?: boolean;
  edge?: boolean;
  vertex?: boolean;
  plane?: boolean;
  /** Only planar faces count as faces. */
  planarOnly?: boolean;
  feature?: boolean;
  sketch?: boolean;
  sketchLine?: boolean;
  sketchPoint?: boolean;
  axis?: boolean;
}

export interface UnitContext {
  units: UnitSystem;
  decimals: number;
  variables: () => Map<string, number>;
}

export abstract class PropertyPanel {
  abstract title: string;
  icon = 'settings';
  /** Existing feature being edited (null when creating). */
  editingId: Id | null = null;
  el: HTMLElement = h('div');
  private msgEl: HTMLElement | null = null;
  /** Which selection box receives viewport picks. */
  activeBox: SelectionBox | null = null;
  boxes: SelectionBox[] = [];
  /** Show OK/Cancel in the confirmation corner. */
  confirm = true;
  helpText = '';
  /** Label and action of the single button shown when confirm is false. */
  closeLabel = 'Close';
  onCloseClick: (() => void) | null = null;

  abstract render(): HTMLElement[];

  /** Feature to preview (resolved by the app), or null for none. */
  preview(): Feature | null {
    return null;
  }

  /** Commit. Return false to keep the panel open. */
  abstract ok(): boolean | Promise<boolean>;

  cancel(): void {}

  /** Viewport pick filter while this panel is open. */
  filter(): PickFilter {
    return this.activeBox?.filter ?? {};
  }

  /** Viewport selection routed to the panel. Return true when consumed. */
  onPick(item: SelItem, additive: boolean): boolean {
    if (!this.activeBox) return false;
    return this.activeBox.toggle(item, additive);
  }

  onBuild(_res: BuildResult): void {}

  /** Called when the panel is removed. */
  dispose(): void {}

  mount(): HTMLElement {
    this.boxes = [];
    this.msgEl = h('div', { class: 'pm-msg', role: 'status', hidden: true });
    const body = this.render();
    this.el = h('div', { class: 'pm-content' }, this.msgEl, ...body);
    if (!this.activeBox) this.activeBox = this.boxes[0] ?? null;
    this.boxes.forEach((b) => b.setActive(b === this.activeBox));
    return this.el;
  }

  setMessage(kind: 'info' | 'warn' | 'error' | null, text = '') {
    if (!this.msgEl) return;
    this.msgEl.hidden = !kind || !text;
    this.msgEl.className = `pm-msg${kind ? ' ' + kind : ''}`;
    this.msgEl.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    this.msgEl.textContent = text;
  }

  activate(box: SelectionBox) {
    this.activeBox = box;
    this.boxes.forEach((b) => b.setActive(b === box));
  }
}

// ---------- Controls ----------

export function section(title: string, children: (HTMLElement | null)[], opts: { collapsed?: boolean; checkbox?: { checked: boolean; onChange: (v: boolean) => void }; icon?: string } = {}): HTMLElement {
  const bodyId = nextDomId('sec');
  const body = h('div', { class: 'sec-body', id: bodyId }, ...children);
  const sec = h('section', { class: 'pm-section', 'data-collapsed': String(!!opts.collapsed) });
  const head = h('button', { class: 'sec-head', 'aria-expanded': String(!opts.collapsed), 'aria-controls': bodyId, type: 'button' });
  if (opts.checkbox) {
    const cb = h('input', { type: 'checkbox', 'aria-label': `Enable ${title}` }) as HTMLInputElement;
    cb.checked = opts.checkbox.checked;
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      opts.checkbox!.onChange(cb.checked);
      setCollapsed(!cb.checked);
    });
    head.append(cb);
  }
  if (opts.icon) head.append(icon(opts.icon, 16));
  head.append(h('span', {}, title), h('span', { class: 'chev' }, icon('chevronDown', 14)));
  const setCollapsed = (c: boolean) => {
    sec.dataset.collapsed = String(c);
    head.setAttribute('aria-expanded', String(!c));
  };
  head.addEventListener('click', () => setCollapsed(sec.dataset.collapsed !== 'true'));
  sec.append(head, body);
  return sec;
}

export interface NumberFieldOptions {
  label: string;
  icon?: string;
  value: Param;
  kind: ParamKind;
  ctx: UnitContext;
  min?: number;
  /** Allow expressions starting with "=" to be stored as linked values. */
  allowExpr?: boolean;
  onChange: (v: Param) => void;
  onLive?: (v: number) => void;
}

/** Display text for a parameter in the document's units. */
export function paramText(v: Param, kind: ParamKind, ctx: UnitContext): string {
  if (typeof v === 'string') return v.startsWith('=') ? v : `=${v}`;
  if (kind === 'length') return formatEditable(v / UNIT_SYSTEMS[ctx.units].scale);
  return formatEditable(v);
}

export function unitSuffix(kind: ParamKind, ctx: UnitContext): string {
  return kind === 'length' ? UNIT_SYSTEMS[ctx.units].length : kind === 'angle' ? 'deg' : '';
}

/** Parses typed text into a Param (number in mm/deg, or an "=expr" string). */
export function parseParam(text: string, kind: ParamKind, ctx: UnitContext, allowExpr = true): { ok: true; value: Param; num: number } | { ok: false; error: string } {
  const t = text.trim();
  const isExpr = t.startsWith('=');
  try {
    const num = evaluate(isExpr ? t.slice(1) : t, {
      kind: kind === 'count' ? 'none' : kind,
      bareScale: kind === 'length' ? UNIT_SYSTEMS[ctx.units].scale : 1,
      lookup: (n) => ctx.variables().get(n),
    });
    const n = kind === 'count' ? Math.round(num) : num;
    if (isExpr && allowExpr) return { ok: true, value: t, num: n };
    return { ok: true, value: n, num: n };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function numberField(o: NumberFieldOptions): HTMLElement {
  const id = nextDomId('num');
  const input = h('input', {
    class: 'input',
    id,
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': o.label,
    value: paramText(o.value, o.kind, o.ctx),
  }) as HTMLInputElement;
  let current: Param = o.value;
  const mark = () => input.classList.toggle('expr', typeof current === 'string');
  mark();
  const commit = (live = false) => {
    const r = parseParam(input.value, o.kind, o.ctx, o.allowExpr !== false);
    if (!r.ok) {
      input.classList.add('invalid');
      input.setAttribute('aria-invalid', 'true');
      input.title = r.error;
      return;
    }
    if (o.min !== undefined && r.num < o.min) {
      input.classList.add('invalid');
      input.title = `Must be at least ${o.min}`;
      return;
    }
    input.classList.remove('invalid');
    input.removeAttribute('aria-invalid');
    input.title = '';
    if (live) { o.onLive?.(r.num); return; }
    current = r.value;
    mark();
    o.onChange(r.value);
  };
  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => commit(), 350);
  });
  input.addEventListener('change', () => { clearTimeout(timer); commit(); });
  input.addEventListener('focus', () => input.select());
  const step = (dir: number) => {
    const r = parseParam(input.value, o.kind, o.ctx, false);
    const base = r.ok ? r.num : 0;
    const scale = o.kind === 'length' ? UNIT_SYSTEMS[o.ctx.units].scale : 1;
    const inc = o.kind === 'count' ? 1 : o.kind === 'angle' ? 1 : o.ctx.units === 'IPS' ? 0.1 * scale : o.ctx.units === 'MKS' ? 0.01 * scale : 1 * scale;
    let next = base + dir * inc;
    if (o.min !== undefined) next = Math.max(o.min, next);
    input.value = paramText(next, o.kind, o.ctx);
    commit();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter') { clearTimeout(timer); commit(); }
  });
  const spin = h('div', { class: 'spin' }, input, h('div', { class: 'spin-btns' },
    h('button', { type: 'button', tabindex: '-1', 'aria-label': `Increase ${o.label}`, onclick: () => step(1) }, icon('chevronUp', 12)),
    h('button', { type: 'button', tabindex: '-1', 'aria-label': `Decrease ${o.label}`, onclick: () => step(-1) }, icon('chevronDown', 12))));
  const label = h('label', { class: 'sr-only', for: id }, o.label);
  const row = h('div', { class: 'row' }, label);
  if (o.icon) {
    const ic = h('span', { class: 'row-icon' }, icon(o.icon, 18));
    attachTooltip(ic, o.label);
    row.append(ic);
  }
  row.append(spin);
  const suffix = unitSuffix(o.kind, o.ctx);
  const wrap = h('div', {}, o.icon ? null : h('div', { class: 'field-label', 'aria-hidden': 'true' }, `${o.label}${suffix ? ` (${suffix})` : ''}`), row);
  return wrap;
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'check' }, input, h('span', {}, label));
}

export function selectField<T extends string>(label: string, value: T, options: { value: T; label: string }[], onChange: (v: T) => void, iconName?: string): HTMLElement {
  const id = nextDomId('sel');
  const sel = h('select', { class: 'input', id }) as HTMLSelectElement;
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label) as HTMLOptionElement;
    if (o.value === value) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value as T));
  const row = h('div', { class: 'row' });
  if (iconName) row.append(h('span', { class: 'row-icon', 'aria-hidden': 'true' }, icon(iconName, 18)));
  row.append(h('div', { class: 'grow' }, sel));
  return h('div', {}, h('label', { class: iconName ? 'sr-only' : 'field-label', for: id }, label), row);
}

export function segmented<T extends string>(label: string, value: T, options: { value: T; label: string; icon?: string }[], onChange: (v: T) => void): HTMLElement {
  const group = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const buttons = options.map((o) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(o.value === value) }, o.icon ? icon(o.icon, 16) : null, o.label);
    b.addEventListener('click', () => {
      buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      onChange(o.value);
    });
    return b;
  });
  group.append(...buttons);
  return group;
}

export function flipButton(label: string, pressed: boolean, onChange: (v: boolean) => void): HTMLElement {
  const b = h('button', { type: 'button', class: 'icon-btn', 'aria-pressed': String(pressed), 'aria-label': label }, icon('reset', 16));
  attachTooltip(b, label);
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(v));
    onChange(v);
  });
  return b;
}

export interface SelBoxItem {
  item: SelItem | null;
  /** Arbitrary payload stored by the panel (e.g. a FaceRef). */
  data: unknown;
  label: string;
}

/** A list of picked entities; clicking it makes it the active pick target. */
export class SelectionBox {
  el: HTMLElement;
  private list: HTMLElement;
  items: SelBoxItem[] = [];

  constructor(
    panel: PropertyPanel,
    readonly label: string,
    readonly filter: PickFilter,
    private convert: (it: SelItem) => SelBoxItem | null,
    private onChange: (items: SelBoxItem[]) => void,
    readonly opts: { single?: boolean; placeholder?: string; icon?: string } = {},
  ) {
    this.list = h('div', { class: 'selbox', role: 'listbox', tabindex: '0', 'aria-label': label });
    this.list.addEventListener('click', () => panel.activate(this));
    this.list.addEventListener('focus', () => panel.activate(this));
    const head = h('div', { class: 'row' }, opts.icon ? h('span', { class: 'row-icon', 'aria-hidden': 'true' }, icon(opts.icon, 18)) : null, h('span', { class: 'field-label' }, label));
    this.el = h('div', {}, head, this.list);
    panel.boxes.push(this);
    this.draw();
  }

  setItems(items: SelBoxItem[], notify = false) {
    this.items = items;
    this.draw();
    if (notify) this.onChange(this.items);
  }

  setActive(active: boolean) {
    this.list.classList.toggle('active', active);
  }

  toggle(it: SelItem, additive: boolean): boolean {
    const conv = this.convert(it);
    if (!conv) return false;
    const idx = this.items.findIndex((x) => x.label === conv.label);
    if (idx >= 0) this.items.splice(idx, 1);
    else if (this.opts.single) this.items = [conv];
    else this.items.push(conv);
    void additive;
    this.draw();
    this.onChange(this.items);
    return true;
  }

  private draw() {
    this.list.textContent = '';
    if (!this.items.length) {
      this.list.append(h('div', { class: 'empty' }, this.opts.placeholder ?? 'Select in the graphics area'));
      return;
    }
    this.items.forEach((it, i) => {
      const rm = h('button', { class: 'icon-btn rm', type: 'button', 'aria-label': `Remove ${it.label}` }, icon('close', 14));
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        this.items.splice(i, 1);
        this.draw();
        this.onChange(this.items);
      });
      this.list.append(h('div', { class: 'item', role: 'option' }, h('span', {}, it.label), rm));
    });
  }
}

export function fmt(v: number, kind: ParamKind, ctx: UnitContext): string {
  if (kind === 'length') return `${formatNumber(v / UNIT_SYSTEMS[ctx.units].scale, ctx.decimals)} ${UNIT_SYSTEMS[ctx.units].length}`;
  if (kind === 'angle') return `${formatNumber(v, 2)}°`;
  return String(v);
}
