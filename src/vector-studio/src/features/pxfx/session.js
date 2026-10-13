/**
 * An effect editing session for the large effect dialogs: the targets,
 * live preview on the canvas inside one open transaction (OK commits it as
 * one undo step, Cancel rolls it back) and a document view for the
 * dialog's own preview, which shows the result whether or not the canvas
 * previews.
 */
import { EFFECTS } from '../paint/effects-model.js';
import { effectTargets, rememberEffect, effectsOf, effectsPatch } from '../paint/effects-ui.js';
import { effectItemIndex } from '../paint/appearance-ops.js';
import { overlayDoc } from './preview.js';

const PREVIEW_PREF = 'effectPreview';

/** null when nothing can take the effect (the user is told). */
export function effectSession(app, type, { edit = null } = {}) {
  const ed = app.editor;
  if (!ed) return null;
  const doc = ed.doc;
  const targets = edit ? [doc.get(edit.id)].filter(Boolean) : effectTargets(ed);
  if (!targets.length) {
    app.notify('Select an object to apply the effect to.');
    return null;
  }
  // The object's effects, or those of the fill or stroke picked in the Appearance panel (edit.item).
  const slot = edit ? edit.item ?? null : effectItemIndex(ed);
  const existing = edit ? effectsOf(targets[0], slot)[edit.index] || null : null;
  const originals = new Map(targets.map((n) => [n.id, effectsOf(n, slot)]));
  const ids = doc.sortByPaintOrder ? doc.sortByPaintOrder(targets.map((n) => n.id)) : targets.map((n) => n.id);
  const list = (orig, fx) => {
    if (edit) {
      const out = orig.slice();
      out[edit.index] = fx ? { ...fx, ...(orig[edit.index]?.hidden ? { hidden: true } : {}) } : orig[edit.index];
      return out;
    }
    return fx ? [...orig, fx] : orig;
  };
  let preview = app.prefs?.get?.(PREVIEW_PREF) ?? true;
  let current = null;
  const tx = doc.begin(EFFECTS[type]?.label || 'Effect');
  const write = () => {
    if (doc.tx !== tx) return;
    for (const [id, orig] of originals) doc.update(id, effectsPatch(doc.get(id), slot, list(orig, preview ? current : null)));
  };
  return {
    doc,
    targets,
    existing,
    ids,
    get preview() {
      return preview;
    },
    set preview(v) {
      preview = Boolean(v);
      app.prefs?.set?.(PREVIEW_PREF, preview);
      write();
    },
    /** Show fx (a normalized record, or null for none) on the canvas when previewing. */
    apply(fx) {
      current = fx;
      write();
    },
    /** The document as it looks with fx: { doc, ids } for EffectPreview. */
    view(fx) {
      const over = new Map();
      for (const [id, orig] of originals) over.set(id, { ...doc.get(id), ...effectsPatch(doc.get(id), slot, list(orig, fx)) });
      return { doc: overlayDoc(doc, over), ids };
    },
    /** Apply fx for good (null removes the edited effect, or adds nothing). */
    commit(fx) {
      if (!fx) {
        if (!edit) {
          tx.cancel();
          return;
        }
        for (const [id, orig] of originals) doc.update(id, effectsPatch(doc.get(id), slot, orig.filter((_, i) => i !== edit.index)));
        tx.commit();
        return;
      }
      current = fx;
      preview = true;
      write();
      tx.commit();
      app.lastEffects = { ...(app.lastEffects || {}), [type]: fx };
      rememberEffect(app, fx);
    },
    cancel() {
      tx.cancel();
    },
  };
}
