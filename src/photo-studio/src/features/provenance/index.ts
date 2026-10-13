// Provenance: a record of how each document is made (sources, edit steps,
// AI use, exports), shown in the Provenance panel, saved in projects,
// optionally attached to exports and readable from any image with
// File → Inspect Provenance. The recorder is small and always on; the panel,
// codecs and dialogs load on first use.
import type { Editor } from '../../editor';
import { registerCommand, registerPanel } from '../../app/registry';
import { lazy, lazyPanel, lazyRun } from '../../app/lazy';
import { download } from '../../persistence/puter';
import { installRecorder, recordOf } from './recorder';

const panel = lazy(() => import('./panel'));
const inspect = lazy(() => import('./inspect'));

export function installProvenance(e: Editor) {
  installRecorder(e);
  registerPanel(lazyPanel({ id: 'provenance', title: 'Provenance', icon: 'provenance', location: 'strip', hidden: true, menu: () => ['file.inspect-provenance', 'provenance.export-record'] }, panel));
  registerCommand(
    // Directly in the Window menu (not under Panels).
    { id: 'window.panel.provenance', label: 'Provenance', recordable: false, checked: (e) => e.dock.isVisible('provenance'), run: (e) => e.dock.show('provenance', true) },
    {
      id: 'file.inspect-provenance',
      label: 'Inspect Provenance…',
      description: 'Read the history and signature attached to an image file and check its pixels',
      recordable: false,
      ...lazyRun(inspect, (m, e) => m.inspectFile(e)),
    },
    {
      id: 'provenance.export-record',
      label: 'Export Provenance Record',
      description: 'Save the document’s provenance record as JSON',
      recordable: false,
      enabled: (e) => e.hasDocument,
      run: (e) => {
        const name = `${e.doc.name.replace(/[\\/:*?"<>|]+/g, '_') || 'Untitled'}-provenance.json`;
        download(new Blob([JSON.stringify(recordOf(e.session), null, 2)], { type: 'application/json' }), name);
        e.message(`Saved ${name}`);
      },
    },
  );
}
