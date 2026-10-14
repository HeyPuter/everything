// Themes and design: the theme gallery (every slide or the selected ones),
// variants, colors, fonts and effects with their Customize dialogs,
// background styles, the Format Background pane, theme files, and the start
// screen's themes. Each flow is checked in the file the app downloads.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { P, parseDeck } from "../src/model.js";
import { CATALOG } from "../src/themes/catalog.js";

test.setTimeout(150_000);
// New presentations start on the Title Slide, as they do by default.
test.use({ storageState: { cookies: [], origins: [] } });
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function start(page, path = "/") {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto(path);
}
async function storyDeck(page) {
  await start(page, "/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await expect(page.locator(".slide-thumb")).toHaveCount(5);
}
const tab = (page, id) => page.locator(`[role=tab][data-tab="${id}"]`).click();
// A ribbon command, unfolding its group first on a narrow screen.
async function command(page, id) {
  const selector = `[data-command="${id}"]`;
  if (!(await page.locator(`${selector}:visible`).count()))
    await page
      .locator(
        `.ribbon-panel:not([hidden]) .ribbon-group:has(${selector}) .ribbon-fold`,
      )
      .click();
  await page.locator(`${selector}:visible`).first().click();
}
// A gallery's full panel, unfolding its group first on a narrow screen.
async function galleryPanel(page, label) {
  const more = page
    .locator(".ribbon-panel:not([hidden]), .ribbon-fold-panel")
    .getByRole("button", { name: `More ${label}` })
    .filter({ visible: true });
  if (!(await more.count()))
    await page
      .locator(`.ribbon-panel:not([hidden]) .ribbon-fold[title="${label}"]`)
      .click();
  await more.first().click();
  return page.locator(".ribbon-gallery-panel");
}
// A theme in the gallery's full panel.
async function themeOption(page, name) {
  return (await galleryPanel(page, "Themes")).getByRole("option", {
    name,
    exact: true,
  });
}
async function download(page) {
  await page
    .getByRole("menuitem", { name: "File", exact: true })
    .or(page.getByRole("button", { name: "File options" }))
    .filter({ visible: true })
    .click();
  const event = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const bytes = await readFile(await (await event).path());
  return { p: await parseDeck(bytes), files: unzipSync(bytes) };
}
const themeOf = (p, slide) => {
  const layout = P.getSlideLayout(slide);
  const master = P.getLayoutMasterPartName(p, P.getSlideLayoutPartName(layout));
  return P.getSlideMasterThemeXml(p, master);
};
const nameOf = (xml) => /<a:theme[^>]*name="([^"]*)"/.exec(xml)?.[1];
const colorsOf = (xml) => /<a:clrScheme name="([^"]*)"/.exec(xml)?.[1];

test("a theme and its variant restyle the master every slide uses", async ({
  page,
}) => {
  await start(page);
  await expect(page.locator("#slide-canvas .slide-image")).toBeVisible();
  const before = await page
    .locator("#slide-canvas .slide-image")
    .getAttribute("src");
  await tab(page, "design");
  await (await themeOption(page, "Harbor")).click();
  await expect
    .poll(() => page.locator("#slide-canvas .slide-image").getAttribute("src"))
    .not.toBe(before);
  // The Variants gallery offers the theme's four color variants.
  const variants = await galleryPanel(page, "Variants");
  await expect(variants.getByRole("option")).toHaveCount(4);
  await variants.getByRole("option", { name: "Harbor Fog" }).click();
  await expect(page.locator("#save-status")).toContainText("Saved");
  const { p } = await download(page);
  expect(P.getSlideMasters(p)).toHaveLength(1);
  const xml = themeOf(p, P.getSlides(p)[0]);
  expect(nameOf(xml)).toBe("Harbor");
  expect(colorsOf(xml)).toBe("Harbor Fog");
  // The title slide keeps its placeholders, on the theme's own layout.
  expect(
    P.getSlideShapes(P.getSlides(p)[0]).map((s) =>
      P.getShapePlaceholderType(s),
    ),
  ).toEqual(["ctrTitle", "subTitle"]);
});

test("a theme applies to the selected slides through its context menu", async ({
  page,
}) => {
  await storyDeck(page);
  await page.locator(".slide-thumb").nth(1).click();
  await tab(page, "design");
  const ember = await themeOption(page, "Ember");
  await ember.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Apply to Selected Slides" })
    .click();
  await expect(page.locator("#save-status")).toContainText("Saved");
  const { p } = await download(page);
  expect(P.getSlideMasters(p)).toHaveLength(2);
  const names = P.getSlides(p).map((s) => nameOf(themeOf(p, s)));
  expect(names[1]).toBe("Ember");
  expect(names.filter((n) => n === "Ember")).toHaveLength(1);
  // Undo takes the second master away again.
  await page.locator("#slide-canvas").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press(`${mod}+z`);
  await expect(page.locator("#save-status")).toContainText("Saved");
  const again = await download(page);
  expect(P.getSlideMasters(again.p)).toHaveLength(1);
});

