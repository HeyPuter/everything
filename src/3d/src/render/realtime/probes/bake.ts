// Light probe baking (Bake / Delete Light Cache), the probe's Object Data properties and the
// Scene ▸ Light Probes panel. Probes enter render scenes through a render-scene hook.
import { app, onAppReady, registerOperators } from '../../../app/app';
import type { DocumentData, ObjectData, RenderSettings } from '../../../data/types';
import { RenderScene, renderSceneHooks, renderVisibleObjects } from '../../final/renderscene';
import { renderContext } from '../../context';
import { dataTabDrawers } from '../../../editors/properties/tabs';
import { propertiesTabs } from '../../../editors/properties/properties';
import { h, type Child } from '../../../ui/h';
import { panel, enumRow, enumMenu } from '../../../ui/widgets';
import { num, bool, enumProp, splitRow } from '../../../ui/props';
import { icon } from '../../../ui/icons';
import { headerToggle, sub } from '../../final/props/common';
import type { LightProbeSettings } from '../types';
import { probeOf, PROBE_TYPES, defaultLightProbe } from './lightprobe';
import { bakeVolume, captureKey, captureSphere, freeProbeCache, hasProbeCache, setProbeCache, type ProbeEntry } from './capture';

/** Objects a probe does not see (its Visibility collection, or everything else when inverted). */
export function probeHiddenObjects(doc: DocumentData, p: LightProbeSettings): Set<string> {
  const out = new Set<string>();
  const cid = p.visibility_collection;
  if (!cid || !doc.collections[cid]) return out;
  const inside = new Set<string>();
  const walk = (id: string) => {
    const c = doc.collections[id];
    if (!c) return;
    c.objects.forEach((o) => inside.add(o));
    c.children.forEach(walk);
  };
  walk(cid);
  for (const id of Object.keys(doc.objects)) if (inside.has(id) === !!p.invert_visibility_collection) out.add(id);
  return out;
}

renderSceneHooks.push((rs, a, o) => {
  const entries: ProbeEntry[] = [];
  if (o.mode === 'raster') {
    const doc = a.doc;
    const renderable = o.final ? renderVisibleObjects(doc) : null;
    for (const ev of a.graph.objects.values()) {
      const p = probeOf(ev.ob);
      if (!p) continue;
      const visible = renderable ? renderable.has(ev.id) : ev.visible && !ev.ob.hide_render && (!o.localView || o.localView.has(ev.id));
      if (visible) entries.push({ id: ev.id, probe: p, world: ev.world.clone(), hidden: probeHiddenObjects(doc, p) });
    }
  }
  rs.scene.userData.probes = entries;
  // grids of probes that left the scene (or lost their bake) are detached
  const keep = new Set(entries.filter((e) => e.probe.type === 'VOLUME' && e.probe.baked).map((e) => e.id));
  for (const c of [...rs.scene.children]) if ((c as { isLightProbeGrid?: boolean }).isLightProbeGrid && !keep.has(c.userData.probeId as string)) rs.scene.remove(c);
});

type Subset = 'ALL' | 'SELECTED' | 'ACTIVE';

function probesIn(subset: Subset): ObjectData[] {
  const all = Object.values(app.doc.objects).filter((o) => o.type === 'LIGHT_PROBE' && o.lightprobe);
  if (subset === 'ACTIVE') return all.filter((o) => o.id === app.doc.scene.active_object);
  if (subset === 'SELECTED') return all.filter((o) => o.select);
  return all;
}

const cubeResolution = (r: RenderSettings) => Number(r.gi_cubemap_resolution ?? 512) || 512;

