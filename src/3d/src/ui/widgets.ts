// Property widgets: drag-to-edit number fields,
// sliders, checkboxes, enum menus, color swatches with a picker, text fields.
import { h, type VNode, type Child } from './h';
import { icon } from './icons';
import { openMenu, openPopover, setWidgetDragging, menuSettings, type MenuItem } from './menu';
import { app } from '../app/app';
import { parseExpression, evalExpression } from '../anim/drivers';
import { buttonHooks, getBinding, bindingValue } from './binding';

export type Unit = 'none' | 'distance' | 'angle' | 'factor' | 'percentage' | 'time' | 'pixel' | 'mass' | 'power' | 'frame';

export interface NumberOpts {
  id: string;
  label?: string;
  value: number;
  set: (v: number, final: boolean) => void;
  min?: number;
  max?: number;
  softMin?: number;
  softMax?: number;
  step?: number;
  precision?: number;
  unit?: Unit;
  int?: boolean;
  slider?: boolean;
  disabled?: boolean;
  /** animation state for coloring: 'keyed' on current frame, 'animated', 'driven' */
  anim?: 'keyed' | 'animated' | 'driven' | 'changed' | null;
  tip?: string;
  align?: 'center' | 'left';
  /** hide the label inside the field */
  noLabel?: boolean;
  className?: string;
}

const editing = new Map<string, string>(); // id -> text being edited

/** Display options (Preferences ▸ Interface sets these). */
export const widgetSettings = {
  /** show 0..1 factors as percentages */
  factorPercentage: false,
  /** colour picker layout */
  colorPicker: 'CIRCLE_HSV' as 'CIRCLE_HSV' | 'CIRCLE_HSL' | 'SQUARE_SV' | 'SQUARE_HS' | 'SQUARE_HV',
};
const pct = (o: NumberOpts) => o.unit === 'factor' && widgetSettings.factorPercentage;

export function formatNumber(v: number, unit: Unit = 'none', precision = 3, int = false): string {
  if (!Number.isFinite(v)) return String(v);
  if (int) return String(Math.round(v));
  switch (unit) {
    case 'distance':
      return `${trim(v, Math.max(precision, 4))} m`;
    case 'angle':
      return `${trim((v * 180) / Math.PI, 1)}°`;
    case 'percentage':
      return `${trim(v, 0)}%`;
    case 'pixel':
      return `${Math.round(v)} px`;
    case 'time':
      return `${trim(v, 2)} s`;
    case 'mass':
      return `${trim(v, 3)} kg`;
    case 'power':
      return `${trim(v, 1)} W`;
    case 'frame':
      return String(Math.round(v));
    default:
      return v.toFixed(precision);
  }
}

function trim(v: number, digits: number) {
  const s = v.toFixed(digits);
  if (!s.includes('.')) return s === '-0' ? '0' : s;
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return t === '-0' ? '0' : t;
}

/** Parse user text (expressions + unit suffixes) into an internal value. */
export function parseNumber(text: string, unit: Unit = 'none'): number {
  let t = text.trim().replace(/,/g, '.');
  let scale = 1;
  const unitMatch = /(mm|cm|km|m|°|deg|d|r|rad|%|px|s|kg|w)\s*$/i.exec(t);
  let explicitAngle = false;
  if (unitMatch) {
    const u = unitMatch[1].toLowerCase();
    t = t.slice(0, unitMatch.index);
    if (u === 'mm') scale = 0.001;
    else if (u === 'cm') scale = 0.01;
    else if (u === 'km') scale = 1000;
    else if (u === '°' || u === 'deg' || u === 'd') {
      scale = Math.PI / 180;
      explicitAngle = true;
    } else if (u === 'r' || u === 'rad') {
      scale = 1;
      explicitAngle = true;
    }
  }
  // allow simple unit-tagged terms inside expressions like "1m+20cm"
  t = t.replace(/(\d+(?:\.\d+)?)\s*cm/g, '($1*0.01)').replace(/(\d+(?:\.\d+)?)\s*mm/g, '($1*0.001)').replace(/(\d+(?:\.\d+)?)\s*m\b/g, '($1)');
  const v = evalExpression(parseExpression(t), {});
  if (unit === 'angle' && !explicitAngle) return (v * Math.PI) / 180;
  if (unit === 'percentage') return v;
  return v * scale;
}

function clamp(v: number, o: NumberOpts) {
  if (o.min !== undefined) v = Math.max(o.min, v);
  if (o.max !== undefined) v = Math.min(o.max, v);
  if (o.int) v = Math.round(v);
  return v;
}

