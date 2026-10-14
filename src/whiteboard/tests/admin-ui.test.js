import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import axe from "axe-core";

// Organization settings rendered against a fake organization: every tab
// loads, saves through the organization worker, and passes axe checks.
test("organization settings tabs render, save, and are accessible", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  for (const key of [
    "document",
    "localStorage",
    "NodeFilter",
    "HTMLElement",
    "Node",
    "Event",
  ])
    globalThis[key] = w[key];
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new w.Event("close"));
  };
  const { createAdminConsole } =
    await import("../src/organization/admin-ui.js");
  const { normalizePolicy } = await import("../worker/org.js");
  const calls = [];
  const day = (n) => ({
    date: `2026-09-${String(n).padStart(2, "0")}`,
    value: n,
  });
  const responses = {
    "org.reports": {
      generated: Date.now(),
      days: 30,
      users: {
        total: 3,
        active: 3,
        deactivated: 0,
        pending: 1,
        guests: 1,
        admins: 1,
        activeLast30Days: 2,
        inactive: [{ uuid: "u3", username: "cam", lastActive: null }],
      },
      usage: {
        dailyActiveUsers: [day(1), day(2)],
        peakConcurrent: [day(1), day(2)],
        minutesPerDay: [day(1), day(2), { date: "2026-09-03", value: 2997 }],
      },
      boards: {
        total: 2,
        archived: 0,
        deleted: 0,
        activeLast30Days: 1,
        stale: 1,
        empty: 0,
        createdByWeek: [{ week: "2026-09-01", created: 2 }],
        topOwners: [{ uuid: "u1", username: "alice", count: 2 }],
        largest: [],
      },
      sharing: {
        organizationVisible: 1,
        publicLinks: 12345,
        withGuests: 1,
        guestMemberships: 1,
        boardsWithGuests: [
          { room: "r1", title: "Kickoff", guests: 1, visibility: "private" },
        ],
      },
      sessions: {
        largest: [
          { room: "r1", title: "Kickoff", participants: 120, at: Date.now() },
        ],
        sessionsOver50: 1,
      },
      feedback: {
        responses: 2,
        averageEase: 4.5,
        // Numbers from the organization's server never become markup.
        distribution: ['<img id="pwn-count">', 0, 0, 1, 1],
        recent: [{ at: 1, ease: '<img id="pwn-ease">', comment: "Great" }],
      },
    },
    "org.users.list": {
      owner: { uuid: "u1", username: "alice" },
      users: [
        {
          uuid: "u2",
          username: "bob",
          email: "bob@fabrikam.test",
          emailVerified: true,
          role: "member",
          status: "active",
          teams: ["t1"],
          lastActive: Date.now(),
        },
        {
          uuid: "pending-1",
          email: "dee@fabrikam.test",
          role: "member",
          status: "pending",
          teams: [],
        },
      ],
    },
    "teams.list": { teams: [{ id: "t1", name: "Design", members: ["u2"] }] },
    // Space names come from members, so they must render as text.
    "spaces.list": {
      spaces: [{ id: "s1", name: 'Discovery</select><img id="pwn" src="x">' }],
    },
    "org.boards": {
      boards: [
        {
          room: "r1",
          title: "Kickoff",
          owner: "u1",
          ownerName: "alice",
          created: 1,
          lastActivity: Date.now(),
          objectCount: 40,
          visibility: "organization",
          guestCount: 1,
        },
      ],
    },
    "org.policy.get": {
      policy: normalizePolicy({ name: "Fabrikam", domains: ["fabrikam.test"] }),
      secrets: {
        slack: false,
        jira: true,
        sentinel: false,
        "siem-token": false,
      },
      siem: null,
      owner: { uuid: "u1", username: "alice" },
    },
    "apikeys.list": {
      keys: [
        {
          id: "k1",
          name: "SCIM",
          scopes: ["scim"],
          prefix: "wbk_abcd1234",
          created: 1,
          lastUsed: null,
          expires: null,
        },
      ],
      scopes: ["scim", "audit:read"],
    },
    "webhooks.list": {
      webhooks: [
        {
          id: "h1",
          url: "https://hooks.example.ca/x",
          events: ["*"],
          enabled: true,
        },
      ],
      events: ["*", "board"],
      pending: 0,
    },
    "org.audit": {
      entries: [
        {
          id: "a1",
          at: Date.now(),
          time: new Date().toISOString(),
          category: "sharing",
          action: "board.visibility.link",
          actor: { username: "bob" },
          target: { type: "board", id: "r1", name: "Kickoff" },
          details: { to: "link" },
        },
      ],
      cursor: null,
    },
  };
  const org = {
    server: "https://whiteboard-abc.puter.work",
    isAdmin: true,
    request: async (op, data) => {
      calls.push([op, data]);
      return responses[op] || { ok: true, policy: {} };
    },
    refresh: async () => {},
  };
  const downloads = [];
  const modal = (title, html, ready) => {
    const d = document.createElement("dialog");
    d.setAttribute("aria-label", title);
    d.innerHTML = `<div class="dialog-header"><h2>${title}</h2></div>${html}`;
    document.body.append(d);
    d.showModal();
    ready?.(d);
    return d;
  };
  const admin = createAdminConsole({
    org,
    modal,
    toast: () => {},
    icon: () => "",
    download: (...args) => downloads.push(args),
    migrate: () => {},
  });
  const d = admin.open();
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const panel = () => d.querySelector("#admin-panel");
  const audit = async (label) => {
    w.eval(axe.source);
    const result = await w.axe.run(d, {
      rules: { "color-contrast": { enabled: false } },
    });
    assert.deepEqual(
      Array.from(
        result.violations,
        (v) => `${label}: ${v.id}: ${v.nodes[0]?.html}`,
      ),
      [],
    );
  };
  await settle();
  assert.match(panel().textContent, /Daily active users/);
  assert.match(panel().textContent, /Ease of use/);
  assert.equal(
    d.querySelector('[aria-selected="true"]').dataset.tab,
    "overview",
  );
  await audit("overview");
  assert.equal(d.querySelector("#pwn-count, #pwn-ease"), null);
  // A count of one is singular.
  assert.match(panel().textContent, /1 guest membership(?!s)/);
  assert.match(panel().textContent, /1 session with 50 or more people/);
  assert.match(panel().textContent, /1 active in the last 30 days/);
  assert.match(panel().textContent, /2 ratings out of 5/);
  // Figures group their digits for the language, and time on boards is
  // given in hours once minutes stop being readable: 3,000 min is 50 h.
  const values = [...panel().querySelectorAll(".stat-value")].map((v) =>
    v.textContent.trim(),
  );
  assert.ok(values.includes("12,345"), values.join(" | "));
  assert.ok(values.includes("50 h"), values.join(" | "));
  // The inactive users export holds everyone, even past the people the
  // report lists.
  panel().querySelector("#report-users").click();
  await settle();
  assert.match(
    downloads.at(-1)[0],
    /^\ufeff?username,email,lastActive\r\ncam,/,
  );
  const report = responses["org.reports"];
  report.users.inactiveCount = 2;
  const ask = org.request;
  org.request = async (op, data) =>
    op === "org.reports" && data?.allInactive
      ? {
          ...report,
          users: {
            ...report.users,
            inactive: [...report.users.inactive, { username: "dee" }],
          },
        }
      : ask(op, data);
  panel().querySelector("#report-users").click();
  await settle();
  org.request = ask;
  delete report.users.inactiveCount;
  assert.match(downloads.at(-1)[1], /inactive-users\.csv/);
  assert.match(downloads.at(-1)[0], /\r\ndee,/);
  // Each chart is one tab stop; arrow keys move between its bars.
  const chart = panel().querySelector(".admin-chart svg");
  const stops = () => [...chart.querySelectorAll('.chart-bar[tabindex="0"]')];
  assert.equal(stops().length, 1);
  assert.equal(stops()[0], [...chart.querySelectorAll(".chart-bar")].at(-1));
  stops()[0].focus();
  stops()[0].dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
  );
  assert.equal(stops().length, 1);
  assert.equal(d.ownerDocument.activeElement, stops()[0]);
  assert.equal(stops()[0], [...chart.querySelectorAll(".chart-bar")].at(-2));
  stops()[0].dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "Home", bubbles: true }),
  );
  assert.equal(stops()[0], chart.querySelector(".chart-bar"));
  // Arrow keys move between tabs.
  d.querySelector('[data-tab="overview"]').dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  await settle();
  assert.equal(d.querySelector('[aria-selected="true"]').dataset.tab, "people");
  assert.match(panel().textContent, /bob@fabrikam\.test/);
  assert.match(panel().textContent, /1 member(?!s)/);
  assert.match(panel().textContent, /awaiting sign-in/);
  const lastActive = () =>
    panel().querySelector("#people-rows tr td:nth-child(5)").textContent;
  const active = lastActive();
  assert.notEqual(active, "-");
  // The worker returns the saved record, which leaves out activity.
  responses["org.users.update"] = {
    user: {
      ...responses["org.users.list"].users[0],
      role: "guest",
      lastActive: null,
    },
  };
  const role = panel().querySelector('[data-role="u2"]');
  role.value = "guest";
  role.dispatchEvent(new w.Event("change"));
  await settle();
  delete responses["org.users.update"];
  assert.deepEqual(calls.at(-1), [
    "org.users.update",
    { uuid: "u2", role: "guest" },
  ]);
  const search = panel().querySelector("#people-search");
  search.value = "b";
  search.dispatchEvent(new w.Event("input"));
  await settle();
  assert.equal(lastActive(), active);
  search.value = "";
  search.dispatchEvent(new w.Event("input"));
  await settle();
  await audit("people");
  for (const tab of [
    "boards",
    "policies",
    "integrations",
    "security",
    "audit",
  ]) {
    d.querySelector(`[data-tab="${tab}"]`).click();
    await settle();
    assert.ok(!panel().querySelector('[role="alert"]'), `${tab} loads`);
    assert.equal(d.querySelector("#pwn"), null, `${tab} escapes names`);
    await audit(tab);
    if (tab === "boards")
      assert.match(panel().textContent, /1 board(?!s)[^]*1 guest(?!s)/);
    if (tab === "security") {
      // Webhook addresses break anywhere like the other technical values,
      // and the tables scroll on their own, so neither widens the dialog
      // on a phone.
      assert.equal(
        panel().querySelector("code[data-user-content]:not(dd code)")
          ?.textContent,
        "https://hooks.example.ca/x",
      );
      for (const table of panel().querySelectorAll(".admin-table"))
        assert.ok(table.parentElement.matches(".table-scroll"));
    }
    if (tab === "boards")
      // Team and space names are kept as written in any language.
      for (const id of ['#bf-team [value="t1"]', '#bf-space [value="s1"]'])
        assert.ok(panel().querySelector(id).hasAttribute("data-user-content"));
  }
  // Saving policies sends what was changed in the form.
  d.querySelector('[data-tab="policies"]').click();
  await settle();
  panel().querySelector("#p-ai").checked = false;
  panel()
    .querySelector("#policy-form")
    .dispatchEvent(new w.Event("submit", { cancelable: true }));
  await settle();
  const saved = calls.find(([op]) => op === "org.policy.set");
  assert.deepEqual(saved[1].policy, { ai: { enabled: false } });
  // The audit log exports CSV.
  d.querySelector('[data-tab="audit"]').click();
  await settle();
  panel().querySelector("#au-csv").click();
  await settle();
  assert.match(downloads.at(-1)[0], /board\.visibility\.link/);
  dom.window.close();
  for (const key of [
    "document",
    "localStorage",
    "NodeFilter",
    "HTMLElement",
    "Node",
    "Event",
  ])
    delete globalThis[key];
});

