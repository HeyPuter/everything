// Texture Paint mode: projection painting into the image of the active material's Image Texture
// node. Each dab rasterizes the triangles under the screen-space brush circle into texture space;
// every texel is mapped back to its 3D point, projected to the screen for the brush falloff and
// depth-tested against a small software depth buffer of the brush footprint (occlusion).
import { Matrix4, Vector3 } from 'three';
import { app, operators, registerOperators } from '../app/app';
import { openMenu } from '../ui/menu';
import { activeView3D } from '../editors/view3d/view3d';
import { uid, newImage, newMaterial } from '../data/defaults';
import type { ImageData as Img, MaterialData, MeshData, NodeData, ObjectData } from '../data/types';
import type { View3D } from '../editors/view3d/view3d';
import { encodeImage, imageCanvas, imageTexture, touchImage } from '../render/images';
import { activeBrush, type PaintBrush } from './brushes';
import { blendColor, falloff, linearToSrgb, srgbToLinear, symmetryPasses, type BlendMode } from './math';
import { activeMeshData, meshSession, type MeshSession } from './session';
import { brushRadiusPx } from './vgather';
import { runStroke } from './stroke';
import { paintDisplay } from './display';
import { materialSlots } from '../editors/view3d/draw';

// ---------------------------------------------------------------------------
// paint slot lookup / creation

function activeMaterial(ob: ObjectData): MaterialData | null {
  const slots = materialSlots(app.doc, ob);
  const id = slots[ob.active_material_index ?? 0] ?? slots.find((s) => !!s) ?? null;
  return id ? (app.doc.materials[id] ?? null) : null;
}

/** Image Texture node used for painting: the active node, else the one feeding Base Color, else any. */
export function paintImageNode(ma: MaterialData | null): NodeData | null {
  if (!ma) return null;
  const nodes = ma.tree.nodes.filter((n) => n.type === 'ShaderNodeTexImage' && n.props.image && app.doc.images[n.props.image as string]);
  if (!nodes.length) return null;
  const act = nodes.find((n) => n.id === ma.tree.active_node);
  if (act) return act;
  const bsdf = ma.tree.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled');
  const link = bsdf && ma.tree.links.find((l) => l.to_node === bsdf.id && l.to_socket === 'Base Color');
  return nodes.find((n) => n.id === link?.from_node) ?? nodes[0];
}

export function paintImage(ob: ObjectData | null = app.activeObject): Img | null {
  if (!ob) return null;
  const node = paintImageNode(activeMaterial(ob));
  return node ? (app.doc.images[node.props.image as string] ?? null) : null;
}

paintDisplay.resolve = () => paintImage()?.id ?? null;

export function meshHasUVs(me: MeshData): boolean {
  if (me.uvs.length !== me.indices.length * 2 || !me.uvs.length) return false;
  for (let i = 0; i < me.uvs.length; i++) if (me.uvs[i] !== 0) return true;
  return false;
}

/**
 * Add a paint slot: a new image (filled with the material's base color) in an Image Texture node
 * linked to Base Color of the active material (a material is created when the object has none).
 */
export function addPaintSlot(
  ob: ObjectData,
  opts: {
    width?: number;
    height?: number;
    name?: string;
    color?: [number, number, number, number];
  } = {},
): Img | null {
  const doc = app.doc;
  const me = ob.data ? doc.meshes[ob.data] : undefined;
  if (!me) return null;
  let ma = activeMaterial(ob);
  if (!ma) {
    ma = newMaterial('Material');
    doc.materials[ma.id] = ma;
    const slot = ob.active_material_index ?? 0;
    if (!me.materials.length) me.materials.push(ma.id);
    else me.materials[Math.min(slot, me.materials.length - 1)] = ma.id;
  }
  const bsdf = ma.tree.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled');
  const base = (bsdf?.inputs['Base Color'] as number[] | undefined) ?? [0.8, 0.8, 0.8, 1];
  const color = opts.color ?? ([base[0], base[1], base[2], 1] as [number, number, number, number]);
  const img = newImage(opts.name ?? `${ma.name} Base Color`, opts.width ?? 1024, opts.height ?? 1024, 'BLANK', color);
  doc.images[img.id] = img;
  const node: NodeData = {
    id: uid('node'),
    type: 'ShaderNodeTexImage',
    name: 'Image Texture',
    location: [(bsdf?.location[0] ?? 0) - 320, bsdf?.location[1] ?? 300],
    inputs: {},
    props: {
      image: img.id,
      interpolation: 'Linear',
      projection: 'FLAT',
      extension: 'REPEAT',
    },
  };
  ma.tree.nodes.push(node);
  ma.tree.active_node = node.id;
  if (bsdf) {
    ma.tree.links = ma.tree.links.filter((l) => !(l.to_node === bsdf.id && l.to_socket === 'Base Color'));
    ma.tree.links.push({
      id: uid('link'),
      from_node: node.id,
      from_socket: 'Color',
      to_node: bsdf.id,
      to_socket: 'Base Color',
    });
  }
  ma.use_nodes = true;
  return img;
}