function displayStep(o: NumberOpts) {
  if (o.step) return o.step;
  if (o.int) return 1;
  if (o.unit === 'angle') return Math.PI / 180;
  if (o.unit === 'factor') return 0.01;
  if (o.unit === 'percentage') return 1;
  return 0.1;
}

/** Number field with drag / click-to-type / arrow increments. */
export function numberField(o: NumberOpts): VNode {
  const text = editing.get(o.id);
  const cls = ['num-field', o.slider ? 'slider' : '', o.anim ? `anim-${o.anim}` : '', o.disabled ? 'disabled' : '', multiIds.has(o.id) ? 'multi-sel' : '', o.className ?? ''].join(' ');
  if (text !== undefined) {
    return h('input', {
      key: o.id,
      class: `${cls} editing`,
      value: text,
      'data-id': o.id,
      ref: (el: HTMLInputElement) =>
        requestAnimationFrame(() => {
          el.focus();
          el.select();
        }),
      oninput: (e: Event) => editing.set(o.id, (e.target as HTMLInputElement).value),
      onkeydown: (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          commitText(o, (e.target as HTMLInputElement).value);
          // Alt+Enter: also set the value on the other selected items
          if (e.altKey) buttonHooks.altEdit(o.id);
        } else if (e.key === 'Escape') {
          editing.delete(o.id);
          app.changed('ui');
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commitText(o, (e.target as HTMLInputElement).value);
          focusNextField(o.id, e.shiftKey);
        }
      },
      onblur: (e: FocusEvent) => {
        if (editing.has(o.id)) commitText(o, (e.target as HTMLInputElement).value);
      },
    });
  }
  const range = (o.softMax ?? o.max ?? 1) - (o.softMin ?? o.min ?? 0);
  const frac = o.slider ? Math.max(0, Math.min(1, (o.value - (o.softMin ?? o.min ?? 0)) / (range || 1))) : 0;
  const unit = o.unit === 'factor' ? 'none' : o.unit;
  return h(
    'div',
    {
      key: o.id,
      class: cls,
      'data-id': o.id,
      tabindex: '-1',
      'data-tip': o.tip ?? '',
      style: o.slider ? { '--fill': `${frac * 100}%` } : null,
      onpointerdown: (e: PointerEvent) => !o.disabled && startDrag(e, o),
      onwheel: (e: WheelEvent) => {
        if (!e.ctrlKey || o.disabled) return;
        e.preventDefault();
        e.stopPropagation();
        const v = clamp(o.value + (e.deltaY < 0 ? 1 : -1) * displayStep(o), o);
        o.set(v, true);
      },
    },
    o.slider ? h('div', { class: 'num-fill' }) : null,
    !o.slider && !o.disabled ? h('span', { class: 'num-arrow l', onpointerdown: (e: PointerEvent) => arrowStep(e, o, -1) }, '‹') : null,
    o.label && !o.noLabel ? h('span', { class: 'num-label' }, o.label) : null,
    h('span', { class: 'num-value' }, pct(o) ? formatNumber(o.value * 100, 'percentage') : formatNumber(o.value, unit, o.precision ?? (o.unit === 'factor' ? 3 : 3), o.int)),
    !o.slider && !o.disabled ? h('span', { class: 'num-arrow r', onpointerdown: (e: PointerEvent) => arrowStep(e, o, 1) }, '›') : null,
  );
}

function focusNextField(id: string, back: boolean) {
  const all = [...document.querySelectorAll('.num-field[data-id]')] as HTMLElement[];
  const i = all.findIndex((el) => el.dataset.id === id);
  const next = all[i + (back ? -1 : 1)];
  if (next) {
    const nid = next.dataset.id!;
    const val = next.querySelector('.num-value')?.textContent ?? '';
    editing.set(nid, val.replace(/ m$|°$/g, ''));
    app.changed('ui');
  }
}

function arrowStep(e: PointerEvent, o: NumberOpts, dir: number) {
  e.stopPropagation();
  e.preventDefault();
  o.set(clamp(o.value + dir * displayStep(o), o), true);
}

function commitText(o: NumberOpts, text: string) {
  editing.delete(o.id);
  if (text.trim().startsWith('#') && buttonHooks.hashExpression(o.id, text.trim().slice(1).trim())) return void app.changed('ui');
  try {
    const v = parseNumber(text.replace(/%\s*$/, ''), o.unit === 'factor' ? 'none' : o.unit) / (pct(o) ? 100 : 1);
    if (Number.isFinite(v)) o.set(clamp(v, o), true);
  } catch {
    app.report('ERROR', `Invalid expression: ${text}`);
  }
  app.changed('ui');
}

