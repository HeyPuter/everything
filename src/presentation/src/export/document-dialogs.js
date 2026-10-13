// Properties (title, author, keywords… and the deck's statistics), Compress
// Pictures, and a summary of what makes the file the size it is.

import { el } from "../ui.js";
import {
  openModal,
  textField,
  checkField,
  radioGroup,
  formatBytes,
  progressLine,
} from "./modal.js";
import {
  COMPRESSIBLE,
  applyCompressedPictures,
  collectPictures,
  compressPictureParts,
  mediaSlides,
} from "./compress-pictures.js";

const RESOLUTIONS = [
  ["330", "330 ppi", "Sharp on high-density screens and projectors."],
  ["220", "220 ppi", "Good for most printers and screens."],
  ["150", "150 ppi", "Good for web pages and screen sharing."],
  ["96", "96 ppi", "Smallest file, for email and sharing."],
  ["keep", "Keep current resolution", "Only delete cropped areas."],
];

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// The library's own name stands in as the author of a new file; nobody
// wrote it, so it shows as no author.
const LIBRARY_AUTHOR = "@office-kit/pptx";
export const authorOf = (core) =>
  core?.creator && core.creator !== LIBRARY_AUTHOR ? core.creator : "";

const definitionList = (rows) =>
  el(
    "dl",
    { class: "file-facts" },
    ...rows.flatMap(([term, value]) => [
      el("dt", {}, term),
      el("dd", {}, value),
    ]),
  );

