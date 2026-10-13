// Assisted editing: Generate Image and Edit with Prompt (Puter AI, only when
// invoked), Upscale (Enhanced Upscale offline, optional AI detail layer), Mask
// All Objects and Harmonize. Denoise and Sharpen Details are filters (see the
// filter catalog). Dialog modules load on first use.
import type { Editor } from '../../editor';
import { registerCommand, type Command } from '../../app/registry';
import { escapeXML } from '../../model/assets';
import { propertySections } from '../panels/properties';
import { deferRecording } from '../filters/record';
import { canHarmonize } from './harmonize-math';
import './assist.css';

const KIND_LABEL = { generate: 'Generated from a prompt', edit: 'Edited with a prompt', upscale: 'AI upscale (generative)', fill: 'AI Fill', expand: 'AI Expand' } as const;

export function installAssist(e: Editor) {
  void e;
  const lazy = <M,>(load: () => Promise<M>, pick: (m: M) => Command['run']): Command['run'] => async (ed, arg) => pick(await load())(ed, arg);
  const generate = () => import('./generate');
  registerCommand(
    { id: 'edit.generate-image', label: 'Generate Image…', enabled: (ed) => ed.hasDocument, run: lazy(generate, (m) => m.generateImageDialog), recordable: false, description: 'Create a new layer from a text prompt with Puter AI (needs a Puter account).' },
    { id: 'edit.edit-with-prompt', label: 'Edit with Prompt…', enabled: (ed) => ed.hasDocument, run: lazy(generate, (m) => m.editWithPromptDialog), recordable: false, description: 'Change the selection or layer by describing the edit, with Puter AI (needs a Puter account).' },
    { id: 'image.upscale', label: 'Upscale…', shortcut: 'Mod+Alt+Shift+U', enabled: (ed) => ed.hasDocument, run: lazy(() => import('./upscale'), (m) => m.upscaleDialog), description: 'Enlarge the whole image with edge-directed Enhanced Upscale (works offline); optional AI detail layer.' },
    { id: 'layer.mask-all-objects', label: 'Mask All Objects…', enabled: (ed) => ed.hasDocument, run: lazy(() => import('./objects'), (m) => m.maskAllObjectsDialog), description: 'Find each distinct object and create a masked layer, group or saved selection for it.' },
    { id: 'layer.harmonize', label: 'Harmonize…', enabled: (ed) => ed.hasDocument && canHarmonize(ed.layer), run: lazy(() => import('./harmonize'), (m) => m.harmonizeDialog), description: 'Match the layer’s color and tone to the layers beneath it.' },
  );
  // Dialogs record their confirmed settings; the AI commands are never recorded.
  for (const id of ['image.upscale', 'layer.mask-all-objects', 'layer.harmonize']) deferRecording(id);
  // Properties: how an assisted layer was made.
  propertySections.push((_e, l) => {
    const g = l.generated;
    if (!g) return '';
    return `<div class="assist-generated"><small>${KIND_LABEL[g.kind]}${g.model ? ` · ${escapeXML(g.model)}` : ''}${g.style ? ` · ${escapeXML(g.style)} style` : ''}</small>${g.kind === 'upscale' || !g.prompt ? '' : `<q>${escapeXML(g.prompt)}</q>`}</div>`;
  });
}
