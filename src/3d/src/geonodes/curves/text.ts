// Text nodes: Join Strings, String to Curves (character outlines from the app's fonts).
import { gn, prop } from './defs';
import { GeometrySet, InstancesComponent, type InstanceReference } from '../geometry';
import { InputField } from '../field';
import { attributeField } from '../inputs';
import type { BezierPoint, CurveData, HandleType, Spline } from '../../data/types';
import { layoutText } from '../../io/fonts';
import type { TextLayout } from '../../io/textlayout';
import { buildCurves, CT, HT, type CurveSpec } from './curvedata';
import { place } from './menu';

gn(
  'GeometryNodeStringJoin',
  'converter',
  {
    exec: (ctx) => {
      const parts = ctx.values('Strings').map((v) => (typeof v === 'string' ? v : ''));
      return { String: parts.join(ctx.string('Delimiter')) };
    },
  },
  { multi: ['Strings'] },
);

// ---------------------------------------------------------------------------
// String to Curves

/** Text layout used by String to Curves (replaceable for tests without loaded fonts). */
export const textLayout: { fn: (cu: CurveData) => TextLayout } = { fn: layoutText };

const ALIGN_X: Record<string, CurveData['align_x']> = { Left: 'LEFT', Center: 'CENTER', Right: 'RIGHT', Justify: 'JUSTIFY', Flush: 'FLUSH' };
const ALIGN_Y: Record<string, CurveData['align_y']> = { Top: 'TOP', 'Top Baseline': 'TOP_BASELINE', Middle: 'CENTER', 'Bottom Baseline': 'BOTTOM_BASELINE', Bottom: 'BOTTOM' };
const OVERFLOW: Record<string, CurveData['overflow']> = { Overflow: 'NONE', 'Scale To Fit': 'SCALE', Truncate: 'TRUNCATE' };
const items = (r: Record<string, unknown>): [string, string][] => Object.keys(r).map((k) => [k, k]);
const PIVOTS = ['Midpoint', 'Top Left', 'Top Center', 'Top Right', 'Bottom Left', 'Bottom Center', 'Bottom Right'];

const HANDLE: Record<HandleType, number> = { FREE: HT.FREE, VECTOR: HT.VECTOR, ALIGNED: HT.ALIGN, AUTO: HT.AUTO };

/** Bézier curves of laid-out glyph outlines (z = 0). */
export function splinesToCurves(splines: Spline[], dx = 0, dy = 0) {
  const list: CurveSpec[] = splines.map((s) => {
    const bp: BezierPoint[] = s.bezier_points;
    const sh = (p: number[]) => [p[0] - dx, p[1] - dy, p[2] ?? 0];
    return {
      points: bp.map((b) => sh(b.co)),
      left: bp.map((b) => sh(b.handle_left)),
      right: bp.map((b) => sh(b.handle_right)),
      cyclic: s.use_cyclic_u,
      type: CT.BEZIER,
      resolution: s.resolution_u || 12,
      typeLeft: HANDLE[bp[0]?.handle_left_type ?? 'FREE'],
      typeRight: HANDLE[bp[0]?.handle_right_type ?? 'FREE'],
    };
  });
  return buildCurves(list);
}

function textData(body: string, base: Partial<CurveData>): CurveData {
  return { ...base, body } as CurveData;
}

const charCache = new Map<string, GeometrySet>();

