// Scripting additions for baking: scene.cycles (the path tracer's render settings, including
// bake_type) and image.colorspace_settings (normal and data bakes go into Non-Color images).
// scene.render.bake and bpy.ops.object.bake work through the generic wrappers.
import { app } from '../app/app';
import { ID_MIXINS, SceneStruct } from '../scripting/api';
import { Struct, proxify, touched, writableTypeStructs } from '../scripting/rna';
import type { ImageData } from '../data/types';

// scene.render.bake.type (Normals / Displacement for multires baking)
writableTypeStructs.add('Bake');

const COLORSPACES: [ImageData['colorspace'], string][] = [
  ['sRGB', 'sRGB'],
  ['Non-Color', 'Non-Color'],
  ['Linear', 'Linear Rec.709'],
];

Object.defineProperty(SceneStruct.prototype, 'cycles', {
  configurable: true,
  get() {
    return proxify(new Struct('CyclesRenderSettings', () => app.doc.scene.render as never, `bpy.data.scenes[${JSON.stringify(app.doc.scene.name)}].cycles`));
  },
});

class ImageColorspace {
  get colorspace_settings() {
    const id = (this as unknown as { __id: string }).__id;
    const img = () => app.doc.images[id];
    return {
      __kind: 'struct',
      __type: 'ColorManagedInputColorspaceSettings',
      get name() {
        const cs = img()?.colorspace ?? 'sRGB';
        return COLORSPACES.find(([v]) => v === cs)?.[1] ?? cs;
      },
      set name(v: string) {
        const im = img();
        const hit = COLORSPACES.find(([k, l]) => l === v || k === v || (v === 'Linear' && k === 'Linear'));
        if (!im || !hit) throw new Error(`colorspace_settings.name: unknown color space "${v}" (use ${COLORSPACES.map(([, l]) => `'${l}'`).join(', ')})`);
        im.colorspace = hit[0];
        touched();
      },
      get is_data() {
        return img()?.colorspace === 'Non-Color';
      },
    };
  }
}
(ID_MIXINS.images ??= []).push(ImageColorspace);
