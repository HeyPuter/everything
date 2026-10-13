import { toUnicode } from "./idn.js";
import { IMAGE_BYTES } from "./content/binary.js";
import { referencedTags, importTags } from "./tags.js";
import { trimMindMap } from "./mind-map.js";
import { assertUnlocked } from "./locking.js";
import {
  clone,
  item,
  bounds,
  validateBoard,
  escape,
  assertImagePixels,
  imageSize,
  truncate,
  keepOnBoard,
  MAX_OBJECTS,
} from "./model.js";
import {
  descendants,
  completeGroups,
  duplicateItems,
  safeURL,
  removeItems,
  inferParents,
  orderAfterFrames,
} from "./scene.js";
import { autoHeightLayout } from "./text.js";
import { cellsText, readTableContent } from "./bulk-content.js";
import { listPlainText } from "./text-blocks.js";
import { externalizeObjectLinks } from "./object-link-data.js";
import { unlinkCopiedJira } from "./planning/task.js";
import { ASSET } from "./collaboration/protocol.js";

export const CLIPBOARD_TYPE = "application/x-whiteboard+json";
const MAX_TRANSFER = 100 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
// Images the browser reads but boards do not store, which are added as a
// PNG copy: a GIF (its first frame) or a BMP.
const CONVERTED_TYPES = ["image/gif", "image/bmp"];
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|bmp)$/i;
export const IMAGE_ACCEPT = [...IMAGE_TYPES, ...CONVERTED_TYPES].join(",");
const editable = (target) =>
  target?.closest?.("input,textarea,select,[contenteditable]");
// Text selected outside the board, as in a comment or a panel, is what a
// copy is for; the board's objects are copied once the board has the focus.
const textSelectedOutsideBoard = () => {
  const selection = document.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount)
    return false;
  const canvas = document.querySelector("#canvas"),
    node = selection.anchorNode;
  return !!node && !canvas?.contains(node) && document.activeElement !== canvas;
};

export function selectionFragment(items, selection, address, options) {
  const ids = descendants(items, selection, options);
  // Keep connections between copied nodes even when only the nodes were selected.
  for (const i of items)
    if (i.startId && ids.has(i.startId) && ids.has(i.endId)) ids.add(i.id);
  const chosen = clone(items.filter((i) => ids.has(i.id))),
    wholeGroups = completeGroups(items, ids);
  for (const i of chosen) {
    trimMindMap(i, ids);
    if (i.groupId && !wholeGroups.has(i.groupId)) delete i.groupId;
    if (!ids.has(i.parentId)) delete i.parentId;
    if (!ids.has(i.startId)) delete i.startId;
    if (!ids.has(i.endId)) delete i.endId;
  }
  return externalizeObjectLinks(chosen, address);
}

export function clipboardFormats(items, catalog = []) {
  const tags = referencedTags(items, catalog);
  const json = JSON.stringify({
    format: "whiteboard/clipboard",
    version: 1,
    items,
    ...(tags.length ? { tags } : {}),
  });
  if (json.length > MAX_TRANSFER)
    throw Error(
      "This selection is too large to copy. Export a board file instead.",
    );
  const text = items
    .map((i) =>
      i.type === "table"
        ? cellsText(i.cells)
        : i.textBlocks?.length
          ? listPlainText(i.text || "", i.textBlocks)
          : i.text || i.url || i.fileName || "",
    )
    .filter(Boolean)
    .join("\n");
  return {
    [CLIPBOARD_TYPE]: json,
    "text/html": `<div data-whiteboard-fragment="${encodeURIComponent(json)}">${escape(text).replaceAll("\n", "<br>")}</div>`,
    "text/plain": text,
  };
}

export function readFragment(data) {
  let json = data.getData(CLIPBOARD_TYPE);
  if (!json) {
    const html = data.getData("text/html");
    if (html.length > MAX_TRANSFER * 3)
      throw Error("This selection is too large to paste.");
    const match = html.match(/data-whiteboard-fragment="([^"]+)"/);
    if (match) {
      try {
        json = decodeURIComponent(match[1]);
      } catch {
        throw Error("This clipboard content is not supported.");
      }
    }
  }
  if (!json) return null;
  if (json.length > MAX_TRANSFER)
    throw Error("This selection is too large to paste.");
  let fragment;
  try {
    fragment = JSON.parse(json);
  } catch {
    throw Error("This clipboard content is not supported.");
  }
  if (
    !fragment ||
    fragment.format !== "whiteboard/clipboard" ||
    fragment.version !== 1
  )
    throw Error("This clipboard content is not supported.");
  validateBoard({
    version: 1,
    title: "Clipboard",
    items: fragment.items,
    tags: fragment.tags,
  });
  // Fragments can come from any web page; apply the upload limits.
  assertImagePixels(fragment.items);
  for (const i of fragment.items)
    if (i.type === "image" && i.src.length > (IMAGE_BYTES * 4) / 3 + 64)
      throw Error("Choose an image smaller than 5 MB.");
  Object.defineProperty(fragment.items, "tags", { value: fragment.tags || [] });
  return fragment.items;
}