/** Ids of the stacked number fields taking part in a vertical multi-drag. */
const multiIds = new Set<string>();

/** Write a value through a field's registered binding (used for the other fields of a multi-drag). */
function writeBinding(id: string, v: number) {
  const b = getBinding(id);
  if (!b) return;
  if (b.min !== undefined) v = Math.max(b.min, v);
  if (b.max !== undefined) v = Math.min(b.max, v);
  if (b.int) v = Math.round(v);
  const cur = b.owner[b.key];
  if (b.index !== undefined && cur && typeof cur === 'object') {
    const next = Array.from(cur as ArrayLike<number>);
    next[b.index] = v;
    b.owner[b.key] = ArrayBuffer.isView(cur) ? new (cur.constructor as Float32ArrayConstructor)(next) : next;
  } else b.owner[b.key] = v;
  b.onChange?.();
}

function startDrag(e: PointerEvent, o: NumberOpts) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.currentTarget as HTMLElement;
  const x0 = e.clientX,
    y0 = e.clientY;
  let lastX = e.clientX,
    travel = 0;
  const start = o.value;
  let moved = false,
    value = start;
  const rect = el.getBoundingClientRect();
  const lockable = 'requestPointerLock' in el;
  const sliderJump = o.slider;
  const step = displayStep(o);
  // vertical drag first: gather the fields stacked in this column, then drag sideways to edit them all
  let multi: { phase: 'collect' | 'edit'; xRef: number; starts: Map<string, number> } | null = null;
  const collect = (y: number) => {
    const lo = Math.min(y0, y),
      hi = Math.max(y0, y);
    const cx = rect.left + rect.width / 2;
    multiIds.clear();
    multiIds.add(o.id);
    for (const f of document.querySelectorAll<HTMLElement>('.num-field[data-id]')) {
      const r = f.getBoundingClientRect();
      const id = f.dataset.id!;
      if (id === o.id || f.classList.contains('disabled') || Math.abs(r.left + r.width / 2 - cx) > rect.width / 2) continue;
      const cy = r.top + r.height / 2;
      if (cy < lo - r.height / 2 || cy > hi + r.height / 2) continue;
      const b = getBinding(id);
      const v = b ? bindingValue(b) : undefined;
      if (typeof v !== 'number') continue;
      multiIds.add(id);
      if (!multi!.starts.has(id)) multi!.starts.set(id, v);
    }
    app.changed('ui');
  };
  const lock = () => {
    if (lockable && !sliderJump) {
      try {
        void (el.requestPointerLock?.() as unknown as Promise<void> | undefined)?.catch?.(() => {});
      } catch {
        // pointer lock is optional
      }
    }
  };
  const move = (ev: PointerEvent) => {
    const dx = document.pointerLockElement ? ev.movementX : ev.clientX - lastX;
    lastX = ev.clientX;
    if (!moved && !multi && !sliderJump && Math.abs(ev.clientY - y0) > 8 && Math.abs(ev.clientY - y0) > Math.abs(ev.clientX - x0) * 1.5) {
      multi = { phase: 'collect', xRef: ev.clientX, starts: new Map() };
      setWidgetDragging(true);
    }
    if (multi?.phase === 'collect') {
      collect(ev.clientY);
      if (Math.abs(ev.clientX - multi.xRef) < 6) return;
      multi.phase = 'edit';
      moved = true;
      lock();
      return;
    }
    travel += Math.abs(dx);
    if (!moved && travel < 3) return;
    if (!moved) {
      moved = true;
      setWidgetDragging(true);
      lock();
    }
    if (sliderJump) {
      const lo = o.softMin ?? o.min ?? 0,
        hi = o.softMax ?? o.max ?? 1;
      const f = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      value = lo + (hi - lo) * f;
      if (ev.shiftKey) value = start + (value - start) * 0.1;
    } else {
      const precise = ev.shiftKey ? 0.1 : 1;
      value += dx * step * 0.1 * precise * (o.int ? 5 : 1);
    }
    let v = clamp(value, o);
    if (ev.ctrlKey) {
      const snap = o.unit === 'angle' ? (5 * Math.PI) / 180 : o.int ? 1 : step;
      v = Math.round(v / snap) * snap;
    }
    if (multi) for (const [id, s0] of multi.starts) writeBinding(id, s0 + (v - start));
    o.set(v, false);
  };
  const finishMulti = () => {
    multiIds.clear();
    app.changed('ui');
  };
  const up = (ev: PointerEvent) => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('keydown', key, true);
    if (document.pointerLockElement) document.exitPointerLock();
    setWidgetDragging(false);
    if (multi && multi.phase === 'collect') {
      // released without editing: nothing changes
      finishMulti();
      return;
    }
    if (!moved) {
      editing.set(o.id, o.int ? String(Math.round(start)) : o.unit === 'angle' ? trim((start * 180) / Math.PI, 4) : pct(o) ? trim(start * 100, 3) : trim(start, 5));
      app.changed('ui');
      return;
    }
    const v = clamp(value, o);
    if (multi) {
      for (const [id, s0] of multi.starts) writeBinding(id, s0 + (v - start));
      finishMulti();
    }
    o.set(v, true);
    // Alt held: copy the result to the other selected items
    if (ev.altKey) buttonHooks.altEdit(o.id);
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      removeEventListener('keydown', key, true);
      if (document.pointerLockElement) document.exitPointerLock();
      setWidgetDragging(false);
      if (multi) {
        for (const [id, s0] of multi.starts) writeBinding(id, s0);
        finishMulti();
      }
      o.set(start, false);
      app.changed('doc');
    }
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  addEventListener('keydown', key, true);
}

