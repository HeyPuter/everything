/**
 * Edit, Object, Select and View commands. File, Type and Effect commands
 * register from their own modules.
 */
import * as O from '../ops/object-ops.js';
import * as C from '../ops/clipboard.js';
import * as SEL from '../ops/select-ops.js';
import { multiply, rotate, scale, shear, translate } from '../lib/matrix.js';
import { transformNodes, transformPatches, selectionBounds, selectionFrame, frameToDoc, frameMatrix } from '../model/geometry.js';
import { reflectAcross } from '../tools/transform-tools.js';
import { createPath } from '../model/nodes.js';

const hasDoc = (app) => Boolean(app.editor);
const hasSel = (app) => Boolean(app.editor?.selection.size);
const selCount = (n) => (app) => (app.editor?.topSelection().length || 0) >= n;
const selHas = (pred) => (app) => Boolean(app.editor?.selectedNodes().some(pred));

function transformAgain(app) {
  const ed = app.editor;
  const last = ed.lastTransform;
  if (!last) return;
  ed.doc.transact('Transform Again', () => {
    if (last.each) transformEach(ed, last.each, last.copy);
    else {
      let ids = ed.topSelection();
      if (last.copy) ids = duplicate(ed, ids);
      transformNodes(ed.doc, ids, last.matrix, last.opts);
    }
  });
}

function duplicate(editor, ids) {
  const doc = editor.doc;
  const out = [];
  for (const id of ids) {
    const n = doc.get(id);
    const parent = doc.get(n.parent);
    const { node, descendants } = doc.cloneSubtree(id);
    doc.insert(node, parent.id, parent.children.indexOf(id) + 1, descendants);
    out.push(node.id);
  }
  editor.select(out);
  return out;
}

/** Apply a matrix to the selection (optionally to a copy) and remember it for Transform Again. */
export function applyTransform(editor, label, m, { copy = false, opts } = {}) {
  const prefs = editor.prefs;
  // Transform panel menu: Transform Object Only / Pattern Only / Both.
  const mode = prefs?.get('transformMode') || 'both';
  const o = opts || {
    scaleStrokes: prefs?.get('scaleStrokes'),
    scaleCorners: prefs?.get('scaleCorners'),
    transformPatterns: mode === 'pattern' || (mode === 'both' && (prefs?.get('transformPatterns') ?? true)),
    ...(mode === 'pattern' ? { transformObjects: false } : {}),
  };
  editor.doc.transact(label, () => {
    let ids = editor.topSelection();
    if (copy) ids = duplicate(editor, ids);
    transformNodes(editor.doc, ids, m, o);
  });
  editor.lastTransform = { matrix: m, copy, opts: o };
}

/**
 * Transform Each: scale/rotate/move every object around its own reference
 * point. The reference point and the scale axes come from each object's
 * bounding box frame, so a turned object scales along its own axes.
 */
export function transformEach(editor, p, copy = false) {
  const doc = editor.doc;
  let ids = editor.topSelection();
  if (copy) ids = duplicate(editor, ids);
  const visual = editor.prefs?.get('previewBounds');
  for (const id of ids) {
    const f = selectionFrame(doc, [id], visual);
    if (!f) continue;
    const lx = f.x + f.w * (p.refX ?? 0.5);
    const ly = f.y + f.h * (p.refY ?? 0.5);
    const { x: rx, y: ry } = frameToDoc(f, lx, ly);
    let dx = p.moveX || 0;
    let dy = p.moveY || 0;
    let ang = p.angle || 0;
    if (p.random) {
      dx *= Math.random() * 2 - 1;
      dy *= Math.random() * 2 - 1;
      ang *= Math.random() * 2 - 1;
    }
    let m = frameMatrix(f, scale((p.scaleX ?? 100) / 100 * (p.reflectX ? -1 : 1), (p.scaleY ?? 100) / 100 * (p.reflectY ? -1 : 1), lx, ly));
    m = multiply(rotate(-ang, rx, ry), m);
    m = multiply(translate(dx, dy), m);
    const patches = transformPatches(doc, doc.get(id), m, { scaleStrokes: editor.prefs?.get('scaleStrokes') });
    for (const [pid, patch] of patches) doc.update(pid, patch);
  }
}