export function placeFragment(items, point, tags = items.tags) {
  const source = clone(items),
    count = source.length;
  if (!count) return [];
  duplicateItems(source, new Set(source.map((i) => i.id)), 0);
  const copies = source.slice(count),
    box = bounds(copies);
  for (const i of copies) {
    i.x += point.x - box.x;
    i.y += point.y - box.y;
  }
  keepOnBoard(copies);
  validateBoard({ version: 1, title: "Clipboard", items: copies, tags });
  return copies;
}

export function textObject(text, point, ctx) {
  text = text.replace(/\r\n?/g, "\n");
  if (!text.trim()) return null;
  if (text.length > 20000)
    throw Error("Paste up to 20,000 characters at a time.");
  // An address starting www. is a web link without its scheme.
  const url =
    safeURL(text.trim()) ||
    (/^www\.[\w-]+(\.[\w-]+)+([/?#]\S*)?$/i.test(text.trim()) &&
      safeURL(`https://${text.trim()}`));
  if (url && !/\s/.test(text.trim()))
    return keepOnBoard([
      item("link", point.x, point.y, {
        w: 320,
        h: 115,
        url,
        text: toUnicode(new URL(url).hostname),
        color: "#dce5f7",
      }),
    ])[0];
  const object = item("text", point.x, point.y, {
    w: 420,
    text,
    fontSize: 22,
    autoHeight: true,
  });
  object.h = autoHeightLayout(object, ctx).height;
  return keepOnBoard([object])[0];
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(Error("Could not read this file."));
    reader.readAsDataURL(file);
  });
}
export async function decodeImage(src) {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    // The browser's own wording names no cause a person can act on.
    throw Error("This image could not be read.");
  }
  return { width: image.naturalWidth, height: image.naturalHeight };
}
// The type of an image boards store only as a PNG copy, from its bytes.
function convertedType(base64) {
  const bytes = atob(base64.slice(0, 8));
  if (/^GIF8[79]a/.test(bytes)) return "image/gif";
  if (bytes.startsWith("BM")) return "image/bmp";
  return null;
}
export async function convertImage(src) {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    throw Error("This image could not be read.");
  }
  const width = image.naturalWidth,
    height = image.naturalHeight;
  if (!width || !height || width * height > 40_000_000)
    throw Error("Choose an image with fewer than 40 million pixels.");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}