test("colors, fonts and effects change the theme, and custom ones are kept", async ({
  page,
}) => {
  await start(page);
  await expect(page.locator("#slide-canvas .slide-image")).toBeVisible();
  await tab(page, "design");
  await (await themeOption(page, "Atlas")).click();
  await command(page, "theme-colors");
  await page
    .getByRole("menuitemcheckbox", { name: "Kite", exact: true })
    .click();
  await command(page, "theme-colors");
  await page.getByRole("menuitem", { name: "Customize Colors…" }).click();
  const colors = page.getByRole("dialog", { name: "Customize Colors" });
  await colors.getByLabel("Accent 1").fill("#123abc");
  await colors.getByRole("textbox", { name: "Name" }).fill("Our colors");
  await colors.getByRole("button", { name: "Save" }).click();
  await expect(colors).toHaveCount(0);
  // The saved scheme is offered again.
  await command(page, "theme-colors");
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Our colors" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await command(page, "theme-fonts");
  await page.getByRole("menuitem", { name: "Customize Fonts…" }).click();
  const fonts = page.getByRole("dialog", { name: "Customize Fonts" });
  await fonts
    .getByRole("combobox", { name: "Heading font" })
    .selectOption("Georgia");
  await fonts
    .getByRole("combobox", { name: "Body font" })
    .selectOption("Verdana");
  await fonts.getByRole("button", { name: "Save" }).click();
  await command(page, "theme-effects");
  await page.getByRole("menuitemcheckbox", { name: "Lifted" }).click();
  await expect(page.locator("#save-status")).toContainText("Saved");
  const { p } = await download(page);
  const xml = themeOf(p, P.getSlides(p)[0]);
  expect(nameOf(xml)).toBe("Atlas");
  expect(colorsOf(xml)).toBe("Our colors");
  expect(xml).toContain('<a:accent1><a:srgbClr val="123ABC"/>');
  expect(xml).toMatch(/<a:majorFont><a:latin typeface="Georgia"/);
  expect(xml).toMatch(/<a:minorFont><a:latin typeface="Verdana"/);
  expect(xml).toContain('<a:fmtScheme name="Lifted">');
});

