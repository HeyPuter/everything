// @vitest-environment happy-dom
// The .blend writer: files it writes read back (with this app's own .blend reader) as the document
// they came from, every pointer in them leads to a block, and the project they carry reopens whole.
// With BLEND_WRITE_OUT=<dir> the test files are also written there, for checking them in other
// programs (tests/fixtures/blend/check_written.py).
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { richDocument, PNG_1PX } from './support/blend_write_doc';
import { writeBlend } from '../../src/io/blend/write/writer';
import { readBlend, convertBlend } from '../../src/io/blend/convert';
import { BlendFile } from '../../src/io/blend/reader';
import { embeddedProject, EMBED_CODE } from '../../src/io/blend/embed';
import { decodeDocument, encodeDocument, isNativeFile } from '../../src/io/native';
import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { fileEvents, openFile, saveFile } from '../../src/io/files';
import type { DocumentData, ObjectData } from '../../src/data/types';
import '../../src/io/blend/index';

const OUT = process.env.BLEND_WRITE_OUT ?? '';
const byName = (doc: DocumentData, name: string): ObjectData => Object.values(doc.objects).find((o) => o.name === name)!;
const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) => a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]) < eps);

describe('.blend files written from a document', () => {
  const src = richDocument();
  const { bytes, warnings } = writeBlend(src);
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/rich.blend`, bytes);
    writeFileSync(`${OUT}/startup.blend`, writeBlend(startupDocument()).bytes);
  }

  it('use the 4.2 layout every later version reads', () => {
    const f = new BlendFile(bytes);
    expect(f.header).toMatchObject({ pointerSize: 8, littleEndian: true, version: 402, largeBHead: false });
    expect(f.blocks[0].code).toBe('GLOB');
  });

  it('only hold pointers to blocks of the file', () => {
    const f = new BlendFile(bytes);
    const addrs = new Set(f.blocks.map((b) => b.addr));
    const bad: string[] = [];
    for (const b of f.blocks) {
      if (b.code === 'DNA1' || b.code === EMBED_CODE || b.sdna === 0) continue;
      for (const s of f.blockStructs(b)) {
        const walk = (st: typeof s, path: string) => {
          for (const fl of st.st.fields) {
            if (fl.nameInfo.funcPointer) continue;
            if (fl.nameInfo.pointer) {
              for (let i = 0; i < fl.nameInfo.arrayLen; i++) {
                const a = st.ptr(fl.name, i);
                if (a !== 0 && !addrs.has(a)) bad.push(`${st.type}.${path}${fl.name}`);
              }
            } else if (fl.structIndex >= 0 && fl.nameInfo.arrayLen === 1) {
              const sub = st.sub(fl.name);
              if (sub) walk(sub, `${path}${fl.name}.`);
            }
          }
        };
        walk(s, '');
      }
    }
    expect(bad).toEqual([]);
  });

  it('say what they hold differently', () => {
    expect(warnings).toContain('Modifiers are applied in .blend files (Rounded)');
    expect(warnings).toContain('Curves and text are stored as meshes in .blend files (Path)');
  });

  describe('read back', async () => {
    const r = await readBlend(bytes);
    const doc = r.doc;

    it('scene settings', () => {
      const s = doc.scene;
      expect(r.sceneName).toBe('Shot');
      expect([s.frame_start, s.frame_end, s.frame_current]).toEqual([10, 90, 33]);
      expect(s.render.fps).toBe(30);
      expect([s.render.resolution_x, s.render.resolution_y, s.render.resolution_percentage]).toEqual([1280, 720, 50]);
      expect(s.render.engine).toBe('PATHTRACE');
      expect(s.render.view_transform).toBe('FILMIC');
      expect(s.render.film_transparent).toBe(true);
      expect(s.cursor.location).toEqual([1, 2, 3]);
      expect(doc.worlds[s.world!].name).toBe('Sky');
      expect(doc.objects[s.camera!].name).toBe('Camera');
      expect(doc.objects[s.active_object!].name).toBe('Rounded');
    });

    it('collections and view layer flags', () => {
      const cols = Object.values(doc.collections);
      const props = cols.find((c) => c.name === 'Props')!;
      const inner = cols.find((c) => c.name === 'Inner')!;
      expect(props.children).toEqual([inner.id]);
      expect(props).toMatchObject({ color_tag: 'COLOR_03', hide_render: true, hide_select: true, hide: false });
      expect(inner).toMatchObject({ hide: true, exclude: false });
      expect(props.objects.map((id) => doc.objects[id].name)).toEqual(['Pivot']);
      expect(inner.objects.map((id) => doc.objects[id].name)).toEqual(['Prism Twin']);
    });

    it('objects: transforms, parenting, display, visibility', () => {
      const pivot = byName(doc, 'Pivot');
      expect(pivot.type).toBe('EMPTY');
      expect(pivot).toMatchObject({ empty_display_type: 'ARROWS', empty_display_size: 2, rotation_mode: 'QUATERNION' });
      expect(close(pivot.rotation_quaternion, [Math.SQRT1_2, 0, 0, Math.SQRT1_2])).toBe(true);
      const a = byName(doc, 'Prism');
      expect(a.parent).toBe(pivot.id);
      expect(close(a.matrix_parent_inverse.flat ? (a.matrix_parent_inverse as unknown as number[]).flat() : a.matrix_parent_inverse, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1])).toBe(true);
      expect(a).toMatchObject({ rotation_mode: 'ZYX', lock_location: [true, false, true], lock_scale: [false, true, false], show_wire: true, show_in_front: true, hide_render: true, select: true });
      expect(close(a.location, [2, 0, 0]) && close(a.rotation_euler, [0.1, 0.2, 0.3]) && close(a.scale, [1, 2, 3]) && close(a.delta_location, [0, 0, 0.5])).toBe(true);
      expect(close(a.color, [1, 0.5, 0.25, 1])).toBe(true);
      expect(byName(doc, 'Prism Twin')).toMatchObject({ hide: true, material_slots_link: ['DATA', 'OBJECT'] });
    });

    it('meshes: shared data, faces, UV maps, colors, edge data, groups, attributes', () => {
      const a = byName(doc, 'Prism'),
        b = byName(doc, 'Prism Twin');
      expect(a.data).toBe(b.data);
      const me = doc.meshes[a.data!];
      const ref = Object.values(src.meshes).find((m) => m.name === 'Prism')!;
      expect(Array.from(me.offsets)).toEqual(Array.from(ref.offsets));
      expect(Array.from(me.indices)).toEqual(Array.from(ref.indices));
      expect(close(me.positions, ref.positions)).toBe(true);
      expect(Array.from(me.smooth!)).toEqual(Array.from(ref.smooth!));
      expect(Array.from(me.material_index!)).toEqual(Array.from(ref.material_index!));
      expect(me.uv_map_name).toBe('Main');
      expect(close(me.uvs, ref.uvs)).toBe(true);
      expect(me.uv_layers_extra?.map((u) => u.name)).toEqual(['Lightmap']);
      expect(me.uv_active_index).toBe(1);
      expect(me.uv_render_name).toBe('Lightmap');
      expect(me.color_attributes.map((c) => [c.name, c.domain])).toEqual([
        ['Heat', 'POINT'],
        ['Paint', 'CORNER'],
      ]);
      expect(close(me.color_attributes.find((c) => c.name === 'Paint')!.data, ref.color_attributes[0].data)).toBe(true);
      expect(me.seams?.[0]).toBe(1);
      expect(me.sharp?.[0]).toBe(1);
      expect(me.creases?.[0]).toBeCloseTo(0.5);
      expect(me.bevel_weight_edge?.[0]).toBeCloseTo(0.25);
      expect(me.crease_vert?.[3]).toBeCloseTo(0.75);
      expect(me.vertex_groups.map((g) => g.name)).toEqual(['Top', 'Bottom']);
      expect(close(me.weights[0], ref.weights[0]) && close(me.weights[1], ref.weights[1])).toBe(true);
      const attr = (n: string) => me.attributes?.find((x) => x.name === n);
      expect(attr('height')).toMatchObject({ domain: 'POINT', data_type: 'FLOAT' });
      expect(close(attr('height')!.data, ref.attributes![0].data)).toBe(true);
      expect(Array.from(attr('face_id')!.data)).toEqual([0, 10, 20, 30, 40, 50, 60]);
      expect(attr('offset')).toMatchObject({ domain: 'POINT', data_type: 'FLOAT_VECTOR' });
      expect(Array.from(attr('tier')!.data)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
      expect(me.materials.map((m) => m && doc.materials[m].name)).toEqual(['Painted', 'Plain']);
    });

    it('evaluated geometry for modifiers and curves', () => {
      const rounded = byName(doc, 'Rounded');
      expect(rounded.modifiers).toEqual([]);
      expect(doc.meshes[rounded.data!].offsets.length - 1).toBe(24);
      const path = byName(doc, 'Path');
      expect(path.type).toBe('MESH');
      expect(doc.meshes[path.data!].offsets.length - 1).toBeGreaterThan(0);
    });

    it('cameras and lights', () => {
      const cam = doc.cameras[byName(doc, 'Ortho Cam').data!];
      expect(cam).toMatchObject({ type: 'ORTHO', ortho_scale: 7, clip_end: 250 });
      expect(cam.shift_x).toBeCloseTo(0.1);
      expect(cam.clip_start).toBeCloseTo(0.5);
      expect(cam.dof).toMatchObject({ use_dof: true, focus_distance: 4, focus_object: byName(doc, 'Pivot').id });
      const spot = doc.lights[byName(doc, 'Spot').data!];
      expect(spot).toMatchObject({ type: 'SPOT', energy: 250 });
      expect(close(spot.color, [1, 0.8, 0.6]) && Math.abs(spot.spot_size - 0.9) < 1e-6 && Math.abs(spot.spot_blend - 0.3) < 1e-6).toBe(true);
      expect(doc.lights[byName(doc, 'Panel').data!]).toMatchObject({ type: 'AREA', shape: 'RECTANGLE', size: 2, size_y: 0.5, energy: 40 });
      expect(doc.lights[byName(doc, 'Sun').data!].angle).toBeCloseTo(0.1);
    });

    it('materials with their node trees, and packed images', () => {
      const m = Object.values(doc.materials).find((x) => x.name === 'Painted')!;
      const n = (t: string) => m.tree.nodes.find((x) => x.type === t)!;
      expect(n('ShaderNodeBsdfPrincipled').inputs).toMatchObject({ Metallic: 0.75, Roughness: 0.25 });
      const tex = n('ShaderNodeTexImage');
      const img = doc.images[tex.props.image as string];
      expect(Array.from(img.bytes!)).toEqual(Array.from(PNG_1PX));
      expect(img.colorspace).toBe('Non-Color');
      expect(tex.parent).toBe(n('NodeFrame').id);
      expect(n('NodeFrame').label).toBe('Inputs');
      expect(n('ShaderNodeMath').props.operation).toBe('MULTIPLY');
      expect(n('ShaderNodeMath').inputs.Value_001).toBe(3);
      expect(n('ShaderNodeValToRGB').props).toMatchObject({ color_ramp: [0, 0, 0, 0, 1, 0.5, 1, 0, 0, 1, 1, 1, 1, 1, 1], ramp_interpolation: 'CONSTANT' });
      expect(n('ShaderNodeRGBCurve').props.curve_0).toEqual([0, 0, 0, 0.5, expect.closeTo(0.7), 0, 1, 1, 0]);
      expect(n('ShaderNodeRGBCurve').mute).toBe(true);
      expect(n('ShaderNodeValue').props['outputs.Value']).toBeCloseTo(0.25);
      expect(n('ShaderNodeValue').hide).toBe(true);
      expect(m.tree.links).toHaveLength(5);
      expect(m.tree.links.filter((l) => l.is_muted)).toHaveLength(1);
      expect(Object.values(doc.materials).find((x) => x.name === 'Plain')!.use_backface_culling).toBe(true);
      const world = doc.worlds[doc.scene.world!];
      expect(world.tree.nodes.find((x) => x.type === 'ShaderNodeBackground')!.inputs).toMatchObject({ Color: [expect.closeTo(0.2), expect.closeTo(0.3), expect.closeTo(0.4), 1], Strength: 2 });
    });
  });
});

describe('the project inside the .blend files this app saves', () => {
  it('reopens whole: the document is the one that was saved', () => {
    const doc = richDocument();
    const project = encodeDocument(doc, { ui: { workspace: 'Shading' } });
    const { bytes } = writeBlend(doc, { embed: project });
    expect(Array.from(embeddedProject(bytes)!)).toEqual(Array.from(project));
    expect(isNativeFile(bytes)).toBe(true);
    const back = decodeDocument(bytes);
    expect(back.extra.ui).toEqual({ workspace: 'Shading' });
    // the modifier and the curve are still what they were (the .blend data has them evaluated)
    expect(byName(back.doc, 'Rounded').modifiers.map((m) => m.type)).toEqual(['SUBSURF']);
    expect(byName(back.doc, 'Path').type).toBe('CURVE');
    // as if the project file itself had been opened
    expect(encodeDocument(back.doc)).toEqual(encodeDocument(decodeDocument(project).doc));
  });

  it('is not there in other .blend files', () => {
    const { bytes } = writeBlend(startupDocument());
    expect(embeddedProject(bytes)).toBeNull();
    expect(isNativeFile(bytes)).toBe(false);
    // and the file is still read by the converter
    expect(convertBlend(new BlendFile(bytes)).stats.objects).toBe(3);
  });
});

describe('Save and Open', () => {
  beforeEach(() => {
    setApp(new App(startupDocument()));
    fileEvents.saveTarget = null;
    fileEvents.keepOriginal = false;
  });

  it('a .blend file saved here opens as the project and Save writes it back in place', async () => {
    const doc = richDocument();
    const file = new File([writeBlend(doc, { embed: encodeDocument(doc) }).bytes as Uint8Array<ArrayBuffer>], 'shot.blend');
    await openFile(file);
    expect(app.filename).toBe('shot.blend');
    expect(byName(app.doc, 'Rounded').modifiers).toHaveLength(1);
    expect(fileEvents.keepOriginal).toBe(false);
    const written: Uint8Array[] = [];
    fileEvents.saveTarget = { name: 'shot.blend', write: async (b) => void written.push(b) };
    saveFile();
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toHaveLength(1);
    expect(isNativeFile(written[0])).toBe(true);
    expect(new BlendFile(written[0]).header.version).toBe(402);
  });

  it('a .blend file from another program is not replaced by Save', async () => {
    // written without the project: as if another program saved it
    const file = new File([writeBlend(richDocument()).bytes as Uint8Array<ArrayBuffer>], 'theirs.blend');
    await openFile(file);
    expect(app.filename).toBe('theirs.blend');
    expect(fileEvents.keepOriginal).toBe(true);
    const written: Uint8Array[] = [];
    fileEvents.saveTarget = { name: 'theirs.blend', write: async (b) => void written.push(b) };
    saveFile();
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toHaveLength(0);
    // saved as a new file instead (downloaded here), which Save may then replace
    expect(fileEvents.keepOriginal).toBe(false);
  });
});
