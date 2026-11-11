// Controls generated from ParamSpec: sliders with numeric fields and units,
// selects, checkboxes, colors and click-to-place points.
import { escapeXML } from '../../model/assets';
import type { NormPath, ParamSpec, ParamValues, Pin } from '../../imaging/types';
import './editors.css';

const RANGE = 1000;
// Wide ranges (radius 0.1–1000 px) use a cubic slider so small values stay
// adjustable; the numeric field always accepts exact values.
const cubic = (s: Extract<ParamSpec, { type: 'number' }>) => s.min >= 0 && s.max - s.min >= 100 && s.max / Math.max(s.min, 0.1) >= 100;
function toSlider(s: Extract<ParamSpec, { type: 'number' }>, v: number) {
  const t = (v - s.min) / (s.max - s.min);
  return Math.round((cubic(s) ? Math.cbrt(Math.max(0, t)) : t) * RANGE);
}
function fromSlider(s: Extract<ParamSpec, { type: 'number' }>, k: number) {
  const t = k / RANGE;
  const v = s.min + (cubic(s) ? t * t * t : t) * (s.max - s.min);
  return snap(s, v);
}
function stepOf(s: Extract<ParamSpec, { type: 'number' }>) {
  if (s.step) return s.step;
  return s.max - s.min <= 20 || !Number.isInteger(s.min) || !Number.isInteger(s.default) ? 0.1 : 1;
}
function snap(s: Extract<ParamSpec, { type: 'number' }>, v: number) {
  const st = stepOf(s);
  const r = Math.round(v / st) * st;
  return Math.min(s.max, Math.max(s.min, Number(r.toFixed(st < 1 ? 2 : 0))));
}
const unitLabel = (u?: string) => (u === 'levels' ? 'levels' : (u ?? ''));

export type PointPicker = { draw: (canvas: HTMLCanvasElement) => void };
export type FormOptions = {
  // Draws the image under a point control (the whole region, small).
  thumbnail?: (canvas: HTMLCanvasElement) => void;
  // Which keys to show (sections); default all.
  keys?: string[];
};

