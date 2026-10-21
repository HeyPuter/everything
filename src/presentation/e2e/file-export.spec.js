// File > Export, Print, Properties, Compress Pictures, File size, Open
// recent and Save as template, end to end through real files.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { deflateSync, crc32 } from "node:zlib";
import { strFromU8, unzipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";

test.setTimeout(120_000);

function storyDeck() {
  const deck = createDeck("story");
  const slides = P.getSlides(deck);
  P.setSlideNotes(slides[0], "Open with the question.");
  P.setSlideHidden(slides[3], true);
  for (const s of slides)
    P.setSlideTransition(s, { effect: "fade", speed: "fast" });
  return deck;
}

async function mock(page, { signedIn = false, files = [] } = {}) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: `window.puter={env:"web",auth:{isSignedIn:async()=>${signedIn},getUser:async()=>({username:"tester",uuid:"u1"})},fs:{readdir:async()=>${JSON.stringify(files)},write:async(path,blob)=>({path,name:path.split('/').pop(),modified:Date.now()/1000})},ui:{onLaunchedWithItems:()=>{}}};`,
    }),
  );
}
async function start(page, deck = storyDeck(), options) {
  await mock(page, options);
  await page.goto("/#/home");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Export test.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(deck)),
  });
  await expect(page.locator("#slide-count")).toHaveText(
    String(P.getSlides(deck).length),
  );
}
async function fileMenu(page, ...path) {
  const bar = page.getByRole("menuitem", { name: "File", exact: true });
  if (await bar.isVisible()) await bar.click();
  else await page.getByRole("button", { name: "File options" }).click();
  for (const item of path)
    await page.getByRole("menuitem", { name: item, exact: true }).click();
}
async function downloadVia(page, ...path) {
  const event = page.waitForEvent("download");
  await fileMenu(page, ...path);
  const download = await event;
  return {
    name: download.suggestedFilename(),
    bytes: await readFile(await download.path()),
  };
}
async function exportAs(page, format, configure = async () => {}) {
  await fileMenu(page, "Export…");
  const dialog = page.getByRole("dialog", { name: "Export" });
  await dialog.getByRole("radio", { name: format, exact: true }).check();
  await configure(dialog);
  const event = page.waitForEvent("download", { timeout: 90_000 });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const download = await event;
  await expect(dialog).toHaveCount(0);
  return {
    name: download.suggestedFilename(),
    bytes: await readFile(await download.path()),
  };
}
const latin = (bytes) => Buffer.from(bytes).toString("latin1");
const mediaBoxes = (pdf) =>
  [...latin(pdf).matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);

