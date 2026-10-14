// A small playable keyboard (two octaves with octave shift) for auditioning
// an instrument: pointer glissando across keys (velocity from how low on the
// key you press) and the computer keyboard in two rows (Z row from the base
// C, Q row an octave up). Keys light up while they sound.
//
//   const kb = createKeyboard({ base: 48, onNoteOn(key, vel), onNoteOff(key) })
//   kb.el; kb.handleKey(e, down) -> true when the key played; kb.releaseAll()

import { h } from '../lib/dom.js';
import { clamp, keyName, isBlackKey } from '../lib/util.js';
import { icon } from '../ui/icons.js';

/** Computer key codes to semitones above the base C. */
export const KEY_MAP = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

const OCTAVES = 2;

export function createKeyboard({ base = 48, onNoteOn, onNoteOff, label = 'Keyboard' }) {
  let lo = base;
  const sounding = new Map(); // source ('p:<id>' | 'k:<code>') -> key
  const keysEl = h('div.kb-keys', { 'aria-hidden': 'true' });
  const octLabel = h('span.kb-oct');
  const down = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Octave down', title: 'Octave down' }, icon('chevron-left', 14));
  const up = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Octave up', title: 'Octave up' }, icon('chevron-right', 14));
  const el = h(
    'div.kb',
    { role: 'group', 'aria-label': `${label}. Play with the computer keyboard: Z to M and Q to P rows` },
    h('div.kb-bar', down, octLabel, up, h('span.kb-hint', 'Play with Z..M and Q..P')),
    keysEl,
  );
  const keyEls = new Map();

  function build() {
    keysEl.replaceChildren();
    keyEls.clear();
    const whites = [];
    for (let k = lo; k <= lo + OCTAVES * 12; k++) if (!isBlackKey(k)) whites.push(k);
    const ww = 100 / whites.length;
    whites.forEach((k, i) => {
      const w = h('div.kb-key.white', { dataset: { key: String(k) }, style: { left: `${i * ww}%`, width: `${ww}%` } }, k % 12 === 0 ? h('span.kb-name', keyName(k)) : null);
      keysEl.append(w);
      keyEls.set(k, w);
      if (k + 1 <= lo + OCTAVES * 12 && isBlackKey(k + 1)) {
        const b = h('div.kb-key.black', { dataset: { key: String(k + 1) }, style: { left: `${(i + 1) * ww - ww * 0.3}%`, width: `${ww * 0.6}%` } });
        keysEl.append(b);
        keyEls.set(k + 1, b);
      }
    });
    octLabel.textContent = `${keyName(lo)} to ${keyName(lo + OCTAVES * 12)}`;
    down.disabled = lo <= 0;
    up.disabled = lo + OCTAVES * 12 >= 120;
  }

  const light = (key, on) => keyEls.get(key)?.classList.toggle('down', on);

  function start(src, key, vel) {
    stop(src);
    sounding.set(src, key);
    light(key, true);
    onNoteOn?.(key, vel);
  }

  function stop(src) {
    const key = sounding.get(src);
    if (key === undefined) return;
    sounding.delete(src);
    if (![...sounding.values()].includes(key)) light(key, false);
    onNoteOff?.(key);
  }

  function releaseAll() {
    for (const src of [...sounding.keys()]) stop(src);
  }

  function shift(d) {
    releaseAll();
    lo = clamp(lo + d * 12, 0, 120 - OCTAVES * 12);
    build();
  }
  down.addEventListener('click', () => shift(-1));
  up.addEventListener('click', () => shift(1));

  const hit = (x, y) => {
    const t = document.elementFromPoint?.(x, y)?.closest?.('.kb-key');
    if (!t || !keysEl.contains(t)) return null;
    const r = t.getBoundingClientRect();
    const vel = r.height ? clamp(0.35 + 0.65 * ((y - r.top) / r.height), 0.1, 1) : 0.8;
    return { key: Number(t.dataset.key), vel };
  };

  keysEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const t = e.target.closest('.kb-key');
    if (!t) return;
    const src = `p:${e.pointerId}`;
    const r = t.getBoundingClientRect();
    const vel = r.height ? clamp(0.35 + 0.65 * ((e.clientY - r.top) / r.height), 0.1, 1) : 0.8;
    start(src, Number(t.dataset.key), vel);
    try {
      keysEl.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events.
    }
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const k = hit(ev.clientX, ev.clientY);
      if (k && k.key !== sounding.get(src)) start(src, k.key, k.vel);
    };
    const end = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      stop(src);
      keysEl.removeEventListener('pointermove', move);
      keysEl.removeEventListener('pointerup', end);
      keysEl.removeEventListener('pointercancel', end);
    };
    keysEl.addEventListener('pointermove', move);
    keysEl.addEventListener('pointerup', end);
    keysEl.addEventListener('pointercancel', end);
  });

  /** Computer keyboard: returns true when the event played or released a note. */
  function handleKey(e, isDown) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const semi = KEY_MAP[e.code];
    if (semi === undefined) return false;
    const src = `k:${e.code}`;
    if (isDown) {
      if (!e.repeat && !sounding.has(src)) start(src, clamp(lo + semi, 0, 127), 0.8);
    } else stop(src);
    return true;
  }

  build();
  return { el, handleKey, releaseAll, get base() { return lo; } };
}
