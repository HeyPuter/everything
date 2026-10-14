// Compress Pictures: each embedded picture is resampled to no more pixels
// than its largest use on a slide needs at the chosen resolution, cropped
// areas can be deleted, and the result is re-encoded in its own format.
// Pictures keep their part names and content types, so every reference to
// them stays valid.

const EMU_PER_INCH = 914400;
const SLIDE_PART = /^\/ppt\/slides\/slide\d+\.xml$/i;

const resolveTarget = (source, target) => {
  if (target.startsWith("/")) return target;
  const segments = [];
  for (const seg of [...source.split("/").slice(0, -1), ...target.split("/")]) {
    if (seg === "..") segments.pop();
    else if (seg !== "." && seg) segments.push(seg);
  }
  return `/${segments.join("/")}`;
};

export const COMPRESSIBLE = new Set(["image/png", "image/jpeg"]);

// Every picture part with the places it is used. A use on a slide picture
// knows its size and crop; anything else (a fill, a background, a layout's
// logo) is counted as needing at most the whole slide.
export function collectPictures(P, pres, { bounds, selection = null } = {}) {
  const pkg = P._internalPackageOf(pres);
  const size = P.getSlideSize(pres) || { width: 12192000, height: 6858000 };
  const parts = new Map();
  for (const media of P.getMediaParts(pres)) {
    if (!media.contentType.startsWith("image/")) continue;
    parts.set(media.name.toLowerCase(), {
      name: media.name,
      contentType: media.contentType,
      size: media.data.byteLength,
      uses: [],
      selected: false,
    });
  }
  const pictureSources = new Map(); // part → Set(slide part)
  for (const slide of P.getSlides(pres)) {
    const slidePart = P.getSlidePartName(slide);
    for (const shape of P.getSlideShapes(slide)) {
      if (P.getShapeKind(shape) !== "picture") continue;
      const name = P.getShapeImagePartName(shape)?.toLowerCase();
      const entry = name && parts.get(name);
      if (!entry) continue;
      const b = bounds(shape);
      if (!b) continue;
      let crop = null;
      try {
        crop = P.getShapeImageCrop(shape);
      } catch {}
      entry.uses.push({
        kind: "picture",
        slidePart,
        shapeId: P.getShapeId(shape),
        w: b.w,
        h: b.h,
        crop,
      });
      if (selection?.has(`${slidePart}#${P.getShapeId(shape)}`))
        entry.selected = true;
      if (!pictureSources.has(name)) pictureSources.set(name, new Set());
      pictureSources.get(name).add(slidePart);
    }
  }
  // Other references: any relationship to the part from a part that showed
  // no picture of it.
  for (const part of pkg.parts) {
    const rels = pkg.getRels(part.name);
    if (!rels) continue;
    for (const rel of rels.items) {
      if (rel.targetMode === "External") continue;
      const target = resolveTarget(part.name, rel.target).toLowerCase();
      const entry = parts.get(target);
      if (!entry) continue;
      const fromPicture =
        SLIDE_PART.test(part.name) &&
        pictureSources.get(target)?.has(part.name);
      if (!fromPicture)
        entry.uses.push({
          kind: "other",
          w: size.width,
          h: size.height,
          crop: null,
        });
    }
  }
  return [...parts.values()];
}

// What to do with one picture `width`×`height` pixels: the scale to draw it
// at (1 keeps its size), and the source rectangle to keep when cropped
// areas go. `ppi` null keeps the resolution.
export function planPicture(
  entry,
  { width, height },
  { ppi = 150, deleteCropped = true } = {},
) {
  const uses = entry.uses;
  if (!uses.length || !width || !height) return null;
  const crops = uses.map((u) => u.crop);
  const sameCrop = crops.every(
    (c) => JSON.stringify(c || null) === JSON.stringify(crops[0] || null),
  );
  const c = crops[0];
  const trims =
    deleteCropped &&
    sameCrop &&
    uses.every((u) => u.kind === "picture") &&
    c &&
    ["left", "top", "right", "bottom"].every((k) => (c[k] || 0) >= 0) &&
    ["left", "top", "right", "bottom"].some((k) => (c[k] || 0) > 0) &&
    (c.left || 0) + (c.right || 0) < 1 &&
    (c.top || 0) + (c.bottom || 0) < 1;
  const keep = trims
    ? {
        x: Math.round(width * (c.left || 0)),
        y: Math.round(height * (c.top || 0)),
        w: Math.max(
          1,
          Math.round(width * (1 - (c.left || 0) - (c.right || 0))),
        ),
        h: Math.max(
          1,
          Math.round(height * (1 - (c.top || 0) - (c.bottom || 0))),
        ),
      }
    : { x: 0, y: 0, w: width, h: height };
  let scale = 1;
  if (ppi) {
    scale = 0;
    for (const use of uses) {
      // The pixels the visible part needs, spread over the whole image.
      const visibleW = 1 - (use.crop?.left || 0) - (use.crop?.right || 0);
      const visibleH = 1 - (use.crop?.top || 0) - (use.crop?.bottom || 0);
      const needW = ((use.w / EMU_PER_INCH) * ppi) / Math.max(0.01, visibleW);
      const needH = ((use.h / EMU_PER_INCH) * ppi) / Math.max(0.01, visibleH);
      scale = Math.max(scale, needW / width, needH / height);
    }
    scale = Math.min(1, scale);
  }
  const out = {
    keep,
    trims: !!trims,
    width: Math.max(1, Math.round(keep.w * scale)),
    height: Math.max(1, Math.round(keep.h * scale)),
  };
  if (!out.trims && out.width >= width && out.height >= height) return null;
  return out;
}

