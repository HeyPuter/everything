// Building blocks for modifier panels: vertex group pickers with an invert toggle, sub-panels,
// enum flag rows, curve mapping and texture settings, and bind buttons.
import { h, type Child } from '../../../ui/h';
import { icon, registerIcons } from '../../../ui/icons';
import { app } from '../../../app/app';
import { panel, enumMenu, button, checkbox, numberField } from '../../../ui/widgets';
import { splitRow, num, enumProp } from '../../../ui/props';
import type { ModifierBase, NodeData, NodeTreeData, ObjectData } from '../../../data/types';
import { drawCurves } from '../../../nodes/editor/rampui';
import { defaultMapCurve } from '../../../eval/mods/common';

registerIcons({
  arrow_leftright: '<path class="s" d="M2 8h12M5 5 2 8l3 3M11 5l3 3-3 3" fill="none" stroke-width="1.3" stroke-linejoin="round"/>',
});

type Rec = Record<string, unknown>;

export function touch(label: string, final = true) {
  app.changed('doc');
  if (final) app.pushUndo(label);
}

/** Small toggle button bound to a boolean property. */
export function toggleIcon(m: Rec, key: string, ic: string, tip: string): Child {
  return h('button', { class: { tbtn: true, 'mod-inv': true, on: !!m[key] }, 'data-tip': tip, onclick: () => ((m[key] = !m[key]), touch(`Change ${tip}`)) }, icon(ic));
}

export function vgroupNames(ob: ObjectData): string[] {
  const me = ob.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
  return (me?.vertex_groups ?? []).map((g) => g.name);
}

/** Vertex group picker with an optional invert toggle. */
export function vgroupRow(ob: ObjectData, m: ModifierBase, key: string, label: string, invertKey?: string | null): Child {
  const r = m as Rec;
  const names = vgroupNames(ob);
  const cur = String(r[key] ?? '');
  const missing = cur && !names.includes(cur);
  return splitRow(
    label,
    h(
      'div',
      { class: 'row-aligned' },
      enumMenu(
        `${m.id}.${key}`,
        [{ value: '', label: '—' }, ...names.map((n) => ({ value: n, label: n, icon: 'group_vertex' })), ...(missing ? [{ value: cur, label: `${cur} (missing)`, icon: 'error' }] : [])],
        cur,
        (v) => ((r[key] = v), touch(`Set ${label}`)),
      ),
      invertKey ? toggleIcon(r, invertKey, 'arrow_leftright', 'Invert') : null,
    ),
  );
}

/** Collapsible sub-panel inside a modifier panel. */
export function sub(m: ModifierBase, id: string, title: string, body: () => Child, opts: { closed?: boolean; header?: Child } = {}): Child {
  return panel(`mod-${m.id}-${id}`, title, body, { sub: true, closed: opts.closed ?? true, header: opts.header });
}

/** Header checkbox for a sub-panel (e.g. "Normals" with its own enable flag). */
export function headerCheck(m: ModifierBase, key: string, label: string): Child {
  const r = m as Rec;
  return checkbox(`${m.id}.${key}.hdr`, '', !!r[key], (v) => ((r[key] = v), touch(`Toggle ${label}`)));
}

/** Row of toggle buttons for a set-valued enum (stored as a string array). */
export function flagRow(m: Rec, key: string, label: string, items: [string, string][]): Child {
  const cur = new Set((m[key] as string[] | undefined) ?? []);
  return splitRow(
    label,
    h(
      'div',
      { class: 'row-aligned' },
      items.map(([v, l]) =>
        h(
          'button',
          {
            key: v,
            class: { tbtn: true, on: cur.has(v) },
            onclick: (e: MouseEvent) => {
              const next = new Set(cur);
              if (e.shiftKey) {
                if (next.has(v)) next.delete(v);
                else next.add(v);
              } else if (next.has(v) && next.size === 1) next.delete(v);
              else {
                next.clear();
                next.add(v);
              }
              m[key] = items.map((i) => i[0]).filter((x) => next.has(x));
              touch(`Change ${label}`);
            },
          },
          l,
        ),
      ),
    ),
  );
}

/** Toggle-flags row where every item toggles independently (no shift needed). */
export function flagToggles(m: Rec, key: string, label: string, items: [string, string][]): Child {
  const cur = new Set((m[key] as string[] | undefined) ?? []);
  return splitRow(
    label,
    h(
      'div',
      { class: 'mod-flags' },
      items.map(([v, l]) =>
        h(
          'button',
          {
            key: v,
            class: { tbtn: true, on: cur.has(v) },
            onclick: () => {
              const next = new Set(cur);
              if (next.has(v)) next.delete(v);
              else next.add(v);
              m[key] = items.map((i) => i[0]).filter((x) => next.has(x));
              touch(`Change ${label}`);
            },
          },
          l,
        ),
      ),
    ),
  );
}

