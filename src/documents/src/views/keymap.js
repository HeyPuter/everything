import { IS_MAC, isComposing, shortcutCode, typesCharacter } from '../ui/dom.js';
import { localStore } from '../lib/storage.js';

/**
 * Keyboard bindings: chords written in a portable form ("Mod+Shift+C", where Mod is Cmd on a Mac and
 * Ctrl elsewhere), the default chords of the chrome's own commands, and the user's own bindings from
 * Customize Keyboard, kept in this browser. A user binding names a command by its id in the command
 * index (a ribbon button or a menu item), so any command can get a key.
 */

export const KEYMAP_STORE = 'documents:keybindings';
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'OS', 'Hyper', 'Super']);
const NAMED = { Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=', Space: 'Space' };

/** The key part of a chord: letters as the layout labels them (shortcutCode), digits by their physical key, so Shift or Option never changes them. */
function keyName(e) {
  const code = e.code || '', letter = /^Key([A-Z])$/.exec(shortcutCode(e))?.[1];
  if (letter) return letter;
  if (/^Key[A-Z]$/.test(code)) return null;
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (NAMED[code]) return code === 'Space' ? 'Space' : code;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) return e.key;
  if (['Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key)) return e.key;
  return null;
}

/** "Mod+Alt+Shift+K" for a keydown, or null for a lone modifier or a key chords cannot use. */
export function chordOf(e, mac = IS_MAC) {
  if (!e || MODIFIER_KEYS.has(e.key)) return null;
  const key = keyName(e);
  if (!key) return null;
  const parts = [];
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push('Mod');
  if (mac && e.ctrlKey) parts.push('Ctrl');
  if (!mac && e.metaKey) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/**
 * Chords the browser (or the system) keeps for itself, which never reach the page: Ctrl+N, Ctrl+T, Ctrl+W (and with
 * Shift) open and close windows and tabs on Windows and Linux, as do Cmd+N, T, W and Cmd+Q, H, M on a Mac; Ctrl+F4,
 * Alt+F4 and Ctrl+Tab close and switch tabs. On a Mac the Control forms (Ctrl+T) are free.
 */
export function browserReserved(chord, mac = IS_MAC) {
  if (!chord) return false;
  const parts = chord.split('+'), key = parts.at(-1).toUpperCase(), mods = parts.slice(0, -1).sort().join('+');
  if ((mods === 'Mod' || mods === 'Mod+Shift') && ['N', 'T', 'W', 'TAB'].includes(key)) return true;
  if (mac) return mods === 'Mod' && ['Q', 'H', 'M'].includes(key);
  return (mods === 'Mod' || mods === 'Alt') && key === 'F4';
}

/** browserReserved for a chord as menus and tooltips show it ("Ctrl+Shift+W", "Ctrl + T", "Cmd+Option+K"). */
export function displayedChordReserved(text, mac = IS_MAC) {
  const names = { cmd: 'Mod', ctrl: mac ? 'Ctrl' : 'Mod', control: mac ? 'Ctrl' : 'Mod', option: 'Alt', alt: 'Alt', shift: 'Shift', meta: mac ? 'Mod' : 'Meta' };
  const parts = String(text || '').split('+').map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  return browserReserved([...parts.slice(0, -1).map(part => names[part.toLowerCase()] || part), parts.at(-1)].join('+'), mac);
}

/** Whether a chord can be bound: it needs a modifier, unless it is a function key, and the browser must let the page have it. */
export function bindable(chord, mac = IS_MAC) {
  if (!chord || browserReserved(chord, mac)) return false;
  const parts = chord.split('+'), key = parts.at(-1);
  if (/^F\d+$/.test(key)) return true;
  if (['Escape', 'Tab', 'Enter', 'Backspace', 'Delete'].includes(key) && parts.length === 1) return false;
  return parts.some(p => ['Mod', 'Ctrl', 'Alt', 'Meta'].includes(p));
}

/** How a chord reads in menus and tooltips on this platform. */
export function displayChord(chord, mac = IS_MAC) {
  if (!chord) return '';
  return chord.split('+').map(part => part === 'Mod' ? (mac ? 'Cmd' : 'Ctrl') : part === 'Alt' && mac ? 'Option' : NAMED[part] || ({ ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' })[part] || part).join('+');
}

export function loadBindings(storage = localStore(), mac = IS_MAC) {
  try {
    const value = JSON.parse(storage?.getItem(KEYMAP_STORE) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, chords]) => typeof id === 'string' && Array.isArray(chords)).map(([id, chords]) => [id, chords.filter(c => typeof c === 'string' && bindable(c, mac))]));
  } catch { return {}; }
}

export function saveBindings(bindings, storage = localStore()) {
  try {
    const clean = Object.fromEntries(Object.entries(bindings).filter(([, chords]) => Array.isArray(chords)));
    if (Object.keys(clean).length) storage?.setItem(KEYMAP_STORE, JSON.stringify(clean)); else storage?.removeItem(KEYMAP_STORE);
  } catch { /* storage unavailable: bindings last for this visit */ }
}

/**
 * The keymap. `defaults` maps a command id to its default chords (the chrome's own commands); `run(id)`
 * runs a command by id and returns false when it is unavailable. User bindings replace a command's
 * defaults; an empty list removes them. One chord belongs to one command: binding it elsewhere moves it.
 */
export function createKeymap({ defaults = {}, run, storage = localStore(), mac = IS_MAC, signal }) {
  let user = loadBindings(storage, mac);
  const listeners = new Set();
  // Every tab of the app shares the bindings. Another tab's change applies here at once, and a change made here
  // starts from what is stored, so it never puts back the bindings another tab has since changed.
  const reload = () => { user = loadBindings(storage, mac); };
  globalThis.addEventListener?.('storage', e => {
    if (e.key !== null && e.key !== KEYMAP_STORE || e.storageArea && e.storageArea !== storage) return;
    reload(); for (const fn of listeners) fn();
  }, { signal });
  const chordsFor = id => user[id] ?? defaults[id] ?? [];
  function table() {
    const map = new Map();
    for (const id of new Set([...Object.keys(defaults), ...Object.keys(user)])) for (const chord of chordsFor(id)) if (!map.has(chord)) map.set(chord, id);
    return map;
  }
  const changed = () => { saveBindings(user, storage); for (const fn of listeners) fn(); };
  return {
    chordsFor,
    /** The first chord of a command, as it reads here, or null. */
    shortcutFor: id => { const chord = chordsFor(id)[0]; return chord ? displayChord(chord, mac) : null; },
    /** Which command a chord runs, or null. */
    commandFor: chord => table().get(chord) || null,
    get custom() { return { ...user }; },
    isCustom: id => Object.hasOwn(user, id),
    assign(id, chord) {
      if (!bindable(chord, mac)) return false;
      reload();
      // The chord leaves whichever command had it.
      for (const other of new Set([...Object.keys(defaults), ...Object.keys(user)])) {
        if (other !== id && chordsFor(other).includes(chord)) user[other] = chordsFor(other).filter(c => c !== chord);
      }
      user[id] = [...chordsFor(id).filter(c => c !== chord), chord];
      changed(); return true;
    },
    remove(id, chord) { reload(); user[id] = chordsFor(id).filter(c => c !== chord); changed(); },
    reset(id) { reload(); if (id) delete user[id]; else user = {}; changed(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Run the command bound to this keydown; true when one ran. */
    handle(e) {
      if (e.defaultPrevented || isComposing(e) || typesCharacter(e, mac) || e.repeat && !/^F\d/.test(e.key)) return false;
      const chord = chordOf(e, mac);
      if (!chord) return false;
      const id = table().get(chord);
      if (!id) return false;
      if (run(id, e) === false) return false;
      e.preventDefault(); e.stopPropagation();
      return true;
    },
  };
}

/**
 * The shortcuts a command shows (in its tooltip, menu item and aria-keyshortcuts), as this platform writes them:
 * its built-in one (`builtIn`, as shown) unless a shortcut of your own on another command has taken it, then your own.
 */
export function shownShortcuts(keymap, id, builtIn, mac = IS_MAC) {
  const own = keymap.chordsFor(id).map(chord => displayChord(chord, mac));
  const taken = !!builtIn && Object.entries(keymap.custom).some(([other, chords]) => other !== id && chords.some(chord => displayChord(chord, mac).toLowerCase() === builtIn.toLowerCase()));
  return [...new Set([...(builtIn && !taken ? [builtIn] : []), ...own])];
}
