// A link the user creates should look like one:
// the document's Hyperlink character style when it has one, otherwise blue
// single-underlined text. Text typed straight after a new link at the caret
// continues with the formatting from before the link.
export const LINK_COLOR = '0563C1';

export function showLink(model) {
  const link = model.hyperlink;
  if (!link) return false;
  const { anchor, focus } = model.selection;
  const continuing = anchor === focus && focus === link.end;
  const before = continuing ? model.typingRun(link.start, 'backward') : null;
  const style = Object.values(model.styles.definitions).find(s => s.type === 'character' && !s.error && (s.id === 'Hyperlink' || String(s.name || '').toLowerCase() === 'hyperlink'));
  model.select(link.start, link.end);
  if (style) model.setCharacterStyle(style.id);
  // The link's look belongs to its text: on the paragraph mark it would color and underline a list label too.
  else model.setRunFormat({ color: LINK_COLOR, underlineStyle: 'single' }, { mark: false });
  model.select(anchor, focus);
  if (continuing) {
    model.typingFormat = { color: before.color, underline: before.underlineStyle !== 'none', underlineStyle: before.underlineStyle, underlineColor: before.underlineColor };
    model.typingStyle = { id: before.styleId || null };
  }
  return true;
}
