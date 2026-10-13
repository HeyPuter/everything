// The steps of each hands-on tutorial. Action steps finish when the user
// really does the thing (a command runs, a tool is chosen, or the document
// changes as asked); reading steps continue with Next.
import { allLayers } from '../../model/document';
import { checks, type Check, type Tutorial } from './tour';
import { TUTORIALS } from './tutorial-list';

const info = (id: string) => TUTORIALS.find((t) => t.id === id)!;

const textAdded: Check = (now, base) => {
  const titled = (v: typeof now) => allLayers(v.doc.layers).filter((l) => l.kind === 'text' && l.text.trim().length > 0).length;
  return titled(now) > titled(base);
};
const adjustmentShownAgain: Check = (now, base) =>
  allLayers(now.doc.layers).some((l) => l.kind === 'adjustment' && l.visible && allLayers(base.doc.layers).some((b) => b.id === l.id && !b.visible));

export const TUTORIAL_STEPS: Record<string, Tutorial['steps']> = {
  layers: [
    {
      title: 'Your image is a stack of layers',
      text: 'The Layers panel lists everything in the document, top to bottom. Right now there is only the Background: the photo itself. Painting straight onto it would change the photo for good, so we will paint on a layer of its own.',
      anchor: { panel: 'layers' },
      panel: 'layers',
    },
    {
      title: 'Add an empty layer',
      text: 'Click the + button at the bottom of the Layers panel. A transparent layer appears above the Background and becomes the selected layer.',
      anchor: { command: 'layer.new-quick' },
      panel: 'layers',
      check: checks.layerAdded,
    },
    {
      title: 'Pick up the Brush',
      text: 'Choose the Brush tool in the toolbar (or press B).',
      anchor: { tool: 'brush' },
      tool: 'brush',
    },
    {
      title: 'Paint on the new layer',
      text: 'Drag across the sky to paint a few strokes. They land on the new layer, so the meadow underneath stays untouched.',
      anchor: { canvas: true },
      check: checks.pixelsChanged,
    },
    {
      title: 'Make the strokes see-through',
      text: 'Lower the layer’s Opacity at the top of the Layers panel. Opacity fades the whole layer at once, and you can raise it again whenever you like.',
      anchor: { selector: '[data-panel="layers"] .layer-options' },
      panel: 'layers',
      check: checks.opacityLowered,
    },
    {
      title: 'Hide a layer to compare',
      text: 'Click the eye next to your paint layer. The strokes disappear while the layer stays in the document; click the empty box again to bring them back.',
      anchor: { selector: '#layers' },
      panel: 'layers',
      check: checks.layerHidden,
    },
    {
      title: 'That is the core idea',
      text: 'Separate layers keep every change editable. You can reorder them by dragging, rename them with a double-click and merge them when you are done.',
      anchor: { panel: 'layers' },
    },
  ],
  masking: [
    {
      title: 'Hide, don’t erase',
      text: 'A layer mask hides parts of a layer without deleting any pixels. The orange ball sits on the Photo layer; below it is a plain Backdrop layer that will show through wherever we hide the photo.',
      anchor: { panel: 'layers' },
      panel: 'layers',
    },
    {
      title: 'Select the ball',
      text: 'Open the Select menu and choose Subject. You can also draw around the ball with the Lasso or the Object Selection tool; any selection works.',
      anchor: { menu: 'Select' },
      check: checks.selectionMade,
    },
    {
      title: 'Turn the selection into a mask',
      text: 'With the Photo layer selected, click the Add layer mask button at the bottom of the Layers panel. The selected area stays visible and everything else is hidden.',
      anchor: { command: 'layer.add-mask' },
      panel: 'layers',
      check: checks.maskAdded,
    },
    {
      title: 'Choose the Brush',
      text: 'Pick the Brush tool. While the mask thumbnail is selected in the Layers panel, the brush paints on the mask instead of the photo.',
      anchor: { tool: 'brush' },
      tool: 'brush',
    },
    {
      title: 'Refine the mask by painting',
      text: 'Paint with black to hide more and with white to reveal again (press X to swap the colors). Try cleaning up the bottom edge of the ball.',
      anchor: { canvas: true },
      check: checks.maskEdited,
    },
    {
      title: 'Nothing was lost',
      text: 'Everything outside the ball is still there, only hidden. Shift-click the mask thumbnail to switch the mask off and on, or use Layer → Layer Mask for more options.',
      anchor: { panel: 'layers' },
    },
  ],
  adjustments: [
    {
      title: 'A flat, hazy image',
      text: 'These hills lack contrast. Instead of changing the pixels, we will add an adjustment layer that changes how everything below it looks, and can be tweaked later.',
      anchor: { canvas: true },
    },
    {
      title: 'Add an adjustment layer',
      text: 'Click the half-filled circle at the bottom of the Layers panel and choose Curves or Levels (any adjustment works).',
      anchor: { selector: '[data-layer-adjust]' },
      panel: 'layers',
      check: checks.kindAdded('adjustment'),
    },
    {
      title: 'Change its settings',
      text: 'The adjustment’s controls are in the Properties panel. For Levels, drag the black and white input sliders toward the edges of the histogram; for Curves, pull the curve into a gentle S.',
      anchor: { panel: 'properties' },
      panel: 'properties',
      check: checks.adjustmentEdited,
    },
    {
      title: 'Compare before and after',
      text: 'Hide the adjustment layer with its eye in the Layers panel to see the original.',
      anchor: { selector: '#layers' },
      panel: 'layers',
      check: checks.layerHidden,
    },
    {
      title: 'Bring it back',
      text: 'Show the adjustment layer again. You can return to its settings at any time, lower its opacity, or paint on its mask to apply it to part of the image only.',
      anchor: { selector: '#layers' },
      panel: 'layers',
      check: adjustmentShownAgain,
    },
  ],
  retouch: [
    {
      title: 'Small spots, quick fixes',
      text: 'This close-up has a few dark spots. The Spot Healing Brush replaces a spot with texture from around it in a single click.',
      anchor: { canvas: true },
    },
    {
      title: 'Zoom in',
      text: 'Zoom in so the spots are easy to hit: use the + button in the status bar, press ⌘ and + (Ctrl and + on Windows), or click with the Zoom tool.',
      anchor: { selector: '.status-zoom' },
      check: checks.zoomedIn,
    },
    {
      title: 'Choose the Spot Healing Brush',
      text: 'Pick the Spot Healing Brush in the toolbar (or press J). Make the brush a little larger than a spot with the ] key.',
      anchor: { tool: 'spot-healing' },
      tool: 'spot-healing',
    },
    {
      title: 'Click on a spot',
      text: 'Click once on one of the dark spots. It blends into the skin around it.',
      anchor: { canvas: true },
      check: checks.pixelsChanged,
    },
    {
      title: 'Finish the rest',
      text: 'Heal the other spots the same way. If a result looks wrong, undo with ⌘Z (Ctrl+Z) and try again with a slightly larger brush. For larger areas, the Healing Brush and the Patch tool give you more control.',
      anchor: { canvas: true },
    },
  ],
  'text-shapes': [
    {
      title: 'Make a simple poster',
      text: 'Text and shapes stay editable: you can change the words, the font or the shape at any time without losing quality.',
      anchor: { canvas: true },
    },
    {
      title: 'Choose the Type tool',
      text: 'Pick the Type tool in the toolbar (or press T).',
      anchor: { tool: 'type' },
      tool: 'type',
    },
    {
      title: 'Write a title',
      text: 'Click on the poster and type a word or two, then press Escape or click the check mark in the options bar to finish. The font, size and color are in the options bar and the Character panel.',
      anchor: { canvas: true },
      check: textAdded,
    },
    {
      title: 'Choose the Rectangle tool',
      text: 'Pick the Rectangle tool from the shape tools (or press U until it is active).',
      anchor: { tool: 'rect-shape' },
      tool: 'rect-shape',
    },
    {
      title: 'Draw a shape',
      text: 'Drag on the canvas to draw a rectangle. It becomes a shape layer whose fill and stroke you can change in the options bar.',
      anchor: { canvas: true },
      check: checks.kindAdded('vector'),
    },
    {
      title: 'Add a shadow',
      text: 'With a layer selected, click the fx button at the bottom of the Layers panel and choose Drop Shadow, then confirm the dialog. Effects follow the layer when you move or edit it.',
      anchor: { command: 'layer.style-dialog' },
      panel: 'layers',
      check: checks.styleAdded,
    },
    {
      title: 'Arrange your design',
      text: 'Drag layers in the Layers panel to put the title above the rectangle, and use the Move tool (V) to position them. Layer → Align lines up several selected layers.',
      anchor: { panel: 'layers' },
    },
  ],
  exporting: [
    {
      title: 'Projects and exports',
      text: 'A .photo project keeps layers, masks and text editable. An export is a flattened copy (PNG, JPEG, WebP and more) for sharing. You usually want both.',
      anchor: { canvas: true },
    },
    {
      title: 'Export a copy',
      text: 'Click Export in the top-right corner. Pick a format and quality while the preview shows the result and its file size, then export (or cancel to continue the tour).',
      anchor: { selector: '.export-button' },
      commands: ['file.export-as'],
    },
    {
      title: 'Export again in one step',
      text: 'Open File → Export and choose Quick Export. It reuses your last settings without asking, which is handy while you iterate.',
      anchor: { menu: 'File' },
      commands: ['file.quick-export-png'],
    },
    {
      title: 'Keep the editable project',
      text: 'Save the project with File → Save (to Puter) or File → Download Project to keep a .photo file on this device. Opening it later brings back every layer.',
      anchor: { menu: 'File' },
      commands: ['file.download-project', 'file.save', 'file.save-as', 'file.save-copy'],
    },
  ],
};

/** A tutorial with its steps, or undefined for an unknown ID. */
export function tutorial(id: string): Tutorial | undefined {
  const t = TUTORIALS.find((x) => x.id === id);
  const steps = TUTORIAL_STEPS[id];
  return t && steps ? { ...info(id), steps } : undefined;
}
