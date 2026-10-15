// Original toolbar icons for sculpt / paint brushes (16×16, theme-colored via .f / .s classes).
import { registerIcons } from '../ui/icons';

const surf = (d: string) => `<path class="f" d="${d} V15 H1 Z" opacity=".35"/><path class="s" d="${d}" fill="none" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>`;

registerIcons({
  brush_sculpt_draw: surf('M1 12 C4 12 5 5 8 5 S12 12 15 12'),
  brush_sculpt_draw_sharp: surf('M1 12 C5 12 7 10 8 3 C9 10 11 12 15 12'),
  brush_sculpt_clay: surf('M1 12 C3 12 3.5 7 6 7 H10 C12.5 7 13 12 15 12') + '<path class="s" d="M5 9.5h6" stroke-width="1" opacity=".6"/>',
  brush_sculpt_clay_strips: surf('M1 12 H3 V7 H13 V12 H15') + '<path class="s" d="M5 7V12M8 7V12M11 7V12" stroke-width="1" opacity=".6"/>',
  brush_sculpt_layer: surf('M1 12 H4 L5 6 H11 L12 12 H15'),
  brush_sculpt_inflate:
    '<circle class="f" cx="8" cy="8" r="3.2" opacity=".5"/><circle class="s" cx="8" cy="8" r="3.2" fill="none" stroke-width="1.3"/><path class="s" d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" stroke-width="1.3" stroke-linecap="round"/>',
  brush_sculpt_blob: surf('M1 12 C3 12 3 4 8 4 S13 12 15 12') + '<circle class="s" cx="8" cy="8" r="1.4" fill="none" stroke-width="1"/>',
  brush_sculpt_crease: surf('M1 7 C5 7 7 8 8 13 C9 8 11 7 15 7'),
  brush_sculpt_smooth: surf('M1 10 C3 8 5 8 8 9.5 S13 11 15 9') + '<path class="s" d="M3 4.5 C5 2.5 7 6.5 9 4.5 S13 3 14 4" fill="none" stroke-width="1" opacity=".6"/>',
  brush_sculpt_flatten:
    surf('M1 11 C2 11 3 8 4 8 H12 C13 8 14 11 15 11') +
    '<path class="s" d="M5 3.5v2.5M8 3.5v2.5M11 3.5v2.5" stroke-width="1.2" stroke-linecap="round"/><path class="f" d="M3.6 5.5 5 7.3 6.4 5.5zM6.6 5.5 8 7.3 9.4 5.5zM9.6 5.5 11 7.3 12.4 5.5z"/>',
  brush_sculpt_fill:
    '<path class="f" d="M1 7 C4 7 5 12 8 12 S12 7 15 7 V15 H1Z" opacity=".35"/><path class="f" d="M4.5 8.3 C6 11.5 10 11.5 11.5 8.3 Z"/><path class="s" d="M1 7 C4 7 5 12 8 12 S12 7 15 7" fill="none" stroke-width="1.4"/>',
  brush_sculpt_scrape: surf('M1 12 L4 7 H12 L15 12') + '<path class="s" d="M4 4.5 6 2.5 8 4.5 10 2.5 12 4.5" fill="none" stroke-width="1" stroke-dasharray="1.5 1" opacity=".7"/>',
  brush_sculpt_pinch:
    '<path class="s" d="M1.5 8h4M14.5 8h-4M8 1.5v4M8 14.5v-4" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M5.8 8 3.8 6.5v3zM10.2 8l2 1.5v-3zM8 5.8 6.5 3.8h3zM8 10.2l1.5 2h-3z"/><circle class="f" cx="8" cy="8" r="1.2"/>',
  brush_sculpt_grab: surf('M1 12 C4 12 5 8 8 8 S12 12 15 12') + '<path class="s" d="M8 8V2.5" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M8 1 10 3.5H6z"/>',
  brush_sculpt_snake_hook:
    '<path class="f" d="M1 13 H15 V15 H1Z" opacity=".35"/><path class="s" d="M3 13 C3 7 6 4 9 4 S13 6 12 8" fill="none" stroke-width="1.6" stroke-linecap="round"/><path class="s" d="M6 13 C6 9 8 7 10 7" fill="none" stroke-width="1" opacity=".6"/>',
  brush_sculpt_thumb: surf('M1 12 C3 12 5 9 7 9 C10 9 12 11 15 11') + '<path class="s" d="M3 5h8" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M13 5 10.5 3v4z"/>',
  brush_sculpt_nudge:
    surf('M1 12 C4 12 5 9 7 9 S12 12 15 12') + '<path class="s" d="M4 5.5c2-1.5 4-1.5 6 0" fill="none" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M12 6.8 9.4 6.6l1.4-2.2z"/>',
  brush_sculpt_rotate:
    '<path class="f" d="M1 12 H15 V15 H1Z" opacity=".35"/><path class="s" d="M12.5 7 A4.5 4.5 0 1 1 8 2.5" fill="none" stroke-width="1.4" stroke-linecap="round"/><path class="f" d="M8 0.6 10.6 2.5 8 4.4z"/><circle class="f" cx="8" cy="7" r="1.1"/>',
  brush_sculpt_mask: '<circle class="s" cx="8" cy="8" r="5.5" fill="none" stroke-width="1.3"/><path class="f" d="M8 2.5 A5.5 5.5 0 0 0 8 13.5Z"/>',
  box_mask: '<path class="s" d="M2.5 3.5h11v9h-11z" fill="none" stroke-width="1.2" stroke-dasharray="2 1.5"/><path class="f" d="M2.5 3.5h5.5v9H2.5z" opacity=".7"/>',
  brush_paint_draw: '<path class="f" d="M2.5 13.5c0-2.2 1.2-3.4 2.9-3.4s2.3 1.1 2.3 2.2-1.2 2.4-3.6 2.4z"/><path class="f" d="M6.8 9.4 13 3.2l1.3 1.3-6.2 6.2z"/>',
  brush_paint_blur: '<circle class="f" cx="8" cy="8" r="5.5" opacity=".25"/><circle class="f" cx="8" cy="8" r="3.5" opacity=".45"/><circle class="f" cx="8" cy="8" r="1.6"/>',
  brush_paint_average: '<circle class="s" cx="8" cy="8" r="5.5" fill="none" stroke-width="1.3"/><path class="s" d="M5 6.7h6M5 9.3h6" stroke-width="1.3" stroke-linecap="round"/>',
  brush_paint_smear: '<path class="f" d="M2 11c2-3 5-4 9-4l3-2v6l-3-2c-3 0-6 1-9 4z" opacity=".75"/><path class="s" d="M2 6.5h4M1.5 4h3" stroke-width="1" stroke-linecap="round" opacity=".6"/>',
  brush_paint_fill:
    '<path class="s" d="M3 7 7.5 2.5 12.5 7.5 8 12z" fill="none" stroke-width="1.3" stroke-linejoin="round"/><path class="f" d="M3.6 7.6h8.3L8 11.4z"/><path class="f" d="M13.2 9.5c.9 1.4 1.3 2.2 1.3 2.8a1.3 1.3 0 0 1-2.6 0c0-.6.4-1.4 1.3-2.8z"/>',
  brush_weight_draw:
    '<defs><linearGradient id="wgrad" x1="0" x2="1"><stop offset="0" stop-color="#2a5bff"/><stop offset=".5" stop-color="#2fd34a"/><stop offset="1" stop-color="#ff3b2f"/></linearGradient></defs><path d="M2.5 13.5c0-2.2 1.2-3.4 2.9-3.4s2.3 1.1 2.3 2.2-1.2 2.4-3.6 2.4z" fill="url(#wgrad)"/><path class="f" d="M6.8 9.4 13 3.2l1.3 1.3-6.2 6.2z"/>',
  eyedropper: '<path class="f" d="M10.8 2.2a1.8 1.8 0 0 1 2.5 2.5l-1.6 1.6.7.7-1.1 1.1-.7-.7-5 5-2.3.6.6-2.3 5-5-.7-.7 1.1-1.1.7.7z"/>',
  mirror_sym: '<path class="s" d="M8 1.5v13" stroke-width="1" stroke-dasharray="1.6 1.2"/><path class="f" d="M6.5 4 2 8l4.5 4zM9.5 4 14 8l-4.5 4z" opacity=".85"/>',
});

