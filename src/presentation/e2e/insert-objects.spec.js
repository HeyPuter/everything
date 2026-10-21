// Insert features end to end: icons, equations, video and audio (from a file
// and recorded), header and footer, zooms, action buttons, photo albums,
// embedded objects and screenshots. Each is checked on the slide, in the
// saved .pptx, and where it acts there, in the slide show.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";

test.setTimeout(120_000);

// Recording and screen capture come from generated streams: a tone for the
// microphone and a painted canvas for the screen.
async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    if (!devices) return;
    devices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const tone = ctx.createOscillator();
      const out = ctx.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      return out.stream;
    };
    devices.getDisplayMedia = async () => {
      const c = document.createElement("canvas");
      c.width = 640;
      c.height = 360;
      const g = c.getContext("2d");
      g.fillStyle = "#2255aa";
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = "#ffcc00";
      g.fillRect(100, 100, 200, 100);
      const stream = c.captureStream(10);
      setInterval(() => g.fillRect(100, 100, 200, 100), 100);
      return stream;
    };
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Insert", exact: true }).click();
}

// A ribbon command, unfolding its group first when the ribbon is narrow.
async function command(page, id) {
  const button = page.locator(`[data-command="${id}"]`).first();
  if (!(await button.isVisible())) {
    const group = await button.evaluate(
      (n) => n.closest("[data-group]").dataset.group,
    );
    await page
      .locator(`[data-group="${group}"] > .ribbon-fold`)
      .filter({ visible: true })
      .click();
  }
  await page
    .locator(`[data-command="${id}"]`)
    .filter({ visible: true })
    .first()
    .click();
}
async function commandMenu(page, id, name) {
  const button = page.locator(`[data-command="${id}"]`).first();
  if (!(await button.isVisible())) {
    const group = await button.evaluate(
      (n) => n.closest("[data-group]").dataset.group,
    );
    await page
      .locator(`[data-group="${group}"] > .ribbon-fold`)
      .filter({ visible: true })
      .click();
  }
  await page
    .getByRole("button", { name })
    .filter({ visible: true })
    .first()
    .click();
}
async function tab(page, name) {
  await page.getByRole("tab", { name, exact: true }).click();
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
  const files = unzipSync(await readFile(await (await event).path()));
  // Slides in presentation order, which can differ from their part names.
  const pres = strFromU8(files["ppt/presentation.xml"]);
  const presRels = strFromU8(files["ppt/_rels/presentation.xml.rels"]);
  const order = [...pres.matchAll(/<p:sldId [^>]*r:id="(rId\d+)"/g)].map(
    ([, id]) =>
      new RegExp(
        `Id="${id}"[^>]*Target="slides/(slide\\d+)\\.xml"|Target="slides/(slide\\d+)\\.xml"[^>]*Id="${id}"`,
      ).exec(presRels),
  );
  const part = (n) => {
    const m = order[n - 1];
    return m ? m[1] || m[2] : `slide${n}`;
  };
  const slide = (n = 1) => strFromU8(files[`ppt/slides/${part(n)}.xml`]);
  const rels = (n = 1) =>
    strFromU8(files[`ppt/slides/_rels/${part(n)}.xml.rels`]);
  return { files, slide, rels };
}

function wav(seconds = 0.5, rate = 8000) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(Math.sin(i / 3) * 8000), 44 + i * 2);
  return b;
}
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function webm(page) {
  const data = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 90;
    const g = c.getContext("2d");
    const rec = new MediaRecorder(c.captureStream(20), {
      mimeType: "video/webm",
    });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start(100);
    for (let i = 0; i < 20; i++) {
      g.fillStyle = `hsl(${i * 18},70%,50%)`;
      g.fillRect(0, 0, 160, 90);
      await new Promise((r) => setTimeout(r, 50));
    }
    rec.stop();
    await new Promise((r) => (rec.onstop = r));
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  return Buffer.from(data, "base64");
}
async function choose(page, open, files) {
  const chooser = page.waitForEvent("filechooser");
  await open();
  await (await chooser).setFiles(files);
}

