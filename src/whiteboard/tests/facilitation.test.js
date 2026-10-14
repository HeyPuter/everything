import { objectNameHTML } from "../src/accessibility/object-content.js";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { IDBFactory } from "fake-indexeddb";
import { appBundle } from "./app-bundle.js";
import axe from "axe-core";
import { createCanvas } from "./canvas.js";
import { board as newBoard, item, validateBoard } from "../src/model.js";
import { SharedDocument, rebase } from "../src/collaboration/document.js";
import { setObjectHeight } from "../src/geometry.js";
import { encode, hash } from "../src/collaboration/protocol.js";
import {
  answerKey,
  adoptWorkshop,
  concealment,
  contributionKey,
  historyKey,
  messageTarget,
  objectTarget,
  participantKey,
  voteFollowingTimer,
  voteTimerId,
  pollTally,
  portableWorkshop,
  hiddenObjects,
  reactionKey,
  resultRecord,
  validateWorkshop,
  validateWorkshopChanges,
  rebaseWorkshop,
  VOTE_GRACE,
  voteKey,
  voteTally,
  workshopEvents,
} from "../src/facilitation/model.js";
import {
  engagement,
  engagementCSV,
  resultsCSV,
  resultsJSON,
} from "../src/facilitation/results.js";
import { createFacilitationUI } from "../src/facilitation/ui.js";
import { PresenceLayer } from "../src/collaboration/presence.js";
import { counted } from "../src/facilitation/strings.js";
import { commentThread } from "../src/comments.js";
import {
  environment,
  memoryStore,
  owner,
  editor,
  viewer,
} from "./collaboration-helpers.js";
import { CollaborationSession } from "../src/collaboration/session.js";
import { createPeerHub } from "./peer-hub.js";
import { language, setLanguage, t, objectKind } from "../src/i18n.js";

const guest = {
  uuid: "44444444-4444-4444-8444-444444444444",
  username: "Dee",
};
const vote = (extra = {}) => ({
  id: "vote1",
  title: "Priorities",
  votes: 2,
  multiple: false,
  anonymous: false,
  hidden: true,
  targets: ["a", "b", "c"],
  state: "active",
  revealed: false,
  startedAt: 1000,
  endsAt: 0,
  ...extra,
});
const ballot = (user, ids, voteId = "vote1", named = true) => [
  voteKey(voteId, user.uuid),
  {
    vote: voteId,
    by: user.uuid,
    ids,
    at: 2000,
    ...(named ? { name: user.username } : {}),
  },
];
const notes = () => [
  item("note", 0, 0, { id: "a", text: "Ship faster" }),
  item("note", 250, 0, { id: "b", text: "=SUM(1)" }),
  item("note", 500, 0, { id: "c", text: "Better docs" }),
];

// Sharing a personal board asks first; a shared board opens its dialog.
async function confirmShare(app) {
  for (let n = 0; n < 5 && !app.doc.querySelector("#confirm-share"); n++)
    await app.tick();
  if (app.doc.querySelector("#confirm-share"))
    await app.click("#confirm-share");
}

test("workshop registers validate strictly and boards without them load unchanged", () => {
  const plain = newBoard("Plain");
  plain.items = notes();
  assert.equal(validateBoard(structuredClone(plain)).workshop, undefined);
  const doc = new SharedDocument();
  doc.commit(plain);
  assert.equal("workshop" in doc.snapshot(), false, "No empty workshop key");
  doc.destroy();
  const workshop = Object.fromEntries([
    ["vote", vote()],
    ballot(editor, ["a", "b"]),
    [
      reactionKey(editor.uuid, objectTarget("a")),
      {
        by: editor.uuid,
        target: ["o", "a"],
        types: ["thumbs", "idea"],
        at: 1,
        name: "Bob",
      },
    ],
    [contributionKey("a"), { by: editor.uuid, at: 1, round: "r1" }],
    [
      participantKey(editor.uuid),
      { by: editor.uuid, name: "Bob", role: "editor", first: 1, last: 2 },
    ],
    [
      "settings",
      {
        lock: "contribute",
        private: "r1",
        anonymous: false,
        stage: { frames: ["f"], shown: 0 },
      },
    ],
    ["agenda", { steps: [{ frame: "f", minutes: 5, text: "Brainstorm" }] }],
  ]);
  validateWorkshop(workshop);
  validateBoard({ ...plain, workshop });
  const invalid = [
    { vote: { ...vote(), votes: 0 } },
    { vote: { ...vote(), targets: [] } },
    { unknown: true },
    // The key must name the ballot's own voter.
    { [voteKey("vote1", owner.uuid)]: ballot(editor, ["a"])[1] },
    {
      [reactionKey(editor.uuid, objectTarget("a"))]: {
        by: editor.uuid,
        target: ["o", "a"],
        types: ["unknown"],
        at: 1,
      },
    },
    {
      [historyKey("h1")]: {
        kind: "vote",
        id: "h1",
        title: "Anonymous",
        startedAt: 1,
        endedAt: 2,
        anonymous: true,
        participants: 1,
        results: [{ id: "a", label: "A", count: 1, voters: ["Bob"] }],
      },
    },
    {
      [contributionKey("a")]: {
        by: editor.uuid,
        at: 1,
        anonymous: true,
        name: "Bob",
      },
    },
    { settings: { lock: "sealed" } },
  ];
  for (const value of invalid)
    assert.throws(() => validateWorkshop(value), /workshop/i);
});

test("the shared document keeps workshop state outside undo and merges concurrent ballots", () => {
  const start = newBoard("Shared");
  start.items = notes();
  start.workshop = { vote: vote() };
  const a = new SharedDocument(),
    b = new SharedDocument();
  a.commit(start);
  b.apply(a.update());
  const before = a.snapshot();
  // Two participants vote at the same time from their own queued boards.
  const mine = structuredClone(before),
    theirs = structuredClone(before);
  mine.workshop = Object.fromEntries([
    ...Object.entries(mine.workshop),
    ballot(owner, ["a"]),
  ]);
  theirs.workshop = Object.fromEntries([
    ...Object.entries(theirs.workshop),
    ballot(editor, ["b", "c"]),
  ]);
  a.commit(rebase(mine, before, a.snapshot()));
  b.commit(rebase(theirs, before, b.snapshot()));
  a.apply(b.update(a.vector()));
  b.apply(a.update(b.vector()));
  assert.deepEqual(a.snapshot().workshop, b.snapshot().workshop);
  assert.deepEqual(
    voteTally(a.snapshot(), a.snapshot().workshop.vote).map((r) => [
      r.id,
      r.count,
    ]),
    [
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ],
  );
  // Drawing undo never removes a vote.
  const moved = a.snapshot();
  moved.items[0].x = 99;
  a.commit(moved);
  a.undo.undo();
  assert.equal(a.snapshot().items[0].x, 0);
  assert.equal(
    Object.keys(a.snapshot().workshop).filter((k) => k.startsWith("v:")).length,
    2,
  );
  a.validate();
  a.workshop.set("vote", null);
  assert.throws(() => a.validate(), /workshop/);
  a.destroy();
  b.destroy();
});

test("imports and duplicates drop live sessions but keep agenda, results, and reactions", () => {
  const reaction = {
    by: "device:x",
    target: ["o", "a"],
    types: ["heart"],
    at: 1,
    name: "Local author",
  };
  const workshop = {
    vote: vote(),
    settings: { private: "r1", lock: "frozen" },
    session: { id: "s1", state: "active", startedAt: 1 },
    run: { id: "r", state: "running", step: 0, startedAt: 1, stepAt: 1 },
    agenda: { steps: [{ frame: "f", minutes: 3 }] },
    [historyKey("old")]: {
      kind: "vote",
      id: "old",
      title: "Done",
      startedAt: 1,
      endedAt: 2,
      anonymous: true,
      participants: 1,
      results: [{ id: "a", label: "A", count: 1 }],
    },
    [reactionKey("device:x", ["o", "a"])]: reaction,
    [contributionKey("a")]: { by: "device:x", at: 1, name: "Local author" },
    ...Object.fromEntries([ballot(editor, ["a"])]),
  };
  const portable = portableWorkshop(workshop);
  assert.deepEqual(Object.keys(portable).sort(), [
    "agenda",
    historyKey("old"),
    reactionKey("device:x", ["o", "a"]),
  ]);
  assert.equal(portableWorkshop({ vote: vote() }), undefined);
  // Sharing gives this device's entries to the signed-in owner.
  const adopted = adoptWorkshop(workshop, "device:x", owner);
  validateWorkshop(adopted);
  assert.equal(
    adopted[reactionKey(owner.uuid, ["o", "a"])].name,
    owner.username,
  );
  assert.equal(adopted[contributionKey("a")].by, owner.uuid);
  // Saved results name this device's votes by the owner too.
  const named = adoptWorkshop(
    {
      [historyKey("mine")]: {
        kind: "vote",
        id: "mine",
        title: "Named",
        startedAt: 1,
        endedAt: 2,
        anonymous: false,
        participants: 2,
        results: [
          { id: "a", label: "A", count: 2, voters: ["Cam", "Local author"] },
          { id: "b", label: "B", count: 1, voters: ["Cam"] },
        ],
      },
    },
    "device:x",
    owner,
    "Local author",
  );
  validateWorkshop(named);
  assert.deepEqual(
    named[historyKey("mine")].results.map((r) => r.voters),
    [[owner.username, "Cam"].sort(), ["Cam"]],
  );
});

test("vote and poll tallies respect anonymity and export CSV and JSON", () => {
  const b = { ...newBoard("Retro"), items: notes() };
  b.workshop = Object.fromEntries([
    ["vote", vote({ state: "ended", endedAt: 5000 })],
    ballot(owner, ["a", "b"]),
    ballot(editor, ["a"]),
    ballot(viewer, ["x"]),
  ]);
  const label = (id) => b.items.find((i) => i.id === id)?.text || id;
  const tally = voteTally(b, b.workshop.vote);
  assert.deepEqual(tally[0], { id: "a", count: 2, voters: ["Alice", "Bob"] });
  assert.equal(
    tally.at(-1).count,
    0,
    "Ballots for unknown objects are ignored",
  );
  const named = resultRecord(b, "vote", label);
  assert.equal(named.participants, 3);
  const csv = resultsCSV(named);
  assert.match(csv, /Rank,Object,Votes,Share \(%\),Participants/);
  assert.match(csv, /1,Ship faster,2,66\.7,"Alice; Bob"/);
  assert.match(csv, /'=SUM\(1\)/, "Formulas are neutralized");
  assert.equal(JSON.parse(resultsJSON(named)).results[0].label, "Ship faster");
  b.workshop.vote.anonymous = true;
  const anonymous = resultRecord(b, "vote", label);
  assert.equal(
    anonymous.results.some((r) => r.voters),
    false,
    "Anonymous results never list voters",
  );
  assert.doesNotMatch(resultsCSV(anonymous), /Alice|Bob/);
  validateWorkshop({ [historyKey(anonymous.id)]: anonymous });
  const poll = {
    id: "p1",
    question: "Lunch?",
    options: [
      { id: "o1", text: "Pizza" },
      { id: "o2", text: "Salad" },
    ],
    multiple: false,
    anonymous: true,
    hidden: false,
    state: "open",
    revealed: false,
    startedAt: 1,
  };
  b.workshop = {
    poll,
    [answerKey("p1", owner.uuid)]: {
      poll: "p1",
      by: owner.uuid,
      ids: ["o2"],
      at: 2,
    },
    [answerKey("p1", editor.uuid)]: {
      poll: "p1",
      by: editor.uuid,
      ids: ["o2"],
      at: 3,
    },
  };
  assert.deepEqual(
    pollTally(b, poll).map((r) => [r.text, r.count, r.voters]),
    [
      ["Pizza", 0, undefined],
      ["Salad", 2, undefined],
    ],
  );
  assert.match(resultsCSV(resultRecord(b, "poll", label)), /1,Salad,2,100/);
  // Tied results share a rank, and the next one counts them both.
  const tied = resultsCSV({
    kind: "vote",
    title: "Tie",
    anonymous: true,
    participants: 3,
    results: [
      { id: "a", label: "Alpha", count: 2 },
      { id: "b", label: "Beta", count: 1 },
      { id: "c", label: "Gamma", count: 1 },
      { id: "d", label: "Delta", count: 0 },
    ],
  });
  for (const row of ["1,Alpha,2", "2,Beta,1", "2,Gamma,1", "4,Delta,0"])
    assert.match(tied, new RegExp(`\r?\n${row},`));
});

test("private mode and staged frames conceal contributions until the facilitator reveals them", () => {
  const frame = item("frame", 0, 400, { id: "f", text: "Round two" });
  const b = {
    ...newBoard("Private"),
    items: [
      ...notes(),
      frame,
      item("note", 20, 460, { id: "inside", parentId: "f", text: "Later" }),
    ],
    workshop: {
      settings: { private: "r1", stage: { frames: ["f"], shown: 0 } },
      [contributionKey("a")]: { by: editor.uuid, at: 1, round: "r1" },
      [contributionKey("b")]: { by: owner.uuid, at: 1, round: "r1" },
      // Created before this private round started.
      [contributionKey("c")]: { by: editor.uuid, at: 1, round: "r0" },
    },
  };
  b.items.find((i) => i.id === "b").task = {
    assignee: { id: owner.uuid, name: "Alice" },
    start: null,
    due: "2026-10-02",
    status: "todo",
  };
  const forOwner = concealment(b, owner.uuid, true);
  assert.deepEqual([...forOwner.notes], ["a"]);
  assert.equal(forOwner.frames.size, 0, "Facilitators see staged frames");
  const forEditor = concealment(b, editor.uuid, false);
  assert.deepEqual([...forEditor.notes], ["b"]);
  assert.deepEqual([...forEditor.frames], ["f"]);
  assert.deepEqual([...forEditor.hidden], ["inside"]);
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    const shown = ui.api.conceal(ui.api.visible(b.items));
    assert.equal(shown.find((i) => i.id === "a").text, "Ship faster");
    assert.equal(shown.find((i) => i.id === "b").text, "Private note");
    assert.equal(
      shown.find((i) => i.id === "b").task,
      undefined,
      "Private notes do not show their task details",
    );
    assert.equal(
      shown.find((i) => i.id === "f").text,
      "Hidden by the facilitator",
    );
    assert.equal(
      shown.some((i) => i.id === "inside"),
      false,
    );
    assert.equal(
      ui.api.locked(new Set(["b"])),
      true,
      "Hidden notes are protected",
    );
    assert.equal(ui.api.locked(new Set(["a"])), false);
    // Each draw passes a new list; a covered note keeps one stand-in, so
    // its text layout is measured once, and it follows the note.
    const again = ui.api.conceal(ui.api.visible([...b.items]));
    const standIn = shown.find((i) => i.id === "b");
    assert.equal(
      again.find((i) => i.id === "b"),
      standIn,
    );
    b.items.find((i) => i.id === "b").x = 999;
    const moved = ui.api.conceal(ui.api.visible([...b.items]));
    assert.equal(moved.find((i) => i.id === "b").x, 999);
    assert.equal(moved.find((i) => i.id === "b").text, "Private note");
    assert.notEqual(b.items.find((i) => i.id === "b").text, "Private note");
    ui.api.render();
    assert.ok(ui.doc.querySelector('[data-fac-item="b"] .fac-private'));
    assert.match(
      ui.doc.querySelector("#workshop-banner").textContent,
      /Private mode/,
    );
    // Exported JSON never includes the hidden text.
    const exported = structuredClone(b);
    ui.api.portable(exported);
    assert.equal(exported.items.find((i) => i.id === "b").text, "Private note");
    assert.equal(exported.workshop, undefined);
    b.workshop = { ...b.workshop, settings: {} };
    assert.equal(
      ui.api.conceal(b.items),
      b.items,
      "Revealing shows every note",
    );
  } finally {
    ui.close();
  }
});

test("facilitation preserves frame languages in staging, voting and agenda navigation", () => {
  for (const interfaceLanguage of ["en", "fr"]) {
    const frames = [
      item("frame", 0, 0, { text: "Bonjour à tous.", lang: "fr-CA", order: 0 }),
      item("frame", 600, 0, {
        text: 'Hello. Bonjour à tous. <img src="bad">',
        lang: "en-CA",
        textRuns: [{ start: 7, end: 22, style: { lang: "fr" } }],
        order: 1,
      }),
      item("frame", 1200, 0, { text: "", lang: "es", order: 2 }),
    ];
    const b = { ...newBoard("Agenda"), items: frames },
      ui = stubUI(b, { role: "owner", me: owner }),
      previousLanguage = language;
    setLanguage(interfaceLanguage);
    const checkTitles = (selector, wholeTag = "fr-CA", passageTag = "fr") => {
      const labels = [...ui.doc.querySelectorAll(selector)];
      assert.equal(labels.length, 3);
      assert.equal(labels[0].querySelector("[lang]")?.lang, wholeTag);
      assert.equal(
        labels[1].querySelector('[lang="en-CA"]')?.textContent,
        frames[1].text,
      );
      assert.equal(
        labels[1].querySelector(`[lang="${passageTag}"]`)?.textContent,
        "Bonjour à tous.",
      );
      assert.equal(labels[1].querySelector("img"), null);
      assert.equal(labels[2].textContent, t("Frame"));
      assert.equal(labels[2].querySelector("[lang]"), null);
    };
    try {
      ui.api.render();
      ui.api.open("session");
      checkTitles("#fac-stage-frames label");
      ui.api.open("vote");
      checkTitles("#fac-vote-frames label");
      ui.api.open("agenda");
      checkTitles(".fac-agenda strong");
      checkTitles(".fac-step legend");
      const go = ui.doc.querySelector('[data-fac="agenda-go"]'),
        references = go
          .getAttribute("aria-labelledby")
          .split(/\s+/)
          .map((id) => ui.doc.getElementById(id));
      assert.ok(references.every(Boolean));
      assert.equal(references[0].textContent, `${t("Go to step")}:`);
      assert.equal(references[1].querySelector("[lang]").lang, "fr-CA");
      ui.click('[data-fac="agenda-start"]');
      assert.equal(
        ui.doc.querySelector(".fac-remaining [lang]")?.lang,
        "fr-CA",
      );
      const chip = ui.doc.querySelector('[data-fac-open="agenda"]');
      assert.equal(chip.querySelector("[lang]")?.lang, "fr-CA");
      assert.equal(
        ui.doc.querySelector("#facilitation-live [lang]")?.lang,
        "fr-CA",
      );
      chip.focus();
      frames[0].lang = "fr-BE";
      b.updated++;
      ui.api.render();
      checkTitles(".fac-agenda strong", "fr-BE");
      checkTitles(".fac-step legend", "fr-BE");
      assert.equal(ui.doc.querySelector('[data-fac-open="agenda"]'), chip);
      assert.equal(ui.doc.activeElement, chip);
      assert.equal(chip.querySelector("[lang]").lang, "fr-BE");
      ui.click('[data-fac="agenda-next"]');
      for (const selector of [
        ".fac-remaining",
        '[data-fac-open="agenda"]',
        "#facilitation-live",
      ]) {
        assert.equal(
          ui.doc.querySelector(`${selector} [lang="fr"]`)?.textContent,
          "Bonjour à tous.",
        );
        assert.equal(ui.doc.querySelector(`${selector} img`), null);
      }
      frames[1].textRuns = [{ start: 7, end: 22, style: { lang: "fr-CA" } }];
      b.updated++;
      ui.api.render();
      assert.equal(
        ui.doc.querySelector('.fac-remaining [lang="fr-CA"]').textContent,
        "Bonjour à tous.",
      );
      assert.equal(
        ui.doc.querySelector('[data-fac-open="agenda"] [lang="fr-CA"]')
          .textContent,
        "Bonjour à tous.",
      );
      checkTitles(".fac-agenda strong", "fr-BE", "fr-CA");
      ui.api.open("session");
      checkTitles("#fac-stage-frames label", "fr-BE", "fr-CA");
      ui.api.open("vote");
      checkTitles("#fac-vote-frames label", "fr-BE", "fr-CA");
    } finally {
      setLanguage(previousLanguage);
      ui.close();
    }
  }
});

test("anonymous input says names are hidden in the app, not encrypted, in both languages", () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  const ui = stubUI(b, { role: "owner", me: owner });
  const previous = language;
  try {
    const copy = () =>
      ui.doc.querySelector("#fac-anonymous").closest("label").nextElementSibling
        .textContent;
    ui.api.open("session");
    assert.match(
      copy(),
      /not encrypted: anyone with access to the board data could find who wrote each note/,
    );
    setLanguage("fr");
    ui.api.render();
    assert.match(copy(), /pas chiffrés/);
  } finally {
    setLanguage(previous);
    ui.close();
  }
});

test("tagged agenda titles stay concealed in participant content and announcements", () => {
  const f = item("frame", 0, 0, {
      id: "french",
      text: "Bonjour à tous.",
      lang: "fr-CA",
    }),
    b = {
      ...newBoard("Agenda"),
      items: [f],
      workshop: {
        settings: { hide: [f.id] },
        agenda: { steps: [{ frame: f.id, text: "Private instructions" }] },
        run: {
          id: "run",
          state: "running",
          startedAt: 1,
          step: 0,
          frame: f.id,
        },
      },
    },
    ui = stubUI(b, { role: "editor", me: editor });
  try {
    ui.api.render();
    ui.api.open("agenda");
    for (const selector of [
      ".fac-agenda",
      ".fac-remaining",
      '[data-fac-open="agenda"]',
      "#facilitation-live",
    ]) {
      const el = ui.doc.querySelector(selector);
      assert.doesNotMatch(el.textContent, /Bonjour|Private instructions/);
      assert.equal(el.querySelector("[lang]"), null);
    }
    b.workshop = { ...b.workshop, settings: {} };
    ui.api.render();
    assert.equal(ui.doc.querySelector(".fac-agenda [lang]")?.lang, "fr-CA");
    assert.equal(
      ui.doc.querySelector('[data-fac-open="agenda"] [lang]')?.lang,
      "fr-CA",
    );
    b.workshop = { ...b.workshop, settings: { hide: [f.id] } };
    ui.api.render();
    assert.doesNotMatch(
      ui.doc.querySelector(".fac-agenda").textContent,
      /Bonjour/,
    );
    assert.equal(ui.doc.querySelector('[data-fac-open="agenda"] [lang]'), null);
  } finally {
    ui.close();
  }
});

test("the agenda runner advances ordered frames, brings everyone, and starts the step timer", () => {
  const frames = ["Welcome", "Brainstorm", "Vote"].map((text, n) =>
    item("frame", n * 600, 0, { id: `f${n}`, text, order: n, w: 500 }),
  );
  const b = {
    ...newBoard("Agenda"),
    shared: { server: "https://x.puter.work", room: "room" },
    items: frames,
    workshop: {
      agenda: {
        steps: [
          { frame: "f0", minutes: 2, text: "Introduce yourself" },
          { frame: "f1", minutes: 10 },
          { frame: "f2" },
        ],
      },
    },
  };
  const host = stubUI(b, { role: "owner", me: owner });
  try {
    host.api.open("agenda");
    assert.equal(host.doc.querySelectorAll(".fac-agenda li").length, 3);
    host.click('[data-fac="agenda-start"]');
    assert.equal(b.workshop.run.step, 0);
    assert.equal(
      b.workshop.session.state,
      "active",
      "Starting records a session",
    );
    assert.deepEqual(host.calls.focus, ["f0"]);
    assert.equal(host.calls.bring, 1);
    assert.equal(host.calls.timer[0].duration, 120000);
    assert.match(host.banner(), /Step 1 of 3: Welcome/);
    assert.match(host.banner(), /Introduce yourself/);
    host.click('[data-fac="agenda-next"]');
    assert.equal(b.workshop.run.step, 1);
    assert.equal(host.calls.timer[1].duration, 600000);
    host.click('[data-fac="agenda-next"]');
    assert.equal(
      host.calls.timer[2].state,
      "idle",
      "A step without a duration stops the last step's timebox",
    );
    assert.equal(
      host.doc.querySelector('[data-fac="agenda-next"]').disabled,
      true,
    );
    // Participants see the step and cannot run the agenda.
    const participant = stubUI(b, { role: "editor", me: editor });
    try {
      participant.api.render();
      assert.match(participant.banner(), /Step 3 of 3: Vote/);
      participant.api.open("agenda");
      assert.equal(
        participant.doc.querySelector('[data-fac="agenda-next"]'),
        null,
      );
      assert.equal(participant.doc.querySelector("#fac-tab-summary"), null);
      // A hidden step's title and instructions stay out of the banner and
      // its announcement.
      const shown = b.workshop;
      b.workshop = {
        ...shown,
        settings: { hide: ["f1"] },
        run: { ...shown.run, step: 1, frame: "f1" },
        agenda: {
          steps: shown.agenda.steps.map((s) =>
            s.frame === "f1" ? { ...s, text: "Pick the winner" } : s,
          ),
        },
      };
      participant.api.render();
      assert.match(
        participant.banner(),
        /Step 2 of 3: Hidden by the facilitator/,
      );
      const live = participant.doc.querySelector("#facilitation-live");
      assert.match(live.textContent, /Step 2 of 3: Hidden by the facilitator/);
      for (const text of [participant.banner(), live.textContent])
        assert.doesNotMatch(text, /Brainstorm|Pick the winner/);
      // The open Agenda tab follows frames being hidden and shown.
      const agenda = () =>
        participant.doc.querySelector(".fac-agenda").textContent;
      assert.match(agenda(), /Hidden by the facilitator/);
      assert.doesNotMatch(agenda(), /Brainstorm/);
      b.workshop = shown;
      participant.api.render();
      assert.match(agenda(), /Brainstorm/);
      b.workshop = { ...shown, settings: { hide: ["f0"] } };
      participant.api.render();
      assert.doesNotMatch(agenda(), /Welcome/);
      b.workshop = shown;
    } finally {
      participant.close();
    }
    host.click('[data-fac="agenda-end"]');
    assert.equal(b.workshop.run.state, "ended");
    assert.equal(host.banner(), "");
    // Skipped frames drop out of the steps.
    b.workshop.agenda.steps[1].skip = true;
    host.api.render();
    host.click('[data-fac="agenda-start"]');
    host.click('[data-fac="agenda-next"]');
    assert.match(host.banner(), /Step 2 of 2: Vote/);
  } finally {
    host.close();
  }
});

test("titles with dollar signs show and are announced as written", async () => {
  const { translateUI } = await import("../src/i18n.js");
  const title = "Q$$ plan $& $' $` done";
  const b = {
    ...newBoard("Agenda"),
    shared: { server: "https://x.puter.work", room: "room" },
    items: [
      item("frame", 0, 0, { id: "f0", text: title, order: 0, w: 500 }),
      ...notes(),
    ],
    workshop: { agenda: { steps: [{ frame: "f0" }] } },
  };
  const host = stubUI(b, { role: "owner", me: owner });
  globalThis.NodeFilter = host.doc.defaultView.NodeFilter;
  try {
    host.api.open("agenda");
    host.click('[data-fac="agenda-start"]');
    // Starting records attendance just after.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(host.banner(), `Step 1 of 1: ${title}`);
    b.workshop = { ...b.workshop, vote: vote({ title }) };
    host.api.render();
    const live = host.doc.querySelector("#facilitation-live");
    assert.equal(live.textContent, `Voting started: ${title}`);
    // The page translates announcements, which leaves the title as written.
    translateUI(host.doc.body);
    assert.equal(live.textContent, `Voting started: ${title}`);
  } finally {
    delete globalThis.NodeFilter;
    host.close();
  }
});

test("French facilitation tabs read the same once the page translates them", async () => {
  const { translateUI } = await import("../src/i18n.js");
  const b = { ...newBoard("Tabs"), items: notes() };
  const host = stubUI(b, { role: "owner", me: owner });
  globalThis.NodeFilter = host.doc.defaultView.NodeFilter;
  const previousLanguage = language;
  try {
    setLanguage("fr");
    host.api.open("vote");
    const tabs = () =>
      [...host.doc.querySelectorAll('[role="tab"]')].map((b) => b.textContent);
    const drawn = tabs();
    assert.ok(!drawn.includes("Voting"), drawn.join());
    // Each tab's French name is not itself an English phrase the page
    // would translate again.
    translateUI(host.doc.body);
    assert.deepEqual(tabs(), drawn);
  } finally {
    setLanguage(previousLanguage);
    delete globalThis.NodeFilter;
    host.close();
  }
});

test("people who only took part anonymously count as participants without being named", () => {
  const b = { ...newBoard("Anonymous only"), items: notes() };
  b.workshop = {
    vote: vote({ targets: ["a", "b"], anonymous: true }),
    ...Object.fromEntries([
      ballot(editor, ["a"], "vote1", false),
      ballot(owner, ["b"], "vote1", false),
    ]),
    [contributionKey("c")]: { by: editor.uuid, at: 3000, anonymous: true },
  };
  const summary = engagement(b, { now: 800000 });
  assert.equal(summary.totals.votes, 2);
  assert.equal(summary.totals.participants, 2, "Two people took part");
  assert.deepEqual(summary.people, [], "No one is named");
  // Once the vote is saved and the next begins, they still count.
  b.workshop[historyKey("vote1")] = resultRecord(b, "vote", (id) => id, 5000);
  for (const key of Object.keys(b.workshop))
    if (key.startsWith("v:")) delete b.workshop[key];
  b.workshop.vote = vote({ id: "vote2", anonymous: true });
  assert.equal(engagement(b, { now: 800000 }).totals.participants, 2);
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("summary");
    const text = ui.doc.querySelector("#fac-tabpanel").textContent;
    assert.match(text, /Participants\s*2/);
    assert.match(text, /Everyone took part anonymously so far/);
    assert.doesNotMatch(text, /No participation recorded yet/);
  } finally {
    ui.close();
  }
});

test("engagement summaries count contributions per participant and stay aggregate when anonymous", () => {
  const b = { ...newBoard("Summary"), items: notes() };
  b.workshop = {
    session: { id: "s1", state: "ended", startedAt: 1000, endedAt: 700000 },
    [participantKey(owner.uuid)]: {
      by: owner.uuid,
      name: "Alice",
      role: "owner",
      session: "s1",
      first: 1000,
      last: 600000,
    },
    [participantKey(editor.uuid)]: {
      by: editor.uuid,
      name: "Bob",
      role: "editor",
      session: "s1",
      first: 2000,
      last: 500000,
    },
    [contributionKey("a")]: { by: editor.uuid, at: 5000, name: "Bob" },
    [contributionKey("b")]: { by: editor.uuid, at: 300000, name: "Bob" },
    [contributionKey("c")]: { by: owner.uuid, at: 400000, anonymous: true },
    [reactionKey(owner.uuid, objectTarget("a"))]: {
      by: owner.uuid,
      target: ["o", "a"],
      types: ["heart", "idea"],
      at: 6000,
      name: "Alice",
    },
    vote: vote({ targets: ["a", "b"], anonymous: true }),
    ...Object.fromEntries([ballot(editor, ["a", "b"], "vote1", false)]),
  };
  b.comments = [
    {
      id: "t",
      x: 0,
      y: 0,
      resolved: false,
      messages: [
        {
          id: "m",
          authorId: owner.uuid,
          authorName: "Alice",
          text: "Nice",
          createdAt: 7000,
        },
      ],
    },
  ];
  const label = (id) => b.items.find((i) => i.id === id)?.text;
  const summary = engagement(b, { now: 800000, label });
  const bob = summary.people.find((p) => p.name === "Bob"),
    alice = summary.people.find((p) => p.name === "Alice");
  assert.equal(bob.notes, 2);
  assert.equal(bob.votes, 0, "Anonymous ballots are not attributed");
  assert.equal(alice.comments, 1);
  assert.equal(alice.reactions, 2);
  assert.equal(summary.anonymousNotes, 1);
  assert.equal(summary.totals.notes, 3);
  assert.deepEqual(summary.reacted[0], {
    id: "a",
    label: "Ship faster",
    count: 2,
  });
  assert.equal(summary.voted[0].count, 1);
  assert.equal(
    summary.timeline.reduce(
      (n, t) => n + t.notes + t.comments + t.reactions + t.votes + t.answers,
      0,
    ),
    3 + 1 + 2 + 2,
    "Notes, comments, reaction types, and votes",
  );
  const csv = engagementCSV(summary);
  assert.match(csv, /Workshop summary/);
  assert.match(csv, /Bob,Can edit,.*,2,0,0,0,0/);
  // Roles read in the reader's language, as the headings above them do.
  const previous = language,
    dom = new JSDOM("<!doctype html><html><body></body></html>"),
    saved = globalThis.document;
  globalThis.document = dom.window.document;
  setLanguage("fr");
  try {
    assert.match(engagementCSV(summary), /Nom,Rôle,.*\nBob,Peut modifier,/s);
  } finally {
    setLanguage(previous);
    globalThis.document = saved;
    dom.window.close();
  }
  b.workshop.settings = { anonymous: true };
  const hidden = engagement(b, { now: 800000, label });
  assert.equal(hidden.people.find((p) => p.name === "Bob").notes, 0);
  assert.equal(hidden.anonymousNotes, 3);
  // A reaction left anonymously stays unattributed once anonymity ends.
  b.workshop[reactionKey(editor.uuid, objectTarget("b"))] = {
    by: editor.uuid,
    target: ["o", "b"],
    types: ["heart"],
    at: 6000,
  };
  b.workshop.settings = { anonymous: false };
  const later = engagement(b, { now: 800000, label });
  assert.equal(later.people.find((p) => p.name === "Bob").reactions, 0);
  assert.equal(later.totals.reactions, 3);
});

// Worker enforcement through the real commit path.
function workerSetup() {
  const env = environment();
  return { env, boards: env.service };
}
async function createRoom(boards, items) {
  const b = newBoard("Workshop");
  b.items = items;
  const doc = new SharedDocument();
  doc.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  doc.destroy();
  return b.id;
}
async function commit(boards, user, room, change) {
  const { doc } = await boards.load(room);
  const before = doc.vector();
  const next = doc.snapshot();
  next.workshop ||= {};
  change(next, next.workshop);
  if (!Object.keys(next.workshop).length) delete next.workshop;
  doc.commit(next);
  const update = doc.update(before);
  doc.destroy();
  return boards.call(user, {
    op: "commit",
    room,
    id: await hash(update),
    update: encode(update),
  });
}
async function invite(boards, room, user, role) {
  const { token } = await boards.call(owner, { op: "invite", room, role });
  await boards.call(user, { op: "join", room, token });
}
const rejected = (promise, status = 422) => assert.rejects(promise, { status });

test("while anonymous input is on, the worker refuses named reactions and contributions", async () => {
  const { env, boards } = workerSetup();
  const room = await createRoom(boards, notes());
  await invite(boards, room, editor, "editor");
  const now = env.now;
  const reaction = (types, named) => ({
    by: editor.uuid,
    target: ["o", "a"],
    types,
    at: now,
    ...(named ? { name: editor.username } : {}),
  });
  const key = reactionKey(editor.uuid, objectTarget("a"));
  // A reaction named before anonymous input began stays valid.
  await commit(boards, editor, room, (b, w) => {
    w[key] = reaction(["heart"], true);
  });
  await commit(
    boards,
    owner,
    room,
    (b, w) => (w.settings = { anonymous: true }),
  );
  await commit(boards, owner, room, (b) => (b.title = "Renamed"));
  await rejected(
    commit(boards, editor, room, (b, w) => {
      w[key] = reaction(["heart", "plus"], true);
    }),
  );
  await rejected(
    commit(boards, editor, room, (b, w) => {
      const note = item("note", 0, 400, { id: "named", text: "Mine" });
      b.items.push(note);
      w[contributionKey(note.id)] = {
        by: editor.uuid,
        at: now,
        name: editor.username,
      };
    }),
  );
  await commit(boards, editor, room, (b, w) => {
    w[key] = reaction(["heart", "plus"], false);
    const note = item("note", 0, 400, { id: "unnamed", text: "Mine" });
    b.items.push(note);
    w[contributionKey(note.id)] = { by: editor.uuid, at: now, anonymous: true };
  });
  const { doc } = await boards.load(room);
  const saved = doc.snapshot().workshop;
  doc.destroy();
  assert.equal(saved[key].name, undefined);
  assert.equal(saved[contributionKey("unnamed")].anonymous, true);
});

test("the worker keeps staged frames and hidden objects from participants' edits", async () => {
  const { boards } = workerSetup();
  const frame = item("frame", 1000, 0, { id: "F1", w: 600, h: 400 });
  const room = await createRoom(boards, [
    ...notes(),
    frame,
    item("note", 1100, 100, { id: "secret", text: "Next", parentId: "F1" }),
    item("note", 0, 600, { id: "hid", text: "Later" }),
    item("note", 0, 900, { id: "plain", text: "Open" }),
  ]);
  await invite(boards, room, editor, "editor");
  await commit(boards, owner, room, (b, w) => {
    w.settings = { stage: { frames: ["F1"], shown: 0 }, hide: ["hid"] };
  });
  const find = (b, id) => b.items.find((i) => i.id === id);
  const drop = (b, id) => (b.items = b.items.filter((i) => i.id !== id));
  const refused = [
    (b) => (find(b, "secret").text = "Changed"),
    (b) => drop(b, "secret"),
    (b) => (find(b, "F1").text = "Peek"),
    (b) => drop(b, "F1"),
    (b) => (find(b, "hid").x += 10),
    (b) => drop(b, "hid"),
    // A new object cannot be slipped into a frame participants cannot see.
    (b) =>
      b.items.push(
        item("note", 1200, 100, { id: "new", text: "In", parentId: "F1" }),
      ),
  ];
  for (const change of refused)
    await rejected(commit(boards, editor, room, change));
  // Everything else on the open board stays theirs to change.
  await commit(boards, editor, room, (b) => {
    find(b, "plain").text = "Edited";
    b.items.push(item("note", 0, 1200, { id: "added", text: "New" }));
  });
  // The facilitator, who sees all of it, changes it as before.
  await commit(boards, owner, room, (b) => {
    find(b, "secret").text = "Revised";
    find(b, "hid").x += 10;
  });
  await commit(boards, owner, room, (b) => drop(b, "F1"));
});

test("a line to a hidden object follows and goes with its visible end", async () => {
  const { updateConnectors } = await import("../src/scene.js");
  const before = {
    title: "T",
    items: [
      item("note", 0, 0, { id: "seen" }),
      item("note", 600, 0, { id: "hid" }),
      item("arrow", 0, 0, { id: "line", startId: "seen", endId: "hid" }),
    ],
    workshop: { settings: { hide: ["hid"] } },
  };
  updateConnectors(before.items);
  const change = (edit) => {
    const after = structuredClone(before);
    edit(after);
    updateConnectors(after.items);
    return () => validateWorkshopChanges(before, after, editor, "editor");
  };
  // Moving the visible end re-routes the line.
  change((b) => (b.items[0].y += 150))();
  // Deleting the visible end removes the line with it.
  change((b) => (b.items = b.items.filter((i) => i.id === "hid")))();
  assert.throws(
    change((b) => (b.items = b.items.slice(0, 2))),
    /facilitator controls/,
  );
  assert.throws(
    change((b) => (b.items[2].color = "#ff0000")),
    /facilitator controls/,
  );
});

test("a device that missed the switch to anonymous input saves its note and reaction without its name", async () => {
  const { env, boards } = workerSetup();
  const room = await createRoom(boards, notes());
  await invite(boards, room, editor, "editor");
  let state,
    remade = null;
  const session = new CollaborationSession({
    puter: env.sdk(editor),
    server: "https://whiteboard-test.puter.work",
    room,
    user: editor,
    store: memoryStore(),
    changed: (next) => (state = next),
    activity() {},
    status() {},
    rejected: (info) => (remade = info.remade),
  });
  try {
    await session.start();
    // The facilitator turns anonymous input on; this device has not heard.
    await commit(
      boards,
      owner,
      room,
      (b, w) => (w.settings = { anonymous: true }),
    );
    const before = structuredClone(state),
      next = structuredClone(state);
    const note = item("note", 0, 400, { id: "late", text: "Offline idea" });
    next.items.push(note);
    next.workshop = {
      ...next.workshop,
      [contributionKey(note.id)]: {
        by: editor.uuid,
        at: env.now,
        name: editor.username,
      },
      [reactionKey(editor.uuid, objectTarget("a"))]: {
        by: editor.uuid,
        target: ["o", "a"],
        types: ["heart"],
        at: env.now,
        name: editor.username,
      },
    };
    await session.commit(next, before);
    await session.flush();
    await session.flush();
    assert.equal(remade, true);
    const { doc } = await boards.load(room);
    const saved = doc.snapshot();
    doc.destroy();
    assert.ok(saved.items.some((i) => i.id === "late"));
    assert.deepEqual(saved.workshop[contributionKey("late")], {
      by: editor.uuid,
      at: env.now,
      anonymous: true,
    });
    const r = saved.workshop[reactionKey(editor.uuid, objectTarget("a"))];
    assert.deepEqual(r.types, ["heart"]);
    assert.equal(r.name, undefined);
    assert.equal(saved.workshop.settings.anonymous, true);
    assert.equal(session.pending.size, 0);
  } finally {
    session.close();
  }
});

test("on a board locked for contributions, the worker keeps a participant's own sticky notes sticky notes", async () => {
  const { env, boards } = workerSetup();
  const room = await createRoom(boards, notes());
  await invite(boards, room, editor, "editor");
  const claim = (w, id) =>
    (w[contributionKey(id)] = {
      by: editor.uuid,
      at: env.now,
      name: editor.username,
    });
  // A shape the participant drew before the lock is theirs too.
  await commit(boards, editor, room, (b, w) => {
    b.items.push(item("rect", 0, 600, { id: "drawn" }));
    claim(w, "drawn");
  });
  await commit(boards, owner, room, (b, w) => {
    w.settings = { lock: "contribute" };
    w.vote = vote({ targets: ["a", "mine"], startedAt: env.now });
  });
  await commit(boards, editor, room, (b, w) => {
    b.items.push(item("note", 0, 300, { id: "mine", text: "Idea" }));
    claim(w, "mine");
  });
  const mine = (b) => b.items.find((i) => i.id === "mine");
  for (const type of ["ellipse", "text", "rect", "frame"])
    await rejected(commit(boards, editor, room, (b) => (mine(b).type = type)));
  await rejected(
    commit(
      boards,
      editor,
      room,
      (b) => (b.items.find((i) => i.id === "drawn").w = 400),
    ),
  );
  // Their notes stay theirs to change, and voting and reactions go on.
  await commit(boards, editor, room, (b, w) => {
    mine(b).text = "Refined";
    mine(b).color = "#ffd6e7";
    const [key, value] = ballot(editor, ["mine"]);
    w[key] = { ...value, at: env.now };
    w[reactionKey(editor.uuid, objectTarget("a"))] = {
      by: editor.uuid,
      target: ["o", "a"],
      types: ["heart"],
      at: env.now,
      name: editor.username,
    };
  });
  await commit(boards, editor, room, (b, w) => {
    b.items = b.items.filter((i) => i.id !== "mine");
    delete w[contributionKey("mine")];
  });
});

test("on a board locked for contributions, a participant's own shapes other than notes are locked to them", () => {
  const claim = { by: editor.uuid, at: 1, name: "Bob" };
  const b = {
    ...newBoard("Contribute"),
    shared: { server: "x", room: "r" },
    items: [
      item("note", 0, 0, { id: "note" }),
      item("rect", 300, 0, { id: "shape" }),
    ],
    workshop: {
      settings: { lock: "contribute" },
      [contributionKey("note")]: claim,
      [contributionKey("shape")]: claim,
    },
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    assert.equal(ui.api.locked(new Set(["note"])), false);
    assert.equal(ui.api.locked(new Set(["shape"])), true);
    assert.equal(
      ui.api.lockReason(new Set(["note", "shape"])),
      "While the board is locked, you can only change your own sticky notes.",
    );
  } finally {
    ui.close();
  }
});

test("the worker keeps a running agenda step's and a timed vote's timer the facilitator's", async () => {
  const { env, boards } = workerSetup();
  const now = env.now;
  const room = await createRoom(boards, notes());
  await invite(boards, room, editor, "editor");
  const timer = (id, extra = {}) => ({
    id,
    state: "running",
    duration: 600000,
    remaining: 600000,
    endsAt: now + 600000,
    ...extra,
  });
  const paused = (b) =>
    (b.timer = { ...b.timer, state: "paused", remaining: 500000, endsAt: 0 });
  const changes = [
    paused,
    (b) => (b.timer = { ...b.timer, state: "idle", endsAt: 0 }),
    (b) =>
      (b.timer = {
        ...b.timer,
        duration: 660000,
        remaining: 660000,
        endsAt: now + 660000,
      }),
    (b) => (b.timer = timer("by-hand")),
    (b) => delete b.timer,
  ];
  await commit(boards, owner, room, (b, w) => {
    w.run = {
      id: "run1",
      state: "running",
      step: 0,
      startedAt: now,
      stepAt: now,
    };
    b.timer = timer("agenda-run1");
  });
  for (const change of changes)
    await rejected(commit(boards, editor, room, change));
  // The rest of the board stays open to them.
  await commit(boards, editor, room, (b) => (b.items[0].text = "Edited"));
  // A step's timer the agenda stopped leaves the timer free again.
  await commit(boards, owner, room, (b) => {
    b.timer = { ...b.timer, state: "idle", endsAt: 0 };
  });
  await commit(boards, editor, room, (b) => (b.timer = timer("by-hand")));
  await commit(boards, owner, room, (b, w) => {
    w.vote = vote({ startedAt: now, endsAt: now + 600000 });
    b.timer = timer(voteTimerId(w.vote));
  });
  await rejected(commit(boards, editor, room, paused));
  await commit(boards, owner, room, paused);
  // Once the agenda and the vote end, the timer is everyone's again.
  await commit(boards, owner, room, (b, w) => {
    w.run = { ...w.run, state: "ended" };
    w.vote = { ...w.vote, state: "ended", endedAt: now };
  });
  await commit(boards, editor, room, (b) => (b.timer = timer("by-hand")));
  await commit(boards, editor, room, paused);
});

test("a facilitator's timebox that has run out is free for participants again", async () => {
  const { facilitatorTimer } = await import("../src/facilitation/model.js");
  const workshop = {
    run: { id: "run1", state: "running", step: 0, startedAt: 0, stepAt: 0 },
  };
  const timer = {
    id: "agenda-run1",
    state: "running",
    duration: 60000,
    remaining: 60000,
    endsAt: 60000,
  };
  assert.match(facilitatorTimer(workshop, timer, 30000), /agenda step/);
  assert.match(
    facilitatorTimer(
      workshop,
      { ...timer, state: "paused", remaining: 5000, endsAt: 0 },
      90000,
    ),
    /agenda step/,
    "A paused timebox stays the facilitator's",
  );
  assert.equal(
    facilitatorTimer(workshop, timer, 60001),
    null,
    "Time's up: anyone may reset it",
  );
});

test("the worker lets commenters vote and react but not edit content, and only facilitators run sessions", async () => {
  const { env, boards } = workerSetup();
  const room = await createRoom(boards, notes());
  await invite(boards, room, editor, "editor");
  await invite(boards, room, viewer, "commenter");
  await invite(boards, room, guest, "viewer");
  const now = env.now;
  await rejected(
    commit(boards, editor, room, (b, w) => (w.vote = vote({ startedAt: now }))),
  );
  await commit(
    boards,
    owner,
    room,
    (b, w) => (w.vote = vote({ startedAt: now })),
  );
  // A commenter votes and reacts, but cannot change content or the session.
  await commit(boards, viewer, room, (b, w) => {
    const [key, value] = ballot(viewer, ["a", "b"]);
    w[key] = { ...value, at: now };
    w[reactionKey(viewer.uuid, objectTarget("a"))] = {
      by: viewer.uuid,
      target: ["o", "a"],
      types: ["thumbs"],
      at: now,
      name: viewer.username,
    };
  });
  await rejected(
    commit(boards, viewer, room, (b) => (b.items[0].text = "Changed")),
  );
  await rejected(
    commit(boards, viewer, room, (b, w) => (w.vote.revealed = true)),
  );
  await rejected(
    commit(boards, viewer, room, (b, w) => (w.settings = { lock: "open" })),
  );
  // Nobody changes another person's ballot or reaction.
  await rejected(
    commit(
      boards,
      editor,
      room,
      (b, w) => delete w[voteKey("vote1", viewer.uuid)],
    ),
  );
  await rejected(
    commit(
      boards,
      owner,
      room,
      (b, w) => delete w[voteKey("vote1", viewer.uuid)],
    ),
    422,
  );
  await rejected(
    commit(boards, editor, room, (b, w) => {
      const [key, value] = ballot(viewer, ["c"]);
      w[key] = value;
    }),
  );
  await rejected(
    commit(boards, editor, room, (b, w) => {
      delete w[reactionKey(viewer.uuid, objectTarget("a"))];
    }),
  );
  await rejected(
    commit(boards, editor, room, (b, w) => {
      const [key, value] = ballot(editor, ["a", "b", "c"]);
      w[key] = value;
    }),
    422,
  );
  await rejected(
    commit(boards, editor, room, (b, w) => {
      const [key, value] = ballot(editor, ["a", "a"]);
      w[key] = value;
    }),
  );
  await rejected(
    commit(boards, editor, room, (b, w) => {
      const [key, value] = ballot(editor, ["missing"]);
      w[key] = value;
    }),
  );
  await rejected(
    commit(boards, editor, room, (b, w) => (w.settings = { private: "r1" })),
  );
  await rejected(
    commit(boards, editor, room, (b, w) => (w.settings = { lock: "frozen" })),
  );
  // Viewers write nothing.
  await rejected(
    commit(boards, guest, room, (b, w) => {
      const [key, value] = ballot(guest, ["a"]);
      w[key] = value;
    }),
    403,
  );
  // A participant removes their own vote; facilitators end the session.
  // Ballots are taken for a moment after it ends, so it ended a while ago.
  await commit(boards, viewer, room, (b, w) => {
    w[voteKey("vote1", viewer.uuid)].ids = ["b"];
  });
  await commit(boards, owner, room, (b, w) => {
    w.vote = { ...w.vote, state: "ended", endedAt: now - VOTE_GRACE - 1000 };
  });
  await rejected(
    commit(
      boards,
      viewer,
      room,
      (b, w) => delete w[voteKey("vote1", viewer.uuid)],
    ),
  );
  const { doc } = await boards.load(room);
  const final = doc.snapshot();
  doc.destroy();
  assert.deepEqual(final.workshop[voteKey("vote1", viewer.uuid)].ids, ["b"]);
  assert.equal(final.items[0].text, "Ship faster");
  // Timed votes close at their deadline.
  await commit(boards, owner, room, (b, w) => {
    w.vote = vote({ id: "vote2", startedAt: env.now, endsAt: env.now + 60000 });
  });
  env.now += 120000;
  await rejected(
    commit(boards, viewer, room, (b, w) => {
      const [key, value] = ballot(viewer, ["a"], "vote2");
      w[key] = value;
    }),
  );
});

test("the worker enforces board locks and private notes and audits facilitation changes", async () => {
  const { env, boards } = workerSetup();
  const room = await createRoom(boards, notes());
  await invite(boards, room, editor, "editor");
  await invite(boards, room, guest, "editor");
  await invite(boards, room, viewer, "commenter");
  const add =
    (user, extra = {}, claim = user) =>
    (b, w) => {
      const note = item("note", 0, 300, {
        id: `n-${user.username}-${b.items.length}`,
        text: "Idea",
        ...extra,
      });
      b.items.push(note);
      w[contributionKey(note.id)] = {
        by: claim.uuid,
        at: env.now,
        name: claim.username,
      };
    };
  await commit(
    boards,
    owner,
    room,
    (b, w) => (w.settings = { lock: "contribute" }),
  );
  await commit(boards, editor, room, add(editor));
  await rejected(commit(boards, editor, room, add(editor, { type: "rect" })));
  await rejected(commit(boards, editor, room, add(editor, {}, owner)));
  await rejected(
    commit(boards, editor, room, (b) =>
      b.items.push(item("note", 0, 0, { id: "unclaimed" })),
    ),
  );
  await rejected(commit(boards, editor, room, (b) => (b.items[0].x = 40)));
  await rejected(commit(boards, editor, room, (b) => b.items.splice(0, 1)));
  await rejected(commit(boards, editor, room, (b) => (b.title = "Renamed")));
  await commit(
    boards,
    editor,
    room,
    (b) => (b.items.at(-1).text = "Refined idea"),
  );
  await commit(boards, owner, room, (b) => (b.items[0].x = 40));
  await commit(
    boards,
    owner,
    room,
    (b, w) => (w.settings = { lock: "frozen" }),
  );
  await rejected(commit(boards, editor, room, add(editor)));
  await rejected(
    commit(boards, editor, room, (b) => (b.items.at(-1).text = "Again")),
  );
  // Voting, reactions, and comments continue while frozen.
  await commit(boards, viewer, room, (b, w) => {
    w[reactionKey(viewer.uuid, objectTarget("a"))] = {
      by: viewer.uuid,
      target: ["o", "a"],
      types: ["eyes"],
      at: env.now,
      name: viewer.username,
    };
  });
  // Private notes are protected from other participants until revealed.
  await commit(boards, owner, room, (b, w) => (w.settings = { private: "r1" }));
  await commit(boards, editor, room, (b, w) => {
    add(editor)(b, w);
    w[contributionKey(b.items.at(-1).id)].round = "r1";
  });
  await rejected(
    commit(boards, guest, room, (b) => (b.items.at(-1).text = "Tampered")),
  );
  await commit(boards, owner, room, (b, w) => (w.settings = { private: null }));
  await commit(boards, guest, room, (b) => (b.items.at(-1).text = "Built on"));
  // Reactions and contribution records of deleted objects may be cleared.
  await commit(boards, editor, room, (b, w) => {
    const id = b.items.at(-1).id;
    b.items.pop();
    delete w[contributionKey(id)];
  });
  await commit(boards, owner, room, (b, w) => {
    w.poll = {
      id: "p1",
      question: "Continue?",
      options: [
        { id: "y", text: "Yes" },
        { id: "n", text: "No" },
      ],
      multiple: false,
      anonymous: true,
      hidden: false,
      state: "open",
      revealed: false,
      startedAt: env.now,
    };
    w.vote = vote({ startedAt: env.now });
  });
  await commit(boards, viewer, room, (b, w) => {
    w[answerKey("p1", viewer.uuid)] = {
      poll: "p1",
      by: viewer.uuid,
      ids: ["y"],
      at: env.now,
    };
  });
  await rejected(
    commit(boards, viewer, room, (b, w) => {
      w[answerKey("p1", viewer.uuid)] = {
        poll: "p1",
        by: viewer.uuid,
        ids: ["y"],
        at: env.now,
        name: viewer.username,
      };
    }),
  );
  await commit(boards, owner, room, (b, w) => {
    w.poll = { ...w.poll, state: "closed", endedAt: env.now };
    w.vote = { ...w.vote, state: "ended", revealed: true, endedAt: env.now };
  });
  const actions = [...env.data]
    .filter(([key]) => key.startsWith("org:audit:"))
    .map(([, entry]) => entry.action);
  for (const action of [
    "workshop.locked",
    "workshop.private_mode",
    "vote.started",
    "vote.ended",
    "vote.revealed",
    "poll.started",
    "poll.closed",
  ])
    assert.ok(actions.includes(action), action);
  const locked = [...env.data].find(
    ([key, entry]) =>
      key.startsWith("org:audit:") && entry.action === "workshop.locked",
  )[1];
  assert.equal(locked.category, "content");
  assert.equal(locked.actor.uuid, owner.uuid);
});

test("workshop events and client-side validation agree on facilitator-only changes", () => {
  const before = { title: "T", items: notes(), workshop: {} };
  const after = { ...before, workshop: { settings: { lock: "frozen" } } };
  assert.throws(
    () => validateWorkshopChanges(before, after, editor, "editor"),
    /facilitator/,
  );
  validateWorkshopChanges(before, after, owner, "facilitator");
  assert.deepEqual(
    workshopEvents(before.workshop, after.workshop).map((e) => e.action),
    ["workshop.locked"],
  );
  const reaction = {
    [reactionKey(editor.uuid, messageTarget("t", "m"))]: {
      by: editor.uuid,
      target: ["m", "t", "m"],
      types: ["plus"],
      at: 1,
      name: "Bob",
    },
  };
  const discussed = {
    ...before,
    comments: [
      {
        id: "t",
        x: 0,
        y: 0,
        resolved: false,
        messages: [
          {
            id: "m",
            authorId: owner.uuid,
            authorName: "Alice",
            text: "Hi",
            createdAt: 1,
          },
        ],
      },
    ],
  };
  validateWorkshopChanges(
    discussed,
    { ...discussed, workshop: reaction },
    editor,
    "commenter",
  );
  // A reaction to a message that is gone is harmless, as when it was
  // deleted at the same moment, and is not refused with everything else.
  assert.doesNotThrow(() =>
    validateWorkshopChanges(
      before,
      { ...before, workshop: reaction },
      editor,
      "commenter",
    ),
  );
});

test("participants record their own attendance but cannot fake it", async () => {
  // The console records a participant's attendance through the same checks.
  const b = {
    ...newBoard("Attendance"),
    items: notes(),
    shared: { server: "x", room: "r" },
  };
  b.workshop = { session: { id: "s1", state: "active", startedAt: 1000 } };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    ui.api.render();
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    ui.close();
  }
  const key = participantKey(editor.uuid);
  assert.deepEqual(b.workshop[key], {
    by: editor.uuid,
    name: "Bob",
    role: "editor",
    session: "s1",
    first: 10000,
    last: 10000,
  });

  const now = 900000;
  const session = { id: "s1", state: "active", startedAt: 100000 };
  const record = {
    by: editor.uuid,
    name: "Bob",
    role: "editor",
    session: "s1",
    first: 200000,
    last: 500000,
  };
  const board = (entry) => ({
    title: "T",
    items: notes(),
    workshop: { session, ...(entry ? { [key]: entry } : {}) },
  });
  const put = (from, patch, user = editor, role = "editor") =>
    validateWorkshopChanges(
      board(from),
      board(patch && { ...(from || record), ...patch }),
      user,
      role,
      now,
    );
  // Seen again: only "last seen" moves on.
  put(record, { last: now });
  // A record written just before the owner changed their role still saves.
  put(record, { last: now }, editor, "commenter");
  put(undefined, { first: now, last: now });
  // Two clients recording the same person at once differ by a moment.
  put(
    { ...record, first: now - 1000, last: now - 1000 },
    {
      first: now - 3000,
      last: now - 3000,
    },
  );
  const faked = [
    [record, { role: "owner" }],
    [record, { role: "facilitator" }],
    [record, { role: "Administrator" }],
    [record, { last: 8e15 }],
    [record, { first: 0 }],
    [record, { first: 150000 }],
    [undefined, { first: 0, last: now }],
    [undefined, { first: 1000, last: 1000 }],
    [record, { session: undefined }],
    [record, null],
  ];
  for (const [from, patch] of faked)
    assert.throws(() => put(from, patch), /attendance/, JSON.stringify(patch));
  // Facilitators may still record and clear anyone.
  put(record, { role: "facilitator", first: 0 }, owner, "facilitator");
  put(record, null, owner, "facilitator");
});

test("workshop rules the worker enforces explain themselves in French", async () => {
  const { readFileSync } = await import("node:fs");
  const { setLanguage, t } = await import("../src/i18n.js");
  const source = readFileSync(
    new URL("../src/facilitation/model.js", import.meta.url),
    "utf8",
  );
  const messages = [...source.matchAll(/Error\(\s*"((?:[^"\\]|\\.)*)"/g)].map(
    (m) => JSON.parse(`"${m[1]}"`),
  );
  assert.ok(messages.includes("This attendance record is not allowed."));
  const dom = new JSDOM("", { url: "https://whiteboard.test" });
  globalThis.document = dom.window.document;
  try {
    setLanguage("fr");
    assert.deepEqual(
      messages.filter((m) => t(m) === m),
      [],
    );
  } finally {
    setLanguage("en");
    dom.window.close();
    delete globalThis.document;
  }
});

// Resolve the naming references as well as ordinary aria-labels.
const accessibleName = (node) =>
  (node.getAttribute("aria-labelledby")
    ? node
        .getAttribute("aria-labelledby")
        .split(/\s+/)
        .map((id) => node.ownerDocument.getElementById(id)?.textContent || "")
        .join(" ")
    : node.getAttribute("aria-label") || node.textContent
  )
    .replace(/\s+/g, " ")
    .trim();

// A facilitation console bound to a small DOM with injected dependencies.
test("selecting a vote's top results leaves out objects hidden from the participant", () => {
  const shown = item("note", 0, 0, { text: "Visible idea" }),
    secret = item("note", 300, 0, { text: "Hidden secret" });
  const b = {
    ...newBoard("Top results"),
    shared: { server: "x", room: "r" },
    items: [shown, secret],
  };
  b.workshop = {
    settings: { hide: [secret.id] },
    vote: {
      id: "vote1",
      title: "Pick",
      votes: 2,
      multiple: false,
      anonymous: false,
      hidden: false,
      targets: [shown.id, secret.id],
      state: "ended",
      revealed: false,
      startedAt: 1000,
      endsAt: 0,
      endedAt: 5000,
    },
    [voteKey("vote1", owner.uuid)]: {
      vote: "vote1",
      by: owner.uuid,
      ids: [secret.id, shown.id],
      at: 2000,
      name: "Olive",
    },
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    ui.api.open("vote");
    ui.doc.querySelector("#fac-top").value = "2";
    ui.doc.querySelector('[data-fac="vote-top"]').click();
    assert.deepEqual(ui.calls.selects, [[shown.id]]);
  } finally {
    ui.close();
  }
});

test("completed votes are offered to summaries as each person sees them in History", () => {
  const b = { ...newBoard("Outcomes"), items: notes() };
  const shown = vote({
    id: "v1",
    title: "Open",
    state: "ended",
    hidden: false,
  });
  const secret = vote({ id: "v2", title: "Secret", state: "ended" });
  b.workshop = Object.fromEntries([
    ballot(editor, ["a"], "v1"),
    ballot(editor, ["b"], "v2"),
  ]);
  for (const [v, at] of [
    [shown, 5000],
    [secret, 6000],
  ])
    b.workshop[historyKey(v.id)] = resultRecord(
      { ...b, workshop: { ...b.workshop, vote: v } },
      "vote",
      (id) => b.items.find((i) => i.id === id).text,
      at,
    );
  const titles = (role, me) => {
    const ui = stubUI(b, { role, me });
    try {
      return ui.api.outcomes().map((r) => [r.title, r.results]);
    } finally {
      ui.close();
    }
  };
  assert.deepEqual(titles("editor", editor), [
    ["Open", [{ label: "Ship faster", count: 1 }]],
  ]);
  // Facilitators' summaries can be added to the board, so results not yet
  // revealed stay out of theirs too.
  assert.deepEqual(
    titles("owner", owner).map(([title]) => title),
    ["Open"],
  );
  b.workshop[historyKey("v2")] = {
    ...b.workshop[historyKey("v2")],
    hidden: false,
  };
  assert.deepEqual(
    titles("editor", editor).map(([title]) => title),
    ["Secret", "Open"],
    "Most recent first once revealed",
  );
});

test("facilitators add time to a timed vote from the Voting tab", () => {
  const b = { ...newBoard("More time"), items: notes() };
  // A one-minute vote shown in the board timer; now is 10 s.
  b.workshop = { vote: vote({ endsAt: 70000 }) };
  b.timer = {
    id: "vote-vote1",
    state: "running",
    duration: 60000,
    remaining: 60000,
    endsAt: 70000,
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("vote");
    const add = ui.doc.querySelector(
      '[data-fac="vote-extend"][data-minutes="5"]',
    );
    assert.equal(add.getAttribute("aria-label"), "Add 5 minutes to voting");
    add.click();
    assert.equal(b.workshop.vote.endsAt, 370000);
    assert.equal(b.timer.endsAt, 370000, "The board timer keeps to the vote");
    assert.equal(b.timer.duration, 360000);
    // A timer counting for something else is left alone.
    b.timer = { ...b.timer, id: "agenda-run1" };
    const before = b.timer;
    ui.click('[data-fac="vote-extend"][data-minutes="1"]');
    assert.equal(b.workshop.vote.endsAt, 430000);
    assert.equal(b.timer, before);
    // There is a limit, as when starting a vote.
    b.workshop = { vote: vote({ endsAt: 10000 + 598 * 60000 }) };
    ui.api.render();
    ui.click('[data-fac="vote-extend"][data-minutes="5"]');
    assert.equal(b.workshop.vote.endsAt, 10000 + 598 * 60000);
    assert.match(
      ui.doc.querySelector("#fac-error").textContent,
      /up to 600 more minutes/,
    );
    // A vote without a time limit, or one that has ended, offers none.
    b.workshop = { vote: vote() };
    ui.api.render();
    assert.equal(ui.doc.querySelector('[data-fac="vote-extend"]'), null);
  } finally {
    ui.close();
  }
});

test("tied vote results share a place and are selected together", () => {
  const b = { ...newBoard("Ties"), items: notes() };
  // a has two votes; b and c one each, tied for second.
  b.workshop = Object.fromEntries([
    ["vote", vote({ hidden: false })],
    ballot(editor, ["a", "b"]),
    ballot(owner, ["a", "c"]),
  ]);
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("vote");
    ui.click('[data-fac="vote-end"]');
    const placesShown = () =>
      [...ui.doc.querySelectorAll("#fac-tabpanel .fac-place")].map(
        (p) => p.textContent,
      );
    assert.deepEqual(placesShown(), ["1.", "2.", "2."]);
    ui.doc.querySelector("#fac-top").value = "2";
    ui.click('[data-fac="vote-top"]');
    assert.deepEqual(ui.calls.selects, [["a", "b", "c"]]);
    assert.match(
      ui.doc.querySelector("#facilitation-live").textContent,
      /3 objects selected, with results tied for last place\./,
    );
    ui.doc.querySelector("#fac-top").value = "1";
    ui.click('[data-fac="vote-top"]');
    assert.deepEqual(ui.calls.selects.at(-1), ["a"]);
    // A saved result ranks the same way.
    ui.openHistory();
    assert.deepEqual(placesShown(), ["1.", "2.", "2."]);
  } finally {
    ui.close();
  }
});

test("revealing a vote another facilitator cleared meanwhile says so", () => {
  const note = item("note", 0, 0, { text: "Idea" });
  const b = {
    ...newBoard("Cleared vote"),
    shared: { server: "x", room: "r" },
    items: [note],
  };
  b.workshop = {
    settings: {},
    vote: {
      id: "vote1",
      title: "Pick",
      votes: 2,
      multiple: false,
      anonymous: false,
      hidden: true,
      targets: [note.id],
      state: "ended",
      revealed: false,
      startedAt: 1000,
      endsAt: 0,
      endedAt: 5000,
    },
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("vote");
    const reveal = ui.doc.querySelector('[data-fac="vote-reveal"]');
    assert.ok(reveal, "The ended vote offers to reveal its results");
    delete b.workshop.vote;
    reveal.click();
    const shown = [
      ui.doc.querySelector("#fac-error")?.textContent || "",
      ...ui.calls.toasts,
    ].join(" ");
    assert.match(shown, /No vote is running/);
    assert.doesNotMatch(shown, /Invalid workshop/);
  } finally {
    ui.close();
  }
});

test("a participant's export leaves out reactions to objects hidden from them", () => {
  const shown = item("note", 0, 0, { text: "Visible idea" }),
    secret = item("note", 300, 0, { text: "Answer key" });
  const b = {
    ...newBoard("Reactions"),
    shared: { server: "x", room: "r" },
    items: [shown, secret],
  };
  const react = (id) => ({
    by: owner.uuid,
    target: ["o", id],
    types: ["heart"],
    at: 1,
    name: "Olive",
  });
  b.workshop = {
    settings: { hide: [secret.id] },
    [reactionKey(owner.uuid, ["o", secret.id])]: react(secret.id),
    [reactionKey(owner.uuid, ["o", shown.id])]: react(shown.id),
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    const exported = structuredClone(b);
    ui.api.portable(exported);
    assert.deepEqual(
      Object.values(exported.workshop).map((r) => r.target[1]),
      [shown.id],
    );
  } finally {
    ui.close();
  }
});

test("a participant's copies and exports keep anonymous reactions' counts but not who left them", () => {
  const idea = item("note", 0, 0, { id: "n1", text: "Idea" });
  const b = {
    ...newBoard("Reactions"),
    shared: { server: "x", room: "r" },
    items: [idea],
  };
  const react = (user, types, name) => ({
    by: user.uuid,
    target: ["o", "n1"],
    types,
    at: 1,
    ...(name ? { name } : {}),
  });
  b.workshop = {
    settings: { anonymous: true },
    [reactionKey(owner.uuid, ["o", "n1"])]: react(owner, ["heart", "plus"]),
    [reactionKey(editor.uuid, ["o", "n1"])]: react(editor, ["heart"]),
    [reactionKey(viewer.uuid, ["o", "n1"])]: react(viewer, ["plus"], "Vic"),
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    for (const make of [
      (copy) => ui.api.portableCopy(copy),
      (copy) => ui.api.portable(copy),
    ]) {
      const copy = structuredClone(b);
      make(copy);
      const text = JSON.stringify(copy.workshop);
      assert.doesNotMatch(text, new RegExp(owner.uuid));
      assert.doesNotMatch(text, new RegExp(editor.uuid));
      // A named reaction was never anonymous.
      assert.match(text, new RegExp(viewer.uuid));
      const reactions = Object.values(copy.workshop);
      assert.equal(reactions.length, 3);
      assert.equal(new Set(reactions.map((r) => r.by)).size, 3);
      assert.deepEqual(reactions.flatMap((r) => r.types).sort(), [
        "heart",
        "heart",
        "plus",
        "plus",
      ]);
      validateWorkshop(copy.workshop);
      validateBoard({ ...copy, shared: undefined });
    }
  } finally {
    ui.close();
  }
});

test("a participant's copies and exports leave out tags used only on hidden objects", () => {
  const answers = item("frame", 900, 0, { w: 400, h: 300 }),
    answer = item("note", 920, 20, {
      text: "The answer",
      parentId: answers.id,
      tagIds: ["secret", "shared"],
    }),
    shown = item("note", 0, 0, { text: "Warm-up", tagIds: ["shared"] });
  const b = {
    ...newBoard("Quiz"),
    shared: { server: "x", room: "r" },
    items: [answers, answer, shown],
    tags: [
      { id: "secret", name: "Answer is Paris", color: "#dce5f7" },
      { id: "shared", name: "Round 1", color: "#dce5f7" },
      { id: "unused", name: "Later", color: "#dce5f7" },
    ],
    workshop: { settings: { hide: [answers.id] } },
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    for (const make of [
      (copy) => ui.api.portableCopy(copy),
      (copy) => ui.api.portable(copy),
    ]) {
      const copy = structuredClone(b);
      make(copy);
      assert.deepEqual(
        copy.items.map((i) => i.id),
        [shown.id],
      );
      assert.deepEqual(
        copy.tags.map((t) => t.id),
        ["shared", "unused"],
      );
    }
  } finally {
    ui.close();
  }
});

function stubUI(
  board,
  {
    role,
    me,
    selection = new Set(),
    now = () => 10000,
    roster = () => [],
    session = () => null,
    canParticipate = () => role !== "viewer",
    managesAccess,
    guestRole,
  },
) {
  const dom = new JSDOM(
    '<div class="canvas-wrap"><canvas id="canvas"></canvas><div class="canvas-navigation"><button data-action="facilitation"></button></div></div>',
  );
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  const doc = dom.window.document;
  doc.querySelector("#canvas").getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1600,
    height: 900,
  });
  const calls = {
    focus: [],
    bring: 0,
    timer: [],
    toasts: [],
    downloads: [],
    selects: [],
  };
  const api = createFacilitationUI({
    board: () => board,
    identity: () => ({ id: me.uuid, name: me.username }),
    role: () => role,
    canParticipate,
    ...(managesAccess ? { managesAccess } : {}),
    ...(guestRole ? { guestRole } : {}),
    canEdit: () => ["owner", "facilitator", "editor"].includes(role),
    now,
    view: () => ({ x: 0, y: 0, z: 1 }),
    canvas: () => doc.querySelector("#canvas"),
    hidden: () => new Map(),
    selection: () => selection,
    select: (ids) => calls.selects.push([...ids]),
    commit(workshop) {
      if (workshop) board.workshop = workshop;
      else delete board.workshop;
      api.render();
    },
    setTimer(timer) {
      calls.timer.push(timer);
      board.timer = timer;
    },
    focusFrame: (frame) => calls.focus.push(frame.id),
    bring: () => calls.bring++,
    follow: () => {},
    session,
    roster,
    icon: (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`,
    toast: (message) => calls.toasts.push(message),
    download: (...args) => calls.downloads.push(args),
    draw: () => {},
  });
  api.bind(doc.querySelector(".canvas-wrap"));
  return {
    api,
    doc,
    calls,
    click(selector) {
      const el = doc.querySelector(selector);
      assert.ok(el, selector);
      el.click();
    },
    // History draws a saved result's rows once its section opens.
    openHistory() {
      api.open("history");
      for (const d of doc.querySelectorAll(
        'details[data-section^="history-"]',
      )) {
        d.open = true;
        d.dispatchEvent(new dom.window.Event("toggle"));
      }
    },
    banner: () =>
      doc.querySelector("#workshop-banner").hidden
        ? ""
        : doc.querySelector("#workshop-banner").textContent,
    close() {
      api.detach();
      dom.window.close();
      if (previous === undefined) delete globalThis.document;
      else globalThis.document = previous;
    },
  };
}

test("on an archived board, the People tab still manages who has access, as Participants does", async () => {
  const b = newBoard("Archived workshop");
  b.shared = true;
  const ticket = (user, session, role) => ({
    user: user.uuid,
    username: user.username,
    session,
    role,
  });
  const people = [ticket(owner, "a", "owner"), ticket(editor, "b", "editor")];
  const requests = [];
  const live = {
    request: async (op, input) => {
      requests.push([op, input]);
      return {};
    },
    heartbeat: async () => {},
  };
  const ui = stubUI(b, {
    role: "owner",
    me: owner,
    roster: () => people,
    session: () => live,
    // Archived: content and activities are closed, access is not.
    canParticipate: () => false,
    managesAccess: () => true,
  });
  try {
    ui.api.open("people");
    const select = ui.doc.querySelector(`[data-fac-role="${editor.uuid}"]`);
    assert.ok(select, "Roles can still be changed");
    assert.ok(
      ui.doc.querySelector(`[data-fac="remove"][data-id="${editor.uuid}"]`),
    );
    // Bringing everyone along is an activity, closed with the board.
    assert.equal(
      ui.doc.querySelector('[data-fac="bring"]').parentElement.hidden,
      true,
    );
    select.value = "viewer";
    select.dispatchEvent(
      new ui.doc.defaultView.Event("change", { bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(requests, [
      ["role", { uuid: editor.uuid, role: "viewer" }],
    ]);
  } finally {
    ui.close();
  }
});

test("the People tab offers a guest no more than the organization lets guests have", () => {
  const b = newBoard("Guests");
  b.shared = true;
  const people = [
    { user: owner.uuid, username: owner.username, session: "a", role: "owner" },
    { user: editor.uuid, username: "Bob", session: "b", role: "commenter" },
    {
      user: viewer.uuid,
      username: "Dee",
      session: "c",
      role: "commenter",
      guest: true,
    },
  ];
  const ui = stubUI(b, {
    role: "owner",
    me: owner,
    roster: () => people,
    session: () => ({}),
    guestRole: () => "commenter",
  });
  try {
    ui.api.open("people");
    const options = (who) =>
      [...ui.doc.querySelector(`[data-fac-role="${who.uuid}"]`).options].map(
        (o) => o.value,
      );
    assert.deepEqual(options(viewer), ["commenter", "viewer"]);
    assert.deepEqual(options(editor), [
      "commenter",
      "facilitator",
      "editor",
      "viewer",
    ]);
  } finally {
    ui.close();
  }
});

test("people joining or leaving reach the People tab and attendance without a board edit", async () => {
  const b = newBoard("Live workshop");
  b.shared = true;
  b.workshop = { session: { id: "s1", state: "active", startedAt: 5000 } };
  const ticket = (user, session, role) => ({
    user: user.uuid,
    username: user.username,
    session,
    role,
  });
  let people = [ticket(owner, "a", "owner")];
  const live = {};
  const ui = stubUI(b, {
    role: "owner",
    me: owner,
    roster: () => people,
    session: () => live,
  });
  try {
    ui.api.open("people");
    const heading = () =>
      ui.doc.querySelector("#fac-people-heading").textContent;
    assert.equal(heading(), "Present now (1)");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A viewer joins a quiet board: nothing is edited or drawn.
    people = [...people, ticket(viewer, "c", "viewer")];
    ui.api.rosterChanged();
    assert.equal(heading(), "Present now (2)");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(b.workshop[participantKey(viewer.uuid)]?.session, "s1");
    // They leave again.
    people = people.slice(0, 1);
    ui.api.rosterChanged();
    assert.equal(heading(), "Present now (1)");
  } finally {
    ui.close();
  }
});

test("the contribution summary supports keyboard scrolling and retains focus on updates", () => {
  const b = newBoard("Keyboard summary");
  b.comments = [
    {
      id: "thread",
      x: 0,
      y: 0,
      resolved: false,
      messages: [
        {
          id: "message",
          authorId: owner.uuid,
          authorName: owner.username,
          text: "Summary sample",
          createdAt: 1000,
        },
      ],
    },
  ];
  const previousLanguage = language;
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    for (const lang of ["en", "fr"]) {
      setLanguage(lang);
      ui.api.open("summary");
      const scrolling = ui.doc.querySelector(".fac-table-wrap");
      assert.equal(scrolling.tabIndex, 0);
      assert.equal(scrolling.getAttribute("role"), "region");
      assert.equal(
        accessibleName(scrolling),
        t("Contributions per participant"),
      );
      scrolling.focus();
      assert.equal(ui.doc.activeElement, scrolling);
      Object.defineProperties(scrolling, {
        clientWidth: { value: 200 },
        scrollWidth: { value: 350 },
      });
      const key = (options) => {
        const event = new ui.doc.defaultView.KeyboardEvent("keydown", {
          ...options,
          bubbles: true,
          cancelable: true,
        });
        scrolling.dispatchEvent(event);
        return event;
      };
      for (let n = 0; n < 5; n++) {
        assert.equal(key({ key: "ArrowRight" }).defaultPrevented, true);
      }
      assert.equal(scrolling.scrollLeft, 150);
      for (let n = 0; n < 5; n++) key({ key: "ArrowLeft" });
      assert.equal(scrolling.scrollLeft, 0);
      for (const options of [
        { key: "Tab" },
        { key: "PageDown" },
        { key: "ArrowRight", ctrlKey: true },
        { key: "ArrowRight", altKey: true },
        { key: "ArrowRight", metaKey: true },
        { key: "ArrowRight", shiftKey: true },
        { key: "ArrowRight", isComposing: true },
      ]) {
        assert.equal(key(options).defaultPrevented, false);
        assert.equal(scrolling.scrollLeft, 0);
      }
      key({ key: "ArrowRight" });
      const previousScroll = scrolling.scrollLeft;
      b.comments = structuredClone(b.comments);
      b.comments[0].messages.push({
        ...b.comments[0].messages[0],
        id: `message-${lang}`,
      });
      ui.api.render();
      const refreshed = ui.doc.querySelector(".fac-table-wrap");
      assert.notEqual(refreshed, scrolling);
      assert.equal(ui.doc.activeElement, refreshed);
      assert.equal(refreshed.scrollLeft, previousScroll);
      ui.click('[data-fac="summary-csv"]');
      assert.equal(
        ui.calls.downloads.at(-1)[0],
        engagementCSV(engagement(b, { now: 10000 })),
      );
      assert.equal(ui.calls.downloads.at(-1)[1], "workshop-summary.csv");
    }
  } finally {
    setLanguage(previousLanguage);
    ui.close();
  }
});

test("composition Escape preserves a voting title draft and ordinary Escape closes facilitation", () => {
  const b = newBoard("Workshop");
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    const opener = ui.doc.querySelector('[data-action="facilitation"]');
    opener.focus();
    ui.api.open("vote");
    const field = ui.doc.querySelector("#fac-vote-title");
    field.focus();
    field.value = "候補を選択";
    for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = new ui.doc.defaultView.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
        ...flags,
      });
      field.dispatchEvent(event);
      assert.ok(ui.doc.querySelector("#facilitation-panel"));
      assert.equal(ui.doc.activeElement, field);
      assert.equal(field.value, "候補を選択");
      assert.equal(event.defaultPrevented, false);
      assert.equal(b.workshop, undefined);
    }
    field.dispatchEvent(
      new ui.doc.defaultView.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(ui.doc.querySelector("#facilitation-panel"), null);
    assert.equal(ui.doc.activeElement, opener);
    assert.equal(b.workshop, undefined);
  } finally {
    ui.close();
  }
});

test("anonymous cursors and editing indicators carry neither the name nor the account's color", () => {
  const b = {
    ...newBoard("Anonymous"),
    shared: { server: "s", room: "r" },
    workshop: { settings: { anonymous: true } },
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    const present = new Map([
      ["session-1", { user: owner.uuid, username: "alice", cursor: null }],
    ]);
    const [[session, person]] = [...ui.api.people(present)];
    assert.equal(session, "session-1");
    assert.equal(person.username, "Participant");
    assert.notEqual(person.user, owner.uuid);
    b.workshop.settings.anonymous = false;
    assert.equal(ui.api.people(present), present);
  } finally {
    ui.close();
  }
});

test("switching anonymous input redraws cursors in a new color, and anonymous notes keep no name on their editing tag", () => {
  const note = item("note", 100, 100, { id: "n1", text: "Idea" });
  const b = {
    ...newBoard("Anonymous"),
    shared: { server: "s", room: "r" },
    items: [note],
    workshop: {
      settings: { anonymous: false },
      [contributionKey("n1")]: { by: owner.uuid, at: 5000, anonymous: true },
    },
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  const layer = new PresenceLayer(ui.doc.querySelector(".canvas-wrap"));
  layer.layer.getBoundingClientRect = () => ({ width: 800, height: 600 });
  try {
    const alice = {
      user: owner.uuid,
      username: "alice",
      cursor: { x: 120, y: 80 },
      selection: [],
      editing: null,
    };
    const present = new Map([["session-1", alice]]);
    const draw = () =>
      layer.render(ui.api.people(present), [note], { x: 0, y: 0, z: 1 }, "me");
    const cursor = () => layer.layer.querySelector(".participant-cursor");
    draw();
    const named = cursor();
    assert.equal(named.textContent, "alice");
    // Turning anonymous input on replaces the cursor rather than renaming it.
    b.workshop.settings.anonymous = true;
    draw();
    const first = cursor();
    assert.equal(named.isConnected, false);
    assert.notEqual(first, named);
    assert.equal(first.textContent, "Participant");
    const firstUser = ui.api.people(present).get("session-1").user;
    // Each anonymous round gives the person a color drawn afresh.
    b.workshop.settings.anonymous = false;
    draw();
    assert.equal(first.isConnected, false);
    b.workshop.settings.anonymous = true;
    draw();
    assert.notEqual(ui.api.people(present).get("session-1").user, firstUser);
    // With anonymity off again, the author still typing in the note written
    // anonymously is shown on it as a participant, not by name.
    b.workshop.settings.anonymous = false;
    alice.selection = ["n1"];
    alice.editing = "n1";
    draw();
    const tag = layer.layer.querySelector(".participant-selection");
    assert.equal(tag.textContent, "Participant · Editing");
    assert.equal(cursor().textContent, "alice");
  } finally {
    layer.close();
    ui.close();
  }
});

test("the voting tab counts its minutes left down with the banner", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = 1_000_000;
  const b = {
    ...newBoard("Vote"),
    shared: { server: "s", room: "r" },
    items: [item("note", 0, 0, { id: "a", text: "A" })],
    workshop: {
      vote: {
        id: "v1",
        title: "Pick one",
        votes: 3,
        multiple: false,
        anonymous: true,
        hidden: false,
        targets: ["a"],
        state: "active",
        revealed: false,
        startedAt: clock,
        endsAt: clock + 10 * 60000,
      },
    },
  };
  const ui = stubUI(b, { role: "editor", me: viewer, now: () => clock });
  try {
    ui.api.render();
    ui.api.open("vote");
    const minutes = () =>
      ui.doc
        .querySelector("#fac-tabpanel")
        .textContent.match(/About \d+ minutes? left/)?.[0];
    assert.equal(minutes(), "About 10 minutes left");
    clock += 6 * 60000;
    t.mock.timers.tick(1000);
    assert.match(ui.banner(), /4:00/);
    assert.equal(minutes(), "About 4 minutes left");
  } finally {
    ui.close();
  }
});

// Built application harness, as in app.test.js.
const code = await appBundle();
async function setup(puter) {
  const dom = new JSDOM('<div id="app"></div><div id="toast"></div>', {
    url: "https://whiteboard.test",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.structuredClone = (value) => w.JSON.parse(w.JSON.stringify(value));
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  Object.defineProperty(w.crypto, "subtle", { value: crypto.subtle });
  w.indexedDB = new IDBFactory();
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.puter = puter;
  const downloads = [];
  w.URL.createObjectURL = (blob) => {
    downloads.push(blob);
    return "blob:test";
  };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  w.HTMLCanvasElement.prototype.setPointerCapture = () => {};
  w.HTMLCanvasElement.prototype.getContext = function () {
    if (
      !this._native ||
      this._native.width !== this.width ||
      this._native.height !== this.height
    )
      this._native = createCanvas(this.width, this.height);
    return this._native.getContext("2d");
  };
  w.HTMLCanvasElement.prototype.toDataURL = function () {
    return this._native.toDataURL("image/png");
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event("close"));
  };
  await w.eval(`(async()=>{${code}\n})()`);
  const tick = () => new Promise((r) => setTimeout(r, 25));
  const doc = w.document;
  const click = async (selector) => {
    const el = doc.querySelector(selector);
    assert.ok(el, selector);
    el.click();
    await tick();
  };
  const until = async (fn, message, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (!fn() && Date.now() < deadline) await tick();
    assert.ok(fn(), message);
  };
  const read = (blob) =>
    new Promise((resolve) => {
      const r = new w.FileReader();
      r.onload = () => resolve(r.result);
      r.readAsText(blob);
    });
  const key = (key, extra = {}) =>
    doc.querySelector("#canvas").dispatchEvent(
      new w.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...extra,
      }),
    );
  const sizeCanvas = () =>
    (doc.querySelector("#canvas").getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 1600,
      height: 900,
    }));
  async function addNote(text) {
    key("n");
    await tick();
    const input = doc.querySelector("#canvas-text-editor");
    assert.ok(input, "Note editor opened");
    input.value = text;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    input.dispatchEvent(
      new w.KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    await tick();
  }
  async function audit(selector) {
    if (!w.axe) w.eval(axe.source);
    const result = await w.axe.run(doc.querySelector(selector), {
      rules: { "color-contrast": { enabled: false } },
    });
    assert.equal(
      result.violations.length,
      0,
      `${selector}: ${result.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.html).join(" ")}`).join(", ")}`,
    );
  }
  const outline = () =>
    [...doc.querySelectorAll("#board-outline button")].map(
      (b) => b.textContent,
    );
  return {
    w,
    doc,
    click,
    tick,
    until,
    read,
    key,
    sizeCanvas,
    addNote,
    audit,
    outline,
    downloads,
    close: () => w.close(),
  };
}

test("built app: a facilitator runs dot votes, polls, reactions, history, and exports on a personal board", async () => {
  const app = await setup();
  const { doc, w, click, until } = app;
  try {
    await click('[data-action="new"]');
    await until(() => doc.querySelector("#canvas"), "Board opened");
    app.sizeCanvas();
    for (const text of ["Ship faster", "=SUM(1)", "Better docs"])
      await app.addNote(text);
    await until(() => app.outline().length === 3, "Three notes");
    const ids = [...doc.querySelectorAll("#board-outline button")].map(
      (b) => b.dataset.id,
    );
    // An unlocked selection offers hiding from its toolbar, then showing.
    await until(
      () => doc.querySelector('#selection-tools [data-action="hide-objects"]'),
      "Hide from participants is on the toolbar of an unlocked note",
    );
    await click('#selection-tools [data-action="hide-objects"]');
    await until(
      () => doc.querySelector('#selection-tools [data-action="show-objects"]'),
      "A hidden note offers Show to participants",
    );
    await click('#selection-tools [data-action="show-objects"]');
    await until(
      () => doc.querySelector('#selection-tools [data-action="hide-objects"]'),
      "Showing the note again restores the Hide button",
    );
    await click('.canvas-navigation [data-action="facilitation"]');
    const panel = doc.querySelector("#facilitation-panel");
    assert.ok(panel, "The console opens from the canvas navigation");
    assert.equal(doc.activeElement.id, "facilitation-heading");
    assert.equal(
      doc
        .querySelector('.canvas-navigation [data-action="facilitation"]')
        .getAttribute("aria-expanded"),
      "true",
    );
    await app.audit("#facilitation-panel");
    // Arrow keys move between tabs.
    doc.querySelector("#fac-tab-session").focus();
    doc
      .querySelector("#fac-tab-session")
      .dispatchEvent(
        new w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    await app.tick();
    assert.equal(doc.activeElement.id, "fac-tab-vote");
    assert.ok(doc.querySelector("#fac-vote-form"));
    await app.audit("#facilitation-panel");
    doc.querySelector("#fac-vote-title").value = "Next quarter";
    doc
      .querySelector("#fac-vote-form")
      .dispatchEvent(new w.Event("submit", { cancelable: true }));
    await app.tick();
    await until(
      () =>
        /3 votes left/.test(doc.querySelector("#workshop-banner").textContent),
      "The banner shows remaining votes",
    );
    const add = (id) =>
      doc.querySelector(`[data-fac-vote="add"][data-id="${id}"]`);
    assert.ok(add(ids[0]), "Votable objects show a vote button on the canvas");
    add(ids[0]).focus();
    add(ids[0]).click();
    await app.tick();
    assert.equal(doc.activeElement, add(ids[0]), "Focus stays on the vote");
    assert.equal(
      add(ids[0]).getAttribute("aria-disabled"),
      "true",
      "One vote per object by default",
    );
    // An unavailable vote button stays focusable but does nothing.
    const before = doc.querySelector("#workshop-banner").textContent;
    add(ids[0]).click();
    await app.tick();
    assert.equal(doc.querySelector("#workshop-banner").textContent, before);
    add(ids[2]).click();
    await app.tick();
    assert.match(doc.querySelector("#fac-remaining").textContent, /1 of 3/);
    doc.querySelector(`[data-fac-vote="remove"][data-id="${ids[2]}"]`).click();
    await app.tick();
    await click(`[data-fac="vote-add"][data-id="${ids[1]}"]`);
    assert.match(doc.querySelector("#fac-remaining").textContent, /1 of 3/);
    assert.equal(
      doc.querySelector(".fac-vote-count"),
      null,
      "Counts stay hidden while voting",
    );
    await app.audit("#facilitation-panel");
    await click('[data-fac="vote-end"]');
    await click('[data-fac="vote-reveal"]');
    await until(
      () => doc.querySelector(`[data-fac-item="${ids[0]}"] .fac-vote-count`),
      "Revealed counts appear on objects",
    );
    const rows = [...doc.querySelectorAll(".fac-results li")].map(
      (li) => li.textContent,
    );
    assert.equal(rows.length, 3);
    assert.match(rows[0], /Ship faster.*1 vote\b/);
    doc.querySelector("#fac-top").value = "1";
    await click('[data-fac="vote-top"]');
    // The first two objects have a vote each, tied for first place.
    assert.deepEqual(
      [...doc.querySelectorAll('#board-outline [aria-pressed="true"]')].map(
        (b) => b.dataset.id,
      ),
      [ids[0], ids[1]],
      "Select top N selects the leading objects, with any tied",
    );
    await click('.canvas-navigation [data-action="facilitation"]');
    await click('.canvas-navigation [data-action="facilitation"]');
    await click("#fac-tab-vote");
    await click('[data-fac="vote-csv"]');
    const csv = await app.read(app.downloads.at(-1));
    assert.match(csv, /Next quarter/);
    assert.match(csv, /'=SUM\(1\)/);
    await click('[data-fac="vote-json"]');
    assert.equal(
      JSON.parse(await app.read(app.downloads.at(-1))).title,
      "Next quarter",
    );
    await click("#fac-tab-history");
    assert.equal(
      doc.querySelectorAll(".fac-history > li").length,
      1,
      "Completed votes stay in the history",
    );
    await app.audit("#facilitation-panel");
    // Polls.
    await click("#fac-tab-poll");
    doc.querySelector("#fac-poll-question").value = "Keep the retro format?";
    doc.querySelector("#fac-poll-options").value = "Yes\nNo\n";
    doc
      .querySelector("#fac-poll-form")
      .dispatchEvent(new w.Event("submit", { cancelable: true }));
    await app.tick();
    doc.querySelector('[name="fac-poll-answer"]').checked = true;
    doc
      .querySelector("#fac-answer-form")
      .dispatchEvent(new w.Event("submit", { cancelable: true }));
    await app.tick();
    assert.match(
      doc.querySelector(".fac-results li").textContent,
      /Yes.*1 response\b.*100%/,
    );
    await app.audit("#facilitation-panel");
    await click('[data-fac="poll-close"]');
    await click("#fac-tab-history");
    assert.equal(doc.querySelectorAll(".fac-history > li").length, 2);
    // Summary.
    await click("#fac-tab-summary");
    assert.ok(doc.querySelector(".fac-totals"));
    await app.audit("#facilitation-panel");
    await click('[data-fac="summary-csv"]');
    assert.match(await app.read(app.downloads.at(-1)), /Workshop summary/);
    // Session controls, including private mode on a personal board.
    await click("#fac-tab-session");
    await click('[data-fac="private-on"]');
    await until(
      () =>
        /Private mode/.test(doc.querySelector("#workshop-banner").textContent),
      "Private mode banner",
    );
    await app.audit("#facilitation-panel");
    doc
      .querySelector("#facilitation-panel")
      .dispatchEvent(
        new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    await app.tick();
    assert.equal(doc.querySelector("#facilitation-panel"), null);
    assert.equal(
      doc.activeElement.dataset.action,
      "facilitation",
      "Focus returns to the entry point",
    );
    await app.addNote("My own private idea");
    assert.ok(
      app.outline().some((t) => t.includes("My own private idea")),
      "Authors see their own private notes",
    );
    // Reactions on objects.
    await click(`#board-outline [data-id="${ids[0]}"]`);
    await click(`[data-fac-item="${ids[0]}"] [data-fac-picker]`);
    assert.ok(doc.querySelector(".fac-picker"));
    await app.audit(".fac-picker");
    assert.equal(doc.activeElement.dataset.facChoose, "thumbs");
    doc.activeElement.dispatchEvent(
      new w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    assert.equal(doc.activeElement.dataset.facChoose, "heart");
    await click('[data-fac-choose="thumbs"]');
    const chip = () =>
      doc.querySelector(
        `[data-fac-item="${ids[0]}"] [data-fac-react="thumbs"]`,
      );
    await until(() => chip(), "The reaction appears on the object");
    assert.equal(chip().getAttribute("aria-pressed"), "true");
    assert.match(chip().textContent, /1/);
    assert.match(chip().getAttribute("aria-label"), /Thumbs up: 1 \(You\)/);
    chip().click();
    await until(() => !chip(), "Toggling removes your reaction");
    // Reactions on comment messages.
    await click('[data-action="add-comment"]');
    doc.querySelector("#comment-text").value = "Worth discussing";
    await click('#comment-form [type="submit"]');
    await click("#comments-panel [data-fac-picker]");
    await click('[data-fac-choose="idea"]');
    await until(
      () =>
        doc.querySelector(
          '#comments-panel [data-fac-react="idea"][aria-pressed="true"]',
        ),
      "Comment messages show reactions",
    );
    await app.audit("#comments-panel");
    await click("#comments-close");
    // The command palette and More tools reach the console too.
    await click('[data-action="more-tools"]');
    await click('[data-feature="facilitation"]');
    assert.ok(doc.querySelector("#facilitation-panel"));
    // Whiteboard files keep results and reactions, not the live session.
    const downloaded = app.downloads.length;
    await click('[data-action="export"]');
    doc.querySelector("#export-format").value = "json";
    doc
      .querySelector("dialog form")
      .dispatchEvent(new w.Event("submit", { cancelable: true }));
    await until(() => app.downloads.length > downloaded, "Board exported");
    await app.tick();
    const exported = JSON.parse(await app.read(app.downloads.at(-1)));
    const keys = Object.keys(exported.workshop);
    assert.equal(keys.filter((k) => k.startsWith("h:")).length, 2);
    assert.ok(keys.some((k) => k.startsWith("r:")));
    assert.equal(exported.workshop.vote, undefined);
    assert.equal(exported.workshop.settings, undefined);
    validateBoard(exported);
    // French.
    doc.querySelector("dialog")?.close();
    const language = doc.querySelector("#language");
    language.value = "fr";
    language.dispatchEvent(new w.Event("change", { bubbles: true }));
    await app.tick();
    await click('.canvas-navigation [data-action="facilitation"]');
    await until(
      () => doc.querySelector("#facilitation-heading"),
      "Console reopened",
    );
    assert.equal(
      doc.querySelector("#facilitation-heading").textContent,
      "Animation",
    );
    assert.equal(doc.querySelector("#fac-tab-poll").textContent, "Sondage");
    await app.audit("#facilitation-panel");
  } finally {
    app.close();
  }
});

test("built collaborators: private mode, a commenter's vote and reaction, and board locks sync through the worker", async () => {
  const env = environment();
  env.service.now = () => Date.now();
  const initial = {
    version: 1,
    id: crypto.randomUUID(),
    title: "Retrospective",
    items: [item("note", 100, 100, { text: "Owner idea" })],
  };
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invites = await Promise.all(
    ["editor", "commenter"].map((role) =>
      env.service.call(owner, { op: "invite", room: initial.id, role }),
    ),
  );
  const a = await setup(env.sdk(owner)),
    b = await setup(env.sdk(editor)),
    c = await setup(env.sdk(viewer)),
    apps = [a, b, c];
  try {
    for (const [index, app] of apps.entries()) {
      await app.click('[data-action="join-shared"]');
      app.doc.querySelector("#join-link").value =
        `https://whiteboard.test/#server=https%3A%2F%2Fwhiteboard-test.puter.work&board=${initial.id}&invite=${index ? invites[index - 1].token : ""}`;
      app.doc
        .querySelector("#join-link")
        .closest("form")
        .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
      await app.until(
        () =>
          !app.doc.querySelector("#join-link") &&
          app.doc.querySelector("#canvas"),
        "Joined",
      );
      app.sizeCanvas();
    }
    await a.until(() => a.outline().length === 1, "Owner sees the board");
    await a.click('.canvas-navigation [data-action="facilitation"]');
    await a.click('[data-fac="private-on"]');
    await b.until(
      () =>
        /Private mode/.test(
          b.doc.querySelector("#workshop-banner").textContent,
        ),
      "Private mode reaches the editor",
    );
    await b.addNote("Bob secret");
    await b.until(
      () => b.outline().some((t) => t.includes("Bob secret")),
      "The author sees the note",
    );
    await a.until(() => a.outline().length === 2, "The note reaches the owner");
    await c.until(
      () => c.outline().length === 2,
      "The note reaches the commenter",
    );
    for (const app of [a, c]) {
      assert.ok(
        !app.outline().some((t) => t.includes("Bob secret")),
        "Others see a placeholder",
      );
      assert.ok(app.outline().some((t) => t.includes("Private note")));
      assert.ok(
        app.doc.querySelector(".fac-private"),
        "A face-down marker is shown",
      );
    }
    // Lists of the board's objects keep the note face down too.
    await a.click('.canvas-navigation [data-action="objects"]');
    const listed = [...a.doc.querySelectorAll("dialog [data-object]")].map(
      (x) => x.textContent,
    );
    assert.ok(
      listed.some((x) => x.includes("Private note")),
      listed.join(),
    );
    assert.ok(!listed.some((x) => x.includes("Bob secret")));
    a.doc.querySelector("dialog").close();
    await a.tick();
    const ownerIdea = [...a.doc.querySelectorAll("#board-outline button")].find(
      (x) => x.textContent.includes("Owner idea"),
    ).dataset.id;
    await a.click(`#board-outline [data-id="${ownerIdea}"]`);
    await a.click("#object-link-access");
    const targets = [
      ...a.doc.querySelectorAll("#object-link-targets [data-link-target]"),
    ].map((x) => x.textContent);
    assert.ok(
      !targets.some((x) => /Bob secret|Private note/.test(x)),
      targets.join(),
    );
    await a.click("#object-link-close");
    await a.click('[data-fac="private-reveal"]');
    await c.until(
      () => c.outline().some((t) => t.includes("Bob secret")),
      "Revealing shows everyone's notes",
    );
    // The commenter votes and reacts; the facilitator sees the results.
    await a.click("#fac-tab-vote");
    a.doc.querySelector("#fac-vote-hidden").checked = false;
    a.doc
      .querySelector("#fac-vote-form")
      .dispatchEvent(new a.w.Event("submit", { cancelable: true }));
    await c.until(
      () => c.doc.querySelector('[data-fac-vote="add"]'),
      "The commenter can vote on the canvas",
    );
    c.doc.querySelector('[data-fac-vote="add"]').click();
    await a.until(
      () =>
        /1 participant has voted/.test(
          a.doc.querySelector("#fac-tabpanel").textContent,
        ),
      "The ballot reaches the facilitator",
    );
    const noteId = c.doc.querySelector("#board-outline button").dataset.id;
    await c.click(`#board-outline [data-id="${noteId}"]`);
    await c.click(`[data-fac-item="${noteId}"] [data-fac-picker]`);
    await c.click('[data-fac-choose="celebrate"]');
    await a.until(
      () =>
        a.doc.querySelector(
          `[data-fac-item="${noteId}"] [data-fac-react="celebrate"]`,
        ),
      "The reaction reaches the facilitator",
    );
    assert.match(
      a.doc
        .querySelector(
          `[data-fac-item="${noteId}"] [data-fac-react="celebrate"]`,
        )
        .getAttribute("aria-label"),
      /Cam/,
      "Named reactions show who reacted",
    );
    // A locked board stops editors from changing the facilitator's note.
    await a.click("#fac-tab-session");
    const contribute = a.doc.querySelector(
      '[name="fac-lock"][value="contribute"]',
    );
    contribute.checked = true;
    contribute.dispatchEvent(new a.w.Event("change", { bubbles: true }));
    await b.until(
      () =>
        /Board locked/.test(
          b.doc.querySelector("#workshop-banner").textContent,
        ),
      "The lock reaches the editor",
    );
    const ownerNote = [...b.doc.querySelectorAll("#board-outline button")].find(
      (x) => x.textContent.includes("Owner idea"),
    ).dataset.id;
    await b.click(`#board-outline [data-id="${ownerNote}"]`);
    b.key("Delete");
    await b.tick();
    assert.ok(
      b.outline().some((t) => t.includes("Owner idea")),
      "Locked content cannot be deleted",
    );
    assert.match(b.doc.querySelector("#toast").textContent, /Unlock|locked/i);
    await b.addNote("Still contributing");
    await a.until(
      () => a.outline().some((t) => t.includes("Still contributing")),
      "Participants can still add notes",
    );
    // A refused change is undone on screen too.
    const title = b.doc.querySelector("#board-title");
    title.value = "Renamed by an editor";
    title.dispatchEvent(new b.w.Event("change", { bubbles: true }));
    await b.tick();
    assert.equal(title.value, "Retrospective");
    assert.match(b.doc.title, /^Retrospective/);
    // The timer is the facilitator's while the board is locked.
    for (const app of [a, b]) await app.click('[data-action="timer"]');
    assert.equal(b.doc.querySelector("#timer-start").disabled, true);
    assert.equal(a.doc.querySelector("#timer-start").disabled, false);
    for (const app of apps) await app.click('[data-action="home"]');
    await Promise.all(
      apps.map((app) =>
        app.until(() => app.doc.querySelector(".library"), "Left the board"),
      ),
    );
  } finally {
    for (const app of apps) app.close();
  }
});

test("facilitators can hide individual objects and frame contents from participants", async () => {
  const { concealment, validateWorkshop, workshopEvents } =
    await import("../src/facilitation/model.js");
  const { board, item } = await import("../src/model.js");
  const frame = item("frame", 0, 0, { w: 300, h: 300, text: "Answers" });
  const inside = item("note", 10, 60, { text: "Answer", parentId: frame.id });
  const loose = item("note", 400, 0, { text: "Hint" });
  const shown = item("note", 400, 400, { text: "Shown" });
  // A line to a hidden object is hidden with it; a free one is not.
  const line = item("arrow", 0, 0, { startId: shown.id, endId: inside.id }),
    kept = item("arrow", 0, 0, { w: 100, h: 0 });
  const b = {
    ...board("Hide"),
    items: [frame, inside, loose, shown, line, kept],
  };
  b.workshop = { settings: { hide: [frame.id, loose.id] } };
  const participant = concealment(b, "someone", false);
  assert.deepEqual(
    [...participant.hidden].sort(),
    [frame.id, inside.id, loose.id, line.id].sort(),
  );
  assert.equal(concealment(b, "facilitator", true).hidden.size, 0);
  assert.deepEqual(workshopEvents({}, b.workshop)[0], {
    action: "workshop.hidden",
    details: { objects: 2 },
  });
  validateWorkshop(b.workshop);
  assert.throws(() =>
    validateWorkshop({ settings: { hide: [frame.id, frame.id] } }),
  );
});

test("a locked object lying in a hidden or staged frame is hidden with it", async () => {
  const { concealment } = await import("../src/facilitation/model.js");
  const { board, item } = await import("../src/model.js");
  const outer = item("frame", 0, 0, { w: 1000, h: 600, text: "Round 1" }),
    inner = item("frame", 50, 50, { w: 300, h: 300, text: "Answers" });
  // Locked objects never join frames; this one lies in the inner frame.
  const key = item("note", 100, 100, { text: "Answer key", locked: true }),
    outside = item("note", 2000, 0, { text: "Agenda", locked: true });
  const b = { ...board("Locked"), items: [outer, inner, key, outside] };
  b.workshop = { settings: { hide: [inner.id] } };
  assert.deepEqual(
    [...concealment(b, "someone", false).hidden].sort(),
    [inner.id, key.id].sort(),
  );
  assert.equal(concealment(b, "facilitator", true).hidden.size, 0);
  b.workshop = {
    settings: { stage: { frames: [outer.id, inner.id], shown: 0 } },
  };
  assert.ok(concealment(b, "someone", false).hidden.has(key.id));
  // Once the inner frame is shown, its locked note is too, even inside the
  // larger frame staged later.
  b.workshop = {
    settings: { stage: { frames: [inner.id, outer.id], shown: 1 } },
  };
  const staged = concealment(b, "someone", false);
  assert.equal(staged.hidden.has(key.id), false);
  assert.equal(staged.hidden.has(outside.id), false);
});

test("starting a new vote right after a timed vote's deadline keeps its result", () => {
  const b = { ...newBoard("Workshop"), items: notes(), shared: { room: "r" } };
  // The stub's clock reads 10000: the deadline has passed, but the vote is
  // still active while late ballots arrive.
  b.workshop = {
    vote: vote({ endsAt: 9000, hidden: false }),
    ...Object.fromEntries([ballot(owner, ["a", "b"]), ballot(editor, ["a"])]),
  };
  const host = stubUI(b, { role: "owner", me: owner });
  try {
    host.api.open("vote");
    assert.equal(host.doc.querySelector('[data-fac="vote-end"]'), null);
    host.click('[data-fac="vote-clear"]');
    assert.equal(b.workshop.vote, undefined);
    const record = b.workshop[historyKey("vote1")];
    assert.ok(record, "The result is in the history");
    assert.equal(record.results.find((r) => r.id === "a").count, 2);
    assert.equal(record.results.find((r) => r.id === "b").count, 1);
    assert.equal(
      Object.keys(b.workshop).some((k) => k.startsWith("v:")),
      false,
      "Ballots are cleared",
    );
  } finally {
    host.close();
  }
});

test("hidden vote results stay hidden in the history until revealed", () => {
  const b = { ...newBoard("Workshop"), items: notes(), shared: { room: "r" } };
  const vote = {
    id: "vote1",
    title: "Secret vote",
    votes: 2,
    multiple: false,
    anonymous: false,
    hidden: true,
    targets: ["a", "b"],
    state: "ended",
    revealed: false,
    startedAt: 1000,
    endsAt: 0,
    endedAt: 5000,
  };
  b.workshop = {
    vote,
    [voteKey("vote1", owner.uuid)]: {
      vote: "vote1",
      by: owner.uuid,
      ids: ["a"],
      at: 2000,
      name: "Alice",
    },
  };
  const record = resultRecord(b, "vote", (id) => id, 5000);
  assert.equal(record.hidden, true);
  b.workshop[historyKey("vote1")] = record;
  validateBoard(b);
  const participant = stubUI(b, { role: "editor", me: editor });
  try {
    participant.api.open("history");
    const panel = participant.doc.querySelector("#fac-tabpanel");
    assert.match(panel.textContent, /Results are hidden/);
    assert.equal(panel.querySelector('[data-fac="history-csv"]'), null);
    assert.doesNotMatch(panel.textContent, /Alice/);
  } finally {
    participant.close();
  }
  const facilitator = stubUI(b, { role: "owner", me: owner });
  try {
    facilitator.api.open("vote");
    facilitator.click('[data-fac="vote-reveal"]');
    assert.equal(b.workshop[historyKey("vote1")].hidden, false);
  } finally {
    facilitator.close();
  }
});

test("a timed vote ends at its deadline without another redraw", async () => {
  const dom = new JSDOM(
    '<div class="canvas-wrap"><canvas id="canvas"></canvas><div class="canvas-navigation"></div></div>',
  );
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  const doc = dom.window.document;
  doc.querySelector("#canvas").getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1600,
    height: 900,
  });
  let clock = 10000;
  const b = { ...newBoard("Workshop"), items: notes() };
  b.workshop = {
    vote: {
      id: "v1",
      title: "Timed",
      votes: 1,
      multiple: false,
      anonymous: true,
      hidden: false,
      targets: ["a"],
      state: "active",
      revealed: false,
      startedAt: 1000,
      endsAt: 10500,
    },
  };
  const api = createFacilitationUI({
    board: () => b,
    identity: () => ({ id: owner.uuid, name: "Alice" }),
    role: () => "owner",
    canParticipate: () => true,
    canEdit: () => true,
    now: () => clock,
    view: () => ({ x: 0, y: 0, z: 1 }),
    canvas: () => doc.querySelector("#canvas"),
    hidden: () => new Map(),
    selection: () => new Set(),
    select() {},
    commit(workshop) {
      b.workshop = workshop;
    },
    setTimer() {},
    focusFrame() {},
    bring() {},
    follow() {},
    session: () => null,
    roster: () => [],
    icon: () => "",
    toast() {},
    download() {},
  });
  try {
    api.bind(doc.querySelector(".canvas-wrap"));
    api.open("vote");
    api.render();
    // Closed at the deadline, and recorded once late ballots can arrive.
    clock = 10500 + VOTE_GRACE;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(b.workshop.vote.state, "ended");
    assert.match(doc.querySelector("#fac-tabpanel").textContent, /ended/);
    // It ended at its deadline, not when it was saved.
    assert.equal(b.workshop.vote.endedAt, 10500);
    assert.equal(b.workshop[historyKey("v1")].endedAt, 10500);
  } finally {
    api.detach();
    dom.window.close();
    globalThis.document = previous;
  }
});

test("counts of one read as one vote, participant, or response in English and French", async () => {
  const { setLanguage } = await import("../src/i18n.js");
  const b = { ...newBoard("Workshop"), items: notes() };
  b.workshop = Object.fromEntries([
    ["vote", vote({ votes: 2, hidden: false, revealed: true })],
    ballot(editor, ["a"]),
  ]);
  const ui = stubUI(b, { role: "editor", me: editor });
  const text = (selector) => ui.doc.querySelector(selector).textContent;
  try {
    ui.api.render();
    ui.api.open("vote");
    assert.match(text("#fac-tabpanel"), /1 participant has voted\./);
    assert.match(text("#fac-tabpanel"), /1 vote · 100%.*0 votes · 0%/);
    assert.match(ui.banner(), /1 vote left/);
    assert.equal(
      ui.doc
        .querySelector(`[data-fac-item="a"] .fac-vote-count`)
        .getAttribute("aria-label"),
      "1 vote",
    );
    setLanguage("fr");
    ui.api.render();
    ui.api.open("vote");
    // French uses the singular for zero too.
    assert.match(text("#fac-tabpanel"), /1 participant a voté\./);
    assert.match(text("#fac-tabpanel"), /1 vote · 100%.*0 vote · 0%/);
    assert.match(ui.banner(), /1 vote restant/);
  } finally {
    setLanguage("en");
    ui.close();
  }
});

test("participants see a timed vote's results at its deadline without a facilitator", () => {
  for (const hidden of [false, true]) {
    const b = { ...newBoard("Workshop"), shared: { server: "x", room: "r" } };
    b.items = notes();
    b.workshop = Object.fromEntries([
      ["vote", vote({ hidden, anonymous: true, endsAt: 5000 })],
      ballot(editor, ["a"], "vote1", false),
    ]);
    // Only a participant is online after the deadline, so nobody ends it.
    const ui = stubUI(b, { role: "editor", me: editor });
    try {
      ui.api.render();
      ui.api.open("vote");
      const panel = ui.doc.querySelector("#fac-tabpanel").textContent;
      assert.match(panel, /Voting has ended/);
      assert.equal(/1 vote · 100%/.test(panel), !hidden, `hidden: ${hidden}`);
      assert.equal(
        ui.doc.querySelectorAll(".fac-vote-count").length,
        hidden ? 0 : 3,
      );
      assert.equal(b.workshop.vote.state, "active");
    } finally {
      ui.close();
    }
  }
});

test("saved results name an object once the facilitator reveals it", () => {
  const b = { ...newBoard("Workshop"), shared: { server: "x", room: "r" } };
  b.items = [
    item("frame", 0, 0, { id: "F", w: 1000, h: 800, text: "Round 2" }),
    item("note", 100, 100, { id: "a", parentId: "F", text: "Secret idea" }),
  ];
  b.workshop = {
    settings: { stage: { frames: ["F"], shown: 0 } },
    [historyKey("v1")]: {
      kind: "vote",
      id: "v1",
      title: "Prior",
      startedAt: 1,
      endedAt: 2,
      anonymous: true,
      participants: 1,
      results: [{ id: "a", label: "Secret idea", count: 3 }],
    },
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    ui.openHistory();
    const text = () => ui.doc.querySelector("#fac-tabpanel").textContent;
    assert.match(text(), /Hidden by the facilitator/);
    assert.doesNotMatch(text(), /Secret idea/);
    b.workshop = { ...b.workshop, settings: {} };
    ui.api.render();
    assert.match(text(), /Secret idea/);
    assert.doesNotMatch(text(), /Hidden by the facilitator/);
  } finally {
    ui.close();
  }
});

test("a vote saves no text hidden from participants, so deleting the object later reveals nothing", () => {
  const b = { ...newBoard("Workshop"), shared: { server: "x", room: "r" } };
  b.items = [
    item("note", 0, 0, { id: "a", text: "Visible idea" }),
    item("note", 250, 0, { id: "b", text: "Hidden secret" }),
    item("frame", 0, 400, { id: "F", w: 600, h: 400, text: "Later" }),
    item("note", 50, 450, { id: "c", parentId: "F", text: "Staged secret" }),
  ];
  b.workshop = {
    settings: {
      lock: "open",
      hide: ["b"],
      stage: { frames: ["F"], shown: 0 },
    },
    vote: vote({ targets: ["a", "b", "c"], hidden: false }),
    ...Object.fromEntries([ballot(owner, ["a", "b"]), ballot(editor, ["c"])]),
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("vote");
    ui.click('[data-fac="vote-end"]');
    const saved = b.workshop[historyKey("vote1")];
    assert.ok(!JSON.stringify(saved).includes("secret"));
    assert.equal(saved.results.find((r) => r.id === "a").label, "Visible idea");
    // The facilitator still reads the names while the objects exist.
    ui.openHistory();
    assert.match(
      ui.doc.querySelector("#fac-tabpanel").textContent,
      /Hidden secret/,
    );
  } finally {
    ui.close();
  }
  // The facilitator deletes both before revealing them.
  b.items = b.items.filter((i) => i.id === "a");
  const participant = stubUI(b, { role: "editor", me: editor });
  try {
    participant.openHistory();
    const text = participant.doc.querySelector("#fac-tabpanel").textContent;
    assert.match(text, /Visible idea/);
    assert.doesNotMatch(text, /secret/);
  } finally {
    participant.close();
  }
});

test("a vote ended in private mode saves no private note's text", () => {
  const b = { ...newBoard("Workshop"), shared: { server: "x", room: "r" } };
  b.items = [
    item("note", 0, 0, { id: "a", text: "Alice secret" }),
    item("note", 250, 0, { id: "b", text: "Other" }),
  ];
  b.workshop = {
    settings: { lock: "open", private: "r1", anonymous: false },
    [contributionKey("a")]: { by: owner.uuid, at: 1000, round: "r1" },
    vote: vote({ targets: ["a", "b"], hidden: false }),
    ...Object.fromEntries([ballot(owner, ["a"]), ballot(editor, ["b"])]),
  };
  const history = (who, role) => {
    const ui = stubUI(b, { role, me: who });
    try {
      ui.openHistory();
      ui.click('[data-fac="history-csv"]');
      return [
        ui.doc.querySelector("#fac-tabpanel").textContent,
        ui.calls.downloads[0][0],
      ];
    } finally {
      ui.close();
    }
  };
  // The owner, who wrote the note, ends the vote while notes are private.
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("vote");
    ui.click('[data-fac="vote-end"]');
  } finally {
    ui.close();
  }
  const saved = b.workshop[historyKey("vote1")];
  assert.ok(!JSON.stringify(saved).includes("Alice secret"));
  assert.deepEqual(
    saved.results.map((r) => r.label),
    ["", "Other"],
  );
  assert.match(history(owner, "owner")[0], /Alice secret/);
  for (const [who, role] of [
    [editor, "facilitator"],
    [guest, "editor"],
  ])
    for (const text of history(who, role)) {
      assert.doesNotMatch(text, /Alice secret/);
      assert.match(text, /Private note/);
    }
  // Once the notes are revealed, everyone sees what the note says.
  b.workshop = { ...b.workshop, settings: { lock: "open", private: null } };
  assert.match(history(editor, "facilitator")[0], /Alice secret/);
});

test("facilitators reveal hidden results from History after starting a new vote", () => {
  const b = { ...newBoard("Workshop"), shared: { server: "x", room: "r" } };
  b.items = notes();
  b.workshop = Object.fromEntries([
    ["vote", vote({ anonymous: true })],
    ballot(editor, ["a"], "vote1", false),
  ]);
  const ui = stubUI(b, { role: "owner", me: owner });
  const participant = () => {
    const other = stubUI(b, { role: "editor", me: editor });
    try {
      other.openHistory();
      return other.doc.querySelector("#fac-tabpanel").textContent;
    } finally {
      other.close();
    }
  };
  try {
    ui.api.open("vote");
    ui.click('[data-fac="vote-end"]');
    // While the vote is still in its tab, History reveals it there too.
    ui.api.open("history");
    assert.match(
      ui.doc.querySelector("#fac-tabpanel").textContent,
      /Only facilitators can see these results/,
    );
    ui.click('[data-fac="history-reveal"]');
    assert.equal(b.workshop.vote.revealed, true);
    assert.equal(b.workshop[historyKey("vote1")].hidden, false);
    ui.api.open("vote");
    ui.click('[data-fac="vote-hide"]');
    assert.equal(b.workshop[historyKey("vote1")].hidden, true);
    // After "New vote", the saved result can still be revealed.
    ui.click('[data-fac="vote-clear"]');
    assert.equal(b.workshop.vote, undefined);
    assert.match(participant(), /Results are hidden/);
    ui.api.open("history");
    ui.click('[data-fac="history-reveal"]');
    assert.equal(b.workshop[historyKey("vote1")].hidden, false);
    assert.equal(ui.doc.querySelector('[data-fac="history-reveal"]'), null);
    assert.doesNotMatch(participant(), /Results are hidden/);
    assert.match(participant(), /1 vote\b/);
  } finally {
    ui.close();
  }
});

test("saved vote results keep only voted objects and open their rows on demand", () => {
  const b = { ...newBoard("Big workshop") };
  b.items = Array.from({ length: 3000 }, (_, n) =>
    item("note", (n % 60) * 220, Math.floor(n / 60) * 220, {
      id: `n${n}`,
      text: `Idea ${n}`,
    }),
  );
  const big = vote({
    state: "ended",
    endedAt: 5000,
    hidden: false,
    targets: b.items.map((i) => i.id),
  });
  b.workshop = Object.fromEntries([
    ["vote", big],
    ballot(owner, ["n1", "n2"]),
    ballot(editor, ["n1"]),
  ]);
  const record = resultRecord(b, "vote", (id) => id, 5000);
  assert.deepEqual(
    record.results.map((r) => [r.id, r.count]),
    [
      ["n1", 2],
      ["n2", 1],
    ],
    "objects nobody voted for are not saved",
  );
  assert.equal(record.targets, 3000);
  assert.ok(JSON.stringify(record).length < 1000);
  assert.match(resultsCSV(record), /Objects in the vote,3000/);
  assert.equal(JSON.parse(resultsJSON(record)).targets, 3000);
  validateWorkshop({ [historyKey(record.id)]: record });
  assert.throws(() =>
    validateWorkshop({
      [historyKey(record.id)]: { ...record, targets: -1 },
    }),
  );
  // Results saved before keep their rows with no votes and still load.
  const old = {
    ...resultRecord(
      {
        ...b,
        workshop: { vote: { ...big, id: "old", targets: ["n0", "n1"] } },
      },
      "vote",
      (id) => id,
      4000,
    ),
    results: [
      { id: "n0", label: "Zero", count: 0 },
      { id: "n1", label: "One", count: 1 },
    ],
  };
  delete old.targets;
  validateWorkshop({ [historyKey("old")]: old });
  b.workshop = {
    [historyKey(record.id)]: record,
    [historyKey("old")]: old,
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("history");
    const panel = ui.doc.querySelector("#fac-tabpanel");
    assert.equal(
      panel.querySelectorAll(".fac-results li").length,
      0,
      "closed records render no rows",
    );
    const details = panel.querySelector(`[data-section="history-vote1"]`);
    details.open = true;
    details.dispatchEvent(new ui.doc.defaultView.Event("toggle"));
    assert.equal(details.querySelectorAll(".fac-results li").length, 2);
    assert.match(details.textContent, /2998 objects got no votes/);
    // The opened record stays open, with its rows, through redraws.
    b.workshop = { ...b.workshop };
    ui.api.render();
    const again = panel.querySelector(`[data-section="history-vote1"]`);
    assert.equal(again.open, true);
    assert.equal(again.querySelectorAll(".fac-results li").length, 2);
    const older = panel.querySelector(`[data-section="history-old"]`);
    older.open = true;
    older.dispatchEvent(new ui.doc.defaultView.Event("toggle"));
    assert.deepEqual(
      [...older.querySelectorAll(".fac-result-label")].map(
        (l) => l.textContent,
      ),
      ["Zero", "One"],
    );
    assert.doesNotMatch(older.textContent, /got no votes/);
  } finally {
    ui.close();
  }
});

test("live vote results page through big votes and are not rebuilt on every draw", () => {
  const b = { ...newBoard("Big workshop") };
  let reads = 0;
  b.items = Array.from({ length: 1000 }, (_, n) => {
    const i = item("note", (n % 60) * 220, Math.floor(n / 60) * 220, {
      id: `n${n}`,
    });
    const text = `Idea ${n}`;
    Object.defineProperty(i, "text", {
      enumerable: true,
      get: () => (reads++, text),
    });
    return i;
  });
  b.workshop = Object.fromEntries([
    [
      "vote",
      vote({ hidden: false, targets: b.items.map((i) => i.id), votes: 3 }),
    ],
    ballot(owner, ["n7"]),
  ]);
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("vote");
    const panel = ui.doc.querySelector("#fac-tabpanel");
    const rows = () =>
      [...panel.querySelectorAll(".fac-results .fac-result-label")].map(
        (l) => l.textContent,
      );
    assert.equal(rows().length, 50);
    assert.equal(rows()[0], "Idea 7");
    assert.match(panel.textContent, /Showing results 1–50 of 1000\./);
    assert.equal(
      panel.querySelector('[data-fac="vote-results-prev"]').disabled,
      true,
    );
    // Draws with nothing new neither rebuild the tab nor name any object
    // beyond the vote buttons on objects in view.
    const drawReads = () => {
      ui.api.render();
      reads = 0;
      for (let n = 0; n < 5; n++) ui.api.render();
      return reads;
    };
    const heading = panel.querySelector("h3");
    const withResults = drawReads();
    assert.equal(panel.querySelector("h3"), heading);
    ui.api.open("session");
    assert.equal(withResults, drawReads());
    ui.api.open("vote");
    const next = panel.querySelector('[data-fac="vote-results-next"]');
    next.focus();
    next.click();
    assert.match(panel.textContent, /Showing results 51–100 of 1000\./);
    assert.equal(rows().length, 50);
    assert.equal(
      ui.doc.activeElement.dataset.fac,
      "vote-results-next",
      "the pressed page button keeps focus",
    );
    for (let n = 0; n < 18; n++)
      panel.querySelector('[data-fac="vote-results-next"]').click();
    assert.match(panel.textContent, /Showing results 951–1000 of 1000\./);
    assert.equal(
      ui.doc.activeElement.dataset.fac,
      "vote-results-prev",
      "focus moves to Previous on the last page",
    );
    // A new ballot redraws the page shown, not every object's row.
    reads = 0;
    b.workshop = {
      ...b.workshop,
      ...Object.fromEntries([ballot(editor, ["n8"])]),
    };
    ui.api.render();
    assert.ok(reads < 2000, `${reads} object names read for one ballot`);
    assert.match(panel.textContent, /Showing results 951–1000 of 1000\./);
  } finally {
    ui.close();
  }
});

test("canvas badges are worked out only for objects in view", async () => {
  const { createOverlay } = await import("../src/facilitation/overlay.js");
  const dom = new JSDOM('<div class="canvas-wrap"><canvas></canvas></div>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  const b = { ...newBoard("Large"), workshop: {} };
  b.items = Array.from({ length: 2000 }, (_, n) =>
    item("note", (n % 50) * 220, Math.floor(n / 50) * 200, { id: `n${n}` }),
  );
  let lookups = 0;
  const index = new Map([
    [
      JSON.stringify(objectTarget("n0")),
      [
        {
          by: editor.uuid,
          target: objectTarget("n0"),
          types: ["heart"],
          at: 1,
        },
      ],
    ],
  ]);
  const get = index.get.bind(index);
  index.get = (key) => (lookups++, get(key));
  const overlay = createOverlay({
    board: () => b,
    view: () => ({ x: 0, y: 0, z: 1 }),
    canvas: () => ({
      getBoundingClientRect: () => ({ width: 1600, height: 900 }),
    }),
    hidden: () => new Map(),
    selection: () => new Set(),
    me: () => ({ id: owner.uuid }),
    canParticipate: () => true,
    index: () => index,
    concealment: () => ({
      notes: new Set(),
      frames: new Set(),
      hidden: new Set(),
    }),
    label: (id) => id,
    icon: () => "",
    voting: () => null,
    stagedForManager: () => false,
  });
  try {
    overlay.bind(dom.window.document.querySelector(".canvas-wrap"));
    overlay.render();
    assert.equal(dom.window.document.querySelectorAll(".fac-item").length, 1);
    assert.ok(lookups < 100, `${lookups} objects looked up`);
  } finally {
    overlay.detach();
    dom.window.close();
    globalThis.document = previous;
  }
});

test("the add reaction button names its object once, as written, in each language", async () => {
  const { createOverlay } = await import("../src/facilitation/overlay.js");
  const { setLanguage } = await import("../src/i18n.js");
  const dom = new JSDOM('<div class="canvas-wrap"><canvas></canvas></div>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  const b = { ...newBoard("Labels"), workshop: {} };
  b.items = [item("note", 0, 0, { id: "n0" })];
  const overlay = createOverlay({
    board: () => b,
    view: () => ({ x: 0, y: 0, z: 1 }),
    canvas: () => ({
      getBoundingClientRect: () => ({ width: 1600, height: 900 }),
    }),
    hidden: () => new Map(),
    selection: () => new Set(["n0"]),
    me: () => ({ id: owner.uuid }),
    canParticipate: () => true,
    index: () => new Map(),
    concealment: () => ({
      notes: new Set(),
      frames: new Set(),
      hidden: new Set(),
    }),
    label: () => `Q&A: Tom's "idea"`,
    icon: () => "",
    voting: () => null,
    stagedForManager: () => false,
  });
  const label = () =>
    accessibleName(dom.window.document.querySelector("[data-fac-picker]"));
  try {
    overlay.bind(dom.window.document.querySelector(".canvas-wrap"));
    overlay.render();
    assert.equal(label(), `Add a reaction: Q&A: Tom's "idea"`);
    setLanguage("fr");
    overlay.render();
    assert.equal(label(), `Ajouter une réaction : Q&A: Tom's "idea"`);
  } finally {
    setLanguage("en");
    overlay.detach();
    dom.window.close();
    globalThis.document = previous;
  }
});

test("a vote button on an object narrower than the button shows its plus alone", async () => {
  const { createOverlay } = await import("../src/facilitation/overlay.js");
  const dom = new JSDOM('<div class="canvas-wrap"><canvas></canvas></div>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  const b = { ...newBoard("Votes"), workshop: {} };
  b.items = [item("note", 0, 0, { id: "n0", text: "Idea" })];
  let zoom = 1;
  const overlay = createOverlay({
    board: () => b,
    view: () => ({ x: 0, y: 0, z: zoom }),
    canvas: () => ({
      getBoundingClientRect: () => ({ width: 1600, height: 900 }),
    }),
    hidden: () => new Map(),
    selection: () => new Set(),
    me: () => ({ id: owner.uuid }),
    canParticipate: () => true,
    index: () => new Map(),
    concealment: () => ({
      notes: new Set(),
      frames: new Set(),
      hidden: new Set(),
    }),
    label: () => "Idea",
    icon: () => "<svg></svg>",
    voting: () => ({
      targets: new Set(["n0"]),
      open: true,
      showCounts: false,
      counts: new Map(),
      mine: [],
      left: 3,
      multiple: true,
    }),
    stagedForManager: () => false,
  });
  const button = () =>
    dom.window.document.querySelector('[data-fac-vote="add"]');
  try {
    overlay.bind(dom.window.document.querySelector(".canvas-wrap"));
    overlay.render();
    assert.equal(button().classList.contains("is-compact"), false);
    assert.match(button().textContent, /Vote/);
    // Zoomed out, the note is about 50 pixels wide on screen.
    zoom = 0.26;
    overlay.render();
    assert.equal(button().classList.contains("is-compact"), true);
    assert.doesNotMatch(
      [...button().querySelectorAll(":scope > span:not(.sr-only)")]
        .map((s) => s.textContent)
        .join(""),
      /Vote/,
    );
    assert.equal(accessibleName(button()), "Vote for Idea · 3 votes left");
  } finally {
    overlay.detach();
    dom.window.close();
    globalThis.document = previous;
  }
});

test("showing an object inside a hidden frame says it stays hidden with the frame", () => {
  const b = { ...newBoard("Hidden"), shared: { server: "x", room: "r" } };
  b.items = [
    item("frame", 0, 0, { id: "F", w: 1000, h: 800, text: "Later" }),
    item("frame", 100, 100, { id: "G", w: 300, h: 300, text: "Inner" }),
    item("note", 150, 150, { id: "n", parentId: "G", text: "Inside" }),
    item("note", 2000, 0, { id: "m", text: "Alone" }),
  ];
  b.workshop = { settings: { lock: "open", hide: ["F", "m"] } };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    // A frame lying inside the hidden frame, and what it holds, are hidden.
    assert.equal(ui.api.hidden("G"), true);
    assert.equal(ui.api.hidden("n"), true);
    ui.api.setHidden(["n"], false);
    assert.deepEqual(b.workshop.settings.hide, ["F", "m"]);
    assert.equal(
      ui.calls.toasts.at(-1),
      "Objects in a hidden frame stay hidden until the frame is shown.",
    );
    ui.api.setHidden(["m"], false);
    assert.deepEqual(b.workshop.settings.hide, ["F"]);
    assert.equal(ui.calls.toasts.at(-1), "Shown to participants.");
    ui.api.setHidden(["F", "G", "n"], false);
    assert.equal(ui.api.hidden("n"), false);
    assert.equal(ui.calls.toasts.at(-1), "Shown to participants.");
  } finally {
    ui.close();
  }
});

test("frames inside a staged or hidden frame are concealed with it", () => {
  const b = {
    ...newBoard("Nested"),
    items: [
      item("frame", 0, 0, { id: "A", w: 1000, h: 800, text: "Outer" }),
      item("frame", 100, 100, { id: "B", w: 400, h: 300, text: "Inner" }),
      item("note", 150, 150, { id: "n", parentId: "B", text: "Secret" }),
      item("frame", 1200, 0, { id: "C", w: 400, h: 300, text: "Beside" }),
    ],
  };
  b.workshop = { settings: { stage: { frames: ["A"], shown: 0 } } };
  const staged = concealment(b, editor.uuid, false);
  assert.deepEqual([...staged.frames], ["A"]);
  assert.deepEqual([...staged.hidden].sort(), ["B", "n"]);
  b.workshop = { settings: { hide: ["A"] } };
  const hidden = concealment(b, editor.uuid, false);
  assert.deepEqual([...hidden.hidden].sort(), ["A", "B", "n"]);
  assert.equal(concealment(b, owner.uuid, true).hidden.size, 0);
  // A step already shown stays visible inside a later, larger step.
  b.workshop = { settings: { stage: { frames: ["B", "A"], shown: 1 } } };
  const revealed = concealment(b, editor.uuid, false);
  assert.deepEqual([...revealed.frames], ["A"]);
  assert.deepEqual([...revealed.hidden], []);
});

test("a locked board refuses participants' planning setting changes", () => {
  const before = { ...newBoard("Locked"), items: notes() };
  before.workshop = { settings: { lock: "frozen" } };
  const after = structuredClone(before);
  after.planning = { statusSync: true };
  assert.throws(
    () => validateWorkshopChanges(before, after, editor, "editor"),
    /locked/,
  );
  // The refused change is rolled back, so allowed notes still save.
  const b = {
    ...newBoard("Contribute"),
    shared: { server: "x", room: "r" },
    items: notes(),
    workshop: { settings: { lock: "contribute" } },
  };
  const baseline = structuredClone(b);
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    b.planning = { statusSync: true };
    assert.equal(ui.api.beforeSave(baseline), false);
    assert.equal(b.planning, undefined);
    b.items.push(item("note", 900, 0, { text: "Mine" }));
    assert.equal(ui.api.beforeSave(baseline), true);
  } finally {
    ui.close();
  }
});

test("text heights measured with this device's fonts do not block votes on a locked board", () => {
  const text = (extra) =>
    item("text", 0, 300, {
      id: "t",
      text: "Agenda",
      autoHeight: true,
      h: 60,
      ...extra,
    });
  for (const lock of ["frozen", "contribute"])
    for (const rotation of [0, 0.5]) {
      const b = {
        ...newBoard("Locked"),
        shared: { server: "x", room: "r" },
        items: [...notes(), text(rotation ? { rotation } : {})],
        workshop: { settings: { lock }, vote: vote() },
      };
      const baseline = structuredClone(b);
      // This device measures the facilitator's text a little taller, which
      // also moves rotated text to keep its corner in place.
      setObjectHeight(b.items[3], 62);
      if (rotation) assert.notEqual(b.items[3].x, baseline.items[3].x);
      const ui = stubUI(b, { role: "editor", me: editor });
      try {
        b.workshop = Object.fromEntries([
          ...Object.entries(b.workshop),
          ballot(editor, ["a"]),
        ]);
        assert.equal(ui.api.beforeSave(baseline), true, `${lock} ${rotation}`);
        assert.ok(b.workshop[voteKey("vote1", editor.uuid)]);
        // Other changes to the text are still refused.
        const edited = structuredClone(b);
        edited.items[3].text = "Changed";
        assert.throws(() =>
          validateWorkshopChanges(baseline, edited, editor, "editor"),
        );
        const resized = structuredClone(b);
        resized.items[3].autoHeight = false;
        assert.throws(() =>
          validateWorkshopChanges(baseline, resized, editor, "editor"),
        );
      } finally {
        ui.close();
      }
    }
});

test("a timer started by hand keeps running through agenda steps without a duration, and ending the agenda stops a step's timer", () => {
  const frames = ["Welcome", "Brainstorm", "Vote"].map((text, n) =>
    item("frame", n * 600, 0, { id: `f${n}`, text, order: n, w: 500 }),
  );
  const b = {
    ...newBoard("Agenda"),
    shared: { server: "https://x.puter.work", room: "room" },
    items: frames,
    workshop: {
      agenda: {
        steps: [{ frame: "f0" }, { frame: "f1", minutes: 10 }, { frame: "f2" }],
      },
    },
  };
  const host = stubUI(b, { role: "owner", me: owner });
  try {
    b.timer = {
      id: "by-hand",
      state: "running",
      duration: 300000,
      remaining: 300000,
      endsAt: 310000,
    };
    host.api.open("agenda");
    host.click('[data-fac="agenda-start"]');
    assert.equal(host.calls.timer.length, 0, "The hand timer keeps running");
    host.click('[data-fac="agenda-next"]');
    assert.equal(host.calls.timer[0].duration, 600000);
    assert.equal(host.calls.timer[0].state, "running");
    host.click('[data-fac="agenda-end"]');
    assert.equal(b.workshop.run.state, "ended");
    assert.equal(host.calls.timer[1].state, "idle");
    assert.equal(host.calls.timer[1].id, host.calls.timer[0].id);
  } finally {
    host.close();
  }
});

test("the agenda steps back from the step shown after frames are deleted", () => {
  const b = {
    ...newBoard("Agenda"),
    items: [0, 1, 2, 3, 4].map((n) =>
      item("frame", n * 900, 0, {
        id: `f${n}`,
        text: `Step ${n}`,
        w: 800,
        h: 600,
        order: n,
      }),
    ),
  };
  b.workshop = {
    run: { id: "run1", state: "running", step: 4, startedAt: 1, stepAt: 1 },
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    b.items = b.items.slice(0, 2);
    ui.api.open("agenda");
    assert.match(ui.doc.querySelector(".fac-remaining").textContent, /2 of 2/);
    ui.click('[data-fac="agenda-prev"]');
    assert.match(ui.doc.querySelector(".fac-remaining").textContent, /1 of 2/);
  } finally {
    ui.close();
  }
});

test("a step inside a hidden section stays covered and the facilitator is told", () => {
  const b = {
    ...newBoard("Sections"),
    shared: { server: "https://x.puter.work", room: "room" },
    items: [
      item("frame", 0, 0, {
        id: "part",
        text: "Part 2",
        w: 2000,
        h: 900,
        order: 0,
      }),
      item("frame", 50, 100, {
        id: "s1",
        text: "Step 1",
        w: 800,
        h: 600,
        order: 1,
      }),
      item("frame", 1000, 100, {
        id: "s2",
        text: "Step 2",
        w: 800,
        h: 600,
        order: 2,
      }),
    ],
    workshop: {
      agenda: { steps: [{ frame: "part", skip: true }] },
      settings: { hide: ["part", "s1", "s2"] },
    },
  };
  const host = stubUI(b, { role: "owner", me: owner });
  try {
    host.api.open("agenda");
    host.click('[data-fac="agenda-start"]');
    assert.equal(b.workshop.run.frame, "s1");
    // Showing Part 2 would show Step 2 as well, so it stays hidden.
    assert.ok(hiddenObjects(b).has("s1"));
    assert.ok(hiddenObjects(b).has("s2"));
    assert.match(
      host.doc.querySelector("#fac-error").textContent,
      /stays hidden from participants because a frame around it/,
    );
  } finally {
    host.close();
  }
});

test("going to an agenda step shows its staged or hidden frame to participants in the same save", () => {
  const b = {
    ...newBoard("Agenda"),
    shared: { server: "https://x.puter.work", room: "room" },
    items: ["Welcome", "Notes", "Ideas", "Vote"].map((text, n) =>
      item("frame", n * 900, 0, {
        id: `f${n}`,
        text,
        w: 800,
        h: 600,
        order: n,
      }),
    ),
    workshop: {
      // The facilitator's notes frame is staged but left out of the agenda.
      agenda: { steps: [{ frame: "f1", skip: true }] },
      settings: {
        stage: { frames: ["f0", "f1", "f2", "f3"], shown: 0 },
        hide: ["f3"],
      },
    },
  };
  let workshop = b.workshop,
    saves = 0;
  Object.defineProperty(b, "workshop", {
    get: () => workshop,
    set: (value) => {
      saves++;
      workshop = value;
    },
    enumerable: true,
    configurable: true,
  });
  const host = stubUI(b, { role: "owner", me: owner });
  const participant = stubUI(b, { role: "editor", me: editor });
  const covered = () => {
    const c = concealment(b, editor.uuid, false);
    return [...new Set([...c.frames, ...c.hidden])].sort();
  };
  try {
    participant.api.render();
    host.api.open("agenda");
    host.click('[data-fac="agenda-start"]');
    assert.equal(saves, 1, "The step and the reveal are one save");
    assert.equal(b.workshop.run.frame, "f0");
    assert.deepEqual(b.workshop.settings.stage, {
      frames: ["f0", "f1", "f2", "f3"],
      shown: 1,
    });
    assert.deepEqual(covered(), ["f1", "f2", "f3"]);
    // The next step skips the notes frame, which stays staged.
    host.click('[data-fac="agenda-next"]');
    assert.equal(saves, 2);
    assert.equal(b.workshop.run.frame, "f2");
    assert.deepEqual(b.workshop.settings.stage, {
      frames: ["f0", "f2", "f1", "f3"],
      shown: 2,
    });
    assert.deepEqual(covered(), ["f1", "f3"]);
    participant.api.render();
    assert.match(participant.banner(), /Step 2 of 3: Ideas/);
    // Going back to a step already shown changes nothing.
    host.click('[data-fac="agenda-prev"]');
    assert.equal(saves, 3);
    assert.deepEqual(b.workshop.settings.stage.shown, 2);
    // A staged frame the facilitator also hid is revealed and shown.
    host.click('[data-fac="agenda-go"][data-step="2"]');
    assert.equal(b.workshop.run.frame, "f3");
    assert.deepEqual(b.workshop.settings, {
      lock: "open",
      private: null,
      anonymous: false,
      stage: { frames: ["f0", "f2", "f3", "f1"], shown: 3 },
    });
    assert.deepEqual(covered(), ["f1"]);
    participant.api.render();
    assert.match(participant.banner(), /Step 3 of 3: Vote/);
    assert.doesNotMatch(participant.banner(), /Hidden by the facilitator/);
    // The notes frame is still the next one to reveal by hand.
    host.api.open("session");
    host.click('[data-fac="stage-next"]');
    assert.equal(b.workshop.settings.stage, undefined);
    assert.deepEqual(covered(), []);
  } finally {
    participant.close();
    host.close();
  }
});

test("a reveal made by going to an agenda step merges with another facilitator's reveal", async () => {
  const { rebaseWorkshop } = await import("../src/facilitation/model.js");
  const stage = { frames: ["A", "B", "C", "D"], shown: 1 };
  const before = { settings: { lock: "open", stage } };
  // This facilitator went to the step on C, revealing it ahead of B...
  const local = {
    settings: {
      lock: "open",
      stage: { frames: ["A", "C", "B", "D"], shown: 2 },
    },
  };
  // ...while another revealed the next frame, B.
  const both = rebaseWorkshop(local, before, {
    settings: { lock: "frozen", stage: { ...stage, shown: 2 } },
  });
  assert.deepEqual(both.settings, {
    lock: "frozen",
    stage: { frames: ["A", "B", "C", "D"], shown: 3 },
  });
  validateWorkshop(both);
  // Revealing every frame, or staging others, meanwhile is kept.
  const all = rebaseWorkshop(local, before, { settings: { lock: "open" } });
  assert.equal(all.settings.stage, undefined);
  const restaged = { frames: ["E"], shown: 0 };
  assert.deepEqual(
    rebaseWorkshop(local, before, {
      settings: { lock: "open", stage: restaged },
    }).settings.stage,
    restaged,
  );
  // With no other change, the reveal applies as made.
  assert.deepEqual(rebaseWorkshop(local, before, before), local);
});

test("vote lists, the agenda, and saved results never name hidden objects", () => {
  const frame = item("frame", 1000, 0, { w: 600, h: 400, text: "Round 2" });
  const staged = item("note", 1100, 100, {
    text: "Staged secret",
    parentId: frame.id,
  });
  const loose = item("note", 300, 0, { text: "Hidden secret" });
  const shown = item("note", 0, 0, { text: "Visible idea" });
  const b = {
    ...newBoard("Workshop"),
    shared: { server: "x", room: "r" },
    items: [shown, frame, staged, loose],
  };
  b.workshop = {
    settings: { stage: { frames: [frame.id], shown: 0 }, hide: [loose.id] },
    vote: vote({ targets: [shown.id, staged.id, loose.id] }),
    [historyKey("old")]: {
      kind: "vote",
      id: "old",
      title: "Earlier",
      startedAt: 1,
      endedAt: 2,
      participants: 1,
      results: [{ id: loose.id, label: "Hidden secret", count: 1 }],
    },
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    for (const tab of ["vote", "agenda", "history"]) {
      ui.api.open(tab);
      const text = ui.doc.querySelector("#fac-tabpanel").textContent;
      assert.doesNotMatch(text, /secret|Round 2/, tab);
    }
    ui.api.open("vote");
    assert.equal(ui.doc.querySelectorAll(".fac-vote-list li").length, 1);
  } finally {
    ui.close();
  }
});

test("a ballot arriving after a vote is saved updates the saved result", async () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  const ended = vote({ state: "ended", endedAt: 9000, hidden: false });
  b.workshop = {
    vote: ended,
    [historyKey(ended.id)]: resultRecord(
      { ...b, workshop: { vote: ended } },
      "vote",
      (id) => id,
      9000,
    ),
  };
  assert.equal(b.workshop[historyKey(ended.id)].participants, 0);
  // Accepted by the worker before the end, merged in after it.
  Object.assign(b.workshop, Object.fromEntries([ballot(editor, ["a"])]));
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.render();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const saved = b.workshop[historyKey(ended.id)];
    assert.equal(saved.participants, 1);
    assert.equal(saved.results.find((r) => r.id === "a").count, 1);
    assert.equal(saved.endedAt, 9000);
  } finally {
    ui.close();
  }
});

test("a late ballot for an object hidden since saves no text hidden from participants", async () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  const ended = vote({ state: "ended", endedAt: 9000, hidden: false });
  b.workshop = {
    vote: ended,
    ...Object.fromEntries([ballot(owner, ["b"])]),
  };
  b.workshop[historyKey(ended.id)] = resultRecord(b, "vote", (id) => id, 9000);
  // The facilitator then hides "Better docs"; a ballot for it, accepted
  // before the end, arrives after.
  b.workshop.settings = { hide: ["c"] };
  Object.assign(b.workshop, Object.fromEntries([ballot(editor, ["c"])]));
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.render();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const saved = b.workshop[historyKey(ended.id)];
    const late = saved.results.find((r) => r.id === "c");
    assert.equal(late.count, 1, "The late ballot counts");
    assert.equal(late.label, "", "Its hidden text is not saved");
    assert.doesNotMatch(JSON.stringify(saved), /Better docs/);
  } finally {
    ui.close();
  }
});

test("facilitators keep a saved vote result's labels instead of rewriting them", async () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  const ended = vote({ state: "ended", endedAt: 9000, hidden: false });
  // Saved by another facilitator, who names objects differently.
  b.workshop = {
    vote: ended,
    ...Object.fromEntries([ballot(editor, ["a"]), ballot(owner, ["b", "c"])]),
  };
  b.workshop[historyKey(ended.id)] = resultRecord(
    b,
    "vote",
    (id) => `Other ${id}`,
    9000,
  );
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    const before = b.workshop;
    ui.api.render();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(b.workshop, before, "an up-to-date result is not rewritten");
    // Received changes replace the entries, as every board update does.
    b.workshop = {
      ...b.workshop,
      ...Object.fromEntries([ballot(viewer, ["b"])]),
    };
    ui.api.render();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const saved = b.workshop[historyKey(ended.id)];
    assert.equal(saved.participants, 3);
    assert.deepEqual(saved.results.map((r) => r.label).sort(), [
      "Other a",
      "Other b",
      "Other c",
    ]);
  } finally {
    ui.close();
  }
});

test("a stale reveal or agenda step never undoes another facilitator's reveal all, end or restart", async () => {
  const { rebaseWorkshop } = await import("../src/facilitation/model.js");
  const stage = { frames: ["A", "B", "C", "D"], shown: 1 };
  const run = {
    id: "run1",
    state: "running",
    step: 1,
    frame: "B",
    startedAt: 1,
    stepAt: 2,
  };
  const before = { settings: { lock: "open", stage }, run };
  // This facilitator reveals the next frame and moves to the next step...
  const local = {
    settings: { lock: "open", stage: { ...stage, shown: 2 } },
    run: { ...run, step: 2, frame: "C", stepAt: 3 },
  };
  // ...after another revealed every frame and ended the agenda.
  const ended = rebaseWorkshop(local, before, {
    settings: { lock: "open" },
    run: { ...run, state: "ended" },
  });
  assert.equal(ended.settings.stage, undefined);
  assert.equal(ended.run.state, "ended");
  validateWorkshop(ended);
  // Another staged different frames and started a new run.
  const restaged = { frames: ["E", "F"], shown: 0 },
    restarted = { ...run, id: "run2", step: 0, frame: "A" };
  const replaced = rebaseWorkshop(local, before, {
    settings: { lock: "open", stage: restaged },
    run: restarted,
  });
  assert.deepEqual(replaced.settings.stage, restaged);
  assert.deepEqual(replaced.run, restarted);
  // Two reveals at once keep the further one, and settings still merge.
  const further = rebaseWorkshop(local, before, {
    settings: { lock: "frozen", stage: { ...stage, shown: 3 } },
    run,
  });
  assert.deepEqual(further.settings, {
    lock: "frozen",
    stage: { ...stage, shown: 3 },
  });
  assert.deepEqual(further.run, local.run);
  // Revealing the last frame, or ending the run, still applies.
  const done = rebaseWorkshop(
    { settings: { lock: "open" }, run: { ...run, state: "ended" } },
    before,
    before,
  );
  assert.equal(done.settings.stage, undefined);
  assert.equal(done.run.state, "ended");
});

test("concurrent facilitator changes to settings and a vote keep both", async () => {
  const { rebaseWorkshop } = await import("../src/facilitation/model.js");
  const before = {
    settings: { lock: "open", private: "r1", anonymous: false },
    vote: vote(),
  };
  // Another facilitator revealed private notes and the vote results...
  const remote = {
    settings: { ...before.settings, private: null },
    vote: { ...before.vote, revealed: true },
  };
  // ...while this one locked the board and ended the vote.
  const local = {
    settings: { ...before.settings, lock: "frozen" },
    vote: { ...before.vote, state: "ended", endedAt: 5000 },
  };
  const merged = rebaseWorkshop(local, before, remote);
  assert.deepEqual(merged.settings, {
    lock: "frozen",
    private: null,
    anonymous: false,
  });
  assert.equal(merged.vote.revealed, true);
  assert.equal(merged.vote.state, "ended");
  validateWorkshop(merged);
  // A different vote is never mixed with the one it replaced.
  const next = { ...vote({ id: "vote2", title: "New" }) };
  const replaced = rebaseWorkshop({ vote: next }, before, remote);
  assert.deepEqual(replaced.vote, next);
  // The first settings on a board merge too: one facilitator locks the
  // board while another turns on private mode and hides an object.
  const first = rebaseWorkshop(
    { settings: { lock: "frozen", private: null, anonymous: false } },
    {},
    {
      settings: { lock: "open", private: "r1", anonymous: false, hide: ["a"] },
    },
  );
  assert.deepEqual(first.settings, {
    lock: "frozen",
    private: "r1",
    anonymous: false,
    hide: ["a"],
  });
  // Frames the other staged meanwhile stay staged.
  const defaults = {
    lock: "open",
    private: null,
    anonymous: false,
    stage: null,
  };
  const stage = { frames: ["f1", "f2"], shown: 0 };
  const staged = rebaseWorkshop(
    { settings: { ...defaults, lock: "frozen" } },
    {},
    { settings: { ...defaults, stage } },
  );
  assert.deepEqual(staged.settings, { ...defaults, lock: "frozen", stage });
});

test("a stale reveal or end keeps the vote or poll another facilitator started or cleared", async () => {
  const { rebaseWorkshop } = await import("../src/facilitation/model.js");
  const poll = (extra = {}) => ({
    id: "poll1",
    question: "Lunch?",
    options: [
      { id: "o1", text: "Yes" },
      { id: "o2", text: "No" },
    ],
    multiple: false,
    anonymous: false,
    hidden: false,
    state: "open",
    revealed: false,
    startedAt: 1000,
    ...extra,
  });
  const before = { vote: vote(), poll: poll() };
  // This facilitator revealed the vote and closed the poll...
  const local = {
    vote: { ...before.vote, revealed: true },
    poll: { ...before.poll, state: "closed", endedAt: 5000 },
  };
  // ...while another started new ones.
  const next = {
    vote: vote({ id: "vote2", title: "New" }),
    poll: poll({ id: "poll2", question: "Dinner?" }),
  };
  assert.deepEqual(rebaseWorkshop(local, before, next), next);
  // A vote and poll the other facilitator cleared stay cleared.
  assert.equal(rebaseWorkshop(local, before, {}), undefined);
  assert.deepEqual(
    rebaseWorkshop(local, before, { settings: { lock: "frozen" } }),
    { settings: { lock: "frozen" } },
  );
  // Clearing the old vote and poll keeps the new ones.
  assert.deepEqual(rebaseWorkshop({}, before, next), next);
  // With nothing new, clearing them still clears them.
  assert.equal(rebaseWorkshop({}, before, before), undefined);
});

test("two facilitators hiding and showing objects at once keep both changes", async () => {
  const { rebaseWorkshop } = await import("../src/facilitation/model.js");
  const before = { settings: { lock: "open", hide: ["a", "b"] } };
  // This facilitator hides x and shows b again...
  const local = { settings: { lock: "open", hide: ["a", "x"] } };
  // ...while another hid y and showed a again.
  const remote = { settings: { lock: "open", hide: ["b", "y"] } };
  const merged = rebaseWorkshop(local, before, remote);
  assert.deepEqual(merged.settings.hide, ["y", "x"]);
  validateWorkshop(merged);
  // Showing everything keeps what the other facilitator hid meanwhile.
  assert.deepEqual(
    rebaseWorkshop({ settings: { lock: "open", hide: [] } }, before, remote)
      .settings.hide,
    ["y"],
  );
  // A merge past the limit keeps this facilitator's own list.
  const many = (p) => Array.from({ length: 300 }, (_, n) => `${p}${n}`);
  const big = rebaseWorkshop(
    { settings: { hide: many("l") } },
    { settings: { hide: [] } },
    { settings: { hide: many("r") } },
  );
  assert.deepEqual(big.settings.hide, many("l"));
});

test("saving the agenda keeps steps another facilitator changed meanwhile", () => {
  const b = { ...newBoard("Agenda"), shared: { server: "x", room: "r" } };
  b.items = [
    item("frame", 0, 0, { id: "F1", w: 500, h: 400, text: "Intro" }),
    item("frame", 600, 0, { id: "F2", w: 500, h: 400, text: "Ideas" }),
  ];
  b.workshop = { agenda: { steps: [{ frame: "F1", minutes: 5 }] } };
  const ui = stubUI(b, { role: "facilitator", me: owner });
  try {
    ui.api.open("agenda");
    const field = (n, name) => ui.doc.querySelectorAll(name)[n];
    // This facilitator starts writing instructions for the second step...
    field(1, ".fac-step-text").value = "Brainstorm";
    // ...while another sets the first step's duration.
    b.workshop = { agenda: { steps: [{ frame: "F1", minutes: 10 }] } };
    ui.api.render();
    assert.equal(field(0, ".fac-step-minutes").value, "10");
    assert.equal(field(1, ".fac-step-text").value, "Brainstorm");
    ui.doc
      .querySelector("#fac-agenda-form")
      .dispatchEvent(
        new ui.doc.defaultView.Event("submit", { cancelable: true }),
      );
    assert.deepEqual(b.workshop.agenda.steps, [
      { frame: "F1", minutes: 10 },
      { frame: "F2", text: "Brainstorm", lang: "en" },
    ]);
    // Once saved, later changes from others show again.
    b.workshop = {
      agenda: {
        steps: [
          { frame: "F1", minutes: 10 },
          { frame: "F2", text: "Vote" },
        ],
      },
    };
    ui.api.render();
    assert.equal(field(1, ".fac-step-text").value, "Vote");
    assert.equal(
      field(1, ".fac-step-text").hasAttribute("lang"),
      false,
      "Legacy shared instructions without a saved tag are not guessed",
    );
  } finally {
    ui.close();
  }
});

test("an agenda step names its duration once, when its frame title already gives it", () => {
  const b = {
    ...newBoard("Agenda"),
    shared: { server: "https://x.puter.work", room: "room" },
    items: [
      item("frame", 0, 0, {
        id: "f0",
        text: "Why we are here (15 min)",
        order: 0,
      }),
      item("frame", 600, 0, { id: "f1", text: "Ideas (10 min)", order: 1 }),
      item("frame", 1200, 0, { id: "f2", text: "Vote", order: 2 }),
    ],
    // The second step was given another duration than its title says.
    workshop: {
      agenda: {
        steps: [
          { frame: "f1", minutes: 20 },
          { frame: "f2", minutes: 5 },
        ],
      },
    },
  };
  const host = stubUI(b, { role: "owner", me: owner });
  try {
    host.api.open("agenda");
    const rows = [...host.doc.querySelectorAll(".fac-agenda li")].map((li) =>
      [...li.childNodes]
        .filter((node) => node.nodeName !== "BUTTON")
        .map((node) => node.textContent)
        .join(""),
    );
    assert.deepEqual(rows, [
      "Why we are here (15 min)",
      "Ideas (10 min) · 20 min",
      "Vote · 5 min",
    ]);
  } finally {
    host.close();
  }
});

test("playbook steps run for the timebox in their frame titles, which the agenda can change or turn off", async () => {
  const { agendaSteps, titleMinutes } =
    await import("../src/facilitation/model.js");
  const { fromTemplate } = await import("../src/templates.js");
  assert.equal(titleMinutes("1 · Set the stage (10 min)"), 10);
  assert.equal(titleMinutes("1 · Préparer le terrain (10 min)"), 10);
  assert.equal(titleMinutes("Notes (min)"), 0);
  assert.equal(titleMinutes("Budget (10 min) review"), 0);
  // Every playbook step starts its timer, in either language.
  for (const lang of ["en", "fr"])
    for (const id of [
      "project-kickoff",
      "lightning-decision-jam",
      "playbook-retro",
      "playbook-discovery",
    ]) {
      const steps = agendaSteps(fromTemplate(id, lang));
      assert.ok(steps.length >= 5, id);
      assert.ok(
        steps.every((s) => s.minutes > 0),
        `${id} ${lang}: ${steps.map((s) => s.minutes)}`,
      );
    }
  const b = { ...newBoard("Retro"), shared: { server: "x", room: "r" } };
  b.items = [
    item("frame", 0, 0, {
      id: "F1",
      w: 500,
      h: 400,
      text: "1 · Stage (10 min)",
    }),
    item("frame", 600, 0, {
      id: "F2",
      w: 500,
      h: 400,
      text: "2 · Data (20 min)",
    }),
    item("frame", 1200, 0, { id: "F3", w: 500, h: 400, text: "3 · Close" }),
  ];
  const ui = stubUI(b, { role: "facilitator", me: owner });
  try {
    ui.api.open("agenda");
    const minutes = () =>
      [...ui.doc.querySelectorAll(".fac-step-minutes")].map((f) => f.value);
    assert.deepEqual(minutes(), ["10", "20", "0"]);
    const save = () =>
      ui.doc
        .querySelector("#fac-agenda-form")
        .dispatchEvent(
          new ui.doc.defaultView.Event("submit", { cancelable: true }),
        );
    // Saving the titles' times stores nothing for them.
    save();
    assert.deepEqual(b.workshop?.agenda?.steps || [], []);
    // No timer for the first step, and a longer second one.
    const [first, second] = ui.doc.querySelectorAll(".fac-step-minutes");
    first.value = "0";
    second.value = "25";
    save();
    assert.deepEqual(b.workshop.agenda.steps, [
      { frame: "F1", minutes: 0 },
      { frame: "F2", minutes: 25 },
    ]);
    assert.deepEqual(
      agendaSteps(b).map((s) => s.minutes),
      [0, 25, 0],
    );
    assert.deepEqual(minutes(), ["0", "25", "0"]);
  } finally {
    ui.close();
  }
});

test("agenda settings are kept for boards with more than 60 frames", async () => {
  const { agendaSteps } = await import("../src/facilitation/model.js");
  const b = {
    ...newBoard("Long"),
    items: Array.from({ length: 61 }, (_, n) =>
      item("frame", n * 700, 0, { w: 600, h: 400, text: `Step ${n + 1}` }),
    ),
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("agenda");
    const rows = ui.doc.querySelectorAll("#fac-agenda-form [data-step]");
    rows[0].querySelector(".fac-step-include").checked = false;
    rows[60].querySelector(".fac-step-include").checked = false;
    ui.doc
      .querySelector("#fac-agenda-form")
      .dispatchEvent(
        new ui.doc.defaultView.Event("submit", { cancelable: true }),
      );
    const titles = agendaSteps(b).map((s) => s.title);
    assert.equal(titles.length, 59);
    assert.ok(!titles.includes("Step 1") && !titles.includes("Step 61"));
  } finally {
    ui.close();
  }
});

test("copies of a workshop board leave out what the person may not see", () => {
  const mine = item("note", 0, 0, { text: "My idea" });
  const theirs = item("note", 300, 0, { text: "Bob's private idea" });
  const secret = item("note", 600, 0, { text: "Answer key" });
  const b = {
    ...newBoard("Workshop"),
    shared: { server: "x", room: "r" },
    items: [mine, theirs, secret],
    workshop: {
      settings: { private: "r1", hide: [secret.id] },
      [contributionKey(theirs.id)]: { by: "bob", at: 1, round: "r1" },
      [contributionKey(mine.id)]: { by: viewer.uuid, at: 1, round: "r1" },
    },
  };
  const ui = stubUI(b, { role: "editor", me: viewer });
  try {
    const copy = structuredClone(b);
    assert.equal(ui.api.portableCopy(copy), 2);
    assert.deepEqual(
      copy.items.map((i) => i.text),
      ["My idea", "Private note"],
    );
    assert.equal(copy.workshop, undefined);
    validateBoard({ ...copy, shared: undefined });
    // The facilitator's own copy keeps hidden objects, not others' notes.
    const own = structuredClone(b);
    assert.equal(
      ui.api.portableCopy(own, { id: owner.uuid, manager: true }),
      2,
    );
    assert.deepEqual(
      own.items.map((i) => i.text),
      ["Private note", "Private note", "Answer key"],
    );
    // ...and keeps it hidden, so a copy prepared for the next session does
    // not show the answer key once shared.
    assert.deepEqual(own.workshop.settings, { hide: [secret.id] });
    validateBoard({ ...own, shared: undefined });
  } finally {
    ui.close();
  }
});

test("a shared board's library card shows only what the person may see there", () => {
  const theirs = item("note", 0, 0, { text: "Bob's private idea" });
  const secret = item("note", 300, 0, { text: "Answer key" });
  const staged = item("frame", 0, 400, { w: 400, h: 300, text: "Reveal" });
  const inside = item("note", 20, 450, {
    text: "Next quarter's plan",
    parentId: staged.id,
  });
  const b = {
    ...newBoard("Workshop"),
    shared: { server: "x", room: "r", role: "editor" },
    items: [theirs, secret, staged, inside],
    workshop: {
      settings: {
        private: "r1",
        hide: [secret.id],
        stage: { frames: [staged.id], shown: 0 },
      },
      [contributionKey(theirs.id)]: { by: "bob", at: 1, round: "r1" },
    },
  };
  const ui = stubUI(newBoard("Other"), { role: "owner", me: owner });
  try {
    const card = ui.api.libraryView(b, false);
    assert.deepEqual(
      card.items.map((i) => i.text),
      ["Private note", "Hidden by the facilitator"],
    );
    assert.equal(card.id, b.id);
    assert.equal(card.updated, b.updated);
    assert.equal(b.items.length, 4, "the stored board is left as it is");
    // A facilitator's card shows what they hid and staged, not others'
    // private notes.
    assert.deepEqual(
      ui.api.libraryView(b, true).items.map((i) => i.text),
      ["Private note", "Answer key", "Reveal", "Next quarter's plan"],
    );
    const plain = { ...b, workshop: undefined };
    assert.equal(ui.api.libraryView(plain, false), plain);
  } finally {
    ui.close();
  }
});

test("the workshop banner keeps keyboard focus while its countdown changes", () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  b.workshop = { vote: vote({ endsAt: 10000 + 300_000 }) };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    ui.api.render();
    const chip = ui.doc.querySelector('[data-fac-open="vote"]');
    chip.focus();
    b.workshop = { vote: vote({ endsAt: 10000 + 299_000 }) };
    ui.api.render();
    assert.equal(ui.doc.querySelector('[data-fac-open="vote"]'), chip);
    assert.match(chip.textContent, /4:59/);
    assert.equal(ui.doc.activeElement, chip);
    // Screen readers announce a focused control's new name, so the name
    // keeps the time it had when focused rather than changing each second.
    const name = () => chip.getAttribute("aria-label") ?? chip.textContent;
    assert.equal(name(), "Voting: 2 votes left · 5:00");
    b.workshop = { ...b.workshop, vote: vote({ endsAt: 10000 + 298_000 }) };
    ui.api.render();
    assert.match(chip.textContent, /4:58/);
    assert.equal(name(), "Voting: 2 votes left · 5:00");
    // What it says otherwise is news and is said, with the time.
    b.workshop = {
      vote: vote({ endsAt: 10000 + 297_000 }),
      ...Object.fromEntries([ballot(editor, ["a"])]),
    };
    ui.api.render();
    assert.equal(name(), "Voting: 1 vote left · 4:57");
    // Focused anew, it gives the time again.
    chip.blur();
    b.workshop = { ...b.workshop, vote: vote({ endsAt: 10000 + 296_000 }) };
    ui.api.render();
    assert.equal(name(), "Voting: 1 vote left · 4:56");
  } finally {
    ui.close();
  }
});

test("the reaction picker keeps its trigger when someone else reacts meanwhile", () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  b.workshop = { session: { id: "s1", state: "active", startedAt: 1 } };
  const ui = stubUI(b, {
    role: "editor",
    me: editor,
    selection: new Set(["a"]),
  });
  Object.assign(globalThis, { innerWidth: 1600, innerHeight: 900 });
  try {
    ui.api.render();
    const trigger = ui.doc.querySelector("[data-fac-picker]");
    trigger.focus();
    trigger.click();
    assert.ok(ui.doc.activeElement.closest(".fac-picker"));
    // Another participant reacts to the same note, which redraws its badge.
    b.workshop = {
      ...b.workshop,
      [reactionKey(viewer.uuid, objectTarget("a"))]: {
        by: viewer.uuid,
        target: ["o", "a"],
        types: ["heart"],
        at: 5,
        name: "Cam",
      },
    };
    ui.api.render();
    const redrawn = ui.doc.querySelector("[data-fac-picker]");
    assert.equal(redrawn.getAttribute("aria-expanded"), "true");
    ui.doc.querySelector(".fac-picker").dispatchEvent(
      new ui.doc.defaultView.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    assert.equal(ui.doc.querySelector(".fac-picker"), null);
    assert.equal(ui.doc.activeElement, redrawn);
    assert.equal(redrawn.getAttribute("aria-expanded"), "false");
  } finally {
    ui.close();
    delete globalThis.innerWidth;
    delete globalThis.innerHeight;
  }
});

test("the reaction picker returns focus to a comment's rebuilt reaction button", () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  const ui = stubUI(b, { role: "editor", me: editor });
  const comments = ui.doc.createElement("div");
  comments.id = "comments-panel";
  ui.doc.body.append(comments);
  const thread = { id: "t1" },
    message = { id: "m1" };
  const draw = () =>
    (comments.innerHTML = ui.api.commentReactions(thread, message));
  Object.assign(globalThis, { innerWidth: 1600, innerHeight: 900 });
  try {
    draw();
    const trigger = comments.querySelector("[data-fac-picker]");
    trigger.focus();
    trigger.click();
    assert.ok(ui.doc.activeElement.closest(".fac-picker"));
    // The comments panel is rebuilt when someone else votes or reacts.
    draw();
    ui.doc.querySelector(".fac-picker").dispatchEvent(
      new ui.doc.defaultView.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    assert.equal(ui.doc.querySelector(".fac-picker"), null);
    assert.equal(
      ui.doc.activeElement,
      comments.querySelector("[data-fac-picker]"),
    );
  } finally {
    ui.close();
    delete globalThis.innerWidth;
    delete globalThis.innerHeight;
  }
});

test("closing the facilitation panel returns focus to what opened it", () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  b.workshop = { vote: vote({ endsAt: 10000 + 300_000 }) };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    ui.api.render();
    const chip = ui.doc.querySelector('[data-fac-open="vote"]');
    chip.focus();
    chip.click();
    const panel = ui.doc.querySelector("#facilitation-panel");
    assert.ok(panel);
    assert.notEqual(ui.doc.activeElement, chip);
    panel.dispatchEvent(
      new ui.doc.defaultView.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    assert.equal(ui.doc.querySelector("#facilitation-panel"), null);
    assert.equal(ui.doc.activeElement, chip);
  } finally {
    ui.close();
  }
});

test("objects added to the same list show up in the participant's view", () => {
  const hiddenNote = item("note", 0, 0, { id: "hidden" });
  const mine = item("note", 300, 0, { id: "mine" });
  const b = {
    ...newBoard("Staged"),
    shared: { server: "s", room: "r" },
    items: [hiddenNote, mine],
    workshop: { settings: { hide: ["hidden"] } },
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    assert.deepEqual(
      ui.api.visible(b.items).map((i) => i.id),
      ["mine"],
    );
    // Adding an object pushes it into the board's list in place.
    b.items.push(item("note", 600, 0, { id: "added" }));
    assert.deepEqual(
      ui.api.visible(b.items).map((i) => i.id),
      ["mine", "added"],
    );
  } finally {
    ui.close();
  }
});

test("starting the agenda starts a session without earlier attendance", () => {
  const record = (who, session) => ({
    by: who.uuid,
    name: who.username,
    role: "editor",
    session,
    first: 1,
    last: 2,
  });
  const b = {
    ...newBoard("Workshop"),
    shared: { server: "s", room: "r" },
    items: [item("frame", 0, 0, { w: 300, h: 200, text: "One", order: 0 })],
    workshop: {
      session: { id: "old", state: "ended", startedAt: 1, endedAt: 2 },
      [participantKey(editor.uuid)]: record(editor, "old"),
      [participantKey(viewer.uuid)]: record(viewer, "old"),
    },
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("agenda");
    ui.click('[data-fac="agenda-start"]');
    assert.equal(b.workshop.session.state, "active");
    assert.notEqual(b.workshop.session.id, "old");
    assert.deepEqual(
      Object.keys(b.workshop).filter((k) => k.startsWith("p:")),
      [],
    );
  } finally {
    ui.close();
  }
});

test("starting, ending and clearing a vote or poll moves focus to its heading or first field", () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  const ui = stubUI(b, { role: "owner", me: owner });
  const submit = (form) => {
    form.querySelector('[type="submit"]').focus();
    form.dispatchEvent(
      new ui.doc.defaultView.Event("submit", { cancelable: true }),
    );
  };
  const press = (action) => {
    const button = ui.doc.querySelector(`[data-fac="${action}"]`);
    button.focus();
    button.click();
  };
  const focused = () => ui.doc.activeElement;
  try {
    ui.api.open("vote");
    submit(ui.doc.querySelector("#fac-vote-form"));
    assert.equal(b.workshop.vote.state, "active");
    // The new vote's heading, above how many votes are left, rather than
    // the control drawn where the start button was.
    assert.equal(focused().tagName, "H3");
    assert.equal(focused().textContent, "Dot vote");
    assert.equal(focused().tabIndex, -1);
    press("vote-end");
    assert.equal(b.workshop.vote.state, "ended");
    assert.equal(focused().tagName, "H3");
    press("vote-clear");
    assert.equal(focused().id, "fac-vote-title", "a new vote starts at Title");
    ui.api.open("poll");
    ui.doc.querySelector("#fac-poll-question").value = "Keep the format?";
    ui.doc.querySelector("#fac-poll-options").value = "Yes\nNo";
    submit(ui.doc.querySelector("#fac-poll-form"));
    assert.equal(b.workshop.poll.state, "open");
    assert.equal(focused().tagName, "H3");
    assert.equal(focused().textContent, "Keep the format?");
    press("poll-close");
    assert.equal(focused().tagName, "H3");
    press("poll-clear");
    assert.equal(focused().id, "fac-poll-question");
  } finally {
    ui.close();
  }
});

test("facilitation actions keep keyboard focus and open sections in the panel", () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("session");
    const start = ui.doc.querySelector('[data-fac="session-start"]');
    start.focus();
    start.click();
    const panel = ui.doc.querySelector("#fac-tabpanel");
    assert.ok(panel.contains(ui.doc.activeElement), "focus stays in the panel");
    assert.equal(ui.doc.activeElement.disabled, false);
    b.items.push(
      item("frame", 0, 400, { w: 300, h: 200, text: "Step one", order: 0 }),
    );
    ui.api.open("agenda");
    const editor = ui.doc.querySelector("#fac-tabpanel details");
    editor.open = true;
    ui.api.render();
    ui.doc.querySelector('[data-fac="agenda-start"]')?.click();
    assert.equal(ui.doc.querySelector("#fac-tabpanel details").open, true);
  } finally {
    ui.close();
  }
});

test("participants' copies and exports keep no hidden text in saved results or the agenda", () => {
  const secret = item("note", 0, 0, { id: "s", text: "Answer key" });
  const frame = item("frame", 0, 400, {
    id: "f",
    w: 400,
    h: 400,
    text: "Round 2",
  });
  const inner = item("note", 10, 410, {
    id: "i",
    text: "Hidden idea",
    parentId: "f",
  });
  const open = item("note", 600, 0, { id: "o", text: "Open idea" });
  const record = (id, hidden) => ({
    kind: "vote",
    id,
    title: "T",
    startedAt: 1,
    endedAt: 2,
    anonymous: true,
    hidden,
    participants: 1,
    results: [
      { id: "s", label: "Answer key", count: 3 },
      { id: "i", label: "Hidden idea", count: 1 },
      { id: "o", label: "Open idea", count: 1 },
    ],
  });
  const b = {
    ...newBoard("W"),
    shared: { server: "x", room: "r" },
    items: [secret, frame, inner, open],
    workshop: {
      settings: { hide: ["s"], stage: { frames: ["f"], shown: 0 } },
      agenda: {
        steps: [{ frame: "f", minutes: 5, text: "Secret instructions" }],
      },
      [historyKey("v1")]: record("v1", true),
      [historyKey("v2")]: record("v2", false),
    },
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    const copy = structuredClone(b);
    ui.api.portableCopy(copy);
    const exported = structuredClone(b);
    ui.api.portable(exported);
    for (const result of [copy, exported]) {
      const text = JSON.stringify(result.workshop);
      assert.doesNotMatch(text, /Answer key|Hidden idea|Secret instructions/);
      assert.equal(result.workshop[historyKey("v1")], undefined);
      assert.deepEqual(
        result.workshop[historyKey("v2")].results.map((r) => r.label),
        ["Hidden by the facilitator", "Hidden by the facilitator", "Open idea"],
      );
      assert.equal(result.workshop.agenda.steps[0].minutes, 5);
      validateWorkshop(result.workshop);
    }
  } finally {
    ui.close();
  }
  // The facilitator's own copy keeps everything.
  const host = stubUI(b, { role: "owner", me: owner });
  try {
    const copy = structuredClone(b);
    host.api.portableCopy(copy);
    assert.match(JSON.stringify(copy.workshop), /Secret instructions/);
    assert.ok(copy.workshop[historyKey("v1")]);
  } finally {
    host.close();
  }
});

test("a vote for an object deleted afterwards can still be taken back", () => {
  const b = { ...newBoard("Vote"), items: notes(), shared: { room: "r" } };
  b.workshop = {
    vote: vote({ votes: 1, endsAt: 0 }),
    ...Object.fromEntries([ballot(editor, ["a"])]),
  };
  b.items = b.items.filter((i) => i.id !== "a");
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    ui.api.open("vote");
    const rows = [...ui.doc.querySelectorAll(".fac-vote-list li")];
    const removed = rows.find((r) => /Removed object/.test(r.textContent));
    assert.ok(removed, "The deleted object stays listed for its voter");
    assert.equal(
      removed
        .querySelector('[data-fac="vote-add"]')
        .getAttribute("aria-disabled"),
      "true",
    );
    removed.querySelector('[data-fac="vote-remove"]').click();
    assert.equal(b.workshop[voteKey("vote1", editor.uuid)], undefined);
    assert.match(ui.doc.querySelector("#fac-remaining").textContent, /1 of 1/);
    assert.ok(
      ![...ui.doc.querySelectorAll(".fac-vote-list li")].some((r) =>
        /Removed object/.test(r.textContent),
      ),
      "Once taken back, it is no longer listed",
    );
  } finally {
    ui.close();
  }
});

test("participants and latecomers go to the current agenda step on their own view", () => {
  const b = {
    ...newBoard("Agenda"),
    shared: { server: "https://x.puter.work", room: "room" },
    items: ["Welcome", "Ideas", "Vote"].map((text, n) =>
      item("frame", n * 900, 0, {
        id: `f${n}`,
        text,
        w: 800,
        h: 600,
        order: n,
      }),
    ),
  };
  for (const role of ["editor", "viewer"]) {
    delete b.workshop;
    const ui = stubUI(b, { role, me: role === "editor" ? editor : viewer });
    const go = () => ui.doc.querySelector('[data-fac="agenda-current"]');
    try {
      ui.api.open("agenda");
      assert.equal(go(), null, "No step to go to before the agenda starts");
      b.workshop = {
        run: {
          id: "run1",
          state: "running",
          step: 1,
          frame: "f1",
          startedAt: 1,
          stepAt: 1,
        },
      };
      ui.api.render();
      assert.equal(go().textContent, "Go to current step");
      const before = structuredClone(b.workshop);
      go().click();
      assert.deepEqual(ui.calls.focus, ["f1"]);
      assert.equal(ui.calls.bring, 0, "Only their own view moves");
      assert.deepEqual(b.workshop, before);
      b.workshop.run = { ...b.workshop.run, state: "ended" };
      ui.api.render();
      assert.equal(go(), null);
    } finally {
      ui.close();
    }
  }
});

test("a running agenda with every frame left out names no step", () => {
  const b = {
    ...newBoard("Agenda"),
    items: [item("frame", 0, 0, { id: "f0", text: "Intro", order: 0 })],
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("agenda");
    ui.click('[data-fac="agenda-start"]');
    assert.match(ui.doc.querySelector("#fac-tabpanel").textContent, /Step 1/);
    b.workshop = {
      ...b.workshop,
      agenda: { steps: [{ frame: "f0", skip: true }] },
    };
    ui.api.render();
    const panel = ui.doc.querySelector("#fac-tabpanel").textContent;
    assert.doesNotMatch(panel, /Step 0 of 0/);
    assert.match(panel, /All frames are excluded from the agenda/);
    assert.ok(ui.doc.querySelector('[data-fac="agenda-end"]'));
  } finally {
    ui.close();
  }
});

test("the agenda runs on imported frames whatever their IDs look like", () => {
  // Imported board files keep their own object IDs.
  const ids = ["Frame 1", "étape:2"];
  const b = {
    ...newBoard("Imported"),
    items: ids.map((id, n) =>
      item("frame", n * 600, 0, { id, text: id, order: n, w: 500 }),
    ),
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("agenda");
    ui.click('[data-fac="agenda-start"]');
    assert.deepEqual(ui.calls.toasts, []);
    assert.equal(b.workshop.run.frame, ids[0]);
    ui.click('[data-fac="agenda-next"]');
    assert.equal(b.workshop.run.frame, ids[1]);
    validateWorkshop(b.workshop);
  } finally {
    ui.close();
  }
});

test("the agenda stays on its frame when earlier frames are deleted or skipped", () => {
  const b = {
    ...newBoard("Agenda"),
    items: ["A", "B", "C", "D"].map((text, n) =>
      item("frame", n * 900, 0, { id: text, text, w: 800, h: 600, order: n }),
    ),
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("agenda");
    ui.click('[data-fac="agenda-start"]');
    ui.click('[data-fac="agenda-next"]');
    assert.match(ui.banner(), /Step 2 of 4: B/);
    b.items = b.items.filter((i) => i.id !== "A");
    ui.api.render();
    assert.match(ui.banner(), /Step 1 of 3: B/);
    ui.click('[data-fac="agenda-next"]');
    assert.match(ui.banner(), /Step 2 of 3: C/);
    assert.deepEqual(ui.calls.focus.at(-1), "C");
    // Skipping an earlier step in the agenda keeps the current one too.
    b.workshop = {
      ...b.workshop,
      agenda: { steps: [{ frame: "B", skip: true }] },
    };
    ui.api.render();
    assert.match(ui.banner(), /Step 1 of 2: C/);
    // If the current frame itself is deleted, the step at its place shows.
    b.items = b.items.filter((i) => i.id !== "C");
    ui.api.render();
    assert.match(ui.banner(), /Step 1 of 1: D/);
  } finally {
    ui.close();
  }
});

test("staging frames is announced as hiding, revealing, and showing all", () => {
  const b = {
    ...newBoard("Stage"),
    shared: { server: "x", room: "r" },
    items: ["A", "B"].map((text, n) =>
      item("frame", n * 900, 0, { id: text, text, w: 800, h: 600, order: n }),
    ),
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  const live = () => ui.doc.querySelector("#facilitation-live").textContent;
  const stage = (value) => {
    b.workshop = { settings: value ? { stage: value } : {} };
    ui.api.render();
    return live();
  };
  try {
    ui.api.render();
    assert.match(
      stage({ frames: ["A", "B"], shown: 0 }),
      /revealing frames one at a time/,
    );
    assert.equal(
      stage({ frames: ["A", "B"], shown: 1 }),
      "The facilitator revealed a frame: A",
    );
    assert.match(stage(null), /All frames are visible/);
  } finally {
    ui.close();
  }
});

test("a board lock tells each role what it can still do", () => {
  const announced = (role, lock) => {
    const b = {
      ...newBoard("Lock"),
      shared: { server: "x", room: "r" },
      items: [],
    };
    const ui = stubUI(b, { role, me: editor });
    try {
      ui.api.render();
      b.workshop = { settings: { lock } };
      ui.api.render();
      return ui.doc.querySelector("#facilitation-live").textContent;
    } finally {
      ui.close();
    }
  };
  assert.equal(
    announced("editor", "contribute"),
    "The board is locked. You can add sticky notes, vote, react, and comment.",
  );
  assert.equal(
    announced("commenter", "contribute"),
    "The board is locked. You can vote, react, and comment.",
  );
  assert.equal(announced("viewer", "contribute"), "The board is locked.");
  assert.equal(
    announced("commenter", "frozen"),
    "The board is frozen. You can vote, react, and comment.",
  );
  assert.equal(announced("viewer", "frozen"), "The board is frozen.");
});

test("a revealed frame is announced by the title participants now see, and ending the agenda is announced", () => {
  const b = {
    ...newBoard("Stage"),
    shared: { server: "x", room: "r" },
    items: ["Welcome", "Ideas", "Vote"].map((text, n) =>
      item("frame", n * 900, 0, {
        id: `f${n}`,
        text,
        w: 800,
        h: 600,
        order: n,
        ...(n === 1 ? { lang: "fr-CA" } : {}),
      }),
    ),
    workshop: {
      settings: { stage: { frames: ["f0", "f1", "f2"], shown: 0 } },
    },
  };
  const host = stubUI(b, { role: "owner", me: owner });
  const ui = stubUI(b, { role: "editor", me: editor });
  const live = () => ui.doc.querySelector("#facilitation-live");
  try {
    ui.api.render();
    host.api.open("session");
    host.click('[data-fac="stage-next"]');
    ui.api.render();
    assert.equal(
      live().textContent,
      "The facilitator revealed a frame: Welcome",
    );
    // The title keeps its language for screen readers.
    host.click('[data-fac="stage-next"]');
    ui.api.render();
    assert.equal(live().textContent, "The facilitator revealed a frame: Ideas");
    assert.equal(live().querySelector('[lang="fr-CA"]').textContent, "Ideas");
    // A frame revealed while still hidden by the facilitator is not named.
    b.workshop = {
      settings: {
        stage: { frames: ["f0", "f1", "f2"], shown: 2 },
        hide: ["f2"],
      },
    };
    ui.api.render();
    b.workshop = { settings: { hide: ["f2"] } };
    ui.api.render();
    assert.match(live().textContent, /All frames are visible/);
    b.workshop = {
      settings: {
        stage: { frames: ["f0", "f1", "f2"], shown: 0 },
        hide: ["f2"],
      },
    };
    ui.api.render();
    b.workshop = {
      settings: {
        stage: { frames: ["f2", "f0", "f1"], shown: 1 },
        hide: ["f2"],
      },
    };
    ui.api.render();
    assert.equal(
      live().textContent,
      "The facilitator revealed a frame: Hidden by the facilitator",
    );
    assert.doesNotMatch(live().textContent, /Vote/);
    // Going to a step names the frame once, in the step.
    b.workshop = {};
    ui.api.render();
    host.api.open("agenda");
    b.workshop = {
      settings: { stage: { frames: ["f0", "f1", "f2"], shown: 0 } },
    };
    host.api.render();
    ui.api.render();
    host.click('[data-fac="agenda-start"]');
    ui.api.render();
    assert.equal(live().textContent, "Step 1 of 3: Welcome");
    host.click('[data-fac="agenda-end"]');
    ui.api.render();
    assert.equal(live().textContent, "The agenda ended.");
  } finally {
    ui.close();
    host.close();
  }
});

test("hiding a large frame stores the frame, not each object in it", () => {
  const frame = item("frame", 0, 0, {
    id: "f",
    w: 5000,
    h: 5000,
    text: "Answers",
  });
  const inside = Array.from({ length: 600 }, (_, n) =>
    item("note", (n % 30) * 160, 100 + Math.floor(n / 30) * 160, {
      id: `n${n}`,
      parentId: "f",
    }),
  );
  const b = {
    ...newBoard("Big"),
    shared: { server: "x", room: "r" },
    items: [frame, ...inside],
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    const ids = ["f", ...inside.map((i) => i.id)];
    ui.api.setHidden(ids, true);
    assert.deepEqual(b.workshop.settings.hide, ["f"]);
    assert.ok(
      ids.every((id) => ui.api.hidden(id)),
      "Contents count as hidden",
    );
    assert.deepEqual(
      [...concealment(b, editor.uuid, false).hidden].length,
      601,
      "Participants see none of it",
    );
    ui.api.setHidden(ids, false);
    assert.deepEqual(b.workshop.settings?.hide || [], []);
  } finally {
    ui.close();
  }
});

test("the summary counts votes and polls that ended earlier in the session", () => {
  const b = { ...newBoard("Summary"), items: notes() };
  const record = (id, kind, results, extra = {}) => ({
    kind,
    id,
    title: id,
    startedAt: 2000,
    endedAt: 3000,
    anonymous: false,
    hidden: false,
    participants: 1,
    results,
    ...extra,
  });
  b.workshop = {
    session: { id: "s1", state: "active", startedAt: 1000 },
    [participantKey(owner.uuid)]: {
      by: owner.uuid,
      name: "Alice",
      role: "owner",
      session: "s1",
      first: 1000,
      last: 9000,
    },
    [participantKey(editor.uuid)]: {
      by: editor.uuid,
      name: "Bob",
      role: "editor",
      session: "s1",
      first: 1000,
      last: 9000,
    },
    // A poll and a vote that ended and were cleared for the next ones.
    [historyKey("p1")]: record("p1", "poll", [
      { id: "o1", label: "Yes", count: 1, voters: ["Bob"] },
      { id: "o2", label: "No", count: 0 },
    ]),
    [historyKey("v0")]: record(
      "v0",
      "vote",
      [{ id: "a", label: "Ship faster", count: 2, voters: ["Alice", "Bob"] }],
      { participants: 2 },
    ),
    // Before the session: not counted.
    [historyKey("old")]: record(
      "old",
      "vote",
      [{ id: "a", label: "Ship faster", count: 1, voters: ["Alice"] }],
      { endedAt: 500 },
    ),
    // A reaction from before the session: not counted either.
    [reactionKey(owner.uuid, objectTarget("a"))]: {
      by: owner.uuid,
      target: ["o", "a"],
      types: ["heart"],
      at: 500,
      name: "Alice",
    },
    vote: vote({ anonymous: false, startedAt: 4000 }),
    ...Object.fromEntries([ballot(owner, ["b"])]),
  };
  const summary = engagement(b, { now: 10000, label: (id) => id });
  assert.deepEqual(summary.reacted, []);
  assert.equal(summary.totals.reactions, 0);
  const row = (name) => summary.people.find((p) => p.name === name);
  assert.equal(row("Bob").answers, 1);
  assert.equal(row("Bob").votes, 1);
  assert.equal(row("Alice").votes, 1 + 1, "Earlier and current votes");
  assert.equal(summary.totals.participants, 2);
  assert.equal(summary.totals.votes, 2 + 1, "Objects voted for");
  assert.equal(summary.totals.answers, 1);
  assert.deepEqual(
    summary.voted.map((r) => [r.id, r.count]),
    [
      ["a", 2],
      ["b", 1],
    ],
    "A vote that ended before the session is not among the most voted",
  );
});

test("the most voted objects count only ballots cast in the session", () => {
  const b = { ...newBoard("Summary"), items: notes() };
  b.workshop = {
    session: { id: "s2", state: "active", startedAt: 5000 },
    // A vote that ended before this session is still on the Voting tab.
    vote: vote({ state: "ended", endedAt: 3000 }),
    ...Object.fromEntries([ballot(owner, ["a"]), ballot(editor, ["b"])]),
  };
  const summary = engagement(b, { now: 10000 });
  assert.equal(summary.totals.votes, 0);
  assert.deepEqual(summary.voted, []);
  // Ballots cast during the session count.
  b.workshop.session.startedAt = 1000;
  assert.deepEqual(
    engagement(b, { now: 10000 }).voted.map((r) => [r.id, r.count]),
    [
      ["a", 1],
      ["b", 1],
    ],
  );
});

test("the summary's activity chart counts an event at the session's end", () => {
  const b = { ...newBoard("Summary"), items: notes() };
  // Twelve whole minutes: the end falls on the edge of a thirteenth bucket.
  const end = 1000 + 12 * 60000;
  b.workshop = {
    session: { id: "s1", state: "ended", startedAt: 1000, endedAt: end },
    vote: vote({ startedAt: 1000 }),
    ...Object.fromEntries([
      [voteKey("vote1", owner.uuid), { ...ballot(owner, ["a"])[1], at: end }],
    ]),
  };
  const summary = engagement(b, { now: end + 5000 });
  assert.equal(summary.timeline.length, 12);
  assert.equal(summary.totals.votes, 1);
  assert.equal(
    summary.timeline.reduce((sum, bucket) => sum + bucket.votes, 0),
    1,
  );
});

test("summary totals add up the rows and count only sticky notes as notes", () => {
  const b = {
    ...newBoard("Summary"),
    items: [
      ...notes(),
      item("pen", 0, 0, {
        id: "p",
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
      item("arrow", 0, 0, { id: "ar" }),
    ],
  };
  b.workshop = {
    session: { id: "s1", state: "active", startedAt: 1000 },
    vote: vote({ anonymous: false, multiple: true, votes: 3 }),
    ...Object.fromEntries([
      ballot(editor, ["a", "a", "b"]),
      ballot(owner, ["c"]),
    ]),
    poll: {
      id: "p1",
      question: "Q",
      options: [
        { id: "o1", text: "Yes" },
        { id: "o2", text: "No" },
      ],
      multiple: false,
      anonymous: false,
      hidden: false,
      state: "open",
      revealed: false,
      startedAt: 1000,
    },
    [answerKey("p1", editor.uuid)]: {
      poll: "p1",
      by: editor.uuid,
      ids: ["o1"],
      at: 2000,
      name: "Bob",
    },
    [contributionKey("a")]: { by: editor.uuid, at: 1500, name: "Bob" },
    [contributionKey("p")]: { by: editor.uuid, at: 1500, name: "Bob" },
    [contributionKey("ar")]: { by: editor.uuid, at: 1500, name: "Bob" },
    [reactionKey(owner.uuid, objectTarget("a"))]: {
      by: owner.uuid,
      target: ["o", "a"],
      types: ["heart", "idea"],
      at: 2000,
      name: "Alice",
    },
  };
  validateWorkshop(b.workshop);
  const summary = engagement(b, { now: 5000 });
  const sum = (key) => summary.people.reduce((n, p) => n + p[key], 0);
  for (const key of ["notes", "reactions", "votes", "answers"]) {
    assert.equal(summary.totals[key], sum(key), key);
    assert.equal(
      summary.totals[key],
      summary.timeline.reduce((n, t) => n + t[key], 0),
      key,
    );
  }
  assert.equal(summary.totals.notes, 1, "Drawings and arrows are not notes");
  assert.equal(summary.totals.votes, 3);
  assert.equal(summary.totals.answers, 1);
  assert.equal(summary.totals.reactions, 2);
});

test("a person's votes in the summary stay the same once the vote is saved", () => {
  const b = { ...newBoard("Dots"), items: notes(), shared: { room: "r" } };
  const live = vote({ anonymous: false, multiple: true });
  b.workshop = {
    session: { id: "s1", state: "active", startedAt: 1000 },
    vote: live,
    ...Object.fromEntries([ballot(editor, ["a", "a", "a", "b"])]),
  };
  const votes = (board) =>
    engagement(board, { now: 10000 }).people.find((p) => p.name === "Bob")
      .votes;
  assert.equal(votes(b), 2);
  const saved = resultRecord(
    { ...b, workshop: { ...b.workshop, vote: { ...live, endedAt: 5000 } } },
    "vote",
    (id) => id,
  );
  b.workshop = {
    session: b.workshop.session,
    [historyKey(saved.id)]: saved,
  };
  assert.equal(votes(b), 2);
});

test("a vote revealed while another facilitator ended it shows its saved result", async () => {
  const b = { ...newBoard("Race"), items: notes(), shared: { room: "r" } };
  const ended = vote({ state: "ended", endedAt: 9000, revealed: true });
  b.workshop = {
    vote: ended,
    ...Object.fromEntries([ballot(editor, ["a"])]),
  };
  // As merged: the vote is revealed but its record was saved hidden.
  b.workshop[historyKey("vote1")] = {
    ...resultRecord(
      {
        ...b,
        workshop: { ...b.workshop, vote: { ...ended, revealed: false } },
      },
      "vote",
      (id) => id,
      9000,
    ),
  };
  assert.equal(b.workshop[historyKey("vote1")].hidden, true);
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.render();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(b.workshop[historyKey("vote1")].hidden, false);
  } finally {
    ui.close();
  }
});

test("a poll revealed while another facilitator closed it shows its saved result", async () => {
  const b = { ...newBoard("Race"), items: notes(), shared: { room: "r" } };
  const poll = {
    id: "p1",
    question: "Lunch?",
    options: [
      { id: "o1", text: "Yes" },
      { id: "o2", text: "No" },
    ],
    multiple: false,
    anonymous: true,
    hidden: true,
    state: "closed",
    revealed: true,
    startedAt: 1000,
    endedAt: 9000,
  };
  b.workshop = {
    poll,
    [answerKey("p1", editor.uuid)]: {
      poll: "p1",
      by: editor.uuid,
      ids: ["o1"],
      at: 2000,
    },
  };
  // As merged: the poll is revealed but its record was saved hidden.
  b.workshop[historyKey("p1")] = resultRecord(
    { ...b, workshop: { ...b.workshop, poll: { ...poll, revealed: false } } },
    "poll",
    (id) => id,
    9000,
  );
  assert.equal(b.workshop[historyKey("p1")].hidden, true);
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.render();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(b.workshop[historyKey("p1")].hidden, false);
  } finally {
    ui.close();
  }
});

test("restoring a deleted object during a session keeps its author", () => {
  const b = { ...newBoard("Undo"), items: notes() };
  b.workshop = {
    session: { id: "s1", state: "active", startedAt: 1000 },
    [contributionKey("a")]: { by: owner.uuid, at: 2000, name: "Alice" },
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    ui.api.beforeSave(null);
    const note = b.items.find((i) => i.id === "a");
    b.items = b.items.filter((i) => i !== note);
    ui.api.beforeSave(null);
    b.items.push(note);
    ui.api.beforeSave(null);
    assert.equal(b.workshop[contributionKey("a")].by, owner.uuid);
    // Once the session ends, records of removed objects are dropped.
    b.workshop = {
      ...b.workshop,
      session: { ...b.workshop.session, state: "ended", endedAt: 5000 },
    };
    b.items = b.items.filter((i) => i !== note);
    ui.api.beforeSave(null);
    assert.equal(b.workshop[contributionKey("a")], undefined);
  } finally {
    ui.close();
  }
});

test("the workshop banner sits below the selection toolbar", () => {
  const b = { ...newBoard("Banner"), items: notes() };
  b.workshop = { settings: { private: "r1" } };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    const wrap = ui.doc.querySelector(".canvas-wrap");
    const tools = ui.doc.createElement("div");
    tools.id = "selection-tools";
    wrap.append(tools);
    wrap.getBoundingClientRect = () => ({ top: 100, height: 800 });
    tools.getBoundingClientRect = () => ({
      top: 120,
      bottom: 240,
      height: 120,
    });
    ui.api.render();
    const banner = ui.doc.querySelector("#workshop-banner");
    assert.equal(banner.hidden, false);
    assert.equal(banner.style.top, "148px");
    tools.hidden = true;
    ui.api.render();
    assert.equal(banner.style.top, "", "Back in place without a toolbar");
  } finally {
    ui.close();
  }
});

test("built collaborators: a participant's note over a hidden frame stays theirs to see", async () => {
  const env = environment();
  env.service.now = () => Date.now();
  const initial = {
    version: 1,
    id: crypto.randomUUID(),
    title: "Hidden answers",
    items: [
      item("frame", -100000, -100000, {
        id: "answers",
        w: 200000,
        h: 200000,
        text: "Answers",
      }),
    ],
    workshop: { settings: { hide: ["answers"] } },
  };
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await env.service.call(owner, {
    op: "invite",
    room: initial.id,
    role: "editor",
  });
  const app = await setup(env.sdk(editor));
  try {
    await app.click('[data-action="join-shared"]');
    app.doc.querySelector("#join-link").value =
      `https://whiteboard.test/#server=https%3A%2F%2Fwhiteboard-test.puter.work&board=${initial.id}&invite=${invite.token}`;
    app.doc
      .querySelector("#join-link")
      .closest("form")
      .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
    await app.until(
      () =>
        !app.doc.querySelector("#join-link") &&
        app.doc.querySelector("#canvas"),
      "Joined",
    );
    app.sizeCanvas();
    assert.deepEqual(app.outline(), [], "The hidden frame is not shown");
    await app.addNote("My answer");
    await app.until(
      () => app.outline().some((t) => t.includes("My answer")),
      "The author still sees a note added over the hidden frame",
    );
    let saved;
    const deadline = Date.now() + 8000;
    while (!saved && Date.now() < deadline) {
      const { doc } = await env.service.load(initial.id);
      saved = doc.snapshot().items.find((i) => i.text === "My answer");
      doc.destroy();
      if (!saved) await app.tick();
    }
    assert.ok(saved, "The note is saved");
    assert.equal(saved.parentId, undefined, "It is not put in the frame");
    // Library content inserted there stays visible too.
    await app.click('[data-action="more-tools"]');
    await app.click('[data-feature="icons"]');
    // The library reads saved templates before it shows its icons.
    await app.until(
      () => app.doc.querySelector('[data-icon="sticker-thumbs-up"]'),
      "The icon library opens",
    );
    await app.click('[data-icon="sticker-thumbs-up"]');
    await app.until(
      () => app.outline().some((t) => t.includes("Thumbs up")),
      "An inserted icon over the hidden frame stays visible",
    );

    await app.click(`#board-outline [data-id="${saved.id}"]`);
    // Nor is the hidden frame offered to move the note into.
    await app.click('#selection-tools [data-action="organize"]');
    assert.deepEqual(
      [...app.doc.querySelectorAll("#parent-frame input[type=radio]")].map(
        (o) => o.value,
      ),
      [""],
    );
    // Let the save that brought the note to the board finish.
    for (let n = 0; n < 8; n++) await app.tick();
  } finally {
    app.close();
  }
});

test("under a lock, connectors may follow the objects they join", async () => {
  const { updateConnectors } = await import("../src/scene.js");
  const mine = item("note", 0, 0, { id: "mine" });
  const theirs = item("note", 600, 0, { id: "theirs" });
  const line = item("arrow", 0, 0, {
    id: "line",
    startId: "mine",
    endId: "theirs",
  });
  const loose = item("arrow", 0, 300, { id: "loose", w: 200, h: 0 });
  const before = {
    title: "T",
    items: [mine, theirs, line, loose],
    workshop: {
      settings: { lock: "contribute" },
      [contributionKey("mine")]: { by: editor.uuid, at: 1, name: "Bob" },
    },
  };
  updateConnectors(before.items);
  const change = (edit) => {
    const after = structuredClone(before);
    const byId = new Map(after.items.map((i) => [i.id, i]));
    edit(byId);
    updateConnectors(after.items);
    return () => validateWorkshopChanges(before, after, editor, "editor");
  };
  // Moving your own note re-routes the line attached to it.
  change((byId) => (byId.get("mine").y += 150))();
  // A line whose stored route was out of date is re-routed by any save.
  before.items.find((i) => i.id === "theirs").y = 400;
  change(() => {})();
  // Other changes to someone else's line are still refused.
  for (const edit of [
    (byId) => (byId.get("line").color = "#ff0000"),
    (byId) => delete byId.get("line").endId,
    (byId) => (byId.get("loose").w = 400),
    (byId) => (byId.get("theirs").x += 50),
  ])
    assert.throws(change(edit), /only change your own sticky notes/);
});

test("facilitators are offered to reveal or hide results only when that changes what participants see", () => {
  const panel = (b, role, me) => {
    const ui = stubUI(b, { role, me });
    ui.api.open(b.workshop.poll ? "poll" : "vote");
    const el = ui.doc.querySelector("#fac-tabpanel");
    const result = {
      text: el.textContent,
      toggle: el.querySelector('[data-fac$="-reveal"], [data-fac$="-hide"]')
        ?.dataset.fac,
    };
    ui.close();
    return result;
  };
  const withVote = (extra) => ({
    ...newBoard("Workshop"),
    items: notes(),
    shared: { room: "r" },
    workshop: { vote: vote(extra) },
  });
  // Results shown once the vote ends: there is nothing to reveal or hide.
  const shown = withVote({ hidden: false, state: "ended", endedAt: 3000 });
  const facilitator = panel(shown, "owner", owner);
  assert.equal(facilitator.toggle, undefined);
  assert.doesNotMatch(facilitator.text, /Only facilitators can see/);
  assert.doesNotMatch(
    panel(shown, "editor", editor).text,
    /Results are hidden/,
  );
  // While the vote runs, or when results stay hidden, the choice matters.
  assert.equal(
    panel(withVote({ hidden: false }), "owner", owner).toggle,
    "vote-reveal",
  );
  const hidden = withVote({ state: "ended", endedAt: 3000 });
  assert.equal(panel(hidden, "owner", owner).toggle, "vote-reveal");
  assert.match(panel(hidden, "owner", owner).text, /Only facilitators can see/);
  hidden.workshop.vote.revealed = true;
  assert.equal(panel(hidden, "owner", owner).toggle, "vote-hide");
  // The same for a poll.
  const poll = (extra) => ({
    ...newBoard("Workshop"),
    items: notes(),
    shared: { room: "r" },
    workshop: {
      poll: {
        id: "p1",
        question: "Lunch?",
        options: [
          { id: "o1", text: "Yes" },
          { id: "o2", text: "No" },
        ],
        multiple: false,
        anonymous: true,
        hidden: false,
        state: "closed",
        revealed: false,
        startedAt: 1000,
        ...extra,
      },
    },
  });
  assert.equal(panel(poll({}), "owner", owner).toggle, undefined);
  assert.equal(
    panel(poll({ hidden: true }), "owner", owner).toggle,
    "poll-reveal",
  );
  assert.equal(
    panel(poll({ state: "open" }), "owner", owner).toggle,
    "poll-reveal",
  );
});

test("staging more frames than can be revealed one at a time is refused", () => {
  const b = {
    ...newBoard("Stage"),
    shared: { server: "x", room: "r" },
    items: Array.from({ length: 62 }, (_, n) =>
      item("frame", n * 900, 0, { text: `Step ${n + 1}`, order: n }),
    ),
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("session");
    ui.doc.querySelector('[data-fac="stage-start"]').click();
    assert.equal(b.workshop?.settings?.stage, undefined);
    assert.match(
      ui.doc.querySelector("#fac-error").textContent,
      /up to 60 frames/,
    );
    // Leaving two out stages the rest, every one of them hidden.
    const boxes = ui.doc.querySelectorAll("#fac-stage-frames input");
    boxes[0].checked = boxes[1].checked = false;
    ui.doc.querySelector('[data-fac="stage-start"]').click();
    assert.equal(b.workshop.settings.stage.frames.length, 60);
  } finally {
    ui.close();
  }
});

test("revealing staged frames passes over deleted ones and names the next frame", () => {
  const b = {
    ...newBoard("Stage"),
    shared: { server: "x", room: "r" },
    items: ["Welcome", "Ideas", "Vote", "Wrap-up"].map((text, n) =>
      item("frame", n * 900, 0, {
        id: `f${n}`,
        text,
        w: 800,
        h: 600,
        order: n,
      }),
    ),
    workshop: {
      settings: { stage: { frames: ["f0", "f1", "f2", "f3"], shown: 0 } },
    },
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  const next = () => ui.doc.querySelector('[data-fac="stage-next"]');
  const status = () =>
    ui.doc.querySelector('[data-fac="stage-next"]').closest(".fac-actions")
      .previousElementSibling.textContent;
  try {
    b.items = b.items.filter((i) => i.id !== "f0" && i.id !== "f2");
    ui.api.open("session");
    assert.match(status(), /0 of 2 staged frames/);
    assert.equal(next().textContent, "Reveal next frame: Ideas");
    next().click();
    assert.equal(b.workshop.settings.stage.shown, 2);
    assert.deepEqual(ui.calls.focus, ["f1"]);
    assert.equal(ui.calls.bring, 1);
    assert.deepEqual(
      [...concealment(b, editor.uuid, false).frames],
      ["f2", "f3"],
    );
    assert.match(status(), /1 of 2 staged frames/);
    assert.equal(next().textContent, "Reveal next frame: Wrap-up");
    // Revealing the last frame left shows them all.
    next().click();
    assert.deepEqual(ui.calls.focus, ["f1", "f3"]);
    assert.equal(b.workshop.settings.stage, undefined);
  } finally {
    ui.close();
  }
});

test("a face-down private note shows none of its tags or link", () => {
  const other = {
    uuid: "55555555-5555-4555-8555-555555555555",
    username: "Cy",
  };
  const b = {
    ...newBoard("Private"),
    shared: { room: "r" },
    tags: [{ id: "t1", name: "Complaint", color: "#e03131" }],
    items: [
      item("note", 0, 0, {
        id: "n",
        text: "My idea",
        tagIds: ["t1"],
        objectLink: { url: "https://example.com/evidence" },
      }),
    ],
    workshop: {
      settings: { private: "r1" },
      [contributionKey("n")]: {
        by: other.uuid,
        at: 5,
        name: "Cy",
        round: "r1",
      },
    },
  };
  validateBoard(structuredClone(b));
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    const [shown] = ui.api.conceal(b.items);
    assert.equal(shown.text, "Private note");
    assert.equal(shown.tagIds, undefined);
    assert.equal(shown.objectLink, undefined);
    const exported = structuredClone(b);
    ui.api.portable(exported);
    assert.equal(exported.items[0].tagIds, undefined);
    assert.equal(exported.items[0].objectLink, undefined);
    // The author still sees their own note in full.
    const author = stubUI(b, { role: "editor", me: other });
    assert.deepEqual(author.api.conceal(b.items)[0].tagIds, ["t1"]);
    author.close();
  } finally {
    ui.close();
  }
});

test("facilitators see which objects are hidden from participants", () => {
  const b = {
    ...newBoard("Hide"),
    shared: { room: "r" },
    items: [
      item("frame", 0, 0, { id: "f", w: 400, h: 300, text: "Answers" }),
      item("note", 500, 0, { id: "n", text: "Hint" }),
      item("note", 800, 0, { id: "shown", text: "Visible" }),
    ],
    workshop: { settings: { hide: ["f", "n"] } },
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.render();
    const marked = (id) =>
      ui.doc.querySelector(`[data-fac-item="${id}"] .fac-staged`)?.textContent;
    assert.match(marked("f"), /Hidden from participants/);
    assert.match(marked("n"), /Hidden from participants/);
    assert.equal(marked("shown"), undefined);
    b.workshop = { settings: { hide: ["f"] } };
    ui.api.render();
    assert.equal(marked("n"), undefined);
  } finally {
    ui.close();
  }
});

test("built collaborators: adding a note to a frozen board says why it was not added", async () => {
  const env = environment();
  env.service.now = () => Date.now();
  const initial = {
    version: 1,
    id: crypto.randomUUID(),
    title: "Frozen",
    items: [],
    workshop: { settings: { lock: "frozen" } },
  };
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await env.service.call(owner, {
    op: "invite",
    room: initial.id,
    role: "editor",
  });
  const app = await setup(env.sdk(editor));
  try {
    await app.click('[data-action="join-shared"]');
    app.doc.querySelector("#join-link").value =
      `https://whiteboard.test/#server=https%3A%2F%2Fwhiteboard-test.puter.work&board=${initial.id}&invite=${invite.token}`;
    app.doc
      .querySelector("#join-link")
      .closest("form")
      .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
    await app.until(
      () =>
        !app.doc.querySelector("#join-link") &&
        app.doc.querySelector("#canvas"),
      "Joined",
    );
    app.sizeCanvas();
    app.key("n");
    await app.tick();
    assert.equal(app.doc.querySelector("#canvas-text-editor"), null);
    assert.equal(
      app.doc.querySelector("#toast").textContent,
      "The facilitator froze this board.",
    );
    assert.deepEqual(app.outline(), []);
    for (let n = 0; n < 8; n++) await app.tick();
  } finally {
    app.close();
  }
});

test("built collaborators: a facilitator's selection does not show where hidden objects are", async () => {
  const env = environment(),
    hub = createPeerHub();
  env.service.now = () => Date.now();
  const key = item("note", 0, 0, { text: "Answer key" });
  const shown = item("note", 400, 0, { text: "Question" });
  const initial = {
    version: 1,
    id: crypto.randomUUID(),
    title: "Quiz",
    items: [key, shown],
    workshop: { settings: { hide: [key.id] } },
  };
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await env.service.call(owner, {
    op: "invite",
    room: initial.id,
    role: "editor",
  });
  const apps = [];
  try {
    for (const [user, token] of [
      [owner, ""],
      [editor, invite.token],
    ]) {
      const sdk = env.sdk(user);
      sdk.peer = hub.peer;
      const app = await setup(sdk);
      apps.push(app);
      await app.click('[data-action="join-shared"]');
      app.doc.querySelector("#join-link").value =
        `https://whiteboard.test/#server=https%3A%2F%2Fwhiteboard-test.puter.work&board=${initial.id}&invite=${token}`;
      app.doc
        .querySelector("#join-link")
        .closest("form")
        .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
      await app.until(
        () =>
          !app.doc.querySelector("#join-link") &&
          app.doc.querySelector("#canvas"),
        "Joined",
      );
      app.sizeCanvas();
      await app.click('[data-action="fit"]');
    }
    const [facilitator, participant] = apps;
    await facilitator.until(
      () => facilitator.outline().length === 2,
      "The facilitator sees the hidden note",
    );
    await facilitator.click('[data-action="participants"]');
    await facilitator.until(
      () =>
        [...facilitator.doc.querySelectorAll(".live-participant-row")].some(
          (row) =>
            row.textContent.includes(editor.username) &&
            row.querySelector("[data-follow]")?.disabled === false,
        ),
      "The participant is connected",
    );
    facilitator.doc.querySelector("dialog[open]")?.close();
    facilitator.key("a", { ctrlKey: true });
    // Moving the pointer shares the selection with the others.
    const move = new facilitator.w.MouseEvent("pointermove", {
      clientX: 800,
      clientY: 850,
      bubbles: true,
    });
    Object.defineProperties(move, {
      pointerId: { value: 1 },
      pointerType: { value: "mouse" },
    });
    facilitator.doc.querySelector("#canvas").dispatchEvent(move);
    const boxes = () =>
      participant.doc.querySelectorAll(".participant-selection").length;
    await participant.until(() => boxes(), "The selection is shown");
    for (let n = 0; n < 8; n++) await participant.tick();
    assert.equal(boxes(), 1, "Only the visible note is outlined");
  } finally {
    for (const app of apps) app.close();
  }
});

// The owner and an editor on one shared board, both joined and linked.
async function liveRoom(env, hub, initial) {
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await env.service.call(owner, {
    op: "invite",
    room: initial.id,
    role: "editor",
  });
  const apps = [];
  for (const [user, token] of [
    [owner, ""],
    [editor, invite.token],
  ]) {
    const sdk = env.sdk(user);
    sdk.peer = hub.peer;
    const app = await setup(sdk);
    apps.push(app);
    await app.click('[data-action="join-shared"]');
    app.doc.querySelector("#join-link").value =
      `https://whiteboard.test/#server=https%3A%2F%2Fwhiteboard-test.puter.work&board=${initial.id}&invite=${token}`;
    app.doc
      .querySelector("#join-link")
      .closest("form")
      .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
    await app.until(
      () =>
        !app.doc.querySelector("#join-link") &&
        app.doc.querySelector("#canvas"),
      "Joined",
    );
    app.sizeCanvas();
  }
  // Peer links come some seconds after joining.
  for (const app of apps)
    await app.until(
      () => app.doc.querySelector(".participants .live-note") === null,
      "Linked",
      30000,
    );
  return apps;
}

test("built collaborators: a live reaction floats up for everyone, named unless input is anonymous", async () => {
  const env = environment(),
    hub = createPeerHub();
  env.service.now = () => Date.now();
  const initial = {
    version: 1,
    id: crypto.randomUUID(),
    title: "Retro",
    items: [],
  };
  const apps = [];
  try {
    apps.push(...(await liveRoom(env, hub, initial)));
    const [facilitator, participant] = apps;
    const control = participant.doc.querySelector('[data-action="live"]');
    assert.equal(control.hidden, false, "Shown on a shared board");
    await participant.click('[data-action="live"]');
    const heart = () =>
      participant.doc.querySelector('[data-live-reaction="heart"]');
    await participant.until(
      () => heart() && !heart().disabled,
      "Reactions go once linked",
      30000,
    );
    await participant.audit("#live-popover");
    heart().click();
    const floating = (app) => [
      ...app.doc.querySelectorAll(".canvas-wrap .live-reaction"),
    ];
    assert.equal(floating(participant).length, 1, "The sender sees it too");
    await facilitator.until(
      () => floating(facilitator).length === 1,
      "The reaction reaches the others",
      30000,
    );
    let [node] = floating(facilitator);
    assert.equal(node.querySelector(".live-reaction-emoji").textContent, "❤️");
    assert.equal(node.querySelector(".live-reaction-name").textContent, "Bob");
    assert.equal(
      facilitator.doc.querySelector("#canvas-text-editor"),
      null,
      "Nothing was added to the board",
    );
    assert.equal(facilitator.outline().length, 0);
    // Anonymous input hides who sent a reaction, from everyone.
    await facilitator.click('[data-action="facilitation"]');
    const anonymous = facilitator.doc.querySelector("#fac-anonymous");
    anonymous.checked = true;
    anonymous.dispatchEvent(
      new facilitator.w.Event("change", { bubbles: true }),
    );
    await participant.until(
      () =>
        participant.doc
          .querySelector("#workshop-banner")
          ?.textContent.includes("Anonymous input"),
      "Anonymous input reaches the participant",
      15000,
    );
    participant.doc
      .querySelector('[data-live-reaction="idea"]')
      .dispatchEvent(new participant.w.MouseEvent("click", { bubbles: true }));
    await facilitator.until(
      () =>
        floating(facilitator).some(
          (n) => n.querySelector(".live-reaction-emoji").textContent === "💡",
        ),
      "The anonymous reaction arrives",
      15000,
    );
    node = floating(facilitator).find(
      (n) => n.querySelector(".live-reaction-emoji").textContent === "💡",
    );
    assert.equal(node.querySelector(".live-reaction-name"), null);
    assert.equal(
      env.calls.filter((c) => c.op === "commit" && c.user === editor.uuid)
        .length,
      0,
      "Reactions are never saved",
    );
  } finally {
    for (const app of apps) app.close();
  }
});

test("built collaborators: a participant raises a hand, the facilitator sees it and lowers it, and it goes when they leave", async () => {
  const env = environment(),
    hub = createPeerHub();
  env.service.now = () => Date.now();
  const initial = {
    version: 1,
    id: crypto.randomUUID(),
    title: "Town hall",
    items: [],
  };
  const apps = [];
  try {
    apps.push(...(await liveRoom(env, hub, initial)));
    const [facilitator, participant] = apps;
    await participant.click('[data-action="live"]');
    const hand = () => participant.doc.querySelector("[data-live-hand]");
    await participant.until(
      () => hand() && !hand().disabled,
      "Hands go up once linked",
      30000,
    );
    hand().click();
    assert.equal(hand().getAttribute("aria-pressed"), "true");
    const badge = () =>
      facilitator.doc.querySelector(".participants .hand-count");
    await facilitator.until(
      () => badge()?.textContent.includes("1"),
      "The facilitator sees a count of raised hands",
      15000,
    );
    assert.match(
      facilitator.doc.querySelector(".participants").textContent,
      /1 raised hand/,
    );
    assert.equal(
      participant.doc.querySelector(".participants .hand-count"),
      null,
      "Only facilitators get the count",
    );
    await facilitator.until(
      () =>
        facilitator.doc
          .querySelector("#board-announcer")
          ?.textContent.includes("Hand raised: Bob"),
      "The facilitator hears it",
    );
    // Participants lists the hand, in order, with a way to lower it.
    await facilitator.click('[data-action="participants"]');
    const section = () => facilitator.doc.querySelector("#raised-hands");
    await facilitator.until(
      () => section() && !section().hidden,
      "Raised hands in Participants",
    );
    assert.equal(section().querySelector("li span").textContent, "Bob");
    await facilitator.audit("#raised-hands");
    section().querySelector("li [data-lower-hand]").click();
    await participant.until(
      () => hand().getAttribute("aria-pressed") === "false",
      "The participant's hand went down",
      15000,
    );
    await participant.until(
      () =>
        participant.doc
          .querySelector("#board-announcer")
          ?.textContent.includes("A facilitator lowered your hand."),
      "The participant is told",
    );
    await facilitator.until(() => !badge(), "The count goes", 15000);
    facilitator.doc.querySelector("dialog[open]")?.close();
    // The People tab lists it too, and the hand goes when they leave.
    hand().click();
    await facilitator.click('[data-action="facilitation"]');
    await facilitator.click("#fac-tab-people");
    const people = () => facilitator.doc.querySelector("#fac-hands");
    await facilitator.until(
      () => people() && !people().hidden,
      "Raised hands in the People tab",
      15000,
    );
    assert.ok(
      facilitator.doc.querySelector(
        `[data-fac-person="${editor.uuid}"] .raised-hand-badge`,
      ),
    );
    await participant.click('[data-action="home"]');
    await facilitator.until(
      () => people()?.hidden !== false && !badge(),
      "The hand leaves with the participant",
      15000,
    );
    assert.equal(
      env.calls.filter((c) => c.op === "commit" && c.user === editor.uuid)
        .length,
      0,
      "Raised hands are never saved",
    );
  } finally {
    for (const app of apps) app.close();
  }
});

test("built app: a personal board suggests no one from the shared board left", async () => {
  const env = environment();
  env.service.now = () => Date.now();
  const note = item("note", 0, 0, { text: "Shared" });
  const initial = {
    version: 1,
    id: crypto.randomUUID(),
    title: "Team",
    items: [note],
  };
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await env.service.call(owner, {
    op: "invite",
    room: initial.id,
    role: "editor",
  });
  const app = await setup(env.sdk(editor));
  const suggestions = async () => {
    await app.click('[data-action="add-comment"]');
    const input = app.doc.querySelector("#comment-text");
    input.value = "@";
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new app.w.Event("input", { bubbles: true }));
    await app.tick();
    const list = input.parentElement.querySelector(".mention-list");
    const names = list.hidden
      ? []
      : [...list.children].map((li) => li.textContent);
    input.value = "";
    input.dispatchEvent(new app.w.Event("input", { bubbles: true }));
    await app.click("#comments-close");
    return names;
  };
  try {
    await app.click('[data-action="join-shared"]');
    app.doc.querySelector("#join-link").value =
      `https://whiteboard.test/#server=https%3A%2F%2Fwhiteboard-test.puter.work&board=${initial.id}&invite=${invite.token}`;
    app.doc
      .querySelector("#join-link")
      .closest("form")
      .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
    await app.until(
      () =>
        !app.doc.querySelector("#join-link") &&
        app.doc.querySelector("#canvas"),
      "Joined",
    );
    app.sizeCanvas();
    await app.click(`#board-outline [data-id="${note.id}"]`);
    let names = [];
    const deadline = Date.now() + 8000;
    while (!names.length && Date.now() < deadline) names = await suggestions();
    assert.deepEqual(names, [`@${owner.username}`], "Members are suggested");
    // Someone who joins later can be mentioned without reopening the board.
    const later = await env.service.call(owner, {
      op: "invite",
      room: initial.id,
      role: "commenter",
    });
    await env.service.call(viewer, {
      op: "join",
      room: initial.id,
      token: later.token,
    });
    const joined = `@${viewer.username}`,
      until = Date.now() + 8000;
    while (!names.includes(joined) && Date.now() < until)
      names = await suggestions();
    assert.ok(names.includes(joined), names.join(", "));
    await app.click('[data-action="home"]');
    await app.until(() => app.doc.querySelector('[data-action="new"]'), "Home");
    await app.click('[data-action="new"]');
    await app.until(() => app.doc.querySelector("#canvas"), "Board opened");
    app.sizeCanvas();
    await app.addNote("Mine");
    await app.until(() => app.outline().length === 1, "A note");
    await app.click("#board-outline button");
    assert.deepEqual(await suggestions(), []);
  } finally {
    app.close();
  }
});

test("built collaborators: links, comment pins, and the frame list respect content hidden from participants", async () => {
  const env = environment();
  env.service.now = () => Date.now();
  const key = item("note", 0, 0, { text: "Answer key" });
  const shown = item("note", 400, 0, {
    text: "Question",
    objectLink: { objectId: key.id },
  });
  const author = { id: owner.uuid, name: owner.username };
  const initial = {
    version: 1,
    id: crypto.randomUUID(),
    title: "Quiz",
    items: [
      key,
      shown,
      item("frame", 0, 400, {
        id: "one",
        w: 300,
        h: 200,
        text: "One",
        order: 0,
      }),
      item("frame", 400, 400, {
        id: "two",
        w: 300,
        h: 200,
        text: "Two",
        order: 1,
      }),
      item("frame", 800, 400, {
        id: "three",
        w: 300,
        h: 200,
        text: "Three",
        order: 2,
      }),
    ],
    comments: [
      commentThread({ x: 20, y: 20 }, author, "About the key", key),
      commentThread({ x: 420, y: 20 }, author, "About the question", shown),
    ],
    workshop: { settings: { hide: [key.id, "two"] } },
  };
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await env.service.call(owner, {
    op: "invite",
    room: initial.id,
    role: "editor",
  });
  const app = await setup(env.sdk(editor));
  try {
    await app.click('[data-action="join-shared"]');
    app.doc.querySelector("#join-link").value =
      `https://whiteboard.test/#server=https%3A%2F%2Fwhiteboard-test.puter.work&board=${initial.id}&invite=${invite.token}&object=${key.id}`;
    app.doc
      .querySelector("#join-link")
      .closest("form")
      .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
    await app.until(
      () =>
        !app.doc.querySelector("#join-link") &&
        app.doc.querySelector("#canvas"),
      "Joined",
    );
    app.sizeCanvas();
    // A link to hidden content does not select it, nor call it deleted.
    assert.equal(app.doc.querySelector("#selection-tools").hidden, true);
    assert.equal(
      app.doc.querySelector("#toast").textContent,
      "The linked part of the board is not shown yet.",
    );
    await app.click('[data-action="fit"]');
    await app.click(`#board-outline [data-id="${shown.id}"]`);
    await app.click("#object-link-access");
    assert.equal(
      app.doc.querySelector("#object-link-current a").textContent,
      "Go to linked object",
    );
    assert.ok(
      !app.doc
        .querySelector("#object-links-panel")
        .textContent.includes(key.text),
      "Neither the preview nor the destination picker reveals hidden content",
    );
    await app.click("#object-link-close");
    const pins = () =>
      [...app.doc.querySelectorAll("#comment-pins > *")].map(
        (p) => p.getAttribute("aria-label") || p.textContent,
      );
    await app.until(() => pins().length, "Comment pins are shown");
    assert.deepEqual(pins(), ["Comment: About the question"]);
    // Opening the other thread from the list leaves the view where it is.
    const pin = app.doc.querySelector("#comment-pins > *");
    const where = [pin.style.left, pin.style.top];
    await app.click('[data-action="comments"]');
    const hiddenThread = [
      ...app.doc.querySelectorAll("#comments-panel [data-thread]"),
    ].find((el) => el.textContent.includes("About the key"));
    assert.ok(hiddenThread, "The thread is listed");
    hiddenThread.click();
    await app.tick();
    const moved = app.doc.querySelector("#comment-pins > *");
    assert.deepEqual([moved.style.left, moved.style.top], where);
    // Frames keep their order while one is hidden, and the list says why.
    await app.click('[data-action="frames"]');
    const list = app.doc.querySelector(".frame-list");
    assert.deepEqual(
      [...list.querySelectorAll(".frame-row strong")].map((s) => s.textContent),
      ["One", "Three"],
    );
    assert.ok(
      [...list.querySelectorAll("[data-order]")].every((b) => b.disabled),
    );
    assert.match(list.textContent, /once the facilitator shows every frame/);
    // Section links in the Share dialog do not name the hidden frame.
    await app.click('[data-action="share"]');
    await confirmShare(app);
    await app.until(() => app.doc.querySelector("#share-link"), "Share dialog");
    const scope = app.doc.querySelector("#share-scope");
    assert.ok(scope, "Section links are offered");
    assert.deepEqual(
      [...scope.options].map((o) => o.value),
      ["", "one", "three"],
    );
    assert.doesNotMatch(scope.textContent, /Two/);
  } finally {
    app.close();
  }
});

test("built viewer text link previews close when a facilitator hides their object", async () => {
  const env = environment();
  env.service.now = () => Date.now();
  const note = item("note", 0, 0, {
      text: "Confidential reference",
      textRuns: [
        { start: 0, end: 22, style: { link: "https://example.com/private" } },
      ],
    }),
    room = await createRoom(env.service, [note]),
    { token } = await env.service.call(owner, {
      op: "invite",
      room,
      role: "viewer",
    }),
    app = await setup(env.sdk(viewer));
  try {
    await app.click('[data-action="join-shared"]');
    app.doc.querySelector("#join-link").value =
      `https://whiteboard.test/#server=https%3A%2F%2Fwhiteboard-test.puter.work&board=${room}&invite=${token}`;
    app.doc
      .querySelector("#join-link")
      .closest("form")
      .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
    await app.until(
      () =>
        !app.doc.querySelector("#join-link") &&
        app.doc.querySelector("#canvas"),
      "Joined",
    );
    app.sizeCanvas();
    await app.click(`#board-outline [data-id="${note.id}"]`);
    await app.click("#text-link-access");
    assert.equal(
      app.doc.querySelector("#text-link-preview a").href,
      "https://example.com/private",
    );
    // Screen readers have been told what is selected, in its words.
    await app.until(
      () =>
        app.doc
          .querySelector("#board-announcer")
          .textContent.includes("Confidential reference"),
      "The selection is announced",
    );
    await commit(env.service, owner, room, (_, workshop) => {
      workshop.settings = { hide: [note.id] };
    });
    await app.until(
      () => !app.doc.querySelector(`#board-outline [data-id="${note.id}"]`),
      "Hidden object disappears from the viewer's board",
    );
    assert.equal(app.doc.querySelector("#text-link-preview"), null);
    assert.ok(!app.doc.body.textContent.includes("Confidential reference"));
  } finally {
    app.close();
  }
});

test("built collaborators: undo on a frozen board is refused and kept for later", async () => {
  const env = environment();
  env.service.now = () => Date.now();
  const initial = {
    version: 1,
    id: crypto.randomUUID(),
    title: "Freeze",
    items: [],
  };
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await env.service.call(owner, {
    op: "invite",
    room: initial.id,
    role: "editor",
  });
  const lock = async (value) => {
    const { doc } = await env.service.load(initial.id);
    const vector = doc.vector(),
      next = doc.snapshot();
    next.workshop = { ...next.workshop, settings: { lock: value } };
    doc.commit(next);
    const update = doc.update(vector);
    doc.destroy();
    await env.service.call(owner, {
      op: "commit",
      room: initial.id,
      id: await hash(update),
      update: encode(update),
    });
  };
  const app = await setup(env.sdk(editor));
  try {
    await app.click('[data-action="join-shared"]');
    app.doc.querySelector("#join-link").value =
      `https://whiteboard.test/#server=https%3A%2F%2Fwhiteboard-test.puter.work&board=${initial.id}&invite=${invite.token}`;
    app.doc
      .querySelector("#join-link")
      .closest("form")
      .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
    await app.until(
      () =>
        !app.doc.querySelector("#join-link") &&
        app.doc.querySelector("#canvas"),
      "Joined",
    );
    app.sizeCanvas();
    await app.addNote("Mine");
    await app.until(() => app.outline().length === 1, "Note added");
    // The note reaches the worker before the owner freezes the board.
    for (let n = 0; n < 200; n++) {
      const { doc } = await env.service.load(initial.id);
      const saved = doc.snapshot().items.length;
      doc.destroy();
      if (saved) break;
      await app.tick();
    }
    await lock("frozen");
    await app.until(
      () =>
        /frozen/i.test(app.doc.querySelector("#workshop-banner").textContent),
      "The freeze reaches the editor",
    );
    app.key("z", { ctrlKey: true });
    await app.tick();
    assert.match(app.outline()[0], /Mine/, "The text stays");
    assert.equal(
      app.doc.querySelector("#toast").textContent,
      "The facilitator froze this board.",
    );
    await lock("open");
    await app.until(
      () =>
        !/frozen/i.test(
          app.doc.querySelector("#workshop-banner")?.textContent || "",
        ),
      "The board opens again",
    );
    app.key("z", { ctrlKey: true });
    await app.until(
      () => app.outline().length === 1 && !/Mine/.test(app.outline()[0]),
      "Undo still works",
    );
    for (let n = 0; n < 8; n++) await app.tick();
  } finally {
    app.close();
  }
});

test("built collaborators: undo that a locked board refuses changes nothing", async () => {
  const env = environment();
  env.service.now = () => Date.now();
  const theirs = item("note", 0, 0, { text: "Owner idea" });
  const initial = {
    version: 1,
    id: crypto.randomUUID(),
    title: "Lock",
    items: [theirs],
  };
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await env.service.call(owner, {
    op: "invite",
    room: initial.id,
    role: "editor",
  });
  const saved = async () => {
    const { doc } = await env.service.load(initial.id);
    const board = doc.snapshot();
    doc.destroy();
    return board;
  };
  const lock = async (value) => {
    const { doc } = await env.service.load(initial.id);
    const vector = doc.vector(),
      next = doc.snapshot();
    next.workshop = { ...next.workshop, settings: { lock: value } };
    doc.commit(next);
    const update = doc.update(vector);
    doc.destroy();
    await env.service.call(owner, {
      op: "commit",
      room: initial.id,
      id: await hash(update),
      update: encode(update),
    });
  };
  const app = await setup(env.sdk(editor));
  try {
    await app.click('[data-action="join-shared"]');
    app.doc.querySelector("#join-link").value =
      `https://whiteboard.test/#server=https%3A%2F%2Fwhiteboard-test.puter.work&board=${initial.id}&invite=${invite.token}`;
    app.doc
      .querySelector("#join-link")
      .closest("form")
      .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
    await app.until(
      () =>
        !app.doc.querySelector("#join-link") &&
        app.doc.querySelector("#canvas"),
      "Joined",
    );
    app.sizeCanvas();
    await app.click(`#board-outline [data-id="${theirs.id}"]`);
    app.key("ArrowRight", { shiftKey: true });
    for (let n = 0; n < 200 && (await saved()).items[0].x === 0; n++)
      await app.tick();
    const moved = (await saved()).items[0].x;
    assert.notEqual(moved, 0, "The move reaches the worker");
    await lock("contribute");
    await app.until(
      () =>
        /locked/i.test(app.doc.querySelector("#workshop-banner").textContent),
      "The lock reaches the editor",
    );
    app.key("z", { ctrlKey: true });
    await app.tick();
    assert.match(app.doc.querySelector("#toast").textContent, /locked|only/i);
    for (let n = 0; n < 40; n++) await app.tick();
    assert.equal((await saved()).items[0].x, moved, "Nothing is saved");
    assert.doesNotMatch(
      app.doc.querySelector("#toast").textContent,
      /conflicted/,
    );
    await lock("open");
    await app.until(
      () =>
        !/locked/i.test(
          app.doc.querySelector("#workshop-banner")?.textContent || "",
        ),
      "The board opens again",
    );
    app.key("z", { ctrlKey: true });
    for (let n = 0; n < 200 && (await saved()).items[0].x !== 0; n++)
      await app.tick();
    assert.equal((await saved()).items[0].x, 0, "Undo still works");
    for (let n = 0; n < 8; n++) await app.tick();
  } finally {
    app.close();
  }
});

test("a reaction left anonymously gains no name when the same person reacts again", () => {
  const editor = {
    uuid: "22222222-2222-4222-8222-222222222222",
    username: "Bob",
  };
  const b = {
    ...newBoard("Workshop"),
    items: [item("note", 0, 0, { id: "a", text: "Idea" })],
  };
  b.workshop = { settings: { lock: "open", anonymous: true } };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    const record = () =>
      b.workshop[Object.keys(b.workshop).find((k) => k.startsWith("r:"))];
    ui.api.react("a", "question");
    assert.equal(record().name, undefined);
    b.workshop = {
      ...b.workshop,
      settings: { lock: "open", anonymous: false },
    };
    ui.api.react("a", "thumbs");
    assert.deepEqual(record().types, ["thumbs", "question"]);
    assert.equal(record().name, undefined);
    // Reactions left with a name keep it; anonymity hides it again.
    ui.api.react("a", "question");
    ui.api.react("a", "thumbs");
    ui.api.react("a", "heart");
    assert.equal(record().name, "Bob");
    b.workshop = { ...b.workshop, settings: { lock: "open", anonymous: true } };
    ui.api.react("a", "thumbs");
    assert.equal(record().name, undefined);
  } finally {
    ui.close();
  }
});

test("a closed poll's saved result includes answers accepted before it closed that arrive afterwards", async () => {
  const owner = {
      uuid: "11111111-1111-4111-8111-111111111111",
      username: "Alice",
    },
    editor = { uuid: "22222222-2222-4222-8222-222222222222", username: "Bob" };
  const b = {
    ...newBoard("Workshop"),
    items: [item("note", 0, 0, { id: "a", text: "Idea" })],
  };
  b.workshop = {
    poll: {
      id: "p1",
      question: "Which?",
      options: [
        { id: "o1", text: "One" },
        { id: "o2", text: "Two" },
      ],
      multiple: false,
      anonymous: true,
      hidden: false,
      state: "open",
      revealed: false,
      startedAt: 1000,
    },
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("poll");
    ui.click('[data-fac="poll-close"]');
    const saved = () => b.workshop[historyKey("p1")];
    assert.equal(saved().participants, 0);
    b.workshop = {
      ...b.workshop,
      [answerKey("p1", editor.uuid)]: {
        poll: "p1",
        by: editor.uuid,
        ids: ["o1"],
        at: 9000,
      },
    };
    ui.api.render();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(saved().participants, 1);
    assert.deepEqual(
      saved().results.map((r) => r.count),
      [1, 0],
    );
  } finally {
    ui.close();
  }
});

test("the open Summary tab follows deleted objects", () => {
  const owner = {
      uuid: "11111111-1111-4111-8111-111111111111",
      username: "Alice",
    },
    editor = { uuid: "22222222-2222-4222-8222-222222222222", username: "Bob" };
  const b = {
    ...newBoard("Workshop"),
    items: [
      item("note", 0, 0, { id: "a", text: "x" }),
      item("note", 300, 0, { id: "b", text: "y" }),
    ],
  };
  b.workshop = {
    session: { id: "s1", state: "active", startedAt: 1000 },
    [contributionKey("a")]: { by: editor.uuid, at: 2000, name: "Bob" },
    [contributionKey("b")]: { by: editor.uuid, at: 2000, name: "Bob" },
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("summary");
    const notes = () =>
      ui.doc.querySelector(".fac-totals div:nth-child(2) dd").textContent;
    assert.equal(notes(), "2");
    // Records of deleted objects stay; the note count follows the board.
    b.items = b.items.filter((i) => i.id !== "b");
    ui.api.render();
    assert.equal(notes(), "1");
  } finally {
    ui.close();
  }
});

test("long vote lists say they are shortened and agenda buttons name their step", () => {
  const frames = ["Welcome", "Brainstorm"].map((text, n) =>
    item("frame", n * 600, 0, { id: `f${n}`, text, order: n, w: 500 }),
  );
  const notes = Array.from({ length: 250 }, (_, n) =>
    item("note", (n % 20) * 220, 800 + Math.floor(n / 20) * 220, {
      id: `n${n}`,
      text: `Idea ${n}`,
    }),
  );
  const b = {
    ...newBoard("Workshop"),
    items: [...frames, ...notes],
    workshop: {
      agenda: { steps: [{ frame: "f0", minutes: 2 }, { frame: "f1" }] },
      vote: vote({ targets: notes.map((n) => n.id), hidden: false }),
    },
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("vote");
    assert.equal(ui.doc.querySelectorAll(".fac-vote-list li").length, 200);
    assert.match(
      ui.doc.querySelector(".fac-vote-list").nextElementSibling.textContent,
      /first 200 of 250/,
    );
    ui.api.open("agenda");
    ui.click('[data-fac="agenda-start"]');
    const names = [...ui.doc.querySelectorAll('[data-fac="agenda-go"]')].map(
      (button) =>
        button
          .getAttribute("aria-labelledby")
          .split(/\s+/)
          .map((id) => ui.doc.getElementById(id).textContent)
          .join(" "),
    );
    assert.deepEqual(names, ["Go to step: Welcome", "Go to step: Brainstorm"]);
  } finally {
    ui.close();
  }
});

test("revealing earlier results from History is audited once", () => {
  const record = {
    kind: "vote",
    id: "v1",
    title: "Budget",
    startedAt: 1,
    endedAt: 2,
    anonymous: true,
    hidden: true,
    participants: 3,
    results: [{ id: "a", label: "", count: 3 }],
  };
  const session = (id, extra = {}) => ({
    ...vote({ id, state: "ended", endedAt: 2, hidden: true }),
    ...extra,
  });
  const actions = (before, after) =>
    workshopEvents(before, after).map((e) => [e.action, e.details.id]);
  // Revealed from History while a later vote runs.
  assert.deepEqual(
    actions(
      { vote: session("v2"), [historyKey("v1")]: record },
      { vote: session("v2"), [historyKey("v1")]: { ...record, hidden: false } },
    ),
    [["vote.revealed", "v1"]],
  );
  // The current vote's reveal is recorded once, not again for its record.
  assert.deepEqual(
    actions(
      { vote: session("v1"), [historyKey("v1")]: record },
      {
        vote: session("v1", { revealed: true }),
        [historyKey("v1")]: { ...record, hidden: false },
      },
    ),
    [["vote.revealed", "v1"]],
  );
  // Hiding again, or no change, records nothing.
  assert.deepEqual(
    actions(
      { [historyKey("v1")]: { ...record, hidden: false } },
      { [historyKey("v1")]: record },
    ),
    [],
  );
});

test("rewriting others' content or comments with its current values is refused while it would win over their edits", async () => {
  const Y = await import("yjs");
  const { decode } = await import("../src/collaboration/protocol.js");
  const env = environment(),
    boards = env.service;
  const initial = newBoard("Workshop");
  initial.items = [item("note", 0, 0, { id: "a", text: "Owner's note" })];
  const thread = commentThread(
    { x: 1, y: 1 },
    { id: owner.uuid, name: owner.username },
    "Owner's words",
  );
  thread.messages[0].createdAt = env.now;
  initial.comments = [thread];
  const seed = new SharedDocument();
  seed.commit(initial);
  const room = initial.id;
  await boards.call(owner, {
    op: "create",
    room,
    update: encode(seed.update()),
  });
  seed.destroy();
  for (const [user, role] of [
    [editor, "editor"],
    [viewer, "commenter"],
  ]) {
    const { token } = await boards.call(owner, { op: "invite", room, role });
    await boards.call(user, { op: "join", room, token });
  }
  const send = async (user, update) =>
    boards.call(user, {
      op: "commit",
      room,
      id: await hash(update),
      update: encode(update),
    });
  const setLock = async (lock) => {
    const { doc } = await boards.load(room);
    const vector = doc.vector(),
      next = doc.snapshot();
    next.workshop = { ...next.workshop, settings: { lock } };
    doc.commit(next);
    const update = doc.update(vector);
    doc.destroy();
    await send(owner, update);
  };
  // A write from a copy of the current state, from a chosen client.
  const rewrite = async (client, change) => {
    const state = decode(
      (await boards.call(owner, { op: "sync", room })).update,
    );
    const base = new Y.Doc(),
      fork = new Y.Doc();
    Y.applyUpdate(base, state);
    fork.clientID = client;
    Y.applyUpdate(fork, state);
    change(fork);
    return Y.encodeStateAsUpdate(fork, Y.encodeStateVector(base));
  };
  const note = (d) => d.getMap("items").get("a");
  const same = (d) => note(d).set("geometry", { ...note(d).get("geometry") });
  const message = (d) =>
    d
      .getMap("comments")
      .get(thread.id)
      .get("messages")
      .get(thread.messages[0].id);
  try {
    for (const lock of ["frozen", "contribute"]) {
      await setLock(lock);
      await assert.rejects(
        send(editor, await rewrite(0x7ffffff1, same)),
        (e) => e.status === 422,
        lock,
      );
      await assert.rejects(
        send(
          editor,
          await rewrite(0x7ffffff2, (d) =>
            d.getMap("board").set("title", "Workshop"),
          ),
        ),
        (e) => e.status === 422,
        `${lock} title`,
      );
    }
    await setLock("open");
    // An open board takes it, as before.
    await send(editor, await rewrite(0x7ffffff3, same));
    // Someone else's comment, rewritten with its own words.
    await assert.rejects(
      send(
        viewer,
        await rewrite(0x7ffffff4, (d) =>
          message(d).set("text", message(d).get("text")),
        ),
      ),
      /Only the author/,
    );
    await assert.rejects(
      send(
        editor,
        await rewrite(0x7ffffff5, (d) =>
          message(d).set("authorId", message(d).get("authorId")),
        ),
      ),
      /Only the author/,
    );
    // The author's own edit saves.
    await send(
      owner,
      await rewrite(7, (d) => {
        message(d).set("text", "Owner's correction");
        message(d).set("editedAt", env.now);
      }),
    );
    const { doc } = await boards.load(room);
    try {
      assert.equal(
        doc.snapshot().comments[0].messages[0].text,
        "Owner's correction",
      );
    } finally {
      doc.destroy();
    }
  } finally {
    env.close?.();
  }
});

test("simultaneous facilitator changes to the same register keep both, and later ones win", () => {
  const start = newBoard("Workshop");
  start.items = [
    item("note", 0, 0, { id: "secret", text: "Private" }),
    item("note", 300, 0, { id: "other", text: "Other" }),
  ];
  start.workshop = {
    settings: { lock: "open", private: null, anonymous: false },
  };
  const exchange = (a, b) => {
    for (let n = 0; n < 3; n++) {
      a.apply(b.update(a.vector()));
      b.apply(a.update(b.vector()));
    }
  };
  const change = (doc, fn) => {
    const before = doc.snapshot(),
      next = structuredClone(before);
    fn(next.workshop);
    doc.commit(rebase(next, before, doc.snapshot()));
  };
  // Either facilitator's value can win the register; both changes stay.
  for (let attempt = 0; attempt < 8; attempt++) {
    const a = new SharedDocument(undefined, { merge: true }),
      b = new SharedDocument(undefined, { merge: true });
    try {
      a.commit(start);
      b.apply(a.update());
      change(a, (w) => {
        w.settings = { ...w.settings, hide: ["secret"] };
      });
      change(b, (w) => {
        w.settings = { ...w.settings, hide: ["other"], lock: "contribute" };
      });
      exchange(a, b);
      for (const doc of [a, b]) {
        const { settings } = doc.snapshot().workshop;
        assert.deepEqual([...settings.hide].sort(), ["other", "secret"]);
        assert.equal(settings.lock, "contribute");
      }
      // A change made after seeing another replaces it as usual.
      change(b, (w) => {
        w.settings = { ...w.settings, hide: [] };
      });
      exchange(a, b);
      for (const doc of [a, b])
        assert.deepEqual(doc.snapshot().workshop.settings.hide, []);
    } finally {
      a.destroy();
      b.destroy();
    }
  }
  // Documents that do not merge, such as the worker's, never write.
  const a = new SharedDocument(),
    b = new SharedDocument();
  try {
    a.commit(start);
    b.apply(a.update());
    change(a, (w) => {
      w.settings = { ...w.settings, hide: ["secret"] };
    });
    change(b, (w) => {
      w.settings = { ...w.settings, hide: ["other"] };
    });
    a.apply(b.update(a.vector()));
    b.apply(a.update(b.vector()));
    assert.deepEqual(a.snapshot().workshop, b.snapshot().workshop);
    assert.equal(a.snapshot().workshop.settings.hide.length, 1);
  } finally {
    a.destroy();
    b.destroy();
  }
});

test("a ballot or reaction racing a facilitator's change does not refuse the rest of the save", async () => {
  const env = environment(),
    boards = env.service;
  let now = Date.now();
  boards.now = () => now;
  const b = newBoard("Workshop");
  b.items = [
    item("note", 0, 0, { id: "a", text: "A" }),
    item("note", 300, 0, { id: "b", text: "B" }),
  ];
  const seed = new SharedDocument();
  seed.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const { token } = await boards.call(owner, {
    op: "invite",
    room: b.id,
    role: "editor",
  });
  await boards.call(editor, { op: "join", room: b.id, token });
  const send = async (user, doc, vector, change) => {
    const next = doc.snapshot();
    change(next);
    doc.commit(next);
    const update = doc.update(vector);
    return boards.call(user, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
    });
  };
  const change = async (user, fn) => {
    const { doc } = await boards.load(b.id);
    try {
      await send(user, doc, doc.vector(), fn);
    } finally {
      doc.destroy();
    }
  };
  const text = async (id) => {
    const { doc } = await boards.load(b.id);
    try {
      return doc.snapshot().items.find((i) => i.id === id)?.text;
    } finally {
      doc.destroy();
    }
  };
  // A ballot sent just before a manual end, with another edit.
  await change(owner, (s) => {
    s.workshop = {
      vote: {
        id: "v1",
        title: "P",
        votes: 2,
        multiple: false,
        anonymous: true,
        hidden: false,
        targets: ["a", "b"],
        state: "active",
        revealed: false,
        startedAt: now,
        endsAt: 0,
      },
    };
  });
  const bob = (await boards.load(b.id)).doc,
    before = bob.vector();
  await change(owner, (s) => {
    s.workshop.vote = { ...s.workshop.vote, state: "ended", endedAt: now };
  });
  now += 2000;
  await send(editor, bob, before, (s) => {
    s.workshop[voteKey("v1", editor.uuid)] = {
      vote: "v1",
      by: editor.uuid,
      ids: ["a"],
      at: now,
    };
    s.items.find((i) => i.id === "b").text = "Bob's edit";
  });
  bob.destroy();
  assert.equal(await text("b"), "Bob's edit");
  // Well after the end, a ballot is refused.
  now += 10_000;
  await assert.rejects(
    change(editor, (s) => {
      s.workshop[voteKey("v1", editor.uuid)] = {
        vote: "v1",
        by: editor.uuid,
        ids: ["b"],
        at: now,
      };
    }),
    /closed/,
  );
  // A reaction to a note deleted at the same moment, with another edit.
  const carol = (await boards.load(b.id)).doc,
    base = carol.vector();
  await change(owner, (s) => {
    s.items = s.items.filter((i) => i.id !== "a");
  });
  await send(editor, carol, base, (s) => {
    s.workshop[reactionKey(editor.uuid, objectTarget("a"))] = {
      by: editor.uuid,
      target: ["o", "a"],
      types: ["heart"],
      at: now,
    };
    s.items.find((i) => i.id === "b").text = "Still saved";
  });
  carol.destroy();
  assert.equal(await text("b"), "Still saved");
  // Reactions to made-up targets cannot use up the board's reaction limit.
  const react = (count) => (s) => {
    for (let n = 0; n < count; n++) {
      const target = messageTarget("none", `m${n}`);
      s.workshop[reactionKey(editor.uuid, target)] = {
        by: editor.uuid,
        target,
        types: ["heart"],
        at: now,
      };
    }
  };
  await assert.rejects(change(editor, react(200)), /no longer exists/);
  await change(editor, react(10));
  const { token: commenter } = await boards.call(owner, {
    op: "invite",
    room: b.id,
    role: "commenter",
  });
  await boards.call(viewer, { op: "join", room: b.id, token: commenter });
  await change(viewer, (s) => {
    s.workshop[reactionKey(viewer.uuid, objectTarget("b"))] = {
      by: viewer.uuid,
      target: ["o", "b"],
      types: ["heart"],
      at: now,
    };
  });
});

test("a register a facilitator cleared is not put back over another facilitator's new one", () => {
  const poll = (id, question) => ({
    id,
    question,
    options: [
      { id: "y", text: "Yes" },
      { id: "n", text: "No" },
    ],
    multiple: false,
    anonymous: false,
    hidden: false,
    state: "open",
    revealed: false,
    startedAt: 1,
  });
  const seed = new SharedDocument();
  seed.commit(newBoard("Workshop"));
  const a = new SharedDocument(seed.update(), { merge: true }),
    b = new SharedDocument(seed.update(), { merge: true });
  seed.destroy();
  a.doc.clientID = 10;
  b.doc.clientID = 20;
  try {
    const vector = a.vector();
    // A starts a poll and cancels it before hearing from B.
    const x = a.snapshot();
    x.workshop = { poll: poll("pa", "A's poll") };
    a.commit(x);
    const y = a.snapshot();
    delete y.workshop;
    a.commit(y);
    // B starts its own at the same time as A's first.
    const z = b.snapshot();
    z.workshop = { poll: poll("pb", "B's poll") };
    b.commit(z);
    const fromA = a.update(b.vector()),
      fromB = b.update(vector);
    a.apply(fromB);
    b.apply(fromA);
    a.apply(b.update(a.vector()));
    b.apply(a.update(b.vector()));
    for (const doc of [a, b])
      assert.equal(doc.snapshot().workshop?.poll?.question, "B's poll");
  } finally {
    a.destroy();
    b.destroy();
  }
});

test("on a locked board, participants' saves that only tidy or re-rank others' objects are taken", async () => {
  const { reorderItems } = await import("../src/scene.js");
  const { decode } = await import("../src/collaboration/protocol.js");
  const carol = {
    uuid: "44444444-4444-4444-8444-444444444444",
    username: "Carol",
  };
  const env = environment(),
    boards = env.service;
  const b = newBoard("Workshop");
  b.items = [
    item("frame", 0, 0, { id: "F", w: 600, h: 600, text: "Frame" }),
    item("rect", 800, 0, { id: "o1" }),
    item("rect", 1200, 0, { id: "o2" }),
  ];
  const seed = new SharedDocument();
  seed.commit(b);
  const room = b.id;
  await boards.call(owner, {
    op: "create",
    room,
    update: encode(seed.update()),
  });
  seed.destroy();
  for (const user of [editor, carol]) {
    const { token } = await boards.call(owner, {
      op: "invite",
      room,
      role: "editor",
    });
    await boards.call(user, { op: "join", room, token });
  }
  const client = async (user) =>
    new SharedDocument(
      decode((await boards.call(user, { op: "sync", room })).update),
    );
  const edit = async (user, doc, change) => {
    const vector = doc.vector(),
      next = doc.snapshot();
    next.workshop ||= {};
    change(next, next.workshop);
    doc.commit(next);
    const update = doc.update(vector);
    return boards.call(user, {
      op: "commit",
      room,
      id: await hash(update),
      update: encode(update),
    });
  };
  const own = (user, id) => (next, w) => {
    next.items.push(item("note", 50, 50, { id, parentId: "F", text: id }));
    w[contributionKey(id)] = { by: user.uuid, at: env.now };
  };
  const facilitator = await client(owner);
  await edit(
    owner,
    facilitator,
    (n, w) => (w.settings = { lock: "contribute" }),
  );
  // Bob adds a note into the frame while the facilitator deletes it.
  const bob = await client(editor),
    other = await client(owner);
  await edit(editor, bob, own(editor, "N"));
  await edit(owner, other, (n) => {
    n.items = n.items.filter((i) => i.id !== "F");
  });
  // Carol's save tidies the stale frame link on Bob's note.
  const c = await client(carol);
  await edit(carol, c, own(carol, "M"));
  // Moving her own note back and to front re-ranks others' objects.
  await edit(carol, c, (n) => {
    n.items = reorderItems(n.items, new Set(["M"]), "backward", {});
  });
  await edit(carol, c, (n) => {
    n.items = reorderItems(n.items, new Set(["M"]), "front", {});
  });
  // Writing someone else's value back as it was is still refused.
  await assert.rejects(
    (async () => {
      const vector = c.vector();
      const entry = c.items.get("o1");
      entry.set("geometry", { ...entry.get("geometry") });
      const update = c.update(vector);
      await boards.call(carol, {
        op: "commit",
        room,
        id: await hash(update),
        update: encode(update),
      });
    })(),
    { status: 422 },
  );
  // So is replacing someone else's object, or its text, with a copy.
  for (const copy of [
    (items) => items.set("o1", items.get("o1").clone()),
    (items) => {
      const entry = items.get("o2");
      entry.set("text", entry.get("text").clone());
    },
  ])
    await assert.rejects(
      (async () => {
        const d = await client(carol),
          vector = d.vector();
        d.doc.transact(() => copy(d.items));
        const update = d.update(vector);
        try {
          await boards.call(carol, {
            op: "commit",
            room,
            id: await hash(update),
            update: encode(update),
          });
        } finally {
          d.destroy();
        }
      })(),
      { status: 422 },
    );
  for (const d of [facilitator, bob, other, c]) d.destroy();
});

test("focus on a vote or reaction badge button that goes moves to the badge or the canvas", () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  b.workshop = {
    [reactionKey(viewer.uuid, objectTarget("a"))]: {
      by: viewer.uuid,
      target: ["o", "a"],
      types: ["heart"],
      at: 5,
      name: "Cam",
    },
    vote: vote({ hidden: true }),
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    const canvas = ui.doc.querySelector("#canvas");
    canvas.tabIndex = 0;
    ui.api.render();
    // Removing this person's only vote here keeps focus on the badge.
    ui.doc.querySelector('[data-fac-vote="add"][data-id="a"]').click();
    const remove = ui.doc.querySelector(
      '[data-fac-vote="remove"][data-id="a"]',
    );
    remove.focus();
    remove.click();
    assert.equal(
      ui.doc.activeElement,
      ui.doc.querySelector('[data-fac-vote="add"][data-id="a"]'),
    );
    // The badge goes when the vote is cleared and Cam removes the only
    // reaction.
    ui.doc.querySelector('[data-fac-react="heart"]')?.focus();
    b.workshop = {};
    ui.api.render();
    assert.ok(
      ui.doc.activeElement === canvas ||
        ui.doc
          .querySelector(".facilitation-badges")
          ?.contains(ui.doc.activeElement),
      "not left on the page",
    );
  } finally {
    ui.close();
  }
});

test("each object's votes and reactions are a group named after the object", () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  b.workshop = {
    vote: vote({ hidden: false, revealed: true }),
    [reactionKey(viewer.uuid, objectTarget("a"))]: {
      by: viewer.uuid,
      target: ["o", "a"],
      types: ["heart"],
      at: 5,
      name: "Cam",
    },
  };
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    ui.api.render();
    const group = ui.doc.querySelector('[data-fac-item="a"]');
    assert.equal(group.getAttribute("role"), "group");
    assert.match(accessibleName(group), /\S/);
    assert.notEqual(
      accessibleName(group),
      accessibleName(ui.doc.querySelector('[data-fac-item="b"]')),
    );
  } finally {
    ui.close();
  }
});

test("the summary counts reactions only on objects and comments that remain", () => {
  const b = { ...newBoard("Workshop"), items: notes() };
  const thread = commentThread(
    { x: 0, y: 0 },
    { id: owner.uuid, name: "Alice" },
    "Hi",
  );
  const gone = commentThread(
    { x: 0, y: 0 },
    { id: owner.uuid, name: "Alice" },
    "Bye",
  );
  gone.messages[0].deleted = true;
  b.comments = [thread, gone];
  b.workshop = { session: { id: "s1", state: "active", startedAt: 1000 } };
  const react = (who, target) => ({
    [reactionKey(who.uuid, target)]: {
      by: who.uuid,
      target,
      types: ["heart"],
      at: 2000,
      name: who.username,
    },
  });
  Object.assign(
    b.workshop,
    react(editor, objectTarget("a")),
    react(viewer, objectTarget("deleted-note")),
    react(owner, messageTarget(thread.id, thread.messages[0].id)),
    react(editor, messageTarget(gone.id, gone.messages[0].id)),
  );
  assert.equal(engagement(b, { now: 5000 }).totals.reactions, 2);
});

for (const surface of ["vote list", "live results", "summary", "overlay"])
  test(`saved object languages reach facilitation ${surface}`, () => {
    const b = newBoard("Object language audit");
    b.items = notes();
    b.items[0].text = "Bonjour à tous.";
    b.items[0].lang = "fr-CA";
    b.workshop = Object.fromEntries([
      ["vote", vote({ hidden: false })],
      ballot(owner, ["a"]),
      [
        reactionKey(owner.uuid, objectTarget("a")),
        {
          by: owner.uuid,
          target: ["o", "a"],
          types: ["thumbs"],
          at: 2000,
          name: owner.username,
        },
      ],
    ]);
    validateBoard(b);
    const ui = stubUI(b, { role: "owner", me: owner });
    const previousLanguage = language;
    try {
      setLanguage("en");
      ui.api.render();
      ui.api.open(surface === "summary" ? "summary" : "vote");
      let label;
      if (surface === "overlay")
        label = ui.doc.querySelector('[data-fac-item="a"]');
      else {
        const selector =
          surface === "vote list"
            ? ".fac-vote-list li"
            : surface === "live results"
              ? ".fac-result-label"
              : ".fac-rank li";
        label = [...ui.doc.querySelectorAll(selector)].find((n) =>
          n.textContent.includes("Bonjour à tous."),
        );
      }
      assert.ok(label, surface + " exposes the authored object name");
      if (surface === "overlay")
        assert.ok(accessibleName(label).includes("Bonjour à tous."));
      assert.equal(
        label.querySelector('[lang="fr-CA"]')?.textContent,
        "Bonjour à tous.",
      );
    } finally {
      setLanguage(previousLanguage);
      ui.close();
    }
  });

test("facilitation object labels retain trimmed and clipped passages, language-only updates and focus", () => {
  const previousLanguage = language;
  const text =
    '\n  Hello. Bonjour à tous. <img src="bad"> ' +
    "word ".repeat(30) +
    "\nSecond line";
  const start = text.indexOf("Bonjour");
  const b = newBoard("Mixed object languages");
  b.items = [
    item("note", 0, 0, {
      id: "a",
      text,
      lang: "en-CA",
      textRuns: [{ start, end: start + 15, style: { lang: "fr" } }],
    }),
    item("note", 250, 0, { id: "b", text: "", lang: "fr-CA" }),
    item("note", 500, 0, { id: "c", text: "Bonjour encore.", lang: "fr-CA" }),
  ];
  b.workshop = Object.fromEntries([
    ["vote", vote({ hidden: false })],
    ballot(owner, ["a"]),
    [
      reactionKey(owner.uuid, objectTarget("a")),
      { by: owner.uuid, target: objectTarget("a"), types: ["heart"], at: 2000 },
    ],
  ]);
  validateBoard(b);
  const ui = stubUI(b, { role: "owner", me: owner, selection: new Set(["a"]) });
  try {
    for (const lang of ["en", "fr"]) {
      setLanguage(lang);
      ui.api.render();
      ui.api.open("vote");
      const rows = ui.doc.querySelectorAll(".fac-vote-list li");
      const label = rows[0].querySelector("[data-user-content]");
      assert.equal(label.lang, "en-CA");
      assert.equal(label.textContent, text.trim().split("\n")[0].slice(0, 120));
      assert.equal(
        label.querySelector('[lang="fr"]').textContent,
        "Bonjour à tous.",
      );
      assert.equal(rows[0].querySelector("img"), null);
      assert.equal(
        rows[1].querySelector("[lang]"),
        null,
        "The empty-note type is interface text",
      );
      assert.equal(rows[2].querySelector("[lang]").lang, "fr-CA");
      const action = rows[0].querySelector('[data-fac="vote-add"]');
      assert.equal(
        accessibleName(action),
        `${t("Vote for")} ${label.textContent}`,
      );
      assert.equal(
        accessibleName(rows[0].querySelector('[data-fac="vote-remove"]')),
        `${t("Remove your vote from")} ${label.textContent}`,
      );
      assert.equal(
        action.querySelector("[lang]"),
        null,
        "Translated action words inherit the interface language",
      );
      const group = ui.doc.querySelector('[data-fac-item="a"]');
      assert.equal(accessibleName(group), label.textContent);
      assert.equal(
        accessibleName(group.querySelector('[data-fac-vote="add"]')),
        `${t("Vote for")} ${label.textContent} · ${counted("{count} votes left", 1).replace("{count}", "1")}`,
      );
      assert.equal(
        accessibleName(group.querySelector("[data-fac-picker]")),
        `${t("Add a reaction")}${lang === "fr" ? " : " : ": "}${label.textContent}`,
      );
      rows[0].querySelector('[data-fac="vote-remove"]').focus();
      b.items[0].lang = "en-GB";
      b.items[0].textRuns[0].style.lang = "fr-CA";
      // Saving an edit made in place stamps the board.
      b.updated++;
      ui.api.render();
      assert.equal(ui.doc.activeElement.dataset.fac, "vote-remove");
      assert.equal(ui.doc.activeElement.dataset.id, "a");
      assert.equal(
        ui.doc.querySelector(".fac-vote-list [data-user-content]").lang,
        "en-GB",
      );
      assert.equal(
        ui.doc.querySelector('.fac-result-label [lang="fr-CA"]').textContent,
        "Bonjour à tous.",
      );
      assert.equal(
        group.querySelector('[lang="fr-CA"]').textContent,
        "Bonjour à tous.",
      );
      const overlayVote = group.querySelector('[data-fac-vote="add"]');
      overlayVote.focus();
      b.items[0].textRuns[0].style.lang = "fr";
      ui.api.render();
      assert.equal(ui.doc.activeElement.dataset.facVote, "add");
      assert.equal(ui.doc.activeElement.closest(".fac-item"), group);
      assert.equal(
        group.querySelector('[lang="fr"]').textContent,
        "Bonjour à tous.",
      );
      ui.api.open("summary");
      const summaryExport = ui.doc.querySelector('[data-fac="summary-csv"]');
      summaryExport.focus();
      b.items[0].textRuns[0].style.lang = "fr-CA";
      ui.api.render();
      assert.equal(ui.doc.activeElement.dataset.fac, "summary-csv");
      for (const row of ui.doc.querySelectorAll(".fac-rank li"))
        assert.equal(
          row.querySelector('[lang="fr-CA"]').textContent,
          "Bonjour à tous.",
        );
      b.items[0].lang = "en-CA";
      b.items[0].textRuns[0].style.lang = "fr";
    }
  } finally {
    setLanguage(previousLanguage);
    ui.close();
  }
});

test("facilitation object language markup preserves masked and removed labels", () => {
  const b = newBoard("Private language tags");
  b.items = notes();
  for (const i of b.items) {
    i.text = "Instructions secrètes " + i.id;
    i.lang = "fr-CA";
  }
  b.workshop = Object.fromEntries([
    [
      "settings",
      { lock: "open", private: "r1", anonymous: false, hide: ["b"] },
    ],
    [
      "vote",
      vote({
        hidden: false,
        revealed: true,
        targets: ["a", "b", "c", "gone"],
        votes: 4,
      }),
    ],
    [contributionKey("a"), { by: editor.uuid, at: 1000, round: "r1" }],
    ballot(owner, ["a", "b", "gone"]),
  ]);
  validateBoard(b);
  const previousLanguage = language;
  const ui = stubUI(b, { role: "editor", me: owner });
  try {
    setLanguage("en");
    ui.api.render();
    ui.api.open("vote");
    const rows = [...ui.doc.querySelectorAll(".fac-vote-list li")];
    for (const name of [
      "Private note",
      "Hidden by the facilitator",
      "Removed object",
    ]) {
      const row = rows.find((r) => r.textContent.startsWith(name));
      assert.ok(row, name);
      assert.equal(row.querySelector("[lang]"), null);
      assert.equal(
        accessibleName(row.querySelector('[data-fac="vote-remove"]')),
        `Remove your vote from ${name}`,
      );
    }
    assert.doesNotMatch(
      ui.doc.querySelector("#fac-tabpanel").textContent,
      /Instructions secrètes [ab]/,
    );
    const privateGroup = ui.doc.querySelector('[data-fac-item="a"]');
    assert.equal(accessibleName(privateGroup), "Private note");
    assert.equal(privateGroup.querySelector("[lang]"), null);
    assert.equal(ui.doc.querySelector('[data-fac-item="b"]'), null);
    assert.equal(
      ui.doc.querySelector('.fac-result-label [lang="fr-CA"]').textContent,
      "Instructions secrètes c",
    );
  } finally {
    setLanguage(previousLanguage);
    ui.close();
  }
});

test("completed votes preserve saved label languages after the current objects change", () => {
  const b = { ...newBoard("Saved label languages"), items: notes() };
  b.items[0].text = "Bonjour à tous.";
  b.items[0].lang = "fr-CA";
  b.workshop = Object.fromEntries([
    ["vote", vote({ hidden: false })],
    ballot(owner, ["a"]),
  ]);
  const ui = stubUI(b, { role: "owner", me: owner });
  const previousLanguage = language;
  try {
    setLanguage("en");
    ui.api.open("vote");
    ui.click('[data-fac="vote-end"]');
    b.items[0].text = "This is current English content.";
    b.items[0].lang = "en";
    validateBoard(b);
    ui.openHistory();
    const row = [...ui.doc.querySelectorAll(".fac-result-label")].find(
      (n) => n.textContent === "Bonjour à tous.",
    );
    assert.ok(
      row,
      "History retains its actual saved French label rather than the current object name",
    );

    assert.equal(
      row.querySelector('[lang="fr-CA"]')?.textContent,
      "Bonjour à tous.",
    );
  } finally {
    setLanguage(previousLanguage);
    ui.close();
  }
});

test("saved result language metadata validates tags, ranges and language-only styles", () => {
  const b = {
    ...newBoard("Saved languages"),
    items: notes(),
    workshop: Object.fromEntries([["vote", vote()], ballot(owner, ["a"])]),
  };
  const record = resultRecord(b, "vote", (id) => id, 10000);
  const valid = {
    ...record.results[0],
    label: "Hello. Bonjour.",
    lang: "en",
    textRuns: [{ start: 7, end: 15, style: { lang: "fr" } }],
  };
  record.results[0] = valid;
  validateWorkshop({ [historyKey(record.id)]: record });
  for (const changes of [
    { lang: "fr_CA" },
    { lang: "<script>" },
    { textRuns: [{ start: 7, end: 16, style: { lang: "fr" } }] },
    { textRuns: [{ start: 7, end: 15, style: { lang: "fr_CA" } }] },
    { textRuns: [{ start: 7, end: 15, style: { lang: "fr", bold: true } }] },
    { label: "A😀B", textRuns: [{ start: 2, end: 4, style: { lang: "fr" } }] },
  ]) {
    const trial = structuredClone(record);
    trial.results[0] = { ...valid, ...changes };
    assert.throws(
      () => validateWorkshop({ [historyKey(trial.id)]: trial }),
      /Invalid workshop/,
    );
  }
  validateWorkshop({
    [historyKey(record.id)]: resultRecord(b, "vote", (id) => id, 10000),
  });
});

test("saved vote languages survive trimmed passages, authored captions, retallying, shared serialization and interface changes", async () => {
  const text =
    '\n  Hello. Bonjour à tous. <img src="bad"> ' + "word ".repeat(30);
  const start = text.indexOf("Bonjour");
  const b = {
    ...newBoard("Snapshots"),
    items: [
      item("note", 0, 0, {
        id: "a",
        text,
        lang: "en-CA",
        textRuns: [
          { start, end: start + 15, style: { lang: "fr-CA", bold: true } },
        ],
      }),
      item("pen", 250, 0, {
        id: "b",
        w: 100,
        h: 100,
        points: [
          [0, 0],
          [100, 100],
        ],
        alt: "Cette courbe monte.",
        lang: "fr-CA",
      }),
      item("note", 500, 0, { id: "c", text: "" }),
    ],
    workshop: Object.fromEntries([
      ["vote", vote({ hidden: false })],
      ballot(owner, ["a", "b"]),
      ballot(viewer, ["c"]),
    ]),
  };
  validateBoard(b);
  const previousLanguage = language;
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    setLanguage("en");
    ui.api.open("vote");
    ui.click('[data-fac="vote-end"]');
    const record = () => b.workshop[historyKey("vote1")];
    const rows = new Map(
      record().results.map((r) => [r.id, structuredClone(r)]),
    );
    assert.equal(rows.get("a").lang, "en-CA");
    assert.deepEqual(rows.get("a").textRuns, [
      { start: 7, end: 22, style: { lang: "fr-CA" } },
    ]);
    assert.equal(rows.get("a").label, text.trim().slice(0, 120));
    assert.equal(rows.get("b").lang, "en");
    assert.deepEqual(rows.get("b").textRuns, [
      {
        start: "Drawing: ".length,
        end: "Drawing: Cette courbe monte.".length,
        style: { lang: "fr-CA" },
      },
    ]);
    assert.equal(rows.get("c").lang, "en");
    b.items = b.items.filter((i) => i.id !== "a");
    b.items[0].alt = "This is current English content.";
    b.items[0].lang = "en";
    b.workshop = {
      ...b.workshop,
      ...Object.fromEntries([ballot(editor, ["a"])]),
    };
    ui.api.render();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(record().results.find((r) => r.id === "a").count, 2);
    for (const row of record().results) {
      const prior = rows.get(row.id);
      assert.equal(row.label, prior.label);
      assert.equal(row.lang, prior.lang);
      assert.deepEqual(row.textRuns, prior.textRuns);
    }
    validateBoard(b);
    const shared = new SharedDocument();
    try {
      shared.commit(b);
      assert.deepEqual(
        shared.snapshot().workshop[historyKey("vote1")],
        record(),
      );
    } finally {
      shared.destroy();
    }
    assert.deepEqual(
      portableWorkshop(b.workshop)[historyKey("vote1")],
      record(),
    );
    setLanguage("fr");
    ui.openHistory();
    const labels = [...ui.doc.querySelectorAll(".fac-result-label")];
    assert.equal(
      labels
        .find((n) => n.textContent.includes("Hello."))
        .querySelector('[lang="fr-CA"]').textContent,
      "Bonjour à tous.",
    );
    const drawing = labels.find((n) => n.textContent.startsWith("Drawing:"));
    assert.equal(drawing.querySelector("[data-user-content]").lang, "en");
    assert.equal(
      drawing.querySelector('[lang="fr-CA"]').textContent,
      "Cette courbe monte.",
    );
    assert.equal(ui.doc.querySelector(".fac-history img"), null);
    ui.click('[data-fac="history-json"]');
    const exported = JSON.parse(ui.calls.downloads.at(-1)[0]);
    assert.deepEqual(exported.results, record().results);
  } finally {
    setLanguage(previousLanguage);
    ui.close();
  }
});

test("redacting saved vote labels removes their old language ranges from history and portable copies", () => {
  const b = {
    ...newBoard("Private history"),
    items: notes(),
    workshop: Object.fromEntries([
      ["vote", vote({ hidden: false })],
      ballot(owner, ["a", "b"]),
      ballot(editor, ["c"]),
    ]),
  };
  for (const i of b.items) {
    i.text = "Instructions secrètes " + i.id;
    i.lang = "fr-CA";
  }
  const previousLanguage = language;
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    setLanguage("en");
    ui.api.open("vote");
    ui.click('[data-fac="vote-end"]');
    const saved = structuredClone(b.workshop[historyKey("vote1")]);
    assert.equal(saved.results[0].lang, "fr-CA");
    b.workshop = {
      ...b.workshop,
      settings: { lock: "open", private: "r1", hide: ["b"] },
      [contributionKey("a")]: { by: editor.uuid, at: 1000, round: "r1" },
    };
    ui.openHistory();
    const privateRow = [...ui.doc.querySelectorAll(".fac-result-label")].find(
      (n) => n.textContent === "Private note",
    );
    assert.ok(privateRow);
    assert.equal(privateRow.querySelector('[lang="fr-CA"]'), null);
    assert.equal(privateRow.querySelector("[data-user-content]").lang, "en");
    const copy = structuredClone(b);
    ui.api.portableCopy(copy, { id: owner.uuid, manager: false });
    const rows = new Map(
      copy.workshop[historyKey("vote1")].results.map((r) => [r.id, r]),
    );
    for (const id of ["a", "b"]) {
      assert.equal(rows.get(id).lang, "en");
      assert.equal(rows.get(id).textRuns, undefined);
      assert.doesNotMatch(rows.get(id).label, /Instructions secrètes/);
    }
    validateWorkshop(copy.workshop);
    assert.deepEqual(
      b.workshop[historyKey("vote1")],
      saved,
      "Viewer redaction does not rewrite the shared snapshot",
    );
    const blank = structuredClone(saved);
    const blankRow = blank.results.find((r) => r.id === "a");
    blankRow.label = "";
    delete blankRow.lang;
    delete blankRow.textRuns;
    b.workshop = {
      ...b.workshop,
      settings: { lock: "open" },
      [historyKey("vote1")]: blank,
    };
    ui.api.render();
    assert.equal(
      ui.doc.querySelector('.fac-result-label [lang="fr-CA"]').textContent,
      "Instructions secrètes a",
    );
    ui.doc.querySelector('[data-fac="history-json"]').focus();
    b.items[0].text = "Current English instructions.";
    b.items[0].lang = "en-GB";
    ui.api.render();
    const currentLabel = [...ui.doc.querySelectorAll(".fac-result-label")].find(
      (n) => n.textContent === "Current English instructions.",
    );
    assert.ok(
      currentLabel,
      "Unlabelled private snapshots track their currently visible object",
    );
    assert.equal(
      currentLabel.querySelector("[data-user-content]").lang,
      "en-GB",
    );
    assert.equal(ui.doc.activeElement.dataset.fac, "history-json");
  } finally {
    setLanguage(previousLanguage);
    ui.close();
  }
});

for (const surface of ["private note", "staged frame"])
  test(`concealed ${surface} placeholders use the interface language while revealed content keeps its language`, () => {
    const source = item(surface === "private note" ? "note" : "frame", 0, 0, {
      id: "a",
      text: "Bonjour. Suivez ce plan.",
      lang: "fr-CA",
      textRuns: [{ start: 0, end: 7, style: { lang: "fr", bold: true } }],
    });
    const b = newBoard("Concealed language");
    b.items = [source];
    b.workshop =
      surface === "private note"
        ? {
            settings: { lock: "open", private: "r1" },
            [contributionKey("a")]: { by: editor.uuid, at: 1000, round: "r1" },
          }
        : { settings: { lock: "open", stage: { frames: ["a"], shown: 0 } } };
    validateBoard(b);
    const original = structuredClone(b);
    const previousLanguage = language;
    const ui = stubUI(b, {
      role: surface === "private note" ? "owner" : "editor",
      me: owner,
    });
    try {
      let standIn;
      for (const interfaceLanguage of ["en", "fr", "en"]) {
        setLanguage(interfaceLanguage);
        ui.doc.documentElement.lang = interfaceLanguage;
        const masked = ui.api.conceal([...b.items])[0];
        if (standIn)
          assert.equal(
            masked,
            standIn,
            "Language refresh retains the measured stand-in",
          );
        standIn = masked;
        const expected = t(
          surface === "private note"
            ? "Private note"
            : "Hidden by the facilitator",
        );
        assert.equal(masked.text, expected);
        const rendered = ui.doc.createElement("div");
        rendered.innerHTML = objectNameHTML(masked);
        assert.equal(
          rendered.querySelector("[data-user-content]").lang,
          interfaceLanguage,
        );
        assert.equal(
          masked.textRuns,
          undefined,
          "Hidden passages do not decorate translated placeholders",
        );
        const copy = structuredClone(b);
        assert.equal(
          ui.api.portableCopy(copy, { id: owner.uuid, manager: false }),
          1,
        );
        assert.equal(copy.items[0].text, expected);
        assert.equal(copy.items[0].lang, interfaceLanguage);
        assert.equal(copy.items[0].textRuns, undefined);
        validateBoard(copy);
        assert.deepEqual(
          b,
          original,
          "Viewing and copying leave authored content untouched",
        );
      }
      b.workshop = { settings: { lock: "open" } };
      const revealed = ui.api.conceal(b.items)[0];
      assert.equal(revealed, source);
      assert.equal(revealed.lang, "fr-CA");
      assert.deepEqual(revealed.textRuns, original.items[0].textRuns);
    } finally {
      setLanguage(previousLanguage);
      ui.close();
    }
  });

test("built participant outlines and object lists tag translated concealment placeholders and restore authored languages on reveal", async () => {
  const env = environment();
  env.service.now = () => Date.now();
  const initial = newBoard("Concealed language");
  const note = item("note", 100, 100, {
    text: "Bonjour. Suivez ce plan.",
    lang: "fr-CA",
  });
  const frame = item("frame", 1000, 100, {
    text: "Deuxième étape.",
    lang: "fr-CA",
  });
  initial.items = [note, frame];
  initial.workshop = {
    settings: {
      lock: "open",
      private: "r1",
      stage: { frames: [frame.id], shown: 0 },
    },
    [contributionKey(note.id)]: { by: owner.uuid, at: Date.now(), round: "r1" },
  };
  validateBoard(initial);
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await env.service.call(owner, {
    op: "invite",
    room: initial.id,
    role: "editor",
  });
  const app = await setup(env.sdk(editor));
  try {
    await app.click('[data-action="join-shared"]');
    app.doc.querySelector("#join-link").value =
      `https://whiteboard.test/#server=https%3A%2F%2Fwhiteboard-test.puter.work&board=${initial.id}&invite=${invite.token}`;
    app.doc
      .querySelector("#join-link")
      .closest("form")
      .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
    await app.until(
      () =>
        !app.doc.querySelector("#join-link") &&
        app.doc.querySelector("#canvas"),
      "Participant joined",
    );
    app.sizeCanvas();
    for (const [interfaceLanguage, privateText, frameText] of [
      ["en", "Private note", "Hidden by the facilitator"],
      ["fr", "Note privée", "Masqué par l’animateur"],
    ]) {
      app.doc.querySelector("#language").value = interfaceLanguage;
      app.doc
        .querySelector("#language")
        .dispatchEvent(new app.w.Event("change"));
      await app.until(
        () => app.outline().some((text) => text.includes(privateText)),
        "Translated note placeholder rendered",
      );
      for (const [id, expected] of [
        [note.id, privateText],
        [frame.id, frameText],
      ]) {
        const label = app.doc.querySelector(
          `#board-outline [data-id="${id}"] [data-user-content]`,
        );
        assert.equal(label.textContent, expected);
        assert.equal(label.lang, interfaceLanguage);
        assert.equal(label.querySelector('[lang="fr-CA"]'), null);
      }
      await app.click('[data-action="objects"]');
      for (const [id, expected] of [
        [note.id, privateText],
        [frame.id, frameText],
      ]) {
        const label = app.doc.querySelector(
          `dialog [data-object="${id}"] [data-user-content][lang]`,
        );
        assert.equal(label.textContent, expected);
        assert.equal(label.lang, interfaceLanguage);
      }
      app.doc.querySelector("dialog[open]").close();
      await app.tick();
    }
    await commit(env.service, owner, initial.id, (board, workshop) => {
      workshop.settings = { lock: "open" };
    });
    await app.until(
      () => app.outline().some((text) => text.includes(note.text)),
      "Reveal reaches the participant",
    );
    for (const source of [note, frame]) {
      const label = app.doc.querySelector(
        `#board-outline [data-id="${source.id}"] [data-user-content]`,
      );
      assert.equal(label.textContent, source.text);
      assert.equal(label.lang, "fr-CA");
    }
    const { doc } = await env.service.load(initial.id);
    try {
      assert.deepEqual(doc.snapshot().items, initial.items);
    } finally {
      doc.destroy();
    }
  } finally {
    app.close();
  }
});

test("generated vote titles preserve their known language in active views, announcements and saved history", () => {
  const previousLanguage = language;
  for (const interfaceLanguage of ["en", "fr"])
    for (const mode of ["default", "blank", "custom"]) {
      const b = { ...newBoard("Vote titles"), items: notes() };
      const ui = stubUI(b, { role: "owner", me: owner });
      try {
        setLanguage(interfaceLanguage);
        ui.api.render();
        ui.api.open("vote");
        const field = ui.doc.querySelector("#fac-vote-title"),
          generated = t("Dot vote");
        if (mode === "blank") field.value = "   ";
        if (mode === "custom") field.value = 'Bonjour. <img src="bad">';
        const expected = mode === "custom" ? field.value : generated;
        ui.doc
          .querySelector("#fac-vote-form")
          .dispatchEvent(
            new ui.doc.defaultView.Event("submit", { cancelable: true }),
          );
        assert.equal(b.workshop.vote.title, expected);
        assert.equal(b.workshop.vote.titleLang, interfaceLanguage);
        validateBoard(b);
        const announcement = ui.doc.querySelector("#facilitation-live");
        assert.ok(announcement.textContent.includes(expected));
        const tagged = announcement.querySelector("[data-user-content]");
        assert.equal(tagged.textContent, expected);
        assert.equal(tagged.lang, interfaceLanguage);
        assert.equal(announcement.querySelector("img"), null);
        setLanguage(interfaceLanguage === "en" ? "fr" : "en");
        ui.api.render();
        const heading = ui.doc.querySelector("#fac-tabpanel h3");
        assert.equal(heading.textContent, expected);
        assert.equal(
          heading.querySelector("[data-user-content]").lang,
          interfaceLanguage,
        );
        assert.equal(heading.hasAttribute("lang"), false);
        ui.click('[data-fac="vote-end"]');
        const id = b.workshop.vote.id,
          saved = b.workshop[historyKey(id)];
        assert.equal(saved.titleLang, interfaceLanguage);
        ui.api.open("history");
        const title = ui.doc.querySelector(".fac-history summary strong");
        assert.equal(title.textContent, expected);
        assert.equal(
          title.querySelector("[data-user-content]").lang,
          interfaceLanguage,
        );
        for (const action of [
          "history-reveal",
          "history-csv",
          "history-json",
        ]) {
          const button = ui.doc.querySelector(`[data-fac="${action}"]`);
          assert.equal(button.hasAttribute("aria-label"), false);
          const references = button
            .getAttribute("aria-labelledby")
            .split(/\s+/);
          assert.equal(ui.doc.getElementById(references[1]), title);
          assert.ok(
            ui.doc
              .getElementById(references[0])
              .textContent.includes(button.textContent),
          );
        }
        const copy = structuredClone(b);
        ui.api.portableCopy(copy, { id: owner.uuid, manager: true });
        assert.equal(copy.workshop[historyKey(id)].titleLang, saved.titleLang);
        validateBoard(copy);
        const doc = new SharedDocument();
        try {
          doc.commit(copy);
          assert.equal(
            doc.snapshot().workshop[historyKey(id)].titleLang,
            saved.titleLang,
          );
        } finally {
          doc.destroy();
        }
        const exported = JSON.parse(resultsJSON(saved));
        assert.equal(exported.titleLang, saved.titleLang);
      } finally {
        setLanguage(previousLanguage);
        ui.close();
      }
    }
});

test("vote and history title-language tags validate without changing legacy records", () => {
  const b = {
    ...newBoard("Title validation"),
    items: notes(),
    workshop: { vote: vote() },
  };
  const legacy = resultRecord(b, "vote", (id) => id, 3000);
  assert.equal(legacy.titleLang, undefined);
  validateWorkshop({ vote: b.workshop.vote, [historyKey(legacy.id)]: legacy });
  for (const tag of ["fr-CA", "en", "es", "zh-Hant"]) {
    b.workshop.vote.titleLang = tag;
    const saved = resultRecord(b, "vote", (id) => id, 3000);
    assert.equal(saved.titleLang, tag);
    validateWorkshop({ vote: b.workshop.vote, [historyKey(saved.id)]: saved });
  }
  for (const invalid of ["", "fr_CA", "not a language", null, 42, {}, ["fr"]]) {
    assert.throws(
      () => validateWorkshop({ vote: { ...vote(), titleLang: invalid } }),
      /workshop/i,
    );
    assert.throws(
      () =>
        validateWorkshop({
          [historyKey(legacy.id)]: { ...legacy, titleLang: invalid },
        }),
      /workshop/i,
    );
  }
});

function fieldLanguage(ui, id, value, start, end, scope) {
  const field = ui.doc.getElementById(id);
  if (start !== undefined) field.setSelectionRange(start, end, "forward", true);
  const toggle = ui.doc.getElementById(`${id}-language-options`);
  assert.ok(toggle, "Authored fields provide language controls");
  toggle.click();
  if (scope) ui.doc.getElementById(`${id}-language-scope`).value = scope;
  ui.doc.getElementById(`${id}-language-tag`).value = value;
  ui.doc.getElementById(`${id}-language-save`).click();
}

test("custom vote titles author whole-field and passage languages and preserve them through active views and history", () => {
  const previousLanguage = language;
  for (const interfaceLanguage of ["en", "fr"]) {
    const b = { ...newBoard("Custom title"), items: notes() };
    const ui = stubUI(b, { role: "owner", me: owner });
    try {
      setLanguage(interfaceLanguage);
      ui.api.render();
      ui.api.open("vote");
      const field = ui.doc.querySelector("#fac-vote-title");
      field.value = '  Hello. Bonjour à tous. <img src="bad">  ';
      fieldLanguage(ui, field.id, "EN-ca", 0, 0, "field");
      fieldLanguage(ui, field.id, "FR-ca", 9, 24, "text");
      assert.equal(
        field.querySelector('[lang="fr-CA"]').textContent,
        "Bonjour à tous.",
      );
      assert.equal(field.getAttribute("role"), "textbox");
      assert.equal(
        field.getAttribute("aria-labelledby"),
        "fac-vote-title-label",
      );
      assert.equal(field.querySelector("img"), null);
      ui.doc
        .querySelector("#fac-vote-form")
        .dispatchEvent(
          new ui.doc.defaultView.Event("submit", { cancelable: true }),
        );
      const session = b.workshop.vote;
      assert.equal(session.title, 'Hello. Bonjour à tous. <img src="bad">');
      assert.equal(session.titleLang, "en-CA");
      assert.deepEqual(session.titleRuns, [
        { start: 7, end: 22, style: { lang: "fr-CA" } },
      ]);
      validateBoard(b);
      assert.equal(
        ui.doc.querySelector('#facilitation-live [lang="fr-CA"]').textContent,
        "Bonjour à tous.",
      );
      setLanguage(interfaceLanguage === "en" ? "fr" : "en");
      ui.api.render();
      assert.equal(
        ui.doc.querySelector('#fac-tabpanel h3 [lang="en-CA"]').textContent,
        session.title,
      );
      assert.equal(
        ui.doc.querySelector('#fac-tabpanel h3 [lang="fr-CA"]').textContent,
        "Bonjour à tous.",
      );
      ui.click('[data-fac="vote-end"]');
      ui.api.open("history");
      const saved = b.workshop[historyKey(session.id)];
      assert.deepEqual(saved.titleRuns, session.titleRuns);
      assert.equal(
        ui.doc.querySelector('.fac-history summary [lang="fr-CA"]').textContent,
        "Bonjour à tous.",
      );
      const json = JSON.parse(resultsJSON(saved));
      assert.deepEqual(json.titleRuns, session.titleRuns);
      const copy = structuredClone(b);
      ui.api.portableCopy(copy, { id: owner.uuid, manager: true });
      assert.deepEqual(
        copy.workshop[historyKey(session.id)].titleRuns,
        session.titleRuns,
      );
      const doc = new SharedDocument();
      try {
        doc.commit(copy);
        assert.deepEqual(
          doc.snapshot().workshop[historyKey(session.id)].titleRuns,
          session.titleRuns,
        );
      } finally {
        doc.destroy();
      }
    } finally {
      setLanguage(previousLanguage);
      ui.close();
    }
  }
});

test("vote-title passage languages validate only language styles and Unicode-safe ranges", () => {
  const session = vote({
    title: "Hi 😀 bonjour",
    titleLang: "en",
    titleRuns: [{ start: 6, end: 13, style: { lang: "fr" } }],
  });
  const b = {
    ...newBoard("Title validation"),
    items: notes(),
    workshop: { vote: session },
  };
  validateBoard(b);
  const saved = resultRecord(b, "vote", (id) => id, 3000);
  assert.deepEqual(saved.titleRuns, session.titleRuns);
  validateWorkshop({ [historyKey(saved.id)]: saved });
  for (const titleRuns of [
    null,
    [{ start: 4, end: 6, style: { lang: "fr" } }],
    [{ start: 6, end: 14, style: { lang: "fr" } }],
    [{ start: 6, end: 13, style: { lang: "bad_tag" } }],
    [{ start: 6, end: 13, style: { bold: true } }],
  ]) {
    assert.throws(
      () => validateWorkshop({ vote: { ...session, titleRuns } }),
      /workshop/i,
    );
    assert.throws(
      () =>
        validateWorkshop({ [historyKey(saved.id)]: { ...saved, titleRuns } }),
      /workshop/i,
    );
  }
});

test("vote-title language drafts retain focus and ranges on redraw, validate tags, cancel safely and avoid stale passage edits", () => {
  const previousLanguage = language;
  const b = { ...newBoard("Vote draft"), items: notes() },
    ui = stubUI(b, { role: "owner", me: owner });
  const key = (node, name, extra = {}) =>
    node.dispatchEvent(
      new ui.doc.defaultView.KeyboardEvent("keydown", {
        key: name,
        bubbles: true,
        cancelable: true,
        ...extra,
      }),
    );
  try {
    setLanguage("en");
    ui.api.open("vote");
    let field = ui.doc.querySelector("#fac-vote-title");
    field.value = "Hello. Bonjour à tous. End.";
    fieldLanguage(ui, field.id, "fr-CA", 7, 22, "text");
    field.value = "First. " + field.value;
    field.value += " Last.";
    field.setSelectionRange(14, 29, "backward", true);
    ui.click("#fac-vote-title-language-options");
    ui.doc.querySelector("#fac-vote-title-language-tag").value = "de";
    ui.doc.querySelector("#fac-vote-title-language-tag").focus();
    b.items.push(item("frame", 0, 400, { text: "A new shared frame" }));
    ui.api.render();
    field = ui.doc.querySelector("#fac-vote-title");
    assert.equal(field.value, "First. Hello. Bonjour à tous. End. Last.");
    assert.equal(
      field.querySelector('[lang="fr-CA"]').textContent,
      "Bonjour à tous.",
    );
    assert.equal(ui.doc.activeElement.id, "fac-vote-title-language-tag");
    assert.equal(ui.doc.activeElement.value, "de");
    ui.click("#fac-vote-title-language-save");
    assert.equal(
      field.querySelector('[lang="de"]').textContent,
      "Bonjour à tous.",
    );
    assert.equal(
      b.workshop,
      undefined,
      "Draft language changes do not start a vote",
    );
    field.setSelectionRange(14, 29, "forward", true);
    ui.click("#fac-vote-title-language-options");
    let tag = ui.doc.querySelector("#fac-vote-title-language-tag");
    tag.value = "bad_tag";
    key(tag, "Enter");
    assert.equal(
      ui.doc.querySelector("#fac-vote-title-language-error").hidden,
      false,
    );
    assert.equal(tag.getAttribute("aria-invalid"), "true");
    assert.equal(
      field.querySelector('[lang="de"]').textContent,
      "Bonjour à tous.",
    );
    tag.value = "es";
    field.value = "Changed. " + field.value;
    ui.click("#fac-vote-title-language-save");
    assert.match(
      ui.doc.querySelector("#fac-vote-title-language-error").textContent,
      /selected text changed/i,
    );
    assert.equal(field.querySelector('[lang="es"]'), null);
    key(tag, "Escape", { isComposing: true });
    assert.equal(
      ui.doc.querySelector("#fac-vote-title-language-controls").hidden,
      false,
    );
    key(tag, "Escape");
    assert.equal(
      ui.doc.querySelector("#fac-vote-title-language-controls").hidden,
      true,
    );
    assert.ok(ui.doc.querySelector("#facilitation-panel"));
    assert.equal(ui.doc.activeElement.id, "fac-vote-title-language-options");
    fieldLanguage(ui, field.id, "", 0, 0, "field");
    assert.equal(field.hasAttribute("lang"), false);
    field.focus();
    key(field, "Enter", { isComposing: true });
    key(field, "Enter", { keyCode: 229 });
    assert.equal(b.workshop, undefined, "Composition Enter leaves the draft");
    key(field, "Enter");
    assert.equal(b.workshop.vote.titleLang, undefined);
    assert.equal(b.workshop.vote.titleRuns[0].style.lang, "de");
    assert.equal(b.workshop.vote.titleRuns[0].start, 23);
    validateBoard(b);
  } finally {
    setLanguage(previousLanguage);
    ui.close();
  }
});

test("poll questions retain authored whole and passage languages in headings, announcements and saved titles", () => {
  const b = { ...newBoard("Question languages"), items: notes() },
    previousLanguage = language;
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    setLanguage("fr");
    ui.api.render();
    ui.api.open("poll");
    const field = ui.doc.querySelector("#fac-poll-question");
    field.value = "  Hello. Bonjour à tous. <img src=bad>  ";
    fieldLanguage(ui, field.id, "en-CA", 0, 0, "field");
    fieldLanguage(ui, field.id, "fr-CA", 9, 24, "text");
    ui.doc.querySelector("#fac-poll-options").value = "Yes\nNo";
    ui.doc
      .querySelector("#fac-poll-form")
      .dispatchEvent(
        new ui.doc.defaultView.Event("submit", { cancelable: true }),
      );
    const poll = b.workshop.poll;
    assert.equal(poll.questionLang, "en-CA");
    assert.deepEqual(poll.questionRuns, [
      { start: 7, end: 22, style: { lang: "fr-CA" } },
    ]);
    validateBoard(b);
    assert.equal(
      ui.doc.querySelector('#facilitation-live [lang="fr-CA"]').textContent,
      "Bonjour à tous.",
    );
    setLanguage("en");
    ui.api.render();
    assert.equal(
      ui.doc.querySelector('#fac-tabpanel h3 [lang="fr-CA"]').textContent,
      "Bonjour à tous.",
    );
    assert.equal(ui.doc.querySelector("#fac-tabpanel h3 img"), null);
    ui.click('[data-fac="poll-close"]');
    ui.api.open("history");
    const saved = b.workshop[historyKey(poll.id)];
    assert.equal(saved.titleLang, "en-CA");
    assert.deepEqual(saved.titleRuns, poll.questionRuns);
    assert.equal(
      ui.doc.querySelector('.fac-history summary [lang="fr-CA"]').textContent,
      "Bonjour à tous.",
    );
    assert.deepEqual(
      JSON.parse(resultsJSON(saved)).titleRuns,
      poll.questionRuns,
    );
    const copy = structuredClone(b);
    ui.api.portableCopy(copy, { id: owner.uuid, manager: true });
    validateBoard(copy);
    assert.deepEqual(
      copy.workshop[historyKey(poll.id)].titleRuns,
      poll.questionRuns,
    );
  } finally {
    setLanguage(previousLanguage);
    ui.close();
  }
});

test("a vote on objects in chosen frames takes locked objects and nested frames inside", () => {
  const b = {
    ...newBoard("Frame vote"),
    items: [
      item("frame", 0, 0, { id: "f", w: 900, h: 600, text: "Ideas" }),
      item("note", 20, 60, { id: "in", text: "Inside", parentId: "f" }),
      // Locked objects never join a frame, but lie in it.
      item("note", 250, 60, { id: "pinned", text: "Pinned", locked: true }),
      item("frame", 450, 300, { id: "g", w: 400, h: 250, text: "Inner" }),
      item("note", 470, 360, { id: "nested", text: "Nested", parentId: "g" }),
      item("note", 1200, 0, { id: "out", text: "Outside" }),
    ],
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.render();
    ui.api.open("vote");
    ui.doc.querySelector('[name="fac-vote-scope"][value="frames"]').checked =
      true;
    ui.doc.querySelector('#fac-vote-frames input[value="f"]').checked = true;
    ui.doc
      .querySelector("#fac-vote-form")
      .dispatchEvent(
        new ui.doc.defaultView.Event("submit", { cancelable: true }),
      );
    assert.deepEqual(b.workshop.vote.targets, ["in", "pinned", "nested"]);
  } finally {
    ui.close();
  }
});

test("revealing a poll's hidden results is shown and announced, as for a vote", () => {
  const b = { ...newBoard("Poll reveal"), items: notes() };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.render();
    ui.api.open("poll");
    ui.doc.querySelector("#fac-poll-question").value = "Which first?";
    ui.doc.querySelector("#fac-poll-options").value = "Search\nForms";
    ui.doc.querySelector("#fac-poll-hidden").checked = true;
    ui.doc
      .querySelector("#fac-poll-form")
      .dispatchEvent(
        new ui.doc.defaultView.Event("submit", { cancelable: true }),
      );
    ui.click('[data-fac="poll-close"]');
    const live = () => ui.doc.querySelector("#facilitation-live").textContent;
    assert.match(live(), /The poll closed\./);
    assert.doesNotMatch(ui.banner(), /Poll results revealed/);
    ui.click('[data-fac="poll-reveal"]');
    assert.equal(b.workshop.poll.revealed, true);
    assert.match(live(), /Poll results revealed\./);
    assert.match(ui.banner(), /Poll results revealed/);
    // The chip opens the poll's results.
    ui.click('#workshop-banner [data-fac-open="poll"]');
    assert.equal(
      ui.doc.querySelector('[role="tab"][aria-selected="true"]').id,
      "fac-tab-poll",
    );
    ui.click('[data-fac="poll-hide"]');
    assert.doesNotMatch(ui.banner(), /Poll results revealed/);
  } finally {
    ui.close();
  }
});

test("poll question languages validate independently of legacy questions and answer labels", () => {
  const legacy = {
    id: "p1",
    question: "Hi 😀 bonjour",
    options: [
      { id: "a", text: "Yes" },
      { id: "b", text: "No" },
    ],
    multiple: false,
    anonymous: true,
    hidden: false,
    state: "open",
    revealed: false,
    startedAt: 1000,
  };
  validateWorkshop({ poll: legacy });
  const tagged = {
    ...legacy,
    questionLang: "en",
    questionRuns: [{ start: 6, end: 13, style: { lang: "fr" } }],
  };
  validateWorkshop({ poll: tagged });
  for (const patch of [
    { questionLang: "bad_tag" },
    { questionLang: null },
    { questionRuns: null },
    { questionRuns: [{ start: 4, end: 6, style: { lang: "fr" } }] },
    { questionRuns: [{ start: 6, end: 14, style: { lang: "fr" } }] },
    { questionRuns: [{ start: 6, end: 13, style: { bold: true } }] },
  ])
    assert.throws(
      () => validateWorkshop({ poll: { ...tagged, ...patch } }),
      /workshop/i,
    );
});

test("choosing the open section again or reopening it keeps a form draft", () => {
  const b = { ...newBoard("Drafts"), items: notes() };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.render();
    ui.api.open("poll");
    const question = () => ui.doc.querySelector("#fac-poll-question");
    question().value = "Keep the retro format?";
    ui.doc.querySelector("#fac-poll-options").value = "Yes\nNo";
    ui.click("#fac-tab-poll");
    assert.equal(question().value, "Keep the retro format?");
    assert.equal(ui.doc.querySelector("#fac-poll-options").value, "Yes\nNo");
    assert.equal(ui.doc.activeElement, ui.doc.querySelector("#fac-tab-poll"));
    ui.doc.querySelector("#fac-tab-poll").dispatchEvent(
      new ui.doc.defaultView.KeyboardEvent("keydown", {
        key: "End",
        bubbles: true,
      }),
    );
    assert.notEqual(
      ui.doc.activeElement,
      ui.doc.querySelector("#fac-tab-poll"),
    );
    ui.click("#fac-tab-poll");
    assert.equal(question().value, "");
    question().value = "Second draft";
    ui.api.open("poll");
    assert.equal(question().value, "Second draft");
    ui.api.open("session");
    ui.api.open("poll");
    assert.equal(question().value, "");
  } finally {
    ui.close();
  }
});

test("poll answer language ranges follow trimmed lines, clipping, voting, saved results and interface changes", () => {
  const b = { ...newBoard("Answer languages"), items: notes() },
    previousLanguage = language;
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    setLanguage("en");
    ui.api.render();
    ui.api.open("poll");
    ui.doc.querySelector("#fac-poll-question").value = "Choose a plan.";
    const field = ui.doc.querySelector("#fac-poll-options"),
      french = "Commençons par améliorer la documentation.",
      mixed = 'Hello. Bonjour à tous. <img src="bad">',
      long = "x".repeat(195) + "😀Bonjour";
    field.value =
      "  \n  " + french + "  \n\n  " + mixed + "  \n  " + long + "  ";
    field.value += "\n  " + "z".repeat(199) + "😀Boundary";
    fieldLanguage(ui, field.id, "en-CA", 0, 0, "field");
    const a = field.value.indexOf(french),
      c = field.value.indexOf("Bonjour à tous."),
      d = field.value.indexOf("😀Bonjour");
    fieldLanguage(ui, field.id, "fr-CA", a, a + french.length, "text");
    fieldLanguage(ui, field.id, "fr", c, c + 15, "text");
    fieldLanguage(ui, field.id, "fr-CA", d, d + 9, "text");
    ui.doc
      .querySelector("#fac-poll-form")
      .dispatchEvent(
        new ui.doc.defaultView.Event("submit", { cancelable: true }),
      );
    const poll = b.workshop.poll;
    assert.equal(poll.options.length, 4);
    assert.equal(
      poll.options[3].text,
      "z".repeat(199),
      "Clipping retains whole Unicode characters",
    );
    assert.equal(poll.options[0].text, french);
    assert.equal(poll.options[0].lang, "en-CA");
    assert.deepEqual(poll.options[0].textRuns, [
      { start: 0, end: french.length, style: { lang: "fr-CA" } },
    ]);
    assert.deepEqual(poll.options[1].textRuns, [
      { start: 7, end: 22, style: { lang: "fr" } },
    ]);
    assert.equal(poll.options[2].text, long.slice(0, 200));
    assert.deepEqual(poll.options[2].textRuns, [
      { start: 195, end: 200, style: { lang: "fr-CA" } },
    ]);
    validateBoard(b);
    const answer = ui.doc.querySelector(
      '#fac-answer-form input[value="' + poll.options[0].id + '"]',
    );
    assert.equal(
      answer.closest("label").querySelector('[lang="fr-CA"]').textContent,
      french,
    );
    answer.checked = true;
    ui.doc
      .querySelector("#fac-answer-form")
      .dispatchEvent(
        new ui.doc.defaultView.Event("submit", { cancelable: true }),
      );
    assert.equal(
      ui.doc.querySelector('.fac-result-label [lang="fr-CA"]').textContent,
      french,
    );
    setLanguage("fr");
    ui.api.render();
    assert.equal(
      ui.doc.querySelector('#fac-answer-form [lang="fr"]').textContent,
      "Bonjour à tous.",
    );
    assert.equal(ui.doc.querySelector("#fac-answer-form img"), null);
    ui.click('[data-fac="poll-close"]');
    ui.openHistory();
    const saved = b.workshop[historyKey(poll.id)];
    assert.deepEqual(saved.results[0].textRuns, poll.options[0].textRuns);
    assert.equal(saved.results[0].lang, "en-CA");
    assert.equal(
      ui.doc.querySelector('.fac-result-label [lang="fr-CA"]').textContent,
      french,
    );
    assert.deepEqual(
      JSON.parse(resultsJSON(saved)).results[0].textRuns,
      poll.options[0].textRuns,
    );
    const copy = structuredClone(b);
    ui.api.portableCopy(copy, { id: owner.uuid, manager: true });
    validateBoard(copy);
    assert.deepEqual(
      copy.workshop[historyKey(poll.id)].results[0].textRuns,
      poll.options[0].textRuns,
    );
  } finally {
    setLanguage(previousLanguage);
    ui.close();
  }
});

test("poll answer language metadata validates each option and preserves legacy tally shapes", () => {
  const poll = {
    id: "p1",
    question: "Choose.",
    options: [
      { id: "a", text: "Hi 😀 bonjour" },
      { id: "b", text: "Other" },
    ],
    multiple: false,
    anonymous: true,
    hidden: false,
    state: "open",
    revealed: false,
    startedAt: 1000,
  };
  const b = {
    ...newBoard("Answer validation"),
    items: notes(),
    workshop: { poll },
  };
  assert.deepEqual(pollTally(b, poll), [
    { id: "a", text: "Hi 😀 bonjour", count: 0 },
    { id: "b", text: "Other", count: 0 },
  ]);
  validateBoard(b);
  const good = {
    ...poll.options[0],
    lang: "en",
    textRuns: [{ start: 6, end: 13, style: { lang: "fr" } }],
  };
  poll.options[0] = good;
  validateBoard(b);
  const rows = pollTally(b, poll);
  assert.deepEqual(rows[0].textRuns, good.textRuns);
  rows[0].textRuns[0].style.lang = "es";
  assert.equal(
    good.textRuns[0].style.lang,
    "fr",
    "Tally metadata cannot mutate an option",
  );
  for (const patch of [
    { lang: "bad_tag" },
    { lang: null },
    { textRuns: null },
    { textRuns: [{ start: 4, end: 6, style: { lang: "fr" } }] },
    { textRuns: [{ start: 6, end: 14, style: { lang: "fr" } }] },
    {
      textRuns: [{ start: 6, end: 13, style: { link: "https://example.com" } }],
    },
  ])
    assert.throws(
      () =>
        validateWorkshop({
          poll: { ...poll, options: [{ ...good, ...patch }, poll.options[1]] },
        }),
      /workshop/i,
    );
});

test("agenda instruction languages survive trimming, frame reordering, shared refreshes, banner rendering and copies", () => {
  const frames = [
      item("frame", 0, 0, { id: "F<weird>", text: "First", order: 0 }),
      item("frame", 600, 0, { id: "G", text: "Second", order: 1 }),
    ],
    b = {
      ...newBoard("Instructions"),
      items: frames,
      workshop: {
        agenda: {
          steps: [
            { frame: "G", text: "Older shared instructions.", lang: "en-CA" },
          ],
        },
      },
    },
    previousLanguage = language;
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    setLanguage("en");
    ui.api.render();
    ui.api.open("agenda");
    let first = ui.doc.querySelector('[data-step="F<weird>"] .fac-step-text'),
      id = first.id;
    first.value = '  Hello. Bonjour à tous. <img src="bad">  ';
    fieldLanguage(ui, id, "en-CA", 0, 0, "field");
    fieldLanguage(ui, id, "fr-CA", 9, 24, "text");
    first.focus();
    frames[0].order = 1;
    frames[1].order = 0;
    b.workshop = {
      agenda: {
        steps: [
          { frame: "G", text: "Newer shared instructions.", lang: "en-GB" },
        ],
      },
    };
    ui.api.render();
    first = ui.doc.getElementById(id);
    assert.equal(ui.doc.activeElement, first);
    assert.equal(
      first.querySelector('[lang="fr-CA"]').textContent,
      "Bonjour à tous.",
    );
    assert.equal(
      ui.doc.querySelector('[data-step="G"] .fac-step-text').value,
      "Newer shared instructions.",
    );
    ui.doc
      .querySelector("#fac-agenda-form")
      .dispatchEvent(
        new ui.doc.defaultView.Event("submit", { cancelable: true }),
      );
    const saved = b.workshop.agenda.steps.find((s) => s.frame === "F<weird>");
    assert.equal(saved.text, 'Hello. Bonjour à tous. <img src="bad">');
    assert.equal(saved.lang, "en-CA");
    assert.deepEqual(saved.textRuns, [
      { start: 7, end: 22, style: { lang: "fr-CA" } },
    ]);
    assert.equal(
      b.workshop.agenda.steps.find((s) => s.frame === "G").lang,
      "en-GB",
    );
    validateBoard(b);
    const instruction = [...ui.doc.querySelectorAll(".fac-agenda li p")].find(
      (n) => n.textContent === saved.text,
    );
    assert.equal(
      instruction.querySelector('[lang="fr-CA"]').textContent,
      "Bonjour à tous.",
    );
    assert.equal(instruction.querySelector("img"), null);
    ui.click('[data-fac="agenda-go"][data-step="1"]');
    const chip = ui.doc.querySelector('[data-fac-open="agenda"]');
    chip.focus();
    assert.equal(
      chip.querySelector('small [lang="fr-CA"]').textContent,
      "Bonjour à tous.",
    );
    setLanguage("fr");
    ui.api.render();
    assert.equal(ui.doc.activeElement, chip);
    assert.equal(
      chip.querySelector('small [lang="en-CA"]').textContent,
      saved.text,
    );
    assert.equal(
      ui.doc.querySelector('.fac-step-text [lang="fr-CA"]').textContent,
      "Bonjour à tous.",
    );
    const copy = structuredClone(b);
    ui.api.portableCopy(copy, { id: owner.uuid, manager: true });
    validateBoard(copy);
    assert.deepEqual(
      copy.workshop.agenda.steps.find((s) => s.frame === "F<weird>").textRuns,
      saved.textRuns,
    );
    const doc = new SharedDocument();
    try {
      doc.commit(copy);
      assert.deepEqual(
        doc.snapshot().workshop.agenda.steps,
        copy.workshop.agenda.steps,
      );
    } finally {
      doc.destroy();
    }
  } finally {
    setLanguage(previousLanguage);
    ui.close();
  }
});

test("agenda instruction language metadata validates tags, ranges and plain language styles", () => {
  const step = {
    frame: "f",
    text: "Hi 😀 bonjour",
    lang: "en",
    textRuns: [{ start: 6, end: 13, style: { lang: "fr" } }],
  };
  validateWorkshop({ agenda: { steps: [step] } });
  validateWorkshop({ agenda: { steps: [{ frame: "f", minutes: 5 }] } });
  for (const patch of [
    { lang: "bad_tag" },
    { lang: null },
    { textRuns: null },
    { textRuns: [{ start: 4, end: 6, style: { lang: "fr" } }] },
    { textRuns: [{ start: 6, end: 14, style: { lang: "fr" } }] },
    { textRuns: [{ start: 6, end: 13, style: { bold: true } }] },
  ])
    assert.throws(
      () => validateWorkshop({ agenda: { steps: [{ ...step, ...patch }] } }),
      /workshop/i,
    );
});

test("concealed agenda instructions hide their language ranges and portable copies discard the captured metadata", () => {
  const b = {
      ...newBoard("Covered instruction languages"),
      items: [
        item("frame", 0, 0, {
          id: "F",
          text: "Bonjour à tous.",
          lang: "fr-CA",
          order: 0,
        }),
      ],
      workshop: {
        settings: { stage: { frames: ["F"], shown: 0 } },
        agenda: {
          steps: [
            {
              frame: "F",
              text: "Instructions secrètes. Hello.",
              lang: "fr-CA",
              textRuns: [{ start: 23, end: 29, style: { lang: "en" } }],
            },
          ],
        },
        run: {
          id: "r1",
          state: "running",
          step: 0,
          frame: "F",
          startedAt: 1000,
          stepAt: 1000,
        },
      },
    },
    previousLanguage = language;
  const ui = stubUI(b, { role: "editor", me: editor });
  try {
    setLanguage("en");
    validateBoard(b);
    ui.api.render();
    ui.api.open("agenda");
    assert.doesNotMatch(ui.doc.body.textContent, /Instructions secrètes/);
    assert.equal(ui.doc.querySelector("#workshop-banner small"), null);
    const original = structuredClone(b.workshop),
      copy = structuredClone(b);
    ui.api.portableCopy(copy, { id: editor.uuid, manager: false });
    const step = copy.workshop.agenda.steps[0];
    assert.equal(step.text, undefined);
    assert.equal(step.lang, undefined);
    assert.equal(step.textRuns, undefined);
    validateBoard(copy);
    assert.deepEqual(b.workshop, original);
    b.workshop = {
      ...b.workshop,
      settings: { stage: { frames: ["F"], shown: 1 } },
    };
    ui.api.render();
    assert.equal(
      ui.doc.querySelector('#workshop-banner small [lang="fr-CA"]').textContent,
      "Instructions secrètes. Hello.",
    );
    assert.equal(
      ui.doc.querySelector('#workshop-banner small [lang="en"]').textContent,
      "Hello.",
    );
  } finally {
    setLanguage(previousLanguage);
    ui.close();
  }
});

const auditLive = (kind, text, lang, runs) =>
  kind === "vote"
    ? {
        id: "v",
        title: text,
        ...(lang ? { titleLang: lang } : {}),
        ...(runs ? { titleRuns: runs } : {}),
        votes: 1,
        multiple: false,
        anonymous: false,
        hidden: false,
        targets: ["a"],
        state: "active",
        revealed: true,
        startedAt: 1,
        endsAt: 0,
      }
    : {
        id: "p",
        question: text,
        ...(lang ? { questionLang: lang } : {}),
        ...(runs ? { questionRuns: runs } : {}),
        options: [
          { id: "a", text: "Yes" },
          { id: "b", text: "No" },
        ],
        multiple: false,
        anonymous: false,
        hidden: false,
        state: "open",
        revealed: true,
        startedAt: 1,
      };
for (const kind of ["vote", "poll"])
  test(`${kind} audit snapshots whole-title and passage languages at its Unicode-safe limit`, () => {
    const text = "Start. Veuillez choisir les prochaines étapes. End.";
    const source = auditLive(kind, text, "en-CA", [
      { start: 7, end: 46, style: { lang: "fr-CA" } },
    ]);
    const b = newBoard();
    b.items = [item("note", 0, 0, { id: "a" })];
    b.workshop = { [kind]: source };
    validateBoard(structuredClone(b));
    const details = workshopEvents({}, b.workshop)[0].details;
    assert.equal(details.title, text);
    assert.equal(details.titleLang, "en-CA");
    assert.deepEqual(details.titleRuns, [
      { start: 7, end: 46, style: { lang: "fr-CA" } },
    ]);
    assert.notEqual(
      details.titleRuns,
      source[kind === "vote" ? "titleRuns" : "questionRuns"],
    );
    details.titleRuns[0].style.lang = "de";
    assert.equal(
      source[kind === "vote" ? "titleRuns" : "questionRuns"][0].style.lang,
      "fr-CA",
    );
    const long = "a".repeat(199) + "😀 suite";
    const clipped = workshopEvents(
      {},
      {
        [kind]: auditLive(kind, long, "en", [
          { start: 195, end: long.length, style: { lang: "fr" } },
        ]),
      },
    )[0].details;
    assert.equal(clipped.title, "a".repeat(199));
    assert.deepEqual(clipped.titleRuns, [
      { start: 195, end: 199, style: { lang: "fr" } },
    ]);
    const legacy = workshopEvents({}, { [kind]: auditLive(kind, "Legacy") })[0]
      .details;
    assert.deepEqual(legacy, {
      id: kind === "vote" ? "v" : "p",
      title: "Legacy",
      anonymous: false,
    });
  });

test("mixed table cell and passage languages are captured in completed vote labels and survive object changes", () => {
  const i = item("table", 0, 0, {
    id: "mixed-table",
    lang: "en-CA",
    cells: [["Please continue.", "Bonjour à tous. Guten Tag."]],
    cellLanguages: {
      "0,1": {
        lang: "fr-CA",
        textRuns: [
          {
            start: "Bonjour à tous. ".length,
            end: "Bonjour à tous. Guten Tag.".length,
            style: { lang: "de" },
          },
        ],
      },
    },
  });
  const b = {
    ...newBoard("Table votes"),
    items: [i],
    workshop: Object.fromEntries([
      ["vote", vote({ targets: [i.id], hidden: false })],
      ballot(owner, [i.id]),
    ]),
  };
  validateBoard(b);
  const previousLanguage = language,
    ui = stubUI(b, { role: "owner", me: owner });
  try {
    setLanguage("en");
    ui.api.open("vote");
    ui.click('[data-fac="vote-end"]');
    const record = Object.values(b.workshop).find((r) => r.results);
    const saved = record.results[0];
    assert.ok(
      saved.textRuns.some(
        (run) =>
          saved.label.slice(run.start, run.end) === "Bonjour à tous. " &&
          run.style.lang === "fr-CA",
      ),
    );
    assert.ok(
      saved.textRuns.some(
        (run) =>
          saved.label.slice(run.start, run.end) === "Guten Tag." &&
          run.style.lang === "de",
      ),
    );
    i.cells = [["Changed English", ""]];
    delete i.cellLanguages;
    i.lang = "en";
    b.updated++;
    setLanguage("fr");
    ui.openHistory();
    assert.equal(
      ui.doc.querySelector('.fac-result-label [lang="fr-CA"]').textContent,
      "Bonjour à tous. ",
    );
    assert.equal(
      ui.doc.querySelector('.fac-result-label [lang="de"]').textContent,
      "Guten Tag.",
    );
    validateBoard(b);
  } finally {
    setLanguage(previousLanguage);
    ui.close();
  }
});

for (const length of [118, 119, 120]) {
  test(`voting previews retain complete Unicode at ${length} characters`, () => {
    const n = notes();
    n[0].text = "Q".repeat(length) + "😀";
    n[0].lang = "fr-CA";
    const b = {
      ...newBoard("Unicode votes"),
      items: n,
      workshop: Object.fromEntries([
        ["vote", vote({ targets: ["a"], hidden: false })],
        ballot(owner, ["a"]),
      ]),
    };
    validateBoard(b);
    const ui = stubUI(b, { role: "owner", me: owner });
    try {
      ui.api.open("vote");
      const caption = ui.doc.querySelector(
        ".fac-vote-list [data-user-content]",
      );
      assert.equal(caption.textContent.isWellFormed(), true);
      assert.equal(caption.lang, "fr-CA");
      assert.equal(n[0].text, "Q".repeat(length) + "😀");
    } finally {
      ui.close();
    }
  });
  test(`completed votes retain complete Unicode at ${length} characters`, () => {
    const n = notes();
    n[0].text = "Q".repeat(length) + "😀";
    n[0].lang = "fr-CA";
    const b = {
      ...newBoard("Unicode votes"),
      items: n,
      workshop: Object.fromEntries([
        ["vote", vote({ targets: ["a"], hidden: false })],
        ballot(owner, ["a"]),
      ]),
    };
    validateBoard(b);
    const ui = stubUI(b, { role: "owner", me: owner });
    try {
      ui.api.open("vote");
      ui.click('[data-fac="vote-end"]');
      const record = Object.values(b.workshop).find((r) => r.results),
        result = record.results[0];
      assert.equal(result.label.isWellFormed(), true);
      validateBoard(b);
      assert.equal(n[0].text, "Q".repeat(length) + "😀");
    } finally {
      ui.close();
    }
  });
}

for (const locale of ["en", "fr"])
  for (const length of [118, 119, 120])
    test(`voting Unicode labels preserve exact whole and passage languages in ${locale} at ${length}`, () => {
      const previous = language;
      const n = notes(),
        text = "Q".repeat(length) + "😀",
        expected = length === 118 ? text : "Q".repeat(Math.min(length, 120));
      n[0].text = text;
      n[0].lang = "fr-CA";
      n[0].textRuns = [
        { start: length, end: length + 2, style: { lang: "en-GB" } },
      ];
      const original = structuredClone(n);
      const b = {
        ...newBoard("Unicode votes"),
        items: n,
        workshop: Object.fromEntries([
          ["vote", vote({ targets: ["a"], hidden: false })],
          ballot(owner, ["a"]),
        ]),
      };
      validateBoard(b);
      const ui = stubUI(b, { role: "owner", me: owner });
      try {
        setLanguage(locale);
        ui.api.open("vote");
        const caption = ui.doc.querySelector(
          ".fac-vote-list [data-user-content]",
        );
        assert.equal(caption.textContent, expected);
        assert.equal(caption.lang, "fr-CA");
        assert.equal(
          caption.querySelector('[lang="en-GB"]')?.textContent,
          length === 118 ? "😀" : undefined,
        );
        ui.click('[data-fac="vote-end"]');
        const record = Object.values(b.workshop).find((r) => r.results),
          result = record.results[0];
        assert.equal(result.label, expected);
        assert.equal(result.lang, "fr-CA");
        assert.deepEqual(
          result.textRuns,
          length === 118
            ? [{ start: 118, end: 120, style: { lang: "en-GB" } }]
            : undefined,
        );
        validateBoard(b);
        assert.deepEqual(n, original);
      } finally {
        setLanguage(previous);
        ui.close();
      }
    });

for (const locale of ["en", "fr"])
  test(`long table vote labels retain translated prefix and exact captured cell languages in ${locale}`, () => {
    const table = item("table", 0, 0, {
      id: "a",
      cells: [["Intro", "Q".repeat(291) + "😀"]],
      lang: "de",
      cellLanguages: {
        "0,1": {
          lang: "fr-CA",
          textRuns: [{ start: 291, end: 293, style: { lang: "en-GB" } }],
        },
      },
    });
    const original = structuredClone(table),
      b = {
        ...newBoard("Long table votes"),
        items: [table],
        workshop: Object.fromEntries([
          ["vote", vote({ targets: ["a"], hidden: false })],
          ballot(owner, ["a"]),
        ]),
      };
    validateBoard(b);
    const ui = stubUI(b, { role: "owner", me: owner }),
      previous = language;
    try {
      setLanguage(locale);
      const prefix = locale === "en" ? "Table: " : "tableau de données : ",
        expected = prefix + "Intro · " + "Q".repeat(120 - prefix.length - 8);
      ui.api.open("vote");
      const preview = ui.doc.querySelector(".fac-vote-list li");
      assert.ok(preview.textContent.includes(expected));
      ui.click('[data-fac="vote-end"]');
      const result = Object.values(b.workshop).find((r) => r.results)
        .results[0];
      assert.equal(result.label, expected);
      assert.equal(result.lang, locale);
      assert.deepEqual(result.textRuns, [
        { start: prefix.length, end: prefix.length + 8, style: { lang: "de" } },
        { start: prefix.length + 8, end: 120, style: { lang: "fr-CA" } },
      ]);
      validateBoard(b);
      assert.deepEqual(table, original);
    } finally {
      setLanguage(previous);
      ui.close();
    }
  });

for (const locale of ["en", "fr"])
  for (const type of ["image", "file", "table"])
    test(`voting captured ${type} names preserve the boundary and authored body language in ${locale}`, () => {
      const previous = language;
      const target = item(type, 0, 0, {
        id: "a",
        text: "",
        lang: "fr-CA",
        ...(type === "image"
          ? { src: createCanvas(2, 2).toDataURL() }
          : type === "file"
            ? {
                data: "data:application/octet-stream;base64,eA==",
                fileName: "",
              }
            : { cells: [[""]] }),
      });
      const b = {
        ...newBoard("Alternative vote labels"),
        items: [target],
        workshop: Object.fromEntries([
          ["vote", vote({ targets: ["a"], hidden: false })],
          ballot(owner, ["a"]),
        ]),
      };
      const ui = stubUI(b, { role: "owner", me: owner });
      try {
        setLanguage(locale);
        const prefix = objectKind(target) + (locale === "fr" ? " : " : ": "),
          short = "Q".repeat(119 - prefix.length),
          body = short + "😀",
          expected = prefix + short;
        if (type === "image") target.alt = body;
        else if (type === "file") target.fileName = body;
        else target.cells = [[body]];
        const original = structuredClone(target);
        validateBoard(b);
        ui.api.open("vote");
        const caption = ui.doc.querySelector(
          ".fac-vote-list [data-user-content]",
        );
        assert.equal(caption.textContent, short);
        assert.equal(caption.lang, "fr-CA");
        ui.click('[data-fac="vote-end"]');
        const result = Object.values(b.workshop).find((r) => r.results)
          .results[0];
        assert.equal(result.label, expected);
        assert.equal(result.label.isWellFormed(), true);
        assert.equal(result.lang, locale);
        assert.deepEqual(result.textRuns, [
          { start: prefix.length, end: 119, style: { lang: "fr-CA" } },
        ]);
        validateBoard(b);
        assert.deepEqual(target, original);
      } finally {
        setLanguage(previous);
        ui.close();
      }
    });

test("a masked board lists no tag used only on content hidden from this person", () => {
  const b = {
    ...newBoard("Private"),
    tags: [
      { id: "pub", name: "Shared idea", color: "#c43b3b" },
      { id: "sec", name: "Layoffs in Q3", color: "#365dc4" },
      { id: "new", name: "Unused", color: "#2f855a" },
    ],
    items: [
      item("note", 0, 0, { id: "a", text: "Visible", tagIds: ["pub"] }),
      item("note", 250, 0, {
        id: "b",
        text: "Owner's private note",
        tagIds: ["sec"],
      }),
    ],
    workshop: {
      settings: { private: "r1" },
      [contributionKey("a")]: { by: editor.uuid, at: 1, round: "r1" },
      [contributionKey("b")]: { by: owner.uuid, at: 1, round: "r1" },
    },
  };
  const participant = stubUI(b, { role: "editor", me: editor });
  try {
    assert.deepEqual([...participant.api.concealedIds()], ["b"]);
    assert.deepEqual(
      participant.api.masked(b).tags.map((tag) => tag.name),
      ["Shared idea", "Unused"],
    );
  } finally {
    participant.close();
  }
  // Each sees the tags of their own private note, not the other's.
  const author = stubUI(b, { role: "owner", me: owner });
  try {
    assert.deepEqual(
      author.api.masked(b).tags.map((tag) => tag.name),
      ["Layoffs in Q3", "Unused"],
    );
  } finally {
    author.close();
  }
  // Without hidden content the board is shown as it is.
  const open = { ...b, workshop: undefined };
  const viewer = stubUI(open, { role: "editor", me: editor });
  try {
    assert.equal(viewer.api.masked(open), open);
  } finally {
    viewer.close();
  }
});

test("a validation message on the facilitation panel survives a redraw of the same tab", () => {
  const b = {
    ...newBoard("Stage"),
    shared: { server: "x", room: "r" },
    items: Array.from({ length: 62 }, (_, n) =>
      item("frame", n * 900, 0, { text: `Step ${n + 1}`, order: n }),
    ),
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.open("session");
    ui.doc.querySelector('[data-fac="stage-start"]').click();
    assert.match(ui.doc.querySelector("#fac-error").textContent, /up to 60/);
    // Someone adds an object: the tab is drawn again, the message stays.
    b.items.push(item("note", 0, 500, { text: "Arrived" }));
    ui.api.render();
    const error = ui.doc.querySelector("#fac-error");
    assert.equal(error.hidden, false, "The message is still shown");
    assert.match(error.textContent, /up to 60/);
    // Another tab starts clean.
    ui.api.open("vote");
    assert.equal(ui.doc.querySelector("#fac-error").hidden, true);
  } finally {
    ui.close();
  }
});

test("a vote never offers notes or objects a participant cannot read", () => {
  const carol = {
    uuid: "55555555-5555-4555-8555-555555555555",
    username: "Carol",
  };
  const b = newBoard("W");
  b.shared = { server: "s", room: "r" };
  b.items = [
    item("note", 0, 0, { id: "a", text: "Public idea" }),
    item("note", 250, 0, { id: "p", text: "Bob's secret" }),
    item("frame", 600, 0, {
      id: "f",
      text: "Staged",
      order: 1,
      w: 300,
      h: 300,
    }),
    item("note", 620, 20, { id: "s", text: "Staged note", parentId: "f" }),
  ];
  b.workshop = {
    settings: { private: "round1", stage: { frames: ["f"], shown: 0 } },
    [contributionKey("p")]: {
      by: editor.uuid,
      at: 1,
      name: "Bob",
      round: "round1",
    },
  };
  // The facilitator starts a vote on all sticky notes: a face-down note
  // of the private round and a note in a frame not yet shown stay out,
  // since the voters could not read them and the tally would reveal them.
  const fac = stubUI(b, { role: "owner", me: owner });
  try {
    fac.api.render();
    fac.api.open("vote");
    fac.doc
      .querySelector("#fac-vote-form")
      .dispatchEvent(
        new fac.doc.defaultView.Event("submit", { cancelable: true }),
      );
    assert.ok(
      b.workshop.vote,
      fac.doc.querySelector("#fac-error")?.textContent,
    );
    assert.deepEqual(b.workshop.vote.targets, ["a"]);
  } finally {
    fac.close();
  }
  // A vote started elsewhere on such a note still offers no ballot for it.
  b.workshop.vote.targets = ["a", "p", "s"];
  const car = stubUI(b, { role: "editor", me: carol });
  try {
    car.api.render();
    car.api.open("vote");
    const rows = [...car.doc.querySelectorAll(".fac-vote-list li")].map(
      (li) => li.querySelector("span").textContent,
    );
    assert.deepEqual(rows, ["Public idea"]);
  } finally {
    car.close();
  }
});

test("a collapsed or expanded facilitation section keeps its state when its count changes", () => {
  const b = newBoard("W");
  b.items = [
    item("note", 0, 0, { id: "a", text: "Ship faster" }),
    item("note", 250, 0, { id: "b", text: "Docs" }),
    item("note", 500, 0, { id: "c", text: "Tests" }),
  ];
  const record = {
    kind: "vote",
    id: "old1",
    title: "Earlier",
    startedAt: 100,
    endedAt: 900,
    anonymous: true,
    hidden: false,
    participants: 1,
    results: [{ id: "a", label: "Ship faster", count: 1 }],
  };
  b.workshop = {
    vote: {
      id: "vote1",
      title: "Priorities",
      votes: 3,
      multiple: false,
      anonymous: true,
      hidden: true,
      targets: ["a", "b", "c"],
      state: "active",
      revealed: false,
      startedAt: 1000,
      endsAt: 0,
    },
    [historyKey("old1")]: record,
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.render();
    ui.api.open("vote");
    assert.equal(ui.doc.querySelector("details.fac-details").open, true);
    ui.doc.querySelector("details.fac-details").open = false;
    // Someone deletes a target: the list's count in its summary changes.
    b.items = b.items.filter((i) => i.id !== "c");
    b.updated = 5;
    ui.api.render();
    assert.equal(ui.doc.querySelector("details.fac-details").open, false);
    ui.api.open("history");
    const d = ui.doc.querySelector(".fac-history details");
    assert.equal(d.open, false);
    d.open = true;
    // A late ballot changes the record's participant count.
    b.workshop = {
      ...b.workshop,
      [historyKey("old1")]: { ...record, participants: 2 },
    };
    ui.api.render();
    assert.equal(ui.doc.querySelector(".fac-history details").open, true);
  } finally {
    ui.close();
  }
});

test("a multiple-answer poll shows each option's share of respondents", () => {
  const b = newBoard("W");
  b.items = [item("note", 0, 0, { id: "a", text: "x" })];
  const poll = {
    id: "p1",
    question: "Which?",
    options: [
      { id: "o1", text: "Tea" },
      { id: "o2", text: "Coffee" },
      { id: "o3", text: "Water" },
    ],
    multiple: true,
    anonymous: true,
    hidden: false,
    state: "open",
    revealed: true,
    startedAt: 0,
  };
  b.workshop = {
    poll,
    [answerKey("p1", owner.uuid)]: {
      poll: "p1",
      by: owner.uuid,
      ids: ["o1", "o2"],
      at: 1,
    },
    [answerKey("p1", editor.uuid)]: {
      poll: "p1",
      by: editor.uuid,
      ids: ["o1"],
      at: 2,
    },
  };
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.render();
    ui.api.open("poll");
    const rows = [
      ...ui.doc.querySelectorAll(".fac-results .fac-result-count"),
    ].map((e) => e.textContent);
    // Two people answered: Tea by both, Coffee by one, Water by none.
    assert.deepEqual(rows, [
      "2 responses · 100%",
      "1 response · 50%",
      "0 responses · 0%",
    ]);
    const record = resultRecord(b, "poll", () => "", 10);
    const shares = resultsCSV(record)
      .split("\r\n")
      .slice(7, 10)
      .map((line) => line.split(",")[3]);
    assert.deepEqual(shares, ["100", "50", "0"]);
    // The saved record reads the same in the history tab.
    b.workshop = { [historyKey(record.id)]: record };
    ui.api.render();
    ui.openHistory();
    assert.match(
      ui.doc.querySelector(".fac-history").textContent,
      /1 response · 50%/,
    );
  } finally {
    ui.close();
  }
});

test("a poll refuses two options with the same text", () => {
  const b = newBoard("W");
  b.items = [item("note", 0, 0, { id: "a", text: "x" })];
  const ui = stubUI(b, { role: "owner", me: owner });
  try {
    ui.api.render();
    ui.api.open("poll");
    ui.doc.querySelector("#fac-poll-question").setRichText("Lunch?", []);
    const options = ui.doc.querySelector("#fac-poll-options");
    options.setRichText("Pizza\nPizza\n  pizza  \n", []);
    ui.doc
      .querySelector("#fac-poll-form")
      .dispatchEvent(
        new ui.doc.defaultView.Event("submit", { cancelable: true }),
      );
    assert.equal(b.workshop?.poll, undefined);
    assert.equal(
      ui.doc.querySelector("#fac-error").textContent,
      "Each option must be different.",
    );
    assert.equal(options.getAttribute("aria-invalid"), "true");
    options.setRichText("Pizza\nSalad\n", []);
    ui.doc
      .querySelector("#fac-poll-form")
      .dispatchEvent(
        new ui.doc.defaultView.Event("submit", { cancelable: true }),
      );
    assert.deepEqual(
      b.workshop.poll.options.map((o) => o.text),
      ["Pizza", "Salad"],
    );
  } finally {
    ui.close();
  }
});

test("the minutes left in a vote agree with the countdown", () => {
  const b = newBoard("W");
  b.items = [item("note", 0, 0, { id: "a", text: "x" })];
  b.workshop = {
    vote: {
      id: "vote1",
      title: "P",
      votes: 1,
      multiple: false,
      anonymous: true,
      hidden: true,
      targets: ["a"],
      state: "active",
      revealed: false,
      startedAt: 0,
      endsAt: 100000,
    },
  };
  // 1:01 on the countdown is about 1 minute, not 2; 0:20 is still about
  // 1 minute rather than none while the vote is open.
  for (const [left, minutes] of [
    [61000, "1"],
    [89000, "1"],
    [91000, "2"],
    [20000, "1"],
  ]) {
    const ui = stubUI(b, {
      role: "editor",
      me: editor,
      now: () => 100000 - left,
    });
    try {
      ui.api.render();
      ui.api.open("vote");
      const m = /About (\d+) minutes? left/.exec(
        ui.doc.querySelector("#fac-tabpanel").textContent,
      );
      assert.equal(m?.[1], minutes, `${left} ms left`);
    } finally {
      ui.close();
    }
  }
});

test("a vote follows only the board timer started for it", () => {
  const vote = { id: "v1", state: "active", endsAt: 70000 };
  const timer = (state, endsAt, id = voteTimerId(vote)) => ({
    id,
    state,
    duration: 60000,
    remaining: 60000,
    endsAt,
  });
  assert.equal(voteTimerId(vote), "vote-v1");
  assert.equal(voteFollowingTimer(vote, timer("running", 70000)), null);
  assert.deepEqual(voteFollowingTimer(vote, timer("running", 370000)), {
    ...vote,
    endsAt: 370000,
  });
  assert.equal(voteFollowingTimer(vote, timer("paused", 0)).endsAt, 0);
  assert.equal(voteFollowingTimer(vote, timer("idle", 0)).endsAt, 0);
  // Another countdown, or a vote that has ended, is left alone.
  assert.equal(voteFollowingTimer(vote, timer("paused", 0, "other")), null);
  assert.equal(
    voteFollowingTimer({ ...vote, state: "ended" }, timer("paused", 0)),
    null,
  );
  assert.equal(voteFollowingTimer(undefined, timer("paused", 0)), null);
});

test("vote buttons follow the board's reading order for the keyboard", async () => {
  const { createOverlay } = await import("../src/facilitation/overlay.js");
  const dom = new JSDOM('<div class="canvas-wrap"><canvas></canvas></div>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  const b = { ...newBoard("Order"), workshop: {} };
  // Added right to left, and one row below.
  b.items = [
    item("note", 900, 0, { id: "right" }),
    item("note", 450, 4, { id: "middle" }),
    item("note", 0, 0, { id: "left" }),
    item("note", 0, 400, { id: "below" }),
  ];
  const targets = new Set(b.items.map((i) => i.id));
  const overlay = createOverlay({
    board: () => b,
    view: () => ({ x: 0, y: 0, z: 1 }),
    canvas: () => ({
      getBoundingClientRect: () => ({ width: 1600, height: 900 }),
    }),
    hidden: () => new Map(),
    selection: () => new Set(),
    me: () => ({ id: owner.uuid }),
    canParticipate: () => true,
    index: () => new Map(),
    concealment: () => ({
      notes: new Set(),
      frames: new Set(),
      hidden: new Set(),
    }),
    label: (id) => id,
    icon: () => "",
    voting: () => ({
      targets,
      open: true,
      left: 3,
      multiple: false,
      mine: [],
      showCounts: false,
      counts: new Map(),
    }),
    stagedForManager: () => false,
  });
  try {
    overlay.bind(dom.window.document.querySelector(".canvas-wrap"));
    overlay.render();
    assert.deepEqual(
      [...dom.window.document.querySelectorAll("[data-fac-item]")].map(
        (n) => n.dataset.facItem,
      ),
      ["left", "middle", "right", "below"],
    );
  } finally {
    overlay.detach();
    dom.window.close();
    globalThis.document = previous;
  }
});

test("objects a facilitator locked stay locked and unchanged for participants", () => {
  const items = notes();
  items[0].locked = true;
  items[1].locked = true;
  const workshop = { settings: { protect: ["a"] } };
  validateWorkshop(workshop);
  const before = { title: "T", items, workshop };
  const edit = (fn) => {
    const after = structuredClone(before);
    fn(after.items);
    return after;
  };
  const unlock = edit((i) => delete i[0].locked),
    move = edit((i) => (i[0].x += 10)),
    remove = edit((i) => i.splice(0, 1));
  for (const after of [unlock, move, remove]) {
    assert.throws(
      () => validateWorkshopChanges(before, after, editor, "editor"),
      /Only a facilitator can unlock or change this object/,
    );
    validateWorkshopChanges(before, after, owner, "facilitator");
  }
  // A participant's own lock, or one the facilitator lifted, stays theirs to
  // remove.
  validateWorkshopChanges(
    before,
    edit((i) => delete i[1].locked),
    editor,
    "editor",
  );
  const lifted = edit((i) => delete i[0].locked);
  validateWorkshopChanges(
    { ...lifted, workshop },
    edit((i) => {
      delete i[0].locked;
      i[0].x += 10;
    }),
    editor,
    "editor",
  );
  // Only facilitators change the list itself.
  assert.throws(
    () =>
      validateWorkshopChanges(
        before,
        { ...before, workshop: {} },
        editor,
        "editor",
      ),
    /facilitator/,
  );
  assert.deepEqual(
    workshopEvents({}, workshop).map((e) => e.action),
    ["workshop.protected"],
  );
  // Two facilitators locking different objects at once both keep theirs.
  assert.deepEqual(
    rebaseWorkshop(
      { settings: { protect: ["a", "b"] } },
      { settings: { protect: ["a"] } },
      { settings: { protect: ["a", "c"] } },
    ).settings.protect.sort(),
    ["a", "b", "c"],
  );
});

test("portable workshops keep what facilitators hid and locked, not live settings", () => {
  const kept = portableWorkshop({
    settings: { lock: "frozen", private: "r1", hide: ["a"], protect: ["b"] },
    vote: { id: "v" },
  });
  assert.deepEqual(kept, { settings: { hide: ["a"], protect: ["b"] } });
  validateWorkshop(kept);
  assert.equal(
    portableWorkshop({ settings: { lock: "frozen", hide: [] } }),
    undefined,
  );
});

test("a selection holding hidden content says the facilitator controls it", () => {
  const frame = item("frame", 0, 0, { w: 600, h: 400, text: "Activity" });
  const table = item("table", 20, 60, {
    parentId: frame.id,
    cells: [["A", "B"]],
  });
  const secret = item("note", 300, 60, {
    text: "Answer key",
    parentId: frame.id,
  });
  const b = {
    ...newBoard("Workshop"),
    shared: { server: "x", room: "r" },
    items: [frame, table, secret],
    workshop: { settings: { hide: [secret.id] } },
  };
  const ui = stubUI(b, { role: "editor", me: viewer });
  try {
    const ids = new Set([frame.id, table.id, secret.id]);
    assert.equal(ui.api.locked(ids), true);
    assert.equal(
      ui.api.lockReason(ids),
      "The facilitator controls part of this selection.",
    );
    assert.equal(ui.api.lockReason(new Set([table.id])), null);
  } finally {
    ui.close();
  }
});

test("a viewer is told why they can watch a vote or poll but not take part", () => {
  const b = { ...newBoard("Workshop"), shared: { server: "x", room: "r" } };
  b.items = notes();
  b.workshop = {
    vote: vote(),
    poll: {
      id: "p1",
      question: "Lunch?",
      options: [
        { id: "o1", text: "Pizza" },
        { id: "o2", text: "Salad" },
      ],
      multiple: false,
      anonymous: true,
      hidden: false,
      state: "open",
      revealed: false,
      startedAt: 1,
    },
  };
  const why = {
    vote: "With view access, you can watch this vote but not vote. To vote, ask the owner or a facilitator for comment access.",
    poll: "With view access, you can watch this poll but not answer it. To answer, ask the owner or a facilitator for comment access.",
  };
  for (const [role, me] of [
    ["viewer", viewer],
    ["commenter", editor],
  ]) {
    const ui = stubUI(b, { role, me });
    try {
      ui.api.render();
      for (const tab of ["vote", "poll"]) {
        ui.api.open(tab);
        const panel = ui.doc.querySelector("#fac-tabpanel").textContent;
        assert.equal(panel.includes(why[tab]), role === "viewer", role);
      }
    } finally {
      ui.close();
    }
  }
});