function png(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width * 3; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[row + 1 + x] = (x * 7 + y * 3 + (seed >> 24)) & 255;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const pngSize = (bytes) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

test("exports a PDF of the visible slides, at the slide's size, with bookmarks", async ({
  page,
}) => {
  await start(page);
  const { name, bytes } = await exportAs(page, "PDF document");
  expect(name).toBe("Export test.pdf");
  const text = latin(bytes);
  expect(text.startsWith("%PDF-1.4")).toBe(true);
  // Five slides, one hidden.
  expect(mediaBoxes(bytes)).toEqual(Array(4).fill([960, 540]));
  expect(text).toContain("/Type /Outlines");
  expect(text).toContain("/Filter /DCTDecode");
});

test("takes a typed extension as the file's own, not part of its name", async ({
  page,
}) => {
  await start(page);
  const named = (name) => async (dialog) =>
    dialog.getByRole("textbox", { name: "File name" }).fill(name);
  const pdf = await exportAs(page, "PDF document", named("Q3 review.PDF"));
  expect(pdf.name).toBe("Q3 review.pdf");
  const jpeg = await exportAs(page, "JPEG pictures", async (dialog) => {
    await named("Cover.jpeg")(dialog);
    await dialog.getByRole("radio", { name: "Current slide" }).check();
  });
  expect(jpeg.name).toBe("Cover - Slide 1.jpg");
  const template = await exportAs(
    page,
    "Template (.potx)",
    named("Brand.potx"),
  );
  expect(template.name).toBe("Brand.potx");
  // A name that only looks like it has an extension keeps it.
  const kept = await exportAs(page, "PDF document", named("Version 2.5"));
  expect(kept.name).toBe("Version 2.5.pdf");
});

test("exports handouts and notes pages as PDF on paper", async ({ page }) => {
  await start(page);
  const handouts = await exportAs(page, "PDF document", async (dialog) => {
    await dialog
      .getByRole("combobox", { name: "Layout" })
      .selectOption("handouts");
    await dialog
      .getByRole("combobox", { name: "Slides per page" })
      .selectOption("6");
    await dialog
      .getByRole("combobox", { name: "Page size" })
      .selectOption("letter");
    await dialog
      .getByRole("checkbox", { name: "Include hidden slides" })
      .check();
  });
  expect(mediaBoxes(handouts.bytes)).toEqual([[612, 792]]);
  // Five slides drawn once each.
  expect(latin(handouts.bytes).match(/\/Subtype \/Image/g)).toHaveLength(5);

  const notes = await exportAs(page, "PDF document", async (dialog) => {
    await dialog
      .getByRole("combobox", { name: "Layout" })
      .selectOption("notes");
    await dialog
      .getByRole("combobox", { name: "Page size" })
      .selectOption("a4");
    await dialog.getByRole("radio", { name: "Current slide" }).check();
  });
  expect(mediaBoxes(notes.bytes)).toEqual([[595.28, 841.89]]);
  expect(latin(notes.bytes)).toContain("/BaseFont /Helvetica");
});

test("exports slides as PNG pictures in a ZIP and the current slide as JPEG", async ({
  page,
}) => {
  await start(page);
  const zip = await exportAs(page, "PNG pictures", async (dialog) => {
    await dialog.getByRole("combobox", { name: "Size" }).selectOption("1280");
  });
  expect(zip.name).toBe("Export test - slides.zip");
  const files = unzipSync(zip.bytes);
  expect(Object.keys(files)).toEqual([
    "Export test - Slide 1.png",
    "Export test - Slide 2.png",
    "Export test - Slide 3.png",
    "Export test - Slide 5.png",
  ]);
  expect(pngSize(Buffer.from(files["Export test - Slide 1.png"]))).toEqual([
    1280, 720,
  ]);
  const jpeg = await exportAs(page, "JPEG pictures", async (dialog) => {
    await dialog.getByRole("radio", { name: "Current slide" }).check();
  });
  expect(jpeg.name).toBe("Export test - Slide 1.jpg");
  expect([...jpeg.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
});

test("exports the show as a WebM video that plays for the show's length", async ({
  page,
}) => {
  await start(page);
  const { name, bytes } = await exportAs(
    page,
    "Video (MP4 or WebM)",
    async (dialog) => {
      await dialog
        .getByRole("combobox", { name: "File type" })
        .selectOption("webm");
      await dialog
        .getByRole("combobox", { name: "Resolution" })
        .selectOption("720");
      await dialog
        .getByRole("spinbutton", { name: "Seconds on each slide" })
        .fill("1");
    },
  );
  expect(name).toBe("Export test.webm");
  expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  const played = await page.evaluate(async (base64) => {
    const video = document.createElement("video");
    video.muted = true;
    video.src = `data:video/webm;base64,${base64}`;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("cannot load"));
    });
    return {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    };
  }, bytes.toString("base64"));
  // Four visible slides of a second each, and three half-second fades.
  expect(played.width).toBe(1280);
  expect(played.height).toBe(720);
  expect(played.duration).toBeGreaterThan(5.2);
  expect(played.duration).toBeLessThan(5.8);
});