test("icons are inserted as SVG pictures, restyled, and converted to shapes", async ({
  page,
}) => {
  await start(page);
  await command(page, "icons");
  const dialog = page.getByRole("dialog", { name: "Insert Icons" });
  await dialog.getByRole("searchbox", { name: "Search icons" }).fill("rocket");
  await dialog.getByRole("option", { name: "rocket", exact: true }).click();
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await expect(
    page.getByRole("tab", { name: "Graphics Format" }),
  ).toBeVisible();
  let saved = await download(page);
  expect(saved.slide()).toContain("asvg:svgBlip");
  expect(saved.slide()).toContain('descr="rocket"');
  const svg = Object.entries(saved.files).find(([n]) => n.endsWith(".svg"));
  expect(strFromU8(svg[1])).toContain('data-icon="Rocket"');

  await tab(page, "Graphics Format");
  await commandMenu(page, "graphics-outline", "Graphics Outline");
  await page.getByRole("menuitem", { name: "Red", exact: true }).click();
  await expect
    .poll(async () => {
      const { files } = await download(page);
      return Object.entries(files)
        .filter(([n]) => n.endsWith(".svg"))
        .some(([, b]) => /stroke="#FF0000"/i.test(strFromU8(b)));
    })
    .toBe(true);

  await command(page, "graphics-convert");
  await expect(page.getByRole("tab", { name: "Graphics Format" })).toBeHidden();
  saved = await download(page);
  expect(saved.slide()).toContain("<a:custGeom>");
  expect(saved.slide()).not.toContain("<p:pic>");
});