// ---------------------------------------------------------------------------

/** Press on a checkbox and drag over others to set them all to the same state. */
let checkDrag: { value: boolean; done: Set<string> } | null = null;

export function checkbox(id: string, label: string, value: boolean, set: (v: boolean) => void, opts: { disabled?: boolean; tip?: string; anim?: string | null } = {}): VNode {
  return h(
    'label',
    {
      key: id,
      'data-id': id,
      class: { checkbox: true, on: value, disabled: !!opts.disabled, [`anim-${opts.anim}`]: !!opts.anim },
      'data-tip': opts.tip ?? '',
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        if (e.button !== 0 || opts.disabled) return;
        checkDrag = { value: !value, done: new Set([id]) };
        addEventListener('pointerup', () => (checkDrag = null), { once: true, capture: true });
        set(!value);
        // Alt+click: set the same value on the other selected items
        if (e.altKey) buttonHooks.altEdit(id);
      },
      onpointerenter: () => {
        const d = checkDrag;
        if (!d || opts.disabled || d.done.has(id)) return;
        d.done.add(id);
        if (value !== d.value) set(d.value);
      },
    },
    h('span', { class: 'cb-box' }, value ? icon('check') : null),
    label ? h('span', { class: 'cb-label' }, label) : null,
  );
}

export function toggleButton(id: string, content: Child, value: boolean, set: (v: boolean) => void, opts: { tip?: string; className?: string; disabled?: boolean } = {}): VNode {
  return h(
    'button',
    {
      key: id,
      class: `tbtn ${value ? 'on' : ''} ${opts.className ?? ''}`,
      'data-tip': opts.tip ?? '',
      disabled: !!opts.disabled,
      'aria-pressed': value ? 'true' : 'false',
      onclick: () => set(!value),
    },
    content,
  );
}

export function button(id: string, content: Child, onClick: (e: MouseEvent) => void, opts: { tip?: string; className?: string; disabled?: boolean; active?: boolean } = {}): VNode {
  return h(
    'button',
    {
      key: id,
      class: `btn ${opts.className ?? ''} ${opts.active ? 'on' : ''}`,
      'data-tip': opts.tip ?? '',
      disabled: !!opts.disabled,
      onclick: (e: MouseEvent) => onClick(e),
    },
    content,
  );
}

export function opButton(idname: string, label?: string, props: Record<string, unknown> = {}, opts: { icon?: string; className?: string; tip?: string } = {}): VNode {
  const enabled = app.poll(idname);
  return h(
    'button',
    {
      key: `op-${idname}-${label ?? ''}-${JSON.stringify(props)}`,
      class: `btn op ${opts.className ?? ''}`,
      disabled: !enabled,
      'data-tip': menuSettings.pythonTips && opts.tip ? `${opts.tip}\nPython: bpy.ops.${idname}()` : (opts.tip ?? ''),
      onclick: (e: MouseEvent) => app.run(idname, props, { event: { x: e.clientX, y: e.clientY } }),
    },
    opts.icon ? icon(opts.icon) : null,
    label ?? '',
  );
}

