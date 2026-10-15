// Hair icons (16×16, original drawings): the Curves object / data, the Sculpt Curves brushes,
// Particle Edit tools and select modes.
import { registerIcons } from '../ui/icons';

const strands = (cls: string) =>
  `<path class="${cls} s" d="M2 14.5h12" stroke-width="1.4" stroke-linecap="round"/><path class="${cls} s" d="M4 14C3.5 10 5 7 4 2.5M8 14c.5-4-1-7 .5-11M12 14c-.5-3 1-6-.5-9.5" fill="none" stroke-width="1.4" stroke-linecap="round"/>`;

registerIcons({
  outliner_ob_curves: strands('c-ob'),
  curves_data: strands('c-da'),
  particlemode: '<path class="s" d="M3 14c0-4 1-7 0-10M8 14c0-4 1.5-6 0-10M13 14c0-3-1-6 0-9" fill="none" stroke-width="1.3" stroke-linecap="round"/><circle class="f" cx="3" cy="4" r="1.5"/><circle class="f" cx="8" cy="4" r="1.5"/><circle class="f" cx="13" cy="5" r="1.5"/>',
  // brushes
  hair_comb: '<path class="f" d="M2 3h12v3H2z"/><path class="s" d="M3.5 6v7M6 6v6M8.5 6v7M11 6v6M13.5 6v5" stroke-width="1.2" stroke-linecap="round"/>',
  hair_add: '<path class="s" d="M3 14c0-3 1-5 0-8M7 14c0-3 1-5 0-8" fill="none" stroke-width="1.3" stroke-linecap="round"/><path class="s" d="M12 2v6M9 5h6" stroke-width="1.6" stroke-linecap="round"/>',
  hair_delete: '<path class="s" d="M3 14c0-3 1-5 0-8M7 14c0-3 1-5 0-8" fill="none" stroke-width="1.3" stroke-linecap="round"/><path class="s" d="M10 3l4 4M14 3l-4 4" stroke-width="1.6" stroke-linecap="round"/>',
  hair_density: '<path class="s" d="M2 14h12" stroke-width="1.2"/><path class="s" d="M3 13V5M5.5 13V7M8 13V4M10.5 13V7M13 13V5" stroke-width="1.1" stroke-linecap="round"/><circle class="s" cx="8" cy="8.5" r="6" fill="none" stroke-width="1" stroke-dasharray="2 1.5"/>',
  hair_snake: '<path class="s" d="M3 14c0-4 3-4 4-7s3-4 6-4" fill="none" stroke-width="1.5" stroke-linecap="round"/><circle class="f" cx="13" cy="3" r="1.8"/>',
  hair_grow: '<path class="s" d="M5 14V5M10 14V8" stroke-width="1.5" stroke-linecap="round"/><path class="f" d="M5 1.5l2.5 3h-5zM12.5 4.5l-2.5-3-2.5 3z" opacity=".9"/>',
  hair_pinch: '<path class="s" d="M3 14c1-4 4-6 5-11M13 14c-1-4-4-6-5-11" fill="none" stroke-width="1.4" stroke-linecap="round"/><path class="s" d="M1.5 8h3M14.5 8h-3" stroke-width="1.2"/>',
  hair_puff: '<path class="s" d="M8 14V3M8 14C6 11 3 10 2 7M8 14c2-3 5-4 6-7" fill="none" stroke-width="1.4" stroke-linecap="round"/>',
  hair_smooth: '<path class="s" d="M3 14c0-3 2-4 1-6s1-4 0-6M9 14c0-3 1-5 1-7s0-3-1-5" fill="none" stroke-width="1.3" stroke-linecap="round"/><path class="s" d="M12 4c1 2 1 6 0 9" fill="none" stroke-width="1.1" stroke-dasharray="1.5 1.2"/>',
  hair_slide: '<path class="s" d="M2 14h12" stroke-width="1.2"/><path class="s" d="M5 13c0-3 1-5 0-8M10 13c0-3 1-5 0-8" fill="none" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M14.5 10.5l-3-2v4zM1.5 10.5l3-2v4z"/>',
  hair_selection: '<path class="s" d="M3 14c0-3 1-5 0-8M7 14c0-3 1-5 0-8" fill="none" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M10 13l1-4 4-4.5-1.5-1.5L9 7.5 8 11z"/>',
  hair_cut: '<circle class="s" cx="4" cy="11.5" r="2" fill="none" stroke-width="1.3"/><circle class="s" cx="12" cy="11.5" r="2" fill="none" stroke-width="1.3"/><path class="s" d="M5.3 10 11 2M10.7 10 5 2" stroke-width="1.3" stroke-linecap="round"/>',
  hair_weight: '<path class="s" d="M4 14c0-4 1-7 0-11M9 14c0-4 1-7 0-11" fill="none" stroke-width="1.4" stroke-linecap="round"/><circle class="f" cx="13" cy="5" r="2"/><circle class="f" cx="13" cy="11" r="1.2" opacity=".6"/>',
  // selection domains / particle select modes
  curve_points: '<path class="s" d="M2.5 13.5C5 12 4 6 8 4.5s5-1 6-2.5" fill="none" stroke-width="1" opacity=".55"/><circle class="f" cx="2.8" cy="13.2" r="1.7"/><circle class="f" cx="6.2" cy="7.6" r="1.7"/><circle class="f" cx="13.3" cy="2.6" r="1.7"/>',
  curve_curves: '<path class="s" d="M2 13.5C5 12 4 6 8 4.5s5-1 6-2.5M2 9.5C4 8.5 4 4 7 3" fill="none" stroke-width="1.7" stroke-linecap="round"/><path class="s" d="M6 14c3-1 3-5 6-6.5" fill="none" stroke-width="1.7" stroke-linecap="round"/>',
  pe_path: '<path class="s" d="M4 14c0-4 2-7 0-11M11 14c0-4-2-7 0-11" fill="none" stroke-width="1.6" stroke-linecap="round"/>',
  pe_point: '<path class="s" d="M5 14c0-4 2-7 0-11" fill="none" stroke-width="1" opacity=".6"/><circle class="f" cx="5" cy="13" r="1.5"/><circle class="f" cx="6" cy="8" r="1.5"/><circle class="f" cx="5" cy="3" r="1.5"/><path class="s" d="M11 14c0-4 2-7 0-11" fill="none" stroke-width="1" opacity=".6"/><circle class="f" cx="11" cy="13" r="1.5"/><circle class="f" cx="12" cy="8" r="1.5"/><circle class="f" cx="11" cy="3" r="1.5"/>',
  pe_tip: '<path class="s" d="M5 14c0-4 2-7 0-11M11 14c0-4 2-7 0-11" fill="none" stroke-width="1" opacity=".6"/><circle class="f" cx="5" cy="3" r="1.9"/><circle class="f" cx="11" cy="3" r="1.9"/>',
});
