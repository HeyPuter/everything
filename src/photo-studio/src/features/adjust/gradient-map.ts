// Gradient Map editor with a compact color-stop editor: presets, a preview
// bar, draggable stops (click below the bar to add, drag away to remove),
// per-stop color, location and midpoint, plus reverse and dither.
import { gradientTable, hexToRgb8, rgb8ToHex, type Gradient, type GradientColorStop, type RGB8 } from '../../imaging/adjust';
import type { AdjustHost } from './host';
import { button, checkbox, h } from './ui';
import { hexRgb } from '../pixels';

const stops = (...s: [number, RGB8][]): Gradient => ({ stops: s.map(([location, color]) => ({ location, color, midpoint: 0.5 })) });
// Original preset ramps.
export const GRADIENT_PRESETS: { id: string; label: string; make: (fg: RGB8, bg: RGB8) => Gradient }[] = [
  { id: 'fg-bg', label: 'Foreground to Background', make: (fg, bg) => stops([0, fg], [1, bg]) },
  { id: 'bw', label: 'Black, White', make: () => stops([0, [0, 0, 0]], [1, [255, 255, 255]]) },
  { id: 'sepia', label: 'Sepia', make: () => stops([0, [30, 18, 10]], [0.55, [150, 108, 68]], [1, [250, 238, 218]]) },
  { id: 'teal-orange', label: 'Teal to Orange', make: () => stops([0, [10, 32, 44]], [0.5, [92, 120, 118]], [1, [255, 196, 136]]) },
  { id: 'navy-cream', label: 'Navy and Cream', make: () => stops([0, [16, 24, 64]], [1, [246, 236, 206]]) },
  { id: 'violet-gold', label: 'Violet to Gold', make: () => stops([0, [36, 8, 60]], [0.45, [180, 50, 110]], [1, [255, 214, 96]]) },
  { id: 'copper', label: 'Copper', make: () => stops([0, [20, 8, 4]], [0.5, [176, 92, 52]], [1, [255, 226, 196]]) },
  { id: 'heat', label: 'Heat', make: () => stops([0, [0, 0, 0]], [0.35, [150, 0, 20]], [0.7, [255, 160, 0]], [1, [255, 255, 220]]) },
  { id: 'spectrum', label: 'Spectrum', make: () => stops([0, [80, 0, 160]], [0.25, [0, 90, 255]], [0.5, [0, 200, 90]], [0.75, [255, 220, 0]], [1, [255, 30, 30]]) },
];