test("exports an MP4 where the browser can encode H.264", async ({ page }) => {
  await start(page);
  const supported = await page.evaluate(async () => {
    if (typeof VideoEncoder === "undefined") return false;
    const { supported } = await VideoEncoder.isConfigSupported({
      codec: "avc1.64001f",
      width: 1280,
      height: 720,
      avc: { format: "avc" },
    });
    return supported;
  });
  test.skip(!supported, "This browser build has no H.264 encoder.");
  const { name, bytes } = await exportAs(
    page,
    "Video (MP4 or WebM)",
    async (dialog) => {
      await dialog
        .getByRole("combobox", { name: "File type" })
        .selectOption("mp4");
      await dialog
        .getByRole("combobox", { name: "Resolution" })
        .selectOption("720");
      await dialog
        .getByRole("spinbutton", { name: "Seconds on each slide" })
        .fill("1");
    },
  );
  expect(name).toBe("Export test.mp4");
  expect(latin(bytes.subarray(4, 8))).toBe("ftyp");
  expect(latin(bytes)).toContain("avcC");
});

test("exports an animated GIF and an outline", async ({ page }) => {
  await start(page);
  const gif = await exportAs(page, "Animated GIF", async (dialog) => {
    await dialog.getByRole("combobox", { name: "Size" }).selectOption("480");
    await dialog
      .getByRole("spinbutton", { name: "Seconds on each slide" })
      .fill("1");
    await dialog
      .getByRole("combobox", { name: "Frames a second in transitions" })
      .selectOption("8");
  });
  expect(gif.name).toBe("Export test.gif");
  expect(latin(gif.bytes.subarray(0, 6))).toBe("GIF89a");
  expect(gif.bytes.readUInt16LE(6)).toBe(480);
  expect(gif.bytes.readUInt16LE(8)).toBe(270);
  expect(latin(gif.bytes)).toContain("NETSCAPE2.0");

  const rtf = await exportAs(page, "Outline (RTF or text)");
  expect(rtf.name).toBe("Export test.rtf");
  const outline = latin(rtf.bytes);
  expect(outline.startsWith("{\\rtf1")).toBe(true);
  expect(outline).toContain("big ideas.");
  const txt = await exportAs(page, "Outline (RTF or text)", async (dialog) => {
    await dialog
      .getByRole("combobox", { name: "File type" })
      .selectOption("txt");
  });
  expect(txt.name).toBe("Export test.txt");
  expect(txt.bytes.toString("utf8")).toContain("Where we are today.");
});

test("stops an export when asked", async ({ page }) => {
  await start(page);
  await fileMenu(page, "Export…");
  const dialog = page.getByRole("dialog", { name: "Export" });
  await dialog.getByRole("radio", { name: "Video (MP4 or WebM)" }).check();
  await dialog
    .getByRole("combobox", { name: "File type" })
    .selectOption("webm");
  await dialog
    .getByRole("spinbutton", { name: "Seconds on each slide" })
    .fill("600");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog.getByRole("progressbar")).toBeVisible();
  await dialog.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator("#toast")).toHaveText("Export stopped.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(dialog.getByRole("progressbar")).toBeHidden();
});

test("saves a template whose main part is a template", async ({ page }) => {
  await start(page);
  const template = await downloadVia(page, "Save as template…");
  expect(template.name).toBe("Export test.potx");
  const files = unzipSync(template.bytes);
  expect(strFromU8(files["[Content_Types].xml"])).toContain(
    "presentationml.template.main+xml",
  );
});

