/**
 * Keyboard chords as text, for custom shortcuts: one spelling for a key press however it is written.
 *
 * A chord is its modifiers in a fixed order, then the key, joined by "+": "Mod+Shift+K", "Alt+F3", "F8".
 * "Mod" is the platform's command key (⌘ on a Mac, Ctrl elsewhere), so a shortcut chosen on one computer
 * means the same on another; "Ctrl" is the Control key on a Mac (beside ⌘) and "Meta" the Windows key elsewhere.
 * The key is named from the physical key where it has one (KeyK → K, Digit1 → 1), so Shift or Option
 * changing the character typed (Option+K is ˚ on a Mac) does not change the chord.
 */

const MOD_ORDER = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];

const CODE_KEYS = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backquote: '`', Space: 'Space', IntlBackslash: '\\',
  NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/', NumpadDecimal: '.', NumpadEnter: 'Enter',
};
const NAMED = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ContextMenu', 'Space']);
const ALIASES = {
  esc: 'Escape', del: 'Delete', ins: 'Insert', return: 'Enter', space: 'Space', spacebar: 'Space', ' ': 'Space',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pgup: 'PageUp', pgdn: 'PageDown',
  pageup: 'PageUp', pagedown: 'PageDown', backspace: 'Backspace', delete: 'Delete', home: 'Home', end: 'End',
  enter: 'Enter', tab: 'Tab', escape: 'Escape', menu: 'ContextMenu', plus: '+', minus: '-',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
};

const isModifierKey = (key) => ['Shift', 'Control', 'Alt', 'Meta', 'OS', 'AltGraph', 'CapsLock', 'Fn', 'Hyper', 'Super'].includes(key);

/** The key's own name in a chord, from a keydown event, or null for a modifier pressed alone. */
function keyName(e) {
  if (isModifierKey(e.key)) return null;
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  if (NAMED.has(code)) return code;
  return normalizeKey(e.key);
}

function normalizeKey(key) {
  if (key == null || key === '') return null;
  const text = String(key);
  if (ALIASES[text.toLowerCase()]) return ALIASES[text.toLowerCase()];
  if (/^f\d{1,2}$/i.test(text)) return text.toUpperCase();
  if (NAMED.has(text)) return text;
  if (text.length === 1) return text.toUpperCase();
  return text;
}