export function createDocumentDialogs(ctx) {
  const { P } = ctx;

  async function properties() {
    const target = ctx.doc();
    if (!target) return;
    await ctx.settled();
    if (ctx.doc() !== target) return;
    const pres = target.pres;
    let core = null,
      ext = null;
    try {
      core = P.getCoreProperties(pres);
    } catch {}
    try {
      ext = P.getExtendedProperties(pres);
    } catch {}
    const stats = P.getDocumentStatistics(pres);
    const readOnly = ctx.readOnly();
    const fields = {
      title: textField("Title", core?.title || ""),
      subject: textField("Subject", core?.subject || ""),
      creator: textField("Author", authorOf(core)),
      manager: textField("Manager", ext?.manager || ""),
      company: textField("Company", ext?.company || ""),
      category: textField("Category", core?.category || ""),
      keywords: textField("Keywords", core?.keywords || "", {
        placeholder: "Separate keywords with commas",
      }),
      description: textField("Comments", core?.description || "", {
        multiline: true,
      }),
    };
    for (const f of Object.values(fields)) {
      f.input.maxLength = f === fields.description ? 2000 : 255;
      if (readOnly) f.input.readOnly = true;
    }
    const size = el("dd", {}, "…");
    P.savePresentation(pres).then(
      (bytes) => (size.textContent = formatBytes(bytes.byteLength)),
      () => (size.textContent = "—"),
    );
    const general = el(
      "dl",
      { class: "file-facts" },
      el("dt", {}, "Name"),
      el("dd", {}, target.name),
      el("dt", {}, "Location"),
      el("dd", {}, target.path || "This device (not saved to Puter yet)"),
      el("dt", {}, "Size"),
      size,
      el("dt", {}, "Created"),
      el("dd", {}, formatDate(core?.created)),
      el("dt", {}, "Modified"),
      el("dd", {}, formatDate(core?.modified)),
      el("dt", {}, "Last modified by"),
      el("dd", {}, core?.lastModifiedBy || "—"),
      el("dt", {}, "Revision"),
      el("dd", {}, core?.revision || "—"),
    );
    const statistics = definitionList([
      ["Slides", String(stats.slides)],
      ["Hidden slides", String(stats.hiddenSlides)],
      ["Slides with notes", String(stats.notes)],
      ["Words on slides", String(stats.words)],
      ["Words in notes", String(stats.notesWords)],
      ["Paragraphs", String(stats.paragraphs)],
      ["Audio and video clips", String(stats.multimediaClips)],
    ]);
    const body = el(
      "form",
      {
        class: "dialog-body properties-body",
        onsubmit: (e) => e.preventDefault(),
      },
      el(
        "section",
        { class: "file-group", "aria-labelledby": "properties-summary" },
        el("h3", { id: "properties-summary" }, "Summary"),
        el(
          "div",
          { class: "export-grid" },
          ...Object.values(fields).map((f) => f.wrap),
        ),
      ),
      el(
        "section",
        { class: "file-group", "aria-labelledby": "properties-statistics" },
        el("h3", { id: "properties-statistics" }, "Statistics"),
        statistics,
      ),
      el(
        "section",
        { class: "file-group", "aria-labelledby": "properties-general" },
        el("h3", { id: "properties-general" }, "General"),
        general,
      ),
    );
    const modal = openModal({
      title: "Properties",
      className: "properties-dialog",
      body,
      actions: readOnly
        ? [{ label: "Close", kind: "primary", onClick: () => true }]
        : [
            { label: "Cancel", onClick: () => true },
            { label: "Save", kind: "primary", onClick: () => apply() },
          ],
    });
    fields.title.input.focus();
    async function apply() {
      const values = {};
      for (const key of [
        "title",
        "subject",
        "creator",
        "category",
        "keywords",
        "description",
      ]) {
        const v = fields[key].input.value.trim();
        values[key] = v || null;
      }
      const company = fields.company.input.value.trim() || null;
      const manager = fields.manager.input.value.trim() || null;
      const changed =
        Object.entries(values).some(
          ([k, v]) =>
            (k === "creator" ? authorOf(core) || null : core?.[k] || null) !==
            v,
        ) ||
        (ext?.company || null) !== company ||
        (ext?.manager || null) !== manager;
      modal.close(true);
      if (!changed || ctx.doc() !== target) return true;
      await ctx.mutate(() => {
        const pres = ctx.doc().pres;
        const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        P.setCoreProperties(pres, {
          ...values,
          ...(P.getCoreProperties(pres)?.created ? {} : { created: now }),
          modified: now,
        });
        P.updateExtendedStatistics(pres);
        P.setExtendedProperties(pres, { company, manager });
      });
      ctx.toast("Properties saved.");
      return true;
    }
  }

  async function compress({ selectionOnly = null } = {}) {
    const target = ctx.doc();
    if (!target) return;
    await ctx.settled();
    if (ctx.doc() !== target) return;
    const selection = new Set(
      ctx
        .selectedShapes()
        .filter((s) => P.getShapeKind(s) === "picture")
        .map(
          (s) => `${P.getSlidePartName(P.getShapeSlide(s))}#${P.getShapeId(s)}`,
        ),
    );
    const all = collectPictures(P, target.pres, {
      bounds: (shape) => ctx.slideBounds(target.pres, shape),
      selection,
    }).filter((e) => e.uses.length);
    const compressible = all.filter((e) => COMPRESSIBLE.has(e.contentType));
    const total = compressible.reduce((n, e) => n + e.size, 0);
    const chosen = all.filter((e) => e.selected);
    const scope = radioGroup(
      "Apply to",
      "compress-scope",
      [
        ["selected", `Selected pictures (${chosen.length})`],
        ["all", `All pictures (${compressible.length})`],
      ],
      (selectionOnly ?? chosen.length > 0) ? "selected" : "all",
    );
    scope.inputs[0].disabled = !chosen.length;
    const cropped = checkField("Delete cropped areas of pictures", true);
    const resolution = radioGroup(
      "Resolution",
      "compress-resolution",
      RESOLUTIONS.map(([v, label, hint]) => [
        v,
        label,
        el("small", { class: "muted" }, hint),
      ]),
      "150",
    );
    const progress = progressLine();
    const others = all.length - compressible.length;
    const body = el(
      "form",
      {
        class: "dialog-body compress-body",
        onsubmit: (e) => e.preventDefault(),
      },
      el(
        "p",
        { class: "muted" },
        compressible.length
          ? `${compressible.length} picture${compressible.length === 1 ? "" : "s"} in PNG or JPEG take ${formatBytes(total)}.`
          : "This presentation has no PNG or JPEG pictures to compress.",
        others
          ? ` ${others} picture${others === 1 ? " is" : "s are"} in another format and stay${others === 1 ? "s" : ""} as ${others === 1 ? "it is" : "they are"}.`
          : "",
      ),
      scope.wrap,
      cropped.wrap,
      resolution.wrap,
      el(
        "p",
        { class: "muted export-note" },
        "Pictures are never enlarged. Undo restores the originals.",
      ),
      progress.wrap,
    );
    let busy = false;
    const modal = openModal({
      title: "Compress pictures",
      className: "compress-dialog",
      body,
      actions: [
        { label: "Cancel", onClick: () => !busy },
        { label: "Compress", kind: "primary", onClick: () => run() },
      ],
    });
    const [, go] = modal.buttons;
    go.disabled = !compressible.length || ctx.readOnly();
    (
      scope.inputs.find((i) => i.checked && !i.disabled) || resolution.inputs[0]
    ).focus();
    async function run() {
      if (busy) return;
      busy = true;
      go.disabled = true;
      progress.show("Compressing pictures…");
      const ppiValue = resolution.value();
      const ppi = ppiValue === "keep" ? null : Number(ppiValue);
      const onlySelected = scope.value() === "selected";
      let summary = null;
      try {
        await ctx.mutate(async () => {
          const pres = ctx.doc().pres;
          const entries = collectPictures(P, pres, {
            bounds: (shape) => ctx.slideBounds(pres, shape),
            selection,
          }).filter(
            (e) =>
              e.uses.length &&
              COMPRESSIBLE.has(e.contentType) &&
              (!onlySelected || e.selected),
          );
          summary = await compressPictureParts(P, pres, entries, {
            ppi,
            deleteCropped: cropped.input.checked,
            progress: (f) =>
              progress.set(f, `Compressing pictures… ${Math.round(f * 100)}%`),
          });
          if (!summary.changed) return ctx.SKIP;
          applyCompressedPictures(P, pres, summary.results);
        });
      } catch (e) {
        ctx.fail(e);
      }
      busy = false;
      modal.close(true);
      if (!summary) return true;
      ctx.toast(
        summary.changed
          ? `Compressed ${summary.changed} picture${summary.changed === 1 ? "" : "s"} from ${formatBytes(summary.before)} to ${formatBytes(summary.after)}.`
          : "The pictures are already as small as these settings make them.",
      );
      return true;
    }
  }

  async function fileSize() {
    const target = ctx.doc();
    if (!target) return;
    await ctx.settled();
    if (ctx.doc() !== target) return;
    const pres = target.pres;
    const media = P.getMediaParts(pres);
    const used = mediaSlides(P, pres);
    let orphans = [];
    try {
      orphans = P.getOrphanMediaPartNames(pres);
    } catch {}
    const orphanSet = new Set(orphans.map((n) => n.toLowerCase()));
    const fonts = P.listPackageParts(pres).filter((p) =>
      /\/fonts\//i.test(p.name),
    );
    const mediaTotal = media.reduce((n, m) => n + m.data.byteLength, 0);
    const fontTotal = fonts.reduce((n, f) => n + f.byteLength, 0);
    const fileTotal = el("strong", {}, "…");
    P.savePresentation(pres).then(
      (bytes) => (fileTotal.textContent = formatBytes(bytes.byteLength)),
      () => (fileTotal.textContent = "—"),
    );
    const rows = [...media]
      .sort((a, b) => b.data.byteLength - a.data.byteLength)
      .map((m) => {
        const slides = used.get(m.name.toLowerCase()) || [];
        const orphan = orphanSet.has(m.name.toLowerCase());
        return el(
          "tr",
          {},
          el("td", {}, m.name.split("/").pop()),
          el(
            "td",
            {},
            m.contentType.replace(/^(image|video|audio)\//, "").toUpperCase(),
          ),
          el("td", { class: "num" }, formatBytes(m.data.byteLength)),
          el(
            "td",
            {},
            orphan
              ? "Not used"
              : slides.length
                ? slides.length > 6
                  ? `${slides.slice(0, 6).join(", ")}…`
                  : slides.join(", ")
                : "Layouts or masters",
          ),
        );
      });
    const body = el(
      "div",
      { class: "dialog-body file-size-body" },
      definitionList([
        ["File size", fileTotal],
        [
          "Pictures, audio and video",
          `${formatBytes(mediaTotal)} in ${media.length} file${media.length === 1 ? "" : "s"}`,
        ],
        ["Embedded fonts", fonts.length ? formatBytes(fontTotal) : "None"],
        ["Unused media", orphans.length ? `${orphans.length}` : "None"],
      ]),
      media.length
        ? el(
            "div",
            { class: "file-size-table-wrap" },
            el(
              "table",
              { class: "file-size-table" },
              el(
                "caption",
                { class: "sr-only" },
                "Media in this presentation, largest first",
              ),
              el(
                "thead",
                {},
                el(
                  "tr",
                  {},
                  el("th", { scope: "col" }, "File"),
                  el("th", { scope: "col" }, "Type"),
                  el("th", { scope: "col", class: "num" }, "Size"),
                  el("th", { scope: "col" }, "Slides"),
                ),
              ),
              el("tbody", {}, ...rows),
            ),
          )
        : el(
            "p",
            { class: "muted" },
            "This presentation has no pictures, audio or video.",
          ),
    );
    const readOnly = ctx.readOnly();
    const modal = openModal({
      title: "File size",
      className: "file-size-dialog",
      body,
      actions: [
        {
          label: "Remove unused media",
          id: "remove-unused-media",
          onClick: async () => {
            await ctx.mutate(() => {
              const removed = ctx.pruneUnusedMedia(ctx.doc().pres);
              if (!removed.length) return ctx.SKIP;
            });
            ctx.toast(
              `Removed ${orphans.length} unused media file${orphans.length === 1 ? "" : "s"}.`,
            );
            return true;
          },
        },
        {
          label: "Compress pictures…",
          onClick: () => {
            modal.close(true);
            compress({ selectionOnly: false });
            return true;
          },
        },
        { label: "Done", kind: "primary", onClick: () => true },
      ],
    });
    modal.buttons[0].disabled = !orphans.length || readOnly;
    modal.buttons[1].disabled =
      readOnly || !media.some((m) => COMPRESSIBLE.has(m.contentType));
    modal.buttons[2].focus();
  }

  return { properties, compress, fileSize };
}
