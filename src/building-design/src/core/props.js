/**
 * Parameters shown in the properties palette and type editor. Each
 * descriptor: { key, label, group, type, get(el, ctx), set(el, value, ctx)
 * -> patch, options(ctx), ro(el, ctx) }.
 *
 * Types: length, number, angle, text, textarea, bool, select, level,
 * levelOpt (a level or none), material, readonly, button.
 */
import { verticalExtent, openingSize, stairLayout, rampLayout } from './model.js';
import { typeThickness, KIND_LABEL } from './catalog.js';
import { roofGeometry } from './build3d.js';
import { area as polyArea, perimeter, dist } from './geom.js';
import { scaleOptions } from './units.js';
import { STAIR_SHAPES } from './stairs.js';
import { DETAIL_FAMILIES, radialTarget } from './annotate.js';
import { applyTemplatePatch, templateKindOf } from './graphics.js';
import { phasesInOrder, phased, PHASE_FILTERS } from './phases.js';
import { mepSize, systemOf, SYSTEMS } from './mep.js';
import { braceHeights } from './build3d.js';
import { topoBoundary } from './topo.js';
import { massFloorArea } from './massing.js';

export const GROUPS = ['Constraints', 'Construction', 'Graphics', 'Underlay', 'Text', 'Dimensions', 'Structural', 'Identity Data', 'Phasing', 'Extents', 'Camera', 'Other'];

const P = (key, label, group, type, extra = {}) => ({ key, label, group, type, ...extra });

const mark = P('mark', 'Mark', 'Identity Data', 'text');
const comments = P('comments', 'Comments', 'Identity Data', 'text');

const LOCATION = [
  { value: 'center', label: 'Wall Centerline' },
  { value: 'exterior', label: 'Exterior Face' },
  { value: 'interior', label: 'Interior Face' },
];

const len = (key, label, group, extra) => P(key, label, group, 'length', extra);
const ro = (key, label, group, get, type = 'length') => P(key, label, group, 'readonly', { get, format: type });

const baseLevel = P('levelId', 'Base Constraint', 'Constraints', 'level');
const topConstraint = P('topLevelId', 'Top Constraint', 'Constraints', 'levelOpt', { none: 'Unconnected' });