test("the join dialog also leads to setting up an organization", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const titles = [];
    const home = createOrganizationHome({
      org: { info: null, onChange() {}, request: async () => ({}) },
      modal: (title, html, ready) => {
        titles.push(title);
        const dialog = document.createElement("dialog");
        dialog.innerHTML = html;
        dialog.close = () => dialog.remove();
        document.body.append(dialog);
        ready(dialog);
        return dialog;
      },
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    home.joinDialog();
    document.querySelector("#org-join-setup").click();
    assert.deepEqual(titles, [
      "Join an organization",
      "Set up an organization",
    ]);
    assert.equal(document.querySelectorAll("dialog").length, 1);
    // Phones keep Join an organization, the way to both.
    const css = readFileSync(
      new URL("../src/organization/organization.css", import.meta.url),
      "utf8",
    );
    assert.ok(!/\.sidebar \.org-start\s*\{\s*display:\s*none/.test(css));
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("scrolling admin tables keep their hidden headings inside them", () => {
  // Screen reader only headings are absolutely positioned; without a
  // positioned scroll box they escape it and widen the dialog on phones.
  const css = readFileSync(
    new URL("../src/organization/organization.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.table-scroll\s*\{[^}]*position:\s*relative/);
  const source = readFileSync(
    new URL("../src/organization/admin-ui.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /class="table-scroll"[^]*class="sr-only"/);
});

test("notifications are worded in the reader's language", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  globalThis.localStorage = dom.window.localStorage;
  const { setLanguage } = await import("../src/i18n.js");
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    // The app loads planning's strings at start.
    await import("../src/planning/i18n.js");
    setLanguage("fr");
    const items = [
      {
        id: "1",
        type: "assignment",
        at: Date.UTC(2026, 8, 26, 12),
        actor: { username: "Bob" },
        title: "Draft the brief",
        due: "2026-10-01",
        text: "Bob: Draft the brief (due 2026-10-01)",
      },
      {
        id: "2",
        type: "alert",
        at: Date.UTC(2026, 8, 26, 12),
        label: "A guest joined a board",
        who: "Dee",
        target: "Plan",
        text: 'A guest joined a board: Dee "Plan" (2026-09-26T12:00:00Z)',
      },
      // Guests who joined together, told of in one alert.
      {
        id: "8",
        type: "alert",
        at: Date.UTC(2026, 8, 26, 12),
        read: true,
        label: "A guest joined a board",
        count: 29,
        target: "Plan",
        text: '29 more guests joined a board: "Plan" (2026-09-26T12:10:00Z)',
      },
      {
        id: "4",
        type: "assignment",
        at: Date.UTC(2026, 8, 26, 12),
        actor: { username: "Bob" },
        title: "Untitled task",
        more: 3,
      },
      // Saved before notifications carried their parts.
      { id: "3", type: "mention", at: 0, text: "Alice: hello" },
      {
        id: "5",
        type: "reply",
        at: 0,
        read: true,
        actor: { username: "Cam" },
        excerpt: "Merci",
        text: "Cam: Merci",
      },
      {
        id: "6",
        type: "assignment",
        at: 0,
        read: true,
        anonymous: true,
        title: "Revue",
        text: "A participant: Revue",
      },
      // An alert from an older worker: its text carries the time, which the
      // notification already shows beside it.
      {
        id: "7",
        type: "alert",
        at: 0,
        read: true,
        text: 'Organization policy changed: nj "Fabrikam" (2026-09-26T22:50:58.759Z)',
      },
    ];
    let dialog;
    const home = createOrganizationHome({
      org: {
        info: { name: "Fabrikam", role: "member", user: {} },
        onChange() {},
        request: async (op) =>
          op === "notifications.list" ? { items, unread: 4 } : {},
      },
      modal: (title, html, ready) => {
        dialog = document.createElement("dialog");
        dialog.innerHTML = html;
        document.body.append(dialog);
        ready(dialog);
        return dialog;
      },
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    await home.notifications();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      [...dialog.querySelectorAll("[data-user-content]")].map(
        (s) => s.textContent,
      ),
      [
        // French sets a colon apart with a space.
        "Bob : Draft the brief (échéance le 1 oct. 2026)",
        "Un invité s’est joint à un tableau : Dee « Plan »",
        "29 autres invités se sont joints à un tableau : « Plan »",
        "Bob : Tâche sans titre et 3 autres",
        "Alice: hello",
        "Cam : Merci",
        "Un participant : Revue",
        'Organization policy changed: nj "Fabrikam"',
      ],
    );
    // The sidebar's count is read out with its meaning.
    const aside = document.createElement("aside");
    aside.innerHTML = home.sidebar();
    document.body.append(aside);
    home.bind(aside);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const button = aside.querySelector('[data-org-action="notifications"]');
    assert.equal(
      button.querySelector(".nav-badge [aria-hidden]").textContent,
      "4",
    );
    assert.equal(
      button.querySelector(".nav-badge .sr-only").textContent,
      "4 non lues",
    );
    // Unread notifications say so, not only in bold.
    assert.deepEqual(
      [...dialog.querySelectorAll(".unread .notification .sr-only")].map(
        (s) => s.textContent,
      ),
      ["Non lue", "Non lue", "Non lue", "Non lue"],
    );
    // Notifications about no board are text, not disabled buttons.
    assert.equal(dialog.querySelector(".notification[disabled]"), null);
    assert.equal(dialog.querySelector('[data-note="2"]').tagName, "DIV");
    // Only a count is announced, not each notification.
    assert.equal(dialog.querySelector("[aria-live]"), null);
    assert.equal(
      dialog.querySelector("#notification-count").textContent,
      "8 notifications",
    );
  } finally {
    setLanguage("en");
    for (const key of keys) delete globalThis[key];
    delete globalThis.localStorage;
  }
});

test("the unread badge counts the notifications the dialog lists and drops one once it is opened", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const items = [
      { id: "1", type: "mention", at: 2, board: "r1", thread: "c1" },
      { id: "2", type: "mention", at: 1, board: "r1", thread: "c2" },
    ];
    const limits = [];
    let dialog;
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { name: "Fabrikam", role: "member", user: {} },
        onChange() {},
        request: async (op, input) => {
          if (op === "notifications.read")
            for (const n of items) if (input.ids.includes(n.id)) n.read = true;
          if (op !== "notifications.list") return {};
          limits.push(input.limit);
          return { items, unread: items.filter((n) => !n.read).length };
        },
      },
      modal: (title, html, ready) => {
        dialog = document.createElement("dialog");
        dialog.close = () => {};
        dialog.innerHTML = html;
        document.body.append(dialog);
        ready(dialog);
        return dialog;
      },
      toast() {},
      icon: () => "",
      // Opening the board fails, so the library stays on screen.
      openShared: async () => {
        throw Error("Board not found.");
      },
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    const aside = document.createElement("aside");
    aside.innerHTML = home.sidebar();
    document.body.append(aside);
    home.bind(aside);
    await settle();
    const badge = () =>
      aside.querySelector(".nav-badge [aria-hidden]")?.textContent;
    assert.equal(badge(), "2");
    await home.notifications();
    await settle();
    dialog.querySelector('[data-note="1"]').click();
    await settle();
    assert.equal(badge(), "1");
    assert.ok(limits.length >= 3);
    assert.ok(new Set(limits).size === 1, `limits ${limits}`);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("the unread badge stops at 99+ and Mark all as read asks until none are left", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    // 350 unread, of which the newest 100 are listed; the worker marks
    // 150 a request here.
    let left = 350;
    const reads = [];
    let dialog;
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { name: "Fabrikam", role: "member", user: {} },
        onChange() {},
        request: async (op, input) => {
          if (op === "notifications.read") {
            reads.push(input);
            left = Math.max(0, left - 150);
            return { ok: true, more: left > 0 };
          }
          if (op !== "notifications.list") return {};
          const items = Array.from({ length: input.limit }, (_, n) => ({
            id: `n${n}`,
            type: "mention",
            at: 1000 - n,
            read: n >= left,
          }));
          return { items, unread: items.filter((n) => !n.read).length };
        },
      },
      modal: (title, html, ready) => {
        dialog = document.createElement("dialog");
        dialog.close = () => {};
        dialog.innerHTML = html;
        document.body.append(dialog);
        ready(dialog);
        return dialog;
      },
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    const aside = document.createElement("aside");
    aside.innerHTML = home.sidebar();
    document.body.append(aside);
    home.bind(aside);
    await settle();
    const badge = aside.querySelector(".nav-badge");
    assert.equal(badge.querySelector("[aria-hidden]").textContent, "99+");
    assert.equal(
      badge.querySelector(".sr-only").textContent,
      "More than 99 unread",
    );
    await home.notifications();
    await settle();
    dialog.querySelector("#notify-read").click();
    await settle();
    await settle();
    assert.equal(reads.length, 3);
    assert.ok(reads.every((r) => r.all === true));
    assert.equal(left, 0);
    assert.equal(badge.hidden, true);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("a notification opens the task or comment it is about", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const items = [
      { id: "1", type: "assignment", at: 1, board: "r1", item: "task1" },
      { id: "2", type: "mention", at: 1, board: "r1", thread: "c1" },
    ];
    const opened = [];
    let dialog;
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { name: "Fabrikam", role: "member", user: {} },
        onChange() {},
        request: async (op) => (op === "notifications.list" ? { items } : {}),
      },
      modal: (title, html, ready) => {
        dialog = document.createElement("dialog");
        dialog.close = () => {};
        dialog.innerHTML = html;
        document.body.append(dialog);
        ready(dialog);
        return dialog;
      },
      toast() {},
      icon: () => "",
      openShared: async (...args) => {
        opened.push(args);
      },
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    await home.notifications();
    await settle();
    dialog.querySelector('[data-note="1"]').click();
    await settle();
    dialog.querySelector('[data-note="2"]').click();
    await settle();
    assert.deepEqual(opened, [
      [
        "https://org.puter.work",
        "r1",
        { thread: undefined, objectId: "task1" },
      ],
      ["https://org.puter.work", "r1", { thread: "c1", objectId: undefined }],
    ]);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("the email notification choice shows what is saved", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const toasts = [];
    let dialog,
      offline = true;
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: {
          name: "Fabrikam",
          role: "member",
          user: { emailVerified: true },
        },
        onChange() {},
        refresh: async () => {},
        request: async (op) => {
          if (op === "prefs.set" && offline) throw Error("Network error");
          return op === "notifications.list" ? { items: [] } : {};
        },
      },
      modal: (title, html, ready) => {
        dialog = document.createElement("dialog");
        dialog.innerHTML = html;
        document.body.append(dialog);
        ready(dialog);
        return dialog;
      },
      toast: (message) => toasts.push(message),
      icon: () => "",
      async openShared() {},
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    await home.notifications();
    const box = dialog.querySelector("#notify-email");
    assert.equal(box.checked, true);
    const error = dialog.querySelector("#notify-error");
    box.click();
    await settle();
    assert.equal(box.checked, true);
    // The reason stays beside the box rather than in a fading notification.
    assert.equal(error.hidden, false);
    assert.equal(error.getAttribute("role"), "alert");
    assert.equal(error.textContent, "Network error");
    assert.deepEqual(toasts, []);
    offline = false;
    box.click();
    await settle();
    assert.equal(box.checked, false);
    assert.equal(error.hidden, true);
    assert.deepEqual(toasts, []);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("notifications are gathered from the servers of shared boards, not only the organization's", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const server = (n) => `https://w${n}.puter.work`;
    // Someone in no organization, invited to boards on twelve workers; the
    // second is unreachable.
    const kept = {
      [server(1)]: [
        { id: "a", type: "mention", at: 30, board: "r1", thread: "c1" },
        { id: "b", type: "reply", at: 10, board: "r1", thread: "c2" },
      ],
      [server(3)]: [
        { id: "a", type: "assignment", at: 20, board: "r3", item: "t1" },
        { id: "c", type: "reply", at: 5, read: true, board: "r3" },
      ],
    };
    const asked = [],
      reads = [],
      opened = [];
    let dialog;
    const home = createOrganizationHome({
      org: { info: null, onChange() {} },
      sharedServers: () => [
        server(1),
        server(2),
        server(1),
        ...Array.from({ length: 10 }, (_, n) => server(n + 3)),
      ],
      request: async (at, op, input) => {
        if (op === "notifications.list") asked.push(at);
        if (at === server(2)) throw Error("Could not reach the shared board.");
        const items = kept[at] || [];
        if (op === "notifications.read") {
          reads.push([at, input]);
          for (const n of items)
            if (input.all || input.ids.includes(n.id)) n.read = true;
          return { ok: true, more: false };
        }
        return { items, unread: items.filter((n) => !n.read).length };
      },
      modal: (title, html, ready) => {
        dialog = document.createElement("dialog");
        dialog.close = () => {};
        dialog.innerHTML = html;
        document.body.append(dialog);
        ready(dialog);
        return dialog;
      },
      toast() {},
      icon: () => "",
      openShared: async (...args) => {
        opened.push(args);
      },
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    // The library offers Notifications without an organization.
    const nav = document.createElement("nav");
    nav.innerHTML = home.notificationsItem();
    document.body.append(nav);
    home.bind(nav);
    await settle();
    // Ten servers are asked, each once, at the same time.
    assert.equal(asked.length, 10);
    assert.equal(new Set(asked).size, 10);
    assert.ok(!asked.includes(server(12)));
    const badge = () =>
      nav.querySelector(".nav-badge [aria-hidden]")?.textContent;
    assert.equal(badge(), "3");
    await home.notifications();
    await settle();
    // Newest first across servers; the email choice belongs to an
    // organization, and the unreachable server is said.
    assert.deepEqual(
      [...dialog.querySelectorAll(".notification-kind")].map(
        (s) => s.textContent,
      ),
      ["Mention", "Assignment", "Reply", "Reply"],
    );
    assert.equal(dialog.querySelector("#notify-email"), null);
    assert.equal(
      dialog.querySelector("#notify-error").textContent,
      "Some notifications could not be loaded.",
    );
    // The assignment shares an id with the mention, and opens its own board
    // on its own server.
    dialog.querySelectorAll("[data-note]")[1].click();
    await settle();
    assert.deepEqual(reads, [[server(3), { ids: ["a"] }]]);
    assert.deepEqual(opened, [
      [server(3), "r3", { thread: undefined, objectId: "t1" }],
    ]);
    assert.equal(badge(), "2");
    reads.length = 0;
    dialog.querySelector("#notify-read").click();
    await settle();
    await settle();
    assert.deepEqual(reads.map(([at]) => at).sort(), [server(1), server(3)]);
    assert.equal(nav.querySelector(".nav-badge").hidden, true);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("an organization member's notifications include those of boards shared from elsewhere", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const orgServer = "https://org.puter.work",
      other = "https://friend.puter.work";
    const asked = [];
    const home = createOrganizationHome({
      org: {
        server: orgServer,
        info: { name: "Fabrikam", role: "member", user: {} },
        onChange() {},
        request: async (op) => {
          asked.push(orgServer);
          return op === "notifications.list"
            ? { items: [{ id: "1", type: "mention", at: 1 }], unread: 1 }
            : {};
        },
      },
      // The organization's own boards are asked through the organization.
      sharedServers: () => [orgServer, other],
      request: async (at, op) => {
        asked.push(at);
        return op === "notifications.list"
          ? { items: [{ id: "1", type: "reply", at: 2 }], unread: 1 }
          : {};
      },
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    assert.equal(home.notificationsItem(), "");
    const aside = document.createElement("aside");
    aside.innerHTML = home.sidebar();
    document.body.append(aside);
    home.bind(aside);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(asked.sort(), [other, orgServer]);
    assert.equal(
      aside.querySelector(".nav-badge [aria-hidden]").textContent,
      "2",
    );
    // Showing the library again soon after reuses the count.
    home.bind(aside);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(asked.length, 2);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("joining from a link confirms the organization before switching", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const used = [];
    const org = {
      server: "https://acme.puter.work",
      info: { name: "ACME", role: "member", configured: true },
      isMember: true,
      onChange() {},
      preview: async (server) => ({ server, info: { name: "ACME Corp" } }),
      use: async (server) => used.push(server),
      request: async () => ({}),
    };
    let dialog;
    const home = createOrganizationHome({
      org,
      modal: (title, html, ready) => {
        dialog = document.createElement("dialog");
        dialog.innerHTML = html;
        dialog.close = () => dialog.remove();
        document.body.append(dialog);
        ready(dialog);
        return dialog;
      },
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    home.joinDialog("https://whiteboard.test/#org=https://evil.puter.work");
    const submit = () =>
      dialog
        .querySelector("#org-join")
        .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    submit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(used, [], "nothing changes on the first press");
    assert.match(
      dialog.querySelector("#org-join-status").textContent,
      /ACME Corp at evil\.puter\.work\?.*replaces ACME/,
    );
    submit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(used, ["https://evil.puter.work"]);
  } finally {
    for (const key of keys) delete globalThis[key];
    dom.window.close();
  }
});

test("a space that cannot be created stays explained in its form", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const toasts = [];
    let dialog,
      offline = true;
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { role: "member" },
        isMember: true,
        onChange() {},
        request: async (op) => {
          if (op === "spaces.create") {
            if (offline) throw Error("Network error");
            return { space: { id: "s1", name: "Design" } };
          }
          return { spaces: [], teams: [], boards: [] };
        },
      },
      modal: (title, html, ready) => {
        dialog = document.createElement("dialog");
        dialog.innerHTML = html;
        dialog.close = () => dialog.remove();
        document.body.append(dialog);
        ready(dialog);
        return dialog;
      },
      toast: (message) => toasts.push(message),
      icon: () => "",
      async openShared() {},
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    await home.renderBoards(document.querySelector("#grid"));
    document.querySelector("#of-space-new").click();
    const form = dialog.querySelector("form"),
      error = dialog.querySelector("#space-error");
    dialog.querySelector("#space-name").value = "Design";
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await settle();
    assert.ok(form.isConnected, "The form stays open with its name");
    assert.equal(dialog.querySelector("#space-name").value, "Design");
    assert.equal(error.hidden, false);
    assert.equal(error.getAttribute("role"), "alert");
    assert.equal(error.textContent, "Network error");
    assert.deepEqual(toasts, []);
    offline = false;
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    assert.equal(error.hidden, true, "Trying again clears it");
    await settle();
    assert.equal(form.isConnected, false);
  } finally {
    for (const key of keys) delete globalThis[key];
    dom.window.close();
  }
});

test("space, team, and new owner choices outside the console are listed by name", async () => {
  const dom = new JSDOM(
    '<!doctype html><html lang="en"><body><div id="grid"></div></body></html>',
    { url: "https://whiteboard.test" },
  );
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const { createBoardAccess } =
      await import("../src/organization/board-access.js");
    const named = (...names) => names.map((name, n) => ({ id: `i${n}`, name }));
    const spaces = named("Team 10", "écoles", "Team 2", "Archive");
    const teams = named("Sample team 11", "Sample team 3", "Sample team 1");
    const server = "https://org.puter.work";
    const org = {
      server,
      info: { role: "member", configured: true },
      isMember: true,
      onChange() {},
      policy: () => null,
      allows: () => false,
      request: async (op) =>
        op === "spaces.list"
          ? { spaces: structuredClone(spaces) }
          : op === "teams.list"
            ? { teams: structuredClone(teams) }
            : { boards: [] },
    };
    const shown = (root, id) =>
      [...root.querySelectorAll(`#${id} option`)]
        .slice(1)
        .map((o) => o.textContent);
    const home = createOrganizationHome({
      org,
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    const grid = document.querySelector("#grid");
    await home.renderBoards(grid);
    const spaceOrder = ["Archive", "écoles", "Team 2", "Team 10"],
      teamOrder = ["Sample team 1", "Sample team 3", "Sample team 11"];
    assert.deepEqual(shown(grid, "of-space"), spaceOrder);
    assert.deepEqual(shown(grid, "of-team"), teamOrder);
    // Board settings, with its new owner choices.
    const members = ["Zoé", "alex", "Marc 10", "Marc 9"].map((username, n) => ({
      uuid: `u${n}`,
      username,
      role: "editor",
    }));
    const session = {
      role: "owner",
      server,
      settings: { visibility: "private" },
      request: async (op) =>
        op === "members" ? { members } : { settings: {} },
    };
    let d;
    const access = createBoardAccess({
      org,
      session: () => session,
      board: () => ({ items: [] }),
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast() {},
      icon: () => "",
    });
    await access.settings();
    assert.deepEqual(shown(d, "bs-space"), spaceOrder);
    assert.deepEqual(shown(d, "bs-team"), teamOrder);
    assert.deepEqual(shown(d, "bs-transfer"), [
      "alex",
      "Marc 9",
      "Marc 10",
      "Zoé",
    ]);
  } finally {
    for (const key of keys) delete globalThis[key];
    dom.window.close();
  }
});

test("a slow organization board search never overwrites a newer one", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const pending = [];
    const board = (room, title) => ({ room, title, visibility: "private" });
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { role: "member" },
        isMember: true,
        onChange() {},
        request: (op) =>
          op === "org.boards"
            ? new Promise((resolve) => pending.push(resolve))
            : Promise.resolve({ spaces: [], teams: [] }),
      },
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    const grid = document.querySelector("#grid");
    const first = home.renderBoards(grid);
    await new Promise((r) => setTimeout(r, 0));
    const second = home.renderBoards(grid);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(pending.length, 2);
    pending[1]({ boards: [board("r1", "Newer")] });
    await second;
    pending[0]({ boards: [board("r2", "Older"), board("r3", "Older too")] });
    await first;
    assert.equal(document.querySelector("#org-count").textContent, "1 board");
    assert.deepEqual(
      [...grid.querySelectorAll(".board-info h3")].map((h) => h.textContent),
      ["Newer"],
    );
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("organization board counts group their digits", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    let total = 1500;
    const boards = (n) =>
      Array.from({ length: n }, (_, i) => ({ room: `r${i}`, title: `B ${i}` }));
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { role: "member" },
        isMember: true,
        onChange() {},
        request: async (op) =>
          op === "org.boards"
            ? { boards: boards(Math.min(total, 1200)), total }
            : { spaces: [], teams: [] },
      },
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    const grid = document.querySelector("#grid");
    const count = () => document.querySelector("#org-count").textContent;
    await home.renderBoards(grid);
    assert.equal(count(), "Showing 1,200 of 1,500 boards.");
    total = 1200;
    await home.renderBoards(grid);
    assert.equal(count(), "1,200 boards");
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("the organization board directory asks for the boards after the last shown, and lists each once", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const board = (n) => ({
      room: `r${n}`,
      title: `Board ${n}`,
      visibility: "private",
    });
    const asked = [];
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { role: "member" },
        isMember: true,
        onChange() {},
        async request(op, input) {
          if (op !== "org.boards") return { spaces: [], teams: [] };
          asked.push(input.after ?? input.offset);
          // A server that cannot follow a board lists one again.
          return input.after
            ? { boards: [board(1), board(2)], total: 3, next: null }
            : { boards: [board(0), board(1)], total: 3, next: "after-r1" };
        },
      },
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    const grid = document.querySelector("#grid");
    await home.renderBoards(grid);
    const cards = () => grid.querySelectorAll(".board-open");
    document.querySelector("#org-more").click();
    for (let n = 0; n < 20 && cards().length < 3; n++)
      await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(asked, [undefined, "after-r1"]);
    assert.deepEqual(
      [...cards()].map((c) => c.dataset.orgOpen),
      ["r0", "r1", "r2"],
    );
    assert.equal(document.querySelector("#org-count").textContent, "3 boards");
    assert.equal(document.querySelector("#org-more"), null);
    assert.equal(document.activeElement, cards()[2]);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("the organization board directory shows more boards past the first 200", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const all = Array.from({ length: 250 }, (_, n) => ({
      room: `r${n}`,
      title: `Board ${n}`,
      visibility: "private",
    }));
    const asked = [];
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { role: "member" },
        isMember: true,
        onChange() {},
        async request(op, input) {
          if (op !== "org.boards") return { spaces: [], teams: [] };
          asked.push(input.offset);
          const from = input.offset || 0;
          return { boards: all.slice(from, from + 200), total: all.length };
        },
      },
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    const grid = document.querySelector("#grid");
    await home.renderBoards(grid);
    const cards = () => grid.querySelectorAll(".board-open");
    assert.equal(cards().length, 200);
    assert.equal(
      document.querySelector("#org-count").textContent,
      "Showing 200 of 250 boards.",
    );
    document.querySelector("#org-more").click();
    for (let n = 0; n < 20 && cards().length < 250; n++)
      await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(asked, [undefined, 200]);
    assert.equal(cards().length, 250);
    assert.equal(
      document.querySelector("#org-count").textContent,
      "250 boards",
    );
    assert.equal(document.querySelector("#org-more"), null);
    assert.equal(document.activeElement, cards()[200]);
    assert.equal(
      new Set([...grid.querySelectorAll("[id^=org-card-]")].map((e) => e.id))
        .size,
      500,
      "Card descriptions keep unique ids",
    );
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("an admin action that finishes after another tab opened changes nothing", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const entry = (id) => ({
      id,
      at: 1,
      time: new Date(1).toISOString(),
      category: "sharing",
      action: `action.${id}`,
      actor: { username: "bob" },
      target: { type: "board", id: "r1", name: "Kickoff" },
    });
    let release;
    const toasts = [];
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op, data) => {
        if (op === "org.audit" && data.cursor)
          return new Promise((resolve) => (release = resolve));
        if (op === "org.audit") return { entries: [entry("a1")], cursor: "c" };
        if (op === "org.users.list")
          return { owner: { uuid: "u1", username: "alice" }, users: [] };
        if (op === "teams.list") return { teams: [] };
        return {};
      },
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast: (m) => toasts.push(m),
      icon: () => "",
      download() {},
      migrate() {},
    });
    const d = admin.open();
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    d.querySelector('[data-tab="audit"]').click();
    await settle();
    d.querySelector("#au-more").click();
    await settle();
    d.querySelector('[data-tab="people"]').click();
    await settle();
    const before = d.querySelector("#admin-panel").innerHTML;
    release({ entries: [entry("a2")], cursor: null });
    await settle();
    assert.equal(d.querySelector("#admin-panel").innerHTML, before);
    assert.deepEqual(toasts, []);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("a failed admin action stays explained in the console instead of a fading notification", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const entry = (id) => ({
      id,
      at: 1,
      time: new Date(1).toISOString(),
      category: "sharing",
      action: `action.${id}`,
      actor: { username: "bob" },
      target: { type: "board", id: "r1", name: "Kickoff" },
    });
    let offline = true;
    const toasts = [];
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op, data) => {
        if (op === "org.audit" && data.cursor) {
          if (offline) throw Error("The organization service is unavailable.");
          return { entries: [entry("a2")], cursor: "d" };
        }
        if (op === "org.audit") return { entries: [entry("a1")], cursor: "c" };
        if (op === "org.users.list")
          return { owner: { uuid: "u1", username: "alice" }, users: [] };
        if (op === "teams.list") return { teams: [] };
        return {};
      },
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast: (m) => toasts.push(m),
      icon: () => "",
      download() {},
      migrate() {},
    });
    const d = admin.open();
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const error = d.querySelector("#admin-error");
    await settle();
    d.querySelector('[data-tab="audit"]').click();
    await settle();
    assert.equal(error.hidden, true);
    d.querySelector("#au-more").click();
    await settle();
    assert.equal(error.hidden, false);
    assert.equal(error.getAttribute("role"), "alert");
    assert.equal(error.textContent, "The organization service is unavailable.");
    assert.deepEqual(toasts, [], "No second, fading copy");
    // Trying again clears it.
    offline = false;
    d.querySelector("#au-more").click();
    assert.equal(error.hidden, true);
    await settle();
    assert.equal(error.hidden, true);
    // So does opening another tab.
    offline = true;
    d.querySelector("#au-more").click();
    await settle();
    assert.equal(error.hidden, false);
    d.querySelector('[data-tab="people"]').click();
    assert.equal(error.hidden, true);
    await settle();
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("an invitation link created after another tab opened shows no error", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = [
    "document",
    "localStorage",
    "NodeFilter",
    "HTMLElement",
    "location",
  ];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    let release;
    const toasts = [];
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op) => {
        if (op === "org.invite")
          return new Promise((resolve) => (release = resolve));
        if (op === "org.users.list")
          return { owner: { uuid: "u1", username: "alice" }, users: [] };
        if (op === "teams.list") return { teams: [] };
        if (op === "org.audit") return { entries: [], cursor: null };
        return {};
      },
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast: (m) => toasts.push(m),
      icon: () => "",
      download() {},
    });
    const d = admin.open("people");
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    d.querySelector("#invite-people").click();
    await settle();
    d.querySelector('[data-tab="audit"]').click();
    await settle();
    const before = d.querySelector("#admin-panel").innerHTML;
    release({ token: "secret-token" });
    await settle();
    assert.deepEqual(toasts, []);
    assert.equal(d.querySelector("#admin-status").textContent, "");
    assert.equal(d.querySelector("#admin-panel").innerHTML, before);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("the audit log date filters read Du and Au in French", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  const { setLanguage } = await import("../src/i18n.js");
  try {
    // The app loads the workshop strings, with their own "From" and "To",
    // before the organization ones.
    await import("../src/facilitation/strings.js");
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    setLanguage("fr");
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op) =>
          op === "org.audit" ? { entries: [], cursor: null } : {},
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("audit");
    await new Promise((r) => setTimeout(r, 20));
    const label = (id) =>
      d.querySelector(`#${id}`).closest("label").textContent;
    assert.equal(label("au-from"), "Du");
    assert.equal(label("au-to"), "Au");
    const { t } = await import("../src/i18n.js");
    assert.equal(t("From"), "De");
    assert.equal(t("To"), "À");
    const scrolling = d.querySelector(".table-scroll");
    assert.equal(scrolling.tabIndex, 0);
    assert.equal(scrolling.getAttribute("aria-label"), "Journal d’audit");
    scrolling.focus();
    assert.equal(document.activeElement, scrolling);
  } finally {
    setLanguage("en");
    for (const key of keys) delete globalThis[key];
  }
});

test("the audit log reads on past empty pages to show the events a filter matches", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const entry = (id) => ({
      id,
      at: 1,
      time: new Date(1).toISOString(),
      category: "sharing",
      action: `action.${id}`,
      actor: { username: "bob" },
      target: { type: "board", id: "r1", name: "Kickoff" },
    });
    // The worker stops after a bounded number of records with a cursor,
    // so a rare filter can bring empty pages before its events.
    const pages = {
      "": { entries: [], cursor: "c3" },
      c3: { entries: [], cursor: "c2" },
      c2: { entries: [entry("a1")], cursor: "c1" },
      c1: { entries: [], cursor: null },
    };
    const asked = [];
    const downloads = [];
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op, data) => {
        if (op === "org.audit") {
          asked.push(data.cursor || "");
          return pages[data.cursor || ""];
        }
        if (op === "org.users.list")
          return { owner: { uuid: "u1", username: "alice" }, users: [] };
        if (op === "teams.list") return { teams: [] };
        return {};
      },
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download: (...args) => downloads.push(args),
      migrate() {},
    });
    const d = admin.open();
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    d.querySelector('[data-tab="audit"]').click();
    await settle();
    assert.equal(d.querySelectorAll(".admin-table tbody tr").length, 1);
    assert.ok(d.querySelector("#au-more"));
    d.querySelector("#au-json").click();
    await settle();
    assert.deepEqual(
      JSON.parse(downloads.at(-1)[0]).map((e) => e.id),
      ["a1"],
    );
    assert.equal(asked.at(-1), "c1", "the export reads past empty pages");
    d.querySelector("#au-more").click();
    await settle();
    assert.equal(d.querySelector("#au-more"), null);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("the audit log export includes pages not loaded on screen", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const entry = (id) => ({
      id,
      at: 1,
      time: new Date(1).toISOString(),
      category: "sharing",
      action: `action.${id}`,
      actor: { username: "bob" },
      target: { type: "board", id: "r1", name: "Kickoff" },
    });
    const pages = {
      "": { entries: [entry("a3")], cursor: "a3" },
      a3: { entries: [entry("a2")], cursor: "a2" },
      a2: { entries: [entry("a1")], cursor: null },
    };
    const downloads = [];
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op, data) => {
        if (op === "org.audit") return pages[data.cursor || ""];
        if (op === "org.users.list")
          return { owner: { uuid: "u1", username: "alice" }, users: [] };
        if (op === "teams.list") return { teams: [] };
        return {};
      },
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download: (...args) => downloads.push(args),
      migrate() {},
    });
    const d = admin.open();
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    d.querySelector('[data-tab="audit"]').click();
    await settle();
    assert.equal(d.querySelectorAll(".admin-table tbody tr").length, 1);
    // A timestamp is one piece: its cell is marked so it never wraps.
    assert.ok(d.querySelector(".admin-table tbody tr td.date-cell"));
    const scrolling = d.querySelector(".table-scroll");
    assert.equal(scrolling.tabIndex, 0);
    assert.equal(scrolling.getAttribute("role"), "region");
    assert.equal(scrolling.getAttribute("aria-label"), "Audit log");
    scrolling.focus();
    assert.equal(document.activeElement, scrolling);
    Object.defineProperties(scrolling, {
      clientWidth: { value: 200 },
      scrollWidth: { value: 500 },
    });
    const right = new dom.window.KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    scrolling.dispatchEvent(right);
    assert.equal(right.defaultPrevented, true);
    assert.ok(scrolling.scrollLeft > 0);
    const left = new dom.window.KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    scrolling.dispatchEvent(left);
    assert.equal(left.defaultPrevented, true);
    assert.equal(scrolling.scrollLeft, 0);
    for (const options of [
      { key: "Tab" },
      { key: "ArrowRight", ctrlKey: true },
      { key: "ArrowRight", altKey: true },
      { key: "ArrowRight", isComposing: true },
    ]) {
      const event = new dom.window.KeyboardEvent("keydown", {
        ...options,
        bubbles: true,
        cancelable: true,
      });
      scrolling.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false);
      assert.equal(scrolling.scrollLeft, 0);
    }
    const previousContent = scrolling.textContent;
    d.querySelector("#audit-filters").dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await settle();
    const refreshed = d.querySelector(".table-scroll");
    assert.notEqual(refreshed, scrolling);
    assert.equal(refreshed.textContent, previousContent);
    assert.equal(document.activeElement, refreshed);
    d.querySelector("#au-json").click();
    await settle();
    assert.deepEqual(
      JSON.parse(downloads.at(-1)[0]).map((e) => e.id),
      ["a3", "a2", "a1"],
    );
    // Loading the last page removes its button; the keyboard stays in the
    // panel instead of falling back to the page.
    d.querySelector("#au-more").focus();
    d.querySelector("#au-more").click();
    await settle();
    assert.equal(document.activeElement.id, "au-more");
    d.querySelector("#au-more").click();
    await settle();
    assert.equal(d.querySelector("#au-more"), null);
    assert.equal(d.querySelectorAll(".admin-table tbody tr").length, 3);
    assert.equal(document.activeElement, d.querySelector("#admin-panel"));
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("a change finishing after another tab opened keeps that tab open", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    let release;
    const deleted = [];
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op, data) => {
        if (op === "teams.delete") {
          deleted.push(data.id);
          if (deleted.length === 1)
            return new Promise((resolve) => (release = resolve));
          return {};
        }
        if (op === "org.users.list")
          return { owner: { uuid: "u1", username: "alice" }, users: [] };
        if (op === "teams.list")
          return {
            teams: [
              { id: "t1", name: "Design", members: [] },
              { id: "t2", name: "Research", members: [] },
            ],
          };
        if (op === "org.audit") return { entries: [], cursor: null };
        return {};
      },
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("people");
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    const remove = d.querySelector('[data-delete-team="t1"]');
    remove.click();
    remove.click();
    await settle();
    d.querySelector('[data-tab="audit"]').click();
    await settle();
    release({});
    await settle();
    const selected = () =>
      d.querySelector('[role="tab"][aria-selected="true"]').dataset.tab;
    assert.equal(selected(), "audit");
    assert.ok(d.querySelector("#audit-filters"));
    // A change finishing on its own tab still shows the result.
    d.querySelector('[data-tab="people"]').click();
    await settle();
    const other = d.querySelector('[data-delete-team="t2"]');
    other.click();
    other.click();
    await settle();
    assert.deepEqual(deleted, ["t1", "t2"]);
    assert.equal(selected(), "people");
    assert.ok(d.querySelector('[data-delete-team="t2"]:not([data-confirmed])'));
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("policy numbers, key scopes, and webhook events from the server never become markup", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const w = dom.window;
  const keys = [
    "document",
    "localStorage",
    "NodeFilter",
    "HTMLElement",
    "Node",
    "Event",
  ];
  for (const key of keys) globalThis[key] = w[key];
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const { normalizePolicy } = await import("../worker/org.js");
    const policy = normalizePolicy({ name: "Fabrikam" });
    policy.guestExpiryDays = '"><img id="pwn-days">';
    policy.retention.auditDays = '"><img id="pwn-audit">';
    const responses = {
      "org.policy.get": { policy, secrets: {}, siem: null, owner: null },
      "apikeys.list": { keys: [], scopes: ['<img id="pwn-scope">'] },
      "webhooks.list": {
        webhooks: [],
        events: ['"><img id="pwn-event">', '<img id="pwn-code">'],
        pending: 1,
      },
    };
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op) => responses[op] || { ok: true, policy: {} },
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        d.showModal();
        ready?.(d);
        return d;
      },
      toast: () => {},
      icon: () => "",
      download: () => {},
      migrate: () => {},
    });
    const d = admin.open();
    const settle = () => new Promise((r) => setTimeout(r, 20));
    for (const tab of ["policies", "security"]) {
      await settle();
      d.querySelector(`[data-tab="${tab}"]`).click();
      await settle();
      assert.equal(d.querySelector('[id^="pwn"]'), null, tab);
    }
    assert.equal(
      d.querySelector('[name="k-scope"]').value,
      '<img id="pwn-scope">',
    );
    assert.match(d.textContent, / 1 delivery waiting to retry\./);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("organization board cards count one object in the singular", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: {
          role: "member",
          name: "Fabrikam",
          user: { emailVerified: true },
        },
        onChange() {},
        request: async (op) =>
          op === "notifications.list"
            ? { unread: 0, items: [] }
            : op === "org.boards"
              ? {
                  boards: [
                    { room: "r1", title: "One", objectCount: 1 },
                    { room: "r2", title: "Two", objectCount: 2 },
                  ],
                }
              : {},
      },
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    await home.renderBoards(document.querySelector("#grid"));
    assert.deepEqual(
      [...document.querySelectorAll(".org-preview")].map((el) =>
        el.textContent.trim(),
      ),
      ["1 object", "2 objects"],
    );
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("numbers from the organization's server never become markup", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const markup = '<img id="pwn" src="x">';
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: {
          role: "member",
          name: "Fabrikam",
          user: { emailVerified: true },
        },
        onChange() {},
        request: async (op) =>
          op === "notifications.list"
            ? { unread: markup, items: [] }
            : op === "org.boards"
              ? {
                  boards: [
                    {
                      room: "r1",
                      title: "Plan",
                      visibility: "private",
                      objectCount: markup,
                    },
                  ],
                }
              : {},
      },
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    await home.refreshBadge();
    document.body.insertAdjacentHTML("beforeend", home.sidebar());
    await home.renderBoards(document.querySelector("#grid"));
    assert.equal(document.querySelector("#pwn"), null);
    assert.match(document.querySelector(".org-preview").textContent, /^0 /);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("the organization library lists, approves, removes, uses, and shares templates", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = [
    "document",
    "HTMLElement",
    "Node",
    "Event",
    "NodeFilter",
    "CSS",
  ];
  for (const key of keys) globalThis[key] = dom.window[key];
  globalThis.CSS ??= { escape: (s) => s };
  try {
    const { createOrganizationLibrary } =
      await import("../src/organization/library-ui.js");
    const items = [
      {
        id: "a",
        name: "Retro",
        category: "Agile",
        status: "approved",
        createdByName: "Alice",
        created: 1,
        canRemove: false,
      },
      {
        id: "b",
        name: 'Kickoff <img id="pwn">',
        category: "Workshops",
        description: "From Miro",
        status: "pending",
        createdByName: "Bob",
        created: 2,
        canRemove: true,
      },
    ];
    const calls = [],
      toasts = [],
      used = [];
    const org = {
      isAdmin: true,
      request: async (op, input) => {
        calls.push([op, input]);
        if (op === "library.list") return { items, canPublish: true };
        if (op === "library.get") return { board: '{"v":1}' };
        if (op === "library.submit") return { item: { status: "approved" } };
        return { ok: true };
      },
    };
    const lib = createOrganizationLibrary({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.setAttribute("aria-label", title);
        d.innerHTML = html;
        d.close = () => d.remove();
        document.body.append(d);
        ready(d);
        return d;
      },
      toast: (m) => toasts.push(m),
      icon: () => "",
      useBoard: async (json, name) => used.push([json, name]),
      shareable: () => ({ title: "Plan", items: [] }),
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    lib.open();
    await settle();
    const rows = () => [...document.querySelectorAll("[data-item]")];
    assert.equal(document.querySelector("#pwn"), null, "Names are escaped");
    // Items awaiting approval come first, with the actions each allows.
    assert.deepEqual(
      rows().map((r) => r.dataset.item),
      ["b", "a"],
    );
    assert.match(rows()[0].textContent, /Awaiting approval/);
    assert.ok(rows()[0].querySelector("[data-library-approve]"));
    assert.equal(rows()[1].querySelector("[data-library-remove]"), null);
    rows()[0].querySelector("[data-library-approve]").click();
    await settle();
    assert.deepEqual(calls.at(-1), ["library.approve", { id: "b" }]);
    assert.doesNotMatch(rows()[0].textContent, /Awaiting approval/);
    // Removal takes a second press.
    rows()[0].querySelector("[data-library-remove]").click();
    await settle();
    assert.notEqual(calls.at(-1)[0], "library.remove");
    // The renamed button keeps focus, so its new question is announced.
    assert.equal(
      document.querySelector("#org-library-status").textContent,
      "Confirm removal",
    );
    rows()[0].querySelector("[data-library-remove]").click();
    await settle();
    assert.deepEqual(calls.at(-1), ["library.remove", { id: "b" }]);
    assert.deepEqual(
      rows().map((r) => r.dataset.item),
      ["a"],
    );
    // Search filters by name, category, and author.
    const search = document.querySelector("#org-library-search");
    search.value = "zzz";
    search.dispatchEvent(new dom.window.Event("input"));
    assert.equal(rows().length, 0);
    assert.match(
      document.querySelector("#org-library-status").textContent,
      /No library items match/,
    );
    search.value = "agile";
    search.dispatchEvent(new dom.window.Event("input"));
    rows()[0].querySelector("[data-library-use]").click();
    await settle();
    assert.deepEqual(used, [['{"v":1}', "Retro"]]);
    assert.equal(document.querySelector("dialog"), null, "Using closes it");
    // Sharing the open board sends it as a template.
    lib.share();
    assert.equal(document.querySelector("#org-library-name").value, "Plan");
    document
      .querySelector("#org-library-share")
      .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await settle();
    const [op, input] = calls.at(-1);
    assert.equal(op, "library.submit");
    assert.equal(input.category, "General");
    assert.deepEqual(JSON.parse(input.board), { title: "Plan", items: [] });
    assert.equal(toasts.at(-1), "Shared to the organization library.");
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("organization library failures stay in the dialog instead of a fading notification", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "HTMLElement", "Event", "CSS"];
  for (const key of keys) globalThis[key] = dom.window[key];
  globalThis.CSS ??= { escape: (s) => s };
  try {
    const { createOrganizationLibrary } =
      await import("../src/organization/library-ui.js");
    const toasts = [];
    let fail = true;
    const lib = createOrganizationLibrary({
      org: {
        isAdmin: true,
        request: async (op) => {
          if (op === "library.list")
            return {
              canPublish: true,
              items: [
                {
                  id: "a",
                  name: "Retro",
                  category: "Agile",
                  status: "pending",
                  canRemove: true,
                  createdByName: "Alice",
                  created: 1,
                },
              ],
            };
          if (fail) throw Error("The organization service is unavailable.");
          if (op === "library.submit") return { item: { status: "approved" } };
          return { ok: true };
        },
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.setAttribute("aria-label", title);
        d.innerHTML = html;
        d.close = () => d.remove();
        document.body.append(d);
        ready(d);
        return d;
      },
      toast: (m) => toasts.push(m),
      icon: () => "",
      useBoard: async () => {},
      shareable: () => ({ title: "Plan", items: [] }),
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    lib.open();
    await settle();
    const error = document.querySelector("#org-library-error");
    assert.equal(error.hidden, true);
    assert.equal(error.getAttribute("role"), "alert");
    document.querySelector("[data-library-approve]").click();
    await settle();
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, "The organization service is unavailable.");
    assert.deepEqual(toasts, []);
    // The next attempt clears it, and success leaves it hidden.
    fail = false;
    document.querySelector("[data-library-approve]").click();
    assert.equal(error.hidden, true);
    await settle();
    assert.equal(error.hidden, true);
    assert.deepEqual(toasts, ["Approved for everyone in the organization."]);
    document.querySelector("dialog").close();
    // Sharing keeps the form, and now its explanation, open.
    toasts.length = 0;
    fail = true;
    lib.share();
    const form = document.querySelector("#org-library-share");
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await settle();
    const shareError = document.querySelector("#org-library-share-error");
    assert.ok(form.isConnected, "The form stays open");
    assert.equal(shareError.hidden, false);
    assert.equal(shareError.getAttribute("role"), "alert");
    assert.equal(
      shareError.textContent,
      "The organization service is unavailable.",
    );
    assert.deepEqual(toasts, []);
    fail = false;
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    assert.equal(shareError.hidden, true);
    await settle();
    assert.equal(form.isConnected, false);
    assert.deepEqual(toasts, ["Shared to the organization library."]);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("the library's default categories read in French", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "HTMLElement", "Event"];
  for (const key of keys) globalThis[key] = dom.window[key];
  const { setLanguage } = await import("../src/i18n.js");
  try {
    const { createOrganizationLibrary } =
      await import("../src/organization/library-ui.js");
    setLanguage("fr");
    const item = (id, category) => ({
      id,
      name: id,
      category,
      status: "approved",
      createdByName: "Alice",
      created: 1,
    });
    const lib = createOrganizationLibrary({
      org: {
        request: async () => ({
          items: [
            item("a", "General"),
            item("b", "Migrated from Miro"),
            item("c", "Agile"),
          ],
        }),
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast() {},
      icon: () => "",
    });
    lib.open();
    await new Promise((r) => setTimeout(r, 0));
    const category = (id) =>
      document.querySelector(`[data-item="${id}"] small span`);
    assert.equal(category("a").textContent, "Général");
    assert.equal(category("b").textContent, "Migré depuis Miro");
    // Names people chose stay as written.
    assert.equal(category("c").textContent, "Agile");
    assert.ok(category("c").hasAttribute("data-user-content"));
    assert.ok(!category("a").hasAttribute("data-user-content"));
    const search = document.querySelector("#org-library-search");
    search.value = "général";
    search.dispatchEvent(new dom.window.Event("input"));
    assert.deepEqual(
      [...document.querySelectorAll("[data-item]")].map((r) => r.dataset.item),
      ["a"],
    );
  } finally {
    setLanguage("en");
    for (const key of keys) delete globalThis[key];
  }
});

test("closing an inline people form returns focus to its button", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op, data) =>
        op === "org.users.list"
          ? {
              owner: { uuid: "u1", username: "alice" },
              users: [
                {
                  uuid: "u2",
                  username: "bob",
                  role: "member",
                  status: "active",
                },
              ],
            }
          : op === "teams.list"
            ? { teams: [{ id: "t1", name: "Design", members: [] }] }
            : op === "org.users.transfer"
              ? // The worker moves boards a batch at a time.
                data.after
                ? { transferred: 3, remaining: 0, next: null }
                : { transferred: 25, remaining: 3, next: "r25" }
              : {},
      refresh: async () => {},
    };
    const toasts = [];
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast: (m) => toasts.push(m),
      icon: () => "",
      download() {},
    });
    const d = admin.open("people");
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    const transfer = d.querySelector('[data-transfer="u2"]');
    transfer.click();
    // Cancel closes the form without moving anything.
    d.querySelector("#transfer-cancel").click();
    assert.equal(d.querySelector("#transfer-target"), null);
    assert.equal(document.activeElement, transfer);
    transfer.click();
    // Moving every board takes a second press, asked again after the new
    // owner changes.
    const go = d.querySelector("#transfer-go");
    go.click();
    await settle();
    assert.equal(go.textContent, "Confirm transfer");
    assert.deepEqual(toasts, []);
    d.querySelector("#transfer-to").dispatchEvent(
      new dom.window.Event("change"),
    );
    assert.equal(go.textContent, "Transfer all boards");
    go.click();
    go.click();
    await settle();
    assert.equal(d.querySelector("#transfer-target"), null);
    assert.equal(document.activeElement, transfer);
    assert.deepEqual(toasts, ["28 boards transferred."]);
    for (const opener of [
      d.querySelector("#new-team"),
      d.querySelector('[data-edit-team="t1"]'),
    ]) {
      opener.click();
      assert.equal(document.activeElement.id, "team-name");
      d.querySelector("#team-cancel").click();
      assert.equal(document.activeElement, opener);
    }
    // Opening another team form replaces the open one.
    d.querySelector("#new-team").click();
    d.querySelector('[data-edit-team="t1"]').click();
    d.querySelector("#new-team").click();
    assert.equal(d.querySelectorAll("#team-list > form").length, 1);
    assert.equal(d.querySelectorAll("#team-name").length, 1);
    assert.equal(document.activeElement.id, "team-name");
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("editing a team keeps its deactivated members", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const sent = [];
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op, data) => {
        if (op === "teams.update") sent.push(data);
        if (op === "org.users.list")
          return {
            owner: { uuid: "u1", username: "alice" },
            users: [
              { uuid: "u2", username: "bob", role: "member", status: "active" },
              {
                uuid: "u3",
                username: "cam",
                role: "member",
                status: "deactivated",
              },
            ],
          };
        if (op === "teams.list")
          return {
            teams: [{ id: "t1", name: "Design", members: ["u2", "u3"] }],
          };
        return {};
      },
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("people");
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    d.querySelector('[data-edit-team="t1"]').click();
    d.querySelector("#team-name").value = "Design team";
    d.querySelector(".inline-form").dispatchEvent(
      new dom.window.Event("submit", { cancelable: true }),
    );
    await settle();
    // Renaming the team removes no one, the deactivated member included.
    assert.deepEqual(sent[0].add, []);
    assert.deepEqual(sent[0].remove, []);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("people search finds roles and statuses as they are shown in French", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  const { setLanguage, t } = await import("../src/i18n.js");
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    setLanguage("fr");
    const person = (uuid, username, role, status) => ({
      uuid,
      username,
      role,
      status,
    });
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op) =>
        op === "org.users.list"
          ? {
              owner: { uuid: "u1", username: "alice" },
              users: [
                person("u2", "bob", "guest", "active"),
                person("u3", "cam", "member", "deactivated"),
                person("u4", "dan", "admin", "pending"),
              ],
            }
          : op === "teams.list"
            ? { teams: [] }
            : {},
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("people");
    await new Promise((r) => setTimeout(r, 20));
    const search = (text) => {
      const input = d.querySelector("#people-search");
      input.value = text;
      input.dispatchEvent(new dom.window.Event("input"));
      return [...d.querySelectorAll("#people-rows tr")].map(
        (row) => row.querySelector("[data-user-content]")?.textContent,
      );
    };
    assert.deepEqual(search("Invité"), ["bob"]);
    assert.deepEqual(search("désactivé"), ["cam"]);
    assert.deepEqual(search("administrateur"), ["dan"]);
    assert.deepEqual(search("en attente"), ["dan"]);
    // The stored values still match, as before.
    assert.deepEqual(search("guest"), ["bob"]);
    // One person's status reads in the singular.
    search("");
    assert.equal(
      d.querySelector('[data-status="u3"] option[value="deactivated"]')
        .textContent,
      "Désactivé",
    );
    assert.equal(t("Deactivated"), "Désactivés");
  } finally {
    setLanguage("en");
    for (const key of keys) delete globalThis[key];
  }
});

