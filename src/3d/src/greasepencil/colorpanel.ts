// Tool settings ▸ Color for the Grease Pencil brushes that paint colors (Draw, Tint, Vertex Paint):
// Material / Color Attribute switch, a hue-saturation wheel with a value bar, the secondary color
// (X swaps) and a palette of colors kept with the scene's tool settings.
import { app } from '../app/app';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { panel, colorSwatch, rgbToHsv, hsvToRgb } from '../ui/widgets';
import { gpTS } from './data';
import type { GPBrush } from './types';
import type { Color } from '../data/types';

const toSrgb = (x: number) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(Math.max(0, x), 1 / 2.4) - 0.055);
const toLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const css = (c: number[]) => `rgb(${c.map((x) => Math.round(Math.max(0, Math.min(1, toSrgb(x))) * 255)).join(',')})`;

/** Default palette (linear RGB): greys, then hues in two lightness rows. */
export function defaultPalette(): Color[] {
  const out: Color[] = [];
  for (const g of [0, 0.15, 0.35, 0.6, 0.8, 1]) out.push([toLinear(g), toLinear(g), toLinear(g)]);
  for (const v of [0.9, 0.55])
    for (let k = 0; k < 9; k++) {
      const [r, g, b] = hsvToRgb(k / 9, v > 0.6 ? 0.75 : 0.85, v);
      out.push([toLinear(r), toLinear(g), toLinear(b)]);
    }
  return out;
}

type PaletteTS = { gpencil_palette?: Color[] };
export function gpPalette(): Color[] {
  const ts = gpTS(app.doc) as unknown as PaletteTS;
  return (ts.gpencil_palette ??= defaultPalette());
}

const WHEEL = 140;
const wheelState = { hsv: null as null | [number, number, number], key: '' };

function wheel(b: GPBrush, refresh: () => void): Child {
  const c = b.color ?? [0, 0, 0];
  const disp = c.map(toSrgb) as [number, number, number];
  const key = c.join(',');
  if (!wheelState.hsv || wheelState.key !== key) {
    const [hh, s, v] = rgbToHsv(disp[0], disp[1], disp[2]);
    // a grey keeps the previous hue so dragging the value bar does not lose it
    wheelState.hsv = [wheelState.hsv && s === 0 ? wheelState.hsv[0] : hh, s, v];
    wheelState.key = key;
  }
  const [hh, s, v] = wheelState.hsv;
  const set = (nh: number, ns: number, nv: number, final = false) => {
    wheelState.hsv = [nh, ns, nv];
    const rgb = hsvToRgb(nh, ns, nv).map(toLinear) as Color;
    b.color = rgb;
    wheelState.key = rgb.join(',');
    if (final) app.pushUndo('Brush Color');
    refresh();
  };
  const paint = (cv: HTMLCanvasElement) => {
    const g = cv.getContext('2d');
    if (!g) return;
    const r = WHEEL / 2;
    const img = g.createImageData(WHEEL, WHEEL);
    for (let y = 0; y < WHEEL; y++)
      for (let x = 0; x < WHEEL; x++) {
        const dx = x - r,
          dy = y - r;
        const d = Math.hypot(dx, dy) / r;
        if (d > 1) continue;
        const [cr, cg, cb] = hsvToRgb((Math.atan2(-dy, dx) / (Math.PI * 2) + 1) % 1, d, v);
        const i = (y * WHEEL + x) * 4;
        img.data[i] = cr * 255;
        img.data[i + 1] = cg * 255;
        img.data[i + 2] = cb * 255;
        img.data[i + 3] = Math.min(1, (1 - d) * r) * 255;
      }
    g.putImageData(img, 0, 0);
  };
  const drag = (e: PointerEvent, fn: (ev: PointerEvent, el: HTMLElement) => void) => {
    const el = e.currentTarget as HTMLElement;
    fn(e, el);
    const mv = (ev: PointerEvent) => fn(ev, el);
    const up = () => {
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', up);
      app.pushUndo('Brush Color');
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  };
  const ang = hh * Math.PI * 2;
  return h(
    'div',
    { class: 'gp-wheel-row' },
    h(
      'div',
      { class: 'gp-wheel', style: { width: `${WHEEL}px`, height: `${WHEEL}px` } },
      h('canvas', {
        key: `gpw-${v.toFixed(3)}`,
        width: WHEEL,
        height: WHEEL,
        ref: paint,
        onpointerdown: (e: PointerEvent) =>
          drag(e, (ev, el) => {
            const r = el.getBoundingClientRect();
            const dx = ev.clientX - r.left - r.width / 2,
              dy = ev.clientY - r.top - r.height / 2;
            set((Math.atan2(-dy, dx) / (Math.PI * 2) + 1) % 1, Math.min(1, Math.hypot(dx, dy) / (r.width / 2)), v);
          }),
      }),
      h('div', { class: 'gp-wheel-cursor', style: { left: `${WHEEL / 2 + Math.cos(ang) * s * (WHEEL / 2)}px`, top: `${WHEEL / 2 - Math.sin(ang) * s * (WHEEL / 2)}px` } }),
    ),
    h(
      'div',
      {
        class: 'gp-wheel-value',
        style: {
          height: `${WHEEL}px`,
          background: `linear-gradient(to top, #000000, rgb(${hsvToRgb(hh, s, 1)
            .map((x) => Math.round(x * 255))
            .join(',')}))`,
        },
        'data-tip': 'Value',
        onpointerdown: (e: PointerEvent) =>
          drag(e, (ev, el) => {
            const r = el.getBoundingClientRect();
            set(hh, s, Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height)));
          }),
      },
      h('div', { class: 'gp-wheel-vcursor', style: { top: `${(1 - v) * 100}%` } }),
    ),
  );
}