/** Capture spheres and bake volumes of `obs` right away (GPU), marking them as baked. */
export function bakeProbes(obs: ObjectData[]): number {
  const ctx = renderContext;
  if (!ctx || !obs.length) return 0;
  const renderer = ctx.engine.renderer;
  const doc = app.doc;
  if (app.hasPending) app.flush();
  const rs = new RenderScene('raster');
  const time = Date.now();
  // the bake time is part of the capture key: probes are captured again
  for (const ob of obs) ob.lightprobe!.baked = { time, key: '' };
  rs.build(app, { mode: 'raster', final: true, useSceneLights: true, useSceneWorld: true });
  rs.configureShadows(renderer, doc);
  let n = 0;
  try {
    for (const e of (rs.scene.userData.probes as ProbeEntry[]) ?? []) {
      if (!obs.some((o) => o.id === e.id)) continue;
      freeProbeCache(e.id);
      if (e.probe.type === 'VOLUME') {
        const grid = bakeVolume(renderer, rs.scene, e);
        grid.userData.probeId = e.id;
        setProbeCache(e.id, { grid });
        n++;
      } else if (e.probe.type === 'SPHERE') {
        const res = cubeResolution(doc.scene.render);
        const env = captureSphere(renderer, rs.scene, e, res);
        if (env) setProbeCache(e.id, { sphere: { key: captureKey(e, res), env } });
        n++;
      } else n++;
      e.probe.baked = { time, key: captureKey(e, 0) };
    }
  } finally {
    // the grids stay cached; the next render scene attaches them
    for (const c of [...rs.scene.children]) if ((c as { isLightProbeGrid?: boolean }).isLightProbeGrid) rs.scene.remove(c);
    rs.dispose();
  }
  ctx.engine.requestDraw();
  return n;
}

const subsetProp = (def: Subset, labels: [string, string, string]) => ({
  id: 'subset',
  label: 'Subset',
  type: 'enum' as const,
  default: def,
  items: [
    ['ALL', labels[0]],
    ['SELECTED', labels[1]],
    ['ACTIVE', labels[2]],
  ] as [string, string][],
});

registerOperators([
  {
    idname: 'object.lightprobe_cache_bake',
    label: 'Bake Light Cache',
    description: 'Capture the light probes from the scene: reflection cubemaps of sphere probes and indirect lighting of volume probes',
    props: [subsetProp('ALL', ['All Light Probes', 'Selected Only', 'Active Only'])],
    poll: () => Object.values(app.doc.objects).some((o) => o.type === 'LIGHT_PROBE'),
    exec: (_ctx, p) => {
      const obs = probesIn((p.subset as Subset) ?? 'ALL');
      if (!obs.length) {
        app.report('WARNING', 'No light probes to bake');
        return 'CANCELLED';
      }
      const n = bakeProbes(obs);
      app.report('INFO', `Baked ${n} light probe${n === 1 ? '' : 's'}`);
      app.changed('doc');
    },
  },
  {
    idname: 'object.lightprobe_cache_free',
    label: 'Delete Light Cache',
    description: 'Delete the captured lighting of light probes',
    props: [subsetProp('SELECTED', ['All Light Probes', 'Selected Only', 'Active Only'])],
    poll: () => Object.values(app.doc.objects).some((o) => o.type === 'LIGHT_PROBE' && (o.lightprobe?.baked || hasProbeCache(o.id))),
    exec: (_ctx, p) => {
      const obs = probesIn((p.subset as Subset) ?? 'SELECTED');
      for (const ob of obs) {
        ob.lightprobe!.baked = null;
        freeProbeCache(ob.id);
      }
      renderContext?.engine.requestDraw();
      app.changed('doc');
    },
  },
]);

// ---------------------------------------------------------------------------
// Object Data properties of a light probe

function typeRow(o: ObjectData, p: LightProbeSettings): Child {
  return h(
    'div',
    { class: 'enum-tabs' },
    enumRow(
      'lp-type',
      PROBE_TYPES.map(([value, label, ic]) => ({ value, label, icon: ic })),
      p.type,
      (v) => {
        if (v === p.type) return;
        freeProbeCache(o.id);
        o.lightprobe = { ...defaultLightProbe(v as LightProbeSettings['type']), visibility_collection: p.visibility_collection, invert_visibility_collection: p.invert_visibility_collection };
        app.pushUndo('Light Probe Type');
        app.changed('doc');
      },
    ),
  );
}

