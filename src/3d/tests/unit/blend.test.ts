// .blend import: container parsing, robustness, and a full cross-check of the converted
// document against the expected values for the same file
// (tests/fixtures/blend/scene.json, written by tests/fixtures/blend/make_scene.py).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { Matrix4 } from 'three';
import { BlendFile, decompressBlend, BlendError } from '../../src/io/blend/reader';
import { parseHeader, detectCompression, readBHeads } from '../../src/io/blend/container';
import { convertBlend, readBlend, type BlendImport } from '../../src/io/blend/convert';
import { appendBlend } from '../../src/io/blend/append';
import { startupDocument } from '../../src/data/defaults';
import { localMatrix } from '../../src/eval/transform';
import { boneRestMatrix } from '../../src/eval/armature';
import type { DocumentData, ObjectData } from '../../src/data/types';

const dir = new URL('../fixtures/blend/', import.meta.url);
const fixture = (n: string) => new Uint8Array(readFileSync(new URL(n, dir)));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const E: any = JSON.parse(readFileSync(new URL('scene.json', dir), 'utf8'));

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-4) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i]), `index ${i}: ${a[i]} vs ${b[i]}`).toBeLessThanOrEqual(eps);
};
const byName = <T extends { name: string }>(rec: Record<string, T>, name: string) => {
  const x = Object.values(rec).find((v) => v.name === name);
  if (!x) throw new Error(`missing ${name}`);
  return x;
};

let raw: Uint8Array;
let imp: BlendImport;
let doc: DocumentData;
const ob = (n: string) => byName(doc.objects, n);

