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
      editor.view.fit({ x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) }, 0);
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

export class EyedropperTool extends Tool {
  static id = 'eyedropper';
  static label = 'Eyedropper Tool';
  static shortcut = 'I';
  static icon = 'tool-eyedropper';
  static hint = 'Click an object to copy its appearance to the selection | Option+Click to apply the current appearance to an object';

  activate() {
    this.setCursor('var(--cursor-eyedropper)');
    this.status();
  }

  onPointerDown(e) {
    const editor = this.editor;
    const hit = hitTest(editor.doc, e.x, e.y, tol(editor, 3), { intoCompound: false });
    if (!hit) return;
    const doc = editor.doc;
    if (e.alt) {
      // Apply the current appearance to the clicked object.
      const patch = {};
      for (const k of eyedropperKeys(this.app)) if (editor.style[k] !== undefined || k === 'appearance') patch[k] = editor.style[k];
      doc.transact('Eyedropper', () => applyStyleDeep(doc, hit, patch));
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
    editor.setStyle(patch);
    const targets = editor.selectedNodes().filter((n) => n.id !== hit.id);
    if (!targets.length) return;
    doc.transact('Eyedropper', () => {
      for (const t of targets) applyStyleDeep(doc, t, patch);
    });
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