// gesture tools: a shape outline combined with a mark for the target (mask, hide, face set, trim)
const SHAPES: Record<string, string> = {
  box: 'M2.5 3.5h11v9h-11z',
  lasso: 'M3.2 9.5C1.4 6 5 2.4 9.6 3s5.4 5 2.6 7.6C9.8 12.8 4.6 12.6 3.2 9.5z',
  line: 'M1.5 13.5 14.5 2.5',
  polyline: 'M2.5 12.5 3.5 4 10 2.5 13.5 8.5 8.5 13.5z',
};
const LINE_SIDE = '<path class="f" d="M1.5 13.5 14.5 2.5V14.5H1.5z" opacity=".3"/>';
const dashed = (d: string) => `<path class="s" d="${d}" fill="none" stroke-width="1.2" stroke-dasharray="2 1.5" stroke-linejoin="round"/>`;
const shapeFill = (k: string, op: number) => (k === 'line' ? LINE_SIDE : `<path class="f" d="${SHAPES[k]}" opacity="${op}"/>`);
const marks: Record<string, string> = {
  mask: '',
  hide: '<path class="s" d="M3 13.5 13 2.5" stroke-width="1.6" stroke-linecap="round"/>',
  face_set: '<path class="f" d="M5 6h3v3H5zM8 9h3v3H8z"/>',
  trim: '<circle class="s" cx="11.3" cy="12.3" r="1.6" fill="none" stroke-width="1.1"/><circle class="s" cx="13.8" cy="9.8" r="1.6" fill="none" stroke-width="1.1"/><path class="s" d="M10.4 11 6.5 6.8M12.5 8.9 8.4 4.9" stroke-width="1.1" stroke-linecap="round"/>',
};
const gestureIcons: Record<string, string> = {};
for (const k of Object.keys(SHAPES))
  for (const t of Object.keys(marks)) {
    const fillOp = t === 'mask' ? 0.65 : t === 'hide' ? 0.15 : 0.25;
    gestureIcons[`${k}_${t}`] = shapeFill(k, fillOp) + dashed(SHAPES[k]) + marks[t];
  }
