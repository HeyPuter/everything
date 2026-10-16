// Original icons for linked data, libraries and library overrides (16×16 grid, theme colored
// through the .f / .s classes).
import { registerIcons } from '../ui/icons';

registerIcons({
  // a file with a chain link in its corner
  library_data_direct:
    '<path class="s" d="M3.5 1.8h5l3 3V8M3.5 1.8V14h4" fill="none" stroke-width="1.2" stroke-linejoin="round"/><path class="s" d="M10.6 10.2l-1.8 1.8M9.4 9.8l.8-.8a1.4 1.4 0 0 1 2 2l-.8.8M10 12.4l-.8.8a1.4 1.4 0 0 1-2-2l.8-.8" fill="none" stroke-width="1.2" stroke-linecap="round"/>',
  // the same, dashed: linked only through another library
  library_data_indirect:
    '<path class="s" d="M3.5 1.8h5l3 3V8M3.5 1.8V14h4" fill="none" stroke-width="1.2" stroke-dasharray="1.6 1.2"/><path class="s" d="M10.6 10.2l-1.8 1.8M9.4 9.8l.8-.8a1.4 1.4 0 0 1 2 2l-.8.8M10 12.4l-.8.8a1.4 1.4 0 0 1-2-2l.8-.8" fill="none" stroke-width="1.2" stroke-linecap="round"/>',
  // a file with an exclamation mark: the library could not be read
  library_data_broken:
    '<path class="s" d="M3.5 1.8h5l3 3V14h-8z" fill="none" stroke-width="1.2" stroke-linejoin="round"/><path d="M7.5 5.5v4.2" stroke="#e8a33d" stroke-width="1.6" stroke-linecap="round"/><circle cx="7.5" cy="12" r=".95" fill="#e8a33d"/>',
  // a small chain link (linked data-block)
  id_linked: '<path class="s" d="M9.2 6.8 6.8 9.2M7.4 5.2 8.6 4a2.2 2.2 0 0 1 3.1 3.1L10.5 8.3M8.6 10.8 7.4 12a2.2 2.2 0 0 1-3.1-3.1L5.5 7.7" fill="none" stroke-width="1.5" stroke-linecap="round"/>',
  // a chain link with a broken middle (make local)
  unlinked: '<path class="s" d="M7.4 5.2 8.6 4a2.2 2.2 0 0 1 3.1 3.1L10.5 8.3M8.6 10.8 7.4 12a2.2 2.2 0 0 1-3.1-3.1L5.5 7.7" fill="none" stroke-width="1.5" stroke-linecap="round"/><path class="s" d="M10.5 11.5l2 1M5.5 4.5l-2-1" fill="none" stroke-width="1.2" stroke-linecap="round"/>',
  // a chain link over a pencil stroke: a library override (editable copy of linked data)
  library_override:
    '<path class="s" d="M8.4 4.6 9.3 3.7a1.9 1.9 0 0 1 2.7 2.7l-.9.9M7.6 8.3 6.7 9.2a1.9 1.9 0 0 1-2.7-2.7l.9-.9M6.6 7.4l2.8-2.8" fill="none" stroke-width="1.3" stroke-linecap="round"/><path class="f" d="M9.6 9.4l3.6 3.6-1.3 1.3-3.6-3.6-.5-1.8z"/>',
  // the same, faded: an override made as part of a hierarchy (system override)
  library_override_system:
    '<path class="s" d="M8.4 4.6 9.3 3.7a1.9 1.9 0 0 1 2.7 2.7l-.9.9M7.6 8.3 6.7 9.2a1.9 1.9 0 0 1-2.7-2.7l.9-.9M6.6 7.4l2.8-2.8" fill="none" stroke-width="1.3" stroke-linecap="round" opacity=".55"/><path class="f" d="M9.6 9.4l3.6 3.6-1.3 1.3-3.6-3.6-.5-1.8z" opacity=".55"/>',
  // a file with an arrow going into it (append: copy data in)
  append_blend:
    '<path class="s" d="M6.5 1.8h4.5l3 3V14H6.5" fill="none" stroke-width="1.2" stroke-linejoin="round"/><path class="s" d="M1.5 9h7M6 6.3 8.7 9 6 11.7" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  // several stacked files: the libraries of this project
  libraries:
    '<path class="s" d="M5 1.8h5.2l2.8 2.8V11H5z" fill="none" stroke-width="1.2" stroke-linejoin="round"/><path class="s" d="M3 4v10h7.5" fill="none" stroke-width="1.2" stroke-linejoin="round"/>',
});
