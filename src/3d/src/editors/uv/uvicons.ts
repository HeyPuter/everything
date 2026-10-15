// Original icons for the UV editor (16×16, theme-colored via .f / .s classes).
import { registerIcons } from '../../ui/icons';

const mesh = '<path class="s" d="M2 13 6 3l8 4-4 7z" fill="none" stroke-width="1" opacity=".55"/>';

registerIcons({
  // two arrows chasing each other around a UV square
  uv_sync:
    '<rect class="s" x="5.5" y="5.5" width="5" height="5" fill="none" stroke-width="1.1"/><path class="s" d="M2.5 7A5.5 5.5 0 0 1 11.5 3" fill="none" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M13.3 2.2 10.4 1.4l.6 3.3z"/><path class="s" d="M13.5 9A5.5 5.5 0 0 1 4.5 13" fill="none" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M2.7 13.8l2.9.8-.6-3.3z"/>',
  // separate pieces of a layout
  uv_island: '<path class="f" d="M1.5 2.5h6v5h-6z" opacity=".85"/><path class="f" d="M9 9.5 14.5 8 13 14H8.5z"/><path class="s" d="M10 2.5h4.5v4" fill="none" stroke-width="1.1" stroke-dasharray="1.6 1.2"/>',
  // UVs stuck together at one place
  sticky_location: '<circle class="f" cx="6.5" cy="8" r="3"/><circle class="s" cx="9.5" cy="8" r="3" fill="none" stroke-width="1.3"/>',
  // only the picked UV
  sticky_off: '<circle class="f" cx="5" cy="8" r="2.6"/><circle class="s" cx="11.5" cy="8" r="2.6" fill="none" stroke-width="1.1" stroke-dasharray="1.5 1.2"/>',
  // every UV of the same vertex, wherever it is
  sticky_vertex: '<circle class="f" cx="8" cy="4" r="2.2"/><circle class="f" cx="3.5" cy="12" r="2.2"/><circle class="f" cx="12.5" cy="12" r="2.2"/><path class="s" d="M7 6 4.5 10M9 6l2.5 4M5.8 12h4.4" stroke-width="1" stroke-dasharray="1.4 1"/>',
  uv_grab: mesh + '<path class="s" d="M8 11V4" stroke-width="1.5" stroke-linecap="round"/><path class="f" d="M8 1.5 11 5H5z"/><circle class="f" cx="8" cy="11.5" r="1.8"/>',
  uv_relax:
    '<path class="s" d="M1.5 5c2-3 4 3 6.5 0s4.5-3 6.5 0" fill="none" stroke-width="1" opacity=".5"/><path class="s" d="M1.5 11c2.2-1.4 4.3-1.4 6.5 0s4.3 1.4 6.5 0" fill="none" stroke-width="1.5" stroke-linecap="round"/><path class="f" d="M8 9.2 6.6 7h2.8z"/>',
  uv_pinch:
    '<path class="s" d="M1.5 1.5l4 4M14.5 1.5l-4 4M1.5 14.5l4-4M14.5 14.5l-4-4" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M6.8 6.8 3.9 6.3 6.3 3.9zM9.2 6.8l2.9-.5-2.4-2.4zM6.8 9.2l-2.9.5 2.4 2.4zM9.2 9.2l2.9.5-2.4 2.4z"/><circle class="f" cx="8" cy="8" r="1.1"/>',
});
