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
      {
        title: 'Structure',
        items: [
          { cmd: 'beam', size: 'lg' },
          { cmd: 'wallStructural', size: 'lg', label: 'Wall' },
          { cmd: 'columnStructural', size: 'lg', label: 'Column' },
          { cmd: 'floor', size: 'lg' },
          { cmd: 'brace', size: 'lg' },
          { cmd: 'beamSystem', size: 'lg' },
        ],
      },
      { title: 'Foundation', items: [{ cmd: 'footing', size: 'lg' }, { cmd: 'wallFooting', size: 'lg', label: 'Wall' }, { cmd: 'slabFoundation', size: 'lg', label: 'Slab' }] },
      { title: 'Model', items: [{ cmd: 'modelLine', size: 'lg' }] },
      { title: 'Opening', items: [{ cmd: 'openingFace', size: 'lg' }, { cmd: 'shaft', size: 'lg' }, { cmd: 'opening', size: 'lg' }] },
      { title: 'Datum', items: [{ cmd: 'level', size: 'lg' }, { cmd: 'grid', size: 'lg' }] },
      { title: 'Work Plane', items: [{ cmd: 'refPlane', size: 'lg' }, { cmd: 'workPlaneGrid', size: 'lg' }] },
    ],
  },
  {
    id: 'systems',
    label: 'Systems',
    panels: [
      { title: 'HVAC', items: [{ cmd: 'duct', size: 'lg' }, { cmd: 'airTerminal', size: 'lg' }, { cmd: 'mechEquipment', size: 'lg' }] },
      { title: 'Plumbing & Piping', items: [{ cmd: 'pipe', size: 'lg' }, { cmd: 'plumbingFixture', size: 'lg' }] },
      {
        title: 'Electrical',
        items: [{ cmd: 'cableTray', size: 'lg' }, { cmd: 'conduit', size: 'lg' }, { cmd: 'electricalEquipment', size: 'lg' }, { cmd: 'electricalFixture', size: 'lg' }, { cmd: 'lightingFixture', size: 'lg' }],
      },
      { title: 'Work Plane', items: [{ cmd: 'refPlane', size: 'lg' }, { cmd: 'workPlaneGrid', size: 'lg' }] },
    ],
  },
  {
    id: 'insert',
    label: 'Insert',
    panels: [
      { title: 'Link', items: [{ cmd: 'linkProject', size: 'lg' }, { cmd: 'manageLinks', size: 'lg' }] },
      { title: 'Import', items: [{ cmd: 'importDxf', size: 'lg' }, { cmd: 'importImage', size: 'lg' }] },
      { title: 'Load from Library', items: [{ cmd: 'transferStandards', size: 'lg', label: 'Load from Project' }, { cmd: 'component', size: 'lg' }, { cmd: 'types', size: 'lg' }] },
      { title: 'Project', items: [{ cmd: 'open', size: 'lg' }, { cmd: 'sample', size: 'lg' }] },
    ],
  },
  {
    id: 'annotate',
    label: 'Annotate',
    panels: [
      {
        title: 'Dimension',
        items: [
          { cmd: 'dimension', size: 'lg', label: 'Aligned' },
          { cmd: 'dimLinear', size: 'lg', label: 'Linear' },
          { cmd: 'dimAngular', size: 'lg', label: 'Angular' },
          { cmd: 'dimRadial', size: 'lg', label: 'Radial' },
          { cmd: 'dimDiameter', size: 'lg', label: 'Diameter' },
          { cmd: 'dimArcLength', size: 'lg', label: 'Arc Length' },
          { cmd: 'spotElevation', size: 'lg' },
          { cmd: 'spotCoordinate', size: 'lg' },
          { cmd: 'spotSlope', size: 'lg' },
        ],
      },
      {
        title: 'Detail',
        items: [
          { cmd: 'detailLine', size: 'lg' },
          { cmd: 'detailArc', size: 'lg' },
          { cmd: 'region', size: 'lg', label: 'Region' },
          { cmd: 'detailItem', size: 'lg', label: 'Component' },
          { cmd: 'revisionCloud', size: 'lg' },
          { cmd: 'insulation', size: 'lg' },
          { cmd: 'groupCreate', size: 'lg', label: 'Detail Group' },
        ],
      },
      { title: 'Text', items: [{ cmd: 'text', size: 'lg' }, { cmd: 'findReplace', size: 'lg', label: 'Find and Replace' }] },
      {
        title: 'Tag',
        items: [
          { cmd: 'tag', size: 'lg' },
          { cmd: 'tagAll', size: 'lg', label: 'Tag All' },
          { cmd: 'tagMulti', size: 'lg', label: 'Multi-Category' },
          { cmd: 'tagMaterial', size: 'lg' },
          { cmd: 'keynote', size: 'lg' },
          { cmd: 'tagRoom', size: 'lg' },
          { cmd: 'treadNumber', size: 'lg' },
        ],
      },
      { title: 'Color Fill', items: [{ cmd: 'colorLegend', size: 'lg' }] },
      {
        title: 'Symbol',
        items: [
          {
            cmd: 'northArrow',
            size: 'lg',
            variants: [
              { cmd: 'northArrow', label: 'North Arrow' },
              { cmd: 'scaleBar', label: 'Graphic Scale' },
            ],
          },
          { cmd: 'spanDirection', size: 'lg' },
        ],
      },
    ],
  },
  {
    id: 'analyze',
    label: 'Analyze',
    panels: [
      { title: 'Spaces & Zones', items: [{ cmd: 'space', size: 'lg' }, { cmd: 'spaceSeparator', size: 'lg' }, { cmd: 'spacesAuto' }, { cmd: 'zones', size: 'lg' }] },
      { title: 'Reports', items: [{ cmd: 'loads', size: 'lg' }, { cmd: 'checkSystems', size: 'lg' }] },
      { title: 'Color Fill', items: [{ cmd: 'ductLegend', size: 'lg' }, { cmd: 'pipeLegend', size: 'lg' }, { cmd: 'zoneLegend', size: 'lg' }] },
      { title: 'Sun', items: [{ cmd: 'sunSettings', size: 'lg', label: 'Location' }, { cmd: 'shadows', size: 'lg' }] },
    ],
  },
  {
    id: 'massing',
    label: 'Massing & Site',
    panels: [
      { title: 'Conceptual Mass', items: [{ cmd: 'mass', size: 'lg' }] },
      { title: 'Model by Face', items: [{ cmd: 'curtainByFace', size: 'lg', label: 'Curtain System' }, { cmd: 'roofByFace', size: 'lg', label: 'Roof' }, { cmd: 'wallByFace', size: 'lg', label: 'Wall' }, { cmd: 'floorByFace', size: 'lg', label: 'Floor' }] },
      { title: 'Model Site', items: [{ cmd: 'topo', size: 'lg' }, { cmd: 'siteComponent', size: 'lg' }, { cmd: 'parkingComponent', size: 'lg' }, { cmd: 'propertyLine', size: 'lg' }] },
    ],
  },
  {
    id: 'view',
    label: 'View',
    panels: [
      {
        title: 'Graphics',
        items: [
          {
            cmd: 'viewTemplates',
            size: 'lg',
            variants: [
              { cmd: 'viewTemplates', label: 'Manage View Templates' },
              { cmd: 'templateFromView', label: 'Create Template from Current View' },
            ],
          },
          { cmd: 'visibility', size: 'lg' },
          { cmd: 'filters', size: 'lg' },
          { cmd: 'thinLines' },
          { cmd: 'revealHidden' },
          { cmd: 'tempReset' },
        ],
      },
      { title: 'Presentation', items: [{ cmd: 'shadows', size: 'lg' }, { cmd: 'sunSettings', size: 'lg' }] },
      {
        title: 'Create',
        items: [
          { cmd: 'view3d', size: 'lg', variants: [{ cmd: 'view3d', label: 'Default 3D View' }, { cmd: 'newView3d', label: 'New 3D View' }] },
          { cmd: 'section', size: 'lg' },
          { cmd: 'callout', size: 'lg' },
          {
            cmd: 'planViews',
            size: 'lg',
            variants: [
              { cmd: 'planViews', label: 'Floor Plan' },
              { cmd: 'areaPlan', label: 'Area Plan' },
            ],
          },
          { cmd: 'elevation', size: 'lg' },
          { cmd: 'draftingView', size: 'lg' },
          {
            cmd: 'duplicateView',
            size: 'lg',
            variants: [
              { cmd: 'duplicateView', label: 'Duplicate' },
              { cmd: 'duplicateDetailing', label: 'Duplicate with Detailing' },
            ],
          },
          {
            cmd: 'legend',
            size: 'lg',
            variants: [
              { cmd: 'legend', label: 'Legend' },
              { cmd: 'legendComponent', label: 'Legend Component' },
            ],
          },
          { cmd: 'schedule', size: 'lg' },
        ],
      },
      { title: 'Crop', items: [{ cmd: 'cropView' }, { cmd: 'cropShow' }] },
      { title: 'Sheet Composition', items: [{ cmd: 'sheet', size: 'lg' }, { cmd: 'placeView', size: 'lg' }, { cmd: 'revisions', size: 'lg' }] },
      { title: 'Windows', items: [{ cmd: 'tileViews', size: 'lg' }, { cmd: 'tabViews', size: 'lg' }, { cmd: 'closeInactive' }, { cmd: 'toggleProps' }, { cmd: 'toggleBrowser' }] },
      { title: 'User Interface', items: [{ cmd: 'shortcuts', size: 'lg' }, { cmd: 'options', size: 'lg' }] },
      { title: 'Navigate', items: [{ cmd: 'zoomFit' }, { cmd: 'zoomRegion' }, { cmd: 'sectionBox' }] },
    ],
  },
  {
    id: 'manage',
    label: 'Manage',
    panels: [
      {
        title: 'Settings',
        items: [
          { cmd: 'materials', size: 'lg' },
          { cmd: 'objectStyles', size: 'lg' },
          { cmd: 'snaps', size: 'lg' },
          { cmd: 'projectInfo', size: 'lg' },
          { cmd: 'projectParams', size: 'lg' },
          { cmd: 'transferStandards', size: 'lg' },
          { cmd: 'purge', size: 'lg' },
          { cmd: 'units', size: 'lg' },
          { cmd: 'renumber', size: 'lg', label: 'Numbering' },
        ],
      },
      { title: 'Project', items: [{ cmd: 'levels', size: 'lg' }, { cmd: 'types', size: 'lg' }, { cmd: 'startingView', size: 'lg' }] },
      { title: 'Phasing', items: [{ cmd: 'phases', size: 'lg' }] },
      { title: 'Design Options', items: [{ cmd: 'designOptions', size: 'lg' }, { cmd: 'addToOption' }, { cmd: 'viewOptions' }, { cmd: 'finishOption' }] },
      { title: 'Selection', items: [{ cmd: 'selectionSave', size: 'lg', label: 'Save' }, { cmd: 'selectionLoad', size: 'lg', label: 'Load' }] },
      { title: 'Inquiry', items: [{ cmd: 'selectionIds', size: 'lg' }, { cmd: 'selectById', size: 'lg' }, { cmd: 'warnings', size: 'lg' }] },
      { title: 'Help', items: [{ cmd: 'shortcuts', size: 'lg' }, { cmd: 'help', size: 'lg' }] },
    ],
  },
  {
    id: 'collab',
    label: 'Collaborate',
    panels: [
      { title: 'Share', items: [{ cmd: 'share', size: 'lg' }, { cmd: 'sharedWithMe', size: 'lg' }] },
      { title: 'Synchronize', items: [{ cmd: 'syncNow', size: 'lg', variants: [{ cmd: 'syncNow', label: 'Synchronize Now' }, { cmd: 'syncComment', label: 'Synchronize with Comment...' }] }, { cmd: 'reloadLatest', size: 'lg' }, { cmd: 'autoSync', size: 'lg' }, { cmd: 'syncHistory', size: 'lg' }] },
      { title: 'Worksets', items: [{ cmd: 'worksets', size: 'lg' }, { cmd: 'viewWorksets', size: 'lg' }, { cmd: 'worksharingDisplay', size: 'lg' }] },
    ],
  },
  {
    id: 'modify',
    label: 'Modify',
    panels: [
      { title: 'Select', items: [{ cmd: 'modify', size: 'lg' }] },
      {
        title: 'Clipboard',
        items: [
          {
            cmd: 'paste',
            size: 'lg',
            variants: [
              { cmd: 'paste', label: 'Paste' },
              { cmd: 'pasteLevels', label: 'Aligned to Selected Levels' },
            ],
          },
          { cmd: 'copyClip' },
          { cmd: 'cutClip' },
        ],
      },
      MODIFY_PANEL(),
      { title: 'View', items: [{ cmd: 'hideEl' }, { cmd: 'tempIsolate' }, { cmd: 'tempHide' }] },
      { title: 'Measure', items: [{ cmd: 'measure', size: 'lg' }, { cmd: 'dimension', size: 'lg' }] },
      { title: 'Create', items: [{ cmd: 'matchType', size: 'lg' }] },
    ],
  },
];

