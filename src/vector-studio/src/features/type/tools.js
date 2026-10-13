/**
 * Type tools: Type (T), Area Type, Type on a Path and Vertical Type.
 *
 * Type tool: click for point type, drag for area type, click a path's edge
 * to flow type into it (closed paths) or along it (open paths), click
 * existing type to edit it. New type starts with placeholder text selected,
 * so typing replaces it. Escape ends editing and selects the type object
 * with the Selection tool.
 */
import { Tool, tol } from '../../tools/tool.js';
import { hitTest, hitNode } from '../../render/hit.js';
import { createText } from '../../model/nodes.js';
import { layoutText, hitTextLocal } from '../../model/text-layout.js';
import { apply, invert } from '../../lib/matrix.js';
import { pathBounds } from '../../model/bezier.js';
import { TextSession } from './session.js';
import { typeDefaults, applyCharStyle, applyParaStyle, currentCharStyle, currentParaStyle, MIXED } from './type-ops.js';
import { familyFaces } from './fonts.js';
import { styleAt } from '../../model/text-runs.js';
import { LOREM, fillPlaceholder } from './lorem.js';
import { headOf, threadFrames } from './thread-model.js';

const svgCursor = (paths, hx, hy, fallback) => {
  const body = paths.map((d) => `<path d="${d}" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><path d="${d}" fill="none" stroke="#000" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;
};

export const CURSORS = {
  type: 'var(--cursor-type)',
  area: svgCursor(['M9 6 h6 M12 6 v12 M9 18 h6', 'M3 2 h22 v22 h-22 z'], 12, 15, 'text'),
  path: svgCursor(['M9 4 h6 M12 4 v12 M9 16 h6', 'M3 24 C 9 18 17 20 25 14'], 12, 13, 'text'),
  vertical: svgCursor(['M7 9 v6 M7 12 h14 M21 9 v6', 'M10 6 v4'], 14, 12, 'vertical-text'),
};

export class TypeTool extends Tool {
  static id = 'type';
  static label = 'Type Tool';
  static shortcut = 'T';
  static icon = 'tool-type';
  static hint = 'Click to create point type | Drag to create area type | Click a path to type in or along it | Esc to finish';
  static vertical = false;
  static mode = 'type';

  constructor(app) {
    super(app);
    this.drag = null;
    this.clicks = { t: 0, x: 0, y: 0, n: 0 };
  }

  get session() {
    const s = this.app.typeSession;
    return s && !s.ended ? s : null;
  }

  activate() {
    this.setCursor(this.constructor.vertical ? CURSORS.vertical : CURSORS.type);
    this.status();
  }

  deactivate() {
    this.endEditing();
    this.drag = null;
  }

  commit() {
    this.endEditing();
  }

  cancel() {
    this.drag = null;
    this.overlay();
  }

  // ---- editing lifecycle ----

  /** Start editing a text object (also called by the Selection tool's double-click). */
  editText(id, e = null, { selectAll = false } = {}) {
    const editor = this.editor;
    if (!editor) return null;
    let node = editor.doc.get(id);
    if (!node || node.type !== 'text' || editor.doc.isLocked(id)) return null;
    // Threaded frames edit the story, which lives in the thread's first frame.
    node = headOf(editor.doc, node);
    id = node.id;
    if (this.session?.id === id && this.session.editor === editor) return this.session;
    this.endEditing();
    const s = new TextSession(this.app, editor, id);
    this.app.typeSession = s;
    if (selectAll) s.selectAll();
    else if (e) {
      const i = s.indexAt(e.x, e.y);
      s.setSelection(i, i);
      if (e.word) s.selectWord(i);
    } else s.setSelection(node.text.length, node.text.length);
    return s;
  }

  /** Finish editing; empty type is removed. `select` keeps the object selected. */
  endEditing({ select = true, removed = false } = {}) {
    const s = this.session;
    if (!s) return;
    s.end();
    this.app.typeSession = null;
    const ed = s.editor;
    const n = ed.doc.get(s.id);
    if (!removed && n && !n.text.length && n.kind !== 'area' && n.kind !== 'path') {
      ed.doc.transact('Clear', () => ed.doc.remove(n.id));
      ed.clearSelection();
    } else if (n && select) ed.select([n.id]);
    else if (!select) ed.clearSelection();
    this.overlay();
  }

  exitToSelection() {
    const s = this.session;
    const id = s?.id;
    this.endEditing({ select: true });
    this.app.setTool(this.app.lastSelectionTool || 'selection');
    if (id && this.editor?.doc.has(id)) this.editor.select([id]);
  }

  // ---- creating ----

  newTextNode(x, y, extra = {}) {
    const d = typeDefaults(this.app);
    return createText('', x, y, { char: { ...d.char }, para: { ...d.para }, fill: d.fill, stroke: d.stroke, strokeWidth: d.strokeWidth, vertical: this.constructor.vertical || undefined, ...extra });
  }

  /** Insert a new type object, filled with placeholder text (selected) when the preference is on. */
  createAndEdit(node, replaceId = null) {
    const editor = this.editor;
    if (!editor.canDrawInTarget()) {
      this.app.notify('The target layer is locked or hidden.');
      return;
    }
    const placeholder = this.app.prefs.get('typePlaceholder') !== false;
    let text = '';
    if (placeholder) text = node.kind === 'point' ? 'Lorem ipsum' : fillPlaceholder(node);
    const n = { ...node, text };
    const layer = editor.targetLayer();
    editor.doc.transact(node.kind === 'area' ? 'Area Type' : node.kind === 'path' ? 'Type on a Path' : 'Type', () => {
      const old = replaceId ? editor.doc.get(replaceId) : null;
      if (old) {
        // The path becomes the type object, in its place in the stacking order.
        const parent = editor.doc.get(old.parent);
        editor.doc.insert(n, parent.id, parent.children.indexOf(old.id) + 1);
        editor.doc.remove(old.id);
      } else editor.doc.insert(n, layer.id);
    });
    const s = this.editText(n.id, null);
    if (s) {
      s.created = true;
      s.setSelection(0, text.length);
    }
  }

  /** A path whose edge is under the pointer (for area type and type on a path). */
  pathAt(e, { closedOnly = false, edgeOnly = true } = {}) {
    const editor = this.editor;
    const t = tol(editor, 4);
    const hit = hitTest(editor.doc, e.x, e.y, t, { filter: (n) => n.type === 'path' && n.anchors.length > 1 && (!closedOnly || n.closed), outline: edgeOnly });
    return hit && hit.type === 'path' ? hit : null;
  }

  textAt(e) {
    const editor = this.editor;
    const hit = hitTest(editor.doc, e.x, e.y, tol(editor, 3), { filter: (n) => n.type === 'text' });
    return hit && hit.type === 'text' ? hit : null;
  }

  insideEdited(e) {
    const s = this.session;
    if (!s) return false;
    const n = s.node();
    if (!n) return false;
    // Every frame of a threaded story belongs to the edited text.
    return threadFrames(this.editor.doc, n).some((f) => {
      const p = apply(invert(f.transform), e.x, e.y);
      return hitTextLocal(layoutText(f), p.x, p.y, tol(this.editor, 6) / Math.max(1e-6, Math.hypot(f.transform[0], f.transform[1])));
    });
  }

  /** Path-type start bracket under the pointer, for dragging the start offset. */
  bracketAt(e) {
    const editor = this.editor;
    for (const id of editor.selection) {
      const n = editor.doc.get(id);
      if (!n || n.type !== 'text' || n.kind !== 'path') continue;
      const lay = layoutText(n);
      if (!lay.path) continue;
      const u = n.pathOptions?.start || 0;
      const p = lay.path.at(u);
      const d = apply(n.transform, p.x, p.y);
      const s = editor.view.toScreen(d.x, d.y);
      if (Math.hypot(s.x - e.sx, s.y - e.sy) < 7) return n;
    }
    return null;
  }

  onHover(e) {
    if (this.bracketAt(e)) {
      this.setCursor('ew-resize');
      return;
    }
    const mode = this.constructor.mode;
    if (this.insideEdited(e) || this.textAt(e)) {
      this.setCursor(this.constructor.vertical ? 'vertical-text' : 'text');
      return;
    }
    if (mode === 'type') {
      const p = this.pathAt(e);
      if (p) {
        this.setCursor(p.closed ? CURSORS.area : CURSORS.path);
        return;
      }
    } else if (mode === 'area') {
      if (this.pathAt(e, { closedOnly: true, edgeOnly: false })) {
        this.setCursor(CURSORS.area);
        return;
      }
    } else if (mode === 'path') {
      if (this.pathAt(e)) {
        this.setCursor(CURSORS.path);
        return;
      }
    }
    this.setCursor(this.constructor.vertical ? CURSORS.vertical : mode === 'area' ? CURSORS.area : mode === 'path' ? CURSORS.path : CURSORS.type);
  }

  #clickCount(e) {
    const now = performance.now();
    const c = this.clicks;
    const near = Math.hypot(e.sx - c.x, e.sy - c.y) < 6;
    c.n = now - c.t < 450 && near ? c.n + 1 : 1;
    c.t = now;
    c.x = e.sx;
    c.y = e.sy;
    return c.n;
  }

  onPointerDown(e) {
    const editor = this.editor;
    const clicks = this.#clickCount(e);
    const bracket = this.bracketAt(e);
    if (bracket) {
      this.drag = { kind: 'bracket', id: bracket.id, tx: editor.doc.begin('Move Type on a Path') };
      return;
    }
    // Inside the text being edited: place the caret or extend, start a drag selection.
    if (this.insideEdited(e)) {
      const s = this.session;
      const i = s.indexAt(e.x, e.y);
      if (clicks >= 3) s.selectParagraph(i);
      else if (clicks === 2) s.selectWord(i);
      else if (e.shift) s.setSelection(s.anchor, i);
      else s.setSelection(i, i);
      s.focus();
      this.drag = clicks === 1 ? { kind: 'select' } : null;
      return;
    }
    const text = this.textAt(e);
    if (text && !editor.doc.isLocked(text.id)) {
      const s = this.editText(text.id, e);
      s?.focus();
      this.drag = { kind: 'select' };
      return;
    }
    this.endEditing({ select: false });
    this.drag = { kind: 'create', x0: e.x, y0: e.y, x: e.x, y: e.y, sx0: e.sx, sy0: e.sy, moved: false };
  }

  onDoubleClick(e) {
    // input.js reports the second click as a double-click instead of a pointerdown.
    this.clicks.n = 2;
    this.clicks.t = performance.now();
    this.clicks.x = e.sx;
    this.clicks.y = e.sy;
    if (this.insideEdited(e)) {
      const s = this.session;
      s.selectWord(s.indexAt(e.x, e.y));
      s.focus();
      return;
    }
    const text = this.textAt(e);
    if (text) {
      const s = this.editText(text.id, e);
      if (s) s.selectWord(s.indexAt(e.x, e.y));
      return;
    }
    this.onPointerDown(e);
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'select') {
      const s = this.session;
      if (!s) return;
      const i = s.indexAt(e.x, e.y);
      if (i !== s.caret) s.setSelection(s.anchor, i);
      return;
    }
    if (d.kind === 'bracket') {
      const n = this.editor.doc.get(d.id);
      if (!n) return;
      const lay = layoutText(n);
      const p = apply(invert(n.transform), e.x, e.y);
      const pr = lay.path.project(p.x, p.y);
      this.editor.doc.update(n.id, { pathOptions: { ...(n.pathOptions || {}), start: Math.max(0, Math.min(lay.path.length - 1, pr.u)) } });
      return;
    }
    if (d.kind === 'create') {
      d.x = e.x;
      d.y = e.y;
      if (Math.hypot(e.sx - d.sx0, e.sy - d.sy0) > 4) d.moved = true;
      if (e.shift && d.moved) {
        const s = Math.max(Math.abs(d.x - d.x0), Math.abs(d.y - d.y0));
        d.x = d.x0 + Math.sign(d.x - d.x0 || 1) * s;
        d.y = d.y0 + Math.sign(d.y - d.y0 || 1) * s;
      }
      this.overlay();
    }
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'select') {
      this.session?.focus();
      return;
    }
    if (d.kind === 'bracket') {
      d.tx.commit();
      return;
    }
    if (d.kind !== 'create') return;
    this.overlay();
    const mode = this.constructor.mode;
    if (d.moved) {
      const x = Math.min(d.x0, d.x);
      const y = Math.min(d.y0, d.y);
      const w = Math.abs(d.x - d.x0);
      const h = Math.abs(d.y - d.y0);
      if (w < 2 || h < 2) return;
      this.createAndEdit(this.newTextNode(x, y, { kind: 'area', width: w, height: h }));
      return;
    }
    // A click: on a path edge, into or along it; else point type.
    if (mode === 'area' || mode === 'type') {
      const p = this.pathAt(e, { closedOnly: true, edgeOnly: mode === 'type' });
      if (p) return this.areaFromPath(p);
    }
    if (mode === 'path' || mode === 'type') {
      const p = this.pathAt(e);
      if (p) return this.pathTypeFrom(p);
    }
    if (mode === 'area' || mode === 'path') {
      this.app.notify(mode === 'area' ? 'To use the Area Type tool, click a closed path.' : 'To use the Type on a Path tool, click a path.');
      return;
    }
    this.createAndEdit(this.newTextNode(d.x0, d.y0, { kind: 'point' }));
  }

  /** Convert a closed path into an area type container. */
  areaFromPath(path) {
    const b = pathBounds(path.anchors, true);
    const rect = isAxisRect(path);
    const node = this.newTextNode(b.x, b.y, { kind: 'area', width: b.w, height: b.h, ...(rect || this.constructor.vertical ? {} : { areaPath: path.anchors }) });
    this.createAndEdit(node, path.id);
  }

  /** Put type along a path (the path becomes the type's baseline guide). */
  pathTypeFrom(path) {
    const node = this.newTextNode(path.anchors[0].x, path.anchors[0].y, { kind: 'path', pathAnchors: path.anchors, pathClosed: path.closed, pathOptions: { effect: 'rainbow', align: 'baseline', start: 0 }, vertical: this.constructor.vertical || undefined });
    this.createAndEdit(node, path.id);
  }

  onKeyDown(e) {
    const s = this.session;
    if (!s) return false;
    return s.handleKey(e, this.keyActions());
  }

  /** Keyboard actions for style shortcuts while editing. */
  keyActions() {
    const app = this.app;
    const num = (v, d) => (v === MIXED || v == null ? d : v);
    return {
      align: (align) => applyParaStyle(app, { align }, { label: 'Paragraph Alignment' }),
      size: (dir, mult) => {
        const cur = currentCharStyle(app);
        const size = Math.max(0.1, Math.min(1296, num(cur?.fontSize, 12) + dir * (app.prefs.get('typeSizeIncrement') || 2) * mult));
        applyCharStyle(app, { fontSize: size }, { label: 'Font Size', coalesce: 'type-size' });
      },
      clearTracking: () => applyCharStyle(app, { tracking: 0 }, { label: 'Tracking' }),
      clearScale: () => applyCharStyle(app, { horizontalScale: 100, verticalScale: 100 }, { label: 'Scale' }),
      toggle: (what) => {
        const cur = currentCharStyle(app) || {};
        if (what === 'underline') applyCharStyle(app, { underline: cur.underline !== true }, { label: 'Underline' });
        else if (what === 'super' || what === 'sub') applyCharStyle(app, { position: cur.position === what ? 'normal' : what }, { label: what === 'super' ? 'Superscript' : 'Subscript' });
        else {
          const faces = familyFaces(cur.fontFamily);
          const w = num(cur.fontWeight, 400);
          const italic = cur.fontStyle === 'italic';
          let target = what === 'bold' ? { fontWeight: w >= 600 ? 400 : 700, fontStyle: italic ? 'italic' : 'normal' } : { fontWeight: w, fontStyle: italic ? 'normal' : 'italic' };
          if (faces.length && !faces.some((f) => f.weight === target.fontWeight && f.style === target.fontStyle)) {
            const near = faces.find((f) => f.style === target.fontStyle);
            if (near) target = { fontWeight: what === 'bold' ? target.fontWeight : near.weight, fontStyle: near.style };
          }
          applyCharStyle(app, target, { label: 'Font Style' });
        }
      },
      kern: (dir, mult) => {
        const s = this.session;
        const [a, b] = s.range();
        if (a === b) {
          // Kerning between the characters around the caret (stored on the following character).
          const n = s.node();
          if (a >= n.text.length || a === 0) return;
          const cur = styleAt(n, a);
          s.anchor = a;
          s.caret = a + 1;
          applyCharStyle(app, { kerning: num(cur.kerning, 0) + dir * (app.prefs.get('typeTrackingIncrement') || 20) * mult }, { label: 'Kerning', coalesce: `kern-${n.id}-${a}` });
          s.anchor = s.caret = a;
          s.changed();
        } else {
          const cur = currentCharStyle(app);
          applyCharStyle(app, { tracking: num(cur?.tracking, 0) + dir * (app.prefs.get('typeTrackingIncrement') || 20) * mult }, { label: 'Tracking', coalesce: 'type-tracking' });
        }
      },
      leading: (dir, mult) => {
        const cur = currentCharStyle(app);
        const auto = num(cur?.fontSize, 12) * 1.2;
        const lead = Math.max(0, num(cur?.leading, auto) ?? auto) + dir * 2 * mult;
        applyCharStyle(app, { leading: Math.max(0, lead) }, { label: 'Leading', coalesce: 'type-leading' });
      },
      baseline: (dir, mult) => {
        const cur = currentCharStyle(app);
        applyCharStyle(app, { baselineShift: num(cur?.baselineShift, 0) + dir * (app.prefs.get('typeBaselineIncrement') || 2) * mult }, { label: 'Baseline Shift', coalesce: 'type-baseline' });
      },
      exit: () => this.exitToSelection(),
    };
  }

  drawOverlay(ctx, editor) {
    this.session?.drawOverlay(ctx, editor);
    const d = this.drag;
    if (d?.kind === 'create' && d.moved) {
      const a = editor.view.toScreen(d.x0, d.y0);
      const b = editor.view.toScreen(d.x, d.y);
      ctx.save();
      ctx.strokeStyle = '#7a7a7a';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.restore();
    }
  }

  openOptions() {
    this.app.dialogs
      .form({
        title: 'Type Options',
        fields: [{ key: 'placeholder', type: 'checkbox', label: 'Fill New Type Objects With Placeholder Text', value: this.app.prefs.get('typePlaceholder') !== false }],
      })
      .then((v) => {
        if (v) this.app.prefs.set('typePlaceholder', v.placeholder);
      });
  }
}

/** Rectangle anchors as { } when the path is an axis-aligned rectangle (so area type stays a plain box). */
function isAxisRect(path) {
  const a = path.anchors;
  if (!path.closed || a.length !== 4) return null;
  for (const p of a) if (p.ix !== p.x || p.iy !== p.y || p.ox !== p.x || p.oy !== p.y) return null;
  const xs = new Set(a.map((p) => Math.round(p.x * 1000)));
  const ys = new Set(a.map((p) => Math.round(p.y * 1000)));
  return xs.size === 2 && ys.size === 2 ? {} : null;
}

export class AreaTypeTool extends TypeTool {
  static id = 'area-type';
  static label = 'Area Type Tool';
  static shortcut = '';
  static icon = 'tool-area-type';
  static hint = 'Click a closed path to flow type inside it | Drag to create a type area';
  static mode = 'area';
}

export class TypeOnPathTool extends TypeTool {
  static id = 'type-on-path';
  static label = 'Type on a Path Tool';
  static shortcut = '';
  static icon = 'tool-type-on-path';
  static hint = 'Click a path to place type along it | Drag the start bracket to move the type';
  static mode = 'path';
}

export class VerticalTypeTool extends TypeTool {
  static id = 'vertical-type';
  static label = 'Vertical Type Tool';
  static shortcut = '';
  static icon = 'tool-vertical-type';
  static hint = 'Click to create vertical point type | Drag to create vertical area type';
  static vertical = true;
}

export class VerticalAreaTypeTool extends TypeTool {
  static id = 'vertical-area-type';
  static label = 'Vertical Area Type Tool';
  static shortcut = '';
  static icon = 'tool-vertical-area-type';
  static hint = 'Click a closed path to flow vertical type inside it | Drag to create a vertical type area';
  static vertical = true;
  static mode = 'area';
}

export class VerticalTypeOnPathTool extends TypeTool {
  static id = 'vertical-type-on-path';
  static label = 'Vertical Type on a Path Tool';
  static shortcut = '';
  static icon = 'tool-vertical-type-on-path';
  static hint = 'Click a path to stack upright type along it | Drag the start bracket to move the type';
  static vertical = true;
  static mode = 'path';
}

export { LOREM };
