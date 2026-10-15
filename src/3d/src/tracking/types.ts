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
}

export interface MovieTrackingCamera {
  sensor_width: number;
  /** focal length in millimeters (pixels are derived from the sensor width and clip width) */
  focal_length: number;
  units: 'PIXELS' | 'MILLIMETERS';
  /** optical center, normalized to -1..1 around the frame center */
  principal_point: Vec2;
  pixel_aspect: number;
  distortion_model: 'POLYNOMIAL';
  k1: number;
  k2: number;
  k3: number;
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

export interface MovieTracking {
  settings: MovieTrackingSettings;
  camera: MovieTrackingCamera;
  tracks: MovieTrackingTrack[];
  /** name of the active track */
  active_track: string | null;
  stabilization: MovieTrackingStabilization;
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
  };
}

export function defaultTrackingCamera(): MovieTrackingCamera {
  return { sensor_width: 35, focal_length: 24, units: 'MILLIMETERS', principal_point: [0, 0], pixel_aspect: 1, distortion_model: 'POLYNOMIAL', k1: 0, k2: 0, k3: 0 };
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
    tracking: { settings: defaultTrackingSettings(), camera: defaultTrackingCamera(), tracks: [], active_track: null, stabilization: defaultStabilization() },
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

export function uniqueTrackName(tracking: MovieTracking, base: string): string {
  const names = new Set(tracking.tracks.map((t) => t.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

// ---------------------------------------------------------------------------
// accessors

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
  const n = clip.tracking.active_track;
  return n ? (clip.tracking.tracks.find((t) => t.name === n) ?? null) : null;
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
