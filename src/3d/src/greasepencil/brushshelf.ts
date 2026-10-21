// Brush shelf of the Grease Pencil paint modes: a strip along the bottom of the 3D viewport with a
// thumbnail per brush (the Draw presets, the eraser kinds, Fill and Tint in Draw Mode; the sculpt,
// vertex and weight brushes in the other modes), category tabs and a search field. View ▸ Asset
// Shelf shows or hides it. Thumbnails are drawn procedurally to suggest each brush's stroke.
import { app } from '../app/app';
import { activeTools } from '../app/prefs';
import { viewMenuExtras, viewportUIHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { setActiveTool, extraToolLists, type ToolDef } from '../editors/view3d/toolbar';
import { h, type Child } from '../ui/h';
import { icon, iconSvg } from '../ui/icons';
import { gpOf, gpTS, gpBrush, DRAW_PRESETS } from './data';

const MODES = new Set(['PAINT_GREASE_PENCIL', 'SCULPT_GREASE_PENCIL', 'VERTEX_GREASE_PENCIL', 'WEIGHT_GREASE_PENCIL']);
const inBrushMode = () => MODES.has(app.doc.mode) && !!gpOf(app.doc, app.activeObject);

export interface ShelfBrush {
  id: string;
  name: string;
  category: string;
  thumb: string;
  active: boolean;
  pick: () => void;
}

// ---------------------------------------------------------------------------
// thumbnails

const thumbCache = new Map<string, string>();

/** A squiggle drawn as a row of round dabs, with width / opacity / jitter shaped by the style. */
function strokeThumb(key: string, o: { width: number; taper: number; alpha: number; soft?: boolean; color?: string; flat?: boolean }): string {
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const W = 96;
  const parts: string[] = [];
  const col = o.color ?? '#202020';
  const n = 60;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = 10 + t * 76;
    const y = 50 - Math.sin(t * Math.PI * 1.6) * 22 + t * 4;
    // pressure-like width: thin at both ends when tapered
    const press = 1 - o.taper + o.taper * Math.sin(t * Math.PI);
    const r = Math.max(0.6, (o.width / 2) * press);
    if (o.flat) parts.push(`<rect x="${(x - r * 0.35).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${(r * 0.7).toFixed(1)}" height="${(r * 2).toFixed(1)}" fill="${col}" fill-opacity="${o.alpha}"/>`);
    else parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="${col}" fill-opacity="${o.alpha}"${o.soft ? ' filter="url(#b)"' : ''}/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}"><defs><filter id="b"><feGaussianBlur stdDeviation="2.4"/></filter></defs><rect width="${W}" height="${W}" rx="8" fill="#dcdcdc"/>${parts.join('')}</svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  thumbCache.set(key, url);
  return url;
}

