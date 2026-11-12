// Editing tools shown in the toolbar and the Tools panel: [id, icon, label].
// Each runs the tool.<id> command; availability depends on the active editor.
// Buttons add the command's current key to the label ("Move Tool (V)").

export const TOOLS = [
  ['move', 'tool-move', 'Move Tool'],
  ['razor', 'tool-razor', 'Razor Tool'],
  ['slip', 'tool-slip', 'Slip Tool'],
  ['time', 'tool-time', 'Time Selection Tool'],
  ['marquee', 'tool-marquee', 'Marquee Selection Tool'],
  ['lasso', 'tool-lasso', 'Lasso Selection Tool'],
  ['brush', 'tool-brush', 'Paintbrush Selection Tool'],
  ['heal', 'tool-heal', 'Spot Healing Brush Tool'],
];
