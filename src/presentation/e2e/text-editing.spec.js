// Editing text on the canvas: what the keys do to the runs and paragraphs
// of the text being edited.
import { test, expect } from "@playwright/test";
import { installMenuNow, ribbonButton } from "./editor-commands.js";

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
