// File menu: opening (all codecs, Puter, recent files), saving projects,
// Export As and the other exporters, File Info, Print and Automate.
import type { Editor } from '../../editor';
import type { Layer } from '../../model/document';
import { registerCommand, type Command } from '../../app/registry';
import { lazy, lazyRun, prefetchOnIdle, type Lazy } from '../../app/lazy';
import { installStartScreen } from './start-screen';
import { setRecentOpener, syncRecentCommands } from './recent';
import { formatInfo } from './formats';
import { allLayers } from '../../model/document';
import { askChoice } from '../preferences/warnings';
import { installAutomate } from './automate-steps';

// Implementations load on first use.
const exportDialog = lazy(() => import('./export-dialog'));
const newDocument = lazy(() => import('./new-document'));
const packaging = lazy(() => import('./package'));
const pathsExport = lazy(() => import('./paths-export'));
const pipeline = lazy(() => import('./pipeline'));
const psdExport = lazy(() => import('./psd-export'));
const layersExport = lazy(() => import('./layers-export'));
const info = lazy(() => import('./info'));
const saving = lazy(() => import('./save'));
const importing = lazy(() => import('./import-layers'));
const lutExport = lazy(() => import('./lut-export'));
/** Opening files (all codecs); prefetched when the workspace is idle. */
export const opening = lazy(() => import('./open'));

export { registerBatchStep, type BatchStep } from './automate-steps';

const hasDoc = (e: Editor) => e.hasDocument;
const hasAdjustment = (layers: Layer[]): boolean => layers.some((l) => l.kind === 'adjustment' || hasAdjustment(l.children));

export function installFiles(e: Editor) {
  const cmd = (id: string, label: string, run: Command['run'], extra: Partial<Command> = {}) =>
    registerCommand({ id, label, run, recordable: false, ...extra });
  // A command whose implementation is a function of a lazily loaded module.
  const lcmd = <M,>(id: string, label: string, mod: Lazy<M>, run: (m: M, e: Editor, arg?: unknown) => unknown, extra: Partial<Command> = {}) =>
    registerCommand({ id, label, recordable: false, ...lazyRun(mod, run), ...extra });
  lcmd('file.new', 'New…', newDocument, (m) => void m.newDocumentWindow(e), { shortcut: 'Mod+N', description: 'Create a document from a preset or custom settings' });
  // These replace the basic versions registered by core.
  lcmd('file.open-cloud', 'Open from Puter…', saving, (m) => m.openFromCloud(e), { description: 'Open one or more files from Puter' });
  lcmd('file.save', 'Save', saving, (m) => m.save(e), { shortcut: 'Mod+S', enabled: hasDoc, description: 'Save to Puter: a document opened from a PSD or an image file (PNG, JPEG, WebP, ...) saves back in that format, others as a .photo project' });
  lcmd('file.save-as', 'Save As…', saving, (m, _e, format) => m.saveAs(e, false, format), { shortcut: 'Mod+Shift+S', enabled: hasDoc, description: 'Save to a new Puter location as a .photo project, a PSD or the image format the document came from' });
  lcmd('file.save-copy', 'Save a Copy…', saving, (m, _e, format) => m.saveAs(e, true, format), { shortcut: 'Mod+Alt+S', enabled: hasDoc, description: 'Save a copy to Puter without changing where this document saves' });
  lcmd('file.download-project', 'Download Project (.photo)', saving, (m) => m.downloadProject(e), { enabled: hasDoc });
  lcmd('file.export-as', 'Export As…', exportDialog, (m) => m.exportAsDialog(e), { shortcut: 'Mod+Alt+Shift+W', enabled: hasDoc, description: 'Export with format, size, metadata and color options' });
  // The label follows Preferences → Export → Quick export format.
  const quick = () => {
    const label = formatInfo[e.preferences.quickExportFormat].label;
    lcmd('file.quick-export-png', `Quick Export as ${label}`, pipeline, (m) => m.quickExport(e), { shortcut: "Mod+Shift+'", enabled: hasDoc, description: `Export a ${label} with your last Export As settings` });
  };
  quick();
  e.preferenceHooks.push(quick, syncRecentCommands);
  lcmd('file.export-psd', 'Export PSD', psdExport, (m) => m.exportPsd(e), { enabled: hasDoc });
  cmd('file.export-tiff', 'Export TIFF…', () => exportTiff(e), { enabled: hasDoc });
  lcmd('file.export-gif', 'Export GIF…', layersExport, (m) => m.exportGif(e), { enabled: hasDoc, description: 'Export a GIF, optionally animating the layers' });
  lcmd('file.export-svg', 'Export SVG', layersExport, (m) => m.exportSvgFile(e), { enabled: hasDoc, description: 'Export layers as SVG shapes, text and images' });
  lcmd('file.export-layers', 'Export Layers to Files…', layersExport, (m) => m.exportLayers(e), { enabled: (e) => e.hasDocument && e.doc.layers.length > 0 });
  lcmd('file.import-layers', 'Import Layers…', importing, (m) => m.importLayers(e), { enabled: hasDoc, description: 'Add every layer of a PSD or .photo file to this document as a group' });
  lcmd('file.import-layers-cloud', 'Import Layers from Puter…', importing, (m) => m.importLayers(e, 'puter'), { enabled: hasDoc, description: 'Add every layer of a PSD or .photo file on Puter to this document as a group' });
  lcmd('file.export-color-lookup', 'Color Lookup Tables…', lutExport, (m) => m.exportColorLookup(e), { enabled: (e) => e.hasDocument && hasAdjustment(e.doc.layers), description: 'Export the effect of the adjustment layers as a .cube, .3dl or .csp table' });
  lcmd('file.package', 'Package as ZIP', packaging, (m) => m.packageDocument(e), { enabled: hasDoc, description: 'Collect the project and its linked files into a ZIP' });
  lcmd('file.export-paths', 'Paths to Vector File…', pathsExport, (m) => m.exportPathsDialog(e), { enabled: (e) => e.hasDocument && (!!e.doc.paths?.length || !!e.doc.workPath?.paths.length), description: 'Export saved paths and the work path as SVG' });
  lcmd('file.info', 'File Info…', info, (m) => m.fileInfo(e), { shortcut: 'Mod+Alt+Shift+I', enabled: hasDoc });
  lcmd('file.print', 'Print…', info, (m) => m.printImage(e), { shortcut: 'Mod+P', enabled: hasDoc });
  installAutomate(e);
  setRecentOpener(async (e, entry) => (await saving()).openRecentEntry(e, entry));
  syncRecentCommands(e);
  installStartScreen(e);
  bindTabDrop(e);
  // Opening an image or starting a document is the likely first step.
  prefetchOnIdle(opening, newDocument);
  // The shell's picker predates some codecs; let it offer every readable type.
  const input = e.root.querySelector<HTMLInputElement>('#file-input');
  if (input) for (const ext of ['.cur', '.pam', '.dib', '.svg', '.webp', '.avif', '.jpg', '.jpeg', '.png', '.gif']) if (!input.accept.split(',').includes(ext)) input.accept += `,${ext}`;
}

