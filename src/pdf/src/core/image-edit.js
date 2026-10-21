import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFStream, PDFObjectCopier } from 'pdf-lib';
import {
  parseContent,
  matrix,
  decode,
  pageSource,
  setPageSource,
  storeStream,
  cloneResources,
  uniqueName,
  pruneEditedFonts,
  pruneEditedForms,
} from './text-edit.js';
import { MAX_IMAGE_SIZE, embedOrientedImage } from './document.js';
import { imageOrientationMatrix, IMAGE_ORIENTATION_KEY } from './image-orientation.js';
import { retainCryptFilter, withoutCryptFilter } from './stream-filters.js';
export { MAX_IMAGE_SIZE };

const identity = [1, 0, 0, 1, 0, 0];
const get = (dict, key) => dict?.lookup(PDFName.of(key));
const numbers = (array) => array?.asArray?.().map((n) => n.asNumber?.());
const error = () => new Error('This image uses a PDF structure that cannot yet be edited.');
export const point = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** Whether a matrix can be undone: finite, and not squashed flat. */
export const invertible = (m) =>
  m.every(Number.isFinite) && Math.abs(m[0] * m[3] - m[1] * m[2]) >= 1e-12;
export function inverse(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!m.every(Number.isFinite) || Math.abs(det) < 1e-12) throw error();
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}
export const imageCorners = (m) =>
  [
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
  ].map(([x, y]) => point(m, x, y));

/** Rotate in PDF coordinates without changing the center, scale, skew, or reflection. */
export function rotateAroundCenter(transform, degrees) {
  inverse(transform);
  if (!Number.isFinite(degrees)) throw new Error('Choose a finite rotation angle.');
  const radians = ((degrees % 360) * Math.PI) / 180;
  const snap = (n) => (Math.abs(n) < 1e-12 ? 0 : n);
  const c = snap(Math.cos(radians)),
    s = snap(Math.sin(radians)),
    [x, y] = point(transform, 0.5, 0.5);
  return matrix([c, s, -s, c, x - c * x + s * y, y - s * x - c * y], transform);
}
const inside = (m, clip) =>
  imageCorners(matrix(clip.inverse, m)).every(
    ([x, y]) =>
      x >= clip.rect[0] - 1e-6 &&
      x <= clip.rect[2] + 1e-6 &&
      y >= clip.rect[1] - 1e-6 &&
      y <= clip.rect[3] + 1e-6,
  );

/** Locate each image paint command, including individual calls through shared forms.
 * No bitmap matching or modifications to the shared image resource are involved.
 * An optional set receives resources whose image placements could not all be measured. */