gn(
  'GeometryNodeStringToCurves',
  'geometry',
  {
    exec: (ctx) => {
      const str = ctx.string('String');
      const size = ctx.float('Size');
      const font = ctx.idRef('Font');
      const overflow = OVERFLOW[String(prop(ctx.node, 'Overflow'))] ?? 'NONE';
      const width = Math.max(0, ctx.float('Text Box Width')),
        height = overflow === 'NONE' ? 0 : Math.max(0, ctx.float('Text Box Height'));
      const base: Partial<CurveData> = {
        size,
        font: font ?? null,
        align_x: ALIGN_X[String(prop(ctx.node, 'Align X'))] ?? 'LEFT',
        align_y: ALIGN_Y[String(prop(ctx.node, 'Align Y'))] ?? 'TOP_BASELINE',
        space_character: ctx.float('Character Spacing'),
        space_word: ctx.float('Word Spacing'),
        space_line: ctx.float('Line Spacing'),
        overflow,
        text_boxes: [{ x: 0, y: 0, width, height }],
      };
      const layout = textLayout.fn(textData(str, base));
      // characters on placed lines
      const placed = new Uint8Array(str.length);
      const lineOf = new Int32Array(str.length);
      layout.lines.forEach((l, li) => {
        for (let i = l.start; i < l.end && i < str.length; i++) {
          placed[i] = 1;
          lineOf[i] = li;
        }
      });
      let remainderStart = str.length;
      if (overflow === 'TRUNCATE')
        for (let i = 0; i < str.length; i++)
          if (!placed[i] && str[i] !== '\n') {
            remainderStart = i;
            break;
          }
      const refs: InstanceReference[] = [];
      const refIdx = new Map<string, number>();
      const transforms: number[] = [];
      const refIndex: number[] = [];
      const lines: number[] = [],
        words: number[] = [],
        pivots: number[] = [];
      const pivot = String(prop(ctx.node, 'Pivot Point'));
      let word = 0;
      let line = 0;
      for (let i = 0; i < Math.min(str.length, remainderStart); i++) {
        const ch = str[i];
        // whitespace starts the next word (a run of it belongs to the word after it)
        if (/\s/.test(ch) && i > 0 && !/\s/.test(str[i - 1])) word++;
        if (placed[i]) line = lineOf[i];
        else if (ch !== '\n') continue;
        const key = `${font ?? ''}|${size}|${ch}`;
        let geo = charCache.get(key);
        if (!geo) {
          const single = /\s/.test(ch) ? null : textLayout.fn(textData(ch, { size, font: font ?? null }));
          const [ox, oy] = single?.carets[0] ?? [0, 0];
          geo = single ? new GeometrySet(undefined, undefined, splinesToCurves(single.splines, ox, oy)) : GeometrySet.empty();
          if (charCache.size > 2000) charCache.clear();
          if (geo.curves?.pointCount || /\s/.test(ch)) charCache.set(key, geo);
        }
        let r = refIdx.get(key);
        if (r === undefined) {
          r = refs.length;
          refs.push({ type: 'GEOMETRY', geometry: geo, key: `char:${key}` });
          refIdx.set(key, r);
        }
        const [x, y] = layout.carets[i];
        transforms.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1);
        refIndex.push(r);
        lines.push(line);
        words.push(word);
        // pivot of the character's outline bounds
        const P = geo.curves?.positions ?? new Float32Array(3);
        let x0 = Infinity,
          x1 = -Infinity,
          y0 = Infinity,
          y1 = -Infinity;
        for (let k = 0; k < P.length; k += 3) {
          x0 = Math.min(x0, P[k]);
          x1 = Math.max(x1, P[k]);
          y0 = Math.min(y0, P[k + 1]);
          y1 = Math.max(y1, P[k + 1]);
        }
        const px = pivot.endsWith('Left') ? x0 : pivot.endsWith('Right') ? x1 : (x0 + x1) / 2;
        const py = pivot.startsWith('Top') ? y1 : pivot.startsWith('Bottom') ? y0 : (y0 + y1) / 2;
        pivots.push(x + px, y + py, 0);
      }
      const inst = new InstancesComponent(Float32Array.from(transforms), Int32Array.from(refIndex), refs);
      const out: Record<string, unknown> = { Remainder: str.slice(remainderStart) };
      for (const [k, data, t] of [
        ['Line', Int32Array.from(lines), 'INT'],
        ['Word', Int32Array.from(words), 'INT'],
        ['Pivot Point', Float32Array.from(pivots), 'VECTOR'],
      ] as const) {
        if (!ctx.used(k)) {
          out[k] = new InputField(t, `none:${k}`, () => ({ data: t === 'INT' ? new Int32Array(1) : new Float32Array(3), single: true }));
          continue;
        }
        const name = ctx.anon(k);
        inst.attrs.set(name, { domain: 'INSTANCE', type: t === 'INT' ? 'INT' : 'FLOAT_VECTOR', data });
        out[k] = attributeField(name, t);
      }
      out['Curve Instances'] = refIndex.length ? new GeometrySet(undefined, undefined, undefined, inst) : GeometrySet.empty();
      return out as Record<string, never>;
    },
    // re-run once the fonts have loaded
    sig: () => (textLayout.fn(textData('A', { size: 1 })).splines.length ? 'fonts' : 'no-fonts'),
  },
  {
    menus: {
      'Align X': items(ALIGN_X),
      'Align Y': items(ALIGN_Y),
      'Pivot Point': PIVOTS.map((p) => [p, p]),
      Overflow: items(OVERFLOW),
    },
    available: (n, s, out) => {
      const ov = String(prop(n, 'Overflow'));
      if (out) return s.identifier === 'Remainder' ? ov === 'Truncate' : true;
      if (s.identifier === 'Text Box Height') return ov !== 'Overflow';
      return true;
    },
  },
);

place('Utilities/Text', 'GeometryNodeStringJoin');
place('Utilities/Text', 'GeometryNodeStringToCurves');