const INSTANCE = {
  wall: [
    P('locationLine', 'Location Line', 'Constraints', 'select', { options: () => LOCATION }),
    baseLevel,
    len('baseOffset', 'Base Offset', 'Constraints'),
    topConstraint,
    len('height', 'Unconnected Height', 'Constraints', { ro: (el) => !!el.topLevelId, get: (el, c) => (el.topLevelId ? wallHeight(el, c) : el.height) }),
    len('topOffset', 'Top Offset', 'Constraints', { ro: (el) => !el.topLevelId }),
    P('roomBounding', 'Room Bounding', 'Constraints', 'bool'),
    P('flipped', 'Flipped', 'Construction', 'bool'),
    P('joinA', 'Join at Start', 'Construction', 'bool'),
    P('joinB', 'Join at End', 'Construction', 'bool'),
    P('structural', 'Structural', 'Structural', 'bool'),
    ro('length', 'Length', 'Dimensions', (el) => dist(el.a, el.b)),
    ro('width', 'Width', 'Dimensions', (el, c) => typeThickness(c.doc.get(el.typeId))),
    ro('area', 'Area', 'Dimensions', (el, c) => dist(el.a, el.b) * wallHeight(el, c), 'area'),
    ro('volume', 'Volume', 'Dimensions', (el, c) => dist(el.a, el.b) * wallHeight(el, c) * typeThickness(c.doc.get(el.typeId)), 'volume'),
    mark,
    comments,
  ],
  door: [
    ro('level', 'Level', 'Constraints', (el, c) => c.doc.get(c.doc.get(el.hostId)?.levelId)?.name ?? '', 'text'),
    ro('host', 'Host', 'Constraints', (el, c) => c.doc.get(c.doc.get(el.hostId)?.typeId)?.name ?? '', 'text'),
    P('flipFacing', 'Flip Facing', 'Construction', 'bool'),
    P('flipHand', 'Flip Hand', 'Construction', 'bool'),
    len('t', 'Position Along Wall', 'Constraints'),
    ro('width', 'Width', 'Dimensions', (el, c) => openingSize(c.doc, el).width),
    ro('heightV', 'Height', 'Dimensions', (el, c) => openingSize(c.doc, el).height),
    mark,
    comments,
  ],
  window: [
    ro('level', 'Level', 'Constraints', (el, c) => c.doc.get(c.doc.get(el.hostId)?.levelId)?.name ?? '', 'text'),
    len('sill', 'Sill Height', 'Constraints', { get: (el, c) => openingSize(c.doc, el).sill }),
    ro('head', 'Head Height', 'Constraints', (el, c) => {
      const s = openingSize(c.doc, el);
      return s.sill + s.height;
    }),
    len('t', 'Position Along Wall', 'Constraints'),
    P('flipFacing', 'Flip Facing', 'Construction', 'bool'),
    ro('width', 'Width', 'Dimensions', (el, c) => openingSize(c.doc, el).width),
    ro('heightV', 'Height', 'Dimensions', (el, c) => openingSize(c.doc, el).height),
    mark,
    comments,
  ],
  opening: [len('width', 'Width', 'Dimensions'), len('height', 'Height', 'Dimensions'), len('sill', 'Sill Height', 'Constraints'), len('t', 'Position Along Wall', 'Constraints')],
  floor: [
    P('levelId', 'Level', 'Constraints', 'level'),
    len('offset', 'Height Offset From Level', 'Constraints'),
    P('structural', 'Structural', 'Structural', 'bool'),
    ro('thickness', 'Thickness', 'Dimensions', (el, c) => typeThickness(c.doc.get(el.typeId))),
    ro('area', 'Area', 'Dimensions', (el) => slabArea(el), 'area'),
    ro('perimeter', 'Perimeter', 'Dimensions', (el) => perimeter(el.boundary || [])),
    ro('volume', 'Volume', 'Dimensions', (el, c) => slabArea(el) * typeThickness(c.doc.get(el.typeId)), 'volume'),
    mark,
    comments,
  ],
  ceiling: [P('levelId', 'Level', 'Constraints', 'level'), len('offset', 'Height Offset From Level', 'Constraints'), ro('area', 'Area', 'Dimensions', (el) => slabArea(el), 'area'), ro('perimeter', 'Perimeter', 'Dimensions', (el) => perimeter(el.boundary || [])), mark, comments],
  roof: [
    P('levelId', 'Base Level', 'Constraints', 'level'),
    len('baseOffset', 'Base Offset From Level', 'Constraints'),
    P('slope', 'Slope (degrees)', 'Construction', 'number', {
      get: (el) => (el.slopes || []).find((s) => s != null) ?? 0,
      set: (el, v) => ({ slopes: (el.slopes || el.boundary.map(() => v)).map((s) => (s == null ? null : Math.max(0, Math.min(80, +v)))) }),
    }),
    ro('thickness', 'Thickness', 'Dimensions', (el, c) => typeThickness(c.doc.get(el.typeId))),
    ro('area', 'Footprint Area', 'Dimensions', (el) => polyArea(el.boundary || []), 'area'),
    ro('ridge', 'Ridge Height', 'Dimensions', (el, c) => {
      try {
        const g = roofGeometry(c.doc, el);
        let mx = 0;
        for (const f of g.faces) for (const p of f.poly) if (f.plane) mx = Math.max(mx, f.plane.k * ((p[0] - f.plane.p[0]) * f.plane.m[0] + (p[1] - f.plane.p[1]) * f.plane.m[1]));
        return mx;
      } catch {
        return 0;
      }
    }),
    mark,
    comments,
  ],
  column: [
    P('levelId', 'Base Level', 'Constraints', 'level'),
    len('baseOffset', 'Base Offset', 'Constraints'),
    topConstraint,
    len('topOffset', 'Top Offset', 'Constraints', { ro: (el) => !el.topLevelId }),
    len('height', 'Unconnected Height', 'Constraints', { ro: (el) => !!el.topLevelId }),
    P('rotation', 'Rotation', 'Constraints', 'angle'),
    P('structural', 'Structural', 'Structural', 'bool'),
    mark,
    comments,
  ],
  beam: [P('levelId', 'Reference Level', 'Constraints', 'level'), len('offset', 'Top Offset From Level', 'Constraints'), ro('length', 'Length', 'Dimensions', (el) => dist(el.a, el.b)), mark, comments],
  stair: [
    P('levelId', 'Base Level', 'Constraints', 'level'),
    len('baseOffset', 'Base Offset', 'Constraints'),
    P('topLevelId', 'Top Level', 'Constraints', 'levelOpt', { none: 'Unconnected' }),
    len('topOffset', 'Top Offset', 'Constraints', { ro: (el) => !el.topLevelId }),
    len('height', 'Unconnected Height', 'Constraints', { ro: (el) => !!el.topLevelId }),
    P('shape', 'Shape', 'Construction', 'select', { get: (el) => el.shape || 'straight', options: () => STAIR_SHAPES }),
    P('turn', 'Turn', 'Construction', 'select', {
      get: (el) => el.turn || 'left',
      options: () => [
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
      ],
    }),
    len('width', 'Width', 'Dimensions', { get: (el, c) => stairLayout(c.doc, el).width }),
    P('risers', 'Number of Risers', 'Dimensions', 'number', { get: (el, c) => stairLayout(c.doc, el).risers, set: (el, v) => ({ risers: Math.max(2, Math.round(+v)) }) }),
    ro('riserHeight', 'Actual Riser Height', 'Dimensions', (el, c) => stairLayout(c.doc, el).riserHeight),
    len('tread', 'Tread Depth', 'Dimensions', { get: (el, c) => stairLayout(c.doc, el).tread }),
    ro('run', 'Run Length', 'Dimensions', (el, c) => stairLayout(c.doc, el).runLength),
    P('railings', 'Handrails', 'Construction', 'bool'),
    mark,
    comments,
  ],
  railing: [P('levelId', 'Level', 'Constraints', 'level'), len('offset', 'Offset From Level', 'Constraints'), ro('length', 'Length', 'Dimensions', (el) => pathLength(el.path || [])), mark, comments],
  component: [
    P('levelId', 'Level', 'Constraints', 'level'),
    len('offset', 'Offset From Level', 'Constraints'),
    P('rotation', 'Rotation', 'Constraints', 'angle'),
    ro('wd', 'Width', 'Dimensions', (el, c) => c.doc.get(el.typeId)?.width ?? 0),
    ro('dp', 'Depth', 'Dimensions', (el, c) => c.doc.get(el.typeId)?.depth ?? 0),
    ro('ht', 'Height', 'Dimensions', (el, c) => c.doc.get(el.typeId)?.height ?? 0),
    mark,
    comments,
  ],
  room: [
    P('name', 'Name', 'Identity Data', 'text'),
    P('number', 'Number', 'Identity Data', 'text'),
    ro('level', 'Level', 'Constraints', (el, c) => c.doc.get(el.levelId)?.name ?? '', 'text'),
    len('upperOffset', 'Height', 'Constraints'),
    ro('area', 'Area', 'Dimensions', (el, c) => c.scene?.rooms.room(el)?.area ?? 0, 'area'),
    ro('perimeter', 'Perimeter', 'Dimensions', (el, c) => c.scene?.rooms.room(el)?.perimeter ?? 0),
    ro('volume', 'Volume', 'Dimensions', (el, c) => (c.scene?.rooms.room(el)?.area ?? 0) * (+el.upperOffset || 0), 'volume'),
    P('department', 'Department', 'Identity Data', 'text'),
    P('floorFinish', 'Floor Finish', 'Identity Data', 'text'),
    P('wallFinish', 'Wall Finish', 'Identity Data', 'text'),
    P('ceilingFinish', 'Ceiling Finish', 'Identity Data', 'text'),
    P('occupant', 'Occupant', 'Identity Data', 'text'),
    comments,
  ],
  roomSeparator: [ro('length', 'Length', 'Dimensions', (el) => dist(el.a, el.b))],
  grid: [
    P('name', 'Name', 'Identity Data', 'text'),
    P('bubbles', 'Bubbles', 'Graphics', 'select', {
      options: () => [
        { value: 'both', label: 'Both ends' },
        { value: 'start', label: 'Start' },
        { value: 'end', label: 'End' },
      ],
    }),
    ro('length', 'Length', 'Dimensions', (el) => dist(el.a, el.b)),
  ],
  level: [P('name', 'Name', 'Identity Data', 'text'), len('elevation', 'Elevation', 'Constraints')],
  dimension: [P('override', 'Text Override', 'Text', 'text'), ro('refs', 'References', 'Other', (el) => String(el.refs?.length ?? 0), 'text')],
  text: [
    P('text', 'Text', 'Text', 'textarea'),
    P('size', 'Size (mm on paper)', 'Text', 'select', { options: () => [1.8, 2.5, 3.5, 5, 7].map((v) => ({ value: v, label: `${v} mm` })) }),
    P('rotation', 'Rotation', 'Text', 'angle'),
    P('bold', 'Bold', 'Text', 'bool'),
    P('align', 'Alignment', 'Text', 'select', {
      options: () => [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'right', label: 'Right' },
      ],
    }),
  ],
  tag: [
    P('show', 'Shows', 'Graphics', 'select', {
      get: (el) => el.show || 'mark',
      options: () => [
        { value: 'mark', label: 'Mark' },
        { value: 'type', label: 'Type' },
        { value: 'material', label: 'Material' },
        { value: 'keynote', label: 'Keynote' },
        { value: 'name', label: 'Name' },
      ],
    }),
    P('leader', 'Leader Line', 'Graphics', 'bool'),
    ro('target', 'Tags', 'Other', (el, c) => describe(c.doc, c.doc.get(el.targetId)), 'text'),
  ],
  region: [
    P('pattern', 'Fill Pattern', 'Graphics', 'select', {
      options: () => ['diag', 'cross', 'concrete', 'insulation', 'brick', 'wood', 'earth', 'solid', 'none'].map((v) => ({ value: v, label: v === 'none' ? 'Gray tone' : v[0].toUpperCase() + v.slice(1) })),
    }),
    P('outline', 'Show Outline', 'Graphics', 'bool'),
    ro('area', 'Area', 'Dimensions', (el) => polyArea(el.boundary || []), 'area'),
  ],
  detailLine: [
    P('style', 'Line Style', 'Graphics', 'select', { options: () => LINE_STYLES }),
    ro('length', 'Length', 'Dimensions', (el) => dist(el.a, el.b)),
  ],
  modelLine: [
    P('levelId', 'Level', 'Constraints', 'level'),
    len('offset', 'Offset From Level', 'Constraints'),
    P('style', 'Line Style', 'Graphics', 'select', { options: () => LINE_STYLES }),
    ro('length', 'Length', 'Dimensions', (el) => dist(el.a, el.b)),
  ],
  refPlane: [P('name', 'Name', 'Identity Data', 'text'), ro('length', 'Length', 'Dimensions', (el) => dist(el.a, el.b))],
  ramp: [
    P('levelId', 'Base Level', 'Constraints', 'level'),
    len('baseOffset', 'Base Offset', 'Constraints'),
    P('topLevelId', 'Top Level', 'Constraints', 'levelOpt', { none: 'Unconnected' }),
    len('topOffset', 'Top Offset', 'Constraints', { ro: (el) => !el.topLevelId }),
    len('height', 'Unconnected Height', 'Constraints', { ro: (el) => !!el.topLevelId }),
    len('width', 'Width', 'Dimensions', { get: (el, c) => rampLayout(c.doc, el).width }),
    P('slopeRatio', 'Slope (1 in ...)', 'Dimensions', 'number', { get: (el, c) => rampLayout(c.doc, el).ratio, set: (el, v) => ({ slopeRatio: Math.max(1, +v) }) }),
    ro('run', 'Run Length', 'Dimensions', (el, c) => rampLayout(c.doc, el).run),
    ro('rise', 'Rise', 'Dimensions', (el, c) => rampLayout(c.doc, el).rise),
    P('railings', 'Handrails', 'Construction', 'bool', { get: (el) => el.railings !== false }),
    mark,
    comments,
  ],
  area: [
    P('name', 'Name', 'Identity Data', 'text'),
    P('number', 'Number', 'Identity Data', 'text'),
    ro('scheme', 'Area Scheme', 'Identity Data', (el) => schemeLabel(el.scheme), 'text'),
    ro('level', 'Level', 'Constraints', (el, c) => c.doc.get(el.levelId)?.name ?? '', 'text'),
    P('areaType', 'Area Type', 'Identity Data', 'select', { get: (el) => el.areaType || 'floor', options: () => AREA_TYPES }),
    ro('area', 'Area', 'Dimensions', (el, c) => c.scene?.areas.area(el)?.area ?? 0, 'area'),
    ro('perimeter', 'Perimeter', 'Dimensions', (el, c) => c.scene?.areas.area(el)?.perimeter ?? 0),
    comments,
  ],
  areaBoundary: [ro('scheme', 'Area Scheme', 'Identity Data', (el) => schemeLabel(el.scheme), 'text'), ro('length', 'Length', 'Dimensions', (el) => dist(el.a, el.b))],
  angularDim: [ro('angle', 'Angle', 'Dimensions', (el) => `${Math.round(((((el.a1 - el.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * (18000 / Math.PI)) / 100}°`, 'text'), len('r', 'Arc Radius', 'Graphics')],
  radialDim: [P('diameter', 'Show Diameter', 'Graphics', 'bool'), ro('value', 'Value', 'Dimensions', (el, c) => radialTarget(c.doc, el).r * (el.diameter ? 2 : 1))],
  spot: [ro('mode', 'Type', 'Identity Data', (el) => ({ elevation: 'Spot Elevation', coordinate: 'Spot Coordinate', slope: 'Spot Slope' })[el.mode] || '', 'text')],
  revisionCloud: [
    P('revisionId', 'Revision', 'Identity Data', 'select', { options: (c) => c.doc.all('revision').sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map((r) => ({ value: r.id, label: `${r.number ?? r.seq}: ${r.description || ''}` })) }),
    P('showTag', 'Show Revision Tag', 'Graphics', 'bool', { get: (el) => el.showTag !== false }),
  ],
  insulation: [len('width', 'Insulation Width', 'Dimensions'), ro('length', 'Length', 'Dimensions', (el) => dist(el.a, el.b))],
  detailItem: [
    P('family', 'Component', 'Identity Data', 'select', { options: () => DETAIL_FAMILIES }),
    len('w', 'Width', 'Dimensions'),
    len('h', 'Height', 'Dimensions'),
    P('rotation', 'Rotation', 'Graphics', 'angle'),
  ],
  detailArc: [len('r', 'Radius', 'Dimensions'), P('style', 'Line Style', 'Graphics', 'select', { options: () => LINE_STYLES })],
  symbol: [P('rotation', 'Rotation', 'Graphics', 'angle'), P('size', 'Size', 'Graphics', 'number', { get: (el) => +el.size || 1 })],
  image: [
    P('name', 'Name', 'Identity Data', 'text'),
    len('w', 'Width', 'Dimensions', { set: (el, v) => ({ w: +v, h: (+v * (+el.h || 1)) / (+el.w || 1) }) }),
    len('h', 'Height', 'Dimensions', { set: (el, v) => ({ h: +v, w: (+v * (+el.w || 1)) / (+el.h || 1) }) }),
    P('rotation', 'Rotation', 'Graphics', 'angle'),
    P('opacity', 'Opacity (0 to 1)', 'Graphics', 'number', { get: (el) => el.opacity ?? 1, set: (el, v) => ({ opacity: Math.max(0.05, Math.min(1, +v)) }) }),
  ],
  colorLegend: [ro('by', 'Colors By', 'Graphics', (el, c) => ROOM_FILL_LABEL[c.doc.get(el.viewId)?.roomFillBy || 'name'], 'text')],
  footing: [P('levelId', 'Level', 'Constraints', 'level'), len('offset', 'Top Offset From Level', 'Constraints'), P('rotation', 'Rotation', 'Constraints', 'angle'), mark, comments],
  wallFooting: [ro('wall', 'Wall', 'Constraints', (el, c) => c.doc.get(c.doc.get(el.wallId)?.typeId)?.name ?? '', 'text'), ro('length', 'Length', 'Dimensions', (el, c) => (c.doc.get(el.wallId) ? dist(c.doc.get(el.wallId).a, c.doc.get(el.wallId).b) : 0)), mark, comments],
  brace: [
    P('levelId', 'Start Level', 'Constraints', 'level'),
    len('baseOffset', 'Start Offset', 'Constraints'),
    P('topLevelId', 'End Level', 'Constraints', 'levelOpt', { none: 'Unconnected' }),
    len('topOffset', 'End Offset', 'Constraints', { ro: (el) => !el.topLevelId }),
    len('height', 'Unconnected Rise', 'Constraints', { ro: (el) => !!el.topLevelId }),
    ro('length', 'Length', 'Dimensions', (el, c) => {
      const { z0, z1 } = braceHeights(c.doc, el);
      return Math.hypot(dist(el.a, el.b), z1 - z0);
    }),
    mark,
    comments,
  ],
  duct: mepParams('duct'),
  pipe: mepParams('pipe'),
  cableTray: mepParams('cableTray'),
  conduit: mepParams('conduit'),
  topo: [
    len('thickness', 'Thickness', 'Dimensions'),
    len('contour', 'Contour Interval', 'Graphics'),
    ro('points', 'Points', 'Dimensions', (el) => String(el.points?.length ?? 0), 'text'),
    ro('area', 'Projected Area', 'Dimensions', (el) => polyArea(topoBoundary(el)), 'area'),
    P('materialId', 'Material', 'Materials and Finishes', 'material'),
    P('editPoints', 'Points', 'Other', 'button', { action: 'topo-points', text: 'Edit...' }),
  ],
  propertyLine: [ro('area', 'Area', 'Dimensions', (el) => polyArea(el.boundary || []), 'area'), ro('perimeter', 'Perimeter', 'Dimensions', (el) => perimeter(el.boundary || [])), comments],
  mass: [
    P('name', 'Name', 'Identity Data', 'text'),
    P('levelId', 'Level', 'Constraints', 'level'),
    len('baseOffset', 'Base Offset', 'Constraints'),
    len('height', 'Height', 'Dimensions'),
    ro('footprint', 'Footprint Area', 'Dimensions', (el) => polyArea(el.boundary || []), 'area'),
    ro('gross', 'Gross Floor Area', 'Dimensions', (el, c) => massFloorArea(c.doc, el), 'area'),
    ro('volume', 'Volume', 'Dimensions', (el) => polyArea(el.boundary || []) * (+el.height || 0), 'volume'),
    comments,
  ],
  group: [
    ro('level', 'Reference Level', 'Constraints', (el, c) => c.doc.get(el.levelId)?.name ?? '', 'text'),
    P('rotation', 'Rotation', 'Constraints', 'angle', { ro: () => true }),
    ro('members', 'Members', 'Identity Data', (el, c) => String(c.doc.filter((x) => x.groupId === el.id).length), 'text'),
    ro('instances', 'Instances of Group', 'Identity Data', (el, c) => String(c.doc.all('group').filter((g) => g.typeId === el.typeId).length), 'text'),
    comments,
  ],
};

