// The Review features: threaded comments saved in the file, Previous/Next
// across slides, the accessibility checker and Reading Order pane, the
// Spelling, Thesaurus and Translate panes, AutoCorrect, Compare, and Always
// Open Read-Only.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { P, createDeck, addDesignedSlide } from "../src/model.js";

test.setTimeout(90_000);

const MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function stub(page, { ai = null } = {}) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body:
        'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}' +
        (ai ? `,ai:{chat:async(messages)=>(${ai})(messages)}` : "") +
        "};",
    }),
  );
}
async function open(page, pres, name = "Deck.pptx") {
  await page.goto("/#/home");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: MIME,
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator("#slide-canvas .slide-image")).toBeVisible();
}
async function download(page) {
  const menu = page.getByRole("menuitem", { name: "File", exact: true });
  if (await menu.isVisible()) await menu.click();
  else await page.getByRole("button", { name: /File options/ }).click();
  const event = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const bytes = await readFile(await (await event).path());
  return { pres: await P.loadPresentation(bytes), zip: unzipSync(bytes) };
}
async function reviewTab(page) {
  await page.getByRole("tab", { name: "Review" }).click();
}
// A ribbon command, from the group a narrow ribbon folds it into if need be.
async function reveal(page, id) {
  const target = page.locator(`[data-command="${id}"]`).first();
  if (await target.isVisible()) return target;
  await page
    .locator(`.ribbon-group:has([data-command="${id}"]) > .ribbon-fold`)
    .click();
  const inPanel = page
    .locator(`.ribbon-fold-panel [data-command="${id}"]`)
    .first();
  await expect(inPanel).toBeVisible();
  return inPanel;
}
// Presses a button from the keyboard. A phone layout wider than the screen
// zooms the page out, and a pointer aimed into the bottom sheet can land a
// little off; the keyboard reaches the button itself.
async function press(locator) {
  await locator.focus();
  await locator.press("Enter");
}
async function command(page, id) {
  await (await reveal(page, id)).click();
}
function textDeck(lines) {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  lines.forEach((text, i) =>
    P.addSlideTextBox(slide, {
      x: 914400,
      y: 914400 * (1 + i),
      w: 914400 * 6,
      h: 685800,
      text,
    }),
  );
  return pres;
}

test("comments: post, mention, reply and resolve, saved as threaded comments", async ({
  page,
}) => {
  await stub(page);
  const pres = createDeck("pitch");
  await open(page, pres);
  await reviewTab(page);
  const target = page.locator(".object-hit").first();
  const shapeId = await target.getAttribute("data-shape-id");
  await target.click();
  await page.keyboard.press(`${MOD}+Shift+M`);
  const pane = page.locator("#review-pane");
  await expect(pane).toBeVisible();
  await pane
    .getByRole("textbox", { name: "New comment" })
    .fill("Check the date");
  await pane.getByRole("button", { name: "Post", exact: true }).click();
  // A guest gives a name once.
  const name = page.getByRole("textbox", { name: "Your name" });
  await name.fill("Ada Lovelace");
  await page.getByRole("button", { name: "Continue" }).click();
  const thread = pane.locator(".comment-thread").first();
  await expect(thread).toContainText("Check the date");
  await expect(thread).toContainText("Ada Lovelace");
  await expect(thread).toContainText(/^On /);
  await expect(page.locator("#slide-canvas .comment-marker")).toHaveCount(1);
  await expect(
    page.locator(".slide-item").first().locator(".slide-comment-badge"),
  ).toHaveText("1");
  // A reply with a mention picked from the list.
  const reply = thread.getByRole("textbox", { name: "Reply" });
  await reply.fill("Agreed @Ad");
  await expect(
    thread.getByRole("option", { name: "Ada Lovelace" }),
  ).toBeVisible();
  await reply.press("Enter");
  await expect(reply).toHaveValue("Agreed @Ada Lovelace ");
  await reply.pressSequentially("thanks");
  await reply.press(`${MOD}+Enter`);
  await expect(pane.locator(".comment-reply")).toHaveCount(1);
  await expect(pane.locator(".comment-mention").first()).toHaveText(
    "@Ada Lovelace",
  );
  await pane.getByRole("button", { name: "Resolve thread" }).click();
  await expect(pane.locator(".comment-thread.resolved")).toHaveCount(1);
  // The marker moves where it is dragged. On a phone the pane is a sheet over
  // the slide; it is put away to reach the marker, which stays.
  if (await pane.evaluate((p) => getComputedStyle(p).position === "fixed"))
    await pane.getByRole("button", { name: "Close pane" }).click();
  const marker = page.locator("#slide-canvas .comment-marker");
  const box = await marker.boundingBox();
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x - 160, box.y + 90, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await marker.boundingBox()).x)
    .toBeLessThan(box.x - 100);

  const { pres: saved, zip } = await download(page);
  const parts = Object.keys(zip);
  expect(
    parts.some((n) => /^ppt\/comments\/modernComment_.*\.xml$/.test(n)),
  ).toBe(true);
  expect(strFromU8(zip["ppt/authors.xml"])).toContain('name="Ada Lovelace"');
  const [t] = P.getSlideCommentThreads(P.getSlides(saved)[0]);
  expect(t).toMatchObject({
    text: "Check the date",
    status: "resolved",
    shapeId,
  });
  expect(t.replies[0].text).toBe("Agreed @Ada Lovelace thanks");
  expect(t.pos.x).toBeGreaterThan(0);
  // Comments never reach the slide's own picture.
  expect(
    strFromU8(zip[P.getSlidePartName(P.getSlides(saved)[0]).slice(1)]),
  ).not.toContain("Check the date");
});

