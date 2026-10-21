// UV editing operators: pin, merge, snap, cursor, align, stitch, seams, minimize stretch,
// pack/average/arrange islands, randomize, mirrored copy, copy/paste, rip and axis nudges.
import { app, registerOperators, operators, type OpContext } from '../../app/app';
import { UVTopo, SelEdit, selReader, isPinned } from './uvcore';
import {
  weld,
  mergeByDistance,
  snapToAdjacentUnselected,
  selGroups,
  selCenter,
  align,
  alignRotation,
  selectedIslands,
  averageIslandsScale,
  packIslandsUV,
  mergeOverlapping,
  islandCorners,
  arrangeIslands,
  randomizeIslands,
  minimizeStretch,
  stitch,
  seamsFromIslands,
  copyMirroredFaces,
  type AlignAxis,
  type ArrangeOptions,
  type PackOptions,
  type RandomizeOptions,
  type StitchOptions,
} from './uvalgo';
import { ripKeep } from './uvselect';
import { locInvoke } from './uvops-select';
import { uvLayers, uvEditPoll, ctxUVEditor, uvCursor, uvChanged, inUVEditor, type EditLayer } from './uvcontext';
import { startUVTransform, nudgeSelection } from './uvtransform';
import { packRegion, selectionBounds, regionSettings, type PackSource } from './uvregion';
import { startStitch } from './uvstitch';
import type { ImageData } from '../../data/types';

type Sel = (c: number) => boolean;

/** Run an edit on the UVs of every edited mesh; `fn` returns whether it changed anything. */
function editUVs(fn: (t: UVTopo, uvs: Float32Array, sel: Sel, layer: EditLayer) => boolean | number, layers = uvLayers()): number {
  let n = 0;
  for (const layer of layers) {
    const t = new UVTopo(layer);
    const uvs = new Float32Array(layer.me.uvs);
    const r = fn(t, uvs, selReader(layer), layer);
    if (r) {
      layer.me.uvs = uvs;
      n += typeof r === 'number' ? r : 1;
    }
  }
  if (n) uvChanged();
  return n;
}

/** Pixel size of the image shown in the UV editor (256 when there is none). */
function imageSize(ctx: OpContext): [number, number] {
  const img = ctxUVEditor(ctx)?.image();
  return img ? [Math.max(1, img.width), Math.max(1, img.height)] : [256, 256];
}

/** In the UV editor: islands with selected UVs; from the 3D Viewport: every island of the selected faces. */
function opIslands(ctx: OpContext, t: UVTopo, sel: Sel) {
  return selectedIslands(t, sel, !inUVEditor(ctx));
}
function opLayers(ctx: OpContext) {
  return uvLayers(!inUVEditor(ctx));
}

let clipboard: { sizes: number[]; uvs: number[] } | null = null;

