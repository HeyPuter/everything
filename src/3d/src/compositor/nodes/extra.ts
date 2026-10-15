// Compositor node types added after the first batch: registration from extra.gen.ts, socket
// availability, panels, value ranges and node bodies (curves, data-block selectors). The GPU
// implementations live in ops/*.ts.
import type { NodeData } from '../../data/types';
import { getNodeType, registerNodeAlias } from '../../nodes/registry';
import { drawCurves, curveHeight } from '../../nodes/editor/rampui';
import type { NodePanelDef, NodeTypeDef, SocketDef } from '../../nodes/types';
import { COMPOSITOR_NODE_DATA } from './data.gen';
import { COMPOSITOR_EXTRA_NODE_DATA } from './extra.gen';
import { cdef, menuValue } from './defs';
import { COLOR_SPACES, defaultHueCurves } from '../color/colorspace';

Object.assign(COMPOSITOR_NODE_DATA, COMPOSITOR_EXTRA_NODE_DATA);

const sock = (d: NodeTypeDef, id: string, out = false): SocketDef => {
  const s = (out ? d.outputs : d.inputs).find((x) => x.identifier === id);
  if (!s) throw new Error(`${d.idname}: no socket ${id}`);
  return s;
};
const range = (d: NodeTypeDef, id: string, min?: number, max?: number) => {
  const s = sock(d, id);
  if (min !== undefined) s.min = min;
  if (max !== undefined) s.max = max;
};
function availability(d: NodeTypeDef, rules: Record<string, (n: NodeData) => boolean>) {
  d.available = (n, s, out) => {
    const r = rules[(out ? 'out:' : '') + s.identifier];
    return r ? r(n) : !s.disabled;
  };
}

// ---------------------------------------------------------------------------
// Input

{
  const d = cdef('CompositorNodeBlankImage', 'input', { description: 'Generate an image of a given size filled with a single color' });
  sock(d, 'Size').min = 1;
}
cdef('CompositorNodeImageInfo', 'input', { description: 'Size, resolution and transform of an image' });
cdef('CompositorNodeImageCoordinates', 'input', { description: 'Coordinates of the pixels of an image: centred uniform, normalized and pixel coordinates' });
{
  const d = cdef('CompositorNodeNormal', 'input', { description: 'A constant direction' });
  d.props = [{ id: 'outputs.Normal', name: 'Normal', type: 'DIRECTION', d: [0, 0, 1], noLabel: true }];
}
{
  const d = cdef('CompositorNodeStringToImage', 'input', { description: 'Render a text as an image mask' });
  range(d, 'Size', 1);
  range(d, 'Wrap Width', 1);
  availability(d, { 'Wrap Width': (n) => n.inputs.Wrap !== false });
}
cdef('CompositorNodeSequencerStripInfo', 'input', { description: 'Timing and transform of the sequencer strip the compositor runs on' });
{
  const d = cdef('CompositorNodeMovieClip', 'input', { description: 'Footage of a movie clip at the current frame, with its 2D stabilization' });
  d.props = [];
}
{
  const d = cdef('CompositorNodeTrackPos', 'input', { description: 'Position of a motion track, in pixels' });
  d.props = d.props.filter((p) => p.id !== 'tracking_object');
  availability(d, { Frame: (n) => ['Relative Frame', 'Absolute Frame'].includes(menuValue(n, 'Mode', d)) });
  sock(d, 'Speed', true).dimensions = 4;
}

// ---------------------------------------------------------------------------
// Color

{
  const d = cdef('CompositorNodeHueCorrect', 'color', { description: 'Adjust hue, saturation and value of colors, each as a curve over the hue' });
  d.init = (n) => {
    if (!n.props.curve_0) Object.assign(n.props, defaultHueCurves());
  };
}
{
  const d = cdef('CompositorNodeConvertColorSpace', 'converter', { description: 'Convert colors from one color space to another' });
  const supported = new Set(Object.keys(COLOR_SPACES));
  for (const id of ['from_color_space', 'to_color_space']) {
    const p = d.props.find((x) => x.id === id)!;
    p.items = p.items!.filter(([v]) => supported.has(v) && v !== 'Linear Rec.709');
  }
}
{
  const d = cdef('CompositorNodeConvertToDisplay', 'converter', { description: 'Apply a view transform and the display encoding, or undo them' });
  d.props = [
    {
      id: 'view_transform',
      name: 'View',
      type: 'ENUM',
      items: [
        ['STANDARD', 'Standard'],
        ['KHRONOS_PBR_NEUTRAL', 'Khronos PBR Neutral'],
        ['AGX', 'AgX'],
        ['FILMIC', 'Filmic'],
        ['RAW', 'Raw'],
      ],
      d: 'STANDARD',
    },
    { id: 'exposure', name: 'Exposure', type: 'FLOAT', d: 0, softMin: -10, softMax: 10 },
    { id: 'gamma', name: 'Gamma', type: 'FLOAT', d: 1, min: 0, softMax: 5 },
  ];
}

// ---------------------------------------------------------------------------
// Filter

{
  const d = cdef('CompositorNodeConvolve', 'filter', { description: 'Filter an image with a custom kernel image' });
  availability(d, {
    'Float Kernel': (n) => menuValue(n, 'Kernel Data Type', d) !== 'Color',
    'Color Kernel': (n) => menuValue(n, 'Kernel Data Type', d) === 'Color',
  });
}
{
  const d = cdef('CompositorNodeInpaint', 'filter', { description: 'Fill transparent areas from their surroundings' });
  range(d, 'Size', 0);
}
{
  const d = cdef('CompositorNodeMaskToSDF', 'filter', { description: 'Signed distance from the edge of a mask, negative inside' });
  void d;
}
{
  const d = cdef('CompositorNodeVecBlur', 'filter', { description: 'Motion blur from a speed (vector) pass' });
  range(d, 'Samples', 1, 256);
  range(d, 'Shutter', 0);
  sock(d, 'Speed').dimensions = 4;
}