test("comments: previous and next across slides, filters, and delete all", async ({
  page,
}) => {
  await stub(page);
  const pres = createDeck("pitch");
  const slides = P.getSlides(pres);
  P.setSlideCommentThreads(slides[1], [
    { author: { name: "Grace" }, text: "On two" },
  ]);
  P.setSlideCommentThreads(slides[3], [
    { author: { name: "Grace" }, text: "On four", status: "resolved" },
  ]);
  await open(page, pres);
  await reviewTab(page);
  await expect(page.locator(".slide-comment-badge")).toHaveCount(1);
  await command(page, "next-comment");
  await expect(page.locator("#slide-position")).toHaveText(/Slide 2 of/);
  await expect(
    page.locator("#review-pane .comment-thread.active"),
  ).toContainText("On two");
  await command(page, "next-comment");
  await expect(page.locator("#slide-position")).toHaveText(/Slide 4 of/);
  await command(page, "previous-comment");
  await expect(page.locator("#slide-position")).toHaveText(/Slide 2 of/);
  // Open comments only.
  await page.getByRole("button", { name: "Filter comments" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "All slides" })
    .or(page.getByRole("menuitem", { name: "All slides" }))
    .click();
  await page.getByRole("button", { name: "Filter comments" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Open comments" })
    .or(page.getByRole("menuitem", { name: "Open comments" }))
    .click();
  await expect(page.locator("#review-pane .comment-thread")).toHaveCount(1);
  // Show Markup off hides the markers.
  await reveal(page, "show-comments");
  await page.getByRole("button", { name: "Show Comments options" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Show Markup" })
    .or(page.getByRole("menuitem", { name: "Show Markup" }))
    .click();
  await expect(page.locator(".comment-marker")).toHaveCount(0);
  // Delete every comment.
  await command(page, "delete-comment");
  await page
    .getByRole("menuitem", { name: "Delete All Comments in This Presentation" })
    .click();
  await page.getByRole("button", { name: "Delete All" }).click();
  await expect(page.locator(".slide-comment-badge")).toHaveCount(0);
  const { pres: saved } = await download(page);
  expect(P.hasPresentationComments(saved)).toBe(false);
});

test("comments stay out of the slide show", async ({ page }) => {
  await stub(page);
  const pres = createDeck("pitch");
  P.setSlideCommentThreads(P.getSlides(pres)[0], [
    { author: { name: "Grace" }, text: "Hidden in the show" },
  ]);
  await open(page, pres);
  await expect(page.locator(".comment-marker")).toHaveCount(1);
  await page.keyboard.press("F5");
  const show = page
    .locator(".slideshow, .presentation-mode, dialog[open]")
    .first();
  await expect(show).toBeVisible();
  await expect(show.locator(".comment-marker")).toHaveCount(0);
  await expect(page.getByText("Hidden in the show")).toHaveCount(0);
});

test("accessibility: issues with fixes, reading order, and the status bar", async ({
  page,
}) => {
  await stub(page);
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  for (const [i, text] of ["Second", "First"].entries())
    P.addSlideTextBox(slide, {
      x: 914400,
      y: 914400 * (3 - i * 2),
      w: 914400 * 4,
      h: 457200,
      text,
    });
  await open(page, pres);
  await reviewTab(page);
  await expect(page.locator("#status-accessibility")).toContainText(
    "Investigate",
  );
  await command(page, "check-accessibility");
  const pane = page.locator("#review-pane");
  await expect(pane.getByText("Missing slide title (1)")).toBeVisible();
  await expect(pane.getByText(/Tips \(1\)/)).toBeVisible();
  // The fix adds a title only screen readers meet.
  await pane.locator(".a11y-item").first().click();
  await expect(pane).toContainText("Why fix");
  await pane.getByRole("button", { name: "Add a Hidden Slide Title" }).click();
  await expect(pane.getByText("Missing slide title")).toHaveCount(0);
  await expect(page.locator("#status-accessibility")).toContainText(
    "Good to go",
  );
  // Reading order: the text above is read after the one below; move it up.
  await pane
    .getByRole("button", { name: "Open Reading Order Pane" })
    .or(pane.locator(".a11y-fix-menu").first())
    .first()
    .click();
  if (
    await page
      .getByRole("menuitem", { name: "Open Reading Order Pane" })
      .isVisible()
  )
    await page
      .getByRole("menuitem", { name: "Open Reading Order Pane" })
      .click();
  await expect(page.locator("#review-pane-title")).toHaveText("Reading Order");
  const names = page.locator(".order-name");
  await expect(names).toHaveCount(3);
  await expect(names.nth(0)).toContainText("Second");
  await expect(names.nth(1)).toContainText("First");
  await names.nth(1).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(names.nth(0)).toContainText("First");
  await expect(names.nth(0)).toBeFocused();
  const { pres: saved } = await download(page);
  const texts = P.getSlideShapes(P.getSlides(saved)[0]).map((s) =>
    P.getShapeText(s),
  );
  expect(texts.indexOf("First")).toBeLessThan(texts.indexOf("Second"));
  expect(P.getSlideTitle(P.getSlides(saved)[0])).toBeTruthy();
});

test("spelling pane: change a word, ignore another", async ({ page }) => {
  await stub(page);
  await open(page, textDeck(["The quick brwn fox", "Zorblax is our product"]));
  await page.keyboard.press("F7");
  const pane = page.locator("#review-pane");
  await expect(pane.locator(".spell-word")).toHaveText("brwn", {
    timeout: 20_000,
  });
  await expect(pane.getByRole("option", { name: "brown" })).toBeVisible();
  await pane.getByRole("option", { name: "brown" }).click();
  await press(pane.getByRole("button", { name: "Change", exact: true }));
  await expect(pane.locator(".spell-word")).toHaveText("Zorblax");
  await press(pane.getByRole("button", { name: "Ignore All" }));
  await expect(pane).toContainText("Spelling check complete");
  const { pres: saved } = await download(page);
  const texts = P.getSlideShapes(P.getSlides(saved)[0]).map((s) =>
    P.getShapeText(s),
  );
  expect(texts).toContain("The quick brown fox");
});

test("AutoCorrect corrects as you type", async ({ page }) => {
  await stub(page);
  await open(page, textDeck(["x"]));
  await page.locator(".object-hit").first().dblclick();
  const editor = page.locator(".inline-editor");
  await expect(editor).toBeFocused();
  await page.keyboard.press(`${MOD}+A`);
  await page.keyboard.type('teh "best" deck (c) 2026. it works ');
  await expect(editor).toHaveText("The “best” deck © 2026. It works ");
  await page.keyboard.press("Escape");
  const { pres: saved } = await download(page);
  expect(P.getShapeText(P.getSlideShapes(P.getSlides(saved)[0])[0])).toBe(
    "The “best” deck © 2026. It works ",
  );
});

test("thesaurus: offline synonyms replace the selected word", async ({
  page,
}) => {
  await stub(page);
  await open(page, textDeck(["A big result"]));
  await page.locator(".object-hit").first().dblclick();
  await expect(page.locator(".inline-editor")).toBeFocused();
  // Select "big".
  await page.evaluate(() => {
    const editor = document.querySelector(".inline-editor");
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.data.indexOf("big");
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 3);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return;
    }
  });
  await page.keyboard.press("Shift+F7");
  const pane = page.locator("#review-pane");
  await expect(
    pane.getByRole("searchbox", { name: "Word to look up" }),
  ).toHaveValue("big");
  await pane.getByRole("option", { name: "large" }).click();
  await press(pane.getByRole("button", { name: "Insert" }));
  await expect(page.locator(".inline-editor")).toHaveText("A large result");
});

test("translate: the selected object's text through the AI", async ({
  page,
}) => {
  await stub(page, {
    ai: `(messages) => { const list = JSON.parse(messages[1].content.split("\\n").slice(1).join("\\n")); return { message: { content: JSON.stringify({ detected: "English", translations: list.map((t) => "FR:" + t) }) } }; }`,
  });
  await open(page, textDeck(["Hello world", "Second box"]));
  await reviewTab(page);
  await page.locator(".object-hit").first().click();
  await command(page, "translate");
  const pane = page.locator("#review-pane");
  await pane
    .getByRole("combobox", { name: "Translate to" })
    .selectOption("fr-FR");
  await press(pane.getByRole("button", { name: "Translate" }));
  await expect(pane.locator(".translate-target")).toHaveText("FR:Hello world");
  await press(pane.getByRole("button", { name: "Insert" }));
  const { pres: saved } = await download(page);
  const shapes = P.getSlideShapes(P.getSlides(saved)[0]);
  expect(P.getShapeText(shapes[0])).toBe("FR:Hello world");
  expect(P.getShapeText(shapes[1])).toBe("Second box");
});

test("compare: list another version's changes and accept them", async ({
  page,
}) => {
  await stub(page);
  const mine = createDeck("pitch");
  const theirs = await P.loadPresentation(await P.savePresentation(mine));
  const first = P.getSlideShapes(P.getSlides(theirs)[0]).find((s) =>
    (P.getShapeText(s) || "").trim(),
  );
  P.setShapeText(first, "A new opening");
  P.removeSlide(theirs, P.getSlides(theirs)[2]);
  addDesignedSlide(theirs, "title", "studio", {
    title: "Appendix",
    body: "More",
  });
  await open(page, mine);
  await reviewTab(page);
  const chooser = page.waitForEvent("filechooser");
  await command(page, "compare");
  await (
    await chooser
  ).setFiles({
    name: "Theirs.pptx",
    mimeType: MIME,
    buffer: Buffer.from(await P.savePresentation(theirs)),
  });
  const pane = page.locator("#review-pane");
  await expect(page.locator("#review-pane-title")).toHaveText("Revisions");
  await expect(pane.getByText("Text changed")).toBeVisible();
  await expect(pane.getByText("Slide deleted")).toBeVisible();
  await expect(pane.getByText("Slide inserted")).toBeVisible();
  // Reject the deletion, accept the rest.
  await pane.getByRole("button", { name: /^Reject: Slide deleted/ }).click();
  await pane.getByRole("button", { name: "Accept All" }).click();
  await expect(pane).toContainText("No changes left to review.");
  const { pres: saved } = await download(page);
  const slides = P.getSlides(saved);
  expect(slides).toHaveLength(P.getSlides(mine).length + 1);
  const texts = P.getSlideShapes(slides[0]).map((s) => P.getShapeText(s));
  expect(texts).toContain("A new opening");
});

test("always open read-only: the mark is saved, and Edit Anyway lifts the lock", async ({
  page,
}) => {
  await stub(page);
  await open(page, textDeck(["Final words"]));
  await reviewTab(page);
  await command(page, "always-read-only");
  const bar = page.locator(".final-bar");
  await expect(bar).toBeVisible();
  await expect(await reveal(page, "always-read-only")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Editing is held back.
  await page.locator(".object-hit").first().click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".object-hit")).toHaveCount(1);
  const { pres: saved } = await download(page);
  expect(P.isMarkedFinal(saved)).toBe(true);
  // Opened again, it is read-only until Edit Anyway.
  await open(page, saved, "Final.pptx");
  await expect(page.locator(".final-bar")).toBeVisible();
  await page.getByRole("button", { name: "Edit Anyway" }).click();
  await expect(page.locator(".final-bar")).toBeHidden();
  await page.locator(".object-hit").first().click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".object-hit")).toHaveCount(0);
});

