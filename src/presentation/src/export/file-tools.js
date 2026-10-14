// File commands beyond open and save: Export (PDF, pictures, video,
// animated GIF, outline, template), Print with its preview, document
// Properties, Compress Pictures and the file size summary. The editor hands
// in what these need through `ctx`, so this module keeps no editor state.
import "./export.css";
import { zipSync, strToU8 } from "fflate";
import { el } from "../ui.js";
import {
  openModal,
  selectField,
  textField,
  checkField,
  radioGroup,
  progressLine,
} from "./modal.js";
import { parseSlideRange, HANDOUT_COUNTS } from "./page-layout.js";
import { exportPdf, slidePictures } from "./document-export.js";
import {
  exportVideo,
  exportGif,
  videoSupport,
  videoSize,
  VIDEO_RESOLUTIONS,
} from "./video-export.js";
import { outlineToRtf, outlineToText } from "./outline-writer.js";
import { createPrintDialog } from "./print-dialog.js";
import { createDocumentDialogs, authorOf } from "./document-dialogs.js";

const OUTLINE_SKIP = new Set([
  "title",
  "ctrTitle",
  "dt",
  "ftr",
  "sldNum",
  "hdr",
  "pic",
  "chart",
  "tbl",
  "clipArt",
  "dgm",
  "media",
  "sldImg",
]);

export const EXPORT_FORMATS = [
  ["pdf", "PDF document", ".pdf"],
  ["png", "PNG pictures", ".png"],
  ["jpeg", "JPEG pictures", ".jpg"],
  ["video", "Video (MP4 or WebM)", ".mp4"],
  ["gif", "Animated GIF", ".gif"],
  ["outline", "Outline (RTF or text)", ".rtf"],
  ["template", "Template (.potx)", ".potx"],
  ["pptx", "PowerPoint (.pptx)", ".pptx"],
];

