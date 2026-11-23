// Editing text on the canvas: what the keys do to the runs and paragraphs
// of the text being edited.
import { test, expect } from "@playwright/test";
import {
  installMenuNow,
  ribbonButton,
  paneSection,
} from "./editor-commands.js";

const slideSvg = async (page) =>
  decodeURIComponent(
    await page.locator(".slide-image").first().getAttribute("src"),
  );

const pressKey = async (page, key, times = 1) => {
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
};

// A text box with `text` typed in it, left open for editing.
async function typedBox(page, text) {
  await page.goto("/");
  await installMenuNow(page);
  await page.evaluate(() => window.__addTextNow());
  await page.locator(".object-hit").last().dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  return editor;
}

test("Backspace and Delete join paragraphs with each keeping its formatting", async ({
  page,
}) => {
  const editor = await typedBox(page, "Alpha bold");
  const press = (key, times) => pressKey(page, key, times);
  await page.keyboard.press("Enter");
  await page.keyboard.type("plain");
  await page.keyboard.press("Enter");
  await page.keyboard.type("last");
  // Bold "bold", at the end of the first paragraph.
  await press("ArrowLeft", 11);
  await press("Shift+ArrowLeft", 4);
  await page.keyboard.press("ControlOrMeta+b");
  // Backspace at the start of "plain", then Delete at the end of "plain".
  await press("ArrowRight", 2);
  await page.keyboard.press("Backspace");
  await expect(editor.locator(".para")).toHaveCount(2);
  await expect(editor.locator("[data-run]").last()).toHaveCSS(
    "font-weight",
    "400",
  );
  await press("ArrowRight", 5);
  await page.keyboard.press("Delete");
  await expect(editor.locator(".para")).toHaveCount(1);
  await expect(editor).toHaveText("Alpha boldplainlast");
  await expect(editor.locator("[data-run]").last()).toHaveCSS(
    "font-weight",
    "400",
  );
  // The joined text keeps its run: typed text continues it, unbolded.
  await press("ArrowRight", 4);
  await page.keyboard.type("!");
  await page.keyboard.press("Escape");
  const svg = await slideSvg(page);
  expect(svg).toMatch(/font-weight="700"[^>]*>bold</);
  expect(svg).not.toMatch(/font-weight="700"[^>]*>[^<]*plain/);
  expect(svg).toMatch(/plainlast!</);
  // Undo takes the edit back as one step.
  await page.keyboard.press("ControlOrMeta+z");
  expect(await slideSvg(page)).toContain(">Your text here<");
});

test("typing over a selection across paragraphs keeps the formatting after it", async ({
  page,
}) => {
  const editor = await typedBox(page, "First");
  const press = (key, times) => pressKey(page, key, times);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second");
  await press("Shift+ArrowLeft", 6);
  await page.keyboard.press("ControlOrMeta+i");
  // From "Fi|rst" to "Sec|ond".
  await press("ArrowRight");
  await press("ArrowLeft", 10);
  await press("Shift+ArrowRight", 7);
  await page.keyboard.type("X");
  await expect(editor).toHaveText("FiXond");
  await expect(editor.locator("[data-run]").last()).toHaveCSS(
    "font-style",
    "italic",
  );
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator(".para")).toHaveCount(2);
  await expect(editor).toHaveText("FirstSecond");
});

test("an input method typing over paragraphs keeps the formatting after it", async ({
  page,
}) => {
  const editor = await typedBox(page, "First");
  const press = (key, times) => pressKey(page, key, times);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second");
  await press("Shift+ArrowLeft", 6);
  await page.keyboard.press("ControlOrMeta+i");
  await press("ArrowRight");
  await press("ArrowLeft", 10);
  await press("Shift+ArrowRight", 7);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "に",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await cdp.send("Input.insertText", { text: "日本" });
  await expect(editor).toHaveText("Fi日本ond");
  await expect(editor.locator("[data-run]").last()).toHaveCSS(
    "font-style",
    "italic",
  );
  await expect(editor.locator("[data-run]").first()).toHaveCSS(
    "font-style",
    "normal",
  );
});