export const LINE_STYLES = ['thin', 'medium', 'wide', 'dashed', 'hidden', 'center'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));

/** Parameters of a duct, pipe, cable tray or conduit run. */
function mepParams(kind) {
  const round = (el, c) => mepSize(c.doc, el).round;
  const out = [P('levelId', 'Reference Level', 'Constraints', 'level'), len('offset', 'Middle Elevation', 'Constraints')];
  if (SYSTEMS[kind].length > 1) out.push(P('system', 'System Type', 'Identity Data', 'select', { get: (el) => systemOf(el).value, options: () => SYSTEMS[kind] }));
  if (kind === 'pipe' || kind === 'conduit') out.push(len('diameter', 'Diameter', 'Dimensions', { get: (el, c) => mepSize(c.doc, el).w }));
  else {
    out.push(len('width', 'Width', 'Dimensions', { get: (el, c) => mepSize(c.doc, el).w, ro: round }));
    out.push(len('height', 'Height', 'Dimensions', { get: (el, c) => mepSize(c.doc, el).h, ro: round }));
    if (kind === 'duct') out.push(len('diameter', 'Diameter', 'Dimensions', { get: (el, c) => mepSize(c.doc, el).w, ro: (el, c) => !round(el, c) }));
  }
  out.push(ro('length', 'Length', 'Dimensions', (el) => dist(el.a, el.b)), mark, comments);
  return out;
}

