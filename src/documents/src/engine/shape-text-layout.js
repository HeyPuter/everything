import { layoutDocument } from './layout.js';
import { EMU_PER_PX } from './images.js';
import { shapeFieldParagraphs } from './shape-page-fields.js';

// Half the declared line width is reserved even when noFill suppresses ink.
// A minimum visible pen does not replace the stored text-frame geometry.
const textEdge = node => (node.text.outlineWidth ?? node.outline?.declaredWidth ?? node.outline?.width ?? 0) / 2;
/** The width (CSS px) a drawing's text frame lays its lines out in. */
export function shapeTextWidth(node, scale = { x: 1, y: 1 }) {
  const tx = node.text, rect = node.textRect || { left: 0, top: 0, right: 1, bottom: 1 };
  return (node.width * scale.x * (rect.right - rect.left) - tx.left - tx.right - 2 * textEdge(node)) / EMU_PER_PX;
}

export function layoutShapeText(node, measure, scale = { x: 1, y: 1 }, fieldContext) {
  // Group transforms resize the frame, not the text's physical units.
  // Layout after composing every ancestor transform: insets, point sizes and
  // paragraph geometry stay absolute, including under nonuniform scaling.
  const tx = node.text, rect = node.textRect || { left: 0, top: 0, right: 1, bottom: 1 };
  const edge = textEdge(node);
  const width = shapeTextWidth(node, scale);
  const left = (node.width * scale.x * rect.left + tx.left + edge) / EMU_PER_PX;
  const top = (node.height * scale.y * rect.top + tx.top + edge) / EMU_PER_PX;
  const clip = { left: left - tx.left / EMU_PER_PX, top, width: Math.max(0, width + (tx.left + tx.right) / EMU_PER_PX), height: Math.max(0, (node.height * scale.y * (rect.bottom - rect.top) - tx.top - tx.bottom - 2 * edge) / EMU_PER_PX) };
  if (width <= 0) throw new Error('A drawing text box has no writing space.');
  // w:txbxContent retains paragraph before/after spacing regardless of
  // the DrawingML spcFirstLastPara flag (which governs a:p text bodies).
  let paragraphs = tx.paragraphs.some(p => p.runs.some(r => r.field)) ? shapeFieldParagraphs(tx.paragraphs, fieldContext) : tx.paragraphs;
  // Paragraph page-break-before is ignored in an unlinked text frame.
  // Keep the resolved property and original XML intact; only layout suppresses it.
  if (paragraphs.some(p => p.format?.pageBreakBefore)) paragraphs = paragraphs.map(p => p.format?.pageBreakBefore ? { ...p, format: { ...p.format, pageBreakBefore: false } } : p);
  const layout = layoutDocument(paragraphs, measure, { width, height: 1e7, left: 0, right: 0, top: 0, bottom: 0, defaultTabStop: 720, shapeText: true, compatibilityMode: tx.compatibilityMode }, undefined, tx.tables);
  // Overflowing w:txbxContent is clipped to the text frame and anchors it at
  // the top when there is no free space, even with vertOverflow="overflow".
  const free = Math.max(0, clip.height - layout.endY);
  return { layout, left, top, clip, shift: free * (tx.anchor === 'ctr' ? .5 : tx.anchor === 'b' ? 1 : 0) };
}