export function registerCoreCommands(app) {
  const c = app.commands;
  let lastSelection = null;
  const ed = () => app.editor;

  c.register([
    // ---- Edit ----
    { id: 'edit.undo', label: (a) => (a.editor?.doc.undoLabel ? `Undo ${a.editor.doc.undoLabel}` : 'Undo'), shortcut: 'Mod+Z', enabled: (a) => a.editor?.doc.canUndo, run: (a) => (a.tool?.cancel?.(), a.editor.doc.undo()) },
    { id: 'edit.redo', label: (a) => (a.editor?.doc.redoLabel ? `Redo ${a.editor.doc.redoLabel}` : 'Redo'), shortcut: 'Shift+Mod+Z', altShortcuts: ['Mod+Y'], enabled: (a) => a.editor?.doc.canRedo, run: (a) => a.editor.doc.redo() },
    { id: 'edit.cut', label: 'Cut', shortcut: 'Mod+X', enabled: hasSel, run: (a) => (C.copy(ed(), { cut: true }), a.clipboardToSystem?.()) },
    { id: 'edit.copy', label: 'Copy', shortcut: 'Mod+C', enabled: hasSel, run: (a) => (C.copy(ed()), a.clipboardToSystem?.()) },
    { id: 'edit.paste', label: 'Paste', shortcut: 'Mod+V', enabled: hasDoc, run: () => C.paste(ed(), 'center') },
    { id: 'edit.pasteFront', label: 'Paste in Front', shortcut: 'Mod+F', enabled: (a) => hasDoc(a) && C.clipboard.data, run: () => C.paste(ed(), 'front') },
    { id: 'edit.pasteBack', label: 'Paste in Back', shortcut: 'Mod+B', enabled: (a) => hasDoc(a) && C.clipboard.data, run: () => C.paste(ed(), 'back') },
    { id: 'edit.pasteInPlace', label: 'Paste in Place', shortcut: 'Shift+Mod+V', enabled: (a) => hasDoc(a) && C.clipboard.data, run: () => C.paste(ed(), 'place') },
    { id: 'edit.pasteAll', label: 'Paste on All Artboards', shortcut: 'Alt+Shift+Mod+V', enabled: (a) => hasDoc(a) && C.clipboard.data, run: () => C.paste(ed(), 'all') },
    { id: 'edit.clear', label: 'Clear', shortcut: 'Delete', altShortcuts: ['Backspace'], enabled: hasSel, run: () => O.deleteSelection(ed()) },
    { id: 'edit.duplicate', label: 'Duplicate', shortcut: '', enabled: hasSel, run: () => ed().doc.transact('Duplicate', () => duplicate(ed(), ed().topSelection())) },

    // ---- Object > Transform ----
    { id: 'object.transformAgain', label: 'Transform Again', shortcut: 'Mod+D', enabled: (a) => hasSel(a) && a.editor.lastTransform, run: transformAgain },
    { id: 'object.transform.move', label: 'Move...', shortcut: 'Shift+Mod+M', enabled: hasSel, run: (a) => a.dialogs.transform('move') },
    { id: 'object.transform.rotate', label: 'Rotate...', enabled: hasSel, run: (a, args) => a.dialogs.transform('rotate', args) },
    { id: 'object.transform.reflect', label: 'Reflect...', enabled: hasSel, run: (a, args) => a.dialogs.transform('reflect', args) },
    { id: 'object.transform.scale', label: 'Scale...', enabled: hasSel, run: (a, args) => a.dialogs.transform('scale', args) },
    { id: 'object.transform.shear', label: 'Shear...', enabled: hasSel, run: (a, args) => a.dialogs.transform('shear', args) },
    { id: 'object.transform.each', label: 'Transform Each...', shortcut: 'Alt+Shift+Mod+D', enabled: hasSel, run: (a) => a.dialogs.transform('each') },
    { id: 'object.flipH', label: 'Flip Horizontal', enabled: hasSel, run: () => flip(ed(), 'h') },
    { id: 'object.flipV', label: 'Flip Vertical', enabled: hasSel, run: () => flip(ed(), 'v') },
    { id: 'object.rotate90cw', label: 'Rotate 90° Clockwise', enabled: hasSel, run: () => rotateBy(ed(), 90) },
    { id: 'object.rotate90ccw', label: 'Rotate 90° Counterclockwise', enabled: hasSel, run: () => rotateBy(ed(), -90) },

    // ---- Object > Arrange ----
    { id: 'object.bringToFront', label: 'Bring to Front', shortcut: 'Shift+Mod+]', enabled: hasSel, run: () => O.arrange(ed(), 'front') },
    { id: 'object.bringForward', label: 'Bring Forward', shortcut: 'Mod+]', enabled: hasSel, run: () => O.arrange(ed(), 'forward') },
    { id: 'object.sendBackward', label: 'Send Backward', shortcut: 'Mod+[', enabled: hasSel, run: () => O.arrange(ed(), 'backward') },
    { id: 'object.sendToBack', label: 'Send to Back', shortcut: 'Shift+Mod+[', enabled: hasSel, run: () => O.arrange(ed(), 'back') },
    { id: 'object.sendToLayer', label: 'Send to Current Layer', enabled: hasSel, run: () => O.sendToLayer(ed(), ed().activeLayerId) },

    // ---- Object ----
    { id: 'object.group', label: 'Group', shortcut: 'Mod+G', enabled: hasSel, run: () => O.group(ed()) },
    { id: 'object.ungroup', label: 'Ungroup', shortcut: 'Shift+Mod+G', enabled: selHas((n) => n.type === 'group'), run: () => O.ungroup(ed()) },
    { id: 'object.lock', label: 'Lock Selection', shortcut: 'Mod+2', enabled: hasSel, run: () => O.lockSelection(ed()) },
    { id: 'object.unlockAll', label: 'Unlock All', shortcut: 'Alt+Mod+2', enabled: hasDoc, run: () => O.unlockAll(ed()) },
    { id: 'object.hide', label: 'Hide Selection', shortcut: 'Mod+3', enabled: hasSel, run: () => O.hideSelection(ed()) },
    { id: 'object.showAll', label: 'Show All', shortcut: 'Alt+Mod+3', enabled: hasDoc, run: () => O.showAll(ed()) },
    { id: 'object.clipMake', label: 'Make', shortcut: 'Mod+7', enabled: selCount(2), run: () => O.makeClipMask(ed()) },
    { id: 'object.clipRelease', label: 'Release', shortcut: 'Alt+Mod+7', enabled: hasSel, run: () => O.releaseClipMask(ed()) },
    { id: 'object.compoundMake', label: 'Make', shortcut: 'Mod+8', enabled: hasSel, run: () => O.makeCompound(ed()) },
    { id: 'object.compoundRelease', label: 'Release', shortcut: 'Alt+Shift+Mod+8', enabled: selHas((n) => n.type === 'compound'), run: () => O.releaseCompound(ed()) },
    { id: 'path.join', label: 'Join', shortcut: 'Mod+J', enabled: hasSel, run: () => O.join(ed()) },
    { id: 'path.average', label: 'Average...', shortcut: 'Alt+Mod+J', enabled: hasSel, run: (a) => a.dialogs.average() },
    { id: 'path.reverse', label: 'Reverse Path Direction', enabled: selHas((n) => n.type === 'path' || n.type === 'compound'), run: () => O.reversePaths(ed()) },
    {
      id: 'object.isolate',
      label: 'Isolate Selected Group',
      enabled: (a, args) => Boolean(args?.id) || selHas((n) => n.type === 'group')(a),
      run: (a, args) => {
        const id = args?.id || ed().selectedNodes().find((n) => n.type === 'group')?.id;
        ed().isolation = id;
        ed().clearSelection();
        ed().emit('isolation');
        ed().invalidate();
      },
    },
    {
      id: 'object.exitIsolation',
      label: 'Exit Isolation Mode',
      enabled: (a) => Boolean(a.editor?.isolation),
      run: () => {
        const id = ed().isolation;
        ed().isolation = null;
        ed().select(ed().doc.has(id) ? [id] : []);
        ed().emit('isolation');
        ed().invalidate();
      },
    },

    // ---- Select ----
    { id: 'select.all', label: 'All', shortcut: 'Mod+A', enabled: hasDoc, run: () => SEL.selectAll(ed()) },
    { id: 'select.allArtboard', label: 'All on Active Artboard', shortcut: 'Alt+Mod+A', enabled: hasDoc, run: () => SEL.selectAllOnArtboard(ed()) },
    {
      id: 'select.none',
      label: 'Deselect',
      shortcut: 'Shift+Mod+A',
      enabled: hasSel,
      run: () => {
        lastSelection = [...ed().selection];
        ed().clearSelection();
      },
    },
    { id: 'select.reselect', label: 'Reselect', shortcut: 'Mod+6', enabled: () => Boolean(lastSelection), run: () => SEL.reselect(ed(), lastSelection) },
    { id: 'select.inverse', label: 'Inverse', enabled: hasDoc, run: () => SEL.selectInverse(ed()) },
    { id: 'select.nextAbove', label: 'Next Object Above', shortcut: 'Alt+Mod+]', enabled: hasSel, run: () => SEL.selectNext(ed(), 1) },
    { id: 'select.nextBelow', label: 'Next Object Below', shortcut: 'Alt+Mod+[', enabled: hasSel, run: () => SEL.selectNext(ed(), -1) },
    ...['fill', 'stroke', 'fillStroke', 'strokeWeight', 'opacity', 'blendMode', 'appearance', 'shape'].map((what) => ({
      id: `select.same.${what}`,
      label: { fill: 'Fill Color', stroke: 'Stroke Color', fillStroke: 'Fill & Stroke', strokeWeight: 'Stroke Weight', opacity: 'Opacity', blendMode: 'Blending Mode', appearance: 'Appearance', shape: 'Shape' }[what],
      enabled: hasSel,
      run: () => SEL.selectSame(ed(), what),
    })),
    ...['sameLayer', 'text', 'clipping', 'stray'].map((what) => ({
      id: `select.object.${what}`,
      label: { sameLayer: 'All on Same Layers', text: 'Text Objects', clipping: 'Clipping Masks', stray: 'Stray Points' }[what],
      enabled: what === 'sameLayer' ? hasSel : hasDoc,
      run: () => SEL.selectObjects(ed(), what),
    })),

    // ---- View ----
    {
      id: 'view.outline',
      label: (a) => (a.editor?.viewOptions.mode === 'outline' ? 'Preview' : 'Outline'),
      shortcut: 'Mod+Y',
      enabled: hasDoc,
      run: () => ed().setViewOption('mode', ed().viewOptions.mode === 'outline' ? 'preview' : 'outline'),
    },
    viewToggle('view.pixelPreview', 'Pixel Preview', 'pixelPreview', 'Alt+Mod+Y'),
    { id: 'view.zoomIn', label: 'Zoom In', shortcut: 'Mod+=', altShortcuts: ['Mod++', 'Shift+Mod+='], enabled: hasDoc, run: () => (ed().view.stepZoom(1), ed().viewChanged()) },
    { id: 'view.zoomOut', label: 'Zoom Out', shortcut: 'Mod+-', enabled: hasDoc, run: () => (ed().view.stepZoom(-1), ed().viewChanged()) },
    { id: 'view.fitArtboard', label: 'Fit Artboard in Window', shortcut: 'Mod+0', enabled: hasDoc, run: () => ed().fitArtboard() },
    { id: 'view.fitAll', label: 'Fit All in Window', shortcut: 'Alt+Mod+0', enabled: hasDoc, run: () => ed().fitAll() },
    { id: 'view.actualSize', label: 'Actual Size', shortcut: 'Mod+1', enabled: hasDoc, run: () => ed().actualSize() },
    {
      id: 'view.fitSelection',
      label: 'Zoom to Selection',
      enabled: hasSel,
      run: () => {
        const b = ed().selectionBounds();
        if (b) ed().view.fit({ x: b.x, y: b.y, w: Math.max(b.w, 1), h: Math.max(b.h, 1) }, 80);
        ed().viewChanged();
      },
    },
    { id: 'view.resetRotation', label: 'Reset View Rotation', shortcut: 'Shift+Mod+1', enabled: (a) => Boolean(a.editor?.view.rotation), run: () => (ed().view.rotateView(0), ed().viewChanged()) },
    viewToggle('view.edges', (a) => (a.editor?.viewOptions.edges ? 'Hide Edges' : 'Show Edges'), 'edges', 'Mod+H'),
    viewToggle('view.artboards', (a) => (a.editor?.viewOptions.artboards ? 'Hide Artboards' : 'Show Artboards'), 'artboards', 'Shift+Mod+H'),
    viewToggle('view.boundingBox', (a) => (a.editor?.viewOptions.boundingBox ? 'Hide Bounding Box' : 'Show Bounding Box'), 'boundingBox', 'Shift+Mod+B'),
    viewToggle('view.transparencyGrid', (a) => (a.editor?.viewOptions.transparencyGrid ? 'Hide Transparency Grid' : 'Show Transparency Grid'), 'transparencyGrid', 'Shift+Mod+D'),
    viewToggle('view.rulers', (a) => (a.editor?.viewOptions.rulers ? 'Hide Rulers' : 'Show Rulers'), 'rulers', 'Mod+R'),
    viewToggle('view.alignmentGuides', 'Alignment Guides', 'alignmentGuides', 'Mod+U'),
    viewToggle('view.guides', (a) => (a.editor?.viewOptions.guides ? 'Hide Guides' : 'Show Guides'), 'guides', 'Mod+;'),
    viewToggle('view.lockGuides', (a) => (a.editor?.viewOptions.lockGuides ? 'Unlock Guides' : 'Lock Guides'), 'lockGuides', 'Alt+Mod+;'),
    viewToggle('view.grid', (a) => (a.editor?.viewOptions.grid ? 'Hide Grid' : 'Show Grid'), 'grid', "Mod+'"),
    viewToggle('view.snapGrid', 'Snap to Grid', 'snapToGrid', "Shift+Mod+'"),
    viewToggle('view.snapPoint', 'Snap to Point', 'snapToPoint', "Alt+Mod+'"),
    viewToggle('view.snapPixel', 'Snap to Pixel', 'snapToPixel'),
    {
      id: 'view.makeGuides',
      label: 'Make Guides',
      shortcut: 'Mod+5',
      enabled: selHas((n) => n.type === 'path' && n.anchors.length === 2),
      run: () => {
        const e = ed();
        const guides = [...(e.doc.root.guides || [])];
        const lines = e.selectedNodes().filter((n) => n.type === 'path' && n.anchors.length === 2);
        e.doc.transact('Make Guides', () => {
          for (const l of lines) {
            const [a, b] = l.anchors;
            if (Math.abs(a.x - b.x) < 1e-6) guides.push({ axis: 'x', pos: a.x });
            else if (Math.abs(a.y - b.y) < 1e-6) guides.push({ axis: 'y', pos: a.y });
            else continue;
            e.doc.remove(l.id);
          }
          e.doc.updateRoot({ guides });
        });
      },
    },
    {
      id: 'view.releaseGuides',
      label: 'Release Guides',
      shortcut: 'Alt+Mod+5',
      enabled: (a) => Boolean(a.editor?.doc.root.guides?.length),
      run: () => {
        // Guides become ordinary lines spanning the artboard area.
        const e = ed();
        const guides = e.doc.root.guides || [];
        const boards = e.doc.artboards;
        const minX = Math.min(...boards.map((b) => b.x)) - 200;
        const maxX = Math.max(...boards.map((b) => b.x + b.w)) + 200;
        const minY = Math.min(...boards.map((b) => b.y)) - 200;
        const maxY = Math.max(...boards.map((b) => b.y + b.h)) + 200;
        const ids = [];
        e.doc.transact('Release Guides', () => {
          for (const g of guides) {
            const pts = g.axis === 'x' ? [[g.pos, minY], [g.pos, maxY]] : [[minX, g.pos], [maxX, g.pos]];
            const node = createPath(pts.map(([x, y]) => ({ x, y, ix: x, iy: y, ox: x, oy: y })), false, { fill: null, stroke: { type: 'solid', color: '#000000' }, strokeWidth: 1 });
            e.doc.insert(node, e.targetLayer().id);
            ids.push(node.id);
          }
          e.doc.updateRoot({ guides: [] });
        });
        e.select(ids);
      },
    },
    { id: 'object.lockOthers', label: 'Lock Others', shortcut: 'Alt+Shift+Mod+2', enabled: hasSel, run: () => O.lockOrHideOthers(ed(), 'locked') },
    { id: 'object.hideOthers', label: 'Hide Others', shortcut: 'Alt+Shift+Mod+3', enabled: hasSel, run: () => O.lockOrHideOthers(ed(), 'hidden') },
    {
      id: 'path.averageJoin',
      label: 'Average & Join',
      shortcut: 'Alt+Shift+Mod+J',
      enabled: hasSel,
      // One undo step: the nested transactions join this one.
      run: () =>
        ed().doc.transact('Average & Join', () => {
          O.average(ed(), 'both');
          O.join(ed());
        }),
    },
    {
      id: 'view.switchUnits',
      label: 'Switch Units',
      shortcut: 'Alt+Shift+Mod+U',
      enabled: hasDoc,
      run: (a) => {
        const order = ['pt', 'px', 'in', 'mm', 'cm', 'pc'];
        const cur = ed().doc.root.units || 'pt';
        const next = order[(order.indexOf(cur) + 1) % order.length];
        ed().doc.transact('Change Units', () => ed().doc.updateRoot({ units: next }));
        a.notify(`Units: ${next}`, { polite: true });
      },
    },
    {
      id: 'layer.new',
      label: 'New Layer',
      shortcut: 'Mod+L',
      enabled: hasDoc,
      run: () => {
        const e = ed();
        const idx = e.doc.root.children.indexOf(e.doc.layerOf(e.activeLayerId)?.id);
        e.doc.transact('New Layer', () => {
          const layer = e.doc.addLayer(undefined, idx + 1);
          e.activeLayerId = layer.id;
        });
        e.emit('active-layer');
      },
    },
    {
      id: 'layer.newWithOptions',
      label: 'New Layer...',
      shortcut: 'Alt+Mod+L',
      enabled: hasDoc,
      run: async (a) => {
        const e = ed();
        const v = await a.dialogs.form({
          title: 'Layer Options',
          fields: [
            { key: 'name', label: 'Name', type: 'text', value: `Layer ${e.doc.layers().length + 1}` },
            { key: 'color', label: 'Color', type: 'color', value: '#4f80ff' },
            { key: 'locked', label: 'Lock', type: 'checkbox', value: false },
            { key: 'hidden', label: 'Hide', type: 'checkbox', value: false },
            { key: 'template', label: 'Template', type: 'checkbox', value: false },
          ],
        });
        if (!v) return;
        const idx = e.doc.root.children.indexOf(e.doc.layerOf(e.activeLayerId)?.id);
        e.doc.transact('New Layer', () => {
          const layer = e.doc.addLayer(v.name || undefined, idx + 1);
          e.doc.update(layer.id, { color: v.color, locked: v.locked, hidden: v.hidden, template: v.template });
          e.activeLayerId = layer.id;
        });
        e.emit('active-layer');
      },
    },
    { id: 'window.nextDocument', label: 'Next Document', shortcut: 'Mod+`', enabled: (a) => a.editors.length > 1, run: (a) => a.activate(a.editors[(a.editors.indexOf(a.editor) + 1) % a.editors.length]) },
    { id: 'window.previousDocument', label: 'Previous Document', shortcut: 'Shift+Mod+`', enabled: (a) => a.editors.length > 1, run: (a) => a.activate(a.editors[(a.editors.indexOf(a.editor) - 1 + a.editors.length) % a.editors.length]) },
    { id: 'view.clearGuides', label: 'Clear Guides', enabled: (a) => Boolean(a.editor?.doc.root.guides?.length), run: () => ed().doc.transact('Clear Guides', () => ed().doc.updateRoot({ guides: [] })) },
  ]);

  function viewToggle(id, label, key, shortcut) {
    return {
      id,
      label,
      shortcut,
      enabled: hasDoc,
      checked: (a) => Boolean(a.editor?.viewOptions[key]),
      run: () => ed().setViewOption(key, !ed().viewOptions[key]),
    };
  }
}

function flip(editor, axis) {
  const b = selectionBounds(editor.doc, editor.topSelection());
  if (!b) return;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  applyTransform(editor, axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical', axis === 'h' ? reflectAcross(cx, cy, 90) : reflectAcross(cx, cy, 0));
}

function rotateBy(editor, deg) {
  const b = selectionBounds(editor.doc, editor.topSelection());
  if (!b) return;
  applyTransform(editor, 'Rotate', rotate(deg, b.x + b.w / 2, b.y + b.h / 2));
}

