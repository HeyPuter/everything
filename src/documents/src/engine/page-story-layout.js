import { measurePageStory, storyContentKey } from './page-story-measure.js';
import { pageStoryPath } from './page-stories.js';
import { positionedImageFrame } from './positioned-images.js';
import { resolveDrawingCollisions } from './drawing-collisions.js';
import { isPositionedImage } from './images.js';
import { pageNumberSequence } from './page-numbering.js';
import { resolveStyledParagraph } from './styles.js';
import { shiftCellClip } from './cell-clipping.js';
import { referencePageGeometry } from './page-settings.js';
import { measureNote, FOOTNOTE_SEPARATOR } from './footnote-layout.js';
import { watermarkFrame } from './vml-watermarks.js';

// Page stories have their own offsets and are kept outside body hit testing.
export function layoutPageStories(body, definition, sectionSettings, measure, numbering, { bestEffort = false, styles, drawingLayouts } = {}) {
  const lines = [], borders = [], cells = [], tableBorders = [], floatingObjects = [], paragraphFrames = [], unsupported = [];
  // Word watermarks (retained VML in a header or footer), placed on each page that shows their story.
  const watermarks = [];
  const borderMargins = [];
  const positions = [];
  if (!definition) return { lines, borders, cells, tableBorders, floatingObjects, paragraphFrames, unsupported, borderMargins, watermarks };
  const resolved = new Map(), storyKeys = new WeakMap();
  // A measurer that remembers stories resolves their styles only when it measures one it has not seen.
  const remembered = !!(styles && measure.paragraphCache);
  const styleOptions = remembered ? { styles, stylesKey: JSON.stringify(styles) } : {};
  const storyParagraphs = (path, story) => {
    if (!styles || remembered) return story.paragraphs;
    if (!resolved.has(path)) resolved.set(path, story.paragraphs.map(p => resolveStyledParagraph(structuredClone(p), styles, numbering)));
    return resolved.get(path);
  };
  const firstPages = new Map(), counts = new Map();
  body.pageSections.forEach((owner, page) => {
    const sections = body.pageRegions?.[page] ? new Set(body.pageRegions[page].map(r => r.section)) : [owner];
    for (const section of sections) {
      if (section === null) continue;
      if (!firstPages.has(section)) firstPages.set(section, page);
      counts.set(section, (counts.get(section) || 0) + 1);
    }
  });
  const numbers = pageNumberSequence(body.pageSections, definition, body.numberingApproximations);
  for (let page = 0; page < body.pageCount; page++) {
    const section = body.pageSections[page], settings = sectionSettings[section], geometry = referencePageGeometry(body.pages[page]);
    if (section === null) continue;
    for (const kind of ['header', 'footer']) {
      const path = pageStoryPath(definition, section, kind, numbers[page], firstPages.get(section) === page);
      const story = path && definition.stories[path];
      if (!story?.paragraphs?.length) continue;
      for (const p of story.paragraphs) for (const run of p.runs) if (run.vml?.watermark) watermarks.push({ page, pageStory: path, watermark: run.vml.watermark, ...watermarkFrame(run.vml.watermark, geometry) });
      if (geometry.pageBorders?.offsetFrom === 'text') {
        const excluded = kind === 'header' ? geometry.bordersDoNotSurroundHeader : geometry.bordersDoNotSurroundFooter;
        const side = kind === 'header' ? 'top' : 'bottom';
        if (!excluded) (borderMargins[page] ||= {})[side] = Math.min(geometry[side], settings[kind] / 15);
      }
      try {
        const { placed, trim, storyGeometry, positions: storyPositions } = measurePageStory({ ...story, paragraphs: storyParagraphs(path, story) }, { ...geometry, storyKind: kind }, measure, numbering,
          { pageNumber: numbers[page], pageCount: body.pageCount, sectionPageCount: counts.get(section), pageNumbering: definition.sections[section].pageNumbering },
          { drawingLayouts, onUnsupported: bestEffort ? error => unsupported.push({ path, page, message: error.message }) : undefined, storyKeys, ...styleOptions, contentKey: storyContentKey(definition, path) });
        positions.push({ path, page, positions: storyPositions });
        const y = kind === 'header' ? settings.header / 15 : geometry.height - settings.footer / 15 - placed.endY + trim;
        const frames = new Map((placed.paragraphFrames || []).map(f=>[f.frameId,f]));
        const shiftY = item => item.frameId && frames.get(item.frameId)?.vAnchor !== 'text' ? 0 : y;
        const shifted = item => ({ ...item, page, pageStory: path, y: item.y + shiftY(item),
          ...(item.cellClip ? { cellClip: shiftCellClip(item.cellClip, shiftY(item)) } : {}) });
        const storyCells = placed.cells.map(shifted);
        const storyLines = placed.lines.map(line => ({ ...shifted(line), storyGeometry, baseline: line.baseline + shiftY(line) }));
        paragraphFrames.push(...(placed.paragraphFrames||[]).map(frame=>({ ...frame, page, pageStory:path,
          top:frame.top+shiftY(frame),bottom:frame.bottom+shiftY(frame) })));
        const objects = [];
        for (const line of storyLines) for (const fragment of line.fragments) if (isPositionedImage(fragment.image)) {
          const first = fragment.image.anchor.vertical === 'line' ? line : storyLines.find(l => l.paragraphId === line.paragraphId);
          const cell = line.cellId ? storyCells.find(c => c.id === line.cellId) : null;
          const anchor = fragment.image.anchor;
          const anchorGeometry = anchor.yPercentage === undefined ? geometry : { ...geometry,
            drawingBounds: body.pageRegions?.[page]?.find(region => region.section === section)?.drawingBounds };
          objects.push({ ...positionedImageFrame(fragment, first, anchorGeometry, cell), pageStory: path });
        }
        resolveDrawingCollisions(objects, body.pages);
        objects.sort((a, b) => a.image.anchor.order - b.image.anchor.order);
        lines.push(...storyLines); cells.push(...storyCells); floatingObjects.push(...objects);
        tableBorders.push(...placed.tableBorders.map(border => ({ ...shifted(border),
          ...(border.clip ? { clip: border.clip.map(([x, top]) => [x, top + y]) } : {}) })));
        for (const border of placed.paragraphBorders) borders.push({ ...shifted(border),
          ...(border.clip ? { clip: border.clip.map(([x, top]) => [x, top + shiftY(border)]) } : {}) });
      } catch (error) {
        if (!bestEffort) throw error;
        unsupported.push({ path, page, message: error.message });
      }
    }
  }
  // Footnotes stack below the separator in each page's reserved area; endnotes
  // follow the body's last line at the positions the body layout assigned them.
  const areas = [...(body.footnoteAreas || []).map(area => ({ area, kind: 'footnote' })), ...(body.endnoteAreas || []).map(area => ({ area, kind: 'endnote' }))];
  for (const { area, kind } of areas) {
    const geometry = referencePageGeometry(body.pages[area.page]), shown = new Map(area.notes.map(note => [note.id, note.display])), shownKey = JSON.stringify([kind, ...shown]);
    const numbers = kind === 'footnote' ? shown : { footnote: new Map(), endnote: shown };
    let y = area.top + (area.separator === false ? 0 : FOOTNOTE_SEPARATOR);
    for (const note of area.notes) {
      const story = definition.stories[note.path];
      if (!story) continue;
      if (note.y !== undefined) y = note.y;
      try {
        const { placed, storyGeometry, positions: storyPositions } = measureNote({ ...story, paragraphs: storyParagraphs(note.path, story) }, note.display, numbers, geometry, measure, numbering, { drawingLayouts, bestEffort, storyKeys, ...styleOptions, storyStylesKey: styleOptions.stylesKey, contentKey: storyContentKey(definition, note.path, note.display, shownKey) });
        positions.push({ path: note.path, page: area.page, positions: storyPositions });
        const top = y, shifted = item => ({ ...item, page: area.page, pageStory: note.path, y: item.y + top, ...(item.cellClip ? { cellClip: shiftCellClip(item.cellClip, top) } : {}) });
        lines.push(...placed.lines.map(line => ({ ...shifted(line), storyGeometry, baseline: line.baseline + top })));
        cells.push(...placed.cells.map(shifted));
        tableBorders.push(...placed.tableBorders.map(border => ({ ...shifted(border), ...(border.clip ? { clip: border.clip.map(([x, t]) => [x, t + top]) } : {}) })));
        for (const border of placed.paragraphBorders) borders.push({ ...shifted(border), ...(border.clip ? { clip: border.clip.map(([x, t]) => [x, t + top]) } : {}) });
        y += placed.endY;
      } catch (error) {
        if (!bestEffort) throw error;
        unsupported.push({ path: note.path, page: area.page, message: error.message });
      }
    }
  }
  return { lines, borders, cells, tableBorders, floatingObjects, paragraphFrames, unsupported, borderMargins, positions, watermarks };
}
