/**
 * Keyboard layouts: complete sets of shortcuts the Keyboard shortcuts
 * dialog can switch between. Default is the editor's own keys; the others
 * follow conventions widely used in professional editing:
 *
 *   Track editing  C blade and V select, Mod+K adds an edit at the
 *                  playhead, J K L shuttle, I and O marks, comma and
 *                  period nudge the selection a frame.
 *   Left hand      everything under the left hand so the right stays on
 *                  the mouse: A S D shuttle, E splits, Z and X mark in and
 *                  out, Alt+arrows nudge.
 *
 * A layout lists only the commands it changes. Its keys win: any other
 * command loses a key the layout gives away, so a layout never conflicts
 * with itself. The user's own rebinding (prefs.shortcuts) goes on top.
 */

export const KEY_LAYOUTS = [
  {
    id: 'default',
    label: 'Default',
    description: 'The editor\'s own shortcuts: Mod+B splits, B is the split tool, J K L shuttle, I and O mark the range.',
    keys: {},
  },
  {
    id: 'track',
    label: 'Track editing',
    description: 'C is the blade and V selects, Mod+K adds an edit at the playhead, J K L shuttle, I and O mark, comma and period nudge by a frame.',
    keys: {
      selectTool: ['V'],
      splitTool: ['C'],
      split: ['Mod+K'],
      splitAll: ['Mod+Shift+K'],
      // Mod+K is the edit here, so the edit assistant moves over.
      assistant: ['Mod+Alt+K'],
      toggleDisabled: ['Shift+E'],
      shuttleBack: ['J'],
      shuttleStop: ['K'],
      shuttleForward: ['L'],
      markIn: ['I'],
      markOut: ['O'],
      markClip: ['X'],
      clearRange: ['Alt+X'],
      goToIn: ['Shift+I'],
      goToOut: ['Shift+O'],
      nudgeLeft: ['Comma'],
      nudgeRight: ['Period'],
      nudgeLeft10: ['Shift+Comma'],
      nudgeRight10: ['Shift+Period'],
      zoomIn: ['Equal', 'Mod+Equal'],
      zoomOut: ['Minus', 'Mod+Minus'],
      zoomFit: ['Shift+Z'],
      toggleSnap: ['S'],
      marker: ['M'],
      freeze: ['Shift+N'],
      deleteLeft: ['Q'],
      deleteRight: ['W'],
    },
  },
  {
    id: 'left-hand',
    label: 'Left hand',
    description: 'Keys under the left hand, the right stays on the mouse: A S D shuttle, E splits, Z and X mark in and out, Alt+arrows nudge.',
    keys: {
      shuttleBack: ['A'],
      shuttleStop: ['S'],
      shuttleForward: ['D'],
      selectTool: ['V'],
      splitTool: ['B'],
      split: ['E'],
      splitAll: ['Shift+E'],
      toggleDisabled: ['Shift+V'],
      markIn: ['Z'],
      markOut: ['X'],
      markClip: ['Shift+X'],
      clearRange: ['Alt+X'],
      goToIn: ['Shift+A'],
      goToOut: ['Shift+D'],
      nudgeLeft: ['Alt+ArrowLeft'],
      nudgeRight: ['Alt+ArrowRight'],
      nudgeLeft10: ['Alt+Shift+ArrowLeft'],
      nudgeRight10: ['Alt+Shift+ArrowRight'],
      zoomFit: ['G'],
      marker: ['F'],
      markerNewColor: ['Shift+F'],
      deleteLeft: ['Q'],
      deleteRight: ['W'],
      toggleRipple: ['R'],
      toggleSnap: ['N'],
      toggleHoverPreview: ['H'],
      playerZoomFit: ['Alt+F'],
      freeze: ['Alt+Shift+F'],
    },
  },
];

export const DEFAULT_LAYOUT = 'default';

export const findLayout = (id) => KEY_LAYOUTS.find((l) => l.id === id) || KEY_LAYOUTS[0];

/**
 * Keys per command id under a layout. defaults: { id: keys } (the
 * commands' own keys). Commands the layout leaves alone keep their keys
 * minus any the layout hands to another command.
 */
export function layoutKeys(layoutId, defaults) {
  const layout = findLayout(layoutId);
  const taken = new Set(Object.values(layout.keys).flat());
  const out = {};
  for (const [id, keys] of Object.entries(defaults)) {
    out[id] = Object.hasOwn(layout.keys, id) ? [...layout.keys[id]] : keys.filter((k) => !taken.has(k));
  }
  return out;
}

/**
 * Keys bound to more than one command: [{ key, ids }], sorted by key.
 * keysById: { id: keys }.
 */
export function findConflicts(keysById) {
  const users = new Map();
  for (const [id, keys] of Object.entries(keysById)) {
    for (const k of new Set(keys)) {
      if (!users.has(k)) users.set(k, []);
      users.get(k).push(id);
    }
  }
  return [...users].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids })).sort((a, b) => a.key.localeCompare(b.key));
}
