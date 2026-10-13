// Zoom: slide pictures that jump to their slide or section in a slide show
// and come back. Slide Zoom and Section Zoom place pictures on the current
// slide; Summary Zoom makes a new slide of them. Each is a picture of the
// target slide with a slide-jump click action (so other apps still follow
// it), and its zoom settings in the app's object data.
import { el, dialog } from "../ui.js";
import { pickFiles, previewToPng } from "./util.js";
import { zoomGrid } from "./geometry.js";
export { zoomGrid };

export const ZOOM_DEFAULTS = {
  slide: { returnToZoom: false, transition: true, duration: 1000 },
  section: { returnToZoom: true, transition: true, duration: 1000 },
  summary: { returnToZoom: true, transition: true, duration: 1000 },
};

export function createZoomFeatures(ctx) {
  const { P } = ctx;
  const isZoom = (obj) => !!obj && P.getShapeObjectData(obj)?.type === "zoom";
  const zooms = () => ctx.selectedShapes().filter(isZoom);
  const dataOf = (obj) => P.getShapeObjectData(obj) ?? {};

  const thumbnail = (slide) => {
    const size = ctx.currentSize();
    return previewToPng(ctx.previewSrc(slide), 640, size.cx / size.cy);
  };

  /** Pick slides (or sections) with their thumbnails. */
  async function pickTargets({
    title,
    sections = false,
    preselect = () => false,
  }) {
    const pres = ctx.pres();
    const entries = sections
      ? (P.getSlideSections(pres) || [])
          .filter((sec) => sec.slides.length)
          .map((sec) => ({
            label: sec.name,
            slide: sec.slides[0],
            section: sec.name,
          }))
      : P.getSlides(pres).map((slide, i) => ({
          label: `${i + 1}. ${ctx.slideTitle(slide) || "Untitled"}`,
          slide,
        }));
    if (!entries.length)
      throw new Error(
        sections
          ? "Add sections to the presentation first (Home > Section)."
          : "There are no slides.",
      );
    const chosen = new Set(
      entries.map((e, i) => (preselect(e, i) ? i : -1)).filter((i) => i >= 0),
    );
    const insertButton = { disabled: true };
    const grid = el(
      "div",
      {
        class: "zoom-pick-grid",
        role: "group",
        "aria-label": sections ? "Sections" : "Slides",
      },
      ...entries.map((entry, i) =>
        el(
          "label",
          { class: "zoom-pick" },
          el("input", {
            type: "checkbox",
            checked: chosen.has(i),
            onchange: (e) => {
              if (e.target.checked) chosen.add(i);
              else chosen.delete(i);
              sync();
            },
          }),
          el("img", { src: ctx.previewSrc(entry.slide), alt: "" }),
          el("span", {}, entry.label),
        ),
      ),
    );
    const count = el("p", { class: "zoom-pick-count", role: "status" });
    const sync = () => {
      count.textContent = `${chosen.size} selected`;
      insertButton.disabled = !chosen.size;
    };
    sync();
    const ok = await dialog({
      title,
      body: el("div", { class: "dialog-body zoom-pick-dialog" }, grid, count),
      confirm: "Insert",
    });
    if (!ok || !chosen.size) return [];
    return [...chosen].sort((a, b) => a - b).map((i) => entries[i]);
  }

  async function addZooms(kind, targets, { onSlide = null, area = null } = {}) {
    const pictures = await Promise.all(targets.map((t) => thumbnail(t.slide)));
    const size = ctx.currentSize();
    const aspect = size.cx / size.cy;
    const ids = [];
    await ctx.mutate(() => {
      const pres = ctx.pres();
      const byPart = new Map(
        P.getSlides(pres).map((s) => [P.getSlidePartName(s), s]),
      );
      const slide = onSlide
        ? onSlide(pres)
        : byPart.get(P.getSlidePartName(ctx.slide()));
      const boxes = zoomGrid(
        targets.length,
        area ?? {
          x: size.cx * 0.08,
          y: size.cy * 0.12,
          w: size.cx * 0.84,
          h: size.cy * 0.76,
        },
        aspect,
      );
      const one = targets.length === 1 && !area;
      targets.forEach((target, i) => {
        const b = one
          ? {
              x: Math.round(size.cx * 0.35),
              y: Math.round(size.cy * 0.35),
              w: Math.round(size.cx * 0.3),
              h: Math.round(size.cy * 0.3),
            }
          : boxes[i];
        const shape = P.addSlideVectorPicture(
          slide,
          { png: pictures[i] },
          {
            ...b,
            name: `${kind === "slide" ? "Slide" : kind === "section" ? "Section" : "Summary Section"} Zoom ${i + 1}`,
          },
        );
        P.setShapeStroke(shape, { color: "#D0D0D0", widthEmu: 3175 });
        const destination = byPart.get(P.getSlidePartName(target.slide));
        if (destination)
          P.setShapeClickAction(shape, { kind: "slide", slide: destination });
        P.setShapeObjectData(shape, {
          type: "zoom",
          kind,
          ...ZOOM_DEFAULTS[kind],
          ...(target.section ? { section: target.section } : {}),
        });
        P.setShapeDescription(shape, `Zoom to ${target.label}`);
        ids.push(P.getShapeId(shape));
      });
      ctx.dedupe(slide);
      if (P.getSlidePartName(slide) === P.getSlidePartName(ctx.slide()))
        ctx.selectIds(ids);
    });
    return ids;
  }

  async function slideZoom() {
    ctx.commitText();
    const targets = await pickTargets({ title: "Insert Slide Zoom" });
    if (targets.length) await addZooms("slide", targets);
  }
  async function sectionZoom() {
    ctx.commitText();
    const targets = await pickTargets({
      title: "Insert Section Zoom",
      sections: true,
    });
    if (targets.length) await addZooms("section", targets);
  }
  // A new slide of section zooms, before the first section chosen.
  async function summaryZoom() {
    ctx.commitText();
    const hasSections = (P.getSlideSections(ctx.pres()) || []).some(
      (s) => s.slides.length,
    );
    const targets = await pickTargets({
      title: "Insert Summary Zoom",
      sections: hasSections,
      preselect: () => true,
    });
    if (!targets.length) return;
    const firstPart = P.getSlidePartName(targets[0].slide);
    const size = ctx.currentSize();
    let summaryIndex = 0;
    await addZooms("summary", targets, {
      onSlide: (pres) => {
        const at = P.getSlides(pres).findIndex(
          (s) => P.getSlidePartName(s) === firstPart,
        );
        P.moveSlide(pres, P.addBlankSlide(pres), Math.max(0, at));
        const slide = P.getSlides(pres)[Math.max(0, at)];
        ctx.titleText(slide, "Summary", size);
        summaryIndex = Math.max(0, at);
        // The summary slide belongs to the section of the slide it precedes.
        return slide;
      },
      area: {
        x: size.cx * 0.06,
        y: size.cy * 0.25,
        w: size.cx * 0.88,
        h: size.cy * 0.68,
      },
    });
    ctx.goToSlide(summaryIndex);
  }

  const setData = (change) =>
    ctx.mutateSlide(ctx.slide(), (slide) => {
      for (const obj of zooms()) {
        const target = P.findShapeById(slide, P.getShapeId(obj));
        if (target)
          P.setShapeObjectData(target, { ...dataOf(target), ...change });
      }
    });

  async function changeImage() {
    const obj = zooms()[0];
    if (!obj) return;
    const [file] = await pickFiles("image/png,image/jpeg");
    if (!file) return;
    const { bytes } = await ctx.readImage(file);
    await ctx.mutateShape(obj, (target, slide) => {
      P.setShapeImage(target, bytes);
      P.setShapeObjectData(target, { ...dataOf(target), customImage: true });
      ctx.pruneMedia(slide);
    });
  }
  async function resetImage() {
    const targets = zooms();
    const updates = [];
    for (const obj of targets) {
      const link = P.getShapeClickAction(obj);
      if (link?.kind === "slide")
        updates.push([P.getShapeId(obj), await thumbnail(link.slide)]);
    }
    await ctx.mutateSlide(ctx.slide(), (slide) => {
      for (const [id, png] of updates) {
        const obj = P.findShapeById(slide, id);
        if (!obj) continue;
        P.setShapeVectorPicture(obj, { png });
        P.setShapeObjectData(obj, { ...dataOf(obj), customImage: false });
      }
      ctx.pruneMedia(slide);
    });
  }

  const first = () => zooms()[0];
  const tab = () => ({
    id: "zoom",
    label: "Zoom",
    contextual: true,
    visible: () =>
      ctx.selectedShapes().length > 0 && ctx.selectedShapes().every(isZoom),
    groups: [
      {
        id: "zoom-image",
        label: "Image",
        icon: "pictures",
        items: [
          {
            type: "large",
            id: "zoom-change-image",
            label: "Change\nImage",
            icon: "changePicture",
            title: "Change Image",
            description: "Show a picture of your own on the zoom.",
            run: () => changeImage().catch(ctx.fail),
          },
          {
            type: "large",
            id: "zoom-reset-image",
            label: "Reset\nImage",
            icon: "resetPicture",
            title: "Reset Image",
            description: "Show the target slide as it looks now.",
            run: () => resetImage().catch(ctx.fail),
          },
        ],
      },
      {
        id: "zoom-options",
        label: "Zoom Options",
        icon: "zoomSlide",
        items: [
          {
            type: "stack",
            items: [
              {
                type: "check",
                id: "zoom-return",
                label: "Return to Zoom",
                checked: () => !!dataOf(first() ?? {}).returnToZoom,
                commit: (on) => setData({ returnToZoom: on }),
              },
              {
                type: "check",
                id: "zoom-transition",
                label: "Zoom Transition",
                checked: () => dataOf(first() ?? {}).transition !== false,
                commit: (on) => setData({ transition: on }),
              },
              {
                type: "spin",
                id: "zoom-duration",
                label: "Duration",
                width: 66,
                min: 0.01,
                max: 59,
                step: 0.25,
                format: (n) => n.toFixed(2),
                enabled: () => dataOf(first() ?? {}).transition !== false,
                value: () => (dataOf(first() ?? {}).duration ?? 1000) / 1000,
                commit: (n) => setData({ duration: Math.round(n * 1000) }),
              },
            ],
          },
        ],
      },
    ],
  });

  const menu = () => [
    {
      label: "Summary Zoom…",
      icon: "o:zoomSummary",
      onSelect: () => summaryZoom().catch(ctx.fail),
    },
    {
      label: "Section Zoom…",
      icon: "o:zoomSection",
      onSelect: () => sectionZoom().catch(ctx.fail),
    },
    {
      label: "Slide Zoom…",
      icon: "o:zoomSlide",
      onSelect: () => slideZoom().catch(ctx.fail),
    },
  ];

  return { menu, tab, isZoom, slideZoom, sectionZoom, summaryZoom };
}