function palette(b: GPBrush, refresh: () => void): Child {
  const pal = gpPalette();
  const same = (a: number[], c: number[]) => a.every((x, i) => Math.abs(x - c[i]) < 1e-4);
  const ts = gpTS(app.doc) as unknown as PaletteTS;
  return h(
    'div',
    { class: 'gp-palette' },
    pal.map((c, i) =>
      h('button', {
        key: `gpp-${i}`,
        class: { 'gp-pal-swatch': true, on: !!b.color && same(c, b.color) },
        style: { background: css(c) },
        'data-tip': 'Click: use this color · Ctrl+click: remove it',
        onclick: (e: MouseEvent) => {
          if (e.ctrlKey || e.metaKey) ts.gpencil_palette = pal.filter((_, j) => j !== i);
          else {
            b.color = [c[0], c[1], c[2]];
            b.color_mode = 'VERTEXCOLOR';
          }
          app.pushUndo('Palette');
          refresh();
        },
      }),
    ),
    h(
      'button',
      {
        key: 'gpp-add',
        class: 'gp-pal-add',
        'data-tip': 'Add the brush color to the palette',
        onclick: () => {
          const c = b.color ?? [0, 0, 0];
          if (!pal.some((x) => same(x, c))) ts.gpencil_palette = [...pal, [c[0], c[1], c[2]]];
          app.pushUndo('Palette');
          refresh();
        },
      },
      icon('add'),
    ),
  );
}

/** The Color panel of a brush; `modes`: offer the Material / Color Attribute switch. */
export function gpColorPanel(b: GPBrush, refresh: () => void, modes = true): Child {
  b.color ??= [0.5, 0.5, 0.5];
  b.secondary_color ??= [1, 1, 1];
  const vc = b.color_mode === 'VERTEXCOLOR' || !modes;
  const seg = (on: boolean, label: string, set: () => void) => h('button', { class: { 'gp-seg': true, on }, onclick: () => (set(), app.pushUndo('Color Mode'), refresh()) }, label);
  return panel('gp-sb-color', 'Color', () => [
    modes
      ? h(
          'div',
          { class: 'gp-seg-row' },
          seg(!vc, 'Material', () => (b.color_mode = 'MATERIAL')),
          seg(vc, 'Color Attribute', () => (b.color_mode = 'VERTEXCOLOR')),
        )
      : null,
    vc
      ? [
          wheel(b, refresh),
          h(
            'div',
            { class: 'gp-color-pair' },
            colorSwatch('gp-col-a', b.color!, (c, final) => ((b.color = [c[0], c[1], c[2]]), final && app.pushUndo('Brush Color'), refresh())),
            colorSwatch('gp-col-b', b.secondary_color!, (c, final) => ((b.secondary_color = [c[0], c[1], c[2]]), final && app.pushUndo('Brush Color'), refresh())),
            h(
              'button',
              {
                class: 'btn',
                'data-tip': 'Swap Colors (X)\nExchange the primary and secondary colors',
                onclick: () => {
                  const a = b.color!;
                  b.color = b.secondary_color!;
                  b.secondary_color = a;
                  app.pushUndo('Swap Colors');
                  refresh();
                },
              },
              icon('arrow_leftright'),
            ),
          ),
        ]
      : null,
    panel('gp-sb-palette', 'Palette', () => [palette(b, refresh)], { sub: true }),
  ]);
}
