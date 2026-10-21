// Object: embed a file of any kind in the presentation, shown as an icon
// with its name. It travels inside the .pptx as an OLE Package, so desktop
// editors open it too; here, opening it downloads the file.
import { dialog, el, toast } from "../ui.js";
import { downloadBytes, fileBytes, pickFiles, svgToPng } from "./util.js";

const MAX_BYTES = 50 * 1024 * 1024;
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** An icon for an embedded file: a page with its type and name below. */
export function objectIconSvg(name) {
  // Shortened by characters, not UTF-16 units: half an emoji would make the
  // drawing unreadable (and its data URL impossible to write).
  const chars = (text, n) => [...text].slice(0, n).join("");
  const ext = chars(
    name.includes(".") ? name.split(".").pop() : "file",
    5,
  ).toUpperCase();
  const label = [...name].length > 22 ? `${chars(name, 19)}…` : name;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="200" viewBox="0 0 240 200"><path d="M84 8h52l28 28v100a8 8 0 0 1-8 8H84a8 8 0 0 1-8-8V16a8 8 0 0 1 8-8z" fill="#F8FAFC" stroke="#64748B" stroke-width="4"/><path d="M136 8v28h28" fill="#E2E8F0" stroke="#64748B" stroke-width="4" stroke-linejoin="round"/><rect x="70" y="84" width="76" height="34" rx="6" fill="#2563EB"/><text x="108" y="108" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700" fill="#FFFFFF">${esc(ext)}</text><text x="120" y="182" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#1F2937">${esc(label)}</text></svg>`;
}

const MIME = {
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  zip: "application/zip",
};

export function createObjectFeatures(ctx) {
  const { P } = ctx;
  const isObject = (obj) => !!obj && P.isOleObjectShape(obj);

  async function insertObject() {
    ctx.commitText();
    const [file] = await pickFiles("*/*");
    if (!file) return;
    if (file.size > MAX_BYTES)
      throw new Error("Choose a file smaller than 50 MB to embed.");
    const data = await fileBytes(file);
    const icon = await svgToPng(objectIconSvg(file.name), 240, 200);
    const size = ctx.currentSize();
    const w = P.inches(1.2),
      h = P.inches(1);
    await ctx.mutateSlide(ctx.slide(), (slide) => {
      const shape = P.addSlideEmbeddedFile(
        slide,
        { name: file.name, data },
        icon,
        {
          x: Math.round((size.cx - w) / 2),
          y: Math.round((size.cy - h) / 2),
          w,
          h,
        },
      );
      ctx.selectIds([P.getShapeId(shape)]);
    });
  }

  function openObject(obj = ctx.currentShape()) {
    if (!isObject(obj)) return false;
    const object = P.getShapeEmbeddedObject(obj);
    if (!object?.file) {
      toast(
        `This ${object?.progId || "embedded"} object can only be opened in the app that made it.`,
      );
      return true;
    }
    const ext = object.file.name.split(".").pop()?.toLowerCase() ?? "";
    downloadBytes(
      object.file.data,
      object.file.name,
      MIME[ext] ?? "application/octet-stream",
    );
    return true;
  }

  async function objectInfo(obj = ctx.currentShape()) {
    if (!isObject(obj)) return;
    const object = P.getShapeEmbeddedObject(obj);
    const choice = await dialog({
      title: "Embedded Object",
      body: el(
        "div",
        { class: "dialog-body" },
        el(
          "p",
          {},
          object?.file
            ? `${object.file.name} (${Math.max(1, Math.round(object.file.data.byteLength / 1024))} KB)`
            : `${object?.progId || "Object"}`,
        ),
      ),
      actions: [
        { label: "Close", value: null },
        ...(object?.file
          ? [{ label: "Download", value: "open", kind: "primary" }]
          : []),
      ],
    });
    if (choice === "open") openObject(obj);
  }

  return { insertObject, openObject, objectInfo, isObject };
}
