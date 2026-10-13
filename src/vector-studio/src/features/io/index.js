/**
 * Import and export: SVG import (open and place), SVG/PDF/PNG/JPEG/WebP
 * export, Export As, Export for Screens, Export Selection, Print, Place,
 * the system clipboard and drag and drop.
 *
 * Only commands, hooks and event wiring load with the app; the parser,
 * writers and dialogs live in lazy.js and load on first use (and in the
 * background once a document is open).
 *
 * Interfaces for other modules (all asynchronous):
 *   app.importers.svg(text, { name })  -> Promise<VDocument> (with importWarnings)
 *   app.importers.svgNodes(text)       -> Promise<{ nodes, root, subtree, assets, bounds, warnings }>
 *   app.importers.image(blob)          -> Promise<{ node, assetId, asset, width, height }>
 *   app.exporters.svg(editor, opts)    -> Promise<string>
 *   app.exporters.svgAsync(editor, opts) -> Promise<string> (same as svg)
 *   app.exporters.pdf(editor, opts)    -> Promise<Uint8Array>
 *   app.exporters.raster(editor, opts) -> Promise<Blob>
 *   app.exporters.thumbnail(editor, { size, artboard }) -> Promise<Blob> (PNG)
 */
import './styles.css';
import { paintHooks, svgExportHooks, exportBakers } from './hooks.js';
import { appearanceAttrs, layerAppearanceBaker, appearanceSpecBaker } from './svg-appearance.js';
import { installSystemIO } from './system.js';
import { pickDeviceFiles } from './kinds.js';

let loading = null;
/** Load the on-demand import/export module (once). */
export function loadIO() {
  if (!loading) {
    loading = import('./lazy.js');
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

export function install(app) {
  paintHooks.app = app;
  // Appearance stacks: marked for SVG import, and layer stacks baked for every exporter.
  if (!svgExportHooks.attrs.includes(appearanceAttrs)) svgExportHooks.attrs.push(appearanceAttrs);
  if (!exportBakers.includes(layerAppearanceBaker)) exportBakers.push(layerAppearanceBaker);
  if (!exportBakers.includes(appearanceSpecBaker)) exportBakers.push(appearanceSpecBaker);
  app.importers = {
    ...(app.importers || {}),
    svg: async (text, opts) => (await loadIO()).importSvgDocument(app, text, opts),
    svgNodes: async (text) => (await loadIO()).importSvgNodes(app, text),
    image: async (blob, opts) => (await loadIO()).imageNodeData(blob, opts),
  };
  app.exporters = {
    ...(app.exporters || {}),
    svg: async (editor, opts) => (await loadIO()).svg(app, editor, opts),
    svgAsync: async (editor, opts) => (await loadIO()).svg(app, editor, opts),
    pdf: async (editor, opts) => (await loadIO()).pdf(app, editor, opts),
    raster: async (editor, opts) => (await loadIO()).raster(editor, opts),
    thumbnail: async (editor, opts) => (await loadIO()).thumbnail(editor, opts),
  };

  const hasDoc = (a) => Boolean(a.editor);
  const signedInPuter = (a) => Boolean(a.puter?.ui?.showOpenFilePicker && a.user);
  app.commands.register([
    {
      id: 'file.place',
      label: 'Place...',
      shortcut: 'Shift+Mod+P',
      enabled: hasDoc,
      run: async (a) => {
        if (signedInPuter(a)) return (await loadIO()).placeCommand(a);
        // Open the file picker while the click or key press is still being handled.
        const editor = a.editor;
        const picked = pickDeviceFiles();
        const [files, io] = await Promise.all([picked, loadIO()]);
        if (a.editor === editor) await io.placeFiles(a, editor, files);
      },
    },
    { id: 'file.exportAs', label: 'Export As...', enabled: hasDoc, run: async (a) => (await loadIO()).exportAsDialog(a) },
    { id: 'file.exportScreens', label: 'Export for Screens...', shortcut: 'Alt+Mod+E', enabled: hasDoc, run: async (a) => (await loadIO()).exportScreensDialog(a, 'artboards') },
    { id: 'file.exportSelection', label: 'Export Selection...', enabled: (a) => Boolean(a.editor?.selection.size), run: async (a) => (await loadIO()).exportScreensDialog(a, 'selection') },
    { id: 'file.print', label: 'Print...', shortcut: 'Mod+P', enabled: hasDoc, run: async (a) => (await loadIO()).printDialog(a) },
  ]);

  // Fetch the module in the background once a document is open, so Copy can
  // write SVG to the system clipboard immediately and dialogs open instantly.
  let prefetched = false;
  app.on('active-editor', (ed) => {
    if (!ed || prefetched) return;
    prefetched = true;
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    idle(() => loadIO().catch(() => {}), { timeout: 4000 });
  });

  installSystemIO(app, loadIO);
}
