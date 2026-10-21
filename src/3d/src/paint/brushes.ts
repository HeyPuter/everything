// Brush data-blocks for sculpt / paint modes: extra settings, defaults for brushes the startup
// document does not ship, and lookup of the active brush per mode.
import type { BrushData, DocumentData, Mode } from '../data/types';
import { app } from '../app/app';
import { activeTools } from '../app/prefs';
import { defaultBrushes } from '../data/defaults';
import type { Falloff } from './math';
import type { StencilSettings } from './brushtex';

/** Brush settings beyond the core BrushData fields (stored on the same data-block). */
export interface PaintBrush extends BrushData, StencilSettings {
  falloff_shape?: 'SPHERE' | 'PROJECTED';
  use_frontface?: boolean;
  /** clay/flatten/fill/scrape plane offset (fraction of the radius) */
  plane_offset?: number;
  /** crease/blob pinch amount */
  crease_pinch_factor?: number;
  /** keep accumulating within a stroke instead of limiting to the brush strength */
  use_accumulate?: boolean;
  /** texture paint: occlusion test against the mesh itself */
  use_occlude?: boolean;
  use_backface_culling?: boolean;
  /** sculpt mask brush: draw or smooth the mask */
  mask_tool?: 'DRAW' | 'SMOOTH';
  /** how dabs are placed along the stroke */
  stroke_method?: 'SPACE' | 'DOTS' | 'AIRBRUSH' | 'LINE' | 'ANCHORED' | 'DRAG_DOT' | 'CURVE';
  /** paint curve the Curve stroke method follows */
  paint_curve?: string | null;
  use_smooth_stroke?: boolean;
  smooth_stroke_radius?: number;
  smooth_stroke_factor?: number;
  /** airbrush interval (seconds) */
  rate?: number;
  /** pen pressure scales the radius / the strength */
  use_pressure_size?: boolean;
  use_pressure_strength?: boolean;
  /** radius in screen pixels (VIEW) or in scene units (SCENE, `unprojected_radius`) */
  use_locked_size?: 'VIEW' | 'SCENE';
  unprojected_radius?: number;
  /** texture paint clone brush: image to copy from (null: the painted image) */
  clone_image?: string | null;
  /** boundary brush deformation */
  boundary_deform_type?: 'GRAB' | 'EXPAND' | 'INFLATE';
  /** texture modulating the strength */
  texture_slot?: import('./brushtex').BrushTexture;
  /** texture scaling only the strength (Texture Paint) */
  mask_texture_slot?: import('./brushtex').BrushTexture;
  /** opacity (percent) of the texture / mask texture overlay in the viewport */
  texture_overlay_alpha?: number;
  mask_overlay_alpha?: number;
  /** brush cursor display */
  show_cursor?: boolean;
  cursor_color_add?: [number, number, number];
  cursor_color_subtract?: [number, number, number];
  falloff: Falloff & BrushData['falloff'];
}

export type BrushMode = 'SCULPT' | 'VERTEX_PAINT' | 'WEIGHT_PAINT' | 'TEXTURE_PAINT';

export interface BrushInfo {
  id: string;
  name: string;
  tool: string;
  icon: string;
  shortcut?: string;
  description: string;
  /** brushes from asset libraries: how to make it the active brush (instead of selecting `id`) */
  pick?: () => void;
}

const S = (id: string, name: string, tool: string, icon: string, description: string, shortcut?: string): BrushInfo => ({ id, name, tool, icon, description, shortcut });

