// The assistant's tools: function schemas for the model and what each does.
// Every change rebuilds the model before the tool answers, and a change that
// makes a feature fail is undone and reported as an error, so the model never
// leaves the part broken without knowing. Answers are plain text with exact
// ids, names and coordinates for the next step.

import type { MeasureTarget } from '../kernel/protocol';
import type { Vec3 } from '../math/vec';
import { cross, dot, len, normalize } from '../math/vec';
import { changeUnits } from '../model/document';
import { evaluate, evaluateVariables, reservedName } from '../model/expr';
import { consumedSketches, defaultName, dependencies, newSketch } from '../model/features';
import { MATERIALS } from '../model/materials';
import type { DrawingViewKind, Feature, FeatureType, Id, PartDocument, SketchFeature, UnitSystem } from '../model/types';
import { UNIT_SYSTEMS } from '../model/units';
import type { ViewName } from '../render/camera';
import type { DisplayStyle } from '../render/renderer';
import type { SelItem } from '../app/selection';
import { SketchIndex } from '../sketch/geom';
import { solveSketch } from '../sketch/solver';
import { ADD_TOOLS } from './features';
import type { AssistantHost } from './host';
import { Inspector } from './inspect';
import { SketchEdit, constraintLine, entityLine, sketchReport } from './sketch';
import { ToolError, Units, num, qty } from './units';

type Obj = Record<string, unknown>;

export interface ToolResult {
  ok: boolean;
  content: string;
  /** The document changed. */
  changed?: boolean;
  /** A screenshot (data URL) the model should look at. */
  image?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Obj };
}

interface ToolDef {
  name: string;
  description: string;
  parameters: Obj;
  run(a: Obj, k: Toolkit): Promise<ToolResult | string>;
}

// ---------- schema helpers ----------

const obj = (properties: Obj, required: string[] = []): Obj => ({ type: 'object', properties, required, additionalProperties: false });
const S = (description: string, extra: Obj = {}): Obj => ({ type: 'string', description, ...extra });
const N = (description: string): Obj => ({ type: 'number', description });
const B = (description: string): Obj => ({ type: 'boolean', description });
const ARR = (items: Obj, description: string): Obj => ({ type: 'array', items, description });
const PARAM = (description: string): Obj => ({ type: ['number', 'string'], description: `${description}. A number in the part's length unit (degrees for angles), or an expression such as "=Width/2" (global variables) or a value with a unit ("12mm", "0.5in").` });
const POINT: Obj = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 3, description: '[x, y] in sketch coordinates, or [x, y, z] in world coordinates (projected onto the sketch plane)' };
const PLANE = S('Plane: "front" (XY, normal +Z), "top" (XZ, normal +Y), "right" (YZ, normal +X), a reference plane feature id, or the name of a planar face');
const AXIS: Obj = { description: 'Axis or direction: "x", "y", "z", a straight or circular edge name, a planar or cylindrical face name, or {"sketch": id, "line": id} for a sketch line', anyOf: [{ type: 'string' }, obj({ sketch: S('Sketch id'), line: S('Line entity id') }, ['sketch', 'line'])] };
const NAMES = (what: string) => ARR({ type: 'string' }, what);
const FEATURE_NAME = S('Display name for the feature tree (optional; a default like "Extrude3" is used)');
const VIEWS: ViewName[] = ['front', 'back', 'left', 'right', 'top', 'bottom', 'isometric', 'trimetric', 'dimetric'];
const STYLES: DisplayStyle[] = ['shadedEdges', 'shaded', 'hiddenRemoved', 'hiddenVisible', 'wireframe'];

const SHAPE: Obj = {
  type: 'object',
  description: 'A sketch shape. Generated entity ids are listed in the result. type and its fields:\n' +
    '- point {at} (a stand-alone point; hole centres)\n' +
    '- line {from, to} / centerline {from, to} (construction line; revolve axis, symmetry line)\n' +
    '- polyline {points, closed} (lines id_l0.. between points id_p0..)\n' +
    '- rectangle {corner1, corner2} or {center, width, height} (corners id_p0..p3 counter-clockwise from min x/min y; lines id_l0 bottom, id_l1 right, id_l2 top, id_l3 left; centred ones add construction diagonals and centre point id_c)\n' +
    '- circle {center, radius | diameter} (circle id, centre point id_c)\n' +
    '- arc {center, radius, start_angle, end_angle} (degrees, counter-clockwise), or {center, start, end}, or {start, through, end} (arc id, centre id_c, ends id_a, id_b)\n' +
    '- polygon {center, sides, radius, inscribed (default true: radius to the vertices; false: to the flats), angle (of the first vertex, default 90)}\n' +
    '- slot {center1, center2, width} or {center, length, width, angle} (straight slot; length between arc centres)\n' +
    '- spline {points}\n' +
    'Any shape takes "id" (your own id, used as a prefix for its parts) and "construction": true. End points that land exactly on existing curve end points are joined.',
  properties: {
    type: S('Shape type', { enum: ['point', 'line', 'centerline', 'polyline', 'rectangle', 'center_rectangle', 'circle', 'arc', 'polygon', 'slot', 'spline'] }),
    id: S('Optional id (letters, digits, _ or -)'),
    construction: B('Construction geometry (not part of profiles)'),
    at: POINT, from: POINT, to: POINT, start: POINT, end: POINT, through: POINT, center: POINT, center1: POINT, center2: POINT, corner1: POINT, corner2: POINT,
    points: ARR(POINT, 'Points in order'),
    closed: B('Close the polyline'),
    width: N('Width'), height: N('Height'), length: N('Slot length between arc centres'),
    radius: N('Radius'), diameter: N('Diameter'),
    start_angle: N('Arc start angle in degrees (0 = +x of the sketch)'), end_angle: N('Arc end angle in degrees'),
    sides: N('Polygon sides'), inscribed: B('Polygon radius goes to the vertices (true) or the flats (false)'), angle: N('Rotation in degrees'),
  },
  required: ['type'],
};
const RELATION: Obj = obj({
  type: S('Relation', { enum: ['coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent', 'equal', 'concentric', 'midpoint', 'collinear', 'fix', 'symmetric'] }),
  refs: NAMES('Entity ids ("O" is the sketch origin). symmetric: two points/lines/circles, then the symmetry line last. midpoint: a point and a line.'),
}, ['type', 'refs']);
const DIMENSION: Obj = obj({
  refs: NAMES('One or two entity ids ("O" is the origin). One line: its length; one circle: diameter; one arc: radius; two points (circle/arc ids mean their centres); point and line: perpendicular distance; two parallel lines: their distance; two lines at an angle: the angle.'),
  type: S('Optional; inferred from refs when omitted', { enum: ['distance', 'hdistance', 'vdistance', 'radius', 'diameter', 'angle'] }),
  value: PARAM('Value to drive the geometry to; omit to lock the current size'),
  name: S('Optional dimension name (default D1, D2…)'),
  driven: B('Reference dimension that only reports its value'),
}, ['refs']);
const SKETCH_OPS: Obj = {
  shapes: ARR(SHAPE, 'Shapes to add'),
  relations: ARR(RELATION, 'Geometric relations to add (after the shapes)'),
  dimensions: ARR(DIMENSION, 'Driving dimensions to add (after the relations)'),
  auto_relations: B('Add horizontal/vertical relations to axis-aligned lines and coincident-with-origin to points at (0,0) (default true)'),
};
const REGIONS = ARR(POINT, 'Optional points inside the closed regions to use (sketch coordinates); by default every region is used, nested ones alternating material/holes');

