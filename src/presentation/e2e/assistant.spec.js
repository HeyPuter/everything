import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { addText, ribbonButton, themeDialog } from "./editor-commands.js";

// Puter with a scripted AI: each request takes the next reply from
// window.__replies (a list of stream parts) and is kept in window.__requests.
// A { type: "gate" } part holds the reply until the test calls window.__gate.
async function mockPuter(page) {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `(()=>{window.__requests=[];window.__replies=[];window.puter={env:"web",auth:{isSignedIn:async()=>false,getUser:async()=>null,signIn:async()=>{},signOut:async()=>{}},fs:{readdir:async()=>[],write:async()=>({})},ui:{onLaunchedWithItems:()=>{}},ai:{chat:async(messages,options)=>{window.__requests.push({messages:JSON.parse(JSON.stringify(messages)),options:{...options,tools:options.tools?.length}});const parts=window.__replies.shift()||[{type:"text",text:"Done."}];return (async function*(){for(const part of parts){if(part.type==="gate"){await new Promise(r=>window.__gate=r);continue;}await new Promise(r=>setTimeout(r,20));yield part;}})();}}};})();`,
    }),
  );
}
const reply = (page, ...replies) =>
  page.evaluate((r) => window.__replies.push(...r), replies);
const toolCall = (name, input, id = `call_${name}`) => ({
  type: "tool_use",
  id,
  name,
  input,
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.removeItem("presentation:assistant"),
  );
  await mockPuter(page);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Present", exact: true }),
  ).toBeVisible();
});

test("the assistant edits the slide, shows its steps, and undoes its reply", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "one layout covers the flow");
  const toggle = page.getByRole("button", { name: "Ask AI" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  const panel = page.locator("#ai-panel");
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const box = page.getByRole("textbox", { name: "Message the assistant" });
  await expect(box).toBeFocused();
  await expect(panel.getByText("Sent with your message:")).toBeAttached();
  await expect(panel.locator(".ai-context")).toHaveText(
    "Sent with your message: Slide 1",
  );
  await expect(
    panel.getByRole("button", { name: /Draft a 6-slide/ }),
  ).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include("#ai-panel").analyze()).violations,
  ).toEqual([]);

  await reply(
    page,
    [
      { type: "text", text: "Adding it. " },
      toolCall("add_text", { text: "Hello from AI", x: 1, y: 1, w: 6, h: 1 }),
    ],
    [{ type: "text", text: "Added a **text box** on slide 1." }],
  );
  await box.fill("Add a greeting");
  await box.press("Enter");
  await expect(panel.locator(".ai-user")).toHaveText("Add a greeting");
  await expect(
    panel.getByRole("button", { name: "Add text “Hello from AI” to slide 1" }),
  ).toBeVisible();
  await expect(panel.locator(".ai-assistant strong")).toHaveText("text box");
  await expect(
    panel.getByRole("button", { name: "slide 1", exact: true }),
  ).toBeVisible();
  const object = page.locator('.object-hit[aria-label^="Hello from AI"]');
  await expect(object).toHaveCount(1);
  // The change is selected on the slide for the user to see.
  await expect(object).toHaveClass(/selected/);
  await expect(panel.getByText("1 change made")).toBeVisible();

  // The model got the deck's state, the tools, and its call answered by id.
  const requests = await page.evaluate(() => window.__requests);
  expect(requests).toHaveLength(2);
  expect(requests[0].options).toMatchObject({
    model: "claude-opus-5-5",
    stream: true,
  });
  expect(requests[0].options.tools).toBeGreaterThan(10);
  expect(requests[0].messages[1].content).toContain("<presentation_state>");
  expect(requests[0].messages[1].content).toContain("The user is on slide 1");
  expect(requests[1].messages.at(-1)).toMatchObject({
    role: "tool",
    tool_call_id: "call_add_text",
  });

  await panel.getByRole("button", { name: "Undo" }).click();
  await expect(object).toHaveCount(0);
  await expect(panel.getByText("1 change undone")).toBeVisible();
  // The button is gone; the keyboard is left at the message box, not lost.
  await expect(box).toBeFocused();
  // The editor's own Redo brings it back.
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(object).toHaveCount(1);

  // Ctrl/Cmd+J closes the panel and hands the keyboard back to the slide.
  await box.press("ControlOrMeta+j");
  await expect(panel).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("the assistant asks before deleting and keeps a declined change out", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "one layout covers the flow");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = page.locator("#ai-panel");
  const box = page.getByRole("textbox", { name: "Message the assistant" });
  await reply(
    page,
    [toolCall("add_shape", { shape: "ellipse", x: 2, y: 2, w: 2, h: 2 })],
    [{ type: "text", text: "Added a circle." }],
  );
  await box.fill("Add a circle");
  await box.press("Enter");
  await expect(panel.getByText("Added a circle.")).toBeVisible();
  const circle = page.locator('.object-hit[aria-label^="Circle"]');
  await expect(circle).toHaveCount(1);
  const id = Number(await circle.getAttribute("data-shape-id"));

  await reply(
    page,
    [toolCall("delete_objects", { slide: 1, ids: [id] })],
    [{ type: "text", text: "Understood, I left it." }],
  );
  await box.fill("Delete the circle");
  await box.press("Enter");
  const card = panel.getByRole("group", { name: "Allow this change?" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("This removes “Circle");
  await expect(
    card.getByRole("button", { name: "Allow", exact: true }),
  ).toBeFocused();
  await card.getByRole("button", { name: "Don’t allow" }).click();
  await expect(panel.getByText("Not allowed, so not changed.")).toBeVisible();
  await expect(panel.getByText("Understood, I left it.")).toBeVisible();
  await expect(circle).toHaveCount(1);
  // A declined reply changed nothing, so the circle's reply keeps its Undo.
  await expect(panel.getByRole("button", { name: "Undo" })).toBeEnabled();
});

