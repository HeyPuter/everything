// Color ramp and curve mapping widgets (node body, sidebar and Properties editor).
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { enumMenu, numberField, colorSwatch, linearToSrgb } from '../../ui/widgets';
import { openMenu, setWidgetDragging } from '../../ui/menu';
import type { NodeData } from '../../data/types';
import { getNodeType } from '../registry';
import { readRamp, writeRamp, bakeRamp, evalRamp, readCurve, writeCurve, evalCurve, evalPeriodicCurve, CURVE_NAMES, CURVE_RANGE, defaultCurves, type CurveKind, type CurvePoint } from '../curves';
import type { NodeDrawContext } from '../types';

const css = (c: number[]) =>
  `rgba(${c
    .slice(0, 3)
    .map((x) => Math.round(Math.max(0, Math.min(1, linearToSrgb(x))) * 255))
    .join(',')},${Math.max(0, Math.min(1, c[3] ?? 1))})`;

// ---------------------------------------------------------------------------
// Color ramp

function rampActive(n: NodeData, count: number) {
  return Math.max(0, Math.min(count - 1, (n.props.ramp_active as number) ?? 0));
}

export function drawRamp(ctx: NodeDrawContext): Child {
  const n = ctx.node;
  const ramp = readRamp(n.props);
  const stops = ramp.stops;
  const act = rampActive(n, stops.length);
  const baked = bakeRamp(ramp, 64);
  const grad: string[] = [];
  for (let i = 0; i < 64; i++) grad.push(`${css(Array.from(baked.subarray(i * 4, i * 4 + 4)))} ${((i / 63) * 100).toFixed(2)}%`);
  const commit = (label: string, final = true) => ctx.changed(label, final);
  const setStops = (s: typeof stops, label: string, final = true) => {
    writeRamp(n.props, s);
    commit(label, final);
  };
  const addStop = () => {
    // insert halfway between the active stop and its right neighbour (or left at the end)
    const sorted = [...stops].sort((a, b) => a.pos - b.pos);
    const a = stops[act];
    const ia = sorted.indexOf(a);
    const b = sorted[ia + 1] ?? sorted[ia - 1] ?? a;
    const pos = b === a ? Math.min(1, a.pos + 0.1) : (a.pos + b.pos) / 2;
    const color = evalRamp(ramp, pos) as [number, number, number, number];
    const s = [...stops, { pos, color }];
    n.props.ramp_active = s.length - 1;
    setStops(s, 'Add Color Stop');
  };
  const removeStop = () => {
    if (stops.length <= 1) return;
    const s = stops.filter((_, i) => i !== act);
    n.props.ramp_active = Math.max(0, act - 1);
    setStops(s, 'Remove Color Stop');
  };
  const barDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const bar = e.currentTarget as HTMLElement;
    const r = bar.getBoundingClientRect();
    const posAt = (x: number) => Math.max(0, Math.min(1, (x - r.left) / r.width));
    const p = posAt(e.clientX);
    // pick the nearest stop within 8px, else (Ctrl) add a stop
    let best = -1,
      bd = 8 / r.width;
    stops.forEach((s, i) => {
      const d = Math.abs(s.pos - p);
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    if (best < 0) {
      if (!e.ctrlKey) {
        // select the closest stop
        let bi = 0;
        stops.forEach((s, i) => Math.abs(s.pos - p) < Math.abs(stops[bi].pos - p) && (bi = i));
        best = bi;
      } else {
        const s = [
          ...stops,
          {
            pos: p,
            color: evalRamp(ramp, p) as [number, number, number, number],
          },
        ];
        n.props.ramp_active = s.length - 1;
        setStops(s, 'Add Color Stop');
        return;
      }
    }
    n.props.ramp_active = best;
    const idx = best;
    let moved = false;
    setWidgetDragging(true);
    const move = (ev: PointerEvent) => {
      moved = true;
      const s = readRamp(n.props).stops;
      s[idx].pos = posAt(ev.clientX);
      writeRamp(n.props, s);
      commit('Move Color Stop', false);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      setWidgetDragging(false);
      commit(moved ? 'Move Color Stop' : 'Select Color Stop', moved);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    commit('Select Color Stop', false);
  };
  const cur = stops[act];
  const key = `${ctx.key}:ramp`;
  return h(
    'div',
    { class: 'nd-ramp' },
    h(
      'div',
      { class: 'nd-ramp-tools' },
      h('button', { class: 'nd-ramp-btn', 'data-tip': 'Add Stop', onclick: addStop }, icon('add')),
      h(
        'button',
        {
          class: 'nd-ramp-btn',
          'data-tip': 'Delete Stop',
          disabled: stops.length <= 1,
          onclick: removeStop,
        },
        icon('remove'),
      ),
      h(
        'button',
        {
          class: 'nd-ramp-btn',
          'data-tip': 'Color Ramp Specials',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              [
                {
                  label: 'Flip Color Ramp',
                  action: () =>
                    setStops(
                      stops.map((s) => ({ pos: 1 - s.pos, color: s.color })),
                      'Flip Color Ramp',
                    ),
                },
                {
                  label: 'Distribute Stops from Left',
                  action: () =>
                    setStops(
                      [...stops]
                        .sort((a, b) => a.pos - b.pos)
                        .map((s, i, arr) => ({
                          pos: i / arr.length,
                          color: s.color,
                        })),
                      'Distribute Stops',
                    ),
                },
                {
                  label: 'Distribute Stops Evenly',
                  action: () =>
                    setStops(
                      [...stops]
                        .sort((a, b) => a.pos - b.pos)
                        .map((s, i, arr) => ({
                          pos: arr.length > 1 ? i / (arr.length - 1) : 0,
                          color: s.color,
                        })),
                      'Distribute Stops',
                    ),
                },
                { separator: true },
                {
                  label: 'Reset Color Ramp',
                  action: () => (
                    setStops(
                      [
                        { pos: 0, color: [0, 0, 0, 1] },
                        { pos: 1, color: [1, 1, 1, 1] },
                      ],
                      'Reset Color Ramp',
                    ),
                    (n.props.ramp_active = 0)
                  ),
                },
              ],
              e.currentTarget as HTMLElement,
            );
          },
        },
        icon('down_arrow_hlt'),
      ),
      enumMenu(
        `${key}:mode`,
        [
          { value: 'RGB', label: 'RGB' },
          { value: 'HSV', label: 'HSV' },
          { value: 'HSL', label: 'HSL' },
        ],
        ramp.colorMode,
        (v) => ((n.props.ramp_color_mode = v), commit('Color Mode')),
        { title: 'Color Mode' },
      ),
      ramp.colorMode === 'RGB'
        ? enumMenu(
            `${key}:interp`,
            [
              { value: 'EASE', label: 'Ease' },
              { value: 'CARDINAL', label: 'Cardinal' },
              { value: 'LINEAR', label: 'Linear' },
              { value: 'B_SPLINE', label: 'B-Spline' },
              { value: 'CONSTANT', label: 'Constant' },
            ],
            ramp.interpolation,
            (v) => ((n.props.ramp_interpolation = v), commit('Interpolation')),
            { title: 'Interpolation' },
          )
        : enumMenu(
            `${key}:hue`,
            [
              { value: 'NEAR', label: 'Near' },
              { value: 'FAR', label: 'Far' },
              { value: 'CW', label: 'Clockwise' },
              { value: 'CCW', label: 'Counter-Clockwise' },
            ],
            ramp.hueInterpolation,
            (v) => ((n.props.ramp_hue_interpolation = v), commit('Hue Interpolation')),
            { title: 'Color Interpolation' },
          ),
    ),
    h(
      'div',
      { class: 'nd-ramp-bar', onpointerdown: barDown },
      h('div', { class: 'nd-ramp-checker' }),
      h('div', {
        class: 'nd-ramp-grad',
        style: { background: `linear-gradient(to right, ${grad.join(', ')})` },
      }),
      stops.map((s, i) =>
        h('div', {
          key: `m${i}`,
          class: { 'nd-ramp-mark': true, on: i === act },
          style: { left: `${s.pos * 100}%`, '--mc': css(s.color) },
        }),
      ),
    ),
    cur
      ? h(
          'div',
          { class: 'nd-ramp-stop' },
          numberField({
            id: `${key}:idx`,
            value: act,
            int: true,
            min: 0,
            max: stops.length - 1,
            set: (v) => ((n.props.ramp_active = v), commit('Active Stop', false)),
          }),
          numberField({
            id: `${key}:pos`,
            label: 'Pos',
            value: cur.pos,
            min: 0,
            max: 1,
            slider: true,
            set: (v, final) => {
              const s = readRamp(n.props).stops;
              s[act].pos = v;
              setStops(s, 'Stop Position', final);
            },
          }),
        )
      : null,
    cur
      ? h(
          'div',
          { class: 'nd-ramp-color' },
          colorSwatch(
            `${key}:col`,
            cur.color,
            (c, final) => {
              const s = readRamp(n.props).stops;
              s[act].color = [c[0], c[1], c[2], c[3] ?? 1];
              setStops(s, 'Stop Color', final);
            },
            { alpha: true },
          ),
        )
      : null,
  );
}