/** Build controls into `host`; `onChange` fires on every edit. */
export function paramForm(host: HTMLElement, specs: ParamSpec[], values: ParamValues, onChange: (v: ParamValues) => void, opts: FormOptions = {}) {
  const shown = opts.keys ? specs.filter((s) => opts.keys!.includes(s.key)) : specs;
  const kernel = shown.filter((s) => /^k\d+$/.test(s.key));
  const html: string[] = [];
  if (kernel.length === 25)
    html.push(`<div class="fp-kernel" role="group" aria-label="Convolution kernel">${kernel.map((s) => `<input type="number" data-key="${s.key}" aria-label="${escapeXML(s.label)}" min="${s.type === 'number' ? s.min : ''}" max="${s.type === 'number' ? s.max : ''}" step="1">`).join('')}</div>`);
  for (const s of shown) {
    if (kernel.length === 25 && kernel.includes(s)) continue;
    const id = `fp-${s.key}-${Math.random().toString(36).slice(2, 7)}`;
    if (s.type === 'number')
      html.push(`<div class="fp-row fp-number"><label for="${id}">${escapeXML(s.label)}</label><input id="${id}" type="number" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${stepOf(s)}"><span class="fp-unit">${escapeXML(unitLabel(s.unit))}</span><input type="range" data-range="${s.key}" min="0" max="${RANGE}" aria-label="${escapeXML(s.label)}"></div>`);
    else if (s.type === 'select')
      html.push(`<div class="fp-row"><label for="${id}">${escapeXML(s.label)}</label><select id="${id}" data-key="${s.key}">${s.options.map((o) => `<option value="${escapeXML(o.value)}">${escapeXML(o.label)}</option>`).join('')}</select></div>`);
    else if (s.type === 'checkbox') html.push(`<div class="fp-row fp-check"><label><input type="checkbox" data-key="${s.key}"> ${escapeXML(s.label)}</label></div>`);
    else if (s.type === 'color') html.push(`<div class="fp-row"><label for="${id}">${escapeXML(s.label)}</label><input id="${id}" type="color" data-key="${s.key}"></div>`);
    else if (s.type === 'pins')
      html.push(`<div class="fp-row fp-point fp-pins" data-pins-row="${s.key}"><span class="fp-point-label">${escapeXML(s.label)}</span><canvas class="fp-point-canvas fp-editor" data-pins="${s.key}" width="260" height="180" tabindex="0" title="Click to add a pin, drag to move it" aria-label="${escapeXML(s.label)}: click to add pins, drag to move, Delete removes the selected pin"></canvas><div class="fp-number fp-pin-value"><label for="${id}">Selected Pin</label><input id="${id}" type="number" data-pin-value="${s.key}" min="${s.min}" max="${s.max}" step="1"><span class="fp-unit">${escapeXML(unitLabel(s.unit))}</span><input type="range" data-pin-range="${s.key}" min="0" max="${RANGE}" aria-label="${escapeXML(s.label)} value"></div><div class="fp-editor-actions"><button type="button" data-pin-remove="${s.key}">Remove Pin</button><span class="fp-point-value" data-point-value="${s.key}"></span></div></div>`);
    else if (s.type === 'paths')
      html.push(`<div class="fp-row fp-point fp-paths"><span class="fp-point-label">${escapeXML(s.label)}</span><canvas class="fp-point-canvas fp-editor" data-paths="${s.key}" width="260" height="180" tabindex="0" title="Drag to draw a path; Alt-click a path to remove it" aria-label="${escapeXML(s.label)}: drag to draw, Alt-click to remove"></canvas><div class="fp-editor-actions"><button type="button" data-paths-undo="${s.key}">Remove Last</button><button type="button" data-paths-clear="${s.key}">Clear</button><span class="fp-point-value" data-point-value="${s.key}"></span></div></div>`);
    else
      html.push(`<div class="fp-row fp-point"><span class="fp-point-label">${escapeXML(s.label)}</span><canvas class="fp-point-canvas" data-point="${s.key}" width="180" height="120" title="Click or drag to place" aria-label="${escapeXML(s.label)}: click to place"></canvas><span class="fp-point-value" data-point-value="${s.key}"></span></div>`);
  }
  host.innerHTML = html.join('');
  const cur: ParamValues = { ...values };
  // Only this form's keys are reported, so several forms can share one value set.
  const own = (): ParamValues => Object.fromEntries(shown.map((x) => [x.key, cur[x.key]]));
  const thumbs = new Map<string, HTMLCanvasElement>();

  const sync = () => {
    for (const s of shown) {
      const v = cur[s.key];
      const input = host.querySelector<HTMLInputElement>(`[data-key="${s.key}"]`);
      if (s.type === 'number') {
        if (input && document.activeElement !== input) input.value = String(v);
        const r = host.querySelector<HTMLInputElement>(`[data-range="${s.key}"]`);
        if (r) r.value = String(toSlider(s, v as number));
      } else if (s.type === 'checkbox') {
        if (input) input.checked = !!v;
      } else if (s.type === 'pins' || s.type === 'paths') {
        const c = editors.get(s.key);
        c?.draw();
      } else if (s.type === 'point') {
        const p = v as { x: number; y: number };
        const lab = host.querySelector(`[data-point-value="${s.key}"]`);
        if (lab) lab.textContent = `${Math.round(p.x * 100)}%, ${Math.round(p.y * 100)}%`;
        const c = thumbs.get(s.key);
        if (c) drawPoint(c, p);
      } else if (input) input.value = String(v);
    }
  };
  const drawPoint = (c: HTMLCanvasElement, p: { x: number; y: number }) => {
    const base = (c as HTMLCanvasElement & { base?: HTMLCanvasElement }).base;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (base) ctx.drawImage(base, 0, 0);
    const x = p.x * c.width,
      y = p.y * c.height;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 8, y);
    ctx.lineTo(x + 8, y);
    ctx.moveTo(x, y - 8);
    ctx.lineTo(x, y + 8);
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  for (const c of host.querySelectorAll<HTMLCanvasElement>('[data-point]')) {
    thumbs.set(c.dataset.point!, c);
    if (opts.thumbnail) {
      const base = document.createElement('canvas');
      base.width = c.width;
      base.height = c.height;
      opts.thumbnail(base);
      c.width = base.width;
      c.height = base.height;
      (c as HTMLCanvasElement & { base?: HTMLCanvasElement }).base = base;
    }
    let down = false;
    const place = (ev: PointerEvent) => {
      const r = c.getBoundingClientRect();
      cur[c.dataset.point!] = { x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)) };
      sync();
      onChange(own());
    };
    c.addEventListener('pointerdown', (ev) => {
      down = true;
      c.setPointerCapture(ev.pointerId);
      place(ev);
    });
    c.addEventListener('pointermove', (ev) => down && place(ev));
    c.addEventListener('pointerup', () => (down = false));
  }
  // Pin and path editors draw over the same region thumbnail as points.
  const editors = new Map<string, { draw: () => void }>();
  const baseFor = (c: HTMLCanvasElement) => {
    if (!opts.thumbnail) return undefined;
    const base = document.createElement('canvas');
    base.width = c.width;
    base.height = c.height;
    opts.thumbnail(base);
    c.width = base.width;
    c.height = base.height;
    return base;
  };
  for (const c of host.querySelectorAll<HTMLCanvasElement>('[data-pins]')) {
    const key = c.dataset.pins!;
    const spec = shown.find((x) => x.key === key) as Extract<ParamSpec, { type: 'pins' }>;
    editors.set(key, pinEditor(c, spec, baseFor(c), host, () => cur[key] as Pin[], (pins, final) => {
      cur[key] = pins;
      if (final) onChange(own());
    }));
  }
  for (const c of host.querySelectorAll<HTMLCanvasElement>('[data-paths]')) {
    const key = c.dataset.paths!;
    const spec = shown.find((x) => x.key === key) as Extract<ParamSpec, { type: 'paths' }>;
    editors.set(key, pathEditor(c, spec, baseFor(c), host, () => cur[key] as NormPath[], (paths) => {
      cur[key] = paths;
      onChange(own());
    }));
  }
  host.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.dataset.pinValue || t.dataset.pinRange) return;
    const rk = t.dataset.range;
    if (rk) {
      const s = shown.find((x) => x.key === rk) as Extract<ParamSpec, { type: 'number' }>;
      cur[rk] = fromSlider(s, Number(t.value));
      sync();
      onChange(own());
      return;
    }
    const key = t.dataset.key;
    const s = shown.find((x) => x.key === key);
    if (!key || !s) return;
    if (s.type === 'number') {
      if (t.value === '' || !Number.isFinite(Number(t.value))) return;
      cur[key] = Math.min(s.max, Math.max(s.min, Number(t.value)));
    } else if (s.type === 'checkbox') cur[key] = t.checked;
    else cur[key] = t.value;
    sync();
    onChange(own());
  });
  host.addEventListener('change', (ev) => {
    // Normalize a typed number that was out of range once editing ends.
    const t = ev.target as HTMLInputElement;
    const s = shown.find((x) => x.key === t.dataset.key);
    if (s?.type === 'number') t.value = String(cur[s.key]);
  });
  // Arrow keys in numeric fields step by 1 (Shift: 10).
  host.addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLInputElement;
    const s = shown.find((x) => x.key === t.dataset.key);
    if (s?.type !== 'number' || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
    ev.preventDefault();
    const d = (ev.key === 'ArrowUp' ? 1 : -1) * (ev.shiftKey ? 10 : 1) * (stepOf(s) < 1 && !ev.shiftKey ? stepOf(s) * 10 : 1);
    cur[s.key] = snap(s, (cur[s.key] as number) + d);
    t.value = String(cur[s.key]);
    sync();
    onChange(own());
  });
  sync();
  return {
    values: own,
    set(v: ParamValues) {
      Object.assign(cur, v);
      sync();
    },
  };
}

