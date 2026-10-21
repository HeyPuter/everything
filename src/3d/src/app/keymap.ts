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
  /** the popup menu gets a search row (typing searches its entries) */
  menuSearch?: boolean;
  /** run a UI action (e.g. open a pie menu) instead of an operator */
  action?: () => void;
  /** only when this predicate holds */
  when?: () => boolean;
  /** key event that triggers the item (default PRESS) */
  value?: KeyValue;
  /** false: ignore auto-repeated key presses */
  repeat?: boolean;
  /** disabled in Preferences ▸ Keymap */
  inactive?: boolean;
}

export type KeyValue = 'PRESS' | 'RELEASE' | 'CLICK' | 'DOUBLE_CLICK';

/** Timing used by the dispatcher (milliseconds); Preferences ▸ Input sets it. */
export const keyTiming = { doubleClick: 350 };

/** Called when items are added after startup (Preferences ▸ Keymap keeps user edits applied). */
export const keymapHooks: { added?: (name: string, items: KeyItem[]) => void } = {};

export const keymaps: Record<string, KeyItem[]> = {};

/** Modes that consume raw key input (e.g. text editing in the 3D view) before keymaps run. */
export const keyInputHooks: ((e: KeyboardEvent) => boolean)[] = [];

/** Keymaps added for an area after its editor's own ones (e.g. the shared View2D navigation). */
export const areaKeymapHooks: ((area: unknown) => string | null)[] = [];

export function addKeys(name: string, items: KeyItem[]) {
  (keymaps[name] ??= []).push(...items);
  keymapHooks.added?.(name, items);
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
  ShiftLeft: 'LEFT_SHIFT',
  ShiftRight: 'RIGHT_SHIFT',
  ControlLeft: 'LEFT_CTRL',
  ControlRight: 'RIGHT_CTRL',
  AltLeft: 'LEFT_ALT',
  AltRight: 'RIGHT_ALT',
  MetaLeft: 'OSKEY',
  MetaRight: 'OSKEY',
  Insert: 'INSERT',
  ContextMenu: 'APP',
  MediaPlayPause: 'MEDIA_PLAY',
  MediaStop: 'MEDIA_STOP',
  MediaTrackNext: 'MEDIA_LAST',
  MediaTrackPrevious: 'MEDIA_FIRST',
};

/** Modifier keys (never bound on their own by the dispatcher's click detection). */
export const MODIFIER_KEYS = ['LEFT_SHIFT', 'RIGHT_SHIFT', 'LEFT_CTRL', 'RIGHT_CTRL', 'LEFT_ALT', 'RIGHT_ALT', 'OSKEY'];
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
  INSERT: 'Insert',
  APP: 'Menu',
  MEDIA_PLAY: 'Media Play',
  MEDIA_STOP: 'Media Stop',
  MEDIA_FIRST: 'Media Previous',
  MEDIA_LAST: 'Media Next',
  BUTTON4MOUSE: 'Mouse Back',
  BUTTON5MOUSE: 'Mouse Forward',
  WHEELUPMOUSE: 'Wheel Up',
  WHEELDOWNMOUSE: 'Wheel Down',
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
    for (const k of items) if (!k.inactive && k.op === idname && (!props || Object.entries(props).every(([p, v]) => k.props?.[p] === v))) return keyLabel(k);
  return '';
}

function matches(k: KeyItem, name: string, e: KeyboardEvent) {
  if (k.key !== name || k.inactive) return false;
  if (k.any) return true;
  const ctrl = e.ctrlKey || e.metaKey;
  return !!k.shift === e.shiftKey && !!k.ctrl === ctrl && !!k.alt === e.altKey;
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || !!t.closest?.('.cm-editor, .text-editor-input'));
}

type EditorKeys = { keymaps?: string[]; onKey?(e: KeyboardEvent): boolean };
const modsOf = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }) => (e.ctrlKey || e.metaKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0);
let lastPress: { name: string; mods: number; time: number } | null = null;
let clickCandidate: { name: string; mods: number } | null = null;
/** keys whose press reached the keymaps (only those can trigger Release items) */
const freeKeys = new Set<string>();

/** Run the first matching item of the hovered editor's keymaps for one key event value. */
function dispatch(e: KeyboardEvent, name: string, area: typeof app.activeArea, editor: EditorKeys | undefined, value: KeyValue, pressMods?: number): boolean {
  const extra: string[] = [];
  for (const f of areaKeymapHooks) {
    const n = f(area);
    if (n) extra.push(n);
  }
  const names = [...(editor?.keymaps ?? []), ...extra, 'Frames', 'Screen', 'Window'];
  const seen = new Set<string>();
  const ev = pressMods === undefined ? e : { ctrlKey: !!(pressMods & 1), metaKey: false, shiftKey: !!(pressMods & 2), altKey: !!(pressMods & 4) };
  for (const km of names) {
    if (seen.has(km)) continue;
    seen.add(km);
    for (const k of keymaps[km] ?? []) {
      if ((k.value ?? 'PRESS') !== value) continue;
      if (!matches(k, name, ev as KeyboardEvent)) continue;
      if (e.repeat && k.repeat === false) continue;
      if (k.when && !k.when()) continue;
      if (k.action) {
        e.preventDefault();
        k.action();
        return true;
      }
      if (k.menu) {
        e.preventDefault();
        openMenu(k.menu(), { x: app.pointer.x, y: app.pointer.y }, { title: k.menuTitle, search: k.menuSearch });
        return true;
      }
      if (!k.op) continue;
      // a frame change may still be waiting for the next animation frame: evaluate it first
      app.flushPending();
      if (!app.poll(k.op, area)) continue;
      e.preventDefault();
      app.run(k.op, k.props ?? {}, { area, event: { x: app.pointer.x, y: app.pointer.y } });
      return true;
    }
  }
  return false;
}

