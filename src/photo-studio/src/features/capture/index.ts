// File → Import → Images from Device: capture photos from a camera into a
// new document or as layers of the current one. The dialog loads on use.
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import { lazy, lazyRun } from '../../app/lazy';

const camera = lazy(() => import('./camera'));

export function installCapture(_e: Editor) {
  registerCommand({
    id: 'file.import-device',
    label: 'Images from Device…',
    menu: 'file.import',
    order: -1,
    recordable: false,
    description: 'Take photos with a camera, with a timer and bursts, into a new document or as layers',
    ...lazyRun(camera, (m, e) => m.captureDialog(e)),
  });
}
