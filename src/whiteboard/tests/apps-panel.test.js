import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// The Apps launcher beside the account control: a grid button opening a
// panel that embeds puter.com/embed/apps.
async function setup({ env = "web", signedIn = false } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html data-theme="light"><body><header><div class="top-right"></div></header><canvas id="canvas" tabindex="0"></canvas></body></html>',
    { url: "https://whiteboard.puter.com/", pretendToBeVisual: true },
  );
  const w = dom.window;
  const saved = new Map();
  for (const [key, value] of Object.entries({
    window: w,
    document: w.document,
    NodeFilter: w.NodeFilter,
    MutationObserver: w.MutationObserver,
    localStorage: w.localStorage,
  })) {
    saved.set(key, globalThis[key]);
    globalThis[key] = value;
  }
  // jsdom lays nothing out; a button with no box counts as hidden.
  w.Element.prototype.getClientRects = () => [{}];
  w.Element.prototype.getBoundingClientRect = () => ({
    left: 300,
    right: 340,
    top: 6,
    bottom: 46,
    width: 40,
    height: 40,
  });
  const state = {
    signedIn,
    user: signedIn ? { username: "ada", uuid: "u1" } : null,
  };
  const puter = {
    env,
    auth: {
      isSignedIn: () => state.signedIn,
      getUser: async () => state.user,
    },
  };
  const { createAccountUI } = await import("../src/account-ui.js");
  const { createAppsPanel, APPS_EMBED_URL, APPS_NEWTAB_URL } =
    await import("../src/apps-panel.js");
  const icon = (name) => `<i data-lucide="${name}"></i>`;
  const account = createAccountUI({
    puter: () => puter,
    icon,
    action() {},
    onMenuOpen: () => apps.close(),
    onChange: () => apps.syncAccount(),
  });
  const apps = createAppsPanel({
    puter: () => puter,
    icon,
    closeAccountMenu: () => account.close(),
    accountKey: () => {
      if (!puter.auth.isSignedIn()) return "";
      const user = account.user();
      return user?.uuid || user?.username || apps.PENDING;
    },
  });
  const render = () => {
    w.document.querySelector(".top-right").innerHTML =
      apps.markup() + account.markup();
    account.bind();
    apps.bind();
  };
  render();
  await account.refresh();
  const doc = w.document;
  return {
    w,
    doc,
    puter,
    state,
    account,
    apps,
    render,
    APPS_EMBED_URL,
    APPS_NEWTAB_URL,
    button: () => doc.querySelector("[data-apps]"),
    panel: () => doc.querySelector(".apps-panel"),
    shown: () => !!doc.querySelector(".apps-panel:not([hidden])"),
    press: (target) =>
      target.dispatchEvent(
        new w.Event("pointerdown", { bubbles: true, cancelable: true }),
      ),
    key: (target, key) => {
      const e = new w.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(e);
      return e;
    },
    done() {
      dom.window.close();
      for (const [key, value] of saved)
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
    },
  };
}

test("the Apps button sits just before the account control, named and closed", async () => {
  const t = await setup();
  try {
    const button = t.button();
    assert.ok(button);
    assert.equal(button.nextElementSibling.matches("[data-account]"), true);
    assert.equal(button.getAttribute("aria-label"), "Apps");
    assert.equal(button.getAttribute("title"), "Apps");
    assert.equal(button.getAttribute("aria-haspopup"), "dialog");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(button.querySelectorAll("circle").length, 9);
    assert.equal(t.panel(), null, "The panel is built on first open");
  } finally {
    t.done();
  }
});

test("inside Puter's desktop the button is left out", async () => {
  const t = await setup({ env: "app" });
  try {
    assert.equal(t.button(), null);
  } finally {
    t.done();
  }
});

test("the button toggles a labelled panel embedding the person's apps", async () => {
  const t = await setup();
  try {
    t.button().click();
    const panel = t.panel();
    assert.ok(t.shown());
    assert.equal(panel.parentElement, t.doc.body);
    assert.equal(t.button().getAttribute("aria-expanded"), "true");
    assert.equal(panel.getAttribute("role"), "dialog");
    assert.equal(panel.getAttribute("aria-label"), "Apps");
    assert.equal(panel.getAttribute("tabindex"), "-1");
    assert.equal(t.doc.activeElement, panel);
    const frame = panel.querySelector("iframe");
    assert.equal(frame.src, t.APPS_EMBED_URL);
    assert.equal(frame.title, "Your Puter apps");
    assert.equal(
      frame.getAttribute("referrerpolicy"),
      "strict-origin-when-cross-origin",
    );
    assert.equal(
      frame.getAttribute("allow"),
      "clipboard-read; clipboard-write",
    );
    const link = panel.querySelector(".apps-panel-newtab");
    assert.equal(link.getAttribute("href"), t.APPS_NEWTAB_URL);
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
    // Under the button, the caret on its centre.
    assert.equal(panel.style.getPropertyValue("--apps-panel-top"), "56px");

    t.button().click();
    assert.equal(t.shown(), false);
    assert.equal(t.button().getAttribute("aria-expanded"), "false");
  } finally {
    t.done();
  }
});