// ----- Pin and path editors -----
const HIT = 9;
function drawBase(ctx: CanvasRenderingContext2D, c: HTMLCanvasElement, base?: HTMLCanvasElement) {
  ctx.clearRect(0, 0, c.width, c.height);
  if (base) ctx.drawImage(base, 0, 0);
  else {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, c.width, c.height);
  }
}
const pointer = (c: HTMLCanvasElement, ev: PointerEvent) => {
  const r = c.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)) };
};

/** Pins on the region thumbnail: click adds, drag moves, the selected pin's
 * value is edited below, Delete or Remove Pin removes it. */
function pinEditor(c: HTMLCanvasElement, spec: Extract<ParamSpec, { type: 'pins' }>, base: HTMLCanvasElement | undefined, host: HTMLElement, get: () => Pin[], set: (pins: Pin[], final: boolean) => void) {
  const key = spec.key;
  let selected = get().length - 1;
  const numSpec = { key, label: spec.label, type: 'number' as const, min: spec.min, max: spec.max, default: spec.default[0]?.value ?? spec.min, unit: spec.unit, step: 1 };
  const valueInput = host.querySelector<HTMLInputElement>(`[data-pin-value="${key}"]`)!;
  const range = host.querySelector<HTMLInputElement>(`[data-pin-range="${key}"]`)!;
  const label = host.querySelector(`[data-point-value="${key}"]`)!;
  const remove = host.querySelector<HTMLButtonElement>(`[data-pin-remove="${key}"]`)!;
  const draw = () => {
    const pins = get();
    if (selected >= pins.length) selected = pins.length - 1;
    const ctx = c.getContext('2d')!;
    drawBase(ctx, c, base);
    pins.forEach((p, i) => {
      const x = p.x * c.width,
        y = p.y * c.height;
      const t = (p.value - spec.min) / (spec.max - spec.min || 1);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = i === selected ? 2.5 : 1.5;
      ctx.strokeStyle = i === selected ? '#3d8bfd' : '#fff';
      ctx.stroke();
      // The arc shows the pin's value.
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, -Math.PI / 2, -Math.PI / 2 + Math.max(0.05, Math.cbrt(t)) * Math.PI * 2);
      ctx.stroke();
    });
    const pin = pins[selected];
    valueInput.disabled = range.disabled = remove.disabled = !pin;
    if (pin) {
      if (document.activeElement !== valueInput) valueInput.value = String(Math.round(pin.value * 10) / 10);
      range.value = String(toSlider(numSpec, pin.value));
    }
    label.textContent = pins.length ? `${pins.length} pin${pins.length === 1 ? '' : 's'}` : 'Click to add a pin';
  };
  const setValue = (v: number, final: boolean) => {
    const pins = get().map((p) => ({ ...p }));
    if (!pins[selected]) return;
    pins[selected].value = Math.min(spec.max, Math.max(spec.min, v));
    set(pins, final);
    draw();
  };
  valueInput.addEventListener('change', () => {
    const v = valueInput.value.trim() === '' ? NaN : Number(valueInput.value);
    if (Number.isFinite(v)) setValue(v, true);
    // Show the value in use (clamped, or kept for a blank entry).
    const pin = get()[selected];
    if (pin) valueInput.value = String(Math.round(pin.value * 10) / 10);
  });
  range.addEventListener('input', () => setValue(fromSlider(numSpec, Number(range.value)), false));
  range.addEventListener('change', () => setValue(fromSlider(numSpec, Number(range.value)), true));
  const removeSelected = () => {
    const pins = get().filter((_, i) => i !== selected);
    selected = pins.length - 1;
    set(pins, true);
    draw();
  };
  remove.addEventListener('click', removeSelected);
  c.addEventListener('keydown', (ev) => {
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      removeSelected();
    }
  });
  let drag: number | undefined;
  c.addEventListener('pointerdown', (ev) => {
    const p = pointer(c, ev);
    const pins = get().map((q) => ({ ...q }));
    const hit = pins.findIndex((q) => Math.hypot((q.x - p.x) * c.width, (q.y - p.y) * c.height) <= HIT);
    if (hit >= 0 && ev.altKey) {
      selected = hit;
      removeSelected();
      return;
    }
    if (hit >= 0) selected = hit;
    else if (pins.length < (spec.limit ?? 64)) {
      pins.push({ x: p.x, y: p.y, value: pins[selected]?.value ?? numSpec.default });
      selected = pins.length - 1;
      set(pins, true);
    }
    drag = selected;
    c.setPointerCapture(ev.pointerId);
    c.focus();
    draw();
  });
  c.addEventListener('pointermove', (ev) => {
    if (drag === undefined) return;
    const p = pointer(c, ev);
    const pins = get().map((q) => ({ ...q }));
    if (!pins[drag]) return;
    pins[drag] = { ...pins[drag], ...p };
    set(pins, false);
    draw();
  });
  c.addEventListener('pointerup', () => {
    if (drag !== undefined) set(get(), true);
    drag = undefined;
  });
  draw();
  return { draw };
}

