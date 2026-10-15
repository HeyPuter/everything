// Original Grease Pencil icons (16×16 grid, theme-colored via .f / .s / .c-ob / .c-da classes).
import { registerIcons } from '../ui/icons';

const squiggle = 'M2 11.5c1.6-3.4 3.2-3.6 4.2-1.6s2.4 2 3.4-.6 2.2-3.6 4.4-3.3';
const pencil = '<path class="f" d="M10.3 2.2 13.8 5.7 8 11.5 4.5 8z" opacity=".9"/><path class="f" d="M4 8.6 7.4 12 3 13z"/>';

registerIcons({
  outliner_ob_greasepencil: `<path class="c-ob s" d="${squiggle}" fill="none" stroke-width="1.8" stroke-linecap="round"/><circle class="c-ob f" cx="14" cy="6" r="1.2"/>`,
  outliner_data_greasepencil: `<path class="c-da s" d="${squiggle}" fill="none" stroke-width="1.8" stroke-linecap="round"/>`,
  greasepencil: `<path class="s" d="M1.5 14c2.5-.2 3.6-1.4 5-2.6" fill="none" stroke-width="1.2" stroke-linecap="round" opacity=".7"/>${pencil}`,
  gp_draw: `<path class="s" d="M1.5 14.5c2-.4 3.4-1.6 4.4-2.8" fill="none" stroke-width="1.3" stroke-linecap="round"/>${pencil}`,
  gp_fill:
    '<path class="s" d="M2.8 7.5 7.4 2.9 12.5 8 7.9 12.6z" fill="none" stroke-width="1.3" stroke-linejoin="round"/><path class="f" d="M3.6 8.2h8.1L7.9 12z"/><path class="f" d="M13.4 9.8c.9 1.4 1.3 2.2 1.3 2.8a1.3 1.3 0 0 1-2.6 0c0-.6.4-1.4 1.3-2.8z"/>',
  gp_erase:
    '<path class="f" d="M9.6 2.5 14 6.9 8.6 12.3H5.4L2.3 9.2z" opacity=".35"/><path class="s" d="M9.6 2.5 14 6.9 8.6 12.3H5.4L2.3 9.2zM5.7 5.8l4.4 4.4M8.6 12.3H14" fill="none" stroke-width="1.2" stroke-linejoin="round"/>',
  gp_tint:
    '<path class="f" d="M8 1.8C10.6 5.4 12.4 7.6 12.4 9.8A4.4 4.4 0 0 1 3.6 9.8C3.6 7.6 5.4 5.4 8 1.8z" opacity=".55"/><path class="s" d="M8 1.8C10.6 5.4 12.4 7.6 12.4 9.8A4.4 4.4 0 0 1 3.6 9.8C3.6 7.6 5.4 5.4 8 1.8z" fill="none" stroke-width="1.2"/><path class="s" d="M6 10.3a2 2 0 0 0 2 2" fill="none" stroke-width="1.1" stroke-linecap="round"/>',
  gp_line: '<path class="s" d="M2.5 13.5 13.5 2.5" stroke-width="1.6" stroke-linecap="round"/><circle class="f" cx="2.5" cy="13.5" r="1.6"/><circle class="f" cx="13.5" cy="2.5" r="1.6"/>',
  gp_polyline:
    '<path class="s" d="M2 13 5.5 4.5 10 11 14 3" fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><circle class="f" cx="5.5" cy="4.5" r="1.3"/><circle class="f" cx="10" cy="11" r="1.3"/>',
  gp_arc:
    '<path class="s" d="M2.5 13.5C2.5 7 7 2.5 13.5 2.5" fill="none" stroke-width="1.6" stroke-linecap="round"/><circle class="f" cx="2.5" cy="13.5" r="1.4"/><circle class="f" cx="13.5" cy="2.5" r="1.4"/>',
  gp_curve:
    '<path class="s" d="M2.5 13.2C4 6.5 12 9.5 13.5 2.8" fill="none" stroke-width="1.6" stroke-linecap="round"/><path class="s" d="M2.5 13.2 6.2 6.2" stroke-width=".9" stroke-dasharray="1.4 1.1" opacity=".75"/><circle class="s" cx="6.2" cy="6.2" r="1.2" fill="none" stroke-width="1"/><circle class="f" cx="2.5" cy="13.2" r="1.4"/><circle class="f" cx="13.5" cy="2.8" r="1.4"/>',
  gp_trim:
    '<path class="s" d="M1.5 11c1.6-1.6 3-2.2 4.2-2.2M10.3 8.8c1.3 0 2.7.6 4.2 2.2" fill="none" stroke-width="1.6" stroke-linecap="round"/><path class="s" d="M5.7 8.8h4.6" stroke-width="1.2" stroke-dasharray="1.3 1.2" opacity=".6"/><path class="s" d="M8 2.2c3 0 4.3 1.6 4.3 3.4S10.6 13 8 13 3.7 7.4 3.7 5.6 5 2.2 8 2.2z" fill="none" stroke-width="1" stroke-dasharray="2 1.4"/>',
  gp_interpolate:
    '<path class="s" d="M2 13.5C2.8 8 3.8 5 6.5 2.5" fill="none" stroke-width="1.6" stroke-linecap="round"/><path class="s" d="M6 13.5C6.9 9 8.2 6.5 10.5 4.5" fill="none" stroke-width="1.3" stroke-linecap="round" opacity=".45"/><path class="s" d="M10 13.5c1-3.6 2.4-5.6 4.5-7" fill="none" stroke-width="1.6" stroke-linecap="round"/>',
  gp_box: '<rect class="s" x="2.5" y="3.5" width="11" height="9" rx=".6" fill="none" stroke-width="1.5"/>',
  gp_circle: '<circle class="s" cx="8" cy="8" r="5.6" fill="none" stroke-width="1.5"/>',
  gp_sculpt_smooth:
    '<path class="s" d="M1.5 10.5c2-3 4-3 6.5-.5s4.5 2.5 6.5-.5" fill="none" stroke-width="1.5" stroke-linecap="round"/><path class="s" d="M2 5.5 4 3.5 6 5.5 8 3.5 10 5.5 12 3.5 14 5.5" fill="none" stroke-width="1" opacity=".55"/>',
  gp_sculpt_thickness:
    '<path class="s" d="M2 12.5C5 12 7 4 14 4" fill="none" stroke-width="3.2" stroke-linecap="round" opacity=".45"/><path class="s" d="M2 12.5C5 12 7 4 14 4" fill="none" stroke-width="1.1" stroke-linecap="round"/>',
  gp_sculpt_strength:
    '<path class="s" d="M2 12.5C5 12 7 4 14 4" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="1.6 1.4" opacity=".7"/><circle class="f" cx="12" cy="11.5" r="2.4" opacity=".5"/>',
  gp_sculpt_grab:
    '<path class="s" d="M1.5 12c3 0 4-5 6.5-5s3.5 5 6.5 5" fill="none" stroke-width="1.4" stroke-linecap="round"/><path class="s" d="M8 7V2.5" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M8 1 10 3.5H6z"/>',
  gp_sculpt_push:
    '<path class="s" d="M5 12.5C7 10 7 6 5 3.5" fill="none" stroke-width="1.4" stroke-linecap="round"/><path class="s" d="M8.5 8H14" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M7.5 8 10 6v4z"/>',
  gp_sculpt_twist:
    '<path class="s" d="M12.5 7.2A4.6 4.6 0 1 1 8 3.4" fill="none" stroke-width="1.4" stroke-linecap="round"/><path class="f" d="M8 1.4 10.6 3.4 8 5.4z"/><path class="s" d="M5.5 9.5c1-1.4 2-1.4 3 0s2 1.4 3 0" fill="none" stroke-width="1"/>',
  gp_sculpt_pinch:
    '<path class="s" d="M1.5 8h4M14.5 8h-4" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M6 8 4 6.5v3zM10 8l2 1.5v-3z"/><path class="s" d="M3 3.5c2 1.5 8 1.5 10 0M3 12.5c2-1.5 8-1.5 10 0" fill="none" stroke-width="1" opacity=".6"/>',
  gp_sculpt_randomize: '<path class="s" d="M1.5 10 3.5 6 5.5 11 7.5 4.5 9.5 10.5 11.5 5.5 14.5 9" fill="none" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>',
  onionskin_on:
    '<circle class="s" cx="5.5" cy="8" r="3.6" fill="none" stroke-width="1" opacity=".45"/><circle class="s" cx="10.5" cy="8" r="3.6" fill="none" stroke-width="1" opacity=".45"/><circle class="f" cx="8" cy="8" r="3.6"/>',
  onionskin_off:
    '<circle class="s" cx="5.5" cy="8" r="3.6" fill="none" stroke-width="1" opacity=".3"/><circle class="s" cx="10.5" cy="8" r="3.6" fill="none" stroke-width="1" opacity=".3"/><circle class="s" cx="8" cy="8" r="3.6" fill="none" stroke-width="1.2"/>',
  gp_select_points: '<circle class="f" cx="3.5" cy="11" r="1.7"/><circle class="f" cx="8" cy="5" r="1.7"/><circle class="f" cx="12.5" cy="10" r="1.7"/>',
  gp_select_strokes: '<path class="s" d="M2 11.5C4.5 4 8 4 9 8s3 3 5-3" fill="none" stroke-width="2" stroke-linecap="round"/>',
  gp_select_between_strokes:
    '<path class="s" d="M2 11.5C4.5 4 8 4 9 8s3 3 5-3" fill="none" stroke-width="1.2" stroke-linecap="round" opacity=".5"/><path class="s" d="M4.3 7.2C6 4.9 7.9 5 8.7 7.2" fill="none" stroke-width="2.2" stroke-linecap="round"/><circle class="f" cx="4.3" cy="7.2" r="1.3"/><circle class="f" cx="8.7" cy="7.2" r="1.3"/>',
  gp_multiframe:
    '<rect class="s" x="1.5" y="4" width="8" height="9" rx=".8" fill="none" stroke-width="1" opacity=".5"/><rect class="s" x="4" y="2.5" width="8" height="9" rx=".8" fill="none" stroke-width="1" opacity=".75"/><rect class="f" x="6.5" y="1" width="8" height="9" rx=".8" opacity=".9"/>',
  gp_pressure:
    '<path class="f" d="M11.6 1.6 14.4 4.4 7.6 11.2 4.8 8.4z" opacity=".85"/><path class="f" d="M4.2 9 7 11.8 3.2 12.8z"/><path class="s" d="M1.5 14.5h4M2.5 12.8" stroke-width="1.4" stroke-linecap="round"/><path class="s" d="M9 14.5c1.5 0 2.5-.6 4.5-.6" fill="none" stroke-width="1" opacity=".6"/>',
  stroke_placement:
    '<path class="s" d="M2 12.5 6 3.5h8l-4 9z" fill="none" stroke-width="1.1" stroke-linejoin="round"/><path class="s" d="M5 9.5c1.5-2 3-2 5.5-1" fill="none" stroke-width="1.6" stroke-linecap="round"/>',
});
