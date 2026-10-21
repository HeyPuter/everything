// Sculpt / paint mode UI: toolbar tools, tool header settings, sidebar Tool tab panels, header
// menus, keymaps and the viewport input hooks (strokes, cursor, context menu).
import { app, onAppReady, registerOperators } from '../app/app';
import { propertiesTabs } from '../editors/properties/properties';
import { activeTools } from '../app/prefs';
import { addKeys, keyName, keymaps, keyLabel, type KeyItem } from '../app/keymap';
import { h, type Child, type VNode } from '../ui/h';
import { icon } from '../ui/icons';
import { checkbox, colorSwatch, enumMenu, enumRow, numberField, panel, button, opButton, row } from '../ui/widgets';
import { openMenu, openPie, openPopover, type MenuItem } from '../ui/menu';
import { editModeHooks, viewportExtensions } from '../editors/view3d/hooks';
import { extraToolLists, toolSettingsRenderers, setActiveTool, type ToolDef } from '../editors/view3d/toolbar';
import { sidebarTabs } from '../editors/view3d/sidebar';
import { modeMenus } from '../editors/view3d/modemenus';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { activeBrush, brushById, BRUSH_LISTS, brushInfo, isBrushMode, setBrushRadius, setBrushStrength, setUnified, type BrushMode, type PaintBrush, type UnifiedFlags } from './brushes';
import { startGesture } from './gesture';
import { startGradient } from './paintops';
import { faceSetStroke } from './facesetbrush';
import { openBrushPicker } from './assetshelf';
import { automaskButton, automaskSettings, dyntopoSettings } from './sculptmenus';
import { faceMaskOn, isSelectTool, PAINT_SELECT_TOOLS, vertMaskOn } from './selmask';
import { cursorState, updateCursor } from './cursor';
import { sculptStroke } from './sculpt';
import { gestureToolPointer, gestureTools, registerToolSettings, sculptToolHooks, sculptToolSlots } from './sculpttools';
import { operators } from '../app/app';
import { vertexPaintStroke, sampleVertexColor } from './vpaint';
import { weightPaintStroke, sampleWeight, ensureActiveGroup } from './wpaint';
import { texturePaintStroke, sampleImageColor, paintImage, meshHasUVs, cloneSource, imagePaintOptions, imagePaintSettings, ensureStencilImage } from './tpaint';
import { strokeActive } from './stroke';
import { activeMeshData, meshSession } from './session';
import { invalidatePaintAttributes } from './display';
import { brushFalloff, falloffPresetPoints, linearToSrgb, srgbToLinear } from './math';
import { curveWidget } from '../render/final/props/curvewidget';
import { hsvToRgb, rgbToHsv, type ColorJitter } from './paintmath';
import { brushThumb } from './brushthumbs';
import { NORMAL_ANGLE, type NormalFalloff } from './vgather';
import { paintHooks } from './painthooks';
import { paintCurvesOf } from './paintcurve';
import { brushOriginNote, brushSpecialsMenu } from './brushassets';
import { mapModes, maskTextureActive, sampleTex, sampleTexRGBA, setImageCanvasSource, textureActive, TEX_SOURCES, type BrushTexture } from './brushtex';
import { imageCanvas, imageReady } from '../render/images';
import { paletteTemplate, palettesOf, paletteUsers } from './palette';
import { dataBlockSelector } from '../editors/properties/tabs';
import { Vector3 } from 'three';

// ---------------------------------------------------------------------------
// toolbar

const EXTRA_TOOLS: Record<BrushMode, ToolDef[]> = {
  SCULPT: [],
  VERTEX_PAINT: [],
  WEIGHT_PAINT: [
    {
      id: 'builtin.sample_weight',
      label: 'Sample Weight',
      icon: 'eyedropper',
      shortcut: 'Shift X',
      description: 'Use the weight under the cursor as the brush weight',
    },
    {
      id: 'builtin.sample_vertex_group',
      label: 'Sample Vertex Group',
      icon: 'sample_group',
      shortcut: 'Shift Ctrl X',
      description: 'Pick the active vertex group from the vertex under the cursor',
    },
    {
      id: 'builtin.gradient',
      label: 'Gradient',
      icon: 'weight_gradient',
      shortcut: 'Shift A',
      description: 'Drag to fill the active group with a gradient',
    },
  ],
  TEXTURE_PAINT: [],
};

for (const mode of Object.keys(BRUSH_LISTS) as BrushMode[]) {
  extraToolLists[mode] = () => {
    const out: (ToolDef | null)[] = BRUSH_LISTS[mode].map((b) =>
      b
        ? {
            id: b.id,
            label: b.name,
            icon: b.icon,
            shortcut: b.shortcut,
            description: b.description,
          }
        : null,
    );
    if (EXTRA_TOOLS[mode].length) out.push(null, ...EXTRA_TOOLS[mode]);
    if (mode === 'SCULPT') {
      out.push(null, ...sculptToolSlots((op) => operators.has(op)));
      registerToolSettings(toolSettingsRenderers);
    }
    // selection masking: select tools in front of the brushes
    if (mode !== 'SCULPT' && (faceMaskOn() || vertMaskOn())) out.unshift({ ...PAINT_SELECT_TOOLS[1], alternates: PAINT_SELECT_TOOLS }, null);
    return out;
  };
  for (const b of BRUSH_LISTS[mode]) if (b) toolSettingsRenderers[b.id] = () => toolHeaderSettings(mode);
}
toolSettingsRenderers['builtin.sample_weight'] = () => [h('span', { class: 'th-label' }, 'Click on the mesh to sample the weight'), weightField('th-sw')];
toolSettingsRenderers['builtin.sample_vertex_group'] = () => h('span', { class: 'th-label' }, 'Click on the mesh to pick one of its vertex groups');
const gradientTool = { type: 'LINEAR' };
toolSettingsRenderers['builtin.gradient'] = () => {
  const b = activeBrush('WEIGHT_PAINT');
  return [
    field(110, enumMenu('th-grad', [{ value: 'LINEAR', label: 'Linear' }, { value: 'RADIAL', label: 'Radial' }], gradientTool.type, (x) => ((gradientTool.type = x), changed()), { tip: 'Gradient type' })),
    field(140, weightField('th-gw')),
    b ? field(140, strengthField(b, 'th-gs')) : null,
    h('span', { class: 'th-label' }, 'Drag from full weight to zero'),
  ];
};

// ---------------------------------------------------------------------------
// shared brush widgets

const DIRECTIONAL = new Set(['DRAW', 'DRAW_SHARP', 'CLAY', 'CLAY_STRIPS', 'CLAY_THUMB', 'LAYER', 'INFLATE', 'BLOB', 'CREASE', 'FLATTEN', 'FILL', 'SCRAPE', 'MULTIPLANE_SCRAPE', 'PINCH', 'MASK']);
const PLANE_TOOLS = new Set(['CLAY', 'CLAY_STRIPS', 'CLAY_THUMB', 'FLATTEN', 'FILL', 'SCRAPE', 'MULTIPLANE_SCRAPE']);
const FALLOFFS: [string, string][] = [
  ['CUSTOM', 'Custom'],
  ['SMOOTH', 'Smooth'],
  ['SMOOTHER', 'Smoother'],
  ['SPHERE', 'Sphere'],
  ['ROOT', 'Root'],
  ['SHARP', 'Sharp'],
  ['LINEAR', 'Linear'],
  ['POW4', 'Sharper'],
  ['INVERSE_SQUARE', 'Inverse Square'],
  ['CONSTANT', 'Constant'],
];
const BLENDS: [string, string][] = [
  ['MIX', 'Mix'],
  ['ADD', 'Add'],
  ['SUB', 'Subtract'],
  ['MUL', 'Multiply'],
  ['LIGHTEN', 'Lighten'],
  ['DARKEN', 'Darken'],
];
const TEX_BLENDS: [string, string][] = [...BLENDS, ['ERASE_ALPHA', 'Erase Alpha']];
const DIR_LABELS: Record<string, [string, string]> = {
  FLATTEN: ['Flatten', 'Contrast'],
  FILL: ['Fill', 'Deepen'],
  SCRAPE: ['Scrape', 'Peaks'],
  PINCH: ['Pinch', 'Magnify'],
  INFLATE: ['Inflate', 'Deflate'],
};

function changed() {
  app.changed('ui');
  const v = activeView3D();
  if (v) v.drawSvg();
}

/** Texture Paint stencil mask settings (Options ▸ Mask). */
function stencilMaskRows(): Child[] {
  const st = imagePaintSettings();
  const imgs = Object.values(app.doc.images);
  return [
    checkbox('pt-stl', 'Stencil Mask', !!st.use_stencil_layer, (x) => ((st.use_stencil_layer = x), x && ensureStencilImage(), app.pushUndo('Stencil Mask'), changed()), { tip: 'Limit painting with a grayscale image over the UVs (paint it with the Mask brush)' }),
    st.use_stencil_layer
      ? [
          row('Stencil Image', enumMenu('pt-sti', imgs.map((im) => ({ value: im.id, label: im.name, icon: 'image' })), st.stencil_image ?? '', (x) => ((st.stencil_image = x), app.pushUndo('Stencil Image'), changed()), { tip: 'White: paint lands · black: blocked' })),
          checkbox('pt-stinv', 'Invert', !!st.invert_stencil, (x) => ((st.invert_stencil = x), changed()), { tip: 'Paint where the stencil is black instead' }),
        ]
      : null,
  ];
}

/** Randomize Color rows: hue / saturation / value jitter with per-stroke and pressure toggles. */
function colorJitterRows(p: string): Child[] {
  const j = app.doc.scene.tool_settings.unified_paint as typeof app.doc.scene.tool_settings.unified_paint & ColorJitter;
  const toggle = (key: keyof ColorJitter, ic: string, tip: string) =>
    h('button', { key: `${p}-${key}`, class: { 'hdr-toggle': true, 'pressure-toggle': true, on: !!j[key] }, 'data-tip': tip, onclick: () => (((j[key] as boolean) = !j[key]), changed()) }, icon(ic));
  const rowFor = (amount: 'hue_jitter' | 'saturation_jitter' | 'value_jitter', label: string, stroke: keyof ColorJitter, press: keyof ColorJitter) =>
    h(
      'div',
      { key: `${p}-${amount}`, class: 'paint-pressure-row' },
      numberField({ id: `${p}-${amount}`, label, value: j[amount] ?? 0, min: 0, max: 1, slider: true, tip: `How far the ${label.toLowerCase()} may vary`, set: (x) => ((j[amount] = x), changed()) }),
      toggle(stroke, 'paint_stroke_once', 'Pick one random value for the whole stroke'),
      toggle(press, 'pressure', 'Scale the variation by the pen pressure'),
    );
  return [
    checkbox(`${p}-on`, 'Randomize Color', !!j.use_color_jitter, (x) => ((j.use_color_jitter = x), changed()), { tip: 'Vary the color of each dab around the brush color' }),
    j.use_color_jitter
      ? [rowFor('hue_jitter', 'Hue', 'use_stroke_random_hue', 'use_random_press_hue'), rowFor('saturation_jitter', 'Saturation', 'use_stroke_random_sat', 'use_random_press_sat'), rowFor('value_jitter', 'Value', 'use_stroke_random_val', 'use_random_press_val')]
      : null,
  ];
}

/** Texture Paint cavity mask: on/off and the curve from cavity to strength. */
function cavityRows(): Child[] {
  const st = imagePaintSettings();
  return [
    checkbox('pt-cav', 'Cavity Mask', !!st.use_cavity, (x) => ((st.use_cavity = x), changed()), { tip: 'Paint mostly into the dips of the surface' }),
    st.use_cavity
      ? curveWidget(
          'pt-cav-curve',
          () =>
            st.cavity_curve ?? [
              [0, 0],
              [1, 1],
            ],
          (pts) => ((st.cavity_curve = pts), changed()),
          'Cavity (left: flat, right: deepest dip) to paint strength',
        )
      : null,
  ];
}

