// Compositor node types (tree type COMPOSITOR): registration from the generated interface data,
// dynamic socket availability, panels, value ranges and the Add menu. Shader nodes shared with
// the compositor (Math, Map Range, Mix, Color Ramp, …) get the COMPOSITOR tree type added.
import type { NodeData } from '../../data/types';
import { app } from '../../app/app';
import { h } from '../../ui/h';
import { icon } from '../../ui/icons';
import { getNodeType, propValue, registerNodeMenu, registerNodeType } from '../../nodes/registry';
import { groupNodeIdnames, makeGroupNodeType } from '../../nodes/common';
import type { MenuCategory, MenuEntry, NodeClass, NodePanelDef, NodeTypeDef, SocketDef, TreeType } from '../../nodes/types';
import { defaultCurves, defaultRamp } from '../../nodes/curves';
import { COMPOSITOR_NODE_DATA } from './data.gen';
import { socketFromCompRaw } from './raw';

const CMP: TreeType[] = ['COMPOSITOR'];
const p = (n: NodeData, id: string) => propValue(n, id) as string;
/** current value of a MENU input socket */
export function menuValue(n: NodeData, id: string, def: NodeTypeDef | undefined = getNodeType(n.type)): string {
  const v = n.inputs[id];
  if (typeof v === 'string') return v;
  return String(def?.inputs.find((s) => s.identifier === id)?.default ?? '');
}

/** Socket value ranges (the interface dump does not include them). */
const RANGES: Record<string, Record<string, [number?, number?]>> = {
  '*': {},
  CompositorNodeBrightContrast: { Bright: [-100, 100], Contrast: [-100, 100] },
  CompositorNodeExposure: { Exposure: [-10, 10] },
  CompositorNodeHueSat: { Hue: [0, 1], Saturation: [0, 2], Value: [0, 2] },
  CompositorNodeColorBalance: {
    'Base Lift': [-1, 1],
    'Base Gamma': [0, 2],
    'Base Gain': [0, 2],
    'Base Offset': [-1, 1],
    'Base Power': [0, 2],
    'Base Slope': [0, 2],
    'Input Temperature': [1800, 100000],
    'Output Temperature': [1800, 100000],
    'Input Tint': [-150, 150],
    'Output Tint': [-150, 150],
  },
  CompositorNodeColorCorrection: {
    'Master Saturation': [0, 4],
    'Master Contrast': [0, 4],
    'Master Gamma': [0, 4],
    'Master Gain': [0, 4],
    'Master Offset': [-1, 1],
    'Highlights Saturation': [0, 4],
    'Highlights Contrast': [0, 4],
    'Highlights Gamma': [0, 4],
    'Highlights Gain': [0, 4],
    'Highlights Offset': [-1, 1],
    'Midtones Saturation': [0, 4],
    'Midtones Contrast': [0, 4],
    'Midtones Gamma': [0, 4],
    'Midtones Gain': [0, 4],
    'Midtones Offset': [-1, 1],
    'Shadows Saturation': [0, 4],
    'Shadows Contrast': [0, 4],
    'Shadows Gamma': [0, 4],
    'Shadows Gain': [0, 4],
    'Shadows Offset': [-1, 1],
    'Midtones Start': [0, 1],
    'Midtones End': [0, 1],
  },
  CompositorNodeBlur: { Size: [0, undefined] },
  CompositorNodeBilateralblur: { Size: [0, 128], Threshold: [0, undefined] },
  CompositorNodeBokehBlur: { Size: [0, undefined], Mask: [0, 1] },
  CompositorNodeGlare: {
    'Highlights Threshold': [0, undefined],
    'Maximum Highlights': [0, undefined],
    Strength: [0, 1],
    Saturation: [0, 1],
    Size: [0, 1],
    Streaks: [1, 16],
    Iterations: [2, 5],
    Fade: [0.75, 1],
    'Color Modulation': [0, 1],
    Jitter: [0, 1],
    'Highlights Smoothness': [0, 1],
  },
  CompositorNodeLensdist: { Distortion: [-0.999, 1], Dispersion: [0, 1] },
  CompositorNodeDilateErode: {
    Size: [-5000, 5000],
    'Falloff Size': [0, undefined],
  },
  CompositorNodeDBlur: {
    Samples: [1, 32],
    Scale: [0, 20],
    'Translation Amount': [-1, 1],
  },
  CompositorNodePixelate: { Size: [1, undefined] },
  CompositorNodePosterize: { Steps: [2, 1024] },
  CompositorNodeKuwahara: {
    Size: [0, undefined],
    Uniformity: [0, 50],
    Sharpness: [0, 1],
    Eccentricity: [0, 2],
  },
  CompositorNodeDespeckle: {
    'Color Threshold': [0, undefined],
    'Neighbor Threshold': [0, 1],
  },
  CompositorNodeBokehImage: {
    Flaps: [3, 24],
    Roundness: [0, 1],
    'Catadioptric Size': [0, 1],
    'Color Shift': [-1, 1],
  },
  CompositorNodeTonemap: {
    Key: [0, 1],
    Balance: [0.001, 10],
    Gamma: [0.001, 3],
    Intensity: [-8, 8],
    Contrast: [0, 1],
    'Light Adaptation': [0, 1],
    'Chromatic Adaptation': [0, 1],
  },
  CompositorNodeCrop: {
    X: [0, undefined],
    Y: [0, undefined],
    Width: [0, undefined],
    Height: [0, undefined],
  },
  CompositorNodeScale: { X: [0.0001, undefined], Y: [0.0001, undefined] },
  CompositorNodeTransform: { Scale: [0.0001, undefined] },
  CompositorNodeTime: {},
  CompositorNodeLumaMatte: { Minimum: [0, 1], Maximum: [0, 1] },
  CompositorNodeDistanceMatte: { Tolerance: [0, 1], Falloff: [0, 1] },
  CompositorNodeDiffMatte: { Tolerance: [0, 1], Falloff: [0, 1] },
  CompositorNodeChromaMatte: {
    Minimum: [0, Math.PI / 2],
    Maximum: [0, Math.PI / 2],
    Falloff: [0, 1],
  },
  CompositorNodeColorMatte: { Hue: [0, 1], Saturation: [0, 1], Value: [0, 1] },
  CompositorNodeChannelMatte: { Minimum: [0, 1], Maximum: [0, 1] },
  CompositorNodeColorSpill: { 'Limit Strength': [0, 2] },
  CompositorNodeZcombine: {},
  CompositorNodeAntiAliasing: {
    Threshold: [0, 1],
    'Contrast Limit': [0, undefined],
    'Corner Rounding': [0, 1],
  },
};

