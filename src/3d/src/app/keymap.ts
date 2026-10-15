// Keymaps (default left-click-select layout) and the global keyboard dispatcher.
import { app } from './app';
import { prefs } from './prefs';
import { menuKey, pieOpen, openMenu, type MenuItem } from '../ui/menu';

export interface KeyItem {
  key: string; // e.g. 'A', 'NUMPAD_1', 'TAB'
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  /** match regardless of modifiers */
  any?: boolean;
  op?: string;
  props?: Record<string, unknown>;
  /** open a menu builder instead of an operator */
  menu?: () => MenuItem[];
  menuTitle?: string;
  /** run a UI action (e.g. open a pie menu) instead of an operator */
  action?: () => void;
  /** only when this predicate holds */
  when?: () => boolean;
}

export const keymaps: Record<string, KeyItem[]> = {};

/** Modes that consume raw key input (e.g. text editing in the 3D view) before keymaps run. */
export const keyInputHooks: ((e: KeyboardEvent) => boolean)[] = [];

export function addKeys(name: string, items: KeyItem[]) {
  (keymaps[name] ??= []).push(...items);
}

const CODE_MAP: Record<string, string> = {
  Tab: 'TAB',
  Space: 'SPACE',
  Delete: 'DEL',
  Backspace: 'BACK_SPACE',
  Escape: 'ESC',
  Enter: 'RET',
  NumpadEnter: 'NUMPAD_ENTER',
  Home: 'HOME',
  End: 'END',
  PageUp: 'PAGE_UP',
  PageDown: 'PAGE_DOWN',
  Backquote: 'ACCENT_GRAVE',
  Period: 'PERIOD',
  Comma: 'COMMA',
  Slash: 'SLASH',
  Backslash: 'BACK_SLASH',
  Minus: 'MINUS',
  Equal: 'EQUAL',
  BracketLeft: 'LEFT_BRACKET',
  BracketRight: 'RIGHT_BRACKET',
  Semicolon: 'SEMI_COLON',
  Quote: 'QUOTE',
  ArrowLeft: 'LEFT_ARROW',
  ArrowRight: 'RIGHT_ARROW',
  ArrowUp: 'UP_ARROW',
  ArrowDown: 'DOWN_ARROW',
  NumpadDecimal: 'NUMPAD_PERIOD',
  NumpadAdd: 'NUMPAD_PLUS',
  NumpadSubtract: 'NUMPAD_MINUS',
  NumpadMultiply: 'NUMPAD_ASTERIX',
  NumpadDivide: 'NUMPAD_SLASH',
};
const DIGITS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];

export function keyName(e: KeyboardEvent): string {
  const c = e.code;
  if (c.startsWith('Key')) return c.slice(3);
  if (c.startsWith('Digit')) return DIGITS[Number(c.slice(5))];
  if (c.startsWith('Numpad') && /\d$/.test(c)) return `NUMPAD_${c.slice(6)}`;
  if (/^F\d+$/.test(c)) return c;
  return CODE_MAP[c] ?? c.toUpperCase();
}

const NICE: Record<string, string> = {
  TAB: 'Tab',
  SPACE: 'Space',
  DEL: 'Delete',
  BACK_SPACE: 'Backspace',
  ESC: 'Esc',
  RET: 'Enter',
  HOME: 'Home',
  ACCENT_GRAVE: '`',
  PERIOD: '.',
  COMMA: ',',
  LEFT_BRACKET: '[',
  RIGHT_BRACKET: ']',
  LEFT_ARROW: '←',
  RIGHT_ARROW: '→',
  UP_ARROW: '↑',
  DOWN_ARROW: '↓',
  PAGE_UP: 'Page Up',
  PAGE_DOWN: 'Page Down',
  NUMPAD_PERIOD: 'Numpad .',
  NUMPAD_PLUS: 'Numpad +',
  NUMPAD_MINUS: 'Numpad -',
  NUMPAD_SLASH: 'Numpad /',
  NUMPAD_ASTERIX: 'Numpad *',
};

export function keyLabel(k: KeyItem) {
  const mods = [k.ctrl ? 'Ctrl' : '', k.shift ? 'Shift' : '', k.alt ? 'Alt' : ''].filter(Boolean);
  let name = NICE[k.key] ?? k.key;
  if (k.key.startsWith('NUMPAD_') && !NICE[k.key]) name = `Numpad ${k.key.slice(7)}`;
  if (DIGITS.includes(k.key)) name = String(DIGITS.indexOf(k.key));
  return [...mods, name].join(' ');
}

