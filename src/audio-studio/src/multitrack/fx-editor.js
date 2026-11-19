// Track effects: the shared Effects Rack slot list (effects/rack.js) bound to
// a track's `fx` slots. Changes are heard live and the whole dialog session
// is one undo step.

import { h } from '../lib/dom.js';
import { openDialog } from '../ui/dialog.js';
import { createRackEditor } from '../effects/rack.js';
import { findTrack, updateTrack } from '../model/session-edits.js';
import { editTrackEffect } from './fx-slots.js';

export const TRACK_SLOTS = 16;

export async function openTrackEffects(app, doc, trackId) {
  const key = `fx:${trackId}`;
  const track = () => findTrack(doc.state, trackId);
  const editor = createRackEditor({
    app,
    getSlots: () => track()?.fx || [],
    setSlots: (slots) => {
      if (!track()) return;
      doc.apply('Track Effects', updateTrack(doc.state, trackId, { fx: slots }), { coalesce: key });
    },
    label: `${track()?.name || 'Track'} effects`,
    slotCount: TRACK_SLOTS,
    // Settings go through the slot editor, so automated ones write keyframes.
    onEdit: (i) => editTrackEffect(app, doc, trackId, i),
  });
  doc.endGesture();
  editor.render();
  await openDialog({
    title: `Track Effects: ${track()?.name || ''}`,
    wide: true,
    className: 'fx-dialog',
    body: h('div.fx-editor', editor.el),
    buttons: [{ label: 'Done', value: true, primary: true }],
  });
  doc.endGesture();
}