const ROOM_FILL_LABEL = { name: 'Name', department: 'Department', occupant: 'Occupant', floorFinish: 'Floor Finish', number: 'Number' };

export const AREA_SCHEMES = [
  { value: 'gross', label: 'Gross Building' },
  { value: 'rentable', label: 'Rentable' },
];

export const AREA_TYPES = [
  { value: 'floor', label: 'Floor Area' },
  { value: 'office', label: 'Office Area' },
  { value: 'store', label: 'Store Area' },
  { value: 'common', label: 'Building Common Area' },
  { value: 'major', label: 'Major Vertical Penetration' },
  { value: 'exterior', label: 'Exterior Area' },
];

export function schemeLabel(s) {
  return AREA_SCHEMES.find((x) => x.value === (s || 'gross'))?.label ?? s;
}

const DETAIL = [
  { value: 'coarse', label: 'Coarse' },
  { value: 'medium', label: 'Medium' },
  { value: 'fine', label: 'Fine' },
];

const STYLES = [
  { value: 'wireframe', label: 'Wireframe' },
  { value: 'hidden', label: 'Hidden Line' },
  { value: 'shaded', label: 'Shaded' },
  { value: 'consistent', label: 'Consistent Colors' },
  { value: 'realistic', label: 'Realistic' },
];

