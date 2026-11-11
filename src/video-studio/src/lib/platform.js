export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

/** True when the platform's command modifier (Cmd on Apple, Ctrl elsewhere) is held. */
export function modKey(e) {
  return isMac ? e.metaKey : e.ctrlKey;
}

/**
 * Human label for a shortcut spec such as "Mod+Alt+N".
 * Apple platforms get the modifier glyphs, others get Ctrl+Alt+... text.
 */
export function shortcutLabel(spec) {
  if (!spec) return '';
  const parts = spec.split('+');
  const key = parts.pop();
  const keyLabel = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Period: '.', Slash: '/', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Comma: ',', Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\', Delete: 'Del', Escape: 'Esc', Backspace: 'Backspace', Space: 'Space', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn' }[key] || key;
  if (isMac) {
    const glyph = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
    return parts.map((p) => glyph[p] || p).join('') + keyLabel;
  }
  return [...parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)), keyLabel].join('+');
}

/**
 * The letter a keydown means ("A".."Z"): the Latin letter typed, so shortcuts follow the
 * keyboard layout (Cmd+Z is undo on a German or French keyboard too, not the key where
 * US keyboards have Z); else the physical key, when the layout types no Latin letter
 * (Cyrillic, Greek) or Option changed the character on Apple keyboards. Null for a non-letter key.
 */
export function eventLetter(e) {
  const typed = typeof e.key === 'string' && e.key.length === 1 ? e.key.toUpperCase() : '';
  if (/^[A-Z]$/.test(typed)) return typed;
  return /^Key[A-Z]$/.test(e.code || '') ? e.code.slice(3) : null;
}

/**
 * Whether a keyboard event matches a spec like "Mod+Shift+K". Letters match
 * the letter typed (see eventLetter); digits match by physical code so they
 * work on layouts that type symbols on the digit row (AZERTY).
 */
export function matchShortcut(e, spec) {
  const parts = spec.split('+');
  const key = parts.pop();
  const want = { mod: false, ctrl: false, alt: false, shift: false };
  for (const p of parts) {
    if (p === 'Mod') want.mod = true;
    else if (p === 'Ctrl') want.ctrl = true;
    else if (p === 'Alt') want.alt = true;
    else if (p === 'Shift') want.shift = true;
  }
  const modDown = isMac ? e.metaKey : e.ctrlKey;
  const ctrlDown = isMac ? e.ctrlKey : false;
  // Off Apple platforms Ctrl is the command key, so "Ctrl+" means "Mod+".
  if (!isMac && want.ctrl) want.mod = true;
  if (modDown !== want.mod) return false;
  if (isMac && ctrlDown !== want.ctrl) return false;
  if (!isMac && want.ctrl && !e.ctrlKey) return false;
  if (e.altKey !== want.alt) return false;
  if (e.shiftKey !== want.shift) return false;
  if (key === 'Space') return e.code === 'Space' || e.key === ' ';
  if (/^[A-Z]$/.test(key)) return eventLetter(e) === key;
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}` || e.code === `Numpad${key}`;
  const codes = { Period: 'Period', Slash: 'Slash', Minus: 'Minus', Equal: 'Equal', BracketLeft: 'BracketLeft', BracketRight: 'BracketRight', Comma: 'Comma', Semicolon: 'Semicolon', Quote: 'Quote', Backquote: 'Backquote', Backslash: 'Backslash' };
  if (codes[key]) return e.code === codes[key];
  return e.key === key;
}
