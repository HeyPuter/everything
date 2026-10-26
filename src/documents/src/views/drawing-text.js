import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { CanvasEditor } from '../engine/canvas-editor.js';
import { shapeTextWidth } from '../engine/shape-text-layout.js';

const MARGIN = 360; // Twips around the draft's text.

// A rich draft owns its own positions and local history. Apply publishes one
// drawing mutation to the document history; cancel never changes the document.
export function openDrawingText({ engine, pkg, image, frame, select = null }) {
  const descriptor = pkg.drawingTextFrames(image, engine.model.assets)[frame];
  if (!descriptor || descriptor.reason) throw new Error(descriptor?.reason || 'This drawing text is unavailable.');
  const assets = {}, images = new Map();
  const addPicture = picture => {
    for (const id of [picture?.assetId, picture?.fallbackAssetId]) {
      if (!id || assets[id]) continue;
      const asset = engine.model.assets[id];
      if (!asset) throw new Error('A drawing picture asset is missing.');
      assets[id] = asset;
      if (engine.images.has(id)) images.set(id, engine.images.get(id));
      if (asset.scene) visitScene(asset.scene);
    }
  };
  const visitParagraphs = paragraphs => { for (const p of paragraphs) for (const r of p.runs) addPicture(r.image); };
  const visitScene = node => { addPicture(node.image); addPicture(node.fill?.image); if (node.text) visitParagraphs(node.text.paragraphs); node.children?.forEach(visitScene); };
  visitParagraphs(descriptor.paragraphs);
  let draft, busy = false;
  const abort = new AbortController();
  const host = el('div.canvas-host', { style: 'height: min(55vh, 480px); overflow: auto;' });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const report = e => { error.textContent = e.message; error.hidden = false; };
  const tool = (label, action) => el('button.btn', { type: 'button', onclick: () => { if (!busy) action(); } }, label);
  const apply = tool('Apply', async () => {
    busy = true; apply.disabled = true; error.hidden = true;
    draft.finishComposition(); draft.input.readOnly = true;
    try {
      if (await engine.applyDrawingText(pkg, image, frame, draft.model.paragraphs, { signal: abort.signal, tables: draft.model.tables })) { modal.close(); engine.focus(); }
    } catch (e) { if (!abort.signal.aborted) report(e); }
    finally { busy = false; apply.disabled = false; draft.input.readOnly = false; }
  });
  const content = el('div', {},
    el('p.modal-text', {}, 'Edit this text frame, then apply your changes to the drawing. The document keeps its original frame size and placement.'),
    el('div.row', { role: 'toolbar', 'aria-label': 'Drawing text formatting' },
      tool('Bold', () => draft.toggleBold()), tool('Italic', () => draft.toggleItalic()),
      tool('Undo', () => draft.undo()), tool('Redo', () => draft.redo())),
    host, error,
    el('div.row.row-end', {}, tool('Cancel', () => modal.close()), apply));
  const modal = openModal({ title: 'Edit drawing text', content, wide: true, onClose: () => { abort.abort(); draft?.destroy(); } });
  // The draft's lines are as long as the frame's, so its text wraps where the drawing's will.
  let writing = 9000 - 2 * MARGIN;
  try {
    const node = pkg.drawingTextSources(image, engine.model.assets[image.assetId])[frame]?.node, width = node ? Math.round(shapeTextWidth(node) * 15) : 0;
    if (Number.isFinite(width) && width > 0) writing = width;
  } catch { /* the default width */ }
  const pageWidth = Math.max(1440, Math.min(31680, writing + 2 * MARGIN));
  try {
    draft = new CanvasEditor(host, {
      paragraphs: descriptor.paragraphs, tables: descriptor.tables, styles: engine.model.styles, numbering: engine.model.numbering,
      assets, images, borrowImages: true,
      pageSettings: { width: pageWidth, left: MARGIN, right: MARGIN, top: MARGIN, bottom: MARGIN, compatibilityMode: engine.model.pageSettings.compatibilityMode },
      inputLabel: 'Drawing text', onError: report,
      protectedPageFields: true,
    });
    draft.input.setAttribute('data-testid', 'drawing-text-input');
    // A new drawing's sample text starts selected, so typing replaces it.
    const at = select ? draft.model.text.indexOf(select) : -1;
    if (at >= 0) draft.model.select(at, at + select.length);
    draft.focus();
  } catch (e) { modal.close(); throw e; }
  return modal;
}