const templated = (el) => !!el.templateId;
const viewName = P('name', 'View Name', 'Identity Data', 'text');
const viewScale = P('scale', 'View Scale', 'Graphics', 'select', { options: (c) => scaleOptions(c.doc.units), get: (el) => el.scale, set: (el, v) => ({ scale: +v }), ro: templated });
const viewDetail = P('detail', 'Detail Level', 'Graphics', 'select', { options: () => DETAIL, ro: templated });
const vis = P('vis', 'Visibility/Graphics', 'Graphics', 'button', { action: 'visibility', text: 'Edit...' });
const viewStyle = P('style', 'Visual Style', 'Graphics', 'select', { options: () => STYLES, ro: templated });
const viewTemplate = P('templateId', 'View Template', 'Identity Data', 'select', {
  get: (el) => el.templateId || '',
  options: (c) => [{ value: '', label: '<None>' }, ...c.doc.all('viewTemplate').filter((t) => t.viewKind === templateKindOf(c.items?.[0]?.kind || 'plan')).map((t) => ({ value: t.id, label: t.name }))],
  set: (el, v, c) => (v ? applyTemplatePatch(c.doc.get(v)) : { templateId: null }),
});

/** A crop rectangle around what the view shows now (or a default area). */
export function defaultCrop(app, view) {
  const c = app?.controllers?.get(view.id) || (app && app.controllerFor?.(view));
  c?.sync?.();
  const b = c?.extents?.();
  const pad = 1000;
  return b ? { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad } : { x0: -5000, y0: -5000, x1: 15000, y1: 12000 };
}

