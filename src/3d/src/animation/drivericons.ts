// Icons for driver variable types (original artwork on the 16×16 grid of ui/icons.ts).
import { registerIcons } from '../ui/icons';

registerIcons({
  // a value tag hanging from a data path dot
  drv_single_prop: '<circle class="f" cx="3.5" cy="8" r="2"/><path class="s" d="M5.5 8h2.5" stroke-width="1.3"/><path class="s" d="M8.5 4.5h4.2a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8.5L7 8z" fill="none" stroke-width="1.3" stroke-linejoin="round"/>',
  // axes with an arrow sliding along one of them
  drv_transform: '<path class="s" d="M3 13V3M3 13h10" stroke-width="1.3"/><path class="s" d="M5.5 10.5l6-6" stroke-width="1.4"/><path class="f" d="M12.8 3.2 12.2 7.4 8.6 3.8z"/>',
  // two arrows from one point with an arc between them
  drv_rotdiff: '<path class="s" d="M3 13 13 9.5M3 13 8 3" stroke-width="1.3"/><path class="s" d="M10 11.6A7 7 0 0 0 6.2 6.2" fill="none" stroke-width="1.2" stroke-dasharray="1.6 1.2"/><circle class="f" cx="3" cy="13" r="1.4"/>',
  // two points joined by a measuring line
  drv_distance: '<circle class="f" cx="3.5" cy="12.5" r="2"/><circle class="f" cx="12.5" cy="3.5" r="2"/><path class="s" d="M5 11 11 5" stroke-width="1.2" stroke-dasharray="1.8 1.3"/>',
  // a frame with a dot: whatever is current in the scene
  drv_context: '<rect class="s" x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke-width="1.3"/><path class="s" d="M2 5.5h12" stroke-width="1.1"/><circle class="f" cx="8" cy="9.5" r="2"/>',
  // two arrows chasing each other around a circle
  drv_update: '<path class="s" d="M13 7A5 5 0 0 0 4 4.6M3 9a5 5 0 0 0 9 2.4" fill="none" stroke-width="1.4"/><path class="f" d="M2.6 2.4 6.4 4.4 3 6.8zM13.4 13.6 9.6 11.6 13 9.2z"/>',
});
