// Motion tracking data model: the movie clip data-block with its tracking settings, camera
// intrinsics, 2D tracks/markers and 2D stabilization. Property names follow the publicly
// documented RNA names (MovieClip, MovieTracking*, …) so scripts and paths map 1:1.
//
// Coordinates: marker positions are normalized frame coordinates (0..1) with the origin at the
// bottom-left corner of the frame (y up). Pattern corners and the search area are stored relative
// to the marker position, also normalized. Frames on markers are *clip* frames (1 = first frame of
// the footage); scene frames map to clip frames through `frame_start`.
import type { ID, Vec2, Color } from '../data/types';

export type MotionModel = 'Loc' | 'LocRot' | 'LocScale' | 'LocRotScale' | 'Affine';
export type PatternMatch = 'KEYFRAME' | 'PREV_FRAME';

export interface MovieTrackingMarker {
  frame: number;
  co: Vec2;
  /** four corners relative to `co` (bottom-left, bottom-right, top-right, top-left) */
  pattern_corners: [Vec2, Vec2, Vec2, Vec2];
  search_min: Vec2;
  search_max: Vec2;
  /** disabled marker (track is lost/disabled from this frame until the next enabled marker) */
  mute: boolean;
  /** user-placed (keyframed) marker as opposed to one produced by the tracker */
  is_keyed: boolean;
}

export interface MovieTrackingTrack {
  name: string;
  markers: MovieTrackingMarker[];
  select: boolean;
  hide: boolean;
  lock: boolean;
  motion_model: MotionModel;
  pattern_match: PatternMatch;
  margin: number;
  correlation_min: number;
  frames_limit: number;
  use_brute: boolean;
  use_normalization: boolean;
  use_red_channel: boolean;
  use_green_channel: boolean;
  use_blue_channel: boolean;
  use_grayscale_preview: boolean;
  weight: number;
  weight_stab: number;
  offset: Vec2;
  use_custom_color: boolean;
  color: Color;
  /** used for 2D stabilization (translation) */
  use_2d_stabilization: boolean;
  /** used for 2D stabilization (rotation / scale) */
  use_2d_stabilization_rotation: boolean;
  /** correlation of the last tracked frame (display only) */
  last_correlation?: number;
  /** reconstructed 3D position (camera solve) in reconstruction space */
  has_bundle?: boolean;
  bundle?: [number, number, number];
  /** average reprojection error of the bundle over the solved frames (pixels) */
  average_error?: number;
}

/** Solved camera of one frame. */
export interface MovieReconstructedCamera {
  frame: number;
  /** camera world matrix in reconstruction space (column-major 4×4, looking down −Z) */
  matrix: number[];
  average_error: number;
}

export interface MovieTrackingReconstruction {
  is_valid: boolean;
  average_error: number;
  cameras: MovieReconstructedCamera[];
}

/** Plane marker: the four corners of the plane (normalized frame coordinates, origin bottom-left). */
export interface MovieTrackingPlaneMarker {
  frame: number;
  corners: [Vec2, Vec2, Vec2, Vec2];
  mute: boolean;
  /** placed by the user rather than computed from the tracks */
  is_keyed?: boolean;
}

export interface MovieTrackingPlaneTrack {
  name: string;
  /** names of the point tracks the plane follows */
  tracks: string[];
  markers: MovieTrackingPlaneMarker[];
  select: boolean;
  /** image shown on the plane in the clip editor */
  image: ID | null;
  image_opacity: number;
  use_auto_keying: boolean;
}

/** Tracks and solution of one tracked object (the camera's live directly on MovieTracking). */
export interface TrackingObjectData {
  tracks: MovieTrackingTrack[];
  active_track: string | null;
  plane_tracks?: MovieTrackingPlaneTrack[];
  active_plane_track?: string | null;
  reconstruction?: MovieTrackingReconstruction;
  /** first / second keyframe of the reconstruction (clip frames) */
  keyframe_a?: number;
  keyframe_b?: number;
}

export interface MovieTrackingObject extends TrackingObjectData {
  name: string;
  /** scale of the object solution in camera space */
  scale: number;
}