/** Toolbar order per mode. Brush ids match `defaultBrushes()` plus the extras below. */
export const BRUSH_LISTS: Record<BrushMode, (BrushInfo | null)[]> = {
  SCULPT: [
    S('brush_draw', 'Draw', 'DRAW', 'brush_sculpt_draw', 'Moves vertices along the area normal', 'V'),
    S('brush_draw_sharp', 'Draw Sharp', 'DRAW_SHARP', 'brush_sculpt_draw_sharp', 'Draws sharp creases using the original surface'),
    S('brush_clay', 'Clay', 'CLAY', 'brush_sculpt_clay', 'Builds up clay toward a plane above the surface'),
    S('brush_clay_strips', 'Clay Strips', 'CLAY_STRIPS', 'brush_sculpt_clay_strips', 'Clay with a square footprint aligned to the stroke', 'C'),
    S('brush_clay_thumb', 'Clay Thumb', 'CLAY_THUMB', 'brush_sculpt_clay_thumb', 'Builds clay up like smearing it with a thumb along the stroke'),
    S('brush_layer', 'Layer', 'LAYER', 'brush_sculpt_layer', 'Raises a layer of constant height'),
    S('brush_inflate', 'Inflate/Deflate', 'INFLATE', 'brush_sculpt_inflate', 'Moves vertices along their own normals', 'I'),
    S('brush_blob', 'Blob', 'BLOB', 'brush_sculpt_blob', 'Pushes the surface outward into a rounded shape'),
    S('brush_crease', 'Crease', 'CREASE', 'brush_sculpt_crease', 'Pinches the surface into a sharp crease', 'Shift C'),
    null,
    S('brush_smooth', 'Smooth', 'SMOOTH', 'brush_sculpt_smooth', 'Smooths the surface (hold Shift with any brush)', 'S'),
    S('brush_flatten', 'Flatten/Contrast', 'FLATTEN', 'brush_sculpt_flatten', 'Flattens toward the area plane (Ctrl: contrast)'),
    S('brush_fill', 'Fill/Deepen', 'FILL', 'brush_sculpt_fill', 'Fills in cavities (Ctrl: deepen)'),
    S('brush_scrape', 'Scrape/Peaks', 'SCRAPE', 'brush_sculpt_scrape', 'Scrapes down peaks (Ctrl: peaks)', 'Shift T'),
    S('brush_multiplane_scrape', 'Multiplane Scrape', 'MULTIPLANE_SCRAPE', 'brush_sculpt_multiplane', 'Scrapes with two angled planes to carve sharp ridges (Ctrl: valleys)'),
    S('brush_pinch', 'Pinch/Magnify', 'PINCH', 'brush_sculpt_pinch', 'Pulls vertices toward the brush center (Ctrl: magnify)', 'P'),
    null,
    S('brush_grab', 'Grab', 'GRAB', 'brush_sculpt_grab', 'Drags a group of vertices with the mouse', 'G'),
    S('brush_elastic_deform', 'Elastic Deform', 'ELASTIC_DEFORM', 'brush_sculpt_elastic', 'Grabs with a soft falloff that keeps the volume of the surroundings'),
    S('brush_snake_hook', 'Snake Hook', 'SNAKE_HOOK', 'brush_sculpt_snake_hook', 'Pulls vertices along the stroke to make long extrusions', 'K'),
    S('brush_thumb', 'Thumb', 'THUMB', 'brush_sculpt_thumb', 'Grab along the surface plane'),
    S('brush_pose', 'Pose', 'POSE', 'brush_sculpt_pose', 'Rotates the part under the brush around the joint at the edge of the brush'),
    S('brush_nudge', 'Nudge', 'NUDGE', 'brush_sculpt_nudge', 'Pushes vertices along the stroke direction'),
    S('brush_rotate', 'Rotate', 'ROTATE', 'brush_sculpt_rotate', 'Rotates vertices around the brush center'),
    S('brush_boundary', 'Boundary', 'BOUNDARY', 'brush_sculpt_boundary', 'Deforms the open border of the mesh near the brush (grab, expand or inflate)'),
    S('brush_cloth', 'Cloth', 'CLOTH', 'brush_sculpt_cloth', 'Drags the surface like cloth: the area around the brush follows and folds'),
    S('brush_slide_relax', 'Slide Relax', 'SLIDE_RELAX', 'brush_sculpt_slide', 'Slides the topology along the stroke (Shift: relax it)'),
    null,
    S('brush_simplify', 'Simplify', 'SIMPLIFY', 'brush_sculpt_simplify', 'Collapses short edges under the brush (needs Dyntopo)'),
    null,
    S('brush_mask', 'Mask', 'MASK', 'brush_sculpt_mask', 'Paints a mask that protects vertices (Ctrl: erase)', 'M'),
    S('brush_draw_face_sets', 'Draw Face Sets', 'DRAW_FACE_SETS', 'brush_sculpt_face_set', 'Paints a new face set (Ctrl: grows the face set under the stroke start)'),
    null,
    S('brush_sculpt_paint', 'Paint', 'PAINT', 'brush_paint_draw', 'Paints the color attribute of the mesh (Ctrl: secondary color, Shift: blur)'),
    S('brush_sculpt_smear', 'Smear', 'SMEAR', 'brush_paint_smear', 'Smears the colors of the mesh along the stroke'),
  ],
  VERTEX_PAINT: [
    S('brush_vertpaint', 'Paint', 'DRAW', 'brush_paint_draw', 'Paints the active color attribute'),
    S('brush_vert_blur', 'Blur', 'BLUR', 'brush_paint_blur', 'Smooths colors with the neighbouring vertices'),
    S('brush_vert_average', 'Average', 'AVERAGE', 'brush_paint_average', 'Paints the average color under the brush'),
    S('brush_vert_smear', 'Smear', 'SMEAR', 'brush_paint_smear', 'Smears colors along the stroke'),
  ],
  WEIGHT_PAINT: [
    S('brush_weight', 'Paint', 'DRAW', 'brush_weight_draw', 'Paints weights into the active vertex group'),
    S('brush_weight_blur', 'Blur', 'BLUR', 'brush_paint_blur', 'Smooths weights with the neighbouring vertices'),
    S('brush_weight_average', 'Average', 'AVERAGE', 'brush_paint_average', 'Paints the average weight under the brush'),
    S('brush_weight_smear', 'Smear', 'SMEAR', 'brush_paint_smear', 'Smears weights along the stroke'),
  ],
  TEXTURE_PAINT: [
    S('brush_texpaint', 'Paint', 'TEXDRAW', 'brush_paint_draw', 'Paints into the active image texture'),
    S('brush_tex_soften', 'Soften', 'SOFTEN', 'brush_paint_blur', 'Blurs the image under the brush'),
    S('brush_tex_smear', 'Smear', 'SMEAR', 'brush_paint_smear', 'Smears the image along the stroke'),
    S('brush_tex_fill', 'Fill', 'FILL', 'brush_paint_fill', 'Fills every face of the object with the color'),
    S('brush_tex_clone', 'Clone', 'CLONE', 'brush_paint_clone', 'Copies the texture from a source point (Ctrl+click to set it) or from another image'),
  ],
};