test("background styles, the Format Background pane and Apply to All", async ({
  page,
}) => {
  await storyDeck(page);
  await tab(page, "design");
  // A background style goes on the master; the slides' own give way.
  await command(page, "background-styles");
  await page.getByRole("menuitem", { name: "Style 6" }).click();
  await expect(page.locator("#save-status")).toContainText("Saved");
  let { p } = await download(page);
  expect(P.getSlideBackground(P.getSlides(p)[0]).kind).toBe("inherit");
  // The pane: a gradient with a third stop, then a pattern.
  await command(page, "format-background");
  const pane = page.locator("#format-background");
  await pane.getByRole("radio", { name: "Gradient fill" }).check();
  await expect(
    pane.getByRole("radiogroup", { name: "Gradient stops" }),
  ).toBeVisible();
  await pane.getByRole("button", { name: "Add gradient stop" }).click();
  await expect(pane.locator(".bg-stop")).toHaveCount(3);
  await pane.getByRole("combobox", { name: "Type" }).selectOption("circle");
  await expect(pane.getByRole("combobox", { name: "Type" })).toHaveValue(
    "circle",
  );
  ({ p } = await download(page));
  expect(P.getSlideBackground(P.getSlides(p)[0]).kind).toBe("gradient");
  await pane.getByRole("radio", { name: "Pattern fill" }).check();
  await pane.getByRole("radio", { name: "Small grid" }).click();
  await expect(pane.getByRole("radio", { name: "Small grid" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // A texture, tiled, and hidden background graphics, applied to all.
  await pane.getByRole("radio", { name: "Picture or texture fill" }).check();
  await pane.getByRole("button", { name: "Linen texture" }).click();
  await expect(pane.getByLabel("Tile picture as texture")).toBeChecked();
  await pane.getByRole("spinbutton", { name: "Scale X (%)" }).fill("50");
  await pane.getByRole("spinbutton", { name: "Scale X (%)" }).press("Enter");
  await pane.getByLabel("Hide background graphics").check();
  await pane.getByRole("button", { name: "Apply to All" }).click();
  await expect(page.locator("#save-status")).toContainText("Saved");
  ({ p } = await download(page));
  const slides = P.getSlides(p);
  for (const s of slides) {
    expect(P.getSlideBackground(s).kind).toBe("image");
    expect(P.getSlideXmlString(s)).toContain('showMasterSp="0"');
  }
  expect(P.getSlideBackgroundPictureFill(slides[3]).tile.scaleX).toBe(0.5);
  // Reset Background puts the slide back on the master's background: the
  // gradient background style chosen first.
  await pane.getByRole("button", { name: "Reset Background" }).click();
  await expect(
    pane.getByRole("radio", { name: "Gradient fill" }),
  ).toBeChecked();
  ({ p } = await download(page));
  expect(P.getSlideBackground(P.getSlides(p)[0]).kind).toBe("inherit");
  expect(P.getSlideBackground(P.getSlides(p)[1]).kind).toBe("image");
});

test("the current theme saves as a theme file that another deck can use", async ({
  page,
}) => {
  await start(page);
  await expect(page.locator("#slide-canvas .slide-image")).toBeVisible();
  await tab(page, "design");
  await (await themeOption(page, "Orbit")).click();
  await expect(page.locator("#save-status")).toContainText("Saved");
  await galleryPanel(page, "Themes");
  const saving = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Current Theme…" }).click();
  const saved = await saving;
  expect(saved.suggestedFilename()).toBe("Orbit.thmx");
  const thmx = await readFile(await saved.path());
  const files = unzipSync(thmx);
  expect(Object.keys(files)).toContain("theme/theme/themeManager.xml");
  expect(strFromU8(files["theme/theme/theme1.xml"])).toContain('name="Orbit"');
  // Another theme, then the file brings Orbit back.
  await (await themeOption(page, "Slate")).click();
  await galleryPanel(page, "Themes");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse for Themes…" }).click();
  await (
    await chooser
  ).setFiles({
    name: "Orbit.thmx",
    mimeType: "application/vnd.ms-officetheme",
    buffer: thmx,
  });
  await expect
    .poll(async () => {
      const { p } = await download(page);
      return nameOf(themeOf(p, P.getSlides(p)[0]));
    })
    .toBe("Orbit");
});

test("the start screen offers every theme, drawn from the theme", async ({
  page,
}) => {
  await start(page, "/#/home");
  const themes = page.getByRole("region", { name: "Start in a theme" });
  await expect(themes.getByRole("button", { name: / theme$/ })).toHaveCount(
    CATALOG.length,
  );
  const lagoon = themes.getByRole("button", {
    name: "New presentation in the Lagoon theme",
  });
  await lagoon.scrollIntoViewIfNeeded();
  expect(await lagoon.locator("img").getAttribute("src")).toMatch(
    /^data:image\/svg\+xml/,
  );
  await lagoon.click();
  await expect(page.locator("#slide-count")).toHaveText("1");
  const { p } = await download(page);
  expect(nameOf(themeOf(p, P.getSlides(p)[0]))).toBe("Lagoon");
});

test("the current theme's thumbnail and variants are shown inline, and the tab fits", async ({
  page,
}, info) => {
  await start(page);
  await expect(page.locator("#slide-canvas .slide-image")).toBeVisible();
  await tab(page, "design");
  const ribbon = page.locator(".ribbon-panel:not([hidden])");
  // The deck's own theme is drawn as "Aa", not with the master's sample text.
  const own = (await galleryPanel(page, "Themes")).getByRole("option").first();
  await expect(own).toHaveAttribute("aria-selected", "true");
  const src = decodeURIComponent(await own.locator("img").getAttribute("src"));
  expect(src).toContain(">Aa<");
  expect(src).not.toContain("Master title style");
  await page.keyboard.press("Escape");
  // The ribbon never scrolls sideways; on wider screens the variants show
  // in the ribbon itself.
  const fits = await ribbon.evaluate((p) => p.scrollWidth <= p.clientWidth + 1);
  expect(fits).toBe(true);
  if (info.project.name === "desktop") {
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await expect
        .poll(() => ribbon.evaluate((p) => p.scrollWidth <= p.clientWidth + 1))
        .toBe(true);
      await expect(
        ribbon.getByRole("listbox", { name: "Variants" }).getByRole("option"),
      ).not.toHaveCount(0);
    }
    await page.setViewportSize({ width: 1440, height: 960 });
  }
  // A theme that is not built in has variants of its own colors: the
  // second swaps light and dark.
  await (
    await galleryPanel(page, "Variants")
  )
    .getByRole("option")
    .nth(1)
    .click();
  await expect(page.locator("#save-status")).toContainText("Saved");
  const { files } = await download(page);
  expect(strFromU8(files["ppt/slideMasters/slideMaster1.xml"])).toContain(
    'bg1="dk1"',
  );
  // The Variants gallery's menu holds the theme's colors, fonts, effects
  // and background styles.
  await (
    await galleryPanel(page, "Variants")
  )
    .getByRole("button", { name: "Fonts" })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Customize Fonts…" }),
  ).toBeVisible();
});
