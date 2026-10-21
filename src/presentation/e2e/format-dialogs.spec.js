// The Font, Paragraph, Tabs, Columns, and Bullets and Numbering dialogs and
// the ribbon's bullet and numbering galleries, checked by what they write to
// the downloaded file.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  P,
  addTextBox,
  command,
  download,
  menu,
  start,
} from "./format-helpers.js";

test.setTimeout(90_000);

async function number(dialog, label, value) {
  const input = dialog
    .getByLabel(label, { exact: true })
    .filter({ visible: true });
  await input.fill(String(value));
  await input.press("Tab");
}

test("the Font dialog sets the face, underline, effects and character spacing", async ({
  page,
}) => {
  await start(page);
  await addTextBox(page);
  await menu(page, "Format", "Font…");
  const dialog = page.getByRole("dialog", { name: "Font" });
  await expect(dialog).toBeVisible();
  const face = dialog.locator("#fmt-font-family");
  await face.fill("Georgia");
  await face.press("Tab");
  await dialog.getByLabel("Font style").selectOption("bold-italic");
  await number(dialog, "Size", 32);
  await dialog.getByLabel("Underline style").selectOption("dbl");
  await dialog.getByRole("button", { name: /^Underline color/ }).click();
  await page.getByRole("menuitem", { name: "Red", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Double strikethrough" }).check();
  await dialog.getByRole("checkbox", { name: "Small caps" }).check();
  await dialog.getByRole("checkbox", { name: "Superscript" }).check();
  await number(dialog, "Offset", 20);
  await dialog.getByRole("tab", { name: "Character Spacing" }).click();
  await dialog.getByLabel("Spacing", { exact: true }).selectOption("expanded");
  await number(dialog, "By", 2);
  await dialog.getByRole("checkbox", { name: "Kerning for fonts" }).check();
  await number(dialog, "Points and above", 14);
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(dialog).toBeHidden();
  const { shapes } = await download(page);
  const fmt = P.getShapeRunFormat(shapes[0], 0, 0);
  expect(fmt).toMatchObject({
    font: "Georgia",
    bold: true,
    italic: true,
    size: 32,
    underline: "dbl",
    underlineColor: "#FF0000",
    strike: "dblStrike",
    cap: "small",
    spc: 200,
    kern: 1400,
  });
  expect(fmt.baseline).toBeCloseTo(0.2, 5);
});

test("the Paragraph and Tabs dialogs set alignment, indents, spacing and tab stops", async ({
  page,
}) => {
  await start(page);
  await addTextBox(page);
  await menu(page, "Format", "Paragraph…");
  const dialog = page.getByRole("dialog", { name: "Paragraph" });
  await dialog.getByLabel("Alignment").selectOption("center");
  await number(dialog, "Before text", 0.5);
  await dialog.getByLabel("Special").selectOption("hanging");
  await number(dialog, "By", 0.25);
  await number(dialog, "Before", 6);
  await number(dialog, "After", 12);
  await dialog.getByLabel("Line spacing").selectOption("exactly");
  await number(dialog, "At", 20);
  await dialog.getByRole("button", { name: "Tabs…" }).click();
  const tabs = page.getByRole("dialog", { name: "Tabs" });
  await number(tabs, "Tab stop position", 2);
  await tabs.getByRole("radio", { name: "Right" }).click();
  await tabs.getByRole("button", { name: "Set", exact: true }).click();
  await expect(
    tabs.getByRole("list", { name: "Tab stops" }).getByRole("listitem"),
  ).toHaveCount(1);
  const axe = await new AxeBuilder({ page })
    .include(".format-dialog")
    .analyze();
  expect(axe.violations).toEqual([]);
  await tabs.getByRole("button", { name: "OK" }).click();
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(dialog).toBeHidden();
  const { shapes } = await download(page);
  const s = shapes[0];
  expect(P.getParagraphAlignment(s, 0)).toBe("ctr");
  expect(P.getParagraphLayout(s, 0)).toMatchObject({
    marL: 457200,
    indent: -228600,
    tabs: [{ pos: 1828800, align: "r" }],
  });
  expect(P.getParagraphSpacing(s, 0)).toMatchObject({
    beforePts: 6,
    afterPts: 12,
  });
  expect(P.getParagraphLineSpacing(s, 0)).toEqual({ kind: "pts", value: 20 });
});

test("the bullet gallery, the numbering gallery and the Bullets and Numbering dialog", async ({
  page,
}) => {
  await start(page);
  await addTextBox(page);
  await (await command(page, "bullets")).waitFor();
  await page
    .getByRole("button", { name: "Bullet styles" })
    .filter({ visible: true })
    .click();
  await page.getByRole("menuitemradio", { name: "Check Mark Bullets" }).click();
  let { shapes } = await download(page);
  expect(P.getParagraphBullet(shapes[0], 0)).toEqual({ char: "✓" });

  await page.keyboard.press("Escape");
  await page.locator(".object-hit").first().click();
  if (
    !(await page.getByRole("button", { name: "Numbering styles" }).isVisible())
  )
    await command(page, "numbering");
  await page
    .getByRole("button", { name: "Numbering styles" })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: /^Lowercase Roman numerals/ })
    .click();
  ({ shapes } = await download(page));
  expect(P.getParagraphBullet(shapes[0], 0)).toEqual({
    autoNum: "romanLcPeriod",
  });

  await page.keyboard.press("Escape");
  await page.locator(".object-hit").first().click();
  await menu(page, "Format", "Bullets and Numbering…");
  const dialog = page.getByRole("dialog", { name: "Bullets and Numbering" });
  await dialog.getByRole("tab", { name: "Numbered" }).click();
  await dialog.getByRole("radio", { name: /^Uppercase letters/ }).click();
  await number(dialog, "Start at", 5);
  await number(dialog, "Size (% of text)", 120);
  await dialog
    .getByRole("button", { name: /^Color/ })
    .filter({ visible: true })
    .click();
  await page.getByRole("menuitem", { name: "Blue", exact: true }).click();
  await dialog.getByRole("button", { name: "OK" }).click();
  ({ shapes } = await download(page));
  expect(P.getParagraphBullet(shapes[0], 0)).toEqual({
    autoNum: "alphaUcPeriod",
    startAt: 5,
  });
  expect(P.getParagraphBulletFormat(shapes[0], 0)).toMatchObject({
    color: "#0070C0",
    sizePct: 1.2,
  });
});

test("the Columns dialog splits the text into columns", async ({ page }) => {
  await start(page);
  await addTextBox(page);
  await menu(page, "Format", "Columns…");
  const dialog = page.getByRole("dialog", { name: "Columns" });
  await number(dialog, "Number", 3);
  await number(dialog, "Spacing", 0.5);
  await dialog.getByRole("button", { name: "OK" }).click();
  const { shapes } = await download(page);
  expect(P.getShapeTextColumns(shapes[0])).toEqual({
    count: 3,
    gapEmu: 457200,
  });
});
