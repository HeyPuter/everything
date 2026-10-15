// Colors for the animation editors.
import type { FCurve, Keyframe, KeyHandleType } from '../data/types';

export const C = {
  back: '#303030',
  channelBack: '#232323',
  grid: 'rgba(0,0,0,0.22)',
  gridMinor: 'rgba(0,0,0,0.12)',
  rulerBack: '#2b2b2b',
  rulerText: '#a6a6a6',
  outOfRange: 'rgba(0,0,0,0.20)',
  previewRange: 'rgba(161,77,0,0.25)',
  playhead: '#4772b3',
  playheadText: '#ffffff',
  marker: 'rgba(255,255,255,0.5)',
  markerSelected: '#ffffff',
  summary: 'rgba(77,39,39,0.70)',
  objectRow: 'rgba(25,78,128,0.50)',
  actionRow: 'rgba(15,44,77,0.50)',
  groupRow: 'rgba(26,51,45,0.80)',
  groupRowSel: 'rgba(33,109,91,0.65)',
  channelRow: 'rgba(18,18,18,0.40)',
  channelRowSel: 'rgba(96,192,64,0.16)',
  longKey: 'rgba(255,255,255,0.12)',
  longKeySelected: 'rgba(255,140,0,0.60)',
  interpLinear: 'rgba(148,229,117,0.80)',
  interpConstant: 'rgba(229,156,123,0.80)',
  interpOther: 'rgba(93,186,190,0.70)',
  // graph editor
  vertex: '#000000',
  vertexSelect: '#ff8500',
  vertexActive: '#ffffff',
  cursorLine: 'rgba(71,114,179,0.9)',
  // nla
  nlaActionLine: 'rgba(153,84,19,0.40)',
  nlaActionLineUnset: 'rgba(77,59,23,0.30)',
  nlaStrip: '#0d0d0d',
  nlaStripSelected: '#ff8c00',
  nlaTrack: 'rgba(48,48,48,1)',
  nlaTrackSel: 'rgba(110,70,30,0.55)',
};

export const KEY_COLORS: Record<Keyframe['type'], [string, string]> = {
  KEYFRAME: ['#bfbfbf', '#ffbe33'],
  EXTREME: ['#e8b3cc', '#f28080'],
  BREAKDOWN: ['#b3dbe8', '#54bfed'],
  JITTER: ['#94e575', '#61c042'],
  MOVING_HOLD: ['#808080', '#ffaf23'],
  GENERATED: ['#585858', '#a28962'],
};

/** Relative size of each keyframe type (keyframe = 1). */
const KEY_SIZE: Record<Keyframe['type'], number> = {
  KEYFRAME: 1,
  EXTREME: 1.2,
  BREAKDOWN: 0.85,
  JITTER: 0.7,
  MOVING_HOLD: 0.8,
  GENERATED: 0.85,
};

export function keyColor(type: Keyframe['type'], selected: boolean) {
  return (KEY_COLORS[type] ?? KEY_COLORS.KEYFRAME)[selected ? 1 : 0];
}

export type KeyShape = 'DIAMOND' | 'CIRCLE' | 'CIRCLE_DOT' | 'SQUARE' | 'CLIPPED';

export function shapeFor(handle: KeyHandleType | 'MIXED', interp: Keyframe['interpolation'] | 'MIXED'): KeyShape {
  if (interp !== 'BEZIER') return 'DIAMOND';
  switch (handle) {
    case 'AUTO_CLAMPED':
      return 'CIRCLE';
    case 'AUTO':
      return 'CIRCLE_DOT';
    case 'VECTOR':
      return 'SQUARE';
    case 'ALIGNED':
      return 'CLIPPED';
    default:
      return 'DIAMOND';
  }
}

/** Draw a keyframe icon centred at (x, y); `size` is the full diamond width for a regular key. */
export function drawKey(g: CanvasRenderingContext2D, x: number, y: number, size: number, type: Keyframe['type'], selected: boolean, shape: KeyShape = 'DIAMOND', alpha = 1) {
  const s = (size * (KEY_SIZE[type] ?? 1)) / 2;
  g.globalAlpha = alpha;
  g.fillStyle = keyColor(type, selected);
  g.strokeStyle = '#000';
  g.lineWidth = 1;
  g.beginPath();
  switch (shape) {
    case 'CIRCLE':
    case 'CIRCLE_DOT':
      g.arc(x, y, s * 0.82, 0, Math.PI * 2);
      break;
    case 'SQUARE': {
      const q = s * 0.72;
      g.rect(x - q, y - q, q * 2, q * 2);
      break;
    }
    case 'CLIPPED': {
      const c = s * 0.45;
      g.moveTo(x - c, y - s);
      g.lineTo(x + c, y - s);
      g.lineTo(x + s, y);
      g.lineTo(x + c, y + s);
      g.lineTo(x - c, y + s);
      g.lineTo(x - s, y);
      g.closePath();
      break;
    }
    default:
      g.moveTo(x, y - s);
      g.lineTo(x + s, y);
      g.lineTo(x, y + s);
      g.lineTo(x - s, y);
      g.closePath();
  }
  g.fill();
  g.stroke();
  if (shape === 'CIRCLE_DOT') {
    g.fillStyle = '#000';
    g.beginPath();
    g.arc(x, y, Math.max(1, s * 0.25), 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

const AXIS_RGB = ['#ff3352', '#8bdc00', '#2890ff'];
const XYZ_PATH = /(^|\.)(location|rotation_euler|scale|delta_location|delta_rotation_euler|delta_scale|rotation_quaternion|rotation_axis_angle)$/;

function hsvCss(h: number, s: number, v: number) {
  const i = Math.floor(h * 6),
    f = h * 6 - i,
    p = v * (1 - s),
    q = v * (1 - f * s),
    t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][((i % 6) + 6) % 6];
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

/** Display color of an F-Curve; `i`/`n` are its position among the listed curves (for rainbow mode). */
export function curveColor(fc: FCurve, i: number, n: number): string {
  const mode = fc.color_mode ?? 'AUTO_RAINBOW';
  if (mode === 'CUSTOM' && fc.color) {
    const c = fc.color.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  const quat = /rotation_(quaternion|axis_angle)$/.test(fc.data_path);
  if ((mode === 'AUTO_RGB' || mode === 'AUTO_YRGB') && XYZ_PATH.test(fc.data_path)) {
    if (quat || mode === 'AUTO_YRGB') {
      if (fc.array_index === 0) return '#e6d24d';
      return AXIS_RGB[(fc.array_index - 1) % 3];
    }
    return AXIS_RGB[fc.array_index % 3];
  }
  const hue = n > 1 ? (i / n) * 0.9 : 0;
  return hsvCss(hue, 0.55, 0.92);
}

export const HANDLE_COLORS: Record<KeyHandleType, [string, string]> = {
  FREE: ['#745900', '#ffc300'],
  AUTO: ['#740d00', '#ff1900'],
  VECTOR: ['#232374', '#4444ff'],
  ALIGNED: ['#157000', '#72ff57'],
  AUTO_CLAMPED: ['#803060', '#f090a0'],
};