const cropOn = P('cropOn', 'Crop View', 'Extents', 'bool', { set: (el, v, c) => ({ cropOn: !!v, ...(v && !el.crop ? { crop: defaultCrop(c.app, el) } : {}) }) });
const cropShow = P('cropShow', 'Crop Region Visible', 'Extents', 'bool', { set: (el, v, c) => ({ cropShow: !!v, ...(v && !el.crop ? { crop: defaultCrop(c.app, el) } : {}) }) });

const VIEW = {
  plan: [
    viewScale,
    viewDetail,
    vis,
    P('roomFill', 'Room Color Fill', 'Graphics', 'bool', { ro: templated }),
    P('roomFillBy', 'Color Scheme', 'Graphics', 'select', { get: (el) => el.roomFillBy || 'name', options: () => Object.entries(ROOM_FILL_LABEL).map(([value, label]) => ({ value, label: `Rooms by ${label}` })), ro: templated }),
    viewTemplate,
    P('underlay', 'Underlay', 'Underlay', 'select', {
      get: (el) => el.underlay || '',
      set: (el, v) => ({ underlay: v || null }),
      options: (c) => [{ value: '', label: 'None' }, { value: 'below', label: 'Level below' }, ...c.doc.levels().map((l) => ({ value: l.id, label: l.name }))],
    }), len('cutHeight', 'Cut Plane Height', 'Extents', { ro: templated }), len('viewDepth', 'View Depth Offset', 'Extents', { ro: templated }), cropOn, cropShow, ro('level', 'Associated Level', 'Identity Data', (el, c) => c.doc.get(el.levelId)?.name ?? '', 'text'), viewName],
  ceilingPlan: [viewScale, viewDetail, vis, len('cutHeight', 'Cut Plane Height', 'Extents', { ro: templated }), cropOn, cropShow, ro('level', 'Associated Level', 'Identity Data', (el, c) => c.doc.get(el.levelId)?.name ?? '', 'text'), viewTemplate, viewName],
  areaPlan: [
    viewScale,
    viewDetail,
    vis,
    len('cutHeight', 'Cut Plane Height', 'Extents', { ro: templated }),
    cropOn,
    cropShow,
    ro('scheme', 'Area Scheme', 'Identity Data', (el) => schemeLabel(el.scheme), 'text'),
    ro('level', 'Associated Level', 'Identity Data', (el, c) => c.doc.get(el.levelId)?.name ?? '', 'text'),
    viewTemplate,
    viewName,
  ],
  view3d: [
    viewStyle,
    viewDetail,
    vis,
    P('sectionBoxOn', 'Section Box', 'Extents', 'bool', { get: (el) => !!el.sectionBox, set: () => null, action: 'section-box' }),
    P('persp', 'Perspective', 'Camera', 'bool', { get: (el, c) => c.app?.vc?.cam?.persp !== false, set: () => null, action: 'toggle-persp' }),
    viewTemplate,
    viewName,
  ],
  drafting: [viewScale, viewDetail, vis, viewName],
  legend: [viewScale, viewDetail, vis, viewName],
  elevation: [viewScale, viewStyle, viewDetail, vis, len('depth', 'Far Clip Offset', 'Extents'), viewTemplate, viewName],
  section: [viewScale, viewStyle, viewDetail, vis, len('depth', 'Far Clip Offset', 'Extents'), viewTemplate, viewName],
  schedule: [viewName, ro('category', 'Category', 'Other', (el) => el.category, 'text'), P('fields', 'Fields', 'Other', 'button', { action: 'schedule-fields', text: 'Edit...' })],
  sheet: [
    P('number', 'Sheet Number', 'Identity Data', 'text'),
    P('name', 'Sheet Name', 'Identity Data', 'text'),
    P('drawnBy', 'Drawn By', 'Identity Data', 'text'),
    P('checkedBy', 'Checked By', 'Identity Data', 'text'),
    P('issueDate', 'Issue Date', 'Identity Data', 'text'),
    P('size', 'Sheet Size', 'Graphics', 'select', { options: () => SHEET_SIZES.map((s) => ({ value: s.id, label: s.label })) }),
  ],
};