test("administrators see that their changes were saved", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const on = { enabled: true };
    const toasts = [];
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op) =>
        op === "org.policy.get"
          ? {
              policy: {
                integrations: {
                  google: on,
                  slack: on,
                  jira: { enabled: false, site: "", email: "", project: "" },
                  embeds: on,
                  webhooks: on,
                  miro: on,
                },
              },
              secrets: {},
            }
          : {},
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast: (m) => toasts.push(m),
      icon: () => "",
      download() {},
    });
    const d = admin.open("integrations");
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    d.querySelector("#integrations-form").dispatchEvent(
      new dom.window.Event("submit", { cancelable: true }),
    );
    await settle();
    assert.deepEqual(toasts, ["Integrations saved."]);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("organization boards hide archived boards until they are asked for", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const { filterBoards } = await import("../worker/admin.js");
    const rows = [
      { room: "r1", title: "Live", visibility: "private" },
      { room: "r2", title: "Old", visibility: "private", archived: 1 },
    ];
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { role: "member", user: { emailVerified: true } },
        isMember: true,
        onChange() {},
        request: async (op, data) =>
          op === "org.boards"
            ? { boards: filterBoards(structuredClone(rows), data) }
            : { spaces: [], teams: [] },
      },
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    const grid = document.querySelector("#grid");
    const titles = () =>
      [...grid.querySelectorAll(".board-info h3")].map((h) => h.textContent);
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await home.renderBoards(grid);
    assert.equal(grid.querySelector("#of-archived").value, "");
    assert.deepEqual(titles(), ["Live"]);
    const archived = grid.querySelector("#of-archived");
    archived.value = "only";
    grid.querySelector("#of-query").focus();
    grid
      .querySelector("#org-filters")
      .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await settle();
    assert.deepEqual(titles(), ["Old"]);
    // The card's name is only its title, so what the card shows about the
    // board, such as being archived, is read as its description.
    const open = grid.querySelector("[data-org-open]");
    const described = open
      .getAttribute("aria-describedby")
      .split(" ")
      .map((id) => document.getElementById(id).textContent)
      .join(" ");
    assert.match(described, /Archived/);
    assert.equal(
      document.activeElement.id,
      "of-query",
      "Searching keeps the keyboard in the search field",
    );
    grid.querySelector("#of-clear").focus();
    grid.querySelector("#of-clear").click();
    await settle();
    assert.deepEqual(titles(), ["Live"]);
    assert.ok(
      document.activeElement.matches(".org-more summary"),
      "Clearing filters moves the keyboard to More filters",
    );
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("organization boards found by their content show the match and open on it", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const opened = [];
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { role: "member", user: { emailVerified: true } },
        isMember: true,
        onChange() {},
        request: async (op, data) =>
          op === "org.boards"
            ? {
                boards: data.query
                  ? [
                      {
                        room: "r1",
                        title: "Roadmap retro",
                        ownerName: "Ana",
                        lastActivity: Date.now(),
                        space: "gone",
                      },
                      {
                        room: "r2",
                        title: "Planning",
                        snippet: {
                          before: "Ship the <b>",
                          hit: "Roadmap",
                          after: " by June",
                        },
                      },
                    ]
                  : [],
              }
            : { spaces: [], teams: [] },
      },
      modal() {},
      toast() {},
      icon: () => "",
      async openShared(...args) {
        opened.push(args);
      },
    });
    const grid = document.querySelector("#grid");
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await home.renderBoards(grid);
    grid.querySelector("#of-query").value = " planning  ROADMAP ";
    grid
      .querySelector("#org-filters")
      .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await settle();
    const [named, found] = grid.querySelectorAll("[data-org-open]");
    assert.equal(
      named.closest(".board-card").querySelector(".card-found"),
      null,
    );
    // A space that no longer exists leaves no empty place on the card.
    assert.doesNotMatch(
      named.closest(".board-card").querySelector(".org-meta").textContent,
      /·\s*$/,
    );
    const where = found.closest(".board-card").querySelector(".card-found");
    assert.equal(where.textContent, "Ship the <b>Roadmap by June");
    assert.equal(where.querySelector("mark").textContent, "Roadmap");
    assert.ok(
      found.getAttribute("aria-describedby").split(" ").includes(where.id),
    );
    // The board opens on the word its card shows; one found by its name
    // opens as it always has.
    found.click();
    await settle();
    named.click();
    await settle();
    assert.deepEqual(opened, [
      ["https://org.puter.work", "r2", { query: "Roadmap" }],
      ["https://org.puter.work", "r1", {}],
    ]);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("what is typed in the organization search while its lists reload is kept", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  const now = Date.now;
  let clock = now();
  Date.now = () => clock;
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const pending = [];
    const release = () => pending.splice(0).forEach((resolve) => resolve());
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { role: "member", user: { emailVerified: true } },
        isMember: true,
        onChange() {},
        request: async (op) => {
          if (op === "org.boards") return { boards: [] };
          await new Promise((resolve) => pending.push(resolve));
          return { spaces: [], teams: [] };
        },
      },
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    const grid = document.querySelector("#grid");
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const first = home.renderBoards(grid);
    await settle();
    release();
    await first;
    await settle();
    // A minute later the lists are asked for again when searching.
    clock += 61_000;
    let field = grid.querySelector("#of-query");
    field.value = "road";
    field.focus();
    grid
      .querySelector("#org-filters")
      .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await settle();
    // Typing goes on while the lists load.
    field.value = "roadmap q3";
    field.setSelectionRange(4, 4);
    release();
    await settle();
    field = grid.querySelector("#of-query");
    assert.equal(field.value, "roadmap q3");
    assert.equal(document.activeElement, field);
    assert.deepEqual([field.selectionStart, field.selectionEnd], [4, 4]);
  } finally {
    Date.now = now;
    for (const key of keys) delete globalThis[key];
  }
});