// Every static tab starts with the Modify (select) button, so selecting is one click from anywhere.
for (const tab of RIBBON) if (tab.panels[0]?.title !== 'Select') tab.panels.unshift({ title: 'Select', items: [{ cmd: 'modify', size: 'lg' }] });

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
      { cmd: 'scaleEl', small: true },
      { cmd: 'mirrorDraw', small: true },
      { cmd: 'pin', small: true },
      { cmd: 'unpin', small: true },
      { cmd: 'demolish', small: true },
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
  else panels.push({ title: 'Create', items: [{ cmd: 'createSimilar', size: 'lg' }, { cmd: 'groupCreate', size: 'lg' }] });
  if (kinds.length > 1) panels.unshift({ title: 'Selection', items: [{ cmd: 'selectionFilter', size: 'lg' }] });
  if (k === 'wall') panels.push({ title: 'Wall', items: [{ cmd: 'flip', size: 'lg' }, { cmd: 'attachTop', size: 'lg' }, { cmd: 'detachTop', size: 'lg' }] });
  if (k === 'door' || k === 'window') panels.push({ title: 'Opening', items: [{ cmd: 'flip', size: 'lg' }] });
  if (k === 'floor' || k === 'roof' || k === 'ceiling' || k === 'railing') panels.push({ title: 'Mode', items: [{ cmd: 'editBoundary', size: 'lg' }] });
  panels.push({ title: 'View', items: [{ cmd: 'hideEl' }, { cmd: 'hideCat' }, { cmd: 'overrideEl' }, { cmd: 'tempIsolate' }, { cmd: 'tempHide' }, { cmd: 'selectSimilar' }] });
  return panels;
}
