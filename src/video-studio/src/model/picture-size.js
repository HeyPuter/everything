/** Logical dimensions of a rasterized picture, independent of its pixel grid. */
export function normalizePictureSize(size) {
  return Number.isFinite(size?.width) && Number.isFinite(size?.height) && size.width > 0 && size.height > 0
    ? { width: size.width, height: size.height } : null;
}

/** A clip may override the framing saved with its generated media item. */
export function pictureSizeFor(clip, asset) {
  return clip?.pictureSize || asset?.pictureSize || null;
}