/** Weight Paint settings beyond the shared tool settings. */
const wpOpts = () => ((app.doc.scene.tool_settings as unknown as { weight_paint?: { use_group_restrict?: boolean } }).weight_paint ??= {});

/** Brush size field: the diameter in pixels (the brush stores its radius). */
function radiusField(b: PaintBrush, id: string, label = 'Size') {
  return numberField({
    id,
    label,
    value: b.radius * 2,
    min: 2,
    max: 4000,
    step: 2,
    unit: 'pixel',
    tip: 'Diameter of the brush in pixels (F)',
    set: (x) => (setBrushRadius(b, Math.max(1, Math.round(x / 2))), changed()),
  });
}
function strengthField(b: PaintBrush, id: string) {
  return numberField({
    id,
    label: 'Strength',
    value: b.strength,
    min: 0,
    max: app.doc.mode === 'SCULPT' ? 10 : 1,
    softMax: 1,
    slider: true,
    precision: 3,
    tip: 'How powerful the effect of the brush is when applied (Shift F)',
    set: (x) => (setBrushStrength(b, x), changed()),
  });
}
function weightField(id: string) {
  const up = app.doc.scene.tool_settings.unified_paint;
  return numberField({
    id,
    label: 'Weight',
    value: up.weight,
    min: 0,
    max: 1,
    slider: true,
    precision: 3,
    tip: 'Weight to paint (Ctrl F)',
    set: (x) => ((up.weight = x), changed()),
  });
}
function directionToggle(b: PaintBrush): VNode | null {
  if (!DIRECTIONAL.has(b.sculpt_tool)) return null;
  const labels = DIR_LABELS[b.sculpt_tool];
  return h(
    'div',
    { key: 'dir', class: 'enum-row' },
    (['ADD', 'SUBTRACT'] as const).map((d) =>
      h(
        'button',
        {
          key: d,
          class: { on: b.direction === d },
          'data-tip': labels ? labels[d === 'ADD' ? 0 : 1] : d === 'ADD' ? 'Add effect of brush' : 'Subtract effect of brush',
          onclick: () => ((b.direction = d), changed()),
        },
        d === 'ADD' ? icon('add') : icon('remove'),
      ),
    ),
  );
}
function falloffMenu(b: PaintBrush, id: string) {
  return enumMenu(
    id,
    FALLOFFS.map(([value, label]) => ({ value, label })),
    b.falloff,
    (x) => {
      // a custom curve starts from the preset it replaces
      if (x === 'CUSTOM' && !b.falloff_curve) b.falloff_curve = falloffPresetPoints(b.falloff);
      b.falloff = x as PaintBrush['falloff'];
      changed();
    },
    { tip: 'Falloff curve preset' },
  );
}
function colorFields(id: string) {
  const up = app.doc.scene.tool_settings.unified_paint;
  return h(
    'div',
    { key: id, style: { display: 'flex', gap: '2px', alignItems: 'center' } },
    h(
      'div',
      { style: { width: '44px' } },
      colorSwatch(`${id}-c`, up.color, (c) => ((up.color = [c[0], c[1], c[2]]), changed())),
    ),
    h(
      'div',
      { style: { width: '44px' } },
      colorSwatch(`${id}-c2`, up.secondary_color, (c) => ((up.secondary_color = [c[0], c[1], c[2]]), changed())),
    ),
    h(
      'button',
      {
        class: 'hdr-toggle',
        'data-tip': 'Swap Colors (X)',
        onclick: () => app.run('paint.brush_colors_flip'),
      },
      icon('sort'),
    ),
  );
}
function blendMenu(b: PaintBrush, id: string, items: [string, string][]) {
  return enumMenu(
    id,
    items.map(([value, label]) => ({ value, label })),
    b.blend ?? 'MIX',
    (x) => ((b.blend = x as PaintBrush['blend']), changed()),
    { tip: 'Blending mode' },
  );
}
function symmetryToggles(prefix: string) {
  const s = app.doc.scene.tool_settings.sculpt;
  const keys = ['use_symmetry_x', 'use_symmetry_y', 'use_symmetry_z'] as const;
  return h(
    'div',
    {
      key: `${prefix}-sym`,
      style: { display: 'flex', alignItems: 'center', gap: '2px' },
    },
    h('span', { class: 'th-label', 'data-tip': 'Mirror' }, icon('mirror_sym')),
    h(
      'div',
      { class: 'enum-row' },
      keys.map((k, i) =>
        h(
          'button',
          {
            key: k,
            class: { on: s[k] },
            'data-tip': `Mirror brush across the ${'XYZ'[i]} axis`,
            onclick: () => ((s[k] = !s[k]), changed()),
          },
          'XYZ'[i],
        ),
      ),
    ),
  );
}
const field = (w: number, c: Child) => h('div', { style: { width: `${w}px`, flex: 'none' } }, c);

const SYM_DIRS: [string, string][] = [
  ['NEGATIVE_X', '-X to +X'],
  ['POSITIVE_X', '+X to -X'],
  ['NEGATIVE_Y', '-Y to +Y'],
  ['POSITIVE_Y', '+Y to -Y'],
  ['NEGATIVE_Z', '-Z to +Z'],
  ['POSITIVE_Z', '+Z to -Z'],
];
const symState = { direction: 'NEGATIVE_X' };

/** Tool header button opening a popover with the given rows. */
function popButton(key: string, label: string, title: string, rows: () => Child, width = 260): VNode {
  return h(
    'button',
    {
      key,
      class: 'th-pop',
      'data-tip': title,
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        openPopover(e.currentTarget as HTMLElement, () => h('div', { class: 'pop-panel' }, h('div', { class: 'pop-title' }, title), rows()), { width });
      },
    },
    h('span', null, label),
    icon('down_arrow_hlt', 'tiny'),
  );
}

export function toolHeaderSettings(mode: BrushMode): Child {
  const b = activeBrush(mode);
  if (!b) return null;
  const parts: Child[] = [];
  // brush picker (thumbnail grid)
  parts.push(
    h(
      'button',
      {
        key: 'th-brush',
        class: 'th-pop th-brush',
        'data-tip': 'Brush (Space)',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          openBrushPicker(e.currentTarget as HTMLElement);
        },
      },
      h('img', { src: brushThumb(b.sculpt_tool, mode, 36), width: 18, height: 18, alt: '' }),
      icon('down_arrow_hlt', 'tiny'),
    ),
  );
  if (paintsColor(mode, b)) {
    parts.push(colorFields('th-col'));
    parts.push(field(110, blendMenu(b, 'th-blend', mode === 'TEXTURE_PAINT' ? TEX_BLENDS : BLENDS)));
  }
  if (mode === 'WEIGHT_PAINT' && b.sculpt_tool === 'DRAW') parts.push(field(140, weightField('th-w')));
  if (!(mode === 'TEXTURE_PAINT' && b.sculpt_tool === 'FILL')) parts.push(field(176, sizeField(b, 'th-r')));
  parts.push(field(176, strengthRow(b, 'th-s')));
  if (mode === 'WEIGHT_PAINT' && b.sculpt_tool === 'DRAW') parts.push(field(100, blendMenu(b, 'th-wblend', BLENDS)));
  if (mode === 'SCULPT') parts.push(directionToggle(b));
  parts.push(popButton('th-p-brush', 'Brush', 'Brush Settings', () => [...mainRows(b, mode, 'thp'), ...advancedRows(b, mode, 'thp')]));
  parts.push(popButton('th-p-tex', 'Texture', 'Texture', () => [...textureRows(b, 'thp', mode), ...(mode === 'TEXTURE_PAINT' ? [h('div', { class: 'pop-sub' }, 'Texture Mask'), ...textureRows(b, 'thpm', mode, true)] : [])]));
  parts.push(popButton('th-p-stroke', 'Stroke', 'Stroke', () => strokeRows(b, mode, 'thp')));
  parts.push(popButton('th-p-falloff', 'Falloff', 'Falloff', () => falloffRows(b, mode, 'thp')));
  parts.push(popButton('th-p-cursor', 'Cursor', 'Cursor', () => cursorRows(b, mode, 'thp')));
  parts.push(h('div', { style: { flex: '1' } }));
  if (mode === 'WEIGHT_PAINT')
    parts.push(
      checkbox('th-autonorm', 'Auto Normalize', !!app.doc.scene.tool_settings.use_auto_normalize, (x) => ((app.doc.scene.tool_settings.use_auto_normalize = x), changed()), {
        tip: 'Keep the sum of deform weights at 1 while painting',
      }),
    );
  parts.push(symmetryToggles('th'));
  if (mode === 'SCULPT') {
    const ts = app.doc.scene.tool_settings.sculpt;
    // Dyntopo: on/off, settings in the popover next to it
    parts.push(
      h(
        'div',
        { key: 'th-dyntopo', class: 'th-dyntopo', style: { display: 'flex', alignItems: 'center', flex: 'none' } },
        checkbox('th-dt-on', 'Dyntopo', !!ts.use_dyntopo, () => app.run('sculpt.dynamic_topology_toggle'), { tip: 'Dyntopo\nAdd and remove triangles under the brush as you sculpt' }),
        popButton('th-p-dyntopo', '', 'Dyntopo', () => dyntopoSettings('pop-dt'), 240),
      ),
    );
    parts.push(popButton('th-p-remesh', 'Remesh', 'Remesh', () => remeshRows()));
    parts.push(automaskButton());
    parts.push(popButton('th-p-options', 'Options', 'Options', () => [...sculptOptionRows(), h('div', { class: 'pop-sub' }, 'Auto-Masking'), ...automaskSettings('thp-am')]));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// sidebar (Tool tab)

function falloffPreview(b: PaintBrush): VNode {
  const W = 180,
    H = 50;
  let d = '';
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const y = brushFalloff(b, t);
    d += `${i ? 'L' : 'M'}${(t * W).toFixed(1)} ${(H - 2 - y * (H - 6)).toFixed(1)}`;
  }
  return h(
    'div',
    { class: 'paint-falloff', style: { padding: '4px 0' } },
    h(
      'svg',
      {
        viewBox: `0 0 ${W} ${H}`,
        width: '100%',
        height: H,
        style: { background: 'rgba(0, 0, 0,0.25)', borderRadius: '3px' },
      },
      h('path', {
        d: `${d}L${W} ${H}L0 ${H}Z`,
        fill: 'rgba(255, 255, 255,0.12)',
      }),
      h('path', { d, fill: 'none', stroke: '#dedfe1', 'stroke-width': 1.5 }),
    ),
  );
}

// ---------------------------------------------------------------------------
// brush settings content (shared by the sidebar / Properties panels and the tool header popovers)

/** Brushes that paint with the brush color (color fields, blend, color picker). */
function paintsColor(mode: BrushMode, b: PaintBrush) {
  if (mode === 'SCULPT') return b.sculpt_tool === 'PAINT';
  return (mode === 'VERTEX_PAINT' || mode === 'TEXTURE_PAINT') && (b.sculpt_tool === 'DRAW' || b.sculpt_tool === 'TEXDRAW' || b.sculpt_tool === 'FILL');
}

function pressureToggle(b: PaintBrush, key: 'use_pressure_size' | 'use_pressure_strength', id: string) {
  const on = key === 'use_pressure_strength' ? b.use_pressure_strength !== false : !!b.use_pressure_size;
  return h(
    'button',
    {
      key: id,
      class: { 'hdr-toggle': true, 'pressure-toggle': true, on },
      'data-tip': key === 'use_pressure_size' ? 'Use pen pressure for the radius' : 'Use pen pressure for the strength',
      onclick: () => ((b[key] = !on), changed()),
    },
    icon('pressure'),
  );
}