test("organization boards can include archived ones, find empty boards and links, and sort", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = [
    "document",
    "localStorage",
    "HTMLElement",
    "Node",
    "Event",
    "NodeFilter",
  ];
  for (const key of keys) globalThis[key] = dom.window[key];
  const { setLanguage } = await import("../src/i18n.js");
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const { filterBoards } = await import("../worker/admin.js");
    const rows = [
      {
        room: "r1",
        title: "Beta",
        objectCount: 3,
        types: { link: 1 },
        created: 2,
        lastActivity: 9,
      },
      {
        room: "r2",
        title: "Alpha",
        objectCount: 0,
        types: {},
        created: 1,
        lastActivity: 5,
        archived: 1,
      },
      {
        room: "r3",
        title: "Gamma",
        objectCount: 2,
        types: { note: 2 },
        created: 3,
        lastActivity: 7,
      },
    ];
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { role: "member", user: { emailVerified: true } },
        isMember: true,
        onChange() {},
        request: async (op, data) =>
          op === "org.boards"
            ? { boards: filterBoards(structuredClone(rows), data, 10) }
            : { spaces: [], teams: [] },
      },
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    const grid = document.querySelector("#grid");
    const titles = () =>
      [...grid.querySelectorAll(".board-info h3")].map((h) => h.textContent);
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const choose = async (id, value) => {
      grid.querySelector(id).value = value;
      grid
        .querySelector("#org-filters")
        .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      await settle();
    };
    await home.renderBoards(grid);
    assert.deepEqual(titles(), ["Beta", "Gamma"]);
    await choose("#of-archived", "include");
    assert.deepEqual(titles(), ["Beta", "Gamma", "Alpha"]);
    assert.equal(grid.querySelector("#of-archived").value, "include");
    await choose("#of-sort", "title");
    assert.deepEqual(titles(), ["Alpha", "Beta", "Gamma"]);
    await choose("#of-activity", "unused");
    assert.deepEqual(titles(), ["Alpha"]);
    await choose("#of-activity", "");
    await choose("#of-type", "link");
    assert.deepEqual(titles(), ["Beta"]);
    // Every choice counts as a filter in use, and clearing them returns to
    // current boards by last activity.
    assert.equal(grid.querySelector(".org-more .badge").textContent, "3");
    // Words typed but not searched for give way to the search shown.
    grid.querySelector("#of-query").value = "unsent";
    grid.querySelector("#of-clear").focus();
    grid.querySelector("#of-clear").click();
    await settle();
    assert.deepEqual(titles(), ["Beta", "Gamma"]);
    assert.equal(grid.querySelector("#of-query").value, "");
    assert.equal(grid.querySelector("#of-sort").value, "updated");
    setLanguage("fr");
    await home.renderBoards(grid);
    const label = (v) =>
      grid.querySelector(`#of-archived option[value="${v}"]`).textContent;
    assert.equal(label("include"), "Inclure");
    assert.equal(
      grid.querySelector('#of-activity option[value="unused"]').textContent,
      "Tableaux vides",
    );
    assert.equal(
      grid.querySelector('#of-sort option[value="title"]').textContent,
      "Nom",
    );
  } finally {
    setLanguage("en");
    for (const key of keys) delete globalThis[key];
  }
});

test("the sidebar and the boards asking for the spaces together ask once", async () => {
  const dom = new JSDOM(
    "<!doctype html><body><aside class='sidebar'></aside><div id='grid'></div></body>",
    { url: "https://whiteboard.test" },
  );
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const asked = [];
    let gone = false;
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: { role: "member", user: { emailVerified: true }, name: "CDS" },
        isMember: true,
        onChange() {},
        request: async (op) => {
          asked.push(op);
          await new Promise((r) => setTimeout(r, 10));
          return op === "org.boards"
            ? { boards: [] }
            : op === "spaces.list"
              ? { spaces: gone ? [] : [{ id: "s1", name: "Sales" }] }
              : op === "teams.list"
                ? { teams: [] }
                : { items: [] };
        },
      },
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    const side = document.querySelector(".sidebar");
    side.innerHTML = home.sidebar();
    home.bind(side);
    await home.renderBoards(document.querySelector("#grid"));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(asked.filter((op) => op === "spaces.list").length, 1);
    assert.equal(asked.filter((op) => op === "teams.list").length, 1);
    assert.equal(side.querySelectorAll("[data-org-space]").length, 1);
    // A space deleted elsewhere leaves the sidebar once it is said.
    gone = true;
    home.forgetLists();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(side.querySelectorAll("[data-org-space]").length, 0);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("board filters agree with their French labels", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "HTMLElement", "Node", "Event"];
  for (const key of keys) globalThis[key] = dom.window[key];
  const { setLanguage } = await import("../src/i18n.js");
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    setLanguage("fr");
    const org = {
      server: "https://org.puter.work",
      info: { role: "admin", user: { emailVerified: true } },
      isMember: true,
      isAdmin: true,
      onChange() {},
      request: async (op) =>
        op === "org.boards"
          ? { boards: [] }
          : op === "spaces.list"
            ? { spaces: [] }
            : { teams: [] },
      refresh: async () => {},
    };
    const home = createOrganizationHome({
      org,
      modal() {},
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    const grid = document.querySelector("#grid");
    await home.renderBoards(grid);
    const text = (root, selector) => root.querySelector(selector).textContent;
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("boards");
    await new Promise((r) => setTimeout(r, 20));
    for (const [root, prefix] of [
      [grid, "of"],
      [d, "bf"],
    ]) {
      // Un espace, une équipe, une activité.
      assert.equal(text(root, `#${prefix}-space option[value=""]`), "Tous");
      assert.equal(text(root, `#${prefix}-team option[value=""]`), "Toutes");
      assert.equal(
        text(root, `#${prefix}-activity option[value="active"]`),
        "Actifs au cours des 30 derniers jours",
      );
    }
    // Archived boards, beside current and deleted ones.
    assert.equal(
      grid.querySelector("#of-archived").closest("label").firstChild
        .textContent,
      "Archivés",
    );
    assert.deepEqual(
      [...d.querySelectorAll("#bf-state option")].map((o) => o.textContent),
      ["Actuels", "Archivés", "Supprimés (récupérables)"],
    );
  } finally {
    setLanguage("en");
    for (const key of keys) delete globalThis[key];
  }
});

test("board date filters mean the start of the chosen day where the person is", async () => {
  const { boardFilters } = await import("../src/organization/client.js");
  const { filterBoards } = await import("../worker/admin.js");
  const sent = boardFilters({ updatedAfter: "2026-09-27", scope: "all" });
  assert.equal(
    sent.updatedAfter,
    new Date("2026-09-27T00:00:00").toISOString(),
  );
  assert.equal(sent.scope, "all");
  assert.deepEqual(boardFilters({ scope: "mine" }), { scope: "mine" });
  // A board updated just before local midnight is left out, one just
  // after it is kept.
  const midnight = new Date("2026-09-27T00:00:00").getTime();
  const rows = [
    { room: "before", title: "A", lastActivity: midnight - 60_000 },
    { room: "after", title: "B", lastActivity: midnight + 60_000 },
  ];
  assert.deepEqual(
    filterBoards(rows, sent).map((b) => b.room),
    ["after"],
  );
});

test("the board directory shows how many boards matched and exports them all", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const all = Array.from({ length: 1500 }, (_, n) => ({
      room: `r${n}`,
      title: `Board ${n}`,
      owner: "u1",
      created: 1,
    }));
    const requests = [],
      downloads = [];
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op, data) => {
        if (op === "org.boards") {
          requests.push(data);
          const offset = data.offset || 0;
          return {
            boards: all.slice(offset, offset + (data.limit || 200)),
            total: all.length,
          };
        }
        if (op === "teams.list") return { teams: [] };
        if (op === "spaces.list") return { spaces: [] };
        if (op === "org.users.list")
          return { owner: { uuid: "u1", username: "alice" }, users: [] };
        return {};
      },
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download: (...args) => downloads.push(args),
      migrate() {},
    });
    const d = admin.open();
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    d.querySelector('[data-tab="boards"]').click();
    await settle();
    const status = () =>
      d.querySelector("#admin-panel [role=status]").textContent;
    assert.match(status(), /Showing 200 of 1,500 boards/);
    assert.equal(d.querySelectorAll(".admin-table tbody tr").length, 200);
    d.querySelector("#bf-more").click();
    await settle();
    assert.match(status(), /Showing 400 of 1,500 boards/);
    d.querySelector("#bf-export").click();
    await settle();
    const csv = downloads.at(-1)[0];
    assert.equal(csv.trim().split(/\r?\n/).length, 1 + 1500);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("board activity and duplicate results are announced", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    let groups = [
      {
        reason: "same name",
        // The worker lists a set's first fifty boards, and how many in all.
        count: 52,
        boards: [
          { title: "Plan", objectCount: 1 },
          { title: "Plan", objectCount: 2 },
        ],
      },
    ];
    const entry = { at: 1, category: "content", action: "board.edit" };
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op, data) =>
        op === "org.boards"
          ? { boards: [{ room: "r1", title: "Plan", created: 1 }], total: 1 }
          : op === "org.board.activity"
            ? data.cursor === "c1"
              ? { entries: [entry, entry], cursor: null }
              : { entries: [entry, entry, entry], cursor: "c1" }
            : op === "org.boards.duplicates"
              ? { groups }
              : op === "teams.list"
                ? { teams: [] }
                : op === "spaces.list"
                  ? { spaces: [] }
                  : {},
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("boards");
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    const announced = () => d.querySelector("#admin-status").textContent;
    d.querySelector('[data-activity="r1"]').click();
    await settle();
    assert.equal(
      announced(),
      "Board activity: 3 events. Older activity is available.",
    );
    // The results land below the board table: the keyboard moves to their
    // heading, which names the board.
    assert.equal(document.activeElement.id, "board-detail-heading");
    assert.match(document.activeElement.textContent, /^Board activity · \S/);
    // Older events load below, until there are no more.
    d.querySelector("#board-activity-more").click();
    await settle();
    assert.equal(d.querySelectorAll("#board-detail tbody tr").length, 5);
    assert.equal(d.querySelector("#board-activity-more"), null);
    assert.equal(announced(), "Board activity: 5 events.");
    assert.equal(
      document.activeElement,
      d.querySelectorAll("#board-detail tbody tr")[3].querySelector("td"),
    );
    d.querySelector("#bf-duplicates").click();
    await settle();
    assert.equal(announced(), "1 set of possible duplicates found.");
    assert.equal(document.activeElement.id, "board-detail-heading");
    assert.equal(document.activeElement.textContent, "Possible duplicates");
    assert.match(
      d.querySelector("#board-detail p").textContent,
      /and 50 more boards$/,
    );
    groups = [];
    d.querySelector("#bf-duplicates").click();
    await settle();
    assert.equal(announced(), "No duplicates found.");
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("each set of possible duplicates is a table of its boards with a way to open each", async () => {
  const opened = [];
  const at = Date.parse("2026-09-20T12:00:00");
  const plan = (n) => ({
    room: `p${n}`,
    title: "Plan",
    ownerName: n % 2 ? "bob" : "alice",
    objectCount: n * 1000,
    lastActivity: at,
  });
  const { respond } = directory([{ room: "r1", title: "Plan", created: 1 }], {
    "org.boards.duplicates": {
      groups: [
        {
          reason: "same name",
          count: 14,
          boards: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(plan),
        },
        { reason: "same content", count: 2, boards: [plan(1), plan(2)] },
      ],
    },
  });
  await withConsole(
    respond,
    "boards",
    async ({ d, settle }) => {
      d.querySelector("#bf-duplicates").click();
      await settle();
      const tables = [...d.querySelectorAll("#board-detail table")];
      assert.equal(tables.length, 2);
      // Each table is named by its set: why its boards match and how many.
      assert.deepEqual(
        tables.map(
          (table) =>
            document.getElementById(table.getAttribute("aria-labelledby"))
              .textContent,
        ),
        ["Same name · 14 boards", "Same content · 2 boards"],
      );
      assert.deepEqual(
        [...tables[0].querySelectorAll("thead th")].map((th) => th.textContent),
        ["Board", "Owner", "Objects", "Last activity", "Actions"],
      );
      // Ten boards at most, then how many more.
      const rows = tables[0].querySelectorAll("tbody tr");
      assert.equal(rows.length, 10);
      assert.deepEqual(
        [...rows[1].children].slice(0, 4).map((cell) => cell.textContent),
        ["Plan", "alice", "2,000", "Sep 20, 2026"],
      );
      assert.equal(
        tables[0].closest(".table-scroll").nextElementSibling.textContent,
        "and 4 more boards",
      );
      // Open names its board and opens it.
      const open = rows[1].querySelector("[data-open-board]");
      assert.equal(
        document.getElementById(open.getAttribute("aria-describedby")),
        rows[1].querySelector("th"),
      );
      open.click();
      await settle();
      assert.deepEqual(opened, ["p2"]);
    },
    { console: { openBoard: async (room) => opened.push(room) } },
  );
});

test("archiving a board from its settings makes it read-only at once", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createBoardAccess } =
      await import("../src/organization/board-access.js");
    let archived = false;
    const s = {
      role: "owner",
      readOnly: false,
      server: "https://whiteboard-abc.puter.work",
      settings: {
        visibility: "private",
        orgRole: "editor",
        linkRole: "viewer",
      },
      request: async (op) => {
        if (op === "archive" || op === "unarchive") {
          archived = op === "archive";
          return { settings: { ...s.settings, archived } };
        }
        return op === "members"
          ? { members: [] }
          : op === "settings.get"
            ? { settings: {} }
            : {};
      },
      heartbeat: async () => {
        s.readOnly = archived;
      },
    };
    let d;
    const toasts = [];
    const access = createBoardAccess({
      org: { info: null, policy: () => null, allows: () => true },
      session: () => s,
      board: () => ({ items: [] }),
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.close = () => d.remove();
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast: (message) => toasts.push(message),
      icon: () => "",
    });
    await access.settings();
    d.querySelector("#bs-archive").click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.readOnly, true);
    assert.equal(toasts.at(-1), "Board archived. It is now read-only.");
    await access.settings();
    d.querySelector("#bs-archive").click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.readOnly, false);
    assert.equal(toasts.at(-1), "Board unarchived. It can be edited again.");
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("saving board settings sends only what was changed in the dialog", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createBoardAccess } =
      await import("../src/organization/board-access.js");
    const sent = [];
    const s = {
      role: "facilitator",
      server: "https://whiteboard-abc.puter.work",
      settings: { visibility: "link", orgRole: "editor", linkRole: "viewer" },
      sharing: {
        organization: true,
        member: true,
        guests: true,
        publicLinks: true,
      },
      request: async (op, input) => {
        if (op === "settings") {
          sent.push(input);
          return { settings: { ...s.settings, ...input } };
        }
        return op === "members"
          ? { members: [] }
          : op === "settings.get"
            ? { settings: {} }
            : {};
      },
    };
    let d;
    const access = createBoardAccess({
      org: { info: null, policy: () => null, allows: () => true },
      session: () => s,
      board: () => ({ items: [] }),
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.close = () => d.remove();
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast() {},
      icon: () => "",
    });
    await access.settings();
    const save = () =>
      d
        .querySelector("#board-settings")
        .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    // Someone else makes the board private meanwhile; this person only
    // changes the link role, so the board stays private.
    d.querySelector("#bs-link-role").value = "commenter";
    save();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(sent, [{ linkRole: "commenter" }]);
    d.querySelector("#bs-org-role").value = "viewer";
    save();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(sent.at(-1), { orgRole: "viewer" });
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("a saved Slack webhook is not sent again and the dialog shows it connected", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createBoardAccess } =
      await import("../src/organization/board-access.js");
    const sent = [];
    const s = {
      role: "owner",
      server: "https://whiteboard-abc.puter.work",
      settings: {
        visibility: "private",
        orgRole: "editor",
        linkRole: "viewer",
      },
      request: async (op, input) => {
        if (op === "settings") {
          sent.push(input);
          return { settings: { ...s.settings, ...input } };
        }
        return op === "members"
          ? { members: [] }
          : op === "settings.get"
            ? { settings: { ...s.settings, integrations: true, slack: false } }
            : {};
      },
    };
    let d;
    const access = createBoardAccess({
      org: {
        server: s.server,
        isMember: true,
        info: { configured: true },
        policy: () => ({ publicLinks: false }),
        allows: () => true,
        request: async (op) =>
          op === "spaces.list" ? { spaces: [] } : { teams: [] },
      },
      session: () => s,
      board: () => ({ items: [] }),
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.close = () => d.remove();
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast: (message) => toasts.push(message),
      icon: () => "",
    });
    const toasts = [];
    await access.settings();
    const save = async () => {
      d.querySelector("#board-settings").dispatchEvent(
        new dom.window.Event("submit", { cancelable: true }),
      );
      await new Promise((r) => setTimeout(r, 20));
    };
    const url = "https://hooks.slack.com/services/T/B/x";
    d.querySelector("#bs-slack").value = url;
    await save();
    assert.deepEqual(sent, [{ slack: url }]);
    // Saving is confirmed once, in the dialog, not also as a notification.
    assert.equal(d.querySelector("#bs-status").textContent, "Settings saved.");
    assert.equal(d.querySelector("#bs-status").dataset.kind, "success");
    assert.deepEqual(toasts, []);
    assert.equal(d.querySelector("#bs-slack").value, "");
    assert.ok(d.querySelector(".badge"));
    d.querySelector("#bs-org-role").value = "viewer";
    await save();
    assert.deepEqual(sent.at(-1), { orgRole: "viewer" });
    // Disconnecting removes the badge and the option.
    d.querySelector("#bs-slack-off").checked = true;
    await save();
    assert.deepEqual(sent.at(-1), { slack: "" });
    assert.equal(d.querySelector(".badge, #bs-slack-off"), null);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("board settings announce the delete confirmation and keep an administrator's owner controls after a transfer", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createBoardAccess } =
      await import("../src/organization/board-access.js");
    const s = {
      role: "owner",
      server: "https://whiteboard-abc.puter.work",
      settings: {
        visibility: "private",
        orgRole: "editor",
        linkRole: "viewer",
      },
      request: async (op) =>
        op === "members"
          ? {
              members: [
                { uuid: "m1", username: "Bea", role: "editor" },
                {
                  uuid: "m2",
                  username: "Gone",
                  role: "editor",
                  inactive: true,
                },
              ],
            }
          : op === "settings.get"
            ? { settings: {} }
            : {},
      // An administrator keeps owner rights after giving the board away.
      heartbeat: async () => {},
    };
    let d;
    const access = createBoardAccess({
      org: { info: null, policy: () => null, allows: () => true },
      session: () => s,
      board: () => ({ items: [] }),
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.close = () => d.remove();
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast() {},
      icon: () => "",
    });
    await access.settings();
    // Deactivated members cannot receive a board.
    assert.deepEqual(
      [...d.querySelectorAll("#bs-transfer option")].map((o) => o.value),
      ["", "m1"],
    );
    const status = () => d.querySelector("#bs-status").textContent;
    d.querySelector("#bs-delete").click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(status(), "Select again to delete for everyone");
    d.querySelector("#bs-transfer").value = "m1";
    d.querySelector("#bs-transfer-go").click();
    await new Promise((r) => setTimeout(r, 20));
    d.querySelector("#bs-transfer-go").click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(status(), "Ownership transferred.");
    assert.ok(d.querySelector("#bs-archive"), "Owner controls remain");
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("board settings do not open for a board left while they load", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createBoardAccess } =
      await import("../src/organization/board-access.js");
    const board = (room) => {
      let release;
      const loaded = new Promise((r) => (release = r));
      return {
        room,
        role: "owner",
        closed: false,
        server: "https://whiteboard-abc.puter.work",
        settings: { visibility: "private", orgRole: "editor" },
        release,
        request: async (op) => {
          await loaded;
          return op === "members" ? { members: [] } : { settings: {} };
        },
      };
    };
    let current = board("a");
    const opened = [];
    const access = createBoardAccess({
      org: { info: null, policy: () => null, allows: () => true },
      session: () => current,
      board: () => ({ items: [] }),
      modal: (title) => opened.push(title),
      toast() {},
      icon: () => "",
    });
    // Moved on to another board before the settings loaded.
    const first = current;
    const pending = access.settings();
    current = board("b");
    first.closed = true;
    first.release();
    await pending;
    assert.deepEqual(opened, []);
    // Closed without another board opening in its place.
    const second = current;
    const again = access.settings();
    second.closed = true;
    second.release();
    await again;
    assert.deepEqual(opened, []);
    // Still on the same board: the dialog opens as before.
    current = board("c");
    const ready = access.settings();
    current.release();
    await ready;
    assert.deepEqual(opened, ["Board settings"]);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("board settings drop owner controls once ownership is transferred", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createBoardAccess } =
      await import("../src/organization/board-access.js");
    const s = {
      role: "owner",
      server: "https://whiteboard-abc.puter.work",
      settings: {
        visibility: "private",
        orgRole: "editor",
        linkRole: "viewer",
      },
      request: async (op) =>
        op === "members"
          ? { members: [{ uuid: "u2", username: "bob", role: "editor" }] }
          : op === "settings.get"
            ? { settings: {} }
            : {},
      heartbeat: async () => {
        s.role = "facilitator";
      },
    };
    let d;
    const access = createBoardAccess({
      org: { info: null, policy: () => null, allows: () => true },
      session: () => s,
      board: () => ({ items: [] }),
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast() {},
      icon: () => "",
    });
    await access.settings();
    d.querySelector("#bs-transfer").value = "u2";
    d.querySelector("#bs-transfer-go").click();
    await new Promise((r) => setTimeout(r, 20));
    d.querySelector("#bs-transfer-go").click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      d.querySelector("#bs-transfer, #bs-archive, #bs-delete"),
      null,
    );
    assert.equal(
      d.querySelector("#bs-status").textContent,
      "Ownership transferred. You are now a facilitator.",
    );
    assert.equal(document.activeElement.textContent, "Save settings");
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("guest invitations follow the policy of the board's own server", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createBoardAccess } =
      await import("../src/organization/board-access.js");
    let server = "https://whiteboard-abc.puter.work";
    const access = createBoardAccess({
      org: {
        server: "https://whiteboard-abc.puter.work",
        info: { configured: true, role: "member" },
        policy: () => ({ guestAccess: true, externalSharing: "any" }),
        allows: () => true,
      },
      session: () => ({ role: "owner", server }),
      board: () => ({ items: [] }),
      modal() {},
      toast() {},
      icon: () => "",
    });
    assert.match(access.shareControls(), /id="share-members"/);
    // A board on someone's own server is not shared under this policy.
    server = "https://whiteboard-other.puter.work";
    assert.doesNotMatch(access.shareControls(), /id="share-members"/);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("a control busy with its action gets keyboard focus back", async () => {
  const dom = new JSDOM(
    "<!doctype html><body><button id='go'>Save</button><input id='next'><dialog><button id='in'>Use</button></dialog></body>",
  );
  const { busy } = await import("../src/accessibility/busy.js");
  const doc = dom.window.document;
  const go = doc.querySelector("#go");
  // Browsers move focus to the page when the focused control is disabled;
  // jsdom does not, and does not blur a disabled control either.
  const drop = (control) => {
    control.disabled = false;
    control.blur();
    control.disabled = true;
  };
  const run = (control, during = () => drop(control)) => {
    control.focus();
    const done = busy(control);
    assert.equal(control.disabled, true);
    during();
    done();
    assert.equal(control.disabled, false);
  };
  run(go, () => {
    drop(go);
    assert.equal(doc.activeElement, doc.body);
  });
  assert.equal(doc.activeElement, go);
  // Focus the action moved on purpose stays where it went.
  run(go, () => doc.querySelector("#next").focus());
  assert.equal(doc.activeElement.id, "next");
  // A control in a dialog that closed is not focused.
  const dialog = doc.querySelector("dialog");
  dialog.setAttribute("open", "");
  const inside = doc.querySelector("#in");
  run(inside, () => {
    drop(inside);
    dialog.removeAttribute("open");
  });
  assert.notEqual(doc.activeElement, inside);
  assert.doesNotThrow(() => busy(null)());
  dom.window.close();
});

