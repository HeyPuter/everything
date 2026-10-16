// Volume icons (16×16, original drawings): the Volume object / data (a puff of smoke), the
// OpenVDB file, and grid types.
import { registerIcons } from '../ui/icons';

const cloud = (cls: string) => `<path class="${cls} f" d="M4.2 12.5a2.7 2.7 0 0 1-.5-5.35 3.3 3.3 0 0 1 6.2-1.55 2.6 2.6 0 0 1 3.3 2.45A2.3 2.3 0 0 1 12.6 12.5z"/>`;

registerIcons({
  outliner_ob_volume: cloud('c-ob'),
  volume_data: cloud('c-da'),
  // a page with a small puff
  file_volume: '<path class="s" d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke-width="1.1" stroke-linejoin="round"/><path class="s" d="M9.5 1.5v3h3" fill="none" stroke-width="1"/><path class="f" d="M5.6 12a1.6 1.6 0 0 1-.3-3.2 2 2 0 0 1 3.7-.9 1.6 1.6 0 0 1 2 1.5 1.3 1.3 0 0 1-.4 2.6z"/>',
  // grid kinds in the grid list
  grid_float: '<path class="s" d="M2.5 2.5h11v11h-11zM2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11" fill="none" stroke-width="1"/><path class="f" d="M6.2 6.2h3.6v3.6H6.2z" opacity=".8"/>',
  grid_vector: '<path class="s" d="M2.5 2.5h11v11h-11z" fill="none" stroke-width="1"/><path class="s" d="M4.5 11.5l6-6M7 5.5h3.5V9" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  pointcloud_data: '<g class="c-da f"><circle cx="4" cy="5" r="1.5"/><circle cx="10" cy="4" r="1.5"/><circle cx="7" cy="9" r="1.5"/><circle cx="12" cy="11" r="1.5"/><circle cx="4" cy="12" r="1.5"/></g>',
});
