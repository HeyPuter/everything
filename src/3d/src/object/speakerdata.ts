// Speaker sound settings (stored on SPEAKER objects): the type and defaults, with no UI
// dependencies so the scripting API can use them.
import type { MediaFile } from '../sequencer/types';

export interface SpeakerSettings {
  sound: MediaFile | null;
  volume: number;
  pitch: number;
  muted: boolean;
  /** scene frame at which the sound starts */
  frame_start: number;
  distance_reference: number;
  distance_max: number;
  attenuation: number;
  /** full cone angles in radians */
  cone_angle_inner: number;
  cone_angle_outer: number;
  cone_volume_outer: number;
}

export function defaultSpeaker(): SpeakerSettings {
  return {
    sound: null,
    volume: 1,
    pitch: 1,
    muted: false,
    frame_start: 1,
    distance_reference: 1,
    distance_max: 10000,
    attenuation: 1,
    cone_angle_inner: 2 * Math.PI,
    cone_angle_outer: 2 * Math.PI,
    cone_volume_outer: 1,
  };
}
