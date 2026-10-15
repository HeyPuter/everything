// Colors for the animation editors.
import type { FCurve, Keyframe, KeyHandleType } from '../data/types';

export const C = {
  back: '#2d2e30',
  channelBack: '#202122',
  grid: 'rgba(0, 0, 0,0.22)',
  gridMinor: 'rgba(0, 0, 0,0.12)',
  rulerBack: '#28292a',
  rulerText: '#a6a7a9',
  outOfRange: 'rgba(0, 0, 0,0.20)',
  previewRange: 'rgba(152, 82, 2,0.25)',
  playhead: '#4b70b5',
  playheadText: '#ffffff',
  marker: 'rgba(255, 255, 255,0.5)',
  markerSelected: '#ffffff',
  summary: 'rgba(74, 40, 38,0.70)',
  objectRow: 'rgba(28, 76, 132,0.50)',
  actionRow: 'rgba(17, 43, 79,0.50)',
  groupRow: 'rgba(26, 50, 46,0.80)',
  groupRowSel: 'rgba(34, 108, 94,0.65)',
  channelRow: 'rgba(14, 15, 17,0.40)',
  channelRowSel: 'rgba(98, 193, 74,0.16)',
  longKey: 'rgba(255, 255, 255,0.12)',
  longKeySelected: 'rgba(245, 148, 4,0.60)',
  interpLinear: 'rgba(154, 230, 132,0.80)',
  interpConstant: 'rgba(227, 159, 121,0.80)',
  interpOther: 'rgba(106, 185, 193,0.70)',
  // graph editor
  vertex: '#000000',
  vertexSelect: '#f58e04',
  vertexActive: '#ffffff',
  cursorLine: 'rgba(75, 112, 181,0.9)',
  // nla
  nlaActionLine: 'rgba(145, 87, 20,0.40)',
  nlaActionLineUnset: 'rgba(74, 60, 23,0.30)',
  nlaStrip: '#090a0c',
  nlaStripSelected: '#f59404',
  nlaTrack: 'rgba(45, 46, 48,1)',
  nlaTrackSel: 'rgba(105, 71, 30,0.55)',
};

export const KEY_COLORS: Record<Keyframe['type'], [string, string]> = {
  KEYFRAME: ['#c0c1c2', '#fcc327'],
  EXTREME: ['#e8b6cb', '#f0847e'],
  BREAKDOWN: ['#bcdcea', '#68beed'],
  JITTER: ['#9ae684', '#63c14c'],
  MOVING_HOLD: ['#7f8082', '#fbb416'],
  GENERATED: ['#565759', '#9f895f'],
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
  g.strokeStyle = '#000000';
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
    g.fillStyle = '#000000';
    g.beginPath();
    g.arc(x, y, Math.max(1, s * 0.25), 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

const AXIS_RGB = ['#fc364b', '#84e003', '#398efc'];
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
      if (fc.array_index === 0) return '#e3d649';
      return AXIS_RGB[(fc.array_index - 1) % 3];
    }
    return AXIS_RGB[fc.array_index % 3];
  }
  const hue = n > 1 ? (i / n) * 0.9 : 0;
  return hsvCss(hue, 0.55, 0.92);
}

export const HANDLE_COLORS: Record<KeyHandleType, [string, string]> = {
  FREE: ['#6e5a02', '#f7ca04'],
  AUTO: ['#701402', '#f92804'],
  VECTOR: ['#27236f', '#4b42fc'],
  ALIGNED: ['#116f02', '#92fd84'],
  AUTO_CLAMPED: ['#7e315c', '#ef939e'],
};
