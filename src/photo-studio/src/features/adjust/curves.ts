// Curves editor: an interactive 256 x 256 graph over the histogram with
// point and pencil modes, channel selection, presets, eyedroppers and an
// on-image targeted adjustment (drag up/down on the canvas).
import { curveFunction, curveToValues, defaultParams, luma, smoothCurveValues, type ChannelKey, type CurveChannel, type CurvesParams } from '../../imaging/adjust';
import type { AdjustHost } from './host';
import { button, h, histogramPath, select } from './ui';
import { droppers, type DropMode } from './droppers';
import { cancelPick, overViewport, sampleAt } from './source';
import { svg } from '../../app/icons';
import { valuesToPoints } from './spec';
export { valuesToPoints };

const CHANNELS: [ChannelKey, string][] = [
  ['rgb', 'RGB'],
  ['r', 'Red'],
  ['g', 'Green'],
  ['b', 'Blue'],
];
const stroke: Record<ChannelKey, string> = { rgb: 'var(--text)', r: '#e5484d', g: '#46a758', b: '#3e8ef7' };
type Pt = [number, number];
// Original curve shapes for the composite channel.
const PRESETS: Record<string, { label: string; rgb?: Pt[]; all?: Partial<Record<ChannelKey, Pt[]>> }> = {
  default: { label: 'Default', rgb: [[0, 0], [255, 255]] },
  medium: { label: 'Medium Contrast', rgb: [[0, 0], [64, 54], [192, 202], [255, 255]] },
  strong: { label: 'Strong Contrast', rgb: [[0, 0], [64, 44], [128, 128], [192, 212], [255, 255]] },
  linear: { label: 'Linear Contrast', rgb: [[0, 0], [48, 32], [208, 224], [255, 255]] },
  lighter: { label: 'Lighter', rgb: [[0, 0], [112, 146], [255, 255]] },
  darker: { label: 'Darker', rgb: [[0, 0], [146, 112], [255, 255]] },
  matte: { label: 'Matte Shadows', rgb: [[0, 30], [70, 72], [190, 196], [255, 250]] },
  negative: { label: 'Negative', rgb: [[0, 255], [255, 0]] },
  cross: { label: 'Cross Process', all: { r: [[0, 0], [70, 52], [190, 210], [255, 255]], g: [[0, 0], [64, 56], [196, 214], [255, 255]], b: [[0, 30], [255, 220]] } },
};

const clampByte = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
const sorted = (pts: Pt[]) => [...pts].sort((a, b) => a[0] - b[0]);

/** Curves that send a sampled color to black, white or neutral gray, applied
 * to the per-channel curves after the composite one. */
export function eyedropCurves(p: CurvesParams, mode: DropMode, color: [number, number, number]) {
  const rgb = curveFunction(p.rgb);
  const v = color.map((c) => clampByte(rgb(c / 255) * 255));
  const target = clampByte(luma(v[0], v[1], v[2]));
  (['r', 'g', 'b'] as const).forEach((k, i) => {
    const c = p[k];
    if (c.mode === 'pencil') Object.assign(c, { mode: 'points', points: valuesToPoints(c.values ?? curveToValues(c)) });
    let pts = sorted(c.points);
    if (mode === 'black') {
      pts = pts.filter((q) => q[0] > v[i]);
      pts.unshift([Math.min(v[i], 253), 0]);
    } else if (mode === 'white') {
      pts = pts.filter((q) => q[0] < v[i]);
      pts.push([Math.max(v[i], 2), 255]);
    } else {
      pts = pts.filter((q) => Math.abs(q[0] - v[i]) > 3);
      if (v[i] > 0 && v[i] < 255) pts.push([v[i], target]);
    }
    if (pts.length < 2) pts.push(mode === 'black' ? [255, 255] : [0, 0]);
    c.points = sorted(pts);
  });
}