test("a reply's Undo turns off once the user edits after it", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "one layout covers the flow");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = page.locator("#ai-panel");
  const box = page.getByRole("textbox", { name: "Message the assistant" });
  await reply(
    page,
    [toolCall("set_notes", { notes: "Welcome everyone" })],
    [{ type: "text", text: "Wrote the notes." }],
  );
  await box.fill("Write notes");
  await box.press("Enter");
  await expect(page.locator("#speaker-notes")).toHaveValue("Welcome everyone");
  const undo = panel.getByRole("button", { name: "Undo" });
  await expect(undo).toBeEnabled();
  await addText(page);
  await expect(undo).toBeDisabled();
});

test("a failed request says what to do and can be tried again", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "one layout covers the flow");
  await page.evaluate(() => {
    const chat = window.puter.ai.chat;
    let failed = false;
    window.puter.ai.chat = async (...args) => {
      if (!failed) {
        failed = true;
        throw { error: { message: "Too many requests", code: "rate_limited" } };
      }
      return chat(...args);
    };
  });
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = page.locator("#ai-panel");
  const box = page.getByRole("textbox", { name: "Message the assistant" });
  await box.fill("Hello");
  await box.press("Enter");
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText("The AI service is busy.");
  await reply(page, [{ type: "text", text: "Hi there." }]);
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(panel.getByText("Hi there.")).toBeVisible();
});

test("the assistant fits beside or over the slide on every screen", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = page.locator("#ai-panel");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  // Above phone widths the slide stays in view beside the panel.
  if (viewport.width > 760) {
    const slide = await page.locator("#slide-canvas").boundingBox();
    expect(slide.x + slide.width).toBeLessThanOrEqual(box.x + 1);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: `test-results/assistant-${info.project.name}.png`,
  });
  await panel.getByRole("button", { name: "Close the assistant" }).click();
  await expect(panel).toBeHidden();
});

test("Undo of a reply longer than the history brings back its palette too", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "one layout covers the flow");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = page.locator("#ai-panel");
  const box = page.getByRole("textbox", { name: "Message the assistant" });
  // 32 changes: more than the 30 steps the undo history keeps.
  await reply(page, [
    toolCall("apply_theme", { theme: "cobalt" }),
    ...Array.from({ length: 31 }, (_, i) =>
      toolCall("set_notes", { notes: `Note ${i}` }, `note_${i}`),
    ),
  ]);
  await box.fill("Recolor and write notes");
  await box.press("Enter");
  await expect(panel.getByText("32 changes made")).toBeVisible({
    timeout: 20000,
  });
  await panel.getByRole("button", { name: "Undo" }).click();
  await expect(panel.getByText("32 changes undone")).toBeVisible();
  await expect(page.locator("#speaker-notes")).toHaveValue("");
  await themeDialog(page);
  await expect(page.locator(".theme-choice[aria-pressed=true]")).toContainText(
    "Studio",
  );
});

test("the user's own selection during a reply stays theirs", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "one layout covers the flow");
  await addText(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Ask AI" }).click();
  await reply(
    page,
    [toolCall("add_shape", { shape: "ellipse", x: 8, y: 4, w: 2, h: 2 })],
    [{ type: "gate" }, { type: "text", text: "Added a circle." }],
  );
  const box = page.getByRole("textbox", { name: "Message the assistant" });
  await box.fill("Add a circle");
  await box.press("Enter");
  await expect(page.locator('.object-hit[aria-label^="Circle"]')).toHaveCount(
    1,
  );
  await page.waitForFunction(() => !!window.__gate);
  const mine = page.locator('.object-hit[aria-label^="Your text here"]');
  await mine.click();
  await page.evaluate(() => window.__gate());
  await expect(page.getByText("Added a circle.")).toBeVisible();
  await expect(mine).toHaveClass(/selected/);
  await expect(page.locator(".object-hit.selected")).toHaveCount(1);
});