export interface MovieTrackingSettings {
  default_pattern_size: number;
  default_search_size: number;
  default_motion_model: MotionModel;
  default_pattern_match: PatternMatch;
  default_margin: number;
  default_correlation_min: number;
  default_frames_limit: number;
  use_default_brute: boolean;
  use_default_normalization: boolean;
  use_default_red_channel: boolean;
  use_default_green_channel: boolean;
  use_default_blue_channel: boolean;
  default_weight: number;
  // camera solve
  use_keyframe_selection?: boolean;
  use_tripod_solver?: boolean;
  refine_intrinsics_focal_length?: boolean;
  refine_intrinsics_principal_point?: boolean;
  refine_intrinsics_radial_distortion?: boolean;
  refine_intrinsics_tangential_distortion?: boolean;
  // clean up
  clean_frames?: number;
  clean_error?: number;
  clean_action?: 'SELECT' | 'DELETE_TRACK' | 'DELETE_SEGMENTS';
  /** distances used by Set Scale / Set Solution Scale */
  distance?: number;
  object_distance?: number;
}

export type DistortionModelName = 'POLYNOMIAL' | 'DIVISION' | 'BROWN';

export interface MovieTrackingCamera {
  sensor_width: number;
  /** focal length in millimeters (pixels are derived from the sensor width and clip width) */
  focal_length: number;
  units: 'PIXELS' | 'MILLIMETERS';
  /** optical center, normalized to -1..1 around the frame center */
  principal_point: Vec2;
  pixel_aspect: number;
  distortion_model: DistortionModelName;
  k1: number;
  k2: number;
  k3: number;
  division_k1?: number;
  division_k2?: number;
  brown_k1?: number;
  brown_k2?: number;
  brown_k3?: number;
  brown_k4?: number;
  brown_p1?: number;
  brown_p2?: number;
}

export interface MovieTrackingStabilization {
  use_2d_stabilization: boolean;
  anchor_frame: number;
  use_stabilize_rotation: boolean;
  use_stabilize_scale: boolean;
  /** expected position (pixels), subtracted from the measured motion */
  target_position: Vec2;
  target_rotation: number;
  target_scale: number;
  use_autoscale: boolean;
  scale_max: number;
  influence_location: number;
  influence_rotation: number;
  influence_scale: number;
  filter_type: 'NEAREST' | 'BILINEAR' | 'BICUBIC';
  show_tracks_expanded: boolean;
  active_track_index: number;
  active_rotation_track_index: number;
}

export interface MovieTracking extends TrackingObjectData {
  settings: MovieTrackingSettings;
  camera: MovieTrackingCamera;
  /** the camera's tracks */
  tracks: MovieTrackingTrack[];
  /** name of the active track */
  active_track: string | null;
  stabilization: MovieTrackingStabilization;
  /** name of the camera tracking object */
  camera_object_name?: string;
  /** tracked objects besides the camera */
  objects?: MovieTrackingObject[];
  /** 0: the camera, i > 0: objects[i − 1] */
  active_object_index?: number;
}

export interface MovieClipData {
  id: ID;
  name: string;
  source: 'MOVIE' | 'SEQUENCE';
  filepath: string;
  /** encoded movie file (source MOVIE) */
  movie?: { mime: string; bytes: Uint8Array } | null;
  /** encoded images (source SEQUENCE), in frame order */
  sequence?: { mime: string; bytes: Uint8Array; name: string }[] | null;
  /** footage resolution in pixels */
  size: [number, number];
  fps: number;
  frame_start: number;
  frame_offset: number;
  frame_duration: number;
  tracking: MovieTracking;
  use_fake_user?: boolean;
  users?: number;
}

declare module '../data/types' {
  interface DocumentData {
    movieclips?: Record<ID, MovieClipData>;
  }
  interface SceneData {
    /** clip used by constraints with "Active Clip" enabled */
    active_clip?: ID | null;
  }
}

// ---------------------------------------------------------------------------
// defaults (factory settings)

