// Zoom: slide pictures that jump to their slide or section in a slide show
// and come back. Slide Zoom and Section Zoom place pictures on the current
// slide; Summary Zoom makes a new slide of them. Each is a picture of the
// target slide with a slide-jump click action (so other apps still follow
// it), and its zoom settings in the app's object data.
import { el, dialog } from "../ui.js";
import { pickFiles, previewToPng } from "./util.js";
import { zoomGrid } from "./geometry.js";
import { templateStamp } from "../model.js";
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
        placeInOwnSection(pres, slide);
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

  // In a deck with sections, the summary slide starts a section of its own
  // before the first section it summarizes. Left to join a neighbour, it
  // ended the section before (or began the first one), so zooming into that
  // section played the summary slide as part of it.
  function placeInOwnSection(pres, slide) {
    const sections = P.getSlideSections(pres) || [];
    if (!sections.length) return;
    const part = P.getSlidePartName(slide);
    const slides = P.getSlides(pres);
    const at = slides.findIndex((s) => P.getSlidePartName(s) === part);
    const nextPart = slides[at + 1] && P.getSlidePartName(slides[at + 1]);
    const rest = sections.map((sec) => ({
      name: sec.name,
      id: sec.id,
      slides: sec.slides.filter((s) => P.getSlidePartName(s) !== part),
    }));
    const before = rest.findIndex((sec) =>
      sec.slides.some((s) => P.getSlidePartName(s) === nextPart),
    );
    rest.splice(before < 0 ? rest.length : before, 0, {
      name: "Summary Section",
      slides: [slide],
    });
    P.setSlideSections(pres, rest);
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

  // Zoom pictures follow their target slides: after an edit, a zoom whose
  // target has changed since it was last seen is drawn again, unless its
  // picture is one the user chose. What each target looked like is kept by
  // deck; a target first seen is taken as drawn.
  const seen = new WeakMap();
  const signature = (pres, slide) => {
    const size = ctx.currentSize();
    return `${size.cx}x${size.cy}|${templateStamp(pres, slide)}|${P.getSlideXmlString(slide)}`;
  };
  function zoomsIn(pres) {
    const out = [];
    for (const slide of P.getSlides(pres))
      for (const shape of P.getSlideShapes(slide)) {
        if (!isZoom(shape)) continue;
        const link = P.getShapeClickAction(shape);
        if (link?.kind === "slide")
          out.push({ slide, shape, target: link.slide });
      }
    return out;
  }
  function remember(pres, list = zoomsIn(pres)) {
    const known = new Map();
    for (const z of list) {
      const part = P.getSlidePartName(z.target);
      if (!known.has(part)) known.set(part, signature(pres, z.target));
    }
    seen.set(pres, known);
    return known;
  }
  // A deck as opened, or as undo or redo brings it back, is taken as drawn:
  // what its zoom targets look like is noted before any edit to them.
  function seedZooms() {
    const pres = ctx.pres();
    if (pres && !seen.has(pres)) remember(pres);
  }
  /**
   * Draws again the zooms whose target slides changed, as part of the edit
   * that changed them: `amends` is the history entry the redraw merges into.
   * Resolves when done; does nothing when no zoom is stale.
   */
  async function refreshStale(amends) {
    const pres = ctx.pres();
    const list = zoomsIn(pres);
    if (!list.length) return;
    const known = seen.get(pres) ?? remember(pres, list);
    const now = new Map();
    const stale = [];
    for (const z of list) {
      const part = P.getSlidePartName(z.target);
      if (!now.has(part)) now.set(part, signature(pres, z.target));
      const was = known.get(part);
      if (
        was !== undefined &&
        was !== now.get(part) &&
        !dataOf(z.shape).customImage &&
        part !== P.getSlidePartName(z.slide)
      )
        stale.push({
          slide: P.getSlidePartName(z.slide),
          id: P.getShapeId(z.shape),
          target: z.target,
        });
    }
    if (!stale.length) {
      for (const [part, value] of now) known.set(part, value);
      return;
    }
    const size = ctx.currentSize();
    const pictures = new Map();
    for (const z of stale) {
      const part = P.getSlidePartName(z.target);
      if (!pictures.has(part))
        pictures.set(
          part,
          await previewToPng(
            ctx.previewOf(pres, z.target),
            640,
            size.cx / size.cy,
          ),
        );
    }
    if (ctx.pres() !== pres) return;
    await ctx.mutate(
      () => {
        const current = ctx.pres();
        const slides = new Map(
          P.getSlides(current).map((s) => [P.getSlidePartName(s), s]),
        );
        let changed = false;
        for (const z of stale) {
          const slide = slides.get(z.slide);
          const obj = slide && P.findShapeById(slide, z.id);
          if (!obj || dataOf(obj).customImage) continue;
          P.setShapeVectorPicture(obj, {
            png: pictures.get(P.getSlidePartName(z.target)),
          });
          ctx.pruneMedia(slide);
          changed = true;
        }
        // What the targets look like now, the redrawn zooms included, is
        // what the next edit is compared with.
        remember(current);
        if (!changed) return ctx.skip;
      },
      { amends },
    );
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

  return {
    menu,
    tab,
    isZoom,
    slideZoom,
    sectionZoom,
    summaryZoom,
    refreshStale,
    seedZooms,
  };
}
