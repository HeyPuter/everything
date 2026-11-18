// Hue/Saturation editor: master and six hue ranges with an editable range
// bar (full range plus falloff handles), colorize, presets and an
// eyedropper that centers the selected range on a sampled color.
import { DEFAULT_HUE_RANGES, HUE_RANGES, defaultParams, hueRangeWeight, rgbToHsl, type HueRangeName, type HueSatRange } from '../../imaging/adjust';
import type { AdjustHost } from './host';
import { button, checkbox, h, hueTrack, select, slider, twoTone } from './ui';
import { cancelPick } from './source';
import { svg } from '../../app/icons';

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const mod = (v: number) => ((v % 360) + 360) % 360;
type Range4 = HueSatRange['range'];
const HANDLE_LABELS = ['Falloff start', 'Range start', 'Range end', 'Falloff end'];

const PRESETS: Record<string, { label: string; apply: (p: AdjustHost<'hue-saturation'>['params']) => void }> = {
  default: { label: 'Default', apply: () => {} },
  moreSat: { label: 'Increase Saturation', apply: (p) => (p.master.saturation = 25) },
  lessSat: { label: 'Decrease Saturation', apply: (p) => (p.master.saturation = -30) },
  strongSat: { label: 'Strong Saturation', apply: (p) => (p.master.saturation = 55) },
  warmSkin: { label: 'Warmer Reds', apply: (p) => Object.assign(p.ranges.reds, { hue: 6, saturation: 12 }) },
  bluerSky: { label: 'Deeper Blues', apply: (p) => Object.assign(p.ranges.blues, { saturation: 30, lightness: -12 }) },
  sepia: { label: 'Sepia', apply: (p) => Object.assign(p, { colorize: true, colorizeHue: 32, colorizeSaturation: 28 }) },
  cyanotype: { label: 'Cyanotype', apply: (p) => Object.assign(p, { colorize: true, colorizeHue: 205, colorizeSaturation: 32 }) },
  aged: { label: 'Aged Photo', apply: (p) => ((p.master.saturation = -55), (p.master.hue = 8)) },
};

/** Move handle `i` of a range by `dh` degrees (or the whole range when i is
 * -1); each handle stays between its neighbors along the circle and the
 * falloff ends never meet. */
export function moveRangeHandle(orig: Range4, i: number, dh: number): Range4 {
  if (i < 0) return orig.map((v) => mod(v + dh)) as Range4;
  const r = [...orig] as Range4;
  const span = (x: number, y: number) => mod(y - x);
  const prev = i > 0 ? span(orig[i - 1], orig[i]) : Infinity;
  const next = i < 3 ? span(orig[i], orig[i + 1]) : Infinity;
  const total = span(orig[0], orig[3]);
  let d = Math.max(-prev, Math.min(next, dh));
  if (i === 0) d = Math.max(-(358 - total), d);
  if (i === 3) d = Math.min(358 - total, d);
  r[i] = mod(orig[i] + d);
  return r;
}

/** Shift a range so its full-effect center sits on `hue`, keeping widths. */
export function centerRange(r: Range4, hue: number): Range4 {
  const center = mod(r[1] + mod(r[2] - r[1]) / 2);
  const d = hue - center;
  return r.map((v) => Math.round(mod(v + d))) as Range4;
}