export function defaultTrackingSettings(): MovieTrackingSettings {
  return {
    default_pattern_size: 21,
    default_search_size: 71,
    default_motion_model: 'Loc',
    default_pattern_match: 'KEYFRAME',
    default_margin: 0,
    default_correlation_min: 0.75,
    default_frames_limit: 0,
    use_default_brute: true,
    use_default_normalization: false,
    use_default_red_channel: true,
    use_default_green_channel: true,
    use_default_blue_channel: true,
    default_weight: 1,
    ...solveSettingsDefaults(),
  };
}

function solveSettingsDefaults(): Partial<MovieTrackingSettings> {
  return {
    use_keyframe_selection: true,
    use_tripod_solver: false,
    refine_intrinsics_focal_length: false,
    refine_intrinsics_principal_point: false,
    refine_intrinsics_radial_distortion: false,
    refine_intrinsics_tangential_distortion: false,
    clean_frames: 0,
    clean_error: 0,
    clean_action: 'SELECT',
    distance: 1,
    object_distance: 1,
  };
}

const CAMERA_EXTRA = { division_k1: 0, division_k2: 0, brown_k1: 0, brown_k2: 0, brown_k3: 0, brown_k4: 0, brown_p1: 0, brown_p2: 0 };

/** Fill the camera-solve fields older files lack (settings, lens models, solution, objects). */
export function normalizeTracking(t: MovieTracking) {
  for (const [k, v] of Object.entries(solveSettingsDefaults())) if ((t.settings as unknown as Record<string, unknown>)[k] === undefined) (t.settings as unknown as Record<string, unknown>)[k] = v;
  for (const [k, v] of Object.entries(CAMERA_EXTRA)) if ((t.camera as unknown as Record<string, unknown>)[k] === undefined) (t.camera as unknown as Record<string, unknown>)[k] = v;
  t.camera.distortion_model ??= 'POLYNOMIAL';
  t.reconstruction ??= emptyReconstruction();
  t.plane_tracks ??= [];
  t.objects ??= [];
  t.active_object_index ??= 0;
  t.keyframe_a ??= 1;
  t.keyframe_b ??= 30;
  for (const o of t.objects) {
    o.reconstruction ??= emptyReconstruction();
    o.plane_tracks ??= [];
  }
}

export function defaultTrackingCamera(): MovieTrackingCamera {
  return { sensor_width: 35, focal_length: 24, units: 'MILLIMETERS', principal_point: [0, 0], pixel_aspect: 1, distortion_model: 'POLYNOMIAL', k1: 0, k2: 0, k3: 0, ...CAMERA_EXTRA };
}

export function defaultStabilization(): MovieTrackingStabilization {
  return {
    use_2d_stabilization: false,
    anchor_frame: 1,
    use_stabilize_rotation: false,
    use_stabilize_scale: false,
    target_position: [0, 0],
    target_rotation: 0,
    target_scale: 1,
    use_autoscale: false,
    scale_max: 2,
    influence_location: 1,
    influence_rotation: 1,
    influence_scale: 1,
    filter_type: 'BILINEAR',
    show_tracks_expanded: true,
    active_track_index: 0,
    active_rotation_track_index: 0,
  };
}

export function newMovieClip(id: ID, name: string, opts: Partial<MovieClipData> = {}): MovieClipData {
  return {
    id,
    name,
    source: 'MOVIE',
    filepath: '',
    movie: null,
    sequence: null,
    size: [0, 0],
    fps: 24,
    frame_start: 1,
    frame_offset: 0,
    frame_duration: 0,
    tracking: { settings: defaultTrackingSettings(), camera: defaultTrackingCamera(), tracks: [], active_track: null, stabilization: defaultStabilization(), reconstruction: emptyReconstruction(), plane_tracks: [], objects: [], active_object_index: 0, keyframe_a: 1, keyframe_b: 30 },
    users: 0,
    ...opts,
  };
}

/** Marker with pattern/search areas sized from the clip defaults (pixel sizes → normalized). */
export function newMarker(frame: number, co: Vec2, size: [number, number], patternPx: number, searchPx: number): MovieTrackingMarker {
  const px = patternPx / 2 / size[0],
    py = patternPx / 2 / size[1];
  const sx = searchPx / 2 / size[0],
    sy = searchPx / 2 / size[1];
  return {
    frame,
    co: [co[0], co[1]],
    pattern_corners: [
      [-px, -py],
      [px, -py],
      [px, py],
      [-px, py],
    ],
    search_min: [-sx, -sy],
    search_max: [sx, sy],
    mute: false,
    is_keyed: true,
  };
}