export function inspectImages(doc, index, { unmeasuredResources } = {}) {
  const images = [];
  function walk(source, resources, initial, path = [], ancestors = new Set()) {
    const first = images.length;
    try {
      if (path.length > 20) {
        unmeasuredResources?.add(resources);
        return;
      }
      let s = { ...initial },
        pendingClip = false,
        currentPath = [];
      const stack = [],
        marked = [];
      for (const command of parseContent(source, { inlineImages: true })) {
        const a = command.args.map((t) => t.value);
        switch (command.op) {
          case 'q':
            stack.push({ ...s });
            break;
          case 'Q':
            if (!stack.length) throw error();
            s = stack.pop();
            break;
          case 'cm':
            if (a.length !== 6 || !a.every(Number.isFinite)) throw error();
            s.ctm = matrix(s.ctm, a);
            break;
          case 're':
            // Under a singular matrix nothing is visible, so a rectangle there can never be a
            // usable clip; it is kept as one that makes a clip unsafe rather than an error that
            // would drop every image the walk has found.
            currentPath.push(
              invertible(s.ctm)
                ? {
                    rect: [
                      Math.min(a[0], a[0] + a[2]),
                      Math.min(a[1], a[1] + a[3]),
                      Math.max(a[0], a[0] + a[2]),
                      Math.max(a[1], a[1] + a[3]),
                    ],
                    inverse: inverse(s.ctm),
                  }
                : false,
            );
            break;
          case 'm':
          case 'l':
          case 'c':
          case 'v':
          case 'y':
            currentPath.push(null);
            break;
          case 'W':
          case 'W*':
            pendingClip = true;
            break;
          case 'n':
          case 'S':
          case 's':
          case 'f':
          case 'F':
          case 'f*':
          case 'B':
          case 'B*':
          case 'b':
          case 'b*':
            if (pendingClip) {
              if (currentPath.length === 1 && currentPath[0])
                s.clips = [...s.clips, currentPath[0]];
              else s.unsafe = true;
            }
            currentPath = [];
            pendingClip = false;
            break;
          case 'Tr':
            s.textClip = a[0] >= 4;
            break;
          case 'ET':
            if (s.textClip) s.unsafe = true;
            break;
          case 'BDC':
          case 'BMC':
            marked.push(s.optional);
            s.optional ||= a[0] === 'OC';
            break;
          case 'EMC':
            s.optional = marked.pop() ?? false;
            break;
          case 'gs': {
            const gs = get(get(resources, 'ExtGState'), a[0]);
            if (!gs) {
              s.unsafe = true;
              break;
            }
            const mask = get(gs, 'SMask');
            if (mask) s.softMask = mask.toString() !== '/None';
            s.opacity = get(gs, 'ca')?.asNumber?.() ?? s.opacity;
            s.blend = get(gs, 'BM')?.decodeText?.() ?? s.blend;
            break;
          }
          case 'Do': {
            const object = get(get(resources, 'XObject'), a[0]);
            const subtype = get(object?.dict, 'Subtype')?.toString();
            if (subtype === '/Form') {
              if (ancestors.has(object)) throw error();
              const ctm = matrix(s.ctm, numbers(get(object.dict, 'Matrix')) || identity);
              // A form squashed flat shows nothing; there is nothing in it to edit.
              if (!invertible(ctm)) break;
              const bbox = numbers(get(object.dict, 'BBox'));
              walk(
                decode(object),
                get(object.dict, 'Resources') || resources,
                {
                  ...s,
                  ctm,
                  optional: s.optional || !!get(object.dict, 'OC'),
                  clips:
                    bbox?.length === 4
                      ? [...s.clips, { rect: bbox, inverse: inverse(ctm) }]
                      : s.clips,
                },
                [
                  ...path,
                  {
                    start: command.start,
                    end: command.end,
                    name: a[0],
                    source: source.slice(command.start, command.end),
                  },
                ],
                new Set([...ancestors, object]),
              );
            } else if (subtype === '/Image') {
              const storedOrientation = get(object.dict, IMAGE_ORIENTATION_KEY)?.asNumber?.();
              const orientation =
                Number.isInteger(storedOrientation) &&
                storedOrientation >= 1 &&
                storedOrientation <= 8
                  ? storedOrientation
                  : 1;
              const transform = matrix(s.ctm, inverse(imageOrientationMatrix(orientation)));
              const valid =
                Math.abs(s.ctm[0] * s.ctm[3] - s.ctm[1] * s.ctm[2]) > 1e-10 &&
                s.ctm.every(Number.isFinite);
              images.push({
                ...command,
                path,
                id: [...path.map((p) => p.start), command.start].join(':'),
                ordinal: images.length,
                transform,
                pixelTransform: s.ctm,
                orientation,
                clips: s.clips,
                object,
                resources,
                opacity: s.opacity,
                blend: s.blend,
                source: source.slice(command.start, command.end),
                editable:
                  valid &&
                  !s.unsafe &&
                  !s.optional &&
                  !s.softMask &&
                  s.opacity > 0 &&
                  !get(object.dict, 'OC') &&
                  get(object.dict, 'ImageMask')?.toString() !== 'true' &&
                  s.clips.every((clip) => inside(s.ctm, clip)),
              });
            }
            break;
          }
        }
      }
    } catch {
      images.splice(first);
      unmeasuredResources?.add(resources);
    }
  }
  const page = doc.getPage(index);
  walk(pageSource(page), page.node.Resources(), {
    ctm: identity,
    clips: [],
    opacity: 1,
    blend: 'Normal',
  });
  return images;
}

