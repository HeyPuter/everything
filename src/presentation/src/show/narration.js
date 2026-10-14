// Recorded narration in the file: per slide, a sound (or, with the camera
// on, a video) object that plays by itself when the slide comes up, as
// desktop editors store slide show recordings. A sound narration is hidden
// during the show; a video narration shows the presenter in the corner.
// The app's object record marks them, so they can be found, replaced and
// cleared, and left out of the show when narrations are turned off.

export const NARRATION_NAME = "Narration";

export function isNarration(P, shape) {
  try {
    return (
      !!P.getShapeMediaKind?.(shape) &&
      P.getShapeObjectData?.(shape)?.recording === "narration"
    );
  } catch {
    return false;
  }
}

export const slideNarrations = (P, slide) =>
  P.getSlideShapes(slide).filter((s) => isNarration(P, s));

export const hasNarration = (P, slide) => slideNarrations(P, slide).length > 0;

/** The slide's narration media: { data, contentType, kind, durationMs }. */
export function narrationOf(P, slide) {
  const shape = slideNarrations(P, slide)[0];
  if (!shape) return null;
  const media = P.getShapeMedia(shape);
  if (!media) return null;
  const data = P.getShapeObjectData(shape) || {};
  return {
    data: media.data,
    contentType: media.contentType,
    kind: media.kind,
    durationMs: Number(data.durationMs) || 0,
    // Where a recording with the camera shows, in EMU, and its outline.
    bounds: P.getShapeBounds(shape),
    shape: data.shape === "rect" ? "rect" : "circle",
  };
}

/** Takes a slide's narration away. Returns whether there was one. */
export function removeNarrations(P, slide) {
  const shapes = slideNarrations(P, slide);
  for (const shape of shapes) P.removeShape(shape);
  return shapes.length > 0;
}

/**
 * Adds a narration to a slide, replacing any it had.
 * media: { kind: "audio"|"video", data, contentType, durationMs, poster,
 *          shape?: "circle"|"rect" }
 */
export function addNarration(P, slide, media, size) {
  removeNarrations(P, slide);
  let box = media.box || null;
  if (box) {
    // In place of a live camera the recording replaced.
  } else if (media.kind === "video") {
    const side = Math.round(Math.min(size.cx, size.cy) * 0.28);
    const margin = Math.round(size.cy * 0.04);
    box = {
      x: size.cx - side - margin,
      y: size.cy - side - margin,
      w: side,
      h: side,
    };
  } else {
    // A small speaker in the corner, hidden during the show.
    const side = P.inches ? P.inches(0.4) : 365760;
    box = {
      x: size.cx - side - Math.round(size.cy * 0.02),
      y: size.cy - side - Math.round(size.cy * 0.02),
      w: side,
      h: side,
    };
  }
  const shape = P.addSlideMedia(
    slide,
    {
      kind: media.kind,
      data: media.data,
      contentType: media.contentType,
      poster: media.poster,
    },
    {
      ...box,
      name: `${NARRATION_NAME} ${media.kind === "video" ? "Video" : "Audio"}`,
    },
    {
      durationMs: media.durationMs,
      start: "automatically",
      hideWhileNotPlaying: media.kind === "audio",
    },
  );
  if (media.kind === "video" && media.shape !== "rect")
    P.setShapePresetGeometry(shape, "ellipse");
  P.setShapeObjectData(shape, {
    type: "media",
    durationMs: media.durationMs,
    recording: "narration",
    ...(media.kind === "video" ? { shape: media.shape || "circle" } : {}),
  });
  P.setShapeDescription(
    shape,
    media.kind === "video"
      ? "Recorded narration with camera"
      : "Recorded narration",
  );
  return shape;
}

/** Sets how long a slide stays before the show moves on by itself,
 * keeping the rest of its transition. `ms` null clears it. */
export function setSlideAdvance(P, slide, ms) {
  let current = null;
  try {
    current = P.getEffectiveSlideTransition(slide);
  } catch {}
  P.setSlideTransition(slide, {
    ...(current || { effect: "none" }),
    effect: current?.effect || "none",
    advanceAfterMs: ms == null ? undefined : Math.max(0, Math.round(ms)),
  });
}