export interface EnumItem {
  value: string;
  label: string;
  icon?: string;
  description?: string;
}

/** Dropdown enum (menu) */
export function enumMenu(id: string, items: EnumItem[], value: string, set: (v: string) => void, opts: { label?: string; iconOnly?: boolean; tip?: string; className?: string; disabled?: boolean; title?: string } = {}): VNode {
  const cur = items.find((i) => i.value === value);
  return h(
    'button',
    {
      key: id,
      'data-id': id,
      class: `enum-menu ${opts.className ?? ''}`,
      'data-tip': opts.tip ?? cur?.description ?? '',
      disabled: !!opts.disabled,
      // Ctrl+wheel steps through the items
      onwheel: (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey) || opts.disabled || !items.length) return;
        e.preventDefault();
        e.stopPropagation();
        const i = items.findIndex((it) => it.value === value);
        const next = items[Math.max(0, Math.min(items.length - 1, (i < 0 ? 0 : i) + (e.deltaY > 0 ? 1 : -1)))];
        if (next && next.value !== value) set(next.value);
      },
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        const alt = e.altKey;
        const menu: MenuItem[] = items.map((it) => ({
          label: it.label,
          icon: it.icon,
          active: it.value === value,
          description: it.description,
          action: () => {
            set(it.value);
            // opened with Alt: also set the choice on the other selected items
            if (alt) buttonHooks.altEdit(id);
          },
        }));
        openMenu(menu, e.currentTarget as HTMLElement, { title: opts.title });
      },
    },
    cur?.icon ? icon(cur.icon) : null,
    opts.iconOnly ? null : h('span', { class: 'em-label' }, cur?.label ?? value ?? ''),
    h('span', { class: 'em-arrow' }, icon('down_arrow_hlt')),
  );
}

/** Row of radio buttons (expanded enum). */
export function enumRow(id: string, items: EnumItem[], value: string, set: (v: string) => void, opts: { iconOnly?: boolean; multi?: string[]; className?: string } = {}): VNode {
  return h(
    'div',
    {
      key: id,
      'data-id': id,
      class: `enum-row ${opts.className ?? ''}`,
      onwheel: (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey) || opts.multi || !items.length) return;
        e.preventDefault();
        e.stopPropagation();
        const i = items.findIndex((it) => it.value === value);
        const next = items[Math.max(0, Math.min(items.length - 1, (i < 0 ? 0 : i) + (e.deltaY > 0 ? 1 : -1)))];
        if (next && next.value !== value) set(next.value);
      },
    },
    items.map((it) =>
      h(
        'button',
        {
          key: it.value,
          class: { on: opts.multi ? opts.multi.includes(it.value) : it.value === value },
          'data-tip': it.description ?? it.label,
          onclick: () => set(it.value),
        },
        it.icon ? icon(it.icon) : null,
        opts.iconOnly ? null : it.label,
      ),
    ),
  );
}

