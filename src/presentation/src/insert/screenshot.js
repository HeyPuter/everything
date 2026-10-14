// Screenshot: capture a window, tab or screen the person shares, then insert
// all of it or a region of it ("screen clipping"), dragged out over the
// captured picture.
import { el, dialog, toast } from "../ui.js";
import { canvasPng } from "./util.js";

async function captureFrame() {
  if (!navigator.mediaDevices?.getDisplayMedia)
    throw new Error("This browser cannot capture the screen.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false,
    });
  } catch (error) {
    if (error?.name === "NotAllowedError") return null;
    throw new Error("The screen could not be captured.");
  }
  try {
    const video = el("video", { muted: true, playsinline: true });
    video.srcObject = stream;
    await video.play();
    // The first frames can be blank while the capture starts.
    await new Promise((r) => setTimeout(r, 250));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    return canvas;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** Lets the person drag out a region; resolves to a canvas or null. */
async function clipRegion(source) {
  const image = el("img", {
    class: "clip-image",
    src: source.toDataURL("image/png"),
    alt: "Captured screen",
    draggable: "false",
  });
  const marquee = el("div", { class: "clip-marquee", hidden: true });
  const hint = el(
    "p",
    { class: "clip-hint", role: "status" },
    "Drag over the part to insert, or insert the whole capture.",
  );
  const stage = el(
    "div",
    {
      class: "clip-stage",
      tabindex: 0,
      "aria-label": "Captured screen. Drag to choose a region.",
    },
    image,
    marquee,
  );
  let region = null;
  let start = null;
  const point = (e) => {
    const r = image.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
      y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
      r,
    };
  };
  stage.addEventListener("pointerdown", (e) => {
    start = point(e);
    stage.setPointerCapture(e.pointerId);
    marquee.hidden = false;
    e.preventDefault();
  });
  stage.addEventListener("pointermove", (e) => {
    if (!start) return;
    const p = point(e);
    const x = Math.min(start.x, p.x),
      y = Math.min(start.y, p.y),
      w = Math.abs(p.x - start.x),
      h = Math.abs(p.y - start.y);
    Object.assign(marquee.style, {
      left: `${image.offsetLeft + x}px`,
      top: `${image.offsetTop + y}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
    const scale = source.width / p.r.width;
    region =
      w > 4 && h > 4
        ? { x: x * scale, y: y * scale, w: w * scale, h: h * scale }
        : null;
    hint.textContent = region
      ? `Region ${Math.round(region.w)} × ${Math.round(region.h)} pixels.`
      : "Drag over the part to insert, or insert the whole capture.";
  });
  stage.addEventListener("pointerup", () => (start = null));
  const choice = await dialog({
    title: "Screen Clipping",
    body: el("div", { class: "dialog-body clip-dialog" }, stage, hint),
    actions: [
      { label: "Cancel", value: null },
      { label: "Insert Whole Capture", value: "whole" },
      { label: "Insert Region", value: "region", kind: "primary" },
    ],
  });
  if (!choice) return null;
  if (choice === "whole" || !region) {
    if (choice === "region" && !region)
      toast("No region was dragged; the whole capture was inserted.");
    return source;
  }
  const out = document.createElement("canvas");
  out.width = Math.round(region.w);
  out.height = Math.round(region.h);
  out
    .getContext("2d")
    .drawImage(
      source,
      region.x,
      region.y,
      region.w,
      region.h,
      0,
      0,
      out.width,
      out.height,
    );
  return out;
}

export function createScreenshotFeatures(ctx) {
  async function screenshot({ clip = false } = {}) {
    const frame = await captureFrame();
    if (!frame) return;
    const canvas = clip ? await clipRegion(frame) : frame;
    if (!canvas) return;
    const bytes = await canvasPng(canvas);
    const file = new File([bytes], "Screenshot.png", { type: "image/png" });
    await ctx.insertImageFile(file);
  }
  const menu = () => [
    {
      label: "Capture a Window or Screen…",
      icon: "o:screenshot",
      onSelect: () => screenshot().catch(ctx.fail),
    },
    {
      label: "Screen Clipping…",
      icon: "o:crop",
      onSelect: () => screenshot({ clip: true }).catch(ctx.fail),
    },
  ];
  return { screenshot, menu, clipRegion };
}