function featureTool(type: FeatureType, description: string, props: Obj, required: string[]): ToolDef {
  return {
    name: ADD_TOOLS[type]!,
    description,
    parameters: obj({ name: FEATURE_NAME, ...props }, required),
    run: (a, k) => k.addFeature(type, a),
  };
}

const TOOLS: ToolDef[] = [
  // ---------- reading ----------
  {
    name: 'get_model',
    description: 'The part as it is now: units, material, global variables, every feature in build order with its arguments and rebuild status, the body\'s size, and the selection. Pass feature ids to get their full arguments (exactly what edit_feature takes) and faces.',
    parameters: obj({ features: NAMES('Feature ids or names to describe in full') }),
    run: async (a, k) => k.getModel(a),
  },
  {
    name: 'get_sketch',
    description: 'Everything in one sketch: its plane and how sketch coordinates map to world space, every entity with ids and coordinates, relations and dimensions, definition status (degrees of freedom, conflicts) and the closed profiles it forms.',
    parameters: obj({ sketch: S('Sketch id or name') }, ['sketch']),
    run: async (a, k) => k.getSketch(a),
  },
  {
    name: 'find_geometry',
    description: 'List faces or edges of the current body with their names (what fillet, chamfer, shell, sketch planes, axes and measure take), types, positions, normals, radii, lengths and areas. Filter to find exactly the ones you need.',
    parameters: obj({
      kind: S('What to list', { enum: ['faces', 'edges'] }),
      feature: S('Only faces created by this feature id (edges: edges bordering such faces)'),
      type: S('Face type (plane, cylinder, cone, sphere, torus, bspline…) or edge type (line, circle, bspline…)'),
      normal: ARR({ type: 'number' }, 'Faces: only planar faces whose outward normal is this direction, e.g. [0, 1, 0]'),
      direction: ARR({ type: 'number' }, 'Edges: only straight edges along this direction or circular edges around this axis'),
      of_face: S('Edges: only the edges bounding this face'),
      near: ARR({ type: 'number' }, 'Sort by distance from this world point [x, y, z]'),
      name_contains: S('Only names containing this text'),
      limit: N('At most this many (default 60, at most 400)'),
    }, ['kind']),
    run: async (a, k) => k.findGeometry(a),
  },
  {
    name: 'measure',
    description: 'Minimum distance between two faces, edges or world points, with the closest points. Also reports the angle between two planar faces or two straight edges.',
    parameters: obj({ a: { description: 'Face name, edge name or world point [x, y, z]' }, b: { description: 'Face name, edge name or world point [x, y, z]' } }, ['a', 'b']),
    run: async (a, k) => k.measure(a),
  },
  {
    name: 'mass_properties',
    description: 'Volume, surface area, mass (from the material density), centre of mass and principal moments of the body.',
    parameters: obj({}),
    run: async (_a, k) => k.massProperties(),
  },
  {
    name: 'calculate',
    description: 'Evaluate arithmetic exactly: + - * / ^, parentheses, sqrt, sin/cos/tan (degrees), asin/acos/atan (degrees), abs, min, max, round, floor, ceil, pi and the global variables. Use it instead of mental arithmetic for coordinates.',
    parameters: obj({ expressions: NAMES('Expressions to evaluate') }, ['expressions']),
    run: async (a, k) => k.calculate(a),
  },
  {
    name: 'capture_view',
    description: 'Look at the model: a screenshot of the graphics area, optionally from a standard orientation (the user\'s view is restored afterwards). Use it to check shapes, proportions and that features look right.',
    parameters: obj({
      orientation: S('Orientation to look from (default: the current view)', { enum: VIEWS }),
      style: S('Display style for the picture', { enum: STYLES }),
    }),
    run: async (a, k) => k.capture(a),
  },
  // ---------- sketches ----------
  {
    name: 'create_sketch',
    description: 'Create a sketch on a plane or planar face with shapes, relations and dimensions in one step. Returns the entity ids with coordinates, the definition status and the closed profiles. The sketch is added at the end of the tree (before the rollback bar).',
    parameters: obj({ plane: PLANE, name: S('Optional sketch name'), ...SKETCH_OPS }, ['plane']),
    run: async (a, k) => k.createSketch(a),
  },
  {
    name: 'edit_sketch',
    description: 'Change an existing sketch. Operations run in this order: delete, shapes, project_edges, move_points, set_radius, construction, fillets, offsets, mirrors, relations, dimensions, set_dimensions; then the sketch is solved and the model rebuilt.',
    parameters: obj({
      sketch: S('Sketch id or name'),
      name: S('Rename the sketch'),
      delete: NAMES('Entity, relation or dimension ids to delete (deleting a point deletes curves using it)'),
      ...SKETCH_OPS,
      project_edges: NAMES('Model edge names to project into the sketch as fixed curves (Convert Entities)'),
      move_points: ARR(obj({ point: S('Point id'), to: POINT }, ['point', 'to']), 'Move points before solving'),
      set_radius: ARR(obj({ circle: S('Circle id'), radius: N('New radius') }, ['circle', 'radius']), 'Resize circles (an existing radius/diameter dimension wins; change it with set_dimensions instead)'),
      construction: NAMES('Entity ids to make construction geometry'),
      normal: NAMES('Entity ids to make normal (not construction) geometry'),
      fillets: ARR(obj({ point: S('Corner point id where exactly two lines meet'), radius: N('Fillet radius') }, ['point', 'radius']), 'Round sketch corners'),
      offsets: ARR(obj({ curves: NAMES('Line, arc or circle ids (a connected chain offsets as one)'), distance: N('Distance; closed chains grow for positive, shrink for negative') }, ['curves', 'distance']), 'Offset curves'),
      mirrors: ARR(obj({ entities: NAMES('Entity ids to mirror'), axis: S('Line id to mirror about') }, ['entities', 'axis']), 'Mirror entities about a line'),
      set_dimensions: ARR(obj({ dimension: S('Dimension id or name'), value: PARAM('New value'), driven: B('Make it a reference (true) or driving (false) dimension') }, ['dimension']), 'Change dimension values'),
    }, ['sketch']),
    run: async (a, k) => k.editSketch(a),
  },
  // ---------- features ----------
  featureTool('extrude', 'Extrude a sketch\'s closed profiles into a boss (adds material) or a cut. Bosses go along the sketch normal, cuts against it (into the face a sketch sits on); reverse flips that.', {
    sketch: S('Profile sketch id'),
    cut: B('Remove material instead of adding it'),
    end: S('End condition (default blind; cuts default to through_all)', { enum: ['blind', 'through_all', 'mid_plane'] }),
    depth: PARAM('Depth (blind), or total depth (mid_plane, half each side)'),
    reverse: B('Extrude the other way'),
    direction2: { anyOf: [{ type: 'null' }, obj({ end: S('End condition', { enum: ['blind', 'through_all'] }), depth: PARAM('Depth') })], description: 'Also extrude the opposite way' },
    draft: PARAM('Draft angle in degrees (tapers the side walls inward)'),
    draft_outward: B('Taper outward instead'),
    regions: REGIONS,
  }, ['sketch']),
  featureTool('revolve', 'Revolve a sketch\'s closed profiles around an axis into a boss or cut. The profile must lie on one side of the axis.', {
    sketch: S('Profile sketch id'),
    axis: { ...AXIS, description: `${AXIS.description as string}. Default: the sketch's first centerline.` },
    angle: PARAM('Angle in degrees (360 for a full revolve)'),
    end: S('One direction or symmetric about the sketch plane', { enum: ['blind', 'mid_plane'] }),
    reverse: B('Revolve the other way'),
    cut: B('Remove material'),
    regions: REGIONS,
  }, ['sketch']),
  featureTool('fillet', 'Round edges with a constant radius. Faces round every edge of each face.', {
    edges: NAMES('Edge names'), faces: NAMES('Face names'), radius: PARAM('Radius'),
  }, ['radius']),
  featureTool('chamfer', 'Bevel edges. Faces chamfer every edge of each face.', {
    edges: NAMES('Edge names'), faces: NAMES('Face names'),
    mode: S('Chamfer type (default distance: equal distances)', { enum: ['distance', 'two_distances', 'distance_angle'] }),
    distance: PARAM('Distance'), distance2: PARAM('Second distance (two_distances)'), angle: PARAM('Angle in degrees (distance_angle)'),
    flip: B('Swap which face the first distance is measured on'),
  }, ['distance']),
  featureTool('shell', 'Hollow the body to a wall thickness, opening the removed faces.', {
    faces_to_remove: NAMES('Faces to open (empty: a closed hollow body)'),
    thickness: PARAM('Wall thickness'),
    outward: B('Add the wall outside the current surfaces instead of inside'),
  }, ['thickness']),
  featureTool('hole', 'Drill holes (simple, counterbored or countersunk) at stand-alone sketch points, into the material against the sketch normal. Give an existing sketch with points, or "on" with "points" to create the position sketch in the same step.', {
    sketch: S('Existing sketch whose stand-alone points are the hole centres'),
    on: PLANE,
    points: ARR(POINT, 'Hole centres (with "on"): sketch [x, y] or world [x, y, z]'),
    kind: S('Hole type (default simple)', { enum: ['simple', 'counterbore', 'countersink'] }),
    diameter: PARAM('Hole diameter'),
    end: S('Depth type (default through_all, or blind when depth is given)', { enum: ['blind', 'through_all'] }),
    depth: PARAM('Depth for blind holes'),
    cb_diameter: PARAM('Counterbore diameter'), cb_depth: PARAM('Counterbore depth'),
    cs_diameter: PARAM('Countersink diameter at the surface'), cs_angle: PARAM('Countersink included angle (e.g. 90 or 82)'),
    reverse: B('Drill along the sketch normal instead'),
  }, ['diameter']),
  featureTool('linearPattern', 'Copy features (extrudes, revolves, holes, lofts, sweeps, patterns) in a line or a grid. count includes the original.', {
    features: NAMES('Seed feature ids'), direction: AXIS, spacing: PARAM('Distance between instances'), count: PARAM('Number of instances including the original'),
    reverse: B('Go the other way'),
    direction2: { anyOf: [{ type: 'null' }, obj({ direction: AXIS, spacing: PARAM('Spacing'), count: PARAM('Instances'), reverse: B('Other way') }, ['direction', 'spacing', 'count'])], description: 'Second direction (grid)' },
  }, ['features', 'direction', 'spacing', 'count']),
  featureTool('circularPattern', 'Copy features around an axis. count includes the original.', {
    features: NAMES('Seed feature ids'), axis: AXIS, count: PARAM('Number of instances including the original'),
    angle: PARAM('Total angle in degrees (default 360)'), equal_spacing: B('Spread instances over the angle (default true); false: angle is the step between instances'),
    reverse: B('Go the other way'),
  }, ['features', 'axis', 'count']),
  featureTool('mirror', 'Mirror features (or the whole body when features is empty) about a plane.', {
    features: NAMES('Feature ids to mirror; empty or omitted mirrors the whole body'), plane: PLANE,
  }, ['plane']),
  featureTool('plane', 'Add a reference plane parallel to a plane or planar face at an offset (along its normal). Use it to sketch at a height or as a mirror plane.', {
    reference: PLANE, offset: PARAM('Offset distance along the normal'), reverse: B('Offset the other way'),
  }, ['reference']),
  featureTool('loft', 'Loft through two or more closed profile sketches (on different parallel or angled planes) in order.', {
    profiles: NAMES('Profile sketch ids in order'), cut: B('Remove material'), ruled: B('Straight sections between profiles'),
  }, ['profiles']),
  featureTool('sweep', 'Sweep a closed profile along a path sketch (open or closed curves). The profile should sit at the start of the path, roughly perpendicular to it.', {
    profile: S('Profile sketch id'), path: S('Path sketch id'), cut: B('Remove material'),
  }, ['profile', 'path']),
  featureTool('draft', 'Tilt faces by an angle about a neutral plane (for moulded parts).', {
    faces: NAMES('Faces to draft'), neutral_plane: PLANE, angle: PARAM('Draft angle in degrees'), reverse: B('Tilt the other way'),
  }, ['faces', 'neutral_plane', 'angle']),
  {
    name: 'edit_feature',
    description: 'Change a feature: any arguments of its add_ tool (only those given change), its name, suppression or visibility. Sketch contents change with edit_sketch.',
    parameters: obj({
      feature: S('Feature id or name'),
      params: { type: 'object', description: 'Arguments to change, as the feature\'s add_ tool takes them' },
      name: S('New display name'),
      suppressed: B('Suppress (skip in the rebuild) or unsuppress'),
      hidden: B('Hide or show (sketches, planes)'),
    }, ['feature']),
    run: async (a, k) => k.editFeature(a),
  },
  {
    name: 'delete_features',
    description: 'Delete features. Sketches used only by deleted features go with them. Features that depend on deleted ones must be included or with_dependents set.',
    parameters: obj({ features: NAMES('Feature ids or names'), with_dependents: B('Also delete every feature that depends on them') }, ['features']),
    run: async (a, k) => k.deleteFeatures(a),
  },
  {
    name: 'set_rollback',
    description: 'Move the rollback bar: features from this one on are not built (new features are inserted at the bar). null rolls to the end.',
    parameters: obj({ before: { type: ['string', 'null'], description: 'Feature id or name the bar goes before, or null for the end' } }, ['before']),
    run: async (a, k) => k.setRollback(a),
  },
  {
    name: 'set_variables',
    description: 'Create, change or delete global variables. Values are numbers in the part\'s length unit (or plain numbers) or expressions of other variables. Feature parameters and dimensions use them as "=Name".',
    parameters: obj({
      set: ARR(obj({ name: S('Variable name (letters, digits, _)'), value: { type: ['number', 'string'], description: 'Value or expression, e.g. 60 or "Width/2 + 5"' } }, ['name', 'value']), 'Variables to create or change'),
      delete: NAMES('Variable names to delete'),
    }),
    run: async (a, k) => k.setVariables(a),
  },
  {
    name: 'set_part',
    description: 'Part properties: name, unit system (stored geometry keeps its size), decimals shown, material (for mass) and colour.',
    parameters: obj({
      name: S('Part name'),
      units: S('Unit system', { enum: ['MMGS', 'CGS', 'MKS', 'IPS'] }),
      decimals: N('Decimal places shown for lengths (0-8)'),
      material: { anyOf: [{ type: 'null' }, { type: 'string' }, obj({ name: S('Name'), density: N('Density in kg/m³') }, ['name', 'density'])], description: `A preset (${MATERIALS.map((m) => m.name).join(', ')}), a custom {name, density}, or null` },
      color: S('Colour as #rrggbb'),
    }),
    run: async (a, k) => k.setPart(a),
  },
  // ---------- view ----------
  {
    name: 'set_view',
    description: 'Change what the user sees: orientation, look normal to a plane or face, zoom to fit, display style, and highlight (select) faces, edges or features to point them out.',
    parameters: obj({
      orientation: S('Standard orientation', { enum: VIEWS }),
      normal_to: PLANE,
      fit: B('Zoom to fit'),
      style: S('Display style', { enum: STYLES }),
      highlight: NAMES('Face names, edge names or feature ids to select'),
    }),
    run: async (a, k) => k.setView(a),
  },
  {
    name: 'drawing',
    description: 'The part\'s 2D drawing sheet: show or hide it, lay out standard views, add views, and set sheet size, orientation, scale and title block.',
    parameters: obj({
      show: B('Show (true) or leave (false) the drawing sheet'),
      arrange: B('Lay out front, top, right and isometric views at a fitting scale'),
      add_views: ARR({ type: 'string', enum: ['front', 'back', 'left', 'right', 'top', 'bottom', 'isometric'] }, 'Views to add'),
      sheet: S('Sheet size', { enum: ['A4', 'A3', 'A2', 'A1', 'Letter', 'Tabloid'] }),
      landscape: B('Landscape (true) or portrait'),
      scale: N('Model to paper scale, e.g. 0.5 for 1:2'),
      title: S('Title block title'), drawn_by: S('Drawn by'), notes: S('Notes'),
    }),
    run: async (a, k) => k.drawing(a),
  },
  {
    name: 'run_command',
    description: 'Run an app command the user would otherwise click: save the part, or export it (opens a save dialog for the user).',
    parameters: obj({ command: S('Command', { enum: ['save', 'export_step', 'export_stl', 'download_part', 'export_drawing_pdf', 'export_drawing_svg'] }) }, ['command']),
    run: async (a, k) => k.runCommand(a),
  },
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const CHANGING = new Set(['create_sketch', 'edit_sketch', 'edit_feature', 'delete_features', 'set_rollback', 'set_variables', 'set_part', 'drawing', ...Object.values(ADD_TOOLS)]);

/** Whether a tool can change the document. */
export const changesDocument = (name: string) => CHANGING.has(name);

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Arguments that are no longer offered but still get their own explanation. */
const RETIRED_ARGS = new Set(['thin']);

/** Says which arguments a tool does not take, or null when it takes them all. */
function unknownArgs(tool: ToolDef, a: Obj, prefix = '', skip: string[] = []): string | null {
  const props = Object.keys((tool.parameters as { properties?: Obj }).properties ?? {}).filter((k) => !skip.includes(k));
  const bad = Object.keys(a).filter((k) => a[k] != null && !props.includes(k) && !RETIRED_ARGS.has(k));
  if (!bad.length) return null;
  return `${tool.name} does not take ${bad.map((k) => `${prefix}${k}`).join(', ')}. It takes: ${props.join(', ')}.`;
}

/** Runs one tool call; never throws. */
export async function runTool(host: AssistantHost, name: string, args: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, content: `Error: there is no tool called ${name}.` };
  const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Obj) : {};
  // A misspelt optional argument would otherwise be skipped, and the call reported as done.
  const unknown = unknownArgs(tool, a);
  if (unknown) return { ok: false, content: `Error: ${unknown} Nothing was done.` };
  const k = new Toolkit(host);
  try {
    const r = await tool.run(a, k);
    return typeof r === 'string' ? { ok: true, content: r, changed: k.changed } : { ...r, changed: r.changed ?? k.changed };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, content: `Error: ${e.message}`, changed: k.changed };
    console.error(e);
    return { ok: false, content: `Error: ${(e as Error)?.message ?? String(e)}`, changed: k.changed };
  }
}

