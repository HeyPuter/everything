/**
 * Layers panel menu commands: new sublayer, duplicate, delete, options,
 * clipping mask, isolation, Locate Object, Merge Selected, Flatten
 * Artwork, Collect in New Layer, Release to Layers (Sequence / Build),
 * Reverse Order, Template, Hide / Outline / Lock Others, Paste Remembers
 * Layers and the panel options. See layer-ops.js for the operations.
 */
import { defaultLabel } from '../../model/nodes.js';
import { clipboardHooks } from '../../ops/clipboard.js';
import { viewHooks } from '../../render/canvas-view.js';
import {
  layerPicks,
  targetLayers,
  currentItem,
  insertLayer,
  nextLayerName,
  duplicateNodes,
  deleteLayers,
  mergeLayers,
  flattenLayers,
  flattenDiscards,
  collectInNewLayer,
  releaseToLayers,
  reverseOrder,
  toggleOthers,
  othersAllSet,
  setTemplate,
  layerNamesOf,
  layerNamed,
} from '../../ops/layer-ops.js';

export * from '../../ops/layer-ops.js';

const quote = (n) => `"${n ? defaultLabel(n) : ''}"`;
const short = (s) => (s.length > 24 ? `${s.slice(0, 23)}…` : s);

/** Drop selected ids that became hidden or locked, and tell panels the active layer may have changed. */
function settle(ed) {
  for (const id of [...ed.selection]) if (!ed.doc.has(id) || ed.doc.isHidden(id) || ed.doc.isLocked(id)) ed.selection.delete(id);
  ed.emit('selection');
  ed.emit('active-layer');
}

/** The container Release to Layers works on: a selected group, else the target layer. */
function releaseTarget(ed) {
  const g = ed.selectedNodes().find((n) => n.type === 'group' && n.children.length && ed.topSelection().includes(n.id));
  return g || ed.doc.get(targetLayers(ed).at(-1));
}

