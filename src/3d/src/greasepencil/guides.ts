// Drawing guides (Draw tool): constrain new strokes to lines in a direction (Parallel), through a
// reference point (Radial), around it (Circular), horizontal / vertical (Grid) or isometric (Iso),
// optionally snapped to a spacing. Pure constraint math plus the header popover.
import { Vector3 } from 'three';
import { app } from '../app/app';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { checkbox, enumMenu, numberField } from '../ui/widgets';
import { openPopover } from '../ui/menu';
import { gpTS } from './data';
import type { View3D } from '../editors/view3d/view3d';

export interface GuideSettings {
  use_guide: boolean;
  type: 'CIRCULAR' | 'RADIAL' | 'PARALLEL' | 'GRID' | 'ISO';
  use_snapping: boolean;
  angle: number;
  angle_snap: number;
  /** spacing in pixels */
  spacing: number;
  reference_point: 'CURSOR' | 'CUSTOM' | 'OBJECT';
  location: [number, number, number];
  reference_object: string | null;
}

export function guideSettings(): GuideSettings {
  const ts = gpTS(app.doc) as unknown as { gpencil_guide?: GuideSettings };
  return (ts.gpencil_guide ??= {
    use_guide: false,
    type: 'CIRCULAR',
    use_snapping: false,
    angle: 0,
    angle_snap: Math.PI / 12,
    spacing: 20,
    reference_point: 'CURSOR',
    location: [0, 0, 0],
    reference_object: null,
  });
}

type P2 = { x: number; y: number };

/**
 * A constraint for one stroke started at `start` (screen pixels, y down). `center` is the reference
 * point on screen. Returns a function mapping pointer positions to guided positions; Grid and Iso
 * pick their direction from the first movement (`dir`).
 */
export function guideConstraint(g: GuideSettings, start: P2, center: P2, dir?: P2): ((p: P2) => P2) | null {
  let s = start;
  const snap = (v: number) => (g.use_snapping && g.spacing > 0 ? Math.round(v / g.spacing) * g.spacing : v);
  const along = (o: P2, a: number) => (p: P2) => {
    const ux = Math.cos(a),
      uy = -Math.sin(a);
    const t = (p.x - o.x) * ux + (p.y - o.y) * uy;
    return { x: o.x + ux * t, y: o.y + uy * t };
  };
  switch (g.type) {
    case 'PARALLEL': {
      if (g.use_snapping) {
        // parallel lines spaced evenly: snap the start across the line direction
        const nx = Math.sin(g.angle),
          ny = Math.cos(g.angle);
        const d = snap((s.x - center.x) * nx + (s.y - center.y) * ny);
        const t = (s.x - center.x) * Math.cos(g.angle) - (s.y - center.y) * Math.sin(g.angle);
        s = { x: center.x + nx * d + Math.cos(g.angle) * t, y: center.y + ny * d - Math.sin(g.angle) * t };
      }
      return along(s, g.angle);
    }
    case 'RADIAL': {
      let a = Math.atan2(-(s.y - center.y), s.x - center.x);
      if (g.use_snapping && g.angle_snap > 0) a = Math.round((a - g.angle) / g.angle_snap) * g.angle_snap + g.angle;
      return along(center, a);
    }
    case 'CIRCULAR': {
      const r = snap(Math.hypot(s.x - center.x, s.y - center.y));
      return (p: P2) => {
        const a = Math.atan2(p.y - center.y, p.x - center.x);
        return { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r };
      };
    }
    case 'GRID':
    case 'ISO': {
      if (!dir) return null;
      const dirs = g.type === 'GRID' ? [0, Math.PI / 2] : [Math.PI / 6, Math.PI / 2, (5 * Math.PI) / 6];
      const a0 = Math.atan2(-dir.y, dir.x);
      let best = dirs[0],
        bd = Infinity;
      for (const d of dirs)
        for (const k of [0, Math.PI]) {
          const diff = Math.abs(Math.atan2(Math.sin(a0 - d - k), Math.cos(a0 - d - k)));
          if (diff < bd) [bd, best] = [diff, d];
        }
      if (g.use_snapping) s = { x: snap(s.x - center.x) + center.x, y: snap(s.y - center.y) + center.y };
      return along(s, best + g.angle);
    }
  }
  return null;
}