/** Collapsible panels (socket identifiers in display order). */
const SAMPLING: NodePanelDef = {
  name: 'Sampling',
  inputs: ['Interpolation', 'Extension X', 'Extension Y'],
  closed: true,
};
const PANELS: Record<string, NodePanelDef[]> = {
  CompositorNodeGlare: [
    {
      name: 'Highlights',
      inputs: ['Highlights Threshold', 'Highlights Smoothness', 'Clamp Highlights', 'Maximum Highlights'],
      closed: true,
    },
    { name: 'Adjust', inputs: ['Strength', 'Saturation', 'Tint'] },
    {
      name: 'Glare',
      inputs: ['Size', 'Streaks', 'Streaks Angle', 'Iterations', 'Fade', 'Color Modulation', 'Diagonal Star', 'Sun Position', 'Jitter', 'Kernel Data Type', 'Float Kernel', 'Color Kernel'],
    },
  ],
  CompositorNodeTranslate: [SAMPLING],
  CompositorNodeRotate: [SAMPLING],
  CompositorNodeScale: [SAMPLING],
  CompositorNodeTransform: [SAMPLING],
  CompositorNodeDisplace: [SAMPLING],
  CompositorNodeMapUV: [SAMPLING],
  CompositorNodeCornerPin: [SAMPLING],
  CompositorNodeColorCorrection: [
    {
      name: 'Master',
      inputs: ['Master Saturation', 'Master Contrast', 'Master Gamma', 'Master Gain', 'Master Offset'],
    },
    {
      name: 'Highlights',
      inputs: ['Highlights Saturation', 'Highlights Contrast', 'Highlights Gamma', 'Highlights Gain', 'Highlights Offset'],
      closed: true,
    },
    {
      name: 'Midtones',
      inputs: ['Midtones Saturation', 'Midtones Contrast', 'Midtones Gamma', 'Midtones Gain', 'Midtones Offset'],
      closed: true,
    },
    {
      name: 'Shadows',
      inputs: ['Shadows Saturation', 'Shadows Contrast', 'Shadows Gamma', 'Shadows Gain', 'Shadows Offset'],
      closed: true,
    },
    {
      name: 'Tonal Range',
      inputs: ['Midtones Start', 'Midtones End'],
      closed: true,
    },
    {
      name: 'Channels',
      inputs: ['Apply On Red', 'Apply On Green', 'Apply On Blue'],
      closed: true,
    },
  ],
  CompositorNodeKeying: [],
};

function applyRanges(idname: string, sockets: SocketDef[]) {
  const r = RANGES[idname] ?? {};
  for (const s of sockets) {
    const range = r[s.identifier];
    if (range) {
      if (range[0] !== undefined) s.min = range[0];
      if (range[1] !== undefined) s.max = range[1];
    } else if (s.subtype === 'FACTOR' && (s.type === 'FLOAT' || s.type === 'VECTOR')) {
      s.min = 0;
      s.max = 1;
    } else if (s.subtype === 'PIXEL' && s.type === 'INT' && s.min === undefined && idname !== 'CompositorNodeDilateErode') s.min = 0;
  }
}

export function cdef(idname: string, category: NodeClass, extra: Partial<NodeTypeDef> = {}): NodeTypeDef {
  const raw = COMPOSITOR_NODE_DATA[idname];
  if (!raw) throw new Error(`missing compositor node data ${idname}`);
  const def: NodeTypeDef = {
    idname,
    label: raw.label,
    width: raw.width,
    category,
    treeTypes: CMP,
    inputs: raw.inputs.map(socketFromCompRaw),
    outputs: raw.outputs.map(socketFromCompRaw),
    props: raw.props.map((x) => ({ ...x })),
    ...extra,
  };
  applyRanges(idname, def.inputs);
  if (PANELS[idname]) def.panels = PANELS[idname];
  registerNodeType(def);
  return def;
}

function setProp(d: NodeTypeDef, id: string, patch: Partial<NodeTypeDef['props'][number]>) {
  const pr = d.props.find((x) => x.id === id);
  if (pr) Object.assign(pr, patch);
}