test("Change Case while editing changes the selected text, keeping its runs", async ({
  page,
}) => {
  const editor = await typedBox(page, "One two three");
  const press = (key, times) => pressKey(page, key, times);
  // Bold "wo th", then select "two three".
  await press("ArrowLeft", 3);
  await press("Shift+ArrowLeft", 5);
  await page.keyboard.press("ControlOrMeta+b");
  await press("ArrowRight", 4);
  await press("Shift+ArrowLeft", 9);
  await (await ribbonButton(page, "Home", "change-case")).click();
  await page.getByRole("menuitem", { name: "UPPERCASE" }).click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("One TWO THREE");
  await expect(editor.locator("[data-run]", { hasText: "WO TH" })).toHaveCSS(
    "font-weight",
    "700",
  );
  // The text stays selected, and undo in the editor takes the change back.
  expect(await page.evaluate(() => getSelection().toString())).toBe(
    "TWO THREE",
  );
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toHaveText("One two three");
  // With no selection, the word at the caret changes.
  await press("ArrowLeft");
  await press("ArrowRight", 2);
  await (await ribbonButton(page, "Home", "change-case")).click();
  await page.getByRole("menuitem", { name: "Capitalize Each Word" }).click();
  await expect(editor).toHaveText("One Two three");
  await page.keyboard.press("Escape");
  const svg = await slideSvg(page);
  expect(svg).toMatch(/font-weight="700"[^>]*>wo th</);
  expect(svg.replace(/<[^>]+>/g, "")).toContain("One Two three");
});

test("typing over a triple-clicked paragraph leaves the next paragraph alone", async ({
  page,
}) => {
  const editor = await typedBox(page, "First line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Third");
  await editor.locator(".para").nth(1).click({ clickCount: 3 });
  await page.keyboard.type("New");
  await expect(editor.locator(".para")).toHaveText([
    "First line",
    "New",
    "Third",
  ]);
  // The typing over the selection is one step.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator(".para")).toHaveText([
    "First line",
    "Second line",
    "Third",
  ]);
});

test("text in a content placeholder shrinks to its box as it is typed", async ({
  page,
}) => {
  await page.goto("/");
  await installMenuNow(page);
  await page.evaluate(() =>
    window.__menuNow("Insert", "New slide", "Title and Content"),
  );
  await page.locator(".object-hit").nth(1).dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  const size = async () =>
    parseFloat(await editor.evaluate((e) => getComputedStyle(e).fontSize));
  const full = await size();
  // A phone shows the text no smaller than can be read.
  const readable = full > 14;
  for (let i = 0; i < 14; i++) {
    if (i) await page.keyboard.press("Enter");
    await page.keyboard.type(`Point ${i}`);
  }
  // The editor shows the text smaller, without a scroll bar.
  if (readable) {
    expect(await size()).toBeLessThan(full);
    expect(
      await editor.evaluate((e) => e.scrollHeight <= e.clientHeight + 1),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  const sizes = (svg) =>
    [...svg.matchAll(/font-size="([\d.]+)"[^>]*>(?:Point|Just)/g)].map(
      (m) => +m[1],
    );
  const shrunk = sizes(await slideSvg(page));
  expect(shrunk).toHaveLength(14);
  // The body's 28 pt is 37.33 px in the slide's 1280 px picture.
  expect(Math.max(...shrunk)).toBeLessThan(37);
  // Fewer points grow back to full size.
  await page.locator(".object-hit").nth(1).dblclick();
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Just one point");
  if (readable) expect(await size()).toBeCloseTo(full, 0);
  await page.keyboard.press("Escape");
  const grown = sizes(await slideSvg(page));
  expect(grown[0]).toBeGreaterThan(Math.max(...shrunk));
  // Undo brings the shrunk text back.
  await page.keyboard.press("ControlOrMeta+z");
  expect(sizes(await slideSvg(page))).toEqual(shrunk);
});

test("a text box set to resize to fit its text follows the text", async ({
  page,
}) => {
  await page.goto("/");
  await installMenuNow(page);
  await page.evaluate(() => window.__addTextNow());
  const hit = page.locator(".object-hit").last();
  await hit.click();
  const box = await paneSection(page, "textBox");
  await box.getByRole("radio", { name: "Resize shape to fit text" }).click();
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  // Heights measured with the panel closed, at one size of the slide.
  const height = async () => (await hit.boundingBox())?.height ?? 0;
  await expect.poll(height).toBeGreaterThan(0);
  const oneLine = await height();
  await hit.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("One");
  for (const line of ["Two", "Three", "Four"]) {
    await page.keyboard.press("Enter");
    await page.keyboard.type(line);
  }
  // The editor grows with the text, and the box takes its height.
  expect(
    await editor.evaluate((e) => e.scrollHeight <= e.clientHeight + 1),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(height).toBeGreaterThan(oneLine * 3);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(height).toBeCloseTo(oneLine, 0);
});
