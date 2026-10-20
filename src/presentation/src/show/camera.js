// The presenter's camera: a live camera object placed on a slide that shows
// the camera during the show, and the camera stream the show and the
// recording studio share.
//
// In the file a live camera is a picture of a camera frame (so any reader
// shows something sensible) named "Live Camera n", carrying the app's object
// record { type: "camera", shape }. During the show the picture's box shows
// the camera instead.

export const CAMERA_NAME = "Live Camera";

// A camera frame, drawn here.
export const CAMERA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 64 64"><defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E8EEF6"/><stop offset="1" stop-color="#C9D5E4"/></linearGradient></defs><rect width="64" height="64" fill="url(#b)"/><rect x="14" y="23" width="26" height="19" rx="4" fill="#3B5B86"/><path d="M41 29l10-6v19l-10-6z" fill="#3B5B86"/><circle cx="21" cy="30" r="2.2" fill="#9CC3F0"/></svg>`;

export const isCameraShape = (P, shape) => {
  try {
    return P.getShapeObjectData?.(shape)?.type === "camera";
  } catch {
    return false;
  }
};

export const cameraShapeKind = (P, shape) =>
  P.getShapeObjectData?.(shape)?.shape === "rect" ? "rect" : "circle";

/** Adds a live camera to a slide. `png` is CAMERA_SVG drawn as a picture. */
export function addCameraShape(
  P,
  slide,
  { png, svg, size, shape = "circle", box = null },
) {
  const side = Math.round(Math.min(size.cx, size.cy) * 0.32);
  const margin = Math.round(size.cy * 0.05);
  const existing = P.getSlideShapes(slide).filter((s) => isCameraShape(P, s));
  const picture = P.addSlideVectorPicture(
    slide,
    { png, svg },
    {
      x: box ? box.x : size.cx - side - margin,
      y: box ? box.y : size.cy - side - margin,
      w: box ? box.w : side,
      h: box ? box.h : side,
      name: `${CAMERA_NAME} ${existing.length + 1}`,
    },
  );
  if (shape === "circle") P.setShapePresetGeometry(picture, "ellipse");
  P.setShapeObjectData(picture, { type: "camera", shape });
  P.setShapeDescription(
    picture,
    "Live camera feed shown during the slide show",
  );
  return picture;
}

/** One camera (and microphone) stream for the whole show, asked for once. */
export function createCameraSource() {
  let stream = null;
  let pending = null;
  let failure = null;
  const users = new Set();
  async function get({ video = true, audio = false, cameraId, micId } = {}) {
    const want = {
      video: video
        ? cameraId
          ? { deviceId: { exact: cameraId } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } }
        : false,
      audio: audio ? (micId ? { deviceId: { exact: micId } } : true) : false,
    };
    const media = globalThis.navigator?.mediaDevices;
    if (!media?.getUserMedia)
      throw new Error("This browser cannot use a camera or microphone.");
    return media.getUserMedia(want);
  }
  return {
    /** The shared camera stream; resolves null when there is no camera. */
    async camera() {
      if (stream) return stream;
      if (failure) return null;
      if (pending) return pending;
      const asked = (pending = get({ video: true }).then(
        (s) => {
          // Stopped while the browser asked: let the camera go.
          if (pending !== asked) {
            s.getTracks().forEach((t) => t.stop());
            return null;
          }
          return (stream = s);
        },
        (error) => {
          if (pending === asked) failure = error;
          return null;
        },
      ));
      return asked;
    },
    get failure() {
      return failure;
    },
    get stream() {
      return stream;
    },
    open: get,
    users,
    stop() {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      pending = null;
      failure = null;
    },
  };
}

/** Lays live video over every camera object of the slide on `layer`. */
export function placeCameras({ P, slide, layer, size, source, bounds }) {
  const nodes = [];
  for (const shape of P.getSlideShapes(slide)) {
    if (!isCameraShape(P, shape)) continue;
    const b = bounds(shape);
    if (!b) continue;
    const doc = layer.ownerDocument;
    const box = doc.createElement("div");
    box.className = `show-camera ${cameraShapeKind(P, shape)}`;
    Object.assign(box.style, {
      left: `${(b.x / size.width) * 100}%`,
      top: `${(b.y / size.height) * 100}%`,
      width: `${(b.w / size.width) * 100}%`,
      height: `${(b.h / size.height) * 100}%`,
    });
    const video = doc.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute("aria-label", "Presenter camera");
    box.append(video);
    layer.append(box);
    nodes.push(box);
    source.camera().then((stream) => {
      if (!stream || !box.isConnected) return;
      video.srcObject = stream;
      video.play().catch(() => {});
      box.classList.add("live");
    });
  }
  return () => nodes.forEach((n) => n.remove());
}
