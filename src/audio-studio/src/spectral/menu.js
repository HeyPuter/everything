// The spectral display settings menu (the sliders button on the frequency
// ruler, View menu entries and the command search all lead here).

import { COLORMAPS } from './colormaps.js';
import { settings, setSettings, logScale, pitchOn, FFT_SIZES, WINDOWS, FLOORS, CEILINGS } from './state.js';

export function spectralMenuItems(app) {
  const s = settings(app);
  const radio = (label, checked, run) => ({ type: 'cmd', label, enabled: true, checked, run });
  return [
    { type: 'sub', label: 'Color Map', items: Object.entries(COLORMAPS).map(([id, m]) => radio(m.label, s.map === id, () => setSettings(app, { map: id }))) },
    {
      type: 'sub',
      label: 'Frequency Scale',
      items: [radio('Logarithmic', logScale(app), () => app.prefs.set('spectralLog', true)), radio('Linear', !logScale(app), () => app.prefs.set('spectralLog', false))],
    },
    { type: 'sub', label: 'Resolution', items: FFT_SIZES.map((n) => radio(`${n} bands`, s.fft === n, () => setSettings(app, { fft: n }))) },
    { type: 'sub', label: 'Window', items: WINDOWS.map((w) => radio(w.label, s.window === w.value, () => setSettings(app, { window: w.value }))) },
    { type: 'sub', label: 'Range Floor', items: FLOORS.map((db) => radio(`${db} dB`, s.minDb === db, () => setSettings(app, { minDb: db }))) },
    { type: 'sub', label: 'Range Ceiling', items: CEILINGS.map((db) => radio(`${db} dB`, s.maxDb === db, () => setSettings(app, { maxDb: db }))) },
    { type: 'sep' },
    { type: 'cmd', label: 'Zoom In (Frequency)', shortcut: app.commands.shortcutLabel('view.zoomInFreq'), enabled: app.commands.isEnabled('view.zoomInFreq'), run: () => app.commands.run('view.zoomInFreq') },
    { type: 'cmd', label: 'Zoom Out (Frequency)', shortcut: app.commands.shortcutLabel('view.zoomOutFreq'), enabled: app.commands.isEnabled('view.zoomOutFreq'), run: () => app.commands.run('view.zoomOutFreq') },
    { type: 'cmd', label: 'Show All Frequencies', enabled: app.commands.isEnabled('view.zoomFullFreq'), run: () => app.commands.run('view.zoomFullFreq') },
    { type: 'sep' },
    radio('Pitch Display', pitchOn(app), () => app.commands.run(pitchOn(app) ? 'view.spectral' : 'view.spectralPitch')),
    { type: 'cmd', label: 'Reset Display Settings', enabled: true, run: () => app.prefs.set('spectralSettings', {}) },
  ];
}
