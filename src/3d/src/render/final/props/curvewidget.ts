// Small curve editor for a list of [x, y] control points in the unit square: drag points,
// click empty space to add one, Ctrl-click (or double-click) a point to remove it.
import { h, type Child } from '../../../ui/h';
import { app } from '../../../app/app';
import { button } from '../../../ui/widgets';
import { curveTable } from '../colormanage';

const SIZE = 160;
const PAD = 6;

export function curveWidget(id: string, get: () => [number, number][], set: (pts: [number, number][]) => void, label: string): Child {
  const pts = get();
  const table = curveTable(pts);
  const toPx = (x: number, y: number) => [PAD + x * SIZE, PAD + (1 - y) * SIZE];
  const path = Array.from(table, (v, i) => {
    const [px, py] = toPx(i / (table.length - 1), v);
    return `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
  }).join('');
  const grid: string[] = [];
  for (let k = 1; k < 4; k++) {
    const g = PAD + (k / 4) * SIZE;
    grid.push(`M${g} ${PAD}V${PAD + SIZE}M${PAD} ${g}H${PAD + SIZE}`);
  }
  const local = (e: PointerEvent, svg: SVGSVGElement): [number, number] => {
    const r = svg.getBoundingClientRect();
    const sx = (SIZE + PAD * 2) / r.width;
    const x = ((e.clientX - r.left) * sx - PAD) / SIZE,
      y = 1 - ((e.clientY - r.top) * sx - PAD) / SIZE;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  };
  const commit = (label2: string) => {
    app.pushUndo(label2);
    app.changed('doc');
  };
  return h(
    'div',
    { class: 'cm-curve', key: id },
    h(
      'svg',
      {
        class: 'cm-curve-svg',
        viewBox: `0 0 ${SIZE + PAD * 2} ${SIZE + PAD * 2}`,
        'data-tip': `${label}\nDrag points, click to add one, Ctrl-click a point to remove it`,
        onpointerdown: (e: PointerEvent) => {
          const svg = e.currentTarget as SVGSVGElement;
          e.preventDefault();
          const [x, y] = local(e, svg);
          const list = get().map((p) => [p[0], p[1]] as [number, number]);
          // nearest point within reach
          let hit = -1,
            best = 0.06;
          list.forEach((p, i) => {
            const d = Math.hypot(p[0] - x, p[1] - y);
            if (d < best) (best = d), (hit = i);
          });
          if (hit >= 0 && (e.ctrlKey || e.metaKey)) {
            if (list.length > 2) {
              list.splice(hit, 1);
              set(list);
              commit('Remove Curve Point');
            }
            return;
          }
          if (hit < 0) {
            list.push([x, y]);
            list.sort((a, b) => a[0] - b[0]);
            hit = list.findIndex((p) => p[0] === x && p[1] === y);
          }
          set(list);
          app.changed('doc');
          svg.setPointerCapture(e.pointerId);
          const move = (ev: PointerEvent) => {
            const [mx, my] = local(ev, svg);
            const cur = get().map((p) => [p[0], p[1]] as [number, number]);
            // keep points ordered: a point stays between its neighbours
            const lo = hit > 0 ? cur[hit - 1][0] + 1e-3 : 0,
              hi = hit < cur.length - 1 ? cur[hit + 1][0] - 1e-3 : 1;
            cur[hit] = [Math.min(hi, Math.max(lo, mx)), my];
            set(cur);
            app.changed('doc');
          };
          const up = () => {
            svg.removeEventListener('pointermove', move);
            svg.removeEventListener('pointerup', up);
            commit('Edit Curve');
          };
          svg.addEventListener('pointermove', move);
          svg.addEventListener('pointerup', up);
        },
      },
      h('rect', { x: PAD, y: PAD, width: SIZE, height: SIZE, class: 'cm-curve-bg' }),
      h('path', { d: grid.join(''), class: 'cm-curve-grid' }),
      h('path', { d: `M${PAD} ${PAD + SIZE}L${PAD + SIZE} ${PAD}`, class: 'cm-curve-diag' }),
      h('path', { d: path, class: 'cm-curve-line' }),
      ...pts.map((p, i) => {
        const [cx, cy] = toPx(p[0], p[1]);
        return h('circle', { key: `p${i}`, cx, cy, r: 3.5, class: 'cm-curve-pt' });
      }),
    ),
    h(
      'div',
      { class: 'btn-row' },
      button(`${id}-reset`, 'Reset', () => {
        set([
          [0, 0],
          [1, 1],
        ]);
        commit('Reset Curve');
      }),
    ),
  );
}
