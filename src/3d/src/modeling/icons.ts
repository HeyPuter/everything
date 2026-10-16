// Original icons for the modeling tools (16×16 grid, theme-colored via .f / .s classes).
import { registerIcons } from '../ui/icons';

registerIcons({
  add_cone:
    '<path class="s" d="M8 2 3.2 11.2M8 2l4.8 9.2" fill="none" stroke-width="1.2" stroke-linecap="round"/><ellipse class="s" cx="8" cy="11.2" rx="4.8" ry="1.8" fill="none" stroke-width="1.2"/><path class="f" d="M11.5 10h1.5v2h2v1.5h-2v2h-1.5v-2h-2V12h2z"/>',
  add_cylinder:
    '<ellipse class="s" cx="7.5" cy="3.8" rx="4.5" ry="1.7" fill="none" stroke-width="1.2"/><path class="s" d="M3 3.8v7.6c0 .9 2 1.7 4.5 1.7M12 3.8V9" fill="none" stroke-width="1.2" stroke-linecap="round"/><path class="f" d="M11.5 10h1.5v2h2v1.5h-2v2h-1.5v-2h-2V12h2z"/>',
  add_uv_sphere:
    '<circle class="s" cx="7.5" cy="7.5" r="5.5" fill="none" stroke-width="1.2"/><ellipse class="s" cx="7.5" cy="7.5" rx="5.5" ry="1.8" fill="none" stroke-width=".9"/><ellipse class="s" cx="7.5" cy="7.5" rx="2" ry="5.5" fill="none" stroke-width=".9"/><path class="f" d="M11.5 10h1.5v2h2v1.5h-2v2h-1.5v-2h-2V12h2z"/>',
  add_ico_sphere:
    '<path class="s" d="M7.5 2 12.3 4.8v5.4L7.5 13 2.7 10.2V4.8z M2.7 4.8 7.5 7.4l4.8-2.6M7.5 7.4V13M7.5 2v5.4" fill="none" stroke-width="1.1" stroke-linejoin="round"/><path class="f" d="M11.5 10h1.5v2h2v1.5h-2v2h-1.5v-2h-2V12h2z"/>',
  monkey:
    '<circle class="s" cx="2.6" cy="7" r="1.8" fill="none" stroke-width="1.1"/><circle class="s" cx="13.4" cy="7" r="1.8" fill="none" stroke-width="1.1"/><path class="s" d="M8 2.5c3 0 4.6 2 4.6 4.6 0 1.4-.4 2.1-.4 3.2 0 2-1.9 3.4-4.2 3.4S3.8 12.3 3.8 10.3c0-1.1-.4-1.8-.4-3.2C3.4 4.5 5 2.5 8 2.5z" fill="none" stroke-width="1.2"/><ellipse class="f" cx="8" cy="10.6" rx="2.6" ry="1.7" opacity=".45"/><circle class="f" cx="6.3" cy="6.8" r=".9"/><circle class="f" cx="9.7" cy="6.8" r=".9"/>',
});
