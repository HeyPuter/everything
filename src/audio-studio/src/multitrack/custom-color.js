// A custom track or clip color from the system color picker (beside the named palette).

import { h } from '../lib/dom.js';
import { TRACK_COLORS } from '../model/session-edits.js';

/** Opens the system color picker; `apply(hex)` gets the color picked. */
export function pickCustomColor(current, apply) {
  // A picker left over from a cancelled pick goes first.
  for (const old of document.querySelectorAll('input.custom-color-picker')) old.remove();
  const input = h('input.custom-color-picker', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(current || '') ? current : TRACK_COLORS[0], 'aria-label': 'Custom color', style: { position: 'fixed', left: '-100px', top: '0', opacity: '0' } });
  document.body.append(input);
  input.addEventListener('change', () => {
    apply(input.value);
    input.remove();
  });
  input.click();
}