/** Availability from MENU sockets / props: map socket identifier → predicate. */
function availability(d: NodeTypeDef, rules: Record<string, (n: NodeData) => boolean>) {
  d.available = (n, s, out) => {
    const r = rules[(out ? 'out:' : '') + s.identifier];
    return r ? r(n) : !s.disabled;
  };
}

// ---------------------------------------------------------------------------
// Input

{
  const d = cdef('CompositorNodeRLayers', 'input', {
    description: 'Input render passes of the scene',
  });
  // scene / view layer (one of each here) and a button rendering the scene
  d.bodyHeight = () => 48;
  d.drawBody = () =>
    h(
      'div',
      { class: 'cmp-rl-body' },
      h('div', { class: 'cmp-rl-row' }, icon('scene_data'), h('span', null, app.doc.scene.name)),
      h(
        'div',
        { class: 'cmp-rl-row' },
        icon('view_layer'),
        h('span', null, 'ViewLayer'),
        h(
          'button',
          {
            class: 'cmp-rl-render',
            'data-tip': 'Render\nRender the active scene',
            onclick: () => app.run('render.render'),
          },
          icon('render'),
        ),
      ),
    );
  // all supported passes; availability follows the View Layer ▸ Passes settings
  d.outputs = [
    { name: 'Image', identifier: 'Image', type: 'RGBA' },
    { name: 'Alpha', identifier: 'Alpha', type: 'FLOAT' },
    { name: 'Depth', identifier: 'Depth', type: 'FLOAT' },
    { name: 'Normal', identifier: 'Normal', type: 'VECTOR' },
    { name: 'Mist', identifier: 'Mist', type: 'FLOAT' },
  ];
  d.available = (_n, s, out) => {
    if (!out) return true;
    const r = app?.doc?.scene.render;
    if (!r) return true;
    if (s.identifier === 'Depth') return !!r.use_pass_z;
    if (s.identifier === 'Normal') return !!r.use_pass_normal;
    if (s.identifier === 'Mist') return !!r.use_pass_mist;
    if (s.identifier === 'IndexOB') return !!r.use_pass_object_index;
    if (s.identifier === 'Vector') return !!r.use_pass_vector;
    if (s.identifier === 'IndexMA') return !!r.use_pass_material_index;
    if (s.identifier === 'Position') return !!r.use_pass_position;
    if (s.identifier === 'UV') return !!r.use_pass_uv;
    if (s.identifier === 'DiffCol') return !!r.use_pass_diffuse_color;
    if (s.identifier === 'Emit') return !!r.use_pass_emit;
    return true;
  };
  d.outputs.push(
    { name: 'Position', identifier: 'Position', type: 'VECTOR' },
    { name: 'Vector', identifier: 'Vector', type: 'VECTOR', dimensions: 4 },
    { name: 'UV', identifier: 'UV', type: 'VECTOR' },
    { name: 'DiffCol', identifier: 'DiffCol', type: 'RGBA' },
    { name: 'Emit', identifier: 'Emit', type: 'RGBA' },
    { name: 'IndexOB', identifier: 'IndexOB', type: 'FLOAT' },
    { name: 'IndexMA', identifier: 'IndexMA', type: 'FLOAT' },
  );
  // shader AOVs and cryptomatte layers follow the View Layer settings
  d.dynamicSockets = (n, ctx) => {
    const r = ctx.doc.scene.render;
    const outputs = [...d.outputs];
    for (const a of r.aovs ?? []) if (a.name) outputs.push({ name: a.name, identifier: `AOV ${a.name}`, type: a.type === 'VALUE' ? 'FLOAT' : 'RGBA' });
    const depth = Math.max(2, Math.min(16, Math.round(r.pass_cryptomatte_depth ?? 6)));
    for (const [layer, on] of [
      ['CryptoObject', r.use_pass_cryptomatte_object],
      ['CryptoMaterial', r.use_pass_cryptomatte_material],
      ['CryptoAsset', r.use_pass_cryptomatte_asset],
    ] as const)
      if (on) for (let i = 0; i < Math.ceil(depth / 2); i++) outputs.push({ name: `${layer}${String(i).padStart(2, '0')}`, identifier: `${layer}${String(i).padStart(2, '0')}`, type: 'RGBA' });
    void n;
    return { inputs: d.inputs, outputs };
  };
}
{
  const d = cdef('CompositorNodeImage', 'input', {
    description: 'Input image or movie file',
  });
  d.props = [{ id: 'image', name: 'Image', type: 'IMAGE', d: null, noLabel: true }];
}
{
  const d = cdef('CompositorNodeRGB', 'input', {
    description: 'A color picker',
  });
  d.outputs[0].default = [0.5, 0.5, 0.5, 1];
  d.props = [
    {
      id: 'outputs.Color',
      name: 'Color',
      type: 'COLOR',
      d: [0.5, 0.5, 0.5, 1],
      noLabel: true,
    },
  ];
}
cdef('CompositorNodeBokehImage', 'input', {
  description: 'Generate image with bokeh shape for use with the Bokeh Blur filter node',
});
cdef('CompositorNodeSceneTime', 'input', {
  description: 'Current frame and time in seconds',
});
{
  const d = cdef('CompositorNodeTime', 'input', {
    description: 'Generate a factor value (from 0.0 to 1.0) between scene start and end time, using a curve mapping',
  });
  d.init = (n) => {
    if (!n.props.curve_0)
      Object.assign(n.props, defaultCurves('FLOAT'), {
        curve_extend: 'HORIZONTAL',
      });
  };
}

