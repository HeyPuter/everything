// Keyboard-only layer commands: stepping the layer selection through the
// stack, cycling blend modes and setting opacity with the number keys.
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import { blendLabel, blends, findLayer } from '../../model/document';
import { visibleRows } from '../../model/layers';
import { layerLock } from '../../model/locks';
import { shownInLayerList } from '../panels/layers';

/** Select the layer above (-1) or below (+1) the current one, or the top/bottom one; `add` extends the selection. */
function step(e: Editor, to: -1 | 1 | 'top' | 'bottom', add = false) {
  // The rows of the Layers list: layers its filter hides are skipped.
  const rows = visibleRows(e.doc.layers, e.collapsedGroups).filter((l) => shownInLayerList(e, l));
  if (!rows.length) return;
  const at = rows.findIndex((l) => l.id === e.selected);
  const i = to === 'top' ? 0 : to === 'bottom' ? rows.length - 1 : at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + to));
  const id = rows[i].id;
  // The last selected layer is the target.
  e.selectLayers(add ? [...[...e.selectedIds].filter((x) => x !== id), id] : [id]);
  e.update();
}
/** The selected layers that Lock All (theirs or a group's) leaves editable;
 * reports when every one is locked. */
function unlocked<T extends { id: string }>(e: Editor, layers: T[]): T[] {
  const free = layers.filter((l) => !layerLock(e.doc.layers, l.id, 'all'));
  if (layers.length && !free.length) e.message('Unlock this layer to edit it.');
  return free;
}
function cycleBlend(e: Editor, by: 1 | -1) {
  const roots = unlocked(e, e.selectedLayers).filter((l) => l.kind !== 'group' || l.blend !== 'pass through');
  if (!roots.length) return;
  const ids = roots.map((l) => l.id);
  const at = Math.max(0, blends.indexOf(roots[0].blend as (typeof blends)[number]));
  const next = blends[(at + by + blends.length) % blends.length];
  e.command('Blend Mode', (d) => {
    for (const id of ids) {
      const l = findLayer(d.layers, id);
      if (l) l.blend = next;
    }
  }, { coalesce: true });
  e.message(`Blend mode: ${blendLabel(next)}`);
}

export function installLayerKeys(_e: Editor) {
  const hasLayer = (e: Editor) => e.hasDocument && e.doc.layers.length > 0;
  const editable = (e: Editor) => e.hasDocument && e.selectedIds.size > 0;
  registerCommand(
    { id: 'layer.select-forward', label: 'Select Layer Above', shortcut: 'Alt+]', hidden: true, recordable: false, enabled: hasLayer, run: (e) => step(e, -1) },
    { id: 'layer.select-backward', label: 'Select Layer Below', shortcut: 'Alt+[', hidden: true, recordable: false, enabled: hasLayer, run: (e) => step(e, 1) },
    { id: 'layer.select-front', label: 'Select Top Layer', shortcut: 'Alt+.', hidden: true, recordable: false, enabled: hasLayer, run: (e) => step(e, 'top') },
    { id: 'layer.select-back', label: 'Select Bottom Layer', shortcut: 'Alt+,', hidden: true, recordable: false, enabled: hasLayer, run: (e) => step(e, 'bottom') },
    { id: 'layer.add-forward', label: 'Add Layer Above to Selection', shortcut: 'Alt+Shift+]', hidden: true, recordable: false, enabled: hasLayer, run: (e) => step(e, -1, true) },
    { id: 'layer.add-backward', label: 'Add Layer Below to Selection', shortcut: 'Alt+Shift+[', hidden: true, recordable: false, enabled: hasLayer, run: (e) => step(e, 1, true) },
    { id: 'layer.blend-next', label: 'Next Blend Mode', shortcut: 'Shift+=', hidden: true, enabled: editable, run: (e) => cycleBlend(e, 1) },
    { id: 'layer.blend-previous', label: 'Previous Blend Mode', shortcut: 'Shift+-', hidden: true, enabled: editable, run: (e) => cycleBlend(e, -1) },
    {
      id: 'layer.set-opacity',
      label: 'Layer Opacity',
      hidden: true,
      enabled: editable,
      description: 'Number keys set the opacity of the selected layers when no painting tool is active',
      run: (e, arg) => {
        const v = Math.max(0, Math.min(1, Number(arg)));
        if (!Number.isFinite(v)) return;
        const ids = unlocked(e, [...e.selectedIds].map((id) => ({ id }))).map((l) => l.id);
        if (!ids.length) return;
        e.command('Layer Opacity', (d) => {
          for (const id of ids) {
            const l = findLayer(d.layers, id);
            if (l) l.opacity = v;
          }
        }, { coalesce: true });
      },
    },
  );
}