// ---------- implementations ----------

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const vec3 = (v: unknown, what: string): Vec3 => {
  if (!Array.isArray(v) || v.length !== 3 || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw new ToolError(`${what}: expected [x, y, z]`);
  return v as Vec3;
};

class Toolkit {
  readonly u: Units;
  readonly ins: Inspector;
  changed = false;

  constructor(readonly host: AssistantHost) {
    this.u = new Units(host.store);
    this.ins = new Inspector(host, this.u);
  }

  private get store() { return this.host.store; }
  private get doc(): PartDocument { return this.host.store.doc; }
  private get refs() { return this.ins.refs; }

  /**
   * Applies a document change, rebuilds and checks it. When a feature that
   * built before now fails (or the change's own feature fails), the change is
   * undone and reported as an error.
   */
  private async apply(label: string, mutate: (doc: PartDocument) => void, opts: { subject?: Id; keepErrors?: boolean } = {}): Promise<string> {
    this.host.prepareForEdit();
    await this.host.settle();
    const before = this.ins.errors();
    const mark = this.store.undoMark;
    this.store.change(label, mutate);
    if (this.store.undoMark === mark) return 'Nothing changed.';
    await this.host.settle();
    const after = this.ins.errors();
    const fresh = [...after].filter(([id, msg]) => before.get(id) !== msg);
    if (fresh.length && !opts.keepErrors) {
      const names = (id: Id) => { const f = this.store.feature(id); return f ? `${id} "${f.name}"` : id; };
      this.store.revertTo(mark);
      await this.host.settle();
      throw new ToolError(`the change made ${fresh.map(([id, msg]) => `${names(id)} fail: ${msg}`).join('; ')}. It was undone; the part is as it was before this call.`);
    }
    this.changed = true;
    const lines: string[] = [];
    const warn = opts.subject ? this.host.featureStatus(opts.subject)?.warning : null;
    if (warn) lines.push(`Warning: ${warn}`);
    if (fresh.length) lines.push(`Features now failing: ${fresh.map(([id, m]) => `${id}: ${m}`).join('; ')}`);
    const still = [...after].filter(([id]) => !fresh.some(([x]) => x === id));
    if (still.length) lines.push(`Features that were already failing: ${still.map(([id, m]) => `${id}: ${m}`).join('; ')}`);
    lines.push(this.ins.bodyText());
    if (this.host.bbox && this.host.faces.length < 4000) {
      const mp = await this.host.massProperties().catch(() => null);
      if (mp) lines.push(`Volume ${this.u.volume(mp.volume)}.`);
    }
    return lines.join('\n');
  }

  // ---------- reading ----------

  getModel(a: Obj): string {
    const parts = [this.ins.partHeader(), this.ins.variablesText(), this.ins.featuresText(200), this.ins.bodyText()];
    if (this.host.ui) parts.push(this.ins.selectionText(this.host.ui.selection()));
    for (const f of this.refs.features_(a.features, 'features')) {
      const i = this.store.indexOf(f.id);
      parts.push(`\n${f.id} "${f.name}" (${f.type}) → ${this.ins.status(f, i)}${f.suppressed ? ' [suppressed]' : ''}${f.hidden ? ' [hidden]' : ''}`);
      if (f.type === 'sketch') parts.push(`${this.ins.sketchFrameText(f)} Use get_sketch for its contents.`);
      else {
        parts.push(`Arguments: ${JSON.stringify(this.ins.codec.args(f))}`);
        const faces = this.ins.facesOf(f.id, 60);
        if (faces) parts.push(faces);
      }
    }
    return parts.join('\n');
  }

  getSketch(a: Obj): string {
    const sk = this.refs.sketch(a.sketch);
    const copy = structuredClone(sk);
    let solve = null;
    try {
      const vars = this.store.resolve().variables;
      solve = solveSketch(copy.entities, copy.constraints, { value: (d) => this.store.dimensionValue(d, vars) });
    } catch { /* report without status */ }
    const ix = new SketchIndex(copy.entities);
    const ents = copy.entities.map((e) => `- ${entityLine(copy, e, this.u, ix)}`);
    const cons = copy.constraints.map((c) => `- ${constraintLine(copy, c, this.u, this.store)}`);
    return [
      this.ins.sketchFrameText(sk),
      `Entities (${ents.length}); "O" is the sketch origin:`, ...(ents.length ? ents : ['- none']),
      `Relations and dimensions (${cons.length}):`, ...(cons.length ? cons : ['- none']),
      sketchReport(copy, solve, this.u, this.store),
    ].join('\n');
  }

  findGeometry(a: Obj): string {
    const kind = a.kind === 'edges' ? 'edges' : 'faces';
    if (!this.host.faces.length) return 'The part has no body yet.';
    const feature = a.feature != null ? this.refs.feature(a.feature).id : undefined;
    const limit = Math.max(1, Math.min(400, Math.round(Number(a.limit) || 60)));
    const scaled = (v: unknown, what: string) => vec3(v, what).map((x) => x * this.u.scale) as Vec3;
    return this.ins.findGeometry({
      kind, feature, type: a.type ? str(a.type) : undefined,
      normal: a.normal != null ? vec3(a.normal, 'normal') : undefined,
      direction: a.direction != null ? vec3(a.direction, 'direction') : undefined,
      ofFace: a.of_face != null ? str(a.of_face) : undefined,
      near: a.near != null ? scaled(a.near, 'near') : undefined,
      nameContains: a.name_contains ? str(a.name_contains) : undefined,
      limit,
    });
  }

  private target(v: unknown, what: string): { t: MeasureTarget; label: string; dir?: Vec3; normal?: Vec3 } {
    if (Array.isArray(v)) return { t: { kind: 'vertex', p: vec3(v, what).map((x) => x * this.u.scale) as Vec3 }, label: `point ${this.u.pt(vec3(v, what).map((x) => x * this.u.scale) as Vec3)}` };
    const s = str(v);
    const fi = this.host.faces.findIndex((f) => f.name === s);
    if (fi >= 0) return { t: { kind: 'face', index: fi }, label: `face ${s}`, normal: this.host.faces[fi].normal };
    const ei = this.host.edges.findIndex((e) => e.name === s);
    if (ei >= 0) return { t: { kind: 'edge', index: ei }, label: `edge ${s}`, dir: this.host.edges[ei].dir };
    this.refs.faceInfo(s, what);
    throw new ToolError(`${what}: not found`);
  }

  async measure(a: Obj): Promise<string> {
    const A = this.target(a.a, 'a'), Bt = this.target(a.b, 'b');
    const r = await this.host.measure(A.t, Bt.t);
    const lines = [`Distance between ${A.label} and ${Bt.label}: ${this.u.len(r.distance, true)} (closest points ${this.u.pt(r.p1)} and ${this.u.pt(r.p2)}; dx ${this.u.len(r.p2[0] - r.p1[0])}, dy ${this.u.len(r.p2[1] - r.p1[1])}, dz ${this.u.len(r.p2[2] - r.p1[2])}).`];
    const va = A.normal ?? A.dir, vb = Bt.normal ?? Bt.dir;
    if (va && vb) {
      const ang = (Math.atan2(len(cross(va, vb)), dot(va, vb)) * 180) / Math.PI;
      lines.push(`Angle between their ${A.normal ? 'normals' : 'directions'}: ${num(ang, 3)}°.`);
    }
    return lines.join('\n');
  }

  async massProperties(): Promise<string> {
    if (!this.host.bbox) return 'The part has no body yet.';
    const mp = await this.host.massProperties();
    if (!mp) return 'Mass properties are not available for this body.';
    const u = this.u;
    const us = UNIT_SYSTEMS[this.doc.units];
    const lines = [`Volume ${u.volume(mp.volume)}; surface area ${u.area(mp.area)}; centre of mass ${u.pt(mp.center)}.`];
    const m = this.doc.material;
    if (m) {
      const kg = mp.volume * 1e-9 * m.density;
      lines.push(`Mass ${num(kg / us.massScale, 4)} ${us.mass} (${m.name}, ${m.density} kg/m³).`);
    } else lines.push('Mass: set a material (set_part) to get the mass.');
    lines.push(`Principal moments per unit density: ${mp.principal.moments.map((x) => qty(x / u.scale ** 5, 2)).join(', ')} ${u.unit}⁵ about axes ${mp.principal.axes.map((x) => u.dir(normalize(x))).join(', ')}.`);
    lines.push(this.ins.bodyText());
    return lines.join('\n');
  }

  calculate(a: Obj): string {
    const exprs = list(a.expressions).map(str).filter(Boolean);
    if (!exprs.length) throw new ToolError('expressions: give at least one');
    const { values } = evaluateVariables(this.doc.variables);
    return exprs.map((e) => {
      try {
        return `${e} = ${num(evaluate(e.replace(/^=/, ''), { lookup: (n) => values.get(n) }), 10)}`;
      } catch (err) {
        return `${e}: error, ${(err as Error).message}`;
      }
    }).join('\n');
  }

  async capture(a: Obj): Promise<ToolResult> {
    const ui = this.host.ui;
    if (!ui) return { ok: false, content: 'Error: there is no view to capture here.' };
    await this.host.settle();
    const orientation = VIEWS.includes(a.orientation as ViewName) ? (a.orientation as ViewName) : undefined;
    const style = STYLES.includes(a.style as DisplayStyle) ? (a.style as DisplayStyle) : undefined;
    const image = ui.capture({ orientation, style });
    if (!image) return { ok: false, content: 'Error: the view could not be captured.' };
    return { ok: true, content: `Screenshot of the ${orientation ?? 'current'} view${style ? ` (${style})` : ''} attached below. Axes: X red, Y green (up), Z blue.`, image };
  }

  // ---------- sketches ----------

  private applySketchOps(ed: SketchEdit, a: Obj) {
    if (typeof a.auto_relations === 'boolean') ed.autoRelations = a.auto_relations;
    if (a.delete != null) ed.delete(a.delete);
    list(a.shapes).forEach((s, i) => ed.addShape(s, i));
    if (a.project_edges != null) ed.project(list(a.project_edges).map((e, i) => this.refs.edgeInfo(e, `project_edges[${i}]`)));
    list(a.move_points).forEach((v, i) => ed.movePoint(v, i));
    list(a.set_radius).forEach((v, i) => ed.setRadius(v, i));
    if (a.construction != null) ed.setConstruction(a.construction, true);
    if (a.normal != null) ed.setConstruction(a.normal, false);
    list(a.fillets).forEach((v, i) => ed.fillet(v, i));
    list(a.offsets).forEach((v, i) => ed.offset(v, i));
    list(a.mirrors).forEach((v, i) => ed.mirror(v, i));
    list(a.relations).forEach((v, i) => ed.addRelation(v, i));
    list(a.dimensions).forEach((v, i) => ed.addDimension(v, i));
    list(a.set_dimensions).forEach((v, i) => ed.setDimension(v, i));
  }

  /** Solves an edited sketch; refuses edits that conflict or newly over-define it. */
  private checkSolve(ed: SketchEdit, previouslyBad: Set<Id>) {
    const solve = ed.solve();
    const newBad = [...solve.badConstraints].filter((id) => !previouslyBad.has(id));
    if (!solve.converged || newBad.length) {
      const bad = ed.sk.constraints.filter((c) => newBad.includes(c.id) || (!solve.converged && solve.conflicting.has(c.id)));
      throw new ToolError(`the sketch cannot be solved: ${solve.converged ? 'it would be over-defined' : 'the constraints conflict'}. ${bad.length ? `Problem constraints: ${bad.map((c) => constraintLine(ed.sk, c, this.u, this.store)).join('; ')}. ` : ''}Nothing was changed. Remove redundant relations/dimensions (e.g. a rectangle already has horizontal/vertical relations; equal sides need one dimension) or fix the values.`);
    }
    return solve;
  }

  private sketchResult(ed: SketchEdit, solve: ReturnType<SketchEdit['solve']>, build: string, head: string): string {
    const sk = this.store.feature<SketchFeature>(ed.sk.id) ?? ed.sk;
    const ix = new SketchIndex(sk.entities);
    const created = new Set(ed.created);
    const ents = sk.entities.filter((e) => created.has(e.id));
    const cons = sk.constraints.filter((c) => created.has(c.id));
    const lines = [head, this.ins.sketchFrameText(sk)];
    if (ents.length) lines.push(`New entities:\n${ents.slice(0, 120).map((e) => `- ${entityLine(sk, e, this.u, ix)}`).join('\n')}${ents.length > 120 ? `\n- … ${ents.length - 120} more (get_sketch)` : ''}`);
    if (cons.length) lines.push(`New dimensions and relations:\n${cons.slice(0, 80).map((c) => `- ${constraintLine(sk, c, this.u, this.store)}`).join('\n')}`);
    if (ed.notes.length) lines.push(`Notes:\n${ed.notes.map((n) => `- ${n}`).join('\n')}`);
    lines.push(sketchReport(sk, solve, this.u, this.store), build);
    return lines.join('\n');
  }

  async createSketch(a: Obj): Promise<string> {
    this.host.prepareForEdit();
    await this.host.settle();
    const plane = this.refs.plane(a.plane);
    const frame = this.refs.planeFrame(plane);
    if (!frame) throw new ToolError('plane: that plane is not available in the current model (is it rolled back or failing?)');
    const id = this.store.nextId('s');
    const name = a.name ? str(a.name) : defaultName(this.doc, 'sketch');
    const sk = newSketch(id, name, plane);
    sk.frame = frame;
    const ed = new SketchEdit(sk, frame, this.u, this.store);
    this.applySketchOps(ed, a);
    const solve = this.checkSolve(ed, new Set());
    const built = ed.sk;
    const at = this.store.builtCount;
    const build = await this.apply(`New sketch ${name}`, (doc) => {
      doc.features.splice(at, 0, built);
      if (doc.rollback != null) doc.rollback = at + 1;
    }, { subject: id });
    return this.sketchResult(ed, solve, build, `Created sketch ${id} "${name}".`);
  }

  async editSketch(a: Obj): Promise<string> {
    this.host.prepareForEdit();
    await this.host.settle();
    const sk = this.refs.sketch(a.sketch);
    const frame = this.refs.sketchFrame(sk);
    if (!frame) throw new ToolError('the sketch plane is not resolved (the sketch may be rolled back or failing)');
    let prevBad = new Set<Id>();
    try {
      const copy = structuredClone(sk);
      const vars = this.store.resolve().variables;
      prevBad = solveSketch(copy.entities, copy.constraints, { value: (d) => this.store.dimensionValue(d, vars) }).badConstraints;
    } catch { /* treat as clean */ }
    const ed = new SketchEdit(sk, frame, this.u, this.store);
    if (a.name != null) ed.sk.name = str(a.name) || sk.name;
    this.applySketchOps(ed, a);
    const solve = this.checkSolve(ed, prevBad);
    const next = ed.sk;
    const build = await this.apply(`Edit ${sk.name}`, (doc) => {
      const i = doc.features.findIndex((f) => f.id === sk.id);
      if (i >= 0) doc.features[i] = next;
    }, { subject: sk.id });
    return this.sketchResult(ed, solve, build, `Updated sketch ${sk.id} "${next.name}".`);
  }

  // ---------- features ----------

  async addFeature(type: FeatureType, a: Obj): Promise<string> {
    this.host.prepareForEdit();
    await this.host.settle();
    const args = { ...a };
    const pre: SketchFeature[] = [];
    const notes: string[] = [];
    if (type === 'hole' && args.sketch == null) {
      if (args.on == null || args.points == null) throw new ToolError('give "sketch" (with stand-alone points) or "on" and "points"');
      const plane = this.refs.plane(args.on, 'on');
      const frame = this.refs.planeFrame(plane);
      if (!frame) throw new ToolError('on: that plane is not available in the current model');
      const sid = this.store.nextId('s');
      const sk = newSketch(sid, defaultName(this.doc, 'sketch'), plane);
      sk.frame = frame;
      const ed = new SketchEdit(sk, frame, this.u, this.store);
      ed.autoRelations = false;
      list(args.points).forEach((p, i) => ed.addShape({ type: 'point', at: p }, i));
      if (!ed.sk.entities.length) throw new ToolError('points: give at least one hole centre');
      pre.push(ed.sk);
      notes.push(...ed.notes.map((n) => n.replace(/^shapes\[(\d+)\] \(point\)\.at/, 'points[$1]')));
      args.sketch = sid;
    }
    delete args.on;
    delete args.points;
    const id = this.store.nextId('f');
    const cut = args.cut === true;
    const name = args.name ? str(args.name) : defaultName(this.doc, type, cut);
    delete args.name;
    // A position sketch made here is not in the document yet: resolve the hole against it.
    const feature = pre.length ? this.withTemp(pre, () => this.ins.codec.build(type, args, null, id, name)) : this.ins.codec.build(type, args, null, id, name);
    const at = this.store.builtCount;
    const build = await this.apply(`Add ${name}`, (doc) => {
      doc.features.splice(at, 0, ...pre, feature);
      if (doc.rollback != null) doc.rollback = at + pre.length + 1;
    }, { subject: id });
    const lines = [`Added ${id} "${name}" (${type})${pre.length ? ` with position sketch ${pre[0].id} (${pre[0].entities.length} point(s))` : ''}.`, build];
    if (notes.length) lines.splice(1, 0, `Notes:\n${notes.map((n) => `- ${n}`).join('\n')}`);
    const faces = this.ins.facesOf(id);
    if (faces) lines.push(faces);
    return lines.join('\n');
  }

  /** Runs fn with features temporarily appended to the document (for resolving references to them). */
  private withTemp<T>(features: Feature[], fn: () => T): T {
    const doc = this.doc;
    const n = doc.features.length;
    doc.features.push(...features);
    try {
      return fn();
    } finally {
      doc.features.length = n;
    }
  }

  async editFeature(a: Obj): Promise<string> {
    this.host.prepareForEdit();
    await this.host.settle();
    const f = this.refs.feature(a.feature);
    let next: Feature = structuredClone(f);
    const params = a.params && typeof a.params === 'object' && !Array.isArray(a.params) ? (a.params as Obj) : null;
    if (a.params != null && !params) throw new ToolError('params: an object of the arguments to change, such as {"depth": 20}');
    if (params && Object.keys(params).length) {
      if (f.type === 'sketch') throw new ToolError('sketch contents change with edit_sketch');
      if (f.type === 'import') throw new ToolError('imported bodies have no parameters to change');
      const add = TOOLS.find((t) => t.name === ADD_TOOLS[f.type]);
      const unknown = add && unknownArgs(add, params, 'params.', ['name']);
      if (unknown) throw new ToolError(`${unknown.replace(add.name, `${f.id} (${f.type})`)} (A new name goes in "name", next to params.)`);
      next = this.ins.codec.build(f.type, params, f, f.id, f.name);
    }
    if (a.name != null && str(a.name)) next.name = str(a.name);
    if (typeof a.suppressed === 'boolean') next.suppressed = a.suppressed || undefined;
    if (typeof a.hidden === 'boolean') next.hidden = a.hidden;
    const build = await this.apply(`Edit ${f.name}`, (doc) => {
      const i = doc.features.findIndex((x) => x.id === f.id);
      if (i >= 0) doc.features[i] = next;
    }, { subject: f.id });
    const lines = [`Updated ${f.id} "${next.name}" → ${this.ins.status(next, this.store.indexOf(f.id))}.`];
    if (next.type !== 'sketch') lines.push(`Arguments now: ${JSON.stringify(this.ins.codec.args(next))}`);
    lines.push(build);
    return lines.join('\n');
  }

  async deleteFeatures(a: Obj): Promise<string> {
    const doc = this.doc;
    const del = new Set(this.refs.features_(a.features, 'features').map((f) => f.id));
    if (!del.size) throw new ToolError('features: give at least one');
    const absorb = () => {
      for (const id of [...del]) {
        const f = this.store.feature(id);
        if (f) for (const s of consumedSketches(f)) if (!doc.features.some((x) => !del.has(x.id) && consumedSketches(x).includes(s))) del.add(s);
      }
    };
    absorb();
    for (let changed = true; changed;) {
      changed = false;
      const dependents = doc.features.filter((f) => !del.has(f.id) && dependencies(f).some((d) => del.has(d)));
      if (!dependents.length) break;
      if (a.with_dependents !== true) throw new ToolError(`these features depend on what would be deleted: ${dependents.map((f) => `${f.id} "${f.name}"`).join(', ')}. Include them or set with_dependents.`);
      for (const f of dependents) del.add(f.id);
      absorb();
      changed = true;
    }
    const names = doc.features.filter((f) => del.has(f.id)).map((f) => `${f.id} "${f.name}"`);
    const build = await this.apply('Delete', (d) => {
      const built = this.store.builtCount;
      const removedBuilt = d.features.slice(0, built).filter((f) => del.has(f.id)).length;
      d.features = d.features.filter((f) => !del.has(f.id));
      if (d.rollback != null) d.rollback = Math.max(0, d.rollback - removedBuilt);
    });
    return `Deleted ${names.join(', ')}.\n${build}`;
  }

  async setRollback(a: Obj): Promise<string> {
    const index = a.before == null || a.before === '' ? null : this.store.indexOf(this.refs.feature(a.before, 'before').id);
    const build = await this.apply('Rollback', (doc) => { doc.rollback = index == null || index >= doc.features.length ? null : index; }, { keepErrors: true });
    return `${index == null ? 'Rolled to the end' : `Rollback bar before ${this.doc.features[index].id}`}.\n${build}`;
  }

  async setVariables(a: Obj): Promise<string> {
    const vars = structuredClone(this.doc.variables);
    for (const n of list(a.delete).map(str)) {
      const i = vars.findIndex((v) => v.name === n);
      if (i < 0) throw new ToolError(`delete: no variable "${n}"`);
      vars.splice(i, 1);
    }
    list(a.set).forEach((s, i) => {
      const o = (s ?? {}) as Obj;
      const name = str(o.name);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ToolError(`set[${i}].name: letters, digits and _ (not starting with a digit)`);
      if (reservedName(name)) throw new ToolError(`set[${i}].name: ${name} is reserved`);
      const expr = typeof o.value === 'number' ? String(o.value) : str(o.value).replace(/^=\s*/, '');
      if (!expr) throw new ToolError(`set[${i}].value: give a number or an expression`);
      const cur = vars.find((v) => v.name === name);
      if (cur) cur.expr = expr;
      else vars.push({ id: `v${Date.now().toString(36)}${i}`, name, expr });
    });
    const { values, errors } = evaluateVariables(vars);
    if (errors.size) throw new ToolError(`variables would have errors: ${[...errors].map(([n, m]) => `${n}: ${m}`).join('; ')}. Nothing was changed.`);
    const build = await this.apply('Edit equations', (doc) => { doc.variables = vars; });
    return `Variables: ${vars.map((v) => `${v.name} = ${v.expr}${String(values.get(v.name)) !== v.expr ? ` (= ${num(values.get(v.name)!)})` : ''}`).join(', ') || 'none'}.\n${build}`;
  }

  async setPart(a: Obj): Promise<string> {
    const patch: Partial<PartDocument> = {};
    if (a.name != null) { const n = str(a.name); if (!n) throw new ToolError('name: cannot be empty'); patch.name = n.slice(0, 120); }
    if (a.units != null) {
      const un = str(a.units).toUpperCase() as UnitSystem;
      if (!(un in UNIT_SYSTEMS)) throw new ToolError('units: MMGS, CGS, MKS or IPS');
      patch.units = un;
    }
    if (a.decimals != null) {
      const d = Math.round(Number(a.decimals));
      if (!(d >= 0 && d <= 8)) throw new ToolError('decimals: 0 to 8');
      patch.decimals = d;
    }
    if (a.material !== undefined) {
      if (a.material === null || a.material === '') patch.material = null;
      else if (typeof a.material === 'string') {
        const m = MATERIALS.find((x) => x.name.toLowerCase() === str(a.material).toLowerCase()) ?? MATERIALS.find((x) => x.name.toLowerCase().includes(str(a.material).toLowerCase()));
        if (!m) throw new ToolError(`material: no preset "${a.material}". Presets: ${MATERIALS.map((x) => x.name).join(', ')}; or give {name, density}`);
        patch.material = { ...m };
      } else {
        const o = a.material as Obj;
        const density = Number(o.density);
        if (!(density > 0)) throw new ToolError('material.density: kg/m³, greater than zero');
        patch.material = { name: str(o.name) || 'Custom material', density };
      }
    }
    if (a.color != null) {
      const c = str(a.color);
      if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new ToolError('color: #rrggbb');
      patch.color = c.toLowerCase();
    }
    if (!Object.keys(patch).length) return 'Nothing to change.';
    // Like every change: an open sketch is finished first, so discarding it later cannot undo this too.
    this.host.prepareForEdit();
    const { units, ...rest } = patch;
    let unlinked: string[] = [];
    this.store.change('Part properties', (doc) => {
      Object.assign(doc, rest);
      // Expressions are in display units: convert them so the geometry keeps its size.
      if (units) unlinked = changeUnits(doc, units);
    });
    this.changed = true;
    return `${this.ins.partHeader()}${units ? ' From now on, lengths in tool arguments and results use the new unit.' : ''}${unlinked.length ? ` These equations could not be converted and were replaced by their values: ${unlinked.join(', ')}.` : ''}`;
  }

  // ---------- view ----------

  async setView(a: Obj): Promise<string> {
    const ui = this.host.ui;
    if (!ui) throw new ToolError('there is no view here');
    await this.host.settle();
    const done: string[] = [];
    const orientation = a.orientation != null ? (VIEWS.includes(a.orientation as ViewName) ? (a.orientation as ViewName) : null) : undefined;
    if (orientation === null) throw new ToolError(`orientation: one of ${VIEWS.join(', ')}`);
    let normalTo;
    if (a.normal_to != null) {
      normalTo = this.refs.planeFrame(this.refs.plane(a.normal_to, 'normal_to')) ?? undefined;
      if (!normalTo) throw new ToolError('normal_to: that plane is not available');
    }
    const style = a.style != null ? (STYLES.includes(a.style as DisplayStyle) ? (a.style as DisplayStyle) : null) : undefined;
    if (style === null) throw new ToolError(`style: one of ${STYLES.join(', ')}`);
    ui.setView({ orientation, normalTo, fit: a.fit === true, style });
    if (orientation) done.push(`${orientation} view`);
    if (normalTo) done.push('normal to the plane');
    if (a.fit === true) done.push('zoomed to fit');
    if (style) done.push(`${style} display`);
    if (a.highlight != null) {
      const items: SelItem[] = list(a.highlight).map((v, i) => {
        const s = str(v);
        const fi = this.host.faces.findIndex((f) => f.name === s);
        if (fi >= 0) return { kind: 'face', index: fi, name: s };
        const ei = this.host.edges.findIndex((e) => e.name === s);
        if (ei >= 0) return { kind: 'edge', index: ei, name: s };
        const f = this.refs.feature(s, `highlight[${i}]`);
        return { kind: 'feature', id: f.id };
      });
      ui.select(items);
      done.push(`highlighted ${items.length} item(s)`);
    }
    return done.length ? `View: ${done.join(', ')}.` : 'Nothing to change.';
  }

  async drawing(a: Obj): Promise<string> {
    const ui = this.host.ui;
    if (!ui) throw new ToolError('drawings need the app\'s interface');
    await this.host.settle();
    const done: string[] = [];
    if (a.show === true || ((a.arrange || a.add_views) && !this.doc.drawing)) {
      if (!this.host.bbox && !this.doc.drawing) throw new ToolError('there is no solid to draw yet');
      ui.showDrawing(true);
      done.push('showing the drawing');
    }
    if (a.arrange === true) { ui.arrangeDrawing(); done.push('standard views arranged'); }
    for (const v of list(a.add_views).map(str)) {
      if (!['front', 'back', 'left', 'right', 'top', 'bottom', 'isometric'].includes(v)) throw new ToolError(`add_views: unknown view ${v}`);
      ui.addDrawingView(v as DrawingViewKind);
      done.push(`added ${v} view`);
    }
    const patch: Obj = {};
    if (a.sheet != null) { if (!['A4', 'A3', 'A2', 'A1', 'Letter', 'Tabloid'].includes(str(a.sheet))) throw new ToolError('sheet: A4, A3, A2, A1, Letter or Tabloid'); patch.sheet = str(a.sheet); }
    if (typeof a.landscape === 'boolean') patch.landscape = a.landscape;
    if (a.scale != null) { const s = Number(a.scale); if (!(s > 0 && s <= 100)) throw new ToolError('scale: a positive ratio such as 0.5 for 1:2'); patch.scale = s; }
    if (a.title != null) patch.title = str(a.title);
    if (a.drawn_by != null) patch.drawnBy = str(a.drawn_by);
    if (a.notes != null) patch.notes = typeof a.notes === 'string' ? a.notes : str(a.notes);
    if (Object.keys(patch).length) {
      if (!this.doc.drawing) throw new ToolError('there is no drawing yet; set show: true first');
      this.host.prepareForEdit();
      this.store.change('Edit drawing', (doc) => { if (doc.drawing) Object.assign(doc.drawing, patch); });
      this.changed = true;
      done.push(`set ${Object.keys(patch).join(', ')}`);
    }
    if (a.show === false) { ui.showDrawing(false); done.push('back to the model'); }
    const d = this.doc.drawing;
    if (d) done.push(`sheet ${d.sheet} ${d.landscape ? 'landscape' : 'portrait'}, scale ${num(d.scale, 4)}, views: ${d.views.map((v) => v.kind).join(', ') || 'none'}`);
    this.changed = true;
    return `Drawing: ${done.join('; ') || 'no change'}.`;
  }

  runCommand(a: Obj): string {
    const ui = this.host.ui;
    if (!ui) throw new ToolError('commands need the app\'s interface');
    const map: Record<string, string> = { save: 'save', export_step: 'exportStep', export_stl: 'exportStl', download_part: 'downloadPart', export_drawing_pdf: 'drawing:pdf', export_drawing_svg: 'drawing:svg' };
    const id = map[str(a.command)];
    if (!id) throw new ToolError(`command: one of ${Object.keys(map).join(', ')}`);
    if (!ui.runCommand(id)) throw new ToolError(`${a.command} is not available right now${id.startsWith('drawing:') ? ' (show the drawing first)' : id.startsWith('export') ? ' (there is no solid)' : ''}`);
    return `Started ${a.command}. Any dialog it opens is for the user.`;
  }
}
