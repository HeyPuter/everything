/**
 * Gradient Mesh: mesh objects (a grid of Coons patches with a color per
 * mesh point), the Mesh tool (U), Object > Create Gradient Mesh, Direct
 * Selection of mesh points and patches, coloring selected points from the
 * paint controls, the Eyedropper picking the color under the pointer on a
 * mesh (into selected mesh points), and SVG / PDF export.
 */
import './mesh-live.js';
import { MeshTool } from './mesh-tool.js';
import { canMesh, convertToMesh, removeLinesThrough } from './mesh-ops.js';
import { drawMeshOverlay, directPointerDown, directMarquee, installMeshPaintHooks, meshPointSelection, meshEyedropperHook } from './mesh-edit.js';
import { installMeshExport } from './mesh-export.js';
import { overlayHooks } from '../../render/overlay.js';
import { directSelectionHooks } from '../../tools/direct-selection.js';
import { eyedropperHooks } from '../../tools/navigation.js';
import { paintHooks } from '../../ops/paint-ops.js';

const DIRECT_HOOK = { pointerDown: directPointerDown, marquee: directMarquee };

const DEFAULTS = { rows: 4, cols: 4, appearance: 'flat', highlight: 100 };

const meshTargets = (ed) => (ed ? ed.selectedNodes().filter((n) => canMesh(n) && !ed.doc.isLocked(n.id)) : []);

/** Object > Create Gradient Mesh: rows, columns, appearance and highlight, with a live preview. */
export async function createMeshDialog(app) {
  const ed = app.editor;
  if (!ed) return false;
  const doc = ed.doc;
  const ids = meshTargets(ed).map((n) => n.id);
  if (!ids.length) {
    app.notify('Select a path to turn into a gradient mesh.');
    return false;
  }
  const last = { ...DEFAULTS, ...(app.prefs.get('meshCreate') || {}) };
  const optsOf = (v) => ({
    rows: Math.max(1, Math.min(50, Math.round(v.rows))),
    cols: Math.max(1, Math.min(50, Math.round(v.cols))),
    appearance: v.appearance,
    highlight: Math.max(0, Math.min(100, v.highlight)) / 100,
  });
  let tx = null;
  const convert = (v) => ids.map((id) => convertToMesh(doc, id, optsOf(v))?.id).filter(Boolean);
  const preview = (v) => {
    if (tx) {
      tx.cancel();
      tx = null;
    }
    if (!v.preview) return;
    tx = doc.begin('Create Gradient Mesh');
    // Selected, so the preview shows its mesh lines.
    ed.select(convert(v));
  };
  let res = null;
  try {
    res = await app.dialogs.form({
      title: 'Create Gradient Mesh',
      fields: [
        { key: 'rows', label: 'Rows', type: 'number', value: last.rows, min: 1, max: 50 },
        { key: 'cols', label: 'Columns', type: 'number', value: last.cols, min: 1, max: 50 },
        {
          key: 'appearance',
          label: 'Appearance',
          type: 'select',
          value: last.appearance,
          options: [
            { value: 'flat', label: 'Flat' },
            { value: 'center', label: 'Highlight to Center' },
            { value: 'edge', label: 'Highlight to Edge' },
          ],
        },
        { key: 'highlight', label: 'Highlight', type: 'percent', value: last.highlight, min: 0, max: 100, help: 'How close the highlight gets to white.' },
        { key: 'preview', label: 'Preview', type: 'checkbox', value: true },
      ],
      previewToggle: true,
      onChange: preview,
    });
  } finally {
    if (tx) {
      tx.cancel();
      tx = null;
    }
  }
  if (!res) return false;
  let out = [];
  doc.transact('Create Gradient Mesh', () => {
    out = convert(res);
  });
  ed.select(out);
  app.prefs.set('meshCreate', { rows: optsOf(res).rows, cols: optsOf(res).cols, appearance: res.appearance, highlight: res.highlight });
  return true;
}

export function install(app) {
  app.registerTool(MeshTool);
  app.commands.register([
    {
      id: 'mesh.create',
      label: 'Create Gradient Mesh...',
      enabled: (a) => meshTargets(a.editor).length > 0,
      run: (a) => createMeshDialog(a),
    },
  ]);
  // Delete with mesh points selected removes their mesh lines, not the mesh.
  const clear = app.commands.get('edit.clear');
  if (clear) {
    app.commands.register({
      ...clear,
      run: (a, args) => {
        const sel = a.editor ? meshPointSelection(a.editor) : new Map();
        if (!sel.size) return clear.run(a, args);
        const doc = a.editor.doc;
        doc.transact('Delete Mesh Point', () => {
          for (const [id, pts] of sel) removeLinesThrough(doc, id, pts);
        });
        a.editor.select([...sel.keys()]);
        return true;
      },
    });
  }
  overlayHooks.add(drawMeshOverlay);
  if (!directSelectionHooks.includes(DIRECT_HOOK)) directSelectionHooks.push(DIRECT_HOOK);
  installMeshPaintHooks(app, paintHooks);
  if (!eyedropperHooks.includes(meshEyedropperHook)) eyedropperHooks.push(meshEyedropperHook);
  installMeshExport();
}
