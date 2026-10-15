// Compositor subsystem entry point (imported from src/modules.ts for its registrations):
// - nodes/defs: COMPOSITOR node types and the Add menu
// - ops/*: GPU implementations of every registered node
// - session: render post-processing hook, Viewer Node image, live re-compositing
// - editor: the Compositor node editor (backdrop, header, operators)
// - properties: Output ▸ Post Processing panel
import { registerIcons } from '../ui/icons';
import './nodes/defs';
import './nodes/extra';
import './ops/input';
import './ops/color';
import './ops/keying';
import './ops/transform';
import './ops/mask';
import './ops/filter';
import './ops/glare';
import './ops/utility';
import './ops/info';
import './ops/colorspace';
import './ops/distance';
import './ops/keyingnode';
import './session';
import './editor';
import './properties';
import './style.css';

registerIcons({
  color_red: '<rect x="3" y="3" width="10" height="10" rx="2" fill="#e05656"/>',
  color_green: '<rect x="3" y="3" width="10" height="10" rx="2" fill="#5ec25e"/>',
  color_blue: '<rect x="3" y="3" width="10" height="10" rx="2" fill="#5a86e6"/>',
});

export { runCompositor } from './run';
export { compositorState, recomposite } from './session';
export { compositingGroup, compositingActive, newCompositingGroup } from './data';