// ---------------------------------------------------------------------------
// Keying and masks

{
  const d = cdef('CompositorNodeKeying', 'matte', { description: 'Pull a matte from a screen color, with edge, garbage/core matte and despill controls' });
  for (const id of ['Preprocess Blur Size', 'Edge Search Size', 'Postprocess Blur Size', 'Postprocess Feather Size']) range(d, id, 0);
  const short: Record<string, string> = {
    'Preprocess Blur Size': 'Blur Size',
    'Key Balance': 'Balance',
    'Edge Search Size': 'Size',
    'Edge Tolerance': 'Tolerance',
    'Postprocess Blur Size': 'Blur Size',
    'Postprocess Dilate Size': 'Dilate Size',
    'Postprocess Feather Size': 'Feather Size',
    'Feather Falloff': 'Falloff',
    'Despill Strength': 'Strength',
    'Despill Balance': 'Balance',
  };
  for (const s of d.inputs) if (short[s.identifier]) s.shortLabel = short[s.identifier];
  const panels: NodePanelDef[] = [
    { name: 'Preprocess', inputs: ['Preprocess Blur Size'], closed: true },
    { name: 'Key', inputs: ['Key Balance'], closed: true },
    { name: 'Tweak', inputs: ['Black Level', 'White Level'], closed: true },
    { name: 'Edges', inputs: ['Edge Search Size', 'Edge Tolerance'], closed: true },
    { name: 'Mask', inputs: ['Garbage Matte', 'Core Matte'], closed: true },
    { name: 'Postprocess', inputs: ['Postprocess Blur Size', 'Postprocess Dilate Size', 'Postprocess Feather Size', 'Feather Falloff'], closed: true },
    { name: 'Despill', inputs: ['Despill Strength', 'Despill Balance'], closed: true },
  ];
  d.panels = panels;
  availability(d, { 'Feather Falloff': (n) => (n.inputs['Postprocess Feather Size'] as number | undefined) !== undefined && (n.inputs['Postprocess Feather Size'] as number) !== 0 });
}
{
  const d = cdef('CompositorNodeKeyingScreen', 'matte', { description: 'Screen color gradient interpolated from the colors under the tracks of a movie clip' });
  d.props = [];
  range(d, 'Smoothness', 0, 1);
}
{
  const d = cdef('CompositorNodeIDMask', 'converter', { description: 'Mask of the pixels whose object or material index equals the given index' });
  range(d, 'Index', 0);
}
cdef('CompositorNodeDoubleEdgeMask', 'matte', { description: 'Gradient between an inner and an outer mask' });
for (const id of ['CompositorNodeCryptomatteV2', 'CompositorNodeCryptomatte']) {
  const d = cdef(id, 'matte', {
    description:
      id === 'CompositorNodeCryptomatte'
        ? 'Matte of the objects picked from cryptomatte passes linked to the inputs'
        : 'Matte of the objects or materials picked from the cryptomatte passes of the render',
  });
  d.props = d.props.filter((p) => ['matte_id', 'layer_name', 'source'].includes(p.id));
  const ln = d.props.find((p) => p.id === 'layer_name');
  if (ln) {
    ln.d = 'CryptoObject';
    ln.noLabel = true;
  }
  const mid = d.props.find((p) => p.id === 'matte_id')!;
  mid.inNode = false;
  d.props = d.props.filter((p) => p.id !== 'source');
}

// ---------------------------------------------------------------------------
// Transform and tracking

{
  const d = cdef('CompositorNodeMovieDistortion', 'distort', { description: 'Remove or add the lens distortion of a movie clip' });
  d.props = [];
}
{
  const d = cdef('CompositorNodeStabilize', 'distort', { description: 'Stabilize footage with the 2D stabilization of a movie clip' });
  d.props = [];
  d.panels = [{ name: 'Sampling', inputs: ['Interpolation', 'Extension X', 'Extension Y'], closed: true }];
}

// ---------------------------------------------------------------------------
// Utilities

cdef('CompositorNodeSwitchView', 'converter', { description: 'Pick the image of the view being composited (stereo: left or right)' });
{
  // legacy two-image switch (files made before the generic Switch node)
  const d = cdef('CompositorNodeSwitch', 'converter', { description: 'Switch between two images' });
  d.hidden = true;
}
// legacy gamma node of older files: the shared Gamma node has the same sockets
registerNodeAlias('CompositorNodeGamma', 'ShaderNodeGamma');

// ---------------------------------------------------------------------------
// Output

{
  const d = cdef('CompositorNodeOutputFile', 'output', { description: 'Save images, one file per input, when rendering' });
  d.props = [
    { id: 'file_name', name: 'File Name', type: 'STRING', d: 'render', inNode: true },
    {
      id: 'file_format',
      name: 'File Format',
      type: 'ENUM',
      items: [
        ['PNG', 'PNG'],
        ['JPEG', 'JPEG'],
        ['WEBP', 'WebP'],
        ['OPEN_EXR', 'OpenEXR'],
      ],
      d: 'PNG',
    },
  ];
}

// curve widgets (RGB Curves, Time Curve, Hue Correct)
for (const id of ['CompositorNodeCurveRGB', 'CompositorNodeTime', 'CompositorNodeHueCorrect']) {
  const d = getNodeType(id);
  if (!d) continue;
  d.drawBody = drawCurves;
  d.bodyHeight = curveHeight;
}
