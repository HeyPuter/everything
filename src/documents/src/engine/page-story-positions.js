// Page-field results are display text. Each retained field still occupies one
// source position; the cached/printed number must never become editable text.
export function pageStoryPositions(source, displayed) {
  const fields = [];
  let sourceAt = 0, displayAt = 0;
  source.forEach((paragraph, index) => {
    paragraph.runs.forEach((run, runIndex) => {
      const length = displayed[index].runs[runIndex].text.length;
      if (run.field) fields.push({ sourceStart: sourceAt, sourceEnd: sourceAt + run.text.length, start: displayAt, end: displayAt + length });
      sourceAt += run.text.length; displayAt += length;
    });
    sourceAt++; displayAt++;
  });
  return fields;
}

function storyPositionMapper(fields) {
  const inside = position => fields.find(f => f.start < position && position < f.end);
  const toSource = (position, edge = 'nearest') => {
    const empty = fields.filter(f => f.start === position && f.end === position);
    if (empty.length) return edge === 'start' ? empty[0].sourceStart : empty.at(-1).sourceEnd;
    let delta = 0;
    for (const field of fields) {
      if (position < field.start) break;
      if (position <= field.end) {
        if (position === field.start && field.start !== field.end) return field.sourceStart;
        if (position === field.end && field.start !== field.end) return field.sourceEnd;
        return edge === 'start' || edge === 'nearest' && position - field.start < (field.end - field.start) / 2 ? field.sourceStart : field.sourceEnd;
      }
      delta = field.sourceEnd - field.end;
    }
    return position + delta;
  };
  return { fields, inside, toSource };
}

// Construct the selection surface for one physical occurrence of a story.
// Painting continues to use the original display offsets and geometry.
export function pageStorySelectionLayout(body, stories, path, page) {
  const positions = stories.positions?.find(p => p.path === path && p.page === page)?.positions;
  if (!positions) throw new Error('The selected page story is not laid out on this page.');
  const { toSource, inside } = storyPositionMapper(positions);
  const range = item => ({ ...item, ...(item.start !== undefined ? { start: toSource(item.start, 'start') } : {}), ...(item.end !== undefined ? { end: toSource(item.end, 'end') } : {}) });
  const stops = list => {
    const visible = list.filter(stop => !inside(stop.offset));
    // A field can wrap onto another line: retain that line's visible edges for
    // hit testing/selection, but never expose positions inside its result.
    if (list.length && !visible.includes(list[0])) visible.unshift({ ...list[0], offset: list[0].offset, sourceEdge: 'start' });
    if (list.length > 1 && !visible.includes(list.at(-1))) visible.push({ ...list.at(-1), sourceEdge: 'end' });
    return visible.flatMap(({ sourceEdge, ...stop }) => {
      const empty = positions.filter(f => f.start === stop.offset && f.end === stop.offset);
      return empty.length ? [empty[0].sourceStart, ...empty.map(f => f.sourceEnd)].map(offset => ({ ...stop, offset }))
        : [{ ...stop, offset: toSource(stop.offset, sourceEdge) }];
    });
  };
  const fragment = item => ({ ...range(item), ...(item.caretStops ? { caretStops: stops(item.caretStops) } : {}) });
  const line = item => ({ ...range(item), stops: stops(item.stops), fragments: item.fragments.map(fragment),
    ...(item.wrapSegments ? { wrapSegments: item.wrapSegments.map(line) } : {}),
    ...(item.cellText ? { cellText: { ...item.cellText, line: line(item.cellText.line) } } : {}) });
  const owned = items => (items || []).filter(item => item.pageStory === path && item.page === page);
  return { ...body, lines: owned(stories.lines).map(line), repeatedLines: [],
    cells: owned(stories.cells), tableWidths: stories.tableWidths?.[path] || {}, floatingObjects: owned(stories.floatingObjects).map(range),
    paragraphFrames: owned(stories.paragraphFrames).map(range),
    hasRotatedCells: owned(stories.lines).some(item => item.cellText),
  };
}
