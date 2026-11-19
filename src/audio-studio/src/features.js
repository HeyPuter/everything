// Feature modules. Each exports install(app) and registers its commands,
// panels, document kinds and menu providers. Order matters only where noted.

import { installCore } from './features/core.js';
import { installEffects } from './features/effects.js';
import { installEffectsDsp } from './features/effects-dsp.js';
import { installMultitrack } from './features/multitrack.js';
import { installIo } from './features/io.js';
import { installSpectralAnalysis } from './features/spectral-analysis.js';
import { installSoundAssistant } from './features/sound-assistant.js';
import { installPanelsExtra } from './features/panels-extra.js';
import { installPreferences } from './features/preferences.js';
import { installControlSurface } from './control-surface/index.js';
import { installMoreCommands } from './multitrack/more-commands.js';
import { installVideo } from './features/video.js';
import { installKeymap } from './commands/keymap.js';
import { installLearn } from './learn/install.js';

// The keymap goes last: it sets the default keys of commands the others register.
export const FEATURES = [installCore, installEffects, installEffectsDsp, installMultitrack, installIo, installSpectralAnalysis, installSoundAssistant, installPanelsExtra, installPreferences, installControlSurface, installMoreCommands, installVideo, installLearn, installKeymap];
