// Properties ▸ Render ▸ Bake (path tracer): bake type and its options, influence (lighting and
// contributions), selected to active, output target and margin, and a summary of where the bake
// will go so problems show before baking.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, button, enumMenu } from '../ui/widgets';
import { num, bool, boolHeading, enumProp, objectProp, splitRow } from '../ui/props';
import { icon } from '../ui/icons';
import { pathTraceExtraPanels } from '../render/final/props/render';
import { changed, headerToggle, sub } from '../render/final/props/common';
import type { RenderSettings } from '../data/types';
import { bakeSettings, bakeType, setBakeType, BAKE_TYPES, SWIZZLE, LIT_TYPES, contributionProblem, contributions, type BakeType } from './settings';
import { planTargets } from './targets';
import { bakeState, cancelBake } from './job';
import { bakeButtonProps } from './ops';

function bakeButton(multires: boolean): Child {
  const running = bakeState();
  if (running)
    return h(
      'div',
      { class: 'bake-run' },
      h('div', { class: 'bake-progress', 'data-tip': running.label }, h('span', { class: 'bake-progress-fill', style: { width: `${(running.progress * 100).toFixed(1)}%` } }), h('span', { class: 'bake-progress-label' }, `Baking… ${Math.round(running.progress * 100)}%`)),
      button('bake-cancel', [icon('x'), 'Cancel'], () => cancelBake(), { tip: 'Stop the bake (Esc); the images are left unchanged' }),
    );
  const id = multires ? 'object.bake_image' : 'object.bake';
  const enabled = app.poll(id);
  return h(
    'button',
    {
      key: 'bake-btn',
      class: 'btn op bake-button',
      disabled: !enabled,
      'data-tip': multires ? 'Bake the multiresolution detail into the image textures of the selected objects' : 'Bake the chosen pass of the selected objects',
      onclick: (e: MouseEvent) => app.run(id, multires ? {} : bakeButtonProps(), { event: { x: e.clientX, y: e.clientY } }),
    },
    icon('render'),
    'Bake',
  );
}

/** Where the bake goes, or what prevents it (shown under the button). */
function summary(r: RenderSettings): Child {
  const b = bakeSettings(r);
  const doc = app.doc;
  const sel = app.selectedObjects().filter((o) => o.type === 'MESH');
  const act = app.activeObject;
  const lines: Child[] = [];
  const problem = b.use_multires ? null : contributionProblem(bakeType(r), contributions(null, b));
  if (problem) lines.push(h('div', { class: 'prop-note warn' }, problem));
  let receivers = sel;
  if (b.use_selected_to_active && !b.use_multires) {
    if (!act || act.type !== 'MESH') return [...lines, h('div', { class: 'prop-note warn' }, 'Selected to Active: make the low-resolution mesh the active object')];
    if (sel.filter((o) => o.id !== act.id).length === 0) return [...lines, h('div', { class: 'prop-note warn' }, 'Selected to Active: also select the objects to bake from')];
    receivers = [act];
  }
  if (!receivers.length) return [...lines, h('div', { class: 'prop-note' }, 'Select the mesh objects to bake.')];
  const plan = planTargets(doc, receivers, b.use_multires ? 'IMAGE_TEXTURES' : b.target);
  for (const e of plan.errors.slice(0, 3)) lines.push(h('div', { class: 'prop-note warn' }, e));
  if (!plan.errors.length && plan.targets.length) {
    const names = [...new Set(plan.targets.map((t) => (t.kind === 'IMAGE' ? `“${doc.images[t.image!]?.name}”` : `${t.object.name} colors`)))];
    lines.push(h('div', { class: 'prop-note bake-into' }, `Bakes into ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`));
  }
  return lines;
}

