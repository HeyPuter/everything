// Original icons for the motion tracking UI (16×16 grid, theme classes f / s).
import { registerIcons } from '../ui/icons';

const tri = (dir: 1 | -1, x: number) => (dir > 0 ? `M${x} 4.5v7l5-3.5z` : `M${x} 4.5v7l-5-3.5z`);

registerIcons({
  // graph curves of solve errors: per frame (bars) and per track (a jagged line)
  clip_error_frames: '<path class="s" d="M1.5 14.5h13" stroke-width="1.1"/><path class="f" d="M3 9h2v5H3zM7 5h2v9H7zM11 8h2v6h-2z"/>',
  clip_error_tracks: '<path class="s" d="M1.5 12l3-6 3 4 3-7 4 6" fill="none" stroke-width="1.3" stroke-linejoin="round"/><path class="s" d="M1.5 14.5h13" stroke-width="1.1"/>',
  // speed curves of the clip graph: a wave with a small X / Y
  clip_speed_x: '<path class="s" d="M1.5 11c2-5 4-5 6 0s4 5 6 0" fill="none" stroke-width="1.3"/><path class="s" d="M10 1.5l4 4M14 1.5l-4 4" stroke-width="1.3"/>',
  clip_speed_y: '<path class="s" d="M1.5 11c2-5 4-5 6 0s4 5 6 0" fill="none" stroke-width="1.3"/><path class="s" d="M10 1.5l2 2.2 2-2.2M12 3.7V6" fill="none" stroke-width="1.3"/>',
  // movie clip editor: film frame with a tracking marker
  clip_editor:
    '<rect class="s" x="1.5" y="3" width="13" height="10" rx="1" fill="none" stroke-width="1.2"/><path class="f" d="M2 3.5h1.2v1.2H2zM2 6.3h1.2v1.2H2zM2 9.1h1.2v1.2H2zM2 11.4h1.2v1.2H2zM12.8 3.5H14v1.2h-1.2zM12.8 6.3H14v1.2h-1.2zM12.8 9.1H14v1.2h-1.2zM12.8 11.4H14v1.2h-1.2z"/><rect class="s" x="5.5" y="5.5" width="5" height="5" fill="none" stroke-width="1.1"/><path class="s" d="M8 7v2M7 8h2" stroke-width="1"/>',
  // a single track (pattern box with anchor)
  tracker: '<rect class="s" x="3" y="3" width="10" height="10" fill="none" stroke-width="1.3"/><path class="s" d="M8 5.5v5M5.5 8h5" stroke-width="1.2"/>',
  tracking_forwards_single: `<path class="f" d="${tri(1, 6)}"/><path class="s" d="M3.5 4v8" stroke-width="1.4"/>`,
  tracking_forwards: `<path class="f" d="${tri(1, 3)}"/><path class="f" d="${tri(1, 8)}"/>`,
  tracking_backwards: `<path class="f" d="${tri(-1, 8)}"/><path class="f" d="${tri(-1, 13)}"/>`,
  tracking_backwards_single: `<path class="f" d="${tri(-1, 10)}"/><path class="s" d="M12.5 4v8" stroke-width="1.4"/>`,
  tracking_clear_backwards: '<path class="s" d="M3 3v10" stroke-width="1.5"/><path class="s" d="M6 8h7" stroke-width="1.3" stroke-dasharray="1.6 1.4"/><path class="f" d="M5 8l3-2.5v5z"/>',
  tracking_clear_forwards: '<path class="s" d="M13 3v10" stroke-width="1.5"/><path class="s" d="M3 8h7" stroke-width="1.3" stroke-dasharray="1.6 1.4"/><path class="f" d="M11 8l-3-2.5v5z"/>',
  tracking_refine_backwards: '<rect class="s" x="7" y="4" width="7" height="7" fill="none" stroke-width="1.1"/><path class="s" d="M10.5 6v3M9 7.5h3" stroke-width="1"/><path class="f" d="M6 7.5 2 5v5z"/>',
  tracking_refine_forwards: '<rect class="s" x="2" y="4" width="7" height="7" fill="none" stroke-width="1.1"/><path class="s" d="M5.5 6v3M4 7.5h3" stroke-width="1"/><path class="f" d="M10 7.5 14 5v5z"/>',
});

export {};