test("a spinner shows until the embed loads, and the panel is built once", async () => {
  const t = await setup();
  try {
    t.button().click();
    const body = t.panel().querySelector(".apps-panel-body");
    assert.ok(body.classList.contains("is-loading"));
    t.panel().querySelector("iframe").dispatchEvent(new t.w.Event("load"));
    assert.equal(body.classList.contains("is-loading"), false);
    const first = t.panel();
    t.button().click();
    t.button().click();
    assert.equal(t.panel(), first);
    assert.equal(t.doc.querySelectorAll(".apps-panel").length, 1);
  } finally {
    t.done();
  }
});

test("Escape and ✕ close it and hand focus back to the button", async () => {
  const t = await setup();
  try {
    t.button().click();
    t.key(t.panel(), "Escape");
    assert.equal(t.shown(), false);
    assert.equal(t.doc.activeElement, t.button());

    t.button().click();
    t.panel().querySelector(".apps-panel-close").click();
    assert.equal(t.shown(), false);
    assert.equal(t.doc.activeElement, t.button());
  } finally {
    t.done();
  }
});

test("keys in the panel never reach the board's shortcuts", async () => {
  const t = await setup();
  try {
    const seen = [];
    t.doc.addEventListener("keydown", (e) => seen.push(e.key));
    t.button().click();
    t.key(t.panel(), "n");
    t.key(t.panel().querySelector(".apps-panel-close"), "Delete");
    assert.deepEqual(seen, []);
    assert.ok(t.shown());
  } finally {
    t.done();
  }
});

test("a press outside only closes it; the board still gets the press", async () => {
  const t = await setup();
  try {
    const canvas = t.doc.querySelector("#canvas");
    let reached = null;
    canvas.addEventListener("pointerdown", (e) => (reached = e));
    t.button().click();
    t.press(t.panel().querySelector(".apps-panel-header"));
    assert.ok(t.shown());
    t.press(t.button());
    assert.ok(t.shown());
    t.press(canvas);
    assert.equal(t.shown(), false);
    assert.ok(reached, "The canvas received the press");
    assert.equal(reached.defaultPrevented, false);
  } finally {
    t.done();
  }
});

test("the account menu and the panel never show together", async () => {
  const t = await setup({ signedIn: true });
  try {
    t.button().click();
    assert.ok(t.shown());
    t.doc.querySelector(".account-button").click();
    assert.ok(t.doc.querySelector(".account-menu"));
    assert.equal(t.shown(), false);
    assert.equal(t.button().getAttribute("aria-expanded"), "false");

    t.button().click();
    assert.ok(t.shown());
    assert.equal(t.doc.querySelector(".account-menu"), null);
  } finally {
    t.done();
  }
});

test("it closes when its button leaves with the view", async () => {
  const t = await setup();
  try {
    t.button().click();
    t.render();
    assert.equal(t.shown(), false);

    t.button().click();
    t.button().remove();
    t.w.dispatchEvent(new t.w.Event("resize"));
    assert.equal(t.shown(), false);
  } finally {
    t.done();
  }
});

test("the embed follows the app's light or dark theme", async () => {
  const t = await setup();
  try {
    t.doc.documentElement.dataset.theme = "dark";
    t.button().click();
    const frame = t.panel().querySelector("iframe");
    assert.equal(frame.style.colorScheme, "dark");
    t.doc.documentElement.dataset.theme = "light";
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(frame.style.colorScheme, "light");
  } finally {
    t.done();
  }
});

test("signing in or out loads the embed afresh for the new account", async () => {
  const t = await setup();
  try {
    t.button().click();
    const first = t.panel();
    t.state.signedIn = true;
    t.state.user = { username: "ada", uuid: "u1" };
    await t.account.refresh();
    assert.equal(first.isConnected, false);
    t.button().click();
    const second = t.panel();
    assert.notEqual(second, first);
    assert.ok(t.shown());
    // The account's name arriving later is the same account.
    await t.account.refresh();
    assert.equal(second.isConnected, true);

    t.state.signedIn = false;
    t.state.user = null;
    await t.account.refresh();
    assert.equal(second.isConnected, false);
  } finally {
    t.done();
  }
});
