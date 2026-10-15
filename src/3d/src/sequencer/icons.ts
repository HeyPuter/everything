// Original icons for the sequencer (16×16 grid, theme-coloured through the f/s classes).
import { registerIcons } from '../ui/icons';
import { TAG_COLORS } from './theme';

registerIcons({
  // editor & view types
  sequence: '<rect class="s" x="1.5" y="3" width="13" height="10" rx="1" fill="none" stroke-width="1.2"/><rect class="f" x="3" y="5" width="6" height="2" rx=".5"/><rect class="f" x="6" y="9" width="7" height="2" rx=".5"/>',
  seq_sequencer: '<rect class="f" x="1.5" y="3" width="7" height="3" rx=".7"/><rect class="f" x="6" y="7" width="8.5" height="3" rx=".7" opacity=".75"/><rect class="f" x="3" y="11" width="6" height="3" rx=".7" opacity=".5"/>',
  seq_preview: '<rect class="s" x="1.5" y="3" width="13" height="9" rx="1" fill="none" stroke-width="1.2"/><path class="f" d="M6.5 5.5v4l3.5-2z"/><path class="s" d="M5 14h6" stroke-width="1.2"/>',
  seq_splitview: '<rect class="s" x="1.5" y="1.5" width="13" height="6" rx="1" fill="none" stroke-width="1.2"/><path class="f" d="M7 3v3l2.5-1.5z"/><rect class="f" x="2" y="9.5" width="6" height="2" rx=".5"/><rect class="f" x="6" y="12.5" width="8" height="2" rx=".5" opacity=".7"/>',
  // strip types
  file_movie: '<rect class="s" x="2" y="3" width="12" height="10" rx="1" fill="none" stroke-width="1.2"/><path class="f" d="M2 3h2v2H2zM2 7h2v2H2zM2 11h2v2H2zM12 3h2v2h-2zM12 7h2v2h-2zM12 11h2v2h-2z"/>',
  file_sound: '<path class="f" d="M3 6h2.5L9 3v10L5.5 10H3z"/><path class="s" d="M11 5.5c1 .8 1 4.2 0 5M12.8 4c1.8 1.6 1.8 6.4 0 8" fill="none" stroke-width="1.2" stroke-linecap="round"/>',
  seq_color: '<rect class="f" x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M4 12 12 4" stroke="#1d1d1d" stroke-width="1.2" opacity=".35"/>',
  seq_text: '<path class="f" d="M3 3h10v2.6h-1.4L11 4.5H9V12l1.4.6V14H5.6v-1.4L7 12V4.5H5l-.6 1.1H3z"/>',
  seq_adjustment: '<rect class="s" x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke-width="1.2"/><path class="s" d="M5 5v6M8 5v6M11 5v6" stroke-width="1.2"/><circle class="f" cx="5" cy="9" r="1.3"/><circle class="f" cx="8" cy="6.5" r="1.3"/><circle class="f" cx="11" cy="8.5" r="1.3"/>',
  seq_meta: '<rect class="s" x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke-width="1.2"/><rect class="f" x="3.5" y="5" width="5" height="2" rx=".5"/><rect class="f" x="7" y="9" width="5.5" height="2" rx=".5"/>',
  seq_transition: '<path class="f" d="M2 13 14 3v10z" opacity=".55"/><path class="s" d="M2 3h12v10H2z" fill="none" stroke-width="1.2"/>',
  seq_effect: '<path class="f" d="M8 1.5 9.6 6l4.7.2-3.7 2.9 1.3 4.6L8 11l-3.9 2.7 1.3-4.6L1.7 6.2 6.4 6z"/>',
  // tools
  seq_blade: '<path class="f" d="M3 13 11.5 2.5l2 1.5-6 8.5z"/><path class="s" d="M2 14.5h4" stroke-width="1.3"/>',
  seq_slip: '<path class="s" d="M2 8h12" stroke-width="1.3"/><path class="f" d="M2 8l3-3v6zM14 8l-3-3v6z"/><path class="s" d="M5.5 3v10M10.5 3v10" stroke-width="1.1"/>',
  seq_split: '<rect class="f" x="1" y="5" width="6" height="6" rx="1"/><rect class="f" x="9" y="5" width="6" height="6" rx="1" opacity=".7"/><path class="s" d="M8 2v12" stroke-width="1.2"/>',
  mute_on: '<rect class="s" x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke-width="1.2"/>',
  file_add_media: '<path class="s" d="M4 2h5l3 3v9H4z" fill="none" stroke-width="1.2" stroke-linejoin="round"/><path class="s" d="M8 7v5M5.5 9.5h5" stroke-width="1.4"/>',
});

// strip colour tags: a rounded swatch in the tag colour, and a chain link for connected strips
registerIcons(
  Object.fromEntries(
    Object.entries(TAG_COLORS).map(([tag, color]) => [`seq_tag_${tag.slice(6)}`, `<rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="${color}"/><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="none" stroke="#000" stroke-opacity=".35"/>`]),
  ),
);
registerIcons({
  linked: '<path class="s" d="M7 9.5 9.5 7M6.3 7.2 4.6 8.9a2.3 2.3 0 0 0 3.3 3.3l1.7-1.7M9.7 8.8l1.7-1.7a2.3 2.3 0 0 0-3.3-3.3L6.4 5.5" fill="none" stroke-width="1.4" stroke-linecap="round"/>',
});
