/**
 * Editing one curtain wall's mullions and panels on its elevation: click a
 * mullion segment to remove or restore it, click a panel to change it.
 */
import { h } from './dom.js';
import { openDialog, toast } from './dialog.js';
import { curtainGrid } from '../core/build3d.js';
import { wallAxis, verticalExtent } from '../core/model.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const PANEL_KINDS = [
  { value: 'glass', label: 'Glass', fill: 'rgba(120, 170, 220, 0.45)' },
  { value: 'solid', label: 'Solid', fill: 'rgba(200, 200, 195, 0.95)' },
  { value: 'door', label: 'Door', fill: 'rgba(120, 170, 220, 0.45)' },
  { value: 'empty', label: 'Empty', fill: 'transparent' },
];

export function curtainEditDialog(app, id = [...app.selection][0]) {
  const doc = app.doc;
  const w = doc.get(id);
  const type = w && doc.get(w.typeId);
  if (!type?.curtain) return toast('Select a curtain wall first.', { kind: 'error' });
  const ax = wallAxis(doc, w);
  const { base, top } = verticalExtent(doc, w);
  const L = ax.length;
  const H = top - base;
  const { us, vs, nu, nv } = curtainGrid(L, H, type, w);
  const off = new Set(w.mullionsOff || []);
  const panels = { ...(w.panels || {}) };
  let brush = 'solid';
  const W0 = 640;
  const s = Math.min(W0 / L, 380 / H);
  const pad = 14;
  const X = (u) => pad + u * s;
  const Y = (z) => pad + (H - z) * s;
  const root = svg('svg', { viewBox: `0 0 ${L * s + pad * 2} ${H * s + pad * 2}`, class: 'cw-svg', role: 'img', 'aria-label': 'Curtain wall elevation' });
  const draw = () => {
    root.replaceChildren();
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        const kind = panels[`${i}:${j}`] || 'glass';
        const k = PANEL_KINDS.find((p) => p.value === kind);
        const r = svg('rect', { x: X(us[i]) + 2, y: Y(vs[j + 1]) + 2, width: Math.max(1, (us[i + 1] - us[i]) * s - 4), height: Math.max(1, (vs[j + 1] - vs[j]) * s - 4), fill: k.fill, class: `cw-panel ${kind}`, tabindex: '0' });
        r.append(svg('title'));
        r.firstChild.textContent = `${k.label} panel (click to make it ${PANEL_KINDS.find((p) => p.value === brush).label.toLowerCase()})`;
        const set = () => {
          if (brush === 'glass') delete panels[`${i}:${j}`];
          else panels[`${i}:${j}`] = brush;
          draw();
        };
        r.addEventListener('click', set);
        r.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), set()));
        root.append(r);
        if (kind === 'door') root.append(svg('line', { x1: X(us[i + 1]) - 10, y1: Y((vs[j] + vs[j + 1]) / 2) - 8, x2: X(us[i + 1]) - 10, y2: Y((vs[j] + vs[j + 1]) / 2) + 8, class: 'cw-handle' }));
      }
    const seg = (key, x1, y1, x2, y2) => {
      const on = !off.has(key);
      const g = svg('g', { class: `cw-mullion${on ? '' : ' off'}`, tabindex: '0' });
      g.append(svg('line', { x1, y1, x2, y2, class: 'hit' }), svg('line', { x1, y1, x2, y2, class: 'vis' }), svg('title'));
      g.lastChild.textContent = on ? 'Mullion (click to remove)' : 'No mullion (click to add)';
      const flip = () => {
        if (on) off.add(key);
        else off.delete(key);
        draw();
      };
      g.addEventListener('click', flip);
      g.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), flip()));
      root.append(g);
    };
    for (let i = 0; i <= nu; i++) for (let j = 0; j < nv; j++) seg(`v:${i}:${j}`, X(us[i]), Y(vs[j]), X(us[i]), Y(vs[j + 1]));
    for (let j = 0; j <= nv; j++) for (let i = 0; i < nu; i++) seg(`h:${j}:${i}`, X(us[i]), Y(vs[j]), X(us[i + 1]), Y(vs[j]));
  };
  draw();
  const brushes = h('div.seg', { role: 'radiogroup', 'aria-label': 'Panel type to apply' });
  const renderBrushes = () => {
    brushes.replaceChildren(...PANEL_KINDS.map((p) => h('button.seg-btn', { type: 'button', role: 'radio', 'aria-checked': String(p.value === brush), onClick: () => ((brush = p.value), renderBrushes(), draw()) }, h('span.cw-swatch', { style: { background: p.fill } }), p.label)));
  };
  renderBrushes();
  return openDialog({
    title: `Mullions and Panels: ${type.name}`,
    size: 'lg',
    body: h('div.cw-edit', h('div.cw-tools', h('span.field-label', 'Click panels to make them'), brushes, h('button.btn.sm', { type: 'button', onClick: () => (off.clear(), Object.keys(panels).forEach((k) => delete panels[k]), draw()) }, 'Reset all')), root, h('p.field-hint', 'Click a mullion segment to remove it or bring it back. Grid lines themselves are moved with the Curtain Grid tool.')),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'OK',
        primary: true,
        onClick: () => {
          app.commit('Edit mullions and panels', () => doc.update(w.id, { mullionsOff: off.size ? [...off] : null, panels: Object.keys(panels).length ? panels : null }));
          return true;
        },
      },
    ],
  });
}
