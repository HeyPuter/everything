// A link the user creates should look like one:
// the document's Hyperlink character style when it has one, otherwise blue
// single-underlined text. Text typed straight after a new link at the caret
// continues with the formatting from before the link.
import { underlinePattern } from './underlines.js';

export const LINK_COLOR = '0563C1';

/** The id of the document's Hyperlink character style, or null when it has none. */
export const linkStyleId = styles => Object.values(styles?.definitions || {})
  .find(s => s.type === 'character' && !s.error && (s.id === 'Hyperlink' || String(s.name || '').toLowerCase() === 'hyperlink'))?.id ?? null;

/** The properties the direct look of a link is made of. */
export const LINK_LOOK = Object.freeze(['color', 'underline', 'underlineStyle', 'underlineColor']);
/** Those properties as `format` has them, to state on a run. */
export const linkLook = format => {
  const pattern = underlinePattern(format);
  return { color: format.color, underline: pattern !== 'none', underlineStyle: pattern, underlineColor: format.underlineColor };
};
/** `declared` (a run's direct formatting, or its edits) without the properties of a link's look. */
export const withoutLinkLook = declared => Object.fromEntries(Object.entries(declared || {}).filter(([key]) => !LINK_LOOK.includes(key)));

/**
 * Whether a run is formatted as showLink formats a link in a document without the style: the link color stated
 * on the run itself (not come by through a style) and a single underline. Text of another color, or underlined
 * otherwise, was formatted by someone and is not taken for it.
 */
export function hasLinkFormat(run) {
  const color = run.overrides?.color ?? run.directFormat?.color ?? (run.styleManaged ? undefined : run.color);
  return String(color || '').toUpperCase() === LINK_COLOR && underlinePattern(run) === 'single';
}

export function showLink(model) {
  const link = model.hyperlink;
  if (!link) return false;
  const { anchor, focus } = model.selection;
  const continuing = anchor === focus && focus === link.end;
  const before = continuing ? model.typingRun(link.start, 'backward') : null;
  const style = linkStyleId(model.styles);
  model.select(link.start, link.end);
  if (style) model.setCharacterStyle(style);
  // The link's look belongs to its text: on the paragraph mark it would color and underline a list label too.
  else model.setRunFormat({ color: LINK_COLOR, underlineStyle: 'single' }, { mark: false });
  model.select(anchor, focus);
  if (continuing) {
    model.typingFormat = { color: before.color, underline: before.underlineStyle !== 'none', underlineStyle: before.underlineStyle, underlineColor: before.underlineColor };
    model.typingStyle = { id: before.styleId || null };
  }
  return true;
}