test("board settings send where the board is filed only when changed there", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createBoardAccess } =
      await import("../src/organization/board-access.js");
    const sent = [],
      server = "https://whiteboard-abc.puter.work";
    const s = {
      role: "facilitator",
      server,
      settings: {
        visibility: "private",
        orgRole: "editor",
        linkRole: "viewer",
      },
      request: async (op, payload) => {
        if (op === "members") return { members: [] };
        if (op === "settings.get")
          return {
            settings: {
              visibility: "private",
              orgRole: "editor",
              linkRole: "viewer",
              space: "sp1",
              team: "tm1",
            },
          };
        if (op === "settings") {
          sent.push(payload);
          return { settings: {} };
        }
        return {};
      },
    };
    let d;
    const access = createBoardAccess({
      org: {
        info: { configured: true },
        server,
        isMember: true,
        policy: () => ({ publicLinks: true, externalSharing: "anyone" }),
        allows: () => false,
        request: async (op) =>
          op === "spaces.list"
            ? {
                spaces: [
                  { id: "sp1", name: "One" },
                  { id: "sp2", name: "Two" },
                ],
              }
            : { teams: [{ id: "tm1", name: "T" }] },
      },
      session: () => s,
      board: () => ({ items: [] }),
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast() {},
      icon: () => "",
    });
    await access.settings();
    const save = async () => {
      d.querySelector("#board-settings").dispatchEvent(
        new dom.window.Event("submit", { cancelable: true }),
      );
      await new Promise((r) => setTimeout(r, 20));
    };
    // Someone else may refile the board meanwhile; changing only its
    // visibility leaves that alone.
    d.querySelector('[name="bs-visibility"][value="organization"]').checked =
      true;
    await save();
    assert.deepEqual(sent.at(-1), { visibility: "organization" });
    d.querySelector("#bs-space").value = "sp2";
    await save();
    assert.equal(sent.at(-1).space, "sp2");
    assert.equal("team" in sent.at(-1), false);
    // Moving it back to where it was filed when the dialog opened is a
    // change from what was last saved.
    d.querySelector("#bs-space").value = "sp1";
    await save();
    assert.deepEqual(sent.at(-1), { space: "sp1" });
    d.querySelector("#bs-team").value = "";
    await save();
    assert.deepEqual(sent.at(-1), { team: null });
    d.querySelector("#bs-team").value = "tm1";
    await save();
    assert.deepEqual(sent.at(-1), { team: "tm1" });
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("audit and board activity preserve captured title language and escaped JSON while paginating and exporting", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const keys = [
    "document",
    "localStorage",
    "NodeFilter",
    "HTMLElement",
    "Node",
    "Event",
  ];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const { setLanguage } = await import("../src/i18n.js");
    setLanguage("en");
    const phrase =
      'Choisissez "les étapes" <img id="pwn-audit"> \\ ensemble.\n';
    const mixed = "Start. " + phrase + "End.";
    const first = {
      id: "first",
      at: 1,
      category: "content",
      action: "vote.started",
      target: { id: "r1" },
      details: {
        id: "v1",
        title: phrase,
        titleLang: "fr-CA",
        anonymous: false,
      },
    };
    const second = {
      id: "second",
      at: 2,
      category: "content",
      action: "poll.started",
      target: { id: "r1" },
      details: {
        id: "p1",
        title: mixed,
        titleLang: "en-CA",
        titleRuns: [
          { start: 7, end: 7 + phrase.length, style: { lang: "fr-CA" } },
        ],
        anonymous: true,
      },
    };
    const legacy = {
      id: "legacy",
      at: 3,
      category: "content",
      action: "vote.started",
      details: { id: "old", title: "Ancien choix", anonymous: false },
    };
    const invalid = {
      id: "invalid",
      at: 4,
      category: "content",
      action: "vote.started",
      details: {
        id: "bad",
        title: "Broken",
        titleLang: "bad tag",
        titleRuns: [{ start: 1, end: 1000, style: { lang: "fr" } }],
      },
    };
    const downloads = [];
    const admin = createAdminConsole({
      org: {
        isAdmin: true,
        server: "https://whiteboard.test",
        request: async (op, data) =>
          op === "org.audit"
            ? data?.cursor
              ? { entries: [second, legacy, invalid], cursor: null }
              : { entries: [first], cursor: "next" }
            : op === "org.board.activity"
              ? { entries: [second] }
              : op === "org.boards"
                ? {
                    boards: [{ room: "r1", title: "Test", created: 1 }],
                    total: 1,
                  }
                : op === "teams.list"
                  ? { teams: [] }
                  : op === "spaces.list"
                    ? { spaces: [] }
                    : {},
      },
      modal(title, html, ready) {
        const d = document.createElement("dialog");
        d.setAttribute("aria-label", title);
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon() {
        return "";
      },
      download(...args) {
        downloads.push(args);
      },
    });
    const d = admin.open("audit");
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    let details = d.querySelector(".admin-table tbody tr td:last-child");
    // Details read as named values, with the raw JSON kept as a tooltip.
    assert.equal(details.textContent, `id v1 · title ${phrase} · anonymous no`);
    assert.equal(details.getAttribute("title"), JSON.stringify(first.details));
    assert.equal(details.querySelector('[lang="fr-CA"]').textContent, phrase);
    assert.equal(d.querySelector("#pwn-audit"), null);
    d.querySelector("#au-more").focus();
    d.querySelector("#au-more").click();
    await settle();
    const rows = [...d.querySelectorAll(".admin-table tbody tr")];
    assert.equal(rows.length, 4);
    details = rows[1].lastElementChild;
    assert.equal(details.textContent, `id p1 · title ${mixed} · anonymous yes`);
    assert.equal(
      details.querySelector('[lang="en-CA"] [lang="fr-CA"]').textContent,
      phrase,
    );
    assert.equal(rows[2].lastElementChild.querySelector("[lang]"), null);
    assert.equal(rows[3].lastElementChild.querySelector("[lang]"), null);
    assert.equal(rows[3].lastElementChild.textContent, "id bad · title Broken");
    assert.equal(
      rows[3].lastElementChild.getAttribute("title"),
      JSON.stringify(invalid.details),
    );
    assert.equal(document.activeElement.id, "admin-panel");
    d.querySelector("#au-json").click();
    await settle();
    assert.deepEqual(JSON.parse(downloads.at(-1)[0]), [
      first,
      second,
      legacy,
      invalid,
    ]);
    d.querySelector("#au-csv").click();
    await settle();
    assert.match(downloads.at(-1)[0], /fr-CA/);
    dom.window.eval(axe.source);
    const result = await dom.window.axe.run(d, {
      rules: { "color-contrast": { enabled: false } },
    });
    assert.deepEqual(
      Array.from(result.violations, (v) => v.id),
      [],
    );
    setLanguage("fr");
    d.querySelector('[data-tab="boards"]').click();
    await settle();
    d.querySelector('[data-activity="r1"]').click();
    await settle();
    const activity = d.querySelector("#board-detail #audit-table");
    assert.equal(activity.tabIndex, 0);
    assert.equal(activity.getAttribute("aria-label"), "Activité du tableau");
    activity.focus();
    assert.equal(document.activeElement, activity);
    Object.defineProperties(activity, {
      clientWidth: { value: 200 },
      scrollWidth: { value: 500 },
    });
    activity.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.ok(activity.scrollLeft > 0);
    details = d.querySelector(
      "#board-detail .admin-table tbody tr td:last-child",
    );
    // In French the value names and yes/no follow the language; people's
    // text keeps its own.
    assert.equal(details.textContent, `id p1 · titre ${mixed} · anonyme oui`);
    assert.equal(
      details.querySelector('[lang="en-CA"] [lang="fr-CA"]').textContent,
      phrase,
    );
  } finally {
    const { setLanguage } = await import("../src/i18n.js");
    setLanguage("en");
    for (const key of keys) delete globalThis[key];
    dom.window.close();
  }
});

test("French authored feedback retains its language through the real worker and admin report", async () => {
  const { environment, owner } = await import("./collaboration-helpers.js");
  const { adminCall } = await import("../worker/admin.js");
  const env = environment(),
    org = env.service.org;
  await adminCall(org, env.service, owner, {
    op: "org.setup",
    name: "Feedback audit",
  });
  const dom = new JSDOM('<!doctype html><html lang="fr"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = [
    "document",
    "localStorage",
    "NodeFilter",
    "HTMLElement",
    "Node",
    "Event",
  ];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createHelpCenter } = await import("../src/help/help-center.js");
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const { setLanguage, translateUI } = await import("../src/i18n.js");
    setLanguage("fr");
    const modal = (title, html, ready) => {
      const d = document.createElement("dialog");
      d.setAttribute("aria-label", title);
      d.innerHTML = html;
      document.body.append(d);
      ready?.(d);
      return d;
    };
    let request;
    createHelpCenter({
      modal,
      icon: () => "",
      tour() {},
      shortcuts() {},
      refresh: () => translateUI(),
      org: {
        info: { role: "owner" },
        async request(op, data) {
          request = { op, ...data };
          return adminCall(org, env.service, owner, request);
        },
      },
    }).open();
    const sentence = "Veuillez faciliter la navigation entre les tableaux.";
    document.querySelector("#help-comment").value = sentence;
    document.querySelector('[name="help-ease"][value="4"]').checked = true;
    document
      .querySelector("#help-feedback")
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    for (let i = 0; i < 50 && document.querySelector("#help-feedback"); i++)
      await new Promise((r) => setTimeout(r, 2));
    assert.equal(document.querySelector("#help-feedback"), null);
    const records = [...env.data]
      .filter(([key]) => key.startsWith("org:feedback:"))
      .map(([, value]) => value);
    assert.equal(records[0].comment, sentence);
    const report = await adminCall(org, env.service, owner, {
      op: "org.reports",
      days: 30,
    });
    assert.equal(report.feedback.recent[0].comment, sentence);
    const legacy = "Un ancien commentaire sans langue connue.";
    await adminCall(org, env.service, owner, {
      op: "feedback.submit",
      ease: 3,
      comment: legacy,
    });
    setLanguage("en");
    const admin = createAdminConsole({
      org: {
        isAdmin: true,
        server: "https://whiteboard.test",
        request: async (op, data) =>
          adminCall(org, env.service, owner, { op, ...data }),
      },
      modal,
      toast() {},
      icon: () => "",
      download() {},
      refresh: () => translateUI(),
    });
    const d = admin.open();
    for (let i = 0; i < 50 && !d.querySelector(".feedback-comments"); i++)
      await new Promise((r) => setTimeout(r, 2));
    const feedback = d.querySelector(
      '.feedback-comments li [data-user-content][lang="fr"]',
    );
    assert.equal(request.lang, "fr");
    assert.equal(records[0].lang, "fr");
    assert.equal(report.feedback.recent[0].lang, "fr");
    assert.equal(records[0].uuid, undefined);
    assert.equal(report.feedback.recent[0].uuid, undefined);
    assert.equal(feedback.closest("[lang]")?.getAttribute("lang"), "fr");
    const old = [
      ...d.querySelectorAll(".feedback-comments [data-user-content]"),
    ].find((node) => node.textContent === legacy);
    assert.ok(old);
    assert.equal(old.hasAttribute("lang"), false);
    assert.equal(old.querySelector("[lang]"), null);
  } finally {
    const { setLanguage } = await import("../src/i18n.js");
    setLanguage("en");
    for (const key of keys) delete globalThis[key];
    dom.window.close();
  }
});

test("organization date filters refuse years the app cannot search", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
    pretendToBeVisual: true,
  });
  const keys = [
    "document",
    "localStorage",
    "NodeFilter",
    "HTMLElement",
    "Node",
    "Event",
  ];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const sent = [];
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      isMember: true,
      info: { name: "Fabrikam", role: "admin", user: { emailVerified: true } },
      request: async (op, data) => {
        sent.push([op, data]);
        if (op === "org.audit") return { entries: [], cursor: null };
        if (op === "org.boards") return { boards: [], total: 0 };
        if (op === "teams.list") return { teams: [] };
        if (op === "spaces.list") return { spaces: [] };
        return {};
      },
      refresh: async () => {},
    };
    const modal = (title, html, ready) => {
      const d = document.createElement("dialog");
      d.innerHTML = html;
      document.body.append(d);
      ready?.(d);
      return d;
    };
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const admin = createAdminConsole({
      org,
      modal,
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("audit");
    await settle();
    const panel = d.querySelector("#admin-panel");
    // Date fields accept years of up to six digits, which cannot be
    // converted to the times the worker filters by.
    for (const id of ["#au-from", "#au-to"]) {
      const field = d.querySelector(id);
      assert.equal(field.min, "0100-01-01");
      assert.equal(field.max, "9999-12-31");
    }
    d.querySelector("#au-to").value = "20266-01-31";
    d.querySelector("#audit-filters .primary").click();
    await settle();
    assert.ok(panel.querySelector("#audit-filters"));
    assert.equal(sent.filter(([op]) => op === "org.audit").length, 1);
    d.querySelector('[data-tab="boards"]').click();
    await settle();
    assert.equal(d.querySelector("#bf-after").max, "9999-12-31");
    d.querySelector("#bf-after").value = "20266-01-31";
    d.querySelector("#board-filters .primary").click();
    await settle();
    assert.ok(panel.querySelector("#board-filters"));
    assert.equal(sent.filter(([op]) => op === "org.boards").length, 1);
    const home = createOrganizationHome({
      org,
      modal,
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    const grid = document.createElement("div");
    document.body.append(grid);
    await home.renderBoards(grid);
    assert.equal(grid.querySelector("#of-after").max, "9999-12-31");
    grid.querySelector("#of-after").value = "20266-01-31";
    grid.querySelector("#org-filters .primary").click();
    await settle();
    assert.equal(sent.filter(([op]) => op === "org.boards").length, 2);
    assert.doesNotMatch(
      grid.querySelector("#org-results").textContent,
      /Invalid time value/,
    );
  } finally {
    for (const key of keys) delete globalThis[key];
    dom.window.close();
  }
});

test("revoking invitation links stops showing the link created before", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
    pretendToBeVisual: true,
  });
  const keys = [
    "document",
    "localStorage",
    "NodeFilter",
    "HTMLElement",
    "Node",
    "Event",
    "location",
  ];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      refresh: async () => {},
      request: async (op) =>
        op === "org.users.list"
          ? { owner: { uuid: "u1", username: "alice" }, users: [] }
          : op === "teams.list"
            ? { teams: [] }
            : op === "org.invite"
              ? { token: "tok123" }
              : { ok: true },
    };
    const toasts = [];
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast: (message) => toasts.push(message),
      icon: () => "",
      download() {},
    });
    const settle = () => new Promise((r) => setTimeout(r, 30));
    const d = admin.open("people");
    await settle();
    d.querySelector("#invite-people").click();
    await settle();
    assert.equal(d.querySelector("#invite-output-field").hidden, false);
    assert.match(d.querySelector("#invite-output").value, /tok123/);
    // How long the link works is shown beside it, not only announced.
    const note = d.querySelector("#invite-output-note");
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /expires in 14 days/);
    // The link copies with one press, or is left selected to copy where
    // the clipboard is refused.
    const copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => copied.push(text) },
    });
    const copy = d.querySelector('[data-copy="invite-output"]');
    copy.click();
    await settle();
    assert.deepEqual(copied, [d.querySelector("#invite-output").value]);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("denied");
        },
      },
    });
    copy.click();
    await settle();
    assert.equal(document.activeElement, d.querySelector("#invite-output"));
    delete navigator.clipboard;
    assert.deepEqual(toasts.splice(0), [
      "Link copied.",
      "Copy the selected text.",
    ]);
    const revoke = d.querySelector("#revoke-org-invites");
    revoke.click();
    revoke.click();
    await settle();
    assert.deepEqual(toasts, ["Invitation links revoked."]);
    assert.equal(d.querySelector("#invite-output-field").hidden, true);
    assert.equal(d.querySelector("#invite-output").value, "");
    assert.equal(d.querySelector("#invite-output-note").hidden, true);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("a destructive button whose confirmed action fails asks for confirmation again", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    let deletes = 0;
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op) => {
        if (op === "teams.delete") {
          deletes++;
          throw Error("The organization service is unavailable.");
        }
        if (op === "org.users.list")
          return { owner: { uuid: "u1", username: "alice" }, users: [] };
        if (op === "teams.list")
          return { teams: [{ id: "t1", name: "Design", members: [] }] };
        return {};
      },
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
      migrate() {},
    });
    const d = admin.open();
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    d.querySelector('[data-tab="people"]').click();
    await settle();
    const button = d.querySelector("[data-delete-team]");
    button.click();
    assert.equal(button.textContent, "Confirm delete");
    assert.equal(deletes, 0, "The first press only arms the button");
    button.click();
    await settle();
    assert.equal(deletes, 1);
    assert.equal(d.querySelector("#admin-error").hidden, false);
    assert.equal(button.dataset.confirmed, undefined, "Disarmed after failing");
    assert.equal(button.textContent, "Delete");
    button.click();
    await settle();
    assert.equal(deletes, 1, "The next press asks again instead of deleting");
    assert.equal(button.textContent, "Confirm delete");
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("Open in the board directory keeps the console when the board cannot be opened", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    let fail = true;
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op) => {
        if (op === "org.boards")
          return {
            boards: [
              {
                room: "r1",
                title: "Kickoff",
                owner: "alice",
                objectCount: 3,
                visibility: "private",
                created: 1700000000000,
              },
            ],
            total: 1,
          };
        if (op === "teams.list") return { teams: [] };
        if (op === "spaces.list") return { spaces: [] };
        if (op === "org.users.list")
          return { owner: { uuid: "u1", username: "alice" }, users: [] };
        return {};
      },
      refresh: async () => {},
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.open = true;
        d.close = () => {
          d.open = false;
        };
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
      migrate() {},
      openBoard: async () => {
        if (fail) throw Error("Board not found.");
      },
    });
    const d = admin.open();
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    d.querySelector('[data-tab="boards"]').click();
    await settle();
    d.querySelector("[data-open-board]").click();
    await settle();
    assert.equal(d.open, true, "The console stays open");
    assert.equal(d.querySelector("#admin-error").hidden, false);
    assert.equal(
      d.querySelector("#admin-error").textContent,
      "Board not found.",
    );
    fail = false;
    d.querySelector("[data-open-board]").click();
    await settle();
    assert.equal(d.open, false, "The console closes once the board opened");
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("deactivating a person takes a second choice of Deactivated", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const calls = [];
    const person = {
      uuid: "u2",
      username: "bob",
      email: "bob@fabrikam.test",
      emailVerified: true,
      role: "member",
      status: "active",
      teams: [],
      lastActive: Date.now(),
    };
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op, data) => {
        calls.push([op, data]);
        if (op === "org.users.list")
          return { owner: { uuid: "u1", username: "alice" }, users: [person] };
        if (op === "org.users.update") return { user: { ...person, ...data } };
        if (op === "teams.list") return { teams: [] };
        return {};
      },
      refresh: async () => {},
    };
    const toasts = [];
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast: (m) => toasts.push(m),
      icon: () => "",
      download() {},
    });
    const d = admin.open("people");
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    const select = () => d.querySelector('[data-status="u2"]');
    const change = (value) => {
      select().value = value;
      select().dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    };
    // One change, as an arrow key through the closed select makes, ends
    // nobody's sessions: the select springs back and asks to be sure.
    change("deactivated");
    await settle();
    assert.equal(
      calls.some(([op]) => op === "org.users.update"),
      false,
    );
    assert.equal(select().value, "active");
    assert.match(
      d.querySelector("#admin-status").textContent,
      /Choose Deactivated again/,
    );
    // The request is visible beside the select, not only announced.
    const note = d.querySelector("#deactivate-note");
    assert.match(note?.textContent || "", /Choose Deactivated again/);
    assert.equal(note.previousElementSibling, select());
    assert.equal(select().getAttribute("aria-describedby"), "deactivate-note");
    change("deactivated");
    await settle();
    assert.equal(d.querySelector("#deactivate-note"), null);
    assert.deepEqual(calls.find(([op]) => op === "org.users.update")?.[1], {
      uuid: "u2",
      status: "deactivated",
    });
    assert.deepEqual(toasts, ["Account deactivated. Their sessions end now."]);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("giving or taking away administration takes a second choice, and the select keeps the keyboard while it saves", async () => {
  const person = {
    uuid: "u2",
    username: "bob",
    role: "member",
    status: "active",
    teams: [],
  };
  let release;
  await withConsole(
    (op, data) => {
      if (op === "org.users.list")
        return { owner: { uuid: "u1", username: "alice" }, users: [person] };
      if (op === "teams.list") return { teams: [] };
      if (op === "org.users.update")
        return new Promise((done) => {
          release = () => done({ user: { ...person, ...data } });
        });
      return {};
    },
    "people",
    async ({ d, w, calls, settle }) => {
      const select = () => d.querySelector('[data-role="u2"]');
      const choose = (value) => {
        select().value = value;
        select().dispatchEvent(new w.Event("change", { bubbles: true }));
      };
      const updates = () => calls.filter(([op]) => op === "org.users.update");
      select().focus();
      // One change, as an arrow key through the closed select makes, gives
      // nobody administration: the select springs back and asks again.
      choose("admin");
      await settle();
      assert.equal(updates().length, 0);
      assert.equal(select().value, "member");
      const note = d.querySelector("#role-note");
      assert.match(note.textContent, /Choose Administrator again/);
      assert.equal(select().getAttribute("aria-describedby"), "role-note");
      assert.match(
        d.querySelector("#admin-status").textContent,
        /Choose Administrator again/,
      );
      choose("admin");
      await settle();
      assert.deepEqual(updates().at(-1)[1], { uuid: "u2", role: "admin" });
      assert.equal(d.querySelector("#role-note"), null);
      // While it saves, the select keeps the keyboard and reads
      // unavailable; another choice springs back.
      assert.equal(document.activeElement, select());
      assert.equal(select().disabled, false);
      assert.equal(select().getAttribute("aria-disabled"), "true");
      choose("guest");
      assert.equal(select().value, "admin");
      assert.equal(updates().length, 1);
      release();
      await settle();
      assert.equal(select().hasAttribute("aria-disabled"), false);
      assert.equal(document.activeElement, select());
      // Taking administration away asks again too, naming the role.
      choose("member");
      await settle();
      assert.equal(updates().length, 1);
      assert.equal(select().value, "admin");
      assert.match(
        d.querySelector("#role-note").textContent,
        /Choose Member again/,
      );
      choose("member");
      await settle();
      assert.deepEqual(updates().at(-1)[1], { uuid: "u2", role: "member" });
      release();
      await settle();
      // A role that has nothing to do with administration goes at once.
      choose("guest");
      await settle();
      assert.deepEqual(updates().at(-1)[1], { uuid: "u2", role: "guest" });
      release();
      await settle();
    },
  );
});

