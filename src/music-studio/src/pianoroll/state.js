// State the piano roll shares with the live input (recording, step edit) and
// keeps across patterns and channels: the keyboard cursor, the resolved snap
// grid, the note clipboard, the chord stamp and the last used note settings.
// Module-level so copy and paste work between patterns and channels.

import { Emitter } from '../lib/emitter.js';
import { STEP } from '../model/time.js';

export const shared = {
  /** Keyboard / step-edit cursor in the current pattern. */
  cursor: { tick: 0, key: 60 },
  /** The piano roll's snap resolved to ticks for its zoom (0 = no snap). */
  grid: STEP,
  /** { notes: [{ key, pos (relative), len, vel, pan }], length } or null. */
  clipboard: null,
  /** Chord stamp for the draw tool: null or { chord, inversion }. */
  stamp: null,
  /** Length and velocity new notes get (the last ones used). Null until set. */
  last: null,
};

/** 'cursor' when the cursor moves from outside the editor (step edit). */
export const sharedEvents = new Emitter();