export function install(app) {
  const ed = () => app.editor;
  const hasDoc = (a) => Boolean(a.editor);
  const hasSel = (a) => Boolean(a.editor?.selection.size);
  const layersPanel = () => app.dock?.panels.get('layers');

  app.commands.register([
    {
      id: 'layers.newSublayer',
      label: 'New Sublayer...',
      enabled: hasDoc,
      run: async (a) => {
        const e = ed();
        const parent = e.doc.get(targetLayers(e).at(-1));
        if (!parent) return;
        const v = await a.dialogs.form({
          title: 'Layer Options',
          fields: [
            { key: 'name', label: 'Name', type: 'text', value: nextLayerName(e.doc) },
            { key: 'color', label: 'Color', type: 'color', value: '#4f80ff' },
            { key: 'template', label: 'Template', type: 'checkbox', value: false },
            { key: 'locked', label: 'Lock', type: 'checkbox', value: false },
            { key: 'show', label: 'Show', type: 'checkbox', value: true },
          ],
        });
        if (!v) return;
        let id;
        e.doc.transact('New Sublayer', () => {
          const layer = insertLayer(e.doc, parent.id, Infinity, {
            name: String(v.name || '').trim() || nextLayerName(e.doc),
            color: v.color,
            template: Boolean(v.template),
            locked: Boolean(v.locked || v.template),
            hidden: !v.show,
            ...(v.template ? { print: false } : {}),
          });
          id = layer.id;
        });
        e.activeLayerId = id;
        layersPanel()?.expanded?.add(parent.id);
        e.emit('active-layer');
      },
    },
    {
      id: 'layers.duplicate',
      label: (a) => `Duplicate ${a.editor ? short(quote(currentItem(a.editor))) : ''}`.trim(),
      enabled: hasDoc,
      run: () => {
        const e = ed();
        const sel = e.topSelection();
        let made = [];
        e.doc.transact('Duplicate', () => {
          made = duplicateNodes(e.doc, sel.length ? sel : targetLayers(e));
        });
        if (sel.length) e.select(made);
        else {
          const picks = layerPicks(e);
          picks.clear();
          made.forEach((id) => picks.add(id));
          e.activeLayerId = made.at(-1) || e.activeLayerId;
          e.emit('active-layer');
        }
      },
    },
    {
      id: 'layers.delete',
      label: (a) => `Delete ${a.editor ? short(quote(currentItem(a.editor))) : ''}`.trim(),
      enabled: (a) => Boolean(a.editor && (a.editor.selection.size || a.editor.doc.layers().length > 1 || targetLayers(a.editor).some((id) => a.editor.doc.get(id)?.parent !== 'root'))),
      run: (a) => {
        const e = ed();
        if (e.selection.size) return a.commands.run('edit.clear');
        const ids = targetLayers(e);
        let n = 0;
        e.doc.transact(ids.length > 1 ? 'Delete Layers' : 'Delete Layer', () => {
          n = deleteLayers(e.doc, ids);
        });
        if (!n) a.notify('A document needs at least one layer.');
        layerPicks(e).clear();
        if (!e.doc.has(e.activeLayerId)) e.activeLayerId = e.doc.layers().at(-1)?.id;
        settle(e);
      },
    },
    {
      id: 'layers.options',
      label: (a) => `Options for ${a.editor ? short(quote(currentItem(a.editor))) : 'Selection'}...`,
      enabled: hasDoc,
      run: (a) => {
        const e = ed();
        const item = currentItem(e);
        if (!item) return;
        if (item.type === 'layer') return layersPanel()?.layerOptions(item);
        return objectOptions(a, item);
      },
    },
    {
      id: 'layers.clipMask',
      label: 'Make/Release Clipping Mask',
      enabled: hasDoc,
      run: () => layersPanel()?.clipButton(),
    },
    {
      id: 'layers.isolate',
      label: 'Enter Isolation Mode',
      enabled: (a) => Boolean(a.editor && !a.editor.isolation),
      run: (a) => {
        const e = ed();
        const g = e.selectedNodes().find((n) => n.type === 'group');
        a.commands.run('object.isolate', { id: g?.id || targetLayers(e).at(-1) });
      },
    },
    {
      id: 'layers.locate',
      label: 'Locate Object',
      enabled: hasSel,
      run: (a) => {
        a.openPanel('layers');
        layersPanel()?.locate(ed().topSelection().at(-1));
      },
    },
    {
      id: 'layers.merge',
      label: 'Merge Selected',
      enabled: (a) => Boolean(a.editor && targetLayers(a.editor).length > 1),
      run: () => {
        const e = ed();
        const ids = targetLayers(e);
        const into = ids.includes(e.activeLayerId) ? e.activeLayerId : ids.at(-1);
        e.doc.transact('Merge Layers', () => mergeLayers(e.doc, ids, into));
        layerPicks(e).clear();
        e.activeLayerId = into;
        settle(e);
      },
    },
    {
      id: 'layers.flatten',
      label: 'Flatten Artwork',
      enabled: (a) => Boolean(a.editor && a.editor.doc.layers().length > 1),
      run: async (a) => {
        const e = ed();
        if (flattenDiscards(e.doc)) {
          const ok = await a.dialogs.confirm({ title: 'Flatten Artwork', message: 'Hidden layers contain artwork. Flattening deletes it. Continue?', okLabel: 'Discard Hidden Art', danger: true });
          if (!ok) return;
        }
        let id;
        e.doc.transact('Flatten Artwork', () => {
          id = flattenLayers(e.doc, targetLayers(e).at(-1));
        });
        layerPicks(e).clear();
        if (id) e.activeLayerId = id;
        settle(e);
      },
    },
    {
      id: 'layers.collect',
      label: 'Collect in New Layer',
      enabled: (a) => Boolean(a.editor && (a.editor.selection.size || layerPicks(a.editor).size)),
      run: () => {
        const e = ed();
        const sel = e.topSelection();
        let id;
        e.doc.transact('Collect in New Layer', () => {
          id = collectInNewLayer(e.doc, sel.length ? sel : targetLayers(e));
        });
        if (!id) return;
        layerPicks(e).clear();
        e.activeLayerId = id;
        for (const anc of e.doc.ancestors(id)) layersPanel()?.expanded?.add(anc.id);
        settle(e);
      },
    },
    ...['sequence', 'build'].map((mode) => ({
      id: mode === 'sequence' ? 'layers.releaseSequence' : 'layers.releaseBuild',
      label: mode === 'sequence' ? 'Release to Layers (Sequence)' : 'Release to Layers (Build)',
      enabled: (a) => Boolean(a.editor && releaseTarget(a.editor)?.children.some((c) => a.editor.doc.get(c)?.type !== 'layer')),
      run: () => {
        const e = ed();
        const c = releaseTarget(e);
        let made = [];
        e.doc.transact('Release to Layers', () => {
          made = releaseToLayers(e.doc, c.id, mode);
        });
        if (!made.length) return;
        const parent = e.doc.get(made[0]).parent;
        layersPanel()?.expanded?.add(parent);
        e.clearSelection();
        settle(e);
      },
    })),
    {
      id: 'layers.reverse',
      label: 'Reverse Order',
      enabled: (a) => Boolean(a.editor && (a.editor.topSelection().length > 1 || targetLayers(a.editor).length > 1)),
      run: () => {
        const e = ed();
        const sel = e.topSelection();
        e.doc.transact('Reverse Order', () => reverseOrder(e.doc, sel.length > 1 ? sel : targetLayers(e)));
      },
    },
    {
      id: 'layers.template',
      label: 'Template',
      enabled: hasDoc,
      checked: (a) => Boolean(a.editor && targetLayers(a.editor).every((id) => a.editor.doc.get(id)?.template)),
      run: () => {
        const e = ed();
        const ids = targetLayers(e);
        const on = !ids.every((id) => e.doc.get(id)?.template);
        e.doc.transact('Template', () => setTemplate(e.doc, ids, on));
        settle(e);
      },
    },
    othersCommand('layers.hideOthers', 'hidden', 'Hide Others', 'Show All Layers'),
    othersCommand('layers.outlineOthers', 'outline', 'Outline Others', 'Preview All Layers'),
    othersCommand('layers.lockOthers', 'locked', 'Lock Others', 'Unlock All Layers'),
    {
      id: 'layers.pasteRemembers',
      label: 'Paste Remembers Layers',
      checked: (a) => Boolean(a.prefs.get('pasteRemembersLayers')),
      run: (a) => a.prefs.set('pasteRemembersLayers', !a.prefs.get('pasteRemembersLayers')),
    },
    {
      id: 'layers.panelOptions',
      label: 'Panel Options...',
      run: () => layersPanel()?.panelOptions(),
    },
  ]);

  function othersCommand(id, key, label, restore) {
    return {
      id,
      label: (a) => (a.editor && othersAllSet(a.editor.doc, keepIds(a.editor), key) ? restore : label),
      enabled: (a) => Boolean(a.editor && a.editor.doc.layers().length > 1),
      run: (a) => {
        const e = a.editor;
        const allSet = othersAllSet(e.doc, keepIds(e), key);
        e.doc.transact(allSet ? restore : label, () => toggleOthers(e.doc, keepIds(e), key));
        settle(e);
      },
    };
  }

  // Layer Options > Dim Images applies on screen only.
  viewHooks.artOptions.push((editor, o) => ({ ...o, dimLayers: true }));

  // Paste Remembers Layers: remember each copied object's layer by name;
  // pasting puts it back in that layer (created again when it is gone).
  clipboardHooks.push({
    copy(doc, ids, data) {
      const names = layerNamesOf(doc, ids);
      data.layerByRoot = Object.fromEntries(ids.map((id, i) => [id, names[i]]));
    },
    targetLayer(doc, data, item) {
      const name = app.prefs.get('pasteRemembersLayers') ? data.layerByRoot?.[item.root] : null;
      if (!name) return null;
      const layer = layerNamed(doc, name);
      return doc.isLocked(layer.id) || doc.isHidden(layer.id) ? null : layer.id;
    },
  });
}

/** Options for an object: its name, visibility and lock. */
async function objectOptions(app, item) {
  const ed = app.editor;
  const v = await app.dialogs.form({
    title: 'Options',
    fields: [
      { key: 'name', label: 'Name', type: 'text', value: item.name || '' },
      { key: 'show', label: 'Show', type: 'checkbox', value: !item.hidden },
      { key: 'locked', label: 'Lock', type: 'checkbox', value: Boolean(item.locked) },
    ],
  });
  if (!v || !ed.doc.has(item.id)) return;
  ed.doc.transact('Options', () => ed.doc.update(item.id, { name: String(v.name || '').trim() || undefined, hidden: !v.show, locked: Boolean(v.locked) }));
  settle(ed);
}

/** The ids whose layers Hide / Outline / Lock Others keep: the selection's, else the target layers. */
function keepIds(ed) {
  const sel = ed.topSelection();
  return sel.length ? sel : targetLayers(ed);
}