export function newTrack(tracking: MovieTracking, name: string): MovieTrackingTrack {
  const s = tracking.settings;
  return {
    name: uniqueTrackName(tracking, name),
    markers: [],
    select: true,
    hide: false,
    lock: false,
    motion_model: s.default_motion_model,
    pattern_match: s.default_pattern_match,
    margin: s.default_margin,
    correlation_min: s.default_correlation_min,
    frames_limit: s.default_frames_limit,
    use_brute: s.use_default_brute,
    use_normalization: s.use_default_normalization,
    use_red_channel: s.use_default_red_channel,
    use_green_channel: s.use_default_green_channel,
    use_blue_channel: s.use_default_blue_channel,
    use_grayscale_preview: false,
    weight: s.default_weight,
    weight_stab: 1,
    offset: [0, 0],
    use_custom_color: false,
    color: [0, 0, 0],
    use_2d_stabilization: false,
    use_2d_stabilization_rotation: false,
  };
}

/** Track name unique within the active tracking object (or the given object). */
export function uniqueTrackName(tracking: MovieTracking | TrackingObjectData, base: string): string {
  const owner = 'settings' in tracking ? activeObjectData(tracking as MovieTracking) : tracking;
  const names = new Set(owner.tracks.map((t) => t.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

// ---------------------------------------------------------------------------
// accessors

/** The tracking object being edited (its tracks are the ones shown in the clip editor). */
export function tobj(clip: MovieClipData): TrackingObjectData {
  return activeObjectData(clip.tracking);
}

export function activeObjectData(tracking: MovieTracking): TrackingObjectData {
  const i = tracking.active_object_index ?? 0;
  return (i > 0 && tracking.objects?.[i - 1]) || tracking;
}

/** Whether the active tracking object is the camera. */
export function isCameraActive(clip: MovieClipData): boolean {
  const i = clip.tracking.active_object_index ?? 0;
  return !(i > 0 && clip.tracking.objects?.[i - 1]);
}

/** Tracking object by name ('' or the camera's name: the camera). */
export function trackingObjectByName(clip: MovieClipData, name: string | null | undefined): TrackingObjectData {
  if (!name || name === cameraObjectName(clip)) return clip.tracking;
  return clip.tracking.objects?.find((o) => o.name === name) ?? clip.tracking;
}

export function cameraObjectName(clip: MovieClipData) {
  return clip.tracking.camera_object_name ?? 'Camera';
}

/** All tracking objects: the camera first. */
export function trackingObjects(clip: MovieClipData): { name: string; data: TrackingObjectData; is_camera: boolean }[] {
  return [{ name: cameraObjectName(clip), data: clip.tracking, is_camera: true }, ...(clip.tracking.objects ?? []).map((o) => ({ name: o.name, data: o as TrackingObjectData, is_camera: false }))];
}

export function emptyReconstruction(): MovieTrackingReconstruction {
  return { is_valid: false, average_error: 0, cameras: [] };
}

export function reconstructionOf(o: TrackingObjectData): MovieTrackingReconstruction {
  return (o.reconstruction ??= emptyReconstruction());
}

export function planeTracksOf(o: TrackingObjectData): MovieTrackingPlaneTrack[] {
  return (o.plane_tracks ??= []);
}

export function clipTable(doc: { movieclips?: Record<ID, MovieClipData> }): Record<ID, MovieClipData> {
  return (doc.movieclips ??= {});
}

/** Scene frame → clip frame (track/marker frames). */
export function sceneToClipFrame(clip: MovieClipData, sceneFrame: number) {
  return sceneFrame - clip.frame_start + 1;
}
export function clipToSceneFrame(clip: MovieClipData, clipFrame: number) {
  return clipFrame + clip.frame_start - 1;
}
/** Clip frame → zero based index into the footage (frame offset shifts which file frame is shown). */
export function clipFrameToSourceIndex(clip: MovieClipData, clipFrame: number) {
  return clipFrame - 1 + clip.frame_offset;
}

/** Index of the marker exactly at `frame`, or -1. Markers are kept sorted by frame. */
export function markerIndex(track: MovieTrackingTrack, frame: number): number {
  const m = track.markers;
  let lo = 0,
    hi = m.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (m[mid].frame === frame) return mid;
    if (m[mid].frame < frame) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function markerExact(track: MovieTrackingTrack, frame: number): MovieTrackingMarker | null {
  const i = markerIndex(track, frame);
  return i < 0 ? null : track.markers[i];
}

/** Marker in effect at `frame`: the last marker at or before it (or the first marker). */
export function markerAt(track: MovieTrackingTrack, frame: number): MovieTrackingMarker | null {
  const m = track.markers;
  if (!m.length) return null;
  let lo = 0,
    hi = m.length - 1,
    best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (m[mid].frame <= frame) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return m[best];
}

/** Enabled marker in effect at `frame` (null when the track is disabled there or has no marker). */
export function enabledMarkerAt(track: MovieTrackingTrack, frame: number): MovieTrackingMarker | null {
  const mk = markerAt(track, frame);
  if (!mk || mk.mute) return null;
  if (frame < track.markers[0].frame) return null;
  return mk;
}

/** Insert or replace the marker at its frame, keeping order. Returns the stored marker. */
export function insertMarker(track: MovieTrackingTrack, marker: MovieTrackingMarker): MovieTrackingMarker {
  const i = markerIndex(track, marker.frame);
  if (i >= 0) {
    track.markers[i] = marker;
    return marker;
  }
  let j = track.markers.length;
  while (j > 0 && track.markers[j - 1].frame > marker.frame) j--;
  track.markers.splice(j, 0, marker);
  return marker;
}

export function cloneMarker(m: MovieTrackingMarker, frame = m.frame): MovieTrackingMarker {
  return {
    frame,
    co: [m.co[0], m.co[1]],
    pattern_corners: m.pattern_corners.map((c) => [c[0], c[1]]) as MovieTrackingMarker['pattern_corners'],
    search_min: [m.search_min[0], m.search_min[1]],
    search_max: [m.search_max[0], m.search_max[1]],
    mute: m.mute,
    is_keyed: m.is_keyed,
  };
}

/** Marker at `frame`, creating a keyframed copy of the marker in effect if there is none. */
export function ensureMarker(track: MovieTrackingTrack, frame: number): MovieTrackingMarker | null {
  const exact = markerExact(track, frame);
  if (exact) return exact;
  const held = markerAt(track, frame);
  if (!held) return null;
  const m = cloneMarker(held, frame);
  m.is_keyed = true;
  return insertMarker(track, m);
}

export function activeTrack(clip: MovieClipData): MovieTrackingTrack | null {
  const o = tobj(clip);
  const n = o.active_track;
  return n ? (o.tracks.find((t) => t.name === n) ?? null) : null;
}

/** Focal length in pixels for the clip width. */
export function focalPixels(clip: MovieClipData): number {
  const c = clip.tracking.camera;
  return (c.focal_length * clip.size[0]) / Math.max(1e-6, c.sensor_width);
}

/** Optical center in pixels (origin bottom-left). */
export function principalPixels(clip: MovieClipData): Vec2 {
  const c = clip.tracking.camera;
  return [((c.principal_point[0] + 1) / 2) * clip.size[0], ((c.principal_point[1] + 1) / 2) * clip.size[1]];
}

/** Tracked frame range [first, last] of a track (enabled spans only), or null. */
export function trackSpan(track: MovieTrackingTrack): [number, number] | null {
  let a = Infinity,
    b = -Infinity;
  for (const m of track.markers)
    if (!m.mute) {
      a = Math.min(a, m.frame);
      b = Math.max(b, m.frame);
    }
  return a <= b ? [a, b] : null;
}

/** Display color of a track (custom color or the default theme colors). */
export function trackColor(track: MovieTrackingTrack, selected = track.select): string {
  if (track.use_custom_color) {
    const c = track.color.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  return selected ? '#fcd745' : '#000000';
}