function bakeButtons(o: ObjectData, p: LightProbeSettings): Child {
  const baked = !!p.baked;
  return [
    h(
      'div',
      { class: 'rt-probe-bake' },
      h('button', { class: 'btn', onclick: () => app.run('object.lightprobe_cache_bake', { subset: 'ACTIVE' }) }, icon('render'), 'Bake Light Cache'),
      h('button', { class: 'btn', disabled: !baked, onclick: () => app.run('object.lightprobe_cache_free', { subset: 'ACTIVE' }) }, icon('x'), 'Delete'),
    ),
    h('div', { class: 'prop-note' }, baked ? `Baked ${new Date(p.baked!.time).toLocaleTimeString()}` : p.type === 'VOLUME' ? 'Not baked: the volume has no effect until it is baked.' : 'Captured automatically; bake again after changing the scene.'),
    void o,
  ];
}

function collectionRow(p: LightProbeSettings): Child {
  const cols = Object.values(app.doc.collections).filter((c) => c.id !== app.doc.scene.collection);
  return splitRow(
    'Collection',
    enumMenu(
      'lp-vis-col',
      [{ value: '', label: '—' }, ...cols.map((c) => ({ value: c.id, label: c.name, icon: 'collection' }))],
      p.visibility_collection ?? '',
      (v) => {
        p.visibility_collection = v || null;
        app.pushUndo('Probe Visibility Collection');
        app.changed('doc');
      },
      { tip: 'Only objects of this collection are seen by the probe' },
    ),
  );
}

function probePanels(o: ObjectData, p: LightProbeSettings): Child {
  return [
    panel('lp-probe', 'Probe', () => [
      typeRow(o, p),
      p.type === 'SPHERE'
        ? [
            enumProp(p, 'influence_type', 'Shape', [['ELIPSOID', 'Sphere'], ['BOX', 'Box']], { tip: 'Shape of the region using this probe' }),
            num(p, 'influence_distance', p.influence_type === 'BOX' ? 'Size' : 'Radius', { unit: 'distance', min: 0, tip: 'Size of the region using this probe (scaled by the object)' }),
            num(p, 'falloff', 'Falloff', { min: 0, max: 1, slider: true, tip: 'Part of the region over which the probe blends out' }),
          ]
        : p.type === 'PLANE'
          ? [
              num(p, 'influence_distance', 'Distance', { unit: 'distance', min: 0, tip: 'How far above and below the plane surfaces use the reflection' }),
              num(p, 'falloff', 'Falloff', { min: 0, max: 1, slider: true, tip: 'Fade of the reflection towards that distance' }),
            ]
          : [num(p, 'intensity', 'Intensity', { min: 0, softMax: 3, tip: 'Strength of the baked indirect light' })],
      sub(
        'lp-visibility',
        'Visibility',
        () => [collectionRow(p), bool(p, 'invert_visibility_collection', 'Invert Collection', { disabled: !p.visibility_collection, tip: 'The collection’s objects are hidden from the probe instead' })],
        { closed: true },
      ),
    ]),
    panel(
      'lp-capture',
      'Capture',
      () => [
        num(p, 'clip_start', 'Clipping Start', { unit: 'distance', min: 0.000001, tip: 'Objects closer than this to the probe are not captured' }),
        p.type === 'VOLUME'
          ? [
              num(p, 'capture_distance', 'Distance', { unit: 'distance', min: 0.000001, tip: 'How far each sample point sees' }),
              bool(p, 'capture_world', 'World', { tip: 'Bake the world’s light into the volume (it then replaces the world’s diffuse light inside)' }),
              bool(p, 'capture_indirect', 'Indirect Light', { tip: 'Also bake light bounced once between surfaces' }),
            ]
          : p.type === 'SPHERE'
            ? num(p, 'clip_end', 'End', { unit: 'distance', min: 0.000001, tip: 'Objects farther than this are not captured' })
            : null,
      ],
      {},
    ),
    p.type === 'SPHERE'
      ? panel(
          'lp-parallax',
          'Custom Parallax',
          () => [
            enumProp(p, 'parallax_type', 'Shape', [['ELIPSOID', 'Sphere'], ['BOX', 'Box']], { tip: 'Shape the reflections are projected onto' }),
            num(p, 'parallax_distance', 'Radius', { unit: 'distance', min: 0, tip: 'Size of the projection shape' }),
          ],
          { closed: true, header: headerToggle(p, 'use_custom_parallax', 'Custom Parallax') },
        )
      : null,
    p.type === 'VOLUME'
      ? panel('lp-bake', 'Bake', () => [
          sub('lp-bake-res', 'Resolution', () => [
            num(p, 'resolution_x', 'Resolution X', { int: true, min: 1, max: 64, tip: 'Sample points along X' }),
            num(p, 'resolution_y', 'Y', { int: true, min: 1, max: 64 }),
            num(p, 'resolution_z', 'Z', { int: true, min: 1, max: 64 }),
          ]),
          bakeButtons(o, p),
        ])
      : panel('lp-bake', 'Bake', () => bakeButtons(o, p), { closed: true }),
    panel(
      'lp-display',
      'Viewport Display',
      () => [
        bool(p, 'show_influence', 'Influence', { tip: 'Show the region influenced by the probe' }),
        p.type === 'SPHERE' ? bool(p, 'show_clip', 'Clipping', { tip: 'Show the clipping distances' }) : null,
        p.type === 'SPHERE' ? bool(p, 'show_parallax', 'Parallax', { disabled: !p.use_custom_parallax, tip: 'Show the custom parallax shape' }) : null,
      ],
      { closed: true },
    ),
  ];
}

