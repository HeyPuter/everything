// Text attributes for Edit → Paste Special → Paste Text Attributes: the
// character and paragraph attributes of the text copied last (a type layer
// copied with Edit → Copy, or a range copied while editing). Kept in memory
// for this page, across documents.
import type { CharStyle, ParagraphStyle, TextContent } from '../../imaging/text/model';

export type TextAttributes = { char: CharStyle; paragraph: ParagraphStyle };
let copied: TextAttributes | undefined;

export const copiedTextAttributes = (): TextAttributes | undefined => copied;

/** Remembers the attributes of copied text: those of its first character
 * and of its first paragraph. */
export function rememberTextAttributes(content: TextContent | undefined) {
  const p = content?.paragraphs.find((x) => x.runs.some((r) => r.text)) ?? content?.paragraphs[0];
  const run = p?.runs.find((r) => r.text) ?? p?.runs[0];
  if (!p || !run) return;
  copied = { char: structuredClone(run.style), paragraph: structuredClone(p.style) };
}

// The text being edited, if any: its selected range (set by the type session).
export const textCopySource: { selected?: () => TextContent | undefined } = {};

/** Edit → Copy: remembers the attributes of the selected range while
 * editing, or of a copied type layer's text. */
export function rememberCopiedLayerText(
  layer: { kind: string; textData?: { content: TextContent } } | undefined,
) {
  const range = textCopySource.selected?.();
  if (range) rememberTextAttributes(range);
  else if (layer?.kind === 'text' && layer.textData) rememberTextAttributes(layer.textData.content);
}
