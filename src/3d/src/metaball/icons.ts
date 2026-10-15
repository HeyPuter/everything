// Metaball icons (16×16, original): a two-lobed blob for the object / data, and one glyph per
// element type.
import { registerIcons } from '../ui/icons';

const blob = (cls: string) =>
  `<circle class="${cls} f" cx="5.8" cy="9.6" r="4.1"/><circle class="${cls} f" cx="11" cy="5.6" r="3.2"/><path class="${cls} f" d="M6.3 5.8 9.6 3.4 13 8 9.6 11.6z"/>`;

registerIcons({
  outliner_ob_meta: blob('c-ob'),
  meta_data: `<g opacity=".9">${blob('c-da')}</g><circle cx="5.6" cy="9.4" r="1.6" fill="#1d1d1d" opacity=".55"/>`,
  meta_ball: '<circle class="f" cx="8" cy="8" r="5.6" opacity=".35"/><circle class="s" cx="8" cy="8" r="5.6" fill="none" stroke-width="1.2"/><circle class="f" cx="8" cy="8" r="2.2"/>',
  meta_capsule: '<rect class="f" x="1.5" y="4.5" width="13" height="7" rx="3.5" opacity=".35"/><rect class="s" x="1.5" y="4.5" width="13" height="7" rx="3.5" fill="none" stroke-width="1.2"/><path class="s" d="M5 8h6" stroke-width="1.6" stroke-linecap="round"/>',
  meta_plane: '<path class="f" d="M4.5 4.5h10l-3 7h-10z" opacity=".35"/><path class="s" d="M4.5 4.5h10l-3 7h-10z" fill="none" stroke-width="1.2" stroke-linejoin="round"/><path class="s" d="M6 8h4.5" stroke-width="1.6" stroke-linecap="round"/>',
  meta_ellipsoid: '<ellipse class="f" cx="8" cy="8" rx="6.5" ry="3.8" opacity=".35"/><ellipse class="s" cx="8" cy="8" rx="6.5" ry="3.8" fill="none" stroke-width="1.2"/><circle class="f" cx="8" cy="8" r="1.6"/>',
  meta_cube: '<rect class="f" x="2.5" y="2.5" width="11" height="11" rx="3" opacity=".35"/><rect class="s" x="2.5" y="2.5" width="11" height="11" rx="3" fill="none" stroke-width="1.2"/><rect class="f" x="6" y="6" width="4" height="4" rx="1"/>',
});