dataTabDrawers.LIGHT_PROBE = (o: ObjectData): Child => {
  const p = probeOf(o);
  return p ? probePanels(o, p) : h('div', { class: 'prop-note' }, 'No light probe data');
};

// ---------------------------------------------------------------------------
// Scene ▸ Light Probes

function sceneProbesPanel(): Child {
  const r = app.doc.scene.render;
  const n = Object.values(app.doc.objects).filter((o) => o.type === 'LIGHT_PROBE').length;
  return panel(
    'sc-lightprobes',
    'Light Probes',
    () => [
      enumProp(r, 'gi_cubemap_resolution', 'Sphere Resolution', [['128', '128 px'], ['256', '256 px'], ['512', '512 px'], ['1024', '1024 px']], { tip: 'Resolution of the cubemaps captured by sphere probes' }),
      h(
        'div',
        { class: 'rt-probe-bake' },
        h('button', { class: 'btn', disabled: !n, onclick: () => app.run('object.lightprobe_cache_bake', { subset: 'ALL' }) }, icon('render'), 'Bake All Light Probes'),
        h('button', { class: 'btn', disabled: !n, onclick: () => app.run('object.lightprobe_cache_free', { subset: 'ALL' }) }, icon('x'), 'Delete All'),
      ),
      h('div', { class: 'prop-note' }, n ? `${n} light probe${n === 1 ? '' : 's'} in the scene` : 'Add probes from Add ▸ Light Probe'),
    ],
    { closed: true },
  );
}

onAppReady(() => {
  const tab = propertiesTabs.find((t) => t.id === 'SCENE');
  if (!tab) return;
  const draw = tab.draw;
  tab.draw = (p) => {
    const r = app.doc.scene.render;
    r.gi_cubemap_resolution ??= '512';
    return [draw(p), r.engine === 'RASTER' ? sceneProbesPanel() : null];
  };
});