/** Screen position of the guide's reference point. */
export function guideCenter(v: View3D, g: GuideSettings): P2 {
  const doc = app.doc;
  let w: Vector3;
  if (g.reference_point === 'OBJECT' && g.reference_object && app.graph.get(g.reference_object)) w = new Vector3().setFromMatrixPosition(app.graph.get(g.reference_object)!.world);
  else if (g.reference_point === 'CUSTOM') w = new Vector3(...g.location);
  else w = new Vector3(...doc.scene.cursor.location);
  const p = v.project(w);
  return { x: p.x, y: p.y };
}

// ---------------------------------------------------------------------------
// header popover

export function guideButton(): Child {
  const g = guideSettings();
  return h(
    'button',
    {
      key: 'gp-guides',
      class: { 'hdr-toggle': true, on: g.use_guide },
      'data-tip': 'Guides\nConstrain new strokes to lines, circles or a grid',
      onclick: (e: MouseEvent) => openPopover(e.currentTarget as HTMLElement, guidePanel, { width: 240 }),
    },
    icon('gp_guides'),
  );
}

function guidePanel(): Child {
  const g = guideSettings();
  const set = () => app.changed('ui');
  const deg = (r: number) => (r * 180) / Math.PI;
  return h(
    'div',
    { class: 'popover-body' },
    checkbox('gpg-use', 'Guides', g.use_guide, (v) => ((g.use_guide = v), set()), { tip: 'Constrain new strokes to the guide' }),
    enumMenu(
      'gpg-type',
      [
        { value: 'CIRCULAR', label: 'Circular', description: 'Circles around the reference point' },
        { value: 'RADIAL', label: 'Radial', description: 'Lines through the reference point' },
        { value: 'PARALLEL', label: 'Parallel', description: 'Lines in one direction' },
        { value: 'GRID', label: 'Grid', description: 'Horizontal and vertical lines' },
        { value: 'ISO', label: 'Isometric', description: 'Lines at 30°, 90° and 150°' },
      ],
      g.type,
      (v) => ((g.type = v as GuideSettings['type']), set()),
    ),
    g.type === 'PARALLEL' || g.type === 'GRID' || g.type === 'ISO' || g.type === 'RADIAL'
      ? numberField({ id: 'gpg-angle', label: 'Angle', value: deg(g.angle), min: -360, max: 360, tip: 'Direction of the lines (degrees)', set: (x) => ((g.angle = (x * Math.PI) / 180), set()) })
      : null,
    checkbox('gpg-snap', 'Use Snapping', g.use_snapping, (v) => ((g.use_snapping = v), set()), { tip: 'Snap the strokes to the spacing (or angle for Radial)' }),
    g.type === 'RADIAL'
      ? numberField({ id: 'gpg-asnap', label: 'Angle Snap', value: deg(g.angle_snap), min: 1, max: 180, tip: 'Angle steps of Radial snapping (degrees)', set: (x) => ((g.angle_snap = (x * Math.PI) / 180), set()) })
      : numberField({ id: 'gpg-space', label: 'Spacing', value: g.spacing, min: 1, max: 1000, int: true, tip: 'Snapping distance in pixels', set: (x) => ((g.spacing = Math.round(x)), set()) }),
    enumMenu(
      'gpg-ref',
      [
        { value: 'CURSOR', label: '3D Cursor', description: 'Use the 3D cursor as reference' },
        { value: 'CUSTOM', label: 'Custom', description: 'Use a custom location' },
        { value: 'OBJECT', label: 'Object', description: 'Use an object as reference' },
      ],
      g.reference_point,
      (v) => ((g.reference_point = v as GuideSettings['reference_point']), set()),
      { tip: 'Reference point of the guides' },
    ),
    g.reference_point === 'CUSTOM'
      ? h(
          'div',
          { class: 'vec-prop' },
          [0, 1, 2].map((i) => numberField({ id: `gpg-loc${i}`, label: 'XYZ'[i], value: g.location[i], unit: 'distance', set: (x) => ((g.location[i] = x), set()) })),
        )
      : null,
    g.reference_point === 'OBJECT'
      ? enumMenu(
          'gpg-ob',
          [{ value: '', label: '—' }, ...Object.values(app.doc.objects).map((o) => ({ value: o.id, label: o.name, icon: 'object_data' }))],
          g.reference_object ?? '',
          (v) => ((g.reference_object = v || null), set()),
        )
      : null,
  );
}