export function gradientCss(g: Gradient, reverse = false, n = 24) {
  const t = gradientTable(g, n, reverse);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(`rgb(${Math.round(t[i * 4] * 255)} ${Math.round(t[i * 4 + 1] * 255)} ${Math.round(t[i * 4 + 2] * 255)}) ${((i / (n - 1)) * 100).toFixed(1)}%`);
  return `linear-gradient(90deg,${parts.join(',')})`;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function gradientMapEditor(body: HTMLElement, host: AdjustHost<'gradient-map'>) {
  const p = host.params;
  const g = p.gradient;
  g.stops.sort((a, b) => a.location - b.location);
  let selected = Math.min((host.ui.stop as number | undefined) ?? 0, g.stops.length - 1);

  const presets = h('div', { class: 'adj-gradient-presets', role: 'group', 'aria-label': 'Gradient presets' });
  for (const preset of GRADIENT_PRESETS) {
    const b = h('button', { type: 'button', class: 'adj-gradient-swatch', title: preset.label, 'aria-label': preset.label });
    const fg = hexRgb(host.e.color) as RGB8,
      bg = hexRgb(host.e.background) as RGB8;
    b.style.background = gradientCss(preset.make(fg, bg), false, 12);
    b.addEventListener('click', () => {
      p.gradient = preset.make(fg, bg);
      host.ui.stop = 0;
      host.change(true);
      host.rerender();
    });
    presets.append(b);
  }
  body.append(presets);

  const editor = h('div', { class: 'adj-gradient-editor' });
  editor.innerHTML = `<div class="adj-gradient-bar"></div><div class="adj-stop-lane" title="Click to add a color stop"></div>`;
  const bar = editor.querySelector<HTMLElement>('.adj-gradient-bar')!,
    lane = editor.querySelector<HTMLElement>('.adj-stop-lane')!;
  body.append(editor);

  const fields = h('div', { class: 'adj-stop-fields' });
  fields.innerHTML = `<label>Color <input type="color" aria-label="Stop color"></label><label>Location <input type="number" min="0" max="100" step="1" aria-label="Stop location"><small>%</small></label><label>Midpoint <input type="number" min="1" max="99" step="1" aria-label="Midpoint to next stop"><small>%</small></label>`;
  const [colorIn, locIn, midIn] = fields.querySelectorAll('input');
  const del = button('Delete stop', () => {
    if (g.stops.length <= 2) return;
    g.stops.splice(selected, 1);
    selected = Math.max(0, selected - 1);
    host.ui.stop = selected;
    draw();
    host.change(true);
  }, { icon: 'trash-2', cls: 'icon-button', title: 'Delete the selected stop' });
  fields.append(del);
  body.append(fields);

  const draw = () => {
    bar.style.background = gradientCss(g, false, 48);
    lane.innerHTML = g.stops
      .map((s, i) => `<button type="button" class="adj-stop ${i === selected ? 'sel' : ''}" data-i="${i}" style="left:${s.location * 100}%;--c:${rgb8ToHex(s.color)}" aria-label="Color stop ${i + 1} at ${Math.round(s.location * 100)}%"></button>`)
      .join('');
    const s = g.stops[selected];
    colorIn.value = rgb8ToHex(s.color);
    locIn.value = String(Math.round(s.location * 100));
    midIn.value = String(Math.round((s.midpoint ?? 0.5) * 100));
    midIn.disabled = selected >= g.stops.length - 1;
    (del as HTMLButtonElement).disabled = g.stops.length <= 2;
  };
  const resort = () => {
    const cur = g.stops[selected];
    g.stops.sort((a, b) => a.location - b.location);
    selected = g.stops.indexOf(cur);
    host.ui.stop = selected;
  };
  lane.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const rect = lane.getBoundingClientRect();
    const t = ev.target as HTMLElement;
    let stop: GradientColorStop;
    if (t.dataset.i !== undefined) {
      selected = Number(t.dataset.i);
      stop = g.stops[selected];
    } else {
      const loc = clamp01((ev.clientX - rect.left) / rect.width);
      const tab = gradientTable(g, 257);
      const k = Math.round(loc * 256) * 4;
      stop = { location: loc, color: [0, 1, 2].map((c) => Math.round(tab[k + c] * 255)) as RGB8, midpoint: 0.5 };
      g.stops.push(stop);
      selected = g.stops.length - 1;
      resort();
      host.change(false);
    }
    host.ui.stop = selected;
    draw();
    let removed = false;
    const move = (m: PointerEvent) => {
      if (removed) return;
      // Dragging a stop well away from the lane removes it.
      if (Math.abs(m.clientY - rect.top - rect.height / 2) > 40 && g.stops.length > 2) {
        removed = true;
        g.stops.splice(g.stops.indexOf(stop), 1);
        selected = 0;
        host.ui.stop = 0;
      } else {
        stop.location = Math.round(clamp01((m.clientX - rect.left) / rect.width) * 1000) / 1000;
        resort();
      }
      draw();
      host.change(false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      host.change(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  lane.addEventListener('keydown', (ev) => {
    const i = Number((ev.target as HTMLElement).dataset.i);
    if (!Number.isFinite(i)) return;
    const d = ev.key === 'ArrowLeft' ? -0.01 : ev.key === 'ArrowRight' ? 0.01 : 0;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      ev.stopPropagation();
      selected = i;
      (del as HTMLButtonElement).click();
      return;
    }
    if (!d) return;
    ev.preventDefault();
    ev.stopPropagation();
    selected = i;
    g.stops[i].location = clamp01(Math.round((g.stops[i].location + d * (ev.shiftKey ? 10 : 1)) * 100) / 100);
    resort();
    draw();
    lane.querySelector<HTMLElement>(`[data-i="${selected}"]`)?.focus();
    host.change(true);
  });
  colorIn.addEventListener('input', () => {
    g.stops[selected].color = hexToRgb8(colorIn.value);
    draw();
    host.change(false);
  });
  colorIn.addEventListener('change', () => host.change(true));
  locIn.addEventListener('change', () => {
    const v = locIn.value.trim() === '' ? NaN : Number(locIn.value);
    if (!Number.isFinite(v)) return draw();
    g.stops[selected].location = clamp01(v / 100);
    resort();
    draw();
    host.change(true);
  });
  midIn.addEventListener('change', () => {
    const v = midIn.value.trim() === '' ? NaN : Number(midIn.value);
    if (!Number.isFinite(v)) return draw();
    g.stops[selected].midpoint = Math.min(0.99, Math.max(0.01, v / 100));
    draw();
    host.change(true);
  });
  draw();
  const opts = h('div', { class: 'adj-row' });
  opts.append(
    checkbox('Reverse', p.reverse, (v) => ((p.reverse = v), host.change(true))).el,
    checkbox('Dither', p.dither, (v) => ((p.dither = v), host.change(true))).el,
  );
  body.append(opts);
}
