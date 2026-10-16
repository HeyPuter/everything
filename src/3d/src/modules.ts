// Feature modules register operators, editors, keymaps, properties tabs and file formats
// as import side effects. Each subsystem owns its own entry module.
import './nodes/index';
import './animation/index';
import './io/formats/index';
import './render/final/index';
import './paint/index';
import './physics/index';
import './scripting/index';
import './modes/index';
import './greasepencil/index';
import './metaball/index';
import './compositor/index';
import './geonodes/index';
// after geometry nodes: hair reuses curve nodes and adds to their Add menu
import './hair/index';
import './spreadsheet/index';
import './tracking/index';
import './sequencer/index';
import './object/index';
import './editors/properties/modui/index';
import './assets/index';
import './bake/index';

export function registerModules() {
  // modules register on import; this function exists to make the dependency explicit
}
