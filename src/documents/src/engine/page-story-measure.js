import { layoutDocument } from './layout.js';
import { paragraphFormat } from './model.js';
import { isPositionedImage } from './images.js';
import { pageFieldValue } from './docx-page-fields.js';
import { resolveStyledParagraph } from './styles.js';
import { pageStoryPositions } from './page-story-positions.js';

// The body clearance and story painter must measure the same generated text.
export function measurePageStory(story, geometry, measure, numbering, context, { styles, drawingLayouts, onUnsupported } = {}) {
  const source = styles ? story.paragraphs.map(p => resolveStyledParagraph(structuredClone(p), styles, numbering)) : story.paragraphs;
  const paragraphs = source.map(p => ({ ...p, runs: p.runs.map(r => {
    if (!r.field) return r;
    let text;
    try { text = pageFieldValue(r.field, { ...context, pageStory: true }); }
    catch (error) { if (!onUnsupported) throw error; onUnsupported(error); }
    return { ...r, text: text ?? r.field.cachedText, ...(text != null && r.field.type === 'PAGE' ? { capitalization: 'normal' } : {}) };
  }) }));
  const storyGeometry = { ...geometry, top: 0, bottom: 0, pageBounds: undefined, boundsBase: undefined, boundsOrigin: undefined };
  const placed = layoutDocument(paragraphs, measure, storyGeometry, numbering, story.tables || [], undefined,
    { drawingLayouts, bestEffort: !!onUnsupported, frameGeometry: geometry, previewCellPageBreaks: !!onUnsupported, previewRotatedCells: !!onUnsupported, previewNegativeWrap: !!onUnsupported, previewManualBreakWrap: !!onUnsupported });
  for (const approximation of [...(placed.floatingTableApproximations || []), ...(placed.frameApproximations || []), ...(placed.rotatedCellApproximations || []), ...(placed.negativeWrapApproximations || []), ...(placed.manualBreakWrapApproximations || [])]) onUnsupported(new Error(approximation.message));
  // Notes are measured as 'footnote' stories (endnotes included).
  if (placed.pageCount !== 1) throw new Error(`This ${geometry.storyKind === 'footnote' ? 'footnote or endnote' : 'header or footer'} is taller than a page.`);
  const last = placed.lines.at(-1), format = paragraphFormat(paragraphs.at(-1), numbering);
  const visible = last?.fragments.filter(f => !isPositionedImage(f.image)) || [];
  const trim = geometry.storyKind === 'footer' && !last?.cellId && format.lineRule === 'auto' && format.lineSpacing === 1 && visible.length && visible.every(f => f.image)
    ? Math.max(0, last.y + last.height - last.baseline - Math.max(0, ...visible.map(f => f.descent))) : 0;
  return { placed, trim, storyGeometry, positions: pageStoryPositions(source, paragraphs) };
}