// ---------------------------------------------------------------------------
// Curves

const CURVE_SIZE = 150;

function curveKind(n: NodeData): CurveKind {
  const k = n.props.curve_kind as CurveKind | undefined;
  if (k && k in CURVE_NAMES) return k;
  return n.type === 'ShaderNodeRGBCurve' ? 'RGB' : n.type === 'ShaderNodeVectorCurve' ? 'VECTOR' : 'FLOAT';
}

export function drawCurves(ctx: NodeDrawContext): Child {
  const n = ctx.node;
  const kind = curveKind(n);
  if (!n.props.curve_0) Object.assign(n.props, defaultCurves(kind));
  const names = CURVE_NAMES[kind];
  const active = Math.max(0, Math.min(names.length - 1, (n.props.curve_active as number) ?? 0));
  const pts = readCurve(n.props, active);
  const sel = Math.max(-1, Math.min(pts.length - 1, (n.props.curve_point as number) ?? -1));
  const [x0, y0, x1, y1] = CURVE_RANGE[kind];
  const extend = (n.props.curve_extend as string) ?? 'EXTRAPOLATED';
  const W = 200,
    H = CURVE_SIZE;
  const sx = (x: number) => ((x - x0) / (x1 - x0)) * W;
  const sy = (y: number) => H - ((y - y0) / (y1 - y0)) * H;
  const commit = (label: string, final = true) => ctx.changed(label, final);
  const key = `${ctx.key}:curve`;
  const colors: Record<string, string> = {
    c: '#e8e9ea',
    r: '#dc524b',
    g: '#66c06a',
    b: '#577edf',
    x: '#dc524b',
    y: '#66c06a',
    z: '#577edf',
    v: '#e8e9ea',
    h: '#e8e9ea',
    s: '#e8e9ea',
  };
  const periodic = kind === 'HUE';
  const curvePath = (i: number) => {
    const p = readCurve(n.props, i);
    let d = '';
    for (let k = 0; k <= 64; k++) {
      const x = x0 + ((x1 - x0) * k) / 64;
      d += `${k ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(periodic ? evalPeriodicCurve(p, x) : evalCurve(p, x, extend)).toFixed(1)}`;
    }
    return d;
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const svg = (e.currentTarget as SVGElement).closest('svg')!;
    const r = svg.getBoundingClientRect();
    const toCurve = (cx: number, cy: number): [number, number] => [x0 + ((cx - r.left) / r.width) * (x1 - x0), y0 + (1 - (cy - r.top) / r.height) * (y1 - y0)];
    const [px, py] = toCurve(e.clientX, e.clientY);
    const cur = readCurve(n.props, active);
    let idx = -1,
      bd = (10 / r.width) * (x1 - x0);
    cur.forEach((p, i) => {
      const d = Math.hypot(p.x - px, (p.y - py) * ((x1 - x0) / (y1 - y0)));
      if (d < bd) {
        bd = d;
        idx = i;
      }
    });
    if (idx < 0) {
      cur.push({ x: px, y: py, handle: 0 });
      writeCurve(n.props, active, cur);
      const sorted = readCurve(n.props, active);
      idx = sorted.findIndex((p) => p.x === px && p.y === py);
    }
    n.props.curve_point = idx;
    const ref = readCurve(n.props, active)[idx];
    setWidgetDragging(true);
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      const [x, y] = toCurve(ev.clientX, ev.clientY);
      const list = readCurve(n.props, active);
      const i = list.findIndex((p) => p.x === ref.x && p.y === ref.y);
      if (i < 0) return;
      ref.x = Math.max(x0, Math.min(x1, x));
      ref.y = Math.max(y0, Math.min(y1, y));
      list[i] = ref;
      writeCurve(n.props, active, list);
      n.props.curve_point = readCurve(n.props, active).findIndex((p) => p.x === ref.x && p.y === ref.y);
      commit('Move Curve Point', false);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      setWidgetDragging(false);
      commit(moved ? 'Move Curve Point' : 'Add Curve Point');
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    commit('Select Curve Point', false);
  };
  const point = sel >= 0 ? pts[sel] : null;
  const setPoint = (patch: Partial<CurvePoint>, label: string, final = true) => {
    const list = readCurve(n.props, active);
    if (sel < 0 || !list[sel]) return;
    Object.assign(list[sel], patch);
    const keep = list[sel];
    writeCurve(n.props, active, list);
    n.props.curve_point = readCurve(n.props, active).findIndex((p) => p.x === keep.x && p.y === keep.y);
    commit(label, final);
  };
  const grid: Child[] = [];
  for (let i = 1; i < 4; i++) {
    grid.push(
      h('line', {
        key: `gx${i}`,
        x1: (W * i) / 4,
        y1: 0,
        x2: (W * i) / 4,
        y2: H,
        class: 'nd-curve-grid',
      }),
    );
    grid.push(
      h('line', {
        key: `gy${i}`,
        x1: 0,
        y1: (H * i) / 4,
        x2: W,
        y2: (H * i) / 4,
        class: 'nd-curve-grid',
      }),
    );
  }
  return h(
    'div',
    { class: 'nd-curve' },
    h(
      'div',
      { class: 'nd-curve-tools' },
      names.length > 1
        ? h(
            'div',
            { class: 'enum-row nd-curve-tabs' },
            names.map((nm, i) =>
              h(
                'button',
                {
                  key: nm,
                  class: { on: i === active },
                  onclick: () => ((n.props.curve_active = i), (n.props.curve_point = -1), commit('Curve Channel', false)),
                },
                nm.toUpperCase(),
              ),
            ),
          )
        : h('div', { class: 'hdr-spacer' }),
      h(
        'button',
        {
          class: 'nd-ramp-btn',
          'data-tip': 'Curve Specials',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              [
                ...(periodic
                  ? []
                  : [
                      {
                        label: 'Extend Horizontal',
                        active: extend === 'HORIZONTAL',
                        action: () => ((n.props.curve_extend = 'HORIZONTAL'), commit('Curve Extend')),
                      },
                      {
                        label: 'Extend Extrapolated',
                        active: extend === 'EXTRAPOLATED',
                        action: () => ((n.props.curve_extend = 'EXTRAPOLATED'), commit('Curve Extend')),
                      },
                      { separator: true },
                    ]),
                {
                  label: 'Reset Curve',
                  action: () => {
                    if (periodic) n.props[`curve_${active}`] = [...(defaultCurves('HUE').curve_0 as number[])];
                    else
                      writeCurve(n.props, active, [
                        { x: x0, y: y0, handle: 0 },
                        { x: x1, y: y1, handle: 0 },
                      ]);
                    n.props.curve_point = -1;
                    commit('Reset Curve');
                  },
                },
              ],
              e.currentTarget as HTMLElement,
            );
          },
        },
        icon('down_arrow_hlt'),
      ),
    ),
    h(
      'svg',
      {
        class: 'nd-curve-svg',
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: 'none',
        onpointerdown: down,
      },
      h('rect', { x: 0, y: 0, width: W, height: H, class: 'nd-curve-bg' }),
      // hue curves: the hue circle along the bottom edge
      periodic ? h('rect', { x: 0, y: H - 6, width: W, height: 6, fill: 'url(#nd-hue-grad)' }) : null,
      periodic
        ? h(
            'defs',
            null,
            h(
              'linearGradient',
              { id: 'nd-hue-grad', x1: '0', x2: '1', y1: '0', y2: '0' },
              ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'].map((c, i) => h('stop', { key: `s${i}`, offset: `${(i / 6) * 100}%`, 'stop-color': c })),
            ),
          )
        : null,
      grid,
      names.map((nm, i) =>
        i === active
          ? null
          : h('path', {
              key: `c${i}`,
              d: curvePath(i),
              class: 'nd-curve-path dim',
              stroke: colors[nm],
            }),
      ),
      h('path', {
        key: 'act',
        d: curvePath(active),
        class: 'nd-curve-path',
        stroke: colors[names[active]],
      }),
      pts.map((p, i) =>
        h('circle', {
          key: `p${i}`,
          cx: sx(p.x),
          cy: sy(p.y),
          r: 3.5,
          class: { 'nd-curve-pt': true, on: i === sel },
        }),
      ),
    ),
    h(
      'div',
      { class: 'nd-curve-point' },
      point
        ? [
            numberField({
              id: `${key}:px`,
              label: 'X',
              value: point.x,
              min: x0,
              max: x1,
              set: (v, f) => setPoint({ x: v }, 'Curve Point X', f),
            }),
            numberField({
              id: `${key}:py`,
              label: 'Y',
              value: point.y,
              min: y0,
              max: y1,
              set: (v, f) => setPoint({ y: v }, 'Curve Point Y', f),
            }),
            enumMenu(
              `${key}:ph`,
              [
                { value: '0', label: 'Auto Handle' },
                { value: '2', label: 'Auto Clamped Handle' },
                { value: '1', label: 'Vector Handle' },
              ],
              String(point.handle),
              (v) => setPoint({ handle: Number(v) }, 'Curve Handle Type'),
              { iconOnly: false, title: 'Handle Type' },
            ),
            h(
              'button',
              {
                class: 'nd-ramp-btn',
                'data-tip': 'Delete Point',
                disabled: pts.length <= 2,
                onclick: () => {
                  const list = readCurve(n.props, active).filter((_, i) => i !== sel);
                  writeCurve(n.props, active, list);
                  n.props.curve_point = -1;
                  commit('Delete Curve Point');
                },
              },
              icon('x'),
            ),
          ]
        : h('span', { class: 'nd-curve-hint' }, 'Click to add or select a point'),
    ),
    kind === 'RGB'
      ? h(
          'div',
          { class: 'nd-curve-levels' },
          h('span', { class: 'nd-label' }, 'Black'),
          colorSwatch(`${key}:black`, [...((n.props.black_level as number[]) ?? [0, 0, 0])], (c, f) => ((n.props.black_level = c.slice(0, 3)), commit('Black Level', f))),
          h('span', { class: 'nd-label' }, 'White'),
          colorSwatch(`${key}:white`, [...((n.props.white_level as number[]) ?? [1, 1, 1])], (c, f) => ((n.props.white_level = c.slice(0, 3)), commit('White Level', f))),
        )
      : null,
  );
}

export const RAMP_HEIGHT = 112;
export function curveHeight(n: NodeData) {
  return 24 + CURVE_SIZE + 6 + 24 + (curveKind(n) === 'RGB' || curveKind(n) === 'HUE' ? 24 : 0) + 6;
}

/**
 * Attach the ramp / curve bodies to the shader node types. Called from `rampattach.ts`, which the
 * nodes entry imports after the shader definitions: this module is also imported early by other
 * areas (modifier panels, sequencer), before the node types exist.
 */
export function attachRampBodies() {
  const ramp = getNodeType('ShaderNodeValToRGB');
  if (ramp) {
    ramp.drawBody = drawRamp;
    ramp.bodyHeight = () => RAMP_HEIGHT;
  }
  for (const id of ['ShaderNodeRGBCurve', 'ShaderNodeVectorCurve', 'ShaderNodeFloatCurve']) {
    const d = getNodeType(id);
    if (!d) continue;
    d.drawBody = drawCurves;
    d.bodyHeight = curveHeight;
  }
}
attachRampBodies();