registerOperators([
  {
    idname: 'uv.pin',
    label: 'Pin',
    description: 'Pin the selected UVs so unwrapping and relaxing keep them in place',
    props: [
      { id: 'clear', label: 'Clear', type: 'bool', default: false },
      { id: 'invert', label: 'Invert', type: 'bool', default: false },
    ],
    poll: uvEditPoll,
    exec: (_ctx, p) => {
      let n = 0;
      for (const layer of uvLayers()) {
        const me = layer.me;
        const sel = selReader(layer);
        const pin = me.uv_pin && me.uv_pin.length === me.indices.length ? new Uint8Array(me.uv_pin) : new Uint8Array(me.indices.length);
        for (const f of layer.faces)
          for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++)
            if (sel(c)) {
              pin[c] = p.clear ? 0 : p.invert ? pin[c] ^ 1 : 1;
              n++;
            }
        me.uv_pin = pin.some(Boolean) ? pin : undefined;
      }
      if (!n) return 'CANCELLED';
      uvChanged();
    },
  },
  {
    idname: 'uv.weld',
    label: 'Weld',
    description: 'Merge the selected UVs at their center',
    poll: uvEditPoll,
    exec: () => (editUVs((t, uvs, sel) => weld(t, uvs, sel) > 0) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'uv.remove_doubles',
    label: 'Merge UVs by Distance',
    description: 'Merge selected UVs that are closer than a distance',
    props: [
      { id: 'threshold', label: 'Merge Distance', type: 'float', default: 0.02, min: 0, max: 10, softMax: 1, precision: 4 },
      { id: 'use_unselected', label: 'Unselected', type: 'bool', default: false },
      { id: 'use_shared_vertex', label: 'Shared Vertex', type: 'bool', default: false },
    ],
    poll: uvEditPoll,
    exec: (_ctx, p) => {
      let removed = 0;
      editUVs((t, uvs, sel) => {
        const n = mergeByDistance(t, uvs, sel, p.threshold as number, !!p.use_unselected, !!p.use_shared_vertex);
        removed += n;
        return n > 0;
      });
      app.report('INFO', `Removed ${removed} UV${removed === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'uv.snap_selected',
    label: 'Snap Selection',
    description: 'Snap the selected UVs to pixels, the 2D cursor or neighbouring UVs',
    props: [{ id: 'target', label: 'Target', type: 'enum', default: 'PIXELS', items: [['PIXELS', 'Pixels'], ['CURSOR', 'Cursor'], ['CURSOR_OFFSET', 'Cursor (Offset)'], ['ADJACENT_UNSELECTED', 'Adjacent Unselected']] }],
    poll: uvEditPoll,
    exec: (ctx, p) => {
      const target = p.target as string;
      const [w, h] = imageSize(ctx);
      let offset: [number, number] | null = null;
      if (target === 'CURSOR_OFFSET') {
        let su = 0,
          sv = 0,
          n = 0;
        for (const layer of uvLayers()) {
          const t = new UVTopo(layer);
          const c = selCenter(t, layer.me.uvs as Float32Array, selReader(layer));
          const k = selGroups(t, selReader(layer)).size;
          if (c && k) {
            su += c[0] * k;
            sv += c[1] * k;
            n += k;
          }
        }
        if (!n) return 'CANCELLED';
        offset = [uvCursor.u - su / n, uvCursor.v - sv / n];
      }
      const n = editUVs((t, uvs, sel) => {
        if (target === 'ADJACENT_UNSELECTED') return snapToAdjacentUnselected(t, uvs, sel);
        let k = 0;
        for (const corners of selGroups(t, sel).values())
          for (const c of corners) {
            if (target === 'PIXELS') {
              uvs[c * 2] = Math.round(uvs[c * 2] * w) / w;
              uvs[c * 2 + 1] = Math.round(uvs[c * 2 + 1] * h) / h;
            } else if (target === 'CURSOR') {
              uvs[c * 2] = uvCursor.u;
              uvs[c * 2 + 1] = uvCursor.v;
            } else if (offset) {
              uvs[c * 2] += offset[0];
              uvs[c * 2 + 1] += offset[1];
            }
            k++;
          }
        return k;
      });
      return n ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'uv.snap_cursor',
    label: 'Snap Cursor',
    description: 'Snap the 2D cursor to pixels, the selection or the origin',
    props: [{ id: 'target', label: 'Target', type: 'enum', default: 'PIXELS', items: [['PIXELS', 'Pixels'], ['SELECTED', 'Selected'], ['ORIGIN', 'Origin']] }],
    poll: uvEditPoll,
    undo: false,
    exec: (ctx, p) => {
      if (p.target === 'ORIGIN') {
        uvCursor.u = uvCursor.v = 0;
      } else if (p.target === 'PIXELS') {
        const [w, h] = imageSize(ctx);
        uvCursor.u = Math.round(uvCursor.u * w) / w;
        uvCursor.v = Math.round(uvCursor.v * h) / h;
      } else {
        let su = 0,
          sv = 0,
          n = 0;
        for (const layer of uvLayers()) {
          const t = new UVTopo(layer);
          for (const corners of selGroups(t, selReader(layer)).values()) {
            su += layer.me.uvs[corners[0] * 2];
            sv += layer.me.uvs[corners[0] * 2 + 1];
            n++;
          }
        }
        if (!n) return 'CANCELLED';
        uvCursor.u = su / n;
        uvCursor.v = sv / n;
      }
      app.changed('ui');
    },
  },
  {
    idname: 'uv.cursor_set',
    label: 'Set 2D Cursor',
    description: 'Place the 2D cursor',
    props: [{ id: 'location', label: 'Location', type: 'vec2', default: [0, 0] }],
    poll: () => !!ctxUVEditor(app.context()),
    undo: false,
    exec: (_ctx, p) => {
      const [u, v] = p.location as number[];
      uvCursor.u = u;
      uvCursor.v = v;
      app.changed('ui');
    },
  },
  {
    idname: 'uv.align',
    label: 'Align',
    description: 'Line up the selected UVs on an axis or along a straight line',
    props: [
      { id: 'axis', label: 'Axis', type: 'enum', default: 'ALIGN_AUTO', items: [['ALIGN_S', 'Straighten'], ['ALIGN_T', 'Straighten X'], ['ALIGN_U', 'Straighten Y'], ['ALIGN_AUTO', 'Align Auto'], ['ALIGN_X', 'Align Vertically'], ['ALIGN_Y', 'Align Horizontally']] },
      { id: 'position_mode', label: 'Position Mode', type: 'enum', default: 'MEAN', items: [['MEAN', 'Mean'], ['MIN', 'Minimum'], ['MAX', 'Maximum']] },
    ],
    poll: uvEditPoll,
    exec: (_ctx, p) => (editUVs((t, uvs, sel) => align(t, uvs, sel, p.axis as AlignAxis, p.position_mode as 'MEAN')) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'uv.align_rotation',
    label: 'Align Rotation',
    description: 'Rotate islands so they line up with the axes',
    props: [
      { id: 'method', label: 'Method', type: 'enum', default: 'AUTO', items: [['AUTO', 'Auto'], ['EDGE', 'Edge'], ['GEOMETRY', 'Geometry']] },
      { id: 'axis', label: 'Axis', type: 'enum', default: 'X', items: [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']], showIf: (p) => p.method === 'GEOMETRY' },
      { id: 'correct_aspect', label: 'Correct Aspect', type: 'bool', default: false },
    ],
    poll: uvEditPoll,
    exec: (ctx, p) => {
      // with Correct Aspect, rotate in the image's pixel proportions
      const [w, h] = imageSize(ctx);
      const k = p.correct_aspect ? w / h : 1;
      return editUVs((t, uvs, sel) => {
        if (k !== 1) for (let i = 0; i < uvs.length; i += 2) uvs[i] *= k;
        const n = alignRotation(t, uvs, sel, p.method as 'AUTO', p.axis as 'X');
        if (k !== 1) for (let i = 0; i < uvs.length; i += 2) uvs[i] /= k;
        return n;
      })
        ? 'FINISHED'
        : 'CANCELLED';
    },
  },
  {
    idname: 'uv.stitch',
    label: 'Stitch',
    description: 'Join the selected UVs with the other UVs of the same mesh vertices',
    props: [
      { id: 'use_limit', label: 'Use Limit', type: 'bool', default: false },
      { id: 'snap_islands', label: 'Snap Islands', type: 'bool', default: true },
      { id: 'limit', label: 'Limit', type: 'float', default: 0.01, min: 0, softMax: 2, showIf: (p) => !!p.use_limit },
      { id: 'static_island', label: 'Static Island', type: 'int', default: 0, min: 0 },
      { id: 'midpoint_snap', label: 'Snap at Midpoint', type: 'bool', default: false },
      { id: 'clear_seams', label: 'Clear Seams', type: 'bool', default: true },
      { id: 'mode', label: 'Operation Mode', type: 'enum', default: 'VERTEX', items: [['VERTEX', 'Vertex'], ['EDGE', 'Edge']] },
    ],
    poll: (ctx) => uvEditPoll() && !app.doc.scene.tool_settings.use_uv_select_sync && !!ctx,
    invoke: (ctx, p) => (ctxUVEditor(ctx) ? startStitch(ctx, p) : app.run('uv.stitch', p, { invoke: false, area: ctx.area })),
    exec: (_ctx, p) => {
      let groups = 0;
      editUVs((t, uvs, sel, layer) => {
        const r = stitch(t, uvs, sel, p as unknown as StitchOptions);
        groups += r.groups;
        if (r.seamCorners.length && layer.me.seams) {
          const seams = new Uint32Array(layer.me.seams);
          for (const c of r.seamCorners) seams[c] = 0;
          layer.me.seams = seams.some(Boolean) ? seams : undefined;
        }
        return r.groups > 0;
      });
      if (!groups) {
        app.report('WARNING', 'Nothing to stitch: select UVs of the same mesh vertices in different places');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'uv.mark_seam',
    label: 'Mark Seam',
    description: 'Mark the selected UV edges as seams',
    props: [{ id: 'clear', label: 'Clear Seams', type: 'bool', default: false }],
    poll: uvEditPoll,
    exec: (_ctx, p) => {
      let n = 0;
      for (const layer of uvLayers()) {
        const t = new UVTopo(layer);
        const sel = selReader(layer);
        const me = layer.me;
        const seams = me.seams && me.seams.length === me.indices.length ? new Uint32Array(me.seams) : new Uint32Array(me.indices.length);
        const all = allMeshEdgeCorners(me);
        for (const f of layer.faces)
          for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
            if (!(sel(c) && sel(t.next(c)))) continue;
            for (const k of all.get(t.meshEdgeKey(c)) ?? [c]) seams[k] = p.clear ? 0 : 1;
            n++;
          }
        me.seams = seams.some(Boolean) ? seams : undefined;
      }
      if (!n) return 'CANCELLED';
      uvChanged();
    },
  },
  {
    idname: 'uv.seams_from_islands',
    label: 'Seams from Islands',
    description: 'Mark the borders of UV islands as seams',
    props: [
      { id: 'mark_seams', label: 'Mark Seams', type: 'bool', default: true },
      { id: 'mark_sharp', label: 'Mark Sharp', type: 'bool', default: false },
    ],
    poll: uvEditPoll,
    exec: (_ctx, p) => {
      for (const layer of uvLayers()) {
        const t = new UVTopo(layer);
        const me = layer.me;
        const r = seamsFromIslands(t, me.seams && me.seams.length === me.indices.length ? me.seams : undefined);
        if (p.mark_seams) me.seams = r.seams.some(Boolean) ? r.seams : undefined;
        if (p.mark_sharp && r.sharpCorners.length) {
          const sharp = me.sharp && me.sharp.length === me.indices.length ? new Uint32Array(me.sharp) : new Uint32Array(me.indices.length);
          for (const c of r.sharpCorners) sharp[c] = 1;
          me.sharp = sharp;
        }
      }
      uvChanged();
    },
  },
  {
    idname: 'uv.minimize_stretch',
    label: 'Minimize Stretch',
    description: 'Relax the selected UVs to reduce stretching compared to the 3D surface',
    props: [
      { id: 'fill_holes', label: 'Fill Holes', type: 'bool', default: true, hidden: true },
      { id: 'blend', label: 'Blend', type: 'float', default: 0, min: 0, max: 1, subtype: 'factor' },
      { id: 'iterations', label: 'Iterations', type: 'int', default: 20, min: 1, max: 1000 },
    ],
    poll: uvEditPoll,
    exec: (_ctx, p) =>
      editUVs((t, uvs, sel) => {
        const movable = new Set<number>();
        for (const [id, corners] of selGroups(t, sel)) if (!t.vertCorners[id].some((c) => isPinned(t.me, c)) && corners.length) movable.add(id);
        return minimizeStretch(t, uvs, movable, p.iterations as number, p.blend as number);
      })
        ? 'FINISHED'
        : 'CANCELLED',
  },
  {
    idname: 'uv.pack_islands',
    label: 'Pack Islands',
    description: 'Arrange the islands to fill the UV square with as little empty space as possible',
    props: [
      { id: 'rotate', label: 'Rotate', type: 'bool', default: true },
      { id: 'rotate_method', label: 'Rotation Method', type: 'enum', default: 'ANY', items: [['ANY', 'Any'], ['CARDINAL', 'Cardinal'], ['AXIS_ALIGNED', 'Axis-aligned'], ['AXIS_ALIGNED_X', 'Axis-aligned (Horizontal)'], ['AXIS_ALIGNED_Y', 'Axis-aligned (Vertical)']], showIf: (p) => !!p.rotate },
      { id: 'scale', label: 'Scale', type: 'bool', default: true },
      { id: 'margin', label: 'Margin', type: 'float', default: 0.001, min: 0, max: 1, precision: 3 },
      { id: 'merge_overlap', label: 'Merge Overlapping', type: 'bool', default: false },
      { id: 'pin', label: 'Lock Pinned Islands', type: 'bool', default: false },
      {
        id: 'udim_source',
        label: 'Pack to',
        type: 'enum',
        default: 'CLOSEST_UDIM',
        items: [
          ['CLOSEST_UDIM', 'Closest UDIM', 'The UDIM tile nearest to the selection'],
          ['ACTIVE_UDIM', 'Active UDIM', 'The active tile of the shown UDIM image'],
          ['ORIGINAL_AABB', 'Original bounding box', 'The bounds of the selected islands before packing'],
          ['CUSTOM_REGION', 'Custom Region', 'The user region (Set User Region, Ctrl B)'],
        ],
      },
    ],
    poll: uvEditPoll,
    exec: (ctx, p) => {
      const layers = opLayers(ctx);
      const view = ctxUVEditor(ctx) as unknown as { image?(): ImageData | null } | null;
      const region = packRegion(p.udim_source as PackSource, selectionBounds(layers), view?.image?.() ?? null, regionSettings().uv_custom_region);
      const o: PackOptions = { margin: p.margin as number, rotate: !!p.rotate, rotateMethod: p.rotate_method as PackOptions['rotateMethod'], scale: !!p.scale, region };
      return editUVs((t, uvs, sel) => {
        let islands = opIslands(ctx, t, sel);
        // pinned islands stay where they are
        if (p.pin) islands = islands.filter((faces) => !islandCorners(t, faces).some((c) => isPinned(t.me, c)));
        if (p.merge_overlap) islands = mergeOverlapping(t, uvs, islands);
        return packIslandsUV(t, uvs, islands, o);
      }, layers)
        ? 'FINISHED'
        : 'CANCELLED';
    },
  },
  {
    idname: 'uv.average_islands_scale',
    label: 'Average Islands Scale',
    description: 'Scale islands so their UV area matches their 3D area relative to each other',
    props: [{ id: 'scale_uv', label: 'Non-Uniform', type: 'bool', default: false }],
    poll: uvEditPoll,
    exec: (ctx, p) => (editUVs((t, uvs, sel) => averageIslandsScale(t, uvs, opIslands(ctx, t, sel), !!p.scale_uv), opLayers(ctx)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'uv.arrange_islands',
    label: 'Arrange/Align Islands',
    description: 'Line islands up in a row or column without scaling them',
    props: [
      { id: 'initial_position', label: 'Initial Position', type: 'enum', default: 'BOUNDING_BOX', items: [['BOUNDING_BOX', 'Bounding Box'], ['UV_GRID', 'UV Grid'], ['CURSOR', '2D Cursor']] },
      { id: 'axis', label: 'Axis', type: 'enum', default: 'Y', items: [['X', 'X'], ['Y', 'Y']] },
      { id: 'align', label: 'Align', type: 'enum', default: 'MIN', items: [['MIN', 'Min'], ['MAX', 'Max'], ['CENTER', 'Center'], ['NONE', 'None']] },
      { id: 'order', label: 'Order', type: 'enum', default: 'LARGE_TO_SMALL', items: [['LARGE_TO_SMALL', 'Largest to Smallest'], ['SMALL_TO_LARGE', 'Smallest to Largest'], ['Fixed', 'Fixed']] },
      { id: 'margin', label: 'Margin', type: 'float', default: 0.05, min: 0, max: 1 },
    ],
    poll: uvEditPoll,
    exec: (ctx, p) => (editUVs((t, uvs, sel) => arrangeIslands(t, uvs, opIslands(ctx, t, sel), p as unknown as ArrangeOptions, [uvCursor.u, uvCursor.v]), opLayers(ctx)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'uv.randomize_uv_transform',
    label: 'Randomize',
    description: 'Randomly move, rotate and scale islands with selected UVs',
    props: [
      { id: 'random_seed', label: 'Random Seed', type: 'int', default: 0, min: 0, max: 10000 },
      { id: 'use_loc', label: 'Randomize Location', type: 'bool', default: true },
      { id: 'loc', label: 'Location', type: 'vec2', default: [0, 0], showIf: (p) => !!p.use_loc },
      { id: 'use_rot', label: 'Randomize Rotation', type: 'bool', default: true },
      { id: 'rot', label: 'Rotation', type: 'float', default: 0, min: -Math.PI * 2, max: Math.PI * 2, subtype: 'angle', showIf: (p) => !!p.use_rot },
      { id: 'use_scale', label: 'Randomize Scale', type: 'bool', default: true },
      { id: 'scale_even', label: 'Scale Even', type: 'bool', default: false, showIf: (p) => !!p.use_scale },
      { id: 'scale', label: 'Scale', type: 'vec2', default: [1, 1], showIf: (p) => !!p.use_scale },
    ],
    poll: uvEditPoll,
    exec: (ctx, p) => {
      editUVs((t, uvs, sel) => randomizeIslands(t, uvs, opIslands(ctx, t, sel), p as unknown as RandomizeOptions));
    },
  },
  {
    idname: 'uv.copy_mirrored_faces',
    label: 'Copy Mirrored UV Coords',
    description: 'Copy UVs from one side of a symmetric mesh to the faces on the other side',
    props: [
      { id: 'mesh_axis', label: 'Axis', type: 'enum', default: 'POS_X', items: [['POS_X', '-X to +X'], ['POS_Y', '-Y to +Y'], ['POS_Z', '-Z to +Z'], ['NEG_X', '+X to -X'], ['NEG_Y', '+Y to -Y'], ['NEG_Z', '+Z to -Z']] },
      { id: 'precision', label: 'Precision', type: 'int', default: 3, min: 1, max: 16 },
    ],
    poll: uvEditPoll,
    exec: (_ctx, p) => {
      const n = editUVs((t, uvs) => copyMirroredFaces(t, uvs, p.mesh_axis as 'POS_X', p.precision as number));
      if (!n) app.report('WARNING', 'No mirrored faces found');
    },
  },
  {
    idname: 'uv.copy',
    label: 'Copy UVs',
    description: 'Copy the UVs of the selected faces',
    poll: uvEditPoll,
    undo: false,
    exec: () => {
      const sizes: number[] = [],
        uvs: number[] = [];
      for (const layer of uvLayers()) {
        const sel = selReader(layer);
        const me = layer.me;
        for (const f of layer.faces) {
          let all = true;
          for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (!sel(c)) all = false;
          if (!all) continue;
          sizes.push(me.offsets[f + 1] - me.offsets[f]);
          for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) uvs.push(me.uvs[c * 2], me.uvs[c * 2 + 1]);
        }
      }
      if (!sizes.length) {
        app.report('WARNING', 'Select faces to copy their UVs');
        return 'CANCELLED';
      }
      clipboard = { sizes, uvs };
      app.report('INFO', `Copied UVs of ${sizes.length} face${sizes.length === 1 ? '' : 's'}`);
      return 'FINISHED';
    },
  },
  {
    idname: 'uv.paste',
    label: 'Paste UVs',
    description: 'Paste copied UVs onto the selected faces (same number and kind of faces)',
    poll: () => uvEditPoll() && !!clipboard,
    exec: () => {
      const cb = clipboard!;
      const targets: { layer: EditLayer; faces: number[] }[] = [];
      let count = 0;
      for (const layer of uvLayers()) {
        const sel = selReader(layer);
        const me = layer.me;
        const faces = layer.faces.filter((f) => {
          for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (!sel(c)) return false;
          return true;
        });
        targets.push({ layer, faces });
        count += faces.length;
      }
      if (count !== cb.sizes.length) {
        app.report('ERROR', `Paste UVs needs ${cb.sizes.length} selected face${cb.sizes.length === 1 ? '' : 's'}, ${count} selected`);
        return 'CANCELLED';
      }
      let i = 0,
        k = 0;
      for (const { layer, faces } of targets) {
        const me = layer.me;
        const uvs = new Float32Array(me.uvs);
        for (const f of faces) {
          const n = me.offsets[f + 1] - me.offsets[f];
          if (n !== cb.sizes[i]) {
            app.report('ERROR', 'The selected faces do not match the copied ones');
            return 'CANCELLED';
          }
          for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++, k++) {
            uvs[c * 2] = cb.uvs[k * 2];
            uvs[c * 2 + 1] = cb.uvs[k * 2 + 1];
          }
          i++;
        }
        me.uvs = uvs;
      }
      uvChanged();
    },
  },
  {
    idname: 'uv.rip',
    label: 'UV Rip',
    description: 'Tear the selected UVs away from their neighbours on the side of the pointer',
    props: [{ id: 'location', label: 'Location', type: 'vec2', default: [0, 0], hidden: true }],
    poll: (ctx) => uvEditPoll() && !app.doc.scene.tool_settings.use_uv_select_sync && !!ctx,
    exec: (_ctx, p) => {
      const [u, v] = p.location as number[];
      let n = 0;
      for (const layer of uvLayers()) {
        const t = new UVTopo(layer);
        const sel = selReader(layer);
        const keep = ripKeep(t, sel, u, v);
        const e = new SelEdit(layer);
        for (const f of layer.faces)
          for (let c = layer.me.offsets[f]; c < layer.me.offsets[f + 1]; c++)
            if (sel(c) && !keep.has(c)) {
              e.set(c, false);
              n++;
            }
        e.commit();
      }
      if (!n) return 'CANCELLED';
      uvChanged(true);
    },
  },
  {
    idname: 'uv.rip_move',
    label: 'UV Rip Move',
    description: 'Rip the selected UVs and move them',
    props: [{ id: 'release_confirm', type: 'bool', default: false, hidden: true }],
    poll: (ctx) => uvEditPoll() && !app.doc.scene.tool_settings.use_uv_select_sync && !!ctxUVEditor(ctx),
    invoke: (ctx, p) => {
      const view = ctxUVEditor(ctx)!;
      const ev = ctx.event ?? app.pointer;
      const local = view.local({ clientX: ev.x, clientY: ev.y });
      const loc = view.toUV(local.x, local.y);
      app.run('uv.rip', { location: [loc.u, loc.v] }, { invoke: false, area: ctx.area });
      return startUVTransform('TRANSLATE', ctx, { release_confirm: p.release_confirm });
    },
  },
  {
    idname: 'uv.move_on_axis',
    label: 'Move on Axis',
    description: 'Move the selected UVs by whole tiles, pixels or grid steps',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'UDIM', items: [['DYNAMIC', 'Dynamic'], ['PIXEL', 'Pixel'], ['UDIM', 'UDIM']] },
      { id: 'axis', label: 'Axis', type: 'enum', default: 'X', items: [['X', 'X'], ['Y', 'Y']] },
      { id: 'distance', label: 'Distance', type: 'int', default: 1 },
    ],
    poll: uvEditPoll,
    exec: (ctx, p) => {
      let step = 1;
      if (p.type === 'PIXEL') step = 1 / imageSize(ctx)[p.axis === 'X' ? 0 : 1];
      else if (p.type === 'DYNAMIC') {
        // one grid line of the editor's current grid
        const view = ctxUVEditor(ctx);
        const px = view ? view.scale() : 400;
        step = 1 / 8;
        while (step * px > 120 && step > 1 / 4096) step /= 2;
        while (step * px < 30 && step < 1) step *= 2;
      }
      const d = (p.distance as number) * step;
      return nudgeSelection(p.axis === 'X' ? d : 0, p.axis === 'Y' ? d : 0) ? 'FINISHED' : 'CANCELLED';
    },
  },
]);

/** Corners of every face (shown or not) that start each mesh edge. */
function allMeshEdgeCorners(me: EditLayer['me']): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const nv = me.positions.length / 3 + 1;
  for (let f = 0; f < me.offsets.length - 1; f++)
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
      const n = c + 1 < me.offsets[f + 1] ? c + 1 : me.offsets[f];
      const a = me.indices[c],
        b = me.indices[n];
      const k = a < b ? a * nv + b : b * nv + a;
      (out.get(k) ?? out.set(k, []).get(k)!).push(c);
    }
  return out;
}



for (const id of ['uv.rip', 'uv.cursor_set']) {
  const op = operators.get(id)!;
  op.invoke = locInvoke(op.exec!);
}
