// Placement of camera background images in the camera frame (pure, unit-tested).
import type { CameraBackgroundImage } from '../../data/types';

export type Rect = { x: number; y: number; w: number; h: number };

export function newBackgroundImage(image: string | null = null): CameraBackgroundImage {
  return { source: 'IMAGE', image, clip: null, use_camera_clip: true, alpha: 0.5, display_depth: 'BACK', frame_method: 'STRETCH', offset: [0, 0], rotation: 0, scale: 1, use_flip_x: false, use_flip_y: false, show_background_image: true, show_expanded: true };
}

/**
 * Where a background image lands in the camera frame (view pixels, y down): its centre, size and
 * rotation. Fit keeps the whole image inside the frame, Crop fills the frame, Stretch matches it.
 */
export function backgroundImagePlacement(frame: Rect, imgW: number, imgH: number, bg: Pick<CameraBackgroundImage, 'frame_method' | 'offset' | 'rotation' | 'scale'>) {
  let w = frame.w,
    h = frame.h;
  if (bg.frame_method !== 'STRETCH' && imgW > 0 && imgH > 0) {
    const s = bg.frame_method === 'FIT' ? Math.min(frame.w / imgW, frame.h / imgH) : Math.max(frame.w / imgW, frame.h / imgH);
    w = imgW * s;
    h = imgH * s;
  }
  w *= bg.scale;
  h *= bg.scale;
  // offsets are in frame widths (x right, y up)
  const cx = frame.x + frame.w / 2 + bg.offset[0] * frame.w;
  const cy = frame.y + frame.h / 2 - bg.offset[1] * frame.w;
  return { cx, cy, w, h, rotation: bg.rotation };
}