// Re-encodes the pictures in the browser. `apply(part, bytes, trimmed)` stores
// a smaller picture. Resolves to { before, after, changed }.
export async function compressPictureParts(
  P,
  pres,
  entries,
  { ppi, deleteCropped, jpegQuality = 0.85, progress },
) {
  let before = 0,
    after = 0,
    changed = 0;
  const results = [];
  for (const [i, entry] of entries.entries()) {
    progress?.(i / entries.length);
    if (!COMPRESSIBLE.has(entry.contentType)) continue;
    const bytes = P.readPackagePart(pres, entry.name);
    if (!bytes) continue;
    let bitmap;
    try {
      bitmap = await createImageBitmap(
        new Blob([bytes], { type: entry.contentType }),
      );
    } catch {
      continue;
    }
    const plan = planPicture(
      entry,
      { width: bitmap.width, height: bitmap.height },
      { ppi, deleteCropped },
    );
    if (!plan) {
      bitmap.close?.();
      continue;
    }
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    const jpeg = entry.contentType === "image/jpeg";
    if (jpeg) {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, plan.width, plan.height);
    }
    context.drawImage(
      bitmap,
      plan.keep.x,
      plan.keep.y,
      plan.keep.w,
      plan.keep.h,
      0,
      0,
      plan.width,
      plan.height,
    );
    bitmap.close?.();
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, entry.contentType, jpeg ? jpegQuality : undefined),
    );
    if (!blob) continue;
    const next = new Uint8Array(await blob.arrayBuffer());
    // A re-encode that would grow the file is kept only to drop crops.
    if (next.byteLength >= bytes.byteLength && !plan.trims) continue;
    before += bytes.byteLength;
    after += next.byteLength;
    changed++;
    results.push({ entry, bytes: next, trims: plan.trims });
  }
  progress?.(1);
  return { before, after, changed, results };
}

// Writes compressed pictures into the presentation and clears the crops of
// pictures whose cropped areas were deleted.
export function applyCompressedPictures(P, pres, results) {
  const trimmed = new Map();
  for (const { entry, bytes, trims } of results) {
    P.setMediaPartBytes(pres, entry.name, bytes);
    if (trims)
      for (const use of entry.uses)
        if (use.kind === "picture") {
          if (!trimmed.has(use.slidePart))
            trimmed.set(use.slidePart, new Set());
          trimmed.get(use.slidePart).add(use.shapeId);
        }
  }
  for (const slide of P.getSlides(pres)) {
    const ids = trimmed.get(P.getSlidePartName(slide));
    if (!ids) continue;
    for (const shape of P.getSlideShapes(slide))
      if (ids.has(P.getShapeId(shape)) && P.getShapeKind(shape) === "picture")
        P.setShapeImageCrop(shape, null);
  }
}

// The slide numbers whose relationships point at each media part.
export function mediaSlides(P, pres) {
  const pkg = P._internalPackageOf(pres);
  const out = new Map();
  P.getSlides(pres).forEach((slide, i) => {
    const part = P.getSlidePartName(slide);
    for (const rel of pkg.getRels(part)?.items || []) {
      if (rel.targetMode === "External") continue;
      const target = resolveTarget(part, rel.target).toLowerCase();
      if (!out.has(target)) out.set(target, []);
      const list = out.get(target);
      if (list.at(-1) !== i + 1) list.push(i + 1);
    }
  });
  return out;
}
