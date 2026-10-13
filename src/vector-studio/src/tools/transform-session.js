/**
 * TransformSession: an interactive transform of the selection that always
 * re-applies the full matrix to the original nodes (no accumulated error),
 * inside one open transaction so the whole drag is one undo step.
 *
 * Used by the Selection tool (move, scale, rotate through the bounding box),
 * the Rotate / Reflect / Scale / Shear tools and Free Transform.
 */
import { collectOriginals, transformFromOriginals } from '../model/geometry.js';

/**
 * Above this many nodes a drag previews the transform as a bitmap and
 * writes the geometry once on release, so moving thousands of objects stays
 * smooth. Smaller selections update the document live (exact preview).
 */
export const PREVIEW_THRESHOLD = 400;

export class TransformSession {
  constructor(editor, label, { duplicate = false, copyLabel = label } = {}) {
    this.editor = editor;
    this.doc = editor.doc;
    this.labels = { move: label, copy: copyLabel };
    this.matrix = [1, 0, 0, 1, 0, 0];
    // Dragging with the pattern key held moves only pattern fills and strokes.
    this.patternsOnly = Boolean(editor.patternsOnly);
    this.#start(duplicate);
  }

  #start(duplicate) {
    this.duplicate = duplicate;
    this.tx = this.doc.begin(duplicate ? this.labels.copy : this.labels.move);
    this.ids = this.editor.topSelection();
    if (duplicate) this.ids = duplicateInPlace(this.editor, this.ids);
    this.originals = collectOriginals(this.doc, this.ids);
    this.preview = this.originals.size > PREVIEW_THRESHOLD && !this.#isolatedAncestor();
  }

  /**
   * Moving content inside a group with opacity, blending, effects or
   * clipping cannot be split out as a bitmap, nor opacity mask art edited in
   * place (the masked object redraws as it moves).
   */
  #isolatedAncestor() {
    for (const id of this.ids) {
      for (const a of this.doc.ancestors(id)) {
        if ((a.opacity ?? 1) < 1 || (a.blendMode && a.blendMode !== 'normal') || a.effects?.length || a.clip || a.blend || a.maskEdit) return true;
      }
    }
    return false;
  }

  /** Alt pressed or released mid-drag: switch between moving the originals and a copy. */
  setDuplicate(duplicate) {
    if (Boolean(duplicate) === this.duplicate) return;
    const m = this.matrix;
    this.#clearPreview();
    this.tx.cancel();
    this.#start(Boolean(duplicate));
    this.apply(m);
  }

  get opts() {
    const prefs = this.editor.prefs;
    const o = { scaleStrokes: prefs?.get('scaleStrokes') ?? false, scaleCorners: prefs?.get('scaleCorners') ?? false, transformPatterns: prefs?.get('transformPatterns') ?? true };
    if (this.patternsOnly) Object.assign(o, { transformObjects: false, transformPatterns: true });
    return o;
  }

  apply(m) {
    this.matrix = m;
    if (this.preview) {
      this.editor.dragPreview = { session: this, ids: this.originals, matrix: m };
      this.editor.emit('invalidate');
      return;
    }
    transformFromOriginals(this.doc, this.originals, m, this.opts);
  }

  #clearPreview() {
    if (this.editor.dragPreview?.session === this) {
      this.editor.dragPreview = null;
      this.editor.emit('invalidate');
    }
  }

  commit() {
    if (this.preview) {
      this.#clearPreview();
      transformFromOriginals(this.doc, this.originals, this.matrix, this.opts);
    }
    this.tx.commit();
    // An Alt-drag copy repeats as a copy (step and repeat with Transform Again).
    if (!isIdentityish(this.matrix)) this.editor.lastTransform = { matrix: this.matrix, copy: this.duplicate, opts: this.opts };
  }

  cancel() {
    this.#clearPreview();
    this.tx.cancel();
  }
}

function isIdentityish(m) {
  return Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[4]) < 1e-9 && Math.abs(m[5]) < 1e-9;
}

/**
 * Copy each id directly above its original (same parent) inside the open
 * transaction and select the copies. Returns the new ids.
 */
export function duplicateInPlace(editor, ids) {
  const doc = editor.doc;
  const out = [];
  for (const id of ids) {
    const node = doc.get(id);
    if (!node) continue;
    const parent = doc.get(node.parent);
    const index = parent.children.indexOf(id) + 1;
    const { node: copy, descendants } = doc.cloneSubtree(id);
    doc.insert(copy, parent.id, index, descendants);
    out.push(copy.id);
  }
  editor.select(out);
  return out;
}