test("the assistant waits for typing on the slide before showing another", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "one layout covers the flow");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const box = page.getByRole("textbox", { name: "Message the assistant" });
  await reply(
    page,
    [toolCall("add_slide", { layout: "content", title: "Two" })],
    [{ type: "text", text: "Added slide 2." }],
  );
  await box.fill("Add a slide");
  await box.press("Enter");
  await expect(page.getByText("Added slide 2.")).toBeVisible();
  await page.locator(".slide-thumb").first().click();
  await addText(page);
  await reply(
    page,
    [{ type: "gate" }, toolCall("select", { slide: 2 })],
    [{ type: "text", text: "Here it is." }],
  );
  await box.fill("Show slide 2");
  await box.press("Enter");
  await page.waitForFunction(() => !!window.__gate);
  await page.locator('.object-hit[aria-label^="Your text here"]').dblclick();
  // The editor opens with its text selected: typing replaces it.
  await page.keyboard.type("Typed by me");
  await page.evaluate(() => window.__gate());
  await expect(
    page.locator("#ai-panel").getByText("Waiting for you to finish typing"),
  ).toBeVisible();
  await expect(page.locator("#slide-label")).toHaveText(/SLIDE 01/i);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.locator("#slide-label")).toHaveText(/SLIDE 02/i);
  await expect(page.getByText("Here it is.")).toBeVisible();
  await page.locator(".slide-thumb").first().click();
  await expect(
    page.locator('.object-hit[aria-label^="Typed by me"]'),
  ).toHaveCount(1);
});

test("the resize edge stops where the panel stops being drawn wider", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "one layout covers the flow");
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = page.locator("#ai-panel");
  const edge = page.getByRole("separator", { name: "Resize the assistant" });
  const drawn = async () => Math.round((await panel.boundingBox()).width);
  await expect(edge).toHaveAttribute("aria-valuenow", String(await drawn()));
  const b = await edge.boundingBox();
  const y = b.y + 200;
  await page.mouse.move(b.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(b.x - 200, y, { steps: 5 });
  await page.mouse.up();
  const widest = await drawn();
  await expect(edge).toHaveAttribute("aria-valuenow", String(widest));
  await expect(edge).toHaveAttribute("aria-valuemax", String(widest));
  // Back the other way the panel narrows at once, with no slack to take up.
  await edge.focus();
  await page.keyboard.press("ArrowRight");
  expect(await drawn()).toBe(Math.max(300, widest - 16));
});

test("where the format panel lies over the slide, it and the assistant take turns", async ({
  page,
}, info) => {
  test.skip(info.project.name === "desktop", "both fit beside the slide there");
  const assistant = page.locator("#ai-panel");
  const format = page.locator("#inspector");
  await page.getByRole("button", { name: "Ask AI" }).click();
  await expect(assistant).toBeVisible();
  await (await ribbonButton(page, "View", "view-format-pane")).click();
  await expect(format).toBeVisible();
  await expect(assistant).toBeHidden();
  await expect(page.getByRole("button", { name: "Ask AI" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.getByRole("button", { name: "Ask AI" }).click();
  await expect(assistant).toBeVisible();
  await expect(format).toBeHidden();
  await expect(
    await ribbonButton(page, "View", "view-format-pane"),
  ).toHaveAttribute("aria-pressed", "false");
  const slide = await page.locator("#slide-canvas").boundingBox();
  expect(slide.width).toBeGreaterThan(100);
});

test("undo reaches the deck from the panel, and object keys do not", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "one layout covers the flow");
  await addText(page);
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = page.locator("#ai-panel");
  const box = page.getByRole("textbox", { name: "Message the assistant" });
  await reply(page, [toolCall("set_notes", { notes: "Hi" })]);
  await box.fill("Write notes");
  await box.press("Enter");
  await expect(page.locator("#speaker-notes")).toHaveValue("Hi");
  // Keys on the panel's buttons that act on objects stay with the chat.
  await panel.getByRole("button", { name: "New chat" }).focus();
  for (const key of ["Delete", "Backspace", "ArrowLeft", "ControlOrMeta+d"])
    await page.keyboard.press(key);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  // Undo reaches the presentation from anywhere in the panel.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("#speaker-notes")).toHaveValue("");
});