// ---------------------------------------------------------------------------
// Output

{
  const d = cdef('CompositorNodeViewer', 'output', {
    description: 'Visualize data from inside a node graph, in the image editor or as a backdrop',
  });
  d.props = [];
}

// ---------------------------------------------------------------------------
// Color

{
  const d = cdef('CompositorNodePremulKey', 'converter', {
    description: 'Convert to and from premultiplied (associated) alpha',
  });
  void d;
}
cdef('CompositorNodeAlphaOver', 'color', {
  description: 'Overlay a foreground image onto a background image',
});
cdef('CompositorNodeSetAlpha', 'converter', {
  description: 'Add an alpha channel to an image',
});
{
  const labels: Record<string, string[]> = {
    RGB: ['Red', 'Green', 'Blue'],
    HSV: ['Hue', 'Saturation', 'Value'],
    HSL: ['Hue', 'Saturation', 'Lightness'],
    YCC: ['Y', 'Cb', 'Cr'],
    YUV: ['Y', 'U', 'V'],
  };
  const idx: Record<string, number> = { Red: 0, Green: 1, Blue: 2 };
  for (const id of ['CompositorNodeCombineColor', 'CompositorNodeSeparateColor']) {
    const d = cdef(id, 'converter', {
      description: id.includes('Combine') ? 'Combine an image from its composite color channels' : 'Split an image into its composite color channels',
    });
    d.socketLabel = (n, s) => (s.identifier in idx ? labels[p(n, 'mode')]?.[idx[s.identifier]] : undefined);
    setProp(d, 'mode', { noLabel: true });
    setProp(d, 'ycc_mode', {
      noLabel: true,
      visible: (n) => p(n, 'mode') === 'YCC',
    });
  }
}
cdef('CompositorNodeZcombine', 'color', {
  description: 'Combine two images using depth maps',
});
cdef('CompositorNodeInvert', 'color', {
  description: 'Invert colors, producing a negative',
});
cdef('CompositorNodeRGBToBW', 'converter', {
  description: 'Convert RGB input into grayscale using luminance',
});
cdef('CompositorNodeBrightContrast', 'color', {
  description: 'Adjust brightness and contrast',
});
{
  const d = cdef('CompositorNodeColorBalance', 'color', {
    description: 'Adjust color and values',
  });
  const lgg = (n: NodeData) => menuValue(n, 'Type', d) === 'Lift/Gamma/Gain';
  const cdl = (n: NodeData) => menuValue(n, 'Type', d).startsWith('Offset');
  const wp = (n: NodeData) => menuValue(n, 'Type', d) === 'White Point';
  availability(d, {
    'Base Lift': lgg,
    'Color Lift': lgg,
    'Base Gamma': lgg,
    'Color Gamma': lgg,
    'Base Gain': lgg,
    'Color Gain': lgg,
    'Base Offset': cdl,
    'Color Offset': cdl,
    'Base Power': cdl,
    'Color Power': cdl,
    'Base Slope': cdl,
    'Color Slope': cdl,
    'Input Temperature': wp,
    'Input Tint': wp,
    'Output Temperature': wp,
    'Output Tint': wp,
  });
  // the white points are derived from the temperature/tint inputs
  d.props = [];
}
cdef('CompositorNodeColorCorrection', 'color', {
  description: 'Adjust the color of an image, separately in several tonal ranges (highlights, midtones and shadows)',
});
cdef('CompositorNodeExposure', 'color', {
  description: 'Adjust brightness using a camera exposure parameter',
});
cdef('CompositorNodeHueSat', 'color', {
  description: 'Apply a color transformation in the HSV color model',
});
{
  const d = cdef('CompositorNodeCurveRGB', 'color', {
    description: 'Perform level adjustments on each color channel of an image',
  });
  d.init = (n) => {
    if (!n.props.curve_0)
      Object.assign(n.props, defaultCurves('RGB'), {
        curve_extend: 'EXTRAPOLATED',
      });
  };
}
{
  const d = cdef('CompositorNodeTonemap', 'color', {
    description: 'Map one set of colors to another in order to approximate the appearance of high dynamic range',
  });
  const rd = (n: NodeData) => menuValue(n, 'Type', d) === 'R/D Photoreceptor';
  availability(d, {
    Key: (n) => !rd(n),
    Balance: (n) => !rd(n),
    Gamma: (n) => !rd(n),
    Intensity: rd,
    Contrast: rd,
    'Light Adaptation': rd,
    'Chromatic Adaptation': rd,
  });
}

// ---------------------------------------------------------------------------
// Creative

cdef('CompositorNodePixelate', 'filter', {
  description: 'Reduce detail in an image by making individual pixels more prominent',
});
cdef('CompositorNodePosterize', 'color', {
  description: 'Reduce the number of colors in an image, converting smooth gradients into sharp transitions',
});
{
  const d = cdef('CompositorNodeKuwahara', 'filter', {
    description: 'Apply smoothing filter that preserves edges, for a stylized painterly effect',
  });
  const ani = (n: NodeData) => menuValue(n, 'Type', d) === 'Anisotropic';
  availability(d, {
    Uniformity: ani,
    Sharpness: ani,
    Eccentricity: ani,
    'High Precision': (n) => !ani(n),
  });
}

