// Filter menu: one command per operation in the Filter submenus, Last Filter,
// Fade, the Filter Gallery, Liquify, Develop, Lens Correction and Live Filters.
import type { Editor } from '../../editor';
import { commands, registerCommand, renamedCommands } from '../../app/registry';
import { layerRowExtras } from '../panels/layers';
import { lazy, lazyRun } from '../../app/lazy';
import { selectionBounds, selectionGrid } from '../../model/selection';
import { GALLERY_ID, RESTORE_ID, categorySlug, commandId, filterLabel, filterMenu, renamedFilters, topLevelFilter } from './menu';
import { canFade, fadeLabel, filterState, isLiveLayer } from './state';
import { bindLiveRows, liveRows } from './live-rows';
import { deferRecording, installRecorderWrapper } from './record';
import { installLiveMenu, syncLiveMenu } from './live-menu';

// The operations, dialogs and workspaces load with the first filter used.
const running = lazy(() => import('./run'));
/** Run a filter: with settings it applies directly, otherwise its dialog opens. */
export async function runFilter(e: Editor, opId: string, arg?: unknown) {
  return (await running()).runFilter(e, opId, arg);
}

const filterDescriptions: Record<string, string> = {
  develop: 'White balance, tone, presence and effects with a before/after preview.',
  denoise: 'Remove luminance and color noise while keeping edges and texture (noise level measured automatically).',
  'sharpen-details': 'Recover detail lost to soft focus or blur by deconvolution, without amplifying noise.',
};
const canFilter = (e: Editor) => e.hasDocument && (!!e.layer || !!e.settings.quickMask);
export function installFilters(e: Editor) {
  installRecorderWrapper(e);
  const sorted = [...filterMenu].sort((a, b) => a.label.localeCompare(b.label));
  for (const [from, to] of Object.entries(renamedFilters)) renamedCommands.set(commandId(from), commandId(to));
  for (const op of filterMenu) {
    const id = commandId(op.id);
    const dialog = !op.immediate;
    if (dialog) deferRecording(id);
    const top = topLevelFilter(op.id);
    registerCommand({
      id,
      label: op.id === 'develop' ? 'Develop Filter…' : `${op.label}${dialog ? '…' : ''}`,
      menu: top ? undefined : `filter.${categorySlug(op.category)}`,
      order: sorted.indexOf(op),
      shortcut: op.id === 'develop' ? 'Mod+Shift+A' : op.id === 'lens-correction' ? 'Mod+Shift+R' : op.id === 'adaptive-wide-angle' ? 'Mod+Alt+Shift+A' : undefined,
      enabled: canFilter,
      description: filterDescriptions[op.id],
      run: (e, arg) => runFilter(e, op.id, arg),
      prefetch: running.prefetch,
    });
  }
  deferRecording('filter.gallery');
  deferRecording('filter.portrait-restore');
  deferRecording('edit.fade');
  registerCommand(
    {
      id: 'filter.gallery',
      label: 'Filter Gallery…',
      enabled: canFilter,
      description: 'Stack texture effects as effect layers with one preview.',
      run: (e, arg) => runFilter(e, GALLERY_ID, arg),
      prefetch: running.prefetch,
    },
    {
      id: 'filter.portrait-restore',
      label: 'Portrait & Restore…',
      enabled: canFilter,
      description: 'Skin smoothing, JPEG cleanup, photo restoration, colorizing, depth blur, color and style transfer and scene changes in one workspace with a before/after preview.',
      run: (e, arg) => runFilter(e, RESTORE_ID, arg),
      prefetch: running.prefetch,
    },
    {
      id: 'filter.liquify',
      label: 'Liquify…',
      shortcut: 'Mod+Shift+X',
      enabled: canFilter,
      description: 'Push, twirl, pucker and bloat pixels with brushes.',
      ...lazyRun(running, (m, e) => m.liquify(e)),
    },
    {
      id: 'filter.last',
      label: 'Last Filter',
      // Control+Command on macOS; Ctrl+Alt elsewhere, where Ctrl is the Mod key.
      shortcut: ['Mod+Ctrl+F', 'Mod+Alt+F'],
      enabled: (e) => canFilter(e) && !!filterState.last,
      ...lazyRun(running, (m, e) => m.runLastFilter(e)),
    },
    {
      id: 'edit.fade',
      label: 'Fade…',
      shortcut: 'Mod+Shift+F',
      enabled: canFade,
      ...lazyRun(running, (m, e, arg) => m.runFade(e, arg)),
    },
    {
      id: 'filter.convert-live',
      label: 'Convert for Live Filters',
      // Video layers change pixels with time; filters apply to their frames directly.
      enabled: (e) => e.hasDocument && !!e.layer && !isLiveLayer(e.layer) && !['group', 'adjustment'].includes(e.layer.kind) && !e.layer.video,
      description: 'Keep the original pixels so filters stay editable.',
      ...lazyRun(running, (m, e) => m.convertForLiveFilters(e)),
    },
    {
      id: 'layer.live-filter-mask',
      label: 'Live Filter Mask from Selection',
      enabled: (e) => isLiveLayer(e.layer) && (!!e.layer.liveMask || !!selectionBounds(e.doc, selectionGrid(e.doc, e.assets.tiles))),
      checked: (e) => isLiveLayer(e.layer) && !!e.layer.liveMask,
      ...lazyRun(running, (m, e) => m.toggleLiveMask(e)),
    },
    {
      id: 'filter.vanishing-point',
      label: 'Perspective Planes…',
      shortcut: 'Mod+Alt+V',
      enabled: (e) => e.hasDocument && !!e.layer,
      description: 'Clone, paint and paste on surfaces in perspective.',
      ...lazyRun(running, (m, e) => m.perspectivePlanes(e)),
    },
  );
  // Menu labels name the filter they repeat or fade.
  e.onUpdate(() => {
    const last = commands.get('filter.last');
    if (last) last.label = filterState.last ? `Last Filter (${filterLabel(filterState.last.opId)})` : 'Last Filter';
    const f = commands.get('edit.fade');
    if (f) f.label = fadeLabel();
  });
  installLiveMenu();
  e.onUpdate(() => syncLiveMenu(e, (id, text) => {
    const c = commands.get(id);
    if (c) c.label = text;
  }));
  layerRowExtras.push(liveRows);
  bindLiveRows(e, (layerId, index, id) => void running().then((m) => m.editLive(e, layerId, index, id)));
}