export function textField(id: string, value: string, set: (v: string) => void, opts: { placeholder?: string; className?: string; icon?: string; live?: boolean } = {}): VNode {
  return h(
    'label',
    { key: id, class: `text-field ${opts.className ?? ''}` },
    opts.icon ? icon(opts.icon) : null,
    h('input', {
      value,
      placeholder: opts.placeholder ?? '',
      spellcheck: 'false',
      oninput: opts.live ? (e: Event) => set((e.target as HTMLInputElement).value) : null,
      onchange: opts.live ? null : (e: Event) => set((e.target as HTMLInputElement).value),
      onkeydown: (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Color

export const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);
export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export function colorCss(rgb: number[], linear = true) {
  const c = rgb.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, linear ? linearToSrgb(x) : x)) * 255));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function colorHex(rgb: number[], linear = true) {
  return rgb
    .slice(0, 3)
    .map((x) => Math.round(Math.max(0, Math.min(1, linear ? linearToSrgb(x) : x)) * 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  let hh = 0;
  if (d > 0) {
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh /= 6;
    if (hh < 0) hh += 1;
  }
  return [hh, max === 0 ? 0 : d / max, max];
}

export function hsvToHsl(hh: number, s: number, v: number): [number, number, number] {
  const l = v * (1 - s / 2);
  return [hh, l <= 0 || l >= 1 ? 0 : (v - l) / Math.min(l, 1 - l), l];
}

export function hslToHsv(hh: number, s: number, l: number): [number, number, number] {
  const v = l + s * Math.min(l, 1 - l);
  return [hh, v <= 0 ? 0 : 2 * (1 - l / v), v];
}

export function hsvToRgb(hh: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(hh * 6),
    f = hh * 6 - i,
    p = v * (1 - s),
    q = v * (1 - f * s),
    t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

export function colorSwatch(id: string, value: number[], set: (v: number[], final: boolean) => void, opts: { alpha?: boolean; linear?: boolean; label?: string; anim?: string | null } = {}): VNode {
  const linear = opts.linear !== false;
  return h(
    'button',
    {
      key: id,
      'data-id': id,
      class: { 'color-swatch': true, [`anim-${opts.anim}`]: !!opts.anim },
      style: { '--swatch': colorCss(value, linear), '--alpha': String(value[3] ?? 1) },
      'data-tip': `Color\n#${colorHex(value, linear)}`,
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        openColorPicker(e.currentTarget as HTMLElement, value, set, opts.alpha ?? value.length > 3, linear);
      },
    },
    h('span', { class: 'sw-color' }),
    opts.alpha || value.length > 3 ? h('span', { class: 'sw-alpha' }) : null,
  );
}

function openColorPicker(anchor: HTMLElement, initial: number[], set: (v: number[], final: boolean) => void, alpha: boolean, linear: boolean) {
  const disp = initial.slice(0, 3).map((x) => (linear ? linearToSrgb(x) : x));
  let [hh, s, v] = rgbToHsv(disp[0], disp[1], disp[2]);
  let a = initial[3] ?? 1;
  let mode: 'RGB' | 'HSV' | 'HEX' = 'HSV';
  const out = () => {
    const rgb = hsvToRgb(hh, s, v).map((x) => (linear ? srgbToLinear(x) : x));
    return alpha ? [...rgb, a] : rgb;
  };
  const emit = (final: boolean) => set(out(), final);
  // picker layout: a 2D field (disc or square) for two components and a bar for the third
  const type = widgetSettings.colorPicker;
  const circle = type.startsWith('CIRCLE');
  const toPicker = (H: number, S: number, V: number): [number, number, number] => {
    if (type === 'CIRCLE_HSL') {
      const [, sl, l] = hsvToHsl(H, S, V);
      return [H, sl, l];
    }
    if (type === 'SQUARE_SV') return [S, V, H];
    if (type === 'SQUARE_HS') return [H, S, V];
    if (type === 'SQUARE_HV') return [H, V, S];
    return [H, S, V];
  };
  const fromPicker = (pa: number, pb: number, pc: number): [number, number, number] => {
    if (type === 'CIRCLE_HSL') return hslToHsv(pa, pb, pc);
    if (type === 'SQUARE_SV') return [pc, pa, pb];
    if (type === 'SQUARE_HS') return [pa, pb, pc];
    if (type === 'SQUARE_HV') return [pa, pc, pb];
    return [pa, pb, pc];
  };
  const setPicker = (pa: number, pb: number, pc: number) => {
    [hh, s, v] = fromPicker(pa, pb, pc);
  };
  let wheelCanvas: HTMLCanvasElement | null = null;
  const drawWheel = (c: HTMLCanvasElement) => {
    wheelCanvas = c;
    const ctx = c.getContext('2d')!;
    const size = c.width,
      r = size / 2;
    const pc = toPicker(hh, s, v)[2];
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        let pa: number, pb: number;
        let alphaPx = 1;
        if (circle) {
          const dx = x - r,
            dy = y - r,
            d = Math.hypot(dx, dy) / r;
          if (d > 1) {
            img.data[i + 3] = 0;
            continue;
          }
          pa = (Math.atan2(-dy, dx) / (Math.PI * 2) + 1) % 1;
          pb = d;
          alphaPx = Math.min(1, (1 - d) * r);
        } else {
          pa = x / (size - 1);
          pb = 1 - y / (size - 1);
        }
        const [ch, cs, cv] = fromPicker(pa, pb, pc);
        const [cr, cg, cb] = hsvToRgb(ch, cs, cv);
        img.data[i] = cr * 255;
        img.data[i + 1] = cg * 255;
        img.data[i + 2] = cb * 255;
        img.data[i + 3] = alphaPx * 255;
      }
    ctx.putImageData(img, 0, 0);
  };
  const pop = openPopover(anchor, () => {
    if (wheelCanvas) drawWheel(wheelCanvas);
    const [pa, pb, pc] = toPicker(hh, s, v);
    const ang = pa * Math.PI * 2;
    const cur = hsvToRgb(hh, s, v);
    const barStops = Array.from({ length: 9 }, (_, k) => {
      const t = k / 8;
      const [bh, bs, bv] = fromPicker(pa, pb, t);
      return `rgb(${hsvToRgb(bh, bs, bv).map((x) => Math.round(x * 255)).join(',')}) ${(1 - t) * 100}%`;
    }).reverse();
    return h(
      'div',
      { class: 'color-picker', 'data-picker': type },
      h(
        'div',
        { class: 'cp-top' },
        h(
          'div',
          { class: { 'cp-wheel': true, 'cp-square': !circle } },
          h('canvas', {
            width: 160,
            height: 160,
            ref: drawWheel,
            onpointerdown: (e: PointerEvent) => {
              const c = e.currentTarget as HTMLCanvasElement;
              const pick = (ev: PointerEvent) => {
                const r = c.getBoundingClientRect();
                const [, , pcNow] = toPicker(hh, s, v);
                if (circle) {
                  const dx = ev.clientX - r.left - r.width / 2,
                    dy = ev.clientY - r.top - r.height / 2;
                  setPicker((Math.atan2(-dy, dx) / (Math.PI * 2) + 1) % 1, Math.min(1, Math.hypot(dx, dy) / (r.width / 2)), pcNow);
                } else {
                  const fx = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)),
                    fy = Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height));
                  setPicker(fx, fy, pcNow);
                }
                emit(false);
                pop.redraw();
              };
              setWidgetDragging(true);
              pick(e);
              const up = () => {
                removeEventListener('pointermove', pick);
                removeEventListener('pointerup', up);
                setWidgetDragging(false);
                emit(true);
              };
              addEventListener('pointermove', pick);
              addEventListener('pointerup', up);
            },
          }),
          h('div', { class: 'cp-cursor', style: circle ? { left: `${80 + Math.cos(ang) * pb * 80}px`, top: `${80 - Math.sin(ang) * pb * 80}px` } : { left: `${pa * 160}px`, top: `${(1 - pb) * 160}px` } }),
        ),
        h(
          'div',
          {
            class: 'cp-value',
            style: { background: `linear-gradient(to bottom, ${barStops.join(', ')})` },
            onpointerdown: (e: PointerEvent) => {
              const bar = e.currentTarget as HTMLElement;
              const pick = (ev: PointerEvent) => {
                const r = bar.getBoundingClientRect();
                const [qa, qb] = toPicker(hh, s, v);
                setPicker(qa, qb, Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height)));
                emit(false);
                pop.redraw();
              };
              setWidgetDragging(true);
              pick(e);
              const up = () => {
                removeEventListener('pointermove', pick);
                removeEventListener('pointerup', up);
                setWidgetDragging(false);
                emit(true);
              };
              addEventListener('pointermove', pick);
              addEventListener('pointerup', up);
            },
          },
          h('div', { class: 'cp-vcursor', style: { top: `${(1 - pc) * 100}%` } }),
        ),
      ),
      enumRow('cp-mode', ['RGB', 'HSV', 'HEX'].map((m) => ({ value: m, label: m === 'HEX' ? 'Hex' : m })), mode, (m) => {
        mode = m as typeof mode;
        pop.redraw();
      }),
      mode === 'HEX'
        ? textField('cp-hex', colorHex(out(), linear), (t) => {
            const m = /^#?([0-9a-f]{6})$/i.exec(t.trim());
            if (!m) return;
            const n = parseInt(m[1], 16);
            [hh, s, v] = rgbToHsv(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
            emit(true);
            pop.redraw();
          })
        : h(
            'div',
            { class: 'col' },
            (mode === 'RGB' ? ['R', 'G', 'B'] : ['H', 'S', 'V']).map((lab, i) =>
              numberField({
                id: `cp-${lab}`,
                label: lab,
                value: mode === 'RGB' ? (linear ? srgbToLinear(cur[i]) : cur[i]) : [hh, s, v][i],
                min: 0,
                max: mode === 'RGB' ? undefined : 1,
                softMax: 1,
                slider: true,
                set: (x, final) => {
                  if (mode === 'RGB') {
                    const c = [...cur] as [number, number, number];
                    c[i] = linear ? linearToSrgb(Math.max(0, x)) : Math.max(0, x);
                    [hh, s, v] = rgbToHsv(c[0], c[1], c[2]);
                  } else if (i === 0) hh = x;
                  else if (i === 1) s = x;
                  else v = x;
                  emit(final);
                  pop.redraw();
                },
              }),
            ),
          ),
      alpha
        ? numberField({
            id: 'cp-A',
            label: 'A',
            value: a,
            min: 0,
            max: 1,
            slider: true,
            set: (x, final) => {
              a = x;
              emit(final);
              pop.redraw();
            },
          })
        : null,
    );
  }, { width: 220, className: 'cp-pop' });
}