test("the Icons dialog takes one Tab for its categories and one for its icons", async ({
  page,
}) => {
  await start(page);
  await command(page, "icons");
  const dialog = page.getByRole("dialog", { name: "Insert Icons" });
  await expect(
    dialog.getByRole("searchbox", { name: "Search icons" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("tab", { name: "All" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const people = dialog.getByRole("tab", { name: "People" });
  await expect(people).toBeFocused();
  await expect(people).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  const first = dialog.getByRole("option").first();
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const second = dialog.getByRole("option").nth(1);
  await expect(second).toBeFocused();
  await page.keyboard.press("Space");
  await expect(second).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Insert", exact: true }),
  ).toBeFocused();
  // Back into the icons, at the one last reached.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(second).toBeFocused();
});

test("equations are pictures that keep their source and reopen for editing", async ({
  page,
}) => {
  await start(page);
  await command(page, "equation");
  const dialog = page.getByRole("dialog", { name: "Equation" });
  await dialog.getByRole("tab", { name: "Radical" }).click();
  await dialog.getByRole("button", { name: "Square root" }).click();
  await page.keyboard.type("x+1");
  await expect(dialog.getByLabel("Equation (TeX-style)")).toHaveValue(
    "\\sqrt{x+1}",
  );
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(1);
  let saved = await download(page);
  expect(saved.slide()).toContain('descr="Equation: \\sqrt{x+1}"');
  expect(saved.slide()).toContain("asvg:svgBlip");

  await page.locator(".object-hit").first().dblclick();
  const edit = page.getByRole("dialog", { name: "Edit Equation" });
  await expect(edit.getByLabel("Equation (TeX-style)")).toHaveValue(
    "\\sqrt{x+1}",
  );
  await edit.getByLabel("Equation (TeX-style)").fill("\\frac{a}{b}");
  await edit.getByRole("button", { name: "Update" }).click();
  await expect
    .poll(async () => (await download(page)).slide())
    .toContain("Equation: \\frac{a}{b}");
});

test("video plays on the canvas and in the slide show, with its playback settings saved", async ({
  page,
}) => {
  await start(page);
  const video = await webm(page);
  await choose(page, () => command(page, "video"), {
    name: "clip.webm",
    mimeType: "video/webm",
    buffer: video,
  });
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "Playback" })).toBeVisible();
  await page
    .locator(".media-bar")
    .getByRole("button", { name: "Play" })
    .click();
  await expect(page.locator("video.media-surface")).toHaveCount(1);
  await expect
    .poll(() =>
      page.locator("video.media-surface").evaluate((v) => v.currentTime),
    )
    .toBeGreaterThan(0);
  // A short clip ends by itself; it is stopped before moving on.
  await page.locator("video.media-surface").evaluate((v) => v.pause());

  await tab(page, "Playback");
  await command(page, "playback-loop");
  await command(page, "playback-hide");
  await command(page, "playback-trim");
  const trim = page.getByRole("dialog", { name: "Trim Video" });
  await trim.getByLabel("Start time").fill("00:00.20");
  await trim.getByLabel("Start time").press("Tab");
  await trim.getByRole("button", { name: "OK" }).click();
  await expect
    .poll(async () => (await download(page)).slide())
    .toContain('<p14:trim st="200"');
  const saved = await download(page);
  expect(saved.slide()).toMatch(/<a:videoFile r:link="rId\d+"\/>/);
  expect(saved.slide()).toContain('repeatCount="indefinite"');
  expect(saved.slide()).toContain('showWhenStopped="0"');
  expect(saved.rels()).toContain("2007/relationships/media");
  expect(Object.keys(saved.files)).toContain("ppt/media/media1.webm");

  // In the show, the first advance plays the video instead of moving on.
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presenter-counter")).toHaveText("1 / 1");
  await page.keyboard.press("Space");
  await expect(page.locator(".presenter-media.playing")).toHaveCount(1);
  await expect(page.locator(".presenter-end")).toBeHidden();
});

test("a video's bytes are let go once another presentation opens", async ({
  page,
}) => {
  await start(page);
  const video = await webm(page);
  await choose(page, () => command(page, "video"), {
    name: "clip.webm",
    mimeType: "video/webm",
    buffer: video,
  });
  await page
    .locator(".media-bar")
    .getByRole("button", { name: "Play" })
    .click();
  const src = await page
    .locator("video.media-surface")
    .evaluate((v) => (v.pause(), v.src));
  const read = (url) =>
    page.evaluate(
      (u) =>
        fetch(u).then(
          (r) => r.arrayBuffer().then((b) => b.byteLength),
          () => null,
        ),
      url,
    );
  expect(await read(src)).toBe(video.length);
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(page.locator(".object-hit")).toHaveCount(0);
  await expect.poll(() => read(src)).toBeNull();
});

test("the table picker sizes a table with the arrow keys", async ({ page }) => {
  await start(page);
  await command(page, "table");
  const label = page.locator(".table-picker-label");
  await expect(
    page.getByRole("gridcell", { name: "1 by 1 table" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("gridcell", { name: "3 by 2 table" }),
  ).toBeFocused();
  await expect(label).toHaveText("3x2 Table");
  await page.keyboard.press("Enter");
  const { slide } = await download(page);
  expect(slide().match(/<a:gridCol /g)).toHaveLength(3);
  expect(slide().match(/<a:tr /g)).toHaveLength(2);
});

test("audio from a file and from a recording is saved as media", async ({
  page,
}) => {
  await start(page);
  await choose(
    page,
    async () => {
      await commandMenu(page, "audio", "Audio sources");
      await page.getByRole("menuitem", { name: "Audio from File…" }).click();
    },
    { name: "tone.wav", mimeType: "audio/wav", buffer: wav() },
  );
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await tab(page, "Playback");
  await command(page, "playback-across-slides");

  await tab(page, "Insert");
  await commandMenu(page, "audio", "Audio sources");
  await page.getByRole("menuitem", { name: "Record Audio…" }).click();
  const record = page.getByRole("dialog", { name: "Record Sound" });
  await record.getByRole("button", { name: "Record" }).click();
  await page.waitForTimeout(700);
  await record.getByRole("button", { name: "Stop" }).click();
  await record.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(2);

  const saved = await download(page);
  expect(saved.slide().match(/<a:audioFile r:link=/g)).toHaveLength(2);
  expect(saved.slide()).toContain('numSld="999"');
  const media = Object.keys(saved.files).filter((n) =>
    /media\/media\d+\.wav$/.test(n),
  );
  expect(media).toHaveLength(2);
  const recorded = saved.files[media[1]];
  expect(strFromU8(recorded.slice(0, 4))).toBe("RIFF");
});

test("playing a recording back keeps one copy of it, let go on closing", async ({
  page,
}) => {
  // Every blob URL the page makes and has not revoked.
  await page.addInitScript(() => {
    const live = (window.liveBlobUrls = new Set());
    const make = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => {
      const url = make(blob);
      live.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      live.delete(url);
      revoke(url);
    };
  });
  await start(page);
  const live = () => page.evaluate(() => window.liveBlobUrls.size);
  const before = await live();
  await commandMenu(page, "audio", "Audio sources");
  await page.getByRole("menuitem", { name: "Record Audio…" }).click();
  const record = page.getByRole("dialog", { name: "Record Sound" });
  await record.getByRole("button", { name: "Record" }).click();
  await page.waitForTimeout(700);
  await record.getByRole("button", { name: "Stop" }).click();
  for (let i = 0; i < 3; i++)
    await record.getByRole("button", { name: "Play" }).click();
  expect(await live()).toBe(before + 1);
  await record.getByRole("button", { name: "Cancel" }).click();
  await expect(record).toHaveCount(0);
  expect(await live()).toBe(before);
});

test("header and footer apply to every slide", async ({ page }) => {
  await start(page);
  await command(page, "insert-new-slide");
  await command(page, "header-footer");
  const dialog = page.getByRole("dialog", { name: "Header and Footer" });
  const slidePanel = dialog.locator("#hf-slide");
  await slidePanel.getByLabel("Slide number").check();
  await slidePanel.getByLabel("Footer", { exact: true }).check();
  await slidePanel
    .getByLabel("Footer text", { exact: true })
    .fill("Board review");
  await dialog.getByRole("button", { name: "Apply to All" }).click();
  // A slide added afterwards shows them too.
  await command(page, "insert-new-slide");
  const saved = await download(page);
  for (const n of [1, 2, 3]) {
    expect(saved.slide(n)).toContain('type="ftr"');
    expect(saved.slide(n)).toContain('type="sldNum"');
    expect(saved.slide(n)).toContain("Board review");
    expect(saved.slide(n)).toContain('type="slidenum"');
  }
});

// The dialog's two tabs are one stop for Tab, moved between with the arrows.
test("header and footer tabs move with the arrow keys", async ({ page }) => {
  await start(page);
  await command(page, "header-footer");
  const dialog = page.getByRole("dialog", { name: "Header and Footer" });
  const slideTab = dialog.getByRole("tab", { name: "Slide" });
  const notesTab = dialog.getByRole("tab", { name: "Notes and Handouts" });
  await expect(notesTab).toHaveAttribute("tabindex", "-1");
  await slideTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(notesTab).toBeFocused();
  await expect(notesTab).toHaveAttribute("aria-selected", "true");
  await expect(dialog.locator("#hf-notes")).toBeVisible();
  await expect(dialog.locator("#hf-slide")).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(slideTab).toBeFocused();
  await expect(dialog.locator("#hf-slide")).toBeVisible();
});

// WordArt presets went in with their fill color only, so white text meant to
// carry a blue outline was invisible on a light slide.
test("WordArt goes in with its preset's outline and gradient", async ({
  page,
}) => {
  await start(page);
  for (const name of [
    "Fill: White; Outline: Blue, Accent color 1",
    "Gradient Fill: Gold, Accent color 4",
  ]) {
    await command(page, "wordart");
    await page.getByRole("menuitem", { name, exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Edit text", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
  const runs = [
    ...saved(await download(page)).matchAll(/<a:rPr[^>]*>.*?<\/a:rPr>/g),
  ].map(([run]) => run);
  expect(runs[0]).toMatch(
    /<a:ln w="9525"><a:solidFill><a:schemeClr val="accent1"\/>/,
  );
  expect(runs[0]).toContain('<a:schemeClr val="bg1"/>');
  expect(runs[1]).toMatch(
    /<a:gradFill[^>]*><a:gsLst><a:gs pos="0"><a:schemeClr val="accent4">/,
  );
  expect(runs[1]).not.toContain("<a:solidFill>");
});
const saved = (file) =>
  file
    .slide(1)
    .split("<p:sp>")
    .filter((sp) => sp.includes("Your text here"))
    .join("");

test("a summary zoom jumps to its slide and returns", async ({ page }) => {
  await start(page);
  await command(page, "insert-new-slide");
  await command(page, "insert-new-slide");
  await command(page, "insert-zoom");
  await page.getByRole("menuitem", { name: "Summary Zoom…" }).click();
  await page
    .getByRole("dialog", { name: "Insert Summary Zoom" })
    .getByRole("button", { name: "Insert", exact: true })
    .click();
  await expect(page.locator(".slide-item")).toHaveCount(4);
  await expect(page.locator(".object-hit")).toHaveCount(4);
  const saved = await download(page);
  expect(saved.slide(1).match(/ppaction:\/\/hlinksldjump/g)).toHaveLength(3);
  expect(saved.slide(1)).toContain("&quot;type&quot;:&quot;zoom&quot;");

  await page.locator(".slide-item").first().locator(".slide-thumb").click();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presenter-counter")).toHaveText("1 / 4");
  await page.getByRole("button", { name: "Zoom to slide 3" }).click();
  await expect(page.locator(".presenter-counter")).toHaveText("3 / 4");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".presenter-counter")).toHaveText("1 / 4");
});

test("action buttons get a default action and action settings", async ({
  page,
}) => {
  await start(page);
  await command(page, "insert-new-slide");
  await page.locator(".slide-item").first().locator(".slide-thumb").click();
  await command(page, "insert-shapes");
  // On a phone the gallery's sticky headings can cover the row as it scrolls.
  await page
    .getByRole("menuitem", { name: "Action Button: End" })
    .dispatchEvent("click");
  const canvas = await page.locator("#slide-canvas").boundingBox();
  await page.mouse.click(
    canvas.x + canvas.width / 3,
    canvas.y + canvas.height / 3,
  );
  const dialog = page.getByRole("dialog", { name: "Action Settings" });
  await expect(
    dialog
      .locator("#action-panel-click")
      .getByLabel("Hyperlink to", { exact: true }),
  ).toHaveValue("lastSlide");
  await dialog.locator("#action-panel-click").getByLabel("Play sound:").check();
  await dialog.getByRole("tab", { name: "Mouse Over" }).click();
  await dialog.locator("#action-panel-hover").getByLabel("Play sound:").check();
  await dialog.getByRole("button", { name: "OK" }).click();
  const saved = await download(page);
  expect(saved.slide()).toContain('prst="actionButtonEnd"');
  expect(saved.slide()).toContain(
    'action="ppaction://hlinkshowjump?jump=lastslide" highlightClick="1"',
  );
  expect(saved.slide()).toMatch(
    /<a:hlinkClick[^>]*><a:snd r:embed="rId\d+" name="Chime"\/>/,
  );
  expect(saved.slide()).toContain("<a:hlinkHover");

  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presenter-counter")).toHaveText("1 / 2");
  await page.locator(".presenter-action-button").click();
  await expect(page.locator(".presenter-counter")).toHaveText("2 / 2");
});

test("photo album makes slides of the chosen pictures", async ({ page }) => {
  await start(page);
  await command(page, "photo-album");
  const dialog = page.getByRole("dialog", { name: "Photo Album" });
  await choose(
    page,
    () => dialog.getByRole("button", { name: "Add Pictures…" }).click(),
    [
      { name: "one.png", mimeType: "image/png", buffer: PNG },
      { name: "two.png", mimeType: "image/png", buffer: PNG },
      { name: "three.png", mimeType: "image/png", buffer: PNG },
    ],
  );
  await expect(dialog.locator(".album-item")).toHaveCount(3);
  // The last picture moves to the front.
  await dialog.locator(".album-item").nth(2).click();
  await dialog.getByRole("button", { name: "Move up" }).click();
  await dialog.getByRole("button", { name: "Move up" }).click();
  await dialog.getByLabel("Picture layout").selectOption("2");
  await dialog.getByLabel("Frame shape").selectOption("ellipse");
  await dialog.getByLabel("Captions below pictures").check();
  await dialog.getByRole("button", { name: "Create" }).click();
  // A title slide and two slides of pictures follow the first slide.
  await expect(page.locator(".slide-item")).toHaveCount(4);
  const saved = await download(page);
  expect(saved.slide(2)).toContain("Photo Album");
  expect(saved.slide(3).match(/<p:pic>/g)).toHaveLength(2);
  expect(saved.slide(3)).toContain('prst="ellipse"');
  expect(saved.slide(3).indexOf(">three<")).toBeLessThan(
    saved.slide(3).indexOf(">one<"),
  );
  expect(saved.slide(4).match(/<p:pic>/g)).toHaveLength(1);
});

test("a picture the album can't use is left out, not the whole album", async ({
  page,
}) => {
  await start(page);
  await command(page, "photo-album");
  const dialog = page.getByRole("dialog", { name: "Photo Album" });
  await choose(
    page,
    () => dialog.getByRole("button", { name: "Add Pictures…" }).click(),
    [
      { name: "one.png", mimeType: "image/png", buffer: PNG },
      {
        name: "huge.png",
        mimeType: "image/png",
        buffer: Buffer.concat([PNG, Buffer.alloc(13 * 1024 * 1024)]),
      },
      { name: "two.png", mimeType: "image/png", buffer: PNG },
    ],
  );
  await dialog.getByRole("button", { name: "Create" }).click();
  // A title slide and the two usable pictures follow the first slide.
  await expect(page.locator(".slide-item")).toHaveCount(4);
  await expect(page.locator("#toast")).toHaveText(
    "“huge.png” was left out. Choose an image smaller than 12 MB.",
  );
});

test("objects are embedded as packages and handed back on opening", async ({
  page,
}) => {
  await start(page);
  await choose(page, () => command(page, "object"), {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("embedded words"),
  });
  await expect(page.locator(".object-hit")).toHaveCount(1);
  const saved = await download(page);
  expect(saved.slide()).toContain('progId="Package"');
  expect(Object.keys(saved.files)).toContain("ppt/embeddings/oleObject1.bin");
  await page.locator(".object-hit").first().dblclick();
  const dialog = page.getByRole("dialog", { name: "Embedded Object" });
  await expect(dialog).toContainText("notes.txt");
  const event = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download" }).click();
  const file = await event;
  expect(file.suggestedFilename()).toBe("notes.txt");
  expect(await readFile(await file.path(), "utf8")).toBe("embedded words");
});

test("screenshots insert a capture, or a clipped region of it", async ({
  page,
}) => {
  await start(page);
  await command(page, "screenshot");
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await commandMenu(page, "screenshot", "Screenshot options");
  await page.getByRole("menuitem", { name: "Screen Clipping…" }).click();
  const dialog = page.getByRole("dialog", { name: "Screen Clipping" });
  const stage = await dialog.locator(".clip-image").boundingBox();
  await page.mouse.move(stage.x + 10, stage.y + 10);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
  await expect(dialog.getByRole("status")).toContainText("Region");
  await dialog.getByRole("button", { name: "Insert Region" }).click();
  await expect(page.locator(".object-hit")).toHaveCount(2);
  const saved = await download(page);
  expect(saved.slide().match(/<p:pic>/g)).toHaveLength(2);
});
