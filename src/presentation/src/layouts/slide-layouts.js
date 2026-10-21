// Slide commands built on layouts: New Slide on a layout, changing the
// layout of the selected slides, and Reset. The editor hands in what these
// need through `host`.
import { P, matchHeaderFooter } from "../model.js";
import { layoutGallery, nextLayoutFor } from "./gallery.js";

export const SLIDE_LIMIT = 300;

export function createLayoutCommands(host) {
  // host: {
  //   pres(),                 the open presentation
  //   current(),              the current slide
  //   targets(),              the slides a slide command covers
  //   mutate(fn),             an undoable edit
  //   commitText(),           close an open text editor first
  //   afterAdd(position),     make the new slide current
  //   skip,                   the value that cancels an edit
  //   available(),            whether slide commands apply now
  // }
  const partsOf = (slides) => new Set(slides.map(P.getSlidePartName));
  const resolve = (parts) =>
    P.getSlides(host.pres()).filter((s) => parts.has(P.getSlidePartName(s)));

  function addSlide(target, layoutPart = null) {
    if (!host.available()) return;
    host.commitText();
    const after = target ? P.getSlidePartName(target) : null;
    return host.mutate(() => {
      const pres = host.pres();
      const slides = P.getSlides(pres);
      if (slides.length >= SLIDE_LIMIT)
        throw new Error(`The slide limit is ${SLIDE_LIMIT}.`);
      const previous = slides.find((s) => P.getSlidePartName(s) === after);
      const part = layoutPart || nextLayoutFor(pres, previous);
      const layout = part && P.findSlideLayoutByPartName(pres, part);
      if (!layout) throw new Error("This presentation has no slide layouts.");
      const added = P.addSlide(pres, { layout });
      const position = previous ? slides.indexOf(previous) + 1 : slides.length;
      P.moveSlide(pres, added, position);
      matchHeaderFooter(
        pres,
        P.getSlides(pres)[position],
        previous,
        position + 1,
      );
      host.afterAdd(position);
    });
  }

  /**
   * The New Slide gallery: a picture of every layout of every master. The
   * gallery is drawn when its menu opens, not when a menu holding it as a
   * submenu does; the pictures are kept per layout and redrawn only when the
   * layout, its master or its theme changes.
   */
  function newSlideItems(target) {
    return [
      {
        custom: () =>
          layoutGallery(host.pres(), {
            label: "Layouts for a new slide",
            onChoose: (part) => addSlide(target, part),
          }),
      },
    ];
  }

  function layoutOf(slide) {
    const layout = slide && P.getSlideLayout(slide);
    return layout ? P.getSlideLayoutPartName(layout) : null;
  }

  /** Puts `targets` on another layout, moving their content across. */
  function changeLayout(targets, part) {
    if (!host.available()) return;
    host.commitText();
    const parts = partsOf(targets);
    return host.mutate(() => {
      const pres = host.pres();
      let changed = false;
      for (const s of resolve(parts)) {
        if (layoutOf(s) === part) continue;
        P.applySlideLayout(pres, s, part);
        changed = true;
      }
      return changed ? undefined : host.skip;
    });
  }

  /** The Layout gallery for the slides a command covers. */
  function layoutItems(targets = host.targets()) {
    const current = layoutOf(targets[0]);
    const same = targets.every((s) => layoutOf(s) === current);
    return [
      {
        custom: () =>
          layoutGallery(host.pres(), {
            label:
              targets.length > 1
                ? `Layout for ${targets.length} slides`
                : "Slide layout",
            selected: same ? current : null,
            radio: true,
            onChoose: (part) => changeLayout(targets, part),
          }),
      },
    ];
  }

  /** Puts the placeholders of `targets` back as their layout has them. */
  function resetSlides(targets = host.targets()) {
    if (!host.available()) return;
    host.commitText();
    const parts = partsOf(targets);
    return host.mutate(() => {
      const pres = host.pres();
      const chosen = resolve(parts);
      if (!chosen.length) return host.skip;
      const before = chosen.map(P.getSlideXmlString).join("\n");
      for (const s of chosen) P.resetSlideToLayout(pres, s);
      return chosen.map(P.getSlideXmlString).join("\n") === before
        ? host.skip
        : undefined;
    });
  }

  const hasLayouts = () =>
    host.available() && P.getSlideLayouts(host.pres()).length > 0;

  return {
    addSlide,
    newSlideItems,
    layoutItems,
    changeLayout,
    resetSlides,
    canChangeLayout: hasLayouts,
    canReset: () => hasLayouts() && !!P.getSlideLayout(host.current()),
  };
}