/** Shortcut label for an operator (first binding found). */
export function shortcutLabel(idname: string, props?: Record<string, unknown>): string {
  for (const items of Object.values(keymaps))
    for (const k of items) if (k.op === idname && (!props || Object.entries(props).every(([p, v]) => k.props?.[p] === v))) return keyLabel(k);
  return '';
}

function matches(k: KeyItem, name: string, e: KeyboardEvent) {
  if (k.key !== name) return false;
  if (k.any) return true;
  const ctrl = e.ctrlKey || e.metaKey;
  return !!k.shift === e.shiftKey && !!k.ctrl === ctrl && !!k.alt === e.altKey;
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || !!t.closest?.('.cm-editor, .text-editor-input'));
}

/** Install the global key handler. Area editors expose `keymaps` (names in priority order). */
export function installKeyboard() {
  addEventListener(
    'keydown',
    (e) => {
      // Modal operators capture everything
      if (app.modal) {
        const r = app.modal.onKey?.(e);
        if (r === 'FINISHED' || r === 'CANCELLED') app.endModal(r);
        if (r !== false) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (pieOpen()) return;
      if (menuKey(e)) {
        e.preventDefault();
        return;
      }
      if (isTyping(e)) return;
      for (const hk of keyInputHooks)
        if (hk(e)) {
          e.preventDefault();
          return;
        }
      const area = app.hoverArea ?? app.activeArea;
      const editor = area?.editor as { keymaps?: string[]; onKey?(e: KeyboardEvent): boolean } | undefined;
      if (editor?.onKey?.(e)) {
        e.preventDefault();
        return;
      }
      let name = keyName(e);
      // laptop numpad emulation: number row acts as numpad in the 3D view
      if (prefs.emulate_numpad && DIGITS.includes(name) && area?.type === 'VIEW_3D' && app.doc.mode !== 'EDIT') name = `NUMPAD_${DIGITS.indexOf(name)}`;
      const names = [...(editor?.keymaps ?? []), 'Frames', 'Screen', 'Window'];
      const seen = new Set<string>();
      for (const km of names) {
        if (seen.has(km)) continue;
        seen.add(km);
        for (const k of keymaps[km] ?? []) {
          if (!matches(k, name, e)) continue;
          if (k.when && !k.when()) continue;
          if (k.action) {
            e.preventDefault();
            k.action();
            return;
          }
          if (k.menu) {
            e.preventDefault();
            openMenu(k.menu(), { x: app.pointer.x, y: app.pointer.y }, { title: k.menuTitle });
            return;
          }
          if (!k.op) continue;
          // a frame change may still be waiting for the next animation frame: evaluate it first
          app.flushPending();
          if (!app.poll(k.op, area)) continue;
          e.preventDefault();
          app.run(k.op, k.props ?? {}, { area, event: { x: app.pointer.x, y: app.pointer.y } });
          return;
        }
      }
      // keep browser shortcuts from stealing editor keys
      if ((e.ctrlKey || e.metaKey) && ['S', 'O', 'N', 'Z', 'Y', 'A', 'D', 'G', 'J', 'P', 'L'].includes(name)) e.preventDefault();
      if (name === 'TAB' || name === 'SPACE' || name === 'F3' || name === 'F12' || name === 'F11') e.preventDefault();
    },
    true,
  );
  addEventListener(
    'keyup',
    (e) => {
      if (app.modal) {
        const r = app.modal.onKey?.(e);
        if (r === 'FINISHED' || r === 'CANCELLED') app.endModal(r);
      }
    },
    true,
  );
  addEventListener(
    'pointermove',
    (e) => {
      app.pointer = { x: e.clientX, y: e.clientY };
      if (app.modal?.onPointerMove) app.modal.onPointerMove(e);
    },
    true,
  );
  addEventListener(
    'pointerdown',
    (e) => {
      if (!app.modal) return;
      // modal pointer clicks are handled by the editor under the pointer, or here as fallback
      const inArea = (e.target as HTMLElement).closest?.('.area-main');
      if (inArea && (e.target as HTMLElement).closest('.view3d')) return;
      const r = app.modal.onPointerDown?.(e);
      if (r) {
        e.preventDefault();
        e.stopPropagation();
        app.endModal(r);
      }
    },
    true,
  );
  addEventListener(
    'pointerup',
    (e) => {
      if (!app.modal) return;
      const r = app.modal.onPointerUp?.(e);
      if (r) app.endModal(r);
    },
    true,
  );
}
