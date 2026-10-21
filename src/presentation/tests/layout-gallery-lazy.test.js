// The New Slide and Layout galleries are drawn when their menus open, not
// when a menu that holds them as a submenu does, and the layout pictures are
// kept until the layout, its master or its theme changes.
import { describe, it, expect } from "vitest";
import { P } from "../src/model.js";
import { templatePicture } from "../src/layouts/gallery.js";
import { createLayoutCommands } from "../src/layouts/slide-layouts.js";

const commands = (pres) =>
  createLayoutCommands({
    pres: () => pres,
    current: () => P.getSlides(pres)[0],
    targets: () => P.getSlides(pres).slice(0, 1),
    mutate: (fn) => fn(),
    commitText: () => {},
    afterAdd: () => {},
    skip: Symbol("skip"),
    available: () => true,
  });

describe("layout galleries", () => {
  it("leave their pictures until the menu opens", () => {
    const pres = P.createPresentation();
    const [master] = P.getSlideMasters(pres);
    P.addSlide(pres, {
      layout: P.findSlideLayoutByPartName(pres, master.layouts[0].partName),
    });
    const layouts = commands(pres);
    for (const items of [
      layouts.newSlideItems(P.getSlides(pres)[0]),
      layouts.layoutItems(),
    ]) {
      expect(items).toHaveLength(1);
      expect(typeof items[0].custom).toBe("function");
    }
  });

  it("keep a layout's picture until the layout changes", () => {
    const pres = P.createPresentation();
    const [master] = P.getSlideMasters(pres);
    const part = master.layouts[1].partName;
    const first = templatePicture(pres, part);
    expect(templatePicture(pres, part)).toBe(first);
    // Another layout's picture is its own.
    expect(templatePicture(pres, master.layouts[2].partName)).not.toBe(first);
    expect(templatePicture(pres, part)).toBe(first);
    // An edit to the layout draws it again.
    const layout = P.getTemplateSlide(pres, part);
    P.setSlideBackground(layout, "#123456");
    const next = templatePicture(pres, part);
    expect(next).not.toBe(first);
    expect(next.src).not.toBe(first.src);
    expect(templatePicture(pres, part)).toBe(next);
  });

  // The toolbar asks on every keystroke and caret move; reading every layout
  // to answer cost time in proportion to the template's layouts.
  it("tell whether layouts apply without reading them", () => {
    const pres = P.createPresentation();
    const [master] = P.getSlideMasters(pres);
    P.addSlide(pres, {
      layout: P.findSlideLayoutByPartName(pres, master.layouts[0].partName),
    });
    // Another layout's bytes are never looked at.
    P._internalPackageOf(pres).getPart(master.layouts[1].partName).data =
      new TextEncoder().encode("not xml");
    const layouts = commands(pres);
    expect(layouts.canChangeLayout()).toBe(true);
    expect(layouts.canReset()).toBe(true);
  });
});