test("the selected tab is brought into the phone tab row", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op) =>
          op === "org.audit" ? { entries: [], cursor: null } : {},
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        // A 300 px row of seven 100 px tabs, scrolled by scrollLeft.
        const row = d.querySelector('[role="tablist"]');
        row.scrollLeft = 0;
        row.getBoundingClientRect = () => ({ left: 0, right: 300 });
        [...row.children].forEach((tab, n) => {
          tab.getBoundingClientRect = () => ({
            left: n * 100 - row.scrollLeft,
            right: n * 100 + 100 - row.scrollLeft,
          });
        });
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("audit");
    const row = d.querySelector('[role="tablist"]');
    // The last tab, Audit log, ends at 700 px: the row scrolls to it.
    assert.equal(row.scrollLeft, 400);
    d.querySelector("#admin-tab-overview").click();
    assert.equal(row.scrollLeft, 0);
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("an administrator cannot act on another administrator's row", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const person = (uuid, username, role) => ({
      uuid,
      username,
      role,
      status: "active",
      teams: [],
    });
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        info: { role: "admin" },
        request: async (op) =>
          op === "org.users.list"
            ? {
                owner: { uuid: "u1", username: "alice" },
                users: [
                  person("u2", "bob", "admin"),
                  person("u3", "cam", "member"),
                ],
              }
            : { teams: [] },
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("people");
    await new Promise((r) => setTimeout(r, 20));
    // The worker refuses all three for another administrator; the row
    // says so rather than offering them.
    for (const selector of ["data-role", "data-status", "data-transfer"]) {
      const control = d.querySelector(`[${selector}="u2"]`);
      assert.equal(control.disabled, true, selector);
      assert.match(
        control.getAttribute("aria-describedby"),
        /(^| )admin-permissions$/,
      );
      assert.equal(d.querySelector(`[${selector}="u3"]`).disabled, false);
    }
    assert.match(
      d.querySelector("#admin-permissions").textContent,
      /transfer their boards/,
    );
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("an emptied retention or guest expiry field is not saved as a default", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const { normalizePolicy } = await import("../worker/org.js");
    const calls = [];
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op, data) => {
          calls.push(op);
          return {
            policy: normalizePolicy({
              guestExpiryDays: 30,
              retention: { auditDays: 3650, deletedBoardDays: 365 },
            }),
            secrets: {},
          };
        },
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("policies");
    await new Promise((r) => setTimeout(r, 20));
    // Blank used to save as 0 (guests never expire), 365 and 30 days.
    for (const id of ["p-guest-days", "p-audit-days", "p-deleted-days"]) {
      const field = d.querySelector("#" + id);
      const kept = field.value;
      field.value = "";
      d.querySelector("#policy-form").requestSubmit();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(field.validity.valueMissing, true, id);
      assert.deepEqual(calls, ["org.policy.get"], id);
      field.value = kept;
    }
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("an action finishing after another action's reload still shows its outcome", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const deferred = () => {
      let resolve, reject;
      const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
      return { promise, resolve, reject };
    };
    let teams = ["Design", "Research", "Sales"].map((name, n) => ({
      id: "t" + n,
      name,
      members: [],
    }));
    const pending = {};
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op, data) =>
          op === "org.users.list"
            ? { owner: { uuid: "u1", username: "alice" }, users: [] }
            : op === "teams.list"
              ? { teams: teams.map((tm) => ({ ...tm })) }
              : (pending[data.id] = deferred()).promise,
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const d = admin.open("people");
    await settle();
    const names = () =>
      [...d.querySelectorAll(".team-row strong")].map((el) => el.textContent);
    // Three deletions confirmed in quick succession, all in flight.
    for (const id of ["t0", "t1", "t2"]) {
      const button = d.querySelector(`[data-delete-team="${id}"]`);
      button.click();
      button.click();
    }
    await settle();
    teams = teams.filter((tm) => tm.id !== "t0");
    pending.t0.resolve({ ok: true });
    await settle();
    assert.deepEqual(names(), ["Research", "Sales"]);
    // The second finished after the first one's reload: it still reloads.
    teams = teams.filter((tm) => tm.id !== "t1");
    pending.t1.resolve({ ok: true });
    await settle();
    assert.deepEqual(names(), ["Sales"]);
    // And a refusal is still explained.
    pending.t2.reject(Error("This team is managed by SCIM."));
    await settle();
    const error = d.querySelector("#admin-error");
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, "This team is managed by SCIM.");
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("stored integration and SIEM secrets can be removed", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const { normalizePolicy } = await import("../worker/org.js");
    const saved = [];
    const secrets = {
      slack: true,
      jira: true,
      sentinel: true,
      "siem-token": true,
    };
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op, data) => {
          if (op === "org.policy.set") saved.push(data.secrets);
          if (op === "apikeys.list") return { keys: [], scopes: [] };
          if (op === "webhooks.list")
            return { webhooks: [], events: ["*"], pending: 0 };
          return { policy: normalizePolicy({}), secrets };
        },
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const d = admin.open("integrations");
    await settle();
    // Leaving the fields empty keeps every stored secret.
    d.querySelector("#integrations-form").requestSubmit();
    await settle();
    d.querySelector("#i-slack-off").checked = true;
    d.querySelector("#i-jira-off").checked = true;
    d.querySelector("#integrations-form").requestSubmit();
    await settle();
    // Single sign-on is not offered as if it worked; multifactor
    // authentication is Puter's.
    assert.match(
      d.textContent,
      /single sign-on needs the Puter account platform and is not available yet/,
    );
    d.querySelector("#admin-tab-security").click();
    await settle();
    assert.match(
      d.textContent,
      /Puter enforces multifactor authentication at sign-in/,
    );
    assert.doesNotMatch(d.textContent, /enforce it in Google Workspace/);
    d.querySelector("#s-secret-off").checked = true;
    d.querySelector("#s-token-off").checked = true;
    d.querySelector("#siem-form").requestSubmit();
    await settle();
    // A new value entered beside the removal wins.
    d.querySelector("#s-token-off").checked = true;
    d.querySelector("#s-token").value = "new-token";
    d.querySelector("#siem-form").requestSubmit();
    await settle();
    assert.deepEqual(saved, [
      {},
      { slack: null, jira: null },
      { sentinel: null, "siem-token": null },
      { "siem-token": "new-token" },
    ]);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("Enter in the team member search does not save the team", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op) =>
          op === "org.users.list"
            ? { owner: { uuid: "u1", username: "alice" }, users: [] }
            : { teams: [] },
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("people");
    await new Promise((r) => setTimeout(r, 20));
    d.querySelector("#new-team").click();
    // The search sits in the team form, whose default button saves it.
    const enter = new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    d.querySelector("#team-member-search").dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, true);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("a deleted team or space no longer narrows the board list", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    let teams = [{ id: "t1", name: "Design", members: [] }];
    let spaces = [{ id: "s1", name: "Discovery" }];
    const sent = [];
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op, data) => {
          if (op === "org.boards") sent.push(data);
          return op === "teams.list"
            ? { teams }
            : op === "spaces.list"
              ? { spaces }
              : { boards: [], total: 0 };
        },
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const d = admin.open("boards");
    await settle();
    d.querySelector("#bf-team").value = "t1";
    d.querySelector("#bf-space").value = "s1";
    d.querySelector("#board-filters").requestSubmit();
    await settle();
    assert.equal(sent.at(-1).team, "t1");
    assert.equal(sent.at(-1).space, "s1");
    // The team goes, elsewhere in the console: its filter goes with it,
    // and the space chosen beside it stays.
    teams = [];
    d.querySelector("#admin-tab-people").click();
    d.querySelector("#admin-tab-boards").click();
    await settle();
    assert.equal(sent.at(-1).team, undefined);
    assert.equal(sent.at(-1).space, "s1");
    assert.equal(d.querySelector("#bf-space").value, "s1");
    spaces = [];
    d.querySelector("#board-filters").requestSubmit();
    await settle();
    assert.equal(sent.at(-1).space, undefined);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("after a row action the keyboard stays at that row in the list", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    let teams = ["Design", "Research", "Sales"].map((name, n) => ({
      id: "t" + n,
      name,
      members: [],
    }));
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op, data) => {
          if (op === "teams.delete")
            teams = teams.filter((tm) => tm.id !== data.id);
          return op === "org.users.list"
            ? { owner: { uuid: "u1", username: "alice" }, users: [] }
            : { teams: teams.map((tm) => ({ ...tm })) };
        },
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const d = admin.open("people");
    await settle();
    // Editing keeps the keyboard on the same team's button after a reload.
    const edit = d.querySelector('[data-edit-team="t1"]');
    edit.focus();
    d.querySelector("#admin-tab-people").click();
    edit.blur();
    await settle();
    assert.equal(
      document.activeElement,
      d.querySelector('[data-edit-team="t1"]'),
    );
    // Deleting Research leaves the keyboard on the row now in its place,
    // Sales, rather than at the top of the panel.
    const remove = d.querySelector('[data-delete-team="t1"]');
    remove.focus();
    remove.click();
    remove.click();
    await settle();
    assert.equal(
      document.activeElement,
      d.querySelector('[data-delete-team="t2"]'),
    );
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("people and teams are listed by name", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    // In uuid order, as the worker lists them.
    const users = [
      ["u1", "zoe"],
      ["u2", "person10"],
      ["u3", undefined, "dee@fabrikam.test"],
      ["u4", "Adam"],
      ["u5", "person2"],
    ].map(([uuid, username, email]) => ({
      uuid,
      username,
      email,
      role: "member",
      status: "active",
      teams: [],
    }));
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op) =>
          op === "org.users.list"
            ? { owner: { uuid: "o", username: "alice" }, users }
            : {
                teams: [
                  { id: "t1", name: "Sales", members: [] },
                  { id: "t2", name: "design", members: [] },
                ],
              },
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("people");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      [...d.querySelectorAll("[data-role]")].map((el) => el.dataset.role),
      ["u4", "u3", "u5", "u2", "u1"],
    );
    assert.deepEqual(
      [...d.querySelectorAll(".team-row strong")].map((el) => el.textContent),
      ["design", "Sales"],
    );
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("audit detail names read in French", async () => {
  const dom = new JSDOM('<!doctype html><html lang="fr"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  const { setLanguage } = await import("../src/i18n.js");
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    setLanguage("fr");
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async () => ({
          entries: [
            {
              id: "a1",
              at: 1,
              category: "admin",
              action: "policy.updated",
              actor: { username: "alice" },
              target: {},
              // As the worker records a policy change, a key and a SCIM user.
              details: {
                changed: ["retention"],
                secretsChanged: [],
                scopes: ["scim"],
                status: "active",
                skipped: 0,
                owner: "bob",
              },
            },
          ],
          cursor: null,
        }),
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const d = admin.open("audit");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      [...d.querySelectorAll(".audit-detail-name")].map((el) => el.textContent),
      [
        "modifiés",
        "secrets modifiés",
        "portées",
        "statut",
        "ignorés",
        "propriétaire",
      ],
    );
  } finally {
    setLanguage("en");
    for (const key of keys) delete globalThis[key];
  }
});

