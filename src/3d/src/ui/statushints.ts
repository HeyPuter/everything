// Mouse button hints of the status bar: what the left, middle and right buttons do in the editor
// under the pointer, following the modifier keys being held (pure; the shell tracks the keys).

export interface HintContext {
  editor?: string;
  mode: string;
  objectType?: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export type Hint = [string, string];

function view3d(c: HintContext): Hint[] {
  const { shift, ctrl, alt, mode } = c;
  const paint = mode === 'SCULPT' || mode.endsWith('PAINT');
  const editMesh = mode === 'EDIT' && c.objectType === 'MESH';
  let lmb: string;
  if (paint) lmb = mode === 'SCULPT' ? (shift ? 'Smooth' : ctrl ? 'Sculpt (Inverted)' : 'Sculpt') : ctrl ? 'Paint (Inverted)' : 'Paint';
  else if (editMesh && alt) lmb = ctrl ? 'Select Ring' : shift ? 'Extend Loop' : 'Select Loop';
  else if (editMesh && ctrl && !shift) lmb = 'Pick Shortest Path';
  else if (alt) lmb = 'Select (Cycle)';
  else lmb = shift ? 'Toggle Selection' : ctrl ? 'Deselect' : 'Select';
  const mmb = alt ? 'Center View / Snap to Axis' : shift && ctrl ? 'Dolly View' : shift ? 'Pan View' : ctrl ? 'Zoom View' : 'Rotate View';
  let rmb: string;
  if (ctrl) rmb = shift ? 'Lasso Deselect' : editMesh ? 'Extrude to Cursor / Lasso' : mode === 'EDIT' && c.objectType === 'ARMATURE' ? 'Extrude to Cursor / Lasso' : 'Lasso Select';
  else if (shift) rmb = 'Set 3D Cursor';
  else rmb = mode === 'OBJECT' ? 'Object' : 'Context Menu';
  return [['LMB', lmb], ['MMB', mmb], ['RMB', rmb]];
}

function nodes(c: HintContext): Hint[] {
  const { shift, ctrl, alt } = c;
  let lmb = 'Select';
  if (ctrl && alt) lmb = shift ? 'Lasso Deselect' : 'Lasso Select';
  else if (shift && ctrl) lmb = 'Link to Viewer';
  else if (shift && alt) lmb = 'Connect to Output';
  else if (shift) lmb = 'Extend Selection';
  else if (ctrl) lmb = 'Deselect';
  else if (alt) lmb = 'Pan View';
  const rmb = ctrl && alt ? 'Mute Links' : ctrl ? 'Cut Links' : shift ? 'Add Reroute' : 'Context Menu';
  return [['LMB', lmb], ['MMB', ctrl ? 'Zoom View' : 'Pan View'], ['RMB', rmb]];
}

/** Hints for the hovered editor; undefined when the editor has none of its own. */
export function mouseHints(c: HintContext): Hint[] | undefined {
  const pan: Hint = ['MMB', 'Pan View'];
  switch (c.editor) {
    case undefined:
    case 'VIEW_3D':
      return view3d(c);
    case 'SHADER':
    case 'GEOMETRY':
    case 'COMPOSITOR':
    case 'TEXTURE_NODES':
      return nodes(c);
    case 'DOPESHEET':
    case 'TIMELINE':
    case 'GRAPH':
    case 'DRIVERS':
    case 'NLA':
    case 'SEQUENCE_EDITOR':
    case 'CLIP_EDITOR':
    case 'IMAGE_EDITOR':
    case 'UV':
    case 'OUTLINER':
    case 'FILE_BROWSER':
    case 'SPREADSHEET':
      return [['LMB', c.shift ? 'Extend Selection' : 'Select'], pan, ['RMB', 'Context Menu']];
    case 'TEXT':
    case 'CONSOLE':
      return [['LMB', c.shift ? 'Extend Selection' : 'Set Cursor'], pan, ['RMB', 'Context Menu']];
    default:
      return [pan, ['RMB', 'Context Menu']];
  }
}
