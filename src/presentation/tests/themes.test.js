import { describe, it, expect } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { P, THEMES, createDeck, preview } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import {
  CATALOG,
  LEGACY_IDS,
  themeById,
  variantPalette,
} from "../src/themes/catalog.js";
import * as E from "../src/themes/engine.js";
import {
  backgroundStyles,
  readThemeXml,
  themeXml,
  withColors,
  withEffects,
  withFonts,
} from "../src/themes/theme-xml.js";
import { masterDesign } from "../src/themes/design.js";

const errors = (pres) =>
  P.validatePresentation(pres).filter((i) => i.severity === "error");
const reload = async (pres) =>
  P.loadPresentation(await P.savePresentation(pres));
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);

// A deck with a title slide, a content slide and a section header, each
// with text in its placeholders.
function sampleDeck() {
  const pres = P.createPresentation();
  for (const type of ["title", "obj", "secHead"])
    P.addSlide(pres, { layout: P.findSlideLayoutByType(pres, type) });
  const texts = [
    ["Quarterly review", "The year ahead"],
    ["What we learned", "First point"],
    ["Next steps", "Where we go"],
  ];
  P.getSlides(pres).forEach((s, i) =>
    P.getSlideShapes(s)
      .filter((x) => P.isShapePlaceholder(x))
      .forEach((x, j) => texts[i][j] && P.setShapeText(x, texts[i][j])),
  );
  return pres;
}
const slideTexts = (pres) => P.getSlides(pres).map((s) => P.getSlideText(s));
const placeholderCount = (pres) =>
  P.getSlides(pres).map(
    (s) => P.getSlideShapes(s).filter((x) => P.isShapePlaceholder(x)).length,
  );

describe("theme catalog", () => {
  it("offers 16 to 24 themes, each with four variants of 12 colors", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(16);
    expect(CATALOG.length).toBeLessThanOrEqual(24);
    expect(new Set(CATALOG.map((t) => t.name)).size).toBe(CATALOG.length);
    for (const theme of CATALOG) {
      expect(theme.variants).toHaveLength(4);
      for (const v of theme.variants)
        expect(
          Object.values(v.colors).every((c) => /^#[0-9a-f]{6}$/.test(c)),
        ).toBe(true);
    }
  });

  it("keeps the original four palettes as themes with the same colors", () => {
    for (const id of ["studio", "cobalt", "clay", "midnight"]) {
      expect(LEGACY_IDS.has(id)).toBe(true);
      const palette = variantPalette(themeById(id), 0);
      for (const key of ["bg", "ink", "accent", "muted", "panel"])
        expect(palette[key]).toBe(THEMES[id][key]);
    }
  });

  it("gives every theme a palette starter decks and the start screen use", () => {
    for (const theme of CATALOG)
      expect(THEMES[theme.id]?.name).toBe(theme.name);
  });

  it("writes a complete theme part", () => {
    const xml = themeXml({
      name: "Sample",
      colors: { ...themeById("harbor").variants[1].colors, name: "Fog" },
      fonts: { major: "Georgia", minor: "Verdana" },
      effects: "lifted",
    });
    const info = readThemeXml(xml);
    expect(info.name).toBe("Sample");
    expect(info.colorName).toBe("Fog");
    expect(info.fonts).toEqual({ major: "Georgia", minor: "Verdana" });
    expect(info.effectsName).toBe("Lifted");
    expect(info.colors.accent1).toBe(
      themeById("harbor").variants[1].colors.accent1,
    );
    expect(xml.match(/<a:effectStyle>/g)).toHaveLength(3);
    expect(xml).toMatch(/<a:bgFillStyleLst>(.*<a:(solidFill|gradFill)){3}/);
  });

  it("offers 12 background styles from the theme's background fills", () => {
    const styles = backgroundStyles("calm");
    expect(styles).toHaveLength(12);
    expect(new Set(styles.map((s) => s.id)).size).toBe(12);
  });
});

