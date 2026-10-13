// Help → What's New: recent features, newest first. Each entry can point at
// the feature: a command to run (the first one that is registered), a tool
// to choose, a panel to show or a tutorial to start. Entries whose target is
// not available in this build show no "Try it" button.
export type WhatsNewAction =
  | { commands: string[]; needs?: 'document'; hint?: string }
  | { tool: string; needs?: 'document'; hint?: string }
  | { panel: string; needs?: 'document'; hint?: string }
  | { tutorial: string };
export type WhatsNewEntry = { id: string; title: string; text: string; release: string; action?: WhatsNewAction };

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: 'tutorials',
    title: 'Hands-on tutorials',
    text: 'Six short guided tours on generated sample images. Each step points at the control to use and moves on when you have done it.',
    release: 'October 2026',
    action: { tutorial: 'layers' },
  },
  {
    id: 'match-font',
    title: 'Match Font',
    text: 'Draw a box around lettering in a photo and get a ranked list of similar fonts from the bundled and installed ones, previewed with your text.',
    release: 'October 2026',
    action: { commands: ['type.match-font'], needs: 'document', hint: 'Open a photo with lettering, then choose Type → Match Font.' },
  },
  {
    id: 'opentype',
    title: 'More OpenType features',
    text: 'Figure styles (lining, oldstyle, proportional, tabular), small capitals, superscript and subscript, and named stylistic sets where the font has them.',
    release: 'October 2026',
    action: { panel: 'character' },
  },
  {
    id: 'block-text',
    title: 'Block text',
    text: 'A new arc-text shape that stacks lines and scales each one to the same width, for bold headline blocks that stay editable.',
    release: 'October 2026',
    action: { commands: ['type.arc-block'], needs: 'document', hint: 'Select a text layer, then choose Type → Convert to Arc Text → Block.' },
  },
  {
    id: 'actual-size',
    title: 'Actual Size view',
    text: 'Shows one image pixel on one physical screen pixel, which differs from 100% on high-density displays.',
    release: 'October 2026',
    action: { commands: ['view.actual-size'], needs: 'document' },
  },
  {
    id: 'artboard-guides',
    title: 'Artboard guides',
    text: 'Guides dropped on an artboard belong to it and move with it; canvas and artboard guides can be shown and cleared separately.',
    release: 'October 2026',
    action: { commands: ['view.guides-new'], needs: 'document', hint: 'Drag a guide from a ruler onto an artboard, or choose View → Guides → New Guide.' },
  },
  {
    id: 'vertical-forms',
    title: 'Latin in vertical text',
    text: 'In vertical text, turn Latin words sideways or set short runs such as dates and numbers side by side in one cell.',
    release: 'October 2026',
    action: { commands: ['type.vertical-combine'], needs: 'document', hint: 'Select a vertical text layer, then choose Type → Language Options.' },
  },
  {
    id: 'rgb-proofs',
    title: 'Web and legacy display proofs',
    text: 'Preview how the image looks where embedded profiles are ignored, or on an older gamma 1.8 display, without changing its pixels.',
    release: 'October 2026',
    action: { commands: ['view.proof-legacy-rgb'], needs: 'document' },
  },
  {
    id: 'convert-linked',
    title: 'Convert embedded objects to linked files',
    text: 'Write an embedded object’s contents to a file on this device or in Puter and keep the layer linked to it.',
    release: 'October 2026',
    action: { commands: ['layer.embed-convert-linked'], needs: 'document', hint: 'Select an embedded object layer, then choose Layer → Embedded Objects → Convert to Linked.' },
  },
  {
    id: 'refine-mask-edge',
    title: 'Refine Mask Edge',
    text: 'Cleans up a layer mask along its boundary with edge-aware matting, so hair and soft edges follow the image.',
    release: 'October 2026',
    action: { commands: ['layer.mask-refine-edge'], needs: 'document', hint: 'Select a layer with a layer mask, then choose Layer → Layer Mask → Refine Mask Edge.' },
  },
  {
    id: 'scripting',
    title: 'Scripts',
    text: 'Plain JavaScript scripts drive documents, layers and commands from a sandbox; install, edit and assign shortcuts in the Scripts panel.',
    release: 'Earlier releases',
    action: { panel: 'scripts' },
  },
  {
    id: 'versions',
    title: 'Version History',
    text: 'Versions are kept in this browser on each save and at the autosave interval; preview, restore or open any of them as a copy.',
    release: 'Earlier releases',
    action: { commands: ['file.version-history'] },
  },
  {
    id: 'pin-warp',
    title: 'Pin Warp',
    text: 'Bend part of a layer with pins on a mesh while the rest stays put; it stays editable on embedded objects.',
    release: 'Earlier releases',
    action: { commands: ['edit.pin-warp'], needs: 'document' },
  },
  {
    id: 'context-fill',
    title: 'Context Fill',
    text: 'Remove an object by filling the selection with texture found elsewhere in the image, computed on this device.',
    release: 'Earlier releases',
    action: { commands: ['edit.context-fill'], needs: 'document', hint: 'Select the area to fill first, for example with the Lasso tool.' },
  },
  {
    id: 'denoise',
    title: 'Denoise and Sharpen Details',
    text: 'Noise reduction that estimates the noise level by itself, and deblurring for soft or slightly out-of-focus photos.',
    release: 'Earlier releases',
    action: { commands: ['filter.denoise'], needs: 'document' },
  },
  {
    id: 'pattern-preview',
    title: 'Pattern Preview',
    text: 'The image repeats around itself and brush strokes wrap across its edges, for painting seamless tiles.',
    release: 'Earlier releases',
    action: { commands: ['view.pattern-preview'], needs: 'document' },
  },
  {
    id: 'remove-spots',
    title: 'One-click spot healing',
    text: 'Click a blemish or dust spot and it blends into its surroundings.',
    release: 'Earlier releases',
    action: { tutorial: 'retouch' },
  },
];