test("policy settings that cannot take effect are shown unavailable", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const { normalizePolicy } = await import("../worker/org.js");
    const saved = [];
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op, data) => {
          if (op === "org.policy.set") saved.push(data.policy);
          return {
            policy: normalizePolicy({
              externalSharing: "guests",
              guestAccess: true,
              guestExpiryDays: 30,
              publicLinks: true,
              ai: { enabled: false, summaries: true },
            }),
            secrets: {},
          };
        },
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const d = admin.open("policies");
    await settle();
    const field = (id) => d.querySelector("#" + id);
    const change = (id, apply) => {
      apply(field(id));
      field(id).dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    };
    // Public links need "Guests and public links"; AI features need AI.
    assert.equal(field("p-links").disabled, true);
    assert.equal(field("p-guests").disabled, false);
    assert.equal(field("p-ai-summaries").disabled, true);
    assert.equal(field("p-ai-model").disabled, true);
    change("p-external", (el) => (el.value = "anyone"));
    assert.equal(field("p-links").disabled, false);
    // Boards can still be given a public link with guests off.
    change("p-guests", (el) => (el.checked = false));
    assert.equal(field("p-links").disabled, false);
    assert.equal(field("p-guest-days").disabled, true);
    change("p-guests", (el) => (el.checked = true));
    change("p-restrict", (el) => (el.checked = true));
    assert.equal(field("p-guests").disabled, true);
    assert.equal(field("p-links").disabled, false);
    change("p-external", (el) => (el.value = "none"));
    assert.equal(field("p-links").disabled, true);
    change("p-ai", (el) => (el.checked = true));
    assert.equal(field("p-ai-summaries").disabled, false);
    // A report schedule asks for its recipients.
    assert.equal(field("p-report-emails").required, false);
    change("p-report", (el) => (el.value = "weekly"));
    assert.equal(field("p-report-emails").required, true);
    change("p-report", (el) => (el.value = "none"));
    assert.equal(field("p-report-emails").required, false);
    // Unavailable settings keep their values, and an emptied unavailable
    // period keeps the one it had.
    field("p-guest-days").value = "";
    field("p-ai").checked = false;
    change("p-ai", () => {});
    d.querySelector("#policy-form").requestSubmit();
    await settle();
    // They were not changed here, so none of them is sent.
    assert.equal(saved.length, 1);
    for (const key of ["guestAccess", "publicLinks", "guestExpiryDays"])
      assert.equal(key in saved[0], false, key);
    assert.equal(saved[0].ai?.summaries, undefined);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("settings typed but not saved survive a visit to another tab", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const { normalizePolicy } = await import("../worker/org.js");
    let policy = normalizePolicy({ name: "Fabrikam" });
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op, data) => {
          if (op === "org.policy.set")
            policy = normalizePolicy({ ...policy, ...data.policy });
          return op === "org.users.list"
            ? { owner: { uuid: "u1", username: "alice" }, users: [] }
            : op === "teams.list"
              ? { teams: [] }
              : { policy, secrets: {} };
        },
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const d = admin.open("policies");
    await settle();
    const note = () => d.querySelector(".unsaved-note");
    assert.equal(note().hidden, true);
    const name = d.querySelector("#p-name");
    name.value = "Fabrikam Digital Services";
    name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const create = d.querySelector("#p-create");
    create.checked = !create.checked;
    create.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(note().hidden, false);
    // A look at People, then back: what was typed is still there.
    d.querySelector("#admin-tab-people").click();
    await settle();
    d.querySelector("#admin-tab-policies").click();
    await settle();
    assert.equal(d.querySelector("#p-name").value, "Fabrikam Digital Services");
    assert.equal(d.querySelector("#p-create").checked, create.checked);
    assert.equal(note().hidden, false);
    // Putting one value back leaves the other change unsaved.
    const again = d.querySelector("#p-create");
    again.checked = !again.checked;
    again.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(note().hidden, false);
    // Saving clears it, and the next visit shows what was saved.
    d.querySelector("#policy-form").requestSubmit();
    await settle();
    assert.equal(note().hidden, true);
    assert.equal(policy.name, "Fabrikam Digital Services");
    d.querySelector("#admin-tab-people").click();
    await settle();
    d.querySelector("#admin-tab-policies").click();
    await settle();
    assert.equal(note().hidden, true);
    assert.equal(d.querySelector("#p-name").value, "Fabrikam Digital Services");
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("closing the console with unsaved settings asks first", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const { normalizePolicy } = await import("../worker/org.js");
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async () => ({ policy: normalizePolicy({}), secrets: {} }),
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        d.setAttribute("open", "");
        d.close = () => {
          d.removeAttribute("open");
          d.dispatchEvent(new dom.window.Event("close"));
        };
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    let d = admin.open("policies");
    await settle();
    // Nothing typed: the console closes at once.
    d.close();
    assert.equal(d.hasAttribute("open"), false);
    d = admin.open("policies");
    await settle();
    const name = d.querySelector("#p-name");
    name.value = "Renamed";
    name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    // Escape, the close button and the backdrop all close the dialog.
    const escape = new dom.window.Event("cancel", { cancelable: true });
    d.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(d.hasAttribute("open"), true);
    const error = d.querySelector("#admin-error");
    assert.equal(error.hidden, false);
    assert.equal(
      error.textContent,
      "Changes in Policies are not saved. Close again to discard them.",
    );
    // Typing again takes the warning back and asks again; a second close
    // in a row discards.
    name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(error.hidden, true);
    d.close();
    assert.equal(error.hidden, false);
    assert.equal(d.hasAttribute("open"), true);
    d.close();
    assert.equal(d.hasAttribute("open"), false);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("a setting changed while a save is on its way stays unsaved", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const { normalizePolicy } = await import("../worker/org.js");
    let finish;
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: (op) =>
          op === "org.policy.set"
            ? new Promise((resolve) => (finish = resolve))
            : Promise.resolve({ policy: normalizePolicy({}), secrets: {} }),
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const d = admin.open("policies");
    await settle();
    const edit = (id, value) => {
      d.querySelector("#" + id).value = value;
      d.querySelector("#" + id).dispatchEvent(
        new dom.window.Event("input", { bubbles: true }),
      );
    };
    edit("p-name", "Sent");
    d.querySelector("#policy-form").requestSubmit();
    await settle();
    // Typed after Save was pressed: not part of what was sent.
    edit("p-audit-days", "30");
    finish({ policy: {} });
    await settle();
    assert.equal(d.querySelector(".unsaved-note").hidden, false);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("opening a board from settings with unsaved changes asks first", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const { normalizePolicy } = await import("../worker/org.js");
    const opened = [];
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op) =>
          op === "org.boards"
            ? { boards: [{ room: "r1", title: "Plan", created: 1 }], total: 1 }
            : op === "teams.list"
              ? { teams: [] }
              : op === "spaces.list"
                ? { spaces: [] }
                : { policy: normalizePolicy({}), secrets: {} },
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        d.setAttribute("open", "");
        d.close = () => {
          d.removeAttribute("open");
          d.dispatchEvent(new dom.window.Event("close"));
        };
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
      openBoard: async (room) => opened.push(room),
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const d = admin.open("policies");
    await settle();
    const name = d.querySelector("#p-name");
    name.value = "Renamed";
    name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    d.querySelector("#admin-tab-boards").click();
    await settle();
    d.querySelector('[data-open-board="r1"]').click();
    await settle();
    assert.deepEqual(opened, []);
    assert.equal(
      d.querySelector("#admin-error").textContent,
      "Changes in Policies are not saved. Open the board again to discard them.",
    );
    d.querySelector('[data-open-board="r1"]').click();
    await settle();
    assert.deepEqual(opened, ["r1"]);
    assert.equal(d.hasAttribute("open"), false);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("SIEM and webhook delivery failures read in French with their status", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  globalThis.localStorage = dom.window.localStorage;
  const { setLanguage } = await import("../src/i18n.js");
  try {
    const { deliveryText } = await import("../src/organization/admin-ui.js");
    // The app loads the workers' messages at start.
    await import("../src/worker-strings.js");
    setLanguage("fr");
    assert.equal(
      deliveryText("SIEM endpoint returned 500."),
      "Le point de terminaison SIEM a renvoyé 500.",
    );
    assert.equal(
      deliveryText("Webhook returned 404."),
      "Le webhook a renvoyé 404.",
    );
    assert.equal(
      deliveryText("Sentinel ingestion failed (403)."),
      "L’ingestion dans Sentinel a échoué (403).",
    );
    // Entra's own error code is kept as sent, even with a "$" in it.
    assert.equal(
      deliveryText("Microsoft Entra sign-in failed (401): invalid_client$&"),
      "La connexion à Microsoft Entra a échoué (401) : invalid_client$&",
    );
    assert.equal(
      deliveryText("The SIEM test failed."),
      "L’essai du SIEM a échoué.",
    );
    setLanguage("en");
    assert.equal(
      deliveryText("Webhook returned 404."),
      "Webhook returned 404.",
    );
  } finally {
    setLanguage("en");
    dom.window.close();
  }
});

test("administrators filter the board directory by owner", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const sent = [];
    const admin = createAdminConsole({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isAdmin: true,
        request: async (op, data) => {
          if (op === "org.boards") sent.push(data);
          if (op === "org.users.list")
            return {
              owner: { uuid: "o1", username: "Zoe" },
              users: [
                {
                  uuid: "u1",
                  username: "Ana",
                  role: "member",
                  status: "active",
                },
                {
                  uuid: "u2",
                  email: "kim@fabrikam.test",
                  role: "member",
                  status: "pending",
                },
              ],
            };
          return op === "teams.list"
            ? { teams: [] }
            : op === "spaces.list"
              ? { spaces: [] }
              : { boards: [], total: 0 };
        },
        refresh: async () => {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download() {},
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const d = admin.open("boards");
    await settle();
    const owner = d.querySelector("#bf-owner");
    assert.deepEqual(
      [...owner.options].map((o) => o.textContent),
      ["Anyone", "Ana", "kim@fabrikam.test", "Zoe"],
    );
    owner.value = "u1";
    d.querySelector("#board-filters").requestSubmit();
    await settle();
    assert.equal(sent.at(-1).owner, "u1");
    assert.equal(d.querySelector("#bf-owner").value, "u1");
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

// An administration console on a fake organization whose requests `respond`
// answers; `run` gets the dialog and the requests made.
async function withConsole(respond, tab, run, options = {}) {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
    pretendToBeVisual: true,
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createAdminConsole } =
      await import("../src/organization/admin-ui.js");
    const calls = [];
    const downloads = [];
    const org = {
      server: "https://whiteboard-abc.puter.work",
      isAdmin: true,
      request: async (op, data) => {
        calls.push([op, data]);
        return respond(op, data);
      },
      refresh: async () => {},
      ...options.org,
    };
    const admin = createAdminConsole({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      download: (...args) => downloads.push(args),
      ...options.console,
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const d = admin.open(tab);
    await settle();
    await run({ d, w: dom.window, calls, downloads, settle, admin, org });
  } finally {
    for (const key of keys) delete globalThis[key];
  }
}

test("saving settings sends only what was changed, keeping another administrator's changes", async () => {
  const { normalizePolicy, mergePolicy } = await import("../worker/org.js");
  let policy = normalizePolicy({
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  await withConsole(
    (op, data) => {
      if (op === "org.policy.set")
        policy = mergePolicy(policy, structuredClone(data.policy));
      if (op === "org.users.list")
        return { owner: { uuid: "u1", username: "alice" }, users: [] };
      if (op === "teams.list") return { teams: [] };
      if (op === "apikeys.list") return { keys: [], scopes: [] };
      if (op === "webhooks.list") return { webhooks: [], events: [] };
      return { policy: structuredClone(policy), secrets: {} };
    },
    "policies",
    async ({ d, w, calls, settle }) => {
      const sent = () =>
        calls.filter(([op]) => op === "org.policy.set").at(-1)[1];
      const change = (id, value) => {
        const el = d.querySelector("#" + id);
        if (el.type === "checkbox") el.checked = value;
        else el.value = value;
        el.dispatchEvent(new w.Event("change", { bubbles: true }));
      };
      // Another administrator turns on the legal hold while this form is
      // open; turning AI off here leaves the hold on.
      policy = mergePolicy(policy, { retention: { legalHold: true } });
      change("p-ai", false);
      d.querySelector("#policy-form").requestSubmit();
      await settle();
      assert.deepEqual(sent().policy, { ai: { enabled: false } });
      assert.equal(policy.retention.legalHold, true);
      // A draft kept while another tab is open holds only what was typed,
      // not the rest of the form as it read then.
      change("p-name", "Fabrikam Digital Services");
      d.querySelector("#admin-tab-people").click();
      await settle();
      policy = mergePolicy(policy, { guestAccess: false });
      d.querySelector("#admin-tab-policies").click();
      await settle();
      assert.equal(d.querySelector("#p-hold").checked, true);
      assert.equal(d.querySelector("#p-guests").checked, false);
      d.querySelector("#policy-form").requestSubmit();
      await settle();
      assert.deepEqual(sent().policy, { name: "Fabrikam Digital Services" });
      assert.equal(policy.guestAccess, false);
      // Integrations and security settings do the same.
      d.querySelector("#admin-tab-integrations").click();
      await settle();
      policy = mergePolicy(policy, {
        integrations: { miro: { enabled: false } },
      });
      change("i-embeds", false);
      d.querySelector("#integrations-form").requestSubmit();
      await settle();
      assert.deepEqual(sent().policy, {
        integrations: { embeds: { enabled: false } },
      });
      assert.equal(policy.integrations.miro.enabled, false);
      d.querySelector("#admin-tab-security").click();
      await settle();
      policy = mergePolicy(policy, { alerts: { guestAccess: false } });
      change("a-public", false);
      d.querySelector("#siem-form").requestSubmit();
      await settle();
      assert.deepEqual(sent().policy, { alerts: { publicSharing: false } });
      assert.equal(policy.alerts.guestAccess, false);
    },
  );
});

test("saving a team sends who joined and left, keeping members added meanwhile", async () => {
  await withConsole(
    (op) =>
      op === "org.users.list"
        ? {
            owner: { uuid: "u1", username: "alice" },
            users: ["bob", "cam", "dee"].map((username, n) => ({
              uuid: "u" + (n + 2),
              username,
              role: "member",
              status: "active",
            })),
          }
        : op === "teams.list"
          ? { teams: [{ id: "t1", name: "Design", members: ["u2", "u3"] }] }
          : { team: { id: "t1", name: "Design", members: ["u3", "u4", "u9"] } },
    "people",
    async ({ d, w, calls, settle }) => {
      d.querySelector('[data-edit-team="t1"]').click();
      for (const [uuid, checked] of [
        ["u2", false],
        ["u4", true],
      ]) {
        const box = d.querySelector(`#team-member-list [value="${uuid}"]`);
        box.checked = checked;
        box.dispatchEvent(new w.Event("change", { bubbles: true }));
      }
      d.querySelector("#team-list > form").requestSubmit();
      await settle();
      const [, sent] = calls.find(([op]) => op === "teams.update");
      assert.deepEqual(sent, {
        id: "t1",
        name: "Design",
        add: ["u4"],
        remove: ["u2"],
      });
      assert.equal(calls.filter(([op]) => op === "teams.update").length, 1);
    },
  );
  // A worker from before additions and removals ignores them and keeps the
  // team as it was; it is then sent the whole list, built on its members.
  await withConsole(
    (op) =>
      op === "org.users.list"
        ? {
            owner: { uuid: "u1", username: "alice" },
            users: [{ uuid: "u4", username: "dee", status: "active" }],
          }
        : op === "teams.list"
          ? { teams: [{ id: "t1", name: "Design", members: ["u2"] }] }
          : { team: { id: "t1", name: "Design", members: ["u2", "u9"] } },
    "people",
    async ({ d, w, calls, settle }) => {
      d.querySelector('[data-edit-team="t1"]').click();
      const box = d.querySelector('#team-member-list [value="u4"]');
      box.checked = true;
      box.dispatchEvent(new w.Event("change", { bubbles: true }));
      d.querySelector("#team-list > form").requestSubmit();
      await settle();
      const sent = calls.filter(([op]) => op === "teams.update");
      assert.equal(sent.length, 2);
      assert.deepEqual(sent[1][1].members, ["u2", "u9", "u4"]);
    },
  );
});

test("a board edited during the boards export is listed once, in the order shown", async () => {
  const { filterBoards } = await import("../worker/admin.js");
  const rows = Array.from({ length: 1500 }, (_, n) => ({
    room: `r${String(n).padStart(4, "0")}`,
    title: `Board ${n}`,
    owner: "u1",
    created: 1,
    lastActivity: 1e6 - n,
  }));
  let edited = null;
  await withConsole(
    (op, data) => {
      if (op === "teams.list") return { teams: [] };
      if (op === "spaces.list") return { spaces: [] };
      if (op === "org.users.list")
        return { owner: { uuid: "u1", username: "alice" }, users: [] };
      if (op !== "org.boards") return {};
      const matched = filterBoards(structuredClone(rows), data);
      const offset = data.offset || 0;
      const page = matched.slice(offset, offset + data.limit);
      // Someone edits a board on the second page while the first is read:
      // it moves to the top of Last activity.
      if (data.limit === 1000 && offset === 0 && !edited) {
        edited = matched[1200].room;
        rows.find((b) => b.room === edited).lastActivity = 2e6;
      }
      return { boards: page, total: matched.length };
    },
    "boards",
    async ({ d, downloads, settle }) => {
      d.querySelector("#bf-export").click();
      await settle();
      const rooms = downloads
        .at(-1)[0]
        .trim()
        .split(/\r\n/)
        .slice(1)
        .map((line) => line.split(",").at(-1));
      assert.equal(rooms.length, 1500);
      assert.equal(new Set(rooms).size, 1500);
      // Listed by Last activity, as on screen, with the edited board first.
      assert.equal(rooms[0], edited);
      assert.equal(rooms[1], "r0000");
    },
  );
});

test("the board directory can list boards by id, an order editing never changes", async () => {
  const { filterBoards } = await import("../worker/admin.js");
  const rows = ["r2", "r10", "r1"].map((room, n) => ({
    room,
    title: room,
    lastActivity: n,
  }));
  assert.deepEqual(
    filterBoards(rows, { sort: "room" }).map((b) => b.room),
    ["r1", "r10", "r2"],
  );
});

// A board directory of `boards` on a fake organization; board actions go
// to `governed`.
const directory = (boards, extra = {}) => ({
  respond: (op) =>
    op === "teams.list"
      ? { teams: [] }
      : op === "spaces.list"
        ? { spaces: [] }
        : op === "org.users.list"
          ? { owner: { uuid: "u1", username: "alice" }, users: [] }
          : op === "org.boards"
            ? { boards: structuredClone(boards), total: boards.length }
            : (extra[op] ?? {}),
});

test("releasing a legal hold takes a second press", async () => {
  const governed = [];
  const { respond } = directory([
    { room: "r1", title: "Kickoff", owner: "u1", created: 1, legalHold: true },
  ]);
  await withConsole(
    respond,
    "boards",
    async ({ d, settle }) => {
      const release = d.querySelector('[data-govern="hold"]');
      assert.equal(release.textContent, "Release hold");
      release.click();
      await settle();
      assert.deepEqual(governed, []);
      assert.equal(release.textContent, "Confirm release");
      release.click();
      await settle();
      assert.deepEqual(governed, [{ op: "hold", room: "r1", enabled: false }]);
    },
    {
      console: {
        govern: async (input) => {
          governed.push(input);
          return { settings: {} };
        },
      },
    },
  );
});

test("a board under a legal hold offers no Delete, and says why", async () => {
  const { normalizePolicy } = await import("../worker/org.js");
  const boards = [
    { room: "r1", title: "Kickoff", owner: "u1", created: 1, legalHold: true },
    { room: "r2", title: "Retro", owner: "u1", created: 1 },
  ];
  for (const legalHold of [false, true]) {
    const { respond } = directory(boards, {
      "org.policy.get": {
        policy: normalizePolicy({ retention: { legalHold } }),
        secrets: {},
      },
    });
    await withConsole(respond, "boards", async ({ d }) => {
      const remove = (room) =>
        d.querySelector(`[data-govern="delete"][data-room="${room}"]`);
      for (const [room, held] of [
        ["r1", true],
        ["r2", legalHold],
      ]) {
        assert.equal(remove(room).disabled, held, room);
        if (!held) continue;
        const note = document.getElementById("board-hold-note");
        assert.match(
          remove(room).getAttribute("aria-describedby"),
          /\bboard-hold-note\b/,
        );
        assert.match(note.textContent, /legal hold/);
        assert.match(remove(room).title, /legal hold/);
        if (legalHold) assert.match(note.textContent, /organization-wide/);
      }
    });
  }
});

test("row actions name the board, person, or team they act on", async () => {
  // Each control's description names its row, read from the row's header.
  const describes = (control, name) => {
    const ids = (control.getAttribute("aria-describedby") || "").split(" ");
    assert.ok(
      ids.some((id) => document.getElementById(id)?.textContent.includes(name)),
      `${control.outerHTML} names ${name}`,
    );
  };
  const { respond } = directory([
    { room: "r1", title: "Kickoff", owner: "u1", created: 1 },
    { room: "r2", title: "Retro", owner: "u1", created: 1, legalHold: true },
  ]);
  await withConsole(respond, "boards", async ({ d }) => {
    for (const row of d.querySelectorAll(".admin-table tbody tr")) {
      // A checkbox to choose the board comes first, then its name.
      const header = row.querySelector("th");
      assert.equal(header.localName, "th");
      assert.equal(header.getAttribute("scope"), "row");
      for (const button of row.querySelectorAll("button"))
        describes(
          button,
          header.querySelector("[data-user-content]").textContent,
        );
    }
    // Delete on a held board also says why it is unavailable.
    const held = d.querySelector('[data-govern="delete"][data-room="r2"]');
    assert.match(held.getAttribute("aria-describedby"), /board-hold-note/);
  });
  await withConsole(
    (op) =>
      op === "org.users.list"
        ? {
            owner: { uuid: "u1", username: "alice" },
            users: [
              { uuid: "u2", username: "bob", role: "member", status: "active" },
            ],
          }
        : { teams: [{ id: "t1", name: "Design", members: ["u2"] }] },
    "people",
    async ({ d }) => {
      const row = d.querySelector("#people-rows tr");
      assert.equal(row.firstElementChild.localName, "th");
      assert.equal(row.firstElementChild.getAttribute("scope"), "row");
      describes(row.querySelector("[data-transfer]"), "bob");
      for (const button of d.querySelectorAll(
        "[data-edit-team], [data-delete-team]",
      ))
        describes(button, "Design");
    },
  );
});

test("Show more boards adds the next boards below those shown and moves to the first", async () => {
  const boards = Array.from({ length: 450 }, (_, n) => ({
    room: `r${n}`,
    title: `Board ${n}`,
    owner: "u1",
    created: 1,
  }));
  const { respond } = directory([]);
  await withConsole(
    (op, data) => {
      if (op !== "org.boards") return respond(op, data);
      const offset = data.offset || 0;
      return {
        boards: boards.slice(offset, offset + data.limit),
        total: boards.length,
      };
    },
    "boards",
    async ({ d, calls, settle }) => {
      const rows = () => d.querySelectorAll(".admin-table tbody tr");
      const form = d.querySelector("#board-filters");
      assert.equal(rows().length, 200);
      calls.length = 0;
      d.querySelector("#bf-more").click();
      await settle();
      // Only the next page is read, and the panel stays as it was.
      assert.deepEqual(
        calls.map(([op, data]) => [op, data.offset, data.limit]),
        [["org.boards", 200, 200]],
      );
      assert.equal(d.querySelector("#board-filters"), form);
      assert.equal(rows().length, 400);
      assert.equal(document.activeElement, rows()[200].querySelector("th"));
      assert.match(document.activeElement.textContent, /Board 200/);
      assert.match(
        d.querySelector("#admin-panel [role=status]").textContent,
        /Showing 400 of 450 boards/,
      );
      // Each new row's actions work.
      assert.ok(rows()[399].querySelector("[data-activity]").onclick);
      d.querySelector("#bf-more").click();
      await settle();
      assert.equal(rows().length, 450);
      assert.equal(d.querySelector("#bf-more"), null);
      assert.equal(document.activeElement, rows()[400].querySelector("th"));
      assert.match(
        d.querySelector("#admin-panel [role=status]").textContent,
        /^450 boards$/,
      );
      // Ids stay unique across the pages.
      const ids = [...d.querySelectorAll("[id^=board-name-]")].map((e) => e.id);
      assert.equal(new Set(ids).size, 450);
    },
  );
});

test("a board action updates its row without reloading the directory", async () => {
  const governed = [];
  const { respond } = directory(
    ["Kickoff", "Retro", "Roadmap"].map((title, n) => ({
      room: `r${n + 1}`,
      title,
      owner: "u1",
      created: 1,
    })),
  );
  await withConsole(
    respond,
    "boards",
    async ({ d, calls, settle }) => {
      const button = (op, room) =>
        d.querySelector(`[data-govern="${op}"][data-room="${room}"]`);
      calls.length = 0;
      // Archiving takes the board out of Current; the keyboard goes on to
      // the same action on the row now in its place.
      button("archive", "r2").focus();
      button("archive", "r2").click();
      await settle();
      assert.deepEqual(governed, [
        { op: "archive", room: "r2", enabled: false },
      ]);
      assert.deepEqual(calls, []);
      assert.equal(button("archive", "r2"), null);
      assert.equal(document.activeElement, button("archive", "r3"));
      assert.equal(d.querySelector("#board-count").textContent, "2 boards");
      assert.match(d.querySelector("#admin-status").textContent, /archived/);
      // A legal hold stays in the row, which now says so.
      button("hold", "r1").focus();
      button("hold", "r1").click();
      await settle();
      assert.deepEqual(calls, []);
      const row = button("hold", "r1").closest("tr");
      assert.match(row.querySelector("th").textContent, /Legal hold/);
      assert.equal(button("hold", "r1").textContent, "Release hold");
      assert.equal(button("delete", "r1").disabled, true);
      assert.equal(d.querySelector("#board-hold-note").hidden, false);
      assert.equal(document.activeElement, button("hold", "r1"));
      // Its actions still work after the row is redrawn.
      button("hold", "r1").click();
      button("hold", "r1").click();
      await settle();
      assert.deepEqual(governed.at(-1), {
        op: "hold",
        room: "r1",
        enabled: false,
      });
      assert.equal(button("delete", "r1").disabled, false);
      assert.equal(d.querySelector("#board-hold-note").hidden, true);
      // The last board leaving says none match.
      for (const room of ["r1", "r3"]) {
        button("delete", room).click();
        button("delete", room).click();
        await settle();
      }
      assert.match(
        d.querySelector(".admin-table tbody").textContent,
        /No boards match/,
      );
      assert.equal(d.querySelector("#board-count").textContent, "0 boards");
    },
    {
      console: {
        govern: async (input) => {
          governed.push(input);
          return { settings: {} };
        },
      },
    },
  );
});

test("administrators archive, hold, and delete many boards at once", async () => {
  const governed = [];
  const { respond } = directory(
    ["Kickoff", "Retro", "Roadmap", "Planning"].map((title, n) => ({
      room: `r${n + 1}`,
      title,
      owner: "u1",
      created: 1,
      legalHold: n === 2,
    })),
  );
  await withConsole(
    respond,
    "boards",
    async ({ d, w, calls, settle }) => {
      const pick = (room, checked = true) => {
        const box = d.querySelector(`[data-select="${room}"]`);
        box.checked = checked;
        box.dispatchEvent(new w.Event("change", { bubbles: true }));
      };
      const selected = () => d.querySelector("#bf-selected").textContent;
      const archive = d.querySelector("#bf-bulk-archive"),
        hold = d.querySelector("#bf-bulk-hold"),
        remove = d.querySelector("#bf-bulk-delete");
      assert.equal(d.querySelector("#bf-bulk-unarchive"), null);
      // Each checkbox is named by its board; nothing is chosen yet.
      const box = d.querySelector('[data-select="r1"]');
      assert.match(
        document.getElementById(box.getAttribute("aria-labelledby"))
          .textContent,
        /Kickoff/,
      );
      assert.ok(d.querySelector("#bf-select-all").getAttribute("aria-label"));
      for (const button of [archive, hold, remove])
        assert.equal(button.disabled, true);
      pick("r1");
      pick("r2");
      assert.equal(selected(), "2 boards selected.");
      assert.equal(archive.disabled, false);
      assert.equal(d.querySelector("#bf-select-all").indeterminate, true);
      calls.length = 0;
      archive.click();
      await settle();
      assert.deepEqual(
        governed.map((g) => [g.op, g.room]),
        [
          ["archive", "r1"],
          ["archive", "r2"],
        ],
      );
      assert.deepEqual(calls, []);
      assert.equal(d.querySelectorAll(".admin-table tbody tr").length, 2);
      assert.equal(d.querySelector("#board-count").textContent, "2 boards");
      assert.equal(selected(), "No boards selected.");
      assert.equal(archive.disabled, true);
      assert.match(d.querySelector("#admin-status").textContent, /2 boards/);
      // Selecting all and deleting takes a second press that names how
      // many boards go; a board under a legal hold is kept.
      const all = d.querySelector("#bf-select-all");
      all.checked = true;
      all.dispatchEvent(new w.Event("change", { bubbles: true }));
      assert.equal(selected(), "2 boards selected.");
      governed.length = 0;
      remove.click();
      await settle();
      assert.deepEqual(governed, []);
      assert.equal(remove.textContent, "Confirm deleting 1 board");
      // Changing the selection asks again.
      pick("r4", false);
      pick("r4");
      assert.equal(remove.textContent, "Delete selected");
      remove.click();
      remove.click();
      await settle();
      assert.deepEqual(
        governed.map((g) => [g.op, g.room]),
        [["delete", "r4"]],
      );
      assert.equal(d.querySelector('[data-select="r4"]'), null);
      assert.ok(d.querySelector('[data-select="r3"]').checked);
      assert.match(
        d.querySelector("#admin-status").textContent,
        /1 board under a legal hold was not deleted/,
      );
    },
    {
      console: {
        govern: async (input) => {
          governed.push(input);
          return { settings: {} };
        },
      },
    },
  );
});

test("emptying the boards shown brings in the next ones that match", async () => {
  // 450 current boards; archiving takes a board out of those listed.
  const boards = Array.from({ length: 450 }, (_, n) => ({
    room: `r${n}`,
    title: `Board ${n}`,
    owner: "u1",
    created: 1,
  }));
  const archived = new Set();
  const { respond } = directory([]);
  await withConsole(
    (op, data) => {
      if (op !== "org.boards") return respond(op, data);
      const current = boards.filter((b) => !archived.has(b.room));
      const offset = data.offset || 0;
      return {
        boards: current.slice(offset, offset + data.limit),
        total: current.length,
      };
    },
    "boards",
    async ({ d, w, settle }) => {
      const rows = () => [...d.querySelectorAll(".admin-table tbody tr")];
      const all = d.querySelector("#bf-select-all");
      all.checked = true;
      all.dispatchEvent(new w.Event("change", { bubbles: true }));
      const archive = d.querySelector("#bf-bulk-archive");
      archive.focus();
      archive.click();
      for (let n = 0; n < 10; n++) await settle();
      // The next 200 of the 250 left are listed, not "none match".
      assert.equal(archived.size, 200);
      assert.equal(rows().length, 200);
      assert.doesNotMatch(
        d.querySelector(".admin-table tbody").textContent,
        /No boards match|Loading/,
      );
      assert.match(rows()[0].textContent, /Board 200/);
      assert.equal(
        d.querySelector("#board-count").textContent,
        "Showing 200 of 250 boards.",
      );
      assert.equal(document.activeElement, rows()[0].querySelector("th"));
      // Show more adds the rest below them, with no note left among them.
      d.querySelector("#bf-more").click();
      await settle();
      assert.equal(rows().length, 250);
      assert.ok(rows().every((row) => row.querySelector("[data-select]")));
      assert.equal(d.querySelector("#board-count").textContent, "250 boards");
    },
    {
      console: {
        govern: async (input) => {
          archived.add(input.room);
          return { settings: {} };
        },
      },
    },
  );
});

test("after an action on chosen boards the keyboard goes on to choosing boards", async () => {
  const { respond } = directory(
    ["Kickoff", "Retro", "Roadmap"].map((title, n) => ({
      room: `r${n + 1}`,
      title,
      owner: "u1",
      created: 1,
    })),
  );
  await withConsole(
    respond,
    "boards",
    async ({ d, w, settle }) => {
      const box = d.querySelector('[data-select="r1"]');
      box.checked = true;
      box.dispatchEvent(new w.Event("change", { bubbles: true }));
      const archive = d.querySelector("#bf-bulk-archive");
      archive.focus();
      archive.click();
      await settle();
      // Nothing is chosen now, so Archive selected is unavailable.
      assert.equal(archive.disabled, true);
      assert.equal(document.activeElement, d.querySelector("#bf-select-all"));
    },
    { console: { govern: async () => ({ settings: {} }) } },
  );
});

test("the audit log can be narrowed to one person and one board", async () => {
  const audits = [],
    searches = [];
  await withConsole(
    (op, data) => {
      if (op === "org.audit") {
        audits.push(data);
        return { entries: [], cursor: null };
      }
      if (op === "org.users.list")
        return {
          owner: { uuid: "u1", username: "alice" },
          users: [
            { uuid: "u3", username: "cam", role: "member", status: "active" },
            { uuid: "u2", username: "bob", role: "member", status: "active" },
          ],
        };
      if (op === "org.boards") {
        searches.push(data);
        return {
          boards: [
            { room: "r1", title: "Kickoff", ownerName: "alice" },
            { room: "r2", title: "Kickoff", ownerName: "bob" },
            { room: "r3", title: "Kickoff retro", ownerName: "bob" },
          ],
          total: 3,
        };
      }
      return {};
    },
    "audit",
    async ({ d, w, settle }) => {
      const person = d.querySelector("#au-actor");
      assert.deepEqual(
        [...person.options].map((o) => o.textContent),
        ["Anyone", "alice", "bob", "cam"],
      );
      person.value = "u2";
      // Boards are suggested by name as it is typed, from the whole
      // directory; boards sharing a name are told apart by owner.
      const board = d.querySelector("#au-board");
      board.value = "Kick";
      board.dispatchEvent(new w.Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(searches.at(-1).query, "Kick");
      assert.equal(searches.at(-1).scope, "all");
      const suggested = [
        ...d.querySelectorAll(`#${board.getAttribute("list")} option`),
      ].map((o) => o.value);
      assert.deepEqual(suggested, [
        "Kickoff (alice)",
        "Kickoff (bob)",
        "Kickoff retro",
      ]);
      // A name that is not one of the boards asks for one.
      board.value = "Kickof";
      d.querySelector("#audit-filters").requestSubmit();
      await settle();
      assert.equal(audits.length, 1);
      assert.notEqual(board.validationMessage, "");
      board.value = "Kickoff (bob)";
      board.dispatchEvent(new w.Event("input", { bubbles: true }));
      d.querySelector("#audit-filters").requestSubmit();
      await settle();
      assert.equal(audits.at(-1).actor, "u2");
      assert.equal(audits.at(-1).board, "r2");
      // The filters show what narrows the list after it reloads.
      assert.equal(d.querySelector("#au-actor").value, "u2");
      assert.equal(d.querySelector("#au-board").value, "Kickoff (bob)");
      // Emptied, the board no longer narrows the list.
      d.querySelector("#au-board").value = "";
      d.querySelector("#audit-filters").requestSubmit();
      await settle();
      assert.equal(audits.at(-1).board, undefined);
    },
  );
});

test("audit log board suggestions name each board once, even with one title and owner", async () => {
  const day = (n) => Date.parse(`2026-09-${n}T12:00:00`);
  const boards = [
    {
      room: "room-aaaaaa",
      title: "Retro",
      ownerName: "alice",
      created: day(10),
    },
    {
      room: "room-bbbbbb",
      title: "Retro",
      ownerName: "alice",
      created: day(11),
    },
    {
      room: "room-cccccc",
      title: "Retro",
      ownerName: "alice",
      created: day(11),
    },
    { room: "room-dddddd", title: "Retro", ownerName: "bob", created: day(11) },
    { room: "room-eeeeee", title: "Retro notes", ownerName: "bob" },
  ];
  const audits = [];
  await withConsole(
    (op, data) => {
      if (op === "org.audit") {
        audits.push(data);
        return { entries: [], cursor: null };
      }
      if (op === "org.users.list")
        return { owner: { uuid: "u1", username: "alice" }, users: [] };
      if (op === "org.boards") return { boards, total: boards.length };
      return {};
    },
    "audit",
    async ({ d, w, settle }) => {
      const board = d.querySelector("#au-board");
      board.value = "Retro";
      board.dispatchEvent(new w.Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const labels = [...d.querySelectorAll("#au-board-list option")].map(
        (o) => o.value,
      );
      // Owner first, then the day created, then the end of the board's id.
      assert.deepEqual(labels, [
        "Retro (alice, Sep 10, 2026)",
        "Retro (alice, Sep 11, 2026, bbbbbb)",
        "Retro (alice, Sep 11, 2026, cccccc)",
        "Retro (bob)",
        "Retro notes",
      ]);
      // Each one chooses its own board.
      board.value = labels[2];
      board.dispatchEvent(new w.Event("input", { bubbles: true }));
      d.querySelector("#audit-filters").requestSubmit();
      await settle();
      assert.equal(audits.at(-1).board, "room-cccccc");
    },
  );
});

test("Apply on the boards and audit tabs keeps the keyboard on Apply and says what was found", async () => {
  const boards = ["Kickoff", "Retro", "Roadmap"].map((title, n) => ({
    room: `r${n}`,
    title,
    owner: "u1",
    created: 1,
  }));
  const { respond } = directory(boards);
  await withConsole(
    (op, data) =>
      op === "org.audit"
        ? {
            entries: [{ at: 1, category: "admin", action: "org.policy" }],
            cursor: "c1",
          }
        : respond(op, data),
    "boards",
    async ({ d, settle }) => {
      const apply = d.querySelector("#bf-apply");
      apply.focus();
      apply.click();
      await settle();
      assert.equal(document.activeElement, d.querySelector("#bf-apply"));
      assert.equal(d.querySelector("#admin-status").textContent, "3 boards");
      // Opening the tab, rather than applying filters, says nothing.
      d.querySelector("#admin-tab-audit").click();
      await settle();
      assert.equal(d.querySelector("#admin-status").textContent, "");
      d.querySelector("#au-apply").focus();
      d.querySelector("#au-apply").click();
      await settle();
      assert.equal(document.activeElement, d.querySelector("#au-apply"));
      assert.equal(
        d.querySelector("#admin-status").textContent,
        "Audit log: 1 event. Older events are available.",
      );
    },
  );
});

test("administrators delete a space from the board directory with a second press", async () => {
  let changes = 0;
  let spaces = [
    { id: "s1", name: "Marketing" },
    { id: "s2", name: "Design" },
  ];
  const { respond } = directory([]);
  await withConsole(
    (op, data) => {
      if (op === "spaces.list") return { spaces: structuredClone(spaces) };
      if (op === "spaces.delete") {
        spaces = spaces.filter((s) => s.id !== data.id);
        return { ok: true };
      }
      return respond(op, data);
    },
    "boards",
    async ({ d, calls, settle }) => {
      const names = () =>
        [...d.querySelectorAll("#space-list strong")].map((e) => e.textContent);
      assert.deepEqual(names(), ["Design", "Marketing"]);
      const remove = d.querySelector('[data-delete-space="s1"]');
      assert.match(
        document.getElementById(remove.getAttribute("aria-describedby"))
          .textContent,
        /Marketing/,
      );
      remove.click();
      await settle();
      assert.equal(calls.filter(([op]) => op === "spaces.delete").length, 0);
      assert.equal(remove.textContent, "Confirm delete");
      remove.click();
      await settle();
      assert.deepEqual(calls.find(([op]) => op === "spaces.delete")[1], {
        id: "s1",
      });
      assert.deepEqual(names(), ["Design"]);
      assert.deepEqual(
        [...d.querySelectorAll("#bf-space option")].map((o) => o.value),
        ["", "s2"],
      );
      // The library's lists of spaces hear of it.
      assert.equal(changes, 1);
    },
    { console: { changed: () => changes++ } },
  );
});

test("the overview says how many boards are shared outside beyond the 50 it lists, and leads to them", async () => {
  const { scaleData } = await import("../scripts/generate-scale-data.mjs");
  const { scaleOrganization } =
    await import("../scripts/scale-organization.js");
  const org = scaleOrganization(scaleData());
  await withConsole(
    (op, data) => org.request(op, data || {}),
    "overview",
    async ({ d, calls, settle }) => {
      const { sharing } = await org.request("org.reports", { days: 30 });
      assert.equal(sharing.boardsWithGuests.length, 50);
      assert.ok(sharing.sharedOutside >= sharing.withGuests);
      assert.ok(sharing.sharedOutside >= sharing.publicLinks);
      const section = [...d.querySelectorAll("#admin-panel h3")].find((h) =>
        /outside the organization/.test(h.textContent),
      ).parentElement;
      assert.equal(section.querySelectorAll("tbody tr").length, 50);
      assert.equal(
        section.querySelector("p").textContent,
        `Showing the 50 with the most guests of ${sharing.sharedOutside.toLocaleString("en-CA")} boards shared outside the organization. Export CSV on the Boards tab lists every board with its guests.`,
      );
      calls.length = 0;
      section.querySelector("#report-link-boards").click();
      await settle();
      await settle();
      assert.equal(
        d.querySelector("#admin-tab-boards").getAttribute("aria-selected"),
        "true",
      );
      assert.equal(d.querySelector("#bf-visibility").value, "link");
      assert.equal(
        calls.find(([op]) => op === "org.boards")[1].visibility,
        "link",
      );
    },
  );
});

test("a tab that could not load says so in the console's words and loads again from Try again", async () => {
  let offline = true;
  await withConsole(
    (op) => {
      if (op === "org.users.list") {
        if (offline)
          throw Error(
            "Could not reach the shared board. Check your connection and try again.",
          );
        return { owner: { uuid: "u1", username: "alice" }, users: [] };
      }
      return op === "teams.list" ? { teams: [] } : {};
    },
    "people",
    async ({ d, settle }) => {
      const alert = d.querySelector("#admin-panel [role=alert]");
      assert.equal(
        alert.textContent,
        "Could not reach your organization's server. Check your connection and try again.",
      );
      const retry = d.querySelector("#admin-retry");
      retry.focus();
      // Still offline: the same choice is offered, with the keyboard on it.
      retry.click();
      await settle();
      assert.equal(document.activeElement, d.querySelector("#admin-retry"));
      offline = false;
      d.querySelector("#admin-retry").click();
      await settle();
      assert.equal(d.querySelector("#admin-retry"), null);
      assert.ok(d.querySelector("#people-search"));
    },
  );
});

test("SIEM settings are available only for the destination chosen", async () => {
  const { normalizePolicy } = await import("../worker/org.js");
  await withConsole(
    (op) =>
      op === "org.policy.get"
        ? { policy: normalizePolicy({ name: "Fabrikam" }), secrets: {} }
        : op === "apikeys.list"
          ? { keys: [], scopes: [] }
          : op === "webhooks.list"
            ? { webhooks: [], events: [] }
            : {},
    "security",
    async ({ d, w }) => {
      const mode = d.querySelector("#s-mode");
      const available = () =>
        ["#s-tenant", "#s-url", '[name="s-category"]'].map(
          (selector) => !d.querySelector(selector).matches(":disabled"),
        );
      assert.equal(mode.value, "none");
      assert.deepEqual(available(), [false, false, false]);
      mode.value = "sentinel";
      mode.dispatchEvent(new w.Event("change", { bubbles: true }));
      assert.deepEqual(available(), [true, false, true]);
      mode.value = "https";
      mode.dispatchEvent(new w.Event("change", { bubbles: true }));
      assert.deepEqual(available(), [false, true, true]);
    },
  );
});

test("the board directory sorts names as people read them", async () => {
  const { filterBoards } = await import("../worker/admin.js");
  const rows = [
    "Planning 10",
    "planning 3",
    "Planning 2",
    "Équipe",
    "Atelier",
  ].map((title, n) => ({ room: `r${n}`, title }));
  assert.deepEqual(
    filterBoards(rows, { sort: "title" }).map((b) => b.title),
    ["Atelier", "Équipe", "Planning 2", "planning 3", "Planning 10"],
  );
});

test("opening organization settings puts the keyboard on the tab shown", async () => {
  await withConsole(
    (op) =>
      op === "org.users.list"
        ? { owner: { uuid: "u1", username: "alice" }, users: [] }
        : { teams: [] },
    "people",
    async ({ d }) => {
      assert.equal(
        document.activeElement,
        d.querySelector("#admin-tab-people"),
      );
    },
    {
      console: {
        // As the app's dialogs do, the keyboard first lands on Close when
        // nothing else in the dialog can take it yet.
        modal: (title, html, ready) => {
          const d = document.createElement("dialog");
          d.innerHTML = `<button class="icon-btn" aria-label="Close dialog"></button>${html}`;
          document.body.append(d);
          d.querySelector("button").focus();
          ready?.(d);
          return d;
        },
      },
    },
  );
});

test("transferring a board's ownership takes a second press naming the new owner", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createBoardAccess } =
      await import("../src/organization/board-access.js");
    const sent = [];
    const s = {
      role: "owner",
      server: "https://whiteboard-abc.puter.work",
      settings: {
        visibility: "private",
        orgRole: "editor",
        linkRole: "viewer",
      },
      request: async (op, data) => {
        sent.push([op, data]);
        return op === "members"
          ? {
              members: [
                { uuid: "m1", username: "Bea", role: "editor" },
                { uuid: "m2", username: "Cy", role: "editor" },
              ],
            }
          : op === "settings.get"
            ? { settings: {} }
            : {};
      },
      heartbeat: async () => {},
    };
    let d;
    const access = createBoardAccess({
      org: { info: null, policy: () => null, allows: () => true },
      session: () => s,
      board: () => ({ items: [] }),
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast() {},
      icon: () => "",
    });
    await access.settings();
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const go = d.querySelector("#bs-transfer-go"),
      to = d.querySelector("#bs-transfer");
    const transfers = () => sent.filter(([op]) => op === "transfer");
    to.value = "m1";
    go.click();
    await settle();
    assert.deepEqual(transfers(), []);
    assert.equal(go.textContent, "Select again to transfer ownership to Bea");
    assert.equal(
      d.querySelector("#bs-status").textContent,
      "Select again to transfer ownership to Bea",
    );
    // Choosing someone else asks again, for them.
    to.value = "m2";
    to.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(go.textContent, "Transfer");
    go.click();
    await settle();
    assert.deepEqual(transfers(), []);
    assert.match(go.textContent, /to Cy$/);
    go.click();
    await settle();
    assert.deepEqual(transfers(), [["transfer", { uuid: "m2" }]]);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("the people export includes the account owner, and large counts group their digits", async () => {
  await withConsole(
    (op) =>
      op === "org.users.list"
        ? {
            owner: {
              uuid: "u1",
              username: "alice",
              email: "alice@fabrikam.test",
            },
            users: [
              { uuid: "u2", username: "bob", role: "member", status: "active" },
            ],
          }
        : { teams: [] },
    "people",
    async ({ d, downloads }) => {
      d.querySelector("#export-people").click();
      const [csv, name] = downloads.at(-1);
      assert.equal(name, "people.csv");
      const lines = csv.trim().split("\r\n");
      assert.equal(lines.length, 3);
      assert.match(lines[1], /^alice,alice@fabrikam\.test,owner,/);
    },
  );
  const { respond } = directory([
    {
      room: "r1",
      title: "Kickoff",
      owner: "u1",
      created: 1,
      objectCount: 2500,
    },
  ]);
  await withConsole(respond, "boards", async ({ d }) => {
    assert.match(d.querySelector(".admin-table tbody tr").textContent, /2,500/);
  });
  const { barChart } = await import("../src/organization/admin-ui.js");
  const chart = barChart(
    [
      { date: "2026-09-01", value: 2997 },
      { date: "2026-09-02", value: 12 },
    ],
    "Minutes spent on boards per day",
  );
  assert.match(chart, /aria-label="2026-09-01: 2,997"/);
  assert.match(chart, /<td>2,997<\/td>/);
});

test("a bulk board action keeps its buttons and choices unavailable until it finishes", async () => {
  const boards = Array.from({ length: 8 }, (_, n) => ({
    room: `r${n}`,
    title: `Board ${n}`,
    owner: "u1",
    created: 1,
  }));
  const { respond } = directory(boards);
  const governed = [];
  const waits = [];
  await withConsole(
    respond,
    "boards",
    async ({ d, w, settle }) => {
      const boxes = [...d.querySelectorAll("[data-select]")];
      for (const box of boxes.slice(0, 3)) {
        box.checked = true;
        box.dispatchEvent(new w.Event("change", { bubbles: true }));
      }
      const archive = d.querySelector("#bf-bulk-archive");
      archive.click();
      await settle();
      assert.equal(governed.length, 3);
      const hold = d.querySelector("#bf-bulk-hold");
      assert.ok(archive.disabled && hold.disabled);
      assert.ok(d.querySelector("#bf-select-all").disabled);
      assert.ok(
        [...d.querySelectorAll("[data-select]")].every((box) => box.disabled),
      );
      // Nothing re-enables them while the action runs.
      boxes[6].dispatchEvent(new w.Event("change", { bubbles: true }));
      archive.click();
      hold.click();
      await settle();
      assert.equal(governed.length, 3);
      for (const resolve of waits.splice(0)) resolve({ settings: {} });
      await settle();
      assert.ok(!d.querySelector("#bf-select-all").disabled);
      assert.ok(
        [...d.querySelectorAll("[data-select]")].every((box) => !box.disabled),
      );
    },
    {
      console: {
        govern: (input) => {
          governed.push(input);
          return new Promise((r) => waits.push(r));
        },
      },
    },
  );
});

test("board activity and duplicates show the last one asked for when replies arrive out of order", async () => {
  const boards = ["Kickoff", "Retro"].map((title, n) => ({
    room: `r${n}`,
    title,
    owner: "u1",
    created: 1,
  }));
  const pending = {};
  const { respond } = directory(boards);
  await withConsole(
    (op, input) =>
      op === "org.board.activity" || op === "org.boards.duplicates"
        ? new Promise((resolve) => {
            pending[input?.room || "duplicates"] = () =>
              resolve(
                op === "org.boards.duplicates"
                  ? { groups: [] }
                  : {
                      entries: [
                        {
                          id: `e${input.room}`,
                          time: new Date(1).toISOString(),
                          action: "board.edit",
                          category: "content",
                          actor: { username: "x" },
                        },
                      ],
                    },
              );
          })
        : respond(op),
    "boards",
    async ({ d, settle }) => {
      const heading = () =>
        d.querySelector("#board-detail-heading")?.textContent;
      d.querySelector('[data-activity="r0"]').click();
      await settle();
      d.querySelector('[data-activity="r1"]').click();
      await settle();
      pending.r1();
      await settle();
      assert.match(heading(), /Retro/);
      pending.r0();
      await settle();
      assert.match(heading(), /Retro/);
      d.querySelector('[data-activity="r0"]').click();
      await settle();
      d.querySelector("#bf-duplicates").click();
      await settle();
      pending.duplicates();
      await settle();
      pending.r0();
      await settle();
      assert.equal(heading(), "Possible duplicates");
    },
  );
});

test("a notification or organization board pressed twice opens its board once", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='grid'></div></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const items = [{ id: "1", type: "mention", at: 1, board: "r1" }];
    const opened = [],
      reads = [],
      waits = [];
    let dialog;
    const home = createOrganizationHome({
      org: {
        server: "https://org.puter.work",
        info: {
          name: "Fabrikam",
          role: "member",
          user: { emailVerified: true },
        },
        onChange() {},
        request: async (op, data) => {
          if (op === "notifications.read") reads.push(data);
          return op === "notifications.list"
            ? { unread: 0, items }
            : op === "org.boards"
              ? { boards: [{ room: "r2", title: "Two", objectCount: 2 }] }
              : {};
        },
      },
      modal: (title, html, ready) => {
        dialog = document.createElement("dialog");
        dialog.close = () => {};
        dialog.innerHTML = html;
        document.body.append(dialog);
        ready(dialog);
        return dialog;
      },
      toast() {},
      icon: () => "",
      openShared: (...args) => {
        opened.push(args[1]);
        return new Promise((resolve) => waits.push(resolve));
      },
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    await home.notifications();
    await settle();
    const note = dialog.querySelector('[data-note="1"]');
    note.click();
    note.click();
    await settle();
    assert.deepEqual(opened, ["r1"]);
    assert.equal(reads.length, 1);
    waits.shift()();
    await settle();
    await home.renderBoards(document.querySelector("#grid"));
    const card = document.querySelector('[data-org-open="r2"]');
    card.click();
    card.click();
    await settle();
    assert.deepEqual(opened, ["r1", "r2"]);
    // Once the board has opened, or failed to, it can be opened again.
    waits.shift()();
    await settle();
    card.click();
    await settle();
    assert.deepEqual(opened, ["r1", "r2", "r2"]);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("organization library search matches every word, ignoring accents and apostrophes", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  globalThis.CSS ??= { escape: (s) => s };
  try {
    const { createOrganizationLibrary } =
      await import("../src/organization/library-ui.js");
    const items = [
      {
        id: "a",
        name: "Rétrospective d’équipe",
        description: "Sprint retro for the team",
        category: "Agile",
        status: "approved",
        createdByName: "Émilie",
        created: 1,
      },
      {
        id: "b",
        name: "Service blueprint",
        category: "General",
        status: "approved",
        createdByName: "Bob",
        created: 2,
      },
    ];
    const lib = createOrganizationLibrary({
      org: {
        request: async (op) =>
          op === "library.list" ? { items, canPublish: false } : {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        d.close = () => d.remove();
        document.body.append(d);
        ready(d);
        return d;
      },
      toast: () => {},
      icon: () => "",
      useBoard: async () => {},
      shareable: () => null,
    });
    lib.open();
    await new Promise((r) => setTimeout(r, 0));
    const search = document.querySelector("#org-library-search");
    const found = (query) => {
      search.value = query;
      search.dispatchEvent(new dom.window.Event("input"));
      return [...document.querySelectorAll("[data-item]")].map(
        (r) => r.dataset.item,
      );
    };
    for (const query of [
      "retrospective",
      "EQUIPE",
      "d'equipe",
      "retro team",
      "emilie",
      "retrospectives",
    ])
      assert.deepEqual(found(query), ["a"], query);
    assert.deepEqual(found("blueprint service"), ["b"]);
    assert.deepEqual(found("retro blueprint"), []);
    assert.deepEqual(found("  "), ["b", "a"]);
    document.querySelector("dialog").close();
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("on an open board, organization templates insert into it or start a new board", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  globalThis.CSS ??= { escape: (s) => s };
  try {
    const { createOrganizationLibrary } =
      await import("../src/organization/library-ui.js");
    const items = [
      {
        id: "a",
        name: "Team retro",
        category: "Agile",
        status: "approved",
        createdByName: "Alice",
        created: 1,
      },
    ];
    const inserted = [],
      used = [];
    let editable = true,
      accept = false;
    const lib = createOrganizationLibrary({
      org: {
        request: async (op) =>
          op === "library.list"
            ? { items, canPublish: false }
            : op === "library.get"
              ? { board: '{"v":1}' }
              : {},
      },
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        d.close = () => d.remove();
        document.body.append(d);
        ready(d);
        return d;
      },
      toast: () => {},
      icon: () => "",
      useBoard: async (json, name) => used.push([json, name]),
      canInsert: () => editable,
      insertBoard: (json) => (inserted.push(json), accept),
      shareable: () => null,
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    lib.open();
    await settle();
    const insert = () => document.querySelector("[data-library-insert]");
    assert.equal(insert().textContent, "Insert into board");
    assert.equal(
      insert().getAttribute("aria-label"),
      "Insert into board: Team retro",
    );
    assert.equal(
      document.querySelector("[data-library-use]").textContent,
      "New board",
    );
    // A refused insertion, such as one over the object limit, keeps the
    // dialog open.
    insert().click();
    await settle();
    assert.deepEqual(inserted, ['{"v":1}']);
    assert.ok(document.querySelector("dialog"));
    accept = true;
    insert().click();
    await settle();
    assert.equal(inserted.length, 2);
    assert.equal(document.querySelector("dialog"), null, "Inserting closes it");
    assert.deepEqual(used, []);
    // Without an editable board, using a template makes a new board.
    editable = false;
    lib.open();
    await settle();
    assert.equal(insert(), null);
    assert.equal(
      document.querySelector("[data-library-use]").textContent,
      "Use template",
    );
    document.querySelector("[data-library-use]").click();
    await settle();
    assert.deepEqual(used, [['{"v":1}', "Team retro"]]);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("a notification another server garbled does not hide the others", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const kept = {
      "https://w1.puter.work": [
        { id: "a", type: "mention", at: 30, board: "r1", thread: "c1" },
      ],
      "https://w2.puter.work": [
        null,
        {
          id: "b",
          type: "reply",
          at: 20,
          board: "r2",
          actor: { username: "Mallory" },
          excerpt: "Looks fine",
          excerptRuns: [null],
        },
      ],
    };
    let dialog;
    const home = createOrganizationHome({
      org: { info: null, onChange() {} },
      sharedServers: () => Object.keys(kept),
      request: async (at, op) =>
        op === "notifications.list"
          ? { items: kept[at], unread: 2 }
          : { ok: true },
      modal: (title, html, ready) => {
        dialog = document.createElement("dialog");
        dialog.close = () => {};
        dialog.innerHTML = html;
        document.body.append(dialog);
        ready(dialog);
        return dialog;
      },
      toast() {},
      icon: () => "",
      openShared: async () => {},
    });
    await home.notifications();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const rows = [...dialog.querySelectorAll("#notification-list li")];
    assert.deepEqual(
      rows.map((li) => li.querySelector(".notification-kind")?.textContent),
      ["Mention", "Reply"],
    );
    assert.match(rows[1].textContent, /Mallory.*Looks fine/);
  } finally {
    for (const key of keys) delete globalThis[key];
    dom.window.close();
  }
});

test("a webhook test says when webhooks are off, so the endpoint can be checked before turning them on", async () => {
  const { normalizePolicy } = await import("../worker/org.js");
  for (const enabled of [false, true]) {
    const policy = normalizePolicy({ name: "Fabrikam" });
    policy.integrations.webhooks.enabled = enabled;
    const toasts = [];
    await withConsole(
      (op) =>
        op === "org.policy.get"
          ? { policy, secrets: {}, siem: null, owner: null }
          : op === "apikeys.list"
            ? { keys: [], scopes: [] }
            : op === "webhooks.list"
              ? {
                  webhooks: [
                    {
                      id: "h1",
                      url: "https://hooks.example.ca/wb",
                      events: ["*"],
                    },
                  ],
                  events: ["*"],
                }
              : { ok: true },
      "security",
      async ({ d, settle }) => {
        d.querySelector('[data-test-hook="h1"]').click();
        await settle();
      },
      { console: { toast: (message) => toasts.push(message) } },
    );
    assert.deepEqual(toasts, [
      enabled
        ? "Webhook test delivered."
        : "Webhook test delivered. Webhooks are off in Integrations, so events are not sent yet.",
    ]);
  }
});

test("the Integrations tab shows why Slack refused the last post and sends a test message", async () => {
  const { normalizePolicy } = await import("../worker/org.js");
  const policy = normalizePolicy({ name: "Fabrikam" });
  policy.integrations.slack.enabled = true;
  const toasts = [];
  let status = {
    lastError: "Slack refused the message (404): no_service",
    lastErrorAt: 1,
  };
  await withConsole(
    (op) =>
      op === "org.policy.get"
        ? { policy, secrets: { slack: true }, slack: status, owner: null }
        : { ok: true },
    "integrations",
    async ({ d, calls, settle }) => {
      assert.match(
        d.querySelector("#admin-panel").textContent,
        /Slack refused the message \(404\): no_service/,
      );
      status = { lastSuccess: Date.UTC(2026, 9, 13, 15) };
      d.querySelector("#i-slack-test").click();
      await settle();
      assert.deepEqual(calls.map(([op]) => op).slice(-3), [
        "org.policy.set",
        "org.slack.test",
        "org.policy.get",
      ]);
      assert.deepEqual(toasts, ["Test message posted to Slack."]);
      assert.doesNotMatch(
        d.querySelector("#admin-panel").textContent,
        /refused/,
      );
      assert.match(d.querySelector("#admin-panel").textContent, /Last post/);
    },
    { console: { toast: (message) => toasts.push(message) } },
  );
});

test("board settings say when Slack stopped taking the board's posts", async () => {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createBoardAccess } =
      await import("../src/organization/board-access.js");
    const settings = {
      visibility: "private",
      orgRole: "editor",
      linkRole: "viewer",
    };
    const session = {
      role: "owner",
      server: "https://whiteboard-abc.puter.work",
      settings,
      request: async (op) =>
        op === "settings.get"
          ? {
              settings: {
                ...settings,
                integrations: true,
                slack: true,
                slackError: "Slack refused the message (404): no_service",
              },
            }
          : { members: [] },
    };
    let d;
    const access = createBoardAccess({
      org: {
        server: "https://whiteboard-abc.puter.work",
        isMember: true,
        info: { configured: true },
        policy: () => ({ publicLinks: false }),
        allows: () => true,
        request: async (op) =>
          op === "spaces.list" ? { spaces: [] } : { teams: [] },
      },
      session: () => session,
      board: () => ({ items: [] }),
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.close = () => d.remove();
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast: () => {},
      icon: () => "",
    });
    await access.settings();
    const note = d.querySelector("#bs-slack-error");
    assert.equal(
      note.textContent,
      "Slack stopped taking this board's posts (404, no_service). Connect the channel again with a new webhook URL.",
    );
    assert.equal(
      d.querySelector("#bs-slack").getAttribute("aria-describedby"),
      "bs-slack-error",
    );
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});
