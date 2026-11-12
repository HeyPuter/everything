import type { Editor } from '../../editor';
import { registerCommand, type Command } from '../../app/registry';
import { allLayers, findLayer, type Layer } from '../../model/document';
import { identityVectorMatrix, type VectorMask } from '../../model/vector';
import { canvasRect } from '../../model/selection';
import { formDialog } from '../../ui/dialog';
import { layerLock } from '../../model/locks';
import type { VectorStroke } from '../../model/vector-stroke';
import { vectorHexColor } from '../../color/vector';
import { commitTarget, hexRgb, pixelTarget } from '../pixels';
import { commitSelectionMask, featherMask } from '../selection';
import { cloneMask, commandsToPaths, componentGroups, parseSvgPath, transformMask, type Cmd } from './geometry';
import { maskCoverage, paintCoverage, selectionToPath, strokeWithBrush } from './raster';
import { activeKey, clearSelection, nextPathName, setActive, setShapeMask, shapeDocMask, targetLocked, targetPath, vstate, type PathTarget } from './state';
import { addVectorMask, canAddVectorMask, commitPathEdit, currentPathForMask, deleteVectorMask, rasterizeVectorMask, toggleVectorMask } from './masks';
import { savePathDialog } from './panel';
import { saveUserShape, shapeFromMask } from './custom-shapes';
import { documentPpi, textMatrix } from '../../model/text-layer';

/** The path that Paths-panel actions apply to: the target, else the work path. */
export function actionPath(e: Editor): PathTarget | undefined {
  const t = targetPath(e);
  if (t) return t;
  const w = e.doc.workPath;
  return w ? { kind: 'work', id: 'work', name: 'Work Path', mask: w } : undefined;
}
const hasPath = (e: Editor) => !!actionPath(e)?.mask.paths.length;
// Painting a shape layer's own path onto pixels would rasterize the shape first.
const paintablePath = (e: Editor) => hasPath(e) && actionPath(e)!.kind !== 'shape';

