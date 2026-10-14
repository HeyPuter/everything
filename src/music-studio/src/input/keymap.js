// Typing keyboard to piano: two rows of the computer keyboard play two
// octaves, laid out like piano keys (the row below holds the black keys of
// the lower octave, the number row those of the upper one). Keys are matched
// by physical position (KeyboardEvent.code), so the layout works the same on
// every keyboard language. Minus and Equal shift the octave.
//
//   lower octave  Z S X D C V G B H N J M ,   (C to the next C)
//   upper octave  Q 2 W 3 E R 5 T 6 Y 7 U I 9 O 0 P   (C to E an octave up)

export const LOWER_ROW = ['KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM', 'Comma'];
export const UPPER_ROW = ['KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU', 'KeyI', 'Digit9', 'KeyO', 'Digit0', 'KeyP'];

export const OCTAVE_DOWN_CODE = 'Minus';
export const OCTAVE_UP_CODE = 'Equal';

/** Key of the lower row's first note at octave shift 0: C4 (the upper row starts at C5, key 60). */
export const BASE_KEY = 48;
export const MIN_OCTAVE = -4;
export const MAX_OCTAVE = 4;

const OFFSETS = new Map([...LOWER_ROW.map((c, i) => [c, i]), ...UPPER_ROW.map((c, i) => [c, 12 + i])]);

/** MIDI key a physical key plays at an octave shift, or null when it is not a piano key. */
export function keyForCode(code, octave = 0) {
  const off = OFFSETS.get(code);
  if (off === undefined) return null;
  const key = BASE_KEY + octave * 12 + off;
  return key >= 0 && key <= 127 ? key : null;
}

export function clampOctave(octave) {
  return Math.max(MIN_OCTAVE, Math.min(MAX_OCTAVE, octave));
}

/** The range of keys the rows cover at an octave shift: [lowest, highest]. */
export function octaveRange(octave = 0) {
  return [BASE_KEY + octave * 12, BASE_KEY + octave * 12 + 12 + UPPER_ROW.length - 1];
}
