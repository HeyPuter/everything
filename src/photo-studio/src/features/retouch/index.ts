// Retouching and assisted selection: healing tools, Quick/Object Selection,
// Magnetic Lasso, Select Subject/Sky, Color Range, Select and Mask, Context
// Fill, AI Fill/Expand, Remove Background, Matting and the Contextual Task Bar.
// Tools, commands and menus register here; their implementations load on
// first use (app/lazy.ts).
import type { Editor } from '../../editor';
import { contributeMenu, registerCommand, registerOverlay, registerTool, type Tool } from '../../app/registry';
import { lazy, lazyRun, lazyTool } from '../../app/lazy';
import { installTaskbar } from './taskbar';
import { hasMask } from '../../model/masks';

const selectTools = lazy(() => import('./tools-select'));
const healTools = lazy(() => import('./tools-heal'));
const commands = lazy(() => import('./commands'));
const colorRange = lazy(() => import('./color-range'));
const focusArea = lazy(() => import('./focus-area'));
const selectAndMask = lazy(() => import('./select-mask'));
const contextFill = lazy(() => import('./context-fill'));
const ai = lazy(() => import('./ai'));
const refineMask = lazy(() => import('./refine-mask'));

type ToolMeta = Parameters<typeof lazyTool>[0];
const tool = (meta: ToolMeta, list: typeof selectTools | typeof healTools) =>
  lazyTool(
    meta,
    lazy(async () => {
      const m = await list();
      const tools: Tool[] = 'selectTools' in m ? m.selectTools : m.healTools;
      return tools.find((t) => t.id === meta.id)!;
    }),
  );

export function installRetouch(e: Editor) {
  registerTool(
    tool({ id: 'object-selection', label: 'Object Selection Tool', key: 'W', icon: 'object-select', group: 'select' }, selectTools),
    tool({ id: 'quick-selection', label: 'Quick Selection Tool', key: 'W', icon: 'quick-select', group: 'select' }, selectTools),
    tool({ id: 'magnetic-lasso', label: 'Magnetic Lasso Tool', key: 'L', icon: 'lasso-magnetic', group: 'lasso' }, selectTools),
    tool({ id: 'spot-healing', label: 'Spot Healing Brush Tool', key: 'J', icon: 'heal-spot', group: 'heal' }, healTools),
    tool({ id: 'healing-brush', label: 'Healing Brush Tool', key: 'J', icon: 'bandage', group: 'heal' }, healTools),
    tool({ id: 'patch', label: 'Patch Tool', key: 'J', icon: 'patch', group: 'heal' }, healTools),
    tool({ id: 'context-move', label: 'Context Move Tool', key: 'J', icon: 'context-move', group: 'heal' }, healTools),
    tool({ id: 'remove-tool', label: 'Remove Tool', key: 'J', icon: 'remove-tool', group: 'heal' }, healTools),
    tool({ id: 'red-eye', label: 'Red Eye Tool', key: 'J', icon: 'red-eye', group: 'heal' }, healTools),
  );
  const doc = (e: Editor) => e.hasDocument;
  const pixel = (e: Editor) => e.layer?.kind === 'pixel';
  const sel = (e: Editor) => !!e.doc.selection;
  registerCommand(
    { id: 'select.subject', label: 'Subject', description: 'Select the most prominent subject in the image.', enabled: doc, ...lazyRun(commands, (m, e) => m.selectSubject(e)) },
    { id: 'select.sky', label: 'Sky', description: 'Select the sky along the top of the image.', enabled: doc, ...lazyRun(commands, (m, e) => m.selectSky(e)) },
    {
      id: 'layer.remove-background',
      label: 'Remove Background',
      description: 'Hide the background of the selected layer with a layer mask (non-destructive).',
      enabled: (e) => !!e.layer && e.layer.kind !== 'group' && e.layer.kind !== 'adjustment',
      ...lazyRun(commands, (m, e) => m.removeBackground(e)),
    },
    {
      id: 'layer.mask-refine-edge',
      label: 'Refine Mask Edge…',
      description: 'Re-estimate the layer mask near its edge from the layer’s pixels, so hair and soft outlines follow the image.',
      enabled: (e) => !!e.layer && e.layer.kind !== 'group' && e.layer.kind !== 'adjustment' && (hasMask(e.layer) || !!e.layer.maskGrid),
      ...lazyRun(refineMask, (m, e) => m.refineMaskEdge(e)),
    },
    { id: 'layer.defringe', label: 'Defringe…', enabled: pixel, ...lazyRun(commands, (m, e) => m.runMatting(e, 'defringe')) },
    { id: 'layer.color-decontaminate', label: 'Color Decontaminate…', enabled: pixel, ...lazyRun(commands, (m, e) => m.runMatting(e, 'decontaminate')) },
    { id: 'layer.remove-black-matte', label: 'Remove Black Matte', enabled: pixel, ...lazyRun(commands, (m, e) => m.runMatting(e, 'black')) },
    { id: 'layer.remove-white-matte', label: 'Remove White Matte', enabled: pixel, ...lazyRun(commands, (m, e) => m.runMatting(e, 'white')) },
    { id: 'select.color-range', label: 'Color Range…', description: 'Select pixels by sampled color or a preset range.', enabled: doc, ...lazyRun(colorRange, (m, e) => m.openColorRange(e)) },
    { id: 'select.focus-area', label: 'Focus Area…', description: 'Select the in-focus parts of the image.', enabled: doc, ...lazyRun(focusArea, (m, e) => m.openFocusArea(e)) },
    {
      id: 'select.mask-refine',
      label: 'Select and Mask…',
      shortcut: 'Mod+Alt+R',
      description: 'Refine the selection edge with edge detection, brushes and global refinements.',
      enabled: doc,
      ...lazyRun(selectAndMask, (m, e, arg) => m.openSelectAndMask(e, arg === 'mask')),
    },
    { id: 'edit.context-fill', label: 'Context Fill…', description: 'Fill the selection with texture and structure from elsewhere in the image.', enabled: sel, ...lazyRun(contextFill, (m, e) => m.openContextFill(e)) },
    { id: 'edit.context-fill-apply', label: 'Context Fill', hidden: true, enabled: sel, ...lazyRun(contextFill, (m, e) => m.quickContextFill(e)) },
    { id: 'edit.ai-fill', label: 'AI Fill…', description: 'Generate new content in the selection with Puter AI (needs a Puter account).', enabled: sel, ...lazyRun(ai, (m, e) => m.openAIFill(e)), recordable: false },
    { id: 'edit.ai-expand', label: 'AI Expand…', description: 'Extend the canvas and generate the new area with Puter AI (needs a Puter account).', enabled: doc, ...lazyRun(ai, (m, e) => m.openAIExpand(e)), recordable: false },
  );
  // Live previews of the Color Range and Focus Area dialogs.
  registerOverlay('color-range-preview', () => colorRange.loaded?.previewOverlay() ?? '');
  registerOverlay('focus-area-preview', () => focusArea.loaded?.previewOverlay() ?? '');
  contributeMenu('edit', ['edit.ai-expand'], 'edit.ai-fill');
  installTaskbar(e);
  contributeMenu('layer', ['layer.remove-background'], 'layer.clipping-mask');
}