export function hueSaturationEditor(body: HTMLElement, host: AdjustHost<'hue-saturation'>) {
  const p = host.params;
  let range = (host.ui.range as 'master' | HueRangeName) ?? 'master';
  if (p.colorize) range = 'master';

  const top = h('div', { class: 'adj-row' });
  top.append(
    select('Preset', [...Object.entries(PRESETS).map(([k, v]) => [k, v.label] as [string, string]), ['custom', 'Custom']], 'custom', (v) => {
      const preset = PRESETS[v];
      if (!preset) return;
      Object.assign(p, defaultParams('hue-saturation'));
      preset.apply(p);
      host.change(true);
      host.rerender();
    }).el,
  );
  // Show the preset that matches, if any.
  const json = JSON.stringify(p);
  const match = Object.entries(PRESETS).find(([, v]) => {
    const q = defaultParams('hue-saturation');
    v.apply(q);
    return JSON.stringify(q) === json;
  });
  top.querySelector('select')!.value = match ? match[0] : 'custom';
  body.append(top);

  if (!p.colorize) {
    const row = h('div', { class: 'adj-row' });
    row.append(
      select('Range', [['master', 'Master'], ...HUE_RANGES.map((n) => [n, cap(n)] as [string, string])], range, (v) => {
        host.ui.range = v;
        host.rerender();
      }).el,
    );
    if (range !== 'master') {
      const pick = h('button', { type: 'button', class: 'icon-button adj-dropper', title: 'Sample in image to center this range on a color', 'aria-label': 'Center range on sampled color', 'aria-pressed': 'false' }, svg('pipette', 15));
      pick.addEventListener('click', async () => {
        if (pick.getAttribute('aria-pressed') === 'true') return cancelPick();
        pick.setAttribute('aria-pressed', 'true');
        const c = await host.pick();
        pick.setAttribute('aria-pressed', 'false');
        if (!c) return;
        const [hue, sat] = rgbToHsl(c[0] / 255, c[1] / 255, c[2] / 255);
        if (sat < 0.02) return host.e.message('That color is neutral; pick a colored area.');
        p.ranges[range as HueRangeName].range = centerRange(p.ranges[range as HueRangeName].range, hue);
        host.change(true);
        host.rerender();
      });
      row.append(pick, button('Reset range', () => ((p.ranges[range as HueRangeName].range = [...DEFAULT_HUE_RANGES[range as HueRangeName]] as Range4), host.change(true), host.rerender()), { cls: 'secondary' }));
    }
    body.append(row);
  }

  const amounts = p.colorize ? null : range === 'master' ? p.master : p.ranges[range];
  if (p.colorize) {
    body.append(
      slider({ label: 'Hue', min: 0, max: 360, value: p.colorizeHue, unit: '°', track: hueTrack, onInput: (v, c) => ((p.colorizeHue = v), host.change(c)) }).el,
      slider({ label: 'Saturation', min: 0, max: 100, value: p.colorizeSaturation, unit: '%', track: twoTone('#888', `hsl(${p.colorizeHue} 100% 50%)`), onInput: (v, c) => ((p.colorizeSaturation = v), host.change(c)) }).el,
      slider({ label: 'Lightness', min: -100, max: 100, value: p.master.lightness, track: 'linear-gradient(90deg,#000,#888,#fff)', onInput: (v, c) => ((p.master.lightness = v), host.change(c)) }).el,
    );
  } else if (amounts) {
    body.append(
      slider({ label: 'Hue', min: -180, max: 180, value: amounts.hue, unit: '°', track: 'linear-gradient(90deg,#0ff,#00f 16.7%,#f0f 33.3%,#f00 50%,#ff0 66.7%,#0f0 83.3%,#0ff)', onInput: (v, c) => ((amounts.hue = v), drawBar(), host.change(c)) }).el,
      slider({ label: 'Saturation', min: -100, max: 100, value: amounts.saturation, unit: '%', track: twoTone('#888', '#e33'), onInput: (v, c) => ((amounts.saturation = v), host.change(c)) }).el,
      slider({ label: 'Lightness', min: -100, max: 100, value: amounts.lightness, unit: '%', track: 'linear-gradient(90deg,#000,#888,#fff)', onInput: (v, c) => ((amounts.lightness = v), host.change(c)) }).el,
    );
  }
  body.append(
    checkbox('Colorize', p.colorize, (v) => {
      p.colorize = v;
      host.change(true);
      host.rerender();
    }).el,
  );

  // Spectrum bars: input hues on top, the resulting hues below. With a range
  // selected the view is centered on it and shows its four handles.
  const bar = h('div', { class: 'adj-hue-bar' });
  bar.innerHTML = `<div class="spectrum in"></div><div class="spectrum out"></div><div class="range-layer"></div><div class="adj-range-values"></div>`;
  body.append(bar);
  const rangeLayer = bar.querySelector<HTMLElement>('.range-layer')!;
  const sel = range !== 'master' && !p.colorize ? p.ranges[range] : null;
  const center = sel ? mod(sel.range[1] + mod(sel.range[2] - sel.range[1]) / 2) : 180;
  const start = center - 180;
  const spectrum = (shift: number, colorize = false) => {
    if (colorize) return `linear-gradient(90deg,#000,hsl(${p.colorizeHue} ${p.colorizeSaturation}% 50%),#fff)`;
    const stops = [];
    for (let i = 0; i <= 12; i++) stops.push(`hsl(${mod(start + i * 30 + shift)} 100% 50%) ${((i / 12) * 100).toFixed(2)}%`);
    return `linear-gradient(90deg,${stops.join(',')})`;
  };
  // Hue shift at each displayed hue for the output strip.
  const drawBar = () => {
    (bar.querySelector('.spectrum.in') as HTMLElement).style.background = spectrum(0);
    const out = bar.querySelector('.spectrum.out') as HTMLElement;
    if (p.colorize) out.style.background = spectrum(0, true);
    else {
      const stops = [];
      for (let i = 0; i <= 24; i++) {
        const hue = start + i * 15;
        let shift = p.master.hue;
        for (const n of HUE_RANGES) {
          const q = p.ranges[n];
          if (q.hue) shift += q.hue * hueRangeWeight(mod(hue), q.range);
        }
        stops.push(`hsl(${mod(hue + shift)} 100% 50%) ${((i / 24) * 100).toFixed(2)}%`);
      }
      out.style.background = `linear-gradient(90deg,${stops.join(',')})`;
    }
    if (!sel) return;
    const pos = (v: number) => (mod(v - start) / 360) * 100;
    const [a, b, c, d] = sel.range.map(pos);
    const fix = (x: number, ref: number) => (x > ref + 50 ? x - 100 : x < ref - 50 ? x + 100 : x);
    const B = b,
      C = fix(c, B),
      A = fix(a, B),
      D = fix(d, C);
    const handle = (x: number, i: number) =>
      `<button type="button" class="hue-handle h${i}" style="left:${x}%" data-i="${i}" ` +
      `role="slider" aria-valuemin="0" aria-valuemax="359" aria-valuenow="${sel.range[i]}" ` +
      `aria-valuetext="${sel.range[i]}°" aria-label="${HANDLE_LABELS[i]}" title="${HANDLE_LABELS[i]}"></button>`;
    rangeLayer.innerHTML = `<div class="falloff" style="left:${A}%;width:${B - A}%"></div><div class="full" style="left:${B}%;width:${C - B}%" title="Drag to move the range"></div><div class="falloff right" style="left:${C}%;width:${D - C}%"></div>${[A, B, C, D].map(handle).join('')}`;
    (bar.querySelector('.adj-range-values') as HTMLElement).textContent = `${sel.range[0]}° / ${sel.range[1]}°   ${sel.range[2]}° \\ ${sel.range[3]}°`;
  };
  drawBar();
  if (sel) {
    rangeLayer.addEventListener('pointerdown', (ev) => {
      const t = ev.target as HTMLElement;
      const handle = t.closest<HTMLElement>('.hue-handle');
      if (!handle && !t.closest('.full')) return;
      ev.preventDefault();
      const rect = bar.getBoundingClientRect();
      const startX = ev.clientX;
      const orig = [...sel.range] as Range4;
      const i = handle ? Number(handle.dataset.i) : -1;
      const move = (m: PointerEvent) => {
        sel.range = moveRangeHandle(orig, i, Math.round(((m.clientX - startX) / rect.width) * 360));
        drawBar();
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
    // Arrow keys move a focused handle by one degree (ten with Shift).
    rangeLayer.addEventListener('keydown', (ev) => {
      const handle = (ev.target as HTMLElement).closest<HTMLElement>('.hue-handle');
      const k = ev.key;
      const d =
        k === 'ArrowLeft' || k === 'ArrowDown' ? -1 : k === 'ArrowRight' || k === 'ArrowUp' ? 1 : 0;
      if (!handle || !d) return;
      ev.preventDefault();
      ev.stopPropagation();
      const i = Number(handle.dataset.i);
      sel.range = moveRangeHandle(sel.range, i, d * (ev.shiftKey ? 10 : 1));
      drawBar();
      rangeLayer.querySelector<HTMLElement>(`.hue-handle[data-i="${i}"]`)?.focus();
      host.change(true);
    });
  }
}
