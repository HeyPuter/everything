/**
 * Ribbon layout: tabs of panels with large buttons, stacks of small buttons
 * and split buttons with variants.
 *   { cmd, size: 'lg' } | { cmd } (small) | { cmd, variants: [{ cmd, label }] }
 */
export const RIBBON = [
  {
    id: 'arch',
    label: 'Architecture',
    panels: [
      { title: 'Select', items: [{ cmd: 'modify', size: 'lg' }] },
      {
        title: 'Build',
        items: [
          {
            cmd: 'wall',
            size: 'lg',
            variants: [
              { cmd: 'wall', label: 'Wall' },
              { cmd: 'wallStructural', label: 'Structural Wall' },
              { cmd: 'curtainWall', label: 'Curtain Wall' },
            ],
          },
          { cmd: 'door', size: 'lg' },
          { cmd: 'window', size: 'lg' },
          { cmd: 'component', size: 'lg' },
          {
            cmd: 'column',
            size: 'lg',
            variants: [
              { cmd: 'columnStructural', label: 'Structural Column' },
              { cmd: 'column', label: 'Column' },
            ],
          },
          { cmd: 'roof', size: 'lg' },
          { cmd: 'ceiling', size: 'lg' },
          { cmd: 'floor', size: 'lg' },
          { cmd: 'curtainWall', size: 'lg' },
          { cmd: 'curtainGrid', size: 'lg' },
        ],
      },
      { title: 'Circulation', items: [{ cmd: 'railing', size: 'lg' }, { cmd: 'ramp', size: 'lg' }, { cmd: 'stair', size: 'lg' }] },
      {
        title: 'Model',
        items: [
          { cmd: 'modelLine', size: 'lg' },
          {
            cmd: 'groupCreate',
            size: 'lg',
            variants: [
              { cmd: 'groupCreate', label: 'Create Group' },
              { cmd: 'groupPlace', label: 'Place Group' },
            ],
          },
        ],
      },
      {
        title: 'Room & Area',
        items: [
          {
            cmd: 'room',
            size: 'lg',
            variants: [
              { cmd: 'room', label: 'Room' },
              { cmd: 'rooms-auto', label: 'Place Rooms Automatically' },
            ],
          },
          { cmd: 'roomSeparator', size: 'lg' },
          { cmd: 'tagRoom', size: 'lg' },
          {
            cmd: 'area',
            size: 'lg',
            variants: [
              { cmd: 'area', label: 'Area' },
              { cmd: 'areaPlan', label: 'Area Plan' },
            ],
          },
          { cmd: 'areaBoundary', size: 'lg' },
          { cmd: 'roomFill' },
        ],
      },
      { title: 'Opening', items: [{ cmd: 'openingFace', size: 'lg' }, { cmd: 'shaft', size: 'lg' }, { cmd: 'opening', size: 'lg' }] },
      { title: 'Datum', items: [{ cmd: 'level', size: 'lg' }, { cmd: 'grid', size: 'lg' }] },
      { title: 'Work Plane', items: [{ cmd: 'refPlane', size: 'lg' }, { cmd: 'workPlaneGrid', size: 'lg' }] },
    ],
  },
  {
    id: 'struct',
    label: 'Structure',
    panels: [
      { title: 'Structure', items: [{ cmd: 'beam', size: 'lg' }, { cmd: 'wallStructural', size: 'lg' }, { cmd: 'columnStructural', size: 'lg' }, { cmd: 'floor', size: 'lg' }] },
      { title: 'Model', items: [{ cmd: 'modelLine', size: 'lg' }] },
      { title: 'Opening', items: [{ cmd: 'openingFace', size: 'lg' }, { cmd: 'shaft', size: 'lg' }, { cmd: 'opening', size: 'lg' }] },
      { title: 'Datum', items: [{ cmd: 'level', size: 'lg' }, { cmd: 'grid', size: 'lg' }] },
      { title: 'Work Plane', items: [{ cmd: 'refPlane', size: 'lg' }, { cmd: 'workPlaneGrid', size: 'lg' }] },
    ],
  },
  {
    id: 'insert',
    label: 'Insert',
    panels: [
      { title: 'Import', items: [{ cmd: 'importDxf', size: 'lg' }] },
      { title: 'Project', items: [{ cmd: 'open', size: 'lg' }, { cmd: 'sample', size: 'lg' }] },
      { title: 'Library', items: [{ cmd: 'component', size: 'lg' }, { cmd: 'types', size: 'lg' }] },
    ],
  },
  {
    id: 'annotate',
    label: 'Annotate',
    panels: [
      { title: 'Dimension', items: [{ cmd: 'dimension', size: 'lg' }, { cmd: 'measure', size: 'lg' }] },
      { title: 'Detail', items: [{ cmd: 'detailLine', size: 'lg' }, { cmd: 'region', size: 'lg' }] },
      { title: 'Text', items: [{ cmd: 'text', size: 'lg' }] },
      { title: 'Tag', items: [{ cmd: 'tag', size: 'lg' }, { cmd: 'tagAll', size: 'lg' }] },
    ],
  },
  {
    id: 'view',
    label: 'View',
    panels: [
      { title: 'Graphics', items: [{ cmd: 'visibility', size: 'lg' }, { cmd: 'thinLines' }, { cmd: 'revealHidden' }, { cmd: 'tempReset' }] },
      {
        title: 'Create',
        items: [
          { cmd: 'view3d', size: 'lg', variants: [{ cmd: 'view3d', label: 'Default 3D View' }, { cmd: 'newView3d', label: 'New 3D View' }] },
          { cmd: 'section', size: 'lg' },
          { cmd: 'elevation', size: 'lg' },
          { cmd: 'planViews', size: 'lg' },
          { cmd: 'duplicateView', size: 'lg' },
          { cmd: 'schedule', size: 'lg' },
        ],
      },
      { title: 'Sheet Composition', items: [{ cmd: 'sheet', size: 'lg' }, { cmd: 'placeView', size: 'lg' }] },
      { title: 'Windows', items: [{ cmd: 'closeInactive' }, { cmd: 'toggleProps' }, { cmd: 'toggleBrowser' }] },
      { title: 'Navigate', items: [{ cmd: 'zoomFit' }, { cmd: 'zoomRegion' }, { cmd: 'sectionBox' }] },
    ],
  },
  {
    id: 'manage',
    label: 'Manage',
    panels: [
      { title: 'Settings', items: [{ cmd: 'projectInfo', size: 'lg' }, { cmd: 'units', size: 'lg' }, { cmd: 'materials', size: 'lg' }, { cmd: 'snaps', size: 'lg' }] },
      { title: 'Project', items: [{ cmd: 'levels', size: 'lg' }, { cmd: 'types', size: 'lg' }, { cmd: 'purge', size: 'lg' }] },
      { title: 'Help', items: [{ cmd: 'shortcuts', size: 'lg' }, { cmd: 'help', size: 'lg' }] },
    ],
  },
  {
    id: 'collab',
    label: 'Collaborate',
    panels: [{ title: 'Share', items: [{ cmd: 'share', size: 'lg' }, { cmd: 'sharedWithMe', size: 'lg' }] }],
  },
  {
    id: 'modify',
    label: 'Modify',
    panels: [
      { title: 'Select', items: [{ cmd: 'modify', size: 'lg' }] },
      { title: 'Clipboard', items: [{ cmd: 'paste', size: 'lg' }, { cmd: 'copyClip' }, { cmd: 'cutClip' }] },
      MODIFY_PANEL(),
      { title: 'View', items: [{ cmd: 'hideEl' }, { cmd: 'tempIsolate' }, { cmd: 'tempHide' }] },
      { title: 'Measure', items: [{ cmd: 'measure', size: 'lg' }, { cmd: 'dimension', size: 'lg' }] },
      { title: 'Create', items: [{ cmd: 'matchType', size: 'lg' }] },
    ],
  },
];