// ---------------------------------------------------------------------------
// persisting painted pixels

let saving: Promise<void> = Promise.resolve();

/** Encode the canvas into the image bytes (async), then push the undo step. */
export function commitImage(img: Img, label: string | null): Promise<void> {
  touchImage(img);
  saving = saving.then(async () => {
    const live = app.doc.images[img.id];
    if (!live) return;
    try {
      const bytes = await encodeImage(live);
      live.bytes = bytes;
      live.mime = 'image/png';
      live.source = 'FILE';
      // keep the cached canvas (pixels are already current) instead of decoding the bytes again
      touchImage(live);
    } catch (e) {
      app.report('ERROR', `Could not store painted image: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (label) app.pushUndo(label);
    app.changed('doc');
  });
  return saving;
}

export function pendingImageSaves() {
  return saving;
}

// ---------------------------------------------------------------------------
// stroke

interface TexStroke {
  img: Img;
  W: number;
  H: number;
  ctx: CanvasRenderingContext2D;
  work: globalThis.ImageData;
  orig: Uint8ClampedArray;
  alpha: Float32Array;
  dirty: [number, number, number, number];
}

function screenMatrix(s: MeshSession, v: View3D): Matrix4 {
  const cam = v.camera;
  cam.updateMatrixWorld();
  return new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(s.world());
}

/** Project local point to (x, y, ndc z); returns false behind the camera. */
function proj(e: number[], x: number, y: number, z: number, W: number, H: number, out: number[]): boolean {
  const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
  const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
  const cz = e[2] * x + e[6] * y + e[10] * z + e[14];
  const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
  if (cw <= 1e-9) return false;
  out[0] = ((cx / cw) * 0.5 + 0.5) * W;
  out[1] = ((-cy / cw) * 0.5 + 0.5) * H;
  out[2] = cz / cw;
  return true;
}

export function texturePaintStroke(v: View3D, e: PointerEvent): boolean {
  const am = activeMeshData();
  const b = activeBrush('TEXTURE_PAINT');
  const s = meshSession();
  if (!am || !b || !s) return false;
  const { ob, me } = am;
  if (!meshHasUVs(me)) {
    app.report('ERROR', 'Missing UVs: unwrap the mesh before texture painting');
    return true;
  }
  let img = paintImage(ob);
  if (!img) {
    app.report('ERROR', 'Missing texture: add a paint slot (Texture Slots panel)');
    return true;
  }
  img = app.doc.images[img.id];
  const canvas = imageCanvas(img);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const W = canvas.width,
    H = canvas.height;
  const work = ctx.getImageData(0, 0, W, H);
  const st: TexStroke = {
    img,
    W,
    H,
    ctx,
    work,
    orig: work.data.slice(),
    alpha: new Float32Array(W * H),
    dirty: [Infinity, Infinity, -1, -1],
  };
  const ts = app.doc.scene.tool_settings;
  const invert = e.ctrlKey || e.metaKey;
  const tool = e.shiftKey ? 'SOFTEN' : b.sculpt_tool;
  let clone: DabOpts['clone'];
  if (tool === 'CLONE') {
    const p0 = v.local(e);
    const h0 = s.raycast(v, p0.x, p0.y);
    if (invert) {
      // Ctrl+click: pick the clone source
      if (h0) {
        cloneSource.uv = hitUV(s, me, h0.tri, h0.point);
        cloneSource.world = h0.world.clone();
        v.drawSvg();
      }
      return true;
    }
    if (!cloneSource.uv || !h0) {
      if (!cloneSource.uv) app.report('INFO', 'Clone: Ctrl+click on the mesh to set the source first');
      return true;
    }
    const startUV = hitUV(s, me, h0.tri, h0.point);
    const srcImg = b.clone_image ? app.doc.images[b.clone_image] : null;
    let data: Uint8ClampedArray = st.orig,
      sw = W,
      sh = H;
    if (srcImg && srcImg.id !== img.id) {
      const c2 = imageCanvas(srcImg);
      const x2 = c2.getContext('2d', { willReadFrequently: true });
      if (x2) {
        data = x2.getImageData(0, 0, c2.width, c2.height).data;
        sw = c2.width;
        sh = c2.height;
      }
    }
    clone = { data, W: sw, H: sh, du: cloneSource.uv[0] - startUV[0], dv: cloneSource.uv[1] - startUV[1] };
  }
  const colLin = invert ? ts.unified_paint.secondary_color : ts.unified_paint.color;
  const color = [linearToSrgb(colLin[0]), linearToSrgb(colLin[1]), linearToSrgb(colLin[2])];
  const mode = (b.blend ?? 'MIX') as BlendMode;
  let lastUV: [number, number] | null = null;
  let filled = false;
  runStroke(v, e, {
    spacing: () => (tool === 'FILL' ? 0 : Math.max(1, b.spacing || 10)),
    radiusPx: () => b.radius,
    settings: () => (tool === 'FILL' ? {} : b),
    dab: (d) => {
      if (tool === 'FILL') {
        if (!filled) fillAll(s, me, st, color, mode, b.strength);
        filled = true;
        return;
      }
      const hit = s.raycast(v, d.x, d.y);
      if (!hit) {
        lastUV = null;
        return;
      }
      const uv = hitUV(s, me, hit.tri, hit.point);
      const delta: [number, number] | null = lastUV ? [uv[0] - lastUV[0], uv[1] - lastUV[1]] : null;
      paintDab(s, v, me, st, b, {
        x: d.x,
        y: d.y,
        hitLocal: hit.point,
        strength: Math.max(0, b.strength) * d.pressure,
        tool,
        color,
        mode,
        uvDelta: delta,
        radius: brushRadiusPx(b, s, v, hit.world) * (d.sizeFactor ?? 1),
        clone,
      });
      lastUV = uv;
    },
    update: () => flushCanvas(st),
    cancel: () => {
      // put the original pixels back
      st.work.data.set(st.orig);
      st.dirty = [0, 0, st.W - 1, st.H - 1];
      flushCanvas(st);
    },
    end: () => {
      flushCanvas(st);
      void commitImage(st.img, 'Texture Paint');
    },
  });
  return true;
}

function hitUV(s: MeshSession, me: MeshData, tri: number, p: Vector3): [number, number] {
  const P = s.positions;
  const c0 = s.triCorners[tri * 3],
    c1 = s.triCorners[tri * 3 + 1],
    c2 = s.triCorners[tri * 3 + 2];
  const a = new Vector3().fromArray(P, me.indices[c0] * 3),
    b = new Vector3().fromArray(P, me.indices[c1] * 3),
    c = new Vector3().fromArray(P, me.indices[c2] * 3);
  const v0 = b.clone().sub(a),
    v1 = c.clone().sub(a),
    v2 = p.clone().sub(a);
  const d00 = v0.dot(v0),
    d01 = v0.dot(v1),
    d11 = v1.dot(v1),
    d20 = v2.dot(v0),
    d21 = v2.dot(v1);
  const den = d00 * d11 - d01 * d01 || 1;
  const w1 = (d11 * d20 - d01 * d21) / den,
    w2 = (d00 * d21 - d01 * d20) / den,
    w0 = 1 - w1 - w2;
  const U = me.uvs;
  return [U[c0 * 2] * w0 + U[c1 * 2] * w1 + U[c2 * 2] * w2, U[c0 * 2 + 1] * w0 + U[c1 * 2 + 1] * w1 + U[c2 * 2 + 1] * w2];
}

function flushCanvas(st: TexStroke) {
  const [x0, y0, x1, y1] = st.dirty;
  if (x1 < x0) return;
  st.ctx.putImageData(st.work, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  st.dirty = [Infinity, Infinity, -1, -1];
  // refresh the GPU texture without bumping the image revision (no material rebuild mid-stroke)
  imageTexture(st.img).needsUpdate = true;
  app.changed('ui');
}

function markDirty(st: TexStroke, x: number, y: number) {
  const d = st.dirty;
  if (x < d[0]) d[0] = x;
  if (y < d[1]) d[1] = y;
  if (x > d[2]) d[2] = x;
  if (y > d[3]) d[3] = y;
}

interface DabOpts {
  x: number;
  y: number;
  hitLocal: Vector3;
  strength: number;
  tool: string;
  color: number[];
  mode: BlendMode;
  uvDelta: [number, number] | null;
  /** brush radius in pixels for this dab */
  radius: number;
  /** clone: source pixels and the texel offset from the painted texel to its source */
  clone?: { data: Uint8ClampedArray; W: number; H: number; du: number; dv: number };
}

/** Clone source picked with Ctrl+click (UV of the paint texture, plus the world point for the marker). */
export const cloneSource = { uv: null as [number, number] | null, world: null as Vector3 | null };

/** Texels painted beyond triangle edges to hide UV seams (Options ▸ Bleed). */
export const imagePaintOptions = { seam_bleed: 2 };

/** Rasterize triangle `t` in texel space, calling fn(texelIndex, x, y, b0, b1, b2) per texel. */
function rasterTri(st: TexStroke, me: MeshData, s: MeshSession, t: number, fn: (i: number, x: number, y: number, b0: number, b1: number, b2: number) => void) {
  const U = me.uvs;
  const c0 = s.triCorners[t * 3],
    c1 = s.triCorners[t * 3 + 1],
    c2 = s.triCorners[t * 3 + 2];
  const W = st.W,
    H = st.H;
  // texel space (y down, v up)
  const ax = U[c0 * 2] * W,
    ay = (1 - U[c0 * 2 + 1]) * H,
    bx = U[c1 * 2] * W,
    by = (1 - U[c1 * 2 + 1]) * H,
    cx = U[c2 * 2] * W,
    cy = (1 - U[c2 * 2 + 1]) * H;
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-12) return;
  const BLEED = imagePaintOptions.seam_bleed;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx) - BLEED)),
    maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx) + BLEED)),
    minY = Math.max(0, Math.floor(Math.min(ay, by, cy) - BLEED)),
    maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy) + BLEED));
  if ((maxX - minX + 1) * (maxY - minY + 1) > 4e6) return;
  // edge lengths for the bleed margin (distance in texels)
  const lab = Math.hypot(bx - ax, by - ay) || 1,
    lbc = Math.hypot(cx - bx, cy - by) || 1,
    lca = Math.hypot(ax - cx, ay - cy) || 1;
  const sgn = area > 0 ? 1 : -1;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      // signed distances to the edges (positive inside)
      const eab = (((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * sgn) / lab;
      const ebc = (((cx - bx) * (py - by) - (cy - by) * (px - bx)) * sgn) / lbc;
      const eca = (((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * sgn) / lca;
      if (eab < -BLEED || ebc < -BLEED || eca < -BLEED) continue;
      // barycentric (clamped to the triangle for texels in the bleed margin)
      let b0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
      let b1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
      let b2 = 1 - b0 - b1;
      if (b0 < 0 || b1 < 0 || b2 < 0) {
        b0 = Math.max(0, b0);
        b1 = Math.max(0, b1);
        b2 = Math.max(0, b2);
        const s2 = b0 + b1 + b2 || 1;
        b0 /= s2;
        b1 /= s2;
        b2 /= s2;
      }
      fn(y * W + x, x, y, b0, b1, b2);
    }
  }
}

function paintDab(s: MeshSession, v: View3D, me: MeshData, st: TexStroke, b: PaintBrush, o: DabOpts) {
  const M0 = screenMatrix(s, v);
  const Wv = v.width,
    Hv = v.height;
  const r = o.radius;
  const P = s.positions;
  const sym = app.doc.scene.tool_settings.sculpt;
  const tmp = [0, 0, 0];
  const centers: [number, number][] = [[o.x, o.y]];
  const camPos0 = new Vector3().setFromMatrixPosition(v.camera.matrixWorld).applyMatrix4(s.world().clone().invert());
  const ortho = (v.camera as { isOrthographicCamera?: boolean }).isOrthographicCamera === true;
  const viewDir0 = new Vector3(0, 0, -1).transformDirection(v.camera.matrixWorld).transformDirection(s.world().clone().invert());
  // symmetry: paint the mirrored mesh from the same viewpoint (a mirrored camera in object space)
  const passes = symmetryPasses(sym.use_symmetry_x, sym.use_symmetry_y, sym.use_symmetry_z);
  for (const sg of o.tool === 'SMEAR' ? passes.slice(0, 1) : passes) {
    const M = M0.clone().multiply(new Matrix4().makeScale(sg[0], sg[1], sg[2])).elements;
    const camPosLocal = new Vector3(camPos0.x * sg[0], camPos0.y * sg[1], camPos0.z * sg[2]);
    const viewDirLocal = new Vector3(viewDir0.x * sg[0], viewDir0.y * sg[1], viewDir0.z * sg[2]);
    // candidate triangles: screen bbox overlaps a brush circle, facing the viewer
    const ntri = s.tris.length / 3;
    const sp = new Float32Array(9);
    const cand: number[] = [];
    const projected: Float32Array[] = [];
    const allowedF = s.paintFaces;
    for (let t = 0; t < ntri; t++) {
      if (allowedF && !allowedF[s.triFace[t]]) continue;
      let ok = true;
      for (let k = 0; k < 3; k++) {
        const vi = s.tris[t * 3 + k] * 3;
        if (!proj(M, P[vi], P[vi + 1], P[vi + 2], Wv, Hv, tmp)) {
          ok = false;
          break;
        }
        sp[k * 3] = tmp[0];
        sp[k * 3 + 1] = tmp[1];
        sp[k * 3 + 2] = tmp[2];
      }
      if (!ok) continue;
      const minX = Math.min(sp[0], sp[3], sp[6]),
        maxX = Math.max(sp[0], sp[3], sp[6]),
        minY = Math.min(sp[1], sp[4], sp[7]),
        maxY = Math.max(sp[1], sp[4], sp[7]);
      let hitC = false;
      for (const [cx, cy] of centers)
        if (maxX >= cx - r && minX <= cx + r && maxY >= cy - r && minY <= cy + r) {
          hitC = true;
          break;
        }
      if (!hitC) continue;
      if (b.use_backface_culling !== false) {
        const f = s.triFace[t];
        const nx = s.fn[f * 3],
          ny = s.fn[f * 3 + 1],
          nz = s.fn[f * 3 + 2];
        const vi = s.tris[t * 3] * 3;
        const d = ortho ? -(nx * viewDirLocal.x + ny * viewDirLocal.y + nz * viewDirLocal.z) : nx * (camPosLocal.x - P[vi]) + ny * (camPosLocal.y - P[vi + 1]) + nz * (camPosLocal.z - P[vi + 2]);
        if (d <= 0) continue;
      }
      cand.push(t);
      projected.push(sp.slice());
    }
    if (!cand.length) continue;
    // software depth buffer over the union of the brush footprints
    let bx0 = Infinity,
      by0 = Infinity,
      bx1 = -Infinity,
      by1 = -Infinity;
    for (const [cx, cy] of centers) {
      bx0 = Math.min(bx0, Math.floor(cx - r - 1));
      by0 = Math.min(by0, Math.floor(cy - r - 1));
      bx1 = Math.max(bx1, Math.ceil(cx + r + 1));
      by1 = Math.max(by1, Math.ceil(cy + r + 1));
    }
    const DW = bx1 - bx0 + 1,
      DH = by1 - by0 + 1;
    const occlude = b.use_occlude !== false && DW * DH < 4e6;
    const depth = occlude ? new Float32Array(DW * DH).fill(Infinity) : null;
    if (depth)
      for (const q of projected) {
        const ax = q[0] - bx0,
          ay = q[1] - by0,
          bxx = q[3] - bx0,
          byy = q[4] - by0,
          cx = q[6] - bx0,
          cy = q[7] - by0;
        const area = (bxx - ax) * (cy - ay) - (byy - ay) * (cx - ax);
        if (Math.abs(area) < 1e-9) continue;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bxx, cx))),
          x1 = Math.min(DW - 1, Math.ceil(Math.max(ax, bxx, cx))),
          y0 = Math.max(0, Math.floor(Math.min(ay, byy, cy))),
          y1 = Math.min(DH - 1, Math.ceil(Math.max(ay, byy, cy)));
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5,
              py = y + 0.5;
            const w0 = ((bxx - px) * (cy - py) - (byy - py) * (cx - px)) / area,
              w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area,
              w2 = 1 - w0 - w1;
            if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
            const z = w0 * q[2] + w1 * q[5] + w2 * q[8];
            const i = y * DW + x;
            if (z < depth[i]) depth[i] = z;
          }
      }
    const data = st.work.data,
      orig = st.orig,
      alpha = st.alpha;
    const fo = b.falloff,
      hard = b.hardness ?? 0;
    const out = [0, 0, 0, 1];
    const dst = [0, 0, 0, 1];
    const src = o.tool === 'TEXDRAW' ? data : data.slice(0); // snapshot for soften / smear sampling
    const r2 = r * r;
    const accumulate = !!b.use_accumulate;
    for (const t of cand) {
      const i0 = s.tris[t * 3] * 3,
        i1 = s.tris[t * 3 + 1] * 3,
        i2 = s.tris[t * 3 + 2] * 3;
      rasterTri(st, me, s, t, (ti, x, y, b0, b1, b2) => {
        const lx = P[i0] * b0 + P[i1] * b1 + P[i2] * b2,
          ly = P[i0 + 1] * b0 + P[i1 + 1] * b1 + P[i2 + 1] * b2,
          lz = P[i0 + 2] * b0 + P[i1 + 2] * b1 + P[i2 + 2] * b2;
        if (!proj(M, lx, ly, lz, Wv, Hv, tmp)) return;
        let best = 0;
        for (const [cx, cy] of centers) {
          const dx = tmp[0] - cx,
            dy = tmp[1] - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r2) continue;
          const f = falloff(fo, Math.sqrt(d2) / r, hard);
          if (f > best) best = f;
        }
        if (best <= 0) return;
        if (depth) {
          const sx = Math.floor(tmp[0]) - bx0,
            sy = Math.floor(tmp[1]) - by0;
          if (sx >= 0 && sy >= 0 && sx < DW && sy < DH) {
            const dz = depth[sy * DW + sx];
            if (dz !== Infinity && tmp[2] > dz + 2e-4 + Math.abs(dz) * 1e-4) return;
          }
        }
        const a = best * o.strength;
        const p = ti * 4;
        if (o.tool === 'TEXDRAW') {
          const sa = accumulate ? Math.min(1, alpha[ti] + a) : Math.max(alpha[ti], a);
          if (!accumulate && sa <= alpha[ti]) return;
          alpha[ti] = sa;
          dst[0] = orig[p] / 255;
          dst[1] = orig[p + 1] / 255;
          dst[2] = orig[p + 2] / 255;
          dst[3] = orig[p + 3] / 255;
          blendColor(o.mode, dst, o.color, sa, out);
        } else if (o.tool === 'SOFTEN') {
          const W = st.W,
            H = st.H;
          let rr = 0,
            gg = 0,
            bb = 0,
            aa = 0,
            n = 0;
          for (let oy = -1; oy <= 1; oy++)
            for (let ox = -1; ox <= 1; ox++) {
              const xx = Math.min(W - 1, Math.max(0, x + ox)),
                yy = Math.min(H - 1, Math.max(0, y + oy));
              const q = (yy * W + xx) * 4;
              rr += src[q];
              gg += src[q + 1];
              bb += src[q + 2];
              aa += src[q + 3];
              n++;
            }
          const k = Math.min(1, a);
          out[0] = (src[p] + (rr / n - src[p]) * k) / 255;
          out[1] = (src[p + 1] + (gg / n - src[p + 1]) * k) / 255;
          out[2] = (src[p + 2] + (bb / n - src[p + 2]) * k) / 255;
          out[3] = (src[p + 3] + (aa / n - src[p + 3]) * k) / 255;
        } else if (o.tool === 'CLONE' && o.clone) {
          const cl = o.clone;
          // texel → uv → shifted uv → source texel (wrapping)
          const u = (x + 0.5) / st.W + cl.du,
            vv = 1 - (y + 0.5) / st.H + cl.dv;
          const sx = Math.min(cl.W - 1, Math.floor((((u % 1) + 1) % 1) * cl.W)),
            sy = Math.min(cl.H - 1, Math.floor((1 - (((vv % 1) + 1) % 1)) * cl.H));
          const q = (sy * cl.W + sx) * 4;
          const sa = accumulate ? Math.min(1, alpha[ti] + a) : Math.max(alpha[ti], a);
          if (!accumulate && sa <= alpha[ti]) return;
          alpha[ti] = sa;
          for (let c = 0; c < 4; c++) out[c] = (orig[p + c] + (cl.data[q + c] - orig[p + c]) * sa) / 255;
        } else if (o.tool === 'SMEAR') {
          if (!o.uvDelta) return;
          const W = st.W,
            H = st.H;
          const sx = Math.min(W - 1, Math.max(0, Math.round(x - o.uvDelta[0] * W))),
            sy = Math.min(H - 1, Math.max(0, Math.round(y + o.uvDelta[1] * H)));
          const q = (sy * W + sx) * 4;
          const k = Math.min(1, a);
          for (let c = 0; c < 4; c++) out[c] = (src[p + c] + (src[q + c] - src[p + c]) * k) / 255;
        } else return;
        data[p] = Math.round(out[0] * 255);
        data[p + 1] = Math.round(out[1] * 255);
        data[p + 2] = Math.round(out[2] * 255);
        data[p + 3] = Math.round(out[3] * 255);
        markDirty(st, x, y);
      });
    }
  }
}

/** Fill tool: blend the color into every texel covered by the mesh UVs. */
function fillAll(s: MeshSession, me: MeshData, st: TexStroke, color: number[], mode: BlendMode, strength: number) {
  const data = st.work.data,
    orig = st.orig;
  const dst = [0, 0, 0, 1],
    out = [0, 0, 0, 1];
  const ntri = s.tris.length / 3;
  for (let t = 0; t < ntri; t++)
    if (!s.paintFaces || s.paintFaces[s.triFace[t]])
    rasterTri(st, me, s, t, (ti, x, y) => {
      const p = ti * 4;
      for (let c = 0; c < 4; c++) dst[c] = orig[p + c] / 255;
      blendColor(mode, dst, color, Math.min(1, strength), out);
      for (let c = 0; c < 4; c++) data[p + c] = Math.round(out[c] * 255);
      markDirty(st, x, y);
    });
}

/** Sample the color under the cursor from the paint image (Shift X). */
export function sampleImageColor(v: View3D, x: number, y: number): boolean {
  const am = activeMeshData();
  const s = meshSession();
  const img = paintImage();
  if (!am || !s || !img || !meshHasUVs(am.me)) return false;
  const hit = s.raycast(v, x, y);
  if (!hit) return false;
  const uv = hitUV(s, am.me, hit.tri, hit.point);
  const c = imageCanvas(img);
  const px = Math.min(c.width - 1, Math.max(0, Math.floor((((uv[0] % 1) + 1) % 1) * c.width)));
  const py = Math.min(c.height - 1, Math.max(0, Math.floor((1 - (((uv[1] % 1) + 1) % 1)) * c.height)));
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(px, py, 1, 1).data;
  app.doc.scene.tool_settings.unified_paint.color = [srgbToLinear(d[0] / 255), srgbToLinear(d[1] / 255), srgbToLinear(d[2] / 255)];
  return true;
}

registerOperators([
  {
    idname: 'paint.add_texture_paint_slot',
    label: 'Add Texture Paint Slot',
    description: 'Add an image texture (linked to Base Color) to paint on',
    props: [
      { id: 'name', label: 'Name', type: 'string', default: '' },
      {
        id: 'width',
        label: 'Width',
        type: 'int',
        default: 1024,
        min: 1,
        max: 16384,
        subtype: 'pixel',
      },
      {
        id: 'height',
        label: 'Height',
        type: 'int',
        default: 1024,
        min: 1,
        max: 16384,
        subtype: 'pixel',
      },
      { id: 'color', label: 'Color', type: 'color', default: [0, 0, 0, 1] },
      {
        id: 'use_material_color',
        label: 'Use Material Color',
        type: 'bool',
        default: true,
      },
    ],
    poll: () => app.activeObject?.type === 'MESH',
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const img = addPaintSlot(ob, {
        width: p.width as number,
        height: p.height as number,
        name: (p.name as string) || undefined,
        color: p.use_material_color ? undefined : (p.color as [number, number, number, number]),
      });
      if (!img) return 'CANCELLED';
      paintDisplay.image = img.id;
    },
  },
]);

// ---------------------------------------------------------------------------
// Project Image: paint an image onto the texture as seen from the current view

function projectImage(v: View3D, src: Img): string | null {
  const am = activeMeshData();
  const s = meshSession();
  if (!am || !s) return 'No mesh';
  const { ob, me } = am;
  if (!meshHasUVs(me)) return 'The mesh has no UVs';
  const img0 = paintImage(ob);
  if (!img0) return 'No paint texture';
  const img = app.doc.images[img0.id];
  const canvas = imageCanvas(img);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const W = canvas.width,
    H = canvas.height;
  const work = ctx.getImageData(0, 0, W, H);
  const st: TexStroke = { img, W, H, ctx, work, orig: work.data.slice(), alpha: new Float32Array(W * H), dirty: [Infinity, Infinity, -1, -1] };
  const sc = imageCanvas(src);
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  if (!sctx) return 'Could not read the image';
  const sd = sctx.getImageData(0, 0, sc.width, sc.height).data;
  const M = screenMatrix(s, v).elements;
  const Wv = Math.max(1, Math.round(v.width)),
    Hv = Math.max(1, Math.round(v.height));
  // software depth buffer of the whole view (nearest surface per pixel)
  const depth = new Float32Array(Wv * Hv).fill(Infinity);
  const P = s.positions;
  const tmp = [0, 0, 0];
  const sp = new Float32Array(9);
  const ntri = s.tris.length / 3;
  for (let t = 0; t < ntri; t++) {
    let ok = true;
    for (let k = 0; k < 3; k++) {
      const vi = s.tris[t * 3 + k] * 3;
      if (!proj(M, P[vi], P[vi + 1], P[vi + 2], Wv, Hv, tmp)) {
        ok = false;
        break;
      }
      sp[k * 3] = tmp[0];
      sp[k * 3 + 1] = tmp[1];
      sp[k * 3 + 2] = tmp[2];
    }
    if (!ok) continue;
    const area = (sp[3] - sp[0]) * (sp[7] - sp[1]) - (sp[4] - sp[1]) * (sp[6] - sp[0]);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(sp[0], sp[3], sp[6]))),
      x1 = Math.min(Wv - 1, Math.ceil(Math.max(sp[0], sp[3], sp[6]))),
      y0 = Math.max(0, Math.floor(Math.min(sp[1], sp[4], sp[7]))),
      y1 = Math.min(Hv - 1, Math.ceil(Math.max(sp[1], sp[4], sp[7])));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5,
          py = y + 0.5;
        const w0 = ((sp[3] - px) * (sp[7] - py) - (sp[4] - py) * (sp[6] - px)) / area,
          w1 = ((sp[6] - px) * (sp[1] - py) - (sp[7] - py) * (sp[0] - px)) / area,
          w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const z = w0 * sp[2] + w1 * sp[5] + w2 * sp[8];
        const i = y * Wv + x;
        if (z < depth[i]) depth[i] = z;
      }
  }
  const data = work.data;
  for (let t = 0; t < ntri; t++) {
    const i0 = s.tris[t * 3] * 3,
      i1 = s.tris[t * 3 + 1] * 3,
      i2 = s.tris[t * 3 + 2] * 3;
    rasterTri(st, me, s, t, (ti, x, y, b0, b1, b2) => {
      const lx = P[i0] * b0 + P[i1] * b1 + P[i2] * b2,
        ly = P[i0 + 1] * b0 + P[i1 + 1] * b1 + P[i2 + 1] * b2,
        lz = P[i0 + 2] * b0 + P[i1 + 2] * b1 + P[i2 + 2] * b2;
      if (!proj(M, lx, ly, lz, Wv, Hv, tmp)) return;
      const sx = Math.floor(tmp[0]),
        sy = Math.floor(tmp[1]);
      if (sx < 0 || sy < 0 || sx >= Wv || sy >= Hv) return;
      const dz = depth[sy * Wv + sx];
      if (dz !== Infinity && tmp[2] > dz + 2e-4 + Math.abs(dz) * 1e-4) return;
      // the image stretched over the whole view
      const ix = Math.min(sc.width - 1, Math.floor((tmp[0] / Wv) * sc.width)),
        iy = Math.min(sc.height - 1, Math.floor((tmp[1] / Hv) * sc.height));
      const q = (iy * sc.width + ix) * 4;
      const a = sd[q + 3] / 255;
      const p = ti * 4;
      for (let c = 0; c < 3; c++) data[p + c] = Math.round(st.orig[p + c] + (sd[q + c] - st.orig[p + c]) * a);
      data[p + 3] = Math.max(st.orig[p + 3], sd[q + 3]);
      markDirty(st, x, y);
    });
  }
  flushCanvas(st);
  void commitImage(img, 'Project Image');
  return null;
}

registerOperators([
  {
    idname: 'paint.project_image',
    label: 'Project Image',
    description: 'Paint an image onto the texture as seen from the current view (stretched over the view)',
    props: [{ id: 'image', label: 'Image', type: 'string', default: '' }],
    undo: false,
    poll: () => app.doc.mode === 'TEXTURE_PAINT' && !!activeView3D() && Object.keys(app.doc.images).length > 0,
    invoke: (ctx, p) => {
      if (p.image && app.doc.images[p.image as string]) return operators.get('paint.project_image')!.exec!(ctx, p);
      // pick the image from a menu
      const cur = paintImage()?.id;
      openMenu(
        Object.values(app.doc.images)
          .filter((im) => im.id !== cur)
          .map((im) => ({ label: im.name, icon: 'image', action: () => app.run('paint.project_image', { image: im.id }) })),
        { x: ctx.event?.x ?? app.pointer.x, y: ctx.event?.y ?? app.pointer.y },
        { title: 'Project Image' },
      );
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const v = activeView3D();
      const src = app.doc.images[p.image as string];
      if (!v || !src) return 'CANCELLED';
      const err = projectImage(v, src);
      if (err) {
        app.report('ERROR', `Project Image: ${err}`);
        return 'CANCELLED';
      }
      return 'CANCELLED';
    },
  },
]);
