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
  const keyLabel = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Period: '.', Slash: '/', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Comma: ',', Delete: 'Del', Escape: 'Esc', PageUp: 'PgUp', PageDown: 'PgDn' }[key] || key;
  if (isMac) {
    const glyph = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
    return parts.map((p) => glyph[p] || p).join('') + keyLabel;
  }
  return [...parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)), keyLabel].join('+');
}

/**
 * Whether a keyboard event matches a spec like "Mod+Shift+K". Letters and
 * digits match by physical code so Alt/Option combinations still work on
 * Apple keyboards (where Option changes e.key).
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
  // Windows and Linux report AltGr as Ctrl+Alt. AltGr types characters ("@"
  // and "#" on French keyboards, "ń" and "ł" on Polish ones): it never runs
  // a Ctrl+Alt shortcut.
  if (!isMac && e.getModifierState?.('AltGraph')) return false;
  const modDown = isMac ? e.metaKey : e.ctrlKey;
  const ctrlDown = isMac ? e.ctrlKey : false;
  // Off Apple platforms Ctrl is the command key, so "Ctrl+" means "Mod+".
  if (!isMac && want.ctrl) want.mod = true;
  if (modDown !== want.mod) return false;
  if (isMac && ctrlDown !== want.ctrl) return false;
  if (!isMac && want.ctrl && !e.ctrlKey) return false;
  if (e.altKey !== want.alt) return false;
  if (e.shiftKey !== want.shift) return false;
  if (/^[A-Z]$/.test(key)) return e.code === `Key${key}`;
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}` || e.code === `Numpad${key}`;
  const codes = { Period: 'Period', Slash: 'Slash', Minus: 'Minus', Equal: 'Equal', BracketLeft: 'BracketLeft', BracketRight: 'BracketRight', Comma: 'Comma' };
  if (codes[key]) return e.code === codes[key];
  return e.key === key;
}