// ---------------------------------------------------------------------------
// Filter

{
  const d = cdef('CompositorNodeBlur', 'filter', {
    description: 'Blur an image, using several blur modes',
  });
  d.inputs.find((s) => s.identifier === 'Size')!.dimensions = 2;
}
cdef('CompositorNodeBilateralblur', 'filter', {
  description: 'Adaptively blur image, while retaining sharp edges',
});
cdef('CompositorNodeBokehBlur', 'filter', {
  description: 'Generate a bokeh type blur similar to Defocus. Unlike defocus an in-focus region is defined in the compositor',
});
{
  const d = cdef('CompositorNodeDefocus', 'filter', {
    description: 'Apply depth of field in 2D, using a Z depth map or mask',
  });
  setProp(d, 'bokeh', { noLabel: false });
  setProp(d, 'f_stop', { visible: (n) => !!propValue(n, 'use_zbuffer') });
  setProp(d, 'z_scale', { visible: (n) => !propValue(n, 'use_zbuffer') });
}
cdef('CompositorNodeDBlur', 'filter', {
  description: 'Blur an image along a direction',
});
{
  const d = cdef('CompositorNodeDenoise', 'filter', {
    description: 'Denoise renders from Cycles and other ray tracing renderers',
  });
  void d;
}
cdef('CompositorNodeDespeckle', 'filter', {
  description: 'Smooth areas of an image in which noise is noticeable, while leaving complex areas untouched',
});
{
  const d = cdef('CompositorNodeDilateErode', 'filter', {
    description: 'Expand and shrink masks',
  });
  availability(d, {
    'Falloff Size': (n) => menuValue(n, 'Type', d) === 'Threshold',
    Falloff: (n) => menuValue(n, 'Type', d) === 'Feather',
  });
}
{
  const d = cdef('CompositorNodeFilter', 'filter', {
    description: 'Apply common image enhancement filters',
  });
  d.dynamicLabel = (n) => menuValue(n, 'Type', d);
}
{
  const d = cdef('CompositorNodeGlare', 'filter', {
    description: 'Add lens flares, fog and glows around bright parts of the image',
  });
  const t = (n: NodeData) => menuValue(n, 'Type', d);
  const is =
    (...types: string[]) =>
    (n: NodeData) =>
      types.includes(t(n));
  availability(d, {
    Size: is('Bloom', 'Fog Glow', 'Sun Beams'),
    Streaks: is('Streaks'),
    'Streaks Angle': is('Streaks'),
    Iterations: is('Streaks', 'Ghosts', 'Simple Star'),
    Fade: is('Streaks', 'Simple Star'),
    'Color Modulation': is('Streaks', 'Ghosts'),
    'Diagonal Star': is('Simple Star'),
    'Sun Position': is('Sun Beams'),
    Jitter: is('Sun Beams'),
    'Kernel Data Type': is('Kernel'),
    'Float Kernel': (n) => t(n) === 'Kernel' && menuValue(n, 'Kernel Data Type', d) === 'Float',
    'Color Kernel': (n) => t(n) === 'Kernel' && menuValue(n, 'Kernel Data Type', d) === 'Color',
    'Maximum Highlights': (n) => n.inputs['Clamp Highlights'] === true,
  });
  d.dynamicLabel = (n) => t(n);
  const sp = d.inputs.find((s) => s.identifier === 'Sun Position');
  if (sp) sp.dimensions = 2;
  // the "Kernel" type needs a kernel image; it is not offered (see ops/glare.ts)
  const tp = d.inputs.find((s) => s.identifier === 'Type')!;
  tp.items = tp.items!.filter((i) => i !== 'Kernel');
}
cdef('CompositorNodeAntiAliasing', 'filter', {
  description: 'Smooth away jagged edges',
});

// ---------------------------------------------------------------------------
// Keying

{
  const d = cdef('CompositorNodeChannelMatte', 'matte', {
    description: 'Create matte based on differences in color channels',
  });
  const cs = (n: NodeData) => menuValue(n, 'Color Space', d);
  const single = (n: NodeData) => menuValue(n, 'Limit Method', d) === 'Single';
  availability(d, {
    'RGB Key Channel': (n) => cs(n) === 'RGB',
    'HSV Key Channel': (n) => cs(n) === 'HSV',
    'YUV Key Channel': (n) => cs(n) === 'YUV',
    'YCbCr Key Channel': (n) => cs(n) === 'YCbCr',
    'RGB Limit Channel': (n) => cs(n) === 'RGB' && single(n),
    'HSV Limit Channel': (n) => cs(n) === 'HSV' && single(n),
    'YUV Limit Channel': (n) => cs(n) === 'YUV' && single(n),
    'YCbCr Limit Channel': (n) => cs(n) === 'YCbCr' && single(n),
  });
}
cdef('CompositorNodeChromaMatte', 'matte', {
  description: 'Create matte based on chroma values',
});
cdef('CompositorNodeColorMatte', 'matte', {
  description: 'Create matte using a given color, for green or blue screen footage',
});
{
  const d = cdef('CompositorNodeColorSpill', 'matte', {
    description: 'Remove colors from a blue or green screen, by reducing one RGB channel compared to the others',
  });
  availability(d, {
    'Limit Channel': (n) => menuValue(n, 'Limit Method', d) === 'Single',
    'Spill Strength': (n) => n.inputs['Use Spill Strength'] === true,
  });
}
cdef('CompositorNodeDiffMatte', 'matte', {
  description: 'Produce a matte that isolates foreground content by comparing it with a reference background image',
});
cdef('CompositorNodeDistanceMatte', 'matte', {
  description: 'Create matte based on 3D distance between colors',
});
cdef('CompositorNodeLumaMatte', 'matte', {
  description: 'Create a matte based on luminance (brightness) difference',
});

