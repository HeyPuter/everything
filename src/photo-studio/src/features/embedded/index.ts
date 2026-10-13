// Embedded objects: Layer → Embedded Objects, File → Open as Embedded Object,
// Place Linked, Load Files into Stack, panel badges and Properties.
import type { Editor } from '../../editor';
import { registerCommand, type Command } from '../../app/registry';
import { stackModes } from '../../model/embedded';
import { layerBadges, layerNotes } from '../panels/layers';
import { propertySections } from '../panels/properties';
import { rasterizeLayer } from '../pixels';
import { lazy } from '../../app/lazy';
import { parentClosed, tabBadge } from './owners';
import { hasLinked, watchLinks } from './link-state';
import { stackable } from './stack-mode';
import { staleFrames } from './frame-math';

// Command implementations load on first use.
const convert = lazy(() => import('./convert'));
const editing = lazy(() => import('./edit'));
const linked = lazy(() => import('./linked'));
const stack = lazy(() => import('./stack'));
const frames = lazy(() => import('./frame'));
import { badge, bindPanel, note, section } from './panel';

const object = (e: Editor) => e.selectedIds.size === 1 && e.layer?.kind === 'image' && !!(e.layer.asset || e.layer.embed);
const anyObject = (e: Editor) => e.selectedLayers.some((l) => l.kind === 'image');
const hasDoc = (e: Editor) => e.hasDocument;

export function installEmbedded(e: Editor) {
  const cmd = (id: string, label: string, run: Command['run'], extra: Partial<Command> = {}) => registerCommand({ id, label, run, ...extra });
  // ----- File -----
  cmd('file.open-as-embedded', 'Open as Embedded Object…', async () => (await convert()).openAsEmbedded(e), { recordable: false, description: 'Open a file as a new document holding it as one embedded object' });
  cmd('file.place-linked', 'Place Linked…', async () => (await linked()).placeLinked(e, 'local'), { enabled: hasDoc, recordable: false, description: 'Place a file that can be updated when it changes' });
  cmd('file.place-linked-cloud', 'Place Linked from Puter…', async () => (await linked()).placeLinked(e, 'puter'), { enabled: hasDoc, recordable: false, description: 'Place a Puter file, re-read from its path on update' });
  cmd('file.load-files-into-stack', 'Load Files into Stack…', async () => (await stack()).loadFilesIntoStack(e), { recordable: false, description: 'Open several files as layers of one document, optionally as a stack' });
  // ----- Layer → Embedded Objects -----
  cmd('layer.embed-convert', 'Convert to Embedded Object', async () => (await convert()).convertToEmbedded(e), { enabled: (e) => e.selectedLayers.length > 0, description: 'Combine the selected layers into one non-destructive object' });
  cmd('layer.embed-new-via-copy', 'New Embedded Object via Copy', async () => (await convert()).newViaCopy(e), { enabled: anyObject, description: 'Duplicate with its own contents (Duplicate Layer shares them)' });
  cmd('layer.embed-update', 'Update Modified Content', async () => (await linked()).updateModified(e, false), { enabled: (e) => hasLinked(e, false) });
  cmd('layer.embed-update-all', 'Update All Modified Content', async () => (await linked()).updateModified(e, true), { enabled: (e) => hasLinked(e, true) });
  cmd('layer.embed-edit', 'Edit Contents', async () => (await editing()).editContents(e), { enabled: object, recordable: false, description: 'Open the contents in a tab; saving it updates every instance' });
  cmd('layer.embed-reset', 'Reset Transform', async () => (await convert()).resetTransform(e), { enabled: anyObject });
  cmd('layer.embed-relink', 'Relink to File…', async () => (await linked()).relink(e), { enabled: (e) => object(e) && hasLinked(e, false), recordable: false });
  cmd('layer.embed-replace', 'Replace Contents…', async () => (await convert()).replaceContents(e), { enabled: object, recordable: false });
  cmd('layer.embed-export', 'Export Contents…', async () => (await convert()).exportContents(e), { enabled: object, recordable: false });
  cmd('layer.embed-embed-linked', 'Embed Linked', async () => (await linked()).embedLinked(e, false), { enabled: (e) => hasLinked(e, false) });
  cmd('layer.embed-embed-all', 'Embed All Linked', async () => (await linked()).embedLinked(e, true), { enabled: (e) => hasLinked(e, true) });
  cmd('layer.embed-convert-linked', 'Convert to Linked…', async () => (await linked()).convertToLinked(e), {
    enabled: (e) => object(e) && !hasLinked(e, false),
    recordable: false,
    description: 'Save the contents to a file on this device or on Puter and link to it',
  });
  cmd('layer.embed-to-layers', 'Convert to Layers', async () => (await convert()).convertToLayers(e), { enabled: object, description: 'Unpack the contents into a group in place' });
  cmd('layer.embed-rasterize', 'Rasterize', async () => {
    if (e.layer?.kind === 'image') await rasterizeLayer(e, e.layer.id, 'Rasterize Embedded Object');
  }, { enabled: object });
  stackModes.forEach(([mode, label], i) =>
    cmd(`layer.embed-stack-${mode}`, label, async () => (await stack()).setStackMode(e, mode), {
      menu: 'layer.embed-stack',
      order: i,
      enabled: (e) => !!stackable(e),
      checked: (e) => (stackable(e)?.stack ?? 'none') === mode,
    }),
  );
  layerBadges.push(badge);
  layerNotes.push(note);
  propertySections.push(section);
  bindPanel(e);
  watchLinks(e);
  e.tabBadges.push(tabBadge);
  e.closeHooks.push((s) => parentClosed(e, s));
  // Warped objects re-render from their content after edits that make the
  // cached render stale (content saved, layer scaled or rotated).
  // The refresh code loads when a frame first goes stale.
  e.onUpdate((e) => {
    if (frames.loaded) frames.loaded.scheduleRefresh(e);
    else if (staleFrames(e.doc).length) void frames().then((m) => m.scheduleRefresh(e));
  });
  // Readbacks (exports, merging, rasterizing) wait for stale frame renders.
  e.whenReady(
    (e) =>
      (e.renderer.beforeReadback = async () => {
        if (frames.loaded || staleFrames(e.doc).length) await (await frames()).framesReady(e);
      }),
  );
}