export const SHEET_SIZES = [
  { id: 'A3', label: 'A3 (420 x 297 mm)', w: 420, h: 297 },
  { id: 'A2', label: 'A2 (594 x 420 mm)', w: 594, h: 420 },
  { id: 'A1', label: 'A1 (841 x 594 mm)', w: 841, h: 594 },
  { id: 'A0', label: 'A0 (1189 x 841 mm)', w: 1189, h: 841 },
  { id: 'ARCHC', label: 'ARCH C (24 x 18 in)', w: 609.6, h: 457.2 },
  { id: 'ARCHD', label: 'ARCH D (36 x 24 in)', w: 914.4, h: 609.6 },
  { id: 'ARCHE', label: 'ARCH E (48 x 36 in)', w: 1219.2, h: 914.4 },
  { id: 'TABLOID', label: 'Tabloid (17 x 11 in)', w: 431.8, h: 279.4 },
];

const MAT = (key, label) => P(key, label, 'Materials and Finishes', 'material');

export const TYPE_PARAMS = {
  wallType: [
    P('function', 'Function', 'Construction', 'select', {
      options: () => [
        { value: 'exterior', label: 'Exterior' },
        { value: 'interior', label: 'Interior' },
        { value: 'foundation', label: 'Foundation' },
      ],
    }),
    P('layers', 'Structure', 'Construction', 'button', { action: 'edit-layers', text: 'Edit...' }),
    ro('thick', 'Thickness', 'Construction', (t) => typeThickness(t)),
    P('mark', 'Type Mark', 'Identity Data', 'text'),
    P('description', 'Description', 'Identity Data', 'text'),
  ],
  floorType: [P('layers', 'Structure', 'Construction', 'button', { action: 'edit-layers', text: 'Edit...' }), ro('thick', 'Thickness', 'Construction', (t) => typeThickness(t)), P('mark', 'Type Mark', 'Identity Data', 'text')],
  roofType: [P('layers', 'Structure', 'Construction', 'button', { action: 'edit-layers', text: 'Edit...' }), ro('thick', 'Thickness', 'Construction', (t) => typeThickness(t)), P('mark', 'Type Mark', 'Identity Data', 'text')],
  ceilingType: [P('layers', 'Structure', 'Construction', 'button', { action: 'edit-layers', text: 'Edit...' }), len('pattern', 'Grid Spacing (0 for none)', 'Graphics'), P('mark', 'Type Mark', 'Identity Data', 'text')],
  doorType: [
    len('width', 'Width', 'Dimensions'),
    len('height', 'Height', 'Dimensions'),
    len('frameWidth', 'Frame Width', 'Dimensions'),
    len('thickness', 'Panel Thickness', 'Dimensions'),
    P('glazing', 'Glazed Panel', 'Construction', 'bool'),
    MAT('panelMaterialId', 'Panel Material'),
    MAT('frameMaterialId', 'Frame Material'),
    P('mark', 'Type Mark', 'Identity Data', 'text'),
  ],
  windowType: [len('width', 'Width', 'Dimensions'), len('height', 'Height', 'Dimensions'), len('sill', 'Default Sill Height', 'Dimensions'), len('frameWidth', 'Frame Width', 'Dimensions'), len('frameDepth', 'Frame Depth', 'Dimensions'), MAT('frameMaterialId', 'Frame Material'), P('mark', 'Type Mark', 'Identity Data', 'text')],
  columnType: [
    P('shape', 'Shape', 'Construction', 'select', {
      options: () => [
        { value: 'rect', label: 'Rectangular' },
        { value: 'round', label: 'Round' },
      ],
    }),
    len('width', 'Width (b)', 'Dimensions'),
    len('depth', 'Depth (h)', 'Dimensions'),
    MAT('materialId', 'Material'),
    P('mark', 'Type Mark', 'Identity Data', 'text'),
  ],
  beamType: [len('width', 'Width', 'Dimensions'), len('depth', 'Depth', 'Dimensions'), MAT('materialId', 'Material'), P('mark', 'Type Mark', 'Identity Data', 'text')],
  stairType: [len('maxRiser', 'Maximum Riser Height', 'Dimensions'), len('tread', 'Minimum Tread Depth', 'Dimensions'), len('width', 'Default Width', 'Dimensions'), len('thickness', 'Thickness', 'Construction'), P('monolithic', 'Monolithic', 'Construction', 'bool'), MAT('materialId', 'Material')],
  footingType: [len('width', 'Width', 'Dimensions'), len('length', 'Length', 'Dimensions'), len('thickness', 'Thickness', 'Dimensions'), MAT('materialId', 'Material'), P('mark', 'Type Mark', 'Identity Data', 'text')],
  wallFootingType: [len('width', 'Width', 'Dimensions'), len('thickness', 'Thickness', 'Dimensions'), MAT('materialId', 'Material'), P('mark', 'Type Mark', 'Identity Data', 'text')],
  ductType: [
    P('shape', 'Shape', 'Construction', 'select', {
      options: () => [
        { value: 'rect', label: 'Rectangular' },
        { value: 'round', label: 'Round' },
      ],
    }),
    len('width', 'Width', 'Dimensions'),
    len('height', 'Height', 'Dimensions'),
    len('diameter', 'Diameter', 'Dimensions'),
    MAT('materialId', 'Material'),
  ],
  pipeType: [len('diameter', 'Diameter', 'Dimensions'), MAT('materialId', 'Material')],
  cableTrayType: [len('width', 'Width', 'Dimensions'), len('height', 'Height', 'Dimensions'), MAT('materialId', 'Material')],
  conduitType: [len('diameter', 'Diameter', 'Dimensions'), MAT('materialId', 'Material')],
  rampType: [
    P('slopeRatio', 'Maximum Slope (1 in ...)', 'Dimensions', 'number'),
    len('width', 'Default Width', 'Dimensions'),
    len('thickness', 'Thickness', 'Construction'),
    MAT('materialId', 'Material'),
    P('mark', 'Type Mark', 'Identity Data', 'text'),
  ],
  railingType: [len('height', 'Rail Height', 'Dimensions'), len('spacing', 'Baluster Spacing', 'Dimensions'), len('rail', 'Rail Size', 'Dimensions'), P('glass', 'Glass Panels', 'Construction', 'bool'), MAT('materialId', 'Material')],
  componentType: [len('width', 'Width', 'Dimensions'), len('depth', 'Depth', 'Dimensions'), len('height', 'Height', 'Dimensions'), len('elevation', 'Default Elevation', 'Dimensions'), ro('category', 'Category', 'Identity Data', (t) => t.category, 'text'), P('mark', 'Type Mark', 'Identity Data', 'text')],
};

