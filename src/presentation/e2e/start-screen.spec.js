// The library screen: its rail, writing a deck from a description (the AI
// answered by the test), starting in a theme, pinning presentations, and
// drafting a slide from a prompt in the editor.
import { test, expect as baseExpect } from "@playwright/test";

test.setTimeout(120_000);
const expect = baseExpect.configure({ timeout: 15_000 });

const errors = new WeakMap();
test.beforeEach(({ page }) => {
  const failures = [];
  errors.set(page, failures);
  page.on("pageerror", (error) => failures.push(error.message));
});
test.afterEach(({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

const outline = {
  title: "Ocean Plastics",
  subtitle: "What we can do",
  notes: "Welcome everyone.",
  slides: [
    {
      layout: "content",
      kicker: "01 / THE PROBLEM",
      title: "Plastic everywhere",
      body: "8 million tonnes a year\nMost from land",
      notes: "Start with the scale.",
    },
    {
      layout: "columns",
      title: "Three fixes",
      columns: [
        { heading: "Reduce", body: "Less packaging" },
        { heading: "Reuse", body: "Refill" },
      ],
      notes: "One line on each.",
    },
    {
      layout: "section",
      title: "Thank you",
      body: "Questions?",
      notes: "Close.",
    },
  ],
};

// `answers` are what the AI streams back, one list of parts per request:
// { text } or { tool: name, input }.
async function start(page, answers = [], hash = "#/home") {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: `window.__answers=${JSON.stringify(answers)};window.__requests=[];
window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}},
ai:{chat:async(messages,options)=>{window.__requests.push({messages,options});const parts=window.__answers.shift()||[{text:"Done."}];
return (async function*(){for(const p of parts){await new Promise(r=>setTimeout(r,5));
if(p.tool) yield {type:"tool_use",id:"call_"+Math.random().toString(36).slice(2),name:p.tool,input:p.input};
else { const t=p.text; for(let i=0;i<t.length;i+=60) yield {type:"text",text:t.slice(i,i+60)}; }}})();}}};`,
    }),
  );
  await page.goto(`/${hash}`);
}

test("a deck is written from a description and opens in the editor", async ({
  page,
}) => {
  await start(page, [[{ text: JSON.stringify(outline) }]]);
  const box = page.getByRole("form", { name: "Write a presentation with AI" });
  await box.getByRole("button", { name: "Create" }).click();
  await expect(box.getByRole("status")).toHaveText(
    "Describe the presentation you want first.",
  );
  await box
    .getByRole("textbox", { name: "Describe your presentation" })
    .fill("A school assembly talk about ocean plastics");
  await box
    .getByRole("combobox", { name: "Number of slides" })
    .selectOption("3");
  await box.getByRole("combobox", { name: "Theme" }).selectOption("cobalt");
  await box.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("#slide-count")).toHaveText("4");
  await expect(page.locator(".document-title")).toHaveText("Ocean Plastics");
  await expect(page.locator("#speaker-notes")).toHaveValue("Welcome everyone.");
  const request = await page.evaluate(() => window.__requests[0]);
  expect(request.messages[1].content).toMatch(/3 content slides/);
  expect(request.messages[1].content).toMatch(/ocean plastics/);
  await page.getByRole("button", { name: /^Slide 3:/ }).click();
  await expect(page.locator("#speaker-notes")).toHaveValue("One line on each.");
  // The new deck is kept like any other.
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(
    page.getByRole("button", { name: "Ocean Plastics Recovery draft" }),
  ).toBeVisible();
});

test("an outline the AI got wrong says so and leaves the library open", async ({
  page,
}) => {
  await start(page, [[{ text: "I cannot help with that." }]]);
  const box = page.getByRole("form", { name: "Write a presentation with AI" });
  await box
    .getByRole("textbox", { name: "Describe your presentation" })
    .fill("Something");
  await box.getByRole("button", { name: "Create" }).click();
  await expect(box.getByRole("status")).toContainText("did not return");
  await expect(box.getByRole("button", { name: "Create" })).toBeEnabled();
});

