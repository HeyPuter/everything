import { layoutDocument } from './layout.js';
import { paragraphFormat } from './model.js';
import { isPositionedImage } from './images.js';
import { pageFieldValue } from './docx-page-fields.js';
import { resolveStyledParagraph } from './styles.js';
import { pageStoryPositions } from './page-story-positions.js';
import { revisionViewKey } from './revisions.js';

// Development builds check that a content name always stands for the same content.
const namedContent = new Map();
function checkNamedContent(name, content) {
  if (!import.meta.env?.DEV) return;
  const json = JSON.stringify(content), seen = namedContent.get(name);
  if (seen !== undefined && seen !== json) throw new Error(`Story content changed under the same name (${name}).`);
  namedContent.set(name, json);
}

/**
 * A serializer for one layout of a document (its body and page stories): each object it is given, such as
 * the styles or the list definitions, is serialized once however many keys read it. Objects must not
 * change while the layout runs; a new layout takes a new serializer.
 */
export function layoutSerializer() {
  const serialized = new Map();
  return value => {
    if (!value || typeof value !== 'object') return JSON.stringify(value ?? null);
    let text = serialized.get(value);
    if (text === undefined) serialized.set(value, text = JSON.stringify(value));
    return text;
  };
}

/**
 * Page stories as layout keys them: the session's version of their content (StorySession
 * pageStories) when it has one, so an edit to the body does not serialize every story again.
 */
export function storiesContentKey(pageStories) {
  const version = pageStories?.storiesVersion;
  if (version === undefined) return JSON.stringify(pageStories ?? null);
  checkNamedContent(`stories ${version}`, pageStories);
  return `stories ${version}`;
}
/** A story of versioned page stories, by its path (and, for a note, its numbers): or undefined. */
export function storyContentKey(pageStories, path, ...numbering) {
  const version = pageStories?.storiesVersion;
  return version === undefined ? undefined : JSON.stringify([version, path, ...numbering]);
}

/**
 * What a story measurement reads besides the measurer, as text. Every page of a long document lays
 * its header, footer and notes out again on each edit, mostly unchanged. A layout serializes its
 * styles (`stylesKey`) and list definitions (`numberingKey`) once and each story's paragraphs once
 * (`storyKeys`, by paragraphs array), or names a versioned story's content (`contentKey`,
 * storyContentKey) without serializing it. The key names the long parts by the cache's short ids:
 * a document with hundreds of lists serialized half a megabyte of list definitions into the key of
 * every page's header and footer on each keystroke, and hashed each key again to look it up.
 */
function storyMeasureKey(cache, story, geometry, numbering, context, { styles, drawingLayouts, onUnsupported, stylesKey, numberingKey, storyKeys, contentKey }) {
  let content;
  if (contentKey !== undefined) { checkNamedContent(contentKey, story); content = cache.intern(contentKey); }
  else {
    let paragraphs = storyKeys?.get(story.paragraphs);
    if (paragraphs === undefined) { paragraphs = cache.intern(JSON.stringify(story.paragraphs)); storyKeys?.set(story.paragraphs, paragraphs); }
    content = [paragraphs, { ...story, paragraphs: undefined }];
  }
  // The page's number and counts reach the story only through its page fields (measureStory): a story
  // without one measures alike on every page, so a long document measures it once, not once a page.
  const pageContext = story.paragraphs.some(p => p.runs.some(r => r.field)) ? context : null;
  // Of the revision view, only what the story's own changes and hidden text show (revisionViewKey).
  return JSON.stringify([content, geometry, cache.intern(numberingKey ?? JSON.stringify(numbering ?? null)), pageContext, revisionViewKey(story.paragraphs, true),
    styles ? cache.intern(stylesKey ?? JSON.stringify(styles)) : null, drawingLayouts ? [...drawingLayouts] : null, !!onUnsupported]);
}

// The body clearance and story painter must measure the same generated text. With a measurer that
// remembers paragraphs, a story measured alike before is reused: its unsupported features are
// reported again, and callers read the result without changing it.
export function measurePageStory(story, geometry, measure, numbering, context, options = {}) {
  const cache = measure.paragraphCache?.();
  if (!cache) return measureStory(story, geometry, measure, numbering, context, options);
  let key;
  try { key = storyMeasureKey(cache, story, geometry, numbering, context, options); }
  catch { return measureStory(story, geometry, measure, numbering, context, options); }
  const remembered = cache.story(key);
  if (remembered) {
    for (const error of remembered.unsupported) options.onUnsupported(error);
    return remembered.result;
  }
  const unsupported = [];
  const result = measureStory(story, geometry, measure, numbering, context, { ...options, onUnsupported: options.onUnsupported && (error => { unsupported.push(error); options.onUnsupported(error); }) });
  cache.rememberStory(key, { result, unsupported });
  return result;
}

function measureStory(story, geometry, measure, numbering, context, { styles, drawingLayouts, onUnsupported } = {}) {
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
