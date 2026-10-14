// SmartArt pictures and single-shape formatting: a picture layout's empty
// picture shapes take pictures, a click picks one shape of a selected
// graphic, and the SmartArt Format tab changes it; all saved in the file.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, parseDeck } from "../src/model.js";

test.setTimeout(120_000);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
  "base64",
);

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
}
const panel = (page) => page.locator(".ribbon-panel:not([hidden])");
// A ribbon command by its data-command, from its folded group if need be.
async function ribbonCommand(page, tab, command) {
  await page.getByRole("tab", { name: tab, exact: true }).click();
  const button = panel(page).locator(`[data-command="${command}"]`).first();
  if (!(await button.isVisible())) {
    await panel(page)
      .locator(`.ribbon-group:has([data-command="${command}"]) .ribbon-fold`)
      .click();
    await page
      .locator(`.ribbon-fold-panel [data-command="${command}"]`)
      .first()
      .click();
    return;
  }
  await button.click();
}
// The arrow of a split command (by its menu label), folded or not.
async function ribbonArrow(page, tab, command, label) {
  await page.getByRole("tab", { name: tab, exact: true }).click();
  const arrow = panel(page).getByRole("button", { name: label, exact: true });
  if (!(await arrow.isVisible())) {
    await panel(page)
      .locator(`.ribbon-group:has([data-command="${command}"]) .ribbon-fold`)
      .click();
    await page
      .locator(".ribbon-fold-panel")
      .getByRole("button", { name: label, exact: true })
      .click();
    return;
  }
  await arrow.click();
}
async function download(page) {
  const item = page.getByRole("menuitem", {
    name: "Download PowerPoint (.pptx)",
    exact: true,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page
      .getByRole("menuitem", { name: "File", exact: true })
      .or(page.getByRole("button", { name: "File options" }))
      .filter({ visible: true })
      .click();
    try {
      await item.waitFor({ state: "visible", timeout: 5000 });
      break;
    } catch {}
  }
  const event = page.waitForEvent("download");
  await item.click();
  const pres = await parseDeck(await readFile(await (await event).path()));
  const graphic = P.getSlideShapes(P.getSlides(pres)[0]).find((s) =>
    P.isDiagramShape(s),
  );
  return { pres, graphic, model: graphic && P.getShapeSmartArt(graphic) };
}
async function insertPictureGraphic(page) {
  await ribbonCommand(page, "Insert", "smartart");
  const dialog = page.getByRole("dialog", {
    name: "Choose a SmartArt Graphic",
  });
  await dialog.getByRole("tab", { name: "Picture", exact: true }).click();
  await dialog
    .getByRole("option", { name: "Captioned Pictures", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(page.locator(".smartart-pane")).toBeVisible();
  await page.keyboard.press("Escape");
}

test("an empty picture shape takes a picture that is saved", async ({
  page,
}) => {
  await start(page);
  await insertPictureGraphic(page);
  const buttons = page.locator(".smartart-picture-button");
  await expect(buttons).toHaveCount(3);
  const choose = page.waitForEvent("filechooser");
  await buttons.nth(1).click();
  await (
    await choose
  ).setFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
  await expect(buttons).toHaveCount(2);
  const { pres, graphic, model } = await download(page);
  const picture = model.items[1].format?.pic?.picture;
  expect(picture).toMatch(/^\/ppt\/media\/image\d+\.png$/);
  expect(Buffer.from(P.getSmartArtPictureBytes(graphic, picture))).toEqual(PNG);
  expect(model.items[0].format).toBeUndefined();
  void pres;
});

test("a picked shape is changed from the SmartArt Format tab", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "The contextual ribbon workflow is for wider screens; phones use the canvas buttons above",
  );
  await start(page);
  await insertPictureGraphic(page);
  // Click inside the first picture shape, away from its button.
  const slot = page.locator(".smartart-picture-slot").first();
  const box = await slot.boundingBox();
  await page.mouse.click(box.x + 6, box.y + 6);
  await expect(page.locator(".smartart-part.picked")).toHaveCount(1);
  // Change Shape to an oval, then make it larger.
  await ribbonCommand(page, "SmartArt Format", "smartart-change-shape");
  await page
    .locator(".menu")
    .getByRole("menuitem", { name: "Oval", exact: true })
    .or(
      page.locator(".menu").getByRole("option", { name: "Oval", exact: true }),
    )
    .or(
      page
        .locator(".menu")
        .getByRole("menuitemradio", { name: "Oval", exact: true }),
    )
    .first()
    .click();
  await ribbonCommand(page, "SmartArt Format", "smartart-larger");
  // A fill color for it.
  await ribbonArrow(
    page,
    "SmartArt Format",
    "smartart-shape-fill",
    "Fill colors",
  );
  await page.locator(".menu .palette-swatch").first().click();
  // Pick a caption with Select Shape and give its text a WordArt style.
  await ribbonCommand(page, "SmartArt Format", "smartart-select-shape");
  await page
    .locator(".menu [role^=menuitem]")
    .filter({ hasNotText: "Whole Graphic" })
    .filter({ hasNotText: "Picture" })
    .first()
    .click();
  await expect(page.locator(".smartart-part.picked")).toHaveCount(1);
  await ribbonArrow(
    page,
    "SmartArt Format",
    "smartart-text-fill",
    "Text fill colors",
  );
  await page.locator(".menu .palette-swatch").nth(4).click();
  const { model } = await download(page);
  const pic = model.items[0].format?.pic;
  expect(pic.geom).toBe("ellipse");
  expect(pic.scale).toBeCloseTo(1.1, 2);
  expect(pic.fill).toBeTruthy();
  expect(model.items.some((i) => i.textStyle?.fill)).toBe(true);
});
