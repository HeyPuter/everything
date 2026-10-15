// Original Outliner icons (16×16 grid, theme colored through .f / .s classes).
import { registerIcons } from '../../ui/icons';

registerIcons({
  holdout_off: '<circle class="s" cx="8" cy="8" r="5.5" fill="none" stroke-width="1.3"/><circle class="s" cx="8" cy="8" r="2" fill="none" stroke-width="1.1"/>',
  holdout_on: '<path class="f" fill-rule="evenodd" d="M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zm0 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  indirect_only_off: '<path class="s" d="M2.5 3.5 7 12l3-6 3.5 7" fill="none" stroke-width="1.2" stroke-linejoin="round" stroke-dasharray="2 1.4"/>',
  indirect_only_on: '<path class="s" d="M2.5 3.5 7 12l3-6 3.5 7" fill="none" stroke-width="1.6" stroke-linejoin="round"/><circle class="f" cx="2.5" cy="3.5" r="1.6"/>',
  outliner_expand_all: '<path class="s" d="M4 3l4 4 4-4M4 9l4 4 4-4" fill="none" stroke-width="1.4" stroke-linejoin="round"/>',
  outliner_hierarchy:
    '<path class="s" d="M3 3h4M5 3v9h4M5 8h4" fill="none" stroke-width="1.3"/><rect class="f" x="10" y="6.5" width="3.5" height="3" rx=".6"/><rect class="f" x="10" y="10.5" width="3.5" height="3" rx=".6"/>',
  outliner_show_active: '<circle class="s" cx="8" cy="8" r="5" fill="none" stroke-width="1.3"/><circle class="f" cx="8" cy="8" r="2"/>',
});
