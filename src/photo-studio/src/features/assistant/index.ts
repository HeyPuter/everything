// The Assistant: describe an edit in words and get a plan of real commands to
// review and run as one undo step, or ask how to do something. The panel,
// catalog, model conversation and runner load on first use; this module only
// registers the panel and commands.
import './assistant.css';
import type { Editor } from '../../editor';
import { contributeMenu, registerCommand, registerPanel } from '../../app/registry';
import { lazy, lazyPanel } from '../../app/lazy';
import { ASSISTANT_MODELS, assistantSettings, saveAssistantSettings } from './settings';

const panel = lazy(() => import('./panel'));
const controller = lazy(() => import('./controller'));

/** Show the Assistant panel and focus its composer; with text, send it. */
export async function openAssistant(e: Editor, text?: string) {
  e.dock.show('assistant');
  const m = await panel();
  // The panel body mounts with the drawer; wait a frame for it.
  for (let i = 0; i < 20 && !e.root.querySelector('.assistant-panel .ast-input'); i++) await new Promise((r) => setTimeout(r, 25));
  const el = e.root.querySelector<HTMLElement>('.assistant-panel');
  if (text?.trim()) {
    m.submit(e, text);
    if (el) m.focusComposer(el);
  } else if (el) m.focusComposer(el);
}

export function installAssistant(e: Editor) {
  registerPanel(
    lazyPanel(
      {
        id: 'assistant',
        title: 'Assistant',
        icon: 'assistant',
        location: 'strip',
        menu: () => ['assistant.ask', 'assistant.clear', '-', { label: 'Model', id: 'assistant.models', items: ASSISTANT_MODELS.map((m) => `assistant.model-${m.id}`) }, 'assistant.see-image'],
      },
      lazy(async () => {
        const m = await panel();
        return { mount: m.mountAssistant, update: m.updateAssistant };
      }),
    ),
  );
  registerCommand(
    {
      id: 'assistant.ask',
      label: 'Describe an Edit…',
      shortcut: 'Mod+Alt+Shift+D',
      recordable: false,
      description: 'Describe a change in words; the Assistant plans it with real commands for you to review and run (Puter AI).',
      run: (ed, arg) => openAssistant(ed, arg && typeof arg === 'object' && typeof (arg as { prompt?: unknown }).prompt === 'string' ? (arg as { prompt: string }).prompt : undefined),
      prefetch: panel.prefetch,
    },
    {
      id: 'assistant.clear',
      label: 'Clear Conversation',
      recordable: false,
      description: 'Forget the Assistant conversation of this document',
      run: async (ed) => (await controller()).clearConversation(ed),
    },
    {
      id: 'assistant.see-image',
      label: 'Share Image Preview',
      recordable: false,
      description: 'Send a small preview of the visible image with each request, so the Assistant can see it',
      checked: () => assistantSettings.seeImage,
      run: (ed) => {
        assistantSettings.seeImage = !assistantSettings.seeImage;
        saveAssistantSettings();
        ed.dock?.update();
      },
    },
    ...ASSISTANT_MODELS.map((m) => ({
      id: `assistant.model-${m.id}`,
      label: `${m.label} (${m.note})`,
      recordable: false,
      description: `Use ${m.label} for the Assistant`,
      checked: () => assistantSettings.model === m.id,
      run: (ed: Editor) => {
        assistantSettings.model = m.id;
        saveAssistantSettings();
        ed.dock?.update();
        ed.message(`The Assistant now uses ${m.label}.`);
      },
    })),
  );
  // Listed directly in the Window menu (next to Scripts) rather than in Window → Panels.
  for (const [id, title] of [['assistant', 'Assistant'], ['generations', 'Generation History']])
    registerCommand({ id: `window.panel.${id}`, label: title, recordable: false, checked: (ed) => !!ed.dock?.isVisible(id), run: (ed) => ed.dock.show(id, true) });
  contributeMenu('edit', ['assistant.ask'], 'edit.edit-with-prompt');
  contributeMenu('window', ['window.panel.assistant', 'window.panel.generations'], 'window.panel.scripts');
  // A closed document's conversation goes with it.
  e.closeHooks.push((s) => controller.loaded?.forgetSession(s.id));
}
