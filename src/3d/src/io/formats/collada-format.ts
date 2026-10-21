// Collada registration: File ▸ Import ▸ Collada (.dae)
import { commitToApp, defineFormat } from './glue';
import { baseName } from './common';
import { colladaImageFiles, readCollada } from './collada';

defineFormat({
  id: 'collada',
  label: 'Collada (.dae)',
  extensions: ['.dae'],
  description: 'COLLADA 1.4/1.5 documents (meshes, materials, hierarchy, cameras, lights, skins, animation)',
  importOptions: [
    { id: 'merge_vertices', label: 'Merge Vertices', type: 'bool', default: true, description: 'Weld the triangle soup produced by the loader back into connected meshes' },
    {
      id: 'bone_heuristic',
      label: 'Bone Dir',
      type: 'enum',
      default: 'AUTO',
      items: [
        ['AUTO', 'Best Fit (point at children)'],
        ['Y', 'Keep Joint Axes'],
      ],
    },
  ],
  importOps: ['wm.collada_import'],
  importOpLabel: 'Import Collada',
  multiFile: true,
  companions(src, have) {
    const images = colladaImageFiles(new TextDecoder().decode(src.bytes)).filter((n) => !have.has(baseName(n)));
    return images.length ? { title: 'Collada Textures', message: `"${src.name}" references these images. Select them to import the textures:`, names: images, accept: 'image/*,.tga,.tif,.tiff' } : null;
  },
  async importData(src, o) {
    const ir = await readCollada(new TextDecoder().decode(src.bytes), src.resources);
    commitToApp(ir, { mergeVertices: !!o.merge_vertices, boneDirection: o.bone_heuristic as 'AUTO' });
  },
});
