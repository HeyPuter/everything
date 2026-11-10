import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// puter.js's <puter-user-menu> at the end of the headers: where the SDK
// defines it, it stands in for the Apps button and the account control, and
// its Sign out is the app's.
async function setup({ env = "web", element = true, theme = "system" } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html data-theme="light"><body><header><div class="top-right"></div></header></body></html>',
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
  // A stand-in with the real element's shape: an open shadow root holding
  // the Sign out item.
  class FakeUserMenu extends w.HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML =
        '<div class="menu"><button class="menu-item feedback"></button><button class="menu-item sign-out"></button></div>';
      this.ownSignOuts = 0;
      this.escapes = 0;
      this.shadowRoot
        .querySelector(".sign-out")
        .addEventListener("click", () => this.ownSignOuts++);
      this.shadowRoot.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.escapes++;
      });
    }
  }
  if (element) w.customElements.define("puter-user-menu", FakeUserMenu);
  const puter = {
    env,
    auth: { isSignedIn: () => false, getUser: async () => null },
  };
  const { createAccountUI } = await import("../src/account-ui.js");
  const { createAppsPanel } = await import("../src/apps-panel.js");
  const { createUserMenu, USER_MENU_TAG } = await import("../src/user-menu.js");
  const { setLanguage } = await import("../src/i18n.js");
  const icon = (name) => `<i data-lucide="${name}"></i>`;
  const account = createAccountUI({ puter: () => puter, icon, action() {} });
  const apps = createAppsPanel({ puter: () => puter, icon });
  const calls = [];
  const state = { theme };
  const menu = createUserMenu({
    puter: () => puter,
    theme: () => state.theme,
    signOut: () => calls.push("sign-out"),
    onSignIn: (user) => calls.push(["signed-in", user]),
    onSignOut: () => calls.push("signed-out"),
  });
  // As both headers draw their corner.
  const render = () => {
    w.document.querySelector(".top-right").innerHTML =
      '<button class="icon-btn" aria-label="Keyboard shortcuts"></button>' +
      (menu.active() ? menu.markup() : apps.markup() + account.markup());
    account.bind();
    apps.bind();
    menu.bind();
  };
  render();
  return {
    w,
    doc: w.document,
    puter,
    state,
    menu,
    calls,
    render,
    setLanguage,
    element: () => w.document.querySelector(USER_MENU_TAG),
    done() {
      setLanguage("en");
      dom.window.close();
      for (const [key, value] of saved)
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
    },
  };
}

test("without the element in the SDK the Apps button and the account control stay", async () => {
  const t = await setup({ element: false });
  try {
    assert.equal(t.menu.active(), false);
    assert.equal(t.menu.markup(), "");
    assert.equal(t.element(), null);
    assert.ok(t.doc.querySelector("[data-apps]"));
    assert.ok(t.doc.querySelector("[data-account] .account-signin"));
  } finally {
    t.done();
  }
});

test("the element ends the header in place of the Apps button and the account control", async () => {
  const t = await setup();
  try {
    assert.equal(t.menu.active(), true);
    const corner = t.doc.querySelector(".top-right");
    assert.equal(corner.lastElementChild, t.element());
    assert.equal(t.doc.querySelectorAll("puter-user-menu").length, 1);
    assert.equal(t.doc.querySelector("[data-user-menu]"), null);
    assert.equal(t.doc.querySelector("[data-apps]"), null);
    assert.equal(t.doc.querySelector("[data-account]"), null);
    assert.equal(t.element().getAttribute("sign-in-label"), "Sign in");
    assert.equal(t.element().getAttribute("sign-out-label"), "Sign out");
    // A header drawn anew gets one element, not a second.
    t.render();
    assert.equal(t.doc.querySelectorAll("puter-user-menu").length, 1);
  } finally {
    t.done();
  }
});

test("inside Puter's desktop the app's own controls stay", async () => {
  const t = await setup({ env: "app" });
  try {
    assert.equal(t.menu.active(), false);
    assert.equal(t.element(), null);
    // The desktop has its own launcher; the account control stays.
    assert.equal(t.doc.querySelector("[data-apps]"), null);
    assert.ok(t.doc.querySelector("[data-account]"));
  } finally {
    t.done();
  }
});

test("without an SDK the app's own controls stay", async () => {
  const t = await setup();
  try {
    t.puter.env = undefined;
    t.render();
    assert.equal(t.element(), null);
    assert.ok(t.doc.querySelector("[data-account] .account-signin"));
  } finally {
    t.done();
  }
});

test("the element's Sign out is handed to the app, and its menu closed", async () => {
  const t = await setup();
  try {
    const element = t.element();
    element.shadowRoot.querySelector(".sign-out").click();
    assert.deepEqual(t.calls, ["sign-out"]);
    assert.equal(element.ownSignOuts, 0, "The element did not sign out");
    assert.equal(element.escapes, 1, "Its menu was closed");
    // Its other items are its own.
    element.shadowRoot.querySelector(".feedback").click();
    assert.deepEqual(t.calls, ["sign-out"]);
  } finally {
    t.done();
  }
});

test("a sign-in and a sign-out the element did by itself are followed", async () => {
  const t = await setup();
  try {
    const user = { username: "ada", uuid: "u1" };
    t.element().dispatchEvent(
      new t.w.CustomEvent("signin", { detail: { user } }),
    );
    t.element().dispatchEvent(new t.w.CustomEvent("signout"));
    assert.deepEqual(t.calls, [["signed-in", user], "signed-out"]);
  } finally {
    t.done();
  }
});

test("the element follows an explicit theme, and the system otherwise", async () => {
  const t = await setup({ theme: "dark" });
  try {
    assert.equal(t.element().getAttribute("theme"), "dark");
    t.state.theme = "light";
    t.menu.syncTheme();
    assert.equal(t.element().getAttribute("theme"), "light");
    t.state.theme = "system";
    t.menu.syncTheme();
    assert.equal(t.element().hasAttribute("theme"), false);
  } finally {
    t.done();
  }
});

test("the element's labels are in the app's language", async () => {
  const t = await setup();
  try {
    t.setLanguage("fr");
    t.render();
    const labels = Object.fromEntries(
      [...t.element().attributes]
        .filter((a) => a.name.endsWith("-label"))
        .map((a) => [a.name, a.value]),
    );
    assert.deepEqual(labels, {
      "apps-label": "Applications",
      "sign-in-label": "Se connecter",
      "sign-out-label": "Se déconnecter",
      "close-label": "Fermer",
      "account-label": "Compte",
      "manage-account-label": "Gérer le compte",
      "usage-label": "Utilisation",
      "open-puter-label": "Ouvrir Puter",
      "feedback-label": "Envoyer la rétroaction",
    });
  } finally {
    t.done();
  }
});