/** Radius field (pixels, or scene units when the size is locked to the scene) with the pressure toggle. */
function sizeField(b: PaintBrush, id: string) {
  const scene = b.use_locked_size === 'SCENE';
  return h(
    'div',
    { key: id, class: 'paint-pressure-row' },
    scene
      ? numberField({ id, label: 'Size', value: (b.unprojected_radius ?? 0.1) * 2, min: 0.0002, max: 200, unit: 'distance', precision: 3, tip: 'Diameter of the brush in scene units (F)', set: (x) => ((b.unprojected_radius = x / 2), changed()) })
      : radiusField(b, id),
    scene ? null : unifiedToggle('size', b, `${id}-u`),
    pressureToggle(b, 'use_pressure_size', `${id}-p`),
  );
}
function strengthRow(b: PaintBrush, id: string) {
  return h('div', { key: id, class: 'paint-pressure-row' }, strengthField(b, id), unifiedToggle('strength', b, `${id}-u`), pressureToggle(b, 'use_pressure_strength', `${id}-p`));
}

/** Share the size / strength between all brushes. */
function unifiedToggle(kind: 'size' | 'strength', b: PaintBrush, id: string) {
  const u = app.doc.scene.tool_settings.unified_paint as unknown as UnifiedFlags;
  const on = kind === 'size' ? !!u.use_unified_size : !!u.use_unified_strength;
  return h(
    'button',
    {
      key: id,
      class: { 'hdr-toggle': true, 'pressure-toggle': true, on },
      'data-tip': `Use the same ${kind} for all brushes`,
      onclick: () => (setUnified(kind, !on, b), app.pushUndo(`Unified ${kind === 'size' ? 'Size' : 'Strength'}`), changed()),
    },
    icon('paint_unified'),
  );
}

/** Switch the radius between screen pixels and scene units, keeping the current size on screen. */
function setSizeUnit(b: PaintBrush, unit: 'VIEW' | 'SCENE') {
  if ((b.use_locked_size ?? 'VIEW') === unit) return;
  const v = activeView3D();
  const s = meshSession();
  if (v && s) {
    const at = cursorState.hit?.point ?? new Vector3().setFromMatrixPosition(s.world());
    const perPx = s.pixelsToLocal(v, at, 1) * s.scale();
    if (unit === 'SCENE') b.unprojected_radius = Math.max(1e-4, b.radius * perPx);
    else setBrushRadius(b, Math.max(1, Math.min(2000, Math.round((b.unprojected_radius ?? 0.1) / perPx))));
  }
  b.use_locked_size = unit;
  changed();
}

function mainRows(b: PaintBrush, mode: BrushMode, p: string): Child[] {
  const rows: Child[] = [];
  if (paintsColor(mode, b)) rows.push(row('Blend', blendMenu(b, `${p}-blend`, mode === 'TEXTURE_PAINT' ? TEX_BLENDS : BLENDS)));
  if (mode === 'WEIGHT_PAINT') {
    if (b.sculpt_tool === 'DRAW') rows.push(row('Blend', blendMenu(b, `${p}-wblend`, BLENDS)));
    rows.push(weightField(`${p}-w`));
  }
  if (!(mode === 'TEXTURE_PAINT' && b.sculpt_tool === 'FILL')) {
    rows.push(sizeField(b, `${p}-r`));
    rows.push(
      row(
        'Size Unit',
        enumRow(
          `${p}-unit`,
          [
            { value: 'VIEW', label: 'View', description: 'Radius in screen pixels' },
            { value: 'SCENE', label: 'Scene', description: 'Radius in scene units' },
          ],
          b.use_locked_size ?? 'VIEW',
          (x) => setSizeUnit(b, x as 'VIEW'),
        ),
      ),
    );
  }
  rows.push(strengthRow(b, `${p}-s`));
  rows.push(...pressureCurveRows(b, p));
  if (mode === 'TEXTURE_PAINT' && b.sculpt_tool === 'CLONE') {
    const imgs = Object.values(app.doc.images);
    rows.push(
      row(
        'Clone from',
        enumMenu(`${p}-clone`, [{ value: '', label: 'Same Image (Ctrl+click source)' }, ...imgs.map((im) => ({ value: im.id, label: im.name, icon: 'image' }))], b.clone_image ?? '', (x) => ((b.clone_image = x || null), changed()), { tip: 'Image the clone brush copies from' }),
      ),
    );
  }
  if (mode === 'SCULPT') {
    const dt = directionToggle(b);
    if (dt) rows.push(row('Direction', dt));
    if (b.sculpt_tool === 'MASK')
      rows.push(
        row(
          'Mask Tool',
          enumMenu(
            `${p}-masktool`,
            [
              { value: 'DRAW', label: 'Draw' },
              { value: 'SMOOTH', label: 'Smooth' },
            ],
            b.mask_tool ?? 'DRAW',
            (x) => ((b.mask_tool = x as 'DRAW'), changed()),
          ),
        ),
      );
  }
  return rows;
}

function advancedRows(b: PaintBrush, mode: BrushMode, p: string): Child[] {
  const rows: Child[] = [];
  if (mode === 'SCULPT') {
    rows.push(numberField({ id: `${p}-nr`, label: 'Normal Radius', value: b.normal_radius_factor ?? 0.5, min: 0, max: 2, slider: true, tip: 'Ratio between the brush radius and the radius used to sample the area normal', set: (x) => ((b.normal_radius_factor = x), changed()) }));
    rows.push(numberField({ id: `${p}-hard`, label: 'Hardness', value: b.hardness ?? 0, min: 0, max: 1, slider: true, tip: 'How close the brush falloff starts from the edge', set: (x) => ((b.hardness = x), changed()) }));
    if (b.sculpt_tool !== 'SMOOTH' && b.sculpt_tool !== 'MASK')
      rows.push(numberField({ id: `${p}-as`, label: 'Auto-Smooth', value: b.auto_smooth_factor ?? 0, min: 0, max: 1, slider: true, tip: 'Smooth the surface after each dab', set: (x) => ((b.auto_smooth_factor = x), changed()) }));
    if (PLANE_TOOLS.has(b.sculpt_tool))
      rows.push(numberField({ id: `${p}-po`, label: 'Plane Offset', value: b.plane_offset ?? 0, min: -2, max: 2, softMin: -0.5, softMax: 0.5, slider: true, tip: 'Offset of the brush plane from the surface', set: (x) => ((b.plane_offset = x), changed()) }));
    if (b.sculpt_tool === 'BOUNDARY')
      rows.push(
        row(
          'Deformation',
          enumMenu(
            `${p}-bdef`,
            [
              { value: 'GRAB', label: 'Grab' },
              { value: 'EXPAND', label: 'Expand' },
              { value: 'INFLATE', label: 'Inflate' },
            ],
            b.boundary_deform_type ?? 'GRAB',
            (x) => ((b.boundary_deform_type = x as 'GRAB'), changed()),
          ),
        ),
      );
    if (b.sculpt_tool === 'LAYER')
      rows.push(
        checkbox(`${p}-persist`, 'Persistent', !!b.use_persistent, (x) => ((b.use_persistent = x), changed()), { tip: 'Measure the layer height from a stored base shape, so strokes build on the same layer' }),
        b.use_persistent ? opButton('sculpt.set_persistent_base', 'Set Persistent Base', {}, { tip: 'Store the current shape as the base of the layer' }) : null,
      );
    if (b.sculpt_tool === 'CREASE') rows.push(numberField({ id: `${p}-pinch`, label: 'Pinch', value: b.crease_pinch_factor ?? 0.5, min: 0, max: 1, slider: true, set: (x) => ((b.crease_pinch_factor = x), changed()) }));
  } else rows.push(numberField({ id: `${p}-hard`, label: 'Hardness', value: b.hardness ?? 0, min: 0, max: 1, slider: true, tip: 'How close the brush falloff starts from the edge', set: (x) => ((b.hardness = x), changed()) }));
  rows.push(checkbox(`${p}-ff`, 'Front Faces Only', !!b.use_frontface, (x) => ((b.use_frontface = x), changed()), { tip: 'Brush only affects vertices facing the viewer' }));
  if (mode === 'TEXTURE_PAINT') {
    rows.push(checkbox(`${p}-occ`, 'Occlude', b.use_occlude !== false, (x) => ((b.use_occlude = x), changed()), { tip: 'Only paint onto the faces directly under the brush' }));
    rows.push(checkbox(`${p}-bfc`, 'Backface Culling', b.use_backface_culling !== false, (x) => ((b.use_backface_culling = x), changed()), { tip: 'Ignore faces pointing away from the view' }));
  }
  if (mode !== 'SCULPT') rows.push(checkbox(`${p}-acc`, 'Accumulate', !!b.use_accumulate, (x) => ((b.use_accumulate = x), changed()), { tip: 'Keep adding within a stroke instead of limiting it to the brush strength' }));
  return rows;
}

function strokeRows(b: PaintBrush, mode: BrushMode, p: string): Child[] {
  const m = b.stroke_method ?? 'SPACE';
  return [
    row('Stroke Method', enumMenu(`${p}-sm`, strokeMethods(mode).map(([value, label]) => ({ value, label })), m, (x) => ((b.stroke_method = x as PaintBrush['stroke_method']), changed()), { tip: 'How dabs are placed along the stroke (Alt E)' })),
    m === 'CURVE'
      ? [
          dataBlockSelector(`${p}-pc`, 'curve_draw', Object.values(paintCurvesOf()), b.paint_curve ?? null, (id) => ((b.paint_curve = id), app.pushUndo('Paint Curve'), changed()), () => app.run('paintcurve.new'), {}),
          opButton('paintcurve.draw', 'Draw Curve', {}, { icon: 'brush_paint_draw', tip: 'Paint along the curve (Enter, or click away from the curve)' }),
          h('div', { class: 'sb-label' }, 'Ctrl+click adds points · drag moves them · right-click selects'),
        ]
      : null,
    m === 'SPACE' || m === 'LINE' || m === 'AIRBRUSH' || m === 'CURVE'
      ? numberField({ id: `${p}-sp`, label: 'Spacing', value: b.spacing ?? 10, min: 1, max: 1000, int: true, unit: 'percentage', tip: 'Spacing between dabs as a percentage of the brush radius', set: (x) => ((b.spacing = Math.round(x)), changed()) })
      : null,
    m === 'SPACE' || m === 'LINE' || m === 'AIRBRUSH' || m === 'CURVE'
      ? checkbox(`${p}-psp`, 'Pressure Spacing', !!b.use_pressure_spacing, (x) => ((b.use_pressure_spacing = x), changed()), { tip: 'Light pen pressure places the dabs closer together' })
      : null,
    m !== 'LINE' && m !== 'ANCHORED' && m !== 'DRAG_DOT'
      ? [
          h(
            'div',
            { class: 'paint-pressure-row' },
            (b.jitter_unit ?? 'BRUSH') === 'VIEW'
              ? numberField({ id: `${p}-jit`, label: 'Jitter', value: b.jitter_absolute ?? 0, min: 0, max: 1000, int: true, unit: 'pixel', tip: 'Random offset of the dabs (pixels)', set: (x) => ((b.jitter_absolute = Math.round(x)), changed()) })
              : numberField({ id: `${p}-jit`, label: 'Jitter', value: b.jitter ?? 0, min: 0, max: 2, slider: true, tip: 'Random offset of the dabs (fraction of the radius)', set: (x) => ((b.jitter = x), changed()) }),
            h('button', { key: `${p}-jitp`, class: { 'hdr-toggle': true, 'pressure-toggle': true, on: !!b.use_pressure_jitter }, 'data-tip': 'Use pen pressure for the jitter', onclick: () => ((b.use_pressure_jitter = !b.use_pressure_jitter), changed()) }, icon('pressure')),
          ),
          row(
            'Jitter Unit',
            enumRow(
              `${p}-jitu`,
              [
                { value: 'VIEW', label: 'View', description: 'Jitter in screen pixels' },
                { value: 'BRUSH', label: 'Brush', description: 'Jitter relative to the brush radius' },
              ],
              b.jitter_unit ?? 'BRUSH',
              (x) => ((b.jitter_unit = x as 'VIEW'), changed()),
            ),
          ),
        ]
      : null,
    m === 'AIRBRUSH' ? numberField({ id: `${p}-rate`, label: 'Rate', value: b.rate ?? 0.1, min: 0.0001, max: 10, precision: 3, unit: 'time', tip: 'Interval between airbrush dabs (seconds)', set: (x) => ((b.rate = x), changed()) }) : null,
    m !== 'LINE' && m !== 'ANCHORED' ? checkbox(`${p}-stab`, 'Stabilize Stroke', !!b.use_smooth_stroke, (x) => ((b.use_smooth_stroke = x), changed()), { tip: 'Let the brush trail behind the pointer for smoother lines (Shift S)' }) : null,
    b.use_smooth_stroke && m !== 'LINE' && m !== 'ANCHORED'
      ? [
          numberField({ id: `${p}-stab-r`, label: 'Radius', value: b.smooth_stroke_radius ?? 75, min: 10, max: 200, int: true, unit: 'pixel', tip: 'Distance the brush trails behind the pointer', set: (x) => ((b.smooth_stroke_radius = Math.round(x)), changed()) }),
          numberField({ id: `${p}-stab-f`, label: 'Factor', value: b.smooth_stroke_factor ?? 0.9, min: 0.5, max: 0.99, slider: true, tip: 'How smoothly the brush follows', set: (x) => ((b.smooth_stroke_factor = x), changed()) }),
        ]
      : null,
  ];
}