/** A wheel event from a mouse wheel (notches), not a trackpad's continuous scrolling. */
export function isWheelNotch(e: WheelEvent) {
  if (e.deltaMode === 1 || e.deltaMode === 2) return true;
  return e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50;
}

/** Keymap items bound to the mouse wheel (WHEELUPMOUSE / WHEELDOWNMOUSE) run before the editors' own wheel handling. */
function onWheel(e: WheelEvent) {
  if (app.modal || pieOpen() || !e.deltaY || !isWheelNotch(e)) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest?.('input, textarea, select, .num-field, .popup-layer, .menu')) return;
  const area = app.hoverArea ?? app.activeArea;
  const editor = area?.editor as EditorKeys | undefined;
  const name = e.deltaY < 0 ? 'WHEELUPMOUSE' : 'WHEELDOWNMOUSE';
  const ev = { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, repeat: false, preventDefault: () => e.preventDefault() } as unknown as KeyboardEvent;
  if (dispatch(ev, name, area, editor, 'PRESS')) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/** The extra mouse buttons (back / forward) run keymap items BUTTON4MOUSE / BUTTON5MOUSE. */
function onExtraButton(e: MouseEvent) {
  if (e.button !== 3 && e.button !== 4) return;
  // never let them navigate the page away
  e.preventDefault();
  if (e.type !== 'mousedown' || app.modal || pieOpen()) return;
  const area = app.hoverArea ?? app.activeArea;
  const editor = area?.editor as EditorKeys | undefined;
  const ev = { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, repeat: false, preventDefault: () => e.preventDefault() } as unknown as KeyboardEvent;
  dispatch(ev, e.button === 3 ? 'BUTTON4MOUSE' : 'BUTTON5MOUSE', area, editor, 'PRESS');
}

/** Install the global key handler. Area editors expose `keymaps` (names in priority order). */
export function installKeyboard() {
  addEventListener('wheel', onWheel, { capture: true, passive: false });
  addEventListener('mousedown', onExtraButton, true);
  addEventListener('mouseup', onExtraButton, true);
  addEventListener('auxclick', (e) => (e.button === 3 || e.button === 4) && e.preventDefault(), true);
  addEventListener(
    'keydown',
    (e) => {
      // a key handled elsewhere (modal, menus, text input, editors) never completes a click
      if (!e.repeat) clickCandidate = null;
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
      const editor = area?.editor as EditorKeys | undefined;
      if (editor?.onKey?.(e)) {
        e.preventDefault();
        return;
      }
      let name = keyName(e);
      // laptop numpad emulation: number row acts as numpad in the 3D view
      if (prefs.emulate_numpad && DIGITS.includes(name) && area?.type === 'VIEW_3D' && app.doc.mode !== 'EDIT') name = `NUMPAD_${DIGITS.indexOf(name)}`;
      const now = performance.now();
      const mods = modsOf(e);
      if (!e.repeat) {
        const dbl = !!lastPress && lastPress.name === name && lastPress.mods === mods && now - lastPress.time <= keyTiming.doubleClick;
        lastPress = dbl ? null : { name, mods, time: now };
        if (!MODIFIER_KEYS.includes(name)) clickCandidate = { name, mods };
        freeKeys.add(name);
        if (dbl && dispatch(e, name, area, editor, 'DOUBLE_CLICK')) return;
      }
      if (dispatch(e, name, area, editor, 'PRESS')) return;
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
        return;
      }
      if (pieOpen() || isTyping(e)) return;
      const area = app.hoverArea ?? app.activeArea;
      const editor = area?.editor as EditorKeys | undefined;
      let name = keyName(e);
      if (prefs.emulate_numpad && DIGITS.includes(name) && area?.type === 'VIEW_3D' && app.doc.mode !== 'EDIT') name = `NUMPAD_${DIGITS.indexOf(name)}`;
      const click = clickCandidate;
      if (MODIFIER_KEYS.includes(name)) return;
      clickCandidate = null;
      if (!freeKeys.delete(name)) return;
      if (click && click.name === name && dispatch(e, name, area, editor, 'CLICK', click.mods)) return;
      dispatch(e, name, area, editor, 'RELEASE');
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