const join = (mods, key) => [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');

/** The chord a keydown makes, or null when only modifiers are down. `mac` says which key is Mod. */
export function chordFromEvent(e, mac) {
  const key = keyName(e);
  if (!key) return null;
  const mods = new Set();
  if (mac ? e.metaKey : e.ctrlKey) mods.add('Mod');
  if (mac ? e.ctrlKey : e.metaKey) mods.add(mac ? 'Ctrl' : 'Meta');
  if (e.altKey) mods.add('Alt');
  if (e.shiftKey) mods.add('Shift');
  return join(mods, key);
}

/**
 * A shortcut as the menus write it ("⌘+Shift+Z", "Ctrl+Shift+Z", "⌃+Shift+~", "Alt+Shift+Right", "F7") as a
 * chord, or null when it is not one key press ("Delete" is; "Drag the handle" is not).
 */
export function parseShortcut(text, mac) {
  if (!text || typeof text !== 'string') return null;
  const parts = text.trim().split(/\s*\+\s*(?=.)/);
  // "Ctrl++" names the + key: the split above leaves it as the last part.
  if (/\+\s*\+$/.test(text.trim())) parts[parts.length - 1] = '+';
  const mods = new Set();
  let key = null;
  for (const raw of parts) {
    const part = raw.trim();
    const lower = part.toLowerCase();
    if (part === '⌘' || lower === 'cmd' || lower === 'command' || lower === 'mod') mods.add('Mod');
    else if (part === '⌃' || lower === 'control') mods.add(mac ? 'Ctrl' : 'Mod');
    else if (lower === 'ctrl') mods.add(mac ? 'Ctrl' : 'Mod');
    else if (part === '⌥' || lower === 'alt' || lower === 'option' || lower === 'opt') mods.add('Alt');
    else if (part === '⇧' || lower === 'shift') mods.add('Shift');
    else if (lower === 'win' || lower === 'meta' || lower === 'super') mods.add(mac ? 'Mod' : 'Meta');
    else if (key == null) key = normalizeKey(part);
    else return null;
  }
  if (!key || /\s/.test(key)) return null;
  return join(mods, key);
}

/** A chord written for people: "⌘+Shift+K" on a Mac, "Ctrl+Shift+K" elsewhere. */
export function formatChord(chord, mac) {
  if (!chord) return '';
  const parts = String(chord).split(/\+(?=.)/);
  const names = { Mod: mac ? '⌘' : 'Ctrl', Ctrl: mac ? '⌃' : 'Ctrl', Meta: mac ? '⌘' : 'Win', Alt: mac ? '⌥' : 'Alt', Shift: 'Shift' };
  const keys = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', ContextMenu: 'Menu' };
  return parts.map((p, i) => (i < parts.length - 1 ? names[p] || p : keys[p] || p)).join('+');
}

/** The modifiers and key of a chord. */
export function chordParts(chord) {
  const parts = String(chord || '').split(/\+(?=.)/);
  return { mods: new Set(parts.slice(0, -1)), key: parts.at(-1) || '' };
}

/** Chords the browser or the system keeps for itself, or that the editor needs as they are. */
const RESERVED = {
  'Mod+C': 'Copy', 'Mod+X': 'Cut', 'Mod+V': 'Paste', 'Mod+W': 'the browser (close the tab)', 'Mod+T': 'the browser (new tab)',
  'Mod+N': 'the browser (new window)', 'Mod+Q': 'the browser (quit)', 'Mod+Shift+T': 'the browser (reopen a tab)',
  'Mod+Shift+N': 'the browser (private window)', 'Mod+Shift+W': 'the browser (close the window)', 'Mod+R': 'the browser (reload)',
  'Mod+Tab': 'the system (switch apps)', 'Alt+Tab': 'the system (switch apps)', 'Alt+F4': 'the system (close the window)',
};

/**
 * Whether a chord can be given to a command: null when it can, else why not. A chord must hold Ctrl, ⌘, Alt
 * (Option) or the Windows key, or be a function key, so typing into a cell is never taken; a few chords stay
 * with the browser or the system.
 */
export function chordProblem(chord) {
  if (!chord) return 'Press a key combination';
  const { mods, key } = chordParts(chord);
  const fn = /^F([1-9]|1[0-2])$/.test(key);
  if (!fn && !['Mod', 'Ctrl', 'Meta', 'Alt'].some((m) => mods.has(m))) return 'Use Ctrl, ⌘, Alt or Option with the key, or a function key (F1 to F12), so typing into cells keeps working';
  if (key === 'Escape' || key === 'Tab') return `${key === 'Tab' ? 'Tab' : 'Escape'} moves the focus and closes dialogs, so it cannot be a shortcut`;
  if (RESERVED[chord]) return `That combination is kept by ${RESERVED[chord]}`;
  return null;
}

/**
 * The custom shortcut table: { [chord]: commandId | null }, null meaning the chord's built-in use is turned
 * off. Entries that are not chords, or name no command, are dropped.
 */
export function normalizeKeymap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [chord, id] of Object.entries(raw)) {
    if (typeof chord !== 'string' || !chord || chord.length > 40) continue;
    if (id === null || (typeof id === 'string' && id && id.length <= 400)) out[chord] = id;
  }
  return out;
}

/**
 * Where a chord is already in use, given the custom table and the built-in shortcuts ({ chord: [ids] }):
 * the command ids it would take the chord from, apart from `id` itself.
 */
export function chordConflicts(chord, id, keymap, builtins) {
  if (!chord) return [];
  if (Object.hasOwn(keymap, chord)) return keymap[chord] && keymap[chord] !== id ? [keymap[chord]] : [];
  return (builtins[chord] || []).filter((other) => other !== id);
}

/**
 * The chords that run command `id`: its built-in ones (`defaults`) unless the custom table takes or turns them
 * off, then those the table gives it.
 */
export function chordsFor(id, defaults, keymap) {
  const kept = (defaults || []).filter((chord) => !Object.hasOwn(keymap, chord) || keymap[chord] === id);
  const custom = Object.entries(keymap).filter(([chord, to]) => to === id && !kept.includes(chord)).map(([chord]) => chord);
  return [...kept, ...custom];
}
