// Icons of the animation editors (original 16×16 drawings).
import { registerIcons } from '../ui/icons';

registerIcons({
  // an action slot: a strip with a socket cut into it
  action_slot: '<rect class="s" x="2" y="4.5" width="12" height="7" rx="1.5" fill="none" stroke-width="1.2"/><rect class="f" x="6" y="7" width="4" height="2" rx=".6"/>',
  // sound strip: a speaker cone with one wave
  // channel modifiers toggle: a plain wrench, filled when on and outlined when off
  modifier_on: '<path class="f" d="M10.6 1.8a3.6 3.6 0 0 0-3.5 4.6l-4.9 4.9a1.4 1.4 0 0 0 2 2l4.9-4.9a3.6 3.6 0 0 0 4.6-3.5l-2 2-2.1-.6-.6-2.1 2-2a3.6 3.6 0 0 0-.4-.4z"/>',
  modifier_off: '<path class="s" d="M10.6 1.8a3.6 3.6 0 0 0-3.5 4.6l-4.9 4.9a1.4 1.4 0 0 0 2 2l4.9-4.9a3.6 3.6 0 0 0 4.6-3.5l-2 2-2.1-.6-.6-2.1 2-2a3.6 3.6 0 0 0-.4-.4z" fill="none" stroke-width="1" stroke-linejoin="round"/>',
  nla_sound: '<path class="f" d="M3 6h2.5L9 3v10L5.5 10H3z"/><path class="s" d="M11 5.5c1.2 1.4 1.2 3.6 0 5" fill="none" stroke-width="1.2" stroke-linecap="round"/>',
});
