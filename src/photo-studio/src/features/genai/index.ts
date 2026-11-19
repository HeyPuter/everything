// Generative layout edits in the Edit menu: AI Recompose (move, scale,
// rotate, flip or remove an object and fill its place), Remove Reflections
// and Rotate Object (turn a flat object in depth). The dialogs load on first
// use; nothing is sent to Puter until Generate is pressed in one of them.
import type { Editor } from '../../editor';
import { contributeMenu, registerCommand, type Command } from '../../app/registry';

export function installGenAI(e: Editor) {
  void e;
  const lazy =
    <M>(load: () => Promise<M>, pick: (m: M) => Command['run']): Command['run'] =>
    async (ed, arg) =>
      pick(await load())(ed, arg);
  const doc = (ed: Editor) => ed.hasDocument;
  registerCommand(
    {
      id: 'edit.ai-recompose',
      label: 'AI Recompose…',
      enabled: doc,
      recordable: false,
      run: lazy(
        () => import('./recompose'),
        (m) => m.recomposeDialog,
      ),
      description:
        'Move, scale, rotate, flip or remove an object; its old place is filled at once and an optional Puter AI pass blends seams and shadows.',
    },
    {
      id: 'edit.remove-reflections',
      label: 'Remove Reflections…',
      enabled: doc,
      recordable: false,
      run: lazy(
        () => import('./reflection'),
        (m) => m.reflectionDialog,
      ),
      description:
        'Take window and glass reflections out of the selection or layer with Puter AI (needs a Puter account).',
    },
    {
      id: 'edit.rotate-object',
      label: 'Rotate Object…',
      enabled: doc,
      recordable: false,
      run: lazy(
        () => import('./rotate-object'),
        (m) => m.rotateObjectDialog,
      ),
      description:
        'Turn an object in depth (around its vertical axis, or tilted) with Puter AI and place it where it stands.',
    },
  );
  contributeMenu('edit', ['edit.ai-recompose', 'edit.remove-reflections'], 'assistant.ask');
  contributeMenu('edit', ['edit.rotate-object'], 'edit.transform');
}