function imageType(base64) {
  const bytes = atob(base64.slice(0, 24));
  if (bytes.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (bytes.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP")
    return "image/webp";
  return null;
}

// The largest photo accepted. One over the 5 MB a board image may take, as
// a phone camera's often is, is made smaller before it is added.
export const IMAGE_UPLOAD_BYTES = 30 * 1024 * 1024;
const blobOf = (canvas, type) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
// Draws a photo at most 4,096 pixels on its longer side, and smaller until
// it fits, as WebP, or as JPEG on a white background where the browser
// cannot write WebP. Browsers draw a JPEG upright from its EXIF
// orientation, which the copy then no longer needs.
export async function shrinkImage(src, { width, height }) {
  const image = new Image();
  image.src = src;
  await image.decode();
  for (
    let side = Math.min(4096, Math.max(width, height));
    side >= 256;
    side = Math.round(side * 0.75)
  ) {
    const scale = side / Math.max(width, height),
      canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    for (const type of ["image/webp", "image/jpeg"]) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (type === "image/jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await blobOf(canvas, type);
      if (blob?.type === type && blob.size <= IMAGE_BYTES)
        return readFile(blob);
    }
  }
  throw Error("This image could not be made small enough to add.");
}
export async function fileObjects(
  files,
  point,
  {
    imagesOnly = false,
    read = readFile,
    decode = decodeImage,
    shrink = shrinkImage,
    convert = convertImage,
  } = {},
) {
  if (!files.length) return [];
  if (
    files.length > 20 ||
    files.reduce((sum, f) => sum + f.size, 0) > 50 * 1024 * 1024
  )
    throw Error("Add up to 20 files and 50 MB at a time.");
  // Validate the whole batch before reading; one failed file leaves the board unchanged.
  for (const file of files) {
    const image =
      IMAGE_TYPES.includes(file.type) ||
      CONVERTED_TYPES.includes(file.type) ||
      IMAGE_NAME.test(file.name);
    if (imagesOnly && !image)
      throw Error("Choose a PNG, JPEG, WebP, GIF, or BMP image.");
    if (file.size > (image ? IMAGE_UPLOAD_BYTES : 10 * 1024 * 1024))
      throw Error(
        image
          ? "Choose an image smaller than 30 MB."
          : "Choose a file smaller than 10 MB.",
      );
  }
  const objects = [];
  let x = point.x,
    y = point.y,
    rowHeight = 0;
  for (const [index, file] of files.entries()) {
    const raw = await read(file);
    let base64 = raw.slice(raw.indexOf(",") + 1);
    const wantsImage =
      IMAGE_TYPES.includes(file.type) ||
      CONVERTED_TYPES.includes(file.type) ||
      IMAGE_NAME.test(file.name);
    // A GIF or BMP becomes a PNG copy, then goes on as any image does.
    const other = wantsImage && convertedType(base64);
    if (other) {
      const png = await convert(`data:${other};base64,${base64}`);
      base64 = png.slice(png.indexOf(",") + 1);
    }
    const mime = imageType(base64);
    const bytes = other ? Math.floor((base64.length * 3) / 4) : file.size;
    let object;
    if (wantsImage && !mime) throw Error("Could not decode an image.");
    if (mime) {
      if (bytes > IMAGE_UPLOAD_BYTES)
        throw Error("Choose an image smaller than 30 MB.");
      let src = `data:${mime};base64,${base64}`;
      // The size the file declares is checked before decoding, which for a
      // huge image would take gigabytes of memory.
      const declared = imageSize(src) || imageSize(src, Infinity);
      if (declared && declared.width * declared.height > 40_000_000)
        throw Error("Choose an image with fewer than 40 million pixels.");
      const { width, height } = await decode(src);
      if (!width || !height || width * height > 40_000_000)
        throw Error("Choose an image with fewer than 40 million pixels.");
      if (bytes > IMAGE_BYTES) src = await shrink(src, { width, height });
      const scale = Math.min(1, 500 / Math.max(width, height));
      object = item("image", 0, 0, {
        src,
        w: width * scale,
        h: height * scale,
      });
    } else {
      object = item("file", 0, 0, {
        w: 280,
        h: 110,
        text: truncate(file.name, 255),
        fileName: truncate(file.name, 255),
        data: `data:application/octet-stream;base64,${base64}`,
        color: "#eadcf0",
      });
    }
    if (index && index % 3 === 0) {
      x = point.x;
      y += rowHeight + 24;
      rowHeight = 0;
    }
    object.x = x;
    object.y = y;
    x += object.w + 24;
    rowHeight = Math.max(rowHeight, object.h);
    objects.push(object);
  }
  keepOnBoard(objects);
  validateBoard({ version: 1, title: "Files", items: objects });
  return objects;
}

function transferFiles(data) {
  const files = Array.from(data.files || []);
  return files.length
    ? files
    : Array.from(data.items || [])
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter(Boolean);
}

export function createTransfer(api) {
  let fileQueue = Promise.resolve();
  let lastPaste = null;
  // The formats this tab last put on the clipboard, for a menu paste where
  // reading the clipboard is refused. Any other copy in the page, or leaving
  // the window, where something else may be copied, forgets them.
  let copied = null;
  globalThis.addEventListener?.("blur", () => (copied = null));
  const eligible = (event) =>
    api.board() &&
    !document.querySelector("dialog[open]") &&
    !editable(event.target);
  function insert(items, target, incomingTags = []) {
    if (!items.length || api.board() !== target) return;
    if (api.canAdd && !api.canAdd()) return;
    if (target.items.length + items.length > MAX_OBJECTS)
      throw Error("A board can contain up to 5,000 objects.");
    const tags = importTags(target, items, incomingTags);
    api.placeItems?.(items);
    api.finishEditing();
    api.mutate(() => {
      if (tags.length || target.tags) target.tags = tags;
      orderAfterFrames(target.items, items);
      target.items.push(...items);
      inferParents(
        target.items,
        new Set(items.filter((i) => !i.parentId).map((i) => i.id)),
        // New objects, so a lock they were copied with does not keep them
        // out of the frame they land in, as with duplicates.
        { includeLocked: true, skip: api.concealed?.() },
      );
      api.select(new Set(items.map((i) => i.id)));
    });
    document.querySelector("#canvas")?.focus({ preventScroll: true });
    // A save the board refused, as on a board the facilitator locked, put
    // it back as it was; the caller reports nothing added.
    return items.every((i) => api.board()?.items.includes(i));
  }
  // Where pasted content goes: centred in the view when it can be, as a
  // large paste placed by its corner would reach past the screen. `offset`
  // keeps repeated pastes from landing exactly on each other.
  function pasteAt(box, point, pasted) {
    // A paste from the board's menu centres on the point it was opened at.
    if (pasted?.at)
      return { x: pasted.at.x - box.w / 2, y: pasted.at.y - box.h / 2 };
    if (!pasted || !api.pastePoint) return point;
    const at = api.pastePoint(box);
    return { x: at.x + pasted.offset, y: at.y + pasted.offset };
  }
  function addFiles(files, point, options, pasted) {
    const target = api.board(),
      canvas = document.querySelector("#canvas");
    if (!target) return Promise.resolve();
    // Serialize decoding to bound memory and keep batches in the user's order.
    fileQueue = fileQueue
      .catch(() => {})
      .then(async () => {
        if (api.board() !== target || !canvas.isConnected) return;
        if (target.items.length + files.length > MAX_OBJECTS)
          throw Error("A board can contain up to 5,000 objects.");
        api.toast("Adding files…");
        const objects = await fileObjects(files, point, options);
        // Images added from the toolbar sit in the middle of the view, as
        // other new objects do; their size is known only once decoded.
        if (options?.centre && objects.length) {
          const box = bounds(objects);
          for (const i of objects) {
            i.x += point.x - box.w / 2 - box.x;
            i.y += point.y - box.h / 2 - box.y;
          }
          keepOnBoard(objects);
        }
        if (pasted && objects.length) {
          const box = bounds(objects),
            at = pasteAt(box, point, pasted);
          for (const i of objects) {
            i.x += at.x - box.x;
            i.y += at.y - box.y;
          }
          keepOnBoard(objects);
        }
        if (
          api.board() === target &&
          canvas.isConnected &&
          insert(objects, target)
        )
          api.toast(
            files.documents
              ? "Files added. To add a document’s contents to the board, open its file card and choose Import contents."
              : "Files added.",
          );
      })
      .catch((error) =>
        api.toast(error.message || "Could not add these files."),
      );
    return fileQueue;
  }
  function copy(event) {
    if (!event.deferred) copied = null;
    if (
      !eligible(event) ||
      !api.selection().size ||
      !event.clipboardData ||
      textSelectedOutsideBoard()
    )
      return;
    try {
      if (event.type === "cut") {
        if (api.canCut) {
          if (!api.canCut(api.selection())) return event.preventDefault();
        } else
          assertUnlocked(api.board().items, api.selection(), {
            deleting: true,
          });
      }
      // Hidden objects never reach the clipboard, including the hidden
      // contents of a visible frame or group.
      const hidden = api.concealed?.() || new Set();
      const ids = hidden.size
        ? new Set([...api.selection()].filter((id) => !hidden.has(id)))
        : api.selection();
      if (!ids.size) throw Error("Hidden objects cannot be copied.");
      // A cut removes everything selected, including hidden objects inside a
      // visible frame or group, which the clipboard leaves out; they would
      // be gone with no way to paste them back.
      if (
        event.type === "cut" &&
        hidden.size &&
        [
          ...descendants(
            api.board().items,
            api.selection(),
            api.selectionOptions?.(),
          ),
        ].some((id) => hidden.has(id))
      )
        throw Error(
          "Hidden objects cannot be cut. Copy the selection instead.",
        );
      const fragment = selectionFragment(
        hidden.size
          ? api.board().items.filter((i) => !hidden.has(i.id))
          : api.board().items,
        ids,
        api.objectURL,
        api.selectionOptions?.(),
      );
      // A shared board's image or file that has not downloaded yet is only
      // a reference to its server, which no paste can use.
      if (
        fragment.some((i) =>
          ["src", "data"].some((key) => ASSET.test(i[key] || "")),
        )
      )
        throw Error(
          "Some images or files have not downloaded from the shared board yet. Try again in a moment.",
        );
      const formats = clipboardFormats(fragment, api.board().tags);
      let structured = false;
      for (const type of [CLIPBOARD_TYPE, "text/html"]) {
        try {
          event.clipboardData.setData(type, formats[type]);
          structured = true;
        } catch {}
      }
      if (!structured)
        throw Error("Could not copy these objects. Your board is unchanged.");
      event.clipboardData.setData("text/plain", formats["text/plain"]);
      event.preventDefault();
      if (!event.deferred) copied = formats;
      if (event.type === "cut" && !event.deferred)
        api.mutate(() => {
          api.board().items = removeItems(
            api.board().items,
            api.selection(),
            api.selectionOptions?.(),
          );
          api.select(new Set());
        });
    } catch (error) {
      event.preventDefault();
      api.toast(error.message);
    }
  }
  function receive(data, point, target, pasted) {
    const fragment = readFragment(data);
    if (fragment) {
      insert(
        unlinkCopiedJira(
          placeFragment(fragment, pasteAt(bounds(fragment), point, pasted)),
          target?.items,
        ),
        target,
        fragment.tags,
      );
      return;
    }
    const content = readTableContent(data),
      cells = content?.cells;
    if (cells) {
      api.pasteCells(cells, point, target, content.cellLanguages);
      return;
    }
    const dropped = transferFiles(data),
      // A drop or the board menu's Paste chose where content goes; a
      // keyboard paste leaves an import or embed to find its own spot.
      chosen = pasted && !pasted.at ? undefined : point;
    // Documents such as PDFs can be imported instead of attached.
    const files =
      dropped.length && api.receiveFiles
        ? api.receiveFiles(dropped, chosen)
        : dropped;
    if (files.length) {
      addFiles(files, point, undefined, pasted);
      return;
    }
    if (dropped.length) return;
    const text =
      data.getData("text/plain") ||
      data
        .getData("text/uri-list")
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("#"))
        .join("\n");
    // Links to embeddable services offer an embed or a link card.
    if (text && api.receiveText?.(text, chosen, target)) return;
    if (text) {
      const object = textObject(
        text,
        point,
        document.createElement("canvas").getContext("2d"),
      );
      if (object) insert([object], target);
    }
  }
  // Copy and Cut from a menu. The browser's own command runs the handler
  // above with the clipboard events' data; where that command is refused,
  // the asynchronous clipboard takes the same formats, and a cut removes
  // the objects only once they are on the clipboard.
  async function clipboardCommand(type) {
    const canvas = document.querySelector("#canvas");
    canvas?.focus({ preventScroll: true });
    let handled = false;
    const seen = () => (handled = true);
    document.addEventListener(type, seen, true);
    try {
      document.execCommand?.(type);
    } catch {}
    document.removeEventListener(type, seen, true);
    if (handled) return;
    const target = api.board(),
      chosen = new Set(api.selection());
    const data = new Map();
    let refused = false;
    copy({
      type,
      target: canvas || document.body,
      clipboardData: { setData: (key, value) => data.set(key, value) },
      preventDefault() {
        refused = !data.size;
      },
      deferred: true,
    });
    if (refused || !data.size) return;
    const write = globalThis.navigator?.clipboard?.write;
    try {
      if (!write || typeof ClipboardItem !== "function") throw Error();
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([data.get("text/html")], { type: "text/html" }),
          "text/plain": new Blob([data.get("text/plain") || ""], {
            type: "text/plain",
          }),
        }),
      ]);
    } catch {
      api.toast(
        type === "cut"
          ? "Your browser did not allow access to the clipboard. Press Ctrl/Cmd+X to cut."
          : "Your browser did not allow access to the clipboard. Press Ctrl/Cmd+C to copy.",
      );
      return;
    }
    copied = Object.fromEntries(data);
    if (type === "cut" && api.board() === target)
      api.mutate(() => {
        target.items = removeItems(
          target.items,
          chosen,
          api.selectionOptions?.(),
        );
        api.select(new Set());
      });
  }
  // Paste from a menu, at the point it was opened. Only the asynchronous
  // clipboard can be read outside a paste event; the browser may ask first.
  async function pasteClipboard(point) {
    const target = api.board(),
      clipboard = globalThis.navigator?.clipboard;
    const refused = () =>
      api.toast(
        "Your browser did not allow access to the clipboard. Press Ctrl/Cmd+V to paste.",
      );
    if (!target || !eligible({ target: document.body })) return;
    // Taken now: the browser asking to read the clipboard may move focus.
    const kept = copied;
    const values = new Map(),
      files = [];
    try {
      if (clipboard?.read) {
        for (const entry of await clipboard.read())
          for (const type of entry.types) {
            const blob = await entry.getType(type);
            if (type.startsWith("text/")) {
              if (!values.has(type)) values.set(type, await blob.text());
            } else if (type.startsWith("image/"))
              files.push(
                new File([blob], `pasted.${type.slice(6).split("+")[0]}`, {
                  type,
                }),
              );
          }
      } else if (clipboard?.readText)
        values.set("text/plain", await clipboard.readText());
      else throw Error("The clipboard cannot be read.");
    } catch {
      // What this tab copied last is still on the clipboard, so a paste
      // right after a menu Copy works without reading it.
      if (!kept) return refused();
      values.clear();
      files.length = 0;
      for (const type in kept) values.set(type, kept[type]);
    }
    if (api.board() !== target) return;
    if (!values.size && !files.length)
      return api.toast("The clipboard is empty.");
    try {
      receive(
        {
          getData: (type) => values.get(type) || "",
          files,
          items: [],
          types: [...values.keys(), ...(files.length ? ["Files"] : [])],
        },
        point,
        target,
        { offset: 0, at: point },
      );
    } catch (error) {
      api.toast(error.message || "Could not paste this content.");
    }
  }
  document.addEventListener("copy", copy);
  document.addEventListener("cut", copy);
  document.addEventListener("paste", (event) => {
    if (!eligible(event) || !event.clipboardData) return;
    event.preventDefault();
    try {
      const point = api.center(),
        target = api.board();
      // Repeated pastes stay visible rather than hiding under the previous copy.
      const signature = `${target.id}:${point.x}:${point.y}`;
      const offset =
        lastPaste?.signature === signature ? lastPaste.offset + 24 : 0;
      lastPaste = { signature, offset: offset % 192 };
      receive(
        event.clipboardData,
        { x: point.x + lastPaste.offset, y: point.y + lastPaste.offset },
        target,
        { offset: lastPaste.offset },
      );
    } catch (error) {
      api.toast(error.message || "Could not paste this content.");
    }
  });
  // A file dropped anywhere else, as on the library, would otherwise
  // replace the app with the file.
  const files = (event) =>
    Array.from(event.dataTransfer?.types || []).includes("Files");
  document.addEventListener("dragover", (event) => {
    if (event.defaultPrevented || !files(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
  });
  document.addEventListener("drop", (event) => {
    if (!event.defaultPrevented && files(event)) event.preventDefault();
  });
  return {
    addFiles,
    insert,
    clipboard: clipboardCommand,
    pasteClipboard,
    bindCanvas(wrap) {
      let depth = 0;
      const clear = () => {
        depth = 0;
        wrap.classList.remove("drop-target");
      };
      const accepts = (event) =>
        !document.querySelector("dialog[open]") &&
        Array.from(event.dataTransfer?.types || []).some((type) =>
          ["Files", "text/plain", "text/uri-list", CLIPBOARD_TYPE].includes(
            type,
          ),
        );
      // Someone who cannot add content, such as a viewer, sees no drop
      // target; the drop is refused rather than opening the file instead.
      // Text fields they can still type in take text as usual.
      const refused = (event) =>
        !(api.canDrop?.() ?? true) && !editable(event.target);
      wrap.addEventListener("dragenter", (event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        if (refused(event)) return;
        depth++;
        wrap.classList.add("drop-target");
      });
      wrap.addEventListener("dragover", (event) => {
        if (!accepts(event)) return;
        if (!(api.canDrop?.() ?? true) && editable(event.target)) return;
        event.preventDefault();
        if (refused(event)) {
          event.dataTransfer.dropEffect = "none";
          clear();
        } else event.dataTransfer.dropEffect = "copy";
      });
      wrap.addEventListener("dragleave", () => {
        if (--depth <= 0) clear();
      });
      wrap.addEventListener("dragend", clear);
      wrap.addEventListener("drop", (event) => {
        clear();
        if (!accepts(event)) return;
        if (editable(event.target) && !transferFiles(event.dataTransfer).length)
          return;
        event.preventDefault();
        try {
          receive(event.dataTransfer, api.point(event), api.board());
        } catch (error) {
          api.toast(error.message || "Could not paste this content.");
        }
      });
    },
  };
}