/** Rewrite a version 5.x (large block header) file into the classic 12-byte header / 24-byte BHead layout. */
function toClassic(bytes: Uint8Array): Uint8Array {
  const h = parseHeader(bytes);
  const blocks = readBHeads(bytes, h);
  const parts: Uint8Array[] = [new TextEncoder().encode(`BLENDER-v${String(h.version).padStart(3, '0')}`)];
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  let p = h.headerSize;
  for (const b of blocks) {
    const head = new Uint8Array(24);
    const hv = new DataView(head.buffer);
    head.set(bytes.subarray(p, p + 4), 0);
    hv.setInt32(4, b.len, true);
    head.set(bytes.subarray(p + 8, p + 16), 8); // old address
    hv.setUint32(16, b.sdna, true);
    hv.setInt32(20, b.count, true);
    parts.push(head, bytes.subarray(b.offset, b.offset + b.len));
    p = b.offset + b.len;
  }
  void dv;
  parts.push(new TextEncoder().encode('ENDB'), new Uint8Array(20));
  const total = parts.reduce((s, x) => s + x.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

beforeAll(async () => {
  raw = (await decompressBlend(fixture('scene_zstd.blend'))).bytes;
  imp = await readBlend(fixture('scene_zstd.blend'));
  doc = imp.doc;
});

describe('container', () => {
  it('detects compression and parses both header variants', () => {
    expect(detectCompression(fixture('scene_zstd.blend'))).toBe('zstd');
    expect(detectCompression(gzipSync(raw))).toBe('gzip');
    expect(detectCompression(raw)).toBe('none');
    const h = parseHeader(raw);
    expect(h).toMatchObject({ pointerSize: 8, littleEndian: true, version: 502, formatVersion: 1, headerSize: 17, largeBHead: true });
    expect(parseHeader(new TextEncoder().encode('BLENDER-v405'))).toMatchObject({ pointerSize: 8, littleEndian: true, version: 405, headerSize: 12, largeBHead: false });
    expect(parseHeader(new TextEncoder().encode('BLENDER_V279'))).toMatchObject({ pointerSize: 4, littleEndian: false, version: 279 });
  });

  it('reads SDNA and resolves struct layouts by name', () => {
    const f = new BlendFile(raw);
    const ob = f.structType('Object')!;
    expect(ob.byName.get('loc')!.nameInfo.dims).toEqual([3]);
    expect(ob.byName.get('parentinv')!.nameInfo.dims).toEqual([4, 4]);
    expect(ob.byName.get('parent')!.nameInfo.pointer).toBe(true);
    // every struct's fields add up to its declared size
    for (const s of f.sdna.structs) expect(s.fields.reduce((a, x) => a + x.size, 0)).toBe(s.size);
    expect(f.ids('OB').length).toBe(Object.keys(E.objects).length);
  });

  it('gives identical results for zstd, gzip, uncompressed and classic-header layouts', async () => {
    const variants = [raw, gzipSync(raw), toClassic(raw), zstdCompressSync ? zstdCompressSync(raw) : raw];
    for (const v of variants) {
      const r = await readBlend(new Uint8Array(v));
      expect(r.stats).toEqual(imp.stats);
      expect(Object.values(r.doc.objects).map((o) => o.name).sort()).toEqual(Object.values(doc.objects).map((o) => o.name).sort());
      const cube = byName(r.doc.meshes, 'CubeMesh');
      close(cube.positions, byName(doc.meshes, 'CubeMesh').positions, 0);
    }
    expect((await decompressBlend(gzipSync(raw))).compression).toBe('gzip');
  });

  it('reads a minimal library-written file (no window manager / UI blocks)', async () => {
    const r = await readBlend(fixture('scene_min_zstd.blend'));
    expect(r.sceneName).toBe('TestScene');
    expect(r.stats.objects).toBe(imp.stats.objects);
  });
});

describe('robustness', () => {
  it('rejects non-blend data with a clear error', async () => {
    await expect(readBlend(new TextEncoder().encode('hello world, not a blend'))).rejects.toThrow(/Not a .blend file/);
    await expect(readBlend(new Uint8Array(0))).rejects.toThrow(BlendError);
  });
  it('rejects truncated files', async () => {
    for (const frac of [0.01, 0.3, 0.7, 0.999]) {
      await expect(readBlend(raw.slice(0, Math.floor(raw.length * frac)))).rejects.toThrow(/Truncated|extends past end|Not a Blender/);
    }
  });
  it('rejects corrupt compressed data and corrupt SDNA', async () => {
    const z = fixture('scene_zstd.blend').slice();
    z.fill(0x55, 100, 4000);
    await expect(readBlend(z)).rejects.toThrow(BlendError);
    const g = gzipSync(raw).slice(0, 5000);
    await expect(readBlend(g)).rejects.toThrow(BlendError);
    const bad = raw.slice();
    const at = Buffer.from(bad).indexOf('SDNANAME');
    bad.set(new TextEncoder().encode('XXXX'), at + 4);
    await expect(readBlend(bad)).rejects.toThrow(/SDNA/);
  });
  it('guards against absurd block sizes', async () => {
    const bad = raw.slice();
    const h = parseHeader(bad);
    // first block header: set its 64-bit length to 2^60
    new DataView(bad.buffer).setUint32(h.headerSize + 16 + 4, 0x10000000, true);
    await expect(readBlend(bad)).rejects.toThrow(BlendError);
  });
});

describe('scene, collections and objects (vs expected)', () => {
  it('imports every object with type, parent and collection membership', () => {
    const names = Object.values(doc.objects).map((o) => o.name).sort();
    expect(names).toEqual(Object.keys(E.objects).sort());
    const typeMap: Record<string, string> = { MESH: 'MESH', EMPTY: 'EMPTY', LIGHT: 'LIGHT', CAMERA: 'CAMERA', CURVE: 'CURVE', FONT: 'FONT', ARMATURE: 'ARMATURE' };
    for (const [name, e] of Object.entries<any>(E.objects)) {
      const o = ob(name);
      expect(o.type, name).toBe(typeMap[e.type]);
      expect(o.parent ? doc.objects[o.parent].name : null, name).toBe(e.parent);
      const cols = Object.values(doc.collections).filter((c) => c.objects.includes(o.id)).map((c) => c.name);
      expect(cols.sort(), name).toEqual(e.collections.sort());
    }
  });

  it('matches transforms in all rotation modes, deltas and parent inverse', () => {
    for (const [name, e] of Object.entries<any>(E.objects)) {
      const o = ob(name);
      expect(o.rotation_mode, name).toBe(e.rotation_mode);
      close(o.location, e.location);
      close(o.rotation_euler, e.rotation_euler);
      close(o.rotation_quaternion, e.rotation_quaternion);
      close(o.rotation_axis_angle, e.rotation_axis_angle);
      close(o.scale, e.scale);
      close(o.delta_location, e.delta_location);
      close(o.delta_scale, e.delta_scale);
      close(o.matrix_parent_inverse, e.matrix_parent_inverse, 1e-3);
    }
  });

  it('reproduces the stored world matrices with this app’s transform math', () => {
    const world = (o: ObjectData): Matrix4 => {
      const local = localMatrix(o);
      if (!o.parent) return local;
      return world(doc.objects[o.parent]).multiply(new Matrix4().fromArray(o.matrix_parent_inverse)).multiply(local);
    };
    let checked = 0;
    for (const [name, e] of Object.entries<any>(E.objects)) {
      const o = ob(name);
      if (o.constraints.length || (o.parent && doc.objects[o.parent].type === 'ARMATURE')) continue;
      close(world(o).toArray(), e.matrix_world, 2e-3);
      checked++;
    }
    expect(checked).toBeGreaterThan(15);
  });

  it('maps visibility flags, view layer exclude/hide and collection settings', () => {
    for (const [name, e] of Object.entries<any>(E.objects)) {
      const o = ob(name);
      expect(o.hide_render, name).toBe(e.hide_render);
      expect(o.hide_select, name).toBe(e.hide_select);
      expect(o.hide_viewport, name).toBe(e.hide_viewport);
    }
    expect(ob('HiddenEmpty').hide).toBe(true);
    expect(ob('Cube').hide).toBe(false);
    for (const [name, e] of Object.entries<any>(E.collections)) {
      const c = name === 'Scene Collection' ? doc.collections[doc.scene.collection] : byName(doc.collections, name);
      expect(c.children.map((id) => doc.collections[id].name), name).toEqual(e.children);
      expect(c.objects.map((id) => doc.objects[id].name).sort(), name).toEqual(e.objects);
      if (name === 'Scene Collection') continue;
      expect(c.hide_render, name).toBe(e.hide_render);
      expect(c.hide_select, name).toBe(e.hide_select);
      expect(c.hide_viewport, name).toBe(e.hide_viewport);
      expect(c.color_tag, name).toBe(e.color_tag);
    }
    for (const [name, e] of Object.entries<any>(E.view_layer)) {
      const c = byName(doc.collections, name);
      expect(c.exclude, name).toBe(e.exclude);
      expect(c.hide, name).toBe(e.hide_viewport);
    }
  });

  it('imports empties, scene settings, world and active camera', () => {
    for (const [name, e] of Object.entries<any>(E.objects)) if (e.empty) expect([ob(name).empty_display_type, ob(name).empty_display_size], name).toEqual([e.empty[0], e.empty[1]]);
    const s = doc.scene;
    expect(s.name).toBe(E.scene.name);
    expect([s.frame_start, s.frame_end, s.render.fps]).toEqual([E.scene.frame_start, E.scene.frame_end, E.scene.fps]);
    expect([s.render.resolution_x, s.render.resolution_y, s.render.resolution_percentage]).toEqual(E.scene.resolution);
    expect(doc.objects[s.camera!].name).toBe(E.scene.camera);
    const w = doc.worlds[s.world!];
    const bg = w.tree.nodes.find((n) => n.type === 'ShaderNodeBackground')!;
    close(bg.inputs.Color as number[], E.scene.world[0]);
    expect(bg.inputs.Strength).toBeCloseTo(E.scene.world[1], 4);
    expect(w.tree.links.length).toBeGreaterThan(0);
  });
});

describe('meshes (vs expected)', () => {
  it('matches topology, positions and per-face data', () => {
    for (const [name, e] of Object.entries<any>(E.meshes)) {
      const m = byName(doc.meshes, name);
      expect(m.positions.length / 3, name).toBe(e.verts);
      expect(m.offsets.length - 1, name).toBe(e.faces);
      expect(m.indices.length, name).toBe(e.loops);
      close(m.positions, e.positions);
      expect(Array.from(m.indices), name).toEqual(e.corner_verts);
      expect(Array.from({ length: e.faces }, (_, i) => m.offsets[i + 1] - m.offsets[i]), name).toEqual(e.face_sizes);
      expect(Array.from(m.smooth ?? []), name).toEqual(e.smooth);
      expect(Array.from(m.material_index ?? []), name).toEqual(e.material_index);
      expect(m.materials.map((id) => (id ? doc.materials[id].name : null)), name).toEqual(e.materials);
      if (e.uv_layers.length) {
        expect(m.uv_map_name).toBe(e.uv_active);
        close(m.uvs, e.uv0);
      }
    }
  });

  it('maps seams, sharp edges and creases onto face corners', () => {
    const e = E.meshes.CubeMesh;
    const m = byName(doc.meshes, 'CubeMesh');
    const edgeKey = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;
    const collect = (arr: ArrayLike<number> | undefined) => {
      const s = new Map<string, number>();
      for (let f = 0; f < m.offsets.length - 1; f++)
        for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
          const n = c + 1 < m.offsets[f + 1] ? c + 1 : m.offsets[f];
          if (arr?.[c]) s.set(edgeKey(m.indices[c], m.indices[n]), arr[c]);
        }
      return s;
    };
    expect([...collect(m.seams).keys()].sort()).toEqual(e.seam_edges.map((x: number[]) => edgeKey(x[0], x[1])).sort());
    expect([...collect(m.sharp).keys()].sort()).toEqual(e.sharp_edges.map((x: number[]) => edgeKey(x[0], x[1])).sort());
    const creases = collect(m.creases);
    expect(creases.size).toBe(e.crease_edges.length);
    for (const [[a, b], v] of e.crease_edges) expect(creases.get(edgeKey(a, b))).toBeCloseTo(v, 4);
  });

  it('imports vertex groups, shape keys and color attributes', () => {
    const m = byName(doc.meshes, 'CubeMesh');
    const e = E.meshes.CubeMesh;
    expect(m.vertex_groups.map((g) => g.name)).toEqual(e.vertex_groups);
    e.vertex_groups.forEach((g: string, gi: number) => {
      for (let v = 0; v < 8; v++) expect(m.weights[gi][v], `${g}[${v}]`).toBeCloseTo(e.weights[g][String(v)] ?? 0, 5);
    });
    expect(m.shape_keys.map((k) => k.name)).toEqual(e.shape_keys.map((k: any) => k.name));
    e.shape_keys.forEach((k: any, i: number) => {
      const sk = m.shape_keys[i];
      expect(sk.value).toBeCloseTo(k.value, 5);
      expect(sk.slider_max).toBeCloseTo(k.slider_max, 5);
      expect(sk.relative_key).toBe(k.relative_key);
      expect(sk.vertex_group ?? '').toBe(k.vertex_group);
      close(sk.data.subarray(3, 6), k.co1);
    });
    expect(m.color_attributes.map((c) => [c.name, c.domain])).toEqual(e.color_attributes.map((c: any) => [c.name, c.domain]));
    e.color_attributes.forEach((c: any, i: number) => close(m.color_attributes[i].data.subarray(4, 8), c.first, 2e-3));
    expect(byName(doc.meshes, 'SkinMesh').vertex_groups.map((g) => g.name)).toEqual(['Mid']);
  });
});

describe('materials, images, lights, cameras (vs expected)', () => {
  it('converts node trees with node idnames, socket identifiers, values and links', () => {
    for (const [name, e] of Object.entries<any>(E.materials)) {
      const ma = byName(doc.materials, name);
      close(ma.diffuse_color, e.diffuse_color);
      expect(ma.metallic).toBeCloseTo(e.metallic, 5);
      expect(ma.roughness).toBeCloseTo(e.roughness, 5);
      expect(ma.tree.nodes.map((n) => n.name).sort()).toEqual(Object.keys(e.nodes).sort());
      for (const [nname, en] of Object.entries<any>(e.nodes)) {
        const n = ma.tree.nodes.find((x) => x.name === nname)!;
        expect(n.type).toBe(en.type);
        close(n.location, en.location, 0.01);
        for (const [id, v] of Object.entries<any>(en.inputs)) {
          if (v === null) continue;
          const got = n.inputs[id];
          if (Array.isArray(v)) close(got as number[], v);
          else if (typeof v === 'boolean') expect(got, `${nname}.${id}`).toBe(v);
          else expect(got as number, `${nname}.${id}`).toBeCloseTo(v, 4);
        }
      }
      const links = ma.tree.links.map((l) => [ma.tree.nodes.find((n) => n.id === l.from_node)!.name, l.from_socket, ma.tree.nodes.find((n) => n.id === l.to_node)!.name, l.to_socket]);
      expect(links.map((l) => l.join('|')).sort()).toEqual(e.links.map((l: string[]) => l.join('|')).sort());
    }
    const red = byName(doc.materials, 'Red Metal');
    const node = (n: string) => red.tree.nodes.find((x) => x.name === n)!;
    expect(node('MathNode').props.operation).toBe('POWER');
    expect(node('MixRGB').props).toMatchObject({ data_type: 'RGBA', blend_type: 'MULTIPLY' });
    expect(node('Tex').props.interpolation).toBe('Closest');
    expect((node('Ramp').props.color_ramp as number[]).slice(0, 5)).toEqual([0, expect.closeTo(0.1, 5), expect.closeTo(0.2, 5), expect.closeTo(0.3, 5), 1]);
    expect(doc.images[node('Tex').props.image as string].name).toBe('Checker');
  });

  it('embeds packed images and records external ones', () => {
    const packed = byName(doc.images, 'Checker');
    expect(packed.bytes?.length).toBeGreaterThan(50);
    expect(packed.mime).toBe('image/png');
    expect([packed.width, packed.height]).toEqual(E.images.Checker.size);
    const ext = byName(doc.images, 'External');
    expect(ext.bytes).toBeNull();
    expect(ext.filepath).toBe(E.images.External.filepath);
    expect(imp.warnings.some((w) => w.includes('External image files') && w.includes('External'))).toBe(true);
  });

  it('matches light and camera settings', () => {
    for (const [name, e] of Object.entries<any>(E.lights)) {
      const l = byName(doc.lights, name);
      expect(l.type).toBe(e.type);
      expect(l.energy).toBeCloseTo(e.energy, 4);
      close(l.color, e.color);
      expect(l.shadow_soft_size).toBeCloseTo(e.shadow_soft_size, 5);
      expect(l.use_shadow).toBe(e.use_shadow);
      if (e.type === 'SPOT') expect([l.spot_size, l.spot_blend, l.show_cone]).toEqual([expect.closeTo(e.spot_size, 5), expect.closeTo(e.spot_blend, 5), e.show_cone]);
      if (e.type === 'AREA') expect([l.shape, l.size, l.size_y]).toEqual([e.shape, e.size, e.size_y]);
      if (e.type === 'SUN') expect(l.angle).toBeCloseTo(e.angle, 5);
    }
    for (const [name, e] of Object.entries<any>(E.cameras)) {
      const c = byName(doc.cameras, name);
      expect(c.type).toBe(e.type);
      for (const k of ['lens', 'sensor_width', 'clip_start', 'clip_end', 'shift_x', 'shift_y', 'ortho_scale'] as const) expect(c[k], k).toBeCloseTo(e[k], 4);
      expect(c.sensor_fit).toBe(e.sensor_fit);
      expect([c.dof.use_dof, c.dof.focus_distance, c.dof.aperture_fstop, c.dof.aperture_blades]).toEqual([e.dof[0], expect.closeTo(e.dof[1], 4), expect.closeTo(e.dof[2], 4), e.dof[3]]);
      expect(c.dof.focus_object ? doc.objects[c.dof.focus_object].name : null).toBe(e.dof[4]);
    }
  });

  it('imports curves and text', () => {
    const cu = byName(doc.curves, 'BezCurve');
    expect(cu.splines.map((s) => s.type)).toEqual(['BEZIER', 'NURBS', 'POLY']);
    expect(cu.dimensions).toBe('3D');
    expect([cu.resolution_u, cu.bevel_depth, cu.extrude]).toEqual([8, expect.closeTo(0.1, 5), expect.closeTo(0.2, 5)]);
    const bz = cu.splines[0];
    expect(bz.use_cyclic_u).toBe(true);
    close(bz.bezier_points[2].co, [2, 1, 0]);
    close(bz.bezier_points[1].handle_left, [0.7, 0.5, 0.1]);
    expect(bz.bezier_points[1].handle_left_type).toBe('FREE');
    expect(bz.bezier_points[2].radius).toBeCloseTo(3, 5);
    const nu = cu.splines[1];
    expect([nu.order_u, nu.use_endpoint_u, nu.points.length]).toEqual([3, true, 4]);
    close(nu.points[3].co, [3, 0, 1, 1.3]);
    const tx = byName(doc.curves, 'TextData');
    expect([tx.body, tx.size, tx.align_x]).toEqual(['Hello Blend', 1.5, 'CENTER']);
  });
});

describe('armature, modifiers, constraints (vs expected)', () => {
  it('imports bones in armature space with matching rest matrices', () => {
    const rig = ob('Rig');
    const arm = doc.armatures[rig.data!];
    const e = E.objects.Rig;
    expect(arm.bones.map((b) => b.name).sort()).toEqual(Object.keys(e.bones).sort());
    for (const [name, eb] of Object.entries<any>(e.bones)) {
      const b = arm.bones.find((x) => x.name === name)!;
      close(b.head, eb.head);
      close(b.tail, eb.tail);
      expect(b.parent).toBe(eb.parent);
      expect(b.use_connect).toBe(eb.use_connect);
      expect(b.use_deform).toBe(eb.use_deform);
      expect([b.use_inherit_rotation, b.inherit_scale]).toEqual(e.bone_flags[name]);
      // rotation part of the expected bone.matrix_local equals this app's rest matrix (validates roll)
      const m = boneRestMatrix(b).toArray();
      close([...m.slice(0, 3), ...m.slice(4, 7), ...m.slice(8, 11)], [...eb.matrix_local.slice(0, 3), ...eb.matrix_local.slice(4, 7), ...eb.matrix_local.slice(8, 11)], 2e-3);
    }
    for (const [name, ep] of Object.entries<any>(e.pose)) {
      const pb = rig.pose![name];
      expect(pb.rotation_mode).toBe(ep.rotation_mode);
      close(pb.location, ep.location);
      close(pb.rotation_euler, ep.rotation_euler);
      close(pb.rotation_quaternion, ep.rotation_quaternion);
      close(pb.scale, ep.scale);
      expect(pb.constraints.map((c) => c.type)).toEqual(ep.constraints);
    }
    const ik = rig.pose!.Tip.constraints[0];
    expect([ik.chain_count, doc.objects[ik.target as string].name]).toEqual([2, 'ParentEmpty']);
  });

  it('maps modifier stacks with settings', () => {
    for (const [name, e] of Object.entries<any>(E.objects)) {
      const o = ob(name);
      expect(o.modifiers.map((m) => [m.name, m.type, m.show_viewport]), name).toEqual(e.modifiers.map((m: any) => [m.name, m.type, m.show_viewport]));
    }
    const m = (n: string) => ob('Cube').modifiers.find((x) => x.name === n)!;
    expect(m('Subsurf')).toMatchObject({ levels: 2, render_levels: 3, quality: 4, use_creases: true, use_limit_surface: true });
    expect(m('Mirror')).toMatchObject({ use_axis: [true, false, true], use_bisect_axis: [false, true, false], use_clip: true, use_mirror_merge: true });
    expect(m('Mirror').merge_threshold).toBeCloseTo(0.002, 6);
    expect(m('Array')).toMatchObject({ count: 3, use_relative_offset: true, use_constant_offset: true, use_merge_vertices: true });
    close(m('Array').relative_offset_displace as number[], [1.5, 0, 0]);
    close(m('Array').constant_offset_displace as number[], [0, 0.25, 0]);
    expect(m('Solidify')).toMatchObject({ use_even_offset: true, use_rim: true });
    expect(m('Solidify').thickness).toBeCloseTo(0.05, 6);
    expect(m('Bevel')).toMatchObject({ segments: 3 });
    expect(m('Displace')).toMatchObject({ direction: 'Z', vertex_group: 'Top', texture: null });
    expect(m('Smooth')).toMatchObject({ iterations: 4, use_x: true, use_y: false, use_z: true });
    expect(m('Wave')).toMatchObject({ use_x: true, use_y: false });
    expect(m('SimpleDeform')).toMatchObject({ deform_method: 'BEND', deform_axis: 'X' });
    expect(m('Triangulate')).toMatchObject({ quad_method: 'FIXED', min_vertices: 5 });
    expect(m('Weld')).toMatchObject({ mode: 'CONNECTED' });
    expect(m('EdgeSplit')).toMatchObject({ use_edge_angle: true, use_edge_sharp: false });
    expect(m('Screw')).toMatchObject({ steps: 8, render_steps: 12, axis: 'Y' });
    expect(m('Build')).toMatchObject({ frame_start: 3, frame_duration: 50, use_reverse: true });
    expect(m('Mask')).toMatchObject({ vertex_group: 'Top', invert_vertex_group: true });
    expect(m('Cast')).toMatchObject({ cast_type: 'CUBOID', use_z: false });
    const s = (n: string) => ob('Skin').modifiers.find((x) => x.name === n)!;
    expect(doc.objects[s('Armature').object as string].name).toBe('Rig');
    expect(s('Curve')).toMatchObject({ deform_axis: 'NEG_Y' });
    expect(s('Shrinkwrap')).toMatchObject({ wrap_method: 'PROJECT' });
    expect([doc.objects[s('Warp').object_from as string].name, doc.objects[s('Warp').object_to as string].name]).toEqual(['ParentEmpty', 'ChildEmpty']);
    expect(s('Hook').strength).toBeCloseTo(0.8, 5);
    expect(imp.warnings.some((w) => w.startsWith('Modifiers imported but not evaluated') && w.includes('Bevel'))).toBe(true);
  });

  it('maps constraints with settings', () => {
    for (const [name, e] of Object.entries<any>(E.objects)) {
      const o = ob(name);
      expect(o.constraints.map((c) => [c.name, c.type, Math.round(c.influence * 1000) / 1000, c.mute]), name).toEqual(e.constraints.map((c: any) => [c.name, c.type, c.influence, c.mute]));
    }
    const c = (n: string) => ob('Constrained').constraints.find((x) => x.name === n)!;
    expect(c('Copy Location')).toMatchObject({ use_x: true, use_y: false, use_z: true, invert_x: true, use_offset: true });
    expect(c('Copy Rotation')).toMatchObject({ mix_mode: 'ADD' });
    expect(c('Copy Scale').power).toBe(2);
    expect(c('Limit Location')).toMatchObject({ use_min_z: true, use_max_x: true, min_z: 0.5, max_x: 3 });
    expect(c('Limit Rotation')).toMatchObject({ use_limit_x: true, min_x: -0.5, max_x: 0.5 });
    expect(c('Track To')).toMatchObject({ track_axis: 'TRACK_NEGATIVE_Z', up_axis: 'UP_Y' });
    expect(c('Damped Track')).toMatchObject({ track_axis: 'TRACK_X' });
    expect(c('Child Of')).toMatchObject({ use_scale_x: false, use_scale_y: true, use_location_x: true });
    expect(c('Limit Distance')).toMatchObject({ distance: 2.5, limit_mode: 'LIMITDIST_OUTSIDE' });
    expect(ob('Follower').constraints[0]).toMatchObject({ type: 'FOLLOW_PATH', use_curve_follow: true, offset: 5, forward_axis: 'FORWARD_X' });
  });
});

describe('animation (vs expected, layered/slotted actions)', () => {
  it('assigns actions and converts F-curves from channelbags', () => {
    for (const [name, e] of Object.entries<any>(E.objects)) {
      const o = ob(name);
      if (name === 'Cube') continue; // shape-key action merged onto the object (checked below)
      expect(o.animation_data?.action ? doc.actions[o.animation_data.action].name : null, name).toBe(e.action);
    }
    for (const [aname, ea] of Object.entries<any>(E.actions)) {
      if (aname === 'NlaAction') continue;
      const act = byName(doc.actions, aname);
      for (const efc of ea.fcurves) {
        const fc = act.fcurves.find((f) => f.data_path.replace(/^data\.shape_keys\./, '') === efc.data_path && f.array_index === efc.array_index)!;
        expect(fc, `${aname} ${efc.data_path}[${efc.array_index}]`).toBeTruthy();
        expect(fc.extrapolation).toBe(efc.extrapolation);
        expect(fc.group ?? null).toBe(efc.group);
        expect(fc.keyframe_points.length).toBe(efc.keys.length);
        efc.keys.forEach((k: any, i: number) => {
          const kp = fc.keyframe_points[i];
          close(kp.co, k.co);
          close(kp.handle_left, k.hl);
          close(kp.handle_right, k.hr);
          expect([kp.interpolation, kp.easing, kp.handle_left_type, kp.handle_right_type]).toEqual([k.interpolation, k.easing, k.hlt, k.hrt]);
        });
      }
    }
    const cubeAct = doc.actions[ob('Cube').animation_data!.action!];
    expect(cubeAct.fcurves.map((f) => f.data_path)).toEqual(['data.shape_keys.key_blocks["Stretch"].value']);
    const rigAct = doc.actions[ob('Rig').animation_data!.action!];
    expect(rigAct.fcurves.every((f) => f.data_path === 'pose.bones["Mid"].rotation_euler')).toBe(true);
  });

  it('imports NLA tracks and strips', () => {
    const ad = ob('NlaObj').animation_data!;
    const e = E.objects.NlaObj.nla;
    expect(ad.nla_tracks.map((t) => [t.name, t.strips.map((s) => [s.name, doc.actions[s.action].name, s.frame_start, s.frame_end, s.repeat, s.blend_type])])).toEqual(e);
  });
});

// A version 4.3 .blend file (classic 12-byte header, 24-byte block headers, CustomData mesh
// layers) read from a local install path when present; the expectations below are for this file.
const LEGACY_43 = '/Applications/Blender.app/Contents/Resources/5.2/datafiles/assets/brushes/essentials_brushes-mesh_vertex.blend';
describe.skipIf(!existsSync(LEGACY_43))('version 4.3 .blend file (classic layout)', () => {
  it('reads the classic layout and CustomData mesh layers', async () => {
    const r = await readBlend(new Uint8Array(readFileSync(LEGACY_43)));
    expect(r.version).toBe('4.3');
    const suz = byName(r.doc.objects, 'Suzanne');
    const me = r.doc.meshes[suz.data!];
    expect([me.positions.length / 3, me.offsets.length - 1, me.indices.length]).toEqual([507, 500, 1968]);
    close(me.positions.subarray(0, 3), [0.4375, -0.765625, 0.1640625]);
    close(me.positions.subarray(300, 303), [-0.7109375, -0.625, 0.484375]);
    expect(Array.from(me.indices.subarray(0, 12))).toEqual([46, 0, 2, 44, 3, 1, 47, 45, 44, 2, 4, 42]);
    expect(Array.from(me.smooth!).reduce((a, b) => a + b, 0)).toBe(0);
    expect(me.uv_map_name).toBe('UVMap');
    close(me.uvs.subarray(10, 12), [0.8663139939308167, 0.8979619741439819]);
    expect(me.color_attributes.map((c) => [c.name, c.domain])).toEqual([['Attribute', 'CORNER']]);
  });
});

describe('import modes', () => {
  it('reports what was skipped', () => {
    expect(imp.warnings.some((w) => w.includes('Additional UV maps') && w.includes('Second'))).toBe(true);
    expect(imp.warnings.some((w) => w.includes('Loose edges') && w.includes('SkinMesh'))).toBe(true);
  });

  it('appends into an existing document with unique names', async () => {
    const target = startupDocument();
    const before = Object.keys(target.objects).length;
    const r = await readBlend(fixture('scene_zstd.blend'));
    const added = appendBlend(target, r);
    expect(added.length).toBe(r.stats.objects);
    expect(Object.keys(target.objects).length).toBe(before + added.length);
    const names = Object.values(target.objects).map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    const master = target.collections[target.scene.collection];
    expect(master.children.map((id) => target.collections[id].name)).toEqual(['Collection', 'Props', 'Excluded', 'HiddenLC', 'NoRender']);
    expect(target.scene.camera).not.toBeNull();
    expect(Object.values(target.objects).filter((o) => o.select).length).toBe(added.length);
  });

  it('can convert the same parsed file twice (no shared mutable state)', () => {
    const f = new BlendFile(raw);
    const a = convertBlend(f),
      b = convertBlend(f);
    expect(a.stats).toEqual(b.stats);
  });
});