export function MODIFY_PANEL() {
  return {
    title: 'Modify',
    items: [
      { cmd: 'align', small: true },
      { cmd: 'offset', small: true },
      { cmd: 'mirrorPick', small: true },
      { cmd: 'move', small: true },
      { cmd: 'copy', small: true },
      { cmd: 'rotate', small: true },
      { cmd: 'trim', small: true },
      { cmd: 'extend', small: true },
      { cmd: 'split', small: true },
      { cmd: 'array', small: true },
      { cmd: 'mirrorDraw', small: true },
      { cmd: 'pin', small: true },
      { cmd: 'unpin', small: true },
      { cmd: 'delete', small: true },
    ],
  };
}

/** Shown while a model group is being edited. */
export const GROUP_EDIT_PANEL = {
  title: 'Edit Group',
  items: [{ cmd: 'groupAdd', size: 'lg' }, { cmd: 'groupRemove', size: 'lg' }, { cmd: 'groupFinish', size: 'lg' }, { cmd: 'groupCancel', size: 'lg' }],
};

/** Panels of the contextual tab for a selection of one category. */
export function contextualPanels(kinds) {
  const panels = [{ title: 'Properties', items: [{ cmd: 'editType', size: 'lg' }] }, MODIFY_PANEL()];
  const k = kinds.length === 1 ? kinds[0] : null;
  if (k === 'group') panels.push({ title: 'Group', items: [{ cmd: 'groupEdit', size: 'lg' }, { cmd: 'ungroup', size: 'lg' }, { cmd: 'groupPlace', size: 'lg' }] });
  else panels.push({ title: 'Create', items: [{ cmd: 'groupCreate', size: 'lg' }] });
  if (k === 'wall') panels.push({ title: 'Wall', items: [{ cmd: 'flip', size: 'lg' }, { cmd: 'attachTop', size: 'lg' }, { cmd: 'detachTop', size: 'lg' }] });
  if (k === 'door' || k === 'window') panels.push({ title: 'Opening', items: [{ cmd: 'flip', size: 'lg' }] });
  if (k === 'floor' || k === 'roof' || k === 'ceiling' || k === 'railing') panels.push({ title: 'Mode', items: [{ cmd: 'editBoundary', size: 'lg' }] });
  panels.push({ title: 'View', items: [{ cmd: 'hideEl' }, { cmd: 'hideCat' }, { cmd: 'tempIsolate' }, { cmd: 'tempHide' }, { cmd: 'selectSimilar' }] });
  return panels;
}