const sources: [string, string][] = [['foreground', 'Foreground Color'], ['background', 'Background Color'], ['black', 'Black'], ['gray', '50% Gray'], ['white', 'White']];
function sourceRgb(e: Editor, source: string): [number, number, number] {
  if (source === 'background') return hexRgb(e.background);
  if (source === 'black') return [0, 0, 0];
  if (source === 'white') return [255, 255, 255];
  if (source === 'gray') return [128, 128, 128];
  return hexRgb(e.color);
}
/** Combine-first copy of a path for rasterizing it as an area. */
function areaMask(mask: VectorMask): VectorMask {
  const m = cloneMask(mask);
  if (m.paths[0]?.operation && m.paths[0].operation !== 'combine') m.paths[0].operation = 'combine';
  return m;
}
export async function fillPath(e: Editor, source = 'foreground', opacity = 1, feather = 0) {
  const t = actionPath(e);
  if (!t?.mask.paths.length) return;
  const target = await pixelTarget(e);
  if (!target) return;
  let cov = await maskCoverage(e, areaMask(t.mask));
  if (feather > 0) cov = featherMask(cov, feather);
  commitTarget(e, target, paintCoverage(e, target, cov, sourceRgb(e, source), opacity), 'Fill Path');
}
export async function strokePath(e: Editor, tool: 'brush' | 'pencil' | 'eraser' = 'brush', pressure = false) {
  const t = actionPath(e);
  if (!t?.mask.paths.length) return;
  const target = await pixelTarget(e);
  if (!target) return;
  commitTarget(e, target, strokeWithBrush(e, target, t.mask, tool, pressure), 'Stroke Path');
}
export async function pathToSelection(e: Editor, op: 'replace' | 'add' | 'subtract' | 'intersect' = 'replace', feather = 0, antiAlias = true) {
  const t = actionPath(e);
  if (!t?.mask.paths.length) return;
  let cov = await maskCoverage(e, areaMask(t.mask));
  if (!antiAlias) for (let i = 0; i < cov.data.length; i++) cov.data[i] = cov.data[i] >= 128 ? 255 : 0;
  if (feather > 0) cov = featherMask(cov, feather);
  commitSelectionMask(e, cov, op, 'Make Selection');
}
export function selectionToWorkPath(e: Editor, tolerance = 2) {
  const mask = selectionToPath(e, tolerance);
  if (!mask) {
    e.message('The selection is empty.');
    return;
  }
  e.command('Make Work Path', (d) => {
    d.workPath = mask;
  });
  setActive(e, 'work');
  e.update();
}
/** Merge selected (or all) components into one outline through the geometry engine. */
export async function mergeComponents(e: Editor) {
  const t = targetPath(e);
  if (!t || !t.mask.paths.length || targetLocked(e, t)) return;
  const st = vstate(e);
  const groups = componentGroups(t.mask);
  const chosen = st.paths.size && st.selectionKey === activeKey(t) ? groups.filter((g) => g.some((i) => st.paths.has(i))) : groups;
  if (chosen.length < 1) return;
  const idx = chosen.flat().sort((a, b) => a - b);
  const sub: VectorMask = { paths: idx.map((i) => structuredClone(t.mask.paths[i])) };
  sub.paths[0].operation = 'combine';
  const r = await e.engine.vectorMask(sub, canvasRect(e.doc));
  const merged = commandsToPaths(parseSvgPath(r.path), r.fillRule === 'evenodd' ? 'even-odd' : 'non-zero', 'combine', true);
  const first = t.mask.paths[idx[0]].operation ?? 'combine';
  if (merged[0]) merged[0].operation = first;
  const drop = new Set(idx);
  const paths = [...t.mask.paths.slice(0, idx[0]).filter((_, i) => !drop.has(i)), ...merged, ...t.mask.paths.slice(idx[0]).filter((_, i) => !drop.has(i + idx[0]))];
  await commitPathEdit(e, t, { ...t.mask, paths }, 'Merge Shape Components');
  clearSelection(e);
  e.update();
}
export function combineShapes(e: Editor) {
  const ids = new Set(e.selectedLayers.filter((l) => l.kind === 'vector').map((l) => l.id));
  const ordered = allLayers(e.doc.layers).filter((l) => ids.has(l.id));
  if (ordered.length < 2) return;
  if (ordered.some((l) => layerLock(e.doc.layers, l.id, 'all'))) {
    e.message('Unlock the shape layers to combine them.');
    return;
  }
  const top = ordered[ordered.length - 1];
  const paths = ordered.flatMap((l, i) => {
    const m = shapeDocMask(l).paths;
    if (i > 0 && m[0] && !m[0].operation) m[0].operation = 'combine';
    return m;
  });
  e.command('Combine Shapes', (d) => {
    const keep = findLayer(d.layers, top.id)!;
    setShapeMask(keep, { paths });
    const drop = new Set(ordered.slice(0, -1).map((l) => l.id));
    const prune = (layers: Layer[]): Layer[] => layers.filter((l) => !drop.has(l.id)).map((l) => ((l.children = prune(l.children)), l));
    d.layers = prune(d.layers);
  });
  e.selectLayers([top.id]);
  e.update();
}
async function strokeSelection(e: Editor) {
  const v = await formDialog('Stroke', [
    { name: 'width', label: 'Width (px)', value: 2, type: 'number', min: 1, max: 250 },
    { name: 'color', label: 'Color', value: e.color, type: 'color' },
    { name: 'location', label: 'Location', value: 'center', type: 'select', options: [['inside', 'Inside'], ['center', 'Center'], ['outside', 'Outside']] },
    { name: 'opacity', label: 'Opacity (%)', value: 100, type: 'number', min: 1, max: 100 },
  ], 'OK');
  if (!v) return;
  const mask = selectionToPath(e, 0.6);
  if (!mask) return;
  // Outline contours form one non-zero component, so holes stay holes.
  const target = await pixelTarget(e);
  if (!target) return;
  const stroke: VectorStroke = {
    enabled: true,
    fillEnabled: false,
    lineWidth: { value: Math.max(1, Number(v.width) || 1), units: 'Pixels' },
    lineDashOffset: { value: 0, units: 'Pixels' },
    resolution: 72,
    cap: 'butt',
    join: 'miter',
    alignment: v.location as VectorStroke['alignment'],
    miterLimit: 4,
    opacity: 1,
    color: vectorHexColor(v.color),
  };
  const rect = canvasRect(e.doc);
  const r = await e.engine.vectorStroke(mask, rect, identityVectorMatrix, stroke);
  const cov = { width: rect.width, height: rect.height, data: new Uint8Array(r.strokeCoverage.length) };
  for (let i = 0; i < cov.data.length; i++) cov.data[i] = Math.round(Math.max(0, Math.min(1, r.strokeCoverage[i])) * 255);
  commitTarget(e, target, paintCoverage(e, target, cov, hexRgb(v.color), Math.max(0.01, Math.min(1, Number(v.opacity) / 100))), 'Stroke');
}
async function textWorkPath(e: Editor) {
  const l = e.layer;
  if (l?.kind !== 'text') return;
  const text = await import('../../imaging/text');
  // Prefer rich text data when the layer carries it; otherwise lay out its plain text.
  const rich = (l as Layer & { textData?: import('../../imaging/text').TextLayerData }).textData;
  const [r, g, b] = hexRgb(/^#[0-9a-f]{6}$/i.test(l.color) ? l.color : '#000000');
  // Plain text layers draw at weight 600 from the top of the em box in layer
  // space; their outlines are laid out the same way, then placed by the layer transform.
  const data = rich ?? text.textLayer(l.text, { size: l.fontSize, weight: 600, color: [r, g, b] }, { origin: { x: 0, y: l.fontSize * 0.8 } });
  const out = await text.textToPathAsync(data, { resolution: rich ? documentPpi(e.doc) : 72 });
  const cmds = out.contours.flat() as Cmd[];
  const paths = commandsToPaths(cmds, 'non-zero', 'combine', true);
  if (rich) {
    // Rich text is laid out in its own local space, placed by the text matrix.
    const [a, b, c, d, tx, ty] = textMatrix(l);
    transformMask({ paths }, a, b, c, d, tx, ty);
  } else {
    const t = l.transform, a = (t.rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const sx = t.width / l.sourceWidth, sy = t.height / l.sourceHeight, cx = t.x + t.width / 2, cy = t.y + t.height / 2;
    transformMask({ paths }, cos * sx, sin * sx, -sin * sy, cos * sy, cx - cos * t.width / 2 + sin * t.height / 2, cy - sin * t.width / 2 - cos * t.height / 2);
  }
  if (!paths.length) {
    e.message('This text has no outlines.');
    return;
  }
  e.command('Create Work Path', (d) => {
    d.workPath = { paths };
  });
  setActive(e, 'work');
  e.update();
  if (out.missingFonts.length) e.message(`Outlines used the default font for: ${out.missingFonts.join(', ')}.`);
}

export function installVectorCommands() {
  const cmd = (c: Command) => registerCommand(c);
  cmd({ id: 'path.fill', label: 'Fill Path with Foreground Color', enabled: paintablePath, run: (e) => fillPath(e) });
  cmd({
    id: 'path.fill-dialog',
    label: 'Fill Path…',
    enabled: paintablePath,
    run: async (e) => {
      const v = await formDialog('Fill Path', [
        { name: 'source', label: 'Contents', value: 'foreground', type: 'select', options: sources },
        { name: 'opacity', label: 'Opacity (%)', value: 100, type: 'number', min: 1, max: 100 },
        { name: 'feather', label: 'Feather Radius (px)', value: 0, type: 'number', min: 0, max: 250 },
      ], 'OK');
      if (v) await fillPath(e, v.source, Number(v.opacity) / 100, Number(v.feather) || 0);
    },
  });
  cmd({ id: 'path.stroke', label: 'Stroke Path with Brush', enabled: paintablePath, run: (e) => strokePath(e) });
  cmd({
    id: 'path.stroke-dialog',
    label: 'Stroke Path…',
    enabled: paintablePath,
    run: async (e) => {
      const v = await formDialog('Stroke Path', [
        { name: 'tool', label: 'Tool', value: 'brush', type: 'select', options: [['brush', 'Brush'], ['pencil', 'Pencil'], ['eraser', 'Eraser']] },
        { name: 'pressure', label: 'Simulate Pressure', value: 'no', type: 'checkbox' },
      ], 'OK', 'Uses the tool’s current size, hardness and opacity.');
      if (v) await strokePath(e, v.tool as 'brush', v.pressure === 'yes');
    },
  });
  cmd({ id: 'path.make-selection', label: 'Load Path as Selection', enabled: hasPath, shortcut: 'Mod+Enter', run: (e) => pathToSelection(e) });
  cmd({
    id: 'path.make-selection-dialog',
    label: 'Make Selection…',
    enabled: hasPath,
    run: async (e) => {
      const v = await formDialog('Make Selection', [
        { name: 'feather', label: 'Feather Radius (px)', value: 0, type: 'number', min: 0, max: 250 },
        { name: 'aa', label: 'Anti-aliased', value: 'yes', type: 'checkbox' },
        { name: 'op', label: 'Operation', value: e.doc.selection ? 'add' : 'replace', type: 'select', options: [['replace', 'New Selection'], ['add', 'Add to Selection'], ['subtract', 'Subtract from Selection'], ['intersect', 'Intersect with Selection']] },
      ], 'OK');
      if (v) await pathToSelection(e, v.op as 'replace', Number(v.feather) || 0, v.aa === 'yes');
    },
  });
  cmd({ id: 'path.from-selection', label: 'Make Work Path from Selection', enabled: (e) => !!e.doc.selection, run: (e) => selectionToWorkPath(e, 2) });
  cmd({
    id: 'path.from-selection-dialog',
    label: 'Make Work Path…',
    enabled: (e) => !!e.doc.selection,
    run: async (e) => {
      const v = await formDialog('Make Work Path', [{ name: 'tolerance', label: 'Tolerance (px)', value: 2, type: 'number', min: 0.5, max: 10, step: 0.5 }], 'OK');
      if (v) selectionToWorkPath(e, Math.max(0.5, Math.min(10, Number(v.tolerance) || 2)));
    },
  });
  cmd({
    id: 'path.new',
    label: 'New Path',
    enabled: (e) => e.hasDocument,
    run: (e) => {
      const name = nextPathName(e.doc);
      const id = crypto.randomUUID();
      e.command('New Path', (d) => {
        d.paths = [...(d.paths ?? []), { id, name, mask: { paths: [] } }];
      });
      setActive(e, `path:${id}`);
      e.update();
    },
  });
  cmd({ id: 'path.save', label: 'Save Path…', enabled: (e) => actionPath(e)?.kind === 'work', run: (e) => savePathDialog(e, actionPath(e)!) });
  cmd({
    id: 'path.duplicate',
    label: 'Duplicate Path',
    enabled: (e) => hasPath(e),
    run: (e) => {
      const t = actionPath(e)!;
      const id = crypto.randomUUID();
      e.command('Duplicate Path', (d) => {
        d.paths = [...(d.paths ?? []), { id, name: `${t.kind === 'saved' ? t.name : t.name.replace(/ (Shape Path|Vector Mask|Type Path)$/, '')} copy`, mask: structuredClone(t.mask) }];
      });
      setActive(e, `path:${id}`);
      e.update();
    },
  });
  cmd({
    id: 'path.delete',
    label: 'Delete Path',
    enabled: (e) => {
      const t = targetPath(e);
      return !!t && t.kind !== 'shape' && t.kind !== 'text';
    },
    run: (e) => {
      const t = targetPath(e);
      if (!t || t.kind === 'shape' || t.kind === 'text') return;
      if (t.kind === 'vmask') return deleteVectorMask(e);
      e.command('Delete Path', (d) => {
        if (t.kind === 'work') delete d.workPath;
        else {
          d.paths = d.paths!.filter((p) => p.id !== t.id);
          if (!d.paths.length) delete d.paths;
        }
      });
      setActive(e, undefined);
      e.update();
    },
  });
  cmd({ id: 'path.merge-components', label: 'Merge Shape Components', enabled: (e) => (targetPath(e)?.mask.paths.length ?? 0) > 1, run: mergeComponents });

  // ----- Vector masks -----
  cmd({ id: 'layer.vmask-reveal-all', label: 'Reveal All', enabled: (e) => canAddVectorMask(e, e.layer), run: (e) => addVectorMask(e, { paths: [], fillStartsWithAllPixels: true }, 'Add Vector Mask') });
  cmd({ id: 'layer.vmask-hide-all', label: 'Hide All', enabled: (e) => canAddVectorMask(e, e.layer), run: (e) => addVectorMask(e, { paths: [] }, 'Add Vector Mask') });
  cmd({
    id: 'layer.vmask-current-path',
    label: 'Current Path',
    enabled: (e) => canAddVectorMask(e, e.layer) && !!currentPathForMask(e) && targetPath(e)?.kind !== 'shape',
    run: (e) => addVectorMask(e, structuredClone(currentPathForMask(e)!), 'Add Vector Mask'),
  });
  cmd({ id: 'layer.vmask-delete', label: 'Delete', enabled: (e) => !!e.layer?.vectorMask, run: deleteVectorMask });
  cmd({ id: 'layer.vmask-toggle', label: 'Disable', enabled: (e) => !!e.layer?.vectorMask, checked: (e) => !!e.layer?.vectorMask?.disabled, run: toggleVectorMask });
  cmd({ id: 'layer.rasterize-vector-mask', label: 'Vector Mask', enabled: (e) => !!e.layer?.vectorMask, run: rasterizeVectorMask });
  cmd({ id: 'layer.combine-shapes', label: 'Combine Shapes', enabled: (e) => e.selectedLayers.filter((l) => l.kind === 'vector').length > 1, run: combineShapes });

  // ----- View, Edit and Type -----
  cmd({
    id: 'view.show-target-path',
    label: 'Target Path',
    shortcut: 'Mod+Shift+H',
    checked: (e) => !e.settings.hideTargetPath,
    recordable: false,
    run: (e) => {
      e.settings.hideTargetPath = !e.settings.hideTargetPath;
      e.overlay();
    },
  });
  cmd({
    id: 'edit.define-shape',
    label: 'Define Custom Shape…',
    enabled: hasPath,
    recordable: false,
    run: async (e) => {
      const t = actionPath(e);
      const d = t && shapeFromMask(t.mask);
      if (!d) return;
      const v = await formDialog('Shape Name', [{ name: 'name', label: 'Name', value: t!.kind === 'saved' ? t!.name : 'Shape' }], 'OK');
      if (!v) return;
      saveUserShape(v.name || 'Shape', d);
      e.message(`“${v.name || 'Shape'}” is now in the custom shape picker.`);
    },
  });
  cmd({ id: 'edit.stroke', label: 'Stroke…', enabled: (e) => !!e.doc.selection, run: strokeSelection });
  cmd({ id: 'type.create-work-path', label: 'Create Work Path', enabled: (e) => e.layer?.kind === 'text' && !!e.layer.text, run: textWorkPath });
}