/** An icon on a light tile, for brushes without a stroke look (sculpt / vertex / weight tools). */
function iconThumb(name: string): string {
  const key = `icon:${name}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const body = iconSvg(name)
    .replace(/<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="96" height="96"><style>.f{fill:#303030}.s{stroke:#303030}</style><rect width="16" height="16" rx="1.4" fill="#dcdcdc"/><g transform="translate(2.4 2.4) scale(.7)">${body}</g></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  thumbCache.set(key, url);
  return url;
}

const PRESET_LOOK: Record<string, Parameters<typeof strokeThumb>[1]> = {
  Pencil: { width: 3, taper: 0.5, alpha: 0.85, color: '#3a3a3a' },
  Pen: { width: 5, taper: 0.3, alpha: 1 },
  'Ink Pen': { width: 8, taper: 0.9, alpha: 1, color: '#101010' },
  Marker: { width: 12, taper: 0, alpha: 0.55, flat: true, color: '#1d1d1d' },
  Airbrush: { width: 16, taper: 0, alpha: 0.18, soft: true },
};

// ---------------------------------------------------------------------------
// brushes per mode

export function shelfBrushes(): ShelfBrush[] {
  const mode = app.doc.mode;
  const cur = activeTools[mode];
  const out: ShelfBrush[] = [];
  if (mode === 'PAINT_GREASE_PENCIL') {
    const ts = gpTS(app.doc);
    for (const p of DRAW_PRESETS)
      out.push({
        id: `draw:${p.id}`,
        name: p.name,
        category: 'Draw',
        thumb: strokeThumb(`draw:${p.id}`, PRESET_LOOK[p.id] ?? { width: Math.min(14, p.size / 4), taper: p.use_pressure_size ? 0.6 : 0, alpha: p.strength }),
        active: cur === 'builtin.brush.Draw' && ts.gpencil_draw_brush === p.id,
        pick: () => {
          ts.gpencil_draw_brush = p.id;
          Object.assign(gpBrush(app.doc, 'builtin.brush.Draw'), {
            size: p.size,
            strength: p.strength,
            use_pressure_size: p.use_pressure_size,
            use_pressure_strength: p.use_pressure_strength,
            pen_smooth_factor: p.smooth,
          });
          setActiveTool('builtin.brush.Draw');
        },
      });
    const er = gpBrush(app.doc, 'builtin.brush.Erase');
    for (const [m, name, look] of [
      ['SOFT', 'Eraser Soft', { width: 14, taper: 0, alpha: 0.35, soft: true, color: '#c04040' }],
      ['HARD', 'Eraser Point', { width: 9, taper: 0, alpha: 0.85, color: '#c04040' }],
      ['STROKE', 'Eraser Stroke', { width: 4, taper: 0, alpha: 0.9, color: '#c04040' }],
    ] as const)
      out.push({
        id: `erase:${m}`,
        name,
        category: 'Erase',
        thumb: strokeThumb(`erase:${m}`, look),
        active: cur === 'builtin.brush.Erase' && (er.eraser_mode ?? 'HARD') === m,
        pick: () => {
          er.eraser_mode = m;
          setActiveTool('builtin.brush.Erase');
        },
      });
    out.push(
      { id: 'fill', name: 'Fill Area', category: 'Utilities', thumb: iconThumb('gp_fill'), active: cur === 'builtin.brush.Fill', pick: () => setActiveTool('builtin.brush.Fill') },
      { id: 'tint', name: 'Tint', category: 'Utilities', thumb: iconThumb('gp_tint'), active: cur === 'builtin.brush.Tint', pick: () => setActiveTool('builtin.brush.Tint') },
    );
    return out;
  }
  const tools = (extraToolLists[mode]?.() ?? []).filter((t): t is ToolDef => !!t && t.id.startsWith('builtin.brush.'));
  for (const t of tools) out.push({ id: t.id, name: t.label, category: 'Brushes', thumb: iconThumb(t.icon), active: cur === t.id, pick: () => setActiveTool(t.id) });
  return out;
}

// ---------------------------------------------------------------------------
// the shelf

interface ShelfState {
  show: boolean;
  tab: string;
  search: string;
}
const states = new WeakMap<View3D, ShelfState>();
function stateOf(v: View3D): ShelfState {
  let s = states.get(v);
  if (!s) states.set(v, (s = { show: true, tab: 'All', search: '' }));
  return s;
}

const changed = () => app.changed('ui');

function shelf(v: View3D): Child {
  if (!inBrushMode()) return null;
  const st = stateOf(v);
  if (!st.show) return null;
  const all = shelfBrushes();
  const cats = [...new Set(all.map((b) => b.category))];
  const q = st.search.trim().toLowerCase();
  const list = all.filter((b) => (st.tab === 'All' || b.category === st.tab) && (!q || b.name.toLowerCase().includes(q)));
  const left = v.showToolbar ? 50 : 4;
  const right = v.showSidebar ? 274 : 4;
  const size = 56;
  return h(
    'div',
    { key: 'gp-shelf', class: 'paint-shelf gp-shelf', style: { left: `${left}px`, right: `${right}px` } },
    h(
      'div',
      { class: 'ps-bar' },
      ['All', ...(cats.length > 1 ? cats : [])].map((t) => h('button', { key: t, class: { 'ps-tab': true, on: st.tab === t }, onclick: () => ((st.tab = t), changed()) }, t)),
      h('div', { class: 'ps-spacer' }),
      h('input', {
        class: 'ps-search',
        placeholder: 'Search',
        value: st.search,
        oninput: (e: Event) => ((st.search = (e.target as HTMLInputElement).value), changed()),
        onkeydown: (e: KeyboardEvent) => e.stopPropagation(),
      }),
      h('button', { class: 'ps-icon', 'data-tip': 'Hide the brush shelf (View ▸ Asset Shelf)', onclick: () => ((st.show = false), changed()) }, icon('x')),
    ),
    h(
      'div',
      { class: 'ps-row' },
      list.length
        ? list.map((b) =>
            h(
              'button',
              {
                key: b.id,
                class: { 'ps-tile': true, on: b.active },
                'data-brush': b.id,
                'data-tip': b.name,
                style: { width: `${size + 8}px` },
                onclick: () => {
                  b.pick();
                  changed();
                },
              },
              h('img', { src: b.thumb, width: size, height: size, draggable: false, alt: '' }),
              h('span', { class: 'ps-name' }, b.name),
            ),
          )
        : h('div', { class: 'ps-empty' }, 'No brushes match'),
    ),
  );
}

viewportUIHooks.push(shelf);

viewMenuExtras.push(() => {
  const v = activeView3D();
  if (!v || !inBrushMode()) return [];
  const st = stateOf(v);
  return [{ label: 'Asset Shelf', checked: st.show, action: () => ((st.show = !st.show), changed()) }];
});
