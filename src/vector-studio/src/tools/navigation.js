/**
 * Navigation and sampling tools: Hand (H), Zoom (Z), Rotate View (Shift+H)
 * and Eyedropper (I).
 */
import { Tool, tol } from './tool.js';
import { hitTest } from '../render/hit.js';
import { STYLE_KEYS } from '../model/nodes.js';
import { stripRunKeys, styleAt, CHAR_KEYS } from '../model/text-runs.js';
import { layoutText, hitTestText, caretPosition } from '../model/text-layout.js';
import { apply, invert } from '../lib/matrix.js';
import { drawArtwork } from '../render/draw.js';
import { rgbToHex } from '../lib/color.js';
import { moveGradient } from '../model/gradients.js';
import { nodeBounds } from '../model/geometry.js';

export class HandTool extends Tool {
  static id = 'hand';
  static label = 'Hand Tool';
  static shortcut = 'H';
  static icon = 'tool-hand';
  static hint = 'Drag to move the view | Hold Space with any tool to pan';

  activate() {
    this.setCursor('grab');
    this.status();
  }

  onPointerDown(e) {
    const v = this.editor.view;
    this.drag = { sx: e.sx, sy: e.sy, panX: v.panX, panY: v.panY };
    this.setCursor('grabbing');
  }

  onPointerMove(e) {
    if (!this.drag) return;
    const v = this.editor.view;
    v.set({ panX: this.drag.panX + e.sx - this.drag.sx, panY: this.drag.panY + e.sy - this.drag.sy });
    this.editor.viewChanged();
  }

  onPointerUp() {
    this.drag = null;
    this.setCursor('grab');
  }

  onDoubleClick() {
    this.editor.fitArtboard();
  }

  /** Double-clicking the tool fits the artboard in the window. */
  openOptions() {
    this.app.commands.run('view.fitArtboard');
  }
}

export class ZoomTool extends Tool {
  static id = 'zoom';
  static label = 'Zoom Tool';
  static shortcut = 'Z';
  static icon = 'tool-zoom';
  static hint = 'Click to zoom in | Option+Click to zoom out | Drag to zoom into an area';

  activate() {
    this.setCursor('zoom-in');
    this.status();
  }

  onHover(e) {
    this.setCursor(e.alt ? 'zoom-out' : 'zoom-in');
  }

  onPointerDown(e) {
    this.drag = { x0: e.x, y0: e.y, sx0: e.sx, sy0: e.sy, x: e.x, y: e.y, sx: e.sx, sy: e.sy, alt: e.alt, zoom0: this.editor.view.zoom };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    d.x = e.x;
    d.y = e.y;
    d.sx = e.sx;
    d.sy = e.sy;
    this.overlay();
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const editor = this.editor;
    const w = Math.abs(d.sx - d.sx0);
    const h = Math.abs(d.sy - d.sy0);
    if (w > 4 && h > 4 && !d.alt) {
      // Fill the window with the dragged screen rectangle, keeping the view rotation.
      const v = editor.view;
      const c = v.toDoc((d.sx0 + d.sx) / 2, (d.sy0 + d.sy) / 2);
      v.set({ zoom: v.zoom * Math.min(v.width / w, v.height / h) });
      v.centerOn(c.x, c.y);
    } else editor.view.stepZoom(e.alt || d.alt ? -1 : 1, e.sx, e.sy);
    editor.viewChanged();
    this.overlay();
  }

  onDoubleClick() {
    this.editor.actualSize();
  }

  drawOverlay(ctx) {
    const d = this.drag;
    if (!d || d.alt) return;
    ctx.save();
    ctx.strokeStyle = '#7a7a7a';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(Math.min(d.sx0, d.sx) + 0.5, Math.min(d.sy0, d.sy) + 0.5, Math.abs(d.sx - d.sx0), Math.abs(d.sy - d.sy0));
    ctx.restore();
  }

  /** Double-clicking the tool shows the document at 100%. */
  openOptions() {
    this.app.commands.run('view.actualSize');
  }
}

export class RotateViewTool extends Tool {
  static id = 'rotate-view';
  static label = 'Rotate View Tool';
  static shortcut = 'Shift+H';
  static icon = 'tool-rotate-view';
  static hint = 'Drag to rotate the view | Shift snaps to 15 degrees | Double-click to reset';

  activate() {
    this.setCursor('var(--cursor-rotate)');
    this.status();
  }

  onPointerDown(e) {
    const v = this.editor.view;
    const cx = v.width / 2;
    const cy = v.height / 2;
    this.drag = { a0: Math.atan2(e.sy - cy, e.sx - cx), r0: v.rotation };
  }

  onPointerMove(e) {
    if (!this.drag) return;
    const v = this.editor.view;
    const a = Math.atan2(e.sy - v.height / 2, e.sx - v.width / 2);
    let deg = this.drag.r0 + ((a - this.drag.a0) * 180) / Math.PI;
    if (e.shift) deg = Math.round(deg / 15) * 15;
    v.rotateView(deg);
    this.editor.viewChanged();
  }