// ---------------------------------------------------------------------------
// Layout helpers

/** Property row with a left label column (property split layout). */
export function row(label: string, ...content: Child[]): VNode {
  return h('div', { class: 'prop-row' }, h('div', { class: 'pr-label' }, label), h('div', { class: 'pr-content' }, ...content));
}

/** Aligned column of stacked fields. */
export function col(...content: Child[]): VNode {
  return h('div', { class: 'col' }, ...content);
}

export function rowAligned(...content: Child[]): VNode {
  return h('div', { class: 'row-aligned' }, ...content);
}

export function decorator(state: 'none' | 'keyed' | 'animated' | 'driven', onClick?: () => void, onContext?: (e: MouseEvent) => void): VNode {
  return h(
    'button',
    {
      class: `decorator ${state}`,
      'data-tip': state === 'none' ? 'Insert Keyframe' : state === 'keyed' ? 'Delete Keyframe' : 'Insert Keyframe',
      onclick: onClick ?? null,
      oncontextmenu: onContext ?? null,
      tabindex: '-1',
    },
    icon(state === 'keyed' ? 'decorate_keyframe' : state === 'animated' ? 'decorate_animate' : 'decorate'),
  );
}

const panelOpen = new Map<string, boolean>();
export function isPanelOpen(id: string, def = true) {
  return panelOpen.get(id) ?? def;
}
export function setPanelOpen(id: string, open: boolean) {
  panelOpen.set(id, open);
}

