// Original icons for NURBS surfaces (16×16 grid, theme-colored via .f / .s classes).
import { registerIcons } from '../ui/icons';
import { OB_ICON, DATA_ICON, DATA_TABLE } from '../editors/outliner/tree';

const grid = '<path class="s" d="M2.5 11.5C5 9 9 10 13.5 7.5M3 7.5C5.5 5 9 6 13 3.5M4.5 3.5 2.5 11.5M8.4 5.6 7.6 10M12.6 4 13.5 7.5" fill="none" stroke-width="1.1" stroke-linecap="round"/>';
const dot = (x: number, y: number) => `<circle class="f" cx="${x}" cy="${y}" r="1.2"/>`;

registerIcons({
  outliner_ob_surface: '<path class="c-ob s" d="M2 12.5c2.5-3 6-2.5 12-5M2.5 7.5c2.5-3 6-2.5 11.5-5M2 12.5 2.5 7.5M8 10.2 8.2 5.3M14 7.5 14 2.5" fill="none" stroke-width="1.3" stroke-linecap="round"/>',
  surface_data: grid + dot(2.5, 11.5) + dot(13.5, 7.5) + dot(4.5, 3.5) + dot(13, 3.5),
  surface_ncurve: '<path class="s" d="M2 11C4 4 12 4 14 11" fill="none" stroke-width="1.3"/><path class="s" d="M2 11 4.5 5h7L14 11" fill="none" stroke-width=".8" stroke-dasharray="1.5 1.2"/>' + dot(4.5, 5) + dot(11.5, 5),
  surface_ncircle: '<circle class="s" cx="8" cy="8" r="5" fill="none" stroke-width="1.3"/><rect class="s" x="3" y="3" width="10" height="10" fill="none" stroke-width=".8" stroke-dasharray="1.5 1.2"/>' + dot(3, 3) + dot(13, 13),
  surface_nsurface: grid,
  surface_ncylinder: '<ellipse class="s" cx="8" cy="3.8" rx="5" ry="1.8" fill="none" stroke-width="1.2"/><path class="s" d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M8 5.6V14" fill="none" stroke-width="1.2"/>',
  surface_nsphere: '<circle class="s" cx="8" cy="8" r="5.6" fill="none" stroke-width="1.2"/><path class="s" d="M8 2.4c-2.6 2-2.6 9.2 0 11.2M8 2.4c2.6 2 2.6 9.2 0 11.2M2.4 8h11.2" fill="none" stroke-width=".9"/>',
  surface_ntorus: '<ellipse class="s" cx="8" cy="8" rx="6.2" ry="4" fill="none" stroke-width="1.2"/><ellipse class="s" cx="8" cy="7.6" rx="2.6" ry="1.3" fill="none" stroke-width="1.1"/><path class="s" d="M1.8 8c0 1.2 2.4 2.6 6.2 2.6s6.2-1.4 6.2-2.6" fill="none" stroke-width=".8"/>',
});

OB_ICON.SURFACE = 'outliner_ob_surface';
DATA_ICON.SURFACE = 'surface_data';
DATA_TABLE.SURFACE = 'curves';