  onPointerUp() {
    this.drag = null;
  }

  onDoubleClick() {
    this.editor.view.rotateView(0);
    this.editor.viewChanged();
  }

  /** Double-clicking the tool turns the view back upright. */
  openOptions() {
    this.app.commands.run('view.resetRotation');
  }
}

/** Fields the Eyedropper picks up and applies, like its default options. */
// Extra fills and strokes (the appearance stack) come along with the fill and stroke.
const EYEDROPPER_KEYS = [...STYLE_KEYS.filter((k) => k !== 'effects'), 'appearance'];

/** Attribute groups the Eyedropper picks up and applies (Eyedropper Options). */
const EYEDROPPER_GROUPS = {
  fill: ['fill', 'appearance'],
  stroke: ['stroke', 'strokeWidth', 'strokeCap', 'strokeJoin', 'miterLimit', 'strokeAlign', 'dash', 'dashOffset', 'arrowStart', 'arrowEnd', 'appearance'],
  transparency: ['opacity', 'blendMode'],
};
const EYEDROPPER_LABELS = { fill: 'Fill', stroke: 'Stroke', transparency: 'Transparency', character: 'Character' };

/** The Eyedropper's groups: { fill, stroke, transparency, character } -> bool (all on by default). */
export function eyedropperGroups(app) {
  return { fill: true, stroke: true, transparency: true, character: true, ...(app.prefs.get('eyedropperGroups') || {}) };
}

function eyedropperKeys(app) {
  const g = eyedropperGroups(app);
  return EYEDROPPER_KEYS.filter((k) => Object.entries(EYEDROPPER_GROUPS).every(([name, keys]) => g[name] || !keys.includes(k)));
}

/**
 * Feature hooks for the Eyedropper: sample(editor, hit, e) -> style patch
 * picked from the clicked object (e.g. the color at the point on a gradient
 * mesh) or null; apply(editor, patch, hit) -> true when the feature applied
 * the picked style itself (e.g. to selected mesh points).
 */
export const eyedropperHooks = [];

/**
 * The color the artwork shows at a document point, as a hex string, or null
 * where nothing is painted. Renders the point on its own, so the grid, guides,
 * selection and Outline mode never tint the result; see-through artwork is
 * read as it looks on white paper.
 */
export const pixelSampler = {
  canvas: null,
  colorAt(editor, x, y) {
    try {
      const c = (this.canvas ||= document.createElement('canvas'));
      c.width = 1;
      c.height = 1;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const { view } = editor;
      const k = view.zoom * (view.dpr || 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, 1, 1);
      ctx.setTransform(k, 0, 0, k, 0.5 - x * k, 0.5 - y * k);
      drawArtwork(ctx, editor.doc, { viewRect: { x: x - 2 / k, y: y - 2 / k, w: 4 / k, h: 4 / k }, outline: false, hairline: 1 / view.zoom, scale: k });
      const d = ctx.getImageData(0, 0, 1, 1).data;
      if (!d[3]) return null;
      const a = d[3] / 255;
      const over = (v) => v * a + 255 * (1 - a);
      return rgbToHex({ r: over(d[0]), g: over(d[1]), b: over(d[2]) });
    } catch {
      // A canvas tainted by a cross-origin image cannot be read back.
      return null;
    }
  },
};

const plural = (n) => `${n} object${n === 1 ? '' : 's'}`;

export class EyedropperTool extends Tool {
  static id = 'eyedropper';
  static label = 'Eyedropper Tool';
  static shortcut = 'I';
  static icon = 'tool-eyedropper';
  static hint = 'Click an object to copy its appearance to the selection | Shift+Click to pick only the color under the pointer | Option+Click to apply the current appearance to an object';

  activate() {
    this.setCursor('var(--cursor-eyedropper)');
    this.status();
  }

