/**
 * Brush workflows that involve dialogs, shared by the Brushes panel, the
 * Properties panel and the commands: New Brush, Brush Options (with Apply
 * to Strokes / Apply to Selected Strokes / Leave Strokes for brushes in
 * use), Options of Selected Object and Delete Brush.
 */
import { h } from '../../lib/dom.js';
import { BRUSH_TYPES, makeBrush, brushDefaults, brushById, docBrushes, setDocBrushes, brushUsers, copyBrush, uniqueBrushName, resolveBrush } from './brush-model.js';
import { brushOptionsDialog, newBrushTypeDialog, selectionArt } from './brush-dialogs.js';
import { addBrush, replaceBrush, brushTargets, applyBrush, setBrushOverrides, deleteBrushes } from './brush-ops.js';

/** Per-app brush state: the current brush (Paintbrush, new strokes). */
export function brushState(app) {
  if (!app.brushState) app.brushState = { currentId: 'def.basic' };
  return app.brushState;
}

/** New Brush: choose a type, set its options, add it (and apply it to the selected paths when made from scratch). */
export async function newBrush(app, presetType = null) {
  const ed = app.editor;
  if (!ed) return null;
  const { art, skipped } = selectionArt(ed);
  const type = presetType || (await newBrushTypeDialog(app, { hasArt: Boolean(art) }));
  if (!type) return null;
  if ((type === 'scatter' || type === 'art' || type === 'pattern') && !art) {
    app.notify(`Select artwork to make a ${BRUSH_TYPES[type].label.toLowerCase()}.`);
    return null;
  }
  if (skipped) app.notify('Type and images cannot be part of a brush; they were left out.', { polite: true });
  const fields = { type, name: uniqueBrushName(ed.doc, `${BRUSH_TYPES[type].short} Brush`) };
  if (type === 'scatter' || type === 'art') fields.art = art;
  if (type === 'pattern') fields.tiles = { ...brushDefaults('pattern').tiles, side: art };
  const draft = makeBrush(fields);
  const result = await brushOptionsDialog(app, draft, { scope: 'brush', title: `New ${BRUSH_TYPES[type].label}`, selectionArt: art, okLabel: 'Create' });
  if (!result) return null;
  const doc = ed.doc;
  doc.transact('New Brush', () => addBrush(doc, result));
  brushState(app).currentId = result.id;
  app.emit?.('brushes');
  return result;
}

/**
 * Ask what to do with strokes that use a changed brush: 'apply' | 'leave' |
 * 'selected' (only the selected strokes take the new settings) | null.
 */
function askApplyToStrokes(app, count, selected = 0) {
  const some = selected > 0 && selected < count;
  return app.dialogs.open({
    title: 'Brush Change',
    body: h('p.dialog-message', `${count} ${count === 1 ? 'object uses' : 'objects use'} this brush. Update them with the new settings, or leave them as they are (the new settings become a new brush)?${some ? ` ${selected} of them ${selected === 1 ? 'is' : 'are'} selected and can take the new settings alone.` : ''}`),
    buttons: [
      { label: 'Cancel', value: null, left: true },
      { label: 'Leave Strokes', value: 'leave' },
      some ? { label: 'Apply to Selected Strokes', value: 'selected' } : null,
      { label: 'Apply to Strokes', value: 'apply', primary: true },
    ].filter(Boolean),
  });
}

