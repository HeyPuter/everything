/**
 * Perspective drawing:
 *
 *  - a one-, two- or three-point perspective grid per document (stored in
 *    the file) drawn over the artwork, with on-canvas controls, the plane
 *    widget and View > Perspective Grid
 *  - Define Grid and Grid Presets dialogs (Edit > Perspective Grid Presets)
 *  - objects in perspective: live groups whose flat artwork is projected
 *    through a grid plane; the shape tools draw straight onto the active
 *    plane while the grid shows
 *  - the Perspective Grid (Shift+P) and Perspective Selection (Shift+V) tools
 *  - Object > Perspective: Attach to Active Plane, Release with Perspective,
 *    Move Plane to Match Object, Edit Text
 */
import './styles.css';
import { registerIcons } from '../../ui/icons.js';
import { overlayHooks } from '../../render/overlay.js';
import { drawingPlanes } from '../../tools/shapes.js';
import { toFlat, localScale, TYPE_LABELS } from './grid-math.js';
import { gridOf, ensureGrid, setGrid, frameFor, planeOffset, isPerspective, createPerspectiveGroup, perspectiveOwner } from './model.js';
import { setOutlineLoader, onOutlinesReady } from './project.js';
import { pstate, setPState, activePlane } from './state.js';
import { drawGrid, drawObjectOutlines } from './render.js';
import { PerspectiveGridTool, PerspectiveSelectionTool } from './tools.js';
import { attachToPlane, releaseWithPerspective, movePlaneToMatch, perspectiveTexts, splitPerspective } from './ops.js';
import { defineGridDialog, presetsDialog, saveGridPresetDialog, applyPreset, planePositionDialog, editTextDialog } from './dialogs.js';
import { allPresets, defaultPresetOf } from './presets.js';
import { createPlaneWidget } from './widget.js';
import { outlineNodes } from '../type/outlines.js';

