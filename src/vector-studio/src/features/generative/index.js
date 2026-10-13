/**
 * Generative features on Puter AI:
 *   Object > Generative > Generate Vectors, Generative Shape Fill,
 *     Rewrite (Generate Text, Fit Text to Frame, Proofread, Translate,
 *     Rewrite), Recolor from Prompt, Generate Patterns, Generation History
 *   Edit > Edit Colors > Recolor from Prompt, Type > Rewrite
 *   Object > Remove Background (local, no AI)
 *   the Generate and Generation History panels, and task bar quick actions.
 * Pictures come from puter.ai.txt2img and are traced into vectors with the
 * Trace Image engine; text and palettes come from puter.ai.chat. Everything
 * reports progress, can be cancelled, and explains what is needed when
 * signed out or offline. Tests inject a fake client as app.generativeAI.
 */
import './styles.css';
import { registerGenerativeIcons } from './icons.js';
import { GenerationHistory } from './history.js';
import { GeneratePanel, openGenerate } from './generate-panel.js';
import { GenerationHistoryPanel } from './history-panel.js';
import { selectedShape } from './place.js';
import { generativeRecolorDialog } from './recolor.js';
import { generateTextDialog, rewriteDialog, proofread, translate, fitText, fitTargets, hasTargets } from './text-ai.js';
import { removeBackgroundCommand } from './background.js';
import { selectedImages } from '../trace/trace-commands.js';

const TEXT_MENU = ['generative.text.rewrite', 'generative.text.proofread', 'generative.text.translate', 'generative.text.fit', '-', 'generative.text.generate'];

export function install(app) {
  registerGenerativeIcons();
  app.generativeHistory = new GenerationHistory(app.prefs?.storage || null);
  app.registerPanel(GeneratePanel);
  app.registerPanel(GenerationHistoryPanel);

  const hasEditor = (a) => Boolean(a.editor);
  const hasSel = (a) => Boolean(a.editor?.selection.size);
  app.commands.register([
    { id: 'generative.vectors', label: 'Generate Vectors...', enabled: hasEditor, run: (a) => openGenerate(a, 'vectors') },
    { id: 'generative.shapeFill', label: 'Generative Shape Fill...', enabled: (a) => Boolean(selectedShape(a.editor)), run: (a) => openGenerate(a, 'shapeFill') },
    { id: 'generative.patterns', label: 'Generate Patterns...', enabled: hasEditor, run: (a) => openGenerate(a, 'pattern') },
    { id: 'generative.recolor', label: 'Recolor from Prompt...', enabled: hasSel, run: (a, args) => generativeRecolorDialog(a, args || {}) },
    { id: 'generative.text.generate', label: 'Generate Text...', enabled: hasEditor, run: (a) => generateTextDialog(a) },
    { id: 'generative.text.fit', label: 'Fit Text to Frame', enabled: (a) => fitTargets(a).length > 0, run: (a) => fitText(a) },
    { id: 'generative.text.proofread', label: 'Proofread', enabled: hasTargets, run: (a) => proofread(a) },
    { id: 'generative.text.translate', label: 'Translate...', enabled: hasTargets, run: (a) => translate(a) },
    { id: 'generative.text.rewrite', label: 'Rewrite...', enabled: hasTargets, run: (a) => rewriteDialog(a) },
    { id: 'object.removeBackground', label: 'Remove Background...', enabled: (a) => selectedImages(a.editor).length > 0, run: (a) => removeBackgroundCommand(a) },
  ]);

  // Task bar quick actions.
  app.taskbarExtras ||= [];
  app.taskbarExtras.push((ctx, { cmdButton, menuButton }) => {
    if (ctx === 'none') return [cmdButton('generative.vectors', 'Generate Vectors', 'gen-vectors')];
    if (ctx === 'path' || ctx === 'shape') return [cmdButton('generative.shapeFill', 'Shape Fill', 'gen-shape-fill', { text: false })];
    if (ctx === 'text') return [menuButton('Rewrite', 'gen-text', TEXT_MENU, { text: false })];
    if (ctx === 'group' || ctx === 'multiple' || ctx === 'live' || ctx === 'clip' || ctx === 'blend') return [cmdButton('generative.recolor', 'Recolor from Prompt', 'gen-recolor', { text: false })];
    if (ctx === 'image') return [cmdButton('object.removeBackground', 'Remove Background', 'gen-remove-bg', { text: false })];
    if (ctx === 'other') {
      const n = app.editor?.doc.get(app.editor.topSelection()[0]);
      if (n?.type === 'image') return [cmdButton('object.removeBackground', 'Remove Background', 'gen-remove-bg', { text: false })];
    }
    return [];
  });
}