describe("applying themes", () => {
  it.each(CATALOG.flatMap((t) => t.variants.map((_, v) => [t.id, v])))(
    "applies %s in variant %i to every slide, through save and reload",
    async (id, variant) => {
      const pres = sampleDeck();
      const before = slideTexts(pres);
      E.applyTheme(pres, id, { variant });
      expect(P.getSlideMasters(pres)).toHaveLength(1);
      expect(errors(pres)).toEqual([]);
      const loaded = await reload(pres);
      expect(slideTexts(loaded)).toEqual(before);
      const info = E.slideThemeInfo(loaded, P.getSlides(loaded)[0]);
      expect(info.theme.id).toBe(id);
      expect(info.variant).toBe(variant);
      expect(info.dark).toBe(!!themeById(id).variants[variant].dark);
    },
  );

  it("keeps slide content in its placeholders and adds no empty ones", () => {
    const pres = sampleDeck();
    const counts = placeholderCount(pres);
    E.applyTheme(pres, "meridian");
    expect(placeholderCount(pres)).toEqual(counts);
    const [title] = P.getSlides(pres);
    const layout = P.getSlideLayout(title);
    expect(P.getSlideLayoutType(layout)).toBe("title");
    // The title follows the new layout's place for it.
    const box = P.getShapeBoundsResolved(pres, P.getSlideShapes(title)[0]);
    expect(box.x).toBe(Math.round(0.08 * 12192000));
  });

  it("applies a theme to selected slides with a second master", () => {
    const pres = sampleDeck();
    E.applyTheme(pres, "atlas");
    const [, second] = P.getSlides(pres);
    E.applyTheme(pres, "ember", { slides: [second] });
    expect(P.getSlideMasters(pres)).toHaveLength(2);
    const names = P.getSlides(pres).map(
      (s) => E.slideThemeInfo(pres, s).theme.id,
    );
    expect(names).toEqual(["atlas", "ember", "atlas"]);
    // Moving the last slide off a master drops that master.
    E.applyTheme(pres, "atlas", { slides: [P.getSlides(pres)[1]] });
    expect(P.getSlideMasters(pres)).toHaveLength(2);
    E.applyTheme(pres, "atlas");
    expect(P.getSlideMasters(pres)).toHaveLength(1);
    expect(errors(pres)).toEqual([]);
  });

  it("recolors the starter slides of the original palettes", () => {
    const pres = createDeck("story", "studio");
    E.applyTheme(pres, "cobalt", {
      from: variantPalette(themeById("studio"), 0),
    });
    expect(P.getSlideBackground(P.getSlides(pres)[0]).color.toLowerCase()).toBe(
      THEMES.cobalt.bg,
    );
    // A designed theme shows its own background behind them.
    E.applyTheme(pres, "lagoon", {
      from: variantPalette(themeById("cobalt"), 0),
    });
    expect(P.getSlideBackground(P.getSlides(pres)[0]).kind).toBe("inherit");
  });

  it("starts designed-theme decks on the theme's master and fonts", async () => {
    const pres = createDeck("pitch", "orbit");
    expect(P.getSlides(pres)).toHaveLength(5);
    expect(P.getSlideMasters(pres)).toHaveLength(1);
    expect(E.slideThemeInfo(pres, P.getSlides(pres)[0]).theme.id).toBe("orbit");
    const xml = P.getSlideXmlString(P.getSlides(pres)[0]);
    expect(xml).toContain('typeface="+mj-lt"');
    expect(errors(await reload(pres))).toEqual([]);
  });

  it("makes a new deck in a theme with its title slide placeholders", () => {
    const pres = E.themedDeck("prism");
    const [slide] = P.getSlides(pres);
    expect(P.getSlideLayoutType(P.getSlideLayout(slide))).toBe("title");
    expect(
      P.getSlideShapes(slide).map((s) => P.getShapePlaceholderType(s)),
    ).toEqual(["ctrTitle", "subTitle"]);
  });
});