// ---------------------------------------------------------------------------
// Mask

for (const id of ['CompositorNodeBoxMask', 'CompositorNodeEllipseMask']) {
  const d = cdef(id, 'matte', {
    description: id.includes('Box') ? 'Create rectangular mask suitable for use as a simple matte' : 'Create elliptical mask suitable for use as a simple matte or vignette mask',
  });
  for (const s of d.inputs) if (s.identifier === 'Position' || s.identifier === 'Size') s.dimensions = 2;
}

// ---------------------------------------------------------------------------
// Transform

cdef('CompositorNodeRotate', 'distort', {
  description: 'Rotate image by specified angle',
});
{
  const d = cdef('CompositorNodeScale', 'distort', {
    description: 'Scale, resize, or stretch an image',
  });
  const t = (n: NodeData) => menuValue(n, 'Type', d);
  availability(d, {
    X: (n) => t(n) === 'Relative' || t(n) === 'Absolute',
    Y: (n) => t(n) === 'Relative' || t(n) === 'Absolute',
    'Frame Type': (n) => t(n) === 'Render Size',
  });
}
cdef('CompositorNodeTransform', 'distort', {
  description: 'Scale, translate and rotate an image',
});
cdef('CompositorNodeTranslate', 'distort', { description: 'Offset an image' });
{
  const d = cdef('CompositorNodeCornerPin', 'distort', {
    description: 'Plane warp transformation using explicit corner values',
  });
  for (const s of d.inputs) if (s.type === 'VECTOR') s.dimensions = 2;
}
cdef('CompositorNodeCrop', 'distort', {
  description: 'Crops image to a smaller region, either making the cropped area transparent or resizing the image',
});
{
  const d = cdef('CompositorNodeDisplace', 'distort', {
    description: 'Displace pixel position using an offset vector',
  });
  d.inputs.find((s) => s.identifier === 'Displacement')!.dimensions = 2;
}
cdef('CompositorNodeFlip', 'distort', {
  description: 'Flip an image along a defined axis',
});
cdef('CompositorNodeMapUV', 'distort', {
  description: 'Map a texture using UV coordinates, to apply a texture to objects in compositing',
});
{
  const d = cdef('CompositorNodeLensdist', 'distort', {
    description: 'Simulate distortion and dispersion from camera lenses',
  });
  availability(d, {
    Distortion: (n) => menuValue(n, 'Type', d) === 'Radial',
    Fit: (n) => menuValue(n, 'Type', d) === 'Radial',
  });
}

// ---------------------------------------------------------------------------
// Utilities

cdef('CompositorNodeLevels', 'converter', {
  description: 'Compute average and standard deviation of pixel values',
});
cdef('CompositorNodeNormalize', 'vector', {
  description: 'Map values to 0 to 1 range, based on the minimum and maximum pixel values',
});
{
  const d = cdef('CompositorNodeSplit', 'converter', {
    description: 'Combine two images for side-by-side display. Typically used in combination with a Viewer node',
  });
  d.inputs.find((s) => s.identifier === 'Position')!.dimensions = 2;
}
{
  const d = cdef('CompositorNodeRelativeToPixel', 'converter', {
    description: 'Convert values that are relative to the image size to be in terms of pixels',
  });
  const vec = (n: NodeData) => p(n, 'data_type') === 'VECTOR';
  availability(d, {
    'Vector Value': vec,
    'Float Value': (n) => !vec(n),
    'out:Vector Value': vec,
    'out:Float Value': (n) => !vec(n),
  });
  for (const s of [...d.inputs, ...d.outputs]) if (s.type === 'VECTOR') s.dimensions = 2;
  setProp(d, 'data_type', { noLabel: true });
}

// Switch (shared idname with Geometry Nodes): sockets follow the input type
const SWITCH_TYPES: Record<string, SocketDef['type']> = {
  FLOAT: 'FLOAT',
  INT: 'INT',
  BOOLEAN: 'BOOLEAN',
  VECTOR: 'VECTOR',
  RGBA: 'RGBA',
};
const SWITCH_DEFAULT: Record<string, unknown> = {
  FLOAT: 0,
  INT: 0,
  BOOLEAN: false,
  VECTOR: [0, 0, 0],
  RGBA: [0.8, 0.8, 0.8, 1],
};
function compositorSwitch(): NodeTypeDef {
  const raw = COMPOSITOR_NODE_DATA.GeometryNodeSwitch;
  const d: NodeTypeDef = {
    idname: 'GeometryNodeSwitch',
    label: raw.label,
    width: raw.width,
    category: 'converter',
    treeTypes: CMP,
    inputs: raw.inputs.map(socketFromCompRaw),
    outputs: raw.outputs.map(socketFromCompRaw),
    props: raw.props.map((x) => ({ ...x, noLabel: true })),
    dynamicSockets: (n) => {
      const t = String(propValue(n, 'input_type') ?? 'FLOAT');
      const type = SWITCH_TYPES[t] ?? 'FLOAT';
      const dv = SWITCH_DEFAULT[t] as SocketDef['default'];
      return {
        inputs: [
          {
            name: 'Switch',
            identifier: 'Switch',
            type: 'BOOLEAN',
            default: false,
          },
          { name: 'False', identifier: 'False', type, default: dv },
          { name: 'True', identifier: 'True', type, default: dv },
        ],
        outputs: [{ name: 'Output', identifier: 'Output', type }],
      };
    },
    description: 'Switch between two inputs',
  };
  return d;
}