/** Brush Options for a document brush. Previews on the artwork using it. */
export async function editBrush(app, brushId) {
  const ed = app.editor;
  if (!ed) return false;
  const doc = ed.doc;
  const def = brushById(doc, brushId);
  if (!def) return false;
  const users = brushUsers(doc, brushId);
  const { art } = selectionArt(ed);
  let tx = null;
  const onPreview = users.length
    ? (next) => {
        if (tx) {
          tx.cancel();
          tx = null;
        }
        if (!next) return;
        tx = doc.begin('Brush Options');
        replaceBrush(doc, next);
      }
    : null;
  let result;
  try {
    result = await brushOptionsDialog(app, def, { scope: 'brush', onPreview, selectionArt: art });
  } finally {
    if (tx) {
      tx.cancel();
      tx = null;
    }
  }
  if (!result) return false;
  if (JSON.stringify(result) === JSON.stringify(def)) return true;
  let how = 'apply';
  // Selected strokes using the brush (directly or through an appearance stroke).
  const picked = new Set(ed.topSelection());
  const selectedUsers = users.filter((id) => picked.has(id) || doc.ancestors(id).some((a) => picked.has(a.id)));
  if (users.length) {
    how = await askApplyToStrokes(app, users.length, selectedUsers.length);
    if (!how) return false;
  }
  doc.transact('Brush Options', () => {
    if (how === 'apply') replaceBrush(doc, result);
    else {
      // Existing strokes keep the old settings; the edited brush is added as a new one.
      const fresh = { ...copyBrush(result, uniqueBrushName(doc, result.name === def.name ? `${def.name} copy` : result.name)) };
      addBrush(doc, fresh, def.id);
      brushState(app).currentId = fresh.id;
      // Apply to Selected Strokes: the selected ones move to the new brush (keeping their own overrides).
      if (how === 'selected') for (const id of selectedUsers) doc.update(id, { brush: { ...doc.get(id).brush, id: fresh.id } });
    }
  });
  return true;
}

/** Options of Selected Object: overrides on the selected brushed paths. */
export async function editSelectedStrokeOptions(app) {
  const ed = app.editor;
  if (!ed) return false;
  const doc = ed.doc;
  const targets = brushTargets(ed).filter((n) => n.brush && brushById(doc, n.brush.id));
  if (!targets.length) {
    app.notify('Select a path painted with a brush.');
    return false;
  }
  const first = targets[0];
  const same = targets.filter((n) => n.brush.id === first.brush.id);
  const effective = resolveBrush(doc, first);
  const ids = same.map((n) => n.id);
  const tx = doc.begin('Stroke Options');
  const onPreview = (over) => {
    // Reset to the original overrides, then show the new ones.
    for (const n of same) doc.update(n.id, { brush: n.brush });
    if (over) setBrushOverrides(doc, ids, over);
  };
  let result;
  try {
    result = await brushOptionsDialog(app, effective, { scope: 'stroke', title: `Stroke Options (${BRUSH_TYPES[effective.type].label})`, onPreview });
  } catch (err) {
    tx.cancel();
    throw err;
  }
  if (!result) {
    tx.cancel();
    return false;
  }
  onPreview(result);
  tx.commit();
  return true;
}

/** Delete brushes, asking what to do with objects using them. */
export async function confirmDeleteBrushes(app, ids) {
  const ed = app.editor;
  if (!ed || !ids.length) return false;
  const doc = ed.doc;
  const users = ids.flatMap((id) => brushUsers(doc, id));
  let how = 'remove';
  if (users.length) {
    how = await app.dialogs.open({
      title: ids.length > 1 ? 'Delete Brushes' : 'Delete Brush',
      body: h('p.dialog-message', `${users.length} ${users.length === 1 ? 'object uses' : 'objects use'} ${ids.length > 1 ? 'these brushes' : 'this brush'}. Expand the strokes into artwork, or remove the brush and keep plain strokes?`),
      buttons: [
        { label: 'Cancel', value: null, left: true },
        { label: 'Remove Strokes', value: 'remove' },
        { label: 'Expand Strokes', value: 'expand', primary: true },
      ],
    });
    if (!how) return false;
  } else {
    const ok = await app.dialogs.confirm({ title: ids.length > 1 ? 'Delete Brushes' : 'Delete Brush', message: `Delete ${ids.length > 1 ? `${ids.length} brushes` : `“${brushById(doc, ids[0])?.name}”`}?`, okLabel: 'Delete', danger: true });
    if (!ok) return false;
  }
  deleteBrushes(doc, ids, how);
  if (ids.includes(brushState(app).currentId)) brushState(app).currentId = docBrushes(doc)[0]?.id || null;
  return true;
}

/** Add a library brush to the document (and apply it to the selection). */
export function useLibraryBrush(app, brush, { apply = true } = {}) {
  const ed = app.editor;
  if (!ed) return null;
  const doc = ed.doc;
  const have = docBrushes(doc).some((b) => b.id === brush.id);
  if (apply && brushTargets(ed).length) applyBrush(ed, brush.id, `Apply ${brush.name}`);
  else if (!have) doc.transact('Add Brush', () => setDocBrushes(doc, [...docBrushes(doc), brush]));
  brushState(app).currentId = brush.id;
  return brush;
}
