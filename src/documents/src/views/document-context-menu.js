import { MOD_KEY } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';
import { bodyFieldRanges } from '../engine/body-fields.js';
import { internalHyperlink } from '../engine/hyperlinks.js';

/** The kinds of place a right-click can land on, most specific first. */
export const CONTEXTS = ['image', 'shape', 'link', 'field', 'list', 'table', 'text'];

/**
 * What the caret or selection is in: one or more of CONTEXTS. A picture or shape selection is that
 * alone; text can be in a link, a field, a list and a table at once, and is always 'text' too.
 */
export function documentContexts(engine, { shapeSelected = false, fieldAtCaret = null } = {}) {
  const model = engine.model;
  if (shapeSelected) return ['shape'];
  if (model.selectedImage) return ['image'];
  const out = [];
  if (model.hyperlink) out.push('link');
  if (fieldAtCaret) { if (fieldAtCaret()) out.push('field'); }
  else if (model.hasBodyFields) {
    try { const at = model.range[0]; if (bodyFieldRanges(model.paragraphs).some(r => r.start <= at && at <= r.end)) out.push('field'); } catch { /* not a readable field */ }
  }
  if (model.listFormatting === 'bullet' || model.listFormatting === 'number') out.push('list');
  if (model.tableContext) out.push('table');
  out.push('text');
  return out;
}

/**
 * The document's right-click menu: spelling suggestions first, then the clipboard, formatting, link,
 * comment, table, picture and field commands for where it was opened, then each feature module's
 * entries from `commands.contextMenuItems(context, kit)`.
 */
export function openDocumentMenu({ event, behind, selectBehind, engine, pkg, w, kit, actions: x }) {
  const editable = !pkg.readOnly && !engine.viewOnly;
  const contexts = documentContexts(engine, { shapeSelected: !!w.shapeSelected?.(), fieldAtCaret: x.fieldAtCaret });
  const has = context => contexts.includes(context);
  const clipboard = x.clipboardState();
  const sep = { separator: true };
  const items = [];
  const add = (...list) => { for (const item of list) if (item) items.push(item); };
  const group = list => { const clean = list.filter(Boolean); if (clean.length) add(sep, ...clean); };

  if (has('text')) add(...x.spellingItems(engine.model.selection.focus));
  add({ label: 'Undo', shortcut: `${MOD_KEY}+Z`, disabled: !editable || !engine.session.history.length, onSelect: () => engine.undo() },
    { label: 'Redo', shortcut: `${MOD_KEY}+Shift+Z`, disabled: !editable || !engine.session.future.length, onSelect: () => engine.redo() });
  group([
    { label: 'Cut', shortcut: `${MOD_KEY}+X`, icon: 'cut', disabled: !clipboard.cut, onSelect: () => x.cut() },
    { label: 'Copy', shortcut: `${MOD_KEY}+C`, icon: 'copy', disabled: !clipboard.copy, onSelect: () => x.copy() },
    { label: 'Paste', shortcut: `${MOD_KEY}+V`, icon: 'paste', disabled: !clipboard.paste, onSelect: () => x.paste() },
    { label: 'Paste without formatting', shortcut: `${MOD_KEY}+Shift+V`, icon: 'pasteText', disabled: !clipboard.paste, onSelect: () => x.pastePlain() },
    w.pasteSpecial && { label: 'Paste Special…', disabled: !clipboard.paste, onSelect: () => w.pasteSpecial() },
  ]);

  if (has('text') && editable) {
    group([
      { label: 'Font…', icon: 'fontDialog', shortcut: `${MOD_KEY}+D`, onSelect: () => w.fontDialog?.() },
      { label: 'Paragraph…', icon: 'paragraphDialog', onSelect: () => x.paragraphDialog() },
      has('list') && { label: 'Restart Numbering at 1', disabled: engine.model.listFormatting !== 'number', onSelect: () => engine.restartNumbering() },
      has('list') && w.multilevelItems && { label: engine.model.listFormatting === 'bullet' ? 'Bullets' : 'Numbering', items: w.multilevelItems() || [] },
      w.copyFormat && { label: 'Copy Formatting', icon: 'formatPainter', onSelect: () => w.copyFormat() },
      w.hasCopiedFormat?.() && { label: 'Paste Formatting', onSelect: () => w.pasteFormat() },
    ]);
  }
  if (has('link')) {
    const link = engine.model.hyperlink?.link;
    group([
      { label: 'Edit link…', icon: 'link', shortcut: `${MOD_KEY}+K`, disabled: !editable, onSelect: () => x.editLink() },
      { label: 'Open link', onSelect: () => engine.openHyperlink() },
      link && !internalHyperlink(link) && link.target && { label: 'Copy link', icon: 'copy', onSelect: () => navigator.clipboard?.writeText(link.target).catch(() => {}) },
      { label: 'Remove link', icon: 'unlink', disabled: !editable, onSelect: () => engine.removeHyperlink() },
    ]);
  } else if (has('text') && editable) {
    group([{ label: 'Insert link…', icon: 'link', shortcut: `${MOD_KEY}+K`, onSelect: () => x.editLink() }]);
  }
  if (has('field')) group([{ label: 'Update Field', icon: 'updateFields', shortcut: 'F9', disabled: !editable || !w.canUpdateFields?.(), onSelect: () => w.updateFields?.() }]);

  if (has('image')) group(x.imageItems());
  if (has('shape')) group([
    w.editShapeText && { label: 'Edit Text', icon: 'drawingText', disabled: !editable, onSelect: () => w.editShapeText() },
    w.wrapItems && { label: 'Wrap Text', icon: 'wrapText', disabled: !editable, items: w.wrapItems() || [] },
    w.arrange && { label: 'Bring Forward', icon: 'bringForward', disabled: !w.canArrange?.(), onSelect: () => w.arrange('forward') },
    w.arrange && { label: 'Send Backward', icon: 'sendBackward', disabled: !w.canArrange?.(), onSelect: () => w.arrange('backward') },
    { label: 'Delete Shape', icon: 'deleteShape', disabled: !editable, onSelect: () => w.deleteSelection?.() },
  ]);
  if (behind) group([{ label: 'Select picture behind text', onSelect: selectBehind }]);
  if (has('table') && editable) group(x.tableItems());

  const comments = x.commentItems();
  if (comments.length) group(comments);
  for (const context of contexts) {
    let extra = [];
    try { extra = w.contextMenuItems?.(context, kit) || []; } catch (e) { console.error(e); }
    group(extra);
  }
  if (engine.session.path === null && engine.model.hasBodyFields && !has('field')) group([{ label: 'Update page references', disabled: !editable, onSelect: () => engine.updatePageReferences() }]);
  group([{ label: 'Print / Save as PDF', icon: 'print', onSelect: x.print }]);

  const rect = engine.input.getBoundingClientRect();
  // A right-click or long press opens with no item chosen; the ContextMenu key and Shift+F10 start on the first.
  const pointer = !!event.pointerType || event.button === 2;
  const label = has('image') ? 'Image menu' : has('shape') ? 'Shape menu' : 'Document menu';
  return openMenu({ anchor: engine.input, x: event.clientX || rect.left, y: event.clientY || rect.bottom, label, items: tidyMenu(items), pointer, onClose: () => engine.focus() });
}

function tidyMenu(items) {
  const out = [];
  for (const item of items) { if (item.separator && (!out.length || out.at(-1).separator)) continue; out.push(item); }
  while (out.at(-1)?.separator) out.pop();
  return out;
}
