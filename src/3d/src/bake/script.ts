// Scripting additions for baking: scene.cycles (the path tracer's render settings, including
// bake_type) and image.colorspace_settings (normal and data bakes go into Non-Color images).
// scene.render.bake and bpy.ops.object.bake work through the generic wrappers.
import { app } from '../app/app';
import { ID_MIXINS, SceneStruct } from '../scripting/api';
import { Struct, proxify, touched, writableTypeStructs, kwMethod } from '../scripting/rna';
import { isTiled, tileView, nextFreeTile, makeTiled, makeSingle, addTile, removeTile } from '../render/udim';
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

// ---------------------------------------------------------------------------
// UDIM tiles: image.source = 'TILED', image.tiles.new(tile_number, label), .get(), .remove(), .active

function tileStruct(imgId: string, number: number) {
  const tile = () => app.doc.images[imgId]?.tiles?.find((t) => t.number === number);
  return {
    __kind: 'struct',
    __type: 'UDIMTile',
    get number() {
      return number;
    },
    get label() {
      return tile()?.label ?? '';
    },
    set label(v: string) {
      const t = tile();
      if (t) (t.label = String(v) || undefined), touched();
    },
    get size() {
      const img = app.doc.images[imgId];
      const i = img?.tiles?.findIndex((t) => t.number === number) ?? -1;
      if (!img || i < 0) return [0, 0];
      const v = tileView(img, i);
      return [v.width, v.height];
    },
    get channels() {
      return 4;
    },
    toString() {
      return `<bpy_struct, UDIMTile(${number})>`;
    },
  };
}

class UdimTiles {
  constructor(private readonly imgId: string) {}
  private get img() {
    return app.doc.images[this.imgId];
  }
  get length() {
    return this.img?.tiles?.length ?? 0;
  }
  __len__() {
    return this.length;
  }
  [Symbol.iterator]() {
    return (this.img?.tiles ?? []).map((t) => tileStruct(this.imgId, t.number))[Symbol.iterator]();
  }
  get(tile_number: number) {
    return this.img?.tiles?.some((t) => t.number === Number(tile_number)) ? tileStruct(this.imgId, Number(tile_number)) : null;
  }
  new(tile_number = 0, label = '') {
    const img = this.img;
    if (!isTiled(img)) throw new Error('image.tiles.new(): the image is not tiled (set image.source = "TILED" first)');
    const n = Number(tile_number) || nextFreeTile(img.tiles.map((t) => t.number));
    const v = tileView(img, 0);
    if (addTile(img, n, { label: String(label), width: v.width, height: v.height }) < 0) throw new Error(`image.tiles.new(): tile ${n} exists or is outside 1001–2000`);
    touched();
    return tileStruct(this.imgId, n);
  }
  remove(tile: { number: number }) {
    const img = this.img;
    const i = img?.tiles?.findIndex((t) => t.number === tile?.number) ?? -1;
    if (!img || i < 0 || !removeTile(img, i)) throw new Error('image.tiles.remove(): cannot remove this tile (an image keeps at least one)');
    touched();
  }
  get active_index() {
    return this.img?.active_tile_index ?? 0;
  }
  set active_index(v: number) {
    const img = this.img;
    if (img?.tiles) img.active_tile_index = Math.max(0, Math.min(img.tiles.length - 1, Math.round(Number(v))));
  }
  get active() {
    const img = this.img;
    const t = img?.tiles?.[img.active_tile_index ?? 0];
    return t ? tileStruct(this.imgId, t.number) : null;
  }
}
kwMethod(UdimTiles.prototype, 'new', ['tile_number', 'label']);
kwMethod(UdimTiles.prototype, 'get', ['tile_number']);

class ImageTiles {
  get tiles() {
    return new UdimTiles((this as unknown as { __id: string }).__id);
  }
  get source() {
    return app.doc.images[(this as unknown as { __id: string }).__id]?.source;
  }
  set source(v: string) {
    const img = app.doc.images[(this as unknown as { __id: string }).__id];
    if (!img) return;
    if (v === 'TILED') makeTiled(img);
    else if (img.source === 'TILED' && (v === 'FILE' || v === 'GENERATED')) makeSingle(img);
    else img.source = v as ImageData['source'];
    touched();
  }
}
(ID_MIXINS.images ??= []).push(ImageTiles);
