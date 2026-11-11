// The AI assistant docked at the right of the window, beside the workspace.
// It stays across workspace switches; the topbar button, Window › AI Assistant
// and F3 search ("Toggle AI Assistant") show and hide it.
import './assistant.css';
import { app, registerOperators } from '../app/app';
import { shell } from '../ui/shell';
import { AssistantPanel } from './panel';

const STATE_KEY = 'p3d:assistant-dock';
const MIN_WIDTH = 300;
const MAX_WIDTH = 720;
/** The workspace keeps at least this much beside the docked assistant when it opens by itself. */
const NARROW_WORKSPACE = 500;

let panel: AssistantPanel | null = null;
let dock: HTMLElement | null = null;
let width = 380;

function load(): { open?: boolean; width?: number } {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as { open?: boolean; width?: number };
  } catch {
    return {};
  }
}

function save() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ open: assistantOpen(), width }));
  } catch {
    /* the dock state is optional */
  }
}

const clampWidth = (w: number) => Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w, window.innerWidth - 320)));

export const assistantOpen = () => !!dock && !dock.hidden;

/** The panel, once the assistant has been opened (tests drive it through this). */
export const assistantPanel = () => panel;

function create(root: HTMLElement) {
  panel = new AssistantPanel(() => toggleAssistant(false));
  const handle = document.createElement('div');
  handle.className = 'as-resize';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize the assistant');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => {
      width = clampWidth(startW + startX - ev.clientX);
      setWidth(root, width);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  dock = document.createElement('div');
  dock.className = 'assistant-dock';
  dock.hidden = true;
  dock.append(handle, panel.el);
  root.append(dock);
  // A narrower window (a phone turned, a window dragged smaller) gets a narrower panel, never one past its edge;
  // widened again, the panel goes back to the width the user gave it.
  window.addEventListener('resize', () => {
    if (assistantOpen() && root.style.getPropertyValue('--assistant-w') !== `${clampWidth(width)}px`) setWidth(root, clampWidth(width), true, false);
  });
}

/**
 * Gives the dock its width; the screen's main editors give or take the room, so side editors keep their size
 * (unless the window resized: then every editor scales with it, and returns to its size when the window does).
 */
function setWidth(root: HTMLElement, w: number, open = true, keepSides = true) {
  const screen = shell?.screen;
  const before = screen?.el.clientWidth ?? 0;
  if (dock) dock.hidden = !open;
  root.style.setProperty('--assistant-w', `${w}px`);
  root.classList.toggle('with-assistant', open);
  if (screen && before) screen.setDock(open ? w : 0, keepSides ? before : screen.el.clientWidth);
}

/** Show or hide the assistant (toggles without an argument). Opening it from a click puts the cursor in its message box. */
export function toggleAssistant(open = !assistantOpen(), focus = true) {
  const root = document.querySelector<HTMLElement>('.shell');
  if (!root) return;
  if (!dock) create(root);
  setWidth(root, clampWidth(width), open);
  if (open && focus) panel!.focus();
  save();
  app.changed('ui');
}

/** Opens the assistant at startup: open by default, then as the user last left it. */
export function restoreAssistant() {
  const s = load();
  if (typeof s.width === 'number' && Number.isFinite(s.width)) width = s.width;
  // Shown without taking the keyboard, so viewport shortcuts work straight away. A narrow window
  // (a phone) starts with it closed: docked, it would leave the workspace a sliver; the topbar
  // button still opens it.
  if (s.open !== false && window.innerWidth >= MIN_WIDTH + NARROW_WORKSPACE) toggleAssistant(true, false);
}

registerOperators([
  {
    idname: 'wm.assistant_toggle',
    label: 'Toggle AI Assistant',
    description: 'Show or hide the AI assistant, which builds and changes the scene from a description',
    undo: false,
    exec: () => toggleAssistant(),
  },
]);
