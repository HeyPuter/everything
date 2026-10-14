// Typing keyboard to piano (Options > Typing keyboard to piano, Alt+K): the
// app's keyboard handler calls app.emitKeyboardNote(event, down) first while
// the option is on; mapped keys play the selected channel through the live
// input and are not used as shortcuts. Key repeats are ignored. Minus and
// Equal shift the octave (layout in keymap.js).

import { keyForCode, clampOctave, octaveRange, OCTAVE_DOWN_CODE, OCTAVE_UP_CODE } from './keymap.js';
import { isTyping } from '../commands/registry.js';
import { keyName } from '../lib/util.js';
import { announce } from '../lib/dom.js';

export const TYPING_VELOCITY = 0.8;

export class TypingKeyboard {
  constructor(app, live) {
    this.app = app;
    this.live = live;
    this.octave = 0;
    this.down = new Map(); // event.code -> key
    window.addEventListener('blur', () => this.releaseAll());
    app.prefs.on('change', (k) => {
      if (k === 'typingKeyboard' && !app.prefs.get('typingKeyboard')) this.releaseAll();
    });
  }

  /** Handles a keydown (down = true) or keyup. Returns true when the key belongs to the typing keyboard. */
  handle(e, down) {
    if (!e || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) {
      if (!down && e && this.down.has(e.code)) this.release(e.code);
      return false;
    }
    if (e.code === OCTAVE_DOWN_CODE || e.code === OCTAVE_UP_CODE) {
      if (down && !e.repeat) this.shiftOctave(e.code === OCTAVE_UP_CODE ? 1 : -1);
      return true;
    }
    if (down) {
      const key = keyForCode(e.code, this.octave);
      if (key === null) return false;
      if (e.repeat || this.down.has(e.code)) return true;
      this.down.set(e.code, key);
      this.live.noteOn(key, TYPING_VELOCITY, 'typing');
      return true;
    }
    if (!this.down.has(e.code)) return keyForCode(e.code, this.octave) !== null;
    this.release(e.code);
    return true;
  }

  release(code) {
    const key = this.down.get(code);
    this.down.delete(code);
    if (key !== undefined) this.live.noteOff(key, 'typing');
  }

  releaseAll() {
    for (const code of [...this.down.keys()]) this.release(code);
  }

  shiftOctave(dir) {
    const next = clampOctave(this.octave + dir);
    if (next === this.octave) {
      announce(`Typing keyboard is at its ${dir > 0 ? 'highest' : 'lowest'} octave`);
      return;
    }
    this.releaseAll();
    this.octave = next;
    const [lo, hi] = octaveRange(next);
    this.app.notify?.(`Typing keyboard: ${keyName(lo)} to ${keyName(hi)}`);
  }
}
