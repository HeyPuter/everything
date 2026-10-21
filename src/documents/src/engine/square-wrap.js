import { EMU_PER_PX, isSideWrappedImage } from './images.js';

// §20.4.2.17: distances expand the drawing's rectangular exclusion area.
export function squareExclusions(layout) {
  // Hidden drawings (§20.4.2.5) do not push text aside.
  return layout.floatingObjects.filter(f => isSideWrappedImage(f.image) && !f.image.hidden).map(f => {
    const d = f.image.anchor.distances, e = f.image.effectExtent || {};
    return { page: f.page, left: f.x - ((d?.L || 0) + (e.left || 0)) / EMU_PER_PX,
      right: f.x + f.width + ((d?.R || 0) + (e.right || 0)) / EMU_PER_PX,
      top: f.y - ((d?.T || 0) + (e.top || 0)) / EMU_PER_PX,
      bottom: f.y + f.height + ((d?.B || 0) + (e.bottom || 0)) / EMU_PER_PX,
      side: f.image.anchor.wrapText };
    }).concat((layout.floatingTables || []).map(f => ({ page:f.page, table:true,
      // Page/margin-positioned tables also exclude text before their anchor.
      // Text-relative tables follow their anchor; extending that exclusion
      // backwards would make the table chase the preceding paragraph.
      start:f.cellId || f.position.vertAnchor === 'text' ? f.start : undefined, cellId:f.cellId,
      left:f.wrapBounds ? Math.min(f.left-24/15,f.wrapBounds.left-f.position.leftFromText/15) : f.left-(f.cellId ? f.position.leftFromText+12 : Math.max(24,f.position.leftFromText+15))/15,
      right:f.wrapBounds ? Math.max(f.right+24/15,f.wrapBounds.right+f.position.rightFromText/15) : f.right+(f.cellId ? f.position.rightFromText+15 : Math.max(24,f.position.rightFromText+15))/15, top:(f.wrapBounds?.top ?? f.top)-f.position.topFromText/15,
      bottom:(f.wrapBounds?.bottom ?? f.bottom)+f.position.bottomFromText/15, side:'both' })))
    .concat((layout.paragraphFrames || []).filter(f => f.wrap !== 'none').map(f => ({
      page: f.page, frameId: f.frameId, start: f.vAnchor === 'text' ? f.start : undefined,
      left: f.wrap === 'notBeside' ? -Infinity : f.left - f.hSpace,
      right: f.wrap === 'notBeside' ? Infinity : f.right + f.hSpace,
      top: f.top - f.vSpace, bottom: f.bottom + f.vSpace, side: 'largest',
    })));
}

export function squareIntervals(left, right, top, height, page, exclusions) {
  let intervals = [{ left, right }];
  // A body line ending exactly at a floating table's top is displaced;
  // one twip of separation is sufficient. Nested tables and pictures retain
  // strict overlap, as independently captured by their existing native controls.
  const active = exclusions.filter(e => e.page === page && (e.table && !e.cellId ? e.top <= top + height + 1e-6 : e.top < top + height - 1e-6) && e.bottom > top + 1e-6 && e.left < right && e.right > left);
  for (const e of active) {
    const side = e.side === 'largest' ? e.left - left > right - e.right ? 'left' : 'right' : e.side;
    intervals = intervals.flatMap(i => [
      ...(side !== 'right' && e.left > i.left ? [{ left: i.left, right: Math.min(i.right, e.left) }] : []),
      ...(side !== 'left' && e.right < i.right ? [{ left: Math.max(i.left, e.right), right: i.right }] : []),
    ]).filter(i => i.right - i.left >= 1 - 1e-6);
  }
  return { intervals, nextY: active.length ? Math.min(...active.map(e => e.bottom)) : top };
}

// Use actual page placement as the next measurement's coordinates. Anchors
// may move with keep/widow rules; a converged placement is required before paint.
export function squareFlowHints(layout) {
  const paragraphs = new Map();
  for (const line of layout.lines) {
    if (!paragraphs.has(line.paragraphId)) paragraphs.set(line.paragraphId, []);
    paragraphs.get(line.paragraphId).push(line);
  }
  const shifts = new Map(layout.lines.filter(l => l.pageMarginShift !== undefined).map(l => [l.page, l.pageMarginShift]));
  return { paragraphs, exclusions: squareExclusions(layout).map(e => {
    const dx = shifts.get(e.page) || 0;
    return dx ? { ...e, left: e.left - dx, right: e.right - dx } : e;
  }) };
}

export function squareFlowSignature(layout) {
  return JSON.stringify([layout.lines.map(l => [l.paragraphId, l.start, l.end, l.page, l.y, l.height, l.baseline, l.stops.map(s => [s.offset, s.x])]), squareExclusions(layout)]);
}

// §17.18.3: LTR left clearance acts only in the leftmost text region;
// right clearance acts when an object interrupts flow to the right.
export function clearingBreakTarget(hints, paragraphId, offset, clear, interval, firstRegion, edges) {
  if (!clear || clear === 'none' || clear === 'left' && !firstRegion) return null;
  if (interval.left <= edges.left + 1e-6 && interval.right >= edges.right - 1e-6) return null;
  const line = hints?.paragraphs.get(paragraphId)?.find(l => l.start <= offset && l.end >= offset);
  if (!line) return null;
  const y = line.y + (line.wrapBefore || 0), height = line.height - (line.wrapBefore || 0);
  const active = hints.exclusions.filter(e => e.page === line.page && (e.start === undefined || offset >= e.start) &&
    e.top < y + height - 1e-6 && e.bottom > y + 1e-6 && e.left < edges.right && e.right > edges.left &&
    (clear === 'all' || clear === 'left' && e.right <= interval.left + 1e-6 || clear === 'right' && e.left >= interval.right - 1e-6));
  if (!active.length) return null;
  return { page: line.page, startY: line.y + line.height, nextStart: offset + 1, bottom: Math.max(...active.map(e => e.bottom)), clear };
}

