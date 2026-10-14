import { createDateDeck } from "../tests/date-field-fixture.js";
import { createSlideRelationshipDeck } from "../tests/slide-relationship-fixture.js";
import { createNumberedDeck } from "../tests/slide-number-fixture.js";
import { createGeometryDeck, holeGeometry } from "../tests/geometry-fixture.js";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  addText,
  insertImage,
  inspector,
  installAddTextNow,
  installMenuNow,
  menuCommand,
  openMenuPath,
  openNewSlideMenu,
  openShapeMenu,
  ribbonButton,
  ribbonControl,
  setRibbonFont,
  themeDialog,
} from "./editor-commands.js";
import {
  P,
  createDeck,
  parseDeck,
  text,
  setRichText,
  SOFT_BREAK,
} from "../src/model.js";
import { readFile } from "node:fs/promises";
import { deflateSync, crc32 } from "node:zlib";
import { randomFillSync } from "node:crypto";
import { unzipSync, zipSync } from "fflate";
import {
  parseXml,
  firstChildElement,
  qname,
  NS,
} from "../lib/pptx/src/internal/xml/index.ts";
import {
  createLargeDeck,
  createMappedColorDeck,
  createSharedFontDeck,
  createTransformedBackgroundDeck,
  withArchiveComment,
  withBackslashPaths,
} from "../tests/fixtures.js";

test("transformed gradient stops survive clipboard copying and .pptx download", async ({
  page,
}) => {
  await start(page);
  const p = createDeck("blank"),
    s = P.getSlides(p)[0];
  const shape = P.addSlideShape(s, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(4),
    h: P.inches(2),
    preset: "rect",
  });
  P.setShapeGradientFill(shape, {
    stops: [
      { offset: 0, color: "#FF0000" },
      { offset: 1, color: "#0000FF" },
    ],
  });
  const files = unzipSync(await P.savePresentation(p)),
    name = P.getSlidePartName(s).slice(1);
  const gradient =
    '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"><a:tint val="50000"/><a:satMod val="300000"/></a:srgbClr></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"><a:shade val="50000"/></a:srgbClr></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill>';
  files[name] = new TextEncoder().encode(
    new TextDecoder()
      .decode(files[name])
      .replace(/<a:gradFill\b[^>]*>[\s\S]*?<\/a:gradFill>/, gradient),
  );
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Gradient colors.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(zipSync(files)),
  });
  const object = page.locator(".object-hit"),
    image = page.locator(".slide-image");
  await expect(object).toHaveCount(1);
  const samples = await image.evaluate(async (image) => {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, 1280, 720);
    return [192, 288, 384].map((x) => ({
      t: (x - 96 + 0.5) / 384,
      pixel: [...context.getImageData(x, 192, 1, 1).data],
    }));
  });
  for (const { t, pixel } of samples) {
    const expected = [
      255 * (1 - t ** 1.875),
      120 * (1 - t ** 1.875),
      120 + 68 * (1 - (1 - t) ** 1.875),
      255,
    ];
    for (let c = 0; c < 4; c++)
      expect(Math.abs(pixel[c] - expected[c])).toBeLessThanOrEqual(3);
  }
  await object.click();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(object).toHaveCount(2);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const bytes = await readFile(await (await downloaded).path()),
    restored = await parseDeck(bytes);
  const slide = P.getSlides(restored)[0];
  expect(P.getSlideShapes(slide)).toHaveLength(2);
  for (const sh of P.getSlideShapes(slide)) {
    expect(P.getShapeGradientFill(sh).stops.map((stop) => stop.color)).toEqual([
      "#FF0000",
      "#0000FF",
    ]);
    expect(
      P.getShapeGradientFillEffective(restored, sh).stops.map(
        (stop) => stop.color,
      ),
    ).toEqual(["#FF7878", "#0000BC"]);
  }
  const xml = new TextDecoder().decode(
    unzipSync(bytes)[P.getSlidePartName(slide).slice(1)],
  );
  // The source remains byte-authored; the copy carries namespace scopes for
  // inherited properties. Compare native values and transform order rather
  // than requiring identical namespace-declaration placement.
  expect(xml).toContain(gradient);
  const nativeGradient = (sh) => {
    const root = parseXml(P.getShapeXmlString(sh)).root,
      props = firstChildElement(root, qname("p", "spPr", NS.pml)),
      fill = firstChildElement(props, qname("a", "gradFill", NS.dml));
    const model = (node) =>
      node.kind === "element"
        ? {
            name: [node.name.namespaceURI, node.name.localName],
            attrs: node.attrs.map((a) => [
              a.name.namespaceURI,
              a.name.localName,
              a.value,
            ]),
            children: node.children.map(model),
          }
        : node;
    return model(fill);
  };
  expect(nativeGradient(P.getSlideShapes(slide)[1])).toEqual(
    nativeGradient(P.getSlideShapes(slide)[0]),
  );
});

test("mapped text and paint colors survive editing, copying, and PNG and .pptx downloads", async ({
  page,
}) => {
  await start(page);
  const original = await createMappedColorDeck({
    decorations: true,
    painted: true,
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Mapped text.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(original),
  });
  const image = page.locator(".slide-image"),
    object = page.locator(".object-hit");
  await expect(object).toHaveCount(1);
  for (const layer of ["slide", "layout", "master"])
    expect(decodeURIComponent(await image.getAttribute("src"))).toContain(
      `fill="#FFFFFF">Mapped ${layer}</tspan>`,
    );
  await object.click();
  await inspector(page);
  await expect(
    panel(page).locator('.color-field:has(input[aria-label="Text color"])'),
  ).toHaveText("#FFFFFF");
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await object.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toHaveCSS("color", "rgb(255, 255, 255)");
  await editor.fill("Edited mapping");
  await editor.press("Control+Enter");
  await object.click();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(object).toHaveCount(2);

  await openFileMenu(page);
  const pngDownload = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download as images", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "This slide as PNG", exact: true })
    .click();
  const png = await readFile(await (await pngDownload).path());
  const pixels = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return [1, 3, 5].map((y) => {
      const bytes = context.getImageData(
        0,
        Math.floor((image.height * y) / 7.5),
        image.width,
        Math.floor(image.height / 7.5),
      ).data;
      let count = 0;
      for (let i = 0; i < bytes.length; i += 4)
        if (
          bytes[i] > 240 &&
          bytes[i + 1] > 240 &&
          bytes[i + 2] > 240 &&
          bytes[i + 3] === 255
        )
          count++;
      const surface = Array.from(
        context.getImageData(
          Math.floor(image.width * 0.6),
          Math.floor((image.height * (y + 0.5)) / 7.5),
          1,
          1,
        ).data,
      );
      return { count, surface };
    });
  }, png.toString("base64"));
  for (const { count, surface } of pixels) {
    expect(count).toBeGreaterThan(200);
    expect(surface).toEqual([0, 0, 0, 255]);
  }

  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const bytes = await readFile(await (await downloaded).path()),
    restored = await parseDeck(bytes);
  const shapes = P.getSlideShapes(P.getSlides(restored)[0]);
  expect(shapes).toHaveLength(2);
  expect(P.getShapeRunFormat(shapes[0], 0, 0).color).toBe("tx1");
  expect(P.getShapeRunFormat(shapes[1], 0, 0).color).toBe("#FFFFFF");
  for (const shape of shapes) {
    expect(P.getShapeText(shape)).toBe("Edited mapping");
    expect(P.getShapeFillColorResolved(restored, shape)).toBe("#000000");
    expect(P.getShapeStrokeColorResolved(restored, shape)).toBe("#FFFFFF");
    expect(P.getShapeRunFormatEffective(restored, shape, 0, 0).color).toBe(
      "#FFFFFF",
    );
  }
  const parts = unzipSync(bytes);
  for (const [name, data] of Object.entries(unzipSync(original)))
    if (/^ppt\/(slideMasters|slideLayouts|theme)\//.test(name))
      expect(parts[name]).toEqual(data);
});

test("text wraps at measured font widths and survives copying and download", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck();
  const slide = P.getSlides(pres)[0];
  P.renameShape(text(slide, "iiiiii iiiiii", 1, 1, 1.04, 1, 18), "Narrow");
  P.renameShape(text(slide, "WWWWWW", 1, 3, 1.04, 1, 18), "Wide");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Font widths.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const image = page.locator(".slide-image");
  await expect(image).toBeVisible();
  const lines = await image.evaluate((image) => {
    const svg = new DOMParser().parseFromString(
      decodeURIComponent(image.src.slice(image.src.indexOf(",") + 1)),
      "image/svg+xml",
    );
    return ["Narrow", "Wide"].map((name) =>
      Array.from(
        svg.querySelectorAll(`g[data-pptx-shape-name="${name}"] text`),
        (node) => node.textContent,
      ),
    );
  });
  expect(lines[0]).toEqual(["iiiiii iiiiii"]);
  expect(lines[1].length).toBeGreaterThan(1);
  expect(lines[1].join("")).toBe("WWWWWW");
  await page.locator(".object-hit").nth(1).click();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(3);
  await openFileMenu(page);
  const download = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const restored = await parseDeck(
    new Uint8Array(await readFile(await (await download).path())),
  );
  const shapes = P.getSlideShapes(P.getSlides(restored)[0]);
  expect(shapes.map(P.getShapeText)).toEqual([
    "iiiiii iiiiii",
    "WWWWWW",
    "WWWWWW",
  ]);
  for (const shape of shapes) {
    expect(P.getShapeRunFormat(shape, 0, 0).font).toBe("Arial");
    expect(P.getShapeRunFormat(shape, 0, 0).size).toBe(18);
    expect(P.getShapeBounds(shape).w).toBe(P.inches(1.04));
  }
});

for (const location of ["layout", "slide"])
  test(`shared ${location} font metadata stays consistent through editing, copying, and download`, async ({
    page,
  }) => {
    await start(page);
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "Shared fonts.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from(
        await createSharedFontDeck({ encoded: true, location }),
      ),
    });
    const image = page.locator(".slide-image");
    await expect
      .poll(async () =>
        decodeURIComponent((await image.getAttribute("src")) || ""),
      )
      .toContain("Times New Roman");
    await page.locator(".object-hit").dblclick();
    const editor = page.getByRole("textbox", {
      name: "Edit text",
      exact: true,
    });
    await expect(editor).toHaveCSS("font-family", /Georgia/);
    await editor.fill("Edited shared serif");
    await editor.press("Control+Enter");
    await page.locator(".object-hit").click();
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    await expect(page.locator(".object-hit")).toHaveCount(2);
    await expect
      .poll(async () =>
        decodeURIComponent((await image.getAttribute("src")) || ""),
      )
      .toContain("Times New Roman");
    await openFileMenu(page);
    const download = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const restored = await parseDeck(
      new Uint8Array(await readFile(await (await download).path())),
    );
    const shapes = P.getSlideShapes(P.getSlides(restored)[0]);
    expect(shapes).toHaveLength(2);
    for (const shape of shapes) {
      expect(P.getShapeText(shape)).toBe("Edited shared serif");
      expect(P.getShapeRunFormat(shape, 0, 0).font).toBe(
        "Unavailable Shared Serif",
      );
    }
  });

test("imports Windows ZIP paths, edits the deck, and downloads canonical paths", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck();
  text(P.getSlides(pres)[0], "Windows archive heading", 1, 1, 8, 1);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Windows paths.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(withBackslashPaths(await P.savePresentation(pres))),
  });
  await expect(page.locator(".document-title")).toHaveText("Windows paths");
  await page.locator(".object-hit").dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toHaveText("Windows archive heading");
  await editor.fill("Edited Windows archive heading");
  await editor.press("Control+Enter");
  await expect
    .poll(async () =>
      decodeURIComponent(
        (await page.locator(".slide-image").getAttribute("src")) || "",
      ),
    )
    .toContain("Edited Windows archive heading");
  await openFileMenu(page);
  const download = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const bytes = new Uint8Array(await readFile(await (await download).path()));
  expect(
    Object.keys(unzipSync(bytes)).some((name) => name.includes("\\")),
  ).toBe(false);
  const restored = await parseDeck(bytes);
  expect(P.getSlideText(P.getSlides(restored)[0])).toBe(
    "Edited Windows archive heading",
  );
});

test("ambiguous ZIP paths leave the open presentation intact", async ({
  page,
}) => {
  await story(page);
  const entries = unzipSync(await P.savePresentation(createDeck()));
  entries["ppt\\slides\\slide1.xml"] = entries["ppt/slides/slide1.xml"];
  await openFileMenu(page);
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("menuitem", { name: "Import PPTX", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "Ambiguous.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(zipSync(entries)),
  });
  await expect(page.locator("#toast")).toContainText(
    "could not be opened as a PowerPoint presentation",
  );
  await expect(page.locator(".document-title")).toHaveText("The big idea");
  await expect(page.locator("#slide-count")).toHaveText("5");
  await expect(page.locator('[data-object="1"]')).toHaveAccessibleName(
    /Make room/,
  );
});

test("an imported font stays consistent in the preview, text editor, and download", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck();
  const object = text(P.getSlides(pres)[0], "Serif heading", 1, 1, 8, 1);
  P.setShapeTextFormat(object, { font: "Georgia" });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Authored font.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".document-title")).toHaveText("Authored font");
  const image = page.locator(".slide-image");
  await expect
    .poll(async () =>
      decodeURIComponent((await image.getAttribute("src")) || ""),
    )
    .toContain("&quot;Georgia&quot;");
  await page.locator(".object-hit").dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toHaveCSS("font-family", /Georgia/);
  await editor.fill("Edited serif heading");
  await editor.press("Control+Enter");
  await expect
    .poll(async () =>
      decodeURIComponent((await image.getAttribute("src")) || ""),
    )
    .toContain("Edited serif heading");
  await expect
    .poll(async () =>
      decodeURIComponent((await image.getAttribute("src")) || ""),
    )
    .toContain("&quot;Georgia&quot;");
  await openFileMenu(page);
  const download = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await download).path())),
  );
  const restored = P.getSlideShapes(P.getSlides(loaded)[0])[0];
  expect(P.getShapeRunFormatEffective(loaded, restored, 0, 0).font).toBe(
    "Georgia",
  );
  expect(P.getShapeText(restored)).toBe("Edited serif heading");
});

test("imports a PPTX with archive-end signatures in its ZIP comment", async ({
  page,
}) => {
  await start(page);
  const original = createDeck("story");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Commented deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(
      withArchiveComment(await P.savePresentation(original), 65535),
    ),
  });
  await expect(page.locator(".document-title")).toHaveText("Commented deck");
  await expect(page.locator("#slide-count")).toHaveText("5");
  await expect(page.locator('[data-object="1"]')).toHaveAccessibleName(
    /Make room/,
  );
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getSlides(loaded).map(P.getSlideText)).toEqual(
    P.getSlides(original).map(P.getSlideText),
  );
});

for (const modifier of ["Control", "Meta"]) {
  test(`${modifier}+S commits and saves text being edited on the canvas`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await page
      .getByRole("button", { name: "The big idea A clear, considered story" })
      .click();
    await page.locator('[data-object="1"]').dblclick();
    const input = page.getByRole("textbox", { name: "Edit text", exact: true });
    await input.fill("Save this in-progress title");
    await input.press(`${modifier}+s`);
    await expect(page.locator("#save-status")).toContainText("Saved to Puter");
    const bytes = await page.evaluate(async () =>
      Array.from(
        new Uint8Array(
          await (
            await puter.fs.read(window.__writes.at(-1).path)
          ).arrayBuffer(),
        ),
      ),
    );
    const loaded = await parseDeck(new Uint8Array(bytes));
    expect(P.getSlideText(P.getSlides(loaded)[0])).toContain(
      "Save this in-progress title",
    );
  });
}

async function mockPuter(
  page,
  {
    signedIn = false,
    env = "web",
    failWrite = false,
    delayAuth = false,
    username = "test-user",
  } = {},
) {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `(()=>{let signedIn=${signedIn};const files={};window.__writes=[];window.puter={env:${JSON.stringify(env)},auth:{isSignedIn:async()=>{if(${delayAuth})await new Promise(resolve=>window.__releaseAuth=resolve);return signedIn},getUser:async()=>({username:${JSON.stringify(username)},uuid:'test-user-id'}),signIn:async()=>{signedIn=true},signOut:async()=>{signedIn=false}},kv:new Proxy({},{get(){throw Error('KV is forbidden')}}),fs:{readdir:async()=>Object.values(files),write:async(path,blob,options)=>{if(${failWrite})throw Error('Cloud save failed. Your draft is still on this device.');const actual=path.startsWith('/')?path:'/test/'+path;window.__writes.push({path:actual,options,size:blob.size});files[actual]={path:actual,name:actual.split('/').pop(),modified:Date.now()/1000,bytes:blob};return files[actual];},read:async path=>files[path].bytes,rename:async(path,name)=>({path:path.slice(0,path.lastIndexOf('/')+1)+name}),delete:async path=>delete files[path]},ui:{onLaunchedWithItems:()=>{}}};})();`,
    }),
  );
}
async function start(page) {
  await mockPuter(page);
  await page.goto("/#/home");
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
}
// Leaves the editor with edits that never reached Puter, so they stay behind
// as a recovery draft: the save on the way out fails, and the person leaves
// anyway.
async function leaveWithUnsavedCloudEdits(page) {
  await page.evaluate(() => {
    const write = puter.fs.write;
    puter.fs.write = async () => {
      puter.fs.write = write;
      throw Error("Cloud save failed.");
    };
  });
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("dialog", { name: "Your latest changes aren't saved to Puter" })
    .getByRole("button", { name: "Leave", exact: true })
    .click();
}
// The app itself opens into a new presentation; a reload lands in the library
// only when its URL asks for it.
async function reloadLibrary(page) {
  await page.evaluate(() => {
    location.hash = "#/home";
  });
  await page.reload();
}
async function story(page) {
  await start(page);
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
}
async function countSvgRenders(page) {
  await page.evaluate(() => {
    const encode = window.encodeURIComponent;
    window.__svgRenders = 0;
    window.encodeURIComponent = (value) => {
      if (typeof value === "string" && value.includes("<svg"))
        window.__svgRenders++;
      return encode(value);
    };
  });
}
// The File menu is on the menu bar, or behind the File options button on a
// phone, where the menu bar gives way.
const fileMenuOpener = (page) =>
  page
    .getByRole("menuitem", { name: "File", exact: true })
    .or(page.getByRole("button", { name: "File options" }))
    .filter({ visible: true });
async function openFileMenu(page) {
  await fileMenuOpener(page).click();
}
// File > Print…, then Print in the print dialog with its settings as they are.
async function printFromMenu(page) {
  await openFileMenu(page);
  await page.getByRole("menuitem", { name: "Print…", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Print" })
    .getByRole("button", { name: "Print", exact: true })
    .click();
}
// A menu bar menu: on the bar, or, on a phone, a submenu of the File
// options button that stands in for the bar.
async function openBarMenu(page, name) {
  const item = page.getByRole("menuitem", { name, exact: true });
  if (await item.isVisible()) {
    await item.click();
    return;
  }
  await openFileMenu(page);
  await page.getByRole("menuitem", { name, exact: true }).click();
}
// The toolbar and the format panel share their formatting buttons' names.
const panel = (page) =>
  page.getByRole("complementary", { name: "Format panel" });

for (const nextAction of ["new presentation", "sign out"]) {
  test(`a delayed cloud picker is discarded after ${nextAction}`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await expect(
      page.getByRole("button", { name: "Account and settings" }),
    ).toContainText("test-user");
    await page.evaluate(() => {
      window.__cloudReads = 0;
      puter.fs.read = async () => {
        window.__cloudReads++;
        throw new Error("Stale file was read");
      };
      puter.ui.showOpenFilePicker = () =>
        new Promise((resolve) => {
          window.__releasePicker = () =>
            resolve({
              name: "Old choice.pptx",
              path: "/old-account/Old choice.pptx",
            });
        });
    });
    await page
      .getByRole("button", { name: "Open from Puter", exact: true })
      .click();
    await page.waitForFunction(() => window.__releasePicker);
    if (nextAction === "new presentation") {
      await page
        .getByRole("button", { name: "New presentation", exact: true })
        .click();
      await addText(page);
      await expect(page.locator(".object-hit")).toHaveCount(1);
    } else {
      await page.getByRole("button", { name: "Account and settings" }).click();
      await page
        .getByRole("menuitem", { name: "Sign out", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Connect Puter", exact: true }),
      ).toBeVisible();
    }
    await page.evaluate(async () => {
      window.__releasePicker();
      await new Promise(requestAnimationFrame);
    });
    expect(await page.evaluate(() => window.__cloudReads)).toBe(0);
    if (nextAction === "new presentation") {
      await expect(page.locator(".object-hit")).toHaveCount(1);
      await expect(page.locator(".document-title")).toHaveText(
        "Untitled presentation",
      );
    } else
      await expect(
        page.getByRole("button", { name: "Connect Puter", exact: true }),
      ).toBeVisible();
  });
}

test("an oversized cloud import is rejected before its blob is copied into memory", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await page.evaluate(() => {
    const blob = new Blob([new Uint8Array(41 * 1024 * 1024)]);
    const read = blob.arrayBuffer.bind(blob);
    window.__bufferReads = 0;
    blob.arrayBuffer = () => {
      window.__bufferReads++;
      return read();
    };
    puter.fs.read = async () => blob;
    puter.ui.showOpenFilePicker = async () => ({
      name: "Oversized.pptx",
      path: "/test/Oversized.pptx",
    });
  });
  await openFileMenu(page);
  await page
    .getByRole("menuitem", { name: "Open from Puter", exact: true })
    .click();
  await expect(page.locator("#toast")).toHaveText(
    "Please choose a PPTX file smaller than 40 MB.",
  );
  expect(await page.evaluate(() => window.__bufferReads)).toBe(0);
  await expect(page).toHaveTitle("The big idea | Presentation");
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
});

for (const selectFile of [false, true]) {
  test(`a cloud picker opened from a guest session ${selectFile ? "opens the selected deck" : "can be cancelled"}`, async ({
    page,
  }) => {
    await start(page);
    const bytes = Array.from(await P.savePresentation(createDeck("story")));
    await page.evaluate(
      ({ bytes, selectFile }) => {
        window.__cloudReads = 0;
        puter.fs.read = async () => {
          window.__cloudReads++;
          return new Blob([new Uint8Array(bytes)]);
        };
        puter.ui.showOpenFilePicker = async () =>
          selectFile
            ? [{ name: "Picked deck.pptx", path: "/test/Picked deck.pptx" }]
            : null;
      },
      { bytes, selectFile },
    );
    await page
      .getByRole("button", { name: "Open from Puter", exact: true })
      .click();
    if (selectFile) {
      await expect(page.locator(".document-title")).toHaveText("Picked deck");
      await expect(page.locator("#slide-count")).toHaveText("5");
      await expect(page.locator("#save-status")).toContainText(
        "Saved to Puter",
      );
      expect(await page.evaluate(() => window.__cloudReads)).toBe(1);
    } else {
      await expect(
        page.getByRole("button", { name: "Account and settings" }),
      ).toContainText("test-user");
      await expect(
        page.getByRole("heading", { name: "Good ideas deserve a stage." }),
      ).toBeVisible();
      expect(await page.evaluate(() => window.__cloudReads)).toBe(0);
    }
  });
}

test("a slow cloud open cannot replace a presentation started afterward", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page.evaluate(() => {
    const read = puter.fs.read;
    puter.fs.read = (path) =>
      new Promise((resolve, reject) => {
        window.__releaseRead = async () => {
          try {
            resolve(await read(path));
          } catch (error) {
            reject(error);
          }
        };
      });
  });
  await page
    .getByRole("button", {
      name: "The big idea PowerPoint presentation",
      exact: true,
    })
    .click();
  await page.waitForFunction(() => window.__releaseRead);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.evaluate(() => window.__releaseRead());
  await addText(page);
  await expect(page.locator(".document-title")).toHaveText(
    "Untitled presentation",
  );
  await expect(page.locator(".object-hit")).toHaveCount(2);
});

for (const action of ["cancel", "restore original text", "keep typing"]) {
  test(`the unsaved-work warning is accurate when you ${action}`, async ({
    page,
  }) => {
    await story(page);
    if (action === "cancel") {
      await page.locator('[data-object="1"]').dblclick();
      const input = page.getByRole("textbox", {
        name: "Edit text",
        exact: true,
      });
      await input.fill("Discard this edit");
      await input.press("Escape");
    } else {
      const notes = page.getByRole("textbox", { name: "Speaker notes" });
      await notes.fill("Temporary notes");
      if (action === "restore original text") await notes.fill("");
    }
    const warned = await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(warned).toBe(action === "keep typing");
  });
}

for (const label of ["Text", "Undo", "Redo"]) {
  test(`queued ${label} work is protected from reload until saved locally`, async ({
    page,
  }) => {
    await story(page);
    if (label !== "Text") {
      await addText(page);
      await expect(page.locator(".object-hit")).toHaveCount(8);
    }
    if (label === "Redo") {
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(page.locator(".object-hit")).toHaveCount(7);
    }
    await installAddTextNow(page);
    const warned = await page.evaluate((label) => {
      if (label === "Text") window.__addTextNow();
      else document.querySelector(`button[aria-label="${label}"]`).click();
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }, label);
    expect(warned).toBe(true);
    await expect(page.locator(".object-hit")).toHaveCount(
      label === "Undo" ? 7 : 8,
    );
    expect(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(false);
  });
}

for (const resizeOpenMenu of [false, true]) {
  test(`file options remain reachable in a short viewport ${resizeOpenMenu ? "after resizing an open menu" : "when opened"}`, async ({
    page,
  }, info) => {
    await story(page);
    const width = page.viewportSize().width;
    await page.setViewportSize({ width, height: resizeOpenMenu ? 700 : 200 });
    await openFileMenu(page);
    if (resizeOpenMenu) await page.setViewportSize({ width, height: 200 });
    const menu = page.getByRole("menu");
    await expect
      .poll(async () => {
        const box = await menu.boundingBox();
        return !!box && box.y >= 8 && box.y + box.height <= 192;
      })
      .toBe(true);
    const first = menu.getByRole("menuitem", {
      name: "New presentation",
      exact: true,
    });
    await expect(first).toBeFocused();
    await page.keyboard.press("End");
    const last = menu.getByRole("menuitem", {
      name: "Back to presentations",
      exact: true,
    });
    await expect(last).toBeFocused();
    const lastBox = await last.boundingBox();
    expect(lastBox.y).toBeGreaterThanOrEqual(8);
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(192);
    await page.keyboard.press("ArrowDown");
    await expect(first).toBeFocused();
    expect((await first.boundingBox()).y).toBeGreaterThanOrEqual(8);
    await page.screenshot({
      path: `test-results/short-menu-${resizeOpenMenu}-${info.project.name}.png`,
    });
    await menu
      .getByRole("menuitem", { name: "Save to Puter", exact: true })
      .click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
  });
}

test("home is responsive, accessible, and uses system appearance by default", async ({
  page,
}, info) => {
  await start(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({
    path: `test-results/home-${info.project.name}.png`,
    fullPage: true,
  });
});

for (const [description, length, suffix] of [
  ["Unicode", 179, "😀"],
  ["whitespace", 179, " rest"],
  ["whitespace before Unicode", 178, " 😀"],
]) {
  test(`long imported ${description} filenames remain consistent when renamed and downloaded`, async ({
    page,
  }) => {
    await start(page);
    const prefix = "x".repeat(length);
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: prefix + suffix + ".pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from(await P.savePresentation(createDeck())),
    });
    await expect(page.locator(".document-title")).toHaveText(prefix);
    await page.locator(".document-title").click();
    await expect(
      page.getByRole("textbox", { name: "Presentation name" }),
    ).toHaveValue(prefix);
    await page.keyboard.press("Escape");
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    expect((await downloaded).suggestedFilename()).toBe(prefix + ".pptx");
  });
}

for (const title of ["The big idea", "Plan.pptx"]) {
  test(`library download preserves the filename for ${title}`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await page
      .getByRole("button", { name: "The big idea A clear, considered story" })
      .click();
    if (title !== "The big idea") {
      await page.locator(".document-title").click();
      const input = page.getByRole("textbox", { name: "Presentation name" });
      await input.fill(title + ".pptx");
      await input.press("Enter");
      await expect(page.locator(".document-title")).toHaveText(title);
    }
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await page
      .getByRole("button", { name: `Options for ${title}`, exact: true })
      .click();
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PPTX", exact: true })
      .click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(title + ".pptx");
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await download.path())),
    );
    expect(P.getSlides(loaded)).toHaveLength(5);
    expect(P.getSlideText(P.getSlides(loaded)[0])).toContain("Make room for");
  });
}

test("a locally saved presentation larger than the import limit can be recovered and downloaded", async ({
  page,
}) => {
  test.setTimeout(60000);
  await start(page);
  const pres = createLargeDeck();
  P.setSlideNotes(P.getSlides(pres)[0], "Saved notes");
  const bytes = await P.savePresentation(pres);
  expect(bytes.byteLength).toBeGreaterThan(40 * 1024 * 1024);
  await page.route("**/large-draft-fixture.pptx", (route) =>
    route.fulfill({ body: Buffer.from(bytes) }),
  );
  await page.evaluate(async () => {
    const { saveDraft } = await import("/src/drafts.js");
    const bytes = new Uint8Array(
      await (await fetch("/large-draft-fixture.pptx")).arrayBuffer(),
    );
    await saveDraft({
      id: "large-draft",
      owner: "guest",
      name: "Large recovery",
      path: null,
      cloudSaved: false,
      theme: "studio",
      bytes,
    });
  });
  await reloadLibrary(page);
  await page
    .getByRole("button", { name: "Large recovery Recovery draft", exact: true })
    .click();
  await expect(page.locator(".document-title")).toHaveText("Large recovery", {
    timeout: 30000,
  });
  await expect(page.locator(".object-hit")).toHaveCount(4);
  await expect(page.locator("#speaker-notes")).toHaveValue("Saved notes");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("Large recovery.pptx");
  const loaded = await P.loadPresentation(
    new Uint8Array(await readFile(await download.path())),
  );
  expect(P.getSlideShapes(P.getSlides(loaded)[0])).toHaveLength(4);
  expect(P.getSlideNotes(P.getSlides(loaded)[0])).toBe("Saved notes");
});

test("a title ending in .pptx survives recovery, unchanged rename, download, and cloud save", async ({
  page,
}) => {
  await start(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Plan.pptx.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(createDeck())),
  });
  const title = page.locator(".document-title");
  await expect(title).toHaveText("Plan.pptx");
  for (let recovery = 0; recovery < 2; recovery++) {
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await page
      .getByRole("button", { name: "Plan.pptx Recovery draft", exact: true })
      .click();
    await expect(title).toHaveText("Plan.pptx");
  }
  await title.click();
  await page.getByRole("textbox", { name: "Presentation name" }).press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(title).toHaveText("Plan.pptx");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  expect((await downloaded).suggestedFilename()).toBe("Plan.pptx.pptx");
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
  await expect(title).toHaveText("Plan.pptx");
  expect(await page.evaluate(() => window.__writes.at(-1).path)).toBe(
    "/test/Presentations/Plan.pptx.pptx",
  );
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page.evaluate(() => {
    window.__renames = 0;
    const rename = puter.fs.rename;
    puter.fs.rename = (...args) => {
      window.__renames++;
      return rename(...args);
    };
  });
  await page
    .getByRole("button", { name: "Options for Plan.pptx", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Presentation name" }).press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.__renames)).toBe(0);
  await page
    .getByRole("button", {
      name: "Plan.pptx PowerPoint presentation",
      exact: true,
    })
    .click();
  await expect(title).toHaveText("Plan.pptx");
});

test("deleting a long unbroken name keeps the confirmation and close control inside the dialog", async ({
  page,
}, info) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.locator(".document-title").click();
  const name = "x".repeat(180);
  const input = page.getByRole("textbox", { name: "Presentation name" });
  await input.fill(name);
  await input.press("Enter");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: `Options for ${name}`, exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete draft", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: `Delete “${name}”?`,
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  const bounds = await dialog.boundingBox();
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  const closeBounds = await close.boundingBox();
  expect(closeBounds.x).toBeGreaterThanOrEqual(bounds.x);
  expect(closeBounds.x + closeBounds.width).toBeLessThanOrEqual(
    bounds.x + bounds.width,
  );
  await page.screenshot({
    path: `test-results/long-delete-dialog-${info.project.name}.png`,
  });
  await close.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: name + " Recovery draft", exact: true }),
  ).toBeVisible();
});

test("opening a rename dialog selects the current name for immediate keyboard replacement", async ({
  page,
}) => {
  await story(page);
  const title = page.locator(".document-title");
  await title.press("Enter");
  const input = page.getByRole("textbox", { name: "Presentation name" });
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((input) => [input.selectionStart, input.selectionEnd]),
  ).toEqual([0, "The big idea".length]);
  await page.keyboard.type("Keyboard title");
  await page.keyboard.press("Enter");
  await expect(title).toHaveText("Keyboard title");
  await expect(title).toBeFocused();
  await title.press("Enter");
  await page.keyboard.type("Canceled title");
  await page.keyboard.press("Escape");
  await expect(title).toHaveText("Keyboard title");
  await expect(title).toBeFocused();
});

for (const [title, input] of [
  ["Alpha", " Alpha "],
  ["Alpha", "Alpha.pptx"],
  ["Plan.pptx", " Plan.pptx "],
]) {
  for (const location of ["library", "editor"]) {
    test(`${location} rename ignores the equivalent name ${JSON.stringify(input)}`, async ({
      page,
    }) => {
      await mockPuter(page, { signedIn: true });
      await page.goto("/#/home");
      await page.evaluate(
        ({ title, bytes }) => {
          puter.fs.readdir = async () => [
            { name: title + ".pptx", path: "/test/" + title + ".pptx" },
          ];
          puter.fs.read = async () => new Blob([new Uint8Array(bytes)]);
          window.__renameCalls = 0;
          puter.fs.rename = async () => {
            window.__renameCalls++;
            throw new Error("The destination already exists.");
          };
        },
        { title, bytes: Array.from(await P.savePresentation(createDeck())) },
      );
      await page
        .getByRole("button", { name: "New presentation", exact: true })
        .click();
      await page.getByRole("button", { name: "Back to presentations" }).click();
      if (location === "library") {
        await page
          .getByRole("button", { name: `Options for ${title}`, exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: "Rename", exact: true })
          .click();
      } else {
        await page
          .getByRole("button", {
            name: `${title} PowerPoint presentation`,
            exact: true,
          })
          .click();
        await page.locator(".document-title").click();
      }
      await page
        .getByRole("textbox", { name: "Presentation name" })
        .fill(input);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /^(Save|Sign in to save)$/ })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(
        await page.evaluate(async () => {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return window.__renameCalls;
        }),
      ).toBe(0);
      if (location === "editor") {
        await expect(page.locator(".document-title")).toHaveText(title);
        await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
      } else
        await expect(
          page.getByRole("button", {
            name: `Options for ${title}`,
            exact: true,
          }),
        ).toBeFocused();
    });
  }
}

for (const action of [
  "rename",
  "delete",
  "delete last",
  "rename while searching",
]) {
  test(`library ${action} preserves a useful keyboard focus target`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await page.evaluate((action) => {
      puter.fs.readdir = async () => window.__files;
      window.__files = [
        { name: "Alpha.pptx", path: "/test/Alpha.pptx" },
        ...(action === "delete last"
          ? []
          : [{ name: "Zulu.pptx", path: "/test/Zulu.pptx" }]),
      ];
      puter.fs.rename = async (path, name) => {
        if (action === "rename while searching")
          await new Promise((resolve) => (window.__releaseRename = resolve));
        const file = window.__files.find((file) => file.path === path);
        file.name = name;
        file.path = "/test/" + name;
        return file;
      };
      puter.fs.delete = async (path) => {
        window.__files = window.__files.filter((file) => file.path !== path);
      };
    }, action);
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    // The extra local draft is not part of this cloud-library focus scenario.
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
    await page.getByRole("button", { name: "Back to presentations" }).click();
    const options = page.getByRole("button", {
      name: "Options for Alpha",
      exact: true,
    });
    await options.focus();
    await options.press("Enter");
    await page
      .getByRole("menuitem", {
        name: action.startsWith("rename") ? "Rename" : "Delete presentation",
        exact: true,
      })
      .click();
    if (action.startsWith("rename")) {
      const input = page.getByRole("textbox", { name: "Presentation name" });
      await input.fill("Beta");
      await input.press("Enter");
      if (action === "rename while searching") {
        await page.waitForFunction(() => window.__releaseRename);
        const search = page.getByRole("searchbox", {
          name: "Search presentations",
        });
        await search.fill("Beta");
        await search.evaluate((input) => input.setSelectionRange(1, 3));
        await page.evaluate(() => window.__releaseRename());
      }
      await expect(
        page.getByRole("button", {
          name: "Beta PowerPoint presentation",
          exact: true,
        }),
      ).toBeVisible();
    } else {
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Alpha PowerPoint presentation",
          exact: true,
        }),
      ).toHaveCount(0);
    }
    if (action === "rename while searching") {
      const search = page.getByRole("searchbox", {
        name: "Search presentations",
      });
      await expect(search).toBeFocused();
      expect(
        await search.evaluate((input) => [
          input.selectionStart,
          input.selectionEnd,
        ]),
      ).toEqual([1, 3]);
      return;
    }
    await expect(
      page.getByRole("button", {
        name: action.startsWith("rename")
          ? "Options for Beta"
          : action === "delete"
            ? "Options for Zulu"
            : "New presentation",
        exact: true,
      }),
    ).toBeFocused();
  });
}

for (const [action, save] of [
  ["Rename", false],
  ["Rename", true],
  ["Delete presentation", false],
]) {
  test(`${save ? "saving" : "closing"} ${action} restores library focus after a background save refreshes its row`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await expect(
      page.getByRole("button", { name: "Account and settings" }),
    ).toContainText("test-user");
    await page.evaluate(() => {
      window.__alpha = { name: "Alpha.pptx", path: "/test/Alpha.pptx" };
      const list = puter.fs.readdir;
      puter.fs.readdir = async (...args) => [
        window.__alpha,
        ...(await list(...args)),
      ];
      puter.fs.rename = async (path, name) => {
        window.__alpha = { name, path: "/test/" + name };
        return window.__alpha;
      };
      const write = puter.fs.write;
      puter.fs.write = async (...args) => {
        await new Promise((resolve) => (window.__releaseWrite = resolve));
        return write(...args);
      };
    });
    await page
      .getByRole("button", { name: "The big idea A clear, considered story" })
      .click();
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await page.waitForFunction(() => window.__releaseWrite);
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await page
      .getByRole("combobox", { name: "Sort presentations" })
      .selectOption("name");
    const options = page.getByRole("button", {
      name: "Options for Alpha",
      exact: true,
    });
    await options.click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
    const focused = page.getByRole("dialog").locator(":focus");
    const control = await focused.elementHandle();
    await page.evaluate(() => window.__releaseWrite());
    await expect(
      page
        .locator(".file-open")
        .filter({ hasText: "The big idea" })
        .filter({ hasText: "PowerPoint presentation" }),
    ).toHaveCount(1);
    expect(
      await control.evaluate((node) => node === document.activeElement),
    ).toBe(true);
    if (save)
      await page
        .getByRole("textbox", { name: "Presentation name" })
        .fill("Zulu");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: save ? "Save" : "Cancel", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: `Options for ${save ? "Zulu" : "Alpha"}`,
        exact: true,
      }),
    ).toBeFocused();
  });
}

test("library search matches equivalent Unicode names in imported drafts and cloud files", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  const bytes = await P.savePresentation(createDeck());
  await page.evaluate(async (bytes) => {
    await puter.fs.write(
      "Presentations/Cafe\u0301 notes.pptx",
      new Blob([new Uint8Array(bytes)]),
      {},
    );
  }, Array.from(bytes));
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Café plan.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator("#slide-count")).toHaveText("1");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const names = page.locator(".file-open strong");
  const search = page.getByRole("searchbox", { name: "Search presentations" });
  await expect(names).toHaveCount(2);
  for (const query of ["CAFÉ", "cafe\u0301"]) {
    await search.fill(query);
    await expect(names).toHaveCount(2);
  }
  await search.fill("No matching name");
  await expect(names).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No matching presentations" }),
  ).toBeVisible();
  await search.fill("");
  await expect(names).toHaveCount(2);
});

test("library dates refresh over time without replacing focused controls", async ({
  page,
}) => {
  await start(page);
  const now = await page.evaluate(() => new Date(2026, 0, 1, 23, 58).getTime());
  await page.clock.install({ time: now });
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const date = page.locator(".file-date");
  await expect(date).toHaveText("Just now");
  const options = page.getByRole("button", {
    name: "Options for Untitled presentation",
    exact: true,
  });
  await options.focus();
  await page.clock.fastForward(125000);
  await expect(date).toHaveText("2 min ago");
  await expect(options).toBeFocused();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(60 * 60 * 1000);
  await expect(date).toHaveText("2 min ago");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(date).toHaveText("Yesterday");
  await expect(options).toBeFocused();
  await page
    .getByRole("button", {
      name: "Untitled presentation Recovery draft",
      exact: true,
    })
    .click();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.clock.fastForward(125000);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
});

test("library modification dates distinguish calendar days and unavailable timestamps", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  const now = await page.evaluate(() => new Date(2026, 0, 2, 2).getTime());
  await page.clock.setFixedTime(now);
  const expected = await page.evaluate(() => {
    const records = [
      {
        name: "Recent",
        modified: new Date(2026, 0, 2, 1, 59, 40).getTime() / 1000,
        expected: "Just now",
      },
      {
        // The cloud's clock runs a little ahead of this device's.
        name: "Server ahead",
        modified: new Date(2026, 0, 2, 2, 0, 20).getTime() / 1000,
        expected: "Just now",
      },
      {
        name: "Minutes ago",
        modified: new Date(2026, 0, 2, 1, 30).getTime() / 1000,
        expected: "30 min ago",
      },
      {
        name: "Same day",
        modified: new Date(2026, 0, 2, 0, 30).getTime() / 1000,
        expected: "Today",
      },
      {
        name: "Previous day",
        modified: new Date(2026, 0, 1, 23).getTime() / 1000,
        expected: "Yesterday",
      },
      {
        name: "Previous year",
        modified: new Date(2025, 11, 31, 12).getTime() / 1000,
        expected: new Date(2025, 11, 31).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
      },
      {
        name: "Future date",
        modified: new Date(2026, 0, 4, 12).getTime() / 1000,
        expected: new Date(2026, 0, 4).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
      },
      { name: "Missing date", expected: "Date unavailable" },
      {
        name: "Invalid date",
        modified: "invalid",
        expected: "Date unavailable",
      },
    ];
    puter.fs.readdir = async () =>
      records.map(({ name, modified }) => ({
        name: name + ".pptx",
        path: "/test/" + name + ".pptx",
        modified,
      }));
    return records.map(({ name, expected }) => ({ name, expected }));
  });
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: "Back to presentations" }).click();
  for (const { name, expected: label } of expected) {
    const row = page.locator(".file-row").filter({
      has: page.getByRole("button", {
        name: name + " PowerPoint presentation",
        exact: true,
      }),
    });
    await expect.soft(row.locator(".file-date")).toHaveText(label);
  }
});

test("the library sort control retains its selected order after reopening the library", async ({
  page,
}) => {
  await start(page);
  for (const name of ["Alpha", "Zulu"]) {
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await page.locator(".document-title").click();
    const input = page.getByRole("textbox", { name: "Presentation name" });
    await input.fill(name);
    await input.press("Enter");
    await expect(page.locator(".document-title")).toHaveText(name);
    await page.getByRole("button", { name: "Back to presentations" }).click();
  }
  const names = page.locator(".file-open strong");
  const sort = page.getByRole("combobox", { name: "Sort presentations" });
  await expect(sort).toHaveValue("modified");
  await expect(names).toHaveText(["Zulu", "Alpha"]);
  await sort.selectOption("name");
  await expect(names).toHaveText(["Alpha", "Zulu"]);
  await page
    .getByRole("button", { name: "Zulu Recovery draft", exact: true })
    .click();
  await expect(page.locator("#slide-count")).toHaveText("1");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(sort).toHaveValue("name");
  await expect(names).toHaveText(["Alpha", "Zulu"]);
  await sort.selectOption("modified");
  await expect(names).toHaveText(["Zulu", "Alpha"]);
});

test("create, edit, undo, recover, and download a real PPTX", async ({
  page,
}, info) => {
  await story(page);
  await addText(page);
  await inspector(page);
  const input = page.getByRole("textbox", { name: "Object text" });
  await input.fill("A better way to present");
  await input.press("Tab");
  await expect(page.locator("#save-status")).toContainText(
    "Saved on this device",
  );
  await expect(
    page.getByRole("button", {
      name: "A better way to present. Select to edit",
    }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Object text" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "A better way to present. Select to edit",
    }),
  ).toHaveCount(1);
  if (
    await page.getByRole("button", { name: "Close format panel" }).isVisible()
  )
    await page.getByRole("button", { name: "Close format panel" }).click();
  await page
    .getByRole("textbox", { name: "Speaker notes" })
    .fill("Remember to pause after the opening.");
  await page.getByRole("textbox", { name: "Speaker notes" }).press("Tab");
  await expect(page.locator("#save-status")).toContainText(
    "Saved on this device",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/editor-${info.project.name}.png`,
    fullPage: true,
  });
  await reloadLibrary(page);
  await page
    .getByRole("button", { name: "The big idea Recovery draft" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Speaker notes" }),
  ).toHaveValue("Remember to pause after the opening.");
  await openFileMenu(page);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const download = await downloadPromise;
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await download.path())),
  );
  expect(P.getSlideText(P.getSlides(loaded)[0])).toContain(
    "A better way to present",
  );
  expect(P.getSlideNotes(P.getSlides(loaded)[0])).toContain(
    "Remember to pause",
  );
  expect(
    P.validatePresentation(loaded).filter((i) => i.severity === "error"),
  ).toEqual([]);
});

for (const failure of ["unsupported", "denied", "exit denied"]) {
  test(`presentation mode explains ${failure} fullscreen requests`, async ({
    page,
  }, info) => {
    await story(page);
    await page.evaluate((failure) => {
      window.__requestFullscreen = Element.prototype.requestFullscreen;
      if (failure !== "exit denied")
        Element.prototype.requestFullscreen =
          failure === "unsupported"
            ? undefined
            : async () => {
                throw new Error("Fullscreen denied");
              };
    }, failure);
    await page.getByRole("button", { name: "Present", exact: true }).click();
    const presenter = page.getByRole("dialog", { name: "Presentation mode" });
    if (failure === "exit denied") {
      await presenter
        .getByRole("button", { name: "Toggle fullscreen", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => !!document.fullscreenElement))
        .toBe(true);
      await page.evaluate(() => {
        document.exitFullscreen = async () => {
          throw new Error("Exit denied");
        };
      });
    }
    await presenter
      .getByRole("button", { name: "Toggle fullscreen", exact: true })
      .click();
    const status = presenter.getByRole("status");
    await expect(status).toHaveText(
      failure === "exit denied"
        ? "Could not exit fullscreen. Use Exit to close presentation mode."
        : "Fullscreen is unavailable in this window.",
    );
    await expect(status).toBeVisible();
    if (failure === "denied") {
      const result = await new AxeBuilder({ page }).analyze();
      expect(result.violations).toEqual([]);
    }
    await page.screenshot({
      path: `test-results/fullscreen-${failure}-${info.project.name}.png`,
    });
    await presenter
      .getByRole("button", { name: "Next slide", exact: true })
      .click();
    await expect(page.locator(".presenter-controls")).toContainText("2 / 5");
    if (failure !== "exit denied") {
      await page.evaluate(() => {
        Element.prototype.requestFullscreen = window.__requestFullscreen;
      });
      await presenter
        .getByRole("button", { name: "Toggle fullscreen", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => !!document.fullscreenElement))
        .toBe(true);
      await expect(status).toBeEmpty();
    }
    await presenter.getByRole("button", { name: "Exit", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);
    await expect(presenter).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Present", exact: true }),
    ).toBeFocused();
  });
}

test("presentation fullscreen can be entered, navigated, toggled, and exited", async ({
  page,
}, info) => {
  await story(page);
  const present = page.getByRole("button", { name: "Present", exact: true });
  await present.click();
  const fullscreen = page.getByRole("button", {
    name: "Toggle fullscreen",
    exact: true,
  });
  expect(await page.evaluate(() => document.fullscreenEnabled)).toBe(true);
  await fullscreen.press("Enter");
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await expect(page.locator(".presenter-controls")).toContainText("2 / 5");
  await page.screenshot({
    path: `test-results/fullscreen-${info.project.name}.png`,
  });
  await fullscreen.click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toBeVisible();
  await expect(page.locator(".presenter-controls")).toContainText("2 / 5");
  await fullscreen.click();
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toHaveCount(0);
  await expect(present).toBeFocused();
});

test("presentation swipes require one finger and a predominantly horizontal gesture", async ({
  page,
}) => {
  await story(page);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  for (const gesture of [
    "left",
    "right",
    "vertical",
    "pinch",
    "pinch controls",
    "short",
    "canceled",
    "left",
  ]) {
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.evaluate((gesture) => {
      const target = document.querySelector(".presenter-slide");
      const finger = (identifier, clientX, clientY, receiver = target) =>
        new Touch({ identifier, target: receiver, clientX, clientY });
      const send = (type, touches, changedTouches, receiver = target) =>
        receiver.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            touches,
            targetTouches: touches.filter((touch) => touch.target === receiver),
            changedTouches,
          }),
        );
      if (gesture.startsWith("pinch")) {
        const secondTarget =
          gesture === "pinch controls"
            ? document.querySelector('[aria-label="Next slide"]')
            : target;
        const first = finger(1, 200, 150),
          second = finger(2, 300, 150, secondTarget);
        send("touchstart", [first], [first]);
        send("touchstart", [first, second], [second], secondTarget);
        const movedFirst = finger(1, 100, 150),
          movedSecond = finger(2, 350, 150, secondTarget);
        send("touchmove", [movedFirst, movedSecond], [movedFirst]);
        send(
          "touchmove",
          [movedFirst, movedSecond],
          [movedSecond],
          secondTarget,
        );
        send("touchend", [movedFirst], [movedSecond], secondTarget);
        send("touchend", [], [movedFirst]);
      } else {
        const first = finger(1, gesture === "right" ? 150 : 250, 150);
        const last = finger(
          1,
          gesture === "right"
            ? 250
            : gesture === "vertical"
              ? 180
              : gesture === "short"
                ? 220
                : 150,
          gesture === "vertical" ? 350 : 155,
        );
        send("touchstart", [first], [first]);
        send("touchmove", [last], [last]);
        send(gesture === "canceled" ? "touchcancel" : "touchend", [], [last]);
      }
    }, gesture);
    await expect
      .soft(page.locator(".presenter-controls"))
      .toContainText(
        gesture === "left" ? "3 / 5" : gesture === "right" ? "1 / 5" : "2 / 5",
      );
  }
});

for (const boundary of ["first", "last"]) {
  test(`keyboard navigation continues after the ${boundary} slide disables its focused button`, async ({
    page,
  }) => {
    await story(page);
    await page.getByRole("button", { name: "Present", exact: true }).click();
    if (boundary === "first") {
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".presenter-controls")).toContainText("2 / 5");
      await page
        .getByRole("button", { name: "Previous slide", exact: true })
        .press("Enter");
      await expect(page.locator(".presenter-controls")).toContainText("1 / 5");
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".presenter-controls")).toContainText("2 / 5");
    } else {
      const next = page.getByRole("button", {
        name: "Next slide",
        exact: true,
      });
      for (let i = 0; i < 4; i++) await next.press("Enter");
      await expect(page.locator(".presenter-controls")).toContainText("5 / 5");
      await page.keyboard.press("ArrowLeft");
      await expect(page.locator(".presenter-controls")).toContainText("4 / 5");
    }
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Presentation mode" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Present", exact: true }),
    ).toBeFocused();
  });
}

test("slides can be added and presentation mode is keyboard navigable", async ({
  page,
}) => {
  await story(page);
  await openNewSlideMenu(page);
  await page
    .getByRole("menuitem", { name: "Title and Content", exact: true })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 6");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".presenter-controls")).toContainText("3 / 6");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("explicit themes persist, and app environment has no logout option", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true, env: "app" });
  await page.goto("/#/home");
  await page.getByRole("button", { name: "Account and settings" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Sign out", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Appearance", exact: true }).click();
  await page.getByRole("combobox", { name: "Color mode" }).selectOption("dark");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

for (const signedIn of [false, true]) {
  test(`cloud saving succeeds without recovery storage ${signedIn ? "when already signed in" : "during the first sign-in"}`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn });
    await page.goto("/#/home");
    await page
      .getByRole("button", { name: "The big idea A clear, considered story" })
      .click();
    await page.evaluate(() => {
      indexedDB.open = () => {
        throw new Error("Recovery storage unavailable");
      };
    });
    await page.locator('[data-object="1"]').dblclick();
    const input = page.getByRole("textbox", { name: "Edit text", exact: true });
    await input.fill("Keep this title in the cloud");
    await input.press("ControlOrMeta+Enter");
    await expect(page.locator("#save-status")).toContainText("Unsaved changes");
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toContainText("Saved to Puter");
    await expect(page.locator(".account-button")).toContainText("test-user");
    await expect(page.locator("#toast")).toContainText(
      "Saved to your Puter cloud",
    );
    expect(await page.evaluate(() => window.__writes.length)).toBe(1);
    const bytes = await page.evaluate(async () =>
      Array.from(
        new Uint8Array(
          await (await puter.fs.read(window.__writes[0].path)).arrayBuffer(),
        ),
      ),
    );
    const loaded = await parseDeck(new Uint8Array(bytes));
    expect(P.getSlideText(P.getSlides(loaded)[0])).toContain(
      "Keep this title in the cloud",
    );
  });
}

test("cloud save writes a PPTX file and changes autosave to the same path", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  await addText(page);
  await expect.poll(() => page.evaluate(() => window.__writes.length)).toBe(2);
  const writes = await page.evaluate(() => window.__writes);
  expect(writes[0].path).toMatch(/\.pptx$/);
  expect(writes[0].size).toBeGreaterThan(1000);
  expect(writes[0].options.overwrite).toBe(false);
  expect(writes[1].options.overwrite).toBe(true);
  expect(writes[1].path).toBe(writes[0].path);
});

test("autosave does not upload a revision the Save button already saved", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  // An edit schedules an autosave; saving by hand first leaves it nothing to do.
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#toast")).toHaveText("Saved to your Puter cloud.");
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => window.__writes.length)).toBe(2);
  // A later edit still autosaves.
  await addText(page);
  await expect.poll(() => page.evaluate(() => window.__writes.length)).toBe(3);
});

test("cloud failures retain recoverable local work", async ({ page }) => {
  await mockPuter(page, { signedIn: true, failWrite: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#toast")).toContainText("Cloud save failed");
  await expect(page.locator("#save-status")).toContainText(
    "Saved on this device",
  );
  await reloadLibrary(page);
  await expect(
    page.getByRole("button", { name: "Untitled presentation Recovery draft" }),
  ).toBeVisible();
});

test("editor accessibility and blank canvas insertion", async ({ page }) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  await addText(page);
  await inspector(page);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("imports a .pptx file without losing slide content", async ({ page }) => {
  await start(page);
  const bytes = await P.savePresentation(createDeck("pitch"));
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Pitch.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "alt",
    /Small idea/,
  );
});

for (const reselect of [false, true]) {
  test(`applying the current theme ${reselect ? "after reselecting it " : ""}preserves redo history`, async ({
    page,
  }) => {
    await story(page);
    await addText(page);
    await expect(page.locator(".object-hit")).toHaveCount(8);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.locator(".object-hit")).toHaveCount(7);
    await expect(
      page.getByRole("button", { name: "Redo", exact: true }),
    ).toBeEnabled();
    await themeDialog(page);
    if (reselect) {
      await page.getByRole("button", { name: "Midnight", exact: true }).click();
      await page.getByRole("button", { name: "Studio", exact: true }).click();
    }
    await page
      .getByRole("button", { name: "Apply theme", exact: true })
      .click();
    // Download waits for queued mutations, so this also verifies the final state.
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    expect(P.getSlideShapes(P.getSlides(loaded)[0])).toHaveLength(7);
    await expect(
      page.getByRole("button", { name: "Redo", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(page.locator(".object-hit")).toHaveCount(8);
  });
}

test("a theme dialog cannot recolor a different presentation opened while it was visible", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  const incoming = createDeck("story");
  const background = P.getSlideBackground(P.getSlides(incoming)[0]).color;
  await page.evaluate(
    (bytes) => {
      puter.fs.read = async () => new Blob([new Uint8Array(bytes)]);
      puter.ui.showOpenFilePicker = () =>
        new Promise((resolve) => {
          window.__releasePicker = () =>
            resolve({
              name: "Another deck.pptx",
              path: "/test/Another deck.pptx",
            });
        });
    },
    Array.from(await P.savePresentation(incoming)),
  );
  await openFileMenu(page);
  await page
    .getByRole("menuitem", { name: "Open from Puter", exact: true })
    .click();
  await page.waitForFunction(() => window.__releasePicker);
  await themeDialog(page);
  await page.getByRole("button", { name: "Midnight", exact: true }).click();
  await page.evaluate(() => window.__releasePicker());
  await expect(page).toHaveTitle("Another deck | Presentation");
  await page.getByRole("button", { name: "Apply theme", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getSlideBackground(P.getSlides(loaded)[0]).color).toBe(background);
});

test("canvas text edits, object movement, and themes survive export", async ({
  page,
}, info) => {
  await story(page);
  const title = page.getByRole("button", {
    name: "Make room for big ideas.. Select to edit",
  });
  // Text boxes are addressable from the canvas by their accessible text.
  const canvasTitle = page.locator('[data-object="1"]');
  await canvasTitle.dblclick();
  const inline = page.getByRole("textbox", { name: "Edit text" });
  await expect(inline).toBeVisible();
  await inline.fill("A clear new title");
  await inline.press("Control+Enter");
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "alt",
    /A clear new title/,
  );
  await page.locator('[data-object="1"]').click();
  await page.keyboard.press("ArrowRight");
  await inspector(page);
  await expect(page.getByRole("spinbutton", { name: "X (in)" })).toHaveValue(
    "0.81",
  );
  if (
    await page.getByRole("button", { name: "Close format panel" }).isVisible()
  )
    await page.getByRole("button", { name: "Close format panel" }).click();
  await themeDialog(page);
  await page.getByRole("button", { name: "Midnight", exact: true }).click();
  await page.getByRole("button", { name: "Apply theme", exact: true }).click();
  await expect(page.locator("#save-status")).toContainText(
    "Saved on this device",
  );
  await openFileMenu(page);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const download = await downloadPromise;
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await download.path())),
  );
  expect(P.getSlideBackground(P.getSlides(loaded)[0]).color).toBe("#18222B");
  expect(P.getSlideText(P.getSlides(loaded)[0])).toContain("A clear new title");
});

test("images retain alternative text and can be resized", async ({ page }) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  const chooser = page.waitForEvent("filechooser");
  await insertImage(page);
  await (
    await chooser
  ).setFiles({
    name: "Diagram.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await inspector(page);
  const alt = page.getByRole("textbox", { name: "Image alternative text" });
  await expect(alt).toBeVisible();
  await alt.fill("A simplified diagram");
  await alt.press("Tab");
  const width = page.getByRole("spinbutton", { name: "Width (in)" });
  await width.fill("3");
  await width.press("Tab");
  await expect(
    page.getByRole("spinbutton", { name: "Width (in)" }),
  ).toHaveValue("3");
  if (
    await page.getByRole("button", { name: "Close format panel" }).isVisible()
  )
    await page.getByRole("button", { name: "Close format panel" }).click();
  await openFileMenu(page);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const download = await downloadPromise;
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await download.path())),
  );
  const image = P.getSlideShapes(P.getSlides(loaded)[0]).find(
    (s) => P.getShapeKind(s) === "picture",
  );
  expect(P.getShapeDescription(image)).toBe("A simplified diagram");
  expect(P.getShapeBounds(image).w).toBe(P.inches(3));
  expect(P.getShapeImageBytes(image).length).toBeGreaterThan(30);
});

test("a deleted image leaves the saved file and returns with undo", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  const chooser = page.waitForEvent("filechooser");
  await insertImage(page);
  await (
    await chooser
  ).setFiles({
    name: "Diagram.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const image = page.getByRole("button", {
    name: "Image: Diagram.png. Select to edit",
  });
  await expect(image).toHaveClass(/selected/);
  const mediaParts = async () => {
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const bytes = new Uint8Array(
      await readFile(await (await downloaded).path()),
    );
    expect(P.validatePresentation(await parseDeck(bytes))).toEqual([]);
    return Object.keys(unzipSync(bytes)).filter((entry) =>
      entry.startsWith("ppt/media/"),
    );
  };
  expect(await mediaParts()).toEqual(["ppt/media/image1.png"]);
  await image.press("Delete");
  await expect(page.locator(".object-hit")).toHaveCount(0);
  // The picture's bytes do not travel on in a file that no longer shows it.
  expect(await mediaParts()).toEqual([]);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(image).toBeVisible();
  expect(await mediaParts()).toEqual(["ppt/media/image1.png"]);
});

test("the pane toggles stay in reach on every screen size", async ({
  page,
}) => {
  await story(page);
  for (const id of ["view-format-pane", "view-thumbnails"]) {
    await expect(await ribbonButton(page, "View", id)).toBeInViewport({
      ratio: 1,
    });
    await page.keyboard.press("Escape");
  }
  // The menus remain usable when the tools are folded.
  await themeDialog(page);
  await expect(
    page.getByRole("heading", { name: "Presentation theme" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("format panel toggle changes visibility on every screen size", async ({
  page,
}) => {
  await story(page);
  const panel = page.getByRole("complementary", { name: "Format panel" });
  const wasVisible = await panel.isVisible();
  await (await ribbonButton(page, "View", "view-format-pane")).click();
  if (wasVisible) await expect(panel).toBeHidden();
  else await expect(panel).toBeVisible();
  await (await ribbonButton(page, "View", "view-format-pane")).click();
  if (wasVisible) await expect(panel).toBeVisible();
  else await expect(panel).toBeHidden();
});

for (const [id, panelName] of [
  ["view-format-pane", "Format panel"],
  ["view-thumbnails", "Slide navigator"],
]) {
  test(`the ${panelName} toggle exposes the panel's visibility`, async ({
    page,
  }) => {
    await story(page);
    const panel = page.getByRole("complementary", {
      name: panelName,
      includeHidden: true,
    });
    const check = async () => {
      const toggle = await ribbonButton(page, "View", id);
      await expect(toggle).toHaveAttribute(
        "aria-pressed",
        String(await panel.isVisible()),
      );
      await page.keyboard.press("Escape");
      expect(await panel.getAttribute("id")).toBeTruthy();
    };
    await check();
    if (panelName === "Format panel") {
      const viewport = page.viewportSize();
      for (const width of [1440, 1000, viewport.width]) {
        await page.setViewportSize({ width, height: viewport.height });
        await check();
      }
    }
    for (let count = 0; count < 2; count++) {
      const visible = await panel.isVisible();
      await (await ribbonButton(page, "View", id)).click();
      await expect(panel).toBeVisible({ visible: !visible });
      await check();
    }
    if (panelName === "Format panel" && page.viewportSize().width <= 1150) {
      if (!(await panel.isVisible()))
        await (await ribbonButton(page, "View", id)).click();
      await page
        .getByRole("button", { name: "Close format panel", exact: true })
        .click();
      await expect(panel).toBeHidden();
      await check();
    }
  });
}

test("closing the format panel returns keyboard focus to the slide", async ({
  page,
}) => {
  if (page.viewportSize().width > 1150)
    await page.setViewportSize({ width: 1000, height: 900 });
  await story(page);
  await inspector(page);
  const close = page.getByRole("button", {
    name: "Close format panel",
    exact: true,
  });
  await close.focus();
  await close.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "Format panel" }),
  ).toBeHidden();
  await expect(page.locator("#main")).toBeFocused();
  // Its toggle opens it again from the keyboard.
  const toggle = await ribbonButton(page, "View", "view-format-pane");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "Format panel" }),
  ).toBeVisible();
});

test("buttons that open menus announce the menu and whether it is open", async ({
  page,
}) => {
  await story(page);
  const openers = [
    page.getByRole("button", { name: "New Slide layouts" }),
    page
      .getByRole("menubar")
      .getByRole("menuitem", { name: "Insert", exact: true }),
    page.getByRole("button", { name: "File options" }),
    page.getByRole("button", { name: "Account and settings" }),
    page.getByRole("button", { name: "Options for slide 2" }),
  ];
  const shown = [];
  for (const opener of openers) {
    // Phones hide the menu bar and the account button, and fold the ribbon's
    // New Slide into its group; the desktop has no File options button.
    if (!(await opener.isVisible())) continue;
    shown.push(opener);
    await expect(opener).toHaveAttribute("aria-haspopup", "menu");
    await expect(opener).toHaveAttribute("aria-expanded", "false");
    await opener.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(opener).toHaveAttribute("aria-expanded", "false");
    await expect(opener).toBeFocused();
  }
  // Opening one menu from another moves the state along with it.
  await shown[0].click();
  await shown[1].click();
  await expect(shown[0]).toHaveAttribute("aria-expanded", "false");
  await expect(shown[1]).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  // Buttons without a menu stay as they are.
  await expect(
    page.getByRole("button", { name: "Present", exact: true }),
  ).not.toHaveAttribute("aria-haspopup");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const fileOptions = page.getByRole("button", {
    name: "Options for The big idea",
  });
  await expect(fileOptions).toHaveAttribute("aria-haspopup", "menu");
  await fileOptions.click();
  await expect(fileOptions).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(fileOptions).toHaveAttribute("aria-expanded", "false");
});

test("keyboard activation respects toolbar buttons and open menus", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await page.getByRole("button", { name: "Present", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await openShapeMenu(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".object-hit")).toHaveCount(8);
  // Menu navigation must not also nudge the previously selected title.
  await page.locator('[data-object="1"]').click({ position: { x: 8, y: 8 } });
  await inspector(page);
  await expect(page.getByRole("spinbutton", { name: "Y (in)" })).toHaveValue(
    "1.8",
  );
});

test("a queued rename is skipped when the first save has already assigned its requested name", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.evaluate(() => {
    const write = puter.fs.write;
    puter.fs.write = async (path, ...args) => {
      await new Promise((resolve) => (window.__releaseWrite = resolve));
      return write("Presentations/Untitled presentation (1).pptx", ...args);
    };
    window.__renameCalls = 0;
    puter.fs.rename = async () => {
      window.__renameCalls++;
      throw new Error("The destination already exists.");
    };
  });
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await page.waitForFunction(() => window.__releaseWrite);
  await page.locator(".document-title").click();
  await page
    .getByRole("textbox", { name: "Presentation name" })
    .fill("Untitled presentation (1)");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^(Save|Sign in to save)$/ })
    .click();
  await page.evaluate(() => window.__releaseWrite());
  await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
  expect(await page.evaluate(() => window.__renameCalls)).toBe(0);
  await expect(page.locator(".document-title")).toHaveText(
    "Untitled presentation (1)",
  );
});

for (const edited of [false, true]) {
  test(`a rename dialog ${edited ? "keeps an explicit edit" : "keeps an unchanged value inactive"} when a first save assigns a new filename`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await expect(
      page.getByRole("button", { name: "Account and settings" }),
    ).toContainText("test-user");
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await page.evaluate(() => {
      const write = puter.fs.write;
      puter.fs.write = async (path, bytes, options) => {
        puter.fs.write = write;
        await new Promise((resolve) => (window.__releaseWrite = resolve));
        return write(path.replace(/\.pptx$/, " (1).pptx"), bytes, options);
      };
      const rename = puter.fs.rename;
      window.__renameCalls = [];
      puter.fs.rename = (...args) => {
        window.__renameCalls.push(args);
        return rename(...args);
      };
    });
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await page.waitForFunction(() => window.__releaseWrite);
    await page.locator(".document-title").click();
    const input = page.getByRole("textbox", { name: "Presentation name" });
    await expect(input).toHaveValue("Untitled presentation");
    if (edited) await input.fill("Chosen name");
    await page.evaluate(() => window.__releaseWrite());
    await expect(page.locator(".document-title")).toHaveText(
      "Untitled presentation (1)",
    );
    await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
    await input.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".document-title")).toHaveText(
      edited ? "Chosen name" : "Untitled presentation (1)",
    );
    expect(await page.evaluate(() => window.__renameCalls)).toEqual(
      edited
        ? [
            [
              "/test/Presentations/Untitled presentation (1).pptx",
              "Chosen name.pptx",
            ],
          ]
        : [],
    );
  });
}

test("a cloud-assigned suffix beyond the input limit stays visible through download and recovery", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  const base = "x".repeat(180);
  const assigned = base + " (1)";
  const bytes = Array.from(await P.savePresentation(createDeck()));
  await page.evaluate(
    async ({ base, bytes }) => {
      await puter.fs.write(
        `Presentations/${base}.pptx`,
        new Blob([new Uint8Array(bytes)]),
        { overwrite: false },
      );
      const write = puter.fs.write;
      puter.fs.write = (path, blob, options) =>
        write(
          options.dedupeName ? path.replace(/\.pptx$/, " (1).pptx") : path,
          blob,
          options,
        );
    },
    { base, bytes },
  );
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  const title = page.locator(".document-title");
  await title.click();
  const input = page.getByRole("textbox", { name: "Presentation name" });
  await input.fill(base);
  await input.press("Enter");
  await expect(title).toHaveText(base);
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
  await expect(title).toHaveText(assigned);
  await title.click();
  await expect(input).toHaveValue(assigned);
  await input.press("Escape");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  expect((await downloaded).suggestedFilename()).toBe(assigned + ".pptx");
  await addText(page);
  await leaveWithUnsavedCloudEdits(page);
  await expect(
    page.getByRole("button", {
      name: base + " PowerPoint presentation",
      exact: true,
    }),
  ).toBeVisible();
  const cloudFile = page.getByRole("button", {
    name: assigned + " PowerPoint presentation",
    exact: true,
  });
  await expect(cloudFile).toBeVisible();
  await page
    .getByRole("button", { name: assigned + " Recovery draft", exact: true })
    .click();
  await expect(title).toHaveText(assigned);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await cloudFile.click();
  await expect(title).toHaveText(assigned);
});

test("a duplicate first-save name follows the cloud filename throughout the editor and recovery", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toContainText("test-user");
  await page.evaluate(() => {
    const write = puter.fs.write;
    puter.fs.write = async (path, blob, options) => {
      if (options.dedupeName) {
        const files = await puter.fs.readdir();
        const name = path.split("/").pop();
        if (files.some((file) => file.name === name))
          path = path.replace(/\.pptx$/, " (1).pptx");
      }
      return write(path, blob, options);
    };
  });
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  await expect(page.locator(".document-title")).toHaveText(
    "Untitled presentation (1)",
  );
  await expect(page).toHaveTitle("Untitled presentation (1) | Presentation");
  await expect(page.locator("#save-status")).toHaveAttribute(
    "title",
    "/test/Presentations/Untitled presentation (1).pptx",
  );
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  expect((await downloaded).suggestedFilename()).toBe(
    "Untitled presentation (1).pptx",
  );
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  expect(
    await page.evaluate(() =>
      window.__writes.map(({ path, options }) => ({
        path,
        overwrite: options.overwrite,
      })),
    ),
  ).toEqual([
    {
      path: "/test/Presentations/Untitled presentation.pptx",
      overwrite: false,
    },
    {
      path: "/test/Presentations/Untitled presentation (1).pptx",
      overwrite: false,
    },
    {
      path: "/test/Presentations/Untitled presentation (1).pptx",
      overwrite: true,
    },
  ]);
  await addText(page);
  await leaveWithUnsavedCloudEdits(page);
  await page
    .getByRole("button", {
      name: "Untitled presentation (1) Recovery draft",
      exact: true,
    })
    .click();
  await expect(page.locator(".document-title")).toHaveText(
    "Untitled presentation (1)",
  );
  await expect(page.locator(".object-hit")).toHaveCount(1);
});

for (const delayedRefresh of [false, true]) {
  test(`a cloud save completed in the library ${delayedRefresh ? "keeps later saves independent of a delayed refresh" : "appears without interrupting search"}`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await expect(
      page.getByRole("button", { name: "Account and settings" }),
    ).toContainText("test-user");
    await page.evaluate(() => {
      const write = puter.fs.write;
      puter.fs.write = async (...args) => {
        await new Promise((resolve) => {
          window.__releaseWrite = resolve;
        });
        window.__releaseWrite = null;
        return write(...args);
      };
    });
    await page
      .getByRole("button", { name: "The big idea A clear, considered story" })
      .click();
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await page.waitForFunction(() => window.__releaseWrite);
    await page.getByRole("button", { name: "Back to presentations" }).click();
    const cloudFile = page.getByRole("button", {
      name: "The big idea PowerPoint presentation",
      exact: true,
    });
    await expect(cloudFile).toHaveCount(0);
    const search = page.getByRole("searchbox", {
      name: "Search presentations",
    });
    await search.fill("big");
    await search.evaluate((input) => input.setSelectionRange(1, 2));
    if (delayedRefresh)
      await page.evaluate(() => {
        const list = puter.fs.readdir;
        puter.fs.readdir = async (...args) => {
          await new Promise((resolve) => (window.__releaseListing = resolve));
          return list(...args);
        };
      });
    await page.evaluate(() => window.__releaseWrite());
    if (delayedRefresh) {
      await page.waitForFunction(() => window.__releaseListing);
      await page
        .getByRole("button", { name: "New presentation", exact: true })
        .click();
      await page
        .getByRole("button", { name: /^(Save|Sign in to save)$/ })
        .click();
      await expect
        .poll(() => page.evaluate(() => !!window.__releaseWrite))
        .toBe(true);
      await page.evaluate(() => window.__releaseWrite());
      await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
      await page.evaluate(() => window.__releaseListing());
      await expect(page).toHaveTitle("Untitled presentation | Presentation");
      await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
      return;
    }
    await expect(cloudFile).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("big");
    expect(
      await search.evaluate((input) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual([1, 2]);
    await cloudFile.click();
    await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
    await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
  });
}

test("recovery after an overlapping first cloud save keeps newer edits and the saved path", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toContainText("test-user");
  await page.evaluate(() => {
    const write = puter.fs.write;
    puter.fs.write = async (...args) => {
      puter.fs.write = write;
      await new Promise((resolve) => (window.__releaseWrite = resolve));
      return write(...args);
    };
  });
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await page.waitForFunction(() => window.__releaseWrite);
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", {
      name: "Untitled presentation Recovery draft",
      exact: true,
    })
    .click();
  await page.evaluate(() => window.__releaseWrite());
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await expect(page.locator("#save-status")).toHaveAttribute(
    "title",
    "/test/Presentations/Untitled presentation.pptx",
  );
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
  expect(
    await page.evaluate(() =>
      window.__writes.map(({ path, options }) => ({
        path,
        overwrite: options.overwrite,
      })),
    ),
  ).toEqual([
    {
      path: "/test/Presentations/Untitled presentation.pptx",
      overwrite: false,
    },
    { path: "/test/Presentations/Untitled presentation.pptx", overwrite: true },
  ]);
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(
        await (await puter.fs.read(window.__writes.at(-1).path)).arrayBuffer(),
      ),
    ),
  );
  const loaded = await parseDeck(new Uint8Array(bytes));
  expect(P.getSlideShapes(P.getSlides(loaded)[0])).toHaveLength(1);
});

test("a pending cloud save does not mark a different presentation as saving", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toContainText("test-user");
  await page.evaluate(() => {
    const write = puter.fs.write;
    window.__completedWrites = 0;
    puter.fs.write = async (...args) => {
      await new Promise((resolve) => {
        window.__releaseWrite = resolve;
      });
      window.__releaseWrite = null;
      const file = await write(...args);
      window.__completedWrites++;
      return file;
    };
  });
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await page.waitForFunction(() => window.__releaseWrite);
  await expect(page.locator("#save-status")).toHaveText("Saving…");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await page.evaluate(() => window.__releaseWrite());
  await page.waitForFunction(() => window.__completedWrites === 1);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await expect(page).toHaveTitle("The big idea | Presentation");
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await page.waitForFunction(() => window.__releaseWrite);
  await expect(page.locator("#save-status")).toHaveText("Saving…");
  await page.evaluate(() => window.__releaseWrite());
  await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
  await expect(page.locator("#save-status")).toHaveAttribute(
    "title",
    "/test/Presentations/The big idea.pptx",
  );
});

test("renaming during a slow cloud save keeps subsequent writes on the renamed path", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  await page.evaluate(() => {
    const write = puter.fs.write;
    let delay = true;
    puter.fs.write = async (...args) => {
      if (delay) {
        delay = false;
        await new Promise((resolve) => {
          window.__releaseWrite = resolve;
        });
      }
      return write(...args);
    };
  });
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await page.waitForFunction(() => window.__releaseWrite);
  await page.locator(".document-title").click();
  await page
    .getByRole("textbox", { name: "Presentation name" })
    .fill("Renamed deck");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^(Save|Sign in to save)$/ })
    .click();
  await page.evaluate(() => window.__releaseWrite());
  await expect(page.locator(".document-title")).toHaveText("Renamed deck");
  await expect(page.locator("#save-status")).not.toContainText("Saving…");
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect
    .poll(() => page.evaluate(() => window.__writes.at(-1).path))
    .toBe("/test/Presentations/Renamed deck.pptx");
});

test("a pending sign-out prevents starting work that its completion would discard", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toContainText("test-user");
  const template = page.getByRole("button", {
    name: "The big idea A clear, considered story",
  });
  const box = await template.boundingBox();
  await page.evaluate(() => {
    const signOut = puter.auth.signOut;
    puter.auth.signOut = async () => {
      await new Promise((resolve) => (window.__releaseSignOut = resolve));
      return signOut();
    };
  });
  await page.getByRole("button", { name: "Account and settings" }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.waitForFunction(() => window.__releaseSignOut);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".editor")).toHaveCount(0);
  const progress = page.getByRole("dialog", {
    name: "Signing out",
    exact: true,
  });
  await expect(progress).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(progress).toBeVisible();
  await page.evaluate(() => window.__releaseSignOut());
  await expect(
    page.getByRole("button", { name: "Connect Puter", exact: true }),
  ).toBeVisible();
  await expect(progress).toHaveCount(0);
  await template.click();
  await expect(page.locator("#slide-count")).toHaveText("5");
});

test("a failed sign-out restores access to the signed-in library", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toContainText("test-user");
  await page.evaluate(() => {
    puter.auth.signOut = async () => {
      await new Promise((resolve) => (window.__releaseSignOut = resolve));
      throw new Error("Sign-out unavailable");
    };
  });
  await page.getByRole("button", { name: "Account and settings" }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.waitForFunction(() => window.__releaseSignOut);
  await expect(
    page.getByRole("dialog", { name: "Signing out", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.__releaseSignOut());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#toast")).toHaveText("Sign-out unavailable");
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toContainText("test-user");
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(page.locator("#slide-count")).toHaveText("1");
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
});

test("signing out clears account files even when device storage fails", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const file = page.getByRole("button", {
    name: "Untitled presentation PowerPoint presentation",
    exact: true,
  });
  await expect(file).toBeVisible();
  await page.evaluate(() => {
    indexedDB.open = () => {
      throw new Error("Device storage unavailable");
    };
  });
  await page.getByRole("button", { name: "Account and settings" }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect Puter" }),
  ).toBeVisible();
  await expect(
    page.getByText("Could not load your presentations.", { exact: false }),
  ).toBeVisible();
  await expect(file).toHaveCount(0);
});

for (const shortcut of ["Escape", "Control+Enter", "Meta+Enter"]) {
  test(`${shortcut} returns focus to the canvas object after inline text editing`, async ({
    page,
  }) => {
    await story(page);
    const hit = page.locator('[data-object="1"]');
    await hit.click();
    await hit.press("Enter");
    const input = page.getByRole("textbox", { name: "Edit text", exact: true });
    const original = await input.evaluate((node) => node.innerText);
    await input.fill("Continue keyboard editing");
    await input.press(shortcut);
    await expect(input).toHaveCount(0);
    await expect(hit).toBeFocused();
    await hit.press("Enter");
    await expect(input).toBeFocused();
    // Each of them keeps what was typed; undo takes it back.
    await expect(input).toHaveText("Continue keyboard editing", {
      useInnerText: true,
    });
    await input.press("Escape");
    await expect(hit).toBeFocused();
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    expect(P.getShapeText(P.getSlideShapes(P.getSlides(loaded)[0])[1])).toBe(
      "Continue keyboard editing",
    );
    await hit.press("ControlOrMeta+z");
    await expect(hit).not.toHaveAccessibleName(/Continue keyboard editing/);
    await expect(hit).toHaveAccessibleName(
      new RegExp(original.trim().split(/\s+/)[0]),
    );
  });
}

test("repeated Present clicks during a pending edit open one presentation", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      indexedDB.open = open;
      const request = open(...args);
      Object.defineProperty(request, "onsuccess", {
        set(callback) {
          request.addEventListener(
            "success",
            (event) => {
              window.__releaseDraft = () => callback(event);
            },
            { once: true },
          );
        },
      });
      return request;
    };
  });
  await page.locator('[data-object="1"]').click();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => window.__releaseDraft);
  const present = page.getByRole("button", { name: "Present", exact: true });
  await present.click();
  await present.click();
  await page.evaluate(() => window.__releaseDraft());
  await expect(page.locator("dialog.presenter")).toHaveCount(1);
  await expect(page.locator(".presenter-controls")).toContainText("1 / 5");
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await expect(page.locator("dialog.presenter")).toHaveCount(0);
  await expect(present).toBeFocused();
  await present.click();
  await expect(page.locator("dialog.presenter")).toHaveCount(1);
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await expect(page.locator("dialog.presenter")).toHaveCount(0);
});

test("presentation mode retains its original deck when a pending import finishes", async ({
  page,
}) => {
  await story(page);
  const secondSlide = await page
    .locator(".slide-thumb img")
    .nth(1)
    .getAttribute("src");
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      File.prototype.arrayBuffer = read;
      return new Promise((resolve) => {
        window.__releaseImport = async () => resolve(await read.call(this));
      });
    };
  });
  const pres = createDeck("blank");
  P.setSlideSize(pres, { width: P.inches(7.5), height: P.inches(10) });
  await openFileMenu(page);
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("menuitem", { name: "Import PPTX", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "Incoming deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await page.waitForFunction(() => window.__releaseImport);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presenter-controls")).toContainText("1 / 5");
  await page.evaluate(() => window.__releaseImport());
  await expect(page.locator(".document-title")).toHaveText("Incoming deck");
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await expect(page.locator(".presenter-slide")).toHaveAttribute(
    "src",
    secondSlide,
  );
  await expect(page.locator(".presenter-controls")).toContainText("2 / 5");
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await expect(page.locator(".document-title")).toHaveText("Incoming deck");
  await expect(page.locator("#slide-count")).toHaveText("1");
});

test("presentation starts on the selected visible slide when earlier slides are hidden", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("story");
  P.setSlideHidden(P.getSlides(pres)[0], true);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Hidden.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await page.getByRole("button", { name: /^Slide 2:/ }).click();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presenter-slide")).toHaveAttribute(
    "alt",
    /Where we are today/,
  );
  await expect(page.locator(".presenter-controls")).toContainText("1 / 4");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".presenter-slide")).toHaveAttribute(
    "alt",
    /See the bigger picture/,
  );
});

test("slide navigation retains keyboard focus and reuses unchanged thumbnails", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() => {
    window.__firstThumbnail = document.querySelector(".slide-thumb img");
  });
  const second = page.getByRole("button", { name: /^Slide 2:/ });
  await second.focus();
  // Space opens the slide (Enter there adds one after it).
  await page.keyboard.press("Space");
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 5");
  await expect(second).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        window.__firstThumbnail === document.querySelector(".slide-thumb img"),
    ),
  ).toBe(true);
  await expect(second).toHaveAttribute("aria-current", "true");
  await expect(
    page.getByRole("button", { name: /^Slide 1:/ }),
  ).not.toHaveAttribute("aria-current", "true");
  // Enter on a thumbnail adds a slide after that one, current or not.
  await page.getByRole("button", { name: /^Slide 4:/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#slide-position")).toHaveText("Slide 5 of 6");
});

test("duplicating at the slide limit keeps the recovery draft loadable", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck();
  for (let i = 1; i < 300; i++) P.addBlankSlide(pres);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Limit.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 300");
  await page
    .getByRole("button", { name: "Options for slide 1", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Duplicate slide", exact: true })
    .click();
  await expect(page.locator("#toast")).toContainText("The slide limit is 300.");
  await expect(page.locator("#slide-count")).toHaveText("300");
  await reloadLibrary(page);
  await page
    .getByRole("button", { name: "Limit Recovery draft", exact: true })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 300");
});

test("an edit immediately after undo keeps both operations in order", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(2);
  await installAddTextNow(page);
  await page.evaluate(() => {
    document.querySelector("#undo").click();
    window.__addTextNow();
  });
  await expect(page.locator(".object-hit")).toHaveCount(2);
  await expect(page.locator("#redo")).toBeDisabled();
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", {
      name: "Untitled presentation Recovery draft",
      exact: true,
    })
    .click();
  await expect(page.locator(".object-hit")).toHaveCount(2);
});

test("a failed library load is not presented as an empty library", async ({
  page,
}) => {
  await start(page);
  await expect(
    page.getByRole("heading", { name: "Your next story starts here" }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__readdir = puter.fs.readdir;
    puter.fs.readdir = async () => {
      throw new Error("Storage is unavailable");
    };
  });
  await page.getByRole("button", { name: "Connect Puter" }).click();
  await expect(page.locator(".error-row")).toContainText(
    "Could not load your presentations",
  );
  await expect(
    page.getByRole("heading", { name: "Your next story starts here" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Import a presentation", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    puter.fs.readdir = window.__readdir;
  });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".error-row")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Your next story starts here" }),
  ).toBeVisible();
});

test("the library shows a loading state until the account and drafts are checked", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true, delayAuth: true });
  await page.goto("/#/home");
  await page.waitForFunction(() => window.__releaseAuth);
  const list = page.locator("#file-list");
  await expect(list).toContainText("Loading your presentations");
  await expect(list).not.toContainText("Your next story starts here");
  await expect(
    page.getByRole("button", { name: "Import a presentation", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.__releaseAuth());
  await expect(list).toContainText("Your next story starts here");
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toContainText("test-user");
});

test("late account initialization preserves work already started", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true, delayAuth: true });
  await page.goto("/#/home");
  await page.waitForFunction(() => window.__releaseAuth);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.evaluate(() => window.__releaseAuth());
  await expect(
    page.getByRole("button", {
      name: "Account and settings",
      includeHidden: true,
    }),
  ).toContainText("test-user");
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", {
      name: "Untitled presentation Recovery draft",
      exact: true,
    })
    .click();
  await expect(page.locator(".object-hit")).toHaveCount(1);
});

for (const [navigation, field] of [
  ["import", "canvas"],
  ["import", "notes"],
  ["import", "width"],
  ["back", "canvas"],
  ["slide", "canvas"],
  ["slide", "notes"],
  ["slide", "width"],
]) {
  test(`${field} edits made during a pending ${navigation} are kept in recovery`, async ({
    page,
  }) => {
    await story(page);
    if (navigation === "import") {
      await page.evaluate(() => {
        const read = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = function () {
          File.prototype.arrayBuffer = read;
          return new Promise(
            (resolve) =>
              (window.__releaseNavigation = async () =>
                resolve(await read.call(this))),
          );
        };
      });
      await openFileMenu(page);
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("menuitem", { name: "Import PPTX", exact: true })
        .click();
      await (
        await chooser
      ).setFiles({
        name: "Incoming.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        buffer: Buffer.from(await P.savePresentation(createDeck("blank"))),
      });
      await page.waitForFunction(() => window.__releaseNavigation);
    } else {
      await page.evaluate(() => {
        const open = indexedDB.open.bind(indexedDB);
        indexedDB.open = (...args) => {
          indexedDB.open = open;
          const request = open(...args);
          Object.defineProperty(request, "onsuccess", {
            set(callback) {
              request.addEventListener(
                "success",
                (event) => (window.__releaseNavigation = () => callback(event)),
                { once: true },
              );
            },
          });
          return request;
        };
      });
      await addText(page);
      await page.waitForFunction(() => window.__releaseNavigation);
      if (navigation === "back")
        await page
          .getByRole("button", { name: "Back to presentations" })
          .click();
      else await page.getByRole("button", { name: /^Slide 2:/ }).click();
    }
    if (field === "canvas") {
      await page.locator('[data-object="1"]').dblclick();
      await page
        .getByRole("textbox", { name: "Edit text", exact: true })
        .fill("Typed while navigation was pending");
    } else if (field === "notes") {
      await page
        .getByRole("textbox", { name: "Speaker notes", exact: true })
        .fill("Notes entered while navigation was pending");
    } else {
      await page.locator('[data-object="1"]').click();
      await inspector(page);
      await page
        .getByRole("spinbutton", { name: "Width (in)", exact: true })
        .fill("3");
    }
    await page.evaluate(() => window.__releaseNavigation());
    if (navigation === "import") {
      await expect(page.locator(".document-title")).toHaveText("Incoming");
      await page.getByRole("button", { name: "Back to presentations" }).click();
    } else if (navigation === "slide") {
      await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 5");
      await page.getByRole("button", { name: "Back to presentations" }).click();
    }
    await page
      .getByRole("button", { name: "The big idea Recovery draft", exact: true })
      .click();
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const firstSlide = P.getSlides(loaded)[0];
    const title = P.getSlideShapes(firstSlide)[1];
    if (field === "canvas")
      expect(P.getShapeText(title)).toBe("Typed while navigation was pending");
    else if (field === "notes")
      expect(P.getSlideNotes(firstSlide)).toBe(
        "Notes entered while navigation was pending",
      );
    else expect(P.getShapeBoundsResolved(loaded, title).w).toBe(P.inches(3));
  });
}

test("a download retains its presentation when navigation is already waiting on an edit", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      indexedDB.open = open;
      const request = open(...args);
      Object.defineProperty(request, "onsuccess", {
        set(callback) {
          request.addEventListener(
            "success",
            (event) => {
              window.__releaseDraft = () => callback(event);
            },
            { once: true },
          );
        },
      });
      return request;
    };
  });
  await addText(page);
  await page.waitForFunction(() => window.__releaseDraft);
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await openFileMenu(page);
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const downloaded = page.waitForEvent("download", { timeout: 5000 });
  await page.evaluate(() => window.__releaseDraft());
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("The big idea.pptx");
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await download.path())),
  );
  expect(P.getSlideShapes(P.getSlides(loaded)[0])).toHaveLength(8);
});

for (const signedIn of [false, true]) {
  test(`renaming a ${signedIn ? "cloud" : "local"} deck updates its displayed name when recovery storage fails`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn });
    await page.goto("/#/home");
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    if (signedIn) {
      await page
        .getByRole("button", { name: /^(Save|Sign in to save)$/ })
        .click();
      await expect(page.locator("#save-status")).toContainText(
        "Saved to Puter",
      );
    } else
      await expect(page.locator("#save-status")).toContainText(
        "Saved on this device",
      );
    await page.evaluate(() => {
      indexedDB.open = () => {
        throw new Error("Recovery storage unavailable");
      };
    });
    await page.locator(".document-title").click();
    await page
      .getByRole("textbox", { name: "Presentation name" })
      .fill("Renamed despite storage failure");
    await page
      .getByRole("textbox", { name: "Presentation name" })
      .press("Enter");
    // The failure is reported in the app's own words, not the browser's.
    await expect(page.locator("#toast")).toHaveText(
      "Device storage is unavailable. Save to Puter or download a copy to keep your work.",
    );
    await expect(page.locator(".document-title")).toHaveText(
      "Renamed despite storage failure",
    );
    await expect(page).toHaveTitle(
      "Renamed despite storage failure | Presentation",
    );
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    expect((await downloaded).suggestedFilename()).toBe(
      "Renamed despite storage failure.pptx",
    );
  });
}

test("a failed recovery save replaces the previous saved status with unsaved changes", async ({
  page,
}) => {
  await story(page);
  await expect(page.locator("#save-status")).toContainText(
    "Saved on this device",
  );
  await page.evaluate(() => {
    indexedDB.open = () => {
      throw new Error("Recovery storage unavailable");
    };
  });
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await expect(page.locator("#toast")).toContainText(
    "Device storage is unavailable",
  );
  await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
  const warns = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(warns).toBe(true);
});

test("Enter confirms a presentation rename from its name field", async ({
  page,
}) => {
  await story(page);
  await page.locator(".document-title").click();
  const name = page.getByRole("textbox", { name: "Presentation name" });
  await name.fill("Keyboard renamed deck");
  await name.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".document-title")).toHaveText(
    "Keyboard renamed deck",
  );
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(
    page.getByRole("button", {
      name: "Keyboard renamed deck Recovery draft",
      exact: true,
    }),
  ).toBeVisible();
});

for (const [width, height] of [
  [13.333, 7.5],
  [10, 7.5],
  [7.5, 10],
]) {
  test(`print-to-PDF preserves a ${width} by ${height} inch slide size`, async ({
    page,
  }) => {
    await start(page);
    const pres = createDeck("blank");
    P.setSlideSize(pres, { width: P.inches(width), height: P.inches(height) });
    const hidden = P.duplicateSlide(pres, P.getSlides(pres)[0]);
    P.setSlideHidden(hidden, true);
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "Print size.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from(await P.savePresentation(pres)),
    });
    await expect(page.locator("#slide-count")).toHaveText("2");
    await page.evaluate(() => {
      window.print = () => {
        window.__printStarted = true;
      };
      const timeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => {
        if (window.__printStarted && delay === 1000) {
          window.__finishPrint = () => callback(...args);
          return 0;
        }
        return timeout(callback, delay, ...args);
      };
    });
    await printFromMenu(page);
    await page.waitForFunction(() => window.__printStarted);
    const pdf = await page.pdf({ preferCSSPageSize: true });
    const pages = [
      ...pdf
        .toString("latin1")
        .matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g),
    ];
    expect(pages).toHaveLength(1);
    expect(Number(pages[0][1])).toBeCloseTo(width * 72, 0);
    expect(Number(pages[0][2])).toBeCloseTo(height * 72, 0);
    await page.evaluate(() => window.__finishPrint());
    await expect(page.locator("#print-slides")).toHaveCount(0);
  });
}

for (const modifier of ["Control", "Meta"]) {
  test(`${modifier}+P opens Print, commits text still being edited, and prints the slides`, async ({
    page,
  }) => {
    await story(page);
    await page.evaluate(() => {
      window.print = () => {
        window.__printedSlides = [
          ...document.querySelectorAll("#print-slides img"),
        ].map((img) => img.alt);
      };
    });
    await page.locator('[data-object="1"]').dblclick();
    const input = page.getByRole("textbox", { name: "Edit text", exact: true });
    await input.fill("Print this in-progress title");
    await input.press(`${modifier}+p`);
    await page
      .getByRole("dialog", { name: "Print" })
      .getByRole("button", { name: "Print", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.__printedSlides?.length || 0))
      .toBe(5);
    expect(await page.evaluate(() => window.__printedSlides[0])).toContain(
      "Print this in-progress title",
    );
    await expect(input).toHaveCount(0);
    await expect(page.locator("#save-status")).toContainText(
      "Saved on this device",
    );
  });
}

test("a superseded print request cannot open another print dialog after its images finish", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() => {
    window.__printCalls = 0;
    window.print = () => window.__printCalls++;
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      const ready = decode.call(this);
      if (this.closest("#print-slides") && !window.__heldPrint) {
        window.__heldPrint = true;
        return ready.then(
          () =>
            new Promise((resolve) => (window.__releasePrintImage = resolve)),
        );
      }
      return ready;
    };
  });
  const print = async () => {
    await printFromMenu(page);
  };
  await print();
  await page.waitForFunction(() => window.__releasePrintImage);
  expect(await page.evaluate(() => window.__printCalls)).toBe(0);
  await print();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
  await page.evaluate(async () => {
    window.__releasePrintImage();
    await new Promise(requestAnimationFrame);
  });
  expect(await page.evaluate(() => window.__printCalls)).toBe(1);
});

for (const destination of ["library", "another presentation"]) {
  test(`leaving a deck for ${destination} cancels its pending print request`, async ({
    page,
  }) => {
    await story(page);
    await page.evaluate(() => {
      window.__printCalls = 0;
      window.print = () => window.__printCalls++;
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () {
        const ready = decode.call(this);
        if (this.closest("#print-slides") && !window.__heldPrint) {
          window.__heldPrint = true;
          return ready.then(
            () =>
              new Promise((resolve) => (window.__releasePrintImage = resolve)),
          );
        }
        return ready;
      };
    });
    await printFromMenu(page);
    await page.waitForFunction(() => window.__releasePrintImage);
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await expect(
      page.getByRole("button", { name: "New presentation", exact: true }),
    ).toBeVisible();
    if (destination === "another presentation") {
      await page
        .getByRole("button", { name: "New presentation", exact: true })
        .click();
      await expect(page.locator("#slide-count")).toHaveText("1");
    }
    await page.evaluate(async () => {
      window.__releasePrintImage();
      await new Promise(requestAnimationFrame);
    });
    expect(await page.evaluate(() => window.__printCalls)).toBe(0);
    await expect(page.locator("#print-slides")).toHaveCount(0);
    if (destination === "another presentation") {
      await printFromMenu(page);
      await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
    }
  });
}

test("printing an all-hidden deck explains why there is nothing to print", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  P.setSlideHidden(P.getSlides(pres)[0], true);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "All hidden.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator("#slide-count")).toHaveText("1");
  await page.evaluate(() => {
    window.__printCalls = 0;
    window.print = () => window.__printCalls++;
  });
  await printFromMenu(page);
  await expect(page.locator("#toast")).toHaveText(
    "There are no visible slides to print.",
  );
  expect(await page.evaluate(() => window.__printCalls)).toBe(0);
  await expect(page.locator("#print-slides")).toHaveCount(0);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator("#toast")).toHaveText(
    "There are no visible slides to present.",
  );
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toHaveCount(0);
});

test("Puter export failures are reported instead of claiming a download", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true, env: "app" });
  await page.goto("/#/home");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(() => {
    puter.ui.showSaveFilePicker = async () => {
      throw new Error("Export destination unavailable");
    };
  });
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await openFileMenu(page);
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  await expect(page.locator("#toast")).toHaveText(
    "Export destination unavailable",
  );
  expect(errors).toEqual([]);
  await expect(page.locator("#save-status")).toContainText(
    "Saved on this device",
  );
});

test("keys pressed while an input method composes text leave the edit alone", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await editor.fill("Composed title");
  // Firefox and Safari report the real key during composition; Escape there
  // cancels an input-method candidate, not the text edit.
  const composing = (target, key, init = {}) =>
    target.evaluate(
      (node, [key, init]) =>
        node.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            isComposing: true,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        ),
      [key, init],
    );
  await composing(editor, "Escape");
  await composing(editor, "Enter", { ctrlKey: true });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveText("Composed title");
  await expect(editor).toBeFocused();
  await editor.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await expect(page.locator('[data-object="1"]')).toHaveAccessibleName(
    /^Composed title\./,
  );
  // The editor's own shortcuts wait for the composition too.
  const hit = page.locator('[data-object="1"]');
  await hit.click();
  await composing(hit, "Delete");
  await composing(hit, "ArrowRight");
  await expect(page.locator(".object-hit")).toHaveCount(7);
  await inspector(page);
  await expect(page.locator('input[aria-label="X (in)"]')).toHaveValue("0.8");
  await hit.press("Delete");
  await expect(page.locator(".object-hit")).toHaveCount(6);
});

test("Enter selects the focused canvas object before editing it", async ({
  page,
}) => {
  await story(page);
  const first = page.locator('[data-object="0"]');
  const title = page.locator('[data-object="1"]');
  await first.click();
  await title.focus();
  await page.keyboard.press("Enter");
  await expect(title).toHaveAttribute("aria-pressed", "true");
  await expect(first).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Edit text", exact: true }),
  ).toHaveText("Make room for\nbig ideas.", { useInnerText: true });
});

test("queued arrow keys accumulate every movement step", async ({ page }) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await page.evaluate(() => {
    const target = document.querySelector('[data-object="1"]');
    for (let i = 0; i < 5; i++) {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          shiftKey: true,
          bubbles: true,
        }),
      );
    }
  });
  await inspector(page);
  await expect(page.getByRole("spinbutton", { name: "X (in)" })).toHaveValue(
    "1.3",
  );
});

test("presentation Space shortcut respects focused controls", async ({
  page,
}) => {
  await story(page);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.keyboard.press("Space");
  await expect(page.locator(".presenter-controls")).toContainText("2 / 5");
  await page
    .getByRole("button", { name: "Previous slide", exact: true })
    .focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".presenter-controls")).toContainText("1 / 5");
  await page.getByRole("button", { name: "Exit", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toHaveCount(0);
});

test("section text keeps its contrast when switching between light and dark palettes", async ({
  page,
}) => {
  await story(page);
  for (const [theme, color] of [
    ["Midnight", "#18222b"],
    ["Studio", "#ffffff"],
  ]) {
    await themeDialog(page);
    await page.getByRole("button", { name: theme, exact: true }).click();
    await page
      .getByRole("button", { name: "Apply theme", exact: true })
      .click();
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    for (const obj of P.getSlideShapes(P.getSlides(loaded).at(-1))) {
      expect(P.getShapeRunFormat(obj, 0, 0).color.toLowerCase()).toBe(color);
    }
  }
});

test("editing one slide renders only the changed thumbnail and canvas", async ({
  page,
}) => {
  await story(page);
  const thumbnails = page.locator(".slide-thumb img");
  const first = await thumbnails.nth(0).getAttribute("src");
  const second = await thumbnails.nth(1).getAttribute("src");
  // Insert > Text box; the menu's own layout pictures are not the edit's.
  await openMenuPath(page, "Insert");
  await countSvgRenders(page);
  await page.getByRole("menuitem", { name: "Text box", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await expect(thumbnails.nth(0)).not.toHaveAttribute("src", first);
  await expect(thumbnails.nth(1)).toHaveAttribute("src", second);
  expect(await page.evaluate(() => window.__svgRenders)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(thumbnails.nth(0)).toHaveAttribute("src", first);
});

test("returning to the home screen reuses the rendered template previews", async ({
  page,
}) => {
  await story(page);
  await countSvgRenders(page);
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  await expect(page.locator(".template-preview img")).toHaveCount(3);
  for (const img of await page.locator(".template-preview img").all())
    expect(await img.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  expect(await page.evaluate(() => window.__svgRenders)).toBe(0);
});

test("undo and redo re-render only the slide whose content changed", async ({
  page,
}) => {
  await story(page);
  const thumbnails = page.locator(".slide-thumb img");
  const second = await thumbnails.nth(1).getAttribute("src");
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(8);
  const edited = await thumbnails.nth(0).getAttribute("src");
  await countSvgRenders(page);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(7);
  await expect(thumbnails.nth(0)).not.toHaveAttribute("src", edited);
  await expect(thumbnails.nth(1)).toHaveAttribute("src", second);
  expect(await page.evaluate(() => window.__svgRenders)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await expect(thumbnails.nth(0)).toHaveAttribute("src", edited);
  await expect(page.locator(".slide-image")).toHaveAttribute("src", edited);
  expect(await page.evaluate(() => window.__svgRenders)).toBeLessThanOrEqual(2);
});

test("presentation mode reuses the navigator's slide renders", async ({
  page,
}) => {
  await story(page);
  const thumbnails = page.locator(".slide-thumb img");
  const first = await thumbnails.nth(0).getAttribute("src");
  const second = await thumbnails.nth(1).getAttribute("src");
  await countSvgRenders(page);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const slide = page.locator(".presenter-slide");
  await expect(slide).toHaveAttribute("src", first);
  await page.keyboard.press("ArrowRight");
  await expect(slide).toHaveAttribute("src", second);
  await expect(page.locator(".presenter-controls [aria-live]")).toHaveText(
    "2 / 5",
  );
  expect(await page.evaluate(() => window.__svgRenders)).toBe(0);
});

test("inserted geometry is named readably on the canvas and in the object list", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Rectangle", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Circle", exact: true }).click();
  const objects = page.locator(".object-hit");
  await expect(objects).toHaveCount(2);
  await expect(objects.nth(0)).toHaveAccessibleName(
    /^Rectangle \d+\. Select to edit$/,
  );
  await expect(objects.nth(1)).toHaveAccessibleName(
    /^Circle \d+\. Select to edit$/,
  );
  await page.keyboard.press("Escape");
  await inspector(page);
  await expect(page.locator(".object-list-item")).toHaveText([
    /^Rectangle \d+$/,
    /^Circle \d+$/,
  ]);
});

test("the Circle tool inserts a circle rather than an oval", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Circle", exact: true }).click();
  await expect(page.locator(".object-hit.selected")).toHaveCount(1);
  await inspector(page);
  await expect(
    page.getByRole("spinbutton", { name: "Width (in)" }),
  ).toHaveValue("2.2");
  await expect(
    page.getByRole("spinbutton", { name: "Height (in)" }),
  ).toHaveValue("2.2");
  const hit = await page.locator(".object-hit.selected").boundingBox();
  expect(Math.abs(hit.width - hit.height)).toBeLessThan(1.5);
});

test("keyboard movement keeps the selected object focused for continued editing", async ({
  page,
}) => {
  await story(page);
  const title = page.locator('[data-object="1"]');
  await title.click();
  const preview = await page.locator(".slide-image").getAttribute("src");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".slide-image")).not.toHaveAttribute(
    "src",
    preview,
  );
  await expect(title).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Edit text", exact: true }),
  ).toBeVisible();
});

for (const commitBeforeRender of [false, true]) {
  test(`speaker notes survive a pending edit when ${commitBeforeRender ? "committed" : "still typing"}`, async ({
    page,
  }) => {
    await story(page);
    await page.evaluate(() => {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => {
        indexedDB.open = open;
        const request = open(...args);
        Object.defineProperty(request, "onsuccess", {
          set(callback) {
            request.addEventListener(
              "success",
              (event) => {
                window.__releaseDraft = () => callback(event);
              },
              { once: true },
            );
          },
        });
        return request;
      };
    });
    await addText(page);
    await page.waitForFunction(() => window.__releaseDraft);
    const notes = page.getByRole("textbox", { name: "Speaker notes" });
    await notes.fill("Keep these notes while the earlier edit finishes.");
    if (commitBeforeRender) await notes.press("Tab");
    await page.evaluate(() => window.__releaseDraft());
    await expect(page.locator(".object-hit")).toHaveCount(8);
    await expect(notes).toHaveValue(
      "Keep these notes while the earlier edit finishes.",
    );
    await notes.press("Tab");
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await page
      .getByRole("button", { name: "The big idea Recovery draft" })
      .click();
    await expect(notes).toHaveValue(
      "Keep these notes while the earlier edit finishes.",
    );
  });
}

test("a stale recovery entry uses the latest name, cloud path, and palette from another tab", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const staleEntry = page.getByRole("button", {
    name: "The big idea Recovery draft",
    exact: true,
  });
  await expect(staleEntry).toBeVisible();
  const other = await page.context().newPage();
  await mockPuter(other, { signedIn: true });
  await other.goto("/#/home");
  await other
    .getByRole("button", { name: "The big idea Recovery draft", exact: true })
    .click();
  await other.locator(".document-title").click();
  await other
    .getByRole("textbox", { name: "Presentation name" })
    .fill("Updated in another tab");
  await other
    .getByRole("textbox", { name: "Presentation name" })
    .press("Enter");
  await expect(other.locator(".document-title")).toHaveText(
    "Updated in another tab",
  );
  await themeDialog(other);
  await other.getByRole("button", { name: "Midnight", exact: true }).click();
  await other.getByRole("button", { name: "Apply theme", exact: true }).click();
  await other.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(other.locator("#save-status")).toContainText("Saved to Puter");
  const path = await other.evaluate(() => window.__writes.at(-1).path);
  await other.close();
  await staleEntry.click();
  await expect(page.locator(".document-title")).toHaveText(
    "Updated in another tab",
  );
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  await themeDialog(page);
  await expect(
    page.getByRole("button", { name: "Midnight", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await addText(page);
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  expect(await page.evaluate(() => window.__writes.at(-1).path)).toBe(path);
  expect(
    await page.evaluate(() => window.__writes.at(-1).options.overwrite),
  ).toBe(true);
});

for (const restore of ["undo", "recovery"]) {
  test(`restoring a deck through ${restore} also restores its palette`, async ({
    page,
  }) => {
    await story(page);
    await themeDialog(page);
    await page.getByRole("button", { name: "Midnight", exact: true }).click();
    await page
      .getByRole("button", { name: "Apply theme", exact: true })
      .click();
    await expect(page.locator("#save-status")).toContainText(
      "Saved on this device",
    );
    if (restore === "undo") {
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Redo", exact: true }),
      ).toBeEnabled();
    } else {
      await reloadLibrary(page);
      await page
        .getByRole("button", { name: "The big idea Recovery draft" })
        .click();
    }
    await themeDialog(page);
    await expect(
      page.getByRole("button", {
        name: restore === "undo" ? "Studio" : "Midnight",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Cobalt", exact: true }).click();
    await page
      .getByRole("button", { name: "Apply theme", exact: true })
      .click();
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    expect(
      P.getSlideBackground(P.getSlides(loaded)[0]).color.toLowerCase(),
    ).toBe("#f0f4fc");
  });
}

for (const destination of ["editor", "home"]) {
  test(`a delayed ${destination} replacement dismisses menus from the previous screen`, async ({
    page,
  }) => {
    if (destination === "editor") {
      await story(page);
      await page.evaluate(() => {
        const read = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = async function () {
          File.prototype.arrayBuffer = read;
          await new Promise(
            (resolve) => (window.__releaseTransition = resolve),
          );
          return read.call(this);
        };
      });
      await openFileMenu(page);
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("menuitem", { name: "Import PPTX", exact: true })
        .click();
      await (
        await chooser
      ).setFiles({
        name: "Imported.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        buffer: Buffer.from(await P.savePresentation(createDeck())),
      });
    } else {
      await start(page);
      await page.evaluate(() => {
        const signIn = puter.auth.signIn;
        puter.auth.signIn = async () => {
          await new Promise(
            (resolve) => (window.__releaseTransition = resolve),
          );
          return signIn();
        };
      });
      await page
        .getByRole("button", { name: "Connect Puter", exact: true })
        .click();
    }
    await page.waitForFunction(() => window.__releaseTransition);
    const anchor =
      destination === "editor"
        ? fileMenuOpener(page)
        : page.getByRole("button", {
            name: "Account and settings",
          });
    await anchor.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await page.evaluate(() => window.__releaseTransition());
    if (destination === "editor")
      await expect(page.locator(".document-title")).toHaveText("Imported");
    else await expect(anchor).toContainText("test-user");
    await expect(menu).toHaveCount(0);
    await anchor.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(anchor).toBeFocused();
  });
}

for (const [action, focusedSlide, count, source = 3] of [
  ["Move up", 2, 5],
  ["Move down", 4, 5],
  ["Delete slide", 3, 4],
  ["Delete slide", 4, 4, 5],
  ["Duplicate slide", 3, 6],
]) {
  test(`slide ${source} ${action} preserves keyboard focus in the navigator`, async ({
    page,
  }) => {
    await story(page);
    await page
      .getByRole("button", { name: `Options for slide ${source}`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
    await expect(page.locator("#slide-count")).toHaveText(String(count));
    const options = page.getByRole("button", {
      name: `Options for slide ${focusedSlide}`,
      exact: true,
    });
    await expect(options).toBeFocused();
    await options.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(options).toBeFocused();
  });
}

test("undo preserves a focused slide thumbnail through the navigator refresh", async ({
  page,
}) => {
  await story(page);
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(8);
  const thumbnail = page.locator(".slide-thumb").nth(2);
  await thumbnail.focus();
  await page.keyboard.press("Control+z");
  await expect(page.locator(".object-hit")).toHaveCount(7);
  await expect(thumbnail).toBeFocused();
  await thumbnail.press("Space");
  await expect(page.locator("#slide-position")).toHaveText("Slide 3 of 5");
});

test("a library refresh closes an outdated file menu and preserves its keyboard focus", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toContainText("test-user");
  await page.evaluate(() => {
    const write = puter.fs.write;
    puter.fs.write = async (...args) => {
      await new Promise((resolve) => (window.__releaseWrite = resolve));
      return write(...args);
    };
  });
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await page.waitForFunction(() => window.__releaseWrite);
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const draft = page.locator(".file-row").filter({
    has: page.getByRole("button", {
      name: "Untitled presentation Recovery draft",
      exact: true,
    }),
  });
  const options = draft.getByRole("button", {
    name: "Options for Untitled presentation",
    exact: true,
  });
  await options.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await page.evaluate(() => window.__releaseWrite());
  await expect(
    page.getByRole("button", {
      name: "Untitled presentation PowerPoint presentation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(menu).toHaveCount(0);
  await expect(options).toBeFocused();
  await options.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(options).toBeFocused();
});

test("scrolling the library dismisses its file menu without reversing the scroll", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page.evaluate(() => {
    puter.fs.readdir = async () =>
      Array.from({ length: 40 }, (_, index) => ({
        name: `Deck ${String(index).padStart(2, "0")}.pptx`,
        path: `/test/Deck ${index}.pptx`,
        modified: 1,
      }));
  });
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const anchor = page.getByRole("button", {
    name: "Options for Deck 10",
    exact: true,
  });
  await anchor.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const [previousScroll, expectedScroll] = await page.evaluate(() => {
    const previous = scrollY;
    window.scrollBy(0, 150);
    return [previous, scrollY];
  });
  expect(expectedScroll).toBeGreaterThan(previousScroll);
  await expect(menu).toHaveCount(0);
  await expect(anchor).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(expectedScroll);
  await anchor.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(anchor).toBeFocused();
});

test("reopening a menu cleans up its previous outside-click listener", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() => {
    window.__menuListeners = new Set();
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    document.addEventListener = (type, handler, options) => {
      if (type === "pointerdown") window.__menuListeners.add(handler);
      return add(type, handler, options);
    };
    document.removeEventListener = (type, handler, options) => {
      if (type === "pointerdown") window.__menuListeners.delete(handler);
      return remove(type, handler, options);
    };
  });
  const shape = page.getByRole("button", {
    name: "Options for slide 1",
    exact: true,
  });
  for (let i = 0; i < 3; i++) {
    await shape.click();
    // Clicking the open menu's button closes it; the next click opens it
    // again. Either way one listener at most is left behind.
    await expect
      .poll(() => page.evaluate(() => window.__menuListeners.size))
      .toBe(i % 2 ? 0 : 1);
  }
  await expect(page.getByRole("menu")).toBeVisible();
  expect(await page.evaluate(() => window.__menuListeners.size)).toBe(1);
  await page.keyboard.press("Escape");
  await expect(shape).toBeFocused();
  expect(await page.evaluate(() => window.__menuListeners.size)).toBe(0);
});

for (const destination of [
  "another slide",
  "another presentation",
  "a replacement slide",
]) {
  test(`a pending image stays with its original slide after opening ${destination}`, async ({
    page,
  }) => {
    await story(page);
    await page.evaluate(() => {
      const decode = window.createImageBitmap;
      window.createImageBitmap = (...args) =>
        new Promise((resolve, reject) => {
          window.__releaseImage = async () => {
            try {
              resolve(await decode(...args));
            } catch (error) {
              reject(error);
            }
          };
        });
    });
    const chooser = page.waitForEvent("filechooser");
    await insertImage(page);
    await (
      await chooser
    ).setFiles({
      name: "Original slide.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await page.waitForFunction(() => window.__releaseImage);
    if (destination === "another slide") {
      await page.getByRole("button", { name: /^Slide 2:/ }).click();
    } else if (destination === "a replacement slide") {
      await page
        .getByRole("button", { name: "Options for slide 1", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Delete slide", exact: true })
        .click();
      await expect(page.locator("#slide-count")).toHaveText("4");
    } else {
      await page.getByRole("button", { name: "Back to presentations" }).click();
      await page
        .getByRole("button", { name: "New presentation", exact: true })
        .click();
    }
    await page.evaluate(() => window.__releaseImage());
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const counts = P.getSlides(loaded).map(
      (s) =>
        P.getSlideShapes(s).filter((obj) => P.getShapeKind(obj) === "picture")
          .length,
    );
    expect(counts).toEqual(
      destination === "another slide"
        ? [1, 0, 0, 0, 0]
        : destination === "a replacement slide"
          ? [0, 0, 0, 0]
          : [0],
    );
  });
}

test("inline typing survives completion of an earlier edit", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      indexedDB.open = open;
      const request = open(...args);
      Object.defineProperty(request, "onsuccess", {
        set(callback) {
          request.addEventListener(
            "success",
            (event) => {
              window.__releaseDraft = () => callback(event);
            },
            { once: true },
          );
        },
      });
      return request;
    };
  });
  await addText(page);
  await page.waitForFunction(() => window.__releaseDraft);
  await page.locator('[data-object="1"]').dblclick();
  const input = page.getByRole("textbox", { name: "Edit text", exact: true });
  await input.fill("Keep this inline draft");
  await input.press("ArrowLeft");
  await page.evaluate(() => window.__releaseDraft());
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await expect(input).toBeFocused();
  await expect(input).toHaveText("Keep this inline draft");
  expect(
    await input.evaluate((node) => {
      const selection = getSelection();
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(selection.anchorNode, selection.anchorOffset);
      return range.toString().length;
    }),
  ).toBe(21);
  await input.press("Control+Enter");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "The big idea Recovery draft" })
    .click();
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "alt",
    /Keep this inline draft/,
  );
});

test("typing in the format panel survives completion of an earlier edit", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await page.evaluate(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      indexedDB.open = open;
      const request = open(...args);
      Object.defineProperty(request, "onsuccess", {
        set(callback) {
          request.addEventListener(
            "success",
            (event) => {
              window.__releaseDraft = () => callback(event);
            },
            { once: true },
          );
        },
      });
      return request;
    };
  });
  await panel(page).getByRole("button", { name: "Bold", exact: true }).click();
  await page.waitForFunction(() => window.__releaseDraft);
  const input = page.getByRole("textbox", { name: "Object text", exact: true });
  await input.fill("Keep typing while saving");
  await input.press("ArrowLeft");
  await page.evaluate(() => window.__releaseDraft());
  await expect(
    panel(page).getByRole("button", { name: "Bold", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(input).toHaveValue("Keep typing while saving");
  await expect(input).toBeFocused();
  expect(await input.evaluate((node) => node.selectionStart)).toBe(23);
  await input.press("Tab");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "The big idea Recovery draft" })
    .click();
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "alt",
    /Keep typing while saving/,
  );
});

test("queued formatting toggles apply every activation", async ({ page }) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await page.evaluate(() => {
    for (const label of ["Bold", "Italic"]) {
      const button = document.querySelector(`button[aria-label="${label}"]`);
      button.click();
      button.click();
    }
  });
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const format = P.getShapeRunFormat(
    P.getSlideShapes(P.getSlides(loaded)[0])[1],
    0,
    0,
  );
  expect(Boolean(format.bold)).toBe(true);
  expect(Boolean(format.italic)).toBe(false);
});

for (const action of ["formatting", "movement"]) {
  test(`object ${action} queued immediately after undo edits the restored object`, async ({
    page,
  }) => {
    await story(page);
    await addText(page);
    await expect(page.locator(".object-hit")).toHaveCount(8);
    await page.locator('[data-object="1"]').click();
    await inspector(page);
    await page.evaluate((action) => {
      document.querySelector("#undo").click();
      if (action === "formatting")
        document.querySelector('button[aria-label="Bold"]').click();
      else
        document
          .querySelector('[data-object="1"]')
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
          );
    }, action);
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const shapes = P.getSlideShapes(P.getSlides(loaded)[0]);
    expect(shapes).toHaveLength(7);
    if (action === "formatting")
      expect(P.getShapeRunFormat(shapes[1], 0, 0).bold).toBe(false);
    else expect(P.getShapeBounds(shapes[1]).x).toBe(P.inches(0.81));
  });
}

for (const action of [
  "Duplicate slide",
  "Delete slide",
  "Move up",
  "Move down",
]) {
  test(`${action} queued after undo keeps the intended slide`, async ({
    page,
  }) => {
    await story(page);
    await openNewSlideMenu(page);
    await page.getByRole("menuitem", { name: "Blank", exact: true }).click();
    await expect(page.locator("#slide-count")).toHaveText("6");
    await page
      .getByRole("button", { name: "Options for slide 3", exact: true })
      .click();
    await page.evaluate((action) => {
      document.querySelector("#undo").click();
      [...document.querySelectorAll(".menu button")]
        .find((button) => button.textContent.trim() === action)
        .click();
    }, action);
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const expected = P.getSlides(createDeck("story")).map(P.getSlideText);
    if (action === "Duplicate slide") expected.splice(2, 0, expected[1]);
    else if (action === "Delete slide") expected.splice(1, 1);
    else {
      const [target] = expected.splice(1, 1);
      expected.splice(action === "Move up" ? 0 : 2, 0, target);
    }
    expect(P.getSlides(loaded).map(P.getSlideText)).toEqual(expected);
  });
}

for (const [active, removed, position, title] of [
  [3, 1, 2, "See the bigger picture"],
  [3, 5, 3, "See the bigger picture"],
  [3, 3, 3, "From idea to impact"],
  [5, 5, 4, "From idea to impact"],
]) {
  test(`deleting slide ${removed} while viewing slide ${active} keeps a stable selection`, async ({
    page,
  }) => {
    await story(page);
    await page
      .getByRole("button", { name: new RegExp(`^Slide ${active}:`) })
      .click();
    await expect(page.locator("#slide-position")).toHaveText(
      `Slide ${active} of 5`,
    );
    await page.locator('[data-object="1"]').click();
    await page
      .getByRole("button", {
        name: `Options for slide ${removed}`,
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", { name: "Delete slide", exact: true })
      .click();
    await expect(page.locator("#slide-count")).toHaveText("4");
    await expect(page.locator(".slide-image")).toHaveAttribute(
      "alt",
      new RegExp(title),
    );
    await expect(page.locator("#slide-position")).toHaveText(
      `Slide ${position} of 4`,
    );
    await expect(page.locator(".object-hit.selected")).toHaveCount(
      active === removed ? 0 : 1,
    );
  });
}

test("refusing to delete the final slide preserves redo history", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(0);
  if (
    !(await page
      .getByRole("button", { name: "Options for slide 1", exact: true })
      .isVisible())
  )
    await (await ribbonButton(page, "View", "view-thumbnails")).click();
  await page
    .getByRole("button", { name: "Options for slide 1", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete slide", exact: true })
    .click();
  await expect(page.locator("#toast")).toContainText("Keep at least one slide");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getSlides(loaded)).toHaveLength(1);
  expect(P.getSlideShapes(P.getSlides(loaded)[0])).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Redo", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(1);
});

test("slide options opened during a pending deletion target the displayed slide", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      indexedDB.open = open;
      const request = open(...args);
      Object.defineProperty(request, "onsuccess", {
        set(callback) {
          request.addEventListener(
            "success",
            (event) => {
              window.__releaseDraft = () => callback(event);
            },
            { once: true },
          );
        },
      });
      return request;
    };
  });
  await page
    .getByRole("button", { name: "Options for slide 1", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete slide", exact: true })
    .click();
  await page.waitForFunction(() => window.__releaseDraft);
  // The navigator shows the deletion before the draft is written; the next
  // deletion, queued behind it, takes the slide shown as the second.
  await expect(page.locator("#slide-count")).toHaveText("4");
  await page
    .getByRole("button", { name: "Options for slide 2", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete slide", exact: true })
    .click();
  await page.evaluate(() => window.__releaseDraft());
  await expect(page.locator("#slide-count")).toHaveText("3");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const expected = P.getSlides(createDeck("story"))
    .map(P.getSlideText)
    .filter((_, i) => i !== 0 && i !== 2);
  expect(P.getSlides(loaded).map(P.getSlideText)).toEqual(expected);
});

test("a thumbnail clicked during deletion still opens the intended slide", async ({
  page,
}) => {
  await story(page);
  await page
    .getByRole("button", { name: "Options for slide 1", exact: true })
    .click();
  await page.evaluate(() => {
    [...document.querySelectorAll(".menu button")]
      .find((button) => button.textContent.trim() === "Delete slide")
      .click();
    document.querySelectorAll(".slide-thumb")[2].click();
  });
  await expect(page.locator("#slide-count")).toHaveText("4");
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "alt",
    /See the bigger picture/,
  );
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 4");
});

for (const action of ["Text", "Rectangle", "Circle"]) {
  test(`${action} insertion stays on the displayed slide while navigation is pending`, async ({
    page,
  }) => {
    await story(page);
    await installMenuNow(page);
    await page.evaluate((action) => {
      const notes = document.querySelector("#speaker-notes");
      notes.value = "Pending notes";
      notes.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelectorAll(".slide-thumb")[1].click();
      if (action === "Text") window.__menuNow("Insert", "Text box");
      else window.__menuNow("Insert", "Shape", action);
    }, action);
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const expected = P.getSlides(createDeck("story")).map(
      (s) => P.getSlideShapes(s).length,
    );
    expected[0]++;
    expect(P.getSlides(loaded).map((s) => P.getSlideShapes(s).length)).toEqual(
      expected,
    );
    await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 5");
    await expect(page.locator(".object-hit.selected")).toHaveCount(0);
  });
}

test("new slides are inserted after the displayed slide while navigation is pending", async ({
  page,
}) => {
  await story(page);
  await installMenuNow(page);
  await page.evaluate(() => {
    const notes = document.querySelector("#speaker-notes");
    notes.value = "Pending notes";
    notes.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelectorAll(".slide-thumb")[1].click();
    window.__menuNow("Insert", "New slide", "Blank");
  });
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const expected = P.getSlides(createDeck("story")).map(P.getSlideText);
  expected.splice(1, 0, "");
  expect(P.getSlides(loaded).map(P.getSlideText)).toEqual(expected);
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 6");
});

for (const action of ["moving", "resizing"]) {
  test(`Escape cancels ${action} before the pointer is released`, async ({
    page,
  }) => {
    await story(page);
    await page.locator('[data-object="1"]').click();
    const hit = page.locator(
      action === "resizing"
        ? '.resize-handle[data-handle="se"]'
        : '[data-object="1"]',
    );
    const box = await hit.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 30,
      box.y + box.height / 2 + 20,
    );
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const expected = P.getShapeBounds(
      P.getSlideShapes(P.getSlides(createDeck("story"))[0])[1],
    );
    expect(
      P.getShapeBounds(P.getSlideShapes(P.getSlides(loaded)[0])[1]),
    ).toEqual(expected);
    await expect(page.locator(".object-hit.selected")).toHaveCount(0);
  });
  test(`${action} back to the gesture origin preserves the original bounds and redo history`, async ({
    page,
  }) => {
    await story(page);
    await addText(page);
    await expect(page.locator(".object-hit")).toHaveCount(8);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.locator(".object-hit")).toHaveCount(7);
    await page.locator('[data-object="1"]').click();
    const hit = page.locator(
      action === "resizing"
        ? '.resize-handle[data-handle="se"]'
        : '[data-object="1"]',
    );
    const box = await hit.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 30, y + 20);
    await page.mouse.move(x, y);
    await page.mouse.up();
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const expected = P.getShapeBounds(
      P.getSlideShapes(P.getSlides(createDeck("story"))[0])[1],
    );
    expect(
      P.getShapeBounds(P.getSlideShapes(P.getSlides(loaded)[0])[1]),
    ).toEqual(expected);
    await expect(
      page.getByRole("button", { name: "Redo", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(page.locator(".object-hit")).toHaveCount(8);
  });
}

for (const [geometry, bounds, direction] of [
  ["past the left edge", [-1, 1, 3, 2], "Down"],
  ["past the left edge", [-1, 1, 3, 2], "Right"],
  ["past the top edge", [1, -1, 3, 3], "Right"],
  ["past the top edge", [1, -1, 3, 3], "Down"],
  ["wider than the slide", [1, 1, 15, 2], "Down"],
  ["at the left boundary", [0, 1, 3, 2], "Left"],
  ["at the top boundary", [1, 0, 3, 2], "Up"],
]) {
  for (const method of ["keyboard", "pointer"]) {
    test(`${method} movement ${direction} preserves imported object placement ${geometry}`, async ({
      page,
    }) => {
      await start(page);
      const pres = createDeck();
      const [x, y, w, h] = bounds.map(P.inches);
      P.addSlideTextBox(P.getSlides(pres)[0], {
        x,
        y,
        w,
        h,
        text: "Move this imported object",
      });
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("button", { name: "Import PPTX", exact: true })
        .click();
      await (
        await chooser
      ).setFiles({
        name: "Placement.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        buffer: Buffer.from(await P.savePresentation(pres)),
      });
      const hit = page.locator(".object-hit");
      await expect(hit).toHaveCount(1);
      const atBoundary = direction === "Left" || direction === "Up";
      if (atBoundary) {
        await addText(page);
        await expect(hit).toHaveCount(2);
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await expect(hit).toHaveCount(1);
        await expect(
          page.getByRole("button", { name: "Redo", exact: true }),
        ).toBeEnabled();
      }
      const canvas = await page.locator("#slide-canvas").boundingBox();
      const rect = await hit.boundingBox();
      const startX =
        (Math.max(rect.x, canvas.x) +
          Math.min(rect.x + rect.width, canvas.x + canvas.width)) /
        2;
      const startY =
        (Math.max(rect.y, canvas.y) +
          Math.min(rect.y + rect.height, canvas.y + canvas.height)) /
        2;
      let delta = P.inches(0.1);
      if (method === "keyboard") {
        await page.mouse.click(startX, startY);
        await page.keyboard.press(`Shift+Arrow${direction}`);
      } else {
        // Alt keeps the pointer's placement: an object nearing the slide's
        // edge would otherwise snap onto it.
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.keyboard.down("Alt");
        await page.mouse.move(
          startX +
            (direction === "Right" ? 25 : direction === "Left" ? -25 : 0),
          startY + (direction === "Down" ? 25 : direction === "Up" ? -25 : 0),
        );
        await page.mouse.up();
        await page.keyboard.up("Alt");
        const size = P.getSlideSize(pres);
        delta =
          (25 / (direction === "Right" ? canvas.width : canvas.height)) *
          (direction === "Right" ? size.width : size.height);
      }
      await expect(hit).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".resize-handle")).toHaveCount(8);
      await openFileMenu(page);
      const downloaded = page.waitForEvent("download");
      await page
        .getByRole("menuitem", {
          name: "Download PowerPoint (.pptx)",
          exact: true,
        })
        .click();
      const loaded = await parseDeck(
        new Uint8Array(await readFile(await (await downloaded).path())),
      );
      expect(
        P.getShapeBounds(P.getSlideShapes(P.getSlides(loaded)[0])[0]),
      ).toEqual({
        x: Math.round(x + (direction === "Right" ? delta : 0)),
        y: Math.round(y + (direction === "Down" ? delta : 0)),
        w,
        h,
      });
      if (atBoundary) {
        await expect(
          page.getByRole("button", { name: "Redo", exact: true }),
        ).toBeEnabled();
        await page.getByRole("button", { name: "Redo", exact: true }).click();
        await expect(hit).toHaveCount(2);
      }
    });
  }
}

for (const dimension of ["width", "height"]) {
  test(`resizing an imported object preserves its small ${dimension} when changing the other dimension`, async ({
    page,
  }) => {
    await start(page);
    const pres = createDeck();
    const x = P.inches(1),
      y = P.inches(1);
    const w = P.inches(dimension === "width" ? 0.1 : 3);
    const h = P.inches(dimension === "height" ? 0.1 : 2);
    P.addSlideTextBox(P.getSlides(pres)[0], {
      x,
      y,
      w,
      h,
      text: "Small imported object",
    });
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "Small object.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from(await P.savePresentation(pres)),
    });
    await page.locator(".object-hit").click();
    const handle = await page
      .locator('.resize-handle[data-handle="se"]')
      .boundingBox();
    const canvas = await page.locator("#slide-canvas").boundingBox();
    const startX = handle.x + handle.width / 2;
    const startY = handle.y + handle.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(
      startX + (dimension === "height" ? 25 : 0),
      startY + (dimension === "width" ? 25 : 0),
    );
    await page.mouse.up();
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const size = P.getSlideSize(pres);
    expect(
      P.getShapeBounds(P.getSlideShapes(P.getSlides(loaded)[0])[0]),
    ).toEqual({
      x,
      y,
      w: Math.round(
        w + (dimension === "height" ? (25 / canvas.width) * size.width : 0),
      ),
      h: Math.round(
        h + (dimension === "width" ? (25 / canvas.height) * size.height : 0),
      ),
    });
  });
}

for (const action of ["moving", "resizing", "cancelling"]) {
  test(`${action} an object survives completion of a pending save`, async ({
    page,
  }) => {
    await story(page);
    await page.locator('[data-object="1"]').click();
    await page.evaluate(() => {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => {
        indexedDB.open = open;
        const request = open(...args);
        Object.defineProperty(request, "onsuccess", {
          set(callback) {
            request.addEventListener(
              "success",
              (event) => {
                window.__releaseDraft = () => callback(event);
              },
              { once: true },
            );
          },
        });
        return request;
      };
    });
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => window.__releaseDraft);
    // A second nudge waits behind the held draft; its render lands while
    // the drag below is under way.
    await page.keyboard.press("ArrowRight");
    const hit = page.locator(
      action === "resizing"
        ? '.resize-handle[data-handle="se"]'
        : '[data-object="1"]',
    );
    const box = await hit.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 30,
      box.y + box.height / 2 + 20,
    );
    await page.evaluate(() => {
      window.__dragPreview = document.querySelector(".slide-image").src;
      window.__releaseDraft();
    });
    await page.waitForFunction(
      () => document.querySelector(".slide-image").src !== window.__dragPreview,
    );
    if (action === "cancelling") await hit.dispatchEvent("pointercancel");
    await page.mouse.up();
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const bounds = P.getShapeBounds(
      P.getSlideShapes(P.getSlides(loaded)[0])[1],
    );
    if (action === "moving") expect(bounds.x).toBeGreaterThan(P.inches(0.9));
    else if (action === "resizing") {
      const original = P.getShapeBounds(
        P.getSlideShapes(P.getSlides(createDeck("story"))[0])[1],
      );
      expect(bounds.w).toBeGreaterThan(original.w);
      expect(bounds.h).toBeGreaterThan(original.h);
      expect(bounds.x).toBe(P.inches(0.81));
    } else expect(bounds.x).toBe(P.inches(0.82));
  });
}

for (const action of ["select", "edit", "keyboard edit", "drag"]) {
  test(`canvas ${action} targets the displayed object during a pending deletion`, async ({
    page,
  }) => {
    await story(page);
    await page.locator('[data-object="0"]').click();
    await page.evaluate(() => {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => {
        indexedDB.open = open;
        const request = open(...args);
        Object.defineProperty(request, "onsuccess", {
          set(callback) {
            request.addEventListener(
              "success",
              (event) => {
                window.__releaseDraft = () => callback(event);
              },
              { once: true },
            );
          },
        });
        return request;
      };
    });
    await page.keyboard.press("Delete");
    await page.waitForFunction(() => window.__releaseDraft);
    // The canvas shows the deletion before the draft is written, so the
    // title is now the first object.
    const title = page.locator('[data-object="0"]');
    await expect(title).toHaveAccessibleName(/^Make room/);
    if (action === "select") {
      await title.click();
      await inspector(page);
      await panel(page)
        .getByRole("button", { name: "Bold", exact: true })
        .click();
    } else if (action.includes("edit")) {
      if (action === "keyboard edit") {
        await title.focus();
        await page.keyboard.press("Space");
        await page.keyboard.press("Enter");
      } else await title.dblclick();
      const input = page.getByRole("textbox", {
        name: "Edit text",
        exact: true,
      });
      await input.fill("Revised opening title");
      await input.press("ControlOrMeta+Enter");
    } else {
      const box = await title.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width / 2 + 30,
        box.y + box.height / 2 + 20,
      );
      await page.mouse.up();
    }
    await page.evaluate(() => window.__releaseDraft());
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const shapes = P.getSlideShapes(P.getSlides(loaded)[0]);
    expect(shapes).toHaveLength(6);
    if (action === "select")
      expect(P.getShapeRunFormat(shapes[0], 0, 0).bold).toBe(false);
    else if (action.includes("edit"))
      expect(P.getShapeText(shapes[0])).toBe("Revised opening title");
    else expect(P.getShapeBounds(shapes[0]).x).toBeGreaterThan(P.inches(0.8));
    expect(P.getShapeText(shapes[1])).toBe(
      P.getShapeText(P.getSlideShapes(P.getSlides(createDeck("story"))[0])[2]),
    );
  });
}

for (const action of ["Forward", "Backward"]) {
  test(`${action} at the stacking boundary preserves redo history`, async ({
    page,
  }) => {
    await story(page);
    await addText(page);
    await expect(page.locator(".object-hit")).toHaveCount(8);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.locator(".object-hit")).toHaveCount(7);
    await inspector(page);
    await page
      .locator(".object-list-item")
      .nth(action === "Forward" ? 6 : 0)
      .click();
    await page.getByRole("button", { name: action, exact: true }).click();
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    expect(
      P.getSlideShapes(P.getSlides(loaded)[0]).map(P.getShapeText),
    ).toEqual(
      P.getSlideShapes(P.getSlides(createDeck("story"))[0]).map(P.getShapeText),
    );
    await expect(
      page.getByRole("button", { name: "Redo", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Undo", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(page.locator(".object-hit")).toHaveCount(8);
  });

  test(`queued ${action} preserves a later object selection`, async ({
    page,
  }) => {
    await story(page);
    await page.locator('[data-object="1"]').click();
    await page.evaluate(() => {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => {
        indexedDB.open = open;
        const request = open(...args);
        Object.defineProperty(request, "onsuccess", {
          set(callback) {
            request.addEventListener(
              "success",
              (event) => {
                window.__releaseDraft = () => callback(event);
              },
              { once: true },
            );
          },
        });
        return request;
      };
    });
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => window.__releaseDraft);
    await inspector(page);
    await page.getByRole("button", { name: action, exact: true }).click();
    if (
      await page.getByRole("button", { name: "Close format panel" }).isVisible()
    )
      await page.getByRole("button", { name: "Close format panel" }).click();
    await page.locator('[data-object="0"]').click();
    await page.evaluate(() => window.__releaseDraft());
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const expected = P.getSlideShapes(P.getSlides(createDeck("story"))[0]).map(
      P.getShapeText,
    );
    const [title] = expected.splice(1, 1);
    expected.splice(action === "Forward" ? 2 : 0, 0, title);
    expect(
      P.getSlideShapes(P.getSlides(loaded)[0]).map(P.getShapeText),
    ).toEqual(expected);
    await expect(page.locator(".object-hit.selected")).toHaveAccessibleName(
      "YOUR NEXT CHAPTER. Select to edit",
    );
  });
}

for (const action of ["Undo", "Redo"]) {
  test(`${action} preserves the viewed slide when an earlier slide changes`, async ({
    page,
  }) => {
    await story(page);
    await openNewSlideMenu(page);
    await page.getByRole("menuitem", { name: "Blank", exact: true }).click();
    await expect(page.locator("#slide-count")).toHaveText("6");
    if (action === "Redo") {
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(page.locator("#slide-count")).toHaveText("5");
    }
    await page
      .getByRole("button", {
        name: new RegExp(`^Slide ${action === "Undo" ? 4 : 3}:`),
      })
      .click();
    await expect(page.locator(".slide-image")).toHaveAttribute(
      "alt",
      /See the bigger picture/,
    );
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect(page.locator("#slide-count")).toHaveText(
      action === "Undo" ? "5" : "6",
    );
    await expect(page.locator(".slide-image")).toHaveAttribute(
      "alt",
      /See the bigger picture/,
    );
    await expect(page.locator("#slide-position")).toHaveText(
      action === "Undo" ? "Slide 3 of 5" : "Slide 4 of 6",
    );
  });
}

test("canvas typing survives completion of a delayed cloud rename", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  await page.evaluate(() => {
    const rename = puter.fs.rename;
    puter.fs.rename = async (...args) => {
      await new Promise((resolve) => (window.__releaseRename = resolve));
      return rename(...args);
    };
  });
  await page.locator(".document-title").click();
  await page
    .getByRole("textbox", { name: "Presentation name" })
    .fill("Revised presentation");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^(Save|Sign in to save)$/ })
    .click();
  await page.waitForFunction(() => window.__releaseRename);
  await page.locator('[data-object="1"]').dblclick();
  const input = page.getByRole("textbox", { name: "Edit text", exact: true });
  await input.fill("A title entered while renaming");
  await page.evaluate(() => window.__releaseRename());
  await expect(page.locator(".document-title")).toHaveText(
    "Revised presentation",
  );
  await expect(input).toBeFocused();
  await expect(input).toHaveText("A title entered while renaming");
  await input.press("ControlOrMeta+Enter");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getShapeText(P.getSlideShapes(P.getSlides(loaded)[0])[1])).toBe(
    "A title entered while renaming",
  );
});

test("import rejects false DEFLATE sizes and preserves the open presentation", async ({
  page,
}) => {
  await story(page);
  const pres = createDeck();
  P.setSlideNotes(P.getSlides(pres)[0], "A".repeat(1024 * 1024));
  const bytes = await P.savePresentation(pres);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = view.getUint32(bytes.length - 22 + 16, true);
  for (let i = 0; i < view.getUint16(bytes.length - 22 + 10, true); i++) {
    const length = view.getUint16(cursor + 28, true);
    const name = new TextDecoder().decode(
      bytes.subarray(cursor + 46, cursor + 46 + length),
    );
    if (name === "ppt/notesSlides/notesSlide1.xml")
      view.setUint32(cursor + 24, 1, true);
    cursor +=
      46 +
      length +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
  }
  await openFileMenu(page);
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("menuitem", { name: "Import PPTX", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "Malformed.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator("#toast")).toContainText(
    "This PPTX file is damaged. Choose another copy of the presentation.",
  );
  await expect(page.locator("#slide-count")).toHaveText("5");
  await expect(page.locator(".document-title")).toHaveText("The big idea");
});

for (const source of ["recovery", "import"]) {
  for (const superseded of [false, true]) {
    test(`a failed ${source} ${superseded ? "stays quiet after newer navigation" : "reports its current error"}`, async ({
      page,
    }) => {
      await start(page);
      if (source === "recovery") {
        await page
          .getByRole("button", { name: "New presentation", exact: true })
          .click();
        await addText(page);
        await expect(page.locator("#save-status")).toHaveText(
          "Saved on this device",
        );
        await page
          .getByRole("button", { name: "Back to presentations" })
          .click();
        await page.evaluate(async () => {
          const drafts = await import("/src/drafts.js");
          const [draft] = await drafts.listDrafts("guest");
          // A second tab can remove a draft while its library entry is still visible.
          await drafts.deleteDraft(draft.id);
          const original = IDBDatabase.prototype.transaction;
          IDBDatabase.prototype.transaction = function (...args) {
            const tx = original.apply(this, args);
            if (args[1] === "readonly") {
              IDBDatabase.prototype.transaction = original;
              Object.defineProperty(tx, "oncomplete", {
                set(callback) {
                  tx.addEventListener("complete", (event) => {
                    window.__releaseOpen = () => callback(event);
                  });
                },
              });
            }
            return tx;
          };
        });
        await page
          .getByRole("button", {
            name: "Untitled presentation Recovery draft",
            exact: true,
          })
          .click();
      } else {
        await page.evaluate(() => {
          const original = File.prototype.arrayBuffer;
          File.prototype.arrayBuffer = async function () {
            File.prototype.arrayBuffer = original;
            await new Promise((resolve) => (window.__releaseOpen = resolve));
            return original.call(this);
          };
        });
        const chooser = page.waitForEvent("filechooser");
        await page
          .getByRole("button", { name: "Import PPTX", exact: true })
          .click();
        await (
          await chooser
        ).setFiles({
          name: "Broken.pptx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          buffer: Buffer.from("not a presentation"),
        });
      }
      await page.waitForFunction(() => window.__releaseOpen);
      if (superseded) {
        await page
          .getByRole("button", {
            name: "The big idea A clear, considered story",
          })
          .click();
        await expect(page.locator("#slide-count")).toHaveText("5");
        await addText(page);
        await expect(page.locator(".object-hit")).toHaveCount(8);
      }
      const previousToast = await page.locator("#toast").textContent();
      await page.evaluate(async () => {
        window.__releaseOpen();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      if (superseded) {
        await expect(page.locator("#toast")).toHaveText(previousToast);
        await expect(page.locator("#slide-count")).toHaveText("5");
        await expect(page.locator(".object-hit")).toHaveCount(8);
        await expect(page.locator("#save-status")).toHaveText(
          "Saved on this device",
        );
      } else {
        await expect(page.locator("#toast")).toHaveText(
          source === "recovery"
            ? "This recovery draft is no longer available."
            : "This is not a valid PPTX file.",
        );
        await expect(
          page.getByRole("heading", { name: "Good ideas deserve a stage." }),
        ).toBeVisible();
      }
    });
  }
}

for (const confirm of [false, true]) {
  test(`a draft cannot finish opening behind its ${confirm ? "confirmed" : "canceled"} delete dialog`, async ({
    page,
  }) => {
    await start(page);
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await addText(page);
    await expect(page.locator("#save-status")).toHaveText(
      "Saved on this device",
    );
    await page.getByRole("button", { name: "Back to presentations" }).click();
    const draft = page.getByRole("button", {
      name: "Untitled presentation Recovery draft",
      exact: true,
    });
    // The library lists drafts through a readonly transaction of its own, so
    // wait for the row before holding the next one: the draft's recovery read.
    await expect(draft).toBeVisible();
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = original.apply(this, args);
        if (args[1] === "readonly") {
          IDBDatabase.prototype.transaction = original;
          Object.defineProperty(tx, "oncomplete", {
            set(callback) {
              tx.addEventListener("complete", (event) => {
                window.__releaseRecovery = () => callback(event);
              });
            },
          });
        }
        return tx;
      };
    });
    await draft.click();
    await page.waitForFunction(() => window.__releaseRecovery);
    await page
      .getByRole("button", {
        name: "Options for Untitled presentation",
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", { name: "Delete draft", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.evaluate(async () => {
      window.__releaseRecovery();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await expect(page.locator(".editor")).toHaveCount(0);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: confirm ? "Delete" : "Cancel", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Good ideas deserve a stage." }),
    ).toBeVisible();
    if (confirm) {
      await expect(draft).toHaveCount(0);
      expect(
        await page.evaluate(
          async () =>
            (await (await import("/src/drafts.js")).listDrafts("guest")).length,
        ),
      ).toBe(0);
    } else {
      await draft.click();
      await expect(page.locator(".object-hit")).toHaveCount(1);
      await expect(page.locator("#save-status")).toHaveText(
        "Saved on this device",
      );
    }
  });
}

test("a failed local draft deletion still allows recovery", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (...args) {
      if (this.name === "drafts") {
        IDBObjectStore.prototype.delete = original;
        throw new Error("Draft deletion failed");
      }
      return original.apply(this, args);
    };
  });
  await page
    .getByRole("button", {
      name: "Options for Untitled presentation",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete draft", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.locator("#toast")).toHaveText("Draft deletion failed");
  await page
    .getByRole("button", {
      name: "Untitled presentation Recovery draft",
      exact: true,
    })
    .click();
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
});

for (const first of ["recovery", "deletion", "recovery of another draft"]) {
  test(
    first === "recovery of another draft"
      ? "deleting a local draft preserves an unrelated pending recovery"
      : `deleting a local draft prevents overlapping recovery when ${first} starts first`,
    async ({ page }) => {
      await start(page);
      await page
        .getByRole("button", { name: "New presentation", exact: true })
        .click();
      await addText(page);
      await expect(page.locator("#save-status")).toHaveText(
        "Saved on this device",
      );
      await page.getByRole("button", { name: "Back to presentations" }).click();
      const unrelated = first === "recovery of another draft";
      if (unrelated) {
        await page
          .getByRole("button", { name: "The pitch Make your next move" })
          .click();
        await page
          .getByRole("button", { name: "Back to presentations" })
          .click();
      }
      const draft = page.getByRole("button", {
        name: "Untitled presentation Recovery draft",
        exact: true,
      });
      // The library lists drafts through a readonly transaction of its own, so
      // wait for the row before holding the next one: the draft's recovery read.
      await expect(draft).toBeVisible();
      await page.evaluate((first) => {
        if (first !== "deletion") {
          const original = IDBDatabase.prototype.transaction;
          IDBDatabase.prototype.transaction = function (...args) {
            const tx = original.apply(this, args);
            if (args[1] === "readonly") {
              IDBDatabase.prototype.transaction = original;
              Object.defineProperty(tx, "oncomplete", {
                set(callback) {
                  tx.addEventListener("complete", (event) => {
                    window.__releaseDraftOperation = () => callback(event);
                  });
                },
              });
            }
            return tx;
          };
        } else {
          const original = indexedDB.open.bind(indexedDB);
          indexedDB.open = (...args) => {
            indexedDB.open = original;
            const request = original(...args);
            Object.defineProperty(request, "onsuccess", {
              set(callback) {
                request.addEventListener("success", (event) => {
                  window.__releaseDraftOperation = () => callback(event);
                });
              },
            });
            return request;
          };
        }
      }, first);
      if (first !== "deletion") {
        await draft.click();
        await page.waitForFunction(() => window.__releaseDraftOperation);
      }
      await page
        .getByRole("button", {
          name: unrelated
            ? "Options for The pitch"
            : "Options for Untitled presentation",
          exact: true,
        })
        .click();
      await page
        .getByRole("menuitem", { name: "Delete draft", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      if (first === "deletion") {
        await page.waitForFunction(() => window.__releaseDraftOperation);
        await draft.click();
        await expect(page.locator("#toast")).toHaveText(
          "This draft is being deleted.",
        );
        await expect(page.locator(".editor")).toHaveCount(0);
      } else
        await expect(
          page.getByRole("button", {
            name: unrelated
              ? "The pitch Recovery draft"
              : "Untitled presentation Recovery draft",
            exact: true,
          }),
        ).toHaveCount(0);
      await page.evaluate(async () => {
        window.__releaseDraftOperation();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      if (unrelated) {
        await expect(page.locator(".object-hit")).toHaveCount(1);
        await expect(page.locator("#save-status")).toHaveText(
          "Saved on this device",
        );
        expect(
          await page.evaluate(async () =>
            (await (await import("/src/drafts.js")).listDrafts("guest")).map(
              (draft) => draft.name,
            ),
          ),
        ).toEqual(["Untitled presentation"]);
        return;
      }
      await expect(
        page.getByRole("heading", { name: "Good ideas deserve a stage." }),
      ).toBeVisible();
      await expect(draft).toHaveCount(0);
      await expect(page.locator(".editor")).toHaveCount(0);
      expect(
        await page.evaluate(
          async () =>
            (await (await import("/src/drafts.js")).listDrafts("guest")).length,
        ),
      ).toBe(0);
    },
  );
}

for (const location of ["library", "editor"]) {
  test(`a ${location} rename updates older recovery drafts`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
    await addText(page);
    await expect(page.locator("#save-status")).toHaveText(
      "Saved on this device",
    );
    await leaveWithUnsavedCloudEdits(page);
    await page.evaluate(() => {
      const read = puter.fs.read;
      puter.fs.rename = async (path, name) => {
        const bytes = await read(path);
        const renamed = path.slice(0, path.lastIndexOf("/") + 1) + name;
        await puter.fs.write(renamed, bytes, { overwrite: false });
        await puter.fs.delete(path);
        return { path: renamed };
      };
    });
    const cloudFile = page.getByRole("button", {
      name: "Untitled presentation PowerPoint presentation",
      exact: true,
    });
    if (location === "library") {
      await page
        .locator(".file-row")
        .filter({ has: cloudFile })
        .getByRole("button", {
          name: "Options for Untitled presentation",
          exact: true,
        })
        .click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    } else {
      await cloudFile.click();
      await expect(page.locator(".object-hit")).toHaveCount(0);
      await page.locator(".document-title").click();
    }
    await page
      .getByRole("textbox", { name: "Presentation name" })
      .fill("Renamed with local changes");
    await page
      .getByRole("textbox", { name: "Presentation name" })
      .press("Enter");
    if (location === "editor") {
      await expect(page.locator(".document-title")).toHaveText(
        "Renamed with local changes",
      );
      await page
        .getByRole("button", { name: /^(Save|Sign in to save)$/ })
        .click();
      await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
      await page.getByRole("button", { name: "Back to presentations" }).click();
    }
    await expect(
      page.getByRole("button", {
        name: "Renamed with local changes PowerPoint presentation",
        exact: true,
      }),
    ).toBeVisible();
    await reloadLibrary(page);
    await page
      .getByRole("button", {
        name: "Renamed with local changes Recovery draft",
        exact: true,
      })
      .click();
    await expect(page.locator(".object-hit")).toHaveCount(1);
    await expect(page.locator("#save-status")).toHaveAttribute(
      "title",
      "/test/Presentations/Renamed with local changes.pptx",
    );
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
    expect(await page.evaluate(() => window.__writes.at(-1).path)).toBe(
      "/test/Presentations/Renamed with local changes.pptx",
    );
    expect(
      await page.evaluate(() => window.__writes.at(-1).options.overwrite),
    ).toBe(true);
  });
}

for (const delayed of ["rename", "read"]) {
  test(`a library rename updates the same file opened during a pending ${delayed}`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toContainText("Saved to Puter");
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await page.evaluate((delayed) => {
      const original = puter.fs[delayed];
      puter.fs[delayed] = async (...args) => {
        const result = await original(...args);
        await new Promise((resolve) => (window.__releaseOperation = resolve));
        return result;
      };
    }, delayed);
    const file = page.getByRole("button", {
      name: "Untitled presentation PowerPoint presentation",
      exact: true,
    });
    if (delayed === "read") {
      await file.click();
      await page.waitForFunction(() => window.__releaseOperation);
    }
    await page
      .getByRole("button", {
        name: "Options for Untitled presentation",
        exact: true,
      })
      .click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Presentation name" })
      .fill("Renamed while opening.pptx.pptx");
    await page
      .getByRole("textbox", { name: "Presentation name" })
      .press("Enter");
    if (delayed === "rename") {
      await page.waitForFunction(() => window.__releaseOperation);
      await file.click();
      await expect(page.locator("#slide-count")).toHaveText("1");
      await addText(page);
      await page
        .getByRole("button", { name: /^(Save|Sign in to save)$/ })
        .click();
    } else await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      window.__releaseOperation();
    });
    await expect(page.locator(".document-title")).toHaveText(
      "Renamed while opening.pptx",
    );
    await addText(page);
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toContainText("Saved to Puter");
    expect(await page.evaluate(() => window.__writes.at(-1).path)).toBe(
      "/test/Presentations/Renamed while opening.pptx.pptx",
    );
    expect(
      await page.evaluate(() =>
        window.__writes
          .slice(1)
          .every(
            (write) =>
              write.path ===
              "/test/Presentations/Renamed while opening.pptx.pptx",
          ),
      ),
    ).toBe(true);
  });
}

test("a cloud read failure without a rename is reported without retrying", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toContainText("test-user");
  await page.evaluate(() => {
    window.__cloudReads = 0;
    puter.ui.showOpenFilePicker = async () => ({
      name: "Unavailable.pptx",
      path: "/test/Unavailable.pptx",
    });
    puter.fs.read = async () => {
      window.__cloudReads++;
      throw new Error("Cloud read unavailable");
    };
  });
  await page
    .getByRole("button", { name: "Open from Puter", exact: true })
    .click();
  await expect(page.locator("#toast")).toHaveText("Cloud read unavailable");
  expect(await page.evaluate(() => window.__cloudReads)).toBe(1);
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
});

for (const superseded of [false, true]) {
  test(`a read whose file was renamed ${superseded ? "stops after newer navigation" : "retries the new path"}`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toContainText("Saved to Puter");
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await page.evaluate(() => {
      const read = puter.fs.read;
      let first = true;
      window.__readPaths = [];
      puter.fs.read = async (path) => {
        window.__readPaths.push(path);
        if (first) {
          first = false;
          await new Promise((resolve) => (window.__releaseRead = resolve));
        }
        if (window.__movedPath === path) throw new Error("Cloud file moved");
        return read(path);
      };
      puter.fs.rename = async (path, name) => {
        const blob = await read(path);
        const target = path.slice(0, path.lastIndexOf("/") + 1) + name;
        const result = await puter.fs.write(target, blob, { overwrite: true });
        await puter.fs.delete(path);
        window.__movedPath = path;
        return result;
      };
    });
    await page
      .getByRole("button", {
        name: "Untitled presentation PowerPoint presentation",
        exact: true,
      })
      .click();
    await page.waitForFunction(() => window.__releaseRead);
    await page
      .getByRole("button", {
        name: "Options for Untitled presentation",
        exact: true,
      })
      .click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Presentation name" })
      .fill("Moved deck");
    await page
      .getByRole("textbox", { name: "Presentation name" })
      .press("Enter");
    await expect(
      page.getByRole("button", {
        name: "Moved deck PowerPoint presentation",
        exact: true,
      }),
    ).toBeVisible();
    if (superseded) {
      await page
        .getByRole("button", { name: "New presentation", exact: true })
        .click();
      await addText(page);
      await expect(page.locator(".object-hit")).toHaveCount(1);
    }
    await page.evaluate(async () => {
      window.__releaseRead();
      await new Promise(requestAnimationFrame);
    });
    if (superseded) {
      await expect(page.locator(".object-hit")).toHaveCount(1);
      await expect(page.locator("#toast")).not.toHaveText("Cloud file moved");
      expect(await page.evaluate(() => window.__readPaths)).toEqual([
        "/test/Presentations/Untitled presentation.pptx",
      ]);
    } else {
      await expect(page.locator(".document-title")).toHaveText("Moved deck");
      expect(await page.evaluate(() => window.__readPaths)).toEqual([
        "/test/Presentations/Untitled presentation.pptx",
        "/test/Presentations/Moved deck.pptx",
      ]);
      await expect(page.locator("#save-status")).toHaveAttribute(
        "title",
        "/test/Presentations/Moved deck.pptx",
      );
    }
  });
}

for (const superseded of [false, true]) {
  test(`recovery queued behind deletion ${superseded ? "respects newer navigation" : "opens a local copy"}`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
    await addText(page);
    await expect(page.locator("#save-status")).toHaveText(
      "Saved on this device",
    );
    await leaveWithUnsavedCloudEdits(page);
    await page.evaluate(() => {
      const original = puter.fs.delete;
      puter.fs.delete = async (...args) => {
        await new Promise((resolve) => (window.__releaseDelete = resolve));
        return original(...args);
      };
    });
    const cloudFile = page.getByRole("button", {
      name: "Untitled presentation PowerPoint presentation",
      exact: true,
    });
    await page
      .locator(".file-row")
      .filter({ has: cloudFile })
      .getByRole("button", {
        name: "Options for Untitled presentation",
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", { name: "Delete presentation", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.waitForFunction(() => window.__releaseDelete);
    await page
      .getByRole("button", {
        name: "Untitled presentation Recovery draft",
        exact: true,
      })
      .click();
    if (superseded) {
      await page
        .getByRole("button", { name: "The big idea A clear, considered story" })
        .click();
      await expect(page.locator("#slide-count")).toHaveText("5");
    }
    await page.evaluate(() => window.__releaseDelete());
    // Saving a new file waits for the queued delete and recovery to finish.
    await expect(page.locator("#slide-count")).toHaveText(
      superseded ? "5" : "1",
    );
    await expect(page.locator("#save-status")).toHaveAttribute(
      "title",
      "Save to Puter to access this presentation on other devices.",
    );
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
    await expect(page.locator("#slide-count")).toHaveText(
      superseded ? "5" : "1",
    );
    await expect(page.locator(".object-hit")).toHaveCount(superseded ? 7 : 1);
    expect(
      await page.evaluate(() => window.__writes.at(-1).options.overwrite),
    ).toBe(false);
  });
}

for (const pendingRecovery of [false, true]) {
  test(`deleting a cloud file detaches its ${pendingRecovery ? "pending" : "inactive"} recovery draft`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toContainText("Saved to Puter");
    await addText(page);
    await expect(page.locator("#save-status")).toHaveText(
      "Saved on this device",
    );
    await leaveWithUnsavedCloudEdits(page);
    const draft = page.getByRole("button", {
      name: "Untitled presentation Recovery draft",
      exact: true,
    });
    if (pendingRecovery) {
      // The library lists drafts through a readonly transaction of its own, so
      // wait for the row before holding the next one: the draft's recovery read.
      await expect(draft).toBeVisible();
      await page.evaluate(() => {
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args) {
          const tx = original.apply(this, args);
          if (args[1] === "readonly") {
            IDBDatabase.prototype.transaction = original;
            Object.defineProperty(tx, "oncomplete", {
              set(callback) {
                tx.addEventListener("complete", (event) => {
                  window.__releaseRecovery = () => callback(event);
                });
              },
            });
          }
          return tx;
        };
      });
      await draft.click();
      await page.waitForFunction(() => window.__releaseRecovery);
    }
    const cloudFile = page.getByRole("button", {
      name: "Untitled presentation PowerPoint presentation",
      exact: true,
    });
    await page
      .locator(".file-row")
      .filter({ has: cloudFile })
      .getByRole("button", {
        name: "Options for Untitled presentation",
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", { name: "Delete presentation", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    if (pendingRecovery) {
      await page.evaluate(() => window.__releaseRecovery());
    } else {
      await expect(cloudFile).toHaveCount(0);
      // Reload to verify that the deleted association was removed from durable storage.
      await reloadLibrary(page);
      await draft.click();
    }
    await expect(page.locator(".object-hit")).toHaveCount(1);
    await expect(page.locator("#save-status")).toHaveAttribute(
      "title",
      "Save to Puter to access this presentation on other devices.",
    );
    await addText(page);
    await expect(page.locator("#save-status")).toHaveText(
      "Saved on this device",
    );
    await page.evaluate(async () => {
      window.dispatchEvent(new Event("online"));
      await new Promise(requestAnimationFrame);
    });
    expect(await page.evaluate(() => window.__writes.length)).toBe(
      pendingRecovery ? 1 : 0,
    );
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
    expect(
      await page.evaluate(() => window.__writes.at(-1).options.overwrite),
    ).toBe(false);
  });
}

for (const delayed of ["delete", "read"]) {
  test(`deleting a cloud file handles its pending ${delayed} without reconnecting the deleted path`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toContainText("Saved to Puter");
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await page.evaluate((delayed) => {
      const original = puter.fs[delayed];
      puter.fs[delayed] = async (...args) => {
        const read = delayed === "read" ? await original(...args) : null;
        await new Promise(
          (resolve) => (window.__releaseFileOperation = resolve),
        );
        return delayed === "read" ? read : original(...args);
      };
    }, delayed);
    const file = page.getByRole("button", {
      name: "Untitled presentation PowerPoint presentation",
      exact: true,
    });
    if (delayed === "read") {
      await file.click();
      await page.waitForFunction(() => window.__releaseFileOperation);
    }
    await page
      .getByRole("button", {
        name: "Options for Untitled presentation",
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", { name: "Delete presentation", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    if (delayed === "delete") {
      await page.waitForFunction(() => window.__releaseFileOperation);
      await file.click();
      await expect(page.locator("#slide-count")).toHaveText("1");
      await addText(page);
      await expect(page.locator("#save-status")).toHaveText(
        "Saved on this device",
      );
      await page.evaluate(async () => {
        window.dispatchEvent(new Event("online"));
        await new Promise(requestAnimationFrame);
      });
    } else await expect(file).toHaveCount(0);
    await page.evaluate(async () => {
      window.__releaseFileOperation();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    if (delayed === "read") {
      await expect(
        page.getByRole("heading", { name: "Good ideas deserve a stage." }),
      ).toBeVisible();
      await expect(page.locator(".editor")).toHaveCount(0);
    } else {
      await expect(page.locator("#save-status")).toHaveAttribute(
        "title",
        "Save to Puter to access this presentation on other devices.",
      );
      await addText(page);
      await expect(page.locator("#save-status")).toHaveText(
        "Saved on this device",
      );
      await page.evaluate(async () => {
        window.dispatchEvent(new Event("online"));
        await new Promise(requestAnimationFrame);
      });
      expect(await page.evaluate(() => window.__writes.length)).toBe(1);
      expect(
        await page.evaluate(
          async () => (await puter.fs.readdir("Presentations")).length,
        ),
      ).toBe(0);
      await page.getByRole("button", { name: "Back to presentations" }).click();
      await page
        .getByRole("button", {
          name: "Untitled presentation Recovery draft",
          exact: true,
        })
        .click();
      await expect(page.locator(".object-hit")).toHaveCount(2);
      await page
        .getByRole("button", { name: /^(Save|Sign in to save)$/ })
        .click();
      await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
      expect(await page.evaluate(() => window.__writes.length)).toBe(2);
      expect(
        await page.evaluate(() => window.__writes.at(-1).options.overwrite),
      ).toBe(false);
    }
  });
}

for (const action of ["Rename", "Delete presentation"]) {
  test(`a delayed library ${action} preserves work started afterward`, async ({
    page,
  }) => {
    await mockPuter(page, { signedIn: true });
    await page.goto("/#/home");
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await page
      .getByRole("button", { name: /^(Save|Sign in to save)$/ })
      .click();
    await expect(page.locator("#save-status")).toContainText("Saved to Puter");
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await page.evaluate((action) => {
      const key = action === "Rename" ? "rename" : "delete";
      const original = puter.fs[key];
      puter.fs[key] = async (...args) => {
        await new Promise(
          (resolve) => (window.__releaseFileOperation = resolve),
        );
        const result = await original(...args);
        window.__fileOperationDone = true;
        return result;
      };
    }, action);
    await page
      .getByRole("button", {
        name: "Options for Untitled presentation",
        exact: true,
      })
      .click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
    if (action === "Rename")
      await page
        .getByRole("textbox", { name: "Presentation name" })
        .fill("Renamed library file");
    await page
      .getByRole("dialog")
      .getByRole("button", {
        name: action === "Rename" ? "Save" : "Delete",
        exact: true,
      })
      .click();
    await page.waitForFunction(() => window.__releaseFileOperation);
    await page
      .getByRole("button", { name: "The big idea A clear, considered story" })
      .click();
    await page.locator('[data-object="1"]').dblclick();
    const input = page.getByRole("textbox", { name: "Edit text", exact: true });
    await input.fill("Keep this in-progress title");
    await page.evaluate(() => window.__releaseFileOperation());
    await page.waitForFunction(() => window.__fileOperationDone);
    await expect(input).toBeFocused();
    await expect(input).toHaveText("Keep this in-progress title");
    await input.press("ControlOrMeta+Enter");
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    expect(P.getShapeText(P.getSlideShapes(P.getSlides(loaded)[0])[1])).toBe(
      "Keep this in-progress title",
    );
  });
}

for (const failFirst of [false, true]) {
  test(`repeated sign-in activation shares one pending request${failFirst ? " and permits retry after failure" : ""}`, async ({
    page,
  }) => {
    await start(page);
    await page.evaluate((failFirst) => {
      const signIn = puter.auth.signIn;
      window.__signInCalls = 0;
      window.__failSignIn = failFirst;
      puter.auth.signIn = async () => {
        window.__signInCalls++;
        await new Promise((resolve) => (window.__releaseSignIn = resolve));
        if (window.__failSignIn) throw new Error("Sign-in cancelled");
        return signIn();
      };
    }, failFirst);
    const connect = page.getByRole("button", {
      name: "Connect Puter",
      exact: true,
    });
    await connect.click();
    await page.waitForFunction(() => window.__releaseSignIn);
    await connect.click();
    expect(await page.evaluate(() => window.__signInCalls)).toBe(1);
    await page.evaluate(() => window.__releaseSignIn());
    if (failFirst) {
      await expect(page.locator("#toast")).toHaveText("Sign-in cancelled");
      await page.evaluate(() => {
        window.__failSignIn = false;
        window.__releaseSignIn = null;
      });
      await connect.click();
      await page.waitForFunction(() => window.__releaseSignIn);
      expect(await page.evaluate(() => window.__signInCalls)).toBe(2);
      await page.evaluate(() => window.__releaseSignIn());
    }
    await expect(
      page.getByRole("button", { name: "Account and settings" }),
    ).toContainText("test-user");
    await expect(connect).toHaveCount(0);
  });
}

test("closing the Puter sign-in window is not reported as an error", async ({
  page,
}) => {
  await start(page);
  // The SDK rejects with plain objects: `{ error, msg }` rather than Errors.
  await page.evaluate(() => {
    window.__rejection = {
      error: "auth_window_closed",
      msg: "Authentication window was closed by the user without completing the process.",
    };
    puter.auth.signIn = () => Promise.reject(window.__rejection);
  });
  const connect = page.getByRole("button", {
    name: "Connect Puter",
    exact: true,
  });
  await connect.click();
  await expect(connect).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator("#toast")).not.toHaveClass(/visible/);
  await expect(page.locator("#toast")).toHaveText("");
  await page.evaluate(() => {
    window.__rejection = {
      error: "popup_blocked",
      msg: "The sign-in popup was blocked by the browser.",
    };
  });
  await connect.click();
  await expect(page.locator("#toast")).toHaveText(
    "The browser blocked the Puter sign-in window. Allow pop-ups for this site and try again.",
  );
  await expect(connect).toBeVisible();
  // The sign-in remains available once the window can open.
  await page.evaluate(() => {
    puter.auth.signIn = async () => {};
  });
  await connect.click();
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toContainText("test-user");
});

for (const reconnect of [false, true]) {
  test(`sign-out cancels an open waiting for sign-in${reconnect ? " and permits a fresh connection" : ""}`, async ({
    page,
  }) => {
    await start(page);
    await page.evaluate(() => {
      const list = puter.fs.readdir;
      let first = true;
      puter.fs.readdir = async (...args) => {
        if (first) {
          first = false;
          await new Promise((resolve) => (window.__releaseList = resolve));
        }
        return list(...args);
      };
      window.__pickerCalls = 0;
      puter.ui.showOpenFilePicker = async () => {
        window.__pickerCalls++;
        return null;
      };
    });
    await page
      .getByRole("button", { name: "Open from Puter", exact: true })
      .click();
    await page.waitForFunction(() => window.__releaseList);
    await page.getByRole("button", { name: "Account and settings" }).click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    const connect = page.getByRole("button", {
      name: "Connect Puter",
      exact: true,
    });
    await expect(connect).toBeVisible();
    if (reconnect) {
      await connect.click();
      await expect(
        page.getByRole("button", { name: "Account and settings" }),
      ).toContainText("test-user");
    }
    await page.evaluate(async () => {
      window.__releaseList();
      await new Promise(requestAnimationFrame);
    });
    expect(await page.evaluate(() => window.__pickerCalls)).toBe(0);
    if (!reconnect) await expect(connect).toBeVisible();
    else {
      await page
        .getByRole("button", { name: "Open from Puter", exact: true })
        .click();
      expect(await page.evaluate(() => window.__pickerCalls)).toBe(1);
    }
  });
}

test("canvas typing survives completion of a delayed sign-in", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() => {
    const signIn = puter.auth.signIn;
    puter.auth.signIn = async () => {
      await new Promise((resolve) => (window.__releaseSignIn = resolve));
      return signIn();
    };
  });
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await page.waitForFunction(() => window.__releaseSignIn);
  await page.locator('[data-object="1"]').dblclick();
  const input = page.getByRole("textbox", { name: "Edit text", exact: true });
  await input.fill("Keep typing during sign-in");
  await page.evaluate(() => window.__releaseSignIn());
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  await expect(input).toBeFocused();
  await expect(input).toHaveText("Keep typing during sign-in");
  await input.press("ControlOrMeta+Enter");
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(
        await (await puter.fs.read(window.__writes.at(-1).path)).arrayBuffer(),
      ),
    ),
  );
  const loaded = await parseDeck(new Uint8Array(bytes));
  expect(P.getShapeText(P.getSlideShapes(P.getSlides(loaded)[0])[1])).toBe(
    "Keep typing during sign-in",
  );
});

test("sign-in transfers recovery ownership after older guest saves finish", async ({
  page,
}) => {
  await page.route("**/src/drafts.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `const records=new Map();
      export async function saveDraft(draft) {
        if(window.__delayDraft) {
          window.__delayDraft=false;
          await new Promise(resolve=>window.__releaseDraft=resolve);
        }
        records.set(draft.id,{...draft,updated:Date.now()});
      }
      export const listDrafts=async owner=>[...records.values()].filter(d=>d.owner===owner&&!d.cloudSaved);
      export const getDraft=async id=>records.get(id);
      export const deleteDraft=async id=>records.delete(id);`,
    }),
  );
  await start(page);
  await page.evaluate(() => {
    const signIn = puter.auth.signIn;
    puter.auth.signIn = async () => {
      await new Promise((resolve) => (window.__releaseSignIn = resolve));
      return signIn();
    };
  });
  await page.getByRole("button", { name: "Account and settings" }).click();
  await page
    .getByRole("menuitem", { name: "Sign in with Puter", exact: true })
    .click();
  await page.waitForFunction(() => window.__releaseSignIn);
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await page.locator('[data-object="1"]').click();
  await page.evaluate(() => (window.__delayDraft = true));
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => window.__releaseDraft);
  await page.evaluate(() => window.__releaseSignIn());
  // The in-memory store completes synchronously once its deliberate pause ends.
  // A frame lets the sign-in promise chain settle without waiting on the old save.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.evaluate(() => window.__releaseDraft());
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toContainText("test-user");
  await expect(
    page.getByRole("button", {
      name: "The big idea Recovery draft",
      exact: true,
    }),
  ).toBeVisible();
});

test("a Save awaiting sign-in does not upload a different presentation opened later", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() => {
    const signIn = puter.auth.signIn;
    puter.auth.signIn = async () => {
      await new Promise((resolve) => (window.__releaseSignIn = resolve));
      return signIn();
    };
  });
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await page.waitForFunction(() => window.__releaseSignIn);
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.evaluate(() => window.__releaseSignIn());
  await expect(page.locator(".account-button")).toContainText("test-user");
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await page.evaluate(() => window.__writes)).toHaveLength(0);
  await expect(page.locator("#save-status")).toContainText(
    "Saved on this device",
  );
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  expect(await page.evaluate(() => window.__writes.at(-1).path)).toContain(
    "Untitled presentation.pptx",
  );
});

test("the reload warning includes unfinished numeric edits and clears when restored", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  const width = page.getByRole("spinbutton", {
    name: "Width (in)",
    exact: true,
  });
  const original = await width.inputValue();
  await width.fill("3");
  const warns = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await warns()).toBe(true);
  await width.fill(original);
  expect(await warns()).toBe(false);
  await width.fill(Number(original).toFixed(3));
  expect(await warns()).toBe(false);
});

test("sign-in completion does not cancel a pending local import", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() => {
    const signIn = puter.auth.signIn;
    puter.auth.signIn = async () => {
      await new Promise((resolve) => (window.__releaseSignIn = resolve));
      return signIn();
    };
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      return new Promise((resolve) => {
        window.__releaseImport = async () => resolve(await read.call(this));
      });
    };
  });
  await page
    .getByRole("button", { name: "Connect Puter", exact: true })
    .click();
  await page.waitForFunction(() => window.__releaseSignIn);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Imported deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(createDeck("story"))),
  });
  await page.waitForFunction(() => window.__releaseImport);
  await page.evaluate(() => window.__releaseSignIn());
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toContainText("test-user");
  await page.evaluate(() => window.__releaseImport());
  await expect(page.locator(".document-title")).toHaveText("Imported deck");
  await expect(page.locator("#slide-count")).toHaveText("5");
  expect(await page.evaluate(() => window.__writes)).toHaveLength(0);
});

test("background edits stay on the displayed slide while navigation is pending", async ({
  page,
}) => {
  await story(page);
  await inspector(page);
  await page.evaluate(() => {
    const notes = document.querySelector("#speaker-notes");
    notes.value = "Pending notes";
    notes.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelectorAll(".slide-thumb")[1].click();
    const background = document.querySelector(
      'input[aria-label="Background color"]',
    );
    background.value = "#123456";
    background.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const expected = P.getSlides(createDeck("story")).map(
    (s) => P.getSlideBackground(s).color,
  );
  expected[0] = "#123456";
  expect(P.getSlides(loaded).map((s) => P.getSlideBackground(s).color)).toEqual(
    expected,
  );
});

test("speaker notes queued immediately after undo survive export", async ({
  page,
}) => {
  await story(page);
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await page.evaluate(() => {
    document.querySelector("#undo").click();
    const notes = document.querySelector("#speaker-notes");
    notes.value = "Notes entered while undo was restoring the deck";
    notes.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getSlideNotes(P.getSlides(loaded)[0])).toBe(
    "Notes entered while undo was restoring the deck",
  );
});

test("an edit queued for an object removed by undo preserves redo", async ({
  page,
}) => {
  await story(page);
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await inspector(page);
  await page.evaluate(() => {
    document.querySelector("#undo").click();
    document.querySelector('button[aria-label="Bold"]').click();
  });
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  await downloaded;
  await expect(page.locator(".object-hit")).toHaveCount(7);
  await expect(
    page.getByRole("button", { name: "Redo", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(8);
});

test("duplicating selects the copy and deleting it clears selection", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await expect(page.locator(".object-hit.selected")).toHaveAccessibleName(
    "Make room for big ideas.. Select to edit",
  );
  await expect(page.locator(".object-hit.selected")).not.toHaveAttribute(
    "data-object",
    "1",
  );
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(7);
  await expect(page.locator(".object-hit.selected")).toHaveCount(0);
  await expect(page.locator('[data-object="1"]')).toHaveAccessibleName(
    "Make room for big ideas.. Select to edit",
  );
});

for (const action of ["Delete", "Duplicate"]) {
  test(`queued ${action} keeps its original target when selection changes`, async ({
    page,
  }) => {
    await story(page);
    await page.locator('[data-object="1"]').click();
    await page.evaluate(() => {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => {
        indexedDB.open = open;
        const request = open(...args);
        Object.defineProperty(request, "onsuccess", {
          set(callback) {
            request.addEventListener(
              "success",
              (event) => {
                window.__releaseDraft = () => callback(event);
              },
              { once: true },
            );
          },
        });
        return request;
      };
    });
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => window.__releaseDraft);
    await inspector(page);
    await page.getByRole("button", { name: action, exact: true }).click();
    if (
      await page.getByRole("button", { name: "Close format panel" }).isVisible()
    )
      await page.getByRole("button", { name: "Close format panel" }).click();
    await page.locator('[data-object="0"]').click();
    await page.evaluate(() => window.__releaseDraft());
    await expect(page.locator(".object-hit")).toHaveCount(
      action === "Delete" ? 6 : 8,
    );
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const texts = P.getSlideShapes(P.getSlides(loaded)[0]).map(P.getShapeText);
    expect(
      texts.filter((text) => text.startsWith("Make room for")),
    ).toHaveLength(action === "Delete" ? 0 : 2);
    expect(texts.filter((text) => text === "YOUR NEXT CHAPTER")).toHaveLength(
      1,
    );
    await expect(page.locator(".object-hit.selected")).toHaveAccessibleName(
      "YOUR NEXT CHAPTER. Select to edit",
    );
  });
}

test("hidden slide text is excluded from accessible descriptions", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck();
  const slide = P.addTitleSlide(pres, "Hidden title for later use");
  P.setShapeHidden(
    P.findSlidePlaceholder(slide, "title") ||
      P.findSlidePlaceholder(slide, "ctrTitle"),
    true,
  );
  P.addSlideTextBox(slide, {
    x: P.inches(1),
    y: P.inches(2),
    w: P.inches(5),
    h: P.inches(1),
    text: "Visible audience message",
  });
  P.removeSlide(pres, P.getSlides(pres)[0]);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Hidden text.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "alt",
    /Visible audience message/,
  );
  await expect(page.locator(".slide-image")).not.toHaveAttribute(
    "alt",
    /Hidden title/,
  );
  expect(
    decodeURIComponent(await page.locator(".slide-image").getAttribute("src")),
  ).not.toContain("Hidden title");
  await expect(page.locator(".slide-thumb")).not.toHaveAccessibleName(
    /Hidden title/,
  );
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presenter-slide")).toHaveAttribute(
    "alt",
    "Visible audience message",
  );
});

test("imported font names remain visible and selectable in the format panel", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("story");
  P.setShapeTextFormat(P.getSlideShapes(P.getSlides(pres)[0])[1], {
    font: "Aptos Display",
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Custom font.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  const font = page.getByRole("combobox", { name: "Font family", exact: true });
  await expect(font).toHaveValue("Aptos Display");
  await panel(page).getByRole("button", { name: "Bold", exact: true }).click();
  await expect(
    panel(page).getByRole("button", { name: "Bold", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(font).toHaveValue("Aptos Display");
  await font.selectOption("Georgia");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(
    P.getShapeRunFormat(P.getSlideShapes(P.getSlides(loaded)[0])[1], 0, 0).font,
  ).toBe("Georgia");
});

test("clearing a position field preserves its value while explicit zero remains valid", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  const x = page.getByRole("spinbutton", { name: "X (in)", exact: true });
  await expect(x).toHaveValue("0.8");
  await x.fill("");
  await x.press("Tab");
  await expect(x).toHaveValue("0.8");
  await x.fill("0");
  await x.press("Tab");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getShapeBounds(P.getSlideShapes(P.getSlides(loaded)[0])[1]).x).toBe(
    0,
  );
});

test("numeric input still commits after a pending edit refreshes its field", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await page.evaluate(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      indexedDB.open = open;
      const request = open(...args);
      Object.defineProperty(request, "onsuccess", {
        set(callback) {
          request.addEventListener(
            "success",
            (event) => {
              window.__releaseDraft = () => callback(event);
            },
            { once: true },
          );
        },
      });
      return request;
    };
  });
  await panel(page).getByRole("button", { name: "Bold", exact: true }).click();
  await page.waitForFunction(() => window.__releaseDraft);
  const width = page.getByRole("spinbutton", {
    name: "Width (in)",
    exact: true,
  });
  await width.fill("3");
  await page.evaluate(() => window.__releaseDraft());
  await expect(
    panel(page).getByRole("button", { name: "Bold", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(width).toHaveValue("3");
  await expect(width).toBeFocused();
  await width.press("Tab");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getShapeBounds(P.getSlideShapes(P.getSlides(loaded)[0])[1]).w).toBe(
    P.inches(3),
  );
});

test("an invalid number restores the latest value committed with Enter", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  const width = page.getByRole("spinbutton", {
    name: "Width (in)",
    exact: true,
  });
  await width.fill("3");
  await width.press("Enter");
  await expect(page.locator('[data-object="1"]')).toHaveAttribute(
    "style",
    /width: 22.5%;/,
  );
  await expect(width).toBeFocused();
  await width.fill("");
  await width.press("Tab");
  await expect(width).toHaveValue("3");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getShapeBounds(P.getSlideShapes(P.getSlides(loaded)[0])[1]).w).toBe(
    P.inches(3),
  );
});

for (const [key, label, value, direction, increment] of [
  ["x", "X (in)", -0.2, "Up", 0.01],
  ["y", "Y (in)", -0.2, "Up", 0.01],
  ["w", "Width (in)", 0.1, "Up", 0.01],
  ["h", "Height (in)", 0.1, "Up", 0.01],
  ["w", "Width (in)", 15, "Down", -0.01],
  ["h", "Height (in)", 9, "Down", -0.01],
  ["size", "Font size", 3, "Up", 1],
  ["size", "Font size", 180, "Down", -1],
]) {
  test(`imported ${label} ${value} remains valid and changes without jumping to the normal range`, async ({
    page,
  }) => {
    await start(page);
    const pres = createDeck();
    const bounds = {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(3),
      h: P.inches(2),
    };
    if (key !== "size") bounds[key] = P.inches(value);
    const shape = P.addSlideTextBox(P.getSlides(pres)[0], {
      ...bounds,
      text: "Imported numeric value",
    });
    if (key === "size") P.setShapeTextFormat(shape, { size: value });
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "Numeric bounds.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from(await P.savePresentation(pres)),
    });
    await expect(page.locator(".document-title")).toHaveText("Numeric bounds");
    await inspector(page);
    await page.locator(".object-list-item").click();
    const control = page.getByRole("spinbutton", { name: label, exact: true });
    await expect(control).toHaveValue(String(value));
    expect(await control.evaluate((input) => input.checkValidity())).toBe(true);
    const expected = Number((value + increment).toFixed(2));
    await control.press(`Arrow${direction}`);
    await expect(control).toHaveValue(String(expected));
    await expect(control).toHaveAttribute(
      direction === "Up" ? "min" : "max",
      String(expected),
    );
    // A focused control survives the refresh; validation must use its updated bounds.
    await control.fill(String(value));
    await control.press("Tab");
    await expect(control).toHaveValue(String(expected));
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const loaded = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const result = P.getSlideShapes(P.getSlides(loaded)[0])[0];
    if (key === "size")
      expect(P.getShapeRunFormatEffective(loaded, result, 0, 0).size).toBe(
        expected,
      );
    else bounds[key] = P.inches(expected);
    expect(P.getShapeBounds(result)).toEqual(bounds);
  });
}

test("position and size controls accept hundredth-inch coordinates and step precisely", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await inspector(page);
  await expect(
    page.getByRole("spinbutton", { name: "X (in)", exact: true }),
  ).toHaveValue("0.81");
  await expect(
    page.getByRole("spinbutton", { name: "Y (in)", exact: true }),
  ).toHaveValue("1.81");
  const expected = {};
  for (const [key, label] of [
    ["x", "X (in)"],
    ["y", "Y (in)"],
    ["w", "Width (in)"],
    ["h", "Height (in)"],
  ]) {
    const control = page.getByRole("spinbutton", { name: label, exact: true });
    expect(await control.evaluate((input) => input.checkValidity())).toBe(true);
    const value = Number(
      (Number(await control.inputValue()) + 0.01).toFixed(2),
    );
    await control.press("ArrowUp");
    await expect(control).toHaveValue(String(value));
    await control.press("Tab");
    expected[key] = P.inches(value);
  }
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getShapeBounds(P.getSlideShapes(P.getSlides(loaded)[0])[1])).toEqual(
    expected,
  );
});

test("selected numeric text survives a pending inspector refresh", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await page.evaluate(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      indexedDB.open = open;
      const request = open(...args);
      Object.defineProperty(request, "onsuccess", {
        set(callback) {
          request.addEventListener(
            "success",
            (event) => {
              window.__releaseDraft = () => callback(event);
            },
            { once: true },
          );
        },
      });
      return request;
    };
  });
  await panel(page).getByRole("button", { name: "Bold", exact: true }).click();
  await page.waitForFunction(() => window.__releaseDraft);
  const width = page.getByRole("spinbutton", {
    name: "Width (in)",
    exact: true,
  });
  await width.focus();
  await width.press("ControlOrMeta+a");
  await page.evaluate(() => window.__releaseDraft());
  await expect(
    panel(page).getByRole("button", { name: "Bold", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.type("3");
  await expect(width).toHaveValue("3");
  await expect(width).toBeFocused();
  await width.press("Tab");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getShapeBounds(P.getSlideShapes(P.getSlides(loaded)[0])[1]).w).toBe(
    P.inches(3),
  );
});

for (const [label, first, second] of [
  ["Object text", "First revision", "Second revision"],
  ["Font family", "Georgia", "Verdana"],
  ["Image alternative text", "First description", "Second description"],
]) {
  test(`queued ${label} edits preserve each committed value for undo`, async ({
    page,
  }) => {
    await start(page);
    const pres = createDeck("story");
    P.addSlideImage(
      P.getSlides(pres)[0],
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
        "base64",
      ),
      { x: P.inches(1), y: P.inches(1), w: P.inches(1), h: P.inches(1) },
    );
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "Queued edits.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from(await P.savePresentation(pres)),
    });
    await expect(page.locator(".object-hit")).toHaveCount(8);
    const shapeIndex = label === "Image alternative text" ? 7 : 1;
    await page.locator(`[data-object="${shapeIndex}"]`).click();
    await inspector(page);
    await page.evaluate(() => {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => {
        indexedDB.open = open;
        const request = open(...args);
        Object.defineProperty(request, "onsuccess", {
          set(callback) {
            request.addEventListener(
              "success",
              (event) => {
                window.__releaseDraft = () => callback(event);
              },
              { once: true },
            );
          },
        });
        return request;
      };
    });
    const notes = page.getByRole("textbox", {
      name: "Speaker notes",
      exact: true,
    });
    await notes.fill("Hold this save while editing the format control.");
    await notes.press("Tab");
    await page.waitForFunction(() => window.__releaseDraft);
    const control = page.getByRole(
      label === "Font family" ? "combobox" : "textbox",
      { name: label, exact: true },
    );
    for (const value of [first, second]) {
      if (label === "Font family") await control.selectOption(value);
      else await control.fill(value);
      await control.press("Tab");
    }
    await page.evaluate(() => window.__releaseDraft());
    const exportedValue = async () => {
      await openFileMenu(page);
      const downloaded = page.waitForEvent("download");
      await page
        .getByRole("menuitem", {
          name: "Download PowerPoint (.pptx)",
          exact: true,
        })
        .click();
      const loaded = await parseDeck(
        new Uint8Array(await readFile(await (await downloaded).path())),
      );
      const shape = P.getSlideShapes(P.getSlides(loaded)[0])[shapeIndex];
      return label === "Font family"
        ? P.getShapeRunFormatEffective(loaded, shape, 0, 0).font
        : label === "Object text"
          ? P.getShapeText(shape)
          : P.getShapeDescription(shape);
    };
    expect(await exportedValue()).toBe(second);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(await exportedValue()).toBe(first);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    expect(await exportedValue()).toBe(second);
  });
}

test("queued position and size edits preserve the other dimensions", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await page.evaluate(() => {
    for (const [label, value] of [
      ["X (in)", "2"],
      ["Y (in)", "3"],
      ["Width (in)", "4"],
      ["Height (in)", "2"],
    ]) {
      const input = document.querySelector(`input[aria-label="${label}"]`);
      input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  for (const [label, value] of [
    ["X (in)", "2"],
    ["Y (in)", "3"],
    ["Width (in)", "4"],
    ["Height (in)", "2"],
  ]) {
    await expect(
      page.getByRole("spinbutton", { name: label, exact: true }),
    ).toHaveValue(value);
  }
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "The big idea Recovery draft" })
    .click();
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await expect(
    page.getByRole("spinbutton", { name: "X (in)", exact: true }),
  ).toHaveValue("2");
  await expect(
    page.getByRole("spinbutton", { name: "Width (in)", exact: true }),
  ).toHaveValue("4");
});

test("image descriptions are exposed on the canvas and in presentation mode", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck();
  const image = P.addSlideImage(
    P.getSlides(pres)[0],
    new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
        "base64",
      ),
    ),
    { x: P.inches(1), y: P.inches(1), w: P.inches(3), h: P.inches(3) },
  );
  P.setShapeDescription(image, "Revenue rises steadily across four quarters.");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Accessible.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "alt",
    /Revenue rises steadily/,
  );
  await expect(page.locator(".object-hit")).toHaveAccessibleName(
    /Revenue rises steadily/,
  );
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presenter-slide")).toHaveAttribute(
    "alt",
    /Revenue rises steadily/,
  );
});

test("new text and shapes stay legible on dark and accent slide backgrounds", async ({
  page,
}) => {
  await story(page);
  await themeDialog(page);
  await page.getByRole("button", { name: "Midnight", exact: true }).click();
  await page.getByRole("button", { name: "Apply theme", exact: true }).click();
  await addText(page);
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Rectangle", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(9);
  await page.getByRole("button", { name: /^Slide 5:/ }).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 5 of 5");
  await addText(page);
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Rectangle", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(7);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const colors = (slide) => {
    const shapes = P.getSlideShapes(slide);
    return [
      P.getShapeRunFormat(shapes.at(-2), 0, 0).color.toLowerCase(),
      P.getShapeFillColor(shapes.at(-1)).toLowerCase(),
    ];
  };
  const slides = P.getSlides(loaded);
  // Dark background: light ink and the accent fill.
  expect(colors(slides[0])).toEqual(["#f1f5ee", "#b9d8a0"]);
  // Accent background: dark ink and the panel fill instead of accent on accent.
  expect(colors(slides[4])).toEqual(["#18222b", "#2c3b45"]);
});

test("the slide navigator keeps the active slide in view when it changes", async ({
  page,
}) => {
  await story(page);
  for (let i = 0; i < 10; i++) {
    await openNewSlideMenu(page);
    await page.getByRole("menuitem", { name: "Blank", exact: true }).click();
    await expect(page.locator("#slide-count")).toHaveText(String(6 + i));
  }
  const activeVisible = () =>
    page.evaluate(() => {
      const list = document.querySelector("#slide-list");
      const item = list.querySelector(".slide-item.active");
      const outer = list.getBoundingClientRect();
      const inner = item.getBoundingClientRect();
      return (
        inner.top >= outer.top - 1 &&
        inner.bottom <= outer.bottom + 1 &&
        inner.left >= outer.left - 1 &&
        inner.right <= outer.right + 1
      );
    });
  await expect(page.locator("#slide-position")).toHaveText("Slide 11 of 15");
  expect(await activeVisible()).toBe(true);
  // Ordinary edits leave the navigator where the user scrolled it.
  await page.evaluate(() => {
    const list = document.querySelector("#slide-list");
    list.scrollTop = 0;
    list.scrollLeft = 0;
  });
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  expect(
    await page.evaluate(() => {
      const list = document.querySelector("#slide-list");
      return list.scrollTop + list.scrollLeft;
    }),
  ).toBe(0);
  // Choosing a slide that is scrolled out of view reveals it.
  await page.evaluate(() =>
    document.querySelectorAll(".slide-thumb")[9].click(),
  );
  await expect(page.locator("#slide-position")).toHaveText("Slide 10 of 15");
  expect(await activeVisible()).toBe(true);
  await page.evaluate(() =>
    document.querySelectorAll(".slide-thumb")[0].click(),
  );
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 15");
  expect(await activeVisible()).toBe(true);
});

test("adjusting a color picker is one undo step and keeps the picker input in place", async ({
  page,
}) => {
  await story(page);
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Rectangle", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await inspector(page);
  const fill = page.locator('input[aria-label="Fill color"]');
  await expect(fill).toHaveValue("#315c48");
  await page.evaluate(async () => {
    const input = document.querySelector('input[aria-label="Fill color"]');
    window.__fillInput = input;
    input.focus();
    // Chrome fires input and change for every adjustment while the picker
    // is open; Firefox and Safari fire input during and change on close.
    for (const color of ["#111111", "#222222", "#333333"]) {
      input.value = color;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  });
  await expect(
    page.locator('.color-field:has(input[aria-label="Fill color"]) span'),
  ).toHaveText("#333333");
  expect(
    await page.evaluate(
      () =>
        document.querySelector('input[aria-label="Fill color"]') ===
          window.__fillInput && document.activeElement === window.__fillInput,
    ),
  ).toBe(true);
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const reselect = () =>
    page.evaluate(() => document.querySelector('[data-object="7"]').click());
  // One undo reverts the whole burst; the next removes the rectangle itself.
  await undo.click();
  await reselect();
  await expect(fill).toHaveValue("#315c48");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await reselect();
  await expect(fill).toHaveValue("#333333");
  // A later adjustment after a pause is its own undo step.
  await page.waitForTimeout(1100);
  await page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Fill color"]');
    input.value = "#444444";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(fill).toHaveValue("#444444");
  await undo.click();
  await reselect();
  await expect(fill).toHaveValue("#333333");
  await undo.click();
  await reselect();
  await expect(fill).toHaveValue("#315c48");
  await undo.click();
  await expect(page.locator(".object-hit")).toHaveCount(7);
  await expect(undo).toBeDisabled();
});

test("alignment buttons show the current paragraph alignment", async ({
  page,
}) => {
  await story(page);
  await addText(page);
  await inspector(page);
  const align = (name) =>
    panel(page).getByRole("button", { name: `Align ${name}`, exact: true });
  await expect(align("left")).toHaveAttribute("aria-pressed", "true");
  await expect(align("center")).toHaveAttribute("aria-pressed", "false");
  await align("center").click();
  await expect(align("center")).toHaveAttribute("aria-pressed", "true");
  await expect(align("left")).toHaveAttribute("aria-pressed", "false");
  await align("right").click();
  await expect(align("right")).toHaveAttribute("aria-pressed", "true");
  await expect(align("center")).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.evaluate(() =>
    document.querySelector('[data-object="7"]').click(),
  );
  await expect(align("center")).toHaveAttribute("aria-pressed", "true");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const added = P.getSlideShapes(P.getSlides(loaded)[0]).at(-1);
  expect(P.getParagraphAlignment(added, 0)).toMatch(/^(ctr|center)$/);
});

test("the fullscreen toggle reflects the presentation's fullscreen state", async ({
  page,
}) => {
  await story(page);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const toggle = page.getByRole("button", {
    name: "Toggle fullscreen",
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const windowed = await toggle.innerHTML();
  await toggle.click();
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await toggle.innerHTML()).not.toBe(windowed);
  // Leaving fullscreen through the browser itself is reflected as well.
  await page.evaluate(() => document.exitFullscreen());
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await toggle.innerHTML()).toBe(windowed);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toHaveCount(0);
});

test("the format panel stays between the toolbar and the footer", async ({
  page,
}) => {
  await story(page);
  await inspector(page);
  const measure = () =>
    page.evaluate(() => {
      const rect = (selector) =>
        document.querySelector(selector).getBoundingClientRect();
      const toolbar = rect(".ribbon"),
        panel = rect("#inspector"),
        footer = rect(".editor-footer"),
        canvas = rect(".slide-canvas");
      return {
        belowToolbar: panel.top >= toolbar.bottom - 0.5,
        aboveFooter: panel.bottom <= footer.top + 0.5,
        panelHeight: panel.height,
        canvasBesidePanel: canvas.right <= panel.left + 0.5,
        canvasWidth: canvas.width,
        phone: innerWidth <= 760,
      };
    });
  let geometry = await measure();
  expect(geometry.belowToolbar).toBe(true);
  expect(geometry.aboveFooter).toBe(true);
  expect(geometry.panelHeight).toBeGreaterThan(100);
  // Phones keep the panel as an overlay; wider screens show the whole slide
  // once the canvas has re-fitted to the narrower workspace.
  if (!geometry.phone) {
    await expect
      .poll(async () => (await measure()).canvasBesidePanel)
      .toBe(true);
    geometry = await measure();
    expect(geometry.canvasWidth).toBeGreaterThan(200);
  }
});

test("library search and name sorting use displayed titles rather than file names", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  const rename = async (name) => {
    await page.locator(".document-title").click();
    const input = page.getByRole("textbox", { name: "Presentation name" });
    await input.fill(name);
    await input.press("Enter");
    await expect(page.locator(".document-title")).toHaveText(name);
  };
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await rename("Alpha");
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await rename("Alpha b");
  await expect(page.locator("#save-status")).toContainText(
    "Saved on this device",
  );
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const titles = page.locator(".file-row .file-text strong");
  await expect(titles).toHaveText(["Alpha b", "Alpha"]);
  await page
    .getByRole("combobox", { name: "Sort presentations" })
    .selectOption("name");
  await expect(titles).toHaveText(["Alpha", "Alpha b"]);
  const search = page.getByRole("searchbox", { name: "Search presentations" });
  await search.fill("pptx");
  await expect(
    page.getByRole("heading", { name: "No matching presentations" }),
  ).toBeVisible();
  await search.fill("alpha b");
  await expect(titles).toHaveText(["Alpha b"]);
  await search.fill("alpha");
  await expect(titles).toHaveText(["Alpha", "Alpha b"]);
});

test("the fill field says when a shape has no fill instead of showing a fallback color", async ({
  page,
}) => {
  await story(page);
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Rectangle", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await inspector(page);
  const fillLabel = page.locator(
    '.color-field:has(input[aria-label="Fill color"]) span',
  );
  await expect(fillLabel).toHaveText("#315C48");
  const fillField = page.locator(
    '.color-field:has(input[aria-label="Fill color"])',
  );
  await expect(fillField).not.toHaveClass(/empty/);
  await page.getByRole("button", { name: "Remove fill", exact: true }).click();
  await expect(fillLabel).toHaveText("No fill");
  await expect(fillField).toHaveClass(/empty/);
  await page.evaluate(() =>
    document.querySelector('[data-object="1"]').click(),
  );
  await expect(fillLabel).toHaveText("No fill");
  await page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Fill color"]');
    input.value = "#123456";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(fillLabel).toHaveText("#123456");
  await page.evaluate(() =>
    document.querySelector('[data-object="3"]').click(),
  );
  await expect(fillLabel).toHaveText("#DCE5DA");
});

test("the browser brand color follows the effective appearance", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await start(page);
  const themeColor = page.locator('meta[name="theme-color"]');
  await expect(themeColor).toHaveAttribute("content", "#f08b73");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(themeColor).toHaveAttribute("content", "#c44730");
  // An explicit choice overrides the system setting and persists.
  await page.getByRole("button", { name: "Account and settings" }).click();
  await page.getByRole("menuitem", { name: "Appearance", exact: true }).click();
  await page.getByRole("combobox", { name: "Color mode" }).selectOption("dark");
  await expect(themeColor).toHaveAttribute("content", "#f08b73");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(themeColor).toHaveAttribute("content", "#f08b73");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "Account and settings" }).click();
  await page.getByRole("menuitem", { name: "Appearance", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Color mode" })
    .selectOption("light");
  await expect(themeColor).toHaveAttribute("content", "#c44730");
});

test("dropping an image while editing inserts it on the current slide", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() =>
    document.querySelectorAll(".slide-thumb")[1].click(),
  );
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 5");
  const drop = (bytes, name, type) =>
    page.evaluate(
      ({ bytes, name, type }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], name, { type }));
        document.querySelector("#slide-canvas").dispatchEvent(
          new DragEvent("drop", {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { bytes, name, type },
    );
  await drop(
    Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
        "base64",
      ),
    ),
    "Sketch.png",
    "image/png",
  );
  await expect(
    page.getByRole("button", { name: "Image: Sketch.png. Select to edit" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 5");
  await expect(page).toHaveTitle("The big idea | Presentation");
  // Dropped presentations still open as imports.
  await drop(
    Array.from(await P.savePresentation(createDeck("pitch", "cobalt"))),
    "Dropped deck.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  await expect(page).toHaveTitle("Dropped deck | Presentation");
  await expect(page.locator("#slide-count")).toHaveText("5");
});

test("the canvas shows the same render as the active slide thumbnail", async ({
  page,
}) => {
  await story(page);
  const same = () =>
    page.evaluate(
      () =>
        document.querySelector(".slide-image").getAttribute("src") ===
        document
          .querySelector(".slide-item.active .slide-thumb img")
          .getAttribute("src"),
    );
  expect(await same()).toBe(true);
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(8);
  expect(await same()).toBe(true);
  await page.evaluate(() =>
    document.querySelectorAll(".slide-thumb")[2].click(),
  );
  await expect(page.locator("#slide-position")).toHaveText("Slide 3 of 5");
  expect(await same()).toBe(true);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 3 of 5");
  expect(await same()).toBe(true);
});

test("the library address works from the address bar while the editor is open", async ({
  page,
  baseURL,
}) => {
  await story(page);
  await expect(page.locator("#save-status")).toContainText(
    "Saved on this device",
  );
  // Only the fragment changes, so the page does not reload.
  await page.evaluate(() => {
    location.hash = "#/home";
  });
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "The big idea Recovery draft" }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#/home");
  // Leaving the library address opens a new presentation, as a fresh load
  // of that address does.
  await page.evaluate(() => {
    location.hash = "";
  });
  await expect(page.locator(".document-title")).toHaveText(
    "Untitled presentation",
  );
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  expect(page.url()).toBe(new URL("/", baseURL).href);
  await expect(page.locator("#save-status")).toContainText("Not saved yet");
});

test("focus lands on the main region when the home and editor screens replace each other", async ({
  page,
}) => {
  await start(page);
  expect(
    await page.evaluate(() => document.activeElement === document.body),
  ).toBe(true);
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
  await expect(page.locator("main.workspace")).toBeFocused();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.activeElement).outlineStyle,
    ),
  ).toBe("none");
  await page.keyboard.press("Tab");
  await expect(page.locator('[data-object="0"]')).toBeFocused();
  await page.getByRole("button", { name: "Back to presentations" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  await expect(page.locator("main.home-main")).toBeFocused();
});

test("the shortcuts dialog documents every editor and presentation shortcut", async ({
  page,
}) => {
  await story(page);
  await openFileMenu(page);
  await page
    .getByRole("menuitem", { name: "Keyboard shortcuts", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  for (const [keys, action] of [
    ["Ctrl / ⌘ + Shift + Z or Ctrl / ⌘ + Y", "Redo"],
    ["Enter", "Edit text of the selected object"],
    ["Ctrl / ⌘ + Enter", "Finish editing text"],
    ["Home / End in presentation", "First or last slide"],
  ]) {
    const row = dialog
      .locator(".shortcuts > div")
      .filter({ has: page.getByText(action, { exact: true }) });
    await expect(row.locator("kbd")).toHaveText(keys);
  }
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // The documented alternative redo shortcut works.
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".object-hit")).toHaveCount(7);
  await page.keyboard.press("Control+y");
  await expect(page.locator(".object-hit")).toHaveCount(8);
});

test("dragging a slide thumbnail onto the canvas is not treated as a file import", async ({
  page,
}) => {
  await story(page);
  for (const image of await page.locator(".slide-thumb img").all())
    await expect(image).toHaveAttribute("draggable", "false");
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "draggable",
    "false",
  );
  await page
    .locator(".slide-thumb img")
    .nth(1)
    .dragTo(page.locator("#slide-canvas"));
  await page.waitForTimeout(300);
  await expect(page.locator("#toast")).not.toContainText("PowerPoint");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  for (const image of await page.locator(".template-preview img").all())
    await expect(image).toHaveAttribute("draggable", "false");
});

test("a file held over the window says what dropping it will do", async ({
  page,
}) => {
  await story(page);
  const overlay = page.locator("#drop-overlay");
  // A held file repeats `dragover` the way the browser does while one hovers.
  // Its bytes and name stay withheld until the drop, so the promise below is
  // made from the type alone.
  const hold = (type) =>
    page.evaluate((type) => {
      clearInterval(window.__held);
      const over = () => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array()], "Held", { type }));
        document.querySelector("#slide-canvas").dispatchEvent(
          new DragEvent("dragover", {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      over();
      window.__held = setInterval(over, 100);
    }, type);
  const release = () => page.evaluate(() => clearInterval(window.__held));
  await hold(
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  await expect(overlay).toHaveClass(/visible/);
  await expect(overlay).toHaveText("Drop to open a presentation");
  // An image joins the slide being edited instead of replacing the deck.
  await hold("image/png");
  await expect(overlay).toHaveText("Drop to add the image to this slide");
  // The overlay lives on those repeats, so a file carried back out of the
  // window clears it without waiting for a `dragleave`.
  await release();
  await expect(overlay).not.toHaveClass(/visible/);
  // Nothing is promised behind a dialog, where the drop is ignored.
  await page.locator(".document-title").click();
  await expect(
    page.getByRole("textbox", { name: "Presentation name" }),
  ).toBeVisible();
  await hold(
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  await expect(overlay).not.toHaveClass(/visible/);
  await release();
});

test("file drops are ignored while a dialog is open", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "Account and settings" }).click();
  await page.getByRole("menuitem", { name: "Appearance", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Appearance" });
  await expect(dialog).toBeVisible();
  const bytes = Array.from(await P.savePresentation(createDeck("pitch")));
  const drop = () =>
    page.evaluate((bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], "Dropped deck.pptx", {
          type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }),
      );
      document.body.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, bytes);
  await drop();
  await page.waitForTimeout(500);
  await expect(dialog).toBeVisible();
  await expect(page).toHaveTitle("Presentation");
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await drop();
  await expect(page).toHaveTitle("Dropped deck | Presentation");
});

test("inactive slide thumbnails show a hover affordance without hiding the active border", async ({
  page,
}) => {
  await story(page);
  const border = (index) =>
    page.evaluate(
      (index) =>
        getComputedStyle(document.querySelectorAll(".slide-thumb")[index])
          .borderTopColor,
      index,
    );
  const idle = await border(1);
  expect(idle).toBe("rgba(0, 0, 0, 0)");
  const active = await border(0);
  await page.locator(".slide-thumb").nth(1).hover();
  await expect.poll(() => border(1)).not.toBe(idle);
  await page.locator(".slide-thumb").nth(0).hover();
  expect(await border(0)).toBe(active);
});

test("autosave waits while offline and resumes when the connection returns", async ({
  page,
  context,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await page.getByRole("button", { name: /^(Save|Sign in to save)$/ }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  const writes = () => page.evaluate(() => window.__writes.length);
  expect(await writes()).toBe(1);
  await context.setOffline(true);
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await expect(page.locator("#save-status")).toContainText(
    "Saved on this device",
  );
  await page.waitForTimeout(2000);
  expect(await writes()).toBe(1);
  await expect(page.locator("#toast")).not.toHaveClass(/visible/);
  await context.setOffline(false);
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  expect(await writes()).toBe(2);
});

test("the slide canvas fits short windows without a scrollbar and keeps its aspect ratio", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "viewport sizes are desktop specific",
  );
  await page.setViewportSize({ width: 1366, height: 768 });
  await story(page);
  const measure = () =>
    page.evaluate(() => {
      const area = document.querySelector("#canvas-area");
      const canvas = document.querySelector("#slide-canvas");
      const label = area.querySelector(".canvas-label");
      const a = area.getBoundingClientRect(),
        c = canvas.getBoundingClientRect();
      return {
        overflow: area.scrollHeight - area.clientHeight,
        inside: c.top >= a.top && c.bottom <= a.bottom,
        width: Math.round(c.width),
        ratio: Math.round((c.width / c.height) * 100) / 100,
        // The label above the slide, where the layout shows one.
        labelMatches:
          !label.offsetWidth ||
          Math.abs(label.getBoundingClientRect().width - c.width) < 1,
        available: Math.round(area.clientWidth),
      };
    });
  let m = await measure();
  expect(m.overflow).toBe(0);
  expect(m.inside).toBe(true);
  expect(m.ratio).toBe(1.78);
  expect(m.labelMatches).toBe(true);
  expect(m.width).toBeLessThan(m.available - 60);
  // Taller windows let the slide grow back up to its width limit.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(async () => (await measure()).width).toBe(1200);
  m = await measure();
  expect(m.overflow).toBe(0);
  expect(m.ratio).toBe(1.78);
  // Overlays still track the canvas after it resizes.
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(async () => (await measure()).overflow).toBe(0);
  const hit = await page.locator('[data-object="1"]').boundingBox();
  const canvas = await page.locator("#slide-canvas").boundingBox();
  expect(hit.x).toBeGreaterThanOrEqual(canvas.x);
  expect(hit.x + hit.width).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
});

test("the slide object list matches the canvas by omitting hidden shapes and naming images", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck();
  const slide = P.addTitleSlide(pres, "Hidden title for later use");
  P.setShapeHidden(
    P.findSlidePlaceholder(slide, "title") ||
      P.findSlidePlaceholder(slide, "ctrTitle"),
    true,
  );
  const subtitle = P.findSlidePlaceholder(slide, "subTitle");
  if (subtitle) P.removeShape(subtitle);
  P.addSlideTextBox(slide, {
    x: P.inches(1),
    y: P.inches(2),
    w: P.inches(5),
    h: P.inches(1),
    text: "Visible audience message",
  });
  const picture = P.addSlideImage(
    slide,
    new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
        "base64",
      ),
    ),
    { x: P.inches(1), y: P.inches(4), w: P.inches(2), h: P.inches(2) },
  );
  P.setShapeDescription(picture, "Team photo");
  P.removeSlide(pres, P.getSlides(pres)[0]);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Hidden objects.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".document-title")).toHaveText("Hidden objects");
  await inspector(page);
  const items = page.locator(".object-list-item");
  await expect(items).toHaveText([
    "Visible audience message",
    "Image: Team photo",
  ]);
  await items.nth(1).click();
  await expect(
    page.getByRole("textbox", { name: "Image alternative text" }),
  ).toHaveValue("Team photo");
});

for (const action of ["moving", "resizing"]) {
  test(`${action} shows one selection whose handle follows the pointer`, async ({
    page,
  }) => {
    await story(page);
    const title = page.locator('[data-object="1"]');
    const panel = page.getByRole("button", {
      name: "Rectangle 5. Select to edit",
    });
    // The title starts selected so its chrome must give way to the panel.
    await title.click();
    await expect(page.locator(".resize-handle")).toHaveCount(8);
    if (action === "resizing") await panel.click();
    const grip =
      action === "resizing"
        ? page.locator('.resize-handle[data-handle="se"]')
        : panel;
    const box = await grip.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 - 40,
      box.y + box.height / 2 + 30,
      { steps: 4 },
    );
    await expect(page.locator(".object-hit.selected")).toHaveCount(1);
    await expect(panel).toHaveAttribute("aria-pressed", "true");
    await expect(title).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".resize-handle")).toHaveCount(8);
    const outline = await panel.boundingBox();
    const handle = await page
      .locator('.resize-handle[data-handle="se"]')
      .boundingBox();
    expect(
      Math.abs(handle.x + handle.width / 2 - (outline.x + outline.width)),
    ).toBeLessThan(2);
    expect(
      Math.abs(handle.y + handle.height / 2 - (outline.y + outline.height)),
    ).toBeLessThan(2);
    await page.mouse.up();
    await expect(panel).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".object-hit.selected")).toHaveCount(1);
    await expect(page.locator(".resize-handle")).toHaveCount(8);
    await expect(
      page.getByRole("button", { name: "Undo", exact: true }),
    ).toBeEnabled();
  });
}

for (const action of ["Align left", "Remove fill", "retyped X position"]) {
  test(`${action} on an object already in that state preserves redo history`, async ({
    page,
  }) => {
    await story(page);
    await addText(page);
    await expect(page.locator(".object-hit")).toHaveCount(8);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.locator(".object-hit")).toHaveCount(7);
    // The title is left aligned with no fill at X = 0.8 in.
    await page.locator('[data-object="1"]').click();
    await inspector(page);
    if (action === "retyped X position") {
      const x = page.getByRole("spinbutton", { name: "X (in)" });
      await expect(x).toHaveValue("0.8");
      await x.fill("0.80");
      await x.press("Enter");
      await expect(x).toHaveValue("0.8");
    } else {
      const control = panel(page).getByRole("button", {
        name: action,
        exact: true,
      });
      if (action === "Align left")
        await expect(control).toHaveAttribute("aria-pressed", "true");
      else
        await expect(
          page.locator(
            '.color-field.empty:has(input[aria-label="Fill color"])',
          ),
        ).toHaveText("No fill");
      await control.click();
    }
    await expect(
      page.getByRole("button", { name: "Redo", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Undo", exact: true }),
    ).toBeDisabled();
    await expect(page.locator("#save-status")).toContainText(
      "Saved on this device",
    );
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(page.locator(".object-hit")).toHaveCount(8);
  });
}

for (const [card, title, background] of [
  ["A new perspective A warmer point of view", "A new perspective", "#FCF1EB"],
  ["The pitch Make your next move", "The pitch", "#F0F4FC"],
  ["The big idea A clear, considered story", "The big idea", "#F5F3EE"],
  ["Blank presentation A fresh canvas", "Untitled presentation", "#F5F3EE"],
]) {
  test(`the “${card.split(" ").slice(0, 3).join(" ")}” card names its presentation after itself`, async ({
    page,
  }) => {
    await start(page);
    await page.getByRole("button", { name: card }).click();
    await expect(page.locator(".document-title")).toHaveText(title);
    await expect(page).toHaveTitle(`${title} | Presentation`);
    await inspector(page);
    await expect(page.locator(".color-field span")).toHaveText(background);
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await expect(
      page.locator(".file-row strong", { hasText: title }),
    ).toHaveCount(1);
  });
}

test("printing reuses the navigator's slide renders", async ({ page }) => {
  await story(page);
  const thumbnails = page.locator(".slide-thumb img");
  const sources = [];
  for (let i = 0; i < 5; i++)
    sources.push(await thumbnails.nth(i).getAttribute("src"));
  await page.evaluate(() => {
    window.print = () => {
      window.__printStarted = true;
    };
  });
  await countSvgRenders(page);
  await printFromMenu(page);
  await page.waitForFunction(() => window.__printStarted);
  expect(
    await page.$$eval("#print-slides img", (images) =>
      images.map((image) => image.getAttribute("src")),
    ),
  ).toEqual(sources);
  expect(await page.evaluate(() => window.__svgRenders)).toBe(0);
});

test("slide options are visible without hovering on touch screens", async ({
  page,
}) => {
  await story(page);
  const coarse = await page.evaluate(
    () => matchMedia("(pointer: coarse)").matches,
  );
  expect(coarse).toBe(test.info().project.name !== "desktop");
  const options = page.getByRole("button", {
    name: "Options for slide 2",
    exact: true,
  });
  await expect(options).toHaveCSS("opacity", coarse ? "1" : "0");
  if (!coarse) {
    await page.locator(".slide-thumb").nth(1).hover();
    await expect(options).toHaveCSS("opacity", "1");
  }
  await options.click();
  await expect(
    page.getByRole("menuitem", { name: "Duplicate slide", exact: true }),
  ).toBeVisible();
});

test("dropping an unsupported image while editing explains the image formats", async ({
  page,
}) => {
  await story(page);
  const drop = (name, type) =>
    page.evaluate(
      ({ name, type }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(64)], name, { type }));
        document.querySelector("#slide-canvas").dispatchEvent(
          new DragEvent("drop", {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { name, type },
    );
  await drop("Animation.gif", "image/gif");
  await expect(page.locator("#toast")).toHaveText(
    "Choose a PNG or JPEG image.",
  );
  await expect(page.locator(".object-hit")).toHaveCount(7);
  await expect(page).toHaveTitle("The big idea | Presentation");
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  await drop("Notes.txt", "text/plain");
  await expect(page.locator("#toast")).toHaveText(
    "Choose a PowerPoint (.pptx) file.",
  );
  await expect(page).toHaveTitle("The big idea | Presentation");
});

test("the font size field steps by whole points and still accepts half sizes", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  const size = page.getByRole("spinbutton", { name: "Font size" });
  await expect(size).toHaveValue("52");
  await size.press("ArrowUp");
  await expect(size).toHaveValue("53");
  await size.press("ArrowDown");
  await size.press("ArrowDown");
  await expect(size).toHaveValue("51");
  await size.fill("10.5");
  await size.press("Enter");
  await expect(size).toHaveValue("10.5");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(
    P.getShapeRunFormatEffective(
      loaded,
      P.getSlideShapes(P.getSlides(loaded)[0])[1],
      0,
      0,
    ).size,
  ).toBe(10.5);
});

test("hidden slides are marked in the navigator and can be shown or hidden again", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("story");
  P.setSlideHidden(P.getSlides(pres)[0], true);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Hidden.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const rows = page.locator(".slide-item");
  await expect(rows.nth(0)).toHaveClass(/hidden-slide/);
  await expect(rows.nth(0).locator(".slide-hidden")).toHaveText("Hidden");
  await expect(rows.nth(0).locator(".slide-thumb")).toHaveAccessibleName(
    /^Slide 1 \(hidden\): YOUR NEXT CHAPTER/,
  );
  await expect(rows.nth(1)).not.toHaveClass(/hidden-slide/);
  await expect(page.locator(".slide-hidden")).toHaveCount(1);
  await expect(page.locator("#slide-label")).toHaveText("SLIDE 01 · HIDDEN");
  // Showing the slide brings it back into the presentation.
  await page
    .getByRole("button", { name: "Options for slide 1", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Show slide", exact: true }).click();
  await expect(page.locator(".slide-hidden")).toHaveCount(0);
  await expect(page.locator("#slide-label")).toHaveText("SLIDE 01");
  await expect(rows.nth(0).locator(".slide-thumb")).toHaveAccessibleName(
    /^Slide 1: YOUR NEXT CHAPTER/,
  );
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presenter-controls")).toContainText("1 / 5");
  await page.keyboard.press("Escape");
  // Hiding is an ordinary edit: undo restores the hidden state and it exports.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(rows.nth(0)).toHaveClass(/hidden-slide/);
  await page
    .getByRole("button", { name: "Options for slide 2", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Hide slide", exact: true }).click();
  await expect(page.locator(".slide-hidden")).toHaveCount(2);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getSlides(loaded).map(P.isSlideHidden)).toEqual([
    true,
    true,
    false,
    false,
    false,
  ]);
});

test("a large deck renders distant thumbnails in idle time, once each", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("story");
  const originals = P.getSlides(pres);
  while (P.getSlides(pres).length < 40)
    P.duplicateSlide(pres, originals[P.getSlides(pres).length % 5]);
  await countSvgRenders(page);
  await page.evaluate(() => {
    window.__idle = [];
    window.requestIdleCallback = (callback) => {
      window.__idle.push(callback);
      return window.__idle.length;
    };
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Forty.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator("#slide-count")).toHaveText("40");
  const thumbnails = page.locator(".slide-thumb img");
  const pending = page.locator(".slide-thumb img:not([src])");
  // Only the current slide's neighbourhood rendered while the deck opened.
  expect(await page.evaluate(() => window.__svgRenders)).toBeLessThan(20);
  expect(await pending.count()).toBeGreaterThan(15);
  await expect(thumbnails.nth(0)).toHaveAttribute("src", /^data:/);
  // Choosing a distant slide renders it for the canvas and fills its thumbnail.
  await page.evaluate(() =>
    document.querySelectorAll(".slide-thumb")[39].click(),
  );
  await expect(page.locator("#slide-position")).toHaveText("Slide 40 of 40");
  await expect(thumbnails.nth(39)).toHaveAttribute("src", /^data:/);
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "src",
    await thumbnails.nth(39).getAttribute("src"),
  );
  // Scrolling reveals thumbnails, which render without waiting for idle time.
  await page.evaluate(() =>
    document.querySelectorAll(".slide-thumb")[38].scrollIntoView(),
  );
  await expect(thumbnails.nth(38)).toHaveAttribute("src", /^data:/);
  await expect(thumbnails.nth(37)).toHaveAttribute("src", /^data:/);
  // Idle time renders the rest exactly once each.
  await page.evaluate(() => {
    while (window.__idle.length)
      window.__idle.shift()({ didTimeout: false, timeRemaining: () => 50 });
  });
  await expect(pending).toHaveCount(0);
  expect(await page.evaluate(() => window.__svgRenders)).toBe(40);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await expect(page.locator(".presenter-controls")).toContainText("40 / 40");
  expect(await page.evaluate(() => window.__svgRenders)).toBe(40);
});

test("sorting by name orders numbered presentations naturally", async ({
  page,
}) => {
  await start(page);
  for (const name of ["Deck 10", "deck 1", "Deck 2"]) {
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await page.locator(".document-title").click();
    const input = page.getByRole("textbox", { name: "Presentation name" });
    await input.fill(name);
    await input.press("Enter");
    await expect(page.locator(".document-title")).toHaveText(name);
    await page.getByRole("button", { name: "Back to presentations" }).click();
  }
  const titles = page.locator(".file-row .file-text strong");
  await expect(titles).toHaveText(["Deck 2", "deck 1", "Deck 10"]);
  await page
    .getByRole("combobox", { name: "Sort presentations" })
    .selectOption("name");
  await expect(titles).toHaveText(["deck 1", "Deck 2", "Deck 10"]);
});

test("resizing an image by its handle keeps its proportions unless Shift is held", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  const chooser = page.waitForEvent("filechooser");
  await insertImage(page);
  await (
    await chooser
  ).setFiles({
    name: "Square.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const width = page.getByRole("spinbutton", { name: "Width (in)" });
  const height = page.getByRole("spinbutton", { name: "Height (in)" });
  // On narrow screens the format panel covers the canvas, so it is opened
  // only to read values and closed again before each drag.
  // Drags and insertions commit through the mutation queue, so wait for the
  // width to move on from its previous value before reading the fields.
  const fields = async (previousWidth) => {
    await inspector(page);
    if (previousWidth) await expect(width).not.toHaveValue(previousWidth);
    const values = [await width.inputValue(), await height.inputValue()];
    const close = page.getByRole("button", { name: "Close format panel" });
    if (await close.isVisible()) await close.click();
    return values;
  };
  const drag = async (dx, dy, shift = false) => {
    const handle = page.locator('.resize-handle[data-handle="se"]');
    // Closing the panel re-fits the canvas through a ResizeObserver, so let
    // the handle settle before measuring it; hovering waits for that.
    await handle.hover();
    const box = await handle.boundingBox();
    await page.mouse.down();
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(
      box.x + box.width / 2 + dx,
      box.y + box.height / 2 + dy,
      { steps: 3 },
    );
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
  };
  expect(await fields()).toEqual(["4", "4"]);
  // A mostly horizontal drag scales both sides by the same factor.
  await drag(40, 5);
  await expect(page.locator("#undo")).toBeEnabled();
  const [w1, h1] = await fields("4");
  expect(Number(w1)).toBeGreaterThan(4);
  expect(w1).toBe(h1);
  const preview = await page.locator(".object-hit.selected").boundingBox();
  expect(Math.abs(preview.width - preview.height)).toBeLessThan(1.5);
  // Shift resizes freely, as shapes and text boxes always do.
  await drag(-30, 10, true);
  const [w2, h2] = await fields(w1);
  expect(w2).not.toBe(h2);
  await addText(page);
  expect(await fields(w2)).toEqual(["6.5", "1"]);
  await drag(30, 0);
  const [w3, h3] = await fields("6.5");
  expect(Number(w3)).toBeGreaterThan(6.5);
  expect(h3).toBe("1");
});

test("long object labels end at a word with an ellipsis in the object list", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck();
  const slide = P.getSlides(pres)[0];
  const long =
    "The quick brown fox jumps over the lazy dog while the sleepy cat watches from the windowsill above the garden";
  P.addSlideTextBox(slide, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(8),
    h: P.inches(2),
    text: long,
  });
  P.addSlideTextBox(slide, {
    x: P.inches(1),
    y: P.inches(4),
    w: P.inches(8),
    h: P.inches(1),
    text: "Presented by \nFrey Munch",
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Labels.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await inspector(page);
  await expect(page.locator(".object-list-item")).toHaveText([
    "The quick brown fox jumps over the lazy dog while the sleepy cat watches from…",
    "Presented by Frey Munch",
  ]);
  // The canvas keeps the complete text for screen readers.
  await expect(page.locator(".object-hit").first()).toHaveAccessibleName(
    `${long}. Select to edit`,
  );
});

test("a narrow ribbon folds its groups into drop-downs that keep their commands", async ({
  page,
}) => {
  await story(page);
  const font = page.locator(
    '.ribbon-panel:not([hidden]) [data-command="font-name"]',
  );
  // A wide window shows the font controls in the ribbon itself.
  if (test.info().project.name === "desktop") {
    await expect(font).toBeVisible();
    return;
  }
  await expect(font).toBeHidden();
  await page
    .locator(
      '.ribbon-panel:not([hidden]) .ribbon-group:has([data-command="font-name"]) > .ribbon-fold',
    )
    .click();
  const panel = page.locator(".ribbon-fold-panel");
  await expect(
    panel.getByRole("combobox", { name: "Font", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  // The menus still work beside a folded ribbon.
  await themeDialog(page);
  await expect(
    page.getByRole("heading", { name: "Presentation theme" }),
  ).toBeVisible();
});

test("empty placeholders in an imported deck can be formatted and filled in", async ({
  page,
}) => {
  await start(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // An untouched subtitle placeholder is saved in .pptx files as a
  // paragraph without runs.
  const original = P.createPresentation();
  P.addTitleSlide(original, "Hello", "");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Placeholders.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(original)),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  const closePanel = async () => {
    const close = page.getByRole("button", { name: "Close format panel" });
    if (await close.isVisible()) await close.click();
  };
  await inspector(page);
  await expect(page.locator(".object-list-item").nth(1)).toHaveText(
    "Subtitle 2",
  );
  await closePanel();
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  // The panel reports the format typed text will take.
  await expect(page.getByRole("combobox", { name: "Font family" })).toHaveValue(
    "Calibri",
  );
  await expect(page.getByRole("spinbutton", { name: "Font size" })).toHaveValue(
    "32",
  );
  const bold = panel(page).getByRole("button", { name: "Bold", exact: true });
  await bold.click();
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await closePanel();
  await page.locator('[data-object="1"]').dblclick();
  const input = page.getByRole("textbox", { name: "Edit text", exact: true });
  await input.fill("A subtitle at last");
  await input.press("Control+Enter");
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "alt",
    /A subtitle at last/,
  );
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const subtitle = P.getSlideShapes(P.getSlides(loaded)[0])[1];
  expect(P.getShapeText(subtitle)).toBe("A subtitle at last");
  expect(P.getShapeRunFormatEffective(loaded, subtitle, 0, 0)).toMatchObject({
    bold: true,
    size: 32,
  });
  expect(errors).toEqual([]);
});

test("the format panel shows the color an imported theme fill resolves to", async ({
  page,
}) => {
  await start(page);
  // .pptx files usually store fills as theme color references.
  const original = P.createPresentation();
  const slide = P.addBlankSlide(original);
  const rect = P.addSlideShape(slide, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(3),
    h: P.inches(2),
    preset: "rect",
  });
  P.setShapeFill(rect, "accent1");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Theme fill.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(original)),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  await page.locator('[data-object="0"]').click();
  await inspector(page);
  const fill = page.locator('.color-field:has(input[aria-label="Fill color"])');
  await expect(fill).toHaveText("#4F81BD");
  await expect(fill.locator("input")).toHaveValue("#4f81bd");
  await expect(fill).not.toHaveClass(/empty/);
});

test("grouped shapes are selected, moved, and measured where the slide shows them", async ({
  page,
}) => {
  await start(page);
  const original = P.createPresentation();
  const slide = P.addBlankSlide(original);
  const box = (x) => ({
    x: P.inches(x),
    y: P.inches(1),
    w: P.inches(2),
    h: P.inches(1),
  });
  const rect = P.addSlideTextBox(slide, { ...box(1), text: "Grouped" });
  P.setShapeFill(rect, "#ff0000");
  P.setShapeTextFormat(rect, { size: 18 });
  const group = P.groupShapes(
    [rect, P.addSlideShape(slide, { ...box(3.5), preset: "ellipse" })],
    { name: "Pair" },
  );
  // A resized group keeps its children's numbers and scales them onto the
  // slide through the group transform: this one is twice its children's size.
  const bounds = P.getShapeBounds(group);
  P.setShapeBounds(group, {
    x: P.inches(2),
    y: P.inches(2),
    w: bounds.w * 2,
    h: bounds.h * 2,
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Grouped.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(original)),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  const percentages = (locator) =>
    locator.evaluate((node) =>
      ["left", "top", "width", "height"].map((key) =>
        parseFloat(node.style[key]),
      ),
    );
  // An edit lands after its mutation settles, so the placement is polled.
  const expectPlacement = async (locator, [x, y, w, h]) => {
    const expected = [x, y, w, h].map(
      (inches, i) => (inches / (i % 2 ? 7.5 : 13.333)) * 100,
    );
    await expect
      .poll(async () =>
        (await percentages(locator)).every(
          (value, i) => Math.abs(value - expected[i]) < 0.05,
        ),
      )
      .toBe(true);
  };
  const child = page.getByRole("button", { name: /^Grouped\./ });
  await expectPlacement(
    page.getByRole("button", { name: /^Pair\./ }),
    [2, 2, 9, 2],
  );
  await expectPlacement(child, [2, 2, 4, 2]);
  await child.click();
  await inspector(page);
  const field = (label) => page.locator(`input[aria-label="${label}"]`);
  await expect(field("X (in)")).toHaveValue("2");
  await expect(field("Y (in)")).toHaveValue("2");
  await expect(field("Width (in)")).toHaveValue("4");
  await expect(field("Height (in)")).toHaveValue("2");
  // The selection chrome sits on the projected bounds.
  expect(await percentages(page.locator(".selection-box"))).toEqual([
    expect.closeTo((2 / 13.333) * 100, 1),
    expect.closeTo((2 / 7.5) * 100, 1),
    expect.closeTo((4 / 13.333) * 100, 1),
    expect.closeTo((2 / 7.5) * 100, 1),
  ]);
  // Its text edits at the size the doubled group shows it: 18 pt inside a
  // twice-scaled group reads like 36 pt. (On phones the panel covers the
  // canvas, so it closes first.)
  const closePanel = page.getByRole("button", { name: "Close format panel" });
  if (await closePanel.isVisible()) await closePanel.click();
  await child.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toHaveText("Grouped");
  const canvasWidth = await page
    .locator("#slide-canvas")
    .evaluate((node) => node.clientWidth);
  expect(
    parseFloat(await editor.evaluate((node) => node.style.fontSize)),
  ).toBeCloseTo(Math.max(14, (36 / 72 / (12192000 / 914400)) * canvasWidth), 0);
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await inspector(page);
  // Nudging moves the shape by a hundredth of an inch on the slide.
  await child.press("ArrowRight");
  await expect(field("X (in)")).toHaveValue("2.01");
  await expectPlacement(child, [2.01, 2, 4, 2]);
  // Typed sizes are slide sizes too.
  await field("Width (in)").fill("5");
  await field("Width (in)").press("Enter");
  await expect(field("Width (in)")).toHaveValue("5");
  await expectPlacement(child, [2.01, 2, 5, 2]);
  // A duplicate leaves the group and lands beside the original at the same
  // size the slide showed.
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(4);
  await expect(field("X (in)")).toHaveValue("2.16");
  await expect(field("Width (in)")).toHaveValue("5");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shapes = P.getSlideShapes(P.getSlides(loaded)[0]);
  const savedGroup = shapes.find((s) => P.getShapeKind(s) === "group");
  expect(P.getGroupTransform(savedGroup)).toEqual(P.getGroupTransform(group));
  // The child's own numbers moved by half as much inside the doubled group.
  expect(P.getShapeBounds(P.getGroupChildren(savedGroup)[0])).toEqual({
    x: P.inches(1) + P.inches(0.01) / 2,
    y: P.inches(1),
    w: P.inches(2.5),
    h: P.inches(1),
  });
  expect(P.getShapeBounds(shapes.at(-1))).toEqual({
    x: P.inches(2.16),
    y: P.inches(2.15),
    w: P.inches(5),
    h: P.inches(2),
  });
});

test("the format panel offers a fill only for shapes that can take one", async ({
  page,
}) => {
  await start(page);
  // Imported decks group shapes and carry tables and lines, none of which
  // accept a fill; the library refuses one with an internal error.
  const original = P.createPresentation();
  const slide = P.addBlankSlide(original);
  const box = (x) => ({
    x: P.inches(x),
    y: P.inches(1),
    w: P.inches(2),
    h: P.inches(1),
  });
  P.addSlideShape(slide, { ...box(1), preset: "rect" });
  P.groupShapes(
    [
      P.addSlideShape(slide, { ...box(4), preset: "rect" }),
      P.addSlideShape(slide, { ...box(6.5), preset: "ellipse" }),
    ],
    { name: "Pair" },
  );
  P.addSlideTable(slide, {
    ...box(1),
    y: P.inches(3),
    w: P.inches(5),
    rows: [["Q1", "Q2"]],
  });
  P.addSlideLine(slide, {
    from: { x: P.inches(9), y: P.inches(1) },
    to: { x: P.inches(12), y: P.inches(3) },
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Mixed.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(original)),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  const fill = page.locator('input[aria-label="Fill color"]');
  const removeFill = page.getByRole("button", { name: "Remove fill" });
  const headings = page.locator("#inspector h3");
  // On phones the panel covers the canvas, so select before opening it.
  const select = async (locator) => {
    const close = page.getByRole("button", { name: "Close format panel" });
    if (await close.isVisible()) await close.click();
    await locator.click();
    await inspector(page);
  };
  const shapeHeadings = [
    "Text",
    "Fill",
    "Border",
    "Link",
    "Position & size",
    "Arrange",
  ];
  await select(page.locator('[data-object="0"]'));
  await expect(headings).toHaveText(shapeHeadings);
  await expect(fill).toHaveCount(1);
  await expect(removeFill).toHaveCount(1);
  for (const [name, own] of [
    [/^Pair\./, []],
    [/^Table \d+\./, ["Table", "Cell text"]],
  ]) {
    await select(page.getByRole("button", { name }));
    await expect(headings).toHaveText([...own, "Position & size", "Arrange"]);
    await expect(fill).toHaveCount(0);
    await expect(removeFill).toHaveCount(0);
    await expect(page.locator("#toast")).not.toContainText("not supported");
  }
  // A line has no interior, but its stroke and arrowheads are its own.
  await select(page.getByRole("button", { name: /^Straight Connector \d+\./ }));
  await expect(headings).toHaveText([
    "Line",
    "Link",
    "Position & size",
    "Arrange",
  ]);
  await expect(fill).toHaveCount(0);
  await expect(removeFill).toHaveCount(0);
  // Grouped shapes and pictures keep their own fill and image controls.
  await select(page.getByRole("button", { name: /^Circle \d+\./ }));
  await expect(headings).toHaveText(shapeHeadings);
  // A new text box takes a fill as well.
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await addText(page);
  await inspector(page);
  await expect(headings).toHaveText(shapeHeadings);
});

test("transformed backgrounds agree across the swatch, duplication, PNG and .pptx downloads", async ({
  page,
}) => {
  await start(page);
  const original = await createTransformedBackgroundDeck({
    color:
      '<a:schemeClr val="accent5"><a:lumMod val="20000"/><a:lumOff val="80000"/><a:alpha val="50000"/></a:schemeClr>',
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Tinted background.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(original),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  const image = page.locator(".slide-image");
  const svg = await image.getAttribute("src");
  expect(decodeURIComponent(svg)).toContain(
    'fill="#EDE0E8" fill-opacity="0.5"',
  );
  await inspector(page);
  const background = page.locator(
    '.color-field:has(input[aria-label="Background color"])',
  );
  await expect(background).toHaveText("#F6F0F4");
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await openBarMenu(page, "Slide");
  await page
    .getByRole("menuitem", { name: "Duplicate slide", exact: true })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 2");
  expect(decodeURIComponent(await image.getAttribute("src"))).toContain(
    'fill="#EDE0E8" fill-opacity="0.5"',
  );
  await openFileMenu(page);
  const pngDownload = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download as images", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "This slide as PNG", exact: true })
    .click();
  const png = await readFile(await (await pngDownload).path());
  const pixel = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  }, png.toString("base64"));
  for (const [i, expected] of [246, 240, 244, 255].entries())
    expect(Math.abs(pixel[i] - expected)).toBeLessThanOrEqual(1);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const bytes = await readFile(await (await downloaded).path());
  const restored = await parseDeck(bytes);
  expect(P.getSlides(restored)).toHaveLength(2);
  for (const slide of P.getSlides(restored)) {
    expect(
      P.getSlideMasterBackground(restored, P.getSlideLayout(slide), {
        theme: P.getPresentationTheme(restored),
        clrMap: P.getEffectiveColorMap(slide),
      }),
    ).toEqual({ kind: "solid", color: "#EDE0E8", opacity: 0.5 });
  }
  // Rendering and duplicating must not flatten the theme, transforms or alpha.
  const parts = unzipSync(bytes);
  for (const [name, data] of Object.entries(unzipSync(original))) {
    if (/^ppt\/(slideMasters|slideLayouts|theme)\//.test(name))
      expect(parts[name]).toEqual(data);
  }
});

test("inherited and theme slide backgrounds are reported and kept legible", async ({
  page,
}) => {
  await start(page);
  // Imported slides usually inherit their background from the master, and
  // dark templates reference theme colors rather than hex values.
  const original = P.createPresentation();
  P.addBlankSlide(original);
  P.setSlideBackground(P.addBlankSlide(original), "tx1");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Backgrounds.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(original)),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 2");
  const closePanel = async () => {
    const close = page.getByRole("button", { name: "Close format panel" });
    if (await close.isVisible()) await close.click();
  };
  await inspector(page);
  const background = page.locator(
    '.color-field:has(input[aria-label="Background color"])',
  );
  await expect(background).toHaveText("#FFFFFF");
  await closePanel();
  await page.getByRole("button", { name: "Slide 2: Blank" }).click();
  await inspector(page);
  await expect(background).toHaveText("#000000");
  await expect(background.locator("input")).toHaveValue("#000000");
  await closePanel();
  // Text added to the dark slide takes a color that reads on black.
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const added = P.getSlideShapes(P.getSlides(loaded)[1])[0];
  expect(P.getShapeRunFormat(added, 0, 0).color.toUpperCase()).toBe("#FFFFFF");
});

test("a long username ends in an ellipsis instead of widening the home header", async ({
  page,
}) => {
  await mockPuter(page, {
    signedIn: true,
    username: "a-very-long-username-that-keeps-going-and-going",
  });
  await page.goto("/#/home");
  const account = page.getByRole("button", { name: "Account and settings" });
  await expect(account).toContainText("a-very-long-username");
  const metrics = await account.evaluate((button) => {
    const label = button.querySelector("span");
    return {
      truncated: label.scrollWidth > label.clientWidth,
      overflow: getComputedStyle(label).textOverflow,
      iconVisible:
        button.querySelector("svg").getBoundingClientRect().left >=
        button.getBoundingClientRect().left,
      insideHeader:
        button.getBoundingClientRect().right <=
        document.querySelector(".home-header").getBoundingClientRect().right -
          16,
      clearOfBrand:
        document.querySelector(".header-right").getBoundingClientRect().left -
          document.querySelector(".brand").getBoundingClientRect().right >=
        12,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  expect(metrics).toEqual({
    truncated: true,
    overflow: "ellipsis",
    iconVisible: true,
    insideHeader: true,
    clearOfBrand: true,
    pageOverflow: 0,
  });
});

test("presenting a distant slide renders it once and keeps it for the navigator", async ({
  page,
}) => {
  await start(page);
  const original = createDeck("story");
  const first = P.getSlides(original)[0];
  while (P.getSlides(original).length < 10) P.duplicateSlide(original, first);
  // Hold back idle-time thumbnail rendering so the last slide stays pending.
  await page.evaluate(() => {
    window.requestIdleCallback = () => 1;
    window.cancelIdleCallback = () => {};
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Long deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(original)),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 10");
  await expect(page.locator(".slide-thumb img").nth(9)).not.toHaveAttribute(
    "src",
    /./,
  );
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await countSvgRenders(page);
  const slide = page.locator(".presenter-slide");
  await page.keyboard.press("End");
  await expect(page.locator(".presenter-controls [aria-live]")).toHaveText(
    "10 / 10",
  );
  const last = await slide.getAttribute("src");
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await expect(slide).toHaveAttribute("src", last);
  expect(await page.evaluate(() => window.__svgRenders)).toBe(1);
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  // The navigator picks the render up when the thumbnail scrolls into view.
  await page.locator(".slide-thumb").nth(9).scrollIntoViewIfNeeded();
  await expect(page.locator(".slide-thumb img").nth(9)).toHaveAttribute(
    "src",
    last,
  );
  expect(await page.evaluate(() => window.__svgRenders)).toBe(1);
});

test("a slide whose part name holds selector syntax still opens from the navigator", async ({
  page,
}) => {
  await start(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Other tools name package parts freely; the last slide here carries
  // characters that mean something in a CSS selector.
  const original = P.createPresentation();
  for (let i = 0; i < 10; i++) P.addBlankSlide(original);
  const parts = unzipSync(await P.savePresentation(original));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const renamed = {};
  for (const [name, data] of Object.entries(parts))
    renamed[name.replace("slide10.xml", 'sl"ide]10.xml')] =
      /\.(xml|rels)$/.test(name)
        ? encoder.encode(
            decoder
              .decode(data)
              .replaceAll("slide10.xml", "sl&quot;ide]10.xml"),
          )
        : data;
  // Keep the far thumbnail pending so the navigator has to look it up.
  await page.evaluate(() => {
    window.requestIdleCallback = () => 1;
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Renamed parts.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(zipSync(renamed)),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 10");
  await page.evaluate(() =>
    document.querySelectorAll(".slide-thumb")[9].click(),
  );
  await expect(page.locator("#slide-position")).toHaveText("Slide 10 of 10");
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "alt",
    /^Slide 10/,
  );
  expect(errors).toEqual([]);
});

test("the delete confirmation says what a draft and a cloud file each are", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  await expect(page.locator("#save-status")).toContainText(
    "Saved on this device",
  );
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const dialog = page.getByRole("dialog", { name: /^Delete/ });
  await page
    .getByRole("button", { name: "Options for Untitled presentation" })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete draft", exact: true })
    .click();
  await expect(dialog).toContainText("from this device");
  await expect(dialog).not.toContainText("Puter cloud");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Options for The big idea" }).click();
  await page
    .getByRole("menuitem", { name: "Delete presentation", exact: true })
    .click();
  await expect(dialog).toContainText("from your Puter cloud");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("the inline editor takes the text's own font and colors when they stay readable", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await themeDialog(page);
  await page.getByRole("button", { name: "Midnight", exact: true }).click();
  await page.getByRole("button", { name: "Apply theme", exact: true }).click();
  await addText(page);
  const object = page.locator(".object-hit");
  await expect(object).toHaveCount(1);
  await object.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  const styles = () =>
    editor.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        color: style.color,
        background: style.backgroundColor,
        weight: style.fontWeight,
        // The authored face stays first; the preview and editor now share
        // a fallback stack for devices where that face is unavailable.
        family: style.fontFamily.split(",")[0].replaceAll('"', "").trim(),
      };
    });
  // Midnight ink on the Midnight background, in the shape's font.
  expect(await styles()).toEqual({
    color: "rgb(241, 245, 238)",
    background: "rgb(24, 34, 43)",
    weight: "400",
    family: "Arial",
  });
  await editor.press("Escape");
  await inspector(page);
  await panel(page).getByRole("button", { name: "Bold", exact: true }).click();
  await expect(
    panel(page).getByRole("button", { name: "Bold", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // Text colored like its background would vanish; the editor falls back to
  // its own readable colors.
  await page.evaluate(() => {
    const color = document.querySelector(
      '#inspector input[aria-label="Text color"]',
    );
    color.value = "#18222b";
    color.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(
    page.locator('.color-field:has(input[aria-label="Text color"])'),
  ).toHaveText("#18222B");
  if (
    await page.getByRole("button", { name: "Close format panel" }).isVisible()
  )
    await page.getByRole("button", { name: "Close format panel" }).click();
  await object.dblclick();
  expect(await styles()).toEqual({
    color: "rgb(32, 36, 32)",
    background: "rgb(255, 255, 255)",
    weight: "700",
    family: "Arial",
  });
});

test("the print and save shortcuts work while presenting", async ({ page }) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
  await page.evaluate(() => {
    window.print = () => {
      window.__printStarted = true;
    };
    const timeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => {
      if (window.__printStarted && delay === 1000) return 0;
      return timeout(callback, delay, ...args);
    };
  });
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const presenter = page.getByRole("dialog", { name: "Presentation mode" });
  await expect(presenter).toBeVisible();
  // In a show Ctrl+P picks up the pen; Cmd+P prints.
  await page.keyboard.press("Meta+p");
  await page
    .getByRole("dialog", { name: "Print" })
    .getByRole("button", { name: "Print", exact: true })
    .click();
  await page.waitForFunction(() => window.__printStarted);
  await expect(page.locator("#print-slides .print-page")).toHaveCount(5);
  await expect(presenter).toBeVisible();
  await page.keyboard.press("Control+s");
  await expect(page.locator("#save-status")).toContainText("Saved to Puter");
  await expect(presenter).toBeVisible();
});

test("the format panel reads text that starts with an empty line", async ({
  page,
}) => {
  await start(page);
  // A leading blank line is stored as a paragraph without runs.
  const original = P.createPresentation();
  const box = P.addSlideTextBox(P.addBlankSlide(original), {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(6),
    h: P.inches(2),
    text: "\nHeadline",
  });
  P.setShapeTextFormat(box, { bold: true, size: 40, color: "#AA0000" });
  const parts = unzipSync(await P.savePresentation(original));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const slide = decoder.decode(parts["ppt/slides/slide1.xml"]);
  const emptied = slide.replace(
    /<a:p><a:r>(?:(?!<\/a:r>).)*<a:t\/><\/a:r><\/a:p>/,
    "<a:p/>",
  );
  expect(emptied).not.toBe(slide);
  parts["ppt/slides/slide1.xml"] = encoder.encode(emptied);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Leading line.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(zipSync(parts)),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  await page.locator('[data-object="0"]').click();
  await inspector(page);
  await expect(page.getByRole("spinbutton", { name: "Font size" })).toHaveValue(
    "40",
  );
  await expect(
    panel(page).getByRole("button", { name: "Bold", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator('.color-field:has(input[aria-label="Text color"])'),
  ).toHaveText("#AA0000");
});

test("keyboard focus survives duplicating and deleting objects", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await inspector(page);
  const focused = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      return active === document.body
        ? "body"
        : active.id || active.getAttribute("aria-label");
    });
  // Duplicating from the panel keeps focus on the copy's Duplicate button.
  await page.getByRole("button", { name: "Duplicate", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".object-hit")).toHaveCount(2);
  await expect(page.locator(".object-hit.selected")).toHaveAttribute(
    "data-object",
    "1",
  );
  expect(await focused()).toBe("Duplicate");
  // Deleting from the panel lands on the panel, which now describes the slide.
  await page.getByRole("button", { name: "Delete", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".object-hit")).toHaveCount(1);
  expect(await focused()).toBe("inspector");
  await expect(page.locator("#inspector h2")).toHaveText("Format Background");
  // The Delete key on the canvas moves focus to the object now in that place,
  // and to the workspace once the slide is empty.
  const closePanel = async () => {
    const close = page.getByRole("button", { name: "Close format panel" });
    if (await close.isVisible()) await close.click();
  };
  await closePanel();
  await page.locator(".object-hit").click();
  await inspector(page);
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(2);
  await closePanel();
  // The copy sits slightly offset over the original; press the original's
  // uncovered top strip, away from the copy's handles.
  const originalBox = await page.locator('[data-object="0"]').boundingBox();
  await page
    .locator('[data-object="0"]')
    .click({ position: { x: originalBox.width / 4, y: 1 } });
  await page.keyboard.press("Delete");
  await expect(page.locator(".object-hit")).toHaveCount(1);
  expect(await focused()).toMatch(/Select to edit$/);
  await page.locator(".object-hit").click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".object-hit")).toHaveCount(0);
  expect(await focused()).toBe("main");
});

test("a message shows above the slideshow and other open dialogs", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toBeVisible();
  await page.keyboard.press("Control+s");
  const toast = page.locator("#toast");
  await expect(toast).toHaveText("Saved to your Puter cloud.");
  await expect(toast).toBeVisible();
  // The top layer stacks in opening order, so a popover opened after the
  // slideshow's dialog paints above it, clear of the control bar.
  expect(
    await toast.evaluate((node) => ({
      popover: node.matches(":popover-open"),
      display: getComputedStyle(node).display,
      aboveControls:
        node.getBoundingClientRect().bottom <=
        document.querySelector(".presenter-controls").getBoundingClientRect()
          .top,
    })),
  ).toEqual({ popover: true, display: "block", aboveControls: true });
  await page.keyboard.press("Escape");
  await expect(toast).toBeVisible();
  await expect(toast).toHaveText("Saved to your Puter cloud.");
});

// A tiny valid PNG, for pasting and inserting pictures, and another one to
// replace it with.
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=";
// A 1 by 1 red PNG the browser can decode; the app now refuses bytes it
// cannot show.
const OTHER_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const png = (base64) => ({
  name: "photo.png",
  mimeType: "image/png",
  buffer: Buffer.from(base64, "base64"),
});
const placement = (locator) =>
  locator.evaluate((node) =>
    ["left", "top"].map((key) => Math.round(parseFloat(node.style[key]) * 100)),
  );

test("objects can be cut, copied, and pasted across slides and presentations", async ({
  page,
}) => {
  await story(page);
  const title = page.locator('[data-object="1"]');
  await title.click();
  const original = await placement(title);
  await page.keyboard.press("Control+c");
  await page.locator(".slide-thumb").nth(1).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 5");
  const objects = page.locator(".object-hit");
  const count = await objects.count();
  // The copy lands where the original sat, and further pastes step aside.
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(count + 1);
  const pasted = page.locator(".object-hit.selected");
  await expect(pasted).toHaveAccessibleName(
    "Make room for big ideas.. Select to edit",
  );
  expect(await placement(pasted)).toEqual(original);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(count + 2);
  const [left, top] = await placement(pasted);
  expect(left).toBeGreaterThan(original[0]);
  expect(top).toBeGreaterThan(original[1]);
  // Cut removes the copy and keeps it for the next paste.
  await page.keyboard.press("Control+x");
  await expect(objects).toHaveCount(count + 1);
  await page.locator(".slide-thumb").nth(2).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 3 of 5");
  const third = await objects.count();
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(third + 1);
  await expect(page.locator(".object-hit.selected")).toHaveAccessibleName(
    "Make room for big ideas.. Select to edit",
  );
  await page.keyboard.press("Control+z");
  await expect(objects).toHaveCount(third);
  // The clipboard outlives the presentation it was filled from.
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(objects).toHaveCount(0);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(1);
  await expect(objects).toHaveAccessibleName(
    "Make room for big ideas.. Select to edit",
  );
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getSlideText(P.getSlides(loaded)[0])).toContain("Make room for");
});

test("pasting an image or text from another app inserts a picture or a text box", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(page.locator(".editor")).toBeVisible();
  const objects = page.locator(".object-hit");
  const paste = (data) =>
    page.evaluate(({ text, png }) => {
      const transfer = new DataTransfer();
      if (text) transfer.setData("text/plain", text);
      if (png)
        transfer.items.add(
          new File(
            [Uint8Array.from(atob(png), (c) => c.charCodeAt(0))],
            "screenshot.png",
            { type: "image/png" },
          ),
        );
      document.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, data);
  await paste({ text: "Pasted words\nfrom elsewhere" });
  await expect(objects).toHaveCount(1);
  await expect(page.locator(".object-hit.selected")).toHaveAccessibleName(
    "Pasted words\nfrom elsewhere. Select to edit",
  );
  // The same picture pasted twice travels once in the file.
  await paste({ png: PIXEL_PNG });
  await paste({ png: PIXEL_PNG });
  await expect(objects).toHaveCount(3);
  await expect(page.locator(".object-hit.selected")).toHaveAccessibleName(
    "Image: screenshot.png. Select to edit",
  );
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const bytes = new Uint8Array(await readFile(await (await downloaded).path()));
  const loaded = await parseDeck(bytes);
  const pictures = P.getSlideShapes(P.getSlides(loaded)[0]).filter(
    (shape) => P.getShapeKind(shape) === "picture",
  );
  expect(pictures).toHaveLength(2);
  for (const picture of pictures)
    expect(Buffer.from(P.getShapeImageBytes(picture)).toString("base64")).toBe(
      PIXEL_PNG,
    );
  expect(
    Object.keys(unzipSync(bytes)).filter((name) =>
      name.startsWith("ppt/media/"),
    ),
  ).toHaveLength(1);
});

test("a right-click menu offers clipboard, order, and delete actions for objects and slides", async ({
  page,
}) => {
  await story(page);
  const objects = page.locator(".object-hit");
  const count = await objects.count();
  const title = page.locator('[data-object="1"]');
  await title.click({ button: "right", position: { x: 20, y: 20 } });
  const objectMenu = page.getByRole("menu", { name: "Object options" });
  await expect(objectMenu).toBeVisible();
  await expect(title).toHaveClass(/selected/);
  // The menu opens at the pointer, not below a button.
  const [box, hit] = await Promise.all([
    objectMenu.boundingBox(),
    title.boundingBox(),
  ]);
  expect(Math.abs(box.x - (hit.x + 20))).toBeLessThan(12);
  // A short screen flips the menu above the pointer, or, when it fits
  // neither way, keeps it within the window.
  const near =
    Math.min(
      Math.abs(box.y - (hit.y + 20)),
      Math.abs(box.y + box.height - (hit.y + 20)),
    ) < 12;
  if (!near) {
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height);
  }
  await objectMenu.getByRole("menuitem", { name: "Order" }).click();
  await page.getByRole("menuitem", { name: "Send to back" }).click();
  await expect(page.locator('[data-object="0"]')).toHaveAccessibleName(
    "Make room for big ideas.. Select to edit",
  );
  await expect(page.locator(".object-hit.selected")).toHaveAttribute(
    "data-object",
    "0",
  );
  // Escape closes the menu and hands the focus back to the object.
  await page.locator('[data-object="0"]').click({ button: "right" });
  await expect(objectMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(objectMenu).toHaveCount(0);
  await expect(page.locator('[data-object="0"]')).toBeFocused();
  // Copy from the object's menu, paste from the slide's.
  await page.locator('[data-object="0"]').click({ button: "right" });
  await objectMenu.getByRole("menuitem", { name: "Copy" }).click();
  await page
    .locator("#slide-canvas")
    .click({ button: "right", position: { x: 4, y: 4 } });
  const slideMenu = page.getByRole("menu", { name: "Slide options" });
  await expect(slideMenu).toBeVisible();
  await slideMenu.getByRole("menuitem", { name: "Paste" }).click();
  await expect(objects).toHaveCount(count + 1);
  await expect(page.locator(".object-hit.selected")).toHaveAccessibleName(
    "Make room for big ideas.. Select to edit",
  );
  // Delete from the menu, and the keyboard reorders with brackets.
  await page.locator(".object-hit.selected").click({ button: "right" });
  await objectMenu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(objects).toHaveCount(count);
  await page.locator('[data-object="0"]').click();
  await page.keyboard.press("Control+]");
  await expect(page.locator(".object-hit.selected")).toHaveAttribute(
    "data-object",
    "1",
  );
  await page.keyboard.press("Control+Shift+]");
  await expect(page.locator(".object-hit.selected")).toHaveAttribute(
    "data-object",
    String(count - 1),
  );
  await page.keyboard.press("Control+Shift+[");
  await expect(page.locator(".object-hit.selected")).toHaveAttribute(
    "data-object",
    "0",
  );
  // Slides have a menu of their own on their thumbnails.
  await page.locator(".slide-thumb").nth(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate slide" }).click();
  await expect(page.locator("#slide-count")).toHaveText("6");
});

test("the ribbon's text controls follow the selection and reach the file", async ({
  page,
}) => {
  await story(page);
  // A control's state, read where the ribbon keeps it even when its group
  // is folded away; pressing one goes through the fold if need be.
  const state = (id) =>
    page
      .locator(
        `.ribbon-panel [data-command="${id}"], .ribbon-fold-panel [data-command="${id}"]`,
      )
      .first();
  const press = async (id) => (await ribbonButton(page, "Home", id)).click();
  const size = state("font-size");
  // Nothing selected: the text tools rest; a bold title wakes them.
  await expect(state("bold")).toBeDisabled();
  await page.locator('[data-object="1"]').click();
  await expect(state("bold")).toHaveAttribute("aria-pressed", "true");
  await expect(size).toHaveValue("52");
  await page.locator('[data-object="2"]').click();
  await expect(state("bold")).toHaveAttribute("aria-pressed", "false");
  await expect(size).toHaveValue("21");
  await press("underline");
  await expect(state("underline")).toHaveAttribute("aria-pressed", "true");
  await press("strike");
  await press("align-justify");
  await press("bullets");
  await expect(state("bullets")).toHaveAttribute("aria-pressed", "true");
  await press("line-spacing");
  await page.getByRole("menuitemcheckbox", { name: "1.5" }).click();
  await ribbonButton(page, "Home", "font-name");
  const font = page.getByRole("combobox", { name: "Font", exact: true });
  await font.fill("Georgia");
  await font.press("Enter");
  await ribbonButton(page, "Home", "font-size");
  const sizeBox = page.getByRole("combobox", { name: "Font Size" });
  await sizeBox.fill("28");
  await sizeBox.press("Enter");
  await expect(size).toHaveValue("28");
  await page.keyboard.press("Escape");
  await inspector(page);
  const bottom = panel(page).getByRole("button", {
    name: "Align bottom",
    exact: true,
  });
  await bottom.click();
  await expect(bottom).toHaveAttribute("aria-pressed", "true");
  // Bold and a size step from the keyboard.
  await page.locator(".object-hit.selected").focus();
  await page.keyboard.press("Control+b");
  await expect(state("bold")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+Shift+.");
  await expect(size).toHaveValue("32");
  // On a narrow screen Escape closes the panel laid over the canvas first;
  // the panel is closed so that Escape lets the selection go.
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page.keyboard.press("Escape");
  await expect(state("bold")).toBeDisabled();
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const body = P.getSlideShapes(P.getSlides(loaded)[0])[2];
  const format = P.getShapeRunFormatEffective(loaded, body, 0, 0);
  expect(format).toMatchObject({ font: "Georgia", size: 32, bold: true });
  expect(format.underline).toBeTruthy();
  expect(format.strike).toBeTruthy();
  expect(P.getParagraphAlignment(body, 0)).toMatch(/^(just|justify)$/);
  expect(P.getShapeTextAnchor(body)).toBe("bottom");
  expect(P.getParagraphBullet(body, 0)).toBe("bullet");
  // A multiple of single spacing; 150 would be 15000%.
  expect(P.getParagraphLineSpacing(body, 0)).toEqual({
    kind: "pct",
    value: 1.5,
  });
});

test("a plain shape takes text from a double-click or the format panel", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Rectangle", exact: true }).click();
  const objects = page.locator(".object-hit");
  await expect(objects).toHaveCount(1);
  await objects.first().dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text" });
  await expect(editor).toBeFocused();
  await editor.fill("Inside");
  await page.keyboard.press("Control+Enter");
  await expect(objects.first()).toHaveAccessibleName("Inside. Select to edit");
  // The text reads on the shape's fill: white on the palette's dark green.
  const svg = decodeURIComponent(
    (await page.locator(".slide-image").getAttribute("src")).replace(
      "data:image/svg+xml;charset=utf-8,",
      "",
    ),
  );
  expect(svg).toContain("Inside");
  expect(svg).toMatch(/fill="#ffffff"/i);
  // The panel's content field types into a shape too.
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Circle", exact: true }).click();
  await expect(objects).toHaveCount(2);
  await inspector(page);
  const content = panel(page).getByRole("textbox", { name: "Object text" });
  await content.fill("Round");
  await content.press("Tab");
  await expect(objects.nth(1)).toHaveAccessibleName("Round. Select to edit");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shapes = P.getSlideShapes(P.getSlides(loaded)[0]);
  expect(shapes.map(P.getShapeText)).toEqual(["Inside", "Round"]);
  expect(shapes.map(P.getShapePreset)).toEqual(["rect", "ellipse"]);
  expect(shapes.map((shape) => P.getShapeTextAnchor(shape))).toEqual([
    "center",
    "center",
  ]);
});

test("shapes, lines, and arrows of many kinds are inserted with readable names", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  const shapeMenu = async (...path) => {
    await openShapeMenu(page);
    for (const label of path)
      await page.getByRole("menuitem", { name: label, exact: true }).click();
  };
  const objects = page.locator(".object-hit");
  await shapeMenu("Star");
  await expect(objects).toHaveCount(1);
  await expect(objects.nth(0)).toHaveAccessibleName(
    /^Star \d+\. Select to edit$/,
  );
  await shapeMenu("Arrows", "Right arrow");
  await expect(objects.nth(1)).toHaveAccessibleName(
    /^Right arrow \d+\. Select to edit$/,
  );
  await shapeMenu("Line");
  await expect(objects.nth(2)).toHaveAccessibleName(
    /^Line \d+\. Select to edit$/,
  );
  // A line has no thickness of its own, yet it can be pressed and dragged.
  const lineHit = objects.nth(2);
  const box = await lineHit.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(8);
  await page.keyboard.press("Escape");
  await lineHit.click();
  await expect(lineHit).toHaveClass(/selected/);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, {
    steps: 5,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await lineHit.boundingBox())?.y ?? -Infinity)
    .toBeGreaterThan(box.y + 40);
  await shapeMenu("Arrow");
  await expect(objects.nth(3)).toHaveAccessibleName(
    /^Arrow \d+\. Select to edit$/,
  );
  await page.keyboard.press("Escape");
  await inspector(page);
  await expect(page.locator(".object-list-item")).toHaveText([
    /^Star \d+$/,
    /^Right arrow \d+$/,
    /^Line \d+$/,
    /^Arrow \d+$/,
  ]);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shapes = P.getSlideShapes(P.getSlides(loaded)[0]);
  expect(shapes.map(P.getShapeKind)).toEqual([
    "shape",
    "shape",
    "connector",
    "connector",
  ]);
  expect(shapes.slice(0, 2).map(P.getShapePreset)).toEqual([
    "star5",
    "rightArrow",
  ]);
  expect(P.getShapeStrokeArrow(shapes[2], "tail")).toBeNull();
  expect(P.getShapeStrokeArrow(shapes[3], "tail")).toEqual({
    type: "triangle",
  });
  // The dragged line kept its length and moved down.
  expect(P.getShapeBounds(shapes[2]).w).toBe(P.inches(5));
  expect(P.getShapeBounds(shapes[2]).y).toBeGreaterThan(P.inches(3.6));
});

test("borders, line styles, and arrowheads are edited in the format panel", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Rectangle", exact: true }).click();
  await inspector(page);
  const format = panel(page);
  await expect(
    format.locator('.color-field:has(input[aria-label="Border color"])'),
  ).toHaveText("No border");
  await format.locator('input[aria-label="Border color"]').fill("#ff0000");
  await expect(
    format.locator('.color-field:has(input[aria-label="Border color"])'),
  ).toHaveText("#FF0000");
  const width = format.getByRole("spinbutton", { name: "Border width (pt)" });
  await expect(width).toHaveValue("1");
  await width.fill("3");
  await width.press("Enter");
  await format
    .getByRole("combobox", { name: "Border style" })
    .selectOption("dash");
  // The border shows on the slide.
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).replace(
        "data:image/svg+xml;charset=utf-8,",
        "",
      ),
    );
  expect(await svg()).toMatch(/stroke="#ff0000"/i);
  expect(await svg()).toContain("dasharray");
  // A line offers arrowheads at either end.
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Arrow", exact: true }).click();
  await inspector(page);
  await expect(format.locator("h3").first()).toHaveText("Line");
  await expect(format.getByRole("combobox", { name: "End arrow" })).toHaveValue(
    "triangle",
  );
  await format
    .getByRole("combobox", { name: "Start arrow" })
    .selectOption("oval");
  await format
    .getByRole("combobox", { name: "End arrow" })
    .selectOption("none");
  await expect(
    format.getByRole("combobox", { name: "Start arrow" }),
  ).toHaveValue("oval");
  // Removing the border takes it away again. The arrow crosses the
  // rectangle's middle, and on a touch screen its handles' targets reach
  // the rectangle's corners, so the arrow is deselected first.
  if (await close.isVisible()) await close.click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".selection-box")).toHaveCount(0);
  await page.locator('[data-object="0"]').click({ position: { x: 12, y: 12 } });
  await inspector(page);
  await format.getByRole("button", { name: "Remove border" }).click();
  await expect(
    format.locator('.color-field:has(input[aria-label="Border color"])'),
  ).toHaveText("No border");
  await page.keyboard.press("Control+z");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const [rectangle, arrow] = P.getSlideShapes(P.getSlides(loaded)[0]);
  expect(P.getShapeStroke(rectangle)).toEqual({
    kind: "solid",
    color: "#FF0000",
    widthEmu: P.pt(3),
  });
  expect(P.getShapeStrokeDash(rectangle)).toBe("dash");
  expect(P.getShapeStrokeArrow(arrow, "head")).toEqual({ type: "oval" });
  expect(P.getShapeStrokeArrow(arrow, "tail")).toEqual({ type: "none" });
});

test("objects resize from every edge and corner and rotate by their handle", async ({
  page,
}) => {
  await story(page);
  const title = page.locator('[data-object="1"]');
  await title.click();
  const handles = page.locator(".resize-handle");
  await expect(handles).toHaveCount(8);
  const handle = (name) =>
    page.locator(`.resize-handle[data-handle="${name}"]`);
  const bounds = () =>
    title.evaluate((node) =>
      ["left", "top", "width", "height"].map(
        (key) => Math.round(parseFloat(node.style[key]) * 100) / 100,
      ),
    );
  const drag = async (locator, dx, dy) => {
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + dx,
      box.y + box.height / 2 + dy,
      { steps: 4 },
    );
    await page.mouse.up();
  };
  const before = await bounds();
  // The left handle moves the left edge and leaves the right edge alone.
  await drag(handle("w"), -60, 0);
  let after = await bounds();
  expect(after[0]).toBeLessThan(before[0]);
  expect(after[2]).toBeGreaterThan(before[2]);
  expect(after[0] + after[2]).toBeCloseTo(before[0] + before[2], 0);
  expect(after[1]).toBe(before[1]);
  // The top handle moves only the top edge.
  const beforeTop = after;
  await drag(handle("n"), 0, -40);
  after = await bounds();
  expect(after[1]).toBeLessThan(beforeTop[1]);
  expect(after[3]).toBeGreaterThan(beforeTop[3]);
  expect(after[1] + after[3]).toBeCloseTo(beforeTop[1] + beforeTop[3], 0);
  expect(after[0]).toBe(beforeTop[0]);
  // A corner with Shift keeps the proportions.
  const beforeCorner = after;
  const corner = handle("se");
  const box = await corner.boundingBox();
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  after = await bounds();
  expect(after[2] / after[3]).toBeCloseTo(beforeCorner[2] / beforeCorner[3], 1);
  expect(after[2]).toBeGreaterThan(beforeCorner[2]);
  // The rotation handle turns the object; Shift snaps to 15° steps.
  const rotate = page.locator(".rotate-handle");
  const hit = await title.boundingBox();
  const grip = await rotate.boundingBox();
  await page.keyboard.down("Shift");
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(hit.x + hit.width + 40, hit.y + hit.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(title).toHaveCSS("transform", /matrix/);
  await inspector(page);
  const rotation = panel(page).getByRole("spinbutton", {
    name: "Rotation (°)",
  });
  await expect(rotation).toHaveValue(/^(75|90|105)$/);
  await rotation.fill("45");
  await rotation.press("Enter");
  await expect
    .poll(() => title.evaluate((node) => node.style.transform))
    .toBe("rotate(45deg)");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shape = P.getSlideShapes(P.getSlides(loaded)[0])[1];
  expect(P.getShapeRotation(shape)).toBe(45);
  const saved = P.getShapeBounds(shape);
  expect(saved.w / saved.h).toBeCloseTo(
    after[2] / after[3] / (7.5 / 13.333),
    0,
  );
});

test("dragged objects snap to the slide's center and other objects' edges unless Alt is held", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Rectangle", exact: true }).click();
  const rect = page.locator(".object-hit");
  await expect(rect).toHaveCount(1);
  await inspector(page);
  const x = panel(page).getByRole("spinbutton", { name: "X (in)" });
  await expect(x).toHaveValue("3.3");
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  const canvas = await page.locator("#slide-canvas").boundingBox();
  const pixelsPerInch = canvas.width / 13.333;
  // The rectangle's center is at 4.8 in; the slide's is at 6.667 in. Stop
  // 0.04 in short and the center snaps the rest of the way, with a guide.
  // Presses land on the object's middle, clear of its handles.
  const drag = async (inches, { alt = false } = {}) => {
    const box = await rect.boundingBox();
    const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.move(cx + inches * pixelsPerInch, cy, { steps: 6 });
    const guides = await page.locator(".snap-guide.vertical").count();
    await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
    return guides;
  };
  expect(await drag(6.667 - 4.8 - 0.04)).toBe(1);
  await expect(page.locator(".snap-guide")).toHaveCount(0);
  await inspector(page);
  await expect(x).toHaveValue("5.17");
  if (await close.isVisible()) await close.click();
  // Alt drags freely: no guide, and the rectangle lands where it was left.
  expect(await drag(-0.3, { alt: true })).toBe(0);
  await inspector(page);
  await expect(x).toHaveValue("4.87");
  if (await close.isVisible()) await close.click();
  // Dragging back toward another object's edge snaps to it.
  await addText(page);
  const text = page.locator(".object-hit").nth(1);
  await expect(text).toHaveAccessibleName("Your text here. Select to edit");
  await inspector(page);
  await expect(x).toHaveValue("1.2");
  if (await close.isVisible()) await close.click();
  const box = await text.boundingBox();
  const [tx, ty] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(tx, ty);
  await page.mouse.down();
  // The text box's left edge (1.2 in) heads for the rectangle's (4.87 in).
  await page.mouse.move(
    tx + (4.87 - 1.2 + 0.03) * pixelsPerInch,
    ty + 3 * pixelsPerInch,
    { steps: 6 },
  );
  await expect(page.locator(".snap-guide.vertical")).toHaveCount(1);
  await page.mouse.up();
  await inspector(page);
  await expect(x).toHaveValue("4.87");
});

test("several objects are selected together, moved, aligned, grouped, and deleted as one", async ({
  page,
}) => {
  await story(page);
  const objects = page.locator(".object-hit");
  const chosen = page.locator(".object-hit.selected");
  const panelA = page.locator('[data-object="3"]');
  const panelB = page.locator('[data-object="4"]');
  // A marquee across the right side picks up the two panels there.
  const canvas = await page.locator("#slide-canvas").boundingBox();
  await page.mouse.move(
    canvas.x + canvas.width * 0.78,
    canvas.y + canvas.height * 0.2,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvas.x + canvas.width * 0.98,
    canvas.y + canvas.height * 0.8,
    { steps: 5 },
  );
  await expect(page.locator(".marquee")).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator(".marquee")).toHaveCount(0);
  await expect(chosen).toHaveCount(2);
  await expect(page.locator(".selection-box.multi")).toHaveCount(1);
  await expect(page.locator(".resize-handle")).toHaveCount(0);
  // Shift-click takes an object out again and puts it back. The small panel
  // sits inside the tall one, so it is pressed near its top, clear of the
  // tall one's bottom handle.
  await panelB.click({ modifiers: ["Shift"], position: { x: 8, y: 6 } });
  await expect(chosen).toHaveCount(1);
  await expect(page.locator(".resize-handle")).toHaveCount(8);
  await panelB.click({ modifiers: ["Shift"], position: { x: 8, y: 6 } });
  await expect(chosen).toHaveCount(2);
  await inspector(page);
  await expect(panel(page).locator("h3").first()).toHaveText(
    "2 objects selected",
  );
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  // Dragging one moves both by the same distance; snapping may settle the
  // pair a few pixels off the pointer.
  const before = await Promise.all([
    panelA.boundingBox(),
    panelB.boundingBox(),
  ]);
  await page.mouse.move(
    before[0].x + before[0].width / 2,
    before[0].y + before[0].height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    before[0].x + before[0].width / 2 - 80,
    before[0].y + before[0].height / 2 - 30,
    { steps: 5 },
  );
  await page.mouse.up();
  // The hit regions are rebuilt when the move lands, so a read may catch a
  // moment without one.
  await expect
    .poll(async () => Math.round((await panelB.boundingBox())?.x ?? Infinity))
    .toBeLessThan(before[1].x - 70);
  const after = await Promise.all([panelA.boundingBox(), panelB.boundingBox()]);
  expect(Math.round(after[0].x - before[0].x)).toBe(
    Math.round(after[1].x - before[1].x),
  );
  expect(Math.round(after[0].y - before[0].y)).toBe(
    Math.round(after[1].y - before[1].y),
  );
  await expect(chosen).toHaveCount(2);
  // Ctrl+A takes every object; Escape lets them all go.
  await page.keyboard.press("Control+a");
  await expect(chosen).toHaveCount(7);
  await page.keyboard.press("Escape");
  await expect(chosen).toHaveCount(0);
  // Aligning the left edges, then grouping, then ungrouping.
  await panelA.click({ position: { x: 8, y: 6 } });
  await panelB.click({ modifiers: ["Shift"], position: { x: 8, y: 6 } });
  await expect(chosen).toHaveCount(2);
  await inspector(page);
  await panel(page).getByRole("button", { name: "Left edges" }).click();
  await expect
    .poll(async () => Math.round((await panelA.boundingBox()).x))
    .toBe(Math.round((await panelB.boundingBox()).x));
  await panel(page).getByRole("button", { name: "Group", exact: true }).click();
  await expect(chosen).toHaveCount(1);
  await expect(chosen).toHaveAccessibleName(/^Group \d+\. Select to edit$/);
  await expect(objects).toHaveCount(8);
  await panel(page).getByRole("button", { name: "Ungroup" }).click();
  await expect(objects).toHaveCount(7);
  await expect(chosen).toHaveCount(2);
  // Deleting removes both; undo brings them back.
  await panel(page)
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(objects).toHaveCount(5);
  await page.keyboard.press("Control+z");
  await expect(objects).toHaveCount(7);
});

test("a copied multi-selection pastes as one and the saved file keeps the alignment", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="3"]').click();
  await page
    .locator('[data-object="4"]')
    .click({ modifiers: ["Shift"], position: { x: 8, y: 6 } });
  await page.keyboard.press("Control+c");
  await page.locator(".slide-thumb").nth(1).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 5");
  const count = await page.locator(".object-hit").count();
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(count + 2);
  await expect(page.locator(".object-hit.selected")).toHaveCount(2);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shapes = P.getSlideShapes(P.getSlides(loaded)[1]);
  expect(shapes).toHaveLength(count + 2);
  const [a, b] = shapes.slice(-2).map(P.getShapeBounds);
  expect(a.x).toBe(P.inches(10.7));
  expect(b.x).toBe(P.inches(10.7));
});

test("slides are reordered by dragging their thumbnails along the navigator", async ({
  page,
}) => {
  await story(page);
  const thumbs = page.locator(".slide-thumb");
  // Thumbnails are named for the first line of their slide's text.
  await expect(thumbs.nth(0)).toHaveAccessibleName(/^Slide 1: YOUR NEXT/);
  const first = await thumbs.nth(0).boundingBox();
  const third = await thumbs.nth(2).boundingBox();
  const horizontal = third.x > first.x + first.width / 2;
  // Drag the first slide past the third; a drop line shows on the way.
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    horizontal ? third.x + third.width * 0.9 : third.x + third.width / 2,
    horizontal ? third.y + third.height / 2 : third.y + third.height * 0.9,
    { steps: 8 },
  );
  await expect(page.locator(".slide-drop")).toHaveCount(1);
  await expect(page.locator(".slide-item.dragging")).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator(".slide-drop")).toHaveCount(0);
  await expect(thumbs.nth(2)).toHaveAccessibleName(/^Slide 3: YOUR NEXT/);
  await expect(thumbs.nth(0)).toHaveAccessibleName(
    /^Slide 1: 01 \/ THE CONTEXT/,
  );
  // The moved slide stays the current one, and undo restores the order.
  await expect(page.locator("#slide-position")).toHaveText("Slide 3 of 5");
  await page.keyboard.press("Control+z");
  await expect(thumbs.nth(0)).toHaveAccessibleName(/^Slide 1: YOUR NEXT/);
  await page.keyboard.press("Control+y");
  await expect(thumbs.nth(2)).toHaveAccessibleName(/^Slide 3: YOUR NEXT/);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(
    P.getSlides(loaded)
      .slice(0, 3)
      .map((slide) => P.getSlideText(slide).split("\n")[1]),
  ).toEqual([
    "Where we are today.",
    "See the bigger picture.",
    "Make room for",
  ]);
});

test("presentation mode shows notes and the next slide, keeps time, blanks the screen, and jumps to a typed slide", async ({
  page,
}) => {
  await story(page);
  const notes = page.locator("#speaker-notes");
  await notes.fill("Remember to smile.");
  await notes.press("Tab");
  await expect(page.locator("#save-status")).toContainText(
    "Saved on this device",
  );
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const presenter = page.getByRole("dialog", { name: "Presentation mode" });
  await expect(presenter).toBeVisible();
  const aside = presenter.getByRole("complementary", { name: "Speaker notes" });
  await expect(aside).toBeHidden();
  await presenter.getByRole("button", { name: "Speaker notes" }).click();
  await expect(aside).toBeVisible();
  await expect(aside.locator(".presenter-notes-text")).toHaveText(
    "Remember to smile.",
  );
  await expect(aside.locator(".presenter-next-label")).toHaveText(/^Slide 2: /);
  // The next slide moves along with the show; the last has none to come.
  await page.keyboard.press("End");
  await expect(aside.locator(".presenter-notes-text")).toHaveText(
    "No notes for this slide.",
  );
  await expect(aside.locator(".presenter-next-label")).toHaveText(
    "This is the last slide.",
  );
  await presenter.getByRole("button", { name: "Speaker notes" }).focus();
  await page.keyboard.press("Space");
  await expect(aside).toBeHidden();
  // The timer counts up from the start of the show.
  const timer = presenter.getByRole("button", { name: /Time elapsed/ });
  await expect.poll(() => timer.textContent()).not.toBe("00:00");
  // B blanks the screen; the next key brings the slide back.
  const stage = presenter.locator(".presenter-stage");
  await page.keyboard.press("b");
  await expect(stage).toHaveClass(/blank/);
  await expect(presenter.locator(".presenter-slide")).toBeHidden();
  await page.keyboard.press("b");
  await expect(stage).not.toHaveClass(/blank/);
  await page.keyboard.press("w");
  await expect(stage).toHaveClass(/blank-white/);
  await page.keyboard.press("ArrowLeft");
  await expect(stage).not.toHaveClass(/blank/);
  // A typed number and Enter go to that slide.
  await page.keyboard.type("2");
  await expect(presenter.locator(".presenter-counter")).toContainText(
    "Go to 2",
  );
  await page.keyboard.press("Enter");
  await expect(presenter.locator(".presenter-counter")).toHaveText("2 / 5");
  await page.keyboard.press("Escape");
  await expect(presenter).toHaveCount(0);
});

test("the slide zooms from the footer, the keyboard, and the View menu, and fits the window again", async ({
  page,
}) => {
  await story(page);
  const canvas = page.locator("#slide-canvas");
  const width = async () => Math.round((await canvas.boundingBox()).width);
  const level = page.getByRole("button", { name: "Zoom level" });
  // Fitting is the Fit button's pressed state; the level shows the scale.
  const fit = page.getByRole("button", {
    name: "Fit slide to current window",
  });
  const fitWidth = await width();
  await expect(fit).toHaveAttribute("aria-pressed", "true");
  await expect(level).toHaveText(/^\d+%$/);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(width).toBeGreaterThan(fitWidth);
  await expect(fit).toHaveAttribute("aria-pressed", "false");
  await expect(level).toHaveText(/^\d+%$/);
  // At 100% an inch is 96 pixels, so a 16:9 slide is 1280 wide and the
  // area scrolls to reach the rest of it.
  await level.click();
  await page.getByRole("menuitemcheckbox", { name: "100%" }).click();
  await expect.poll(width).toBe(1280);
  expect(
    await page.evaluate(() => {
      const area = document.querySelector("#canvas-area");
      return area.scrollWidth > area.clientWidth;
    }),
  ).toBe(true);
  // Overlays stay on their objects at any zoom.
  const hit = await page.locator('[data-object="1"]').boundingBox();
  const box = await canvas.boundingBox();
  expect(hit.x).toBeGreaterThanOrEqual(box.x - 1);
  expect(hit.x + hit.width).toBeLessThanOrEqual(box.x + box.width + 1);
  await page.keyboard.press("Control+-");
  await expect.poll(width).toBeLessThan(1280);
  await page.keyboard.press("Control+0");
  await expect.poll(width).toBe(fitWidth);
  await expect(fit).toHaveAttribute("aria-pressed", "true");
  const view = page.getByRole("menuitem", { name: "View", exact: true });
  if (await view.isVisible()) {
    await view.click();
    await page.getByRole("menuitem", { name: "Zoom in", exact: true }).click();
    await expect.poll(width).toBeGreaterThan(fitWidth);
    await view.click();
    await page.getByRole("menuitem", { name: "Zoom", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Fit to screen" }).click();
    await expect.poll(width).toBe(fitWidth);
  }
  // Ctrl and the wheel zoom too, and the choice survives a reload.
  await canvas.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect.poll(width).toBeGreaterThan(fitWidth);
  const zoomed = await width();
  await page.reload();
  await expect(page.locator(".editor")).toBeVisible();
  await expect.poll(width).toBe(zoomed);
  await page.keyboard.press("Control+0");
});

test("objects take links to web addresses or slides that work while presenting", async ({
  page,
}) => {
  await story(page);
  const title = page.locator('[data-object="1"]');
  await title.click();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Add link" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Web address" }).fill("puter.com");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await inspector(page);
  await expect(panel(page).locator(".link-target")).toHaveText(
    "https://puter.com",
  );
  // The text now reads as a link on the slide.
  const svg = decodeURIComponent(
    (await page.locator(".slide-image").getAttribute("src")).replace(
      "data:image/svg+xml;charset=utf-8,",
      "",
    ),
  );
  expect(svg).toContain("puter.com");
  // A second object links to a slide.
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page.locator('[data-object="3"]').click();
  await inspector(page);
  await panel(page).getByRole("button", { name: "Add link" }).click();
  await page
    .getByRole("combobox", { name: "Link to" })
    .selectOption("slide:/ppt/slides/slide3.xml");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(panel(page).locator(".link-target")).toHaveText("Slide 3");
  // Presenting, the regions sit over the linked objects and the slide link
  // goes to its slide.
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const presenter = page.getByRole("dialog", { name: "Presentation mode" });
  await expect(
    presenter.getByRole("link", { name: "Open https://puter.com" }),
  ).toHaveAttribute("href", "https://puter.com");
  await presenter.getByRole("button", { name: "Go to slide 3" }).click();
  await expect(presenter.locator(".presenter-counter")).toHaveText("3 / 5");
  await page.keyboard.press("Escape");
  // Removing the link takes it off, and the file keeps what remains.
  if (await close.isVisible()) await close.click();
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await panel(page).getByRole("button", { name: "Remove link" }).click();
  await expect(panel(page).locator(".link-target")).toHaveText("No link");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shapes = P.getSlideShapes(P.getSlides(loaded)[0]);
  expect(P.getShapeHyperlink(shapes[1])).toBeNull();
  expect(P.getShapeClickAction(shapes[1])).toBeNull();
  const action = P.getShapeClickAction(shapes[3]);
  expect(action.kind).toBe("slide");
  expect(P.getSlidePartName(action.slide)).toBe(
    P.getSlidePartName(P.getSlides(loaded)[2]),
  );
});

test("a slide takes a background image, and pictures are replaced, faded, cropped, and flipped", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(page.locator(".editor")).toBeVisible();
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).replace(
        "data:image/svg+xml;charset=utf-8,",
        "",
      ),
    );
  await inspector(page);
  let chooser = page.waitForEvent("filechooser");
  await panel(page)
    .getByRole("button", { name: "Background image", exact: true })
    .click();
  await (await chooser).setFiles(png(PIXEL_PNG));
  await expect(
    panel(page).getByRole("button", { name: "Remove background image" }),
  ).toBeVisible();
  await expect(
    panel(page).locator(
      '.color-field:has(input[aria-label="Background color"])',
    ),
  ).toHaveText("Image");
  expect(await svg()).toContain("<image");
  // A picture: replace its bytes, fade it, crop it, and flip it.
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  chooser = page.waitForEvent("filechooser");
  await insertImage(page);
  await (await chooser).setFiles(png(PIXEL_PNG));
  const picture = page.locator(".object-hit");
  await expect(picture).toHaveAccessibleName(
    "Image: photo.png. Select to edit",
  );
  await inspector(page);
  chooser = page.waitForEvent("filechooser");
  await panel(page).getByRole("button", { name: "Replace image" }).click();
  await (await chooser).setFiles({ ...png(OTHER_PNG), name: "other.png" });
  await expect(picture).toHaveAccessibleName(
    "Image: other.png. Select to edit",
  );
  const transparency = panel(page).getByRole("slider", {
    name: "Transparency (%)",
  });
  await transparency.fill("40");
  await expect(
    panel(page).locator(
      '.range-field:has(input[aria-label="Transparency (%)"]) span',
    ),
  ).toHaveText("40%");
  // Brightness lightens the picture on the canvas.
  const brightness = panel(page).getByRole("slider", {
    name: "Brightness (%)",
  });
  await brightness.fill("30");
  await expect(
    panel(page).locator(
      '.range-field:has(input[aria-label="Brightness (%)"]) span',
    ),
  ).toHaveText("+30%");
  await expect.poll(svg).toContain('intercept="0.3"');
  const cropLeft = panel(page).getByRole("spinbutton", {
    name: "Crop left (%)",
  });
  await cropLeft.fill("20");
  await cropLeft.press("Enter");
  await panel(page).getByRole("button", { name: "Flip horizontal" }).click();
  await expect.poll(async () => (await svg()).includes("clipPath")).toBe(true);
  // Removing the background image leaves the palette's color.
  if (await close.isVisible()) await close.click();
  await page.keyboard.press("Escape");
  await inspector(page);
  await panel(page)
    .getByRole("button", { name: "Remove background image" })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "Background image", exact: true }),
  ).toBeVisible();
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const bytes = new Uint8Array(await readFile(await (await downloaded).path()));
  const loaded = await parseDeck(bytes);
  const slide = P.getSlides(loaded)[0];
  expect(P.getSlideBackground(slide).kind).toBe("solid");
  const shape = P.getSlideShapes(slide)[0];
  expect(Buffer.from(P.getShapeImageBytes(shape)).toString("base64")).toBe(
    OTHER_PNG,
  );
  expect(P.getShapeImageOpacity(shape)).toBeCloseTo(0.6, 5);
  expect(P.getShapeImageCrop(shape)).toMatchObject({ left: 0.2 });
  expect(P.getShapeFlip(shape)).toEqual({ horizontal: true, vertical: false });
  // The replaced picture and the removed background left no media behind.
  expect(
    Object.keys(unzipSync(bytes)).filter((name) =>
      name.startsWith("ppt/media/"),
    ),
  ).toHaveLength(1);
});

test("tables are inserted, filled in cell by cell, reshaped, and resized with their grid", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(page.locator(".editor")).toBeVisible();
  await menuCommand(page, "Insert", "Table");
  const dialog = page.getByRole("dialog", { name: "Insert table" });
  await dialog.getByRole("spinbutton", { name: "Rows" }).fill("2");
  await dialog.getByRole("spinbutton", { name: "Columns" }).fill("3");
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  const table = page.locator(".object-hit");
  await expect(table).toHaveAccessibleName(/^Table \d+\. Select to edit$/);
  await expect(table).toHaveClass(/selected/);
  await expect(page.locator(".cell-focus")).toHaveCount(1);
  // Double-clicking a cell edits it; Tab moves to the next cell.
  const box = await table.boundingBox();
  await table.dblclick({ position: { x: box.width / 6, y: box.height / 4 } });
  const editor = page.getByRole("textbox", { name: /^Edit cell/ });
  await expect(editor).toHaveAccessibleName("Edit cell, row 1, column 1");
  await editor.fill("Region");
  await editor.press("Tab");
  await expect(editor).toHaveAccessibleName("Edit cell, row 1, column 2");
  await editor.fill("Q1");
  await editor.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).replace(
        "data:image/svg+xml;charset=utf-8,",
        "",
      ),
    );
  await expect.poll(svg).toContain("Region");
  expect(await svg()).toContain("Q1");
  // Rows and columns come and go around the current cell.
  await inspector(page);
  const format = panel(page);
  await expect(format.locator("h3").first()).toHaveText("Table");
  await format.getByRole("button", { name: "Row below" }).click();
  await expect(format.locator(".helper").first()).toContainText("3 × 3");
  await format.getByRole("button", { name: "Delete column" }).click();
  await expect(format.locator(".helper").first()).toContainText("3 × 2");
  await format.getByRole("checkbox", { name: "Header row" }).uncheck();
  // Resizing the frame stretches the grid along with it.
  const width = format.getByRole("spinbutton", { name: "Width (in)" });
  await width.fill("6");
  await width.press("Enter");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const saved = P.getSlideShapes(P.getSlides(loaded)[0])[0];
  expect(P.isTableShape(saved)).toBe(true);
  expect(P.getTableDimensions(saved)).toEqual({ rows: 3, cols: 2 });
  // The deleted column was the current one, where Q1 had been typed.
  expect(P.getTableCellText(P.getTableCell(saved, 0, 0))).toBe("Region");
  expect(P.getTableCellText(P.getTableCell(saved, 0, 1))).toBe("");
  expect(P.getTableStyleFlags(saved).firstRow).toBe(false);
  expect(P.getTableColumnWidths(saved).reduce((a, b) => a + b, 0)).toBe(
    P.inches(6),
  );
  expect(P.getShapeBounds(saved).w).toBe(P.inches(6));
});

test("slides take a transition that plays as they arrive while presenting", async ({
  page,
}) => {
  await story(page);
  await page.locator(".slide-thumb").nth(1).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 5");
  await inspector(page);
  const transition = panel(page).getByRole("combobox", { name: "Transition" });
  await expect(transition).toHaveValue("none");
  await transition.selectOption("fade");
  await expect(transition).toHaveValue("fade");
  // Every slide can take the same one; slide 4 then gets a push of its own.
  await panel(page)
    .getByRole("button", { name: "Apply to all slides" })
    .click();
  // On a phone the panel covers the navigator, so it closes for the click.
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page.locator(".slide-thumb").nth(3).click();
  await inspector(page);
  await expect(transition).toHaveValue("fade");
  await transition.selectOption("push");
  if (await close.isVisible()) await close.click();
  await page.locator(".slide-thumb").nth(0).click();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const presenter = page.getByRole("dialog", { name: "Presentation mode" });
  const slide = presenter.locator(".presenter-slide:not(.presenter-leaving)");
  const playing = presenter.locator(".slide-transition");
  await page.keyboard.press("ArrowRight");
  await expect(playing).toHaveAttribute("data-effect", "fade");
  await expect(playing).toHaveCount(0, { timeout: 3000 });
  await expect(slide).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(playing).toHaveAttribute("data-effect", "push");
  await expect(playing).toHaveCount(0, { timeout: 3000 });
  await page.keyboard.press("Escape");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(
    P.getSlides(loaded).map((s) => P.getSlideTransition(s)?.effect || "none"),
  ).toEqual(["fade", "fade", "fade", "push", "fade"]);
});

test("find and replace walks matches across slides and replaces one or all of them", async ({
  page,
}) => {
  await story(page);
  await page.keyboard.press("Control+f");
  const bar = page.getByRole("search", { name: "Find and replace" });
  await expect(bar).toBeVisible();
  const query = bar.getByRole("searchbox", { name: "Find" });
  await expect(query).toBeFocused();
  await query.fill("idea");
  const count = bar.locator(".find-count");
  await expect(count).toHaveText(/^1 of [3-9]$/);
  const total = Number((await count.textContent()).split(" of ")[1]);
  // The first match is on the current slide; Next walks on to other slides.
  await expect(page.locator(".object-hit.selected")).toHaveAccessibleName(
    /big ideas/,
  );
  await expect(page.locator(".object-hit.match")).toHaveCount(1);
  await bar.getByRole("button", { name: "Next match" }).click();
  await expect(count).toHaveText(`2 of ${total}`);
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 5");
  await expect(page.locator(".object-hit.selected")).toHaveAccessibleName(
    /idea/,
  );
  // Replacing the current match writes into its run; the count follows.
  await bar.getByRole("textbox", { name: "Replace with" }).fill("plan");
  await bar.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(count).toHaveText(`2 of ${total - 1}`);
  // The selection moves on to the next match, which is still to be replaced.
  await expect(page.locator(".object-hit.selected")).toHaveAccessibleName(
    /idea/,
  );
  // Matching case finds nothing for capitals; Replace all clears the rest.
  await query.fill("IDEA");
  // A new search starts from the current slide, so it lands on match two.
  await expect(count).toHaveText(new RegExp(`^\\d of ${total - 1}$`));
  await bar.getByRole("button", { name: "Match case" }).click();
  await expect(count).toHaveText("No matches");
  await bar.getByRole("button", { name: "Match case" }).click();
  await bar.getByRole("button", { name: "Replace all" }).click();
  await expect(count).toHaveText("No matches");
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const text = P.getSlides(loaded).map(P.getSlideText).join("\n");
  expect(text).not.toMatch(/idea/i);
  expect(text).toContain("Make room for\nbig plans.");
  // Formatting stayed with the replaced run.
  const title = P.getSlideShapes(P.getSlides(loaded)[0])[1];
  expect(P.getShapeRunFormat(title, 0, 0).bold).toBe(true);
});

test("slides download as PNG images, one at a time or all together in a ZIP", async ({
  page,
}) => {
  await story(page);
  await page.locator(".slide-thumb").nth(1).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 5");
  await openFileMenu(page);
  await page.getByRole("menuitem", { name: "Download as images" }).click();
  let downloaded = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "This slide as PNG" }).click();
  let file = await downloaded;
  expect(file.suggestedFilename()).toBe("The big idea - Slide 2.png");
  const png = new Uint8Array(await readFile(await file.path()));
  // A PNG signature, then an IHDR chunk with the slide's size at twice 96 dpi.
  expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset);
  expect(view.getUint32(16)).toBe(2560);
  expect(view.getUint32(20)).toBe(1440);
  await expect(page.locator("#toast")).toContainText("downloaded as a PNG");
  await openFileMenu(page);
  await page.getByRole("menuitem", { name: "Download as images" }).click();
  downloaded = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "All slides as PNG (ZIP)" }).click();
  file = await downloaded;
  expect(file.suggestedFilename()).toBe("The big idea - slides.zip");
  const entries = unzipSync(new Uint8Array(await readFile(await file.path())));
  expect(Object.keys(entries).sort()).toEqual([
    "The big idea - Slide 1.png",
    "The big idea - Slide 2.png",
    "The big idea - Slide 3.png",
    "The big idea - Slide 4.png",
    "The big idea - Slide 5.png",
  ]);
  expect([...entries["The big idea - Slide 5.png"].slice(0, 4)]).toEqual([
    137, 80, 78, 71,
  ]);
});

test("the slide size changes to standard and back, scaling the content along", async ({
  page,
}) => {
  await story(page);
  const aspect = page.locator(".zoom-control > span");
  await expect(aspect).toHaveText("16:9");
  await openFileMenu(page);
  await page.getByRole("menuitem", { name: "Slide size" }).click();
  const dialog = page.getByRole("dialog", { name: "Slide size" });
  await dialog
    .getByRole("combobox", { name: "Slide size" })
    .selectOption("4:3");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(aspect).toHaveText("4:3");
  await expect
    .poll(async () => {
      const box = await page.locator("#slide-canvas").boundingBox();
      return Math.round((box.width / box.height) * 100) / 100;
    })
    .toBe(1.33);
  // The title moved and shrank with the slide: 0.8 in from the left became
  // 0.6, and the text a step smaller.
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await expect(
    panel(page).getByRole("spinbutton", { name: "X (in)" }),
  ).toHaveValue("0.6");
  await expect(
    panel(page).getByRole("spinbutton", { name: "Font size" }),
  ).toHaveValue("39");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getSlideSize(loaded)).toMatchObject({
    width: 9144000,
    height: 6858000,
  });
  const title = P.getSlideShapes(P.getSlides(loaded)[0])[1];
  // Proportional: the width scaled by 0.75 fills the slide, and the content
  // sits centered in the taller frame, 0.9375 in from the top.
  expect(P.getShapeBounds(title).x).toBe(Math.round(P.inches(0.8) * 0.75));
  expect(P.getShapeBounds(title).y).toBe(
    Math.round(P.inches(1.8) * 0.75 + P.inches(0.9375)),
  );
  expect(P.getShapeBounds(title).h).toBe(Math.round(P.inches(2.1) * 0.75));
  // Undo brings the widescreen slides back.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+z");
  await expect(aspect).toHaveText("16:9");
});

test("several slides are selected with Shift and Ctrl clicks and act together", async ({
  page,
}) => {
  await story(page);
  const thumbs = page.locator(".slide-thumb");
  const count = page.locator("#slide-count");
  const position = page.locator("#slide-position");
  await expect(count).toHaveText("5");
  // Shift-click selects the range from the current slide; the canvas stays.
  await thumbs.nth(2).click({ modifiers: ["Shift"] });
  await expect(count).toHaveText("3 of 5 selected");
  await expect(page.locator(".slide-item.selected")).toHaveCount(3);
  await expect(thumbs.nth(1)).toHaveAccessibleName(/^Slide 2 \(selected\):/);
  await expect(position).toHaveText("Slide 1 of 5");
  // Ctrl-click takes one out and brings another in.
  await thumbs.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await thumbs.nth(4).click({ modifiers: ["ControlOrMeta"] });
  await expect(count).toHaveText("3 of 5 selected");
  await expect(thumbs.nth(1)).toHaveAccessibleName(/^Slide 2: /);
  // A selected slide's options cover the whole selection; the copies land
  // after the last selected slide and take over the selection.
  await page
    .getByRole("button", { name: "Options for slide 3", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Hide 3 slides", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Duplicate 3 slides", exact: true })
    .click();
  await expect(count).toHaveText("3 of 8 selected");
  await expect(position).toHaveText("Slide 6 of 8");
  await expect(thumbs.nth(5)).toHaveAccessibleName(
    /^Slide 6 \(selected\): YOUR NEXT/,
  );
  await expect(thumbs.nth(6)).toHaveAccessibleName(/^Slide 7 \(selected\): 02/);
  await expect(thumbs.nth(7)).toHaveAccessibleName(
    /^Slide 8 \(selected\): LET/,
  );
  // Escape lets the extra slides go.
  await page.keyboard.press("Escape");
  await expect(count).toHaveText("8");
  await expect(page.locator(".slide-item.selected")).toHaveCount(0);
  // Hiding the range marks every slide in it; the menu then offers to show.
  await thumbs.nth(7).click({ modifiers: ["Shift"] });
  await page
    .getByRole("button", { name: "Options for slide 8", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Hide 3 slides", exact: true })
    .click();
  await expect(page.locator(".hidden-slide")).toHaveCount(3);
  await expect(thumbs.nth(6)).toHaveAccessibleName(
    /^Slide 7 \(hidden, selected\)/,
  );
  await page
    .getByRole("button", { name: "Options for slide 8", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Show 3 slides", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // Delete in the navigator removes the selected slides; the slide that
  // moves into the first freed place becomes current. Undo brings them back.
  await thumbs.nth(7).focus();
  await page.keyboard.press("Delete");
  await expect(count).toHaveText("5");
  await expect(position).toHaveText("Slide 5 of 5");
  await page.keyboard.press("Control+z");
  await expect(count).toHaveText("8");
  // Ctrl+A in the navigator selects every slide, and the deck keeps at
  // least one.
  await thumbs.nth(0).click();
  await thumbs.nth(0).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(count).toHaveText("8 of 8 selected");
  await page
    .getByRole("button", { name: "Options for slide 2", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete 8 slides", exact: true })
    .click();
  await expect(page.getByText("Keep at least one slide")).toBeVisible();
  await expect(count).toHaveText("8 of 8 selected");
  // A menu on a slide outside the selection acts on that slide alone.
  await thumbs.nth(0).click();
  await thumbs.nth(1).click({ modifiers: ["Shift"] });
  await page
    .getByRole("button", { name: "Options for slide 4", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Delete slide", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});

test("selected slides move together when one of them is dragged or moved", async ({
  page,
}) => {
  await story(page);
  const thumbs = page.locator(".slide-thumb");
  const count = page.locator("#slide-count");
  await thumbs.nth(1).click();
  await thumbs.nth(2).click({ modifiers: ["Shift"] });
  await expect(count).toHaveText("2 of 5 selected");
  const from = await thumbs.nth(2).boundingBox();
  const fourth = await thumbs.nth(3).boundingBox();
  const horizontal = fourth.x > from.x + from.width / 2;
  // Drag slide 3 past slide 4: slide 2 comes along as a block.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    horizontal ? fourth.x + fourth.width * 0.9 : fourth.x + fourth.width / 2,
    horizontal ? fourth.y + fourth.height / 2 : fourth.y + fourth.height * 0.9,
    { steps: 8 },
  );
  await expect(page.locator(".slide-item.dragging")).toHaveCount(2);
  await page.mouse.up();
  await expect(thumbs.nth(1)).toHaveAccessibleName(/^Slide 2: 03 \/ THE PLAN/);
  await expect(thumbs.nth(2)).toHaveAccessibleName(
    /^Slide 3 \(selected\): 01 \/ THE CONTEXT/,
  );
  await expect(thumbs.nth(3)).toHaveAccessibleName(/^Slide 4 \(selected\): 02/);
  await expect(page.locator("#slide-position")).toHaveText("Slide 3 of 5");
  await expect(count).toHaveText("2 of 5 selected");
  // Move up from a selected slide's options takes the pair up together. At
  // the end of the deck the navigator leaves out the move that cannot happen,
  // and the menu bar's Slide menu shows it disabled.
  await page
    .getByRole("button", { name: "Options for slide 4", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect(thumbs.nth(1)).toHaveAccessibleName(
    /^Slide 2 \(selected\): 01 \/ THE CONTEXT/,
  );
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 5");
  for (const n of [3, 4]) {
    await page
      .getByRole("button", { name: `Options for slide ${n}`, exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Move down", exact: true })
      .click();
  }
  await expect(thumbs.nth(4)).toHaveAccessibleName(/^Slide 5 \(selected\): 02/);
  await expect(page.locator("#slide-position")).toHaveText("Slide 4 of 5");
  await page
    .getByRole("button", { name: "Options for slide 5", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Move up", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Move down", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  const slideMenu = page.getByRole("menuitem", { name: "Slide", exact: true });
  if (await slideMenu.isVisible()) {
    await slideMenu.click();
    await expect(
      page.getByRole("menuitem", { name: "Move down", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
  }
});

test("shapes take a drop shadow from the format panel or the Format menu and keep it in the file", async ({
  page,
}) => {
  await story(page);
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Rectangle", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await inspector(page);
  const shadow = panel(page).getByRole("checkbox", { name: "Drop shadow" });
  await expect(shadow).not.toBeChecked();
  const shadows = async () =>
    (
      decodeURIComponent(
        (await page.locator(".slide-image").getAttribute("src")).split(",")[1],
      ).match(/feDropShadow/g) || []
    ).length;
  expect(await shadows()).toBe(0);
  await shadow.check();
  await expect(shadow).toBeChecked();
  await expect.poll(shadows).toBe(1);
  // The Format menu shows the shadow on, and takes it off again.
  await openBarMenu(page, "Format");
  const item = page.getByRole("menuitemcheckbox", {
    name: "Drop shadow",
    exact: true,
  });
  await expect(item).toHaveAttribute("aria-checked", "true");
  await item.click();
  await expect.poll(shadows).toBe(0);
  await expect(
    panel(page).getByRole("checkbox", { name: "Drop shadow" }),
  ).not.toBeChecked();
  // Every selected shape takes the shadow together, and the file keeps it.
  await page.keyboard.press("Control+a");
  await expect(page.locator(".object-hit.selected")).toHaveCount(8);
  await openBarMenu(page, "Format");
  await expect(item).toHaveAttribute("aria-checked", "false");
  await item.click();
  await expect.poll(shadows).toBe(8);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const effects = P.getSlideShapes(P.getSlides(loaded)[0]).map(
    (shape) => P.getShapeEffect(shape)?.kind,
  );
  expect(effects).toEqual(Array(8).fill("shadow"));
  expect(
    P.getShapeEffect(P.getSlideShapes(P.getSlides(loaded)[0])[7]),
  ).toMatchObject({
    opacity: 0.4,
    angleDeg: 45,
  });
  // Undo lifts all eight at once; without a selection the menu item is off.
  await page.keyboard.press("Control+z");
  await expect.poll(shadows).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".object-hit.selected")).toHaveCount(0);
  await openBarMenu(page, "Format");
  await expect(item).toBeDisabled();
  await page.keyboard.press("Escape");
});

test("part of a text box is formatted on its own while editing, and the file keeps the mixed runs", async ({
  page,
}) => {
  await story(page);
  const hit = page.locator('[data-object="1"]');
  await hit.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("Make room for\nbig ideas.", {
    useInnerText: true,
  });
  // Select "room" and make it italic and, since the title is bold, plain.
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+i");
  const italic = page.locator(
    '.ribbon-panel:not([hidden]) [data-command="italic"]',
  );
  const bold = page.locator(
    '.ribbon-panel:not([hidden]) [data-command="bold"]',
  );
  if (await bold.isVisible()) {
    // The toolbar reflects the selection and formats it without closing
    // the editor.
    await expect(italic).toHaveAttribute("aria-pressed", "true");
    await expect(bold).toHaveAttribute("aria-pressed", "true");
    await bold.click();
    await expect(bold).toHaveAttribute("aria-pressed", "false");
  } else await page.keyboard.press("Control+b");
  await expect(editor).toBeFocused();
  // The two paragraphs were two runs; the split word makes four.
  const spans = editor.locator("span");
  await expect(spans).toHaveCount(4);
  await expect(spans.nth(1)).toHaveText("room");
  await expect(spans.nth(1)).toHaveCSS("font-style", "italic");
  await expect(spans.nth(1)).toHaveCSS("font-weight", "400");
  await expect(spans.nth(0)).toHaveCSS("font-weight", "700");
  // Typing at the end of the styled word keeps its style.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("y");
  await expect(spans.nth(1)).toHaveText("roomy");
  await expect(spans).toHaveCount(4);
  // Enter starts a new paragraph inside the run's formatting.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Now");
  await expect(editor).toHaveText("Make roomy for\nNow\nbig ideas.", {
    useInnerText: true,
  });
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).split(",")[1],
    );
  await expect.poll(svg).toContain("roomy");
  expect(await svg()).toMatch(/font-style="italic"/);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const title = P.getSlideShapes(P.getSlides(loaded)[0])[1];
  expect(P.getShapeText(title)).toBe("Make roomy for\nNow\nbig ideas.");
  const runs = P.getShapeParagraphElements(title, 0);
  expect(runs.map((r) => r.text)).toEqual(["Make ", "roomy", " for"]);
  expect(runs.map((r) => !!r.format.bold)).toEqual([true, false, true]);
  expect(runs.map((r) => !!r.format.italic)).toEqual([false, true, false]);
  expect(P.getShapeParagraphElements(title, 1)[0].format.bold).toBe(true);
  // Editing the text again keeps the mixed runs it already has.
  await hit.dblclick();
  await expect(editor).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("!");
  await expect(editor).toHaveText("Make roomy for\nNow\nbig ideas.!", {
    useInnerText: true,
  });
  await page.keyboard.press("Control+Enter");
  await expect.poll(svg).toContain("ideas.!");
  await hit.dblclick();
  await expect(editor.locator("span").nth(1)).toHaveCSS("font-style", "italic");
  await page.keyboard.press("Escape");
  // Undo takes the whole edit back in one step.
  await page.keyboard.press("Control+z");
  await expect.poll(svg).not.toContain("ideas.!");
});

test("color, size, and font from the toolbar or panel apply to the selected text while editing", async ({
  page,
}) => {
  await story(page);
  const hit = page.locator('[data-object="1"]');
  await hit.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
  const toolbarSize = page.locator('.toolbar select[aria-label="Font size"]');
  const useToolbar = await toolbarSize.isVisible();
  if (!useToolbar) await inspector(page);
  const scope = useToolbar ? page.locator(".toolbar") : panel(page);
  // A color from the picker colors the word and leaves the editor open.
  await scope.locator('input[aria-label="Text color"]').fill("#cc0000");
  const spans = editor.locator("span");
  await expect(spans).toHaveCount(4);
  await expect(spans.nth(1)).toHaveText("room");
  await expect(spans.nth(1)).toHaveCSS("color", "rgb(204, 0, 0)");
  await expect(spans.nth(0)).not.toHaveCSS("color", "rgb(204, 0, 0)");
  // A size and a font follow, on the same selection.
  if (useToolbar) {
    await toolbarSize.selectOption("24");
    await page
      .locator('.toolbar select[aria-label="Font"]')
      .selectOption("Georgia");
  } else {
    const size = panel(page).getByRole("spinbutton", { name: "Font size" });
    await size.fill("24");
    await size.press("Enter");
    await panel(page)
      .getByRole("combobox", { name: "Font family" })
      .selectOption("Georgia");
  }
  await expect(spans.nth(1)).toHaveCSS("font-family", /Georgia/);
  await expect(spans.nth(0)).not.toHaveCSS("font-family", /Georgia/);
  const [word, rest] = await Promise.all(
    [1, 0].map((i) =>
      spans
        .nth(i)
        .evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
    ),
  );
  expect(Math.round((word / rest) * 100)).toBe(Math.round((24 / 52) * 100));
  // The edit commits as one step with the runs formatted apart.
  await editor.focus();
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const title = P.getSlideShapes(P.getSlides(loaded)[0])[1];
  const runs = P.getShapeParagraphElements(title, 0);
  expect(runs.map((r) => r.text)).toEqual(["Make ", "room", " for"]);
  expect(runs[1].format).toMatchObject({
    color: "#CC0000",
    size: 24,
    font: "Georgia",
  });
  expect(runs[0].format).toMatchObject({ size: 52, font: "Arial" });
  expect(runs[0].format.color).not.toBe("#CC0000");
  await page.keyboard.press("Control+z");
  await hit.dblclick();
  await expect(editor.locator("span")).toHaveCount(2);
  await page.keyboard.press("Escape");
});

test("text formatting, alignment, and a fill apply to the current table cell", async ({
  page,
}) => {
  await story(page);
  await menuCommand(page, "Insert", "Table");
  const dialog = page.getByRole("dialog", { name: "Insert table" });
  await dialog.getByRole("spinbutton", { name: "Rows" }).fill("2");
  await dialog.getByRole("spinbutton", { name: "Columns" }).fill("2");
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  const table = page.locator('[data-object="7"]');
  await expect(table).toHaveClass(/selected/);
  await inspector(page);
  const format = panel(page);
  // The panel leads with the table and follows with the current cell's text.
  await expect(format.locator("h3").nth(0)).toHaveText("Table");
  await expect(format.locator("h3").nth(1)).toHaveText("Cell text");
  await expect(format.locator(".helper").nth(1)).toContainText(
    "Row 1, column 1",
  );
  // Formatting goes to the first cell: bold, 24 points, red, centered, at
  // the bottom, on a green fill.
  await format.getByRole("button", { name: "Bold", exact: true }).click();
  const size = format.getByRole("spinbutton", { name: "Font size" });
  await size.fill("24");
  await size.press("Enter");
  await format.locator('input[aria-label="Text color"]').fill("#cc0000");
  await format
    .getByRole("button", { name: "Align center", exact: true })
    .click();
  await format
    .getByRole("button", { name: "Align bottom", exact: true })
    .click();
  await format.locator('input[aria-label="Cell fill"]').fill("#00aa00");
  await expect(
    format.getByRole("button", { name: "Bold", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).split(",")[1],
    );
  await expect.poll(svg).toMatch(/00AA00/i);
  // Lists and line spacing are not for cells.
  await expect(
    format.getByRole("button", { name: "Bulleted list" }),
  ).toHaveCount(0);
  await expect(
    format.getByRole("combobox", { name: "Line spacing" }),
  ).toHaveCount(0);
  // Another cell becomes current when it is edited; its own formatting
  // leaves the first cell's alone, and keyboard shortcuts reach it too.
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  const box = await table.boundingBox();
  await table.dblclick({
    position: { x: (box.width * 3) / 4, y: (box.height * 3) / 4 },
  });
  const editor = page.getByRole("textbox", { name: /^Edit cell/ });
  await expect(editor).toHaveAccessibleName("Edit cell, row 2, column 2");
  await editor.fill("Second");
  await editor.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await inspector(page);
  await expect(format.locator(".helper").nth(1)).toContainText(
    "Row 2, column 2",
  );
  await format.getByRole("button", { name: "Italic", exact: true }).click();
  if (await close.isVisible()) await close.click();
  await table.press("Control+b");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const saved = P.getSlideShapes(P.getSlides(loaded)[0]).find(P.isTableShape);
  const cellFormat = (r, c) =>
    P.getTableCellParagraphs(P.getTableCell(saved, r, c))[0].elements.find(
      (e) => e.kind === "r",
    )?.format || {};
  expect(cellFormat(0, 0)).toMatchObject({
    bold: true,
    size: 24,
    color: "#CC0000",
  });
  expect(P.getTableCellAlignment(P.getTableCell(saved, 0, 0))).toBe("ctr");
  expect(P.getTableCellAnchor(P.getTableCell(saved, 0, 0))).toBe("bottom");
  expect(P.getTableCellFill(P.getTableCell(saved, 0, 0))).toBe("#00AA00");
  expect(P.getTableCellText(P.getTableCell(saved, 1, 1))).toBe("Second");
  expect(cellFormat(1, 1)).toMatchObject({ italic: true, bold: true });
  expect(cellFormat(0, 1).bold).toBeFalsy();
  expect(P.getTableCellFill(P.getTableCell(saved, 0, 1))).toBeNull();
});

test("Tab and Shift+Tab nest list items while editing, and the levels survive later edits", async ({
  page,
}) => {
  await story(page);
  await addText(page);
  const box = page.locator(".object-hit.selected");
  await expect(box).toHaveCount(1);
  await box.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.type("Plan");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Detail");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Wrap up");
  // Tab on the middle paragraph steps it in; the block shows the indent.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Tab");
  await expect(editor.locator(".para").nth(1)).toHaveAttribute(
    "data-level",
    "1",
  );
  await expect(editor.locator(".para").nth(0)).toHaveAttribute(
    "data-level",
    "0",
  );
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  // Bullets on the box render the nested item to the right of the others.
  const bullets = page.getByRole("button", {
    name: "Bulleted list",
    exact: true,
  });
  if (await bullets.first().isVisible()) await bullets.first().click();
  else {
    await openBarMenu(page, "Format");
    await page.getByRole("menuitem", { name: "Lists", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Bulleted list" }).click();
  }
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).split(",")[1],
    );
  await expect.poll(svg).toContain("Detail");
  const bulletX = (markup) =>
    [...markup.matchAll(/<text[^>]*x="([\d.]+)"[^>]*>[•◦▪]<\/text>/g)].map(
      (m) => parseFloat(m[1]),
    );
  let xs = bulletX(await svg());
  expect(xs.length).toBe(3);
  expect(xs[1]).toBeGreaterThan(xs[0]);
  expect(xs[2]).toBe(xs[0]);
  // Editing again keeps the level, and a plain retype of the text does too.
  await box.dblclick();
  await expect(editor.locator(".para").nth(1)).toHaveAttribute(
    "data-level",
    "1",
  );
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("!");
  await page.keyboard.press("Control+Enter");
  await expect.poll(svg).toContain("Wrap up!");
  xs = bulletX(await svg());
  expect(xs[1]).toBeGreaterThan(xs[0]);
  // The Format menu steps every paragraph without an open editor.
  await openBarMenu(page, "Format");
  await page.getByRole("menuitem", { name: "Lists", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Increase indent", exact: true })
    .click();
  // The step lands a moment after the menu closes.
  await expect.poll(async () => bulletX(await svg())[0]).toBeGreaterThan(xs[0]);
  const stepped = bulletX(await svg());
  expect(stepped[1]).toBeGreaterThan(stepped[0]);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shape = P.getSlideShapes(P.getSlides(loaded)[0]).find(
    (s) => P.getShapeText(s) === "Plan\nDetail\nWrap up!",
  );
  expect([0, 1, 2].map((i) => P.getParagraphLevel(shape, i))).toEqual([
    1, 2, 1,
  ]);
  expect(P.getParagraphIndent(shape, 1).leftEmu).toBe(1143000);
  // Shift+Tab steps back out.
  await box.dblclick();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+Tab");
  await expect(editor.locator(".para").nth(0)).toHaveAttribute(
    "data-level",
    "0",
  );
  await page.keyboard.press("Escape");
});

test("alignment and lists apply to the paragraphs selected while editing", async ({
  page,
}) => {
  await story(page);
  await page.getByRole("button", { name: /^Slide 4:/ }).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 4 of 5");
  const body = page.locator('[data-object="2"]');
  await body.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  const blocks = editor.locator(".para");
  await expect(blocks).toHaveCount(5);
  // The first paragraph, centered from the Format menu; the editor stays
  // open and the others keep their alignment.
  await page.keyboard.press("ArrowLeft");
  await openBarMenu(page, "Format");
  await page.getByRole("menuitem", { name: "Align", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Align center" }).click();
  await expect(editor).toBeFocused();
  await expect(blocks.nth(0)).toHaveCSS("text-align", "center");
  await expect(blocks.nth(2)).toHaveCSS("text-align", "left");
  // Paragraphs three to five become a bulleted list together; the toolbar's
  // list button reflects the caret's paragraph.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  const bullets = page.locator(
    '.ribbon-panel:not([hidden]) [data-command="bullets"]',
  );
  if (await bullets.isVisible()) {
    await expect(bullets).toHaveAttribute("aria-pressed", "false");
    await bullets.click();
    await expect(bullets).toHaveAttribute("aria-pressed", "true");
  } else {
    await openBarMenu(page, "Format");
    await page.getByRole("menuitem", { name: "Lists", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Bulleted list" }).click();
  }
  await expect(editor).toBeFocused();
  await expect(blocks.nth(2)).toHaveAttribute("data-list", "bullet");
  await expect(blocks.nth(4)).toHaveAttribute("data-list", "bullet");
  await expect(blocks.nth(0)).toHaveAttribute("data-list", "none");
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).split(",")[1],
    );
  await expect
    .poll(async () => ((await svg()).match(/>•</g) || []).length)
    .toBe(3);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shape = P.getSlideShapes(P.getSlides(loaded)[3])[2];
  expect(P.getParagraphAlignment(shape, 0)).toBe("ctr");
  expect(P.getParagraphAlignment(shape, 2)).not.toBe("ctr");
  const listed = (i) => {
    const bullet = P.getParagraphBullet(shape, i);
    return !!bullet && bullet !== "none";
  };
  expect([0, 1, 2, 3, 4].map(listed)).toEqual([false, false, true, true, true]);
  expect(P.getParagraphIndent(shape, 2).leftEmu).toBe(342900);
  // Taking the bullet off one paragraph leaves the others listed and clears
  // its hanging indent.
  await body.dblclick();
  await expect(blocks.nth(3)).toHaveAttribute("data-list", "bullet");
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await openBarMenu(page, "Format");
  await page.getByRole("menuitem", { name: "Lists", exact: true }).click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Bulleted list" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemcheckbox", { name: "Bulleted list" }).click();
  await expect(blocks.nth(3)).toHaveAttribute("data-list", "none");
  await expect(blocks.nth(2)).toHaveAttribute("data-list", "bullet");
  await page.keyboard.press("Control+Enter");
  await expect
    .poll(async () => ((await svg()).match(/>•</g) || []).length)
    .toBe(2);
});

test("a copy is saved to Puter under a new name and becomes the open presentation", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
  await openFileMenu(page);
  await page
    .getByRole("menuitem", { name: "Save a copy to Puter", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Save a copy" });
  const name = dialog.getByRole("textbox", { name: "Presentation name" });
  await expect(name).toHaveValue("The big idea copy");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".document-title span")).toHaveText(
    "The big idea copy",
  );
  await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
  await expect(
    page.getByText("Saved a copy as The big idea copy."),
  ).toBeVisible();
  const writes = await page.evaluate(() => window.__writes);
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toMatch(/The big idea copy\.pptx$/);
  expect(writes[0].options).toMatchObject({ dedupeName: true });
  // Later saves go to the copy, and the library lists it.
  await page.locator('[data-object="1"]').dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await editor.fill("Edited in the copy");
  await editor.press("Control+Enter");
  await page.keyboard.press("Control+s");
  // The queued edit/save can still show the preceding save's status.
  await expect.poll(() => page.evaluate(() => window.__writes.length)).toBe(2);
  await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
  const later = await page.evaluate(() => window.__writes);
  expect(later).toHaveLength(2);
  expect(later[1].path).toBe(writes[0].path);
  const savedCopy = await parseDeck(
    new Uint8Array(
      await page.evaluate(async () =>
        Array.from(
          new Uint8Array(
            await (
              await puter.fs.read(window.__writes.at(-1).path)
            ).arrayBuffer(),
          ),
        ),
      ),
    ),
  );
  expect(P.getSlideText(P.getSlides(savedCopy)[0])).toContain(
    "Edited in the copy",
  );
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(
    page.getByRole("button", { name: /^The big idea copy/ }),
  ).toBeVisible();
});

test("a rounded rectangle's corner radius follows the panel slider", async ({
  page,
}) => {
  await story(page);
  await openShapeMenu(page);
  await page
    .getByRole("menuitem", { name: "Rounded rectangle", exact: true })
    .click();
  await expect(page.locator(".object-hit.selected")).toHaveCount(1);
  await inspector(page);
  const radius = panel(page).getByRole("slider", { name: "Corner radius (%)" });
  await expect(radius).toHaveValue("17");
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).split(",")[1],
    );
  const before = await svg();
  await radius.fill("45");
  await expect(
    panel(page).locator(
      '.range-field:has(input[aria-label="Corner radius (%)"]) span',
    ),
  ).toHaveText("45%");
  await expect.poll(svg).not.toBe(before);
  // Other shapes offer no corner slider.
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page.keyboard.press("Escape");
  await page.locator('[data-object="0"]').click();
  await inspector(page);
  await expect(
    panel(page).getByRole("slider", { name: "Corner radius (%)" }),
  ).toHaveCount(0);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const rounded = P.getSlideShapes(P.getSlides(loaded)[0]).find(
    (s) => P.getShapePreset(s) === "roundRect",
  );
  expect(P.getShapeAdjustValues(rounded)).toEqual({ adj: 45000 });
});

test("paragraph spacing and line spacing apply to the whole box, or to the caret's paragraph while editing", async ({
  page,
}) => {
  await story(page);
  await page.getByRole("button", { name: /^Slide 4:/ }).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 4 of 5");
  const body = page.locator('[data-object="2"]');
  await body.click();
  await inspector(page);
  const after = panel(page).getByRole("spinbutton", {
    name: "Space after (pt)",
  });
  await expect(after).toHaveValue("0");
  await after.fill("12");
  await after.press("Enter");
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).split(",")[1],
    );
  const before = await svg();
  // While editing, the space before and a double line spacing go to the
  // caret's paragraph alone.
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await body.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await inspector(page);
  const spaceBefore = panel(page).getByRole("spinbutton", {
    name: "Space before (pt)",
  });
  await spaceBefore.fill("18");
  await spaceBefore.press("Enter");
  await expect(editor.locator(".para").nth(2)).toHaveCSS("margin-top", /px/);
  await expect(editor.locator(".para").nth(0)).toHaveCSS("margin-top", "0px");
  await panel(page)
    .getByRole("combobox", { name: "Line spacing" })
    .selectOption("2");
  await expect(editor.locator(".para").nth(2)).not.toHaveCSS(
    "line-height",
    "normal",
  );
  // Back to the text (closing the panel would end the edit) to finish it.
  await editor.focus();
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await expect.poll(svg).not.toBe(before);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shape = P.getSlideShapes(P.getSlides(loaded)[3])[2];
  expect(
    [0, 1, 2, 3, 4].map((i) => P.getParagraphSpacing(shape, i).afterPts),
  ).toEqual([12, 12, 12, 12, 12]);
  expect(
    [0, 1, 2, 3].map((i) => P.getParagraphSpacing(shape, i).beforePts),
  ).toEqual([null, null, 18, null]);
  expect(P.getParagraphLineSpacing(shape, 2)).toMatchObject({
    kind: "pct",
    value: 2,
  });
  expect(P.getParagraphLineSpacing(shape, 0)).toBeFalsy();
});

// A hovered primary or danger button used to take the plain button's light
// hover background while keeping its white label, so the label vanished.
test("primary and danger buttons keep their colors under the pointer", async ({
  page,
}) => {
  await story(page);
  await reloadLibrary(page);
  const keepsColor = async (button) => {
    const rest = await button.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    await button.hover();
    await expect(button).toHaveCSS("background-color", rest);
  };
  await keepsColor(
    page.getByRole("button", { name: "New presentation", exact: true }),
  );
  await page
    .getByRole("button", { name: "Options for The big idea", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete draft", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await keepsColor(dialog.getByRole("button", { name: "Delete", exact: true }));
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

// The text section's alignment row holds seven buttons and a separator, and
// the two flip buttons carry long labels; at the desktop panel width they
// used to run past the panel's padding, clipping the last button and adding
// a horizontal scrollbar.
test("the format panel's button rows fit inside the panel", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await expect(
    panel(page).getByRole("button", { name: "Align bottom", exact: true }),
  ).toBeVisible();
  const [outside, overflow] = await panel(page).evaluate((node) => {
    const content = node.querySelector(".inspector-content");
    const edge =
      content.getBoundingClientRect().right -
      parseFloat(getComputedStyle(content).paddingRight);
    return [
      [...content.querySelectorAll("*")]
        .filter((child) => {
          const box = child.getBoundingClientRect();
          return box.width > 0 && box.right > edge + 0.5;
        })
        .map((child) => child.getAttribute("aria-label") || child.className),
      node.scrollWidth - node.clientWidth,
    ];
  });
  expect(outside).toEqual([]);
  expect(overflow).toBe(0);
});

// The arrange section appends its optional rows straight into the panel, and
// a row an object lacks used to arrive as the text "false".
test("the format panel shows no stray text for the rows an object lacks", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await expect(
    panel(page).getByRole("button", { name: "Flip vertical", exact: true }),
  ).toBeVisible();
  const stray = await panel(page).evaluate((node) => {
    const content = node.querySelector(".inspector-content");
    return [...content.childNodes]
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => child.textContent.trim())
      .filter(Boolean);
  });
  expect(stray).toEqual([]);
});

// The canvas text editor is a contenteditable element; the unload guard used
// to read a textarea's value from it, threw, and warned about nothing.
test("the unsaved-work warning covers text still being typed on the canvas", async ({
  page,
}) => {
  await story(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator('[data-object="1"]').dblclick();
  const input = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(input).toBeFocused();
  const warns = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await warns()).toBe(false);
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  expect(await warns()).toBe(true);
  await input.press("Control+Enter");
  await expect(input).toHaveCount(0);
  // The status read "Saved on this device" before the edit too; the edit has
  // landed once the object carries the typed text.
  // AutoCorrect capitalizes the new sentence.
  await expect(page.locator('[data-object="1"]')).toHaveAccessibleName(
    /and more/i,
  );
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  expect(await warns()).toBe(false);
  expect(errors).toEqual([]);
});

// A toolbar or menu control suspends the canvas editor instead of closing it.
// Undo used to replace the presentation underneath the suspended editor, and
// the next click anywhere committed the typed text into the restored state,
// discarding the redo stack.
test("undoing while a canvas edit is suspended undoes the typed text", async ({
  page,
}) => {
  await story(page);
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).replace(
        "data:image/svg+xml;charset=utf-8,",
        "",
      ),
    );
  const title = page.locator('[data-object="1"]');
  await title.click();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeEnabled();
  await title.dblclick();
  const input = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(input).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" ZZZ");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(input).toHaveCount(0);
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  await expect(redo).toBeEnabled();
  await expect.poll(svg).not.toContain("ZZZ");
  await page.locator(".canvas-area").click({ position: { x: 10, y: 10 } });
  await expect(redo).toBeEnabled();
  expect(await svg()).not.toContain("ZZZ");
  await redo.click();
  await expect.poll(svg).toContain("ZZZ");
});

// Importing another presentation while an edit was suspended used to commit
// the typed text into the imported deck, whose first slide shares the part
// name and shape ids.
test("switching presentations commits a suspended canvas edit to its own presentation", async ({
  page,
}) => {
  await story(page);
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).replace(
        "data:image/svg+xml;charset=utf-8,",
        "",
      ),
    );
  await page.locator('[data-object="1"]').dblclick();
  const input = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(input).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" KEPT");
  await openFileMenu(page);
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("menuitem", { name: "Import PPTX", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "Incoming deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(createDeck("story"))),
  });
  await expect(page.locator(".document-title")).toHaveText("Incoming deck");
  await expect(input).toHaveCount(0);
  await page.locator(".canvas-area").click({ position: { x: 10, y: 10 } });
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  expect(await svg()).not.toContain("KEPT");
  await reloadLibrary(page);
  await page
    .getByRole("button", { name: "The big idea Recovery draft", exact: true })
    .click();
  await expect.poll(svg).toContain("KEPT");
});

// The object menu picked Group and Ungroup out of the arrange list by
// position, and the flip items added later shifted them.
test("the object menu offers Group for several objects and Ungroup for a group", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await page.locator('[data-object="2"]').click({ modifiers: ["Shift"] });
  await page.locator('[data-object="2"]').click({ button: "right" });
  let menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /Flip/ })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Group", exact: true }).click();
  // The panel may be closed on a phone; the button is still in the page.
  const ungroup = page.locator('#inspector button[aria-label="Ungroup"]');
  await expect(ungroup).toHaveCount(1);
  const group = page.locator('.object-hit[aria-pressed="true"]');
  await expect(group).toHaveAttribute("aria-label", /^Group \d+\./);
  // The children's hit regions lie over the group's, so the menu is asked
  // for on the group's region directly.
  await group.dispatchEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 200,
    clientY: 200,
  });
  menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /Flip/ })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Ungroup", exact: true }).click();
  await expect(ungroup).toHaveCount(0);
});

// A new slide used to join the slides selected before it rather than
// replace them, so the next Delete or Hide took the old selection along.
test("a new slide arrives as the only selected slide", async ({ page }) => {
  await story(page);
  await page
    .locator(".slide-thumb")
    .nth(1)
    .click({ modifiers: ["Shift"] });
  await expect(page.locator("#slide-count")).toHaveText("2 of 5 selected");
  await openBarMenu(page, "Slide");
  await page.getByRole("menuitem", { name: "New slide", exact: true }).click();
  await page.getByRole("menuitem", { name: "Blank", exact: true }).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 6");
  await expect(page.locator("#slide-count")).toHaveText("6");
  await expect(page.locator(".slide-item.selected")).toHaveCount(0);
});

// Edits and history steps used to leave the search's count and current match
// where they were, so Replace could act on a match that no longer existed.
test("an open search follows edits and history steps", async ({ page }) => {
  await story(page);
  await page.keyboard.press("Control+f");
  await page
    .getByRole("searchbox", { name: "Find", exact: true })
    .fill("Make room");
  const count = page.locator(".find-count");
  await expect(count).toHaveText("1 of 1");
  await expect(page.locator('.object-hit[aria-pressed="true"]')).toHaveCount(1);
  await openBarMenu(page, "Edit");
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(count).toHaveText("No matches");
  await expect(
    page.getByRole("button", { name: "Replace", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(count).toHaveText("1 of 1");
});

// The find bar's buttons are not text fields, so Backspace pressed on one of
// them used to delete the object the current match had selected.
test("Backspace on a find bar button leaves the matched object alone", async ({
  page,
}) => {
  await story(page);
  const objects = await page.locator(".object-hit").count();
  await page.keyboard.press("Control+f");
  await page
    .getByRole("searchbox", { name: "Find", exact: true })
    .fill("Make room");
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
  await page.getByRole("button", { name: "Next match", exact: true }).focus();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
  await expect(page.locator(".object-hit")).toHaveCount(objects);
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
});

// Any fragment other than the library's used to read as a request for a new
// presentation, so the skip link's "#main" replaced the library with one.
test("the skip link on the library keeps the library", async ({ page }) => {
  await start(page);
  await page.locator(".skip-link").focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  await expect(page.locator("#main")).toBeFocused();
});

// Renders are cached by slide XML, but a slide's size lives outside it; a
// size change without scaling used to keep every old render, stretched.
test("changing the slide size renders the slides at the new size", async ({
  page,
}) => {
  await story(page);
  const viewBox = async () =>
    /viewBox="([^"]+)"/.exec(
      decodeURIComponent(
        await page.locator(".slide-image").getAttribute("src"),
      ),
    )[1];
  expect(await viewBox()).toBe("0 0 1280.00 720.00");
  await openFileMenu(page);
  await page.getByRole("menuitem", { name: "Slide size" }).click();
  const dialog = page.getByRole("dialog", { name: "Slide size" });
  await dialog
    .getByRole("combobox", { name: "Slide size" })
    .selectOption("4:3");
  await dialog.getByRole("checkbox").uncheck();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".zoom-control > span")).toHaveText("4:3");
  await expect.poll(viewBox).toBe("0 0 960.00 720.00");
  await expect
    .poll(
      async () =>
        /viewBox="([^"]+)"/.exec(
          decodeURIComponent(
            await page.locator(".slide-thumb img").first().getAttribute("src"),
          ),
        )[1],
    )
    .toBe("0 0 960.00 720.00");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(viewBox).toBe("0 0 1280.00 720.00");
});

// Replacing a picture's bytes with a file of the same name leaves the
// slide's XML unchanged, so the cached render used to keep the old picture.
test("replacing a picture with a same-named file shows the new picture", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).replace(
        "data:image/svg+xml;charset=utf-8,",
        "",
      ),
    );
  let chooser = page.waitForEvent("filechooser");
  await insertImage(page);
  await (await chooser).setFiles(png(PIXEL_PNG));
  const picture = page.locator(".object-hit");
  await expect(picture).toHaveAccessibleName(
    "Image: photo.png. Select to edit",
  );
  await expect.poll(svg).toContain("<image");
  const before = await svg();
  await inspector(page);
  chooser = page.waitForEvent("filechooser");
  await panel(page).getByRole("button", { name: "Replace image" }).click();
  await (await chooser).setFiles(png(OTHER_PNG));
  await expect.poll(svg).not.toBe(before);
  await expect
    .poll(() => page.locator(".slide-thumb img").first().getAttribute("src"))
    .not.toBe("data:image/svg+xml;charset=utf-8," + encodeURIComponent(before));
});

// The link layer over the slide took every touch, so a swipe never reached
// the slide and did nothing on a touch screen.
test("the slideshow's link layer lets touches through to the slide", async ({
  page,
}) => {
  await story(page);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const image = page.locator(".presenter-slide");
  await expect(image).toBeVisible();
  expect(
    await image.evaluate((img) => {
      const box = img.getBoundingClientRect();
      return document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      )?.className;
    }),
  ).toBe("presenter-slide");
  await page.keyboard.press("Escape");
});

// A display rule set here outranks the browser's [hidden] rule, so the link
// dialog's address field stayed visible for a slide link, and the slideshow's
// next-slide preview kept a sliver of white on the last slide.
test("hidden controls stay hidden whatever their display rule", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Add link" });
  const address = dialog.getByRole("textbox", { name: "Web address" });
  await expect(address).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "Link to" })
    .selectOption("nextSlide");
  await expect(address).toBeHidden();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.keyboard.press("End");
  await page
    .locator(".presenter")
    .getByRole("button", { name: "Speaker notes", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("This is the last slide.")).toBeVisible();
  expect(
    await page
      .locator(".presenter-next")
      .evaluate((node) => node.hidden && getComputedStyle(node).display),
  ).toBe("none");
  await page.keyboard.press("Escape");
});

// Six controls that never wrapped ran off both sides of a phone's screen.
test("the slideshow's controls stay within the screen", async ({ page }) => {
  await story(page);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const controls = page.locator(".presenter-controls");
  await expect(controls).toBeVisible();
  const box = await controls.boundingBox();
  const width = await page.evaluate(() => innerWidth);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  await page.keyboard.press("Escape");
});

// The plain hover rule outranked the pressed rule, so a toggled Bold or
// alignment button looked untoggled under the pointer.
test("a pressed ribbon toggle keeps its pressed look under the pointer", async ({
  page,
}) => {
  // The button's colors ease in; read them settled.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await story(page);
  await page.locator('[data-object="1"]').click();
  const bold = await ribbonButton(page, "Home", "bold");
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  const rest = await bold.evaluate((node) => [
    getComputedStyle(node).backgroundColor,
    getComputedStyle(node).color,
  ]);
  await bold.hover();
  await expect(bold).toHaveCSS("background-color", rest[0]);
  await expect(bold).toHaveCSS("color", rest[1]);
});

// A toast already open when the slideshow started stayed underneath it, and
// a later toast only changed the covered message.
test("a toast shown during the slideshow appears above it", async ({
  page,
}) => {
  await story(page);
  // The title links to slide 2, which is hidden, so following it toasts.
  await page.locator('[data-object="1"]').click();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Add link" });
  await dialog
    .getByRole("combobox", { name: "Link to" })
    .selectOption("slide:/ppt/slides/slide2.xml");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("button", { name: "Options for slide 2", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Hide slide", exact: true }).click();
  await expect(page.locator(".slide-hidden")).toHaveCount(1);
  // A toast is open as the slideshow starts.
  await page.locator(".slide-thumb").first().focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  const toast = page.locator("#toast");
  await expect(toast).toHaveText(
    "Keep at least one slide in your presentation.",
  );
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const presenter = page.getByRole("dialog", { name: "Presentation mode" });
  await expect(presenter).toBeVisible();
  // The top layer paints in order of entry, so a message that stays put is
  // painted under the slideshow; one that re-enters it is painted above. The
  // popover's beforetoggle events tell which happened (the toggle event
  // that follows is coalesced into one).
  await toast.evaluate((node) => {
    window.__toggles = [];
    node.addEventListener("beforetoggle", (e) =>
      window.__toggles.push(e.newState),
    );
  });
  await presenter.getByRole("button", { name: "Go to slide 2" }).click();
  await expect(toast).toHaveText("That slide is hidden or was removed.");
  await expect
    .poll(() => page.evaluate(() => window.__toggles))
    .toEqual(["closed", "open"]);
  await expect(toast).toBeVisible();
  await page.keyboard.press("Escape");
});

// Only file drags were cancelled; a link or text dragged from another app
// fell through to the browser, which navigates the tab to a dropped link.
test("a link or text dragged from another app does not navigate the page", async ({
  page,
}) => {
  await story(page);
  const prevented = await page.evaluate(() => {
    const drag = (target, type) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/uri-list", "https://example.com/");
      dataTransfer.setData("text/plain", "https://example.com/");
      return !target.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }),
      );
    };
    const canvas = document.querySelector("#slide-canvas");
    const notes = document.querySelector("#speaker-notes");
    return {
      canvasOver: drag(canvas, "dragover"),
      canvasDrop: drag(canvas, "drop"),
      notesOver: drag(notes, "dragover"),
      notesDrop: drag(notes, "drop"),
    };
  });
  expect(prevented).toEqual({
    canvasOver: true,
    canvasDrop: true,
    notesOver: false,
    notesDrop: false,
  });
});

// crypto.randomUUID exists only in secure contexts; over plain http on a LAN
// address every presentation failed to open.
test("presentations open where crypto.randomUUID is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });
  await story(page);
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
});

// The copy's name went to the cloud as typed, so "Deck.pptx" was saved as
// Deck.pptx.pptx while every other naming path strips the extension.
test("a copy saved under a name ending in .pptx keeps one extension", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await openFileMenu(page);
  await page
    .getByRole("menuitem", { name: "Save a copy to Puter", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Save a copy" });
  await dialog
    .getByRole("textbox", { name: "Presentation name" })
    .fill("Deck.pptx");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".document-title span")).toHaveText("Deck");
  expect(await page.evaluate(() => window.__writes.at(-1).path)).toMatch(
    /\/Deck\.pptx$/,
  );
});

// Opposite crop sides could add up to more than the picture, which blew the
// remaining sliver up to nothing.
test("opposite crop sides leave some of the picture", async ({ page }) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  const chooser = page.waitForEvent("filechooser");
  await insertImage(page);
  await (await chooser).setFiles(png(PIXEL_PNG));
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await inspector(page);
  const left = panel(page).getByRole("spinbutton", { name: "Crop left (%)" });
  await left.fill("60");
  await left.press("Enter");
  await expect(left).toHaveValue("60");
  const right = panel(page).getByRole("spinbutton", {
    name: "Crop right (%)",
  });
  await right.fill("60");
  await right.press("Enter");
  await expect(right).toHaveValue("39");
});

// -90 and 270 are the same angle; typing the one over the other used to
// record an undo step that changed nothing.
test("the rotation field records no step for the same angle", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await inspector(page);
  const rotation = panel(page).getByRole("spinbutton", {
    name: "Rotation (°)",
  });
  await rotation.fill("270");
  await rotation.press("Enter");
  await expect(rotation).toHaveValue("270");
  await rotation.fill("-90");
  await rotation.press("Enter");
  await expect(rotation).toHaveValue("270");
  // One step back is the unrotated box; undo drops the selection, so the
  // box is selected again to read its field.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page.locator(".object-hit").click();
  await inspector(page);
  await expect(rotation).toHaveValue("0");
});

// A table is drawn at its grid's size even when the stored graphic frame
// is larger. Selection and cell editing must follow that displayed grid.
test("cells are found where the slide draws them", async ({ page }) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const frame = {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(6),
    h: P.inches(1),
  };
  const table = P.addSlideTable(slide, {
    ...frame,
    rows: [
      ["a", "b"],
      ["c", "d"],
    ],
  });
  P.setShapeBounds(table, { ...frame, h: P.inches(3) });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Tall table.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hit = page.locator(".object-hit");
  await expect(hit).toHaveAccessibleName(/^Table/);
  const box = await hit.boundingBox();
  expect(box.width / box.height).toBeCloseTo(6, 1);
  await hit.dblclick({
    position: { x: box.width * 0.75, y: box.height * 0.85 },
  });
  await expect(
    page.getByRole("textbox", { name: /^Edit cell/ }),
  ).toHaveAccessibleName("Edit cell, row 2, column 2");
});

// A new row used to be squeezed into the old frame with the others, and the
// editor's grid then disagreed with the drawing.
test("a table grows with its rows and shares its width among its columns", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await menuCommand(page, "Insert", "Table");
  const dialog = page.getByRole("dialog", { name: "Insert table" });
  await dialog.getByRole("spinbutton", { name: "Rows" }).fill("2");
  await dialog.getByRole("spinbutton", { name: "Columns" }).fill("3");
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await inspector(page);
  const height = panel(page).getByRole("spinbutton", { name: "Height (in)" });
  const width = panel(page).getByRole("spinbutton", { name: "Width (in)" });
  await expect(height).toHaveValue("1");
  const before = await width.inputValue();
  await panel(page).getByRole("button", { name: "Row below" }).click();
  await expect(height).toHaveValue("1.5");
  await panel(page).getByRole("button", { name: "Column right" }).click();
  await expect(width).toHaveValue(before);
  await panel(page).getByRole("button", { name: "Delete row" }).click();
  await expect(height).toHaveValue("1");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const saved = P.getSlideShapes(P.getSlides(loaded)[0])[0];
  const bounds = P.getShapeBounds(saved);
  expect(P.getTableRowHeights(saved).reduce((a, b) => a + b, 0)).toBe(bounds.h);
  expect(P.getTableColumnWidths(saved).reduce((a, b) => a + b, 0)).toBe(
    bounds.w,
  );
});

// Delete pressed on a focused thumbnail used to remove the current slide.
test("Delete in the navigator removes the focused slide", async ({ page }) => {
  await story(page);
  const thumbs = page.locator(".slide-thumb");
  await expect(thumbs.nth(2)).toHaveAttribute("aria-label", /THE APPROACH/);
  await thumbs.nth(2).focus();
  await page.keyboard.press("Delete");
  await expect(page.locator("#slide-count")).toHaveText("4");
  await expect(thumbs.first()).toHaveAttribute(
    "aria-label",
    /YOUR NEXT CHAPTER/,
  );
  await expect(
    page.locator('.slide-thumb[aria-label*="THE APPROACH"]'),
  ).toHaveCount(0);
});

// The link region sat where the unrotated object would be.
test("a rotated object's link region turns with it while presenting", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Add link" });
  await dialog
    .getByRole("combobox", { name: "Link to" })
    .selectOption("nextSlide");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await inspector(page);
  const rotation = panel(page).getByRole("spinbutton", {
    name: "Rotation (°)",
  });
  await rotation.fill("90");
  await rotation.press("Enter");
  await expect(rotation).toHaveValue("90");
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const region = page.getByRole("button", { name: "Go to next slide" });
  await expect(region).toHaveCSS("transform", "matrix(0, 1, -1, 0, 0, 0)");
  await page.keyboard.press("Escape");
});

// Placeholders that take their position from the layout have no position
// of their own, and grouping them threw a raw library error.
test("layout-positioned placeholders can be grouped", async ({ page }) => {
  await start(page);
  const pres = createDeck("blank");
  P.removeSlide(pres, P.getSlides(pres)[0]);
  const slide = P.addTitleSlide(pres, "Grouped title");
  P.addSlideShape(slide, {
    x: P.inches(1),
    y: P.inches(5),
    w: P.inches(2),
    h: P.inches(1),
    preset: "rect",
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Placeholders.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  // The title layout brings a title and a subtitle placeholder.
  await expect(page.locator(".object-hit")).toHaveCount(3);
  await page.locator("#slide-canvas").focus();
  await page.keyboard.press("Control+a");
  await expect(page.locator('.object-hit[aria-pressed="true"]')).toHaveCount(3);
  await page.keyboard.press("Control+Alt+g");
  await expect(
    page.locator('#inspector button[aria-label="Ungroup"]'),
  ).toHaveCount(1);
  await expect(page.locator("#toast")).not.toContainText("groupShapes");
});

// Ungrouping dropped the group's rotation, so its children snapped back to
// where they were before the group was turned.
test("ungrouping a turned group keeps its children where they were shown", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const rect = (y) =>
    P.addSlideShape(slide, {
      x: P.inches(1),
      y: P.inches(y),
      w: P.inches(2),
      h: P.inches(1),
      preset: "rect",
    });
  const group = P.groupShapes([rect(1), rect(3)]);
  P.setShapeRotation(group, 90);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Turned group.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".object-hit")).toHaveCount(3);
  await page.locator("#slide-canvas").focus();
  await page.keyboard.press("Control+a");
  await expect(page.locator('.object-hit[aria-pressed="true"]')).toHaveCount(1);
  await inspector(page);
  await panel(page)
    .getByRole("button", { name: "Ungroup", exact: true })
    .click();
  await expect(page.locator(".object-hit")).toHaveCount(2);
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const inches = (b) =>
    [b.x, b.y, b.w, b.h].map((v) => Math.round((v / 914400) * 100) / 100);
  const shapes = P.getSlideShapes(P.getSlides(loaded)[0]);
  // The group turned about its center at (2, 2.5) in: the upper box moved to
  // its right, the lower one to its left, each turned itself.
  expect(shapes.map((s) => inches(P.getShapeBounds(s)))).toEqual([
    [2, 2, 2, 1],
    [0, 2, 2, 1],
  ]);
  expect(shapes.map((s) => P.getShapeRotation(s))).toEqual([90, 90]);
});

// A group selected together with one of its children moved the child twice:
// once inside the moving group and once on its own.
test("a child selected along with its group moves only with the group", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const rect = (x) =>
    P.addSlideShape(slide, {
      x: P.inches(x),
      y: P.inches(1),
      w: P.inches(1),
      h: P.inches(1),
      preset: "rect",
    });
  P.groupShapes([rect(1), rect(3)]);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Group.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hits = page.locator(".object-hit");
  await expect(hits).toHaveCount(3);
  // The group's region lies under its children's; the second child is
  // pressed, then the group joins through its own region.
  await hits.nth(2).click();
  await hits.nth(0).dispatchEvent("click", { bubbles: true, shiftKey: true });
  await expect(page.locator("#inspector h3").first()).toHaveText(
    "2 objects selected",
  );
  await page.keyboard.press("Shift+ArrowRight");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const [group, first, second] = P.getSlideShapes(P.getSlides(loaded)[0]);
  const x = (s) => Math.round((P.getShapeBounds(s).x / 914400) * 100) / 100;
  expect(x(group)).toBe(1.1);
  // Children keep their place inside the group.
  expect([x(first), x(second)]).toEqual([1, 3]);
});

// Line spacing, paragraph spacing, and lists on a whole box looked only at
// the first paragraph, so a change already true of it did nothing for the
// rest, and bullets toggled off when only the first paragraph had them.
test("whole-box paragraph settings cover every paragraph", async ({ page }) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  const hit = page.locator(".object-hit");
  await hit.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await page.keyboard.press("Control+a");
  await page.keyboard.type("First");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second");
  // The caret's paragraph alone takes double spacing; the first, a bullet.
  await openBarMenu(page, "Format");
  await page
    .getByRole("menuitem", { name: "Line spacing", exact: true })
    .click();
  await page
    .getByRole("menuitemcheckbox", { name: "Double", exact: true })
    .click();
  await editor.focus();
  await page.keyboard.press("ArrowUp");
  await openBarMenu(page, "Format");
  await page.getByRole("menuitem", { name: "Lists", exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Bulleted list", exact: true })
    .click();
  await editor.focus();
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  // With the box selected, Single applies to every paragraph even though the
  // first is single already, and Bulleted list bullets the rest rather than
  // clearing the one that had it.
  await hit.click();
  await openBarMenu(page, "Format");
  await page
    .getByRole("menuitem", { name: "Line spacing", exact: true })
    .click();
  await page
    .getByRole("menuitemcheckbox", { name: "Single", exact: true })
    .click();
  await hit.click();
  await openBarMenu(page, "Format");
  await page.getByRole("menuitem", { name: "Lists", exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Bulleted list", exact: true })
    .click();
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const box = P.getSlideShapes(P.getSlides(loaded)[0])[0];
  expect([0, 1].map((i) => P.getParagraphLineSpacing(box, i))).toEqual([
    null,
    null,
  ]);
  expect([0, 1].map((i) => P.getParagraphBullet(box, i))).toEqual([
    "bullet",
    "bullet",
  ]);
});

// Deleting a slide left the links pointing at it in other slides, as
// relationships to a part no longer in the file.
test("deleting a slide removes the links to it", async ({ page }) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Add link" });
  await dialog
    .getByRole("combobox", { name: "Link to" })
    .selectOption("slide:/ppt/slides/slide2.xml");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await inspector(page);
  await expect(panel(page).locator(".link-target")).toHaveText("Slide 2");
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page
    .getByRole("button", { name: "Options for slide 2", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete slide", exact: true })
    .click();
  await expect(page.locator("#slide-count")).toHaveText("4");
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await expect(panel(page).locator(".link-target")).toHaveText("No link");
  if (await close.isVisible()) await close.click();
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const title = P.getSlideShapes(P.getSlides(loaded)[0])[0];
  expect(P.getShapeXmlString(title)).not.toContain("hlinksldjump");
});

// Find counted matches in the flattened text while Replace found them run
// by run, so the counts disagreed and Replace could change the wrong one.
test("find counts the matches that Replace can reach", async ({ page }) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const box = text(slide, "ab", 1, 1, 8, 1, 24, "#000000");
  setRichText(box, [
    {
      runs: [
        { text: "ab", format: {}, rpr: null, changes: { bold: true } },
        { text: "c abc abc", format: {}, rpr: null, changes: {} },
      ],
    },
  ]);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Runs.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.keyboard.press("Control+h");
  await page.getByRole("searchbox", { name: "Find", exact: true }).fill("abc");
  await expect(page.locator(".find-count")).toHaveText("1 of 2");
  await page.getByRole("textbox", { name: "Replace with" }).fill("ZZZ");
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
  await page.getByRole("button", { name: "Replace all", exact: true }).click();
  await expect(page.locator(".find-count")).toHaveText("No matches");
  await expect
    .poll(async () =>
      decodeURIComponent(
        await page.locator(".slide-image").getAttribute("src"),
      ),
    )
    .toContain("c ZZZ ZZZ");
});

// The toolbar read the editor's runs on every selection change and kept
// what it read, so once a run's text was deleted the spans still on screen
// indexed the wrong runs and the commit gave the rest the wrong formatting.
test("deleting a whole run keeps the remaining runs' formatting", async ({
  page,
}) => {
  await story(page);
  const hit = page.locator('[data-object="1"]');
  await hit.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  // "room" becomes a run of its own: italic, and plain in a bold title.
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+i");
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).split(",")[1],
    );
  await expect.poll(svg).toMatch(/font-style="italic"/);
  // The first run, "Make ", goes whole.
  await hit.dblclick();
  await expect(editor).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Delete");
  await expect(editor).toHaveText("room for\nbig ideas.", {
    useInnerText: true,
  });
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await expect.poll(svg).not.toContain("Make");
  // "room" is still its own italic run, followed by the bold " for".
  expect(await svg()).toMatch(/font-style="italic"[^>]*>room</);
  expect(await svg()).toMatch(/font-weight="700"[^>]*> for</);
});

// Opening the editor on text with an empty paragraph and clicking away used
// to record an undo step and rewrite the text without an edit.
test("opening and leaving the editor without typing records no undo step", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  const hit = page.locator(".object-hit");
  await hit.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("BBB");
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  const svg = async () =>
    decodeURIComponent(
      (await page.locator(".slide-image").getAttribute("src")).split(",")[1],
    );
  await expect.poll(svg).toContain("BBB");
  await hit.dblclick();
  await expect(editor).toBeFocused();
  await page.locator(".canvas-area").click({ position: { x: 10, y: 10 } });
  await expect(editor).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(svg).not.toContain("BBB");
});

// A submenu opened by hovering could not be entered from the keyboard, Escape
// then closed the whole menu, and the arrow keys left it open and stale.
test("a hover-opened submenu takes the keyboard like one opened by it", async ({
  page,
}) => {
  await story(page);
  await openFileMenu(page);
  const parent = page.getByRole("menuitem", {
    name: "Download as images",
    exact: true,
  });
  await parent.hover();
  const child = page.getByRole("menuitem", {
    name: "This slide as PNG",
    exact: true,
  });
  await expect(child).toBeVisible();
  await expect(parent).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(child).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(child).toHaveCount(0);
  await expect(parent).toBeFocused();
  // The pointer leaves and comes back, which opens the submenu once more.
  await page.getByRole("menuitem", { name: "Rename", exact: true }).hover();
  await parent.hover();
  await expect(child).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(child).toHaveCount(0);
  await expect(parent).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(parent).toHaveCount(0);
});

// A press near a thumbnail's edge released just outside it before the drag
// threshold left the drag armed: the pointer's next pass showed a phantom
// drop line, and the next click reordered the slides.
test("a press released outside a thumbnail before dragging arms no drag", async ({
  page,
}) => {
  await story(page);
  const thumbs = page.locator(".slide-thumb");
  const box = await thumbs.first().boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 3, y);
  await page.mouse.up();
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.move(box.x + box.width / 2 - 20, y);
  await expect(page.locator(".slide-drop")).toHaveCount(0);
  await expect(page.locator("#slide-list")).not.toHaveClass(/reordering/);
  await thumbs.first().click();
  await expect(thumbs.first()).toHaveAttribute(
    "aria-label",
    /YOUR NEXT CHAPTER/,
  );
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
});

// On a Mac, Ctrl-click opens the context menu; the modifier that adds a
// slide to the selection is the same one every other row names.
test("the shortcut list names the thumbnail modifier the way it names the rest", async ({
  page,
}) => {
  await story(page);
  await openFileMenu(page);
  await page
    .getByRole("menuitem", { name: "Keyboard shortcuts", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toContainText(
    "Shift + click / Ctrl / ⌘ + click on a thumbnail",
  );
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  // Tab nests a paragraph only while editing; the Lists menu says so only then.
  await page.locator('[data-object="1"]').click();
  await openBarMenu(page, "Format");
  await page.getByRole("menuitem", { name: "Lists", exact: true }).click();
  const indent = page.getByRole("menuitem", { name: "Increase indent" });
  await expect(indent).toBeVisible();
  await expect(indent.locator(".menu-shortcut")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

// A break inside a paragraph (a:br, typed with Shift+Enter) used to become a
// paragraph of its own on any edit, taking the next paragraph's bullet and
// alignment with it, and a slide-number field became plain text.
test("soft breaks survive an edit and Shift+Enter makes one", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const box = text(slide, "One", 1, 1, 8, 2, 28, "#000000");
  setRichText(box, [
    {
      runs: [
        {
          text: `First line${SOFT_BREAK}second line`,
          format: {},
          rpr: null,
          changes: {},
        },
      ],
    },
    { runs: [{ text: "Next paragraph", format: {}, rpr: null, changes: {} }] },
  ]);
  P.setParagraphBullet(box, 1, "bullet");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Breaks.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hit = page.locator(".object-hit");
  await expect(hit).toHaveCount(1);
  await hit.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  // Two paragraphs, the first shown on two lines.
  await expect(editor.locator(".para")).toHaveCount(2);
  await expect(editor.locator(".para").first()).toHaveText(
    "First line\nsecond line",
    { useInnerText: true },
  );
  // The caret goes to the end of the first paragraph's second line.
  await editor
    .locator(".para")
    .first()
    .evaluate((block) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let last = null;
      for (let node; (node = walker.nextNode());) last = node;
      const range = document.createRange();
      range.setStart(last, last.data.length);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await page.keyboard.type(" more");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("third line");
  await expect(editor.locator(".para")).toHaveCount(2);
  await expect(editor.locator(".para").first()).toHaveText(
    "First line\nsecond line more\nthird line",
    { useInnerText: true },
  );
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const saved = P.getSlideShapes(P.getSlides(loaded)[0])[0];
  expect(P.getShapeParagraphCount(saved)).toBe(2);
  expect(P.getShapeText(saved)).toBe(
    "First line\nsecond line more\nthird line\nNext paragraph",
  );
  // Two breaks inside the first paragraph, however the runs fall.
  expect(
    P.getShapeParagraphElements(saved, 0).filter((e) => e.kind === "br"),
  ).toHaveLength(2);
  expect(P.getParagraphBullet(saved, 0)).toBeFalsy();
  expect(P.getParagraphBullet(saved, 1)).toBe("bullet");
});

// Children of a turned or mirrored group were placed where they would be in
// an unturned group, so their handles and hit regions sat on empty canvas.
test("children of a turned group are found where the slide draws them", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const rect = (y) =>
    P.addSlideShape(slide, {
      x: P.inches(1),
      y: P.inches(y),
      w: P.inches(2),
      h: P.inches(1),
      preset: "rect",
    });
  const group = P.groupShapes([rect(1), rect(3)]);
  P.setShapeRotation(group, 90);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Turned group.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hits = page.locator(".object-hit");
  await expect(hits).toHaveCount(3);
  // The group turned about (2, 2.5) in: the upper box now stands at
  // (2, 2) in and the lower at (0, 2) in, each turned a quarter itself.
  expect(await placement(hits.nth(1))).toEqual([1500, 2667]);
  expect(await placement(hits.nth(2))).toEqual([0, 2667]);
  await expect(hits.nth(1)).toHaveCSS("transform", "matrix(0, 1, -1, 0, 0, 0)");
  // Moving a child by its box moves it where the slide shows it.
  await hits.nth(1).click();
  await page.keyboard.press("Shift+ArrowRight");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const [, first] = P.getSlideShapes(P.getSlides(loaded)[0]);
  const b = P.getShapeBounds(first);
  // A move to the right on the slide is a move up inside a group turned a
  // quarter clockwise.
  expect([b.x, b.y].map((v) => Math.round((v / 914400) * 100) / 100)).toEqual([
    1, 0.9,
  ]);
});

// The address field refused "example.com" on Enter while Done accepted it,
// and an address with a port was taken for another scheme.
test("the link dialog takes a bare address on Enter and one with a port", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await page.keyboard.press("Control+k");
  let dialog = page.getByRole("dialog", { name: "Add link" });
  await dialog
    .getByRole("textbox", { name: "Web address" })
    .fill("example.com");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await inspector(page);
  await expect(panel(page).locator(".link-target")).toHaveText(
    "https://example.com",
  );
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page.keyboard.press("Control+k");
  dialog = page.getByRole("dialog", { name: "Edit link" });
  await dialog
    .getByRole("textbox", { name: "Web address" })
    .fill("localhost:3000/deck");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await inspector(page);
  await expect(panel(page).locator(".link-target")).toHaveText(
    "https://localhost:3000/deck",
  );
});

// The rotate handle was a 14px circle on touch screens, and the footer's
// zoom buttons 24 by 22 pixels.
test("touch screens get larger targets for the rotate handle and zoom buttons", async ({
  page,
  hasTouch,
}) => {
  test.skip(!hasTouch, "Coarse pointers only.");
  await story(page);
  await page.locator('[data-object="1"]').click();
  const handle = page.locator(".rotate-handle");
  await expect(handle).toBeVisible();
  const hit = await handle.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const target = document.elementFromPoint(
      box.left + box.width / 2,
      box.top - 8,
    );
    return (
      target === node ||
      (target?.classList.contains("rotate-target") &&
        target.closest(".selection-box") === node.closest(".selection-box"))
    );
  });
  expect(hit).toBe(true);
  const zoom = page.getByRole("button", { name: "Zoom in", exact: true });
  expect(
    await zoom.evaluate((node) => {
      const after = getComputedStyle(node, "::after");
      return (
        parseFloat(after.height) - parseFloat(getComputedStyle(node).height)
      );
    }),
  ).toBeGreaterThanOrEqual(20);
});

// The dashed amber outline on a found object did not stand out on a white
// slide.
test("a found object's outline reads against a white slide", async ({
  page,
}) => {
  await story(page);
  await page.keyboard.press("Control+f");
  await page.getByRole("searchbox", { name: "Find", exact: true }).fill("a");
  const match = page.locator(".object-hit.match:not(.selected)").first();
  await expect(match).toBeVisible();
  await expect(match).toHaveCSS("outline-color", "rgb(184, 121, 26)");
});

// Stepping the size past the ladder's end recorded an undo step that
// changed nothing.
test("stepping the font size at its limit records no undo step", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await inspector(page);
  const size = panel(page).getByRole("spinbutton", { name: "Font size" });
  await size.fill("6");
  await size.press("Enter");
  await expect(size).toHaveValue("6");
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page.locator(".object-hit").click();
  // Five steps reach the smallest size; two more change nothing.
  for (let i = 0; i < 7; i++) await page.keyboard.press("Control+Shift+Comma");
  await inspector(page);
  await expect(size).toHaveValue("1");
  if (await close.isVisible()) await close.click();
  for (let i = 0; i < 5; i++)
    await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.locator(".object-hit").click();
  await inspector(page);
  await expect(size).toHaveValue("6");
});

// A name of spaces passed as a change and renamed the presentation to
// "Untitled presentation".
test("a blank name in the rename prompt changes nothing", async ({ page }) => {
  await story(page);
  const title = page.locator(".document-title");
  await title.click();
  const input = page.getByRole("textbox", { name: "Presentation name" });
  await input.fill("   ");
  await input.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(title).toHaveText("The big idea");
});

// The click that dismissed a context menu was swallowed when it landed
// inside the menu's anchor, and the slide menu's anchor is the whole
// workspace, so a Shift-click meant to add an object was lost.
test("dismissing the slide's context menu with a Shift-click still selects", async ({
  page,
}) => {
  await story(page);
  await page
    .locator("#slide-canvas")
    .click({ button: "right", position: { x: 5, y: 5 } });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.locator('[data-object="1"]').click({ modifiers: ["Shift"] });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator('[data-object="1"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

// A file named like a picture but holding something else made the library
// refuse it in its own words.
test("a file that is not a picture is refused in plain words", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await inspector(page);
  const chooser = page.waitForEvent("filechooser");
  await panel(page)
    .getByRole("button", { name: "Background image", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from("this is not a picture"),
  });
  await expect(page.locator("#toast")).toHaveText(
    "This file could not be read as an image. Choose a PNG or JPEG.",
  );
});

// Scaling the content to a new slide size skipped the text inside groups
// and the placeholders that take their position from the layout.
test("scaling to a new slide size covers grouped text and layout placeholders", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  P.removeSlide(pres, P.getSlides(pres)[0]);
  const slide = P.addTitleSlide(pres, "Title here");
  const title = P.getSlideShapes(slide)[0];
  const shown = P.getShapeBoundsResolved(pres, title);
  const boxes = [1, 4].map((x) => text(slide, "Grouped", x, 5, 2, 1, 28));
  P.groupShapes(boxes);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Scaled.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".object-hit")).toHaveCount(5);
  await openFileMenu(page);
  await page.getByRole("menuitem", { name: "Slide size" }).click();
  const dialog = page.getByRole("dialog", { name: "Slide size" });
  await dialog
    .getByRole("combobox", { name: "Slide size" })
    .selectOption("4:3");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".zoom-control > span")).toHaveText("4:3");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shapes = P.getSlideShapes(P.getSlides(loaded)[0]);
  // 16:9 to 4:3 keeps the height, so everything shrinks to three quarters
  // and moves in from the sides.
  const k = 0.75;
  const dx = (9144000 - 12192000 * k) / 2;
  const dy = (6858000 - 6858000 * k) / 2;
  expect(P.getShapeBounds(shapes[0])).toEqual({
    x: Math.round(shown.x * k + dx),
    y: Math.round(shown.y * k + dy),
    w: Math.round(shown.w * k),
    h: Math.round(shown.h * k),
  });
  const grouped = shapes.filter((s) => P.getShapeText(s) === "Grouped");
  expect(grouped.map((s) => P.getShapeRunFormat(s, 0, 0).size)).toEqual([
    21, 21,
  ]);
});

// A cell merged into its neighbor keeps a text body that is never shown,
// so typing into the merged-away half vanished on commit, and Find counted
// matches nobody could see.
test("a merged cell is edited as the cell it merged into", async ({ page }) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const table = P.addSlideTable(slide, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(6),
    h: P.inches(1),
    rows: [
      ["a", "hidden"],
      ["c", "d"],
    ],
  });
  P.mergeTableCells(table, { row: 0, col: 0, rowSpan: 1, colSpan: 2 });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Merged.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hit = page.locator(".object-hit");
  await expect(hit).toHaveAccessibleName(/^Table/);
  const box = await hit.boundingBox();
  // The right half of the first row belongs to the merged cell on the left.
  await hit.dblclick({
    position: { x: box.width * 0.75, y: box.height * 0.25 },
  });
  await expect(
    page.getByRole("textbox", { name: /^Edit cell/ }),
  ).toHaveAccessibleName("Edit cell, row 1, column 1");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+f");
  await page
    .getByRole("searchbox", { name: "Find", exact: true })
    .fill("hidden");
  await expect(page.locator(".find-count")).toHaveText("No matches");
});

// The ribbon's tabs scroll sideways on a narrow screen, and only sideways.
test("the ribbon's tab strip does not scroll vertically", async ({ page }) => {
  await story(page);
  await expect(page.locator(".ribbon-tabs")).toHaveCSS("overflow-y", "hidden");
});

// A rename finished after the editor was left did not reach the library.
test("the library lists a rename that finishes after leaving the editor", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await page.keyboard.press("Control+s");
  await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
  // The cloud takes a moment to rename; the library is opened meanwhile,
  // and lists its files again once the rename has gone through.
  await page.evaluate(() => {
    const rename = puter.fs.rename;
    puter.fs.rename = (...args) =>
      new Promise((resolve) => setTimeout(() => resolve(rename(...args)), 800));
    const readdir = puter.fs.readdir;
    window.__listings = 0;
    puter.fs.readdir = (...args) => {
      window.__listings++;
      return readdir(...args);
    };
  });
  await page.locator(".document-title").click();
  const input = page.getByRole("textbox", { name: "Presentation name" });
  await input.fill("Renamed idea");
  await input.press("Enter");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__listings)).toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.__listings), { timeout: 5000 })
    .toBe(2);
});

// With viewport-fit=cover the page runs under a phone's notch and home bar;
// the chrome keeps clear of them.
test("the chrome keeps clear of a phone's safe areas", async ({ page }) => {
  await story(page);
  const rules = await page.evaluate(() =>
    [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules];
        } catch {
          return [];
        }
      })
      .filter((rule) => rule.cssText.includes("safe-area-inset"))
      .map((rule) => rule.selectorText),
  );
  for (const selector of [
    ".editor-header",
    ".ribbon-tab-row",
    ".ribbon-body",
    ".editor-footer",
    ".presenter-controls",
    "#toast",
    ".home-header",
  ])
    expect(rules).toContain(selector);
});

// An account lookup that never answered held the library at "Loading" for
// good, local drafts and all.
test("the library opens as a guest while the account lookup hangs", async ({
  page,
}) => {
  test.slow();
  await mockPuter(page, { signedIn: true, delayAuth: true });
  await page.goto("/#/home");
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  await expect(page.locator(".library")).not.toContainText("Loading", {
    timeout: 10000,
  });
  // The account arrives late and is taken up.
  await page.evaluate(() => window.__releaseAuth());
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toHaveText("test-user", { timeout: 10000 });
});

// A file written elsewhere can give a link any address at all, and one with
// a "javascript:" scheme would run in the page the moment it was followed.
test("a link whose address is not a web, mail, or phone address gets no region while presenting", async ({
  page,
}) => {
  await start(page);
  const deck = createDeck("story");
  const [, title, body] = P.getSlideShapes(P.getSlides(deck)[0]);
  const script = "javascript:document.title='owned'";
  P.setShapeClickAction(title, { kind: "url", url: script });
  P.setShapeHyperlink(title, script);
  P.setShapeClickAction(body, { kind: "url", url: "mailto:hello@example.com" });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Linked deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(deck)),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const presenter = page.getByRole("dialog", { name: "Presentation mode" });
  await expect(
    presenter.getByRole("link", { name: "Open mailto:hello@example.com" }),
  ).toHaveAttribute("href", "mailto:hello@example.com");
  await expect(presenter.locator(".presenter-link")).toHaveCount(1);
  await expect(page.locator('[href^="javascript:" i]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page).toHaveTitle("Linked deck | Presentation");
  // The panel still shows the address, so the link can be edited or removed.
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  await expect(panel(page).locator(".link-target")).toHaveText(script);
  await panel(page).getByRole("button", { name: "Remove link" }).click();
  await expect(panel(page).locator(".link-target")).toHaveText("No link");
});

// The picker remembered the last color it applied and skipped a repeat of
// it, so a color given to one object could not be given to the next.
test("the ribbon's font color applies a color already given to another object", async ({
  page,
}) => {
  await story(page);
  const textColor = () =>
    panel(page).locator('.color-field:has(input[aria-label="Text color"])');
  const close = page.getByRole("button", { name: "Close format panel" });
  const closePanel = async () => {
    if (await close.isVisible()) await close.click();
  };
  // The first time from the palette; after that the button's own press
  // gives the color it shows.
  const pick = async (object, fromPalette) => {
    await closePanel();
    await page.locator(`[data-object="${object}"]`).click();
    await ribbonButton(page, "Home", "font-color");
    if (fromPalette) {
      await page
        .getByRole("button", { name: "Font colors", exact: true })
        .filter({ visible: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Dark Red", exact: true })
        .click();
    } else await (await ribbonButton(page, "Home", "font-color")).click();
    await inspector(page);
  };
  await pick(1, true);
  await expect(textColor()).toHaveText("#C00000");
  // The same color goes on a second object too.
  await pick(2, false);
  await expect(textColor()).toHaveText("#C00000");
  // And again after an undo took it off.
  await closePanel();
  await page.locator('[data-object="2"]').click();
  await page.keyboard.press("Control+z");
  await page.locator('[data-object="2"]').click();
  await inspector(page);
  await expect(textColor()).not.toHaveText("#C00000");
  await pick(2, false);
  await expect(textColor()).toHaveText("#C00000");
});

// A form with two number fields and no submit button ignores Enter, so the
// table dialog only closed through its Insert button.
test("Enter in the table dialog's fields inserts the table", async ({
  page,
}) => {
  await story(page);
  await menuCommand(page, "Insert", "Table");
  const dialog = page.getByRole("dialog", { name: "Insert table" });
  await dialog.getByRole("spinbutton", { name: "Rows" }).fill("2");
  const columns = dialog.getByRole("spinbutton", { name: "Columns" });
  await columns.fill("4");
  await columns.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-object="7"]')).toHaveClass(/selected/);
  await inspector(page);
  await expect(panel(page).locator(".helper").first()).toContainText("2 × 4");
});

// Firefox reports a mouse wheel's movement in lines rather than pixels; read
// as pixels, a notch fell far short of a zoom step.
test("a wheel that counts in lines zooms one step per notch", async ({
  page,
}) => {
  await story(page);
  const canvas = page.locator("#slide-canvas");
  const width = async () => Math.round((await canvas.boundingBox()).width);
  const level = page.getByRole("button", { name: "Zoom level" });
  const fitWidth = await width();
  const notch = (deltaY) =>
    page.evaluate((deltaY) => {
      document.querySelector("#canvas-area").dispatchEvent(
        new WheelEvent("wheel", {
          deltaY,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, deltaY);
  await notch(-3);
  await expect(level).toHaveText(/^\d+%$/);
  await expect.poll(width).toBeGreaterThan(fitWidth);
  const zoomed = await width();
  await notch(3);
  await expect.poll(width).toBeLessThan(zoomed);
  await page.keyboard.press("Control+0");
  await expect(
    page.getByRole("button", { name: "Fit slide to current window" }),
  ).toHaveAttribute("aria-pressed", "true");
});

// A shortcut pressed while a toolbar or panel picker held the focus was left
// to the browser, which has nothing to undo there, so the choice just made
// could not be taken back without leaving the picker first.
test("undo and redo reach the presentation from a picker that has the focus", async ({
  page,
}) => {
  await story(page);
  const title = page.locator('[data-object="1"]');
  const font = ribbonControl(page, "font-name");
  await title.click();
  await setRibbonFont(page, "Georgia");
  await expect(font).toHaveValue("Georgia");
  await font.focus();
  await page.keyboard.press("Control+z");
  // Undo clears the selection; the title reads Arial again once reselected.
  await title.click();
  await expect(font).toHaveValue("Arial");
  await font.focus();
  await page.keyboard.press("Control+Shift+z");
  await title.click();
  await expect(font).toHaveValue("Georgia");
  // A switch in the panel is the same: the shadow it just gave comes off.
  const close = page.getByRole("button", { name: "Close format panel" });
  const closePanel = async () => {
    if (await close.isVisible()) await close.click();
  };
  await page.locator('[data-object="3"]').click();
  await inspector(page);
  const shadow = panel(page).getByRole("checkbox", { name: "Drop shadow" });
  await shadow.check();
  await expect(shadow).toBeChecked();
  await page.keyboard.press("Control+z");
  await closePanel();
  await page.locator('[data-object="3"]').click();
  await inspector(page);
  await expect(
    panel(page).getByRole("checkbox", { name: "Drop shadow" }),
  ).not.toBeChecked();
});

// Bold from the toolbar reached the primary object of a selection alone,
// while the other selected objects kept their formatting.
test("text formatting from the toolbar applies to every selected object", async ({
  page,
}) => {
  await story(page);
  const title = page.locator('[data-object="1"]');
  const body = page.locator('[data-object="2"]');
  await title.click();
  await body.click({ modifiers: ["Shift"] });
  await expect(page.locator(".object-hit.selected")).toHaveCount(2);
  const italic = ribbonControl(page, "italic");
  const font = ribbonControl(page, "font-name");
  await (await ribbonButton(page, "Home", "italic")).click();
  await setRibbonFont(page, "Georgia");
  // Both objects carry the italic and the font.
  await title.click();
  await expect(italic).toHaveAttribute("aria-pressed", "true");
  await expect(font).toHaveValue("Georgia");
  await body.click();
  await expect(italic).toHaveAttribute("aria-pressed", "true");
  await expect(font).toHaveValue("Georgia");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shapes = P.getSlideShapes(P.getSlides(loaded)[0]);
  for (const i of [1, 2])
    expect(P.getShapeRunFormat(shapes[i], 0, 0)).toMatchObject({
      italic: true,
      font: "Georgia",
    });
  // Each change was one undo step for both objects.
  await body.click();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await title.click();
  await expect(italic).toHaveAttribute("aria-pressed", "false");
  await expect(font).toHaveValue("Arial");
  await body.click();
  await expect(italic).toHaveAttribute("aria-pressed", "false");
  await expect(font).toHaveValue("Arial");
});

// The helper text under a panel heading ran straight into the field below.
test("the panel's helper text stands clear of the field under it", async ({
  page,
}) => {
  await story(page);
  await menuCommand(page, "Insert", "Table");
  await page
    .getByRole("dialog", { name: "Insert table" })
    .getByRole("button", { name: "Insert", exact: true })
    .click();
  await inspector(page);
  const gaps = await panel(page).evaluate((node) =>
    [...node.querySelectorAll("p.helper + .field")].map((field) =>
      Math.round(
        field.getBoundingClientRect().top -
          field.previousElementSibling.getBoundingClientRect().bottom,
      ),
    ),
  );
  expect(gaps.length).toBeGreaterThanOrEqual(2);
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(10);
});

// A control disabled or removed while it had the focus dropped the focus
// onto the page, where the next Tab started over from the top.
test("keyboard focus stays in the editor when the control under it is used up", async ({
  page,
}) => {
  await story(page);
  const title = page.locator('[data-object="1"]');
  await title.click();
  await (await ribbonButton(page, "Home", "italic")).click();
  // The last undo hands the focus to the workspace, where one press too many
  // does nothing, rather than to Redo, where it would take the step back.
  const undo = page.locator("#undo");
  await expect(undo).toBeEnabled();
  await undo.focus();
  await page.keyboard.press("Enter");
  await expect(undo).toBeDisabled();
  await expect(page.locator("#main")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(undo).toBeDisabled();
  await expect(page.locator("#redo")).toBeEnabled();
  // A text control left without a selection hands it to the workspace.
  await title.click();
  const font = ribbonControl(page, "font-name");
  await setRibbonFont(page, "Georgia");
  await font.focus();
  await page.keyboard.press("Control+z");
  await expect(font).toBeDisabled();
  await expect(page.locator("#main")).toBeFocused();
  // A panel button that removes itself, or can no longer be used, hands it
  // to the panel.
  await title.click();
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Web address" }).fill("puter.com");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await inspector(page);
  const remove = panel(page).getByRole("button", { name: "Remove link" });
  await remove.focus();
  await page.keyboard.press("Enter");
  await expect(remove).toHaveCount(0);
  await expect(panel(page)).toBeFocused();
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await menuCommand(page, "Insert", "Table");
  const dialog = page.getByRole("dialog", { name: "Insert table" });
  await dialog.getByRole("spinbutton", { name: "Rows" }).fill("2");
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await inspector(page);
  const deleteRow = panel(page).getByRole("button", { name: "Delete row" });
  await deleteRow.focus();
  await page.keyboard.press("Enter");
  await expect(deleteRow).toBeDisabled();
  await expect(panel(page)).toBeFocused();
});

// Zoom in stayed pressable at 400% and Zoom out at 25%, where neither had
// anything left to do.
test("the zoom buttons and menu items switch off at the ends of the zoom ladder", async ({
  page,
}) => {
  await story(page);
  const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
  const zoomOut = page.getByRole("button", { name: "Zoom out", exact: true });
  const level = page.getByRole("button", { name: "Zoom level" });
  await expect(zoomIn).toBeEnabled();
  await expect(zoomOut).toBeEnabled();
  for (let i = 0; i < 15; i++) await page.keyboard.press("Control+=");
  await expect(level).toHaveText("400%");
  await expect(zoomIn).toBeDisabled();
  await expect(zoomOut).toBeEnabled();
  const view = page.getByRole("menuitem", { name: "View", exact: true });
  if (await view.isVisible()) {
    await view.click();
    await expect(
      page.getByRole("menuitem", { name: "Zoom in", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("menuitem", { name: "Zoom out", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");
  }
  // The button used up hands the focus to the workspace, so one press too
  // many does not zoom back in.
  await zoomOut.focus();
  for (let i = 0; i < 15; i++) await page.keyboard.press("Enter");
  await expect(level).toHaveText("25%");
  await expect(zoomOut).toBeDisabled();
  await expect(zoomIn).toBeEnabled();
  await expect(page.locator("#main")).toBeFocused();
  await page.keyboard.press("Control+0");
  await expect(
    page.getByRole("button", { name: "Fit slide to current window" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(zoomIn).toBeEnabled();
  await expect(zoomOut).toBeEnabled();
});

// With the focus on a thumbnail, the arrow keys moved the object selected on
// the canvas, and with nothing selected they did nothing at all.
test("arrow keys step along the slides from the navigator", async ({
  page,
}) => {
  await story(page);
  const thumb = (n) => page.locator(`.slide-item:nth-child(${n}) .slide-thumb`);
  const position = page.locator("#slide-position");
  const title = page.locator('[data-object="1"]');
  await title.click();
  const before = await title.boundingBox();
  await thumb(1).focus();
  await page.keyboard.press("ArrowDown");
  await expect(position).toHaveText("Slide 2 of 5");
  await expect(thumb(2)).toBeFocused();
  // Right steps forward too: phones lay the thumbnails out in a row.
  await page.keyboard.press("ArrowRight");
  await expect(position).toHaveText("Slide 3 of 5");
  await page.keyboard.press("ArrowUp");
  await expect(position).toHaveText("Slide 2 of 5");
  await page.keyboard.press("End");
  await expect(position).toHaveText("Slide 5 of 5");
  await expect(thumb(5)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(position).toHaveText("Slide 5 of 5");
  await page.keyboard.press("Home");
  await expect(position).toHaveText("Slide 1 of 5");
  await expect(thumb(1)).toBeFocused();
  // Shift extends the selection from the current slide and follows along.
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator("#slide-count")).toHaveText("3 of 5 selected");
  await expect(position).toHaveText("Slide 1 of 5");
  await expect(thumb(3)).toBeFocused();
  await expect(page.locator(".slide-item.selected")).toHaveCount(3);
  // The title on slide 1 stayed where it was.
  expect(await title.boundingBox()).toEqual(before);
  await openFileMenu(page);
  await page
    .getByRole("menuitem", { name: "Keyboard shortcuts", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Keyboard shortcuts" })
      .locator(".shortcuts > div", { hasText: "Move between slides" })
      .locator("kbd"),
  ).toHaveText("Arrow keys / Home / End in the navigator");
});

// With device storage unavailable, opening a presentation surfaced the
// browser's own error, and every edit repeated the storage warning.
test("unavailable device storage is reported once, in plain words", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new Error("IndexedDB is disabled");
      },
    });
  });
  await start(page);
  const toasts = [];
  await page.exposeFunction("__toast", (text) => toasts.push(text));
  await page.evaluate(() =>
    new MutationObserver(() => {
      const text = document.querySelector("#toast").textContent;
      if (text) window.__toast(text);
    }).observe(document.querySelector("#toast"), {
      childList: true,
      characterData: true,
      subtree: true,
    }),
  );
  const warning =
    "Device storage is unavailable. Save to Puter or download a copy to keep your work.";
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
  await expect(page.locator("#toast")).toHaveText(warning);
  await page.locator('[data-object="1"]').click();
  const italic = page.getByRole("button", { name: "Italic", exact: true });
  for (let i = 0; i < 3; i++) {
    await italic.first().click();
    await expect(italic.first()).toHaveAttribute(
      "aria-pressed",
      i % 2 ? "false" : "true",
    );
  }
  await expect(page.locator("#save-status")).toHaveText("Unsaved changes");
  expect(toasts.filter((text) => text === warning)).toHaveLength(1);
  expect(toasts.some((text) => text.includes("IndexedDB"))).toBe(false);
});

// Inserting a text box, a shape, or a picture, or pasting text from another
// app, while several objects were selected kept the others selected alongside
// the new one, so the panel read "2 objects selected" for an object just
// added.
test("a newly inserted or pasted object is selected on its own", async ({
  page,
}) => {
  await story(page);
  const objects = page.locator(".object-hit");
  const chosen = page.locator(".object-hit.selected");
  const selectPanels = async () => {
    await page.locator('[data-object="3"]').click({ position: { x: 8, y: 6 } });
    await page
      .locator('[data-object="4"]')
      .click({ modifiers: ["Shift"], position: { x: 8, y: 6 } });
    await expect(chosen).toHaveCount(2);
  };
  await selectPanels();
  await addText(page);
  await expect(objects).toHaveCount(8);
  await expect(chosen).toHaveCount(1);
  await expect(chosen).toHaveAccessibleName("Your text here. Select to edit");
  await expect(page.locator(".selection-box.multi")).toHaveCount(0);
  await selectPanels();
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "Pasted words");
    document.querySelector("#main").focus();
    document.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(objects).toHaveCount(9);
  await expect(chosen).toHaveCount(1);
  await expect(chosen).toHaveAccessibleName("Pasted words. Select to edit");
  await selectPanels();
  const chooser = page.waitForEvent("filechooser");
  await insertImage(page);
  await (await chooser).setFiles(png(PIXEL_PNG));
  await expect(objects).toHaveCount(10);
  await expect(chosen).toHaveCount(1);
  await expect(chosen).toHaveAccessibleName("Image: photo.png. Select to edit");
  await expect(page.locator(".selection-box.multi")).toHaveCount(0);
});

// A picture chosen for the slide that could not be decoded was refused with
// the browser's own words ("The source image could not be decoded."), unlike
// a background picture, which was refused in the app's.
test("an inserted picture that cannot be read is refused in plain words", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  const chooser = page.waitForEvent("filechooser");
  await insertImage(page);
  await (
    await chooser
  ).setFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from("this is not a picture"),
  });
  await expect(page.locator("#toast")).toHaveText(
    "This file could not be read as an image. Choose a PNG or JPEG.",
  );
  await expect(page.locator(".object-hit")).toHaveCount(0);
});

// The slide takes the keyboard focus while presenting, and the browser drew
// its focus ring around it after the first key press, for the rest of the
// show.
test("the slide shows no focus ring while presenting", async ({ page }) => {
  await story(page);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const slide = page.locator(".presenter-slide");
  await expect(slide).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".presenter-counter")).toHaveText("2 / 5");
  await expect(slide).toBeFocused();
  expect(
    await slide.evaluate((node) => getComputedStyle(node).outlineStyle),
  ).toBe("none");
  await page.keyboard.press("Escape");
});

// On a phone the control bar wraps onto two rows and covered the bottom of
// the notes panel; the stage kept clear of a one-row bar only.
test("the slideshow's controls keep clear of the notes and the slide", async ({
  page,
}) => {
  await story(page);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const presenter = page.getByRole("dialog", { name: "Presentation mode" });
  await presenter.getByRole("button", { name: "Speaker notes" }).click();
  const aside = presenter.getByRole("complementary", { name: "Speaker notes" });
  await expect(aside).toBeVisible();
  const controls = await presenter.locator(".presenter-controls").boundingBox();
  const notes = await aside.boundingBox();
  const slide = await presenter.locator(".presenter-slide-area").boundingBox();
  expect(notes.y + notes.height).toBeLessThanOrEqual(controls.y);
  expect(slide.y + slide.height).toBeLessThanOrEqual(controls.y);
  await page.keyboard.press("Escape");
});

// Each of several selected objects was held to the slide on its own, so a
// nudge toward an edge moved the ones with room and left the one at the edge
// behind, and the arrangement drifted apart.
test("arrow keys move several selected objects together, or not at all", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await openShapeMenu(page);
  await page.getByRole("menuitem", { name: "Rectangle", exact: true }).click();
  await addText(page);
  const objects = page.locator(".object-hit");
  await expect(objects).toHaveCount(2);
  // The text box goes against the slide's right edge.
  await inspector(page);
  await panel(page).getByRole("button", { name: "Right edges" }).click();
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  const lefts = () =>
    objects.evaluateAll((nodes) =>
      nodes.map((node) => Math.round(parseFloat(node.style.left) * 1000)),
    );
  await expect.poll(lefts).toEqual([24750, 51250]);
  await page.locator('[data-object="0"]').click();
  await page.locator('[data-object="1"]').click({ modifiers: ["Shift"] });
  await expect(page.locator(".object-hit.selected")).toHaveCount(2);
  // Right has no room for the text box, so neither moves; left moves both.
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(lefts).toEqual([24000, 50500]);
  await expect(page.locator(".object-hit.selected")).toHaveCount(2);
});

// While several objects were dragged together, the one under the pointer
// snapped to the edges and centers of the others, which were moving along
// with it, and a guide line marked a meeting that never happened.
test("objects dragged together do not snap to each other", async ({ page }) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  for (let i = 0; i < 2; i++) {
    await openShapeMenu(page);
    await page
      .getByRole("menuitem", { name: "Rectangle", exact: true })
      .click();
  }
  const objects = page.locator(".object-hit");
  await expect(objects).toHaveCount(2);
  // The second rectangle spans 8 to 11 inches, its center at 9.5.
  await inspector(page);
  const x = panel(page).getByRole("spinbutton", { name: "X (in)" });
  await x.fill("8");
  await x.press("Enter");
  await expect(x).toHaveValue("8");
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page.locator('[data-object="0"]').click();
  await page.locator('[data-object="1"]').click({ modifiers: ["Shift"] });
  await expect(page.locator(".object-hit.selected")).toHaveCount(2);
  const canvas = await page.locator("#slide-canvas").boundingBox();
  const pixelsPerInch = canvas.width / 13.333;
  const box = await page.locator('[data-object="0"]').boundingBox();
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // The first's right edge (6.3 in) comes up to where the second's center
  // was (9.5 in); the second has moved on with it, so there is no guide.
  await page.mouse.move(cx + (9.5 - 6.3 + 0.02) * pixelsPerInch, cy, {
    steps: 8,
  });
  await expect(objects.nth(0)).toHaveCSS("left", /.+/);
  expect(await page.locator(".snap-guide").count()).toBe(0);
  await page.mouse.up();
  // The hit regions are rebuilt when the move lands, so a read may catch a
  // moment without one.
  await expect
    .poll(async () =>
      Math.round(
        (await page.locator('[data-object="1"]').boundingBox())?.x ?? -Infinity,
      ),
    )
    .toBeGreaterThan(Math.round(box.x + box.width) + 3 * pixelsPerInch);
});

// The link dialog's address field followed the kind of link with no room
// between them, unlike the other dialogs' fields.
test("the link dialog's address field stands clear of the kind of link", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Add link" });
  const kind = await dialog
    .getByRole("combobox", { name: "Link to" })
    .boundingBox();
  const address = await dialog
    .locator('label:has(input[aria-label="Web address"])')
    .boundingBox();
  expect(address.y - (kind.y + kind.height)).toBeGreaterThanOrEqual(12);
  await page.keyboard.press("Escape");
});

// The browser's own undo lost track of the text once the editor redrew it
// for a paragraph break, so Ctrl+Z did nothing after the first Enter. The
// editor keeps its own steps; with none left, Ctrl+Z leaves the editor and
// undoes the edit before it, as it would outside the editor.
test("undo and redo inside the canvas text editor step through the typing", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  const box = page.locator(".object-hit");
  await expect(box).toHaveCount(1);
  await box.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text" });
  await expect(editor).toBeFocused();
  const content = () =>
    editor.evaluate((node) => node.innerText.replace(/\n+$/, ""));
  await page.keyboard.press("End");
  await page.keyboard.type(" for now");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second line");
  await expect.poll(content).toBe("Your text here for now\nSecond line");
  await page.keyboard.press("Control+z");
  await expect.poll(content).toBe("Your text here for now");
  await page.keyboard.press("Control+z");
  await expect.poll(content).toBe("Your text here for now");
  await page.keyboard.press("Control+z");
  await expect.poll(content).toBe("Your text here");
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(content).toBe("Your text here for now");
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+Enter");
  await expect(box).toHaveAccessibleName(
    "Your text here for now. Select to edit",
  );
  // With nothing typed since the editor opened, Ctrl+Z reaches the edit
  // that was committed before.
  await box.dblclick();
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect(editor).toHaveCount(0);
  await expect(box).toHaveAccessibleName("Your text here. Select to edit");
});

// Dragging the rotate handle of an object inside a turned group set the
// object's own turn to the angle the slide showed, so it jumped by the
// group's turn on top of the drag.
test("a grouped object turned by its handle keeps the group's turn out of its own", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  for (let i = 0; i < 2; i++) {
    await openShapeMenu(page);
    await page
      .getByRole("menuitem", { name: "Rectangle", exact: true })
      .click();
  }
  const objects = page.locator(".object-hit");
  await expect(objects).toHaveCount(2);
  await inspector(page);
  const y = panel(page).getByRole("spinbutton", { name: "Y (in)" });
  await y.fill("5");
  await y.press("Enter");
  await expect(y).toHaveValue("5");
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  // On a phone the second rectangle's rotate handle would reach over the
  // first, so the selection is let go before the pair is picked.
  await page.locator("#slide-canvas").click({ position: { x: 4, y: 4 } });
  await expect(page.locator(".selection-box")).toHaveCount(0);
  await page.locator('[data-object="0"]').click();
  await page.locator('[data-object="1"]').click({ modifiers: ["Shift"] });
  await inspector(page);
  await panel(page).getByRole("button", { name: "Group", exact: true }).click();
  await expect(objects).toHaveCount(3);
  const rotation = panel(page).getByRole("spinbutton", {
    name: "Rotation (°)",
  });
  await rotation.fill("90");
  await rotation.press("Enter");
  await expect(rotation).toHaveValue("90");
  if (await close.isVisible()) await close.click();
  // The first child shows the group's turn; its own is still none.
  const child = page.locator('[data-object="1"]');
  await child.click();
  await expect(child).toHaveClass(/selected/);
  await expect(child).toHaveAttribute("style", /rotate\(90deg\)/);
  const handle = await page.locator(".rotate-handle").boundingBox();
  const box = await child.boundingBox();
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  const [hx, hy] = [handle.x + handle.width / 2, handle.y + handle.height / 2];
  const radius = Math.hypot(hx - cx, hy - cy);
  const from = Math.atan2(hy - cy, hx - cx);
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    const angle = from + ((30 * Math.PI) / 180) * (i / 6);
    await page.mouse.move(
      cx + radius * Math.cos(angle),
      cy + radius * Math.sin(angle),
    );
  }
  await page.mouse.up();
  // A 30° turn of the handle is a 30° turn of the object, shown at 120°.
  await expect
    .poll(async () =>
      Math.round(
        parseFloat(
          /rotate\(([-\d.]+)deg\)/.exec(await child.getAttribute("style"))[1],
        ),
      ),
    )
    .toBeGreaterThan(110);
  const shown = parseFloat(
    /rotate\(([-\d.]+)deg\)/.exec(await child.getAttribute("style"))[1],
  );
  expect(shown).toBeLessThan(130);
  await inspector(page);
  const own = Number(await rotation.inputValue());
  expect(own).toBeGreaterThan(20);
  expect(own).toBeLessThan(40);
});

// Escape let go of an object or a slide being dragged, but not of a marquee:
// the box stayed with the pointer and selected what it covered on release.
test("Escape lets go of a marquee before the pointer is released", async ({
  page,
}) => {
  await story(page);
  const canvas = await page.locator("#slide-canvas").boundingBox();
  await page.mouse.move(
    canvas.x + canvas.width * 0.78,
    canvas.y + canvas.height * 0.2,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvas.x + canvas.width * 0.98,
    canvas.y + canvas.height * 0.8,
    { steps: 5 },
  );
  await expect(page.locator(".marquee")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".marquee")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator(".object-hit.selected")).toHaveCount(0);
  await expect(page.locator(".selection-box")).toHaveCount(0);
});

// The object menu's Align, Distribute, Group, and Ungroup items were built
// before the right-click selected the object under it, so with nothing
// selected Align to slide came disabled, and an unselected group's Ungroup
// too.
test("the object menu's arrange items follow the object right-clicked", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click({ button: "right" });
  let menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "Align to slide", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.locator('[data-object="1"]').click();
  await page.locator('[data-object="2"]').click({ modifiers: ["Shift"] });
  await page.locator('[data-object="2"]').click({ button: "right" });
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: "Group", exact: true })
    .click();
  const group = page.locator('.object-hit[aria-pressed="true"]');
  await expect(group).toHaveAttribute("aria-label", /^Group \d+\./);
  const id = await group.getAttribute("data-shape-id");
  await page.keyboard.press("Escape");
  await expect(page.locator('.object-hit[aria-pressed="true"]')).toHaveCount(0);
  // The children's hit regions lie over the group's, so the menu is asked
  // for on the group's region directly.
  await page
    .locator(`.object-hit[data-shape-id="${id}"]`)
    .dispatchEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 300,
    });
  menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "Ungroup", exact: true }),
  ).toBeEnabled();
  await expect(
    menu.getByRole("menuitem", { name: "Align to slide", exact: true }),
  ).toBeEnabled();
  await menu.getByRole("menuitem", { name: "Ungroup", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(7);
});

// The canvas editor opened upright over a turned text box, so the turned
// text stayed in view beside an upright copy of it being edited.
test("text is edited at the angle its box is turned to", async ({ page }) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await inspector(page);
  const rotation = panel(page).getByRole("spinbutton", {
    name: "Rotation (°)",
  });
  await rotation.fill("30");
  await rotation.press("Enter");
  await expect(page.locator(".object-hit")).toHaveAttribute(
    "style",
    /rotate\(30deg\)/,
  );
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page.locator(".object-hit").dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  const angle = await editor.evaluate((node) => {
    const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(node).transform);
    if (!m) return null;
    const [a, b] = m[1].split(",").map(Number);
    return Math.round((Math.atan2(b, a) * 180) / Math.PI);
  });
  expect(angle).toBe(30);
});

// Ungrouping put a mirrored group's children back where the group held
// them, unmirrored, so they swapped sides and lost their mirroring; a turned
// child inside a mirrored group turns the other way, and lost that too.
test("ungrouping a mirrored group keeps its children where they were shown", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const rect = (x) =>
    P.addSlideShape(slide, {
      x: P.inches(x),
      y: P.inches(1),
      w: P.inches(1),
      h: P.inches(1),
      preset: "rect",
    });
  const [left, right] = [rect(1), rect(3)];
  P.setShapeRotation(right, 30);
  const group = P.groupShapes([left, right]);
  P.setShapeFlip(group, { horizontal: true, vertical: false });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Mirrored group.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".object-hit")).toHaveCount(3);
  // The mirrored group shows its first child on the right, its second on
  // the left and turned the other way.
  await expect(page.locator('[data-object="1"]')).toHaveAttribute(
    "style",
    /left: 22\.5/,
  );
  await expect(page.locator('[data-object="2"]')).toHaveAttribute(
    "style",
    /rotate\(330deg\)/,
  );
  await page.locator("#slide-canvas").focus();
  await page.keyboard.press("Control+a");
  await expect(page.locator('.object-hit[aria-pressed="true"]')).toHaveCount(1);
  await inspector(page);
  await panel(page)
    .getByRole("button", { name: "Ungroup", exact: true })
    .click();
  await expect(page.locator(".object-hit")).toHaveCount(2);
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const inches = (b) =>
    [b.x, b.y, b.w, b.h].map((v) => Math.round((v / 914400) * 100) / 100);
  const shapes = P.getSlideShapes(P.getSlides(loaded)[0]);
  expect(shapes.map((s) => inches(P.getShapeBounds(s)))).toEqual([
    [3, 1, 1, 1],
    [1, 1, 1, 1],
  ]);
  expect(shapes.map((s) => P.getShapeRotation(s) || 0)).toEqual([0, 330]);
  expect(shapes.map((s) => !!P.getShapeFlip(s)?.horizontal)).toEqual([
    true,
    true,
  ]);
});

// An image relationship whose target was an address rather than a part path
// made the media check throw after the picture had joined the slide, so the
// picture was neither shown nor in the history nor in the draft until the
// next edit carried it along.
test("a picture is inserted on a slide whose file holds an odd image target", async ({
  page,
}) => {
  await start(page);
  const files = unzipSync(await P.savePresentation(createDeck("blank")));
  const rels = Object.keys(files).find((name) =>
    /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name),
  );
  files[rels] = new TextEncoder().encode(
    new TextDecoder()
      .decode(files[rels])
      .replace(
        "</Relationships>",
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://a:99999/x.png"/></Relationships>',
      ),
  );
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Odd target.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(zipSync(files)),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  const image = page.waitForEvent("filechooser");
  await insertImage(page);
  await (await image).setFiles(png(PIXEL_PNG));
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await expect(page.locator(".object-hit")).toHaveAccessibleName(/^Image/);
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
});

// An edit that failed part-way left what it had done in the presentation
// but out of the canvas, the history, and the draft; the next edit then
// carried it along as its own. The last snapshot comes back instead.
test("an edit that fails part-way leaves the presentation as it was", async ({
  page,
}) => {
  await page.route("**/src/model.js*", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = "export function dedupeSlideMedia(pres, target) {";
    if (!body.includes(marker)) throw new Error("model.js changed shape");
    await route.fulfill({
      response,
      body: body.replace(
        marker,
        `${marker}\n  throw new Error("The media check failed.");`,
      ),
    });
  });
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  const image = page.waitForEvent("filechooser");
  await insertImage(page);
  await (await image).setFiles(png(PIXEL_PNG));
  await expect(page.locator("#toast")).toHaveText("The media check failed.");
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(2);
  for (const hit of await page.locator(".object-hit").all())
    await expect(hit).toHaveAccessibleName(/^Your text here/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(0);
});

// A file whose group shares an id with one of its own children sent the walk
// up the groups round in a circle, freezing the page the moment another
// object was moved along with the child.
test("moving a selection survives a group that shares its child's id", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const rect = (x) =>
    P.addSlideShape(slide, {
      x: P.inches(x),
      y: P.inches(1),
      w: P.inches(1),
      h: P.inches(1),
      preset: "rect",
    });
  const [first, second, loose] = [rect(1), rect(3), rect(6)];
  const group = P.groupShapes([first, second]);
  const element = group[Symbol.for("@office-kit/pptx.shape.element")];
  const cNvPr = element.children
    .find((c) => c.name?.localName === "nvGrpSpPr")
    .children.find((c) => c.name?.localName === "cNvPr");
  cNvPr.attrs.find((a) => a.name.localName === "id").value = String(
    P.getShapeId(first),
  );
  P.renameShape(group, "Twins");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Twins.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hits = page.locator(".object-hit");
  await expect(hits).toHaveCount(4);
  const ids = await hits.evaluateAll((nodes) =>
    nodes.map((node) => node.dataset.shapeId),
  );
  // The shapes are told apart as the file opens; the walk up the groups
  // stays bounded all the same.
  expect(new Set(ids).size).toBe(4);
  const child = page.locator(
    `.object-hit[data-shape-id="${P.getShapeId(second)}"]`,
  );
  const other = page.locator(
    `.object-hit[data-shape-id="${P.getShapeId(loose)}"]`,
  );
  await child.click();
  await other.click({ modifiers: ["Shift"] });
  await expect(page.locator('.object-hit[aria-pressed="true"]')).toHaveCount(2);
  const before = await other.evaluate((node) => node.style.left);
  await page.keyboard.press("ArrowRight");
  await expect(other).not.toHaveAttribute(
    "style",
    new RegExp(`left: ${before.replace(".", "\\.")}`),
  );
  await expect(page.locator('.object-hit[aria-pressed="true"]')).toHaveCount(2);
});

// Placing the hit regions read the canvas width after each one was added,
// so every object on the slide cost the browser a layout of its own.
test("selecting on a slide with many objects lays the page out a few times, not once per object", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  for (let i = 0; i < 40; i++)
    P.addSlideShape(slide, {
      x: P.inches(0.5 + (i % 8) * 1.5),
      y: P.inches(0.5 + Math.floor(i / 8) * 1.3),
      w: P.inches(1),
      h: P.inches(1),
      preset: "rect",
    });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Forty.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hits = page.locator(".object-hit");
  await expect(hits).toHaveCount(40);
  await hits.first().click();
  await expect(page.locator(".object-hit.selected")).toHaveCount(1);
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  const layouts = async () =>
    (await client.send("Performance.getMetrics")).metrics.find(
      (metric) => metric.name === "LayoutCount",
    ).value;
  const before = await layouts();
  await page.keyboard.press("Escape");
  await expect(page.locator(".object-hit.selected")).toHaveCount(0);
  expect((await layouts()) - before).toBeLessThan(12);
});

// Typing over a title of two paragraphs left the editor's runs behind its
// text, so the toolbar looked for the caret's paragraph past the last one
// and fell into a loop: the page reported a stack overflow and the toolbar
// stopped following the text.
test("the toolbar follows text typed over several paragraphs", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await story(page);
  await page.locator('[data-object="1"]').dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  // The editor opens with all of its text selected; typing replaces it.
  await editor.pressSequentially("One line now");
  await expect(editor).toHaveText("One line now");
  await editor.press("Control+i");
  await expect(
    page.locator('.ribbon-panel:not([hidden]) [data-command="italic"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await editor.press("Control+Enter");
  await expect(page.locator('[data-object="1"]')).toHaveAccessibleName(
    /^One line now/,
  );
  expect(errors).toEqual([]);
  await expect(page.locator("#toast")).not.toContainText("stack");
});

// Deleting or cutting a grouped object did nothing to the file, since the
// library takes objects off the slide's top level only, yet recorded an undo
// step and wrote the draft as if it had.
test("a grouped object is deleted or cut on its own", async ({ page }) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const rect = (x) =>
    P.addSlideShape(slide, {
      x: P.inches(x),
      y: P.inches(1),
      w: P.inches(1),
      h: P.inches(1),
      preset: "rect",
    });
  const [first, second] = [rect(1), rect(3)];
  P.groupShapes([first, second]);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Pair.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hits = page.locator(".object-hit");
  await expect(hits).toHaveCount(3);
  await page
    .locator(`.object-hit[data-shape-id="${P.getShapeId(second)}"]`)
    .click();
  await page.keyboard.press("Delete");
  await expect(hits).toHaveCount(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(hits).toHaveCount(3);
  await page
    .locator(`.object-hit[data-shape-id="${P.getShapeId(first)}"]`)
    .click();
  await page.keyboard.press("Control+x");
  await expect(hits).toHaveCount(2);
  await page.keyboard.press("Control+v");
  await expect(hits).toHaveCount(3);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shapes = P.getSlideShapes(P.getSlides(loaded)[0]);
  expect(shapes.map(P.getShapeKind)).toEqual(["group", "shape", "shape"]);
  expect(P.getGroupChildren(shapes[0]).length).toBe(1);
});

// Replace found the text it had just written when the replacement held the
// word looked for, so each press replaced inside the last replacement.
test("Replace moves on past a replacement that holds the search text", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  const box = page.locator(".object-hit");
  await expect(box).toHaveCount(1);
  await box.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await editor.fill("cat dog cat");
  await editor.press("Control+Enter");
  await expect(box).toHaveAccessibleName(/^cat dog cat/);
  await page.keyboard.press("Control+h");
  await page.getByRole("searchbox", { name: "Find", exact: true }).fill("cat");
  await page
    .getByRole("textbox", { name: "Replace with", exact: true })
    .fill("cats");
  const count = page.locator(".find-count");
  await expect(count).toHaveText("1 of 2");
  const replace = page.getByRole("button", { name: "Replace", exact: true });
  await replace.click();
  await expect(box).toHaveAccessibleName(/^cats dog cat\./);
  await expect(count).toHaveText("2 of 2");
  await replace.click();
  await expect(box).toHaveAccessibleName(/^cats dog cats\./);
});

// The canvas editor's copies of the runs left the field element behind, so
// any edit to a footer turned its slide number into plain text.
test("editing text beside a slide number field keeps the field", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const box = text(slide, "Company ", 1, 6, 6, 0.5, 14);
  const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const node = (localName, attrs = [], children = []) => ({
    kind: "element",
    name: { prefix: "a", localName, namespaceURI: NS_A },
    attrs: attrs.map(([name, value]) => ({
      name: { prefix: "", localName: name, namespaceURI: "" },
      value,
    })),
    prefixDecls: new Map(),
    children,
  });
  const body = box[Symbol.for("@office-kit/pptx.shape.element")].children.find(
    (c) => c.name?.localName === "txBody",
  );
  body.children
    .find((c) => c.name?.localName === "p")
    .children.push(
      node(
        "fld",
        [
          ["id", "{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}"],
          ["type", "slidenum"],
        ],
        [node("t", [], [{ kind: "text", data: "1" }])],
      ),
    );
  P.renameShape(box, "Footer");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Footer.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hit = page.locator(".object-hit");
  await expect(hit).toHaveAccessibleName(/^Company 1/);
  await hit.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await editor.press("Home");
  await editor.pressSequentially("Our ");
  await editor.press("Control+Enter");
  await expect(hit).toHaveAccessibleName(/^Our Company 1/);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shape = P.getSlideShapes(P.getSlides(loaded)[0])[0];
  expect(P.getShapeText(shape)).toBe("Our Company 1");
  expect(P.getShapeXmlString(shape)).toMatch(/<a:fld [^>]*type="slidenum"/);
});

// A paragraph spaced by a fixed number of points showed as a "NaN" choice in
// the panel's line spacing list.
test("fixed line spacing reads as its points in the panel", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const box = text(slide, "Exactly spaced\nlines", 1, 1, 6, 2, 24);
  P.setParagraphLineSpacing(box, 0, { kind: "pts", value: 20 });
  P.setParagraphLineSpacing(box, 1, { kind: "pts", value: 20 });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Spaced.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await page.locator(".object-hit").click();
  await inspector(page);
  const spacing = panel(page).getByRole("combobox", { name: "Line spacing" });
  await expect(spacing).not.toHaveValue("NaN");
  await expect(spacing.locator("option:checked")).toHaveText("Exactly 20 pt");
  // Choosing a multiple replaces the fixed spacing; the fixed choice goes.
  await spacing.selectOption("1.5");
  await expect(spacing).toHaveValue("1.5");
  await expect(spacing.locator("option")).toHaveCount(4);
});

// A marquee tested an object's box as if it stood upright, so a turned
// object was selected where it was not and missed where it was.
test("a marquee selects a turned object where the slide shows it", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const strip = P.addSlideShape(slide, {
    x: P.inches(1),
    y: P.inches(3),
    w: P.inches(4),
    h: P.inches(0.5),
    preset: "rect",
  });
  P.setShapeRotation(strip, 90);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Strip.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".object-hit")).toHaveCount(1);
  const canvas = await page.locator("#slide-canvas").boundingBox();
  const at = (x, y) => [
    canvas.x + (x / 13.333) * canvas.width,
    canvas.y + (y / 7.5) * canvas.height,
  ];
  const marquee = async ([x1, y1], [x2, y2]) => {
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 5 });
    await page.mouse.up();
  };
  // The strip stands from (2.75, 1.25) to (3.25, 5.25) in; its upright box
  // would lie from (1, 3) to (5, 3.5).
  await marquee(at(2.4, 4.2), at(3.6, 5));
  await expect(page.locator(".object-hit.selected")).toHaveCount(1);
  await marquee(at(0.6, 2.9), at(1.6, 3.6));
  await expect(page.locator(".object-hit.selected")).toHaveCount(0);
});

// Bold pressed in an editor whose text had all been deleted formatted no run,
// so the text typed next came out plain.
test("formatting chosen in an emptied editor applies to the text typed next", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await addText(page);
  const box = page.locator(".object-hit");
  await expect(box).toHaveCount(1);
  await box.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await editor.press("Delete");
  await expect(editor).toHaveText("");
  await editor.press("Control+b");
  await expect(
    page.locator('.ribbon-panel:not([hidden]) [data-command="bold"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await editor.pressSequentially("typed");
  await editor.press("Control+Enter");
  await expect(box).toHaveAccessibleName(/^typed/);
  await expect(
    page.locator('.ribbon-panel:not([hidden]) [data-command="bold"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shape = P.getSlideShapes(P.getSlides(loaded)[0])[0];
  expect(P.getShapeText(shape)).toBe("typed");
  expect(P.getShapeRunFormat(shape, 0, 0)).toMatchObject({ bold: true });
});

// A copy of a grouped object joined the slide's top level with the object's
// own turn and mirroring, not the ones the group gave it on the slide.
test("a duplicated grouped object keeps the turn and mirroring it showed", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const rect = (x) =>
    P.addSlideShape(slide, {
      x: P.inches(x),
      y: P.inches(1),
      w: P.inches(1),
      h: P.inches(1),
      preset: "rect",
    });
  const [left, right] = [rect(1), rect(3)];
  P.setShapeRotation(right, 30);
  const group = P.groupShapes([left, right]);
  P.setShapeFlip(group, { horizontal: true, vertical: false });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Mirrored pair.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hits = page.locator(".object-hit");
  await expect(hits).toHaveCount(3);
  const child = page.locator(
    `.object-hit[data-shape-id="${P.getShapeId(right)}"]`,
  );
  await expect(child).toHaveAttribute("style", /rotate\(330deg\)/);
  await child.click();
  await page.keyboard.press("Control+d");
  await expect(hits).toHaveCount(4);
  const copy = page.locator(".object-hit.selected");
  await expect(copy).toHaveAttribute("style", /rotate\(330deg\)/);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const pasted = P.getSlideShapes(P.getSlides(loaded)[0]).at(-1);
  expect(P.getShapeKind(pasted)).toBe("shape");
  expect(P.getShapeRotation(pasted)).toBe(330);
  expect(P.getShapeFlip(pasted)).toMatchObject({ horizontal: true });
});

// A copied object kept a slide link's relationship id without the
// relationship, so the paste pointed the link at whatever the destination
// slide held under that id, or at nothing, and the file needed repair.
test("a pasted object's slide link goes to its slide, or goes", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="3"]').click();
  await page.keyboard.press("Control+k");
  await page
    .getByRole("combobox", { name: "Link to" })
    .selectOption("slide:/ppt/slides/slide3.xml");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await inspector(page);
  await expect(panel(page).locator(".link-target")).toHaveText("Slide 3");
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page.locator('[data-object="3"]').click();
  await page.keyboard.press("Control+c");
  await page.locator(".slide-thumb").nth(1).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 5");
  await page.keyboard.press("Control+v");
  await inspector(page);
  await expect(panel(page).locator(".link-target")).toHaveText("Slide 3");
  if (await close.isVisible()) await close.click();
  const dangling = (files, part) => {
    const xml = new TextDecoder().decode(files[part]);
    const rels = new TextDecoder().decode(
      files[part.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels")],
    );
    const ids = new Set(
      [...rels.matchAll(/ Id="([^"]+)"/g)].map((match) => match[1]),
    );
    return [...xml.matchAll(/ r:id="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((id) => id && !ids.has(id));
  };
  await openFileMenu(page);
  let downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  let bytes = new Uint8Array(await readFile(await (await downloaded).path()));
  let loaded = await parseDeck(bytes);
  const second = P.getSlides(loaded)[1];
  const action = P.getShapeClickAction(P.getSlideShapes(second).at(-1));
  expect(action?.kind).toBe("slide");
  expect(P.getSlidePartName(action.slide)).toBe(
    P.getSlidePartName(P.getSlides(loaded)[2]),
  );
  expect(
    dangling(unzipSync(bytes), P.getSlidePartName(second).slice(1)),
  ).toEqual([]);
  // In another presentation the slide is not there to link to.
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(page.locator(".object-hit")).toHaveCount(0);
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await inspector(page);
  await expect(panel(page).locator(".link-target")).toHaveText("No link");
  if (await close.isVisible()) await close.click();
  await openFileMenu(page);
  downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  bytes = new Uint8Array(await readFile(await (await downloaded).path()));
  loaded = await parseDeck(bytes);
  const only = P.getSlides(loaded)[0];
  expect(P.getShapeClickAction(P.getSlideShapes(only)[0])).toBeNull();
  expect(dangling(unzipSync(bytes), P.getSlidePartName(only).slice(1))).toEqual(
    [],
  );
});

// The saved appearance was applied once the app's code ran, so a dark
// window painted the page light first. The page now reads the choice before
// it paints, as the sibling apps do.
test("the saved appearance applies before the app's code runs", async ({
  page,
}) => {
  await page.route("**/src/main.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("presentation:theme", "dark");
  });
  await page.goto("/");
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("dark");
  await page.addInitScript(() => {
    localStorage.removeItem("presentation:theme");
  });
  await page.goto("/");
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("system");
});

// The title button was named "Rename presentation", so the heading never
// gave the presentation's name to a screen reader, and a long name cut short
// had no tooltip to read it from.
test("the title is named by the presentation and says how to rename it", async ({
  page,
}) => {
  await story(page);
  const title = page.locator(".document-title");
  await expect(title).toHaveAccessibleName("The big idea");
  await expect(title).toHaveAccessibleDescription("Rename “The big idea”");
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(
    "The big idea",
  );
  await title.click();
  const dialog = page.getByRole("dialog", { name: "Rename presentation" });
  await dialog.getByRole("textbox", { name: "Presentation name" }).fill("Q3");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(title).toHaveAccessibleName("Q3");
  await expect(title).toHaveAccessibleDescription("Rename “Q3”");
  await expect(page).toHaveTitle("Q3 | Presentation");
});

// The phone layout's rules replaced the paddings that kept the chrome clear
// of a notch and the home bar with plain ones.
test("the phone layout keeps the chrome clear of the screen's insets", async ({
  page,
}) => {
  await story(page);
  const declarations = await page.evaluate(() => {
    const found = {};
    for (const sheet of document.styleSheets)
      for (const rule of sheet.cssRules)
        if (rule.media?.mediaText.includes("max-width: 760px"))
          for (const inner of rule.cssRules)
            for (const selector of [
              ".editor-header",
              ".editor-footer",
              ".presenter-controls",
              ".home-header",
            ])
              if (inner.selectorText === selector)
                found[selector] = inner.style.cssText;
    return found;
  });
  expect(Object.keys(declarations).sort()).toEqual([
    ".editor-footer",
    ".editor-header",
    ".home-header",
    ".presenter-controls",
  ]);
  for (const text of Object.values(declarations))
    expect(text).toContain("safe-area-inset");
  expect(declarations[".editor-footer"]).toContain(
    "calc(27px + env(safe-area-inset-bottom))",
  );
});

// Escape rebuilt the object regions and dropped the keyboard focus onto the
// page, where the next Tab started over from the top.
test("Escape deselects an object and keeps the focus on it", async ({
  page,
}) => {
  await story(page);
  const title = page.locator('[data-object="1"]');
  await title.click();
  await expect(title).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(title).toHaveAttribute("aria-pressed", "false");
  await expect(title).toBeFocused();
});

// The save status was rewritten after every edit, so a screen reader
// announced "Saved on this device" again and again over the work.
test("the save status is announced only when it changes", async ({ page }) => {
  await story(page);
  const status = page.locator("#save-status");
  await expect(status).toHaveText("Saved on this device");
  await page.evaluate(() => {
    window.__statusChanges = 0;
    new MutationObserver(() => window.__statusChanges++).observe(
      document.querySelector("#save-status"),
      { childList: true, subtree: true, characterData: true },
    );
  });
  const title = page.locator('[data-object="1"]');
  await title.click();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await expect(title).toHaveAttribute("style", /left: 6\.2/);
  await expect(status).toHaveText("Saved on this device");
  expect(await page.evaluate(() => window.__statusChanges)).toBe(0);
});

// The account button showed the username but was named "Account and
// settings" alone, so what it showed was not what it was called.
test("the account button is named after the signed-in account", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  const account = page.getByRole("button", { name: "Account and settings" });
  await expect(account).toContainText("test-user");
  await expect(account).toHaveAccessibleName("test-user: account and settings");
});

// The arrow keys moved the selected object from wherever the focus was, so
// a tool button in the toolbar nudged the object when it was stepped along.
test("the arrows move an object from the canvas, not from a tool button", async ({
  page,
}) => {
  await story(page);
  const title = page.locator('[data-object="1"]');
  await title.click();
  const before = await title.getAttribute("style");
  await page
    .locator('.ribbon-panel:not([hidden]) [data-command="bold"]')
    .focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  expect(await title.getAttribute("style")).toBe(before);
  await title.focus();
  await page.keyboard.press("ArrowDown");
  await expect(title).not.toHaveAttribute("style", before);
});

// A value typed past a field's range was put back to the old one without a
// word; it now takes the nearest end of the range, as the field shows. The
// table dialog turned 0 columns into the default 3 instead of the least, 1.
test("number fields take the nearest allowed value and the table dialog the least", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await inspector(page);
  const size = panel(page).getByRole("spinbutton", { name: "Font size" });
  await size.fill("999");
  await size.press("Enter");
  await expect(size).toHaveValue("144");
  await expect(ribbonControl(page, "font-size")).toHaveValue("144");
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await menuCommand(page, "Insert", "Table");
  const dialog = page.getByRole("dialog", { name: "Insert table" });
  await dialog.getByRole("spinbutton", { name: "Rows" }).fill("99");
  await dialog.getByRole("spinbutton", { name: "Columns" }).fill("0");
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await inspector(page);
  await expect(panel(page).locator(".helper").first()).toContainText("30 × 1.");
});

// Slide options and the find bar's buttons were drawn under 44px with
// nothing more to press on a touch screen.
test("touch screens get larger targets for slide options and the find bar", async ({
  page,
}) => {
  await story(page);
  const coarse = await page.evaluate(
    () => matchMedia("(pointer: coarse)").matches,
  );
  test.skip(!coarse, "a touch screen only");
  await page.keyboard.press("Control+f");
  const heights = await page.evaluate(() =>
    [
      document.querySelector(".slide-item > .icon-btn"),
      document.querySelector(".findbar .icon-btn"),
      document.querySelector(".find-action"),
    ].map((node) => parseFloat(getComputedStyle(node, "::after").height)),
  );
  for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
});

// A long name in the library ended in an ellipsis with no way to read the
// rest of it.
test("a library row's name is readable in full from its tooltip", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/#/home");
  await page.evaluate(async () => {
    await puter.fs.write(
      "Presentations/A rather long presentation name that runs past the row.pptx",
      new Blob(["x"]),
      {},
    );
  });
  // The library reads the cloud again on the way back from the editor.
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const row = page.getByRole("button", {
    name: /^A rather long presentation name/,
  });
  await expect(row).toHaveAttribute(
    "title",
    "A rather long presentation name that runs past the row",
  );
});

// The tools are no navigation landmark: the ribbon's tabs are a tab list and
// the quick commands a toolbar.
test("the editing tools are a tab list and a toolbar, and a menu's heading is not an item", async ({
  page,
}) => {
  await story(page);
  await expect(page.getByRole("tablist").first()).toBeVisible();
  await expect(
    page.getByRole("toolbar", { name: "Quick Access Toolbar" }),
  ).toBeVisible();
  // The menu bar is a menubar, so no navigation landmark remains.
  expect(await page.getByRole("navigation").count()).toBe(0);
  // The library shows the account button on every screen size.
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page.getByRole("button", { name: "Account and settings" }).click();
  const header = page.locator(".menu-header").first();
  await expect(header).toHaveText("Not signed in");
  await expect(header).toHaveAttribute("role", "presentation");
});

// The format panel laid over a narrow screen's canvas had no way to close
// from the keyboard but its own button; Escape closes it first, as it does
// the find bar.
test("Escape closes the format panel laid over the canvas", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await story(page);
  await page.locator('[data-object="1"]').click();
  await (await ribbonButton(page, "View", "view-format-pane")).click();
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(page.locator("#main")).toBeFocused();
  // The object stays selected; a second Escape lets it go.
  await expect(page.locator('[data-object="1"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-object="1"]')).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

// Dialogs without a field to focus opened on their Close button; the first
// choice takes the focus instead.
test("the slide size and appearance dialogs open on their first choice", async ({
  page,
}) => {
  await story(page);
  await openFileMenu(page);
  await page
    .getByRole("menuitem", { name: "Page setup (slide size)…", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Slide size" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await openBarMenu(page, "View");
  await page.getByRole("menuitem", { name: "Appearance", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Color mode" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await themeDialog(page);
  await expect(
    page.getByRole("button", { name: "Studio", exact: true }),
  ).toBeFocused();
});

// A photo straight from a phone went into the file at its full size, and
// every edit of its slide redrew many megabytes of it; a picture larger than
// a slide can show at twice its size on screen is scaled down as it comes in.
test("a very large picture is scaled down as it is inserted", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  const chooser = page.waitForEvent("filechooser");
  await insertImage(page);
  await (
    await chooser
  ).setFiles({
    name: "Huge.png",
    mimeType: "image/png",
    buffer: noisePng(3200, 2400),
  });
  const hit = page.locator(".object-hit");
  await expect(hit).toHaveAccessibleName("Image: Huge.png. Select to edit");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const files = unzipSync(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const media = Object.keys(files).find((name) => /^ppt\/media\//.test(name));
  const view = new DataView(files[media].buffer, files[media].byteOffset);
  expect([view.getUint32(16), view.getUint32(20)]).toEqual([2560, 1920]);
  // The picture keeps its proportions on the slide.
  const [w, h] = await hit.evaluate((node) => [
    parseFloat(node.style.width) * 13.333,
    parseFloat(node.style.height) * 7.5,
  ]);
  expect(Math.round((w / h) * 100) / 100).toBe(1.33);
});
// A PNG of the given size filled with noise, which compresses as little as
// a photo does, so a smaller copy of it is smaller in bytes too.
function noisePng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const rows = randomFillSync(Buffer.alloc((width + 1) * height));
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// The slide waited for the edit's snapshot, a serialization of the whole
// file, and for the draft's write before it showed the edit.
test("the slide shows an edit before the draft is written", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      indexedDB.open = open;
      const request = open(...args);
      Object.defineProperty(request, "onsuccess", {
        set(callback) {
          request.addEventListener(
            "success",
            (event) => {
              window.__releaseDraft = () => callback(event);
            },
            { once: true },
          );
        },
      });
      return request;
    };
  });
  const title = page.locator('[data-object="1"]');
  await title.click();
  const before = await title.getAttribute("style");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => window.__releaseDraft);
  await expect(title).not.toHaveAttribute("style", before);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await page.evaluate(() => window.__releaseDraft());
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
});

// The panel's Content field wrote the text back as plain paragraphs, so a
// typo fixed there took every bullet, alignment, and run format with it.
test("the Content field keeps each paragraph's settings and formatting", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const box = text(slide, "Heading\nPoint one\nPoint two", 1, 1, 6, 3, 24);
  P.setShapeRunFormat(box, 0, 0, { bold: true });
  P.setParagraphAlignment(box, 0, "center");
  P.setParagraphBullet(box, 1, "bullet");
  P.setParagraphBullet(box, 2, "bullet");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "List.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await page.locator(".object-hit").click();
  await inspector(page);
  const content = panel(page).getByRole("textbox", { name: "Object text" });
  await content.fill("Heading\nPoint one!\nPoint two\nPoint three");
  await content.press("Tab");
  await expect(page.locator(".object-hit")).toHaveAccessibleName(/Point three/);
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const shape = P.getSlideShapes(P.getSlides(loaded)[0])[0];
  expect(P.getShapeText(shape)).toBe(
    "Heading\nPoint one!\nPoint two\nPoint three",
  );
  expect(P.getShapeRunFormat(shape, 0, 0)).toMatchObject({ bold: true });
  expect(P.getShapeRunFormat(shape, 1, 0)?.bold).toBeFalsy();
  expect(P.getParagraphAlignment(shape, 0)).toBe("ctr");
  expect([1, 2, 3].map((i) => P.getParagraphBullet(shape, i))).toEqual([
    "bullet",
    "bullet",
    "bullet",
  ]);
});

// Every edit rebuilt the navigator: each row and its thumbnail were made
// anew, and the browser decoded every picture again, so a nudge on a long
// deck lagged behind the key. Rows are kept and brought up to date instead.
test("an edit keeps the other slides' thumbnails as they are", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() => {
    document
      .querySelectorAll("#slide-list img")
      .forEach((img, i) => (img.dataset.kept = String(i)));
  });
  const title = page.locator('[data-object="1"]');
  await title.click();
  await page.keyboard.press("ArrowRight");
  await expect(title).toHaveAttribute("style", /left: 6\.075%/);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll("#slide-list img")].map(
        (img) => img.dataset.kept,
      ),
    ),
  ).toEqual(["0", "1", "2", "3", "4"]);
  // The rows still act for the slides they show after the deck changes
  // under them: an undo replaces the whole presentation.
  await page.keyboard.press("Control+z");
  await expect(title).toHaveAttribute("style", /left: 6%;/);
  await page.locator(".slide-thumb").nth(2).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 3 of 5");
  await page.getByRole("button", { name: "Options for slide 3" }).click();
  await page.getByRole("menuitem", { name: "Hide slide", exact: true }).click();
  await expect(page.locator(".slide-item.hidden-slide")).toHaveCount(1);
  await page.getByRole("button", { name: "Options for slide 3" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Show slide", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".slide-item.hidden-slide")).toHaveCount(0);
  await page.getByRole("button", { name: "Options for slide 3" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Hide slide", exact: true }),
  ).toBeVisible();
});

// A file whose group shared an id with one of its children had every lookup
// by id find the group, so pressing the child selected the group and Delete
// on it took the group; duplicates take fresh ids as the file opens.
test("shapes that share an id in a file are told apart", async ({ page }) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const rect = (x) =>
    P.addSlideShape(slide, {
      x: P.inches(x),
      y: P.inches(1),
      w: P.inches(1),
      h: P.inches(1),
      preset: "rect",
    });
  const [first, second] = [rect(1), rect(3)];
  rect(6);
  const group = P.groupShapes([first, second]);
  const element = group[Symbol.for("@office-kit/pptx.shape.element")];
  element.children
    .find((c) => c.name?.localName === "nvGrpSpPr")
    .children.find((c) => c.name?.localName === "cNvPr")
    .attrs.find((a) => a.name.localName === "id").value = String(
    P.getShapeId(first),
  );
  P.renameShape(group, "Twins");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Twins.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hits = page.locator(".object-hit");
  await expect(hits).toHaveCount(4);
  const ids = await hits.evaluateAll((nodes) =>
    nodes.map((node) => node.dataset.shapeId),
  );
  expect(new Set(ids).size).toBe(4);
  // The first child, the one that shared the group's id, is its own object.
  const child = hits.nth(1);
  await expect(child).toHaveAccessibleName(/^Rectangle/);
  await child.click();
  await expect(page.locator(".object-hit.selected")).toHaveAccessibleName(
    /^Rectangle/,
  );
  await page.keyboard.press("Delete");
  await expect(hits).toHaveCount(3);
  await expect(hits.first()).toHaveAccessibleName(/^Twins/);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const saved = P.getSlideShapes(P.getSlides(loaded)[0]).map(P.getShapeId);
  expect(new Set(saved).size).toBe(saved.length);
});

// Downloading every slide as PNG images drew them one by one with nothing on
// screen until the ZIP was offered.
test("downloading every slide as images says so while they are drawn", async ({
  page,
}) => {
  await story(page);
  await page.evaluate(() => {
    window.__toasts = [];
    const node = document.querySelector("#toast");
    new MutationObserver(() => window.__toasts.push(node.textContent)).observe(
      node,
      { childList: true, characterData: true, subtree: true },
    );
  });
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download as images", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "All slides as PNG (ZIP)", exact: true })
    .click();
  expect((await (await downloaded).path()) ?? "").not.toBe("");
  await expect(page.locator("#toast")).toHaveText(
    "5 slides downloaded as PNG images.",
  );
  expect(await page.evaluate(() => window.__toasts)).toEqual([
    "Preparing 5 slides as PNG images…",
    "5 slides downloaded as PNG images.",
  ]);
});

// A web address followed while presenting told the site which page it was
// opened from.
test("a web link followed while presenting withholds the referrer", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').click();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Add link" });
  await dialog.getByRole("textbox", { name: "Web address" }).fill("puter.com");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const link = page
    .getByRole("dialog", { name: "Presentation mode" })
    .getByRole("link", { name: "Open https://puter.com" });
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("target", "_blank");
});

// The font and size boxes show an imported value that is not on their lists,
// and the next object's value replaces it.
test("the ribbon's font and size boxes show an imported value", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("story");
  const shapes = P.getSlideShapes(P.getSlides(pres)[0]);
  P.setShapeTextFormat(shapes[1], { font: "Aptos Display", size: 11.5 });
  P.setShapeTextFormat(shapes[2], { font: "Bahnschrift", size: 9.5 });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Custom text.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".document-title")).toHaveText("Custom text");
  const size = ribbonControl(page, "font-size");
  const font = ribbonControl(page, "font-name");
  await page.locator('[data-object="1"]').click();
  await expect(size).toHaveValue("11.5");
  await expect(font).toHaveValue("Aptos Display");
  await page.locator('[data-object="2"]').click();
  await expect(size).toHaveValue("9.5");
  await expect(font).toHaveValue("Bahnschrift");
  // The size list keeps to its own steps, in order.
  await ribbonButton(page, "Home", "font-size");
  await page
    .getByRole("button", { name: "Font Size list" })
    .filter({ visible: true })
    .click();
  const sizes = await page
    .getByRole("menu", { name: "Font Size" })
    .getByRole("menuitemcheckbox")
    .allTextContents();
  expect(sizes.map(Number)).toEqual(
    [...sizes.map(Number)].sort((a, b) => a - b),
  );
  expect(sizes).not.toContain("9.5");
  await page.keyboard.press("Escape");
});

// Tab from a cell a merge reaches across landed on the cell the merge hides,
// which is the merged cell itself, so the key never left the first cell.
test("Tab steps past the cells a merge covers", async ({ page }) => {
  await start(page);
  const pres = createDeck("blank");
  const table = P.addSlideTable(P.getSlides(pres)[0], {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(6),
    h: P.inches(1),
    rows: [
      ["a", "hidden"],
      ["c", "d"],
    ],
  });
  P.mergeTableCells(table, { row: 0, col: 0, rowSpan: 1, colSpan: 2 });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Merged.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const cell = page.getByRole("textbox", { name: /^Edit cell/ });
  await page.locator(".object-hit").dblclick();
  await expect(cell).toHaveAccessibleName("Edit cell, row 1, column 1");
  await page.keyboard.press("Tab");
  await expect(cell).toHaveAccessibleName("Edit cell, row 2, column 1");
  await page.keyboard.press("Tab");
  await expect(cell).toHaveAccessibleName("Edit cell, row 2, column 2");
  // Back the same way, and the last step leaves the table's last cell.
  await page.keyboard.press("Shift+Tab");
  await expect(cell).toHaveAccessibleName("Edit cell, row 2, column 1");
  await page.keyboard.press("Shift+Tab");
  await expect(cell).toHaveAccessibleName("Edit cell, row 1, column 1");
  await page.keyboard.press("Shift+Tab");
  await expect(cell).toHaveCount(0);
});

// The panel's Apply to all slides passed the placeholder the panel shows for
// an imported transition to the library, which reported an unknown effect
// and left every slide as it was.
test("applying to all slides is unavailable for an imported transition", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  P.addBlankSlide(pres);
  P.setSlideTransition(P.getSlides(pres)[0], { effect: "wipe", speed: "med" });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Wiped.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator("#slide-count")).toHaveText("2");
  await inspector(page);
  const transition = panel(page).getByRole("combobox", { name: "Transition" });
  const applyAll = panel(page).getByRole("button", {
    name: "Apply to all slides",
  });
  await expect(transition).toHaveValue("other");
  await expect(applyAll).toBeDisabled();
  // One of the transitions on offer applies to every slide as before.
  await transition.selectOption("fade");
  await expect(applyAll).toBeEnabled();
  await applyAll.click();
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(
    P.getSlides(loaded).map((s) => P.getSlideTransition(s)?.effect),
  ).toEqual(["fade", "fade"]);
});

// A menu keeps the canvas text editor open while it is used, so work started
// from one read the presentation without the text still being typed: the
// slideshow and the downloaded file both showed the text as it was before.
test("work started from a menu includes text still being typed on the canvas", async ({
  page,
}) => {
  await story(page);
  const input = page.getByRole("textbox", { name: "Edit text", exact: true });
  await page.locator('[data-object="1"]').dblclick();
  await input.fill("Typed before presenting");
  await openBarMenu(page, "View");
  await page.getByRole("menuitem", { name: "Present", exact: true }).click();
  const show = page.getByRole("dialog", { name: "Presentation mode" });
  await expect(show.locator("img.presenter-slide").first()).toHaveAttribute(
    "alt",
    /Typed before presenting/,
  );
  await show.getByRole("button", { name: "Exit", exact: true }).click();
  await page.locator('[data-object="1"]').dblclick();
  await input.fill("Typed before downloading");
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(P.getSlideText(P.getSlides(loaded)[0])).toContain(
    "Typed before downloading",
  );
});

// A merged cell is drawn across every column and row the merge covers, but
// the editor and the current-cell marker took only the first of them, so
// typing in a merged cell happened in a box a fraction of its width.
test("a merged cell is edited across the whole of it", async ({ page }) => {
  await start(page);
  const pres = createDeck("blank");
  const table = P.addSlideTable(P.getSlides(pres)[0], {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(6),
    h: P.inches(2),
    rows: [
      ["a", "hidden"],
      ["c", "d"],
    ],
  });
  P.mergeTableCells(table, { row: 0, col: 0, rowSpan: 1, colSpan: 2 });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Merged.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hit = page.locator(".object-hit");
  await expect(hit).toHaveAccessibleName(/^Table/);
  const box = await hit.boundingBox();
  await hit.dblclick({
    position: { x: box.width * 0.25, y: box.height * 0.25 },
  });
  const cell = page.getByRole("textbox", {
    name: "Edit cell, row 1, column 1",
  });
  const editor = await cell.boundingBox();
  // The merged cell spans both columns and the first of the two rows.
  expect(editor.width / box.width).toBeGreaterThan(0.9);
  expect(editor.height / box.height).toBeLessThan(0.6);
  const marker = await page.locator(".cell-focus").boundingBox();
  expect(marker.width / box.width).toBeGreaterThan(0.9);
  expect(marker.height / box.height).toBeLessThan(0.6);
  // A cell no merge reaches keeps its own column.
  await page.keyboard.press("Escape");
  await hit.dblclick({
    position: { x: box.width * 0.25, y: box.height * 0.75 },
  });
  const plain = await page
    .getByRole("textbox", { name: "Edit cell, row 2, column 1" })
    .boundingBox();
  expect(plain.width / box.width).toBeLessThan(0.6);
});

// A table's text lives in its cells rather than in a text body, so a slide
// holding one read as blank on the canvas, in the navigator, and to anyone
// listening to the slideshow.
test("a slide's description covers the text in its tables", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await menuCommand(page, "Insert", "Table");
  const dialog = page.getByRole("dialog", { name: "Insert table" });
  await dialog.getByRole("spinbutton", { name: "Rows" }).fill("2");
  await dialog.getByRole("spinbutton", { name: "Columns" }).fill("2");
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  const table = page.locator(".object-hit");
  const box = await table.boundingBox();
  await table.dblclick({ position: { x: box.width / 4, y: box.height / 4 } });
  const editor = page.getByRole("textbox", { name: /^Edit cell/ });
  for (const value of ["Region", "Sales", "North"]) {
    await editor.fill(value);
    await editor.press("Tab");
  }
  await editor.fill("120");
  await editor.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "alt",
    /Region, Sales\nNorth, 120/,
  );
  await expect(page.locator(".slide-thumb")).toHaveAttribute(
    "aria-label",
    /Region, Sales/,
  );
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Presentation mode" })
      .locator("img.presenter-slide")
      .first(),
  ).toHaveAttribute("alt", /North, 120/);
});

// A table, a chart, and a group carry neither a geometry nor a text body to
// be named by, so the slide's object list drew a plain square for each.
test("the slide's object list gives each kind of object its own icon", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const box = (y) => ({
    x: P.inches(0.5),
    y: P.inches(y),
    w: P.inches(2),
    h: P.inches(1),
  });
  P.renameShape(
    P.addSlideShape(slide, { ...box(0.5), preset: "rect" }),
    "Rectangle 96",
  );
  P.renameShape(
    P.groupShapes([
      P.addSlideShape(slide, { ...box(2), preset: "rect" }),
      P.addSlideShape(slide, { ...box(3), preset: "rect" }),
    ]),
    "Group 99",
  );
  P.renameShape(
    P.addSlideTable(slide, { ...box(4), rows: [["a", "b"]] }),
    "Table 98",
  );
  P.renameShape(
    P.addSlideChart(slide, {
      ...box(5),
      spec: {
        kind: "column",
        categories: ["A"],
        series: [{ name: "Revenue", values: [10] }],
      },
    }),
    "Chart 97",
  );
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Kinds.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".document-title")).toHaveText("Kinds");
  await inspector(page);
  const drawing = (locator) =>
    locator
      .locator("svg")
      .first()
      .evaluate((node) => node.innerHTML);
  const row = (name) =>
    drawing(panel(page).getByRole("button", { name, exact: true }));
  const square = await row("Rectangle 96");
  const table = await row("Table 98");
  expect(square).not.toBe("");
  // Each kind is told apart from the others.
  expect(
    new Set([square, table, await row("Chart 97"), await row("Group 99")]).size,
  ).toBe(4);
});

// The count of wheel movement carried across a change of direction, so a
// small turn one way had to be undone before a turn the other way told, and
// a trackpad pinch that wavered stalled.
test("a wheel turned the other way zooms without undoing the turn before it", async ({
  page,
}) => {
  await story(page);
  const canvas = page.locator("#slide-canvas");
  const width = async () => Math.round((await canvas.boundingBox()).width);
  const level = page.getByRole("button", { name: "Zoom level" });
  const fitWidth = await width();
  const wheel = (deltaY) =>
    page.evaluate((deltaY) => {
      document.querySelector("#canvas-area").dispatchEvent(
        new WheelEvent("wheel", {
          deltaY,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, deltaY);
  // Most of a notch out leaves the zoom where it was.
  await wheel(30);
  await expect(
    page.getByRole("button", { name: "Fit slide to current window" }),
  ).toHaveAttribute("aria-pressed", "true");
  // A whole notch the other way then zooms in, rather than being spent
  // undoing the movement before it.
  await wheel(-20);
  await wheel(-20);
  await expect(level).toHaveText(/^\d+%$/);
  await expect.poll(width).toBeGreaterThan(fitWidth);
});

// The skip link's fragment replaced the address of the screen it was used
// on, so a reload, or a link shared from there, opened a new presentation
// instead of the library.
test("the skip link leaves the screen's own address in place", async ({
  page,
  baseURL,
}) => {
  await start(page);
  await page.locator(".skip-link").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  await expect.poll(() => new URL(page.url()).hash).toBe("#/home");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  // The editor's address carries no fragment of its own.
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  await page.locator(".skip-link").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  await expect.poll(() => page.url()).toBe(new URL("/", baseURL).href);
});

// The format panel and the right-click menu leave a link out for a group and
// for a graphic frame, but the Insert menu and the shortcut offered one, so
// the link went into the file with nothing in the editor to show or remove.
test("a group and a table are not offered a link", async ({ page }) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const box = (y) => ({
    x: P.inches(0.5),
    y: P.inches(y),
    w: P.inches(2),
    h: P.inches(1),
  });
  P.renameShape(
    P.addSlideShape(slide, { ...box(0.5), preset: "rect" }),
    "Rectangle 96",
  );
  P.renameShape(
    P.groupShapes([
      P.addSlideShape(slide, { ...box(2), preset: "rect" }),
      P.addSlideShape(slide, { ...box(3.5), preset: "rect" }),
    ]),
    "Group 99",
  );
  P.renameShape(
    P.addSlideTable(slide, { ...box(5), rows: [["a", "b"]] }),
    "Table 98",
  );
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Linkable.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".document-title")).toHaveText("Linkable");
  await inspector(page);
  await panel(page)
    .getByRole("button", { name: "Group 99", exact: true })
    .click();
  await expect(panel(page).getByText("No link")).toHaveCount(0);
  await openBarMenu(page, "Insert");
  await expect(
    page.getByRole("menuitem", { name: "Link", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Add link" })).toHaveCount(0);
  const close = panel(page).getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await page
    .getByRole("button", { name: "Table 98. Select to edit" })
    .click({ force: true });
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Add link" })).toHaveCount(0);
  // An ordinary shape still takes one.
  await page
    .getByRole("button", { name: "Rectangle 96. Select to edit" })
    .click({ force: true });
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Add link" })).toBeVisible();
});

// The running search and the table cell last edited belonged to the
// presentation they were set in. Opening another kept them, so its objects
// were marked as matches of a search that was no longer running, and its
// tables opened on a cell nobody had chosen.
test("a presentation opens without the last one's search or current cell", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  text(slide, "Chapter one", 1, 0.3, 6, 0.5);
  P.renameShape(
    P.addSlideTable(slide, {
      x: P.inches(1),
      y: P.inches(1.2),
      w: P.inches(6),
      h: P.inches(2),
      rows: [
        ["one", "two"],
        ["three", "four"],
      ],
    }),
    "Table 98",
  );
  const file = {
    name: "Twice.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  };
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (await chooser).setFiles(file);
  await expect(page.locator(".document-title")).toHaveText("Twice");
  await page.keyboard.press("Control+f");
  await page
    .getByRole("searchbox", { name: "Find", exact: true })
    .fill("Chapter");
  await expect(page.locator(".object-hit.match")).toHaveCount(1);
  const table = page.getByRole("button", { name: "Table 98. Select to edit" });
  const box = await table.boundingBox();
  await table.dblclick({
    position: { x: box.width * 0.25, y: box.height * 0.75 },
  });
  const cell = page.getByRole("textbox", { name: /^Edit cell/ });
  await expect(cell).toHaveAccessibleName("Edit cell, row 2, column 1");
  await cell.press("Control+Enter");
  await expect(cell).toHaveCount(0);
  // The same file again, as a presentation of its own.
  const again = page.waitForEvent("filechooser");
  await openFileMenu(page);
  await page
    .getByRole("menuitem", { name: "Import PPTX", exact: true })
    .click();
  await (await again).setFiles(file);
  await expect(page.locator("#toast")).toContainText("Imported.");
  await expect(page.locator(".object-hit.match")).toHaveCount(0);
  await table.click();
  await inspector(page);
  await expect(panel(page).locator(".helper").first()).toContainText(
    "Row 1, column 1 is current",
  );
});

// A drag clamped the object under the pointer to the slide and let the rest
// of the selection past its edge, where nothing is drawn. The arrow keys
// already move a selection as one.
test("dragging several objects stops them all at the slide's edge", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const bar = (x, name) =>
    P.renameShape(
      P.addSlideShape(slide, {
        x: P.inches(x),
        y: P.inches(2),
        w: P.inches(2),
        h: P.inches(1),
        preset: "rect",
      }),
      name,
    );
  bar(1, "Left 90");
  bar(9, "Right 91");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Pair.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".document-title")).toHaveText("Pair");
  const left = page.getByRole("button", { name: "Left 90. Select to edit" });
  await left.click();
  await page
    .getByRole("button", { name: "Right 91. Select to edit" })
    .click({ modifiers: ["Shift"] });
  await expect(page.locator(".object-hit.selected")).toHaveCount(2);
  const grip = await left.boundingBox();
  const canvas = await page.locator("#slide-canvas").boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width - 4, grip.y + grip.height / 2, {
    steps: 20,
  });
  await page.mouse.up();
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const saved = P.getSlideShapes(P.getSlides(loaded)[0]);
  const bounds = Object.fromEntries(
    saved.map((s) => [P.getShapeName(s), P.getShapeBounds(s)]),
  );
  const width = P.getSlideSize(loaded).width;
  // They moved, they kept the eight inches between them, and the trailing
  // one came to rest on the slide's edge rather than beyond it.
  expect(bounds["Left 90"].x).toBeGreaterThan(P.inches(1));
  expect(bounds["Right 91"].x - bounds["Left 90"].x).toBe(P.inches(8));
  expect(bounds["Right 91"].x + bounds["Right 91"].w).toBeLessThanOrEqual(
    width,
  );
});

// An edit shows before its draft is written, but undo and redo waited for
// the write first, so taking a step back lagged behind making one.
test("the slide shows an undo before the draft is written", async ({
  page,
}) => {
  await story(page);
  const title = page.locator('[data-object="1"]');
  await title.click();
  const before = await title.getAttribute("style");
  await page.keyboard.press("ArrowRight");
  await expect(title).not.toHaveAttribute("style", before);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  // The next draft write is held open.
  await page.evaluate(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      indexedDB.open = open;
      const request = open(...args);
      Object.defineProperty(request, "onsuccess", {
        set(callback) {
          request.addEventListener(
            "success",
            (event) => {
              window.__releaseDraft = () => callback(event);
            },
            { once: true },
          );
        },
      });
      return request;
    };
  });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForFunction(() => window.__releaseDraft);
  await expect(title).toHaveAttribute("style", before);
  await page.evaluate(() => window.__releaseDraft());
  await expect(
    page.getByRole("button", { name: "Redo", exact: true }),
  ).toBeEnabled();
});

// Selecting a group and one of its children asked for the same object
// twice: duplicating and pasting left a stray copy of the child beside the
// group's own, and lining them up moved the child out of its group. A drag
// already leaves a carried object to its group.
test("an object its selected group carries is left to the group", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const child = (x, name) => {
    const shape = P.addSlideShape(slide, {
      x: P.inches(x),
      y: P.inches(1),
      w: P.inches(2),
      h: P.inches(1),
      preset: "rect",
    });
    P.renameShape(shape, name);
    return shape;
  };
  P.renameShape(
    P.groupShapes([child(1, "Child A"), child(4, "Child B")]),
    "Group 99",
  );
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Carried.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".document-title")).toHaveText("Carried");
  await inspector(page);
  await panel(page)
    .getByRole("button", { name: "Group 99", exact: true })
    .click();
  const close = panel(page).getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  const pick = async () => {
    await page
      .getByRole("button", { name: "Child A. Select to edit" })
      .click({ modifiers: ["Shift"] });
    await expect(page.locator(".object-hit.selected")).toHaveCount(2);
  };
  await pick();
  await page.keyboard.press("Control+d");
  await expect(page.locator(".object-hit")).toHaveCount(6);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".object-hit")).toHaveCount(3);
  // The group moves to the slide's edge; the child stays where it sits in it.
  await page
    .getByRole("button", { name: "Group 99. Select to edit" })
    .click({ force: true });
  await pick();
  await inspector(page);
  await panel(page)
    .getByRole("button", { name: "Left edges", exact: true })
    .click();
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  const saved = P.getSlideShapes(P.getSlides(loaded)[0]);
  expect(saved.map((s) => P.getShapeName(s))).toEqual([
    "Group 99",
    "Child A",
    "Child B",
  ]);
  const at = (name) =>
    P.getShapeBounds(saved.find((s) => P.getShapeName(s) === name)).x;
  expect(at("Group 99")).toBe(0);
  expect(at("Child B") - at("Child A")).toBe(P.inches(3));
});

// A sign-in tried while the first account lookup was still out takes the
// account over, and one that came to nothing left the library on its
// loading message with nothing but a reload to get past it.
test("a sign-in that comes to nothing still lets the library load", async ({
  page,
}) => {
  await mockPuter(page, { delayAuth: true });
  await page.goto("/#/home");
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  await page.evaluate(() => {
    puter.auth.signIn = () =>
      Promise.reject({ error: "auth_window_closed", msg: "closed" });
  });
  await page
    .getByRole("button", { name: "Connect Puter", exact: true })
    .click();
  await page.evaluate(() => window.__releaseAuth());
  await expect(page.locator(".library")).not.toContainText("Loading", {
    timeout: 15000,
  });
  await expect(page.locator(".library")).toContainText(
    "Your next story starts here",
  );
  await expect(
    page.getByRole("button", { name: "Connect Puter", exact: true }),
  ).toBeVisible();
});

// Native chart dependency graphs travel with cut/copy selections.
test("a chart travels with cut and mixed selections", async ({ page }) => {
  await start(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  P.renameShape(
    P.addSlideShape(slide, {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(2),
      h: P.inches(1),
      preset: "rect",
    }),
    "Rectangle 96",
  );
  P.renameShape(
    P.addSlideChart(slide, {
      x: P.inches(1),
      y: P.inches(3),
      w: P.inches(4),
      h: P.inches(2),
      spec: {
        kind: "column",
        categories: ["A"],
        series: [{ name: "Revenue", values: [10] }],
      },
    }),
    "Chart 97",
  );
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Charted.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".object-hit")).toHaveCount(2);
  const chart = page.getByRole("button", { name: "Chart 97. Select to edit" });
  // Cutting the chart alone retains its native data for the next paste.
  await chart.click({ force: true });
  await page.keyboard.press("Control+x");
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(2);
  // Both the chart and the ordinary object are copied together.
  await page
    .getByRole("button", { name: "Rectangle 96. Select to edit" })
    .click();
  await chart.click({ force: true, modifiers: ["Shift"] });
  await expect(page.locator(".object-hit.selected")).toHaveCount(2);
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(4);
});

// A label cut at its length limit could land between the two halves of one
// character, as an emoji is written, and the half left behind showed as a
// replacement glyph.
test("a long object label is not cut through a character", async ({ page }) => {
  await start(page);
  const pres = createDeck("blank");
  // No spaces to fall back on, and a character straddling the cut.
  text(P.getSlides(pres)[0], `a${"🎉".repeat(60)}`, 1, 1, 6, 2, 18);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Long.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".document-title")).toHaveText("Long");
  await inspector(page);
  const label = await panel(page)
    .locator(".object-list-item span")
    .first()
    .textContent();
  expect(label.endsWith("…")).toBe(true);
  expect(label.isWellFormed()).toBe(true);
});

// A slide action reads the slides as they stand, and a menu keeps the canvas
// text editor open while it is used, so duplicating the slide being typed on
// copied the text it had before and the typing turned up on the original
// afterwards.
test("duplicating the slide being typed on copies the text", async ({
  page,
}) => {
  await story(page);
  await page.locator('[data-object="1"]').dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await editor.fill("Typed then duplicated");
  await openBarMenu(page, "Slide");
  await page
    .getByRole("menuitem", { name: "Duplicate slide", exact: true })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 6");
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "alt",
    /Typed then duplicated/,
  );
  // The slide it was copied from keeps it too.
  await page.locator(".slide-thumb").first().click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 6");
  await expect(page.locator(".slide-image")).toHaveAttribute(
    "alt",
    /Typed then duplicated/,
  );
});

// The toolbar and the menus keep the canvas text editor open while they are
// used, so inserting an object left the editor standing over the slide
// beside the new one with its text still uncommitted, and a copy made that
// way carried the text from before the typing.
test("inserting and copying commit the text open on the canvas", async ({
  page,
}) => {
  await story(page);
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  const alt = () => page.locator(".slide-image").getAttribute("alt");
  await page.locator('[data-object="1"]').dblclick();
  await editor.fill("Typed then inserted");
  await addText(page);
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".object-hit")).toHaveCount(8);
  await expect.poll(alt).toContain("Typed then inserted");
  // A copy made while typing carries what was typed, not what was there.
  await page.locator('[data-object="1"]').dblclick();
  await editor.fill("Typed then copied");
  await openBarMenu(page, "Edit");
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".object-hit")).toHaveCount(9);
  await expect
    .poll(async () => (await alt()).match(/Typed then copied/g)?.length)
    .toBe(2);
  // Deleting while typing takes the editor with the object; the copy lies
  // over the original, so it is the one to type in.
  await page.locator('[data-object="8"]').dblclick();
  await editor.fill("Typed then deleted");
  await openBarMenu(page, "Edit");
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".object-hit")).toHaveCount(8);
});

for (const shapeKind of ["picture", "shape"]) {
  test(`inherited geometry clips ${shapeKind} images and survives clipboard and .pptx export`, async ({
    page,
  }) => {
    await start(page);
    const bytes = await createGeometryDeck({
      shapeKind,
      geometry: holeGeometry,
    });
    const file = {
      name: "Picture geometry.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from(bytes),
    };
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (await chooser).setFiles(file);
    const objects = page.locator(".object-hit"),
      image = page.locator(".slide-image");
    await expect(objects).toHaveCount(1);
    const inspectPixels = async () =>
      image.evaluate(async (img) => {
        await img.decode();
        const svg = new DOMParser().parseFromString(
          decodeURIComponent(img.src.split(",").slice(1).join(",")),
          "image/svg+xml",
        );
        const viewBox = svg.documentElement
          .getAttribute("viewBox")
          .split(/\s+/)
          .map(Number);
        const canvas = document.createElement("canvas");
        canvas.width = viewBox[2];
        canvas.height = viewBox[3];
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const pixel = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
        return {
          background: pixel(20, 20),
          hole: pixel(288, 192),
          rim: pixel(110, 110),
        };
      });
    const imported = await inspectPixels();
    // Confirmed in native output with same-winding nested contours: the
    // inner contour is a hole. SVG's default nonzero clipping fills it in.
    expect(imported.hole).toEqual(imported.background);
    expect(imported.rim).not.toEqual(imported.background);
    await objects.click();
    await page.keyboard.press("Control+c");
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await expect(objects).toHaveCount(0);
    await page.keyboard.press("Control+v");
    await expect(objects).toHaveCount(1);
    const pasted = await inspectPixels();
    expect(pasted.hole).toEqual(pasted.background);
    expect(pasted.rim).toEqual(imported.rim);
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const pres = await parseDeck(
      new Uint8Array(await readFile(await (await downloaded).path())),
    );
    const shape = P.getSlideShapes(P.getSlides(pres)[0])[0];
    expect(
      P.getShapeCustomGeometry(shape).paths[0].commands.filter(
        (c) => c.kind === "close",
      ),
    ).toHaveLength(2);
    expect(P.getShapeGeometryEffective(pres, shape).kind).toBe("custom");
  });
}

test("slide-number fields follow reordering, duplication, undo and clipboard without becoming literal text", async ({
  page,
}) => {
  await start(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Numbered deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await createNumberedDeck()),
  });
  const imageText = (image) =>
    image.evaluate(
      (img) =>
        new DOMParser().parseFromString(
          decodeURIComponent(img.src.split(",").slice(1).join(",")),
          "image/svg+xml",
        ).documentElement.textContent,
    );
  const canvas = page.locator(".slide-image");
  await expect
    .poll(() => imageText(canvas))
    .toContain("Number: 40 / literal 999");
  await page
    .getByRole("button", { name: "Options for slide 1", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Move down", exact: true }).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 2");
  await expect
    .poll(() => imageText(canvas))
    .toContain("Number: 41 / literal 999");
  const thumbs = page.locator("#slide-list .slide-thumb img");
  await expect
    .poll(() => imageText(thumbs.nth(0)))
    .toContain("Number: 40 / literal 999");
  await expect
    .poll(() => imageText(thumbs.nth(1)))
    .toContain("Number: 41 / literal 999");
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => imageText(canvas))
    .toContain("Number: 40 / literal 999");
  await page
    .getByRole("button", { name: "Options for slide 1", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Duplicate slide", exact: true })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 3");
  await expect
    .poll(() => imageText(canvas))
    .toContain("Number: 41 / literal 999");
  await expect
    .poll(() => imageText(thumbs.nth(2)))
    .toContain("Number: 42 / literal 999");
  const field = page.locator('[data-object="1"]');
  await expect(field).toHaveAttribute(
    "aria-label",
    "Number: 41 / literal 999. Select to edit",
  );
  await expect(canvas).toHaveAttribute("alt", /Number: 41 \/ literal 999/);
  await field.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toContainText("Number: 41 / literal 999");
  await editor.press("ArrowLeft");
  await page.keyboard.type("Edited ");
  await editor.press("Control+Enter");
  await expect
    .poll(() => imageText(canvas))
    .toContain("Edited Number: 41 / literal 999");
  await openFileMenu(page);
  const download = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const saved = await parseDeck(
    new Uint8Array(await readFile(await (await download).path())),
  );
  const savedSlide = P.getSlides(saved)[1];
  expect(P.getSlideNumber(saved, savedSlide)).toBe(41);
  expect(P.getShapeXmlString(P.getSlideShapes(savedSlide)[1])).toContain(
    'type="slidenum"',
  );
  await field.click();
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.keyboard.press("Control+v");
  await expect
    .poll(() => imageText(canvas))
    .toContain("Edited Number: 1 / literal 999");
});

test("package-root slide relationships survive move, undo, duplication, deletion and export", async ({
  page,
}) => {
  await start(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Absolute slide targets.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await createSlideRelationshipDeck()),
  });
  const canvas = page.locator(".slide-image");
  const action = async (n, name) => {
    await page
      .getByRole("button", { name: `Options for slide ${n}`, exact: true })
      .click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  await expect(canvas).toHaveAttribute("alt", /Page A/);
  await action(1, "Move down");
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 3");
  await expect(canvas).toHaveAttribute("alt", /Page A/);
  await page.keyboard.press("Control+z");
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 3");
  await action(1, "Duplicate slide");
  await expect(page.locator("#slide-count")).toHaveText("4");
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 4");
  await action(1, "Delete slide");
  await expect(page.locator("#slide-count")).toHaveText("3");
  await expect(canvas).toHaveAttribute("alt", /Page A/);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await downloaded).path())),
  );
  expect(
    P.getSlides(loaded).map((s) => P.getShapeText(P.getSlideShapes(s)[0])),
  ).toEqual(["Page A", "Page B", "Page C"]);
  expect(P.getSlideNumber(loaded, P.getSlides(loaded)[2])).toBe(9);
});

test("automatic dates share a snapshot through editing and undo and refresh for presenting and printing", async ({
  page,
}) => {
  await start(page);
  const setDate = async (year) =>
    page.clock.setFixedTime(
      new Date(
        await page.evaluate((y) => new Date(y, 1, 28, 0, 5, 6).getTime(), year),
      ),
    );
  await setDate(2024);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Automatic dates.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await createDateDeck({ type: "datetime9" })),
  });
  const imageText = (image) =>
    image.evaluate(
      (img) =>
        new DOMParser().parseFromString(
          decodeURIComponent(img.src.split(",").slice(1).join(",")),
          "image/svg+xml",
        ).documentElement.textContent,
    );
  const canvas = page.locator(".slide-image"),
    field = page.locator('[data-object="1"]');
  await expect
    .poll(() => imageText(canvas))
    .toContain("Date: 2/28/24 12:05:06 AM / literal 999");
  await expect(field).toHaveAttribute(
    "aria-label",
    "Date: 2/28/24 12:05:06 AM / literal 999. Select to edit",
  );
  await setDate(2030);
  await field.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toContainText("2/28/24 12:05:06 AM");
  await editor.press("ArrowLeft");
  await page.keyboard.type("Edited ");
  await editor.press("Control+Enter");
  await expect.poll(() => imageText(canvas)).toContain("Edited Date: 2/28/24");
  await page.keyboard.press("Control+z");
  await expect.poll(() => imageText(canvas)).toContain("Date: 2/28/24");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const presenter = page.getByRole("dialog", { name: "Presentation mode" });
  await expect
    .poll(() => imageText(presenter.locator(".presenter-slide").first()))
    .toContain("Date: 2/28/30 12:05:06 AM");
  await expect(presenter.locator(".presenter-slide").first()).toHaveAttribute(
    "alt",
    /2\/28\/30/,
  );
  await page.keyboard.press("Escape");
  await expect.poll(() => imageText(canvas)).toContain("Date: 2/28/30");
  await expect
    .poll(() => imageText(page.locator("#slide-list .slide-thumb img").first()))
    .toContain("Date: 2/28/30");
  await setDate(2040);
  await page.evaluate(() => {
    window.print = () => {
      window.__datePrint = [
        ...document.querySelectorAll("#print-slides img"),
      ].map((img) => ({ src: img.src, alt: img.alt }));
    };
  });
  await printFromMenu(page);
  await expect
    .poll(() => page.evaluate(() => window.__datePrint?.length))
    .toBe(2);
  const printed = await page.evaluate(() => window.__datePrint);
  for (const item of printed) {
    expect(decodeURIComponent(item.src)).toContain("2/28/40 12:05:06 AM");
    expect(item.alt).toContain("2/28/40");
  }
  await expect.poll(() => imageText(canvas)).toContain("Date: 2/28/40");
  await openFileMenu(page);
  const download = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const saved = await parseDeck(
    new Uint8Array(await readFile(await (await download).path())),
  );
  const savedShape = P.getSlideShapes(P.getSlides(saved)[0])[1];
  expect(P.getShapeXmlString(savedShape)).toContain('type="datetime9"');
  expect(P.getShapeText(savedShape)).toContain("CACHED-DATE");
  await field.click();
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.keyboard.press("Control+v");
  await expect
    .poll(() => imageText(canvas))
    .toContain("Date: 2/28/40 12:05:06 AM");
});

test("table date fields show the inherited language in cell editing without rewriting the field", async ({
  page,
}) => {
  await start(page);
  await page.clock.setFixedTime(
    new Date(
      await page.evaluate(() => new Date(2024, 1, 29, 0, 5, 6).getTime()),
    ),
  );
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Table dates.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(
      await createDateDeck({
        table: true,
        type: "datetime5",
        language: "de-DE",
        inherited: true,
      }),
    ),
  });
  const hit = page.locator(".object-hit").last();
  await expect(page.locator(".slide-image")).toHaveAttribute("alt", /24-02-29/);
  const box = await hit.boundingBox();
  await hit.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
  const editor = page.getByRole("textbox", { name: /^Edit cell/ });
  await expect(editor).toHaveValue(/24-02-29/);
  await editor.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await openFileMenu(page);
  const download = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const saved = await parseDeck(
    new Uint8Array(await readFile(await (await download).path())),
  );
  const cell = P.getTableCell(P.getSlideTables(P.getSlides(saved)[0])[0], 0, 0);
  expect(
    P.getTableCellParagraphs(cell)[0].elements.find((e) => e.kind === "fld"),
  ).toMatchObject({ type: "datetime5", text: "CACHED-DATE" });
});

for (const table of [false, true])
  test(`adjacent plain-text edits keep a live field in ${table ? "table cells" : "the Content panel"}`, async ({
    page,
  }) => {
    await start(page);
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "Live field.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from(await createDateDeck({ table })),
    });
    const hit = page.locator(".object-hit").last();
    let input;
    if (table) {
      await hit.dblclick();
      input = page.getByRole("textbox", { name: /^Edit cell/ });
    } else {
      await hit.click();
      await inspector(page);
      input = panel(page).getByRole("textbox", { name: "Object text" });
    }
    await input.focus();
    await input.evaluate((el) => el.setSelectionRange(0, 0));
    await page.keyboard.type("Before ");
    await input.evaluate((el) =>
      el.setSelectionRange(el.value.length, el.value.length),
    );
    await page.keyboard.type(" after");
    const unchanged = await input.inputValue();
    await input.evaluate((el) => {
      const at = el.value.indexOf("Date: ") + 8;
      el.setSelectionRange(at, at);
    });
    await page.keyboard.type("X");
    await input.press("ControlOrMeta+z");
    await expect(input).toHaveValue(unchanged);
    await input.press("ControlOrMeta+Shift+z");
    await expect(input).not.toHaveValue(unchanged);
    await input.press("ControlOrMeta+z");
    await expect(input).toHaveValue(unchanged);
    await input.press(table ? "Control+Enter" : "Tab");
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const p = await parseDeck(
        new Uint8Array(await readFile(await (await downloaded).path())),
      ),
      s = P.getSlides(p)[0];
    const elements = table
      ? P.getTableCellParagraphs(
          P.getTableCell(P.getSlideTables(s)[0], 0, 0),
        )[0].elements
      : P.getShapeParagraphElements(P.getSlideShapes(s)[1], 0);
    expect(elements.filter((e) => e.kind === "fld")).toHaveLength(1);
    expect(elements.find((e) => e.kind === "fld").type).toBe("datetime1");
    expect(elements.map((e) => e.text || "").join("")).toMatch(
      /^Before Date: .* after$/,
    );
    if (table) {
      await hit.dblclick();
      input = page.getByRole("textbox", { name: /^Edit cell/ });
    } else {
      await inspector(page);
      input = panel(page).getByRole("textbox", { name: "Object text" });
    }
    await input.focus();
    await input.evaluate((el) =>
      el.setSelectionRange(
        el.value.indexOf("Date: ") + 6,
        el.value.indexOf(" / literal"),
      ),
    );
    await page.keyboard.type("fixed");
    await input.press(table ? "Control+Enter" : "Tab");
    await openFileMenu(page);
    const literalDownload = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const literal = await parseDeck(
      new Uint8Array(await readFile(await (await literalDownload).path())),
    );
    const literalSlide = P.getSlides(literal)[0];
    const literalElements = table
      ? P.getTableCellParagraphs(
          P.getTableCell(P.getSlideTables(literalSlide)[0], 0, 0),
        )[0].elements
      : P.getShapeParagraphElements(P.getSlideShapes(literalSlide)[1], 0);
    expect(literalElements.some((e) => e.kind === "fld")).toBe(false);
    expect(literalElements.map((e) => e.text || "").join("")).toBe(
      "Before Date: fixed / literal 999 after",
    );
  });

test("find and replace keeps untouched live fields in table cells", async ({
  page,
}) => {
  await start(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Field search.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await createDateDeck({ table: true })),
  });
  await expect(page.locator(".editor")).toBeVisible();
  await page.keyboard.press("Control+f");
  const bar = page.getByRole("search", { name: "Find and replace" });
  await bar.getByRole("searchbox", { name: "Find", exact: true }).fill("Date:");
  await expect(bar.locator(".find-count")).toHaveText("1 of 2");
  await bar.getByRole("textbox", { name: "Replace with" }).fill("Updated:");
  await bar.getByRole("button", { name: "Replace all", exact: true }).click();
  await expect(page.locator(".slide-image")).toHaveAttribute("alt", /Updated:/);
  await openFileMenu(page);
  const download = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const p = await parseDeck(
    new Uint8Array(await readFile(await (await download).path())),
  );
  for (const s of P.getSlides(p)) {
    const elements = P.getTableCellParagraphs(
      P.getTableCell(P.getSlideTables(s)[0], 0, 0),
    )[0].elements;
    expect(elements.find((e) => e.kind === "fld")).toMatchObject({
      type: "datetime1",
      text: "CACHED-DATE",
    });
    expect(elements.map((e) => e.text || "").join("")).toBe(
      "Updated: CACHED-DATE / literal 999",
    );
  }
});

for (const mode of ["partial", "field-only", "table", "table-field-only"])
  test(`character formatting preserves live fields: ${mode}`, async ({
    page,
  }) => {
    await start(page);
    const files = unzipSync(
      await createDateDeck({ table: mode.startsWith("table"), count: 1 }),
    );
    if (mode.endsWith("field-only")) {
      let xml = new TextDecoder().decode(files["ppt/slides/slide1.xml"]);
      xml = xml
        .replace("<a:r><a:t>Date: </a:t></a:r>", "")
        .replace("<a:r><a:t> / literal 999</a:t></a:r>", "");
      files["ppt/slides/slide1.xml"] = new TextEncoder().encode(xml);
    }
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "Field formatting.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from(zipSync(files)),
    });
    const hit = page.locator(".object-hit").last();
    if (mode === "partial") {
      await hit.dblclick();
      const editor = page.getByRole("textbox", {
        name: "Edit text",
        exact: true,
      });
      await editor.evaluate((el) => {
        const span = el.querySelector('[data-run="1"]');
        const range = document.createRange();
        range.setStart(span.firstChild, 1);
        range.setEnd(span.firstChild, 2);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await editor.press("Control+i");
      await expect(editor.locator('[data-run="1"]')).toHaveCSS(
        "font-style",
        "italic",
      );
      await editor.press("Control+z");
      await expect(editor.locator('[data-run="1"]')).toHaveCSS(
        "font-style",
        "normal",
      );
      await editor.press("Control+Shift+z");
      await expect(editor.locator('[data-run="1"]')).toHaveCSS(
        "font-style",
        "italic",
      );
      await editor.press("Control+Enter");
    } else {
      await hit.click();
      await inspector(page);
      if (mode.endsWith("field-only"))
        await expect(
          panel(page).getByRole("button", { name: "Bold", exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
      await panel(page)
        .getByRole("button", { name: "Italic", exact: true })
        .click();
    }
    await openFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const p = await parseDeck(
        new Uint8Array(await readFile(await (await downloaded).path())),
      ),
      s = P.getSlides(p)[0];
    const es = mode.startsWith("table")
      ? P.getTableCellParagraphs(
          P.getTableCell(P.getSlideTables(s)[0], 0, 0),
        )[0].elements
      : P.getShapeParagraphElements(P.getSlideShapes(s)[1], 0);
    expect(es.filter((e) => e.kind === "fld")).toHaveLength(1);
    expect(es.find((e) => e.kind === "fld")).toMatchObject({
      type: "datetime1",
      format: { bold: true, italic: true },
    });
    if (mode === "partial")
      for (const e of es.filter((e) => e.kind === "r"))
        expect(e.format?.italic).not.toBe(true);
  });

// Content growth must reach the hit grid and editor, while exported row sizes
// remain authored minimums until the user explicitly resizes the table.
test("table rows expand around edited text without changing authored minimums", async ({
  page,
}) => {
  await start(page);
  const pres = createDeck("blank"),
    s = P.getSlides(pres)[0];
  const table = P.addSlideTable(s, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(6),
    h: P.inches(0.5),
    rows: [
      ["One\nTwo\nThree", "Peer"],
      ["Last", "Peer"],
    ],
  });
  for (const row of P.getTableCells(table))
    for (const cell of row) {
      P.setTableCellTextFormat(cell, { size: 18, font: "Arial" });
      P.setTableCellMargins(cell, { left: 0, right: 0, top: 0, bottom: 0 });
    }
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Growing rows.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hit = page.locator(".object-hit");
  await expect(hit).toHaveAccessibleName(/^Table/);
  let box = await hit.boundingBox();
  expect(box.width / box.height).toBeCloseTo(5, 1);
  await hit.dblclick({
    position: { x: box.width * 0.75, y: box.height * 0.92 },
  });
  const editor = page.getByRole("textbox", {
    name: "Edit cell, row 2, column 2",
  });
  await editor.fill("Four\nFive\nSix\nSeven");
  await editor.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await expect
    .poll(async () => {
      const b = await hit.boundingBox();
      return b.width / b.height;
    })
    .toBeCloseTo(6 / 2.1, 1);
  await inspector(page);
  await expect(
    panel(page).getByRole("spinbutton", { name: "Height (in)" }),
  ).toHaveValue("2.1");
  await openFileMenu(page);
  const download = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const loaded = await parseDeck(
    new Uint8Array(await readFile(await (await download).path())),
  );
  const saved = P.getSlideShapes(P.getSlides(loaded)[0]).find(P.isTableShape);
  expect(P.getTableRowHeights(saved)).toEqual([P.inches(0.25), P.inches(0.25)]);
  expect(P.getTableCellText(P.getTableCell(saved, 1, 1))).toBe(
    "Four\nFive\nSix\nSeven",
  );
  // Explicit resizing uses the currently drawn proportions, not equal shares
  // of the two small authored row heights.
  const height = panel(page).getByRole("spinbutton", { name: "Height (in)" });
  await height.fill("4.2");
  await height.press("Enter");
  await expect(height).toHaveValue("4.2");
  await openFileMenu(page);
  const resized = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  const changed = await parseDeck(
    new Uint8Array(await readFile(await (await resized).path())),
  );
  const t = P.getSlideShapes(P.getSlides(changed)[0]).find(P.isTableShape);
  const rows = P.getTableRowHeights(t);
  expect(rows[0] / 914400).toBeCloseTo(1.8, 5);
  expect(rows[1] / 914400).toBeCloseTo(2.4, 5);
});

test("percentage paragraph spacing survives inline editing, partial spacing edits, copying and download", async ({
  page,
}) => {
  await start(page);
  const p = createDeck("blank"),
    s = P.getSlides(p)[0];
  const shape = text(s, "First\nSecond", 1, 1, 5, 3, 18);
  for (let i = 0; i < 2; i++)
    P.setParagraphSpacing(shape, i, { beforePts: 6, afterPct: 0.333 });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Percentage paragraphs.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(p)),
  });
  const objects = page.locator(".object-hit");
  await expect(objects).toHaveCount(1);
  await objects.click();
  await inspector(page);
  const before = panel(page).getByRole("spinbutton", {
    name: "Space before (pt)",
  });
  const after = panel(page).getByRole("spinbutton", {
    name: "Space after (%)",
  });
  await expect(after).toHaveValue("33.3");
  await before.fill("9");
  await before.press("Enter");
  await expect(after).toHaveValue("33.3");
  const close = page.getByRole("button", { name: "Close format panel" });
  if (await close.isVisible()) await close.click();
  await objects.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  await editor.press("ArrowLeft");
  await editor.press("X");
  await expect(editor).toContainText("XFirst");
  await expect(editor).toContainText("Second");
  await expect(editor.locator(".para").first()).not.toHaveCSS(
    "margin-bottom",
    "0px",
  );
  await inspector(page);
  await after.fill("50");
  await after.press("Enter");
  // Back to the text (closing the panel would end the edit) to finish it.
  await editor.focus();
  await editor.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await objects.click();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(2);
  await openFileMenu(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const restored = await parseDeck(
    await readFile(await (await downloaded).path()),
  );
  for (const copy of P.getSlideShapes(P.getSlides(restored)[0])) {
    expect(P.getShapeText(copy)).toBe("XFirst\nSecond");
    expect(P.getParagraphSpacing(copy, 0)).toEqual({
      beforePts: 9,
      afterPts: null,
      afterPct: 0.5,
    });
    expect(P.getParagraphSpacing(copy, 1)).toEqual({
      beforePts: 9,
      afterPts: null,
      afterPct: 0.333,
    });
  }
});

for (const [submenu, command, attribute, value] of [
  ["Align", "Align center", "style", "center"],
  ["Lists", "Bulleted list", "data-list", "bullet"],
  ["Line spacing", "Double", "style", "2.4"],
]) {
  test(`paragraph ${command} returns focus before the next keyboard action`, async ({
    page,
  }) => {
    await story(page);
    await page.getByRole("button", { name: /^Slide 4:/ }).click();
    await page.locator('[data-object="2"]').dblclick();
    const editor = page.getByRole("textbox", {
      name: "Edit text",
      exact: true,
    });
    await expect(editor).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await openBarMenu(page, "Format");
    await page.getByRole("menuitem", { name: submenu, exact: true }).click();
    // Sample the focus at the microtask checkpoint after the menu command.
    // A timer leaves a gap in which the next native key goes to its anchor.
    const focus = await page
      .getByRole("menuitemcheckbox", { name: command, exact: true })
      .evaluate(async (item) => {
        item.click();
        await Promise.resolve();
        return document.activeElement?.getAttribute("aria-label");
      });
    expect(focus).toBe("Edit text");
    await expect(editor.locator(".para").nth(0)).toHaveAttribute(
      attribute,
      new RegExp(value),
    );
    await page.keyboard.press("Control+Enter");
    await expect(editor).toHaveCount(0);
  });
}

test("panel commands update fitted canvas bounds before the next pointer action", async ({
  page,
}) => {
  await story(page);
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
  for (const [id, name] of [
    ["view-format-pane"],
    ["view-format-pane", "Close format panel"],
    ["view-thumbnails"],
    ["view-thumbnails"],
  ]) {
    let command = name && page.getByRole("button", { name, exact: true });
    if (!command || !(await command.isVisible()))
      command = await ribbonButton(page, "View", id);
    const bounds = await command.evaluate(async (button) => {
      const measure = () => {
        const { x, y, width, height } = document
          .querySelector("#slide-canvas")
          .getBoundingClientRect();
        return { x, y, width, height };
      };
      button.click();
      const immediate = measure();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return { immediate, settled: measure() };
    });
    expect(bounds.immediate).toEqual(bounds.settled);
  }
});