function base(id: string, name: string, tool: string, mode: BrushMode, extra: Partial<PaintBrush> = {}): PaintBrush {
  return {
    id,
    name,
    sculpt_tool: tool,
    mode,
    strength: 0.5,
    radius: 50,
    falloff: 'SMOOTH',
    direction: 'ADD',
    auto_smooth_factor: 0,
    spacing: 10,
    ...extra,
  } as PaintBrush;
}

/** Brushes created on demand when a document does not have them (older files / extra tools). */
function extraBrushes(): PaintBrush[] {
  return [
    base('brush_clay_thumb', 'Clay Thumb', 'CLAY_THUMB', 'SCULPT', { strength: 0.5 }),
    base('brush_multiplane_scrape', 'Multiplane Scrape', 'MULTIPLANE_SCRAPE', 'SCULPT', { strength: 0.5 }),
    base('brush_elastic_deform', 'Elastic Deform', 'ELASTIC_DEFORM', 'SCULPT', { strength: 0.5 }),
    base('brush_pose', 'Pose', 'POSE', 'SCULPT', { strength: 1 }),
    base('brush_slide_relax', 'Slide Relax', 'SLIDE_RELAX', 'SCULPT', { strength: 0.5 }),
    base('brush_cloth', 'Cloth', 'CLOTH', 'SCULPT', { strength: 1, spacing: 5 }),
    base('brush_boundary', 'Boundary', 'BOUNDARY', 'SCULPT', { strength: 1 }),
    base('brush_simplify', 'Simplify', 'SIMPLIFY', 'SCULPT', { strength: 0.5 }),
    base('brush_draw_face_sets', 'Draw Face Sets', 'DRAW_FACE_SETS', 'SCULPT', { strength: 1, falloff_shape: 'SPHERE' }),
    base('brush_sculpt_paint', 'Paint', 'PAINT', 'SCULPT', { strength: 1, blend: 'MIX', falloff_shape: 'SPHERE' }),
    base('brush_sculpt_smear', 'Smear', 'SMEAR', 'SCULPT', { strength: 1, blend: 'MIX', falloff_shape: 'SPHERE' }),
    base('brush_vert_blur', 'Blur', 'BLUR', 'VERTEX_PAINT', {
      strength: 1,
      blend: 'MIX',
      falloff_shape: 'PROJECTED',
    }),
    base('brush_vert_average', 'Average', 'AVERAGE', 'VERTEX_PAINT', {
      strength: 1,
      blend: 'MIX',
      falloff_shape: 'PROJECTED',
    }),
    base('brush_vert_smear', 'Smear', 'SMEAR', 'VERTEX_PAINT', {
      strength: 1,
      blend: 'MIX',
      falloff_shape: 'PROJECTED',
    }),
    base('brush_weight_blur', 'Blur', 'BLUR', 'WEIGHT_PAINT', {
      strength: 1,
      blend: 'MIX',
      falloff_shape: 'PROJECTED',
    }),
    base('brush_weight_average', 'Average', 'AVERAGE', 'WEIGHT_PAINT', {
      strength: 1,
      blend: 'MIX',
      falloff_shape: 'PROJECTED',
    }),
    base('brush_weight_smear', 'Smear', 'SMEAR', 'WEIGHT_PAINT', {
      strength: 1,
      blend: 'MIX',
      falloff_shape: 'PROJECTED',
    }),
    base('brush_tex_soften', 'Soften', 'SOFTEN', 'TEXTURE_PAINT', {
      strength: 1,
      blend: 'MIX',
    }),
    base('brush_tex_smear', 'Smear', 'SMEAR', 'TEXTURE_PAINT', {
      strength: 1,
      blend: 'MIX',
    }),
    base('brush_tex_clone', 'Clone', 'CLONE', 'TEXTURE_PAINT', {
      strength: 1,
      blend: 'MIX',
    }),
    base('brush_tex_fill', 'Fill', 'FILL', 'TEXTURE_PAINT', {
      strength: 1,
      blend: 'MIX',
    }),
  ];
}