/** Keep an image within clipping frames that enclose its original placement. */
export function constrainImage(entry, desired) {
  let amount = 1;
  for (const clip of entry.clips) {
    const before = imageCorners(matrix(clip.inverse, entry.transform));
    const after = imageCorners(matrix(clip.inverse, desired));
    for (let i = 0; i < 4; i++)
      for (let axis = 0; axis < 2; axis++) {
        const delta = after[i][axis] - before[i][axis];
        if (delta > 0) amount = Math.min(amount, (clip.rect[axis + 2] - before[i][axis]) / delta);
        else if (delta < 0) amount = Math.min(amount, (clip.rect[axis] - before[i][axis]) / delta);
      }
  }
  amount = Math.max(0, Math.min(1, amount));
  return desired.map((n, i) => entry.transform[i] + (n - entry.transform[i]) * amount);
}

/** Wrap only the selected Do in a local transform; clone every shared ancestor form. */
export function editImage(doc, index, entry, { transform = entry.transform, remove = false } = {}) {
  if (!entry.editable) throw error();
  inverse(transform);
  if (!remove && entry.clips.some((clip) => !inside(transform, clip)))
    throw new Error('Keep the image inside its original frame.');
  const current = inspectImages(doc, index).find((image) => image.id === entry.id);
  if (
    !current?.editable ||
    current.source !== entry.source ||
    current.transform.some((n, i) => Math.abs(n - entry.transform[i]) > 1e-7)
  )
    throw new Error('The image changed. Select it again before editing.');
  if (!remove && transform.every((n, i) => Math.abs(n - entry.transform[i]) < 1e-8)) return false;
  const local = matrix(
    inverse(entry.pixelTransform || entry.transform),
    matrix(transform, imageOrientationMatrix(entry.orientation || 1)),
  );
  const replacement = remove
    ? ''
    : `q\n${local.map((n) => PDFNumber.of(n).toString()).join(' ')} cm\n${entry.source}\nQ`;
  rewriteOccurrence(doc, index, entry, replacement);
}

/** New pixels and alpha inherit the replaced image's individual cipher choices. */
function hasImageProtection(image, visited = new Set()) {
  if (visited.has(image)) return false;
  visited.add(image);
  if (withoutCryptFilter(image.dict) !== image.dict) return true;
  return ['SMask', 'Mask'].some((key) => {
    const mask = get(image.dict, key);
    return mask instanceof PDFStream && hasImageProtection(mask, visited);
  });
}

function retainImageProtection(image, source, visited = new Set()) {
  if (visited.has(image)) return;
  visited.add(image);
  retainCryptFilter(image.dict, [source.dict]);
  for (const key of ['SMask', 'Mask']) {
    const mask = get(image.dict, key);
    if (!(mask instanceof PDFStream)) continue;
    const oldMask = get(source.dict, key),
      otherMask = get(source.dict, key === 'SMask' ? 'Mask' : 'SMask');
    retainImageProtection(
      mask,
      oldMask instanceof PDFStream ? oldMask : otherMask instanceof PDFStream ? otherMask : source,
      visited,
    );
  }
}

/** Replace one image occurrence, fitting the new aspect ratio within its existing axes. */
export async function replaceImage(doc, index, entry, bytes, transform = entry.transform) {
  editImage(doc, index, entry); // Validate the source without writing anything.
  inverse(transform);
  if (entry.clips.some((clip) => !inside(transform, clip)))
    throw new Error('Keep the image inside its original frame.');
  if (bytes?.length > MAX_IMAGE_SIZE) throw new Error('Choose an image smaller than 20 MB.');
  const validFile = () => new Error('Choose a valid PNG or JPEG image.');
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw validFile();
  // Decode in an isolated document so malformed files cannot change the target's resources.
  const source = await PDFDocument.create();
  let image;
  try {
    image = await embedOrientedImage(source, bytes);
    await image.image.embed();
  } catch {
    throw validFile();
  }
  const width = Math.hypot(transform[0], transform[1]),
    height = Math.hypot(transform[2], transform[3]),
    scale = Math.min(width / image.width, height / image.height),
    sx = (image.width * scale) / width,
    sy = (image.height * scale) / height;
  const fitted = matrix(transform, [sx, 0, 0, sy, (1 - sx) / 2, (1 - sy) / 2]);
  editImage(doc, index, entry); // The caller may have changed this document during decoding.
  const oriented = matrix(fitted, imageOrientationMatrix(image.orientation));
  const local = matrix(inverse(entry.pixelTransform || entry.transform), oriented),
    name = uniqueName(get(entry.resources, 'XObject'), 'ReplacementImage');
  const updateResources = hasImageProtection(entry.object)
    ? (resources) => {
        const ref = PDFObjectCopier.for(source.context, doc.context).copy(image.image.ref);
        retainImageProtection(doc.context.lookup(ref), entry.object);
        get(resources, 'XObject').set(name, ref);
      }
    : (resources) =>
        get(resources, 'XObject').set(
          name,
          PDFObjectCopier.for(source.context, doc.context).copy(image.image.ref),
        );
  rewriteOccurrence(
    doc,
    index,
    entry,
    `q\n${local.map((n) => PDFNumber.of(n).toString()).join(' ')} cm\n${name} Do\nQ`,
    updateResources,
  );
}

