// Effect slots of a track edited in place from the Mixer and the track
// headers: a slot's menu inserts or replaces an effect right there (grouped
// like the Effects menu), and edits, bypasses or removes the one in it. Each
// change is one undo step on the session.

import { announce } from '../lib/dom.js';
import { getEffect } from '../effects/registry.js';
import { isRealtime } from '../effects/apply.js';
import { groupedEffects, makeSlot, setSlot, removeSlot, toggleSlot, fitSlots } from '../effects/rack.js';
import { openEffectDialog } from '../effects/dialog.js';
import { findTrack, updateTrack } from '../model/session-edits.js';
import { TRACK_SLOTS } from './fx-editor.js';

const slotsOf = (doc, trackId) => fitSlots(findTrack(doc.state, trackId)?.fx || [], TRACK_SLOTS);

function commit(doc, trackId, slots, label) {
  doc.endGesture();
  doc.apply(label, updateTrack(doc.state, trackId, { fx: slots }));
}

/** Puts effect `def` in slot `index` of a track (keeping the settings when it is already there). */
export function insertTrackEffect(doc, trackId, index, def) {
  const slots = slotsOf(doc, trackId);
  const prev = slots[index];
  commit(doc, trackId, setSlot(slots, index, makeSlot(def.id, prev?.effect === def.id ? prev.values : undefined)), prev ? 'Replace Effect' : 'Add Effect');
  announce(`${def.name} in slot ${index + 1}`);
}

/** Opens the settings of the effect in slot `index`; changes are heard live and coalesce into one step. */
export async function editTrackEffect(app, doc, trackId, index) {
  const slot = slotsOf(doc, trackId)[index];
  const def = slot && getEffect(slot.effect);
  if (!def) return;
  const key = `fxslot:${trackId}:${slot.id}`;
  const update = (patch) => {
    const cur = slotsOf(doc, trackId);
    if (cur[index]?.id !== slot.id) return;
    doc.apply('Effect Settings', updateTrack(doc.state, trackId, { fx: setSlot(cur, index, { ...cur[index], ...patch }) }), { coalesce: key });
  };
  doc.endGesture();
  await openEffectDialog(app, def, {
    mode: 'edit',
    values: slot.values,
    title: `Effect - ${def.name} (${findTrack(doc.state, trackId)?.name || 'Track'}, Slot ${index + 1})`,
    slotId: slot.id,
    onChange: (values) => update({ values }),
    onPower: (enabled) => update({ enabled }),
    enabled: slot.enabled !== false,
  });
  doc.endGesture();
}

/** Menu items for slot `index` of a track: effects to put there, then what to do with the one in it. */
export function trackSlotMenu(app, doc, trackId, index) {
  const slot = slotsOf(doc, trackId)[index];
  const items = groupedEffects(isRealtime).map((g) => ({
    type: 'sub',
    label: g.label,
    items: g.defs.map((d) => ({ type: 'cmd', label: d.name, enabled: true, checked: slot?.effect === d.id, run: () => insertTrackEffect(doc, trackId, index, d) })),
  }));
  if (!items.length) items.push({ type: 'cmd', label: 'No realtime effects available', enabled: false });
  if (slot) {
    items.push(
      { type: 'sep' },
      { type: 'cmd', label: 'Edit Effect...', enabled: Boolean(getEffect(slot.effect)), run: () => editTrackEffect(app, doc, trackId, index) },
      { type: 'cmd', label: slot.enabled === false ? 'Turn On' : 'Turn Off', enabled: true, run: () => commit(doc, trackId, toggleSlot(slotsOf(doc, trackId), index), slot.enabled === false ? 'Effect On' : 'Effect Off') },
      { type: 'cmd', label: 'Remove Effect', enabled: true, run: () => commit(doc, trackId, removeSlot(slotsOf(doc, trackId), index), 'Remove Effect') },
    );
  }
  items.push({ type: 'sep' }, { type: 'cmd', label: 'Edit All Track Effects...', enabled: true, run: () => app.commands.run('mt.trackEffects', { id: trackId }) });
  return items;
}

/** Opens a slot's menu under `anchor`. */
export function openTrackSlotMenu(app, doc, trackId, index, anchor) {
  const r = anchor?.getBoundingClientRect?.();
  app.openMenu(trackSlotMenu(app, doc, trackId, index), { anchor, x: r ? r.left : undefined, y: r ? r.bottom : undefined, label: `Slot ${index + 1} effect` });
}
