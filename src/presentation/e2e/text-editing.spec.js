// Editing text on the canvas: what the keys do to the runs and paragraphs
// of the text being edited.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { P } from "../src/model.js";
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

// Opens a presentation's bytes as an imported file.
async function importDeck(page, bytes, name = "Deck.pptx") {
  await page.goto("/#/home");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(bytes),
  });
}

// The first slide's XML in the presentation as downloaded.
async function downloadedSlide(page) {
  await page
    .getByRole("menuitem", { name: "File", exact: true })
    .or(page.getByRole("button", { name: "File options" }))
    .filter({ visible: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const files = unzipSync(await readFile(await (await download).path()));
  return strFromU8(files["ppt/slides/slide1.xml"]);
}

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

test("a click in the text after using the ribbon puts the caret there", async ({
  page,
}) => {
  const editor = await typedBox(page, "One two three");
  await pressKey(page, "Shift+ArrowLeft", 5);
  // A ribbon tab takes the focus and leaves the editor waiting.
  await page.getByRole("tab", { name: "Insert", exact: true }).click();
  await expect(editor).toBeVisible();
  const box = await editor.locator("[data-run]").first().boundingBox();
  await page.mouse.click(box.x + 1, box.y + box.height / 2);
  await expect(editor).toBeFocused();
  await page.keyboard.type("X");
  // The text is typed where clicked; "three", selected before, stays.
  await expect(editor).toHaveText("XOne two three");
});

test("Format Painter carries the formatting of selected text to other text", async ({
  page,
}) => {
  const editor = await typedBox(page, "one two three");
  const press = (key, times) => pressKey(page, key, times);
  // Bold and italicize "three", and pick it up with the brush.
  await press("Shift+ArrowLeft", 5);
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.press("ControlOrMeta+i");
  await (await ribbonButton(page, "Home", "format-painter")).click();
  // A click with the brush paints the word clicked.
  const first = editor.locator("[data-run]").first();
  const box = await first.boundingBox();
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await expect(
    editor.locator("[data-run]", { hasText: /^One$/ }).first(),
  ).toHaveCSS("font-weight", "700");
  await expect(editor.locator("[data-run]", { hasText: "two" })).toHaveCSS(
    "font-weight",
    "400",
  );
  // From the keyboard: copy the formatting of "one", paste it on "two".
  await page.keyboard.press("ControlOrMeta+Shift+c");
  await press("ArrowRight", 5);
  await page.keyboard.press("ControlOrMeta+Shift+v");
  await expect(editor.locator("[data-run]", { hasText: "two" })).toHaveCSS(
    "font-style",
    "italic",
  );
  await page.keyboard.press("Escape");
  expect(await slideSvg(page)).toMatch(/font-weight="700"[^>]*>two</);
});

test("Find and Replace reach the speaker notes", async ({ page }) => {
  const editor = await typedBox(page, "Say hello");
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  const notes = page.locator("#speaker-notes");
  test.skip(!(await notes.isVisible()), "the phone layout hides the notes");
  await notes.fill("First hello\nThen HELLO again");
  await notes.blur();
  await page.keyboard.press("ControlOrMeta+f");
  const bar = page.getByRole("search", { name: "Find and replace" });
  const query = bar.getByRole("searchbox", { name: "Find" });
  await query.fill("hello");
  const count = bar.locator(".find-count");
  await expect(count).toHaveText("1 of 3");
  // The next match is in the notes, where it is selected.
  await bar.getByRole("button", { name: "Next match" }).click();
  await expect(count).toHaveText("2 of 3");
  await expect(page.locator(".object-hit.selected")).toHaveCount(0);
  expect(
    await notes.evaluate((n) =>
      n.value.slice(n.selectionStart, n.selectionEnd),
    ),
  ).toBe("hello");
  // Replace all reaches them too, as one undo step.
  await bar.getByRole("textbox", { name: "Replace with" }).fill("hi");
  await bar.getByRole("button", { name: "Replace all" }).click();
  await expect(count).toHaveText("No matches");
  await expect(notes).toHaveValue("First hi\nThen hi again");
  expect(await slideSvg(page)).toContain(">Say hi<");
  await page.locator("#slide-canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(notes).toHaveValue("First hello\nThen HELLO again");
  expect(await slideSvg(page)).toContain(">Say hello<");
});

test("an ordinal AutoCorrect raises is saved raised by a third", async ({
  page,
}) => {
  await typedBox(page, "The 1st ");
  await page.keyboard.type("place");
  await page.keyboard.press("Escape");
  const xml = await downloadedSlide(page);
  expect(xml).toMatch(/baseline="30000"[^>]*>(?:(?!<\/a:r>).)*<a:t>st<\/a:t>/);
  expect(xml).not.toMatch(/baseline="\d{6,}"/);
});

test("raised text shows raised while it is edited", async ({ page }) => {
  const editor = await typedBox(page, "E = mc2");
  await page.keyboard.press("Shift+ArrowLeft");
  await (await ribbonButton(page, "Home", "superscript")).click();
  const raised = editor.locator("[data-run]", { hasText: /^2$/ });
  await expect(raised).toHaveCSS("vertical-align", "super");
  const size = (loc) =>
    loc.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  const base = await size(editor.locator("[data-run]").first());
  expect(await size(raised)).toBeLessThan(base * 0.7);
});

test("list paragraphs show the numbers and bullets the slide shows while edited", async ({
  page,
}) => {
  const pres = P.createPresentation();
  const box = P.addSlideTextBox(P.addBlankSlide(pres), {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(8),
    h: P.inches(3),
    text: "Third\nFourth\nAside\nFifth",
  });
  for (const i of [0, 1, 3])
    P.setParagraphBullet(box, i, { autoNum: "romanUcPeriod", startAt: 3 });
  P.setParagraphLevel(box, 2, 1);
  P.setParagraphBullet(box, 2, { char: "–" });
  await importDeck(page, await P.savePresentation(pres), "Lists.pptx");
  await page.locator(".object-hit").dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  const markers = () =>
    editor
      .locator(".para")
      .evaluateAll((list) => list.map((p) => p.dataset.marker ?? null));
  // The deeper bullet leaves the count going.
  expect(await markers()).toEqual(["III.", "IV.", "–", "V."]);
  // A paragraph added after the first takes the next number.
  // The editor opens with everything selected: to the start, then past
  // "Third".
  await page.keyboard.press("ArrowLeft");
  await pressKey(page, "ArrowRight", 5);
  await page.keyboard.press("Enter");
  await page.keyboard.type("New");
  await expect.poll(markers).toEqual(["III.", "IV.", "V.", "–", "VI."]);
});

test("right-to-left and vertical text are edited the way they read", async ({
  page,
}) => {
  const pres = P.createPresentation();
  const slide = P.addBlankSlide(pres);
  P.addSlideTextBox(slide, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(6),
    h: P.inches(1),
    text: "RIGHT-TO-LEFT",
  });
  const vertical = P.addSlideTextBox(slide, {
    x: P.inches(8),
    y: P.inches(1),
    w: P.inches(1),
    h: P.inches(4),
    text: "Down the box",
  });
  P.setShapeTextDirection(vertical, "vert");
  const files = unzipSync(await P.savePresentation(pres));
  const name = Object.keys(files).find((n) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(n),
  );
  files[name] = strToU8(
    strFromU8(files[name]).replace(
      /<a:p><a:r><a:rPr lang="en-US"\/><a:t>RIGHT-TO-LEFT<\/a:t><\/a:r><\/a:p>/,
      '<a:p><a:pPr algn="r" rtl="1"/><a:r><a:rPr lang="he-IL"/><a:t>גרסה 2 של Office.</a:t></a:r></a:p>',
    ),
  );
  await importDeck(page, zipSync(files));
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await page.locator(".object-hit").first().dblclick();
  await expect(editor).toBeFocused();
  await expect(editor.locator(".para")).toHaveAttribute("dir", "rtl");
  await page.keyboard.press("Escape");
  await page.locator(".object-hit").last().dblclick();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveCSS("writing-mode", "vertical-rl");
});

test("Find whole words only skips the word inside longer words", async ({
  page,
}) => {
  const editor = await typedBox(page, "A cat, a catalog and a cat.");
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+f");
  const bar = page.getByRole("search", { name: "Find and replace" });
  await bar.getByRole("searchbox", { name: "Find" }).fill("cat");
  const count = bar.locator(".find-count");
  await expect(count).toHaveText("1 of 3");
  const words = bar.getByRole("button", { name: "Find whole words only" });
  await words.click();
  await expect(words).toHaveAttribute("aria-pressed", "true");
  await expect(count).toHaveText("1 of 2");
  await bar.getByRole("textbox", { name: "Replace with" }).fill("dog");
  await bar.getByRole("button", { name: "Replace all" }).click();
  await expect(count).toHaveText("No matches");
  expect(await slideSvg(page)).toContain(">A dog, a catalog and a dog.<");
});
