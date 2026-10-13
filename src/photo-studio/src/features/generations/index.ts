// Generation History: AI results kept in this browser (see panel.ts). The
// panel body and the store load when the panel is first shown.
import './generations.css';
import type { Editor } from '../../editor';
import { registerCommand, registerPanel } from '../../app/registry';
import { lazy, lazyPanel, lazyRun } from '../../app/lazy';

const panel = lazy(() => import('./panel'));

export function installGenerations(e: Editor) {
  void e;
  registerPanel(
    lazyPanel(
      { id: 'generations', title: 'Generation History', icon: 'generation-history', location: 'strip', menu: () => ['generations.clear'] },
      lazy(async () => {
        const m = await panel();
        return { mount: m.mountGenerations, update: m.updateGenerations };
      }),
    ),
  );
  registerCommand({
    id: 'generations.clear',
    label: 'Clear Generation History…',
    recordable: false,
    description: 'Delete every AI result kept in this browser (layers already placed stay).',
    ...lazyRun(panel, (m, ed) => m.clearGenerations(ed)),
  });
}
