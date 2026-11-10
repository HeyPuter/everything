/**
 * Ribbon layout. Each tab has panels; each panel lists items:
 *   { cmd, size: 'lg' | 'sm', label?, icon?, args?, variants?: [...] }
 *   { type: 'combo', combo: 'layer' | 'color' | 'linetype' | 'lineweight' | 'textStyle' | 'dimStyle' }
 *   { type: 'toggle', setting, label, icon }
 * `more` items appear in the panel's overflow menu.
 */
export const RIBBON = [
  {
    id: 'home',
    label: 'Home',
    panels: [
      {
        title: 'Draw',
        items: [
          { cmd: 'LINE', size: 'lg' },
          { cmd: 'PLINE', size: 'lg' },
          {
            cmd: 'CIRCLE',
            size: 'lg',
            variants: [
              { label: 'Center, Radius', icon: 'circle', args: { mode: 'cr' } },
              { label: 'Center, Diameter', icon: 'circle', args: { mode: 'cd' } },
              { label: '2-Point', icon: 'circle-2p', args: { mode: '2p' } },
              { label: '3-Point', icon: 'circle-3p', args: { mode: '3p' } },
              { label: 'Tan, Tan, Radius', icon: 'circle-ttr', args: { mode: 'ttr' } },
            ],
          },
          {
            cmd: 'ARC',
            size: 'lg',
            variants: [
              { label: '3-Point', icon: 'arc', args: {} },
              { label: 'Start, Center, End', icon: 'arc-sce', args: { mode: 'sce' } },
              { label: 'Center, Start, End', icon: 'arc-cse', args: { mode: 'cse' } },
              { label: 'Start, End, Radius', icon: 'arc-ser', args: { mode: 'ser' } },
            ],
          },
          { cmd: 'RECTANG', size: 'sm', variants: [{ label: 'Rectangle', icon: 'rectangle', cmd: 'RECTANG' }, { label: 'Polygon', icon: 'polygon', cmd: 'POLYGON' }] },
          {
            cmd: 'ELLIPSE',
            size: 'sm',
            variants: [
              { label: 'Center', icon: 'ellipse', args: { mode: 'center' } },
              { label: 'Axis, End', icon: 'ellipse', args: {} },
              { label: 'Elliptical arc', icon: 'ellipse-arc', args: { mode: 'arc' } },
            ],
          },
          { cmd: 'HATCH', size: 'sm' },
          { cmd: 'SPLINE', size: 'sm' },
          { cmd: 'XLINE', size: 'sm' },
          { cmd: 'POINT', size: 'sm' },
        ],
        more: ['RAY', 'POLYGON', 'DONUT', 'REVCLOUD'],
      },
      {
        title: 'Modify',
        items: [
          { cmd: 'MOVE', size: 'sm' },
          { cmd: 'COPY', size: 'sm' },
          { cmd: 'STRETCH', size: 'sm' },
          { cmd: 'ROTATE', size: 'sm' },
          { cmd: 'MIRROR', size: 'sm' },
          { cmd: 'SCALE', size: 'sm' },
          { cmd: 'TRIM', size: 'sm', variants: [{ label: 'Trim', icon: 'trim', cmd: 'TRIM' }, { label: 'Extend', icon: 'extend', cmd: 'EXTEND' }] },
          { cmd: 'FILLET', size: 'sm', variants: [{ label: 'Fillet', icon: 'fillet', cmd: 'FILLET' }, { label: 'Chamfer', icon: 'chamfer', cmd: 'CHAMFER' }] },
          { cmd: 'ARRAYRECT', size: 'sm', label: 'Array', variants: [{ label: 'Rectangular array', icon: 'array-rect', cmd: 'ARRAYRECT' }, { label: 'Polar array', icon: 'array-polar', cmd: 'ARRAYPOLAR' }] },
          { cmd: 'ERASE', size: 'sm', iconOnly: true },
          { cmd: 'EXPLODE', size: 'sm', iconOnly: true },
          { cmd: 'OFFSET', size: 'sm', iconOnly: true },
        ],
        more: ['JOIN', 'BREAK', 'BREAKATPOINT', 'LENGTHEN', 'ALIGN', { label: 'Bring to front', cmd: 'DRAWORDER', args: { where: 'front' }, icon: 'draw-order' }, { label: 'Send to back', cmd: 'DRAWORDER', args: { where: 'back' }, icon: 'draw-order' }],
      },
      {
        title: 'Annotation',
        items: [
          { cmd: 'MTEXT', size: 'lg', label: 'Text', variants: [{ label: 'Multiline text', icon: 'mtext', cmd: 'MTEXT' }, { label: 'Single line text', icon: 'text', cmd: 'TEXT' }] },
          {
            cmd: 'DIMLINEAR',
            size: 'lg',
            label: 'Dimension',
            variants: [
              { label: 'Linear', icon: 'dim-linear', cmd: 'DIMLINEAR' },
              { label: 'Aligned', icon: 'dim-aligned', cmd: 'DIMALIGNED' },
              { label: 'Angular', icon: 'dim-angular', cmd: 'DIMANGULAR' },
              { label: 'Radius', icon: 'dim-radius', cmd: 'DIMRADIUS' },
              { label: 'Diameter', icon: 'dim-diameter', cmd: 'DIMDIAMETER' },
              { label: 'Ordinate', icon: 'dim-ordinate', cmd: 'DIMORDINATE' },
            ],
          },
          { cmd: 'LEADER', size: 'sm' },
          { cmd: 'DIMCONTINUE', size: 'sm', label: 'Continue' },
          { cmd: 'DIMBASELINE', size: 'sm', label: 'Baseline' },
        ],
      },
      {
        title: 'Layers',
        wide: true,
        items: [
          { cmd: 'LAYER', size: 'lg', label: 'Layer Properties' },
          { type: 'combo', combo: 'layer' },
          { type: 'row', items: [{ cmd: 'LAYOFF', iconOnly: true }, { cmd: 'LAYISO', iconOnly: true }, { cmd: 'LAYFRZ', iconOnly: true }, { cmd: 'LAYLCK', iconOnly: true }, { cmd: 'LAYMCUR', label: 'Make Current' }] },
          { type: 'row', items: [{ cmd: 'LAYON', iconOnly: true }, { cmd: 'LAYUNISO', iconOnly: true }, { cmd: 'LAYTHW', iconOnly: true }, { cmd: 'LAYULK', iconOnly: true }, { cmd: 'LAYMATCH', label: 'Match Layer' }] },
        ],
      },
      {
        title: 'Block',
        items: [
          { cmd: 'INSERT', size: 'lg', label: 'Insert' },
          { cmd: 'BLOCK', size: 'sm', label: 'Create' },
          { cmd: 'BLOCKS', size: 'sm', label: 'Library' },
        ],
      },
      {
        title: 'Properties',
        wide: true,
        items: [
          { cmd: 'MATCHPROP', size: 'lg', label: 'Match Properties' },
          { type: 'combo', combo: 'color' },
          { type: 'combo', combo: 'linetype' },
          { type: 'combo', combo: 'lineweight' },
        ],
      },
      {
        title: 'Utilities',
        items: [
          {
            cmd: 'DIST',
            size: 'lg',
            label: 'Measure',
            variants: [
              { label: 'Distance', icon: 'measure-dist', cmd: 'DIST' },
              { label: 'Area', icon: 'measure-area', cmd: 'AREA' },
              { label: 'Point coordinates', icon: 'id-point', cmd: 'ID' },
              { label: 'List', icon: 'list', cmd: 'LIST' },
            ],
          },
          { cmd: 'QSELECT', size: 'sm', iconOnly: true },
          { cmd: 'SELECTALL', size: 'sm', iconOnly: true },
          { cmd: 'SELECTSIMILAR', size: 'sm', iconOnly: true },
        ],
      },
      {
        title: 'Clipboard',
        items: [
          { cmd: 'PASTECLIP', size: 'lg', label: 'Paste' },
          { cmd: 'CUTCLIP', size: 'sm', iconOnly: true },
          { cmd: 'COPYCLIP', size: 'sm', iconOnly: true },
          { cmd: 'COPYBASE', size: 'sm', iconOnly: true },
        ],
      },
    ],
  },
  {
    id: 'insert',
    label: 'Insert',
    panels: [
      {
        title: 'Block',
        items: [
          { cmd: 'INSERT', size: 'lg', label: 'Insert' },
          { cmd: 'BLOCK', size: 'lg', label: 'Create Block' },
          { cmd: 'BLOCKS', size: 'lg', label: 'Block Library' },
          { cmd: 'EXPLODE', size: 'lg' },
        ],
      },
      {
        title: 'Import',
        items: [
          { cmd: 'IMPORT', size: 'lg', label: 'Import' },
          { cmd: 'PASTECLIP', size: 'lg', label: 'Paste' },
        ],
      },
    ],
  },
  {
    id: 'annotate',
    label: 'Annotate',
    panels: [
      {
        title: 'Text',
        wide: true,
        items: [
          { cmd: 'MTEXT', size: 'lg', label: 'Multiline Text' },
          { cmd: 'TEXT', size: 'lg', label: 'Single Line' },
          { type: 'combo', combo: 'textStyle' },
          { type: 'combo', combo: 'textHeight' },
        ],
      },
      {
        title: 'Dimensions',
        wide: true,
        items: [
          { cmd: 'DIM', size: 'lg', label: 'Dimension' },
          { cmd: 'DIMLINEAR', size: 'sm', label: 'Linear' },
          { cmd: 'DIMALIGNED', size: 'sm', label: 'Aligned' },
          { cmd: 'DIMANGULAR', size: 'sm', label: 'Angular' },
          { cmd: 'DIMRADIUS', size: 'sm', label: 'Radius' },
          { cmd: 'DIMDIAMETER', size: 'sm', label: 'Diameter' },
          { cmd: 'DIMORDINATE', size: 'sm', label: 'Ordinate' },
          { cmd: 'DIMCONTINUE', size: 'sm', label: 'Continue' },
          { cmd: 'DIMBASELINE', size: 'sm', label: 'Baseline' },
          { type: 'combo', combo: 'dimStyle' },
        ],
      },
      {
        title: 'Leaders',
        items: [{ cmd: 'LEADER', size: 'lg', label: 'Leader' }],
      },
      {
        title: 'Styles',
        items: [
          { cmd: 'STYLE', size: 'lg', label: 'Text Styles' },
          { cmd: 'DIMSTYLE', size: 'lg', label: 'Dimension Styles' },
        ],
      },
    ],
  },
  {
    id: 'view',
    label: 'View',
    panels: [
      {
        title: 'Navigate',
        items: [
          { cmd: 'ZOOMEXTENTS', size: 'lg', label: 'Extents' },
          { cmd: 'ZOOM', size: 'lg', label: 'Window', args: { mode: 'window' } },
          { cmd: 'PAN', size: 'lg' },
          { cmd: 'ZOOM', size: 'sm', label: 'Zoom In', icon: 'zoom-in', args: { mode: 'in' } },
          { cmd: 'ZOOM', size: 'sm', label: 'Zoom Out', icon: 'zoom-out', args: { mode: 'out' } },
          { cmd: 'ZOOM', size: 'sm', label: 'Previous', icon: 'zoom-prev', args: { mode: 'previous' } },
        ],
      },
      {
        title: 'Palettes',
        items: [
          { cmd: 'PROPERTIES', size: 'lg' },
          { cmd: 'LAYER', size: 'lg', label: 'Layers' },
          { cmd: 'BLOCKS', size: 'lg', label: 'Blocks' },
        ],
      },
      {
        title: 'Display',
        items: [
          { type: 'toggle', setting: 'grid', label: 'Grid', icon: 'grid' },
          { type: 'toggle', setting: 'lwDisplay', label: 'Lineweight', icon: 'lineweight' },
          { type: 'toggle', setting: 'showUcs', label: 'Coordinate Icon', icon: 'ucs-icon' },
          { type: 'toggle', setting: 'showCmdLine', label: 'Command Line', icon: 'cmd-line' },
          { cmd: 'REGEN', size: 'sm', label: 'Regenerate' },
          { cmd: 'CLEANSCREEN', size: 'sm', label: 'Clean Screen' },
        ],
      },
      {
        title: 'Interface',
        items: [{ type: 'theme' }],
      },
    ],
  },
  {
    id: 'manage',
    label: 'Manage',
    panels: [
      {
        title: 'Drawing Setup',
        items: [
          { cmd: 'UNITS', size: 'lg', label: 'Units' },
          { cmd: 'LINETYPE', size: 'lg', label: 'Linetypes' },
          { cmd: 'STYLE', size: 'lg', label: 'Text Styles' },
          { cmd: 'DIMSTYLE', size: 'lg', label: 'Dim Styles' },
        ],
      },
      {
        title: 'Settings',
        items: [
          { cmd: 'DSETTINGS', size: 'lg', label: 'Drafting' },
          { cmd: 'OPTIONS', size: 'lg', label: 'Settings' },
          { cmd: 'SHORTCUTS', size: 'lg', label: 'Shortcuts' },
        ],
      },
      {
        title: 'Cleanup',
        items: [{ cmd: 'PURGE', size: 'lg', label: 'Purge' }],
      },
    ],
  },
  {
    id: 'output',
    label: 'Output',
    panels: [
      {
        title: 'Plot',
        items: [{ cmd: 'PLOT', size: 'lg', label: 'Plot' }],
      },
      {
        title: 'Export',
        items: [
          { cmd: 'EXPORT', size: 'lg', label: 'Export' },
          { cmd: 'DWGOUT', size: 'lg', label: 'DWG' },
          { cmd: 'DXFOUT', size: 'lg', label: 'DXF' },
        ],
      },
    ],
  },
];

/** Contextual tab shown while the hatch command runs. */
export const HATCH_TAB = { id: 'hatch', label: 'Hatch Creation', contextual: true };