function falloffRows(b: PaintBrush, mode: BrushMode, p: string): Child[] {
  return [
    row('Preset', falloffMenu(b, `${p}-fo`)),
    b.falloff === 'CUSTOM'
      ? curveWidget(`${p}-focurve`, () => b.falloff_curve ?? falloffPresetPoints('SMOOTH'), (pts) => ((b.falloff_curve = pts), changed()), 'Falloff curve: strength from the rim (left) to the center (right)')
      : falloffPreview(b),
    mode !== 'TEXTURE_PAINT'
      ? row(
          'Shape',
          enumMenu(
            `${p}-fshape`,
            [
              { value: 'SPHERE', label: 'Sphere' },
              { value: 'PROJECTED', label: 'Projected' },
            ],
            b.falloff_shape ?? 'SPHERE',
            (x) => ((b.falloff_shape = x as 'SPHERE'), changed()),
            { tip: 'Sphere: 3D distance. Projected: screen-space circle' },
          ),
        )
      : null,
    mode !== 'SCULPT' ? normalFalloffRows(mode, p) : null,
    mode === 'SCULPT'
      ? [
          checkbox(`${p}-fff`, 'Front-Face Falloff', !!b.use_frontface_falloff, (x) => ((b.use_frontface_falloff = x), (b.use_frontface ||= x), changed()), { tip: 'Fade the brush out on surfaces turning away from the view' }),
          b.use_frontface_falloff ? numberField({ id: `${p}-ffa`, label: 'Angle', value: b.falloff_angle ?? 0, min: 0, max: Math.PI / 2, unit: 'angle', tip: 'Surfaces up to this angle from the view get full strength', set: (x) => ((b.falloff_angle = x), changed()) }) : null,
        ]
      : null,
  ];
}

/** Normal falloff of the paint modes: less paint on surfaces turning away from the view. */
function normalFalloffRows(mode: BrushMode, p: string): Child[] {
  const ts = app.doc.scene.tool_settings as unknown as Record<string, NormalFalloff | undefined>;
  const key = mode === 'VERTEX_PAINT' ? 'vertex_paint' : mode === 'WEIGHT_PAINT' ? 'weight_paint' : 'image_paint';
  const st = (ts[key] ??= {});
  const on = st.use_normal_falloff !== false;
  return [
    checkbox(`${p}-nfo`, 'Normal Falloff', on, (x) => ((st.use_normal_falloff = x), changed()), { tip: 'Paint less on surfaces turning away from the view' }),
    on ? numberField({ id: `${p}-nfa`, label: 'Angle', value: st.normal_angle ?? NORMAL_ANGLE, min: 0, max: Math.PI / 2, unit: 'angle', tip: 'Surfaces turned further than this get no paint', set: (x) => ((st.normal_angle = x), changed()) }) : null,
  ];
}

/** Pressure response curve rows (shown under the size / strength fields when turned on). */
function pressureCurveRows(b: PaintBrush, p: string): Child[] {
  const out: Child[] = [];
  for (const [flag, key, label] of [
    ['use_size_curve', 'curve_size', 'Size'],
    ['use_strength_curve', 'curve_strength', 'Strength'],
  ] as const) {
    const pressureOn = key === 'curve_size' ? !!b.use_pressure_size : b.use_pressure_strength !== false;
    if (!pressureOn) continue;
    out.push(checkbox(`${p}-${key}-on`, `${label} Pressure Curve`, !!b[flag], (x) => ((b[flag] = x), changed()), { tip: `Shape how pen pressure maps to the ${label.toLowerCase()}` }));
    if (b[flag])
      out.push(
        curveWidget(
          `${p}-${key}`,
          () =>
            b[key] ?? [
              [0, 0],
              [1, 1],
            ],
          (pts) => ((b[key] = pts), changed()),
          `${label} pressure: pen pressure (left to right) to ${label.toLowerCase()}`,
        ),
      );
  }
  return out;
}

function textureRows(b: PaintBrush, p: string, mode: BrushMode = app.doc.mode as BrushMode, mask = false): Child[] {
  const key = mask ? 'mask_texture_slot' : 'texture_slot';
  const t: BrushTexture = b[key] ?? { source: 'NONE', map_mode: 'VIEW_PLANE', angle: 0, scale: 1, strength: 1 };
  const set = (patch: Partial<BrushTexture>) => {
    b[key] = { ...t, ...patch };
    changed();
  };
  const images = Object.values(app.doc.images);
  const rows: Child[] = [
    row(mask ? 'Mask' : 'Texture', enumMenu(`${p}-tsrc`, TEX_SOURCES.map(([value, label]) => ({ value, label })), t.source, (x) => set({ source: x as BrushTexture['source'] }), { tip: mask ? 'Pattern that scales the brush strength' : 'Pattern that modulates the brush (in Texture Paint: its colors are painted)' })),
  ];
  if (t.source === 'IMAGE')
    rows.push(
      images.length
        ? row('Image', enumMenu(`${p}-timg`, images.map((im) => ({ value: im.id, label: im.name, icon: 'image' })), t.image ?? '', (x) => set({ image: x }), { tip: 'Image used as the brush texture (bright = strong)' }))
        : h('div', { class: 'sb-label' }, 'No images in the file: open one in the Image Editor first'),
    );
  if (t.source === 'NONE') return rows;
  const modes = mapModes(mode, mask);
  const stencil = t.map_mode === 'STENCIL';
  rows.push(
    h('canvas', {
      key: `${p}-tprev-${t.source}-${t.image}-${t.angle}-${t.scale}`,
      class: 'paint-tex-preview',
      width: 96,
      height: 96,
      ref: (c: HTMLCanvasElement) => {
        const ctx = c.getContext('2d');
        if (!ctx) return;
        const img = ctx.createImageData(96, 96);
        const cos = Math.cos(-t.angle),
          sin = Math.sin(-t.angle);
        const px = [0, 0, 0, 0];
        for (let y = 0; y < 96; y++)
          for (let x = 0; x < 96; x++) {
            const dx = (x / 48 - 1) / t.scale,
              dy = (1 - y / 48) / t.scale;
            const i = (y * 96 + x) * 4;
            sampleTexRGBA(t, dx * cos - dy * sin, dx * sin + dy * cos, px);
            if (mask || t.source !== 'IMAGE') {
              const f = sampleTex(t, dx * cos - dy * sin, dx * sin + dy * cos);
              img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(f * 255);
            } else for (let k = 0; k < 3; k++) img.data[i + k] = Math.round(px[k] * px[3] * 255);
            img.data[i + 3] = 255;
          }
        ctx.putImageData(img, 0, 0);
      },
    }),
    row(
      'Mapping',
      enumMenu(
        `${p}-tmap`,
        modes.map(([value, label, description]) => ({ value, label, description })),
        modes.some((m) => m[0] === t.map_mode) ? t.map_mode : 'VIEW_PLANE',
        (x) => {
          set({ map_mode: x as BrushTexture['map_mode'] });
          if (x === 'STENCIL') centerStencil(b, mask);
        },
        { tip: 'How the texture is placed over the brush' },
      ),
    ),
  );
  if (stencil)
    rows.push(
      h('div', { class: 'sb-label' }, 'Right-drag moves the stencil · Shift: scale · Ctrl: rotate' + (mask ? ' (hold Alt for the mask)' : '')),
      h(
        'div',
        { class: 'row-split' },
        opButton('brush.stencil_fit_image_aspect', 'Image Aspect', { mask }, { tip: 'Give the stencil the proportions of its image' }),
        opButton('brush.stencil_reset_transform', 'Reset Transform', { mask }, { tip: 'Put the stencil back to its default place, size and angle' }),
      ),
    );
  if (t.map_mode === 'RANDOM' || t.map_mode === 'VIEW_PLANE' || t.map_mode === 'AREA_PLANE' || stencil) {
    rows.push(numberField({ id: `${p}-tang`, label: 'Angle', value: t.angle, min: -Math.PI * 2, max: Math.PI * 2, unit: 'angle', set: (x) => set({ angle: x }) }));
    if (!stencil && t.map_mode !== 'RANDOM')
      rows.push(
        checkbox(`${p}-trnd`, 'Random', !!t.use_random, (x) => set({ use_random: x }), { tip: 'Rotate the texture by a random angle for each dab' }),
        t.use_random ? numberField({ id: `${p}-trnda`, label: 'Random Angle', value: t.random_angle ?? Math.PI * 2, min: 0, max: Math.PI * 2, unit: 'angle', set: (x) => set({ random_angle: x }) }) : null,
      );
  }
  const off = t.offset ?? [0, 0, 0];
  rows.push(
    numberField({ id: `${p}-tscale`, label: 'Size', value: t.scale, min: 0.01, max: 100, softMax: 4, set: (x) => set({ scale: x }) }),
    numberField({ id: `${p}-toffx`, label: 'Offset X', value: off[0], min: -10, max: 10, softMin: -2, softMax: 2, set: (x) => set({ offset: [x, off[1], off[2]] }) }),
    numberField({ id: `${p}-toffy`, label: 'Y', value: off[1], min: -10, max: 10, softMin: -2, softMax: 2, set: (x) => set({ offset: [off[0], x, off[2]] }) }),
    t.map_mode === '3D' ? numberField({ id: `${p}-toffz`, label: 'Z', value: off[2], min: -10, max: 10, softMin: -2, softMax: 2, set: (x) => set({ offset: [off[0], off[1], x] }) }) : null,
    numberField({ id: `${p}-tstr`, label: 'Influence', value: t.strength ?? 1, min: 0, max: 1, slider: true, tip: 'How much the texture modulates the brush', set: (x) => set({ strength: x }) }),
  );
  return rows;
}

/** Put a new stencil in the middle of the active viewport. */
function centerStencil(b: PaintBrush, mask: boolean) {
  const v = activeView3D();
  if (!v) return;
  if (mask ? b.mask_stencil_pos : b.stencil_pos) return;
  const s = Math.round(Math.min(v.width, v.height) * 0.35);
  if (mask) {
    b.mask_stencil_pos = [Math.round(v.width / 2), Math.round(v.height / 2)];
    b.mask_stencil_dimension ??= [s, s];
  } else {
    b.stencil_pos = [Math.round(v.width / 2), Math.round(v.height / 2)];
    b.stencil_dimension ??= [s, s];
  }
}

