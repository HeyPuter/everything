// Scripting access to motion tracking: `clip.tracking.objects` (the camera and tracked objects),
// `.reconstruction` with `cameras.find_frame()` / `matrix_from_frame()` and `tracks.new()`. Everything else (tracks, markers, camera, settings) is reached through the
// generic wrappers.
import { app } from '../app/app';
import { ID_MIXINS } from '../scripting/api';
import { arrayFactories, BoundArray, PropCollection, proxify, pyError, Struct, touched } from '../scripting/rna';
import { Matrix } from '../scripting/mathutils';
import { normalizeTracking, insertMarker, newMarker, newTrack, reconstructionOf, trackingObjects, uniqueTrackName, type MovieClipData, type MovieReconstructedCamera, type MovieTracking, type MovieTrackingTrack, type TrackingObjectData } from './types';
import { reconstructedMatrix } from './reconstruction';

type Raw = Record<string, unknown>;

class ReconstructedCameras extends BoundArray {
  /** The solved camera of a frame, or null. */
  find_frame(frame = 1) {
    const list = (this.__get() ?? []) as MovieReconstructedCamera[];
    const i = list.findIndex((c) => c.frame === frame);
    return i < 0 ? null : (this as unknown as { getItem(i: number): unknown }).getItem(i);
  }
  /** Camera matrix at a frame, interpolated between the solved frames around it. */
  matrix_from_frame(frame = 1) {
    const list = (this.__get() ?? []) as MovieReconstructedCamera[];
    const m = reconstructedMatrix({ is_valid: true, average_error: 0, cameras: list }, frame);
    return m ? Matrix.fromColumnMajor(m.toArray()) : null;
  }
}

class ReconstructionStruct extends Struct {
  get cameras() {
    return new ReconstructedCameras('MovieReconstructedCamera', `${this.__path}.cameras`, () => (this.__resolve()?.cameras as unknown[]) ?? undefined, 'cameras');
  }
}

/** One tracking object: the camera's data lives on the tracking struct itself. */
class TrackingObjectStruct extends Struct {
  constructor(
    resolve: () => Raw | null | undefined,
    path: string,
    private readonly cam: () => MovieClipData | null,
    private readonly camera: boolean,
  ) {
    super('MovieTrackingObject', resolve, path);
  }
  get name(): string {
    const c = this.cam();
    return this.camera ? (c?.tracking.camera_object_name ?? 'Camera') : String(this.__raw.name);
  }
  set name(v: string) {
    if (this.camera) {
      const c = this.cam();
      if (c) c.tracking.camera_object_name = String(v);
    } else this.__raw.name = String(v);
    touched();
  }
  get is_camera() {
    return this.camera;
  }
  get scale() {
    return this.camera ? 1 : Number(this.__raw.scale ?? 1);
  }
  set scale(v: number) {
    if (this.camera) throw pyError('AttributeError', 'The camera object has no solution scale');
    this.__raw.scale = Number(v);
    touched();
  }
  get reconstruction() {
    const raw = this.__raw as unknown as TrackingObjectData;
    reconstructionOf(raw);
    return proxify(new ReconstructionStruct('MovieTrackingReconstruction', () => (this.__resolve() as unknown as TrackingObjectData | null)?.reconstruction as unknown as Raw, `${this.__path}.reconstruction`));
  }
  override __hidden() {
    return HIDE_ON_OBJECT;
  }
}
const HIDE_ON_OBJECT = new Set(['settings', 'camera', 'stabilization', 'objects', 'active_object_index', 'camera_object_name']);

