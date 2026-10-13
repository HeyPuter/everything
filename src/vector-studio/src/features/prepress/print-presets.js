/**
 * Print presets (Edit > Print Presets and the Print dialog's preset menu).
 * Editing a preset opens the Print dialog's panes.
 */
import { registerPresetKind } from './presets.js';
import { PRINT_DEFAULTS, normalizePrint, printSettingsSummary } from '../io/print-settings.js';

export const PRINT_BUILTINS = {
  Default: { ...PRINT_DEFAULTS },
  'Fit to Letter': { ...PRINT_DEFAULTS, media: 'letter', scaling: 'fit', orientation: 'auto' },
  'Proof with Marks': { ...PRINT_DEFAULTS, media: 'letter', scaling: 'fit', useDocBleed: true, marks: { trim: true, registration: true, colorBars: true, pageInfo: true } },
  'Separations Proof': { ...PRINT_DEFAULTS, media: 'letter', scaling: 'fit', mode: 'separations', marks: { trim: true, registration: true, colorBars: false, pageInfo: true } },
};

registerPresetKind('print', {
  title: 'Print Presets',
  noun: 'Print Preset',
  key: 'printPresets',
  builtins: PRINT_BUILTINS,
  normalize: normalizePrint,
  summary: printSettingsSummary,
  edit: async (app, { name, values, title, names }) => {
    const { loadIO } = await import('../io/index.js');
    const io = await loadIO();
    return io.printDialog(app, { name, values, title, names });
  },
});
