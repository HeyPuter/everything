/**
 * Shared state between the Remove panel (details) and the on-canvas region
 * editor (player): which clip's regions are being edited, the selected
 * region, the tool (brush, box or eraser), the brush size and whether the
 * regions are shown tinted. UI state only; the regions live in the project.
 *
 * Editing is active while the Remove panel is on screen for the selected
 * clip.
 *
 * Events: change (anything above changed, redraw the overlay).
 */
import { Emitter } from '../lib/emitter.js';

export const REMOVE_TOOLS = [
  { id: 'brush', label: 'Brush', icon: 'brush', hint: 'Paint over what to remove' },
  { id: 'box', label: 'Box', icon: 'square', hint: 'Drag a box around what to remove' },
  { id: 'erase', label: 'Erase', icon: 'eraser', hint: 'Paint to take back part of a painted region' },
];

class RemoveEditState extends Emitter {
  constructor() {
    super();
    this.panel = null;
    this.clipId = null;
    this.index = 0;
    this.tool = 'brush';
    this.size = 0.05; // brush diameter, fraction of the picture's short side
    this.show = true; // tint the regions on the preview
    this.cursor = null; // [x, y, r] in css px while over the picture
  }

  /** The Remove panel for clipId is now shown in el. */
  open(el, clipId) {
    if (this.clipId !== clipId) this.index = 0;
    this.panel = el;
    this.clipId = clipId;
    this.emit('change');
  }

  /** Whether the regions of clipId are edited on the canvas right now. */
  active(clipId) {
    return Boolean(this.panel?.isConnected && this.clipId && this.clipId === clipId);
  }

  set(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (this[k] !== v) {
        this[k] = v;
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  refresh() {
    this.emit('change');
  }
}

export const removeEdit = new RemoveEditState();
