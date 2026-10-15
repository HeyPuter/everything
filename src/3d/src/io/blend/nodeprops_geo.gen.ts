// GENERATED (see tests/fixtures/blend/make_gn_enums.py): for every geometry and function node type,
// one node per enum item / boolean state / menu socket item was written to a .blend file by a bpy
// script, read back with this package's reader, and the DNA field that changed was recorded.
// Same rule format as nodeprops.gen.ts; 'socket.<identifier>' reads a menu socket's stored value.
import type { NodePropRule } from './nodeprops.gen';

export const GEO_NODE_PROP_RULES: Record<string, Record<string, NodePropRule>> = {
  FunctionNodeAlignEulerToVector: {
    axis: { f: "custom1", e: { 0: "X", 1: "Y", 2: "Z" } },
    pivot_axis: { f: "custom2", e: { 0: "AUTO", 1: "X", 2: "Y", 3: "Z" } },
  },
  FunctionNodeAlignRotationToVector: {
    axis: { f: "custom1", e: { 0: "X", 1: "Y", 2: "Z" } },
    pivot_axis: { f: "custom2", e: { 0: "AUTO", 1: "X", 2: "Y", 3: "Z" } },
  },
  FunctionNodeAxesToRotation: {
    primary_axis: { f: "custom1", e: { 0: "X", 1: "Y", 2: "Z" } },
    secondary_axis: { f: "custom2", e: { 0: "X", 1: "Y", 2: "Z" } },
  },
  FunctionNodeBitMath: {
    operation: { f: "custom1", e: { 0: "AND", 1: "OR", 2: "XOR", 3: "NOT", 4: "SHIFT", 5: "ROTATE" } },
  },
  FunctionNodeBooleanMath: {
    operation: { f: "custom1", e: { 0: "AND", 1: "OR", 2: "NOT", 3: "NAND", 4: "NOR", 5: "XNOR", 6: "XOR", 7: "IMPLY", 8: "NIMPLY" } },
  },
  FunctionNodeCombineColor: {
    mode: { f: "storage.mode", e: { 0: "RGB", 1: "HSV", 2: "HSL" } },
  },
  FunctionNodeCompare: {
    data_type: { f: "storage.data_type", e: { 0: "FLOAT", 1: "VECTOR", 2: "RGBA", 6: "INT", 7: "STRING", 8: "OBJECT", 9: "IMAGE", 11: "COLLECTION", 13: "MATERIAL", 19: "FONT", 23: "SOUND" } },
    mode: { f: "storage.mode", e: { 0: "ELEMENT", 1: "LENGTH", 2: "AVERAGE", 3: "DOT_PRODUCT", 4: "DIRECTION" } },
    operation: { f: "storage.operation", e: { 0: "LESS_THAN", 1: "LESS_EQUAL", 2: "GREATER_THAN", 3: "GREATER_EQUAL", 4: "EQUAL", 5: "NOT_EQUAL" } },
  },
  FunctionNodeFindInString: {
    Mode: { f: "socket.Mode", e: { 0: "From Start", 1: "From End" } },
  },
  FunctionNodeFloatToInt: {
    rounding_mode: { f: "custom1", e: { 0: "ROUND", 1: "FLOOR", 2: "CEILING", 3: "TRUNCATE" } },
  },
  FunctionNodeHashValue: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 2: "RGBA", 6: "INT", 7: "STRING", 14: "ROTATION", 16: "MATRIX" } },
  },
  FunctionNodeInputBool: {
    boolean: { f: "storage.boolean", b: 1 },
  },
  FunctionNodeIntegerMath: {
    operation: { f: "custom1", e: { 0: "ADD", 1: "SUBTRACT", 2: "MULTIPLY", 3: "DIVIDE", 4: "MULTIPLY_ADD", 5: "POWER", 6: "FLOORED_MODULO", 7: "ABSOLUTE", 8: "MINIMUM", 9: "MAXIMUM", 10: "GCD", 11: "LCM", 12: "NEGATE", 13: "SIGN", 14: "DIVIDE_FLOOR", 15: "DIVIDE_CEIL", 16: "DIVIDE_ROUND", 17: "MODULO" } },
  },
  FunctionNodeMatchString: {
    Operation: { f: "socket.Operation", e: { 0: "Starts With", 1: "Ends With", 2: "Contains" } },
  },
  FunctionNodeRandomValue: {
    data_type: { f: "storage.data_type", e: { 10: "FLOAT", 11: "INT", 48: "FLOAT_VECTOR", 50: "BOOLEAN" } },
  },
  FunctionNodeRotateEuler: {
    rotation_type: { f: "custom1", e: { 0: "EULER", 1: "AXIS_ANGLE" } },
    space: { f: "custom2", e: { 0: "OBJECT", 1: "LOCAL" } },
  },
  FunctionNodeRotateRotation: {
    rotation_space: { f: "custom1", e: { 0: "GLOBAL", 1: "LOCAL" } },
  },
  FunctionNodeSeparateColor: {
    mode: { f: "storage.mode", e: { 0: "RGB", 1: "HSV", 2: "HSL" } },
  },
  FunctionNodeSetStringCase: {
    Case: { f: "socket.Case", e: { 0: "Uppercase", 1: "Lowercase" } },
  },
  FunctionNodeStringToValue: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 6: "INT" } },
  },
  FunctionNodeValueToString: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 6: "INT" } },
  },
  GeometryNodeAccumulateField: {
    data_type: { f: "storage.data_type", e: { 10: "FLOAT", 11: "INT", 20: "TRANSFORM", 48: "FLOAT_VECTOR" } },
    domain: { f: "storage.domain", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeAttributeDomainSize: {
    component: { f: "custom1", e: { 0: "MESH", 1: "POINTCLOUD", 2: "INSTANCES", 4: "CURVE", 6: "GREASEPENCIL" } },
  },
  GeometryNodeAttributeStatistic: {
    data_type: { f: "custom1", e: { 10: "FLOAT", 48: "FLOAT_VECTOR" } },
    domain: { f: "custom2", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeBlurAttribute: {
    data_type: { f: "custom1", e: { 10: "FLOAT", 11: "INT", 47: "FLOAT_COLOR", 48: "FLOAT_VECTOR" } },
  },
  GeometryNodeBoneInfo: {
    transform_space: { f: "custom1", e: { 0: "ORIGINAL", 1: "RELATIVE" } },
  },
  GeometryNodeCaptureAttribute: {
    domain: { f: "storage.domain", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeCollectionInfo: {
    transform_space: { f: "storage.transform_space", e: { 0: "ORIGINAL", 1: "RELATIVE" } },
  },
  GeometryNodeCurveArc: {
    mode: { f: "storage.mode", e: { 0: "POINTS", 1: "RADIUS" } },
  },
  GeometryNodeCurveHandleTypeSelection: {
    handle_type: { f: "storage.handle_type", e: { 0: "FREE", 1: "AUTO", 2: "VECTOR", 3: "ALIGN" } },
  },
  GeometryNodeCurvePrimitiveBezierSegment: {
    mode: { f: "storage.mode", e: { 0: "POSITION", 1: "OFFSET" } },
  },
  GeometryNodeCurvePrimitiveCircle: {
    mode: { f: "storage.mode", e: { 0: "POINTS", 1: "RADIUS" } },
  },
  GeometryNodeCurvePrimitiveLine: {
    mode: { f: "storage.mode", e: { 0: "POINTS", 1: "DIRECTION" } },
  },
  GeometryNodeCurvePrimitiveQuadrilateral: {
    mode: { f: "storage.mode", e: { 0: "RECTANGLE", 1: "PARALLELOGRAM", 2: "TRAPEZOID", 3: "KITE", 4: "POINTS" } },
  },
  GeometryNodeCurveSetHandles: {
    handle_type: { f: "storage.handle_type", e: { 0: "FREE", 1: "AUTO", 2: "VECTOR", 3: "ALIGN" } },
  },
  GeometryNodeCurveSplineType: {
    spline_type: { f: "storage.spline_type", e: { 0: "CATMULL_ROM", 1: "POLY", 2: "BEZIER", 3: "NURBS" } },
  },
  GeometryNodeCurveToPoints: {
    mode: { f: "storage.mode", e: { 0: "COUNT", 1: "LENGTH", 2: "EVALUATED" } },
  },
  GeometryNodeDeleteGeometry: {
    domain: { f: "storage.domain", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
    mode: { f: "storage.mode", e: { 0: "ALL", 1: "EDGE_FACE", 2: "ONLY_FACE" } },
  },
  GeometryNodeDistributePointsInGrid: {
    mode: { f: "custom1", e: { 0: "DENSITY_RANDOM", 1: "DENSITY_GRID" } },
  },
  GeometryNodeDistributePointsInVolume: {
    Mode: { f: "socket.Mode", e: { 0: "Random", 1: "Grid" } },
  },
  GeometryNodeDistributePointsOnFaces: {
    distribute_method: { f: "custom1", e: { 0: "RANDOM", 1: "POISSON" } },
    use_legacy_normal: { f: "custom2", b: 1 },
  },
  GeometryNodeDuplicateElements: {
    domain: { f: "storage.domain", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 4: "SPLINE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeExtrudeMesh: {
    mode: { f: "storage.mode", e: { 0: "VERTICES", 1: "EDGES", 2: "FACES" } },
  },
  GeometryNodeFieldAtIndex: {
    data_type: { f: "custom2", e: { 10: "FLOAT", 11: "INT", 20: "FLOAT4X4", 47: "FLOAT_COLOR", 48: "FLOAT_VECTOR", 50: "BOOLEAN", 52: "QUATERNION" } },
    domain: { f: "custom1", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeFieldAverage: {
    data_type: { f: "custom1", e: { 10: "FLOAT", 48: "FLOAT_VECTOR" } },
    domain: { f: "custom2", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeFieldMinAndMax: {
    data_type: { f: "custom1", e: { 10: "FLOAT", 11: "INT", 48: "FLOAT_VECTOR" } },
    domain: { f: "custom2", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeFieldOnDomain: {
    data_type: { f: "custom2", e: { 10: "FLOAT", 11: "INT", 20: "FLOAT4X4", 47: "FLOAT_COLOR", 48: "FLOAT_VECTOR", 50: "BOOLEAN", 52: "QUATERNION" } },
    domain: { f: "custom1", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeFieldToGrid: {
    data_type: { f: "storage.data_type", e: { 0: "FLOAT", 1: "VECTOR", 4: "BOOLEAN", 6: "INT" } },
  },
  GeometryNodeFieldVariance: {
    data_type: { f: "custom1", e: { 10: "FLOAT", 48: "FLOAT_VECTOR" } },
    domain: { f: "custom2", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeFillCurve: {
    "Fill Rule": { f: "socket.Fill Rule", e: { 0: "Even-Odd", 1: "Non-Zero" } },
    Mode: { f: "socket.Mode", e: { 0: "Triangles", 1: "N-gons" } },
  },
  GeometryNodeFilletCurve: {
    Mode: { f: "socket.Mode", e: { 0: "B\u00e9zier", 1: "Poly" } },
  },
  GeometryNodeFilterList: {
    socket_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 2: "RGBA", 4: "BOOLEAN", 6: "INT", 7: "STRING", 8: "OBJECT", 9: "IMAGE", 10: "GEOMETRY", 11: "COLLECTION", 13: "MATERIAL", 14: "ROTATION", 15: "MENU", 16: "MATRIX", 17: "BUNDLE", 18: "CLOSURE", 19: "FONT", 23: "SOUND" } },
  },
  GeometryNodeForeachGeometryElementOutput: {
    domain: { f: "storage.domain", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeGetAttributeNames: {
    "Data Type": { f: "socket.Data Type", e: { 0: "Boolean", 1: "8-Bit Integer", 2: "2D 16-Bit Integer Vector", 3: "Integer", 4: "2D Integer Vector", 5: "Float", 6: "2D Vector", 7: "Vector", 8: "4x4 Matrix", 9: "Byte Color", 10: "Color", 11: "Quaternion", 12: "String", 13: "4D Vector" } },
    Domain: { f: "socket.Domain", e: { 0: "Point", 1: "Edge", 2: "Face", 3: "Face Corner", 4: "Spline", 5: "Instance", 6: "Layer" } },
  },
  GeometryNodeGetGeometryComponent: {
    Type: { f: "socket.Type", e: { 0: "Mesh", 1: "Point Cloud", 2: "Instances", 3: "Volume", 4: "Curve", 6: "Grease Pencil" } },
  },
  GeometryNodeGetNamedGrid: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 4: "BOOLEAN", 6: "INT" } },
  },
  GeometryNodeGizmoDial: {
    color_id: { f: "storage.color_id", e: { 0: "PRIMARY", 1: "SECONDARY", 2: "X", 3: "Y", 4: "Z" } },
  },
  GeometryNodeGizmoLinear: {
    color_id: { f: "storage.color_id", e: { 0: "PRIMARY", 1: "SECONDARY", 2: "X", 3: "Y", 4: "Z" } },
    draw_style: { f: "storage.draw_style", e: { 0: "ARROW", 1: "CROSS", 2: "BOX" } },
  },
  GeometryNodeGizmoTransform: {
    use_rotation_x: { f: "storage.flag", b: 8 },
    use_rotation_y: { f: "storage.flag", b: 16 },
    use_rotation_z: { f: "storage.flag", b: 32 },
    use_scale_x: { f: "storage.flag", b: 64 },
    use_scale_y: { f: "storage.flag", b: 128 },
    use_scale_z: { f: "storage.flag", b: 256 },
    use_translation_x: { f: "storage.flag", b: 1 },
    use_translation_y: { f: "storage.flag", b: 2 },
    use_translation_z: { f: "storage.flag", b: 4 },
  },
  GeometryNodeGridAdvect: {
    "Integration Scheme": { f: "socket.Integration Scheme", e: { 0: "Semi-Lagrangian", 1: "Midpoint", 2: "Runge-Kutta 3", 3: "Runge-Kutta 4", 4: "MacCormack", 5: "BFECC" } },
    Limiter: { f: "socket.Limiter", e: { 0: "None", 1: "Clamp", 2: "Revert" } },
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 6: "INT" } },
  },
  GeometryNodeGridClip: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 4: "BOOLEAN", 6: "INT" } },
  },
  GeometryNodeGridDilateAndErode: {
    Connectivity: { f: "socket.Connectivity", e: { 0: "Face", 1: "Edge", 2: "Vertex" } },
    Tiles: { f: "socket.Tiles", e: { 0: "Ignore", 1: "Expand", 2: "Preserve" } },
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 4: "BOOLEAN", 6: "INT" } },
  },
  GeometryNodeGridInfo: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 4: "BOOLEAN", 6: "INT" } },
  },
  GeometryNodeGridMean: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 6: "INT" } },
  },
  GeometryNodeGridMedian: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 6: "INT" } },
  },
  GeometryNodeGridPrune: {
    Mode: { f: "socket.Mode", e: { 0: "Inactive", 1: "Threshold", 2: "SDF" } },
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 4: "BOOLEAN", 6: "INT" } },
  },
  GeometryNodeGridToPoints: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 4: "BOOLEAN", 6: "INT" } },
  },
  GeometryNodeGridVoxelize: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 4: "BOOLEAN", 6: "INT" } },
  },
  GeometryNodeImageTexture: {
    extension: { f: "storage.extension", e: { 0: "REPEAT", 1: "EXTEND", 2: "CLIP", 3: "MIRROR" } },
    interpolation: { f: "storage.interpolation", e: { 0: "Linear", 1: "Closest", 2: "Cubic" } },
  },
  GeometryNodeIndexSwitch: {
    data_type: { f: "storage.data_type", e: { 0: "FLOAT", 1: "VECTOR", 2: "RGBA", 4: "BOOLEAN", 6: "INT", 7: "STRING", 8: "OBJECT", 9: "IMAGE", 10: "GEOMETRY", 11: "COLLECTION", 13: "MATERIAL", 14: "ROTATION", 15: "MENU", 16: "MATRIX", 17: "BUNDLE", 18: "CLOSURE", 19: "FONT", 23: "SOUND" } },
  },
  GeometryNodeInputNamedAttribute: {
    data_type: { f: "storage.data_type", e: { 10: "FLOAT", 11: "INT", 20: "FLOAT4X4", 47: "FLOAT_COLOR", 48: "FLOAT_VECTOR", 50: "BOOLEAN", 52: "QUATERNION" } },
  },
  GeometryNodeInputNormal: {
    legacy_corner_normals: { f: "custom1", b: 1 },
  },
  GeometryNodeListGetItem: {
    socket_type: { f: "storage.socket_type", e: { 0: "FLOAT", 1: "VECTOR", 2: "RGBA", 4: "BOOLEAN", 6: "INT", 7: "STRING", 8: "OBJECT", 9: "IMAGE", 10: "GEOMETRY", 11: "COLLECTION", 13: "MATERIAL", 14: "ROTATION", 15: "MENU", 16: "MATRIX", 17: "BUNDLE", 18: "CLOSURE", 19: "FONT", 23: "SOUND" } },
    structure_type: { f: "storage.structure_type", e: { 0: "AUTO", 1: "SINGLE", 2: "DYNAMIC", 3: "FIELD", 4: "GRID", 5: "LIST" } },
  },
  GeometryNodeListLength: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 2: "RGBA", 4: "BOOLEAN", 6: "INT", 7: "STRING", 8: "OBJECT", 9: "IMAGE", 10: "GEOMETRY", 11: "COLLECTION", 13: "MATERIAL", 14: "ROTATION", 15: "MENU", 16: "MATRIX", 17: "BUNDLE", 18: "CLOSURE", 19: "FONT", 23: "SOUND" } },
  },
  GeometryNodeMenuSwitch: {
    Menu: { f: "socket.Menu", e: { 0: "A", 1: "B" } },
    data_type: { f: "storage.data_type", e: { 0: "FLOAT", 1: "VECTOR", 2: "RGBA", 4: "BOOLEAN", 6: "INT", 7: "STRING", 8: "OBJECT", 9: "IMAGE", 10: "GEOMETRY", 11: "COLLECTION", 13: "MATERIAL", 14: "ROTATION", 15: "MENU", 16: "MATRIX", 17: "BUNDLE", 18: "CLOSURE", 19: "FONT", 23: "SOUND" } },
  },
  GeometryNodeMergeByDistance: {
    Mode: { f: "socket.Mode", e: { 0: "All", 1: "Connected" } },
  },
  GeometryNodeMergeLayers: {
    mode: { f: "storage.mode", e: { 0: "MERGE_BY_NAME", 1: "MERGE_BY_ID" } },
  },
  GeometryNodeMeshBevel: {
    "Affect Kind": { f: "socket.Affect Kind", e: { 0: "Vertices", 1: "Edges" } },
  },
  GeometryNodeMeshBoolean: {
    operation: { f: "custom1", e: { 0: "INTERSECT", 1: "UNION", 2: "DIFFERENCE" } },
    solver: { f: "custom2", e: { 0: "EXACT", 1: "FLOAT", 2: "MANIFOLD" } },
  },
  GeometryNodeMeshCircle: {
    fill_type: { f: "storage.fill_type", e: { 0: "NONE", 1: "NGON", 2: "TRIANGLE_FAN" } },
  },
  GeometryNodeMeshCone: {
    fill_type: { f: "storage.fill_type", e: { 0: "NONE", 1: "NGON", 2: "TRIANGLE_FAN" } },
  },
  GeometryNodeMeshCylinder: {
    fill_type: { f: "storage.fill_type", e: { 0: "NONE", 1: "NGON", 2: "TRIANGLE_FAN" } },
  },
  GeometryNodeMeshLine: {
    count_mode: { f: "storage.count_mode", e: { 0: "TOTAL", 1: "RESOLUTION" } },
    mode: { f: "storage.mode", e: { 0: "END_POINTS", 1: "OFFSET" } },
  },
  GeometryNodeMeshToCurve: {
    mode: { f: "custom1", e: { 0: "EDGES", 1: "FACES" } },
  },
  GeometryNodeMeshToPoints: {
    mode: { f: "storage.mode", e: { 0: "VERTICES", 1: "EDGES", 2: "FACES", 3: "CORNERS" } },
  },
  GeometryNodeMeshToVolume: {
    "Resolution Mode": { f: "socket.Resolution Mode", e: { 0: "Amount", 1: "Size" } },
  },
  GeometryNodeObjectInfo: {
    transform_space: { f: "storage.transform_space", e: { 0: "ORIGINAL", 1: "RELATIVE" } },
  },
  GeometryNodePointsToVolume: {
    "Resolution Mode": { f: "socket.Resolution Mode", e: { 0: "Amount", 1: "Size" } },
  },
  GeometryNodeProximity: {
    target_element: { f: "storage.target_element", e: { 0: "POINTS", 1: "EDGES", 2: "FACES" } },
  },
  GeometryNodeRaycast: {
    Interpolation: { f: "socket.Interpolation", e: { 0: "Interpolated", 1: "Nearest" } },
    data_type: { f: "storage.data_type", e: { 10: "FLOAT", 11: "INT", 20: "FLOAT4X4", 47: "FLOAT_COLOR", 48: "FLOAT_VECTOR", 50: "BOOLEAN", 52: "QUATERNION" } },
  },
  GeometryNodeRealizeInstances: {
    realize_to_point_domain: { f: "custom1", b: 1 },
  },
  GeometryNodeRemoveAttribute: {
    "Pattern Mode": { f: "socket.Pattern Mode", e: { 0: "Exact", 1: "Wildcard" } },
  },
  GeometryNodeRenameAttribute: {
    Mode: { f: "socket.Mode", e: { 0: "Single", 1: "Prefix" } },
  },
  GeometryNodeResampleCurve: {
    Mode: { f: "socket.Mode", e: { 0: "Count", 1: "Length", 2: "Evaluated" } },
    keep_last_segment: { f: "storage.keep_last_segment", b: 1 },
  },
  GeometryNodeSDFGridBoolean: {
    operation: { f: "custom1", e: { 0: "INTERSECT", 1: "UNION", 2: "DIFFERENCE" } },
  },
  GeometryNodeSampleCurve: {
    data_type: { f: "storage.data_type", e: { 10: "FLOAT", 11: "INT", 20: "FLOAT4X4", 47: "FLOAT_COLOR", 48: "FLOAT_VECTOR", 50: "BOOLEAN", 52: "QUATERNION" } },
    mode: { f: "storage.mode", e: { 0: "FACTOR", 1: "LENGTH" } },
    use_all_curves: { f: "storage.use_all_curves", b: 1 },
  },
  GeometryNodeSampleGrid: {
    Interpolation: { f: "socket.Interpolation", e: { 0: "Nearest Neighbor", 1: "Trilinear", 2: "Triquadratic" } },
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 4: "BOOLEAN", 6: "INT" } },
  },
  GeometryNodeSampleGridIndex: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 4: "BOOLEAN", 6: "INT" } },
  },
  GeometryNodeSampleIndex: {
    clamp: { f: "storage.clamp", b: 1 },
    data_type: { f: "storage.data_type", e: { 10: "FLOAT", 11: "INT", 20: "FLOAT4X4", 47: "FLOAT_COLOR", 48: "FLOAT_VECTOR", 50: "BOOLEAN", 52: "QUATERNION" } },
    domain: { f: "storage.domain", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeSampleNearest: {
    domain: { f: "custom2", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER" } },
  },
  GeometryNodeSampleNearestSurface: {
    data_type: { f: "custom1", e: { 10: "FLOAT", 11: "INT", 20: "FLOAT4X4", 47: "FLOAT_COLOR", 48: "FLOAT_VECTOR", 50: "BOOLEAN", 52: "QUATERNION" } },
  },
  GeometryNodeSampleSoundFrequencies: {
    "FFT Size": { f: "socket.FFT Size", e: { 128: "128", 256: "256", 512: "512", 1024: "1024", 2048: "2048", 4096: "4096", 8192: "8192", 16384: "16384", 32768: "32768" } },
    "Window Function": { f: "socket.Window Function", e: { 0: "Hann", 1: "Hamming", 2: "Blackman", 3: "Rectangular" } },
  },
  GeometryNodeSampleUVSurface: {
    data_type: { f: "custom1", e: { 10: "FLOAT", 11: "INT", 20: "FLOAT4X4", 47: "FLOAT_COLOR", 48: "FLOAT_VECTOR", 50: "BOOLEAN", 52: "QUATERNION" } },
  },
  GeometryNodeScaleElements: {
    "Scale Mode": { f: "socket.Scale Mode", e: { 0: "Uniform", 1: "Single Axis" } },
    domain: { f: "custom1", e: { 1: "EDGE", 2: "FACE" } },
  },
  GeometryNodeSeparateGeometry: {
    domain: { f: "storage.domain", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeSetCurveHandlePositions: {
    mode: { f: "storage.mode", e: { 1: "LEFT", 2: "RIGHT" } },
  },
  GeometryNodeSetCurveNormal: {
    Mode: { f: "socket.Mode", e: { 0: "Minimum Twist", 1: "Z Up", 2: "Free" } },
  },
  GeometryNodeSetGreasePencilColor: {
    mode: { f: "custom1", e: { 0: "STROKE", 1: "FILL" } },
  },
  GeometryNodeSetGreasePencilDepth: {
    depth_order: { f: "custom1", e: { 0: "2D", 4: "3D" } },
  },
  GeometryNodeSetGridBackground: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 4: "BOOLEAN", 6: "INT" } },
  },
  GeometryNodeSetGridTransform: {
    data_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 4: "BOOLEAN", 6: "INT" } },
  },
  GeometryNodeSetMeshNormal: {
    domain: { f: "custom2", e: { 0: "POINT", 2: "FACE", 3: "CORNER" } },
    mode: { f: "custom1", e: { 0: "SHARPNESS", 1: "FREE", 2: "TANGENT_SPACE" } },
  },
  GeometryNodeSetShadeSmooth: {
    domain: { f: "custom1", e: { 1: "EDGE", 2: "FACE" } },
  },
  GeometryNodeSortElements: {
    domain: { f: "custom1", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 4: "CURVE", 5: "INSTANCE" } },
  },
  GeometryNodeSortList: {
    socket_type: { f: "custom1", e: { 0: "FLOAT", 1: "VECTOR", 2: "RGBA", 4: "BOOLEAN", 6: "INT", 7: "STRING", 8: "OBJECT", 9: "IMAGE", 10: "GEOMETRY", 11: "COLLECTION", 13: "MATERIAL", 14: "ROTATION", 15: "MENU", 16: "MATRIX", 17: "BUNDLE", 18: "CLOSURE", 19: "FONT", 23: "SOUND" } },
  },
  GeometryNodeSplitToInstances: {
    domain: { f: "custom1", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeStoreNamedAttribute: {
    data_type: { f: "storage.data_type", e: { 10: "FLOAT", 11: "INT", 17: "BYTE_COLOR", 20: "FLOAT4X4", 24: "FLOAT4", 45: "INT8", 47: "FLOAT_COLOR", 48: "FLOAT_VECTOR", 49: "FLOAT2", 50: "BOOLEAN", 52: "QUATERNION" } },
    domain: { f: "storage.domain", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeStoreNamedGrid: {
    data_type: { f: "custom1", e: { 1: "BOOLEAN", 2: "FLOAT", 4: "INT", 7: "VECTOR_FLOAT" } },
  },
  GeometryNodeStringToCurves: {
    "Align X": { f: "socket.Align X", e: { 0: "Left", 1: "Center", 2: "Right", 3: "Justify", 4: "Flush" } },
    "Align Y": { f: "socket.Align Y", e: { 0: "Top Baseline", 1: "Top", 2: "Middle", 3: "Bottom Baseline", 4: "Bottom" } },
    Overflow: { f: "socket.Overflow", e: { 0: "Overflow", 1: "Scale To Fit", 2: "Truncate" } },
    "Pivot Point": { f: "socket.Pivot Point", e: { 0: "Midpoint", 1: "Top Left", 2: "Top Center", 3: "Top Right", 4: "Bottom Left", 5: "Bottom Center", 6: "Bottom Right" } },
  },
  GeometryNodeSubdivisionSurface: {
    "Boundary Smooth": { f: "socket.Boundary Smooth", e: { 0: "All", 1: "Keep Corners" } },
  },
  GeometryNodeSwitch: {
    input_type: { f: "storage.input_type", e: { 0: "FLOAT", 1: "VECTOR", 2: "RGBA", 4: "BOOLEAN", 6: "INT", 7: "STRING", 8: "OBJECT", 9: "IMAGE", 10: "GEOMETRY", 11: "COLLECTION", 13: "MATERIAL", 14: "ROTATION", 15: "MENU", 16: "MATRIX", 17: "BUNDLE", 18: "CLOSURE", 19: "FONT", 23: "SOUND" } },
  },
  GeometryNodeToolActiveElement: {
    domain: { f: "custom1", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 6: "LAYER" } },
  },
  GeometryNodeToolSetSelection: {
    domain: { f: "custom1", e: { 0: "POINT", 1: "EDGE", 2: "FACE", 4: "CURVE" } },
    selection_type: { f: "custom2", e: { 0: "BOOLEAN", 1: "FLOAT" } },
  },
  GeometryNodeTransferAttributes: {
    "Pattern Mode": { f: "socket.Pattern Mode", e: { 0: "Exact", 1: "Wildcard" } },
  },
  GeometryNodeTransform: {
    Mode: { f: "socket.Mode", e: { 0: "Components", 1: "Matrix" } },
  },
  GeometryNodeTriangulate: {
    "N-gon Method": { f: "socket.N-gon Method", e: { 0: "Beauty", 1: "Clip" } },
    "Quad Method": { f: "socket.Quad Method", e: { 0: "Beauty", 1: "Fixed", 2: "Fixed Alternate", 3: "Shortest Diagonal", 4: "Longest Diagonal" } },
  },
  GeometryNodeTrimCurve: {
    mode: { f: "storage.mode", e: { 0: "FACTOR", 1: "LENGTH" } },
  },
  GeometryNodeUVPackIslands: {
    Method: { f: "socket.Method", e: { 0: "Bounding Box", 1: "Convex Hull", 2: "Exact Shape" } },
  },
  GeometryNodeUVTangent: {
    Method: { f: "socket.Method", e: { 0: "Exact", 1: "Fast" } },
  },
  GeometryNodeUVUnwrap: {
    Method: { f: "socket.Method", e: { 0: "Angle Based", 1: "Conformal", 2: "Minimum Stretch" } },
  },
  GeometryNodeViewer: {
    domain: { f: "storage.domain", e: { "-1": "AUTO", 0: "POINT", 1: "EDGE", 2: "FACE", 3: "CORNER", 4: "CURVE", 5: "INSTANCE", 6: "LAYER" } },
  },
  GeometryNodeVolumeToMesh: {
    "Resolution Mode": { f: "socket.Resolution Mode", e: { 0: "Grid", 1: "Amount", 2: "Size" } },
  },
  GeometryNodeWarning: {
    warning_type: { f: "custom1", e: { 0: "ERROR", 1: "WARNING", 2: "INFO" } },
  },
};
