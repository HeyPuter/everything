// View → Quick Compare: a before/after view of the active document against
// the state it opened in, its last save, a History snapshot or a history
// state. Split with a draggable divider, side by side, or press and hold.
// The view loads on first use; this module only registers the command and
// the spring-loaded \ key (tap to toggle, hold to peek).
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import { lazy } from '../../app/lazy';
import type { DocumentSession } from '../../app/session';
import { compareActive } from './state';

const view = lazy(() => import('./compare'));
// A held \ key turns a comparison it started off again when released.
const PEEK_MS = 400;

export function installQuickCompare(e: Editor) {
  // A peek whose key came up before the view had loaded (first use): the
  // comparison it turns on ends as soon as it starts.
  let endedPeek: DocumentSession | undefined;
  let loading = false;
  registerCommand({
    id: 'view.quick-compare',
    label: 'Quick Compare',
    shortcut: '\\',
    recordable: false,
    enabled: (e) => e.hasDocument,
    checked: (e) => compareActive(e),
    description:
      'Compare the image with the state it was opened in, its last save, a snapshot or a history state (hold \\ to peek)',
    prefetch: view.prefetch,
    run: async (e, arg) => {
      loading = !view.loaded;
      const m = await view().finally(() => (loading = false));
      const shown = m.quickCompare(e, arg);
      if (endedPeek && endedPeek === e.session && compareActive(e)) m.exitCompare(e);
      endedPeek = undefined;
      await shown;
    },
  });
  let pressed: { at: number; wasOn: boolean } | undefined;
  const plainBackslash = (ev: KeyboardEvent) =>
    // Matched by key position, as the editor matches shortcuts.
    (ev.code === 'Backslash' || ev.key === '\\') &&
    !ev.shiftKey &&
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
      endedPeek = undefined;
    },
    true,
  );
  window.addEventListener('keyup', (ev) => {
    if ((ev.code !== 'Backslash' && ev.key !== '\\') || !pressed) return;
    const { at, wasOn } = pressed;
    pressed = undefined;
    if (wasOn || performance.now() - at <= PEEK_MS) return;
    if (loading) endedPeek = e.session;
    else if (compareActive(e)) view.loaded?.exitCompare(e);
  });
}