// ---------------------------------------------------------------------------
// shared shader nodes

const SHARED = [
  'ShaderNodeValue',
  'ShaderNodeMix',
  'ShaderNodeMath',
  'ShaderNodeMapRange',
  'ShaderNodeClamp',
  'ShaderNodeValToRGB',
  'ShaderNodeFloatCurve',
  'ShaderNodeGamma',
  'ShaderNodeBlackbody',
  'ShaderNodeCombineXYZ',
  'ShaderNodeSeparateXYZ',
  'ShaderNodeVectorMath',
  'ShaderNodeVectorCurve',
  'ShaderNodeVectorRotate',
  'ShaderNodeRadialTiling',
  'ShaderNodeTexBrick',
  'ShaderNodeTexChecker',
  'ShaderNodeTexGabor',
  'ShaderNodeTexGradient',
  'ShaderNodeTexMagic',
  'ShaderNodeTexNoise',
  'ShaderNodeTexVoronoi',
  'ShaderNodeTexWave',
  'ShaderNodeTexWhiteNoise',
  'FunctionNodeInputBool',
  'FunctionNodeInputInt',
  'FunctionNodeInputVector',
  'FunctionNodeInputRotation',
  'FunctionNodeInputString',
];

/** Add the compositor tree type to node types defined elsewhere (idempotent, re-run after late registrations). */
export function shareNodeTypes() {
  for (const id of SHARED) {
    const d = getNodeType(id);
    if (d && !d.treeTypes.includes('COMPOSITOR')) d.treeTypes = [...d.treeTypes, 'COMPOSITOR'];
  }
  const sw = getNodeType('GeometryNodeSwitch');
  if (!sw) registerNodeType(compositorSwitch());
  else if (!sw.treeTypes.includes('COMPOSITOR')) sw.treeTypes = [...sw.treeTypes, 'COMPOSITOR'];
}
shareNodeTypes();
// node types registered by modules loaded later (e.g. Geometry Nodes' Switch) still get COMPOSITOR
setTimeout(shareNodeTypes, 0);

makeGroupNodeType('CompositorNodeGroup', CMP);
groupNodeIdnames.COMPOSITOR = 'CompositorNodeGroup';

// ramps of new compositor Color Ramp nodes start black → white
void defaultRamp;

// ---------------------------------------------------------------------------
// Add menu

const e = (idname: string, label?: string, settings?: Record<string, never> | Record<string, string>): MenuEntry => ({
  idname,
  label,
  settings: settings as MenuEntry['settings'],
});