/** Editable 0..1 mapping curve stored on the modifier (`key` holds the curve settings). */
export function curveWidget(m: ModifierBase, key: string): Child {
  const r = m as Rec;
  if (!r[key] || typeof r[key] !== 'object') r[key] = defaultMapCurve();
  const node = { id: `${m.id}-${key}`, type: 'ShaderNodeFloatCurve', name: key, props: r[key] } as unknown as NodeData;
  return h(
    'div',
    { class: 'mod-curve' },
    drawCurves({
      node,
      tree: {} as NodeTreeData,
      where: 'properties',
      key: `${m.id}.${key}`,
      changed: (label, final = true) => {
        r[key] = { ...(r[key] as Rec) };
        touch(label, final);
      },
    }),
  );
}

export const TEXTURE_TYPES: [string, string][] = [
  ['', 'None'],
  ['CLOUDS', 'Clouds'],
  ['VORONOI', 'Voronoi'],
  ['WOOD', 'Wood'],
  ['MARBLE', 'Marble'],
  ['STUCCI', 'Stucci'],
  ['MAGIC', 'Magic'],
  ['BLEND', 'Blend'],
  ['NOISE', 'Noise'],
];

/** Procedural texture settings stored inline on the modifier (`key` holds the texture or null). */
export function textureRows(m: ModifierBase, key: string, label = 'Texture'): Child[] {
  const r = m as Rec;
  const tex = r[key] as Rec | null | undefined;
  const rows: Child[] = [
    splitRow(
      label,
      enumMenu(
        `${m.id}.${key}.type`,
        TEXTURE_TYPES.map(([value, l]) => ({ value, label: l, icon: value ? 'texture' : undefined })),
        String(tex?.type ?? ''),
        (v) => {
          r[key] = v ? { noise_scale: 0.25, noise_depth: 2, contrast: 1, brightness: 1, turbulence: 5, ...(tex ?? {}), type: v } : null;
          touch(`Set ${label}`);
        },
      ),
    ),
  ];
  if (tex?.type) {
    rows.push(num(tex, 'noise_scale', 'Size', { min: 0.0001, unit: 'distance' }));
    if (['CLOUDS', 'MARBLE', 'STUCCI'].includes(tex.type as string)) rows.push(num(tex, 'noise_depth', 'Depth', { int: true, min: 0, max: 24 }));
    if (['WOOD', 'MARBLE'].includes(tex.type as string)) rows.push(num(tex, 'turbulence', 'Turbulence', { min: 0 }));
  }
  return rows;
}

/** Texture coordinate options for a modifier texture. */
export function textureCoordRows(m: ModifierBase, mapKey: string, objectKey: string, filterOb: ObjectData): Child[] {
  const r = m as Rec;
  return [
    enumProp(r, mapKey, 'Coordinates', [
      ['LOCAL', 'Local'],
      ['GLOBAL', 'Global'],
      ['OBJECT', 'Object'],
    ]),
    r[mapKey] === 'OBJECT' ? objRow(r, objectKey, 'Object', (o) => o.id !== filterOb.id) : null,
  ];
}

/** Object picker (same look as other modifier object fields). */
export function objRow(m: Rec, key: string, label: string, filter?: (o: ObjectData) => boolean, onChange?: () => void): Child {
  const cands = Object.values(app.doc.objects)
    .filter((o) => !filter || filter(o))
    .sort((a, b) => a.name.localeCompare(b.name));
  const menu = enumMenu(`${(m as { id?: string }).id ?? ''}.${key}`, [{ value: '', label: '—' }, ...cands.map((c) => ({ value: c.id, label: c.name, icon: 'object' }))], String(m[key] ?? ''), (v) => {
    m[key] = v || null;
    onChange?.();
    touch(`Set ${label || 'Object'}`);
  });
  return label ? splitRow(label, menu) : menu;
}

/** Full-width operator button for bind-style actions. */
export function wideButton(id: string, label: string, onClick: () => void, opts: { disabled?: boolean; tip?: string } = {}): Child {
  return h('div', { class: 'btn-row mod-wide' }, button(id, label, onClick, { disabled: opts.disabled, tip: opts.tip }));
}

/** Bare number field bound to a modifier property (for use inside composite rows). */
export function numField(m: ModifierBase, key: string, opts: { unit?: 'distance' | 'angle' | 'none'; min?: number; max?: number; int?: boolean; disabled?: boolean; label?: string } = {}): Child {
  const r = m as Rec;
  return numberField({ id: `${m.id}.${key}`, value: Number(r[key] ?? 0), unit: opts.unit, min: opts.min, max: opts.max, int: opts.int, disabled: opts.disabled, label: opts.label, set: (v, final) => ((r[key] = v), touch(`Change ${key}`, final)) });
}

/** Row of toggle buttons, each bound to its own boolean property. */
export function boolToggles(m: ModifierBase, label: string, items: [string, string][]): Child {
  const r = m as Rec;
  return splitRow(
    label,
    h(
      'div',
      { class: 'mod-flags' },
      items.map(([k, l]) => h('button', { key: k, class: { tbtn: true, on: r[k] !== false && !!r[k] }, onclick: () => ((r[k] = !r[k]), touch(`Change ${l}`)) }, l)),
    ),
  );
}