describe("variants, colors, fonts and effects", () => {
  it("switches variants in place, including to a dark one", () => {
    const pres = sampleDeck();
    const master = E.applyTheme(pres, "harbor");
    expect(E.applyVariant(pres, [master], 3, P.getSlides(pres))).toBe(true);
    const info = E.masterInfo(pres, master);
    expect(info.variant).toBe(3);
    expect(info.dark).toBe(true);
    expect(P.getSlideMasters(pres)).toHaveLength(1);
    // Rendering resolves the new background.
    const svg = renderSlideToSvg(pres, P.getSlides(pres)[1], {});
    expect(svg).toContain(
      themeById("harbor").variants[3].colors.dk1.slice(1).toUpperCase(),
    );
    expect(E.applyVariant(pres, [master], 3)).toBe(false);
  });

  it("changes colors, fonts and effects on the theme part", async () => {
    const pres = sampleDeck();
    const master = E.applyTheme(pres, "gallery");
    const colors = {
      ...themeById("signal").variants[2].colors,
      name: "Custom Mine",
    };
    E.applyColors(pres, [master], colors);
    E.applyFonts(pres, [master], {
      name: "Pair",
      major: "Impact",
      minor: "Verdana",
    });
    E.applyEffects(pres, [master], "glow");
    const loaded = await reload(pres);
    const info = E.masterInfo(loaded, P.getSlideMasters(loaded)[0].partName);
    expect(info.colorName).toBe("Custom Mine");
    expect(info.colors.accent1).toBe(colors.accent1);
    expect(info.fonts).toEqual({ major: "Impact", minor: "Verdana" });
    expect(info.effects).toBe("glow");
    expect(info.theme.id).toBe("gallery");
    expect(info.variant).toBe(-1);
    expect(errors(loaded)).toEqual([]);
  });

  it("edits theme XML with any namespace prefix", () => {
    const base = themeXml({
      name: "T",
      colors: { ...themeById("paper").variants[0].colors, name: "P" },
      fonts: { major: "Arial", minor: "Arial" },
    });
    const odd = base
      .replace(/<(\/?)a:/g, "<$1d:")
      .replace("xmlns:a=", "xmlns:d=");
    const changed = withEffects(
      withFonts(
        withColors(odd, { ...themeById("kite").variants[0].colors, name: "K" }),
        {
          major: "Georgia",
          minor: "Tahoma",
        },
      ),
      "soft",
    );
    const info = readThemeXml(changed);
    expect(info.colorName).toBe("K");
    expect(info.fonts).toEqual({ major: "Georgia", minor: "Tahoma" });
    expect(info.effectsName).toBe("Soft Shadow");
  });
});

describe("theme files", () => {
  it("saves a master as a theme file and applies it to another deck", async () => {
    const source = sampleDeck();
    const master = E.applyTheme(source, "blueprint", { variant: 1 });
    const bytes = P.exportThemeFile(source, master, { thumbnail: PNG });
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "theme/theme/themeManager.xml",
        "theme/theme/theme1.xml",
        "theme/theme/_rels/theme1.xml.rels",
        "theme/slideMasters/slideMaster1.xml",
        "theme/slideLayouts/slideLayout11.xml",
        "docProps/thumbnail.png",
      ]),
    );
    expect(strFromU8(files["_rels/.rels"])).toContain(
      "theme/theme/themeManager.xml",
    );
    expect(strFromU8(files["theme/theme/_rels/theme1.xml.rels"])).toContain(
      "slideMaster",
    );
    const target = createDeck("story", "clay");
    const texts = slideTexts(target);
    E.applyThemeFile(target, bytes);
    expect(P.getSlideMasters(target)).toHaveLength(1);
    expect(slideTexts(target)).toEqual(texts);
    const info = E.slideThemeInfo(target, P.getSlides(target)[0]);
    expect(info.theme.id).toBe("blueprint");
    expect(info.variant).toBe(1);
    expect(errors(await reload(target))).toEqual([]);
  });

  it("brings in the first master of a presentation", async () => {
    const source = sampleDeck();
    E.applyTheme(source, "grove");
    P.setSlideBackgroundPicture(
      P.getTemplateSlide(source, P.getSlideMasters(source)[0].partName),
      PNG,
    );
    const target = sampleDeck();
    const master = P.importSlideMasterFile(
      target,
      await P.savePresentation(source),
    );
    const entry = P.getSlideMasters(target).find((m) => m.partName === master);
    expect(entry.layouts).toHaveLength(11);
    expect(E.masterInfo(target, master).theme.id).toBe("grove");
    expect(
      P.getSlideMasterBackgroundImageBytes(
        target,
        P.findSlideLayoutByPartName(target, entry.layouts[0].partName),
      ),
    ).toEqual(PNG);
    expect(errors(await reload(target))).toEqual([]);
  });

  it("refuses files that are not themes or presentations", () => {
    expect(() =>
      P.importSlideMasterFile(sampleDeck(), new Uint8Array([1, 2, 3])),
    ).toThrow(/not a theme/);
  });
});

