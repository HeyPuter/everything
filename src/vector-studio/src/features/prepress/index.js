/**
 * Print production: color management (Edit > Color Settings, Assign
 * Profile, color-managed proofs and CMYK conversion), the Separations
 * Preview panel, Effect > Video, and the presets for transparency
 * flattening, printing and PDF export.
 */
import './styles.css';
import { registerIcons } from '../../ui/icons.js';
import { viewHooks } from '../../render/canvas-view.js';
import { PROOFS, proofHooks, applyProof } from '../workspace/view.js';
import { cmykEngine } from '../../lib/color.js';
import { documentCmykProfile, separate, simulate } from './color-management.js';
import { proofBody, documentCmykLabel } from './proof.js';
import { colorSettingsDialog, assignProfileDialog, proofCustomizeDialog } from './color-dialogs.js';
import { drawSeparations, separationState } from './separations.js';
import { drawGpuProof, gpuHandlesProof } from './gpu-proof.js';
import { SeparationsPanel } from './separations-panel.js';
import { videoEffectCommands } from './video-effects.js';
import { presetsManagerDialog } from './presets.js';
import { flattenTransparencyDialog } from './flattener-presets.js';
import './print-presets.js';
import './pdf-presets.js';

const P = (d, extra = {}) => ['path', { d, ...extra }];

registerIcons({
  // Three overlapping plates.
  'panel-separations': [['circle', { cx: '9', cy: '9', r: '5' }], ['circle', { cx: '15', cy: '9', r: '5' }], ['circle', { cx: '12', cy: '14.5', r: '5' }]],
  // A stack flattening into one sheet.
  'panel-flattener': [P('M4 7l8-4 8 4-8 4z'), P('M4 12l8 4 8-4', { 'stroke-dasharray': '2 2' }), P('M4 17l8 4 8-4')],
});

export function install(app) {
  const hasDoc = (a) => Boolean(a.editor);
  const refreshProof = () => {
    applyProof(app, { refresh: true });
    for (const v of app.views?.values?.() || []) v.invalidate?.();
  };

  // Proofs from the color settings.
  proofHooks.body = (kind) => proofBody(app, kind);
  PROOFS.cmyk.label = (a) => documentCmykLabel(a);
  PROOFS.custom.label = 'Custom';

  // Convert to CMYK separates with the document's press model.
  cmykEngine.toCmyk = (rgb) => separate([rgb.r / 255, rgb.g / 255, rgb.b / 255], documentCmykProfile(app, app.editor?.doc));
  cmykEngine.toRgb = (cmyk) => {
    const v = simulate(cmyk, documentCmykProfile(app, app.editor?.doc));
    return { r: v[0] * 255, g: v[1] * 255, b: v[2] * 255 };
  };

  app.commands.register([
    { id: 'edit.colorSettings', label: 'Color Settings...', shortcut: 'Shift+Mod+K', run: async (a) => (await colorSettingsDialog(a)) && refreshProof() },
    { id: 'edit.assignProfile', label: 'Assign Profile...', enabled: hasDoc, run: async (a) => (await assignProfileDialog(a)) && refreshProof() },
    {
      id: 'view.proof.customize',
      label: 'Customize...',
      enabled: hasDoc,
      checked: (a) => a.editor?.viewOptions.proof === 'custom',
      run: async (a) => {
        if (!(await proofCustomizeDialog(a))) return;
        const ed = a.editor;
        ed.viewOptions = { ...ed.viewOptions, proof: 'custom', proofColors: true };
        ed.emit('view-options');
        refreshProof();
      },
    },
    ...videoEffectCommands(),
    { id: 'edit.pdfPresets', label: 'PDF Presets...', run: (a) => presetsManagerDialog(a, 'pdf') },
    { id: 'edit.printPresets', label: 'Print Presets...', run: (a) => presetsManagerDialog(a, 'print') },
    { id: 'edit.flattenerPresets', label: 'Transparency Flattener Presets...', run: (a) => presetsManagerDialog(a, 'flattener') },
    { id: 'object.flatten', label: 'Flatten Transparency...', enabled: (a) => Boolean(a.editor?.selection.size), run: (a) => flattenTransparencyDialog(a) },
  ]);
  app.registerPanel(SeparationsPanel);

  // Separations first: while they show, the proof does not apply on top.
  viewHooks.postArt.push((ctx, editor) => {
    if (separationState(editor).on) drawSeparations(app, ctx, editor);
    else drawGpuProof(app, ctx, editor);
  });
  proofHooks.canvas = (editor) => separationState(editor).on || gpuHandlesProof(app, editor);

  app.prefs.on?.('change', ({ key }) => {
    if (key === 'colorSettings' || key === 'proofCustom') refreshProof();
  });
  // A document's assigned profile changes its proofs and separations.
  const watched = new WeakSet();
  app.on('active-editor', (ed) => {
    applyProof(app, { refresh: true });
    if (!ed || watched.has(ed)) return;
    watched.add(ed);
    let last = ed.doc.root.colorProfile;
    // Separations replace the proof filter while they show.
    ed.on('view-options', () => applyProof(app));
    ed.on('doc-change', () => {
      const p = ed.doc.root.colorProfile;
      if (p === last) return;
      last = p;
      refreshProof();
    });
  });
}