function cursorRows(b: PaintBrush, mode: BrushMode, p: string): Child[] {
  return [
    checkbox(`${p}-cur`, 'Show Cursor', b.show_cursor !== false, (x) => ((b.show_cursor = x), changed()), { tip: 'Draw the brush outline under the pointer' }),
    mode === 'SCULPT' && b.show_cursor !== false
      ? [
          row('Add Color', colorSwatch(`${p}-cadd`, b.cursor_color_add ?? [1, 0.47, 0.47], (c) => ((b.cursor_color_add = [c[0], c[1], c[2]]), changed()), { linear: false })),
          DIRECTIONAL.has(b.sculpt_tool) ? row('Subtract Color', colorSwatch(`${p}-csub`, b.cursor_color_subtract ?? [0.43, 0.55, 1], (c) => ((b.cursor_color_subtract = [c[0], c[1], c[2]]), changed()), { linear: false })) : null,
        ]
      : null,
    b.show_cursor !== false
      ? h(
          'div',
          { class: 'paint-pressure-row' },
          numberField({ id: `${p}-fov`, label: 'Falloff Opacity', value: b.cursor_overlay_alpha ?? 33, min: 0, max: 100, slider: true, precision: 0, tip: 'Opacity of the falloff shading inside the brush cursor', set: (x) => ((b.cursor_overlay_alpha = Math.round(x)), changed()) }),
          h('button', { key: `${p}-fov-on`, class: { 'hdr-toggle': true, 'pressure-toggle': true, on: !!b.use_cursor_overlay }, 'data-tip': 'Show the falloff inside the cursor', onclick: () => ((b.use_cursor_overlay = !b.use_cursor_overlay), changed()) }, icon(b.use_cursor_overlay ? 'hide_off' : 'hide_on')),
        )
      : null,
    textureActive(b) ? numberField({ id: `${p}-tov`, label: 'Texture Opacity', value: b.texture_overlay_alpha ?? 33, min: 0, max: 100, slider: true, precision: 0, tip: 'Opacity of the texture overlay (stencils) in the viewport', set: (x) => ((b.texture_overlay_alpha = Math.round(x)), changed()) }) : null,
    maskTextureActive(b) ? numberField({ id: `${p}-mov`, label: 'Mask Texture Opacity', value: b.mask_overlay_alpha ?? 33, min: 0, max: 100, slider: true, precision: 0, tip: 'Opacity of the mask texture overlay (stencils) in the viewport', set: (x) => ((b.mask_overlay_alpha = Math.round(x)), changed()) }) : null,
  ];
}

function remeshRows(): Child[] {
  const am = activeMeshData();
  if (!am) return [];
  return [
    h(
      'div',
      { class: 'row-split' },
      numberField({
        id: 'pt-voxel',
        label: 'Voxel Size',
        value: am.me.remesh_voxel_size ?? 0.1,
        min: 0.0001,
        max: 10,
        unit: 'distance',
        precision: 4,
        tip: 'Size of the voxel used for volume evaluation (smaller = more detail) (R)',
        set: (x, final) => ((am.me.remesh_voxel_size = x), app.changed('ui'), final && app.pushUndo('Voxel Size')),
      }),
      button('pt-voxel-sample', icon('eyedropper'), () => app.run('sculpt.sample_detail_size', { mode: 'VOXEL' }), { tip: 'Sample the voxel size from the mesh under the cursor' }),
    ),
    opButton('object.voxel_remesh', 'Voxel Remesh'),
  ];
}

function sculptOptionRows(): Child[] {
  const ts = app.doc.scene.tool_settings.sculpt;
  return [
    numberField({ id: 'pt-grav', label: 'Gravity', value: ts.gravity ?? 0, min: 0, max: 1, slider: true, tip: 'Pull the surface downward (world -Z) with every dab', set: (x) => ((ts.gravity = x), changed()) }),
    checkbox('pt-delay', 'Delay Viewport Updates', !!ts.use_sculpt_delay_updates, (x) => ((ts.use_sculpt_delay_updates = x), changed()), { tip: 'Refresh shading only after the stroke on meshes with modifiers' }),
  ];
}

function brushTile(b: PaintBrush, mode: BrushMode): Child {
  const info = brushInfo(b.id);
  const preview = (b as PaintBrush & { asset_data?: { preview?: string } }).asset_data?.preview;
  const note = brushOriginNote(b);
  return h(
    'div',
    { class: 'paint-brush-tile' },
    h('img', { src: preview || brushThumb(b.sculpt_tool, mode, 192), width: 96, height: 96, alt: '', draggable: false }),
    h(
      'div',
      { class: 'pbt-side' },
      h(
        'div',
        { class: 'pbt-head' },
        h('div', { class: 'pbt-name' }, info?.name ?? b.name),
        h(
          'button',
          {
            class: 'pbt-menu',
            'data-tip': 'Brush Specials',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openMenu(brushSpecialsMenu(), e.currentTarget as HTMLElement);
            },
          },
          icon('down_arrow_hlt'),
        ),
      ),
      enumMenu(
        'pt-brush',
        BRUSH_LISTS[mode].filter((x): x is NonNullable<typeof x> => !!x).map((x) => ({ value: x.id, label: x.name, icon: x.icon })),
        b.id,
        (id) => (setActiveTool(id), changed()),
        { tip: 'Active brush (Space: brush shelf)' },
      ),
      info ? h('div', { class: 'pbt-desc' }, info.description) : note ? h('div', { class: 'pbt-desc' }, note) : null,
    ),
  );
}

/** The brush panels of a paint mode (Tool tabs of the 3D View, the Properties and the Image Editor). */
export function paintToolPanels(mode: BrushMode): Child[] {
  return brushPanels(mode);
}

function brushPanels(mode: BrushMode): Child[] {
  const b = activeBrush(mode);
  const ts = app.doc.scene.tool_settings;
  const out: Child[] = [];
  const tool = activeTools[mode];
  const isBrush = !!b && !gestureTools[tool] && !tool?.startsWith('builtin.');
  if (isBrush) {
    out.push(panel(`pt-brushes-${mode}`, 'Brush', () => brushTile(b, mode)));
    out.push(
      panel(`pt-brush-${mode}`, 'Brush Settings', () => [
        ...mainRows(b, mode, 'pt'),
        panel(`pt-adv-${mode}`, 'Advanced', () => advancedRows(b, mode, 'pt'), { sub: true, closed: true }),
        panel(`pt-stroke-${mode}`, 'Stroke', () => strokeRows(b, mode, 'pt'), { sub: true, closed: true }),
        panel(`pt-tex-${mode}`, 'Texture', () => textureRows(b, 'pt', mode), { sub: true, closed: true }),
        mode === 'TEXTURE_PAINT' ? panel(`pt-texmask-${mode}`, 'Texture Mask', () => textureRows(b, 'ptm', mode, true), { sub: true, closed: true }) : null,
        panel(`pt-falloff-${mode}`, 'Falloff', () => falloffRows(b, mode, 'pt'), { sub: true, closed: true }),
        panel(`pt-cursor-${mode}`, 'Cursor', () => cursorRows(b, mode, 'pt'), { sub: true, closed: true }),
      ]),
    );
    if (paintsColor(mode, b)) {
      out.push(panel(`pt-color-${mode}`, 'Color Picker', () => [colorPicker('pt-cp'), panel(`pt-cjit-${mode}`, 'Randomize Color', () => colorJitterRows('pt-cj'), { sub: true, closed: true })]));
      out.push(panel(`pt-palette-${mode}`, 'Color Palette', () => paletteRows(mode, 'pt-pal'), { closed: true }));
    }
  } else if (tool === 'builtin.sample_weight') out.push(panel('pt-sw', 'Sample Weight', () => [weightField('pt-sw-w')]));
  if (mode === 'WEIGHT_PAINT') {
    const am = activeMeshData();
    out.push(
      panel('pt-wp-opts', 'Options', () => [
        checkbox('pt-an', 'Auto Normalize', !!ts.use_auto_normalize, (x) => ((ts.use_auto_normalize = x), changed()), { tip: 'Ensure all deform vertex groups sum to 1 while painting' }),
        checkbox('pt-restrict', 'Restrict', !!wpOpts().use_group_restrict, (x) => ((wpOpts().use_group_restrict = x), changed()), { tip: 'Only paint vertices that already belong to the active group' }),
        am
          ? row(
              'Group',
              enumMenu(
                'pt-vg',
                am.me.vertex_groups.map((g, i) => ({ value: String(i), label: g.name, icon: 'group_vertex' })),
                String(am.ob.vertex_group_active_index ?? 0),
                (x) => ((am.ob.vertex_group_active_index = Number(x)), invalidatePaintAttributes(), app.changed('doc')),
                { tip: 'Active vertex group' },
              ),
              button(
                'pt-vg-add',
                icon('add'),
                () => {
                  app.run('object.vertex_group_add');
                  invalidatePaintAttributes();
                },
                { tip: 'Add vertex group' },
              ),
            )
          : null,
      ]),
    );
  }
  if (mode === 'VERTEX_PAINT') {
    const am = activeMeshData();
    if (am)
      out.push(
        panel('pt-vp-attr', 'Color Attribute', () => [
          enumMenu(
            'pt-ca',
            am.me.color_attributes.map((c, i) => ({ value: String(i), label: `${c.name} (${c.domain === 'POINT' ? 'Vertex' : 'Face Corner'})`, icon: 'group_vcol' })),
            String(am.me.active_color_index),
            (x) => ((am.me.active_color_index = Number(x)), app.pushUndo('Active Color Attribute'), app.changed('doc')),
          ),
        ]),
      );
  }
  if (mode === 'TEXTURE_PAINT')
    out.push(
      panel('pt-tp-opts', 'Options', () => [
        numberField({ id: 'pt-bleed', label: 'Bleed', value: imagePaintOptions.seam_bleed, min: 0, max: 32, int: true, unit: 'pixel', tip: 'Paint this many pixels past the UV island borders to hide seams', set: (x) => ((imagePaintOptions.seam_bleed = Math.round(x)), changed()) }),
        panel('pt-tp-ext', 'External', () => [
          opButton('image.project_edit', 'Quick Edit', {}, { tip: 'Save a snapshot of the view to edit in another program' }),
          opButton('image.project_apply', 'Apply', {}, { tip: 'Project the edited snapshot back onto the texture' }),
          opButton('paint.project_image', 'Apply Camera Image', {}, { tip: 'Project an image onto the texture from the current view' }),
        ], { sub: true, closed: true }),
      ], { closed: true }),
      panel('pt-tp-mask', 'Masking', () => [panel('pt-tp-stencil', 'Stencil Mask', () => stencilMaskRows(), { sub: true }), panel('pt-tp-cavity', 'Cavity Mask', () => cavityRows(), { sub: true, closed: true })], { closed: true }),
    );
  if (mode === 'TEXTURE_PAINT') {
    const am = activeMeshData();
    const img = paintImage();
    out.push(
      panel('pt-slots', 'Texture Slots', () => [
        img ? h('div', { class: 'sb-label' }, icon('texture'), ` ${img.name} (${img.width}×${img.height})`) : h('div', { class: 'sb-label' }, 'Missing texture'),
        am && !meshHasUVs(am.me) ? [h('div', { class: 'sb-label', style: { color: '#eb6760' } }, 'Missing UVs'), opButton('paint.add_simple_uvs', 'Add Simple UVs')] : null,
        opButton('paint.add_texture_paint_slot', 'New Base Color Texture', {}, { icon: 'add' }),
      ]),
    );
  }
  if (mode === 'SCULPT') {
    out.push(panel('pt-dyntopo', 'Dyntopo', () => dyntopoSettings('pt-dt')));
    if (activeMeshData()) out.push(panel('pt-remesh', 'Remesh', () => remeshRows()));
  }
  out.push(
    panel(`pt-sym-${mode}`, 'Symmetry', () => [
      row('Mirror', symmetryToggles('pt')),
      mode === 'SCULPT'
        ? [
            row('Direction', enumMenu('pt-symdir', SYM_DIRS.map(([value, label]) => ({ value, label })), symState.direction, (x) => ((symState.direction = x), changed()), { tip: 'Which half is copied over the other' })),
            opButton('sculpt.symmetrize', 'Symmetrize', { direction: symState.direction }),
          ]
        : null,
    ]),
  );
  if (mode === 'SCULPT') {
    out.push(panel('pt-sculpt-opts', 'Options', () => sculptOptionRows(), { closed: true }));
    out.push(panel('pt-automask', 'Auto-Masking', () => automaskSettings('pt-am'), { closed: true }));
  }
  out.push(panel(`pt-workspace-${mode}`, 'Workspace', () => [h('div', { class: 'sb-label' }, `Mode: ${mode[0] + mode.slice(1).toLowerCase().replace('_', ' ')}`)], { closed: true }));
  return out;
}

