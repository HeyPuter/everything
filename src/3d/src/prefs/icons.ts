// Original icons used by the Preferences editor (16×16 grid, theme-coloured via .f / .s).
import { registerIcons } from '../ui/icons';

registerIcons({
  keyboard: '<rect class="s" x="1.5" y="4" width="13" height="8" rx="1.3" fill="none" stroke-width="1.2"/><path class="f" d="M3.5 6h1.4v1.3H3.5zM6 6h1.4v1.3H6zM8.6 6H10v1.3H8.6zM11.1 6h1.4v1.3h-1.4zM5 9.2h6v1.3H5z"/>',
  prefs_save: '<path class="s" d="M3 2.5h7.5L13 5v8.5H3z" fill="none" stroke-width="1.3" stroke-linejoin="round"/><path class="f" d="M5 2.5h5v3H5z"/><path class="s" d="M5.8 10.2l1.6 1.6 3-3.2" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  // a plug-in module: a puzzle piece
  ext_addon: '<path class="f" d="M3 4h3.2a1.6 1.6 0 1 1 3.2 0H12.5v3.3a1.6 1.6 0 1 1 0 3.2V14H9.4a1.6 1.6 0 1 0-3.2 0H3V10.5a1.6 1.6 0 1 0 0-3.2z"/>',
  // a theme: a palette with colour wells
  ext_theme: '<path class="s" d="M8 2.2c3.4 0 6 2.3 6 5.1 0 1.8-1.4 2.6-2.8 2.6h-1.3c-.8 0-1.3.6-1.1 1.3l.3.8c.4 1.2-.4 2.1-1.5 1.9C4.6 13.5 2 11 2 7.9 2 4.7 4.7 2.2 8 2.2z" fill="none" stroke-width="1.3"/><circle class="f" cx="5.2" cy="7.4" r="1.1"/><circle class="f" cx="7.6" cy="5" r="1.1"/><circle class="f" cx="10.6" cy="5.6" r="1.1"/>',
});
