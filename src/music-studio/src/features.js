// Feature modules, installed in order after the core. Each exports
// install(app) and registers its panels, commands and menu items.

import * as playlist from './panels/playlist.js';
import * as rack from './panels/channel-rack.js';
import * as pianoRoll from './panels/piano-roll.js';
import * as mixer from './panels/mixer.js';
import * as browser from './panels/browser.js';

export const FEATURES = [browser, playlist, rack, pianoRoll, mixer];