// ---------------------------------------------------------------------------
// color picker (inline wheel) and palette

const pickerState = { hsv: null as null | [number, number, number], key: '' };

function colorPicker(p: string): Child {
  const up = app.doc.scene.tool_settings.unified_paint;
  const disp = up.color.map((x) => linearToSrgb(x)) as [number, number, number];
  const key = up.color.join(',');
  // keep the hue while the value is 0 (black loses it otherwise)
  if (!pickerState.hsv || pickerState.key !== key) {
    const [hh, s, v] = rgbToHsv(disp[0], disp[1], disp[2]);
    pickerState.hsv = [pickerState.hsv && s === 0 ? pickerState.hsv[0] : hh, s, v];
    pickerState.key = key;
  }
  const [hh, s, v] = pickerState.hsv;
  const set = (nh: number, ns: number, nv: number) => {
    pickerState.hsv = [nh, ns, nv];
    const rgb = hsvToRgb(nh, ns, nv).map((x) => srgbToLinear(x)) as [number, number, number];
    up.color = rgb;
    pickerState.key = rgb.join(',');
    changed();
  };
  const SIZE = 150;
  const drawWheel = (c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const r = SIZE / 2;
    const img = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const dx = x - r,
          dy = y - r;
        const d = Math.hypot(dx, dy) / r;
        const i = (y * SIZE + x) * 4;
        if (d > 1) continue;
        const [cr, cg, cb] = hsvToRgb((Math.atan2(-dy, dx) / (Math.PI * 2) + 1) % 1, d, v);
        img.data[i] = cr * 255;
        img.data[i + 1] = cg * 255;
        img.data[i + 2] = cb * 255;
        img.data[i + 3] = Math.min(1, (1 - d) * r) * 255;
      }
    ctx.putImageData(img, 0, 0);
  };
  const drag = (e: PointerEvent, fn: (ev: PointerEvent, el: HTMLElement) => void) => {
    const el = e.currentTarget as HTMLElement;
    fn(e, el);
    const mv = (ev: PointerEvent) => fn(ev, el);
    const up2 = () => {
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', up2);
      app.pushUndo('Brush Color');
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up2);
  };
  const ang = hh * Math.PI * 2;
  return h(
    'div',
    { class: 'paint-color-picker' },
    h(
      'div',
      { class: 'pcp-top' },
      h(
        'div',
        { class: 'pcp-wheel', style: { width: `${SIZE}px`, height: `${SIZE}px` } },
        h('canvas', {
          key: `wheel-${v.toFixed(3)}`,
          width: SIZE,
          height: SIZE,
          ref: drawWheel,
          onpointerdown: (e: PointerEvent) =>
            drag(e, (ev, el) => {
              const r = el.getBoundingClientRect();
              const dx = ev.clientX - r.left - r.width / 2,
                dy = ev.clientY - r.top - r.height / 2;
              set((Math.atan2(-dy, dx) / (Math.PI * 2) + 1) % 1, Math.min(1, Math.hypot(dx, dy) / (r.width / 2)), v);
            }),
        }),
        h('div', { class: 'pcp-cursor', style: { left: `${SIZE / 2 + Math.cos(ang) * s * (SIZE / 2)}px`, top: `${SIZE / 2 - Math.sin(ang) * s * (SIZE / 2)}px` } }),
      ),
      h(
        'div',
        {
          class: 'pcp-value',
          style: { height: `${SIZE}px`, background: `linear-gradient(to top, #000000, rgb(${hsvToRgb(hh, s, 1).map((x) => Math.round(x * 255)).join(',')}))` },
          'data-tip': 'Value',
          onpointerdown: (e: PointerEvent) =>
            drag(e, (ev, el) => {
              const r = el.getBoundingClientRect();
              set(hh, s, Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height)));
            }),
        },
        h('div', { class: 'pcp-vcursor', style: { top: `${(1 - v) * 100}%` } }),
      ),
    ),
    row('Color', colorFields(`${p}-sw`)),
  );
}

function paletteRows(mode: BrushMode, p: string): Child {
  const owner = mode === 'WEIGHT_PAINT' ? null : mode;
  if (!owner) return null;
  return paletteTemplate(owner, p, (cur, set, create) => dataBlockSelector(`${p}-ids`, 'paint_palette', Object.values(palettesOf()), cur?.id ?? null, set, create, { users: cur ? paletteUsers(app.doc, cur.id) : 0 }));
}

// Properties editor ▸ Tool tab: the same brush panels in the paint modes
onAppReady(() => {
  const tab = propertiesTabs.find((t) => t.id === 'TOOL');
  if (!tab) return;
  const orig = tab.draw;
  tab.draw = (p) => {
    const mode = app.doc.mode;
    return isBrushMode(mode) ? brushPanels(mode) : orig(p);
  };
});

const toolTab = sidebarTabs.find((t) => t.id === 'Tool');
if (toolTab) {
  const orig = toolTab.draw;
  toolTab.draw = (v: View3D) => {
    const mode = app.doc.mode;
    if (!isBrushMode(mode)) return orig(v);
    return brushPanels(mode);
  };
}

// ---------------------------------------------------------------------------
// header menus

const sc = (km: string, op: string, props?: Record<string, unknown>) => {
  const k = (keymaps[km] ?? []).find((x) => !x.inactive && x.op === op && (!props || Object.entries(props).every(([p, v]) => x.props?.[p] === v)));
  return k ? keyLabel(k) : undefined;
};

const vpMenu = (): MenuItem[] => [
  { label: 'Smooth Vertex Colors', op: 'paint.vertex_color_smooth' },
  { label: 'Dirty Vertex Colors', op: 'paint.vertex_color_dirt' },
  { label: 'Vertex Color from Weight', op: 'paint.vertex_color_from_weight' },
  { separator: true },
  { label: 'Invert', op: 'paint.vertex_color_invert' },
  { label: 'Levels', op: 'paint.vertex_color_levels' },
  { label: 'Hue/Saturation/Value', op: 'paint.vertex_color_hsv' },
  { label: 'Brightness/Contrast', op: 'paint.vertex_color_brightness_contrast' },
  { separator: true },
  { label: 'Set Color Attribute', op: 'paint.vertex_color_set', shortcut: 'Ctrl X' },
  { label: 'Sample Color', op: 'paint.sample_color', shortcut: 'Shift X' },
  { label: 'Swap Colors', op: 'paint.brush_colors_flip', shortcut: 'X' },
];

modeMenus.VERTEX_PAINT = {
  ...modeMenus.VERTEX_PAINT,
  header: () => [['Paint', vpMenu]],
  context: vpMenu,
};

export const lockMenu = (): MenuItem[] => {
  const l = (label: string, action: string, mask: string): MenuItem => ({ label, op: 'object.vertex_group_lock', props: { action, mask } });
  return [
    l('Lock All', 'LOCK', 'ALL'),
    l('Lock Selected', 'LOCK', 'SELECTED'),
    l('Lock Unselected', 'LOCK', 'UNSELECTED'),
    l('Lock Only Selected', 'LOCK', 'INVERT_UNSELECTED'),
    l('Lock Only Unselected', 'UNLOCK', 'INVERT_UNSELECTED'),
    { separator: true },
    l('Unlock All', 'UNLOCK', 'ALL'),
    l('Unlock Selected', 'UNLOCK', 'SELECTED'),
    l('Unlock Unselected', 'UNLOCK', 'UNSELECTED'),
    { separator: true },
    l('Invert Locks', 'INVERT', 'ALL'),
  ];
};

const wpMenu = (): MenuItem[] => [
  { label: 'Assign Automatic from Bones', op: 'paint.weight_from_bones', props: { type: 'AUTOMATIC' } },
  { label: 'Assign from Bone Envelopes', op: 'paint.weight_from_bones', props: { type: 'ENVELOPES' } },
  { separator: true },
  { label: 'Normalize All', op: 'object.vertex_group_normalize_all' },
  { label: 'Normalize', op: 'object.vertex_group_normalize' },
  { separator: true },
  { label: 'Mirror', op: 'object.vertex_group_mirror' },
  { label: 'Invert', op: 'object.vertex_group_invert' },
  { label: 'Clean', op: 'object.vertex_group_clean' },
  { separator: true },
  { label: 'Quantize', op: 'object.vertex_group_quantize' },
  { label: 'Levels', op: 'object.vertex_group_levels' },
  { label: 'Smooth', op: 'object.vertex_group_smooth' },
  { label: 'Transfer Weights', op: 'object.data_transfer', props: { use_reverse_transfer: true, data_type: 'VGROUP_WEIGHTS' } },
  { label: 'Limit Total', op: 'object.vertex_group_limit_total' },
  { separator: true },
  { label: 'Set Weight', op: 'paint.weight_set', shortcut: 'Ctrl X' },
  { label: 'Sample Weight', op: 'paint.weight_sample', shortcut: 'Shift X' },
  { label: 'Sample Group', op: 'paint.weight_sample_group', shortcut: 'Shift Ctrl X' },
  { separator: true },
  { label: 'Gradient (Linear)', op: 'paint.weight_gradient', props: { type: 'LINEAR' }, shortcut: 'Shift A' },
  { label: 'Gradient (Radial)', op: 'paint.weight_gradient', props: { type: 'RADIAL' }, shortcut: 'Shift Alt A' },
  { separator: true },
  { label: 'Locks', submenu: lockMenu },
];

modeMenus.WEIGHT_PAINT = {
  ...modeMenus.WEIGHT_PAINT,
  header: () => [['Weights', wpMenu]],
  // the vertex group being painted
  headerExtra: () => {
    const am = activeMeshData();
    if (!am || !am.me.vertex_groups.length) return null;
    return h(
      'div',
      { key: 'wp-group', style: { width: '130px', flex: 'none', marginLeft: '8px' } },
      enumMenu(
        'hdr-wp-group',
        am.me.vertex_groups.map((g, i) => ({ value: String(i), label: g.name, icon: 'group_vertex' })),
        String(am.ob.vertex_group_active_index ?? 0),
        (x) => ((am.ob.vertex_group_active_index = Number(x)), invalidatePaintAttributes(), app.pushUndo('Active Vertex Group'), app.changed('doc')),
        { tip: 'Vertex group to paint' },
      ),
    );
  },
};

