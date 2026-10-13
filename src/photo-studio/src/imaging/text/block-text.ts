// Block text: every line of point text is scaled so that all lines share one
// width, and the lines are stacked tightly by their capital height, like a
// poster headline. It is applied to a finished horizontal layout, so line
// breaking, shaping, kerning and features are unchanged; each line is then
// scaled uniformly about its own left end (glyphs, carets, decorations).
import type { Decoration, GlyphRun, LayoutLine, Rect, TextLayout } from './layout';
import type { TextLayerData } from './model';

export type BlockText = NonNullable<TextLayerData['block']>;
type Core = Pick<TextLayout, 'lines' | 'runs' | 'decorations' | 'bounds'>;

// Proportions of the em used to stack lines: capital height above the
// baseline, and descenders below it when the line has any.
const CAP = 0.7;
const DESCENDER = 0.22;
const hasDescender = (text: string) => /[gjpqyQJ,;()[\]{}|@$§¶_]/.test(text);

/** Scale each line of `core` to `block.width` and stack the lines from the
 * first baseline (`originY`); `left` is where every line starts. */
export function applyBlock<T extends Core>(core: T, block: BlockText, left: number, originY: number, text: (start: number, end: number) => string): T {
  const W = Math.max(1, block.width);
  const gap = Number.isFinite(block.gap) ? block.gap : 0;
  const lines: LayoutLine[] = [];
  const runs: GlyphRun[] = [];
  const decorations: Decoration[] = [];
  let baseline = originY;
  let prevBottom: number | undefined;
  for (const l of core.lines) {
    const lineRuns = core.runs.filter((r) => r.start >= l.start && r.end <= l.end);
    const em = Math.max(0, ...lineRuns.map((r) => r.sizePx)) || l.ascent;
    const s = l.width > 0.5 ? W / l.width : 1;
    const top = CAP * em * s;
    const bottom = hasDescender(text(l.start, l.end)) ? DESCENDER * em * s : 0;
    if (prevBottom !== undefined) baseline += prevBottom + gap + top;
    prevBottom = bottom;
    const map = (x: number, y: number): [number, number] => [left + (x - l.x) * s, baseline + (y - l.y) * s];
    lines.push({
      ...l,
      x: left,
      y: baseline,
      width: l.width * s,
      ascent: l.ascent * s,
      descent: l.descent * s,
      leading: l.leading * s,
      stopPos: l.stopPos.map((p) => left + (p - l.x) * s),
      ...(l.boxes ? { boxes: l.boxes.map((b) => ({ ...b, x0: left + (b.x0 - l.x) * s, x1: left + (b.x1 - l.x) * s })) } : {}),
    });
    for (const r of lineRuns) {
      const [x, y] = map(r.x, r.y);
      runs.push({
        ...r,
        x,
        y,
        width: r.width * s,
        advances: r.advances.map((a) => a * s),
        sizePx: r.sizePx * s,
        letterSpacing: r.letterSpacing * s,
        ascent: r.ascent * s,
        descent: r.descent * s,
        font: r.font.replace(/(\d+(?:\.\d+)?)px/, (_, v: string) => `${Math.round(Number(v) * s * 1000) / 1000}px`),
      });
    }
    for (const d of core.decorations) {
      if (Math.abs(d.y - l.y) > l.ascent + l.descent || d.x < l.x - 0.5 || d.x > l.x + l.width + 0.5) continue;
      const [x, y] = map(d.x, d.y);
      decorations.push({ ...d, x, y, width: d.width * s, thickness: d.thickness * s });
    }
  }
  const visible = lines.filter((l) => l.visible);
  const bounds = union(visible.map((l) => ({ x: l.x, y: l.y - l.ascent, width: l.width, height: l.ascent + l.descent })));
  return { ...core, lines, runs, decorations, bounds };
}

function union(rs: Rect[]): Rect {
  if (!rs.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x0 = Math.min(...rs.map((r) => r.x)),
    y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.width)),
    y1 = Math.max(...rs.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Block settings for text whose widest line is `widest` pixels wide. */
export function blockFor(widest: number, gap?: number): BlockText {
  const width = Math.max(8, Math.round(widest));
  return { width, gap: gap ?? Math.round(width * 0.03) };
}
