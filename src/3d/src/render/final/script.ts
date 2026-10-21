// Scripting access to the render settings: scene.cycles (path tracer, including the options in
// render.cycles), scene.eevee (realtime engine, with its bpy names), writable Camera.type /
// Light.type, and the camera's panoramic settings and stereo rig.
import { app, onAppReady } from '../../app/app';
import { SceneStruct, ID_MIXINS } from '../../scripting/api';
import { Struct, proxify, writableTypeStructs, touched } from '../../scripting/rna';
import type { RenderSettings } from '../../data/types';
import { ptSettings } from './ptsettings';
import { ensureRealtimeDefaults } from '../realtime/props';
import { defaultPanorama, panorama, PANORAMA_TYPES } from './ptcamera';
import { cameraStereo } from './stereo';

writableTypeStructs.add('Camera');
writableTypeStructs.add('Light');

type Raw = Record<string, unknown>;

/** scene.cycles: the shared render settings plus the path tracer's own (render.cycles). */
class CyclesStruct extends Struct {
  override __extra(): Raw | null {
    return ptSettings(app.doc.scene.render) as unknown as Raw;
  }
}

/** Realtime settings whose names differ from the render settings they live in. */
const EEVEE_ALIASES: [string, keyof RenderSettings][] = [
  ['taa_render_samples', 'raster_samples'],
  ['taa_samples', 'preview_raster_samples'],
  ['use_raytracing', 'use_ssr'],
];

class EeveeStruct extends Struct {}
for (const [alias, key] of EEVEE_ALIASES) {
  if (alias === key) continue;
  Object.defineProperty(EeveeStruct.prototype, alias, {
    configurable: true,
    get() {
      return (app.doc.scene.render as unknown as Raw)[key];
    },
    set(v: unknown) {
      const r = app.doc.scene.render as unknown as Raw;
      r[key] = typeof r[key] === 'boolean' ? !!v : typeof r[key] === 'number' ? Number(v) : v;
      touched();
    },
  });
}

// after every module (the bake module defines an earlier scene.cycles)
onAppReady(() => {
  const path = (k: string) => `bpy.data.scenes[${JSON.stringify(app.doc.scene.name)}].${k}`;
  Object.defineProperty(SceneStruct.prototype, 'cycles', {
    configurable: true,
    get() {
      return proxify(new CyclesStruct('CyclesRenderSettings', () => app.doc.scene.render as never, path('cycles')));
    },
  });
  Object.defineProperty(SceneStruct.prototype, 'eevee', {
    configurable: true,
    get() {
      ensureRealtimeDefaults(app.doc.scene.render);
      return proxify(new EeveeStruct('SceneEEVEE', () => app.doc.scene.render as never, path('eevee')));
    },
  });
});

// Camera data: panoramic projection settings and the stereo rig (filled with defaults on first use)
class CameraRenderMixin {
  get stereo() {
    const id = (this as unknown as { __id: string }).__id;
    return proxify(new Struct('CameraStereoData', () => (app.doc.cameras[id] ? (cameraStereo(app.doc.cameras[id]) as unknown as Raw) : null), `bpy.data.cameras[${JSON.stringify(app.doc.cameras[id]?.name ?? '')}].stereo`));
  }
}
for (const key of Object.keys(defaultPanorama())) {
  Object.defineProperty(CameraRenderMixin.prototype, key, {
    configurable: true,
    enumerable: true,
    get(this: { __id: string }) {
      const ca = app.doc.cameras[this.__id];
      return ca ? (panorama(ca) as unknown as Raw)[key] : undefined;
    },
    set(this: { __id: string }, v: unknown) {
      const ca = app.doc.cameras[this.__id];
      if (!ca) return;
      const p = panorama(ca) as unknown as Raw;
      if (key === 'panorama_type' && !PANORAMA_TYPES.some(([t]) => t === v)) throw new Error(`panorama_type: expected one of ${PANORAMA_TYPES.map(([t]) => `'${t}'`).join(', ')}`);
      p[key] = typeof p[key] === 'number' ? Number(v) : v;
      touched();
    },
  });
}
(ID_MIXINS.cameras ??= []).push(CameraRenderMixin);