/** Collapsible panel (sub-panels nest inside). */
/** Text the Properties search is filtering by; while set, panels show their contents. */
let panelSearch = '';
export function setPanelSearch(q: string) {
  panelSearch = q;
}

/** Press on a panel header and drag over others to open / close them all. */
let panelDrag: { open: boolean; done: Set<string> } | null = null;

/** Collapsible panel (sub-panels nest inside). */
export function panel(id: string, title: Child, body: () => Child, opts: { closed?: boolean; header?: Child; sub?: boolean; className?: string; icon?: string } = {}): VNode {
  const open = panelSearch ? true : isPanelOpen(id, !opts.closed);
  return h(
    'section',
    { key: id, 'data-panel': id, class: { panel: true, sub: !!opts.sub, open, [opts.className ?? '']: !!opts.className } },
    h(
      'header',
      {
        class: 'panel-header',
        onpointerdown: (e: PointerEvent) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, .num-field, label, .enum-menu, .ph-grip')) return;
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            // Ctrl+click: open this panel and collapse its siblings
            const section = (e.currentTarget as HTMLElement).parentElement;
            for (const sib of section?.parentElement?.children ?? []) {
              const pid = (sib as HTMLElement).dataset?.panel;
              if (pid && pid !== id) setPanelOpen(pid, false);
            }
            setPanelOpen(id, true);
          } else {
            setPanelOpen(id, !open);
            panelDrag = { open: !open, done: new Set([id]) };
            addEventListener('pointerup', () => (panelDrag = null), { once: true, capture: true });
          }
          app.changed('ui');
        },
        onpointerenter: () => {
          const d = panelDrag;
          if (!d || d.done.has(id)) return;
          d.done.add(id);
          if (isPanelOpen(id, !opts.closed) !== d.open) {
            setPanelOpen(id, d.open);
            app.changed('ui');
          }
        },
      },
      h('span', { class: 'ph-arrow' }, icon(open ? 'disclosure_tri_down' : 'disclosure_tri_right')),
      opts.icon ? icon(opts.icon) : null,
      opts.header ?? null,
      h('span', { class: 'ph-title' }, title),
      opts.sub ? null : h('span', { class: 'ph-grip', 'data-tip': 'Drag to reorder panels' }, '⠿'),
    ),
    open ? h('div', { class: 'panel-body' }, body()) : null,
  );
}

export function separator(): VNode {
  return h('div', { class: 'ui-sep' });
}

export function label(text: string, opts: { icon?: string; className?: string } = {}): VNode {
  return h('div', { class: `ui-label ${opts.className ?? ''}` }, opts.icon ? icon(opts.icon) : null, text);
}