/** Change one source occurrence, copying its shared ancestor forms. */
export function rewriteOccurrence(doc, index, entry, replacement, updateResources) {
  function rebuild(source, resources, depth) {
    const result = rebuildLevel(source, resources, depth);
    pruneEditedFonts(result.resources, result.source);
    pruneEditedForms(doc, result.resources, result.source);
    return result;
  }
  function rebuildLevel(source, resources, depth) {
    const copy = cloneResources(doc, resources);
    if (depth < entry.path.length) {
      const call = entry.path[depth];
      if (source.slice(call.start, call.end) !== call.source) throw error();
      const form = get(get(resources, 'XObject'), call.name);
      const nested = rebuild(decode(form), get(form.dict, 'Resources') || resources, depth + 1);
      const dict = form.dict.clone(doc.context);
      dict.delete(PDFName.of('Filter'));
      dict.delete(PDFName.of('DecodeParms'));
      retainCryptFilter(dict, [form.dict]);
      dict.set(PDFName.of('Resources'), nested.resources);
      const stream = PDFRawStream.of(
        dict,
        Uint8Array.from(nested.source, (c) => c.charCodeAt(0)),
      );
      const objects = get(copy, 'XObject'),
        current = get(resources, 'XObject').get(PDFName.of(call.name)),
        ref = storeStream(doc, current, stream);
      if (ref === current) return { source, resources: copy };
      const name = uniqueName(objects, 'EditedImageForm');
      objects.set(name, ref);
      return {
        source: source.slice(0, call.start) + `${name} Do` + source.slice(call.end),
        resources: copy,
      };
    }
    if (source.slice(entry.start, entry.end) !== entry.source) throw error();
    updateResources?.(copy);
    return {
      source: source.slice(0, entry.start) + replacement + source.slice(entry.end),
      resources: copy,
    };
  }
  const page = doc.getPage(index),
    result = rebuild(pageSource(page), page.node.Resources(), 0);
  page.node.set(PDFName.of('Resources'), result.resources);
  setPageSource(doc, page, result.source);
}

/** Renderable image-only PDF for a faithful drag preview, including image soft masks. */
export async function imagePreview(doc, entry) {
  const preview = await PDFDocument.create();
  const copier = PDFObjectCopier.for(doc.context, preview.context);
  const sideways = entry.orientation >= 5;
  const width = get(entry.object.dict, sideways ? 'Height' : 'Width').asNumber(),
    height = get(entry.object.dict, sideways ? 'Width' : 'Height').asNumber();
  const ratio = Math.min(1, 1200 / Math.max(width, height));
  const page = preview.addPage([width * ratio, height * ratio]);
  const resource = preview.context.register(copier.copy(entry.object));
  const colors = get(entry.resources, 'ColorSpace');
  page.node.set(
    PDFName.of('Resources'),
    preview.context.obj({
      XObject: { Preview: resource },
      ...(colors ? { ColorSpace: copier.copy(colors) } : {}),
    }),
  );
  page.node.set(
    PDFName.of('Contents'),
    preview.context.register(
      preview.context.flateStream(
        `q ${page.getWidth()} 0 0 ${page.getHeight()} 0 0 cm ${imageOrientationMatrix(entry.orientation || 1).join(' ')} cm /Preview Do Q`,
      ),
    ),
  );
  return preview.save();
}