modeMenus.TEXTURE_PAINT = {
  ...modeMenus.TEXTURE_PAINT,
  header: () => [
    [
      'Paint',
      () => [
        { label: 'Add Texture Paint Slot', op: 'paint.add_texture_paint_slot' },
        { label: 'Add Simple UVs', op: 'paint.add_simple_uvs' },
        { label: 'Image from View', op: 'paint.image_from_view' },
        { label: 'Project Image', op: 'paint.project_image' },
        { separator: true },
        {
          label: 'Sample Color',
          op: 'paint.sample_color',
          shortcut: 'Shift X',
        },
        { label: 'Swap Colors', op: 'paint.brush_colors_flip', shortcut: 'X' },
      ],
    ],
  ],
};

// ---------------------------------------------------------------------------
// operators used by keys / menus

function pointerIn(v: View3D, ev?: { x: number; y: number }) {
  const r = v.el.getBoundingClientRect();
  const x = (ev?.x ?? app.pointer.x) - r.left,
    y = (ev?.y ?? app.pointer.y) - r.top;
  return { x, y };
}

let previousBrush: Record<string, string> = {};

registerOperators([
  {
    idname: 'paint.brush_select',
    label: 'Select Brush',
    props: [
      { id: 'brush', label: 'Brush', type: 'string', default: '' },
      { id: 'toggle', label: 'Toggle', type: 'bool', default: false },
    ],
    undo: false,
    internal: true,
    poll: () => isBrushMode(app.doc.mode),
    exec: (_ctx, p) => {
      const mode = app.doc.mode;
      const id = p.brush as string;
      if (!app.doc.brushes[id] && !id.startsWith('builtin.')) return 'CANCELLED';
      const cur = activeTools[mode];
      if (p.toggle && cur === id && previousBrush[mode]) setActiveTool(previousBrush[mode]);
      else {
        if (cur !== id) previousBrush[mode] = cur;
        setActiveTool(id);
      }
      changed();
    },
  },
  {
    idname: 'paint.brush_colors_flip',
    label: 'Swap Colors',
    description: 'Swap primary and secondary brush colors',
    undo: false,
    poll: () => app.doc.mode === 'VERTEX_PAINT' || app.doc.mode === 'TEXTURE_PAINT' || app.doc.mode === 'SCULPT',
    exec: () => {
      const up = app.doc.scene.tool_settings.unified_paint;
      const c = up.color;
      up.color = up.secondary_color;
      up.secondary_color = c;
      changed();
    },
  },
  {
    idname: 'paint.sample_color',
    label: 'Sample Color',
    description: 'Use the color under the cursor as the brush color',
    undo: false,
    poll: () => (app.doc.mode === 'TEXTURE_PAINT' || app.doc.mode === 'VERTEX_PAINT' || (app.doc.mode === 'SCULPT' && !!activeMeshData()?.me.color_attributes.length)) && !!activeView3D(),
    exec: (ctx) => {
      const v = activeView3D()!;
      const p = pointerIn(v, ctx.event);
      const ok = app.doc.mode === 'TEXTURE_PAINT' ? sampleImageColor(v, p.x, p.y) : sampleVertexColor(v, p.x, p.y);
      if (!ok) return 'CANCELLED';
      changed();
    },
  },
  {
    idname: 'paint.weight_sample',
    label: 'Sample Weight',
    description: 'Use the weight of the active group under the cursor as the brush weight',
    undo: false,
    poll: () => app.doc.mode === 'WEIGHT_PAINT' && !!activeView3D(),
    exec: (ctx) => {
      const v = activeView3D()!;
      const p = pointerIn(v, ctx.event);
      const w = sampleWeight(v, p.x, p.y);
      if (w === null) return 'CANCELLED';
      app.doc.scene.tool_settings.unified_paint.weight = w;
      app.report('INFO', `Weight: ${w.toFixed(3)}`);
      changed();
    },
  },
]);

// ---------------------------------------------------------------------------
// keymaps (dispatched from the viewport before the generic 3D View keys)

const sculptMode = () => app.doc.mode === 'SCULPT';
const brushKey = (key: string, brush: string, mods: Partial<KeyItem> = {}): KeyItem => ({
  key,
  op: 'paint.brush_select',
  props: { brush, ...(brush === 'brush_mask' ? { toggle: true } : {}) },
  ...mods,
});
const common = (extra: KeyItem[] = []): KeyItem[] => [
  { key: 'F', op: 'wm.radial_control', props: { data: 'size' } },
  { key: 'F', ctrl: true, op: 'wm.radial_control', props: { data: 'angle' }, when: () => app.doc.mode !== 'WEIGHT_PAINT' },
  {
    key: 'F',
    shift: true,
    op: 'wm.radial_control',
    props: { data: 'strength' },
  },
  { key: 'LEFT_BRACKET', op: 'brush.scale_size', props: { scalar: 0.9 } },
  { key: 'RIGHT_BRACKET', op: 'brush.scale_size', props: { scalar: 1 / 0.9 } },
  ...extra,
];

addKeys('Sculpt', [
  ...common([
    { key: 'X', op: 'paint.brush_colors_flip' },
    { key: 'X', shift: true, op: 'paint.sample_color' },
    { key: 'X', ctrl: true, op: 'sculpt.color_filter', props: { type: 'FILL', strength: 1, use_immediate: true } },
    brushKey('V', 'brush_draw'),
    brushKey('S', 'brush_smooth'),
    brushKey('P', 'brush_pinch'),
    brushKey('I', 'brush_inflate'),
    brushKey('G', 'brush_grab'),
    brushKey('T', 'brush_scrape', { shift: true }),
    brushKey('C', 'brush_clay_strips'),
    brushKey('C', 'brush_crease', { shift: true }),
    brushKey('K', 'brush_snake_hook'),
    brushKey('M', 'brush_mask'),
    {
      key: 'M',
      alt: true,
      op: 'paint.mask_flood_fill',
      props: { mode: 'VALUE', value: 0 },
    },
    {
      key: 'I',
      ctrl: true,
      op: 'paint.mask_flood_fill',
      props: { mode: 'INVERT' },
    },
    { key: 'B', op: 'paint.mask_box_gesture' },
    { key: 'R', ctrl: true, op: 'object.voxel_remesh' },
    { key: 'A', menu: () => maskPieAsMenu(), menuTitle: 'Mask Edit' },
  ]).map((k) => ({ ...k, when: sculptMode })),
]);
addKeys('Vertex Paint', [
  ...common([
    { key: 'X', shift: true, ctrl: true, op: 'paint.sample_color' },
    { key: 'X', op: 'paint.brush_colors_flip' },
    { key: 'X', shift: true, op: 'paint.sample_color' },
    { key: 'X', ctrl: true, op: 'paint.vertex_color_set' },
  ]),
]);
addKeys('Weight Paint', [
  ...common([
    { key: 'X', shift: true, ctrl: true, op: 'paint.weight_sample_group' },
    { key: 'A', shift: true, op: 'paint.weight_gradient', props: { type: 'LINEAR' } },
    { key: 'A', shift: true, alt: true, op: 'paint.weight_gradient', props: { type: 'RADIAL' } },
    { key: 'K', menu: () => lockPie(), menuTitle: 'Vertex Group Locks' },
    {
      key: 'F',
      ctrl: true,
      op: 'wm.radial_control',
      props: { data: 'weight' },
    },
    { key: 'X', shift: true, op: 'paint.weight_sample' },
    { key: 'X', ctrl: true, op: 'paint.weight_set' },
  ]),
]);
addKeys('Image Paint', [
  ...common([
    { key: 'X', shift: true, ctrl: true, op: 'paint.sample_color' },
    { key: 'X', op: 'paint.brush_colors_flip' },
    { key: 'X', shift: true, op: 'paint.sample_color' },
  ]),
]);

/** Mask pie (A): shown as a pie around the pointer. */
function maskPieAsMenu(): MenuItem[] {
  openPie(
    'Mask Edit',
    [
      {
        label: 'Invert Mask',
        op: 'paint.mask_flood_fill',
        props: { mode: 'INVERT' },
      },
      {
        label: 'Clear Mask',
        op: 'paint.mask_flood_fill',
        props: { mode: 'VALUE', value: 0 },
      },
      {
        label: 'Smooth Mask',
        op: 'sculpt.mask_filter',
        props: { filter_type: 'SMOOTH' },
      },
      {
        label: 'Sharpen Mask',
        op: 'sculpt.mask_filter',
        props: { filter_type: 'SHARPEN' },
      },
      {
        label: 'Grow Mask',
        op: 'sculpt.mask_filter',
        props: { filter_type: 'GROW' },
      },
      {
        label: 'Shrink Mask',
        op: 'sculpt.mask_filter',
        props: { filter_type: 'SHRINK' },
      },
      {
        label: 'Increase Contrast',
        op: 'sculpt.mask_filter',
        props: { filter_type: 'CONTRAST_INCREASE' },
      },
      {
        label: 'Decrease Contrast',
        op: 'sculpt.mask_filter',
        props: { filter_type: 'CONTRAST_DECREASE' },
      },
    ],
    app.pointer.x,
    app.pointer.y,
    'A',
  );
  return [];
}

const KEYMAP_OF: Record<BrushMode, string> = {
  SCULPT: 'Sculpt',
  VERTEX_PAINT: 'Vertex Paint',
  WEIGHT_PAINT: 'Weight Paint',
  TEXTURE_PAINT: 'Image Paint',
};
/** Generic 3D View keys that act on objects and must not fire in paint modes. */
const BLOCKED = new Set(['G', 'R', 'S', 'B', 'C', 'W', 'A', 'I', 'K', 'M', 'H', 'X', 'DEL']);

function matchKey(k: KeyItem, name: string, e: KeyboardEvent) {
  if (k.key !== name || k.inactive || (k.value ?? 'PRESS') !== 'PRESS') return false;
  if (k.any) return true;
  const ctrl = e.ctrlKey || e.metaKey;
  return !!k.shift === e.shiftKey && !!k.ctrl === ctrl && !!k.alt === e.altKey;
}

function paintKey(v: View3D, e: KeyboardEvent): boolean {
  const mode = app.doc.mode;
  if (!isBrushMode(mode)) return false;
  const name = keyName(e);
  if (e.repeat && name !== 'LEFT_BRACKET' && name !== 'RIGHT_BRACKET') return BLOCKED.has(name);
  const first = paintHooks.priorityKeymaps.filter((k) => k.active()).flatMap((k) => keymaps[k.name] ?? []);
  for (const k of [...first, ...(keymaps[KEYMAP_OF[mode]] ?? [])]) {
    if (!matchKey(k, name, e)) continue;
    if (k.when && !k.when()) continue;
    if (k.menu) {
      // pies open themselves and return no items; plain menus open at the pointer
      const items = k.menu();
      if (items.length) openMenu(items, { x: app.pointer.x, y: app.pointer.y }, { title: k.menuTitle });
      return true;
    }
    if (!k.op || !app.poll(k.op, v.area as never)) continue;
    app.run(k.op, k.props ?? {}, {
      event: { x: app.pointer.x, y: app.pointer.y },
    });
    return true;
  }
  // swallow plain object-mode keys (transform, select tools) that would act on the object
  return !e.ctrlKey && !e.metaKey && !e.altKey && BLOCKED.has(name);
}