test("a theme starts a new deck in its palette", async ({ page }) => {
  await start(page);
  const themes = page.getByRole("region", { name: "Start in a theme" });
  await expect(themes.getByRole("listitem")).toHaveCount(4);
  await themes
    .getByRole("listitem", { name: "New presentation in the Midnight theme" })
    .click();
  await expect(page.locator("#slide-count")).toHaveText("1");
  await expect(page.locator(".document-title")).toHaveText(
    "Untitled presentation",
  );
  await expect(page.locator(".object-hit")).not.toHaveCount(0);
});

test("presentations can be pinned to the top and shown on their own", async ({
  page,
}) => {
  await start(page);
  for (const name of ["Alpha", "Zulu"]) {
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    // The title is reached by the keyboard: on a tablet the menu bar lies
    // over part of it.
    await page.locator(".document-title").focus();
    await page.keyboard.press("Enter");
    const input = page.getByRole("textbox", { name: "Presentation name" });
    await input.fill(name);
    await input.press("Enter");
    await expect(page.locator(".document-title")).toHaveText(name);
    await page.getByRole("button", { name: "Back to presentations" }).click();
  }
  const titles = page.locator(".file-row .file-text strong");
  await expect(titles).toHaveText(["Zulu", "Alpha"]);
  await expect(page.locator(".file-table-head")).toContainText("LAST OPENED");
  await page
    .getByRole("button", { name: "Options for Alpha", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Pin to Top" }).click();
  await expect(titles).toHaveText(["Alpha (pinned)", "Zulu"]);
  await page.getByRole("button", { name: "Pinned", exact: true }).click();
  await expect(titles).toHaveText(["Alpha (pinned)"]);
  await page.reload();
  await expect(titles.first()).toHaveText("Alpha (pinned)");
  await page
    .getByRole("button", { name: "Recent", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Options for Alpha", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Unpin" }).click();
  await expect(titles).toHaveText(["Zulu", "Alpha"]);
});

test("the rail moves between the library's sections", async ({ page }) => {
  await start(page);
  const rail = page.getByRole("navigation", { name: "Library sections" });
  await rail.getByRole("button", { name: "New" }).click();
  await expect(
    page.getByRole("textbox", { name: "Describe your presentation" }),
  ).toBeFocused();
  await expect(rail.getByRole("button", { name: "New" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await rail.getByRole("button", { name: "Recent" }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search presentations" }),
  ).toBeFocused();
});

test("New Slide from Prompt has the assistant draft a slide after the current one", async ({
  page,
}) => {
  await start(
    page,
    [
      [
        {
          tool: "add_slide",
          input: {
            layout: "content",
            title: "Our goals",
            body: "Grow\nLearn",
            notes: "Talk through each goal.",
          },
        },
      ],
      [{ text: "Added slide 2 with your goals." }],
    ],
    "",
  );
  // The command sits in the Home tab, or in its group's drop-down when the
  // ribbon is narrow.
  const run = page.locator('[data-command="new-slide-prompt"]');
  if (!(await run.isVisible()))
    await page
      .locator(
        '[data-group]:has([data-command="new-slide-prompt"]) .ribbon-fold',
      )
      .click();
  await run.click();
  const dialog = page.getByRole("dialog", { name: "New Slide from Prompt" });
  await dialog
    .getByRole("textbox", { name: "Describe the slide" })
    .fill("Our goals for next year");
  await dialog.getByRole("button", { name: "Draft Slide" }).click();
  await expect(page.locator("#slide-count")).toHaveText("2");
  const sent = await page.evaluate(
    () => window.__requests[0].messages.at(-1).content,
  );
  expect(sent).toMatch(/right after slide 1/);
  expect(sent).toMatch(/Our goals for next year/);
});
