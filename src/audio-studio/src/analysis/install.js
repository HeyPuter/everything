// Analysis panels: Frequency Analysis, Amplitude Statistics, Phase Analysis,
// Phase Meter and Match Loudness, plus Effects > Match Loudness.

import '../styles/analysis.css';
import { frequencyPanel } from './frequency.js';
import { amplitudePanel } from './amplitude.js';
import { phaseAnalysisPanel, phaseMeterPanel } from './phase.js';
import { loudnessPanel } from './loudness.js';

export function installAnalysis(app) {
  app.registerPanel({ id: 'frequency', title: 'Frequency Analysis', create: frequencyPanel, near: ['levels', 'selection'] });
  app.registerPanel({ id: 'amplitude', title: 'Amplitude Statistics', create: amplitudePanel, near: ['history', 'markers', 'properties'] });
  app.registerPanel({ id: 'phaseAnalysis', title: 'Phase Analysis', create: phaseAnalysisPanel, near: ['phase', 'frequency', 'levels'] });
  app.registerPanel({
    id: 'phase',
    title: 'Phase Meter',
    create: phaseMeterPanel,
    near: ['levels', 'selection'],
    menu: (a) => [{ type: 'cmd', label: 'Reset Indicators', enabled: true, run: () => a.dock.instances.get('phase')?.resetHold() }],
  });
  app.registerPanel({ id: 'loudness', title: 'Match Loudness', create: loudnessPanel, near: ['properties', 'assistant', 'effects'] });
  app.commands.register({
    id: 'fx.matchLoudness',
    label: 'Match Loudness...',
    run: () => {
      app.dock.openPanel('loudness', { attention: true });
      if (app.active?.kind === 'audio') app.matchLoudnessAdd?.(app.active);
    },
  });
}
