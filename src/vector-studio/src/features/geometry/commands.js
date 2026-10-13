/** Commands for Pathfinder and Object > Path / Shape / Expand. */
import { ALL_KINDS, canRun, runPathfinder, pathfinderOptions, operands } from './pathfinder.js';
import { trapCommand, makeCompoundShape, releaseCompoundShapes, expandCompoundShapes, selectedCompoundShapes } from './pathfinder-extras.js';
import { installMixEffects } from './mix-effects.js';
import {
  outlineStroke,
  offsetPathDialog,
  simplifyDialog,
  addAnchorPoints,
  removeAnchorPoints,
  divideBelow,
  splitGridDialog,
  cleanUpDialog,
  expandDialog,
  expandShapes,
  convertToShapes,
} from './path-ops.js';
import { isLive, expandLive } from '../../model/live.js';
import { isGradient } from '../../model/gradients.js';
import { expandAppearance, hasExpandableAppearance } from '../../ops/expand-appearance.js';
import { hasStackStroke } from '../../model/appearance.js';

const PATHFINDER_DEFAULTS = Object.freeze({ ...pathfinderOptions });
const leaves = (app) => (app.editor ? operands(app.editor) : []);
const selectedLive = (app) => (app.editor ? app.editor.selectedNodes().filter((n) => isLive(n)) : []);
const hasPaths = (app) => leaves(app).length > 0;

export function registerGeometryCommands(app) {
  const c = app.commands;
  Object.assign(pathfinderOptions, app.prefs.get('pathfinderOptions') || {});
  installMixEffects(app);
  c.register(
    ALL_KINDS.map((def) => ({
      id: `pathfinder.${def.kind}`,
      label: def.label,
      enabled: (a) => canRun(a.editor, def.kind),
      run: (a) => runPathfinder(a, def.kind),
    })),
  );
  c.register([
    {
      id: 'path.repeatPathfinder',
      label: (a) => {
        const def = ALL_KINDS.find((k) => k.kind === a.lastPathfinder);
        return def ? `Repeat ${def.label}` : 'Repeat Pathfinder';
      },
      shortcut: 'Mod+4',
      enabled: (a) => Boolean(a.lastPathfinder) && canRun(a.editor, a.lastPathfinder),
      run: (a) => runPathfinder(a, a.lastPathfinder),
    },
    {
      id: 'pathfinder.options',
      label: 'Pathfinder Options...',
      enabled: () => true,
      run: async (a) => {
        const v = await a.dialogs.form({
          title: 'Pathfinder Options',
          fields: [
            { key: 'precision', label: 'Precision', type: 'length', value: pathfinderOptions.precision, min: 0.001, max: 100, step: 0.001 },
            { key: 'removeRedundant', label: 'Remove Redundant Points', type: 'checkbox', value: pathfinderOptions.removeRedundant },
            { key: 'removeUnpainted', label: 'Divide and Outline Will Remove Unpainted Artwork', type: 'checkbox', value: pathfinderOptions.removeUnpainted },
          ],
          extraButtons: [{ label: 'Defaults', action: 'defaults' }],
        });
        if (!v) return;
        Object.assign(pathfinderOptions, v.__action === 'defaults' ? PATHFINDER_DEFAULTS : { precision: v.precision, removeRedundant: v.removeRedundant, removeUnpainted: v.removeUnpainted });
        a.prefs.set('pathfinderOptions', { ...pathfinderOptions });
      },
    },
    {
      id: 'pathfinder.trap',
      label: 'Trap...',
      enabled: (a) => leaves(a).filter((n) => n.fill).length >= 2,
      run: (a) => trapCommand(a),
    },
    {
      id: 'pathfinder.makeCompoundShape',
      label: 'Make Compound Shape',
      enabled: (a) => Boolean(a.editor && (a.editor.topSelection().length >= 2 || selectedCompoundShapes(a.editor).length)),
      run: (a, args) => makeCompoundShape(a.editor, args?.kind || 'unite'),
    },
    {
      id: 'pathfinder.releaseCompoundShape',
      label: 'Release Compound Shape',
      enabled: (a) => selectedCompoundShapes(a.editor).length > 0,
      run: (a) => releaseCompoundShapes(a.editor),
    },
    {
      id: 'pathfinder.expandCompoundShape',
      label: 'Expand Compound Shape',
      enabled: (a) => selectedCompoundShapes(a.editor).length > 0,
      run: (a) => expandCompoundShapes(a.editor),
    },
    { id: 'path.outlineStroke', label: 'Outline Stroke', enabled: (a) => leaves(a).some((n) => (n.stroke && n.strokeWidth > 0) || hasStackStroke(n)) || Boolean(a.editor?.selectedNodes().some(hasStackStroke)), run: (a) => outlineStroke(a) },
    { id: 'path.offset', label: 'Offset Path...', enabled: hasPaths, run: (a) => offsetPathDialog(a) },
    { id: 'path.simplify', label: 'Simplify...', enabled: (a) => leaves(a).some((n) => n.type === 'compound' || n.anchors.length > 2), run: (a) => simplifyDialog(a) },
    { id: 'path.addAnchors', label: 'Add Anchor Points', enabled: hasPaths, run: (a) => addAnchorPoints(a.editor) },
    {
      id: 'path.removeAnchors',
      label: 'Remove Anchor Points',
      enabled: (a) => Boolean(a.editor) && [...a.editor.anchors.values()].some((s) => s.size > 0),
      run: (a) => removeAnchorPoints(a),
    },
    { id: 'path.divideBelow', label: 'Divide Objects Below', enabled: (a) => leaves(a).length === 1, run: (a) => divideBelow(a) },
    { id: 'path.splitGrid', label: 'Split Into Grid...', enabled: hasPaths, run: (a) => splitGridDialog(a) },
    { id: 'path.cleanUp', label: 'Clean Up...', enabled: (a) => Boolean(a.editor), run: (a) => cleanUpDialog(a) },
    {
      id: 'object.expand',
      label: 'Expand...',
      enabled: (a) => Boolean(a.editor) && (selectedLive(a).length > 0 || leaves(a).some((n) => n.shape || (n.stroke && n.strokeWidth > 0) || isGradient(n.fill)) || a.editor.selectedNodes().some((n) => n.type === 'text')),
      run: (a) => {
        // Live objects (repeats, symbol instances, blends, ...) expand to their artwork directly.
        const live = selectedLive(a);
        if (live.length) {
          const doc = a.editor.doc;
          const out = [];
          doc.transact('Expand', () => live.forEach((n) => out.push(expandLive(doc, n.id)?.id)));
          a.editor.select(out.filter(Boolean));
          return true;
        }
        return expandDialog(a);
      },
    },
    {
      id: 'object.expandAppearance',
      label: 'Expand Appearance',
      enabled: (a) => Boolean(a.editor) && a.editor.topSelection().some((id) => hasExpandableAppearance(a.editor.doc, a.editor.doc.get(id))),
      run: (a) => expandAppearance(a.editor),
    },
    { id: 'shape.expand', label: 'Expand Shape', enabled: (a) => leaves(a).some((n) => n.type === 'path' && n.shape), run: (a) => expandShapes(a.editor) },
    { id: 'shape.convert', label: 'Convert to Shapes', enabled: (a) => leaves(a).some((n) => n.type === 'path' && !n.shape), run: (a) => convertToShapes(a) },
  ]);
}
