// Arrange and Edit commands: the Selection Pane (rename, hide all, reorder),
// rotation and the Size and Rotation dialog, Regroup, aligning to the slide,
// Replace Fonts, Paste Special, Repeat, and the Format Object shortcut.
import { test, expect } from "@playwright/test";
import {
  P,
  addShape,
  addTextBox,
  command,
  download,
  menu,
  mod,
  start,
  tab,
} from "./format-helpers.js";

test.setTimeout(120_000);

const objects = (page) => page.locator(".object-hit");

async function selectAll(page) {
  await menu(page, "Edit", "Select all");
}

test("the Selection Pane renames, hides and shows all, and reorders", async ({
  page,
}) => {
  await start(page);
  await addShape(page, "Rectangle");
  await addShape(page, "Circle");
  await tab(page, "Shape Format");
  await (await command(page, "selection-pane")).click();
  const pane = page.getByRole("complementary", { name: "Selection" });
  const names = pane.locator(".selection-name");
  await expect(names).toHaveText([/^Circle/, /^Rectangle/]);
  await names.first().focus();
  await page.keyboard.press("F2");
  const rename = pane.getByRole("textbox");
  await rename.fill("Sun");
  await rename.press("Enter");
  await expect(names.first()).toHaveText("Sun");
  await pane.getByRole("button", { name: "Hide All" }).click();
  await expect(pane.locator("li.hidden-object")).toHaveCount(2);
  await pane.getByRole("button", { name: "Show All" }).click();
  await expect(pane.locator("li.hidden-object")).toHaveCount(0);
  await names.nth(1).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(names).toHaveText([/^Rectangle/, "Sun"]);
  const { shapes } = await download(page);
  expect(shapes.map((s) => P.getShapeName(s))).toEqual([
    "Sun",
    expect.stringMatching(/^Rectangle/),
  ]);
  expect(shapes.some((s) => P.isShapeHidden(s))).toBe(false);
});

test("rotate, the Size and Rotation dialog, Regroup and aligning to the slide", async ({
  page,
}) => {
  await start(page);
  await addShape(page, "Rectangle");
  await tab(page, "Shape Format");
  await (await command(page, "rotate")).click();
  await page.getByRole("menuitem", { name: "Rotate Right 90°" }).click();
  await (await command(page, "rotate")).click();
  await page.getByRole("menuitem", { name: "More Rotation Options…" }).click();
  const dialog = page.getByRole("dialog", { name: "Size and Rotation" });
  await expect(dialog.getByLabel("Rotation", { exact: true })).toHaveValue(
    "90",
  );
  await dialog.getByRole("checkbox", { name: "Lock aspect ratio" }).check();
  const width = dialog.getByLabel("Width", { exact: true });
  await width.fill("1.5");
  await width.press("Tab");
  await expect(dialog.getByLabel("Height", { exact: true })).toHaveValue("1");
  const rotation = dialog.getByLabel("Rotation", { exact: true });
  await rotation.fill("45");
  await rotation.press("Tab");
  await dialog.getByRole("button", { name: "OK" }).click();
  let { shapes } = await download(page);
  expect(P.getShapeRotation(shapes[0])).toBe(45);
  expect(P.getShapeAspectLock(shapes[0])).toBe(true);
  expect(P.getShapeBounds(shapes[0]).w).toBe(1371600);

  await addShape(page, "Circle");
  await selectAll(page);
  const chosen = page.locator(".object-hit.selected");
  await page.keyboard.press(`${mod}+Alt+g`);
  await expect(chosen).toHaveCount(1);
  await page.keyboard.press(`${mod}+Alt+Shift+g`);
  await expect(chosen).toHaveCount(2);
  await page.locator("#slide-canvas").click({ position: { x: 4, y: 4 } });
  await expect(chosen).toHaveCount(0);
  await page.keyboard.press(`${mod}+Alt+j`);
  await expect(chosen).toHaveCount(1);
  ({ shapes } = await download(page));
  const group = shapes.find((s) => P.getShapeKind(s) === "group");
  expect(P.getGroupChildren(group)).toHaveLength(2);

  await page.keyboard.press(`${mod}+Alt+Shift+g`);
  await expect(chosen).toHaveCount(2);
  await selectAll(page);
  await tab(page, "Shape Format");
  await (await command(page, "align")).click();
  await page.getByRole("menuitemcheckbox", { name: "Align to Slide" }).click();
  await (await command(page, "align")).click();
  await page.getByRole("menuitem", { name: "Align Top" }).click();
  ({ shapes } = await download(page));
  const tops = shapes
    .filter((s) => P.getShapeKind(s) === "shape")
    .map((s) => {
      const b = P.getShapeBounds(s);
      const r = P.getShapeRotation(s) || 0;
      // The turned rectangle's top is where its box shows on the slide.
      return r === 45 ? Math.round(b.y + b.h / 2) : b.y;
    });
  expect(Math.min(...tops)).toBeLessThan(400000);
});

test("Replace Fonts, Paste Special as a picture, Repeat, and Format Object", async ({
  page,
}) => {
  await start(page);
  await addTextBox(page);
  await menu(page, "Format", "Font…");
  const font = page.getByRole("dialog", { name: "Font" });
  await font.locator("#fmt-font-family").fill("Georgia");
  await font.locator("#fmt-font-family").press("Tab");
  await font.getByRole("button", { name: "OK" }).click();
  await menu(page, "Format", "Replace Fonts…");
  const replace = page.getByRole("dialog", { name: "Replace Fonts" });
  await replace.getByLabel("Replace").selectOption("Georgia");
  await replace.getByLabel("With").fill("Verdana");
  await replace.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Verdana");
  let { shapes } = await download(page);
  expect(P.getShapeRunFormat(shapes[0], 0, 0).font).toBe("Verdana");

  // Paste Special: the copied object comes back as a picture of itself.
  await page.keyboard.press("Escape");
  await addShape(page, "Circle");
  await page.keyboard.press(`${mod}+c`);
  await menu(page, "Edit", "Paste Special…");
  const paste = page.getByRole("dialog", { name: "Paste Special" });
  await paste.getByRole("radio", { name: "Picture (PNG)" }).check();
  await paste.getByRole("button", { name: "Paste" }).click();
  await expect(objects(page)).toHaveCount(3);
  ({ shapes } = await download(page));
  expect(shapes.filter((s) => P.getShapeKind(s) === "picture")).toHaveLength(1);

  // Repeat: Change Shape on one shape, then Ctrl/⌘+Y on another.
  await selectAll(page);
  await page.keyboard.press("Delete");
  await expect(objects(page)).toHaveCount(0);
  await addShape(page, "Rectangle");
  await addShape(page, "Circle");
  await tab(page, "Shape Format");
  await (await command(page, "change-shape")).click();
  await page.getByRole("menuitem", { name: "Change Shape" }).click();
  await page.getByRole("menuitemradio", { name: "Heart", exact: true }).click();
  await (await command(page, "selection-pane")).click();
  const pane = page.getByRole("complementary", { name: "Selection" });
  await pane.getByRole("button", { name: /^Rectangle/ }).click();
  await page.keyboard.press(`${mod}+y`);
  await expect
    .poll(
      async () =>
        (await download(page)).shapes.filter(
          (s) => P.getShapePreset(s) === "heart",
        ).length,
    )
    .toBe(2);

  // Format Object opens the pane.
  await page.keyboard.press("Escape");
  await objects(page).first().click({ force: true });
  await page.keyboard.press(`${mod}+Shift+Digit1`);
  await expect(
    page.getByRole("complementary", { name: "Format panel" }),
  ).toBeVisible();
});
