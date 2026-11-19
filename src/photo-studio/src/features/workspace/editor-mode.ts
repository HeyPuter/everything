// Assisted and Pro editor modes. Assisted opens the Assistant, turns on the
// quick actions bar and shows the essential tools (the others stay in the
// Extra Tools flyout and keep their shortcuts); Pro brings back the
// workspace exactly as it was before Assisted was chosen. The choice is a
// preference; a two-part switch at the start of the options bar changes it
// and Window › Editor Mode shows or hides that switch.
import type { Editor } from '../../editor';
import { contributeMenu, registerCommand } from '../../app/registry';
import { setSimplifiedSlots } from '../../app/toolbar-layout';
import { svg } from '../../app/icons';
import type { DockLayout } from '../../app/dock';
import { setTaskbarVisible, taskbarVisible } from '../retouch/taskbar';

export type EditorMode = 'pro' | 'assisted';
/** Toolbar slots shown in Assisted mode. */
export const ASSISTED_SLOTS = [
  'move',
  'marquee',
  'lasso',
  'select',
  'crop',
  'heal',
  'brush',
  'eraser',
  'type',
  'hand',
  'zoom',
];
const proKey = 'photo-studio-pro-workspace';
// What Pro returns to: the arrangement and toggles before Assisted.
export type ProSnapshot = { dock: DockLayout; taskbar: boolean; assistant: boolean };

function loadSnapshot(): ProSnapshot | null {
  try {
    const v = JSON.parse(localStorage.getItem(proKey) ?? 'null') as ProSnapshot | null;
    return v && typeof v === 'object' && v.dock && typeof v.taskbar === 'boolean' ? v : null;
  } catch {
    return null;
  }
}
function storeSnapshot(s: ProSnapshot | null) {
  try {
    if (s) localStorage.setItem(proKey, JSON.stringify(s));
    else localStorage.removeItem(proKey);
  } catch {
    /* The snapshot then lasts until the page closes. */
  }
}

export function installEditorMode(e: Editor) {
  let applied: EditorMode = 'pro';
  let memory: ProSnapshot | null = loadSnapshot();
  const sw = document.createElement('div');
  sw.className = 'mode-switch';
  sw.setAttribute('role', 'radiogroup');
  sw.setAttribute('aria-label', 'Editor mode');
  sw.innerHTML =
    `<button type="button" role="radio" data-mode="assisted" title="Assisted: the Assistant, quick actions and the essential tools">${svg('sparkles', 14)}<span>Assisted</span></button>` +
    `<button type="button" role="radio" data-mode="pro" title="Pro: the full workspace">${svg('sliders-horizontal', 14)}<span>Pro</span></button>`;
  const buttons = [...sw.querySelectorAll<HTMLButtonElement>('button')];
  const paint = () => {
    for (const b of buttons) {
      const on = b.dataset.mode === applied;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    sw.hidden = !e.preferences.showModeSwitch;
    e.root.classList.toggle('mode-switch-hidden', sw.hidden);
  };
  sw.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
    if (b) setMode(b.dataset.mode as EditorMode);
  });
  sw.addEventListener('keydown', (ev) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(ev.key))
      return;
    ev.preventDefault();
    const next: EditorMode =
      ev.key === 'Home'
        ? 'assisted'
        : ev.key === 'End'
          ? 'pro'
          : applied === 'pro'
            ? 'assisted'
            : 'pro';
    setMode(next);
    buttons.find((b) => b.dataset.mode === next)?.focus();
  });
  const bar = e.root.querySelector('.optionsbar');
  bar?.insertBefore(sw, bar.firstChild);

  /** Bring the workspace into a mode (without storing the preference). */
  const apply = (mode: EditorMode, first = false) => {
    if (mode === applied && !first) return paint();
    const dock = e.dock;
    if (mode === 'assisted') {
      // Remember Pro's arrangement once (a reload in Assisted keeps it).
      if (!first || !memory) {
        memory = {
          dock: dock.getLayout(),
          taskbar: taskbarVisible(),
          assistant: dock.isVisible('assistant'),
        };
        storeSnapshot(memory);
      }
      setSimplifiedSlots(ASSISTED_SLOTS);
      setTaskbarVisible(true);
      if (!dock.isVisible('assistant')) dock.show('assistant');
    } else {
      setSimplifiedSlots(null);
      if (memory) {
        dock.setLayout(memory.dock);
        setTaskbarVisible(memory.taskbar);
        if (!memory.assistant && dock.isVisible('assistant')) dock.show('assistant', true);
      }
      memory = null;
      storeSnapshot(null);
    }
    applied = mode;
    e.root.classList.toggle('assisted-mode', mode === 'assisted');
    e.toolbar.render();
    paint();
    // The canvas area may have changed size.
    window.dispatchEvent(new Event('resize'));
  };
  const setMode = (mode: EditorMode) => {
    if (mode === applied) return;
    e.preferences.editorMode = mode;
    e.savePreferences();
    apply(mode);
    e.update();
    e.message(
      mode === 'assisted'
        ? 'Assisted mode: the Assistant, quick actions and the essential tools. Switch back to Pro at any time.'
        : 'Pro mode: the full workspace is back.',
    );
  };
  // Changes from the Preferences window.
  e.preferenceHooks.push(() => apply(e.preferences.editorMode === 'assisted' ? 'assisted' : 'pro'));

  registerCommand(
    {
      id: 'window.mode-assisted',
      label: 'Assisted',
      recordable: false,
      description: 'Open the Assistant and the quick actions bar and show the essential tools',
      checked: () => applied === 'assisted',
      run: () => setMode('assisted'),
    },
    {
      id: 'window.mode-pro',
      label: 'Pro',
      recordable: false,
      description: 'The full workspace, as it was before Assisted mode',
      checked: () => applied === 'pro',
      run: () => setMode('pro'),
    },
    {
      id: 'window.mode-switch',
      label: 'Show Mode Switch',
      recordable: false,
      description: 'Show or hide the Assisted/Pro switch at the start of the options bar',
      checked: (ed) => ed.preferences.showModeSwitch,
      run: (ed) => {
        ed.preferences.showModeSwitch = !ed.preferences.showModeSwitch;
        ed.savePreferences();
        paint();
        ed.update();
      },
    },
  );
  contributeMenu(
    'window',
    [
      {
        label: 'Editor Mode',
        id: 'window.editor-mode',
        items: ['window.mode-assisted', 'window.mode-pro', '-', 'window.mode-switch'],
      },
    ],
    'window.contextual-taskbar',
  );

  // The dock exists once the workspace chrome is built.
  const attach = () => {
    if (!e.dock || !e.toolbar) {
      requestAnimationFrame(attach);
      return;
    }
    if (e.preferences.editorMode === 'assisted') apply('assisted', true);
    else paint();
  };
  paint();
  queueMicrotask(attach);
}