/** Freehand paths on the region thumbnail: drag draws, Alt-click removes. */
function pathEditor(c: HTMLCanvasElement, spec: Extract<ParamSpec, { type: 'paths' }>, base: HTMLCanvasElement | undefined, host: HTMLElement, get: () => NormPath[], set: (paths: NormPath[]) => void) {
  const key = spec.key;
  const label = host.querySelector(`[data-point-value="${key}"]`)!;
  let current: NormPath | undefined;
  const draw = () => {
    const ctx = c.getContext('2d')!;
    drawBase(ctx, c, base);
    for (const path of [...get(), ...(current ? [current] : [])]) {
      if (!path.length) continue;
      const pts = path.map((p) => [p.x * c.width, p.y * c.height] as const);
      for (const [w, color] of [[3.5, 'rgba(0,0,0,0.6)'], [1.6, '#fff']] as const) {
        ctx.lineWidth = w;
        ctx.strokeStyle = color;
        ctx.lineJoin = ctx.lineCap = 'round';
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      }
      // Arrowhead: paths have a direction.
      const [x1, y1] = pts[pts.length - 1],
        [x0, y0] = pts[Math.max(0, pts.length - 4)];
      const a = Math.atan2(y1 - y0, x1 - x0);
      if (pts.length > 1) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(x1 + Math.cos(a) * 7, y1 + Math.sin(a) * 7);
        ctx.lineTo(x1 + Math.cos(a + 2.5) * 7, y1 + Math.sin(a + 2.5) * 7);
        ctx.lineTo(x1 + Math.cos(a - 2.5) * 7, y1 + Math.sin(a - 2.5) * 7);
        ctx.fill();
      }
    }
    const n = get().length;
    label.textContent = n ? `${n} path${n === 1 ? '' : 's'}` : 'Drag to draw a path';
  };
  const nearPath = (p: { x: number; y: number }) =>
    get().findIndex((path) => path.some((q, i) => {
      const r = path[i + 1] ?? q;
      const ax = q.x * c.width, ay = q.y * c.height, bx = r.x * c.width, by = r.y * c.height;
      const px = p.x * c.width, py = p.y * c.height;
      const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2)) : 0;
      return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))) <= HIT;
    }));
  c.addEventListener('pointerdown', (ev) => {
    const p = pointer(c, ev);
    if (ev.altKey) {
      const i = nearPath(p);
      if (i >= 0) {
        set(get().filter((_, k) => k !== i));
        draw();
      }
      return;
    }
    if (get().length >= (spec.limit ?? 32)) return;
    current = [p];
    c.setPointerCapture(ev.pointerId);
    draw();
  });
  c.addEventListener('pointermove', (ev) => {
    if (!current) return;
    const p = pointer(c, ev);
    const last = current[current.length - 1];
    if (Math.hypot((p.x - last.x) * c.width, (p.y - last.y) * c.height) < 3) return;
    current.push(p);
    draw();
  });
  c.addEventListener('pointerup', () => {
    const path = current;
    current = undefined;
    if (path && path.length > 1) set([...get(), simplify(path, 1.5 / Math.max(c.width, c.height))]);
    draw();
  });
  host.querySelector(`[data-paths-undo="${key}"]`)!.addEventListener('click', () => {
    set(get().slice(0, -1));
    draw();
  });
  host.querySelector(`[data-paths-clear="${key}"]`)!.addEventListener('click', () => {
    set([]);
    draw();
  });
  draw();
  return { draw };
}
/** Ramer–Douglas–Peucker simplification of a polyline (tolerance in path units). */
export function simplify(path: NormPath, tol: number): NormPath {
  if (path.length < 3) return path;
  let best = 0,
    at = 0;
  const a = path[0],
    b = path[path.length - 1];
  const dx = b.x - a.x,
    dy = b.y - a.y,
    len = Math.hypot(dx, dy) || 1e-9;
  for (let i = 1; i < path.length - 1; i++) {
    const d = Math.abs((path[i].x - a.x) * dy - (path[i].y - a.y) * dx) / len;
    if (d > best) {
      best = d;
      at = i;
    }
  }
  if (best <= tol) return [a, b];
  return [...simplify(path.slice(0, at + 1), tol).slice(0, -1), ...simplify(path.slice(at), tol)];
}