const S = { 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
const P = (d, extra = {}) => ['path', { d, ...S, ...extra }];

registerIcons({
  // Two walls meeting at a corner, with their grid lines receding.
  'tool-perspective-grid': [P('M12 4v16M12 4 3 7.5v9L12 20M12 4l9 3.5v9L12 20'), P('M7.5 5.8v12.4M16.5 5.8v12.4M3 12l9 1.5 9-1.5', { 'stroke-width': '1.25' })],
  // A pointer over a receding plane.
  'tool-perspective-select': [P('M2.5 9.5 12 6l9.5 3.5-2 9.5H4.5z', { 'stroke-width': '1.25' }), ['path', { d: 'M9 8.5l8.5 3.6-3.6 1.1-1.6 3.6z', fill: 'currentColor', ...S }]],
  'perspective-plane': [P('M3 18 8 6h8l5 12z'), P('M12 6v12M5.5 12h13', { 'stroke-width': '1.25' })],
});

const hasDoc = (a) => Boolean(a.editor);
const sel = (a) => (a.editor ? a.editor.topSelection().map((id) => a.editor.doc.get(id)).filter(Boolean) : []);
const selPersp = (a) => sel(a).filter(isPerspective);

/** The perspective object that holds the selection's type (for Edit Text). */
function textOwner(a) {
  const ed = a.editor;
  if (!ed) return null;
  for (const id of ed.topSelection()) {
    const owner = perspectiveOwner(ed.doc, id);
    if (owner && perspectiveTexts(ed.doc, owner.id).length) return owner;
  }
  return null;
}

function setType(app, type) {
  const ed = app.editor;
  if (!ed) return;
  const g = gridOf(ed.doc);
  if (g.type === type && pstate(ed).visible) return;
  if (g.type !== type) applyPreset(app, defaultPresetOf(type));
  else setPState(ed, { visible: true });
}

function registerCommands(app) {
  const ed = () => app.editor;
  const toggle = (key) => (a) => setPState(a.editor, { [key]: !pstate(a.editor)[key] });
  app.commands.register([
    {
      id: 'perspective.show',
      label: (a) => (a.editor && pstate(a.editor).visible ? 'Hide Grid' : 'Show Grid'),
      shortcut: 'Shift+Mod+I',
      enabled: hasDoc,
      run: (a) => {
        const show = !pstate(a.editor).visible;
        setPState(a.editor, { visible: show });
        a.notify(show ? 'Perspective grid shown' : 'Perspective grid hidden', { polite: true });
      },
    },
    { id: 'perspective.rulers', label: (a) => (a.editor && pstate(a.editor).rulers ? 'Hide Rulers' : 'Show Rulers'), enabled: hasDoc, run: toggle('rulers') },
    { id: 'perspective.snap', label: 'Snap to Grid', enabled: hasDoc, checked: (a) => Boolean(a.editor && pstate(a.editor).snap), run: toggle('snap') },
    { id: 'perspective.lock', label: 'Lock Grid', enabled: hasDoc, checked: (a) => Boolean(a.editor && pstate(a.editor).lock), run: toggle('lock') },
    {
      id: 'perspective.lockStation',
      label: 'Lock Station Point',
      enabled: (a) => Boolean(a.editor) && gridOf(a.editor.doc).type !== 'one',
      checked: (a) => Boolean(a.editor && pstate(a.editor).lockStation),
      run: toggle('lockStation'),
    },
    { id: 'perspective.define', label: 'Define Grid...', enabled: hasDoc, run: (a) => defineGridDialog(a) },
    ...['one', 'two', 'three'].map((type) => ({
      id: `perspective.${type}`,
      label: TYPE_LABELS[type],
      enabled: hasDoc,
      checked: (a) => Boolean(a.editor) && gridOf(a.editor.doc).type === type,
      run: (a) => setType(a, type),
    })),
    { id: 'perspective.savePreset', label: 'Save Grid as Preset...', enabled: hasDoc, run: (a) => saveGridPresetDialog(a) },
    { id: 'edit.perspectivePresets', label: 'Perspective Grid Presets...', run: (a) => presetsDialog(a) },
    { id: 'perspective.planePosition', label: 'Plane Position...', enabled: hasDoc, run: (a, args) => planePositionDialog(a, args?.plane || activePlane(a.editor) || 'left') },
    {
      id: 'perspective.attach',
      label: 'Attach to Active Plane',
      enabled: (a) => Boolean(a.editor && activePlane(a.editor)) && sel(a).length > 0,
      run: (a) => {
        const e = ed();
        let ids = [];
        e.doc.transact('Attach to Active Plane', () => {
          ids = attachToPlane(e.doc, e.topSelection(), activePlane(e));
        });
        e.select(ids);
      },
    },
    {
      id: 'perspective.release',
      label: 'Release with Perspective',
      enabled: (a) => selPersp(a).length > 0,
      run: (a) => {
        const e = ed();
        const keep = sel(a).filter((n) => !isPerspective(n)).map((n) => n.id);
        let ids = [];
        e.doc.transact('Release with Perspective', () => {
          ids = releaseWithPerspective(
            e.doc,
            selPersp(a).map((n) => n.id),
          );
        });
        e.select([...keep, ...ids]);
      },
    },
    {
      id: 'perspective.movePlane',
      label: 'Move Plane to Match Object',
      enabled: (a) => selPersp(a).length === 1,
      run: (a) => {
        const e = ed();
        let plane = null;
        e.doc.transact('Move Plane to Match Object', () => {
          plane = movePlaneToMatch(e.doc, selPersp(a)[0].id);
        });
        if (plane) setPState(e, { visible: true, plane });
      },
    },
    {
      id: 'perspective.editText',
      label: 'Edit Text',
      enabled: (a) => Boolean(textOwner(a)),
      run: (a) => editTextDialog(a, textOwner(a).id),
    },
  ]);
  app.menuSources.set('perspectivePresets', (a) =>
    allPresets(a.prefs).map((p) => ({
      label: p.name,
      enabled: Boolean(a.editor),
      checked: Boolean(a.editor) && gridOf(a.editor.doc).name === p.name,
      run: () => applyPreset(a, p),
    })),
  );
}

/**
 * Ungroup splits objects in perspective into one object per piece of
 * artwork on the same plane (moving the flat contents out would drop them
 * off the plane); other groups ungroup as usual.
 */
function wrapUngroup(app) {
  const base = app.commands.get('object.ungroup');
  if (!base) return;
  app.commands.register({
    ...base,
    enabled: (a) => (base.enabled ? base.enabled(a) : true),
    run: (a, args) => {
      const e = a.editor;
      const persp = e ? e.topSelection().filter((id) => isPerspective(e.doc.get(id))) : [];
      if (!persp.length) return base.run(a, args);
      const doc = e.doc;
      const out = [];
      doc.transact('Ungroup', () => {
        out.push(...splitPerspective(doc, persp));
        for (const id of e.topSelection()) {
          const g = doc.get(id);
          if (!g || g.type !== 'group' || isPerspective(g) || persp.includes(id)) continue;
          const parent = doc.get(g.parent);
          let index = parent.children.indexOf(id);
          for (const c of g.children.slice()) {
            doc.move(c, parent.id, index++);
            out.push(c);
          }
          doc.remove(id);
        }
      });
      e.select(out.filter((id) => doc.has(id)));
    },
  });
}

/** The active plane as a drawing plane for the shape tools (see tools/shapes.js). */
function drawingPlaneFor(editor) {
  const plane = activePlane(editor);
  if (!plane) return null;
  const doc = editor.doc;
  const g = gridOf(doc);
  const offset = planeOffset(g, plane);
  const frame = frameFor(g, plane, offset);
  const st = pstate(editor);
  return {
    toPlane(x, y) {
      const p = toFlat(frame, x, y);
      if (!p || !st.snap || !(g.cell > 0)) return p;
      // Snap to grid lines within a few pixels.
      const t = 6 / editor.view.zoom / Math.max(1e-6, localScale(frame, p.x, p.y));
      const sx = Math.round((p.x - g.ox) / g.cell) * g.cell + g.ox;
      const sy = Math.round((p.y - g.oy) / g.cell) * g.cell + g.oy;
      return { x: Math.abs(sx - p.x) < t ? sx : p.x, y: Math.abs(sy - p.y) < t ? sy : p.y };
    },
    insert(d, node, parentId, descendants = [], index = Infinity) {
      ensureGrid(d);
      const group = createPerspectiveGroup(g, plane, offset, [node.id]);
      d.insert(group, parentId, index, [{ ...node, parent: group.id }, ...descendants]);
      return group.id;
    },
  };
}

export function install(app) {
  app.registerTool(PerspectiveGridTool);
  app.registerTool(PerspectiveSelectionTool);
  registerCommands(app);
  wrapUngroup(app);
  overlayHooks.add((ctx, editor) => {
    drawGrid(ctx, editor);
    drawObjectOutlines(ctx, editor);
  });
  drawingPlanes.add((editor) => drawingPlaneFor(editor));
  setOutlineLoader((text) => outlineNodes(text));
  onOutlinesReady(() => {
    for (const v of app.views.values()) v.invalidate();
  });
  app.on('started', () => {
    const widget = createPlaneWidget(app);
    app.canvasWrap.append(widget.el);
    app.perspectiveWidget = widget;
    widget.refresh();
  });
}

export { gridOf, setGrid };