test.describe("a new presentation", () => {
  // The app's own start: a Title Slide waiting for its title and subtitle.
  test.use({ storageState: { cookies: [], origins: [] } });
  test("starts with nothing for the accessibility check to fix", async ({
    page,
  }) => {
    await stub(page);
    await page.goto("/");
    await expect(page.locator("#slide-canvas .object-hit")).toHaveCount(2);
    await expect(page.locator("#status-accessibility")).toHaveText(
      "Accessibility: Good to go",
    );
    // The empty placeholders are tips in the pane.
    await reviewTab(page);
    await command(page, "check-accessibility");
    const pane = page.locator("#review-pane");
    await expect(pane).toContainText("Empty placeholder (2)");
    await expect(pane).not.toContainText("Missing slide title");
  });
  test("the status follows each edit and its undo", async ({ page }) => {
    await stub(page);
    await page.goto("/");
    const status = page.locator("#status-accessibility");
    await expect(status).toHaveText("Accessibility: Good to go");
    // Without its title placeholder the slide has no title.
    await page.locator("#slide-canvas .object-hit").first().click();
    await page.keyboard.press("Delete");
    await expect(page.locator("#slide-canvas .object-hit")).toHaveCount(1);
    await expect(status).toHaveText("Accessibility: Investigate");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z",
    );
    await expect(page.locator("#slide-canvas .object-hit")).toHaveCount(2);
    await expect(status).toHaveText("Accessibility: Good to go");
  });
});