  /** Say what the click did, keeping the tool's hint after it. */
  #report(text) {
    this.status(`${text} | ${this.constructor.hint}`);
  }

  /**
   * Pick the color shown under the pointer into the active fill or stroke,
   * and give it to the selection. Returns false where nothing is painted.
   */
  #pickColor(e) {
    const editor = this.editor;
    const color = pixelSampler.colorAt(editor, e.x, e.y);
    if (!color) return false;
    const key = editor.focusPaint === 'stroke' ? 'stroke' : 'fill';
    const patch = { [key]: { type: 'solid', color } };
    editor.setStyle(patch);
    if (key === 'fill' && eyedropperHooks.some((hk) => hk.apply?.(editor, patch, null))) {
      this.#report(`Picked ${color.toUpperCase()} for the selected mesh points`);
      return true;
    }
    const targets = editor.selectedNodes().filter((n) => n.type !== 'image');
    if (targets.length) {
      editor.doc.transact('Eyedropper', () => {
        for (const t of targets) applyStyleDeep(editor.doc, t, patch);
      });
      this.#report(`Picked ${color.toUpperCase()} as the ${key} of ${plural(targets.length)}`);
    } else this.#report(`Picked ${color.toUpperCase()} as the ${key} for new objects. Select objects first to recolor them`);
    return true;
  }

  onPointerDown(e) {
    const editor = this.editor;
    // Sampling may reach outside isolation; applying paint must stay inside it.
    const filter = e.alt && editor.isolation ? (n) => editor.inIsolation(n.id) : null;
    const hit = hitTest(editor.doc, e.x, e.y, tol(editor, 3), { intoCompound: false, filter });
    const doc = editor.doc;
    if (e.alt) {
      if (!hit) {
        this.#report('Nothing here to apply the appearance to');
        return;
      }
      // Apply the current appearance to the clicked object.
      const patch = {};
      for (const k of eyedropperKeys(this.app)) if (editor.style[k] !== undefined || k === 'appearance') patch[k] = editor.style[k];
      doc.transact('Eyedropper', () => applyStyleDeep(doc, hit, patch));
      this.#report('Applied the current appearance to the object');
      return;
    }
    // Shift, a placed image, and anything the pointer cannot pick as an object
    // (locked art, say) give the color that shows under the pointer.
    if (e.shift || !hit || hit.type === 'image') {
      if (!this.#pickColor(e)) this.#report(hit ? 'Could not read a color here' : 'Nothing to pick up here. Click an object or an image');
      return;
    }
    const groups = eyedropperGroups(this.app);
    const patch = {};
    // A picked object without extra fills and strokes clears the targets' (appearance: undefined).
    for (const k of eyedropperKeys(this.app)) if (hit[k] !== undefined || k === 'appearance') patch[k] = hit[k];
    if (hit.type === 'text') {
      // Type samples the character under the pointer (its runs may override the object's paint).
      const st = styleAt(hit, textIndexAt(hit, e.x, e.y));
      if (groups.fill) patch.fill = st.fill;
      if (groups.stroke) {
        patch.stroke = st.stroke;
        patch.strokeWidth = st.strokeWidth;
      }
      // A chosen glyph alternate belongs to its character, not to the picked style.
      if (groups.character) patch.char = Object.fromEntries(CHAR_KEYS.filter((k) => k !== 'altGlyph').map((k) => [k, st[k]]));
    }
    for (const hk of eyedropperHooks) {
      const p = hk.sample?.(editor, hit, e);
      if (p) Object.assign(patch, p);
    }
    editor.setStyle(patch);
    if (eyedropperHooks.some((hk) => hk.apply?.(editor, patch, hit))) {
      this.#report('Picked the color for the selected mesh points');
      return;
    }
    const targets = editor.selectedNodes().filter((n) => n.id !== hit.id);
    if (!targets.length) {
      this.#report('Picked up the appearance for new objects. Select other objects first to restyle them');
      return;
    }
    // Gradient end points keep their place relative to each object's bounds.
    const placed = ['fill', 'stroke'].filter((k) => patch[k] && patch[k].x1 !== undefined);
    const from = placed.length ? nodeBounds(doc, hit) : null;
    doc.transact('Eyedropper', () => {
      for (const t of targets) {
        const p = { ...patch };
        if (placed.length) {
          const to = nodeBounds(doc, t);
          for (const k of placed) p[k] = moveGradient(p[k], from, to);
        }
        applyStyleDeep(doc, t, p);
      }
    });
    this.#report(`Copied the appearance to ${plural(targets.length)}`);
  }

  async openOptions() {
    const g = eyedropperGroups(this.app);
    const v = await this.app.dialogs.form({
      title: 'Eyedropper Options',
      description: 'Attributes the Eyedropper picks up and applies.',
      fields: Object.keys(EYEDROPPER_LABELS).map((k) => ({ key: k, label: EYEDROPPER_LABELS[k], type: 'checkbox', value: g[k] })),
    });
    if (v) this.app.prefs.set('eyedropperGroups', Object.fromEntries(Object.keys(EYEDROPPER_LABELS).map((k) => [k, Boolean(v[k])])));
  }
}

function textIndexAt(node, x, y) {
  try {
    const p = apply(invert(node.transform), x, y);
    const lay = layoutText(node);
    const c = hitTestText(lay, p.x, p.y);
    // The caret lands between characters; the character under the point is the one before it when the point is left of the caret.
    const i = c > 0 && lay.fromLocal(p.x, p.y).u < caretPosition(lay, c).u ? c - 1 : c;
    return Math.max(0, Math.min(node.text.length - 1, i));
  } catch {
    return 0;
  }
}

/** Apply style fields to a node; groups pass them to their paintable descendants. */
export function applyStyleDeep(doc, node, patch) {
  if (node.type === 'group' || node.type === 'layer') {
    for (const c of node.children) applyStyleDeep(doc, doc.get(c), patch);
    return;
  }
  if (node.type === 'image') return;
  const p = { ...patch };
  if (node.type !== 'text') delete p.char;
  else {
    if (patch.char) p.char = { ...node.char, ...patch.char };
    // Character runs that override these keys give way to the whole-object value.
    if (node.runs) p.runs = stripRunKeys({ ...node, ...p }, [...Object.keys(patch), ...Object.keys(patch.char || {})]);
  }
  doc.update(node.id, p);
}
