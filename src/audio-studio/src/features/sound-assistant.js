// Sound Assistant, Batch Process and Diagnostics panels.

import '../styles/sound-assistant.css';
import { Mic, Music, Zap, Trees } from 'lucide';
import { registerIcons } from '../ui/icons.js';
import { soundAssistantPanel } from '../sound-assistant/panel.js';
import { batchPanel } from '../batch/panel.js';
import { diagnosticsPanel, DIAGNOSTICS } from '../diagnostics/panel.js';

export function installSoundAssistant(app) {
  registerIcons({ 'sa-dialogue': Mic, 'sa-music': Music, 'sa-sfx': Zap, 'sa-ambience': Trees });
  app.registerPanel({ id: 'assistant', title: 'Sound Assistant', create: soundAssistantPanel, near: ['properties', 'effects'] });
  app.registerPanel({ id: 'batch', title: 'Batch Process', create: batchPanel, near: ['files', 'favorites', 'media'] });
  app.registerPanel({ id: 'diagnostics', title: 'Diagnostics', create: diagnosticsPanel, near: ['assistant', 'properties'] });

  // Effects > Diagnostics items open the Diagnostics panel on that diagnostic
  // (scan, review, then repair) so each problem can be checked before it is
  // fixed; the effects stay available
  // in the Effects Rack and Favorites.
  for (const { id } of DIAGNOSTICS) {
    const cmd = app.commands.commands.get(`fx.${id}`);
    if (!cmd) continue;
    app.commands.register({
      ...cmd,
      repeatable: false,
      run: () => {
        app.dock.openPanel('diagnostics', { attention: true });
        app.dock.instance('diagnostics')?.select?.(id);
      },
    });
  }
}
