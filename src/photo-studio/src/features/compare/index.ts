// View → Quick Compare: a before/after view of the active document against
// the state it opened in, its last save, a History snapshot or a history
// state. Split with a draggable divider, side by side, or press and hold.
// The view loads on first use; this module only registers the command and
// the spring-loaded \ key (tap to toggle, hold to peek).
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import { lazy, lazyRun } from '../../app/lazy';
import { compareActive } from './state';

const view = lazy(() => import('./compare'));
// A held \ key turns a comparison it started off again when released.
const PEEK_MS = 400;

export function installQuickCompare(e: Editor) {
  registerCommand({
    id: 'view.quick-compare',
    label: 'Quick Compare',
    shortcut: '\\',
    recordable: false,
    enabled: (e) => e.hasDocument,
    checked: (e) => compareActive(e),
    description:
      'Compare the image with the state it was opened in, its last save, a snapshot or a history state (hold \\ to peek)',
    ...lazyRun(view, (m, e, arg) => m.quickCompare(e, arg)),
  });
  let pressed: { at: number; wasOn: boolean } | undefined;
  const plainBackslash = (ev: KeyboardEvent) =>
    ev.key === '\\' &&
    !ev.metaKey &&
    !ev.ctrlKey &&
    !ev.altKey &&
    !(ev.target as HTMLElement | null)?.closest?.(
      'input,textarea,select,[contenteditable="true"],dialog',
    );
  window.addEventListener(
    'keydown',
    (ev) => {
      if (!plainBackslash(ev)) return;
      // Key repeat would toggle the view on and off while the key is held.
      if (ev.repeat) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        return;
      }
      pressed = { at: performance.now(), wasOn: compareActive(e) };
    },
    true,
  );
  window.addEventListener('keyup', (ev) => {
    if (ev.key !== '\\' || !pressed) return;
    const { at, wasOn } = pressed;
    pressed = undefined;
    if (!wasOn && compareActive(e) && performance.now() - at > PEEK_MS) view.loaded?.exitCompare(e);
  });
}