delete gestureIcons.box_mask;
registerIcons(gestureIcons);

registerIcons({
  line_project:
    '<path class="s" d="M1.5 9.5h13" stroke-width="1.4" stroke-linecap="round"/><path class="s" d="M4 2.5v4.5M8 3.5v3.5M12 1.5v5.5" stroke-width="1.1" stroke-linecap="round"/><path class="f" d="M2.6 6.4 4 8.4 5.4 6.4zM6.6 6.4 8 8.4 9.4 6.4zM10.6 6.4 12 8.4 13.4 6.4z"/><path class="f" d="M1.5 10.5h13v4h-13z" opacity=".35"/>',
  mesh_filter:
    '<path class="f" d="M1 11c2.5-3 4.5-3 7 0s4.5 3 7 0v4H1z" opacity=".35"/><path class="s" d="M1 11c2.5-3 4.5-3 7 0s4.5 3 7 0" fill="none" stroke-width="1.3"/><path class="s" d="M2.5 5h11" stroke-width="1.1" stroke-linecap="round"/><path class="f" d="M1 5 3.4 3.2v3.6zM15 5l-2.4-1.8v3.6z"/>',
  cloth_filter:
    '<path class="f" d="M2 3c2 1 4 1 6 0s4-1 6 0v9c-2-1-4-1-6 0s-4 1-6 0z" opacity=".35"/><path class="s" d="M2 3c2 1 4 1 6 0s4-1 6 0M2 12c2 1 4 1 6 0s4-1 6 0M2 3v9M14 3v9" fill="none" stroke-width="1.2"/>',
  face_set_edit:
    '<path class="f" d="M2 2h6v6H2z" opacity=".35"/><path class="f" d="M8 8h6v6H8z" opacity=".8"/><path class="s" d="M2 2h12v12H2zM8 2v12M2 8h12" fill="none" stroke-width="1"/>',
  brush_sculpt_face_set:
    '<path class="f" d="M1.5 1.5h6v6h-6z" opacity=".3"/><path class="f" d="M8.5 8.5h6v6h-6z" opacity=".3"/><path class="f" d="M2.5 13.5c0-2.2 1.2-3.4 2.9-3.4s2.3 1.1 2.3 2.2-1.2 2.4-3.6 2.4z"/><path class="f" d="M6.8 9.4 13 3.2l1.3 1.3-6.2 6.2z"/>',
  mask_by_color:
    '<circle class="s" cx="8" cy="8" r="5.5" fill="none" stroke-width="1.2"/><path class="f" d="M8 2.5A5.5 5.5 0 0 0 8 13.5z" opacity=".6"/><path class="f" d="M10.8 2.2a1.8 1.8 0 0 1 2.5 2.5l-1.6 1.6.7.7-1.1 1.1-.7-.7-3.6 3.6-1.6.4.4-1.6 3.6-3.6-.7-.7 1.1-1.1.7.7z"/>',
  weight_gradient:
    '<defs><linearGradient id="wgrad2" x1="0" x2="1"><stop offset="0" stop-color="#2a5bff"/><stop offset=".5" stop-color="#2fd34a"/><stop offset="1" stop-color="#ff3b2f"/></linearGradient></defs><path d="M1.5 4.5h13v7h-13z" fill="url(#wgrad2)"/><path class="s" d="M1.5 4.5h13v7h-13z" fill="none" stroke-width="1"/>',
  sample_group:
    '<path class="f" d="M10.8 2.2a1.8 1.8 0 0 1 2.5 2.5l-1.6 1.6.7.7-1.1 1.1-.7-.7-5 5-2.3.6.6-2.3 5-5-.7-.7 1.1-1.1.7.7z"/><path class="s" d="M1.5 1.5h4v4h-4z" fill="none" stroke-width="1"/>',
});

registerIcons({
  automask:
    '<circle class="s" cx="8" cy="8" r="5.5" fill="none" stroke-width="1.2"/><path class="f" d="M8 2.5A5.5 5.5 0 0 1 8 13.5z" opacity=".6"/><path class="s" d="M3.5 12.5 12.5 3.5" stroke-width="1.2" stroke-linecap="round"/>',
});