// Whether hints can change a paragraph's rows at all. squareRow places each row at a line the
// paragraph had in the previous pass, or past its last line on that page or the next one, and a
// clearing break looks only at those lines. Without an exclusion on any of those pages, every row
// takes the full writing width, exactly as measured without hints.
export function squareHintsReach(hints, paragraphId) {
  const lines = hints?.paragraphs.get(paragraphId);
  if (!lines?.length || !hints.exclusions.length) return false;
  let first = Infinity, last = -Infinity;
  for (const line of lines) { first = Math.min(first, line.page); last = Math.max(last, line.page); }
  return hints.exclusions.some(e => e.page >= first && e.page <= last + 1);
}

export function squareRow(hints, paragraphId, index, edges, page, minimumWidth = 0, paragraphBefore = 0, clearance = null) {
  const previous = hints?.paragraphs.get(paragraphId);
  if (!previous?.length) return { intervals: [edges], before: 0 };
  const line = previous[Math.min(index, previous.length - 1)];
  const height = line.height - (line.wrapBefore || 0);
  const fitHeight = (line.fitHeight ?? line.height) - (line.wrapBefore || 0);
  let y = clearance?.startY ?? line.y + Math.max(0, index - previous.length + 1) * height, pageIndex = clearance?.page ?? line.page;
  if (!clearance) while (y + fitHeight > page.height - page.bottom + 1e-6 && !(line.oversizedInlineHeight && y <= page.top + 1e-6)) { y = page.top; pageIndex++; }
  const initial = y;
  if (clearance) y = Math.max(y, clearance.bottom);
  for (let attempt = 0; attempt <= hints.exclusions.length; attempt++) {
    const exclusions = hints.exclusions.filter(e => e.start === undefined || (clearance?.nextStart ?? line.start) >= e.start);
    const result = squareIntervals(edges.left, edges.right, y, height, pageIndex, exclusions);
    const intervals = minimumWidth ? result.intervals.filter(i => i.right - i.left >= minimumWidth - 1e-6) : result.intervals;
    const region = intervals[0];
    const cleared = !clearance || region &&
      (clearance.clear === 'left' ? region.left <= edges.left + 1e-6
        : clearance.clear === 'right' ? region.right >= edges.right - 1e-6
          : region.left <= edges.left + 1e-6 && region.right >= edges.right - 1e-6);
    if (intervals.length && cleared) return { intervals, before: y - initial,
      ...(clearance ? { clearancePage: clearance.page, clearanceBefore: y - initial } : {}) };
    // The first paragraph keeps its own before-spacing after clearing a
    // floating table. The gap to the preceding paragraph has already been
    // used to position the table and must not swallow this fresh text gap.
    const table = index === 0 && paragraphBefore && exclusions.some(e => e.table && e.page === pageIndex &&
      Math.abs(e.bottom - result.nextY) < 1e-6 && (e.cellId ? e.top < y + height - 1e-6 : e.top <= y + height + 1e-6) && e.bottom > y + 1e-6 && e.left < edges.right && e.right > edges.left);
    y = result.nextY + (table ? paragraphBefore : 0);
  }
  throw new Error('Square wrapping leaves no text interval.');
}

export function joinSquareLine(pieces, before, format) {
  const first = pieces[0], last = pieces.at(-1);
  if (pieces.length === 1) return { ...first, baseline: first.baseline + before, height: first.height + before, fitHeight: (first.fitHeight ?? first.height) + before, wrapBefore: before, wrapSegments: pieces };
  // The two intervals share one line box. In particular, mixed font metrics
  // must not increase an authored exact height by joining two local baselines.
  const ascent = Math.max(...pieces.map(p => p.ascent)), descent = Math.max(...pieces.map(p => p.descent));
  const natural = ascent + descent;
  const spacingAscent = Math.max(...pieces.map(p => p.spacingAscent ?? p.ascent));
  const spacingDescent = Math.max(...pieces.map(p => (p.spacingHeight ?? p.ascent + p.descent) - (p.spacingAscent ?? p.ascent)));
  const exact = format.lineRule === 'exact' && format.lineSpacing !== 0;
  const height = format.lineRule === 'auto' ? natural + (spacingAscent + spacingDescent) * (format.lineSpacing - 1)
    : exact ? format.lineSpacing * 4 / 3 : Math.max(natural, format.lineSpacing * 4 / 3);
  const imageOnly = pieces.every(p => p.imageOnly);
  const baseline = exact ? height * .8 : imageOnly && format.lineRule === 'atLeast' ? height - descent
    : format.lineRule === 'auto' ? ascent + spacingAscent * (Math.min(1, format.lineSpacing) - 1)
    : ascent + (height >= natural ? (height - natural) / 2 : height - natural);
  return { ...first, end: last.end, paragraphEnd: last.paragraphEnd, hardBreak: last.hardBreak,
    ...(last.pageBreakWithMark ? { pageBreakWithMark: true } : {}),
    baseline: baseline + before, height: height + before, fitHeight: (format.lineRule === 'auto' ? Math.min(height,natural) : height) + before, wrapBefore: before,
    wrapSegments: pieces, ascent, descent,
    ...(pieces.some(p => p.oversizedInlineHeight) ? { oversizedInlineHeight: true } : {}),
    ...Object.fromEntries(['fragments', 'stops', 'leaders', 'backgrounds', 'underlines', 'strikes'].map(key => [key, pieces.flatMap(p => p[key])])),
  };
}
