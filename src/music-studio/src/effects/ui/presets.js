// Presets for one effect slot: the built-in list from effects/presets.js plus
// the user's own presets for that effect type, loaded through the mixer
// controller (one undo step, heard right away).

import { presetController } from '../../ui/presets.js';
import { defaultEffectParams } from '../catalog.js';
import { effectPresetsFor } from '../presets.js';
import { slotById } from '../../mixer/slots.js';

/** A preset controller for slot `slotId` on mixer track `track`, or null when the slot is gone. */
export function effectPresetController(app, ctl, track, slotId) {
  const slot = slotById(app.store.project, track, slotId);
  if (!slot) return null;
  const type = slot.type;
  return presetController({
    app,
    kind: `effect:${type}`,
    builtins: effectPresetsFor(type),
    defaults: defaultEffectParams(type),
    params: () => slotById(app.store.project, track, slotId)?.params,
    apply: (entry) => ctl.loadEffectPreset(track, slotId, entry.params, entry.name),
  });
}