test("previews and prints handouts, notes pages and slides", async ({
  page,
}, info) => {
  await start(page);
  await page.evaluate(() => {
    window.__prints = [];
    window.print = () =>
      window.__prints.push({
        pages: document.querySelectorAll("#print-slides .export-page").length,
        slides: document.querySelectorAll("#print-slides img").length,
        filter: document.querySelector("#print-slides img")?.style.filter,
        texts: [
          ...document.querySelectorAll("#print-slides .export-page-text"),
        ].map((t) => t.textContent),
      });
  });
  if (info.project.name === "desktop") await page.keyboard.press("Control+p");
  else await fileMenu(page, "Print…");
  const dialog = page.getByRole("dialog", { name: "Print" });
  await expect(
    dialog.getByRole("status").filter({ hasText: "Page" }),
  ).toHaveText("Page 1 of 4");
  await dialog
    .getByRole("combobox", { name: "Layout" })
    .selectOption("handouts");
  await dialog
    .getByRole("combobox", { name: "Slides per page" })
    .selectOption("3");
  await dialog.getByRole("combobox", { name: "Paper" }).selectOption("letter");
  await dialog.getByRole("checkbox", { name: "Print hidden slides" }).check();
  await dialog
    .getByRole("combobox", { name: "Output" })
    .selectOption("grayscale");
  await dialog.getByRole("textbox", { name: "Header" }).fill("Team review");
  await expect(
    dialog.getByRole("status").filter({ hasText: "Page" }),
  ).toHaveText("Page 1 of 2");
  await expect(dialog.locator(".print-sheet img")).toHaveCount(3);
  await dialog.getByRole("button", { name: "Next page" }).click();
  await expect(dialog.locator(".print-sheet img")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Print", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__prints.length)).toBe(1);
  const printed = await page.evaluate(() => window.__prints[0]);
  expect(printed).toMatchObject({
    pages: 2,
    slides: 5,
    filter: "grayscale(1)",
  });
  expect(printed.texts).toContain("Team review");

  // The settings are kept for the next print.
  await fileMenu(page, "Print…");
  await expect(dialog.getByRole("combobox", { name: "Layout" })).toHaveValue(
    "handouts",
  );
  await dialog.getByRole("combobox", { name: "Layout" }).selectOption("notes");
  await dialog.getByRole("radio", { name: "Slide numbers" }).check();
  await dialog
    .getByRole("textbox", { name: "Slide numbers to print" })
    .fill("1");
  await expect(
    dialog.getByRole("status").filter({ hasText: "Page" }),
  ).toHaveText("Page 1 of 1");
  await dialog.getByRole("button", { name: "Print", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__prints.length)).toBe(2);
  const notes = await page.evaluate(() => window.__prints[1]);
  expect(notes.pages).toBe(1);
  expect(notes.texts).toContain("Open with the question.");
});

test("prints letter-size handouts at the paper's size", async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    window.print = () => (window.__printed = true);
    const timeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) =>
      window.__printed && delay === 1000
        ? 0
        : timeout(callback, delay, ...args);
  });
  await fileMenu(page, "Print…");
  const dialog = page.getByRole("dialog", { name: "Print" });
  await dialog
    .getByRole("combobox", { name: "Layout" })
    .selectOption("handouts");
  await dialog.getByRole("combobox", { name: "Paper" }).selectOption("letter");
  await dialog
    .getByRole("combobox", { name: "Slides per page" })
    .selectOption("4");
  await dialog.getByRole("button", { name: "Print", exact: true }).click();
  await page.waitForFunction(() => window.__printed);
  const pdf = await page.pdf({ preferCSSPageSize: true });
  const pages = mediaBoxes(pdf);
  expect(pages).toHaveLength(1);
  expect(pages[0][0]).toBeCloseTo(612, 0);
  expect(pages[0][1]).toBeCloseTo(792, 0);
});