describe("backgrounds", () => {
  it("writes gradient, pattern and picture backgrounds that survive saving", async () => {
    const pres = sampleDeck();
    const [a, b, c] = P.getSlides(pres);
    P.setSlideBackgroundGradient(a, {
      stops: [
        { offset: 0, color: "scheme:accent1/lumMod=60000/lumOff=40000" },
        { offset: 1, color: "#123456", opacity: 0.5 },
      ],
      path: "circle",
      focus: { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 },
    });
    P.setSlideBackgroundPattern(b, {
      preset: "smGrid",
      foreground: "scheme:tx2",
      background: "#FFFFFF",
    });
    P.setSlideBackgroundPicture(c, PNG, {
      tile: {
        offsetX: 12700,
        scaleX: 0.5,
        scaleY: 0.5,
        align: "ctr",
        flip: "xy",
      },
      transparency: 0.25,
    });
    const loaded = await reload(pres);
    const [la, lb, lc] = P.getSlides(loaded);
    expect(P.getSlideBackground(la).kind).toBe("gradient");
    expect(P.getSlideBackground(lb).kind).toBe("pattern");
    expect(P.getSlideBackgroundPictureFill(lc)).toEqual({
      tile: {
        offsetX: 12700,
        offsetY: 0,
        scaleX: 0.5,
        scaleY: 0.5,
        align: "ctr",
        flip: "xy",
      },
      stretch: { left: 0, top: 0, right: 0, bottom: 0 },
      transparency: 0.25,
    });
    const svg = renderSlideToSvg(loaded, lc, {});
    expect(svg).toContain("<pattern");
    expect(svg).toContain('opacity="0.750"');
    expect(errors(loaded)).toEqual([]);
  });

  it("stretches a picture with insets, and changes options in place", () => {
    const pres = sampleDeck();
    const [slide] = P.getSlides(pres);
    P.setSlideBackgroundPicture(slide, PNG);
    expect(
      P.setSlideBackgroundPictureOptions(slide, {
        stretch: { left: 0.1, right: 0.1 },
      }),
    ).toBe(true);
    expect(P.getSlideBackgroundPictureFill(slide).stretch.left).toBeCloseTo(
      0.1,
    );
    const svg = renderSlideToSvg(pres, slide, {});
    expect(svg).toContain('preserveAspectRatio="none"');
    P.clearSlideBackground(slide);
    expect(
      P.setSlideBackgroundPictureOptions(slide, { transparency: 0.5 }),
    ).toBe(false);
  });

  it("copies a background to other slides, sharing its picture", async () => {
    const pres = sampleDeck();
    const [a, b, c] = P.getSlides(pres);
    P.setSlideBackgroundPicture(a, PNG, { tile: {} });
    P.copySlideBackground(a, b);
    P.copySlideBackground(c, a);
    expect(P.getSlideBackground(b).kind).toBe("image");
    expect(P.getSlideBackground(a).kind).toBe("inherit");
    expect(P.getSlideBackgroundImageBytes(b)).toEqual(PNG);
    const loaded = await reload(pres);
    expect(errors(loaded)).toEqual([]);
    expect(
      P.getSlideBackgroundPictureFill(P.getSlides(loaded)[1]).tile,
    ).not.toBe(null);
  });

  it("applies background style fills on masters and slides", () => {
    const pres = sampleDeck();
    const master = E.applyTheme(pres, "paper");
    const view = P.getTemplateSlide(pres, master);
    for (const style of backgroundStyles("calm"))
      E.setBackgroundFill(view, style.fill);
    E.setBackgroundFill(P.getSlides(pres)[0], {
      pattern: "pct20",
      fg: "tx1",
      bg: "bg1",
    });
    expect(P.getSlideBackground(P.getSlides(pres)[0]).kind).toBe("pattern");
    expect(errors(pres)).toEqual([]);
  });
});

describe("theme pictures", () => {
  it("renders a theme's design from its master", () => {
    const pres = E.themedDeck("signal");
    const src = preview(pres, P.getSlides(pres)[0]);
    expect(src.startsWith("data:image/svg+xml")).toBe(true);
    const design = masterDesign(themeById("signal"), 0, {
      width: 9144000,
      height: 6858000,
    });
    // A 4:3 design sizes its artwork to the slide.
    expect(design.shapes).toContain('<a:ext cx="');
    expect(design.layouts.title.placeholders[0].box.w).toBe(
      Math.round(0.52 * 9144000),
    );
  });
});