function curvePath(c: CurveChannel) {
  const f = curveFunction(c);
  let d = '';
  for (let i = 0; i <= 128; i++) {
    const x = (i / 128) * 255;
    d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${(255 - f(x / 255) * 255).toFixed(1)}`;
  }
  return d;
}

export function curvesEditor(body: HTMLElement, host: AdjustHost<'curves'>) {
  const p = host.params;
  const key = (host.ui.channel as ChannelKey) ?? 'rgb';
  const chan = () => p[key];
  let selected = (host.ui.selected as number | undefined) ?? -1;

  const top = h('div', { class: 'adj-row' });
  const presetKey = Object.entries(PRESETS).find(([, v]) => (v.rgb ? JSON.stringify(p.rgb.points) === JSON.stringify(v.rgb) && ['r', 'g', 'b'].every((k) => JSON.stringify(p[k as ChannelKey]) === JSON.stringify(defaultParams('curves').r)) : false))?.[0] ?? 'custom';
  top.append(
    select('Preset', [...Object.entries(PRESETS).map(([k, v]) => [k, v.label] as [string, string]), ['custom', 'Custom']], presetKey, (v) => {
      const preset = PRESETS[v];
      if (!preset) return;
      Object.assign(p, defaultParams('curves'));
      if (preset.rgb) p.rgb.points = preset.rgb.map((q) => [...q] as Pt);
      for (const [k, pts] of Object.entries(preset.all ?? {})) p[k as ChannelKey].points = pts!.map((q) => [...q] as Pt);
      host.ui.selected = -1;
      host.change(true);
      host.rerender();
    }).el,
  );
  body.append(top);

  const row = h('div', { class: 'adj-row' });
  row.append(
    select('Channel', CHANNELS, key, (v) => {
      host.ui.channel = v;
      host.ui.selected = -1;
      host.rerender();
    }).el,
  );
  const modes = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Curve mode' });
  const setMode = (m: 'points' | 'pencil') => {
    const c = chan();
    if (c.mode === m) return;
    if (m === 'pencil') c.values = curveToValues(c).map((v) => Math.round(v * 100) / 100);
    else c.points = valuesToPoints(c.values ?? curveToValues(c));
    c.mode = m;
    host.ui.selected = -1;
    host.change(true);
    host.rerender();
  };
  modes.append(
    button('Points', () => setMode('points'), { icon: 'spline', title: 'Edit points on the curve', pressed: chan().mode === 'points', cls: 'icon-button' }),
    button('Pencil', () => setMode('pencil'), { icon: 'pencil', title: 'Draw the curve freehand', pressed: chan().mode === 'pencil', cls: 'icon-button' }),
  );
  row.append(modes);
  body.append(row);

  const tools = droppers(host as AdjustHost, (mode, color) => eyedropCurves(p, mode, color));
  const target = h('button', { type: 'button', class: 'icon-button adj-target', title: 'Click and drag up or down in the image to adjust that tone', 'aria-label': 'On-image adjustment', 'aria-pressed': 'false' }, svg('hand', 15));
  tools.prepend(target);
  if (chan().mode === 'pencil') tools.append(button('Smooth', () => ((chan().values = smoothCurveValues(chan().values ?? curveToValues(chan()), 2)), host.change(true), host.rerender()), { title: 'Smooth the drawn curve' }));
  tools.append(
    button('Auto', async () => {
      const s = await host.source();
      if (!s) return;
      const { autoLevels } = await import('../../imaging/adjust');
      const lv = autoLevels(s.image, 'tone');
      Object.assign(p, defaultParams('curves'));
      for (const k of ['r', 'g', 'b'] as const) p[k].points = [[lv[k].inBlack, 0], [lv[k].inWhite, 255]];
      host.change(true);
      host.rerender();
    }, { title: 'Automatic per-channel contrast' }),
  );
  body.append(tools);

  const NS = 'http://www.w3.org/2000/svg';
  const graph = h('div', { class: 'adj-curve-box' });
  graph.innerHTML = `<svg class="adj-curve" viewBox="-6 -6 268 268" tabindex="0" role="application" aria-label="Curve graph. Click to add points, drag to move, Delete to remove.">
<g class="grid">${[64, 128, 192].map((v) => `<line x1="${v}" y1="0" x2="${v}" y2="255"/><line x1="0" y1="${v}" x2="255" y2="${v}"/>`).join('')}<rect x="0" y="0" width="255" height="255" fill="none"/></g>
<path class="hist" d=""/><line class="base" x1="0" y1="255" x2="255" y2="0"/><g class="others"></g><path class="curve" fill="none" stroke="${stroke[key]}"/><g class="pts"></g></svg>`;
  const svgEl = graph.querySelector('svg')!;
  const readout = h('div', { class: 'adj-curve-io' });
  readout.innerHTML = `<label>Input <input type="number" min="0" max="255" step="1" aria-label="Input"></label><label>Output <input type="number" min="0" max="255" step="1" aria-label="Output"></label>`;
  const [inBox, outBox] = readout.querySelectorAll('input');
  body.append(graph, readout);

  void host.source().then((s) => {
    if (!s) return;
    const hist = key === 'rgb' ? s.hist.rgb : s.hist[key];
    svgEl.querySelector('.hist')!.setAttribute('d', histogramPath(hist, 255, 255));
  });

  const draw = () => {
    const c = chan();
    svgEl.querySelector('.curve')!.setAttribute('d', curvePath(c));
    const others = svgEl.querySelector('.others')!;
    others.innerHTML = '';
    if (key === 'rgb')
      for (const k of ['r', 'g', 'b'] as const) {
        const o = p[k];
        if (o.mode === 'points' && o.points.length === 2 && o.points.every(([x, y]) => x === y)) continue;
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', curvePath(o));
        path.setAttribute('stroke', stroke[k]);
        others.append(path);
      }
    const g = svgEl.querySelector('.pts')!;
    g.innerHTML = '';
    if (c.mode === 'points')
      c.points.forEach(([x, y], i) => {
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', String(x - 3.5));
        r.setAttribute('y', String(255 - y - 3.5));
        r.setAttribute('width', '7');
        r.setAttribute('height', '7');
        if (i === selected) r.classList.add('sel');
        g.append(r);
      });
    const sp = c.mode === 'points' ? c.points[selected] : undefined;
    inBox.disabled = outBox.disabled = !sp;
    inBox.value = sp ? String(Math.round(sp[0])) : '';
    outBox.value = sp ? String(Math.round(sp[1])) : '';
  };
  const select_ = (i: number) => {
    selected = i;
    host.ui.selected = i;
  };
  const toGraph = (ev: { clientX: number; clientY: number }): Pt => {
    const r = svgEl.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * 268 - 6,
      y = ((ev.clientY - r.top) / r.height) * 268 - 6;
    return [x, 255 - y];
  };
  // Keep inputs strictly increasing so the curve stays a function.
  const movePoint = (i: number, x: number, y: number) => {
    const pts = chan().points;
    const lo = i > 0 ? pts[i - 1][0] + 1 : 0,
      hi = i < pts.length - 1 ? pts[i + 1][0] - 1 : 255;
    pts[i] = [Math.min(hi, Math.max(lo, clampByte(x))), clampByte(y)];
  };

  svgEl.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    svgEl.focus();
    const c = chan();
    const [gx, gy] = toGraph(ev);
    if (c.mode === 'pencil') {
      const values = (c.values ??= curveToValues(c));
      let last: Pt = [clampByte(gx), clampByte(gy)];
      values[last[0]] = last[1];
      const move = (m: PointerEvent) => {
        const [x, y] = toGraph(m),
          nx = clampByte(x),
          ny = clampByte(y);
        const [x0, y0] = last;
        const steps = Math.abs(nx - x0);
        for (let s = 0; s <= steps; s++) {
          const t = steps ? s / steps : 1;
          values[Math.round(x0 + (nx - x0) * t)] = y0 + (ny - y0) * t;
        }
        last = [nx, ny];
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
      draw();
      host.change(false);
      return;
    }
    let i = c.points.findIndex(([x, y]) => Math.abs(x - gx) < 8 && Math.abs(y - gy) < 8);
    if (i < 0) {
      const x = clampByte(gx);
      if (c.points.some((q) => q[0] === x)) i = c.points.findIndex((q) => q[0] === x);
      else {
        c.points.push([x, clampByte(gy)]);
        c.points = sorted(c.points);
        i = c.points.findIndex((q) => q[0] === x);
        movePoint(i, gx, gy);
      }
    }
    select_(i);
    draw();
    host.change(false);
    let removed = false;
    const move = (m: PointerEvent) => {
      const [x, y] = toGraph(m);
      const pts = chan().points;
      // Dragging a point well outside the graph removes it (two must remain).
      const outside = x < -24 || x > 279 || y < -24 || y > 279;
      if (outside && pts.length > 2 && !removed) {
        removed = true;
        pts.splice(selected, 1);
        select_(-1);
      } else if (!removed) movePoint(selected, x, y);
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
  svgEl.addEventListener('keydown', (ev) => {
    const c = chan();
    if (c.mode !== 'points') return;
    if (ev.key === 'Tab' || ev.key === 'Escape') return;
    ev.stopPropagation();
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected >= 0 && c.points.length > 2) {
      ev.preventDefault();
      c.points.splice(selected, 1);
      select_(-1);
      draw();
      host.change(true);
      return;
    }
    if (ev.key === '+' || ev.key === '=' || ev.key === '-') {
      ev.preventDefault();
      if (!c.points.length) return;
      select_(((selected < 0 ? 0 : selected) + (ev.key === '-' ? -1 : 1) + c.points.length) % c.points.length);
      draw();
      return;
    }
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[ev.key];
    if (!d || selected < 0) return;
    ev.preventDefault();
    const k = ev.shiftKey ? 10 : 1;
    const [x, y] = c.points[selected];
    movePoint(selected, x + d[0] * k, y + d[1] * k);
    draw();
    host.change(true);
  });
  const edit = () => {
    if (selected < 0) return;
    const num = (box: HTMLInputElement) => (box.value.trim() === '' ? NaN : Number(box.value));
    const x = num(inBox),
      y = num(outBox);
    // Blank or invalid entries show the point's values again.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return draw();
    movePoint(selected, x, y);
    draw();
    host.change(true);
  };
  inBox.addEventListener('change', edit);
  outBox.addEventListener('change', edit);

  // On-image adjustment: press on the canvas to pick the tone, then drag
  // vertically to raise or lower it on the curve.
  target.addEventListener('click', () => {
    const on = target.getAttribute('aria-pressed') !== 'true';
    target.setAttribute('aria-pressed', String(on));
    if (!on) return stopTarget?.();
    cancelPick();
    stopTarget = armTarget();
  });
  let stopTarget: (() => void) | undefined;
  const armTarget = () => {
    const viewport = host.e.el('#viewport');
    viewport.classList.add('adj-picking');
    document.body.classList.add('adj-picking-on');
    const down = async (ev: PointerEvent) => {
      if (!overViewport(host.e, ev) || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const startY = ev.clientY;
      const [dx, dy] = host.e.docPoint(ev.clientX, ev.clientY);
      const s = await host.source();
      const color = s && sampleAt(s.image, dx - (s.x ?? 0), dy - (s.y ?? 0));
      if (!color) return;
      const c = chan();
      if (c.mode === 'pencil') setMode('points');
      const rgb = curveFunction(p.rgb);
      const v = key === 'rgb' ? clampByte(luma(color[0], color[1], color[2])) : clampByte(rgb(color[{ r: 0, g: 1, b: 2 }[key]] / 255) * 255);
      const pts = chan().points;
      let i = pts.findIndex((q) => Math.abs(q[0] - v) <= 3);
      if (i < 0) {
        pts.push([v, clampByte(curveFunction(chan())(v / 255) * 255)]);
        chan().points = sorted(pts);
        i = chan().points.findIndex((q) => q[0] === v);
      }
      select_(i);
      const y0 = chan().points[i][1];
      draw();
      const move = (m: PointerEvent) => {
        m.stopPropagation();
        movePoint(selected, chan().points[selected][0], y0 + (startY - m.clientY) / 2);
        draw();
        host.change(false);
      };
      const up = (u: PointerEvent) => {
        u.stopPropagation();
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        host.change(true);
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
    };
    window.addEventListener('pointerdown', down, true);
    const off = () => {
      window.removeEventListener('pointerdown', down, true);
      viewport.classList.remove('adj-picking');
      document.body.classList.remove('adj-picking-on');
      target.setAttribute('aria-pressed', 'false');
      stopTarget = undefined;
    };
    // Disarm when the editor is replaced.
    const watch = new MutationObserver(() => {
      if (!target.isConnected) {
        off();
        watch.disconnect();
      }
    });
    watch.observe(document.body, { childList: true, subtree: true });
    return () => {
      off();
      watch.disconnect();
    };
  };
  draw();
}