export function createFileTools(ctx) {
  const { P } = ctx;

  // A shape's paragraphs with their indent levels.
  function paragraphs(pres, shape) {
    let text = "";
    try {
      text = ctx.displayShapeText(pres, shape) || "";
    } catch {
      return [];
    }
    const lines = text.split("\n");
    let count = 0;
    try {
      count = P.getShapeParagraphCount(shape);
    } catch {}
    const out = [];
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let level = 0;
      try {
        level = P.getParagraphLevel(shape, count === lines.length ? i : 0) || 0;
      } catch {}
      out.push({ text: line, level });
    });
    return out;
  }
  // A slide's outline: its title and the paragraphs of its body text. A
  // slide built from placeholders reads from them; one built from free text
  // boxes takes the box in the largest type as its title and the others, top
  // to bottom, as its body.
  function slideOutline(pres, slide) {
    const shapes = [];
    for (const shape of ctx.visibleSlideShapes(slide)) {
      let type = null,
        idx = null;
      try {
        type = P.getShapePlaceholderType(shape);
        idx = P.getShapePlaceholderIdx?.(shape) ?? null;
      } catch {}
      const items = paragraphs(pres, shape);
      if (!items.length) continue;
      shapes.push({ shape, type, placeholder: !!type || idx != null, items });
    }
    const titleShape = shapes.find(
      (s) => s.type === "title" || s.type === "ctrTitle",
    );
    const joined = (s) => s.items.map((p) => p.text.trim()).join(" ");
    if (shapes.some((s) => s.placeholder)) {
      return {
        title: titleShape ? joined(titleShape) : "",
        items: shapes
          .filter((s) => s.placeholder && !OUTLINE_SKIP.has(s.type))
          .flatMap((s) => s.items),
      };
    }
    for (const s of shapes) {
      try {
        s.size = P.getShapeRunFormatEffective(pres, s.shape, 0, 0)?.size || 0;
      } catch {
        s.size = 0;
      }
      const b = ctx.slideBounds(pres, s.shape) || { x: 0, y: 0 };
      s.x = b.x;
      s.y = b.y;
    }
    const title = [...shapes].sort((a, b) => b.size - a.size || a.y - b.y)[0];
    return {
      title: title ? joined(title) : "",
      items: shapes
        .filter((s) => s !== title)
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .flatMap((s) => s.items),
    };
  }

  // Where each piece of a slide's text sits, for the PDF's searchable layer.
  function textBlocks(pres, slide) {
    const out = [];
    for (const shape of ctx.visibleSlideShapes(slide)) {
      const items = paragraphs(pres, shape);
      if (!items.length) continue;
      const b = ctx.slideBounds(pres, shape);
      if (!b) continue;
      let size = 18;
      try {
        size = P.getShapeRunFormatEffective(pres, shape, 0, 0)?.size || 18;
      } catch {}
      out.push({ x: b.x, y: b.y, size, lines: items.map((p) => p.text) });
    }
    return out;
  }

  // The slides an export or print covers, with what each needs.
  function gather({ range = "all", custom = "", includeHidden = false } = {}) {
    const target = ctx.doc();
    const pres = target.pres;
    const all = P.getSlides(pres);
    let picks;
    if (range === "current") picks = [ctx.currentIndex()];
    else if (range === "selected") {
      const parts = new Set(ctx.selectedSlides().map(P.getSlidePartName));
      picks = all
        .map((s, i) => (parts.has(P.getSlidePartName(s)) ? i : -1))
        .filter((i) => i >= 0);
    } else if (range === "custom") {
      picks = parseSlideRange(custom, all.length);
      if (picks === null)
        throw new Error(
          "Enter slide numbers and ranges separated by commas, such as 1-3, 5.",
        );
    } else picks = all.map((_, i) => i);
    if (range !== "current" && range !== "selected" && !includeHidden)
      picks = picks.filter((i) => !P.isSlideHidden(all[i]));
    return picks.map((i) => {
      const s = all[i];
      let src = null,
        outline = null;
      const read = () => (outline ??= slideOutline(pres, s));
      return {
        slide: s,
        number: i + 1,
        hidden: P.isSlideHidden(s),
        get title() {
          return read().title;
        },
        get notes() {
          return P.getSlideNotes(s) || "";
        },
        get outline() {
          return read().items;
        },
        get alt() {
          return ctx.slideDescription(s, pres) || `Slide ${i + 1}`;
        },
        get textBlocks() {
          return textBlocks(pres, s);
        },
        get transition() {
          try {
            return P.getEffectiveSlideTransition(s);
          } catch {
            return null;
          }
        },
        get src() {
          return (src ??= ctx.previewSrc(target, s));
        },
        // A recorded narration: { data, contentType, durationMs } or null.
        get narration() {
          return ctx.narrationOf?.(s) ?? null;
        },
      };
    });
  }

  function slideSize() {
    const size = P.getSlideSize(ctx.doc().pres) || {
      width: 12192000,
      height: 6858000,
    };
    return { slideWidth: size.width, slideHeight: size.height };
  }

  const baseName = () =>
    ctx.cleanName(ctx.doc().name, { maxLength: Infinity }) || "Presentation";

  function documentInfo() {
    const pres = ctx.doc().pres;
    let core = null;
    try {
      core = P.getCoreProperties(pres);
    } catch {}
    return {
      title: core?.title || ctx.doc().name,
      author: authorOf(core),
      subject: core?.subject || "",
      keywords: core?.keywords || "",
      creator: "Presentation",
    };
  }

  async function templateBlob() {
    const bytes = await P.savePresentation(ctx.doc().pres);
    const copy = await P.loadPresentation(bytes);
    P.setPresentationKind(copy, "template");
    return new Blob([await P.savePresentation(copy)], {
      type: P.PRESENTATION_FILE_TYPES.template,
    });
  }

  async function saveAsTemplate() {
    const target = ctx.doc();
    await ctx.settled();
    if (!target || ctx.doc() !== target) return;
    await ctx.download(
      await templateBlob(),
      `${baseName()}.potx`,
      "Template downloaded.",
    );
  }

  /* ---------- Export dialog ---------- */
  async function openExportDialog(initial = "pdf") {
    const target = ctx.doc();
    if (!target) return;
    await ctx.settled();
    if (ctx.doc() !== target) return;
    ctx.refreshFields?.();
    const { slideWidth, slideHeight } = slideSize();
    const aspect = slideWidth / slideHeight;
    const selectedCount = ctx.selectedSlides().length;

    const name = textField("File name", baseName(), {
      maxlength: 180,
      autocomplete: "off",
    });
    const formatList = radioGroup(
      "Format",
      "export-format",
      EXPORT_FORMATS.map(([v, label]) => [v, label]),
      initial,
    );
    formatList.wrap.classList.add("export-formats");

    // Options shared by formats that cover slides.
    const range = radioGroup(
      "Slides",
      "export-range",
      [
        ["all", "All slides"],
        ["current", "Current slide"],
        ["selected", `Selected slides (${selectedCount})`],
        ["custom", "Slide numbers"],
      ],
      "all",
    );
    const custom = textField("Slide numbers", "", {
      placeholder: "e.g. 1-3, 5",
      "aria-label": "Slide numbers to export",
    });
    custom.wrap.classList.add("export-custom-range");
    const hidden = checkField("Include hidden slides");

    const pdfLayout = selectField(
      "Layout",
      [
        ["slides", "Slides"],
        ["notes", "Notes pages"],
        ["handouts", "Handouts"],
        ["outline", "Outline"],
      ],
      "slides",
    );
    const perPage = selectField(
      "Slides per page",
      HANDOUT_COUNTS.map((n) => [n, `${n}`]),
      6,
    );
    const order = selectField(
      "Order",
      [
        ["horizontal", "Across, then down"],
        ["vertical", "Down, then across"],
      ],
      "horizontal",
    );
    const paper = selectField(
      "Page size",
      [
        ["slide", "Slide size"],
        ["letter", "US Letter"],
        ["a4", "A4"],
        ["legal", "US Legal"],
        ["a3", "A3"],
      ],
      "slide",
    );
    const pdfQuality = selectField(
      "Picture quality",
      [
        ["150", "Standard (150 ppi), smaller file"],
        ["220", "High (220 ppi)"],
        ["300", "Print (300 ppi)"],
        ["lossless", "Lossless (200 ppi), largest file"],
      ],
      "220",
    );
    const pdfColor = selectField(
      "Color",
      [
        ["color", "Color"],
        ["grayscale", "Grayscale"],
        ["bw", "Black and white"],
      ],
      "color",
    );
    const pdfFrame = checkField("Frame slides");

    const pictureWidths = [
      [960, "Small"],
      [1280, "Medium"],
      [1920, "Large"],
      [3840, "Extra large"],
    ].map(([w, label]) => [w, `${label} (${w} × ${Math.round(w / aspect)})`]);
    const picWidth = selectField("Size", pictureWidths, 1920);

    const container = selectField(
      "File type",
      [
        ["mp4", "MP4 (H.264)"],
        ["webm", "WebM (VP9)"],
      ],
      "mp4",
    );
    const resolution = selectField(
      "Resolution",
      VIDEO_RESOLUTIONS.map(([v, label, h]) => {
        const s = videoSize(h, aspect);
        return [v, `${label}, ${s.width} × ${s.height}`];
      }),
      "1080",
    );
    const seconds = textField("Seconds on each slide", "5", {
      type: "number",
      min: 1,
      max: 600,
      step: 0.5,
    });
    const timings = checkField("Use slide timings where a slide has one", true);
    const narrations = checkField("Include recorded narrations", true);
    const videoNote = el("p", { class: "muted export-note", role: "note" });

    const gifWidth = selectField(
      "Size",
      [480, 640, 960, 1280].map((w) => [w, `${w} × ${Math.round(w / aspect)}`]),
      640,
    );
    const gifSeconds = textField("Seconds on each slide", "3", {
      type: "number",
      min: 0.5,
      max: 600,
      step: 0.5,
    });
    const gifFps = selectField(
      "Frames a second in transitions",
      [
        [8, "8"],
        [12, "12"],
        [15, "15"],
        [24, "24"],
      ],
      12,
    );
    const gifLoop = checkField("Loop forever", true);

    const outlineType = selectField(
      "File type",
      [
        ["rtf", "Rich Text Format (.rtf)"],
        ["txt", "Plain text (.txt)"],
      ],
      "rtf",
    );

    const groups = {
      range: el(
        "div",
        { class: "export-group" },
        range.wrap,
        custom.wrap,
        hidden.wrap,
      ),
      pdf: el(
        "div",
        { class: "export-group export-grid" },
        pdfLayout.wrap,
        perPage.wrap,
        order.wrap,
        paper.wrap,
        pdfQuality.wrap,
        pdfColor.wrap,
        pdfFrame.wrap,
      ),
      pictures: el("div", { class: "export-group export-grid" }, picWidth.wrap),
      video: el(
        "div",
        { class: "export-group export-grid" },
        container.wrap,
        resolution.wrap,
        seconds.wrap,
        timings.wrap,
        narrations.wrap,
        videoNote,
      ),
      gif: el(
        "div",
        { class: "export-group export-grid" },
        gifWidth.wrap,
        gifSeconds.wrap,
        gifFps.wrap,
        gifLoop.wrap,
      ),
      outline: el(
        "div",
        { class: "export-group export-grid" },
        outlineType.wrap,
      ),
      about: el("p", { class: "muted export-note" }),
    };
    const progress = progressLine();
    const body = el(
      "form",
      {
        class: "dialog-body export-body",
        onsubmit: (e) => {
          e.preventDefault();
          start();
        },
      },
      el("div", { class: "export-side" }, formatList.wrap),
      el(
        "div",
        { class: "export-main" },
        name.wrap,
        groups.about,
        groups.range,
        groups.pdf,
        groups.pictures,
        groups.video,
        groups.gif,
        groups.outline,
        progress.wrap,
      ),
    );
    let support = null;
    const ABOUT = {
      pdf: "Slides, notes pages, handouts or the outline as a PDF anyone can open and print.",
      png: "Each slide as a picture with sharp edges; several slides download together in a ZIP.",
      jpeg: "Each slide as a compact photo-style picture; several slides download together in a ZIP.",
      video: "The slide show as a video, with its transitions and timings.",
      gif: "The slide show as a looping animation for chats, pages and email.",
      outline:
        "The slide titles and body text, indented by level, for a word processor.",
      template:
        "A copy of this presentation to start new ones from. Its slides, layouts and theme come along.",
      pptx: "The presentation as a PowerPoint file.",
    };
    function sync() {
      const format = formatList.value();
      const slides = ["pdf", "png", "jpeg", "video", "gif"].includes(format);
      groups.about.textContent = ABOUT[format] || "";
      groups.range.hidden = !slides;
      custom.wrap.hidden = range.value() !== "custom";
      hidden.wrap.hidden = format === "video" || format === "gif";
      groups.pdf.hidden = format !== "pdf";
      groups.pictures.hidden = format !== "png" && format !== "jpeg";
      groups.video.hidden = format !== "video";
      narrations.wrap.hidden = !(
        ctx.narrationOf &&
        P.getSlides(ctx.doc().pres).some((s) => ctx.narrationOf(s))
      );
      groups.gif.hidden = format !== "gif";
      groups.outline.hidden = format !== "outline";
      const handouts = pdfLayout.input.value === "handouts";
      perPage.wrap.hidden = !handouts;
      order.wrap.hidden = !handouts;
      if (format === "video" && support) {
        const kind =
          !narrations.wrap.hidden &&
          narrations.input.checked &&
          support[container.input.value]
            ? "realtime"
            : support[container.input.value];
        videoNote.textContent =
          kind === "fast"
            ? "The video is encoded in this browser; long presentations take a little while."
            : kind === "realtime"
              ? "This browser records the video in real time, so it takes as long as the show."
              : container.input.value === "mp4"
                ? "This browser cannot make MP4 videos. Choose WebM."
                : "This browser cannot make videos.";
      }
      exportButton.disabled =
        busy ||
        (format === "video" && support && !support[container.input.value]);
    }
    let busy = false;
    let controller = null;
    const modal = openModal({
      title: "Export",
      className: "export-dialog",
      body,
      actions: [
        {
          label: "Cancel",
          onClick: () => {
            if (busy) {
              controller?.abort();
              return false;
            }
            return true;
          },
        },
        { label: "Export", kind: "primary", onClick: () => start() },
      ],
      onClose: () => controller?.abort(),
    });
    const [cancelButton, exportButton] = modal.buttons;
    body.addEventListener("change", sync);
    body.addEventListener("input", sync);
    sync();
    formatList.inputs.find((i) => i.checked)?.focus();
    videoSupport(1280, 720).then((s) => {
      support = s;
      if (!s.mp4 && s.webm) container.input.value = "webm";
      for (const option of container.input.options)
        option.disabled = !s[option.value];
      sync();
    });

    async function start() {
      if (busy) return;
      if (ctx.doc() !== target) return modal.close(null);
      const format = formatList.value();
      const fileBase =
        ctx.cleanName(name.input.value, { maxLength: Infinity }) || baseName();
      let slides;
      try {
        slides = ["pdf", "png", "jpeg", "video", "gif"].includes(format)
          ? gather({
              range: range.value(),
              custom: custom.input.value,
              includeHidden:
                format !== "video" && format !== "gif" && hidden.input.checked,
            })
          : [];
      } catch (e) {
        ctx.toast(e.message);
        custom.input.focus();
        return;
      }
      if (
        ["pdf", "png", "jpeg", "video", "gif"].includes(format) &&
        !slides.length
      ) {
        ctx.toast("There are no slides to export in that range.");
        return;
      }
      busy = true;
      controller = new AbortController();
      const signal = controller.signal;
      exportButton.disabled = true;
      cancelButton.querySelector("span").textContent = "Stop";
      cancelButton.setAttribute("aria-label", "Stop");
      progress.show("Preparing…");
      const report = (message) => (f) =>
        progress.set(f, `${message} ${Math.round(f * 100)}%`);
      try {
        const done = await runExport(format, fileBase, slides, signal, report);
        if (done !== false) modal.close(true);
      } catch (e) {
        if (e?.name === "AbortError") ctx.toast("Export stopped.");
        else ctx.fail(e);
      } finally {
        busy = false;
        if (modal.dialog.isConnected) {
          cancelButton.querySelector("span").textContent = "Cancel";
          cancelButton.setAttribute("aria-label", "Cancel");
          progress.hide();
          sync();
        }
      }
    }

    async function runExport(format, fileBase, slides, signal, report) {
      const { slideWidth, slideHeight } = slideSize();
      const info = documentInfo();
      if (format === "pdf") {
        const q = pdfQuality.input.value;
        const blob = await exportPdf({
          slides,
          layout: pdfLayout.input.value,
          perPage: Number(perPage.input.value),
          order: order.input.value,
          paper: paper.input.value,
          scaleToFit: true,
          frame: pdfFrame.input.checked,
          colorMode: pdfColor.input.value,
          dpi: q === "lossless" ? 200 : Number(q),
          quality: q === "lossless" ? "lossless" : "high",
          slideWidth,
          slideHeight,
          info,
          signal,
          progress: report("Drawing slides…"),
        });
        return ctx.download(blob, `${fileBase}.pdf`, "PDF downloaded.");
      }
      if (format === "png" || format === "jpeg") {
        const type = format === "png" ? "image/png" : "image/jpeg";
        const ext = format === "png" ? "png" : "jpg";
        const blobs = await slidePictures({
          slides,
          width: Number(picWidth.input.value),
          slideWidth,
          slideHeight,
          type,
          signal,
          progress: report("Drawing slides…"),
        });
        if (blobs.length === 1)
          return ctx.download(
            blobs[0],
            `${fileBase} - Slide ${slides[0].number}.${ext}`,
            `Slide downloaded as a ${format.toUpperCase()} picture.`,
          );
        const digits = String(Math.max(...slides.map((s) => s.number))).length;
        const files = {};
        for (const [i, blob] of blobs.entries())
          files[
            `${fileBase} - Slide ${String(slides[i].number).padStart(digits, "0")}.${ext}`
          ] = new Uint8Array(await blob.arrayBuffer());
        return ctx.download(
          new Blob([zipSync(files, { level: 0 })], { type: "application/zip" }),
          `${fileBase} - slides.zip`,
          `${blobs.length} slides downloaded as ${format.toUpperCase()} pictures.`,
        );
      }
      if (format === "video") {
        const kind = container.input.value;
        const blob = await exportVideo({
          container: kind,
          height: Number(
            VIDEO_RESOLUTIONS.find(([v]) => v === resolution.input.value)[2],
          ),
          aspect: slideWidth / slideHeight,
          slides,
          options: {
            secondsPerSlide: Math.max(0.5, Number(seconds.input.value) || 5),
            useTimings: timings.input.checked,
            narrations: narrations.input.checked,
          },
          signal,
          progress: report("Making the video…"),
        });
        return ctx.download(
          blob,
          `${fileBase}.${kind === "mp4" && blob.type.includes("mp4") ? "mp4" : "webm"}`,
          "Video downloaded.",
        );
      }
      if (format === "gif") {
        const blob = await exportGif({
          width: Number(gifWidth.input.value),
          aspect: slideWidth / slideHeight,
          slides,
          fps: Number(gifFps.input.value),
          loop: gifLoop.input.checked,
          options: {
            secondsPerSlide: Math.max(0.5, Number(gifSeconds.input.value) || 3),
            useTimings: false,
          },
          signal,
          progress: report("Making the animation…"),
        });
        return ctx.download(
          blob,
          `${fileBase}.gif`,
          "Animated GIF downloaded.",
        );
      }
      if (format === "outline") {
        const all = gather({ includeHidden: true });
        const rtf = outlineType.input.value === "rtf";
        const text = rtf
          ? outlineToRtf(all, { title: info.title })
          : outlineToText(all);
        return ctx.download(
          new Blob([rtf ? strToU8(text) : strToU8(`﻿${text}`)], {
            type: rtf ? "application/rtf" : "text/plain;charset=utf-8",
          }),
          `${fileBase}.${rtf ? "rtf" : "txt"}`,
          "Outline downloaded.",
        );
      }
      if (format === "template")
        return ctx.download(
          await templateBlob(),
          `${fileBase}.potx`,
          "Template downloaded.",
        );
      if (format === "pptx")
        return ctx.download(
          new Blob([await P.savePresentation(ctx.doc().pres)], {
            type: P.PRESENTATION_FILE_TYPES.presentation,
          }),
          `${fileBase}.pptx`,
          "PowerPoint file downloaded.",
        );
    }
  }

  const print = createPrintDialog(ctx, {
    gather,
    slideSize,
    documentInfo,
    baseName,
  });
  const documents = createDocumentDialogs(ctx);

  return {
    openExportDialog,
    openPrintDialog: print.open,
    saveAsTemplate,
    openPropertiesDialog: documents.properties,
    openCompressDialog: documents.compress,
    openFileSizeDialog: documents.fileSize,
    gather,
  };
}
