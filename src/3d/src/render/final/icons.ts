// Icons of the render settings (shutter curve shapes, swap dimensions, stereo views).
import { registerIcons } from '../../ui/icons';

const curve = (d: string) => `<path class="s" d="M2 13.5h12" fill="none" stroke-width="1" opacity="0.5"/><path class="s" d="${d}" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;

registerIcons({
  rs_curve_smooth: curve('M2 13C5 13 5 3 8 3s3 10 6 10'),
  rs_curve_sphere: curve('M2 13C2 6 4.5 3 8 3s6 3 6 10'),
  rs_curve_root: curve('M2 13C2.5 6 5 3 8 3s5.5 3 6 10'),
  rs_curve_sharp: curve('M2 13C6 12.5 7 6 8 3c1 3 2 9.5 6 10'),
  rs_curve_line: curve('M2 13 8 3l6 10'),
  rs_curve_max: curve('M2 13V3h12v10'),
  rs_swap: '<path class="s" d="M3 5.5h9M9.5 3 12 5.5 9.5 8M13 10.5H4M6.5 8 4 10.5 6.5 13" fill="none" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  rs_eyedropper: '<path class="s" d="M10.5 2.5l3 3-1.6 1.6-3-3zM9.4 4.6l2 2L5.5 12.5 3 13l.5-2.5z" fill="none" stroke-width="1.2" stroke-linejoin="round"/><path class="f" d="M11.8 1.7a1.3 1.3 0 0 1 1.9 0l.6.6a1.3 1.3 0 0 1 0 1.9l-1 1-2.5-2.5z"/>',
  rs_stereo: '<circle class="s" cx="5" cy="8.5" r="3" fill="none" stroke-width="1.3"/><circle class="s" cx="11" cy="8.5" r="3" fill="none" stroke-width="1.3"/><path class="s" d="M8 8.5h0M2 8.5 3 4h2M14 8.5 13 4h-2" fill="none" stroke-width="1.2" stroke-linecap="round"/>',
});