// Preferences → File Handling → Ask before saving layered TIFF files: TIFF
// export writes one flattened image.
async function exportTiff(e: Editor) {
  if (e.preferences.askLayeredTiff && allLayers(e.doc.layers).filter((l) => l.kind !== 'group').length > 1) {
    const choice = await askChoice('Layered TIFF', 'TIFF export flattens the layers into one image. Export a PSD to keep them, or flatten into the TIFF.', [
      ['psd', 'Export PSD Instead'],
      ['flatten', 'Flatten and Export'],
    ]);
    if (!choice) return;
    if (choice === 'psd') return (await psdExport()).exportPsd(e);
  }
  return (await exportDialog()).exportAsDialog(e, { format: 'tiff' });
}

// Dropping onto the document tabs opens files as new documents (the editor's
// workspace drop handler does the opening); show that target while dragging.
function bindTabDrop(e: Editor) {
  const tabs = e.root.querySelector<HTMLElement>('.document-tabs');
  if (!tabs) return;
  const files = (ev: DragEvent) => !!ev.dataTransfer?.types.includes('Files');
  tabs.addEventListener('dragover', (ev) => {
    if (!files(ev)) return;
    ev.preventDefault();
    ev.dataTransfer!.dropEffect = 'copy';
    tabs.classList.add('files-drop-target');
    e.el('#viewport').classList.remove('dragover');
  });
  const clear = () => tabs.classList.remove('files-drop-target');
  tabs.addEventListener('dragleave', (ev) => {
    if (!tabs.contains(ev.relatedTarget as Node | null)) clear();
  });
  tabs.addEventListener('drop', clear);
  document.addEventListener('dragend', clear);
}