function bakePanel(r: RenderSettings): Child {
  const b = bakeSettings(r);
  const type = bakeType(r);
  return panel(
    'rs-bake',
    'Bake',
    () => [
      h('div', { class: 'btn-col bake-btn-row' }, bakeButton(b.use_multires)),
      summary(r),
      bool(b, 'use_multires', 'Bake from Multires', { tip: 'Bake the detail of the Multiresolution modifier (its highest level) onto the mesh at its preview level' }),
      b.use_multires
        ? [
            enumProp(b, 'type', 'Bake Type', [
              ['NORMALS', 'Normals'],
              ['DISPLACEMENT', 'Displacement'],
            ]),
            b.type === 'DISPLACEMENT' ? bool(b, 'use_lores_mesh', 'Low Resolution Mesh', { tip: 'Measure displacement from the base mesh instead of the subdivided preview level' }) : null,
          ]
        : [
            splitRow(
              'Bake Type',
              enumMenu(
                'rs-bake-type',
                BAKE_TYPES.map(([value, label, description]) => ({ value, label, description })),
                type,
                (v) => {
                  setBakeType(r, v as BakeType);
                  changed('Bake Type');
                },
                { tip: 'Type of pass to bake' },
              ),
            ),
            type === 'NORMAL'
              ? [
                  enumProp(b, 'normal_space', 'Space', [
                    ['TANGENT', 'Tangent'],
                    ['OBJECT', 'Object'],
                  ], { tip: 'Tangent space follows the surface (for deforming or tiling meshes); object space is fixed to the object' }),
                  (['normal_r', 'normal_g', 'normal_b'] as const).map((k, i) =>
                    splitRow(
                      i === 0 ? 'Swizzle R' : 'RGB'[i],
                      enumMenu(`rs-bake-${k}`, SWIZZLE.map(([value, label]) => ({ value, label })), b[k], (v) => {
                        b[k] = v as typeof b.normal_r;
                        changed('Normal Swizzle');
                      }, { tip: `Axis stored in the ${'RGB'[i]} channel (−Y in G gives the other common normal map convention)` }),
                    ),
                  ),
                ]
              : null,
            type === 'AO' ? num(r as RenderSettings & { ambient_occlusion_distance: number }, 'ambient_occlusion_distance', 'Distance', { unit: 'distance', min: 0, softMax: 100, tip: 'Surfaces farther than this do not occlude' }) : null,
            LIT_TYPES.has(type) ? influencePanel(r, type) : null,
            sub('rs-bake-s2a', 'Selected to Active', () => selectedToActive(r), { closed: true, header: headerToggle(b, 'use_selected_to_active', 'Selected to Active') }),
          ],
      sub('rs-bake-output', 'Output', () => output(r), {}),
    ],
    { closed: true },
  );
}

function influencePanel(r: RenderSettings, type: BakeType): Child {
  const b = bakeSettings(r);
  return sub('rs-bake-influence', 'Influence', () =>
    type === 'COMBINED'
      ? [
          boolHeading(b, 'use_pass_direct', 'Lighting', 'Direct', { tip: 'Light reaching the surface straight from lamps, emitters and the world' }),
          bool(b, 'use_pass_indirect', 'Indirect', { tip: 'Light reaching the surface after bouncing off other surfaces' }),
          boolHeading(b, 'use_pass_diffuse', 'Contributions', 'Diffuse'),
          bool(b, 'use_pass_glossy', 'Glossy'),
          bool(b, 'use_pass_transmission', 'Transmission'),
          bool(b, 'use_pass_emit', 'Emission'),
        ]
      : [
          boolHeading(b, 'use_pass_direct', 'Contributions', 'Direct'),
          bool(b, 'use_pass_indirect', 'Indirect'),
          bool(b, 'use_pass_color', 'Color', { tip: 'Multiply by the surface color (off: lighting only)' }),
        ],
  );
}

function selectedToActive(r: RenderSettings): Child {
  const b = bakeSettings(r);
  const on = b.use_selected_to_active;
  return [
    bool(b, 'use_cage', 'Cage', { disabled: !on, tip: 'Cast the rays from a cage mesh (same faces as the active object) instead of the extruded surface' }),
    b.use_cage ? objectProp(b, 'cage_object', 'Cage Object', { disabled: !on, filter: (o) => o.type === 'MESH', none: 'Extruded surface' }) : null,
    num(b, 'cage_extrusion', 'Extrusion', { unit: 'distance', min: 0, softMax: 1, disabled: !on || (b.use_cage && !!b.cage_object), tip: 'Push the ray start points outwards along the normals so rays reach detail above the low-resolution surface' }),
    num(b, 'max_ray_distance', 'Max Ray Distance', { unit: 'distance', min: 0, softMax: 1, disabled: !on, tip: 'How far rays travel to find the selected objects (0: no limit)' }),
  ];
}

function output(r: RenderSettings): Child {
  const b = bakeSettings(r);
  const images = b.use_multires || b.target === 'IMAGE_TEXTURES';
  return [
    b.use_multires
      ? null
      : enumProp(b, 'target', 'Target', [
          ['IMAGE_TEXTURES', 'Image Textures'],
          ['VERTEX_COLORS', 'Active Color Attribute'],
        ], { tip: 'Image Textures: the active Image Texture node of each material. Active Color Attribute: the mesh colors' }),
    images ? bool(b, 'use_clear', 'Clear Image', { tip: 'Clear the images before baking (off: keep pixels outside the baked areas)' }) : null,
    images
      ? sub('rs-bake-margin', 'Margin', () => [
          b.use_multires
            ? null
            : enumProp(b, 'margin_type', 'Type', [
                ['ADJACENT_FACES', 'Adjacent Faces'],
                ['EXTEND', 'Extend'],
              ], { tip: 'Adjacent Faces continues across UV seams with the colors of the neighbouring faces; Extend repeats the border texels' }),
          num(b, 'margin', 'Size', { int: true, unit: 'pixel', min: 0, max: 32767, softMax: 64, tip: 'Pixels filled around the UV islands so texture filtering does not pick up the background' }),
        ])
      : null,
  ];
}

pathTraceExtraPanels.push(bakePanel);
