// Image objects: reference/background image empties and images as mesh planes.
import { Euler } from 'three';
import { app, registerOperators } from '../app/app';
import type { ImageData, NodeData, ObjectData } from '../data/types';
import { newMaterial, newMeshData, newObject, uid } from '../data/defaults';
import { addObjectToScene, uniqueName } from './object';
import { pickFile } from '../io/native';
import { activeView3D } from '../editors/view3d/view3d';
import { propertiesTabs } from '../editors/properties/properties';
import { h } from '../ui/h';
import { panel, button } from '../ui/widgets';
import { num, bool, enumProp } from '../ui/props';
import { openMenu } from '../ui/menu';

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif';

/** Decode an image file into an image datablock (bytes are kept so files stay self-contained). */
export async function imageFromFile(file: File): Promise<ImageData> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || (/\.jpe?g$/i.test(file.name) ? 'image/jpeg' : 'image/png');
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const img: ImageData = {
    id: uid('im'),
    name: uniqueName(app.doc, file.name, 'images'),
    mime,
    bytes,
    width: bmp.width,
    height: bmp.height,
    source: 'FILE',
    filepath: file.name,
    colorspace: 'sRGB',
    revision: 0,
  };
  bmp.close();
  return img;
}

function viewRotation(): [number, number, number] {
  const v = activeView3D();
  if (!v) return [Math.PI / 2, 0, 0];
  const e = new Euler().setFromQuaternion(v.camera.quaternion, 'ZYX');
  return [e.x, e.y, e.z];
}