class TrackingObjects extends PropCollection<TrackingObjectStruct> {
  constructor(
    path: string,
    private readonly clip: () => MovieClipData | null,
  ) {
    super(path);
  }
  list() {
    const c = this.clip();
    if (!c) return [];
    return trackingObjects(c).map((o, i) =>
      proxify(
        new TrackingObjectStruct(
          () => {
            const cc = this.clip();
            if (!cc) return null;
            return (i === 0 ? cc.tracking : cc.tracking.objects?.[i - 1]) as unknown as Raw;
          },
          `${this.__path}[${JSON.stringify(o.name)}]`,
          this.clip,
          i === 0,
        ),
      ),
    );
  }
  nameOf(item: TrackingObjectStruct) {
    return item.name;
  }
  get active() {
    const c = this.clip();
    return c ? this.list()[c.tracking.active_object_index ?? 0] ?? null : null;
  }
  set active(v: TrackingObjectStruct | null) {
    const c = this.clip();
    if (!c || !v) return;
    const i = this.list().findIndex((o) => o.name === v.name);
    if (i >= 0) c.tracking.active_object_index = i;
    touched();
  }
  new(name = 'Object') {
    const c = this.clip();
    if (!c) throw pyError('ReferenceError', 'Movie clip has been removed');
    const names = new Set(trackingObjects(c).map((o) => o.name));
    let n = name;
    for (let i = 1; names.has(n); i++) n = `${name}.${String(i).padStart(3, '0')}`;
    (c.tracking.objects ??= []).push({ name: n, scale: 1, tracks: [], active_track: null, plane_tracks: [], reconstruction: { is_valid: false, average_error: 0, cameras: [] }, keyframe_a: 1, keyframe_b: 30 });
    touched();
    return this.getItem(n);
  }
  remove(obj: TrackingObjectStruct) {
    const c = this.clip();
    if (!c || !obj) return;
    if (obj.is_camera) throw pyError('RuntimeError', 'The camera tracking object cannot be removed');
    const i = (c.tracking.objects ?? []).findIndex((o) => o.name === obj.name);
    if (i < 0) return;
    c.tracking.objects!.splice(i, 1);
    if ((c.tracking.active_object_index ?? 0) > i) c.tracking.active_object_index = Math.max(0, (c.tracking.active_object_index ?? 0) - 1);
    touched();
  }
}

class TrackingStruct extends Struct {
  constructor(
    resolve: () => Raw | null | undefined,
    path: string,
    private readonly clip: () => MovieClipData | null,
  ) {
    super('MovieTracking', resolve, path);
  }
  get objects() {
    return new TrackingObjects(`${this.__path}.objects`, this.clip);
  }
  get reconstruction() {
    const raw = this.__raw as unknown as MovieTracking;
    reconstructionOf(raw);
    return proxify(new ReconstructionStruct('MovieTrackingReconstruction', () => (this.__resolve() as unknown as MovieTracking | null)?.reconstruction as unknown as Raw, `${this.__path}.reconstruction`));
  }
}

class MovieClipTracking {
  get tracking() {
    const self = this as unknown as Struct & { __raw: Raw };
    const clip = () => (self.__resolve() as unknown as MovieClipData | null) ?? null;
    const c = clip();
    if (c) normalizeTracking(c.tracking);
    return proxify(new TrackingStruct(() => clip()?.tracking as unknown as Raw, `${self.__path}.tracking`, clip));
  }
  /** Frame size in pixels. */
  get size() {
    const c = (this as unknown as Struct).__resolve() as unknown as MovieClipData | null;
    return c ? [...c.size] : [0, 0];
  }
}
(ID_MIXINS.movieclips ??= []).push(MovieClipTracking);

// tracks.new(name, frame) and markers.insert / find_frame / delete_frame on generic lists
arrayFactories.push({
  match: /^bpy\.data\.movieclips\[\]\.tracking(\.objects\[\])?\.tracks$/,
  make: (args, list) => {
    const clip = Object.values(app.doc.movieclips ?? {}).find((c) => c.tracking.tracks === list || c.tracking.objects?.some((o) => o.tracks === list));
    const t = newTrack(clip?.tracking ?? ({ tracks: list, settings: {} } as unknown as MovieTracking), String(args[0] ?? 'Track'));
    t.name = uniqueTrackName({ tracks: list as MovieTrackingTrack[], active_track: null }, String(args[0] || 'Track'));
    const frame = Number(args[1] ?? 1);
    if (clip) insertMarker(t, newMarker(frame, [0.5, 0.5], clip.size[0] ? clip.size : [1920, 1080], clip.tracking.settings.default_pattern_size, clip.tracking.settings.default_search_size));
    return t;
  },
});
