/**
 * PDF presets (Edit > PDF Presets and the PDF options' preset menu).
 * Passwords are never stored in presets.
 */
import { registerPresetKind } from './presets.js';
import { PDF_DEFAULTS, presetPdf, pdfSummary } from '../io/pdf-settings.js';

const marksAll = { trim: true, registration: true, colorBars: true, pageInfo: true };

export const PDF_BUILTINS = {
  'Print Quality': { ...PDF_DEFAULTS },
  'Press Ready': { ...PDF_DEFAULTS, standard: 'press', compat: '1.6', colorConversion: 'convert', destination: 'cmyk:document', marks: marksAll, useDocBleed: true, downsampleAbove: 450, downsamplePpi: 300 },
  'Small File': { ...PDF_DEFAULTS, compat: '1.5', downsample: 'bicubic', downsamplePpi: 100, downsampleAbove: 150, imageCompression: 'jpeg', jpegQuality: 0.5, colorConversion: 'convert', destination: 'rgb:srgb' },
  'Editable Archive': { ...PDF_DEFAULTS, layers: true, thumbnails: true, downsample: 'none', imageCompression: 'zip', textOutlines: false },
  'PDF/X-1a:2001': { ...PDF_DEFAULTS, standard: 'x1a', colorConversion: 'convert', destination: 'cmyk:document', flatten: true, flattener: 'Medium Resolution', marks: marksAll, useDocBleed: true, downsampleAbove: 450, downsamplePpi: 300, profileInclusion: 'none' },
  'PDF/X-4': { ...PDF_DEFAULTS, standard: 'x4', compat: '1.6', colorConversion: 'none', marks: marksAll, useDocBleed: true, downsampleAbove: 450, downsamplePpi: 300 },
};

registerPresetKind('pdf', {
  title: 'PDF Presets',
  noun: 'PDF Preset',
  key: 'pdfPresets',
  builtins: PDF_BUILTINS,
  normalize: presetPdf,
  summary: pdfSummary,
  edit: async (app, { name, values, title, names }) => {
    const { loadIO } = await import('../io/index.js');
    const io = await loadIO();
    return io.pdfOptionsDialog(app, { presetEdit: { name, values, title, names } });
  },
});