test("saves document properties and statistics in the file", async ({
  page,
}) => {
  await start(page);
  await fileMenu(page, "Properties");
  const dialog = page.getByRole("dialog", { name: "Properties" });
  await expect(dialog.getByText("Hidden slides")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Title" }).fill("Quarterly review");
  await dialog.getByRole("textbox", { name: "Author" }).fill("Ada Lovelace");
  await dialog.getByRole("textbox", { name: "Keywords" }).fill("q3, budget");
  await dialog.getByRole("textbox", { name: "Company" }).fill("Example Co");
  await dialog.getByRole("textbox", { name: "Comments" }).fill("For the board");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toHaveText("Properties saved.");
  const { bytes } = await downloadVia(page, "Download PowerPoint (.pptx)");
  const deck = await parseDeck(bytes);
  expect(P.getCoreProperties(deck)).toMatchObject({
    title: "Quarterly review",
    creator: "Ada Lovelace",
    keywords: "q3, budget",
    description: "For the board",
  });
  expect(P.getExtendedProperties(deck).company).toBe("Example Co");
  expect(P.getExtendedStatistics(deck)).toMatchObject({
    slides: 5,
    hiddenSlides: 1,
    notes: 1,
  });
  // Undo takes the properties back.
  await page.keyboard.press("Control+z");
  await fileMenu(page, "Properties");
  await expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("");
});

test("compresses pictures, deleting cropped areas, and undo restores them", async ({
  page,
}) => {
  const deck = createDeck("blank");
  const [s] = P.getSlides(deck);
  const big = P.addSlideImage(s, png(1600, 1200), {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(2),
    h: P.inches(1.5),
  });
  const cropped = P.addSlideImage(s, png(1000, 1000), {
    x: P.inches(5),
    y: P.inches(1),
    w: P.inches(2),
    h: P.inches(2),
  });
  P.setShapeImageCrop(cropped, { left: 0.5 });
  await start(page, deck);
  const before = P.getMediaParts(deck).map((m) => m.data.byteLength);

  await fileMenu(page, "File size…");
  const sizes = page.getByRole("dialog", { name: "File size" });
  await expect(sizes.getByRole("row")).toHaveCount(3);
  await sizes.getByRole("button", { name: "Compress pictures…" }).click();
  const dialog = page.getByRole("dialog", { name: "Compress pictures" });
  await expect(
    dialog.getByRole("radio", { name: /Selected pictures/ }),
  ).toBeDisabled();
  await dialog.getByRole("radio", { name: /^96 ppi/ }).check();
  await dialog.getByRole("button", { name: "Compress", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Compressed 2 pictures");

  const { bytes } = await downloadVia(page, "Download PowerPoint (.pptx)");
  const out = await parseDeck(bytes);
  const pictures = P.getSlideShapes(P.getSlides(out)[0]).filter(
    (shape) => P.getShapeKind(shape) === "picture",
  );
  const [a, b] = pictures.map((p) => Buffer.from(P.getShapeImageBytes(p)));
  // 2 inches at 96 ppi. The cropped picture keeps only its right half,
  // which its square frame stretches to twice its width.
  expect(pngSize(a)).toEqual([192, 144]);
  expect(pngSize(b)).toEqual([192, 384]);
  expect(P.getShapeImageCrop(pictures[1])).toBeNull();
  expect(a.length + b.length).toBeLessThan(before[0] + before[1]);

  await page.keyboard.press("Control+z");
  const restored = await parseDeck(
    (await downloadVia(page, "Download PowerPoint (.pptx)")).bytes,
  );
  const again = P.getSlideShapes(P.getSlides(restored)[0]).filter(
    (shape) => P.getShapeKind(shape) === "picture",
  );
  expect(pngSize(Buffer.from(P.getShapeImageBytes(again[0])))).toEqual([
    1600, 1200,
  ]);
  expect(P.getShapeImageCrop(again[1])).toMatchObject({ left: 0.5 });
});

test("opens recent presentations and closes back to the library", async ({
  page,
}) => {
  const now = Date.now() / 1000;
  await start(page, storyDeck(), {
    signedIn: true,
    files: [
      {
        path: "/tester/AppData/Presentations/Budget.pptx",
        name: "Budget.pptx",
        modified: now - 60,
      },
      {
        path: "/tester/AppData/Presentations/Roadmap.pptx",
        name: "Roadmap.pptx",
        modified: now,
      },
    ],
  });
  await fileMenu(page, "Open recent");
  const items = page
    .getByRole("menu", { name: "Open recent" })
    .getByRole("menuitem");
  await expect(items.first()).toContainText("Roadmap");
  await expect(items.nth(1)).toContainText("Budget");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await fileMenu(page, "Close");
  await expect(
    page.getByRole("button", { name: "New presentation", exact: true }),
  ).toBeVisible();
});
