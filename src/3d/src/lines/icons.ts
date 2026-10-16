// Original icons for line rendering (16×16 grid, theme colours via .f / .s classes).
import { registerIcons } from '../ui/icons';

registerIcons({
  // line style: three strokes of different weights
  line_data:
    '<path class="s" d="M2.5 4.5h11" stroke-width="2.2" stroke-linecap="round"/><path class="s" d="M2.5 8.5h11" stroke-width="1.4" stroke-linecap="round"/><path class="s" d="M2.5 12h2.5M7 12h2.5M11.5 12h2" stroke-width="1" stroke-linecap="round"/>',
  // sampler: a dropper tip
  eyedropper:
    '<path class="f" d="M11.2 1.9a1.8 1.8 0 0 1 2.6 2.6l-1.6 1.6.7.7-1.1 1.1-3.9-3.9 1.1-1.1.7.7z"/><path class="s" d="M8.4 5.6 3.3 10.7l-.6 2.5 1.1.1 2.4-.6 5.1-5.1" fill="none" stroke-width="1.2" stroke-linejoin="round"/>',
  // line art: a cube outline drawn with a pen stroke
  mod_lineart:
    '<path class="s" d="M3 5.2 8 2.6l5 2.6v5.6L8 13.4l-5-2.6z" fill="none" stroke-width="1.3" stroke-linejoin="round"/><path class="s" d="M3 5.2 8 7.8l5-2.6M8 7.8v5.6" fill="none" stroke-width="1" opacity=".7"/>',
  outliner_collection: '<path class="s" d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" fill="none" stroke-width="1.2" stroke-linejoin="round"/>',
  // edge mark: an edge between two vertices with a tick
  freestyle_edge:
    '<path class="s" d="M3 13 13 3" stroke-width="1.8" stroke-linecap="round"/><circle class="f" cx="3" cy="13" r="1.6"/><circle class="f" cx="13" cy="3" r="1.6"/><path class="s" d="M9.5 11.5h4M11.5 9.5v4" stroke-width="1.1" stroke-linecap="round"/>',
  freestyle_face: '<path class="f" d="M2.5 3.5h8v8h-8z" opacity=".45"/><path class="s" d="M2.5 3.5h8v8h-8z" fill="none" stroke-width="1.2"/><path class="s" d="M11 12h3.5M12.75 10.25v3.5" stroke-width="1.1" stroke-linecap="round"/>',
});