/** Factory settings of a built-in brush (null for other brushes). */
export function factoryBrush(id: string): PaintBrush | null {
  const b = (defaultBrushes()[id] as PaintBrush | undefined) ?? extraBrushes().find((x) => x.id === id);
  if (!b) return null;
  fillDefaults(b);
  return b;
}

/** Settings each brush should have even when loaded from an older document. */
function fillDefaults(b: PaintBrush) {
  const mode = b.mode as BrushMode;
  if (b.falloff_shape === undefined) b.falloff_shape = mode === 'VERTEX_PAINT' || mode === 'WEIGHT_PAINT' ? 'PROJECTED' : 'SPHERE';
  if (b.use_frontface === undefined) b.use_frontface = false;
  if (b.normal_radius_factor === undefined) b.normal_radius_factor = 0.5;
  if (b.hardness === undefined) b.hardness = 0;
  if (mode === 'TEXTURE_PAINT') {
    if (b.use_occlude === undefined) b.use_occlude = true;
    if (b.use_backface_culling === undefined) b.use_backface_culling = true;
  }
  if (mode !== 'SCULPT' && !b.blend) b.blend = 'MIX';
  if (mode === 'SCULPT') {
    if (b.plane_offset === undefined) b.plane_offset = 0;
    if (b.crease_pinch_factor === undefined) b.crease_pinch_factor = 0.5;
    if (b.sculpt_tool === 'MASK' && !b.mask_tool) b.mask_tool = 'DRAW';
  }
}

/** Make sure every brush listed in the toolbars exists in the document. Returns true if any was added. */
export function ensureBrushes(doc: DocumentData): boolean {
  let added = false;
  for (const b of extraBrushes())
    if (!doc.brushes[b.id]) {
      doc.brushes[b.id] = b;
      added = true;
    }
  for (const b of Object.values(doc.brushes)) fillDefaults(b as PaintBrush);
  return added;
}

export function isBrushMode(mode: Mode | string): mode is BrushMode {
  return mode === 'SCULPT' || mode === 'VERTEX_PAINT' || mode === 'WEIGHT_PAINT' || mode === 'TEXTURE_PAINT';
}

const DEFAULT_TOOL: Record<BrushMode, string> = {
  SCULPT: 'brush_draw',
  VERTEX_PAINT: 'brush_vertpaint',
  WEIGHT_PAINT: 'brush_weight',
  TEXTURE_PAINT: 'brush_texpaint',
};

/** Active brush of a mode (the active toolbar tool when it is a brush). */
export function activeBrush(mode: BrushMode = app.doc.mode as BrushMode): PaintBrush | null {
  const doc = app.doc;
  const id = activeTools[mode];
  let b = id ? (doc.brushes[id] as PaintBrush | undefined) : undefined;
  if (!b && mode === 'SCULPT' && !id?.startsWith('builtin.')) b = doc.brushes[doc.scene.tool_settings.sculpt.brush] as PaintBrush | undefined;
  if (!b && !id?.startsWith('builtin.')) b = doc.brushes[DEFAULT_TOOL[mode]] as PaintBrush | undefined;
  if (b) fillDefaults(b);
  return b ?? null;
}

export function brushInfo(id: string): BrushInfo | undefined {
  for (const list of Object.values(BRUSH_LISTS)) for (const b of list) if (b && b.id === id) return b;
  return undefined;
}

export function brushById(id: string): PaintBrush | null {
  const b = app.doc.brushes[id] as PaintBrush | undefined;
  if (b) fillDefaults(b);
  return b ?? null;
}
