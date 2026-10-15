// Extra menu icons (original artwork, 16×16 grid, same stroke weights as icons.ts).
import { registerIcons } from './icons';

registerIcons({
  // magnifier over a selected element
  zoom_selected: '<circle class="s" cx="7" cy="7" r="4.2" fill="none" stroke-width="1.5"/><path class="s" d="M10 10l4 4" stroke-width="1.6"/><rect class="f" x="5.4" y="5.4" width="3.2" height="3.2" rx=".5"/>',
  // an edge with stitches across it
  edge_seam: '<path class="s" d="M2.5 13.5 13.5 2.5" stroke-width="1.4"/><path class="s" d="M3.6 9.6l2.8 2.8M6.1 7.1l2.8 2.8M8.6 4.6l2.8 2.8" stroke-width="1.2"/>',
  // two faces meeting in a hard ridge
  edge_sharp: '<path class="s" d="M2 12.5 8 3.5l6 9" fill="none" stroke-width="1.4" stroke-linejoin="round"/><circle class="f" cx="8" cy="3.8" r="1.6"/><path class="s" d="M5 12.5h6" stroke-width="1.1" opacity=".55"/>',
  // a soft bend pulled towards a sharp edge
  edge_crease: '<path class="s" d="M2 12.5C5 12.5 6.5 4 8 4s3 8.5 6 8.5" fill="none" stroke-width="1.4"/><path class="s" d="M8 7.5v6M6.3 11.8 8 13.5l1.7-1.7" fill="none" stroke-width="1.1"/>',
  // picture on a stand: placed in the scene as a reference
  image_reference: '<rect class="s" x="2.5" y="2.5" width="11" height="8.5" rx="1" fill="none" stroke-width="1.3"/><path class="f" d="M3.6 10l3-3.4 2 2.2 1.3-1.2 2.5 2.4z"/><path class="s" d="M8 11v2.8M5.5 14h5" stroke-width="1.3"/>',
  // picture behind a grid: placed behind everything
  image_background: '<rect class="s" x="4.5" y="1.5" width="10" height="8" rx="1" fill="none" stroke-width="1.2" opacity=".55"/><rect class="s" x="1.5" y="5.5" width="10" height="8.5" rx="1" fill="none" stroke-width="1.3"/><path class="f" d="M2.6 13l3-3.3 2 2 1.2-1 2 2.3z"/>',
  // arrow circling back to an earlier time
  recover_last: '<path class="s" d="M3.5 6.5A5 5 0 1 1 3 9.5" fill="none" stroke-width="1.4"/><path class="f" d="M1.5 3.5 5.6 3.9 3 7.2z"/><path class="s" d="M8 5.5V8.5l2 1.3" fill="none" stroke-width="1.3"/>',
  // film strip with a play mark
  render_animation: '<rect class="s" x="2" y="3" width="12" height="10" rx="1" fill="none" stroke-width="1.3"/><path class="s" d="M4.5 3v10M11.5 3v10" stroke-width="1" opacity=".6"/><path class="f" d="M6.8 5.8v4.4L10.2 8z"/>',
  // paste board with mirrored arrows
  pasteflipdown: '<rect class="s" x="3" y="3.5" width="10" height="10.5" rx="1" fill="none" stroke-width="1.3"/><rect class="f" x="5.5" y="1.5" width="5" height="3.2" rx=".7"/><path class="s" d="M8 7v5" stroke-width="1" opacity=".6"/><path class="f" d="M7 8v3L4.8 9.5zM9 8v3l2.2-1.5z"/>',
  // force field slowing things down: shrinking speed lines into a dot
  force_drag: '<path class="c-mo s" d="M2 5h7M2 8h5M2 11h3" stroke-width="1.3"/><circle class="c-mo s" cx="11.5" cy="8" r="2.3" fill="none" stroke-width="1.3"/>',
  // mouse with the left, middle or right button filled (status bar hints)
  mouse_lmb: '<path class="f" d="M7.5 2.1A3.8 3.8 0 0 0 4 6v1.6h3.5z"/><rect class="s" x="4" y="2" width="8" height="12" rx="4" fill="none" stroke-width="1.1"/><path class="s" d="M4 7.6h8M8 2v5.6" stroke-width="1"/>',
  mouse_mmb: '<rect class="s" x="4" y="2" width="8" height="12" rx="4" fill="none" stroke-width="1.1"/><path class="s" d="M4 7.6h8" stroke-width="1"/><rect class="f" x="7" y="3.4" width="2" height="3.4" rx="1"/>',
  mouse_rmb: '<path class="f" d="M8.5 2.1A3.8 3.8 0 0 1 12 6v1.6H8.5z"/><rect class="s" x="4" y="2" width="8" height="12" rx="4" fill="none" stroke-width="1.1"/><path class="s" d="M4 7.6h8M8 2v5.6" stroke-width="1"/>',
  // editor types: node editors and the drivers editor as plain line icons
  editor_shader: '<rect class="s" x="1.5" y="2.5" width="6" height="5" rx="1" fill="none" stroke-width="1.2"/><path class="s" d="M7.5 5c2.5 0 1.5 5.5 3 5.5" fill="none" stroke-width="1.2"/><circle class="s" cx="11.8" cy="10.8" r="2.7" fill="none" stroke-width="1.2"/><path class="s" d="M10.4 9.6a1.6 1.6 0 0 1 1.6-.8" fill="none" stroke-width="1"/>',
  editor_geometry: '<rect class="s" x="1.5" y="2.5" width="6" height="5" rx="1" fill="none" stroke-width="1.2"/><path class="s" d="M7.5 5c2.5 0 1.5 5 3 5" fill="none" stroke-width="1.2"/><path class="s" d="M12 7.5l2.6 6H9.4z" fill="none" stroke-width="1.2" stroke-linejoin="round"/>',
  drivers: '<path class="s" d="M6 12.5c2.5 0 3-9 7.5-9" fill="none" stroke-width="1.4"/><circle class="s" cx="3.5" cy="12.5" r="2" fill="none" stroke-width="1.2"/><path class="s" d="M3.5 8.5v2M3.5 14.5v1" stroke-width="1.2"/>',
  // two-way arrow (mirror, invert)
  arrow_leftright: '<path class="s" d="M2.5 8h11" stroke-width="1.3"/><path class="f" d="M1.5 8 5 5v6zM14.5 8 11 5v6z"/>',
  // colour channels: all three overlapping, or one channel; alpha as a checker square
  image_rgb: '<circle cx="6" cy="6.2" r="3.4" fill="#dc4c45" opacity=".9"/><circle cx="10" cy="6.2" r="3.4" fill="#51c057" opacity=".8"/><circle cx="8" cy="9.8" r="3.4" fill="#5278df" opacity=".8"/>',
  rgb_red: '<circle cx="8" cy="8" r="4.5" fill="#dc4c45"/>',
  rgb_green: '<circle cx="8" cy="8" r="4.5" fill="#51c057"/>',
  rgb_blue: '<circle cx="8" cy="8" r="4.5" fill="#5278df"/>',
  image_alpha: '<rect class="s" x="2.5" y="2.5" width="11" height="11" rx="1" fill="none" stroke-width="1.2"/><path class="f" d="M3 3h5v5H3zM8 8h5v5H8z" opacity=".75"/>',
});
