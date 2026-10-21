// Space in the Grease Pencil paint modes: a popup grid of the mode's brushes (the Draw presets,
// Erase, Fill, Tint in Draw Mode; the sculpt / vertex / weight brushes in the other modes).
import { app } from '../app/app';
import { activeTools } from '../app/prefs';
import { addKeys } from '../app/keymap';
import { extraToolLists, setActiveTool, type ToolDef } from '../editors/view3d/toolbar';
import { h } from '../ui/h';
import { icon } from '../ui/icons';
import { openPopover, closeMenus } from '../ui/menu';
import { gpOf, gpTS, gpBrush, DRAW_PRESETS } from './data';

const MODES = new Set(['PAINT_GREASE_PENCIL', 'SCULPT_GREASE_PENCIL', 'VERTEX_GREASE_PENCIL', 'WEIGHT_GREASE_PENCIL']);
const inBrushMode = () => MODES.has(app.doc.mode) && !!gpOf(app.doc, app.activeObject);

interface Tile {
  key: string;
  label: string;
  icon: string;
  active: boolean;
  pick: () => void;
}

/** Brushes offered for the current mode. */
export function brushTiles(): Tile[] {
  const mode = app.doc.mode;
  const cur = activeTools[mode];
  const tools = (extraToolLists[mode]?.() ?? []).filter((t): t is ToolDef => !!t && (t.id.startsWith('builtin.brush.') || t.id.startsWith('builtin_brush.')));
  const out: Tile[] = [];
  for (const t of tools) {
    if (mode === 'PAINT_GREASE_PENCIL' && t.id === 'builtin.brush.Draw') {
      // the Draw tool's presets each get a tile
      const ts = gpTS(app.doc);
      for (const p of DRAW_PRESETS)
        out.push({
          key: `preset:${p.id}`,
          label: p.name,
          icon: 'gp_draw',
          active: cur === t.id && ts.gpencil_draw_brush === p.id,
          pick: () => {
            ts.gpencil_draw_brush = p.id;
            Object.assign(gpBrush(app.doc, 'builtin.brush.Draw'), {
              size: p.size,
              strength: p.strength,
              use_pressure_size: p.use_pressure_size,
              use_pressure_strength: p.use_pressure_strength,
              pen_smooth_factor: p.smooth,
            });
            setActiveTool(t.id);
          },
        });
      continue;
    }
    out.push({ key: t.id, label: t.label, icon: t.icon, active: cur === t.id, pick: () => setActiveTool(t.id) });
  }
  return out;
}

export function openGPBrushPicker(anchor: { x: number; y: number }) {
  if (!inBrushMode()) return;
  openPopover(
    anchor,
    () =>
      h(
        'div',
        { class: 'pop-panel gp-brush-pick' },
        brushTiles().map((t) =>
          h(
            'button',
            {
              key: t.key,
              class: { 'gp-bp-tile': true, on: t.active },
              'data-tip': t.label,
              onclick: () => {
                t.pick();
                closeMenus();
                app.changed('ui');
              },
            },
            icon(t.icon),
            h('span', null, t.label),
          ),
        ),
      ),
    { width: 360 },
  );
}

addKeys('Grease Pencil', [
  {
    key: 'SPACE',
    when: inBrushMode,
    action: () => openGPBrushPicker({ x: app.pointer.x - 180, y: app.pointer.y - 20 }),
  },
]);