// Every model type can carry a keynote, shown by keynote tags.
for (const k of ['wallType', 'floorType', 'roofType', 'ceilingType', 'doorType', 'windowType', 'columnType', 'beamType', 'stairType', 'rampType', 'railingType', 'componentType']) {
  TYPE_PARAMS[k].push(P('keynote', 'Keynote', 'Identity Data', 'text'));
}

const phaseOptions = (c, none) => [...(none ? [{ value: '', label: none }] : []), ...phasesInOrder(c.doc).map((p) => ({ value: p.id, label: p.name }))];
const lastPhase = (c) => phasesInOrder(c.doc).at(-1)?.id ?? '';
const PHASE_PARAMS = [
  P('phaseId', 'Phase Created', 'Phasing', 'select', { get: (el, c) => el.phaseId || lastPhase(c), options: (c) => phaseOptions(c) }),
  P('demolishedId', 'Phase Demolished', 'Phasing', 'select', { get: (el) => el.demolishedId || '', set: (el, v) => ({ demolishedId: v || null }), options: (c) => phaseOptions(c, 'None') }),
];
const VIEW_PHASE = [
  P('phaseId', 'Phase', 'Phasing', 'select', { get: (el, c) => el.phaseId || lastPhase(c), options: (c) => phaseOptions(c), ro: templated }),
  P('phaseFilter', 'Phase Filter', 'Phasing', 'select', { get: (el) => el.phaseFilter || 'all', options: () => PHASE_FILTERS, ro: templated }),
];
const PHASED_VIEWS = new Set(['plan', 'ceilingPlan', 'areaPlan', 'view3d', 'elevation', 'section']);

export function instanceParams(el) {
  if (VIEW[el.kind]) return PHASED_VIEWS.has(el.kind) ? [...VIEW[el.kind], ...VIEW_PHASE] : VIEW[el.kind];
  const base = INSTANCE[el.kind] || [mark, comments];
  return phased(el) ? [...base, ...PHASE_PARAMS] : base;
}

export function paramValue(d, el, ctx) {
  if (d.get) return d.get(el, ctx);
  return el[d.key];
}

/** Patch for setting a parameter (null means the descriptor handles it with an action). */
export function paramPatch(d, el, value, ctx) {
  if (d.set) return d.set(el, value, ctx);
  if (d.type === 'number') return { [d.key]: +value };
  if (d.type === 'select' && typeof paramValue(d, el, ctx) === 'number') return { [d.key]: +value };
  return { [d.key]: value };
}

export function isReadOnly(d, el, ctx) {
  return d.type === 'readonly' || (typeof d.ro === 'function' && d.ro(el, ctx));
}

function wallHeight(el, c) {
  const { base, top } = verticalExtent(c.doc, el);
  return top - base;
}

function slabArea(el) {
  const outer = polyArea(el.boundary || []);
  return outer - (el.holes || []).reduce((s, h) => s + polyArea(h), 0);
}

function pathLength(p) {
  let s = 0;
  for (let i = 0; i + 1 < p.length; i++) s += dist(p[i], p[i + 1]);
  return s;
}

export function describe(doc, el) {
  if (!el) return '';
  if (el.kind === 'room') return `Room ${el.number || ''} ${el.name || ''}`.trim();
  if (el.kind === 'area') return `Area ${el.name || ''}`.trim();
  if (el.kind === 'level' || el.kind === 'grid' || (el.kind === 'refPlane' && el.name)) return `${KIND_LABEL[el.kind]} ${el.name}`;
  const t = doc.get(el.typeId);
  const base = KIND_LABEL[el.kind] || el.kind;
  return t ? `${base}: ${t.name}` : base;
}