/** Keys of the Texture Paint keymap in the Image Editor's Paint mode. */
export function imagePaintKey(e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return false;
  const name = keyName(e);
  for (const k of keymaps['Image Paint'] ?? []) {
    if (k.inactive || !matchKey(k, name, e)) continue;
    if (k.when && !k.when()) continue;
    if (k.menu) {
      const items = k.menu();
      if (items.length) openMenu(items, { x: app.pointer.x, y: app.pointer.y }, { title: k.menuTitle });
      return true;
    }
    if (!k.op || !app.poll(k.op)) continue;
    app.run(k.op, k.props ?? {}, { event: { x: app.pointer.x, y: app.pointer.y } });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// viewport hooks

editModeHooks.pointer.push((v, e) => {
  const mode = app.doc.mode;
  if (!isBrushMode(mode)) return false;
  const ob = app.activeObject;
  if (!ob || ob.type !== 'MESH') return false;
  const tool = activeTools[mode];
  if (mode !== 'SCULPT' && isSelectTool(tool)) {
    // select tools pick faces / vertices while a selection mask is on (handled by the viewport)
    if (faceMaskOn() || vertMaskOn()) return false;
    setActiveTool(BRUSH_LISTS[mode].find((b) => !!b)!.id);
  }
  if (mode === 'SCULPT' && tool?.startsWith('builtin.') && !gestureTools[tool]) sculptToolSlots((op) => operators.has(op));
  if (mode === 'SCULPT' && gestureTools[tool]) return gestureToolPointer(v, e, tool);
  if (mode === 'SCULPT' && sculptToolHooks.pointer.some((f) => f(v, e, tool))) return true;
  if (mode === 'WEIGHT_PAINT' && tool === 'builtin.sample_weight') {
    app.run('paint.weight_sample', {}, { event: { x: e.clientX, y: e.clientY } });
    return true;
  }
  if (mode === 'WEIGHT_PAINT' && tool === 'builtin.sample_vertex_group') {
    app.run('paint.weight_sample_group', {}, { event: { x: e.clientX, y: e.clientY } });
    return true;
  }
  if (mode === 'WEIGHT_PAINT' && tool === 'builtin.gradient') {
    const am = activeMeshData();
    if (am && !am.me.vertex_groups.length) ensureActiveGroup(am.ob, am.me);
    startGradient(v, { type: gradientTool.type }, e);
    return true;
  }
  if (mode === 'SCULPT' && e.shiftKey && (e.ctrlKey || e.metaKey) && operators.has('paint.mask_lasso_gesture')) {
    // Shift+Ctrl+drag: lasso mask (with Alt: unmask)
    return startGesture(v, { op: 'paint.mask_lasso_gesture', kind: 'LASSO', props: { value: e.altKey ? 0 : 1 }, label: 'Lasso Mask' }, e);
  }
  return brushStroke(v, e);
});



/**
 * Start a stroke of the active brush of the current paint mode at a pointer press (Ctrl inverts,
 * Shift smooths / blurs, Alt masks in Sculpt Mode). Returns true when the press was used.
 */
export function brushStroke(v: View3D, e: PointerEvent, live = true): boolean {
  const mode = app.doc.mode;
  lastStrokeStarted = false;
  if (live) for (const f of paintHooks.brushPointer) if (f(v, e)) return true;
  if (mode === 'SCULPT' && e.altKey) {
    // Alt: temporary Mask brush (keeps the current radius); Ctrl+Alt removes mask
    const mb = brushById('brush_mask');
    const cur = activeBrush('SCULPT');
    if (mb) {
      lastStrokeStarted = sculptStroke(v, e, { ...mb, radius: cur?.radius ?? mb.radius, mask_tool: 'DRAW' });
      return true;
    }
  }
  const sb = mode === 'SCULPT' ? activeBrush('SCULPT') : null;
  if (sb && (sb.sculpt_tool === 'PAINT' || sb.sculpt_tool === 'SMEAR')) {
    // painting in Sculpt Mode shows the color attribute in solid shading
    if (v.shading.type === 'SOLID' && v.shading.color_type !== 'VERTEX') {
      v.shading.color_type = 'VERTEX';
      app.report('INFO', 'Viewport color set to Attribute to show the painted colors');
    }
    lastStrokeStarted = vertexPaintStroke(v, e, sb);
  } else if (mode === 'SCULPT' && activeBrush('SCULPT')?.sculpt_tool === 'DRAW_FACE_SETS') lastStrokeStarted = faceSetStroke(v, e, activeBrush('SCULPT')!) !== false;
  else if (mode === 'SCULPT') lastStrokeStarted = sculptStroke(v, e);
  else if (mode === 'VERTEX_PAINT') lastStrokeStarted = vertexPaintStroke(v, e);
  else if (mode === 'WEIGHT_PAINT') {
    const am = activeMeshData();
    if (am && !am.me.vertex_groups.length) {
      ensureActiveGroup(am.ob, am.me);
      invalidatePaintAttributes();
    }
    lastStrokeStarted = weightPaintStroke(v, e);
  } else lastStrokeStarted = texturePaintStroke(v, e);
  return true;
}

/** Whether the last `brushStroke` call actually started a stroke (it hit the mesh). */
export let lastStrokeStarted = false;
paintHooks.startStroke = (v, e) => brushStroke(v, e, false) && lastStrokeStarted;

// clone source marker
editModeHooks.svg.push((v) => {
  if (app.doc.mode !== 'TEXTURE_PAINT' || activeBrush('TEXTURE_PAINT')?.sculpt_tool !== 'CLONE' || !cloneSource.world) return null;
  const q = v.project(cloneSource.world);
  if (q.z < -1 || q.z > 1) return null;
  return h(
    'g',
    { key: 'clone-src', 'pointer-events': 'none' },
    h('circle', { cx: q.x, cy: q.y, r: 7, fill: 'none', stroke: '#000000', 'stroke-width': 3, opacity: 0.5 }),
    h('circle', { cx: q.x, cy: q.y, r: 7, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.3 }),
    h('path', { d: `M${q.x - 11} ${q.y}h22M${q.x} ${q.y - 11}v22`, stroke: '#ffffff', 'stroke-width': 1 }),
  ) as VNode;
});

editModeHooks.hover.push((v, e) => {
  if (!isBrushMode(app.doc.mode)) {
    if (v.el.style.cursor === 'crosshair') v.el.style.cursor = '';
    if (cursorState.inside) {
      cursorState.inside = false;
      cursorState.hit = null;
    }
    return;
  }
  v.el.style.cursor = 'crosshair';
  if (strokeActive()) return;
  const p = v.local(e);
  if ((e.target as HTMLElement).closest?.('.v3d-ui')) {
    if (cursorState.inside) {
      cursorState.inside = false;
      v.drawSvg();
    }
    return;
  }
  updateCursor(v, p.x, p.y);
});

/** Brush settings popover (right-click / W). */
function brushPopover(x: number, y: number) {
  const mode = app.doc.mode as BrushMode;
  openPopover({ x, y }, () => h('div', { class: 'pop-panel' }, h('div', { class: 'pop-title' }, brushInfo(activeBrush(mode)?.id ?? '')?.name ?? 'Brush'), toolHeaderSettingsColumn(mode)), { width: 240 });
}

editModeHooks.context.push((v, e) => {
  if (!isBrushMode(app.doc.mode)) return false;
  brushPopover(e.clientX, e.clientY);
  void v;
  return true;
});

for (const km of ['Sculpt', 'Vertex Paint', 'Weight Paint', 'Image Paint'])
  addKeys(km, [
    {
      key: 'W',
      menu: () => {
        brushPopover(app.pointer.x, app.pointer.y);
        return [];
      },
      when: () => isBrushMode(app.doc.mode),
    },
  ]);

function toolHeaderSettingsColumn(mode: BrushMode): Child {
  const b = activeBrush(mode);
  if (!b) return null;
  return [
    mode === 'VERTEX_PAINT' || mode === 'TEXTURE_PAINT' ? colorFields('ctx-col') : null,
    mode === 'WEIGHT_PAINT' ? weightField('ctx-w') : null,
    radiusField(b, 'ctx-r'),
    strengthField(b, 'ctx-s'),
    mode === 'SCULPT' ? directionToggle(b) : null,
  ];
}

viewportExtensions.push((v) => {
  const orig = v.onKey.bind(v);
  v.onKey = (e: KeyboardEvent) => paintKey(v, e) || orig(e);
  const leave = () => {
    if (cursorState.view === v && cursorState.inside) {
      cursorState.inside = false;
      v.drawSvg();
    }
  };
  v.el.addEventListener('pointerleave', leave);
  return () => {
    v.el.removeEventListener('pointerleave', leave);
    v.onKey = orig;
  };
});

function lockPie(): MenuItem[] {
  const l = (label: string, action: string, mask: string) => ({ label, op: 'object.vertex_group_lock', props: { action, mask } });
  openPie(
    'Vertex Group Locks',
    [l('Lock All', 'LOCK', 'ALL'), l('Unlock All', 'UNLOCK', 'ALL'), l('Unlock Selected', 'UNLOCK', 'SELECTED'), l('Lock Selected', 'LOCK', 'SELECTED'), l('Lock Unselected', 'LOCK', 'UNSELECTED'), l('Lock Only Selected', 'LOCK', 'INVERT_UNSELECTED'), l('Lock Only Unselected', 'UNLOCK', 'INVERT_UNSELECTED'), l('Invert Locks', 'INVERT', 'ALL')],
    app.pointer.x,
    app.pointer.y,
    'K',
  );
  return [];
}

/** Stroke methods offered per mode (anchored / drag dot need a mode that can undo dabs). */
export function strokeMethods(mode: BrushMode): [string, string][] {
  const all: [string, string][] = [
    ['DOTS', 'Dots'],
    ['DRAG_DOT', 'Drag Dot'],
    ['SPACE', 'Space'],
    ['AIRBRUSH', 'Airbrush'],
    ['ANCHORED', 'Anchored'],
    ['LINE', 'Line'],
    ['CURVE', 'Curve'],
  ];
  return mode === 'SCULPT' ? all : all.filter(([m]) => m !== 'ANCHORED' && m !== 'DRAG_DOT');
}

registerOperators([
  {
    idname: 'paint.brush_stroke_method_set',
    label: 'Set Stroke Method',
    description: 'Choose how the dabs of the active brush are placed along the stroke',
    props: [{ id: 'method', label: 'Stroke Method', type: 'enum', default: 'SPACE', items: [['DOTS', 'Dots'], ['DRAG_DOT', 'Drag Dot'], ['SPACE', 'Space'], ['AIRBRUSH', 'Airbrush'], ['ANCHORED', 'Anchored'], ['LINE', 'Line'], ['CURVE', 'Curve']] }],
    undo: false,
    poll: () => isBrushMode(app.doc.mode) && !!activeBrush(app.doc.mode as BrushMode),
    exec: (_c, p) => {
      const mode = app.doc.mode as BrushMode;
      if (!strokeMethods(mode).some(([m]) => m === p.method)) return 'CANCELLED';
      activeBrush(mode)!.stroke_method = p.method as PaintBrush['stroke_method'];
      changed();
    },
  },
  {
    idname: 'paint.brush_smooth_stroke_toggle',
    label: 'Toggle Stabilize Stroke',
    description: 'Let the brush trail behind the pointer for smoother lines',
    undo: false,
    poll: () => isBrushMode(app.doc.mode) && !!activeBrush(app.doc.mode as BrushMode),
    exec: () => {
      const b = activeBrush(app.doc.mode as BrushMode)!;
      b.use_smooth_stroke = !b.use_smooth_stroke;
      app.report('INFO', `Stabilize Stroke ${b.use_smooth_stroke ? 'on' : 'off'}`);
      changed();
    },
  },
]);

function strokeMethodMenu(): MenuItem[] {
  const mode = app.doc.mode as BrushMode;
  const cur = activeBrush(mode)?.stroke_method ?? 'SPACE';
  return strokeMethods(mode).map(([m, label]) => ({ label, active: cur === m, op: 'paint.brush_stroke_method_set', props: { method: m } }));
}
for (const km of ['Sculpt', 'Vertex Paint', 'Weight Paint', 'Image Paint'])
  addKeys(km, [
    { key: 'E', alt: true, menu: strokeMethodMenu, menuTitle: 'Stroke Method', when: () => isBrushMode(app.doc.mode) },
    { key: 'S', shift: true, op: 'paint.brush_smooth_stroke_toggle', when: () => isBrushMode(app.doc.mode) },
  ]);

setImageCanvasSource((img) => {
  const c = imageCanvas(img);
  return imageReady(img) ? c : null;
});