export const COMPOSITOR_MENU: MenuCategory[] = [
  {
    label: 'Input',
    items: [
      {
        label: 'Constant',
        items: [
          e('FunctionNodeInputBool'),
          e('CompositorNodeRGB'),
          e('FunctionNodeInputInt'),
          e('CompositorNodeNormal'),
          e('FunctionNodeInputRotation'),
          e('FunctionNodeInputString'),
          e('ShaderNodeValue'),
          e('FunctionNodeInputVector'),
        ],
      },
      'SEPARATOR',
      e('CompositorNodeBlankImage'),
      e('CompositorNodeBokehImage'),
      e('NodeGroupInput', 'Group Input'),
      e('CompositorNodeImage'),
      e('CompositorNodeImageInfo'),
      e('CompositorNodeImageCoordinates'),
      e('CompositorNodeMask'),
      e('CompositorNodeMovieClip'),
      e('CompositorNodeStringToImage'),
      'SEPARATOR',
      {
        label: 'Scene',
        items: [e('CompositorNodeRLayers'), e('CompositorNodeSceneTime'), e('CompositorNodeTime')],
      },
    ],
  },
  {
    label: 'Output',
    items: [e('CompositorNodeOutputFile'), e('NodeGroupOutput', 'Group Output'), e('CompositorNodeViewer')],
  },
  {
    label: 'Color',
    separatorBefore: true,
    items: [
      {
        label: 'Adjust',
        items: [
          e('CompositorNodeBrightContrast'),
          e('CompositorNodeColorBalance'),
          e('CompositorNodeColorCorrection'),
          e('CompositorNodeExposure'),
          e('ShaderNodeGamma'),
          e('CompositorNodeHueCorrect'),
          e('CompositorNodeHueSat'),
          e('CompositorNodeCurveRGB'),
          e('CompositorNodeTonemap'),
        ],
      },
      'SEPARATOR',
      e('CompositorNodePremulKey'),
      e('CompositorNodeAlphaOver'),
      e('CompositorNodeSetAlpha'),
      'SEPARATOR',
      e('CompositorNodeCombineColor'),
      e('CompositorNodeSeparateColor'),
      'SEPARATOR',
      e('CompositorNodeZcombine'),
      e('ShaderNodeMix', 'Mix Color', { data_type: 'RGBA' }),
      'SEPARATOR',
      e('ShaderNodeBlackbody'),
      e('ShaderNodeValToRGB'),
      e('CompositorNodeConvertColorSpace'),
      e('CompositorNodeConvertToDisplay'),
      'SEPARATOR',
      e('CompositorNodeInvert'),
      e('CompositorNodeRGBToBW'),
    ],
  },
  {
    label: 'Creative',
    items: [e('CompositorNodeKuwahara'), e('CompositorNodePixelate'), e('CompositorNodePosterize')],
  },
  {
    label: 'Filter',
    items: [
      {
        label: 'Blur',
        items: [e('CompositorNodeBilateralblur'), e('CompositorNodeBlur'), e('CompositorNodeBokehBlur'), e('CompositorNodeDefocus'), e('CompositorNodeDBlur'), e('CompositorNodeVecBlur')],
      },
      'SEPARATOR',
      e('CompositorNodeAntiAliasing'),
      e('CompositorNodeConvolve'),
      e('CompositorNodeDenoise'),
      e('CompositorNodeDespeckle'),
      'SEPARATOR',
      e('CompositorNodeDilateErode'),
      e('CompositorNodeMaskToSDF'),
      e('CompositorNodeInpaint'),
      'SEPARATOR',
      e('CompositorNodeFilter'),
      e('CompositorNodeGlare'),
    ],
  },
  {
    label: 'Keying',
    separatorBefore: true,
    items: [
      e('CompositorNodeChannelMatte'),
      e('CompositorNodeChromaMatte'),
      e('CompositorNodeColorMatte'),
      e('CompositorNodeColorSpill'),
      e('CompositorNodeDiffMatte'),
      e('CompositorNodeDistanceMatte'),
      e('CompositorNodeKeying'),
      e('CompositorNodeKeyingScreen'),
      e('CompositorNodeLumaMatte'),
    ],
  },
  {
    label: 'Mask',
    items: [
      e('CompositorNodeCryptomatteV2'),
      e('CompositorNodeCryptomatte'),
      'SEPARATOR',
      e('CompositorNodeBoxMask'),
      e('CompositorNodeEllipseMask'),
      'SEPARATOR',
      e('CompositorNodeDoubleEdgeMask'),
      e('CompositorNodeIDMask'),
    ],
  },
  {
    label: 'Tracking',
    separatorBefore: true,
    items: [e('CompositorNodeStabilize'), e('CompositorNodeTrackPos')],
  },
  {
    label: 'Texture',
    separatorBefore: true,
    items: [
      e('ShaderNodeTexBrick'),
      e('ShaderNodeTexChecker'),
      e('ShaderNodeTexGabor'),
      e('ShaderNodeTexGradient'),
      e('ShaderNodeTexMagic'),
      e('ShaderNodeTexNoise'),
      e('ShaderNodeTexVoronoi'),
      e('ShaderNodeTexWave'),
      e('ShaderNodeTexWhiteNoise'),
    ],
  },
  {
    label: 'Transform',
    items: [
      e('CompositorNodeRotate'),
      e('CompositorNodeScale'),
      e('CompositorNodeTransform'),
      e('CompositorNodeTranslate'),
      'SEPARATOR',
      e('CompositorNodeCornerPin'),
      e('CompositorNodeCrop'),
      'SEPARATOR',
      e('CompositorNodeDisplace'),
      e('CompositorNodeFlip'),
      e('CompositorNodeMapUV'),
      'SEPARATOR',
      e('CompositorNodeLensdist'),
      e('CompositorNodeMovieDistortion'),
    ],
  },
  {
    label: 'Utilities',
    items: [
      {
        label: 'Math',
        items: [e('ShaderNodeClamp'), e('ShaderNodeFloatCurve'), e('ShaderNodeMapRange'), e('ShaderNodeMath'), e('ShaderNodeMix')],
      },
      {
        label: 'Vector',
        items: [
          e('ShaderNodeCombineXYZ'),
          e('ShaderNodeMapRange', 'Map Range', { data_type: 'FLOAT_VECTOR' }),
          e('ShaderNodeMix', 'Mix Vector', { data_type: 'VECTOR' }),
          e('ShaderNodeSeparateXYZ'),
          'SEPARATOR',
          e('ShaderNodeRadialTiling'),
          e('ShaderNodeVectorCurve'),
          e('ShaderNodeVectorMath'),
          e('ShaderNodeVectorRotate'),
        ],
      },
      'SEPARATOR',
      e('CompositorNodeLevels'),
      e('CompositorNodeNormalize'),
      'SEPARATOR',
      e('CompositorNodeSplit'),
      e('GeometryNodeSwitch'),
      e('CompositorNodeSwitchView', 'Switch Stereo View'),
      'SEPARATOR',
      e('CompositorNodeRelativeToPixel'),
    ],
  },
];

/** Add-menu poll: entries whose node type exists and runs in the compositor. */
export function compositorEntryPoll(idname: string): boolean {
  const d = getNodeType(idname);
  if (!d || !d.treeTypes.includes('COMPOSITOR')) return false;
  return !compositorEntryCheck || compositorEntryCheck(idname);
}
let compositorEntryCheck: ((idname: string) => boolean) | null = null;
/** Set by the evaluator module: whether a node type has an implementation. */
export function setCompositorEntryCheck(f: (idname: string) => boolean) {
  compositorEntryCheck = f;
}

registerNodeMenu(['COMPOSITOR'], COMPOSITOR_MENU);