registerOperators([
  {
    idname: 'object.empty_image_add',
    label: 'Add Image Empty',
    description: 'Add an empty object displaying an image (reference or background), aligned to the view',
    props: [
      { id: 'background', label: 'Background', type: 'bool', default: false },
      { id: 'image', label: 'Image', type: 'string', default: '' },
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    invoke: (ctx, p) => {
      const rotation = viewRotation();
      const location = [...ctx.doc.scene.cursor.location];
      void pickFile(IMAGE_ACCEPT).then(async (file) => {
        if (!file) return;
        try {
          const img = await imageFromFile(file);
          app.doc.images[img.id] = img;
          app.run('object.empty_image_add', { background: p.background, image: img.id, location, rotation }, { invoke: false });
        } catch (e) {
          app.report('ERROR', `Cannot load image: ${e instanceof Error ? e.message : e}`);
        }
      });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const img = ctx.doc.images[p.image as string];
      if (!img) return 'CANCELLED';
      const ob = newObject((img.filepath ?? img.name).replace(/\.[a-z0-9]+$/i, ''), 'EMPTY', img.id);
      ob.empty_display_type = 'IMAGE';
      ob.empty_display_size = 5;
      ob.empty_image_offset = [-0.5, -0.5];
      if (p.background) {
        // background images sit behind everything and only show in axis-aligned orthographic views
        ob.empty_image_depth = 'BACK';
        ob.empty_image_side = 'FRONT';
        ob.show_empty_image_perspective = false;
        ob.show_empty_image_only_axis_aligned = true;
      } else {
        ob.empty_image_depth = 'DEFAULT';
        ob.empty_image_side = 'DOUBLE_SIDED';
      }
      addObjectToScene(ctx.doc, ob, { location: (p as Record<string, unknown>).location ?? ctx.doc.scene.cursor.location, rotation: (p as Record<string, unknown>).rotation ?? viewRotation() });
    },
  },
  {
    idname: 'image.import_as_mesh_planes',
    label: 'Mesh Plane',
    description: 'Create a mesh plane sized to an image, with a material using the image',
    props: [
      { id: 'image', label: 'Image', type: 'string', default: '' },
      { id: 'height', label: 'Height', type: 'float', default: 1, min: 0.0001, subtype: 'distance' },
      { id: 'shader', label: 'Shader', type: 'enum', default: 'PRINCIPLED', items: [['PRINCIPLED', 'Principled'], ['EMISSION', 'Emit'], ['SHADELESS', 'Shadeless']] },
      { id: 'align_view', label: 'Align to View', type: 'bool', default: false },
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    invoke: () => {
      void pickFile(IMAGE_ACCEPT).then(async (file) => {
        if (!file) return;
        try {
          const img = await imageFromFile(file);
          app.doc.images[img.id] = img;
          app.run('image.import_as_mesh_planes', { image: img.id }, { invoke: false });
        } catch (e) {
          app.report('ERROR', `Cannot load image: ${e instanceof Error ? e.message : e}`);
        }
      });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const img = doc.images[p.image as string];
      if (!img) return 'CANCELLED';
      const hgt = p.height as number;
      const w = (hgt * img.width) / Math.max(1, img.height);
      const x = w / 2,
        y = hgt / 2;
      const base = (img.filepath ?? img.name).replace(/\.[a-z0-9]+$/i, '');
      const me = newMeshData(uniqueName(doc, base, 'meshes'), {
        positions: new Float32Array([-x, -y, 0, x, -y, 0, x, y, 0, -x, y, 0]),
        offsets: new Uint32Array([0, 4]),
        indices: new Uint32Array([0, 1, 2, 3]),
        uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      });
      const ma = newMaterial(uniqueName(doc, base, 'materials'));
      const tex: NodeData = {
        id: uid('node'),
        type: 'ShaderNodeTexImage',
        name: 'Image Texture',
        location: [-320, 300],
        inputs: {},
        props: { image: img.id, interpolation: 'Linear', projection: 'FLAT', extension: 'CLIP' },
      };
      ma.tree.nodes.push(tex);
      const bsdf = ma.tree.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
      const out = ma.tree.nodes.find((n) => n.type === 'ShaderNodeOutputMaterial')!;
      if (p.shader === 'PRINCIPLED') {
        ma.tree.links.push({ id: uid('link'), from_node: tex.id, from_socket: 'Color', to_node: bsdf.id, to_socket: 'Base Color' });
        ma.tree.links.push({ id: uid('link'), from_node: tex.id, from_socket: 'Alpha', to_node: bsdf.id, to_socket: 'Alpha' });
      } else {
        // emission (also used for "shadeless": full strength, no lighting response)
        ma.tree.nodes = ma.tree.nodes.filter((n) => n !== bsdf);
        ma.tree.links = ma.tree.links.filter((l) => l.from_node !== bsdf.id);
        const em: NodeData = { id: uid('node'), type: 'ShaderNodeEmission', name: 'Emission', location: [10, 300], inputs: { Strength: 1 }, props: {} };
        ma.tree.nodes.push(em);
        ma.tree.links.push({ id: uid('link'), from_node: tex.id, from_socket: 'Color', to_node: em.id, to_socket: 'Color' });
        ma.tree.links.push({ id: uid('link'), from_node: em.id, from_socket: 'Emission', to_node: out.id, to_socket: 'Surface' });
      }
      ma.blend_method = 'HASHED';
      ma.tree.active_node = tex.id;
      doc.materials[ma.id] = ma;
      me.materials = [ma.id];
      doc.meshes[me.id] = me;
      const ob = newObject(base, 'MESH', me.id);
      addObjectToScene(doc, ob, { location: [...doc.scene.cursor.location], rotation: p.align_view ? viewRotation() : [Math.PI / 2, 0, 0] });
    },
  },
]);

// ---------------------------------------------------------------------------
// Object Data tab for empties (display settings, image settings)

function emptyData(o: ObjectData) {
  const changed = (label: string) => {
    app.pushUndo(label);
    app.changed('doc');
  };
  const img = o.data ? app.doc.images[o.data] : undefined;
  const parts = [
    panel('empty-display', 'Empty', () => [
      enumProp(o, 'empty_display_type', 'Display As', [
        ['PLAIN_AXES', 'Plain Axes'],
        ['ARROWS', 'Arrows'],
        ['SINGLE_ARROW', 'Single Arrow'],
        ['CIRCLE', 'Circle'],
        ['CUBE', 'Cube'],
        ['SPHERE', 'Sphere'],
        ['CONE', 'Cone'],
        ['IMAGE', 'Image'],
      ]),
      num(o, 'empty_display_size', 'Size', { unit: 'distance', min: 0 }),
    ]),
  ];
  if (o.empty_display_type !== 'IMAGE') return parts;
  o.empty_image_offset ??= [-0.5, -0.5];
  const off = o.empty_image_offset;
  const imageMenu = (e: MouseEvent) =>
    openMenu(
      [
        ...Object.values(app.doc.images).map((im) => ({ label: im.name, icon: 'image', active: im.id === o.data, action: () => ((o.data = im.id), changed('Assign Image')) })),
        { separator: true },
        {
          label: 'Open…',
          icon: 'file_folder',
          action: () =>
            void pickFile(IMAGE_ACCEPT).then(async (f) => {
              if (!f) return;
              const im = await imageFromFile(f);
              app.doc.images[im.id] = im;
              o.data = im.id;
              changed('Open Image');
            }),
        },
      ],
      e.currentTarget as HTMLElement,
    );
  parts.push(
    panel('empty-image', 'Image', () => [
      h('div', { class: 'prop-datablock' }, button('empty-img', img ? img.name : 'Open Image…', imageMenu, { className: 'wide' })),
      img ? h('div', { class: 'prop-note' }, `${img.width} × ${img.height} px`) : null,
      num(off as unknown as Record<string, number>, '0' as never, 'Offset X', { step: 0.1 }),
      num(off as unknown as Record<string, number>, '1' as never, 'Y', { step: 0.1 }),
      enumProp(o, 'empty_image_depth', 'Depth', [
        ['DEFAULT', 'Default'],
        ['FRONT', 'Front'],
        ['BACK', 'Back'],
      ]),
      enumProp(o, 'empty_image_side', 'Side', [
        ['DOUBLE_SIDED', 'Both'],
        ['FRONT', 'Front'],
        ['BACK', 'Back'],
      ]),
      bool(o, 'show_empty_image_orthographic', 'Show in Orthographic'),
      bool(o, 'show_empty_image_perspective', 'Show in Perspective'),
      bool(o, 'show_empty_image_only_axis_aligned', 'Only Axis Aligned'),
      bool(o, 'use_empty_image_alpha', 'Use Opacity'),
      o.use_empty_image_alpha ? num(o.color as unknown as Record<string, number>, '3' as never, 'Opacity', { min: 0, max: 1, slider: true }) : null,
    ]),
  );
  return parts;
}

// Empties always get an Object Data tab.
const dataTab = propertiesTabs.find((t) => t.id === 'DATA');
if (dataTab) {
  const poll = dataTab.poll,
    draw = dataTab.draw;
  dataTab.poll = () => app.activeObject?.type === 'EMPTY' || poll();
  dataTab.draw = (p) => {
    const o = app.activeObject;
    if (o?.type === 'EMPTY') {
      o.show_empty_image_orthographic ??= true;
      o.show_empty_image_perspective ??= true;
      return emptyData(o);
    }
    return draw(p);
  };
}
