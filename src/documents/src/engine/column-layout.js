import { sectionColumnIntervals } from './section-columns.js';

export function columnAtPoint(page, x) {
  if (!page?.columns || page.storyKind) return null;
  const intervals = sectionColumnIntervals(page.columns, page.left * 15, (page.width - page.left - page.right) * 15);
  const distance = i => Math.max(i.left / 15 - x, 0, x - i.right / 15);
  return intervals.reduce((best, item, index) => distance(item) < distance(intervals[best]) ? index : best, 0);
}

export function columnFlowPage(page) {
  if (!page.columns || page.storyKind || page.tableDepth) return page;
  const intervals = sectionColumnIntervals(page.columns, page.left * 15, (page.width - page.left - page.right) * 15);
  const physicalBounds = page.pageBounds;
  return { ...page, right: page.width - intervals[0].right / 15,
    flowColumns: intervals.length,
    ...(physicalBounds ? { pageBounds: index => physicalBounds(Math.floor(index / intervals.length)) } : {}) };
}

const shiftClip = (clip, dx) => clip && ({ ...clip,
  ...(clip.left !== undefined ? { left: clip.left + dx } : {}),
  ...(clip.right !== undefined ? { right: clip.right + dx } : {}),
});
function shiftLine(line, page, dx, column) {
  const result = { ...line, page, column, columnOffset: dx,
    fragments: line.fragments.map(f => ({ ...f, x: f.x + dx })),
    stops: line.stops.map(s => ({ ...s, x: s.x + dx })),
  };
  for (const key of ['underlines', 'strikes', 'backgrounds', 'leaders']) if (line[key]) result[key] = line[key].map(s => ({ ...s, x: s.x + dx }));
  if (line.marker) result.marker = { ...line.marker, x: line.marker.x + dx };
  if (line.paragraphBackground) result.paragraphBackground = { ...line.paragraphBackground, x: line.paragraphBackground.x + dx };
  if (line.paragraphFrame) result.paragraphFrame = { ...line.paragraphFrame, x: line.paragraphFrame.x + dx, right: line.paragraphFrame.right + dx };
  for (const key of ['cellClip', 'textClip']) if (line[key]) result[key] = shiftClip(line[key], dx);
  for (const key of ['columnLeft', 'hangingRight', 'hangingLeft']) if (line[key] !== undefined) result[key] = line[key] + dx;
  return result;
}

/** Map paginated column slots to physical pages without changing source order. */
export function placeColumnFlow(result, physicalPage) {
  if (!physicalPage.columns || physicalPage.storyKind || physicalPage.tableDepth) return result;
  const intervals = sectionColumnIntervals(physicalPage.columns, physicalPage.left * 15, (physicalPage.width - physicalPage.left - physicalPage.right) * 15);
  const count = intervals.length;
  const position = item => ({ page: Math.floor(item.page / count), column: item.page % count, dx: intervals[item.page % count].left / 15 - physicalPage.left });
  const line = item => {
    const { page, column, dx } = position(item);
    const shifted = shiftLine(item, page, dx, column);
    shifted.columnLeft ??= intervals[column].left / 15;
    shifted.columnRight = intervals[column].right / 15;
    return shifted;
  };
  return { ...result, pageCount: Math.ceil(result.pageCount / count),
    lines: result.lines.map(line), repeatedLines: result.repeatedLines.map(line),
    cells: result.cells.map(item => { const { page, column, dx } = position(item); return { ...item, page, column, x: item.x + dx, ...(item.cellClip ? { cellClip: shiftClip(item.cellClip, dx) } : {}) }; }),
  };
}
