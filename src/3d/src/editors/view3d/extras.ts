// Entry module of later 3D Viewport / Object Mode additions (imported from object/index.ts).
import './view3d-r4.css';
import './selectops';
import './lightdraw';
import './datagizmos';
import './viewops';
import './camdraw';
import './objdisplay';
import './bpyspace';
import { registerIcons } from '../../ui/icons';

// snapping target icons (edge centre, perpendicular, face centre)
registerIcons({
  snap_midpoint: '<path class="s" d="M2 13 14 3" fill="none" stroke-width="1.3"/><rect class="f" x="6" y="6" width="4" height="4" transform="rotate(45 8 8)"/>',
  snap_perpendicular: '<path class="s" d="M2 13h12M8 13V3" fill="none" stroke-width="1.3"/><path class="s" d="M8 10.5h2.5V13" fill="none" stroke-width="1"/><circle class="f" cx="8" cy="3" r="1.5"/>',
  snap_face_center: '<path class="s" d="M2.5 4.5 13.5 2.5v9l-11 2z" fill="none" stroke-width="1.2" stroke-linejoin="round"/><circle class="f" cx="8" cy="8" r="2"/>',
});
