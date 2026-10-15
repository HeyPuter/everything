// Keyboard helpers for editors with text input (Text Editor, Console): their own keymap
// is consulted first, and window-level shortcuts (F3, Ctrl S, Ctrl ,) keep working while typing.
import { app, type AreaLike } from '../app/app';
import { keymaps, keyName, type KeyItem } from '../app/keymap';

export function keyMatches(k: KeyItem, name: string, e: KeyboardEvent) {
  if (k.key !== name || k.inactive || (k.value ?? 'PRESS') !== 'PRESS') return false;
  if (k.any) return true;
  return !!k.shift === e.shiftKey && !!k.ctrl === (e.ctrlKey || e.metaKey) && !!k.alt === e.altKey;
}

/** Keys that belong to text editing and never trigger window shortcuts from a text field. */
const TEXT_KEYS = new Set(['Z', 'Y', 'A', 'C', 'V', 'X', 'L', 'LEFT_ARROW', 'RIGHT_ARROW', 'UP_ARROW', 'DOWN_ARROW', 'HOME', 'END', 'BACK_SPACE', 'DEL']);

/** Run the first matching binding from `keymapNames` (plus window shortcuts); returns true when handled. */
export function dispatchEditorKeys(e: KeyboardEvent, area: AreaLike, keymapNames: string[], before?: () => void): boolean {
  const name = keyName(e);
  for (const km of keymapNames) {
    for (const k of keymaps[km] ?? []) {
      if (!keyMatches(k, name, e) || !k.op || !app.poll(k.op, area)) continue;
      e.preventDefault();
      before?.();
      app.run(k.op, k.props ?? {}, { area, event: { x: app.pointer.x, y: app.pointer.y } });
      return true;
    }
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (!/^F\d+$/.test(name) && !ctrl) return false;
  if (ctrl && TEXT_KEYS.has(name)) return false;
  for (const km of ['Window', 'Screen']) {
    for (const k of keymaps[km] ?? []) {
      if (!keyMatches(k, name, e) || !k.op || !app.poll(k.op, area)) continue;
      e.preventDefault();
      before?.();
      app.run(k.op, k.props ?? {}, { area, event: { x: app.pointer.x, y: app.pointer.y } });
      return true;
    }
  }
  return false;
}

/**
 * Keyboard focus follows the mouse: when the pointer is over
 * another area, keys typed while a text field of this editor has focus go to that area instead.
 */
export function redirectIfElsewhere(e: KeyboardEvent, area: AreaLike, field: HTMLElement): boolean {
  const hover = app.hoverArea;
  if (!hover || hover === area || e.isComposing) return false;
  if ((e as KeyboardEvent & { __redirected?: boolean }).__redirected) return false;
  e.preventDefault();
  field.blur();
  const copy = new KeyboardEvent('keydown', { key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat, bubbles: true, cancelable: true });
  (copy as KeyboardEvent & { __redirected?: boolean }).__redirected = true;
  window.dispatchEvent(copy);
  return true;
}
