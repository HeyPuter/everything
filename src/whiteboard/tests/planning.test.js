import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { JSDOM } from "jsdom";
import { IDBFactory } from "fake-indexeddb";
import { appBundle } from "./app-bundle.js";
import axe from "axe-core";
import { PDFDocument, PDFRawStream, PDFName } from "pdf-lib";
import { Image as NativeImage } from "@napi-rs/canvas";
import { createCanvas } from "./canvas.js";
import { board, item, validateBoard } from "../src/model.js";
import { SharedDocument, rebase } from "../src/collaboration/document.js";
import { encode, hash } from "../src/collaboration/protocol.js";
import { tagFooter } from "../src/tags.js";
import { drawObject } from "../src/render.js";
import { updateConnectors } from "../src/scene.js";
import { exportRegions, exportPDF } from "../src/export.js";
import { exportSVG } from "../src/export-svg.js";
import { drawOrder } from "../src/export-layout.js";
import { spreadsheetModel } from "../src/export-sheet.js";
import { planDuplication } from "../src/duplication.js";
import {
  CLIPBOARD_TYPE,
  clipboardFormats,
  selectionFragment,
} from "../src/transfer.js";
import {
  copyObjectStyle,
  objectStylePatch,
  applyObjectStyle,
} from "../src/object-style.js";
import {
  validTask,
  validatePlanningFields,
  statusFromTitle,
  blockers,
  dependencyEdges,
  dependencyCycle,
  assignmentChanges,
  initials,
  taskRow,
  newTask,
  dateFromDay,
  canBeDependency,
  STATUSES,
  STATUS_LABELS,
} from "../src/planning/task.js";
import { taskLayout, taskClock } from "../src/planning/task-renderer.js";
import {
  collectTasks,
  filterTasks,
  groupTasks,
  sortTasks,
  summarizeTasks,
  taskSheet,
  exportTasksCSV,
  exportTasksXLSX,
  summarySheet,
} from "../src/planning/tasks.js";
import {
  timelineModel,
  timelineItems,
  placedTimeline,
  refreshedTimeline,
  BAR_COLORS,
} from "../src/planning/timeline.js";
import {
  taskParents,
  applyStatusSync,
  alignColumnStatuses,
  statusSyncChanges,
} from "../src/planning/kanban.js";
import { fromTemplate } from "../src/templates.js";
import {
  applyCreated,
  applyStatuses,
  jiraStatus,
  jiraLink,
  jiraIssues,
} from "../src/planning/jira.js";
import { adminCall } from "../worker/admin.js";
import { environment, owner, editor, viewer } from "./collaboration-helpers.js";

globalThis.window ??= { Image: NativeImage };
const measure = createCanvas(10, 10).getContext("2d");
const TODAY = "2026-09-26";

// A small plan: two frames used as Kanban columns, four tasks, one
// dependency, and an ordinary note.
function plan() {
  const b = board("Launch plan");
  const todo = item("frame", 0, 0, { w: 600, h: 600, text: "To do", order: 0 });
  const done = item("frame", 700, 0, {
    w: 600,
    h: 600,
    text: "Terminé",
    order: 1,
  });
  const design = item("note", 30, 70, {
    text: "Design review",
    h: 190,
    parentId: todo.id,
    task: {
      assignee: { id: editor.uuid, name: "Bob Smith" },
      start: "2026-09-20",
      due: "2026-09-24",
      status: "in-progress",
      priority: "high",
    },
  });
  const build = item("rect", 260, 70, {
    text: "Build pages",
    parentId: todo.id,
    task: {
      assignee: { id: owner.uuid, name: "Alice" },
      start: "2026-09-25",
      due: "2026-10-05",
      status: "todo",
    },
  });
  const ship = item("text", 30, 320, {
    text: "Ship",
    autoHeight: true,
    parentId: todo.id,
    task: { assignee: null, start: null, due: "2026-10-10", status: "todo" },
  });
  const retro = item("ellipse", 730, 70, {
    text: "Retrospective",
    parentId: done.id,
    task: {
      assignee: null,
      start: null,
      due: null,
      status: "done",
      jira: {
        key: "WB-7",
        url: "https://team.atlassian.net/browse/WB-7",
        status: "Done",
      },
    },
  });
  const dependency = {
    ...item("arrow", 0, 0, { text: "" }),
    startId: design.id,
    endId: build.id,
    dependency: "blocks",
  };
  const plain = item("note", 900, 300, { text: "Just a note" });
  b.items = [todo, done, design, build, ship, retro, dependency, plain];
  updateConnectors(b.items);
  return { b, todo, done, design, build, ship, retro, dependency, plain };
}

test("task validation is strict and older boards load unchanged", () => {
  const { b, design } = plan();
  assert.equal(validateBoard(structuredClone(b)).items.length, 8);
  const legacy = board("Old");
  legacy.items = [item("note", 0, 0, { text: "Plain" })];
  assert.deepEqual(validateBoard(structuredClone(legacy)), legacy);
  assert.equal(validTask(newTask()), true);
  for (const task of [
    { status: "started" },
    { status: "todo", due: "2026-02-30" },
    { status: "todo", start: "2026-10-02", due: "2026-10-01" },
    { status: "todo", owner: "Ana" },
    { status: "todo", priority: "urgent" },
    { status: "todo", assignee: "Ana" },
    { status: "todo", assignee: { id: "", name: "Ana" } },
    { status: "todo", assignee: { id: "a", name: "Ana", email: "x" } },
    { status: "todo", jira: { key: "wb-1", url: "https://x.test/1" } },
    { status: "todo", jira: { key: "WB-1", url: "http://x.test/1" } },
    [],
  ]) {
    assert.equal(validTask(task), false, JSON.stringify(task));
    const copy = structuredClone(b);
    copy.items.find((i) => i.id === design.id).task = task;
    assert.throws(() => validateBoard(copy), /Invalid task details/);
  }
  assert.throws(
    () => validatePlanningFields({ type: "image", task: newTask() }),
    /Invalid task details/,
  );
  assert.throws(
    () => validatePlanningFields({ type: "note", dependency: "blocks" }),
    /Invalid task dependency/,
  );
  assert.throws(
    () => validatePlanningFields({ type: "arrow", dependency: "after" }),
    /Invalid task dependency/,
  );
  assert.throws(
    () => validateBoard({ ...structuredClone(b), planning: { sync: true } }),
    /Invalid planning settings/,
  );
  assert.ok(
    validateBoard({ ...structuredClone(b), planning: { statusSync: true } }),
  );
});

test("tasks, dependencies, and planning settings round-trip through the shared document and merge concurrently", () => {
  const { b, design, build, dependency } = plan();
  b.planning = { statusSync: true };
  const doc = new SharedDocument();
  doc.commit(b);
  doc.validate();
  const snapshot = doc.snapshot(b.id);
  const byId = new Map(snapshot.items.map((i) => [i.id, i]));
  assert.deepEqual(byId.get(design.id).task, design.task);
  assert.equal(byId.get(dependency.id).dependency, "blocks");
  assert.deepEqual(snapshot.planning, { statusSync: true });
  // Two collaborators edit different tasks at the same time.
  const a = new SharedDocument(doc.update()),
    c = new SharedDocument(doc.update());
  const left = a.snapshot(b.id),
    right = c.snapshot(b.id);
  left.items.find((i) => i.id === design.id).task.status = "done";
  right.items.find((i) => i.id === build.id).task.assignee = {
    id: viewer.uuid,
    name: "Cam",
  };
  a.commit(left);
  c.commit(right);
  a.apply(c.update(a.vector()));
  c.apply(a.update(c.vector()));
  for (const merged of [a.snapshot(b.id), c.snapshot(b.id)]) {
    const items = new Map(merged.items.map((i) => [i.id, i]));
    assert.equal(items.get(design.id).task.status, "done");
    assert.equal(items.get(build.id).task.assignee.name, "Cam");
    validateBoard(merged);
  }
  // The task is one register: concurrent edits of the same task keep one
  // complete version rather than mixing fields.
  const x = new SharedDocument(a.update()),
    y = new SharedDocument(a.update());
  const sx = x.snapshot(b.id),
    sy = y.snapshot(b.id);
  sx.items.find((i) => i.id === design.id).task = {
    ...sx.items.find((i) => i.id === design.id).task,
    status: "blocked",
    priority: "low",
  };
  sy.items.find((i) => i.id === design.id).task = {
    ...sy.items.find((i) => i.id === design.id).task,
    status: "todo",
    due: "2026-12-01",
  };
  x.commit(sx);
  y.commit(sy);
  x.apply(y.update(x.vector()));
  const winner = x.snapshot(b.id).items.find((i) => i.id === design.id).task;
  assert.ok(
    (winner.status === "blocked" && winner.priority === "low") ||
      (winner.status === "todo" && winner.due === "2026-12-01"),
  );
  // Rebasing keeps a local planning change and adopts remote ones otherwise.
  const before = doc.snapshot(b.id);
  const local = { ...structuredClone(before), planning: undefined };
  assert.equal(rebase(local, before, before).planning, undefined);
  const remote = { ...structuredClone(before), planning: undefined };
  assert.equal(rebase(before, before, remote).planning, undefined);
  for (const d of [doc, a, c, x, y]) d.destroy();
});

test("copy, paste, duplication, and exports keep tasks; style copying does not", () => {
  const { b, design, build, dependency } = plan();
  const fragment = selectionFragment(b.items, new Set([design.id, build.id]));
  assert.deepEqual(fragment.find((i) => i.id === design.id).task, design.task);
  assert.equal(
    fragment.find((i) => i.id === dependency.id).dependency,
    "blocks",
  );
  const clipboard = JSON.parse(clipboardFormats(fragment)[CLIPBOARD_TYPE]);
  assert.ok(clipboard.items.some((i) => i.task?.priority === "high"));
  const duplicated = planDuplication(b.items, new Set([design.id]), {});
  assert.deepEqual(duplicated.copies[0].task, design.task);
  assert.notEqual(duplicated.copies[0].id, design.id);
  // A duplicate is a new task, not the one linked to the Jira issue.
  const { retro } = plan();
  const [copy] = planDuplication([retro], new Set([retro.id]), {}).copies;
  const { jira, ...unlinked } = retro.task;
  assert.ok(jira);
  assert.deepEqual(copy.task, unlinked);
  assert.equal(retro.task.jira, jira);
  const style = copyObjectStyle(design);
  assert.equal("task" in style, false);
  const target = item("note", 0, 0, {
    text: "Other",
    color: "#ffffff",
    task: newTask(),
  });
  applyObjectStyle(target, objectStylePatch(target, style));
  assert.equal(target.color, design.color);
  assert.deepEqual(target.task, newTask());
  const plainTarget = item("note", 0, 0, { text: "Plain", color: "#ffffff" });
  applyObjectStyle(plainTarget, objectStylePatch(plainTarget, style));
  assert.equal(plainTarget.task, undefined);
  const exported = JSON.parse(JSON.stringify(b));
  assert.deepEqual(validateBoard(exported).items[2].task, design.task);
});

test("task badges render status, initials, due dates, overdue state, and Jira keys on canvas, SVG, and PDF", async () => {
  taskClock.now = () => Date.parse(`${TODAY}T12:00:00`);
  try {
    const { b, design, build, retro } = plan();
    const ctx = createCanvas(400, 400).getContext("2d");
    const layout = taskLayout(ctx, design);
    assert.deepEqual(layout.labels, ["In progress", "BS", "Sep 24"]);
    const pill = layout.ops.find(
      (o) => o.op === "pill" && o.fill === "#fde7e4",
    );
    assert.ok(pill, "Overdue due dates are highlighted");
    assert.ok(
      layout.ops.some((o) => o.op === "circle" && o.fill === "#b3261e"),
      "Overdue dates carry an icon, not color alone",
    );
    assert.equal(
      taskLayout(ctx, build).ops.some((o) => o.fill === "#fde7e4"),
      false,
    );
    assert.ok(taskLayout(ctx, retro).labels.includes("WB-7"));
    // A due date in another year says which year.
    const later = { ...build, task: { ...build.task, due: "2028-01-15" } };
    assert.ok(taskLayout(ctx, later).labels.includes("Jan 15, 2028"));
    // A card too narrow for the year still shows the date without it,
    // wherever a date this year would fit.
    const soon = { ...build, task: { ...build.task, due: "2026-01-15" } };
    let narrowed = false;
    for (let w = 60; w <= 400; w += 2) {
      const labels = taskLayout(ctx, { ...later, w }).labels;
      if (!taskLayout(ctx, { ...soon, w }).labels.includes("Jan 15")) continue;
      if (labels.includes("Jan 15")) narrowed = true;
      else assert.ok(labels.includes("Jan 15, 2028"), `due date at width ${w}`);
    }
    assert.ok(narrowed);
    assert.equal(taskRow(b.items[7]), 0);
    // The footer reserves room below the text and paints inside the object.
    assert.ok(tagFooter(design) > 0);
    const canvas = createCanvas(300, 300),
      paint = canvas.getContext("2d");
    const probe = { ...design, x: 10, y: 10, w: 220, h: 190 };
    drawObject(paint, probe, "#30342f", () => {});
    const footer = paint.getImageData(14, 10 + 190 - 18, 60, 10).data;
    let white = 0;
    for (let n = 0; n < footer.length; n += 4)
      if (footer[n] > 245 && footer[n + 1] > 245 && footer[n + 2] > 245)
        white++;
    assert.ok(white > 40, "The status chip is painted in the footer");
    // Narrow objects keep the status icon and drop its label and the date.
    const narrow = { ...design, w: 40, h: 120 };
    assert.deepEqual(taskLayout(ctx, narrow).labels, ["BS"]);
    assert.ok(taskLayout(ctx, narrow).ops.some((o) => o.op === "circle"));
    // Plain text grows by the footer row.
    assert.equal(taskRow(b.items[4]), 26);
    const svg = exportSVG(b, exportRegions(b), { ctx: measure });
    assert.match(svg, /class="task-badge"/);
    assert.match(svg, />In progress</);
    assert.match(svg, />WB-7</);
    const rasterizer = async (board, rect, { scale, maxSize }) => {
      const s = Math.min(scale, maxSize / Math.max(rect.w, rect.h)),
        out = createCanvas(Math.ceil(rect.w * s), Math.ceil(rect.h * s)),
        c = out.getContext("2d");
      c.scale(s, s);
      c.translate(-rect.x, -rect.y);
      drawOrder(board.items).forEach((i) =>
        drawObject(c, i, "#30342f", () => {}),
      );
      return out;
    };
    const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
      mode: "vector",
      scale: "fit",
      measure,
    });
    const pdf = await PDFDocument.load(
      new Uint8Array(await blob.arrayBuffer()),
    );
    let content = "";
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      try {
        content +=
          object.dict.get(PDFName.of("Filter"))?.toString() === "/FlateDecode"
            ? new TextDecoder().decode(inflateSync(object.contents))
            : "";
      } catch {
        /* Image streams are not text. */
      }
    }
    const hex = (text) =>
      [...text]
        .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
    for (const text of ["In progress", "WB-7", "BS"])
      assert.ok(content.includes(hex(text)), text);
  } finally {
    taskClock.now = () => Date.now();
  }
});

test("an untitled task's generated title follows the interface language", async () => {
  const dom = new JSDOM("", { url: "https://whiteboard.test" });
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  const { setLanguage } = await import("../src/i18n.js");
  const b = board("Plan");
  const blank = item("note", 0, 0, { text: "", task: { status: "todo" } });
  b.items = [blank];
  try {
    assert.equal(collectTasks(b, { today: TODAY })[0].title, "Untitled task");
    setLanguage("fr");
    // The same object, read again after the language changed.
    assert.equal(
      collectTasks(b, { today: TODAY })[0].title,
      "Tâche sans titre",
    );
    setLanguage("en");
    assert.equal(collectTasks(b, { today: TODAY })[0].title, "Untitled task");
  } finally {
    setLanguage("en");
    delete globalThis.document;
    delete globalThis.localStorage;
    dom.window.close();
  }
});

test("the task list filters, groups, sorts, summarizes, and exports", async () => {
  const { b, design, build, ship, retro, todo, done } = plan();
  const rows = collectTasks(b, { today: TODAY });
  assert.equal(rows.length, 4);
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(design.id).overdue, true);
  assert.equal(byId.get(retro.id).overdue, false);
  assert.deepEqual(
    byId.get(build.id).blockedBy.map((x) => x.title),
    ["Design review"],
  );
  assert.equal(byId.get(build.id).frame, "To do");
  assert.deepEqual(
    filterTasks(rows, { status: "todo" })
      .map((r) => r.id)
      .sort(),
    [build.id, ship.id].sort(),
  );
  assert.deepEqual(
    filterTasks(rows, { assignee: editor.uuid }).map((r) => r.id),
    [design.id],
  );
  assert.deepEqual(
    filterTasks(rows, { assignee: "" })
      .map((r) => r.id)
      .sort(),
    [ship.id, retro.id].sort(),
  );
  assert.deepEqual(
    filterTasks(rows, { overdue: true }).map((r) => r.id),
    [design.id],
  );
  assert.deepEqual(
    filterTasks(rows, { frame: done.id }).map((r) => r.id),
    [retro.id],
  );
  assert.deepEqual(
    filterTasks(rows, { blocked: true }).map((r) => r.id),
    [build.id],
  );
  assert.deepEqual(
    sortTasks(rows, "due").map((r) => r.title),
    ["Design review", "Build pages", "Ship", "Retrospective"],
  );
  assert.deepEqual(
    sortTasks(rows, "due-desc").map((r) => r.title),
    ["Ship", "Build pages", "Design review", "Retrospective"],
  );
  assert.deepEqual(
    groupTasks(rows, "status").map((g) => [g.key, g.rows.length]),
    [
      ["todo", 2],
      ["in-progress", 1],
      ["done", 1],
    ],
  );
  assert.deepEqual(
    groupTasks(rows, "assignee").map((g) => g.label),
    ["Alice", "Bob Smith", "Unassigned"],
  );
  assert.deepEqual(
    groupTasks(rows, "frame").map((g) => g.key),
    [done.id, todo.id],
  );
  const summary = summarizeTasks(rows);
  assert.deepEqual(summary.byStatus, {
    todo: 2,
    "in-progress": 1,
    blocked: 0,
    done: 1,
  });
  assert.equal(summary.overdue, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.completion, 25);
  // Rounding never reports every task done while one is open, or none done
  // when some are.
  const many = (done, total) =>
    summarizeTasks(
      Array.from({ length: total }, (_, n) => ({
        ...rows[0],
        id: "r" + n,
        status: n < done ? "done" : "todo",
      })),
    ).completion;
  assert.equal(many(199, 200), 99);
  assert.equal(many(1, 201), 1);
  assert.equal(many(200, 200), 100);
  assert.equal(many(0, 200), 0);
  assert.equal(many(1, 3), 33);
  assert.deepEqual(
    summary.assignees.map((a) => [a.name, a.total]),
    [
      ["Alice", 1],
      ["Bob Smith", 1],
      ["Unassigned", 2],
    ],
  );
  const sheet = taskSheet(sortTasks(rows, "due"));
  assert.deepEqual(sheet.rows[0].slice(0, 5), [
    "Task",
    "Status",
    "Assignee",
    "Start",
    "Due",
  ]);
  assert.deepEqual(sheet.rows[1].slice(0, 8), [
    "Design review",
    "In progress",
    "Bob Smith",
    "2026-09-20",
    "2026-09-24",
    "High",
    "To do",
    "",
  ]);
  assert.equal(sheet.rows[2][7], "Design review");
  const csvBlob = exportTasksCSV(sortTasks(rows, "due"));
  assert.deepEqual(
    [...new Uint8Array(await csvBlob.arrayBuffer()).slice(0, 3)],
    [0xef, 0xbb, 0xbf],
  );
  const csv = await csvBlob.text();
  assert.ok(csv.startsWith("Task,Status,Assignee"));
  assert.match(csv, /Retrospective,Done,,,,,Terminé,,,,WB-7,Done,/);
  const xlsx = new Uint8Array(
    await exportTasksXLSX(rows, "Launch").arrayBuffer(),
  );
  assert.deepEqual([...xlsx.slice(0, 2)], [0x50, 0x4b]);
  // Only Start and Due become dates; a title that looks like one stays text.
  // The workbook's parts are stored uncompressed, so its XML can be read.
  const dated = new TextDecoder().decode(
    await exportTasksXLSX(
      [{ ...rows[0], title: "2026-10-15", start: "", due: "2026-10-20" }],
      "Dates",
    ).arrayBuffer(),
  );
  // The tasks sheet is the first one.
  const tasksXML = dated.slice(
    dated.indexOf("<worksheet"),
    dated.indexOf("</worksheet>"),
  );
  assert.match(tasksXML, /<c r="A2" t="s">/);
  assert.match(tasksXML, /<c r="E2" s="2"><v>46315<\/v>/);
  // The Summary sheet tells the Blocked status from tasks blocked by others.
  const measures = summarySheet(summarizeTasks(rows)).rows.map((r) => r[0]);
  assert.equal(new Set(measures).size, measures.length);
  assert.ok(measures.includes("Blocked by other tasks"));
  // The board spreadsheet export reads structured task fields as text.
  const objects = spreadsheetModel(b, exportRegions(b))[0].rows;
  const header = objects[0];
  const designRow = objects.find((r) => r.includes("Design review"));
  assert.equal(designRow[header.indexOf("Assignee")], "Bob Smith");
  assert.equal(designRow[header.indexOf("Status")], "In progress");
  assert.equal(designRow[header.indexOf("Priority")], "High");
  const retroRow = objects.find((r) => r.includes("Retrospective"));
  assert.equal(retroRow[header.indexOf("Jira")], "WB-7");
});

test("the task spreadsheet lists every predecessor, including finished ones", () => {
  const { b, design, build } = plan();
  design.task.status = "done";
  const rows = collectTasks(b, { today: TODAY });
  const sheet = taskSheet(rows),
    column = sheet.rows[0].indexOf("Predecessors");
  assert.ok(column > sheet.rows[0].indexOf("Blocked by"));
  const row = sheet.rows.find((r) => r.at(-1) === build.id);
  assert.equal(row[sheet.rows[0].indexOf("Blocked by")], "");
  assert.equal(row[column], "Design review");
});

test("dependencies block successors until their predecessors are done", () => {
  const { b, design, build, ship, dependency } = plan();
  assert.deepEqual(dependencyEdges(b.items), [
    { from: design.id, to: build.id, line: dependency.id },
  ]);
  assert.deepEqual(
    [...blockers(b.items)].map(([id, list]) => [id, list.map((i) => i.id)]),
    [[build.id, [design.id]]],
  );
  // "Depends on" reverses the direction.
  const reverse = {
    ...item("arrow", 0, 0, { text: "" }),
    startId: ship.id,
    endId: build.id,
    dependency: "depends-on",
  };
  b.items.push(reverse);
  assert.deepEqual(
    blockers(b.items)
      .get(ship.id)
      .map((i) => i.id),
    [build.id],
  );
  design.task.status = "done";
  assert.equal(blockers(b.items).has(build.id), false);
  // Connectors to ordinary objects are not dependencies.
  const loose = {
    ...item("arrow", 0, 0, { text: "" }),
    startId: b.items[7].id,
    endId: build.id,
    dependency: "blocks",
  };
  b.items.push(loose);
  validateBoard(structuredClone(b));
  assert.equal(dependencyEdges(b.items).length, 2);
  // A second line saying the same thing adds nothing, and a line from a
  // task back to itself is not a dependency.
  design.task.status = "todo";
  const again = {
    ...item("arrow", 0, 0, { text: "" }),
    startId: build.id,
    endId: design.id,
    dependency: "depends-on",
  };
  const self = {
    ...item("arrow", 0, 0, { text: "" }),
    startId: design.id,
    endId: design.id,
  };
  assert.equal(canBeDependency(self, b.items), false);
  b.items.push(again, { ...self, dependency: "blocks" });
  assert.equal(dependencyEdges(b.items).length, 2);
  assert.deepEqual(
    blockers(b.items)
      .get(build.id)
      .map((i) => i.id),
    [design.id],
  );
  assert.equal(blockers(b.items).has(design.id), false);
});

test("timeline models and generated timeline frames are valid, linked, and accessible data", () => {
  const { b, design, build, ship, retro } = plan();
  const rows = collectTasks(b, { today: TODAY });
  const model = timelineModel(rows, {
    today: TODAY,
    groupBy: "assignee",
    edges: dependencyEdges(b.items),
  });
  assert.deepEqual(
    model.lanes.map((l) => l.label),
    ["Alice", "Bob Smith", "Unassigned"],
  );
  assert.deepEqual(
    model.unscheduled.map((r) => r.id),
    [retro.id],
  );
  const bar = model.lanes[1].bars[0];
  assert.equal(bar.row.id, design.id);
  assert.equal(bar.end - bar.start + 1, 5);
  assert.match(bar.label, /Design review, In progress, Sep 20 to Sep 24/);
  assert.ok(model.today > 0 && model.today < 100);
  assert.equal(model.edges.length, 1);
  const { items, frame } = timelineItems(b, rows, {
    today: TODAY,
    origin: { x: 0, y: 900 },
  });
  const next = { ...structuredClone(b), items: [...b.items, ...items] };
  updateConnectors(next.items);
  validateBoard(next);
  assert.equal(frame.type, "frame");
  assert.ok(items.slice(1).every((i) => i.parentId === frame.id));
  assert.ok(
    items.every((i) => i.x + i.w <= frame.x + frame.w),
    "No label sticks out past the frame's right edge",
  );
  const bars = items.filter((i) => i.objectLink);
  assert.deepEqual(
    bars.map((i) => i.objectLink.objectId).sort(),
    [design.id, build.id, ship.id].sort(),
  );
  const designBar = bars.find((i) => i.objectLink.objectId === design.id);
  const buildBar = bars.find((i) => i.objectLink.objectId === build.id);
  assert.match(designBar.text, /Design review \(In progress\)/);
  assert.ok(buildBar.x > designBar.x, "Later tasks start further right");
  const arrow = items.find((i) => i.type === "arrow");
  assert.equal(arrow.startId, designBar.id);
  assert.equal(arrow.endId, buildBar.id);
  const today = items.find((i) => i.type === "text" && i.text === "Today");
  assert.ok(today);
  // "Today" overlaps no date label, and stays inside the frame.
  const overlaps = (a, b) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const dates = items.filter(
    (i) => i.type === "text" && i !== today && i.fontSize === 12,
  );
  assert.ok(dates.length > 1);
  assert.ok(dates.every((d) => !overlaps(d, today)));
  assert.ok(today.y + today.h <= frame.y + frame.h);
  assert.ok(items.some((i) => i.type === "text" && i.text === "Bob Smith"));
  assert.throws(
    () => timelineItems(b, [rows.find((r) => r.id === retro.id)]),
    /Add start or due dates/,
  );
  // A task with text near the object limit still gives a valid bar.
  const long = structuredClone(b);
  long.items.find((i) => i.id === design.id).text = "x".repeat(19990);
  const placed = timelineItems(long, collectTasks(long, { today: TODAY }), {
    today: TODAY,
  }).items;
  validateBoard({ ...long, items: [...long.items, ...placed] });
  const longBar = placed.find((i) => i.objectLink?.objectId === design.id);
  assert.ok(longBar.text.length < 250);
  // Long ranges, such as a mistyped year, keep a few labels and a frame
  // that stays valid and a usable width.
  const far = structuredClone(b);
  far.items.find((i) => i.id === ship.id).task.due = "9999-12-31";
  const farRows = collectTasks(far, { today: TODAY });
  const farModel = timelineModel(farRows, { today: TODAY });
  assert.equal(farModel.unit, "year");
  assert.ok(farModel.ticks.length <= 12);
  assert.ok(farModel.ticks.every((tick) => /^\d{4}$/.test(tick.label)));
  const wide = timelineItems(far, farRows, { today: TODAY });
  assert.ok(wide.frame.w <= 25000);
  assert.ok(wide.items.length < 30);
  validateBoard({ ...far, items: [...far.items, ...wide.items] });
  far.items.find((i) => i.id === ship.id).task.due = "2028-06-30";
  const quarters = timelineModel(collectTasks(far, { today: TODAY }), {
    today: TODAY,
  });
  assert.equal(quarters.unit, "quarter");
  assert.ok(
    quarters.ticks.every((tick) =>
      ["01", "04", "07", "10"].includes(dateFromDay(tick.day).slice(5, 7)),
    ),
  );
  // Month and quarter ticks name the month and year, not the first day.
  assert.equal(quarters.ticks[0].label, "Oct 2026");
  far.items.find((i) => i.id === ship.id).task.due = "2027-06-30";
  const months = timelineModel(collectTasks(far, { today: TODAY }), {
    today: TODAY,
    language: "fr",
  });
  assert.equal(months.unit, "month");
  assert.equal(months.ticks[0].label, "oct. 2026");
});

test("a placed timeline is recognised by its content and refreshed in place from its tasks", () => {
  const { b, todo, design, build, ship } = plan();
  const placed = timelineItems(b, collectTasks(b, { today: TODAY }), {
    today: TODAY,
    groupBy: "status",
    origin: { x: 0, y: 900 },
  });
  const frame = placed.frame;
  frame.text = "Launch roadmap";
  b.items.push(...placed.items);
  const bar = (items, task) =>
    items.find(
      (i) => i.parentId === frame.id && i.objectLink?.objectId === task,
    );
  const designBar = bar(b.items, design.id);
  // Someone's note inside the timeline, and a connector from outside to a
  // bar, are not part of what it generates.
  const note = item("note", frame.x + 40, frame.y + frame.h - 60, {
    text: "Ask legal",
    parentId: frame.id,
  });
  const outside = item("note", -400, 950, { text: "Kickoff" });
  const link = {
    ...item("arrow", 0, 0, { text: "" }),
    startId: outside.id,
    endId: designBar.id,
  };
  b.items.push(note, outside, link);
  updateConnectors(b.items);
  // Ordinary frames, and a frame holding only a link to a note, are not
  // timelines.
  assert.equal(placedTimeline(b.items, todo.id), null);
  const linked = item("frame", 3000, 0, { w: 400, h: 400, text: "Links" });
  b.items.push(linked, {
    ...item("rect", 3020, 40, { text: "" }),
    parentId: linked.id,
    objectLink: { objectId: note.id },
  });
  assert.equal(placedTimeline(b.items, linked.id), null);
  // Nor is a frame with a white panel and a button linking to a task.
  const notes = item("frame", 4000, 0, { w: 600, h: 400, text: "Notes" });
  const withNotes = [
    ...b.items,
    notes,
    {
      ...item("rect", 4020, 40, { w: 500, h: 300, color: "#ffffff" }),
      text: "",
      parentId: notes.id,
    },
    {
      ...item("rect", 4100, 100, { w: 200, h: 40, color: "#ffffff" }),
      text: "Open task",
      parentId: notes.id,
      objectLink: { objectId: design.id },
    },
  ];
  assert.equal(placedTimeline(withNotes, notes.id), null);
  const found = placedTimeline(b.items, frame.id);
  assert.ok(found);
  const generated = new Set(found.generated.map((i) => i.id));
  assert.deepEqual(
    [...generated].sort(),
    placed.items
      .slice(1)
      .map((i) => i.id)
      .sort(),
  );
  // The tasks change after placing: one is finished, one moves, one stops
  // being a task, and a new one is planned.
  design.task.status = "done";
  ship.task.due = "2026-10-14";
  delete build.task;
  const added = item("note", 30, 400, {
    text: "Write docs",
    parentId: todo.id,
    task: {
      assignee: null,
      start: "2026-10-01",
      due: "2026-10-03",
      status: "todo",
    },
  });
  b.items.push(added);
  const before = structuredClone(b.items);
  const items = refreshedTimeline(b, found, collectTasks(b, { today: TODAY }), {
    today: TODAY,
  });
  assert.deepEqual(b.items, before, "The board itself is left unchanged");
  validateBoard({ ...b, items });
  // The frame keeps its id, place, title, and order, and stays where it
  // was in the stacking order.
  const after = items.find((i) => i.id === frame.id);
  assert.deepEqual(
    { x: after.x, y: after.y, text: after.text, order: after.order },
    { x: frame.x, y: frame.y, text: "Launch roadmap", order: frame.order },
  );
  assert.equal(
    items.findIndex((i) => i.id === frame.id),
    b.items.findIndex((i) => i.id === frame.id),
  );
  assert.equal(items.filter((i) => i.type === "frame").length, 4);
  // Bars show the tasks as they are now, by the same lanes.
  const nextDesign = bar(items, design.id);
  assert.equal(nextDesign.id, designBar.id, "A bar keeps its id");
  assert.match(nextDesign.text, /^Design review \(Done\)$/);
  assert.equal(nextDesign.color, BAR_COLORS.done);
  assert.equal(bar(items, build.id), undefined);
  assert.ok(bar(items, added.id));
  assert.ok(
    bar(items, ship.id).x + bar(items, ship.id).w >
      bar(b.items, ship.id).x + bar(b.items, ship.id).w,
    "The moved due date lengthens its bar",
  );
  const captions = items
    .filter((i) => i.parentId === frame.id && i.bold && i.fontSize === 14)
    .map((i) => i.text);
  assert.deepEqual(captions, ["To do", "Done"]);
  // The dependency on the task that is gone goes with its bar; the note
  // and the connector to a bar that stays are kept.
  assert.ok(!items.some((i) => i.type === "arrow" && i.parentId === frame.id));
  assert.ok(items.some((i) => i.id === link.id && i.endId === designBar.id));
  assert.ok(items.some((i) => i.id === note.id && i.parentId === frame.id));
  assert.ok(after.y + after.h >= note.y + note.h);
  // Nothing generated before is left behind, and refreshing again finds
  // the same timeline and changes nothing.
  assert.ok(
    [...generated].every(
      (id) =>
        id === designBar.id ||
        id === bar(b.items, ship.id).id ||
        !items.some((i) => i.id === id),
    ),
  );
  const again = placedTimeline(items, frame.id);
  // Bars and the frame keep their ids; other generated objects are new.
  const shape = (i) => [
    i.parentId !== frame.id || i.objectLink || i.id === note.id ? i.id : "",
    i.type,
    i.text,
    i.x,
    i.y,
    i.w,
    i.h,
  ];
  assert.equal(
    again.generated.length,
    items.filter((i) => i.parentId === frame.id).length - 1,
  );
  assert.deepEqual(
    refreshedTimeline(
      { ...b, items },
      again,
      collectTasks({ ...b, items }, { today: TODAY }),
      {
        today: TODAY,
      },
    ).map(shape),
    items.map(shape),
  );
  // A moved timeline is still recognised.
  const moved = items.map((i) =>
    i.id === frame.id || i.parentId === frame.id
      ? { ...i, x: i.x + 333, y: i.y - 77 }
      : i,
  );
  assert.equal(
    placedTimeline(moved, frame.id)?.generated.length,
    again.generated.length,
  );
});

test("a refreshed timeline keeps the lanes it was placed with", () => {
  for (const groupBy of ["assignee", "frame", "status"]) {
    const { b, ship } = plan();
    const placed = timelineItems(b, collectTasks(b, { today: TODAY }), {
      today: TODAY,
      groupBy,
    });
    b.items.push(...placed.items);
    const captions = (items) =>
      items
        .filter((i) => i.parentId === placed.frame.id && i.fontSize === 14)
        .map((i) => i.text);
    const width = (items) =>
      items.find((i) => i.objectLink?.objectId === ship.id).w;
    // A later due date changes the bar, not the lanes.
    ship.task.start = "2026-10-08";
    const items = refreshedTimeline(
      b,
      placedTimeline(b.items, placed.frame.id),
      collectTasks(b, { today: TODAY }),
      { today: TODAY },
    );
    assert.ok(width(items) > width(placed.items), groupBy);
    assert.deepEqual(captions(items), captions(placed.items), groupBy);
  }
});

test("a refreshed timeline takes in the objects its grown frame covers", () => {
  const b = board("Timeline");
  const task = (n, who) =>
    item("note", n * 220, 0, {
      text: `Task ${n}`,
      task: {
        assignee: { id: who, name: who },
        start: "2026-10-01",
        due: "2026-10-09",
        status: "todo",
      },
    });
  b.items = [task(0, "Ana"), task(1, "Ana")];
  const placed = timelineItems(b, collectTasks(b, { today: TODAY }), {
    today: TODAY,
    origin: { x: 0, y: 400 },
  });
  b.items.push(...placed.items);
  const f = placed.frame;
  const below = item("note", f.x, f.y + f.h + 40, { text: "Below" }),
    hidden = item("note", f.x + 240, f.y + f.h + 40, { text: "Hidden" }),
    far = item("note", f.x, f.y + 5000, { text: "Far" });
  b.items.push(below, hidden, far);
  // More people's tasks, later, need more lanes and a wider frame.
  for (let n = 2; n < 8; n++) {
    const more = task(n, `P${n}`);
    more.task.due = "2026-12-20";
    b.items.push(more);
  }
  const before = structuredClone(b.items);
  const items = refreshedTimeline(
    b,
    placedTimeline(b.items, f.id),
    collectTasks(b, { today: TODAY }),
    { today: TODAY, skip: new Set([hidden.id]) },
  );
  assert.deepEqual(b.items, before, "The board itself is left unchanged");
  validateBoard({ ...b, items });
  const frame = items.find((i) => i.id === f.id),
    find = (id) => items.find((i) => i.id === id);
  assert.ok(frame.y + frame.h > below.y + below.h, "The frame grew over it");
  assert.equal(find(below.id).parentId, f.id);
  // An object hidden from this person, or one the frame does not reach,
  // stays out.
  assert.equal(find(hidden.id).parentId, undefined);
  assert.equal(find(far.id).parentId, undefined);
});

test("Kanban status sync updates tasks moved into status frames only when enabled", () => {
  assert.equal(statusFromTitle("To do"), "todo");
  assert.equal(statusFromTitle("À faire"), "todo");
  // Every Kanban template column matches in French too.
  assert.equal(statusFromTitle("Backlog"), "todo");
  assert.equal(statusFromTitle("Carnet"), "todo");
  assert.equal(statusFromTitle("Terminées"), "done");
  assert.equal(statusFromTitle("Terminés (4)"), "done");
  // The Scrum and Kanban templates' other columns: work waiting to start is
  // to do, work under review is still in progress.
  assert.equal(statusFromTitle("Product backlog"), "todo");
  assert.equal(statusFromTitle("Carnet de produit"), "todo");
  assert.equal(statusFromTitle("Ready (WIP 5)"), "todo");
  assert.equal(statusFromTitle("Prêt (limite 5)"), "todo");
  assert.equal(statusFromTitle("Review"), "in-progress");
  assert.equal(statusFromTitle("Révision (limite 2)"), "in-progress");
  // Kanban template columns carry work-in-progress limits.
  assert.equal(statusFromTitle("In progress (WIP 3)"), "in-progress");
  assert.equal(statusFromTitle("En cours (limite 3)"), "in-progress");
  assert.equal(statusFromTitle("Done (3)"), "done");
  assert.equal(statusFromTitle("In Progress (3)"), "in-progress");
  assert.equal(statusFromTitle("En cours"), "in-progress");
  assert.equal(statusFromTitle("Bloqué"), "blocked");
  assert.equal(statusFromTitle("Bloquées"), "blocked");
  assert.equal(statusFromTitle("Done"), "done");
  assert.equal(statusFromTitle("Terminé"), "done");
  assert.equal(statusFromTitle("Ideas"), null);
  const { b, design, done, plain } = plan();
  const before = taskParents(b.items);
  design.parentId = done.id;
  plain.parentId = done.id;
  assert.deepEqual(applyStatusSync(b, before), []);
  assert.equal(design.task.status, "in-progress");
  assert.equal(statusSyncChanges(before, b.items).length, 1);
  b.planning = { statusSync: true };
  const changes = applyStatusSync(b, before);
  assert.deepEqual(
    changes.map((c) => [c.item.id, c.status]),
    [[design.id, "done"]],
  );
  assert.equal(design.task.status, "done");
  assert.equal(plain.task, undefined);
  validateBoard(structuredClone(b));
});

test("the Kanban and Scrum templates are working task boards in both languages", () => {
  for (const id of ["kanban", "scrum-board"])
    for (const language of ["en", "fr"]) {
      const b = fromTemplate(id, language);
      assert.deepEqual(b.planning, { statusSync: true });
      const columns = new Map(
        b.items.filter((i) => i.type === "frame").map((f) => [f.id, f]),
      );
      const column = (i) =>
        statusFromTitle(columns.get(i.parentId)?.text || "");
      const cards = b.items.filter((i) => i.type === "note" && column(i));
      assert.ok(cards.length >= 8, `${id} ${language}`);
      for (const card of cards)
        assert.equal(
          card.task.status,
          /^(Blocked|Bloqué)/.test(card.text) ? "blocked" : column(card),
          card.text,
        );
      // Notes outside the columns (policies, goals) stay plain notes.
      assert.ok(
        b.items
          .filter((i) => i.type === "note" && !column(i))
          .every((i) => !i.task),
      );
      validateBoard(structuredClone(b));
      // Moving a card to the Done column marks it done.
      const card = cards.find((c) => c.task.status === "todo"),
        done = [...columns.values()].find(
          (f) => statusFromTitle(f.text) === "done",
        );
      const before = taskParents(b.items);
      card.parentId = done.id;
      assert.deepEqual(
        applyStatusSync(b, before).map((c) => [c.item.id, c.status]),
        [[card.id, "done"]],
      );
    }
  assert.equal(
    fromTemplate("kanban").items.filter((i) => i.task?.status === "blocked")
      .length,
    1,
  );
  // Other templates are not task boards.
  const brainstorm = fromTemplate("brainstorm");
  assert.equal(brainstorm.planning, undefined);
  assert.ok(brainstorm.items.every((i) => !i.task));
});

test("turning Kanban status sync on lines up tasks already in status columns", () => {
  const { b, design, build, done } = plan();
  const shipped = item("note", 760, 300, {
    text: "Shipped",
    parentId: done.id,
    task: newTask(),
  });
  b.items.push(shipped);
  const changes = alignColumnStatuses(b);
  assert.deepEqual(
    changes.map((c) => [c.item.id, c.status]),
    [[shipped.id, "done"]],
  );
  // A status someone chose is kept: design is in progress in To do.
  assert.equal(design.task.status, "in-progress");
  assert.equal(design.task.priority, "high");
  assert.equal(build.task.status, "todo");
  assert.equal(shipped.task.status, "done");
  assert.deepEqual(alignColumnStatuses(b), []);
  // Turning sync off and on again keeps the Kanban template's blocked card.
  const kanban = fromTemplate("kanban");
  assert.deepEqual(alignColumnStatuses(kanban), []);
  assert.equal(
    kanban.items.filter((i) => i.task?.status === "blocked").length,
    1,
  );
});

test("Kanban status sync gives a card made a task inside a status column that column's status", () => {
  const { b, done, plain } = plan();
  b.planning = { statusSync: true };
  // The board's first task, made from a note already in the Done column.
  const empty = { ...b, items: b.items.filter((i) => !i.task) };
  const note = item("note", 760, 300, { text: "Ship it", parentId: done.id });
  empty.items.push(note);
  let before = taskParents(empty.items);
  note.task = { assignee: null, start: null, due: null, status: "todo" };
  assert.deepEqual(
    applyStatusSync(empty, before).map((c) => [c.item.id, c.status]),
    [[note.id, "done"]],
  );
  // A card added to a column as a new task.
  before = taskParents(b.items);
  plain.parentId = done.id;
  plain.task = { assignee: null, start: null, due: null, status: "todo" };
  const card = item("note", 760, 400, {
    text: "New card",
    parentId: done.id,
    task: { assignee: null, start: null, due: null, status: "todo" },
  });
  b.items.push(card);
  assert.deepEqual(
    applyStatusSync(b, before).map((c) => [c.item.id, c.status]),
    [
      [plain.id, "done"],
      [card.id, "done"],
    ],
  );
  // A task outside any column, or unchanged in its column, is left alone.
  before = taskParents(b.items);
  const loose = item("note", 2000, 0, {
    text: "Loose",
    task: { assignee: null, start: null, due: null, status: "todo" },
  });
  b.items.push(loose);
  assert.deepEqual(applyStatusSync(b, before), []);
});

test("Kanban status sync keeps the status of a pasted, duplicated or inserted card", () => {
  const { b, done } = plan();
  b.planning = { statusSync: true };
  const before = taskParents(b.items);
  // A blocked card pasted into Done, as a duplicate or a second copy of the
  // Kanban template's blocked card, stays blocked; a new card still to do
  // takes the column's status.
  const blocked = item("note", 760, 300, {
    text: "Waiting on legal",
    parentId: done.id,
    task: newTask({ status: "blocked" }),
  });
  const fresh = item("note", 760, 400, {
    text: "New card",
    parentId: done.id,
    task: newTask(),
  });
  b.items.push(blocked, fresh);
  assert.deepEqual(
    applyStatusSync(b, before).map((c) => [c.item.id, c.status]),
    [[fresh.id, "done"]],
  );
  assert.equal(blocked.task.status, "blocked");
  // Inserting the Kanban template twice keeps both copies' blocked cards.
  const kanban = fromTemplate("kanban");
  const copy = fromTemplate("kanban");
  const parents = taskParents(kanban.items);
  kanban.items.push(...copy.items);
  assert.deepEqual(applyStatusSync(kanban, parents), []);
  assert.equal(
    kanban.items.filter((i) => i.task?.status === "blocked").length,
    2,
  );
});

test("Jira helpers link created issues, refresh statuses, and explain availability", () => {
  const { b, design, build, retro } = plan();
  const result = applyCreated(b.items, [
    {
      item: design.id,
      key: "WB-8",
      url: "https://team.atlassian.net/browse/WB-8",
    },
    {
      item: build.id,
      error: "Jira returned 400.",
      detail: "Specify a valid issue type",
    },
  ]);
  assert.deepEqual(result, {
    linked: 1,
    failed: 1,
    error: "Jira returned 400.",
    detail: "Specify a valid issue type",
    unlinked: [],
  });
  assert.deepEqual(design.task.jira, {
    key: "WB-8",
    url: "https://team.atlassian.net/browse/WB-8",
  });
  assert.equal(
    applyStatuses(b.items, [
      { key: "WB-8", status: "In Review" },
      { key: "WB-7", status: "Done" },
    ]),
    1,
  );
  assert.equal(design.task.jira.status, "In Review");
  assert.equal(retro.task.jira.status, "Done");
  // The task's own status follows the issue's status category.
  design.task.status = "blocked";
  assert.equal(
    applyStatuses(b.items, [
      { key: "WB-8", status: "Done", category: "done" },
      { key: "WB-7", status: "Reopened", category: "new" },
    ]),
    2,
  );
  assert.equal(design.task.status, "done");
  assert.equal(retro.task.status, "todo");
  assert.equal(
    applyStatuses(b.items, [
      { key: "WB-8", status: "In Progress", category: "indeterminate" },
    ]),
    1,
  );
  assert.equal(design.task.status, "in-progress");
  // A status set on the board stays while Jira's does not change.
  design.task.status = "blocked";
  assert.equal(
    applyStatuses(b.items, [
      { key: "WB-8", status: "In Progress", category: "indeterminate" },
    ]),
    0,
  );
  assert.equal(design.task.status, "blocked");
  assert.equal(
    applyStatuses(b.items, [
      { key: "WB-8", status: "In Review", category: "indeterminate" },
    ]),
    1,
  );
  assert.equal(design.task.status, "blocked");
  validateBoard(structuredClone(b));
  const session = { server: "https://org.puter.work", room: "r" };
  const org = (allowed, server = session.server) => ({
    server,
    info: { configured: true, role: "member" },
    allows: () => allowed,
  });
  assert.equal(jiraStatus(org(true), null).available, false);
  assert.equal(jiraStatus(org(true), session).available, true);
  assert.match(jiraStatus(org(false), session).message, /not set up/);
  assert.match(
    jiraStatus(org(true, "https://other.puter.work"), session).message,
    /not on your organization's server/,
  );
  assert.match(
    jiraStatus({ server: null, info: null, allows: () => true }, session)
      .message,
    /Join an organization/,
  );
  assert.match(
    jiraStatus(
      { ...org(true), info: { configured: true, role: "guest" } },
      session,
    ).message,
    /available to organization members/,
  );
});

test("a task hidden from its assignee is not named to them when assigned", async () => {
  const env = environment();
  const boards = env.service;
  const b = board("Workshop");
  const frame = item("frame", 0, 0, { w: 500, h: 500, text: "Later" });
  const note = item("note", 10, 10, {
    text: "Confidential plan",
    parentId: frame.id,
    task: newTask(),
  });
  b.items = [frame, note];
  b.workshop = { settings: { lock: "open", hide: [frame.id] } };
  const seed = new SharedDocument();
  seed.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await boards.call(owner, {
    op: "invite",
    room: b.id,
    role: "editor",
  });
  await boards.call(editor, { op: "join", room: b.id, token: invite.token });
  const { doc } = await boards.load(b.id);
  const vector = doc.vector();
  const next = doc.snapshot();
  next.items.find((i) => i.id === note.id).task = {
    ...newTask(),
    assignee: { id: editor.uuid, name: "Bob" },
  };
  doc.commit(next);
  const update = doc.update(vector);
  doc.destroy();
  await boards.call(owner, {
    op: "commit",
    room: b.id,
    id: await hash(update),
    update: encode(update),
  });
  const list = await adminCall(boards.org, boards, editor, {
    op: "notifications.list",
  });
  assert.equal(list.items.length, 0);
  assert.ok(!JSON.stringify(list).includes("Confidential"));
  // The assignment is still audited.
  assert.ok(
    [...env.data.values()].some(
      (e) => e?.action === "board.content.task_assigned",
    ),
  );
});

test("assignments past the first hundred in one edit are notified and audited", async () => {
  const env = environment();
  const boards = env.service;
  const b = board("Big plan");
  b.items = [item("note", 0, 0, { text: "Start" })];
  const seed = new SharedDocument();
  seed.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  for (const user of [editor, viewer]) {
    const invite = await boards.call(owner, {
      op: "invite",
      room: b.id,
      role: "editor",
    });
    await boards.call(user, { op: "join", room: b.id, token: invite.token });
  }
  const { doc } = await boards.load(b.id);
  const vector = doc.vector();
  const next = doc.snapshot();
  for (let n = 0; n < 101; n++)
    next.items.push(
      item("note", n * 10, 200, {
        text: `Task ${n}`,
        task: {
          ...newTask(),
          assignee:
            n < 100
              ? { id: editor.uuid, name: "Bob" }
              : { id: viewer.uuid, name: "Cam" },
        },
      }),
    );
  doc.commit(next);
  const update = doc.update(vector);
  doc.destroy();
  await boards.call(owner, {
    op: "commit",
    room: b.id,
    id: await hash(update),
    update: encode(update),
  });
  const list = async (user) =>
    (await adminCall(boards.org, boards, user, { op: "notifications.list" }))
      .items;
  assert.equal((await list(viewer)).length, 1);
  const [grouped] = await list(editor);
  assert.equal(grouped.more, 99);
  const audits = [...env.data.entries()]
    .filter(([key]) => key.startsWith("org:audit:"))
    .map(([, e]) => e)
    .filter((e) => e?.action === "board.content.task_assigned");
  assert.equal(audits.length, 101);
  assert.deepEqual(audits.find((e) => e.details.count).details, {
    count: 1,
    assignees: [viewer.uuid],
  });
});

test("a task that comes back with the same assignee does not notify them again", async () => {
  const env = environment();
  const boards = env.service;
  const b = board("Sprint");
  const note = item("note", 0, 0, { text: "Write the brief", task: newTask() });
  b.items = [note];
  const seed = new SharedDocument();
  seed.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  for (const user of [editor, viewer]) {
    const invite = await boards.call(owner, {
      op: "invite",
      room: b.id,
      role: "editor",
    });
    await boards.call(user, { op: "join", room: b.id, token: invite.token });
  }
  async function commit(change) {
    const { doc } = await boards.load(b.id);
    const vector = doc.vector();
    const next = doc.snapshot();
    change(next);
    doc.commit(next);
    const update = doc.update(vector);
    doc.destroy();
    env.now += 1000;
    return boards.call(owner, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
    });
  }
  const notices = async (user) =>
    (await adminCall(boards.org, boards, user, { op: "notifications.list" }))
      .items.length;
  const assigned = (to) => ({
    ...structuredClone(note),
    task: { ...newTask(), assignee: { id: to.uuid, name: to.username } },
  });
  await commit((next) => (next.items = [assigned(editor)]));
  assert.equal(await notices(editor), 1);
  // Deleted, then brought back, twice.
  for (let n = 0; n < 2; n++) {
    await commit((next) => (next.items = []));
    await commit((next) => (next.items = [assigned(editor)]));
  }
  assert.equal(await notices(editor), 1);
  // Given to someone else, then back, each is told.
  await commit((next) => (next.items = [assigned(viewer)]));
  await commit((next) => (next.items = [assigned(editor)]));
  assert.equal(await notices(viewer), 1);
  assert.equal(await notices(editor), 2);
});

test("a task added during anonymous input does not name its author when assigned", async () => {
  const env = environment();
  const boards = env.service;
  const b = board("Retro");
  b.items = [item("note", 0, 0, { text: "Existing" })];
  b.workshop = { settings: { lock: "open", anonymous: true } };
  const seed = new SharedDocument();
  seed.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await boards.call(owner, {
    op: "invite",
    room: b.id,
    role: "editor",
  });
  await boards.call(editor, { op: "join", room: b.id, token: invite.token });
  const { doc } = await boards.load(b.id);
  const vector = doc.vector();
  const next = doc.snapshot();
  next.items.push(
    item("note", 300, 0, {
      text: "Review the pull requests",
      task: { ...newTask(), assignee: { id: editor.uuid, name: "Bob" } },
    }),
  );
  doc.commit(next);
  const update = doc.update(vector);
  doc.destroy();
  await boards.call(owner, {
    op: "commit",
    room: b.id,
    id: await hash(update),
    update: encode(update),
  });
  const [notice] = (
    await adminCall(boards.org, boards, editor, { op: "notifications.list" })
  ).items;
  assert.equal(notice.anonymous, true);
  assert.equal(notice.actor, undefined);
  assert.doesNotMatch(JSON.stringify(notice), new RegExp(owner.username));
  assert.match(notice.text, /^A participant: Review the pull requests/);
});

test("assigning a task to a board member notifies them and is audited", async () => {
  const env = environment();
  const boards = env.service;
  const b = board("Sprint");
  const note = item("note", 0, 0, { text: "Write the brief", task: newTask() });
  b.items = [note];
  const seed = new SharedDocument();
  seed.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await boards.call(owner, {
    op: "invite",
    room: b.id,
    role: "editor",
  });
  await boards.call(editor, { op: "join", room: b.id, token: invite.token });
  async function commit(user, change) {
    const { doc } = await boards.load(b.id);
    const vector = doc.vector();
    const next = doc.snapshot();
    change(next);
    doc.commit(next);
    const update = doc.update(vector);
    doc.destroy();
    return boards.call(user, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
    });
  }
  await commit(owner, (next) => {
    next.items[0].task = {
      ...next.items[0].task,
      assignee: { id: editor.uuid, name: "Bob" },
      due: "2026-10-01",
    };
  });
  const list = await adminCall(boards.org, boards, editor, {
    op: "notifications.list",
  });
  assert.equal(list.unread, 1);
  const [notice] = list.items;
  assert.equal(notice.type, "assignment");
  assert.equal(notice.board, b.id);
  assert.equal(notice.boardTitle, "Sprint");
  assert.equal(notice.item, note.id);
  assert.equal(notice.actor.uuid, owner.uuid);
  assert.match(notice.subject, /Alice assigned you a task on Sprint/);
  assert.match(notice.text, /Write the brief \(due 2026-10-01\)/);
  // Its parts let the app word it in each reader's language.
  assert.equal(notice.title, "Write the brief");
  assert.equal(notice.due, "2026-10-01");
  const audits = () =>
    [...env.data.entries()]
      .filter(([key]) => key.startsWith("org:audit:"))
      .map(([, value]) => value)
      .filter((e) => e.action === "board.content.task_assigned");
  assert.equal(audits().length, 1);
  assert.equal(audits()[0].details.assignee, editor.uuid);
  // Unchanged assignees and non-members are not notified.
  await commit(owner, (next) => {
    next.items[0].task = { ...next.items[0].task, status: "in-progress" };
  });
  await commit(owner, (next) => {
    next.items[0].task = {
      ...next.items[0].task,
      assignee: { id: viewer.uuid, name: "Cam" },
    };
  });
  assert.equal(
    (await adminCall(boards.org, boards, editor, { op: "notifications.list" }))
      .items.length,
    1,
  );
  assert.equal(
    (await adminCall(boards.org, boards, viewer, { op: "notifications.list" }))
      .items.length,
    0,
  );
  assert.equal(audits().length, 1);
  // Pasting many tasks assigned to someone tells them once, with a count,
  // while each assignment is still audited.
  await commit(owner, (next) => {
    for (let n = 0; n < 30; n++)
      next.items.push(
        item("note", 300, n * 10, {
          text: `Step ${n + 1}`,
          task: { ...newTask(), assignee: { id: editor.uuid, name: "Bob" } },
        }),
      );
  });
  const notices = (
    await adminCall(boards.org, boards, editor, { op: "notifications.list" })
  ).items;
  assert.equal(notices.length, 2);
  // Notifications made in the same millisecond may list in either order.
  const pasted = notices.find((n) => n.title !== "Write the brief");
  assert.equal(pasted.title, "Step 1");
  assert.equal(pasted.more, 29);
  assert.match(pasted.subject, /Alice assigned you tasks on Sprint/);
  assert.match(pasted.text, /Step 1 and 29 more$/);
  assert.equal(audits().length, 31);
  assert.deepEqual(
    assignmentChanges(
      { items: [note] },
      {
        items: [
          { ...note, task: { ...note.task, assignee: { id: "x", name: "X" } } },
        ],
      },
    ).map((c) => c.assignee.id),
    ["x"],
  );
});

test("the task panel assigns shared board members and organization users with one undo step per change", async () => {
  const dom = new JSDOM(
    '<div class="canvas-wrap"><canvas id="canvas"></canvas></div>',
    {
      url: "https://whiteboard.test",
      pretendToBeVisual: true,
    },
  );
  const previous = {
    document: globalThis.document,
    NodeFilter: globalThis.NodeFilter,
  };
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  try {
    const { createPlanning } = await import("../src/planning/index.js");
    const { b, design, build } = plan();
    const selection = new Set([design.id, build.id]);
    let mutations = 0;
    const toasts = [];
    const session = {
      server: "https://org.puter.work",
      room: b.id,
      request: async (op) => {
        assert.equal(op, "members");
        return {
          members: [
            { uuid: owner.uuid, username: "Alice", role: "owner" },
            { uuid: editor.uuid, username: "Bob", role: "editor" },
            { uuid: "gone", username: "Gone", role: "removed" },
          ],
        };
      },
    };
    const org = {
      server: session.server,
      isAdmin: true,
      info: { configured: true, role: "admin" },
      allows: () => true,
      request: async (op) => {
        assert.equal(op, "org.users.list");
        return {
          users: [
            { uuid: viewer.uuid, username: "Cam", status: "active" },
            // Deactivated and not yet signed-in people are not offered.
            { uuid: "gone", username: "Dee", status: "deactivated" },
            {
              uuid: "pending-1",
              email: "eve@fabrikam.test",
              status: "pending",
            },
          ],
        };
      },
    };
    const planning = createPlanning({
      board: () => b,
      selection: () => selection,
      select: () => {},
      canvas: () => document.querySelector("#canvas"),
      readOnly: () => false,
      session: () => session,
      org,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      prepare: () => {},
      addObject: () => {},
      mutate: (fn) => {
        mutations++;
        fn();
      },
      focusRegion: () => {},
      modal: () => null,
      toast: (m) => toasts.push(m),
      download: () => {},
    });
    // Task lists read the board as this person sees it.
    const concealed = createPlanning({
      board: () => b,
      view: () => ({ ...b, items: b.items.filter((i) => i !== design) }),
      now: () => Date.parse(`${TODAY}T12:00:00`),
    });
    assert.ok(planning.tasks().some((row) => row.id === design.id));
    assert.ok(!concealed.tasks().some((row) => row.id === design.id));
    planning.actions["task-details"]();
    await new Promise((r) => setTimeout(r, 10));
    planning.render();
    const panel = document.querySelector("#task-panel");
    assert.ok(panel);
    const assignee = panel.querySelector("#task-assignee");
    assert.deepEqual(
      [...assignee.options].map((o) => o.textContent),
      ["Mixed", "Unassigned", "Alice", "Bob", "Cam"],
    );
    // People from the organization who are not on the board are marked,
    // since they are not notified and cannot open it.
    assert.deepEqual(
      [...assignee.querySelectorAll("optgroup")].map((g) => [
        g.label,
        [...g.children].map((o) => o.textContent),
      ]),
      [
        ["On this board", ["Alice", "Bob"]],
        ["Not on this board", ["Cam"]],
      ],
    );
    const note = panel.querySelector("#task-assignee-note");
    assert.equal(note.hidden, true);
    assert.equal(panel.querySelector("#task-status").value, "__mixed__");
    assignee.value = viewer.uuid;
    assignee.dispatchEvent(new dom.window.Event("change"));
    assert.equal(mutations, 1);
    assert.deepEqual(design.task.assignee, { id: viewer.uuid, name: "Cam" });
    assert.deepEqual(build.task.assignee, { id: viewer.uuid, name: "Cam" });
    planning.render();
    assert.equal(assignee.value, viewer.uuid);
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /not notified/);
    const status = panel.querySelector("#task-status");
    planning.render();
    status.value = "blocked";
    status.dispatchEvent(new dom.window.Event("change"));
    assert.equal(mutations, 2);
    assert.ok([design, build].every((i) => i.task.status === "blocked"));
    // An invalid date range is refused with a message and no edit.
    const start = panel.querySelector("#task-start");
    start.value = "2026-12-31";
    start.dispatchEvent(new dom.window.Event("change"));
    assert.equal(mutations, 2);
    assert.match(panel.querySelector("#task-error").textContent, /start date/);
    // A date the model cannot keep says so, not that the range is wrong.
    const due = panel.querySelector("#task-due");
    assert.equal(due.max, "9999-12-31");
    for (const value of ["0026-09-27", "20266-09-27"]) {
      due.value = value;
      due.dispatchEvent(new dom.window.Event("change"));
      assert.equal(mutations, 2);
      assert.equal(
        panel.querySelector("#task-error").textContent,
        "Enter a valid date, with a year from 100 to 9999.",
      );
    }
    // Locked objects keep the panel read-only.
    build.locked = true;
    planning.render();
    assert.equal(panel.querySelector("#task-status").disabled, true);
    assert.equal(panel.querySelector("#task-readonly").hidden, false);
    // The Tasks button and the Task details button are injected.
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div class="canvas-navigation"><button id="tag-access"></button><button id="text-link-access"></button><button data-action="timer"></button></div><div id="selection-tools"><div class="selection-row"><button data-action="tags"></button></div></div>',
    );
    planning.render();
    assert.ok(document.querySelector("#text-link-access + #task-access"));
    assert.ok(document.querySelector('[data-action="tags"] + #task-details'));
  } finally {
    dom.window.close();
    globalThis.document = previous.document;
    globalThis.NodeFilter = previous.NodeFilter;
  }
});

test("the task panel offers people who joined or left the board since it last opened", async () => {
  const dom = new JSDOM(
    '<div class="canvas-wrap"><canvas id="canvas"></canvas></div>',
    { url: "https://whiteboard.test", pretendToBeVisual: true },
  );
  const previous = {
    document: globalThis.document,
    NodeFilter: globalThis.NodeFilter,
  };
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  try {
    const { createPlanning } = await import("../src/planning/index.js");
    const { b, ship } = plan();
    let members = [{ uuid: owner.uuid, username: "Alice", role: "owner" }];
    let requests = 0;
    const session = {
      server: "https://org.puter.work",
      room: b.id,
      request: async () => {
        requests++;
        return { members: structuredClone(members) };
      },
    };
    const planning = createPlanning({
      board: () => b,
      selection: () => new Set([ship.id]),
      canvas: () => document.querySelector("#canvas"),
      readOnly: () => false,
      session: () => session,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      prepare: () => {},
      mutate: (fn) => fn(),
      toast: () => {},
    });
    const names = () =>
      [...document.querySelectorAll("#task-assignee option")].map(
        (o) => o.textContent,
      );
    planning.actions["task-details"]();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(names(), ["Unassigned", "Alice"]);
    // The first opening asks for the member list once.
    assert.equal(requests, 1);
    planning.close();
    members = [
      { uuid: owner.uuid, username: "Alice", role: "removed" },
      { uuid: editor.uuid, username: "Bob", role: "editor" },
    ];
    planning.actions["task-details"]();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(names(), ["Unassigned", "Bob"]);
    assert.equal(requests, 2);
  } finally {
    dom.window.close();
    globalThis.document = previous.document;
    globalThis.NodeFilter = previous.NodeFilter;
  }
});

test("a task field shows a collaborator's change once focus leaves it", async () => {
  const dom = new JSDOM(
    '<div class="canvas-wrap"><canvas id="canvas" tabindex="0"></canvas></div>',
    { url: "https://whiteboard.test", pretendToBeVisual: true },
  );
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { createTaskPanel } = await import("../src/planning/task-panel.js");
    const { b, ship } = plan();
    const panel = createTaskPanel({
      board: () => b,
      selection: () => new Set([ship.id]),
      canvas: () => document.querySelector("#canvas"),
      canEdit: () => true,
      readOnly: () => false,
      mutate: (fn) => {
        fn();
        panel.render();
      },
      toast: () => {},
      announce: () => {},
      prepare: () => {},
      people: async () => null,
      concealed: () => new Set(),
      jira: { available: () => false },
    });
    panel.open();
    const canvas = document.querySelector("#canvas");
    const due = document.querySelector("#task-due");
    const start = document.querySelector("#task-start");
    // A collaborator moves the due date while it has focus.
    due.focus();
    ship.task = { ...ship.task, due: "2026-12-24" };
    panel.render();
    assert.equal(due.value, "2026-10-10");
    canvas.focus();
    await Promise.resolve();
    assert.equal(due.value, "2026-12-24");
    // A date just saved stays as typed.
    due.focus();
    due.value = "2026-11-02";
    due.dispatchEvent(new dom.window.Event("change"));
    canvas.focus();
    await Promise.resolve();
    assert.equal(ship.task.due, "2026-11-02");
    assert.equal(due.value, "2026-11-02");
    // A refused date stays for the person to correct.
    start.focus();
    start.value = "2026-12-01";
    start.dispatchEvent(new dom.window.Event("change"));
    canvas.focus();
    await Promise.resolve();
    assert.equal(ship.task.start, null);
    assert.equal(start.value, "2026-12-01");
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("composition Escape keeps the task assignee draft and ordinary Escape closes the panel", async () => {
  const dom = new JSDOM(
    '<div class="canvas-wrap"><canvas id="canvas" tabindex="0"></canvas></div>',
    { url: "https://whiteboard.test", pretendToBeVisual: true },
  );
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { createTaskPanel } = await import("../src/planning/task-panel.js");
    const { b, ship } = plan();
    const panel = createTaskPanel({
      board: () => b,
      selection: () => new Set([ship.id]),
      canvas: () => document.querySelector("#canvas"),
      canEdit: () => true,
      readOnly: () => false,
      mutate: (fn) => fn(),
      toast: () => {},
      announce: () => {},
      prepare: () => {},
      people: async () => null,
      concealed: () => new Set(),
      jira: { available: () => false },
    });
    panel.open();
    await Promise.resolve();
    const field = document.querySelector("#task-assignee-text");
    field.focus();
    field.value = "下書き";
    const before = structuredClone(ship.task);
    for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
        ...flags,
      });
      field.dispatchEvent(event);
      assert.ok(document.querySelector("#task-panel"));
      assert.equal(document.activeElement, field);
      assert.equal(field.value, "下書き");
      assert.equal(event.defaultPrevented, false);
      assert.deepEqual(ship.task, before);
    }
    field.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(document.querySelector("#task-panel"), null);
    assert.equal(document.activeElement, document.querySelector("#canvas"));
    assert.deepEqual(ship.task, before);
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

const code = await appBundle();
async function setup() {
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
  w.puter = {
    env: "web",
    auth: { isSignedIn: () => false },
    kv: { get: async () => null, set: async () => {} },
  };
  w.Image = NativeImage;
  const downloads = [];
  w.URL.createObjectURL = (blob) => {
    downloads.push(blob);
    return "blob:test";
  };
  w.URL.revokeObjectURL = () => {};
  const names = [];
  w.HTMLAnchorElement.prototype.click = function () {
    if (this.download) names.push(this.download);
  };
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
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event("close"));
  };
  await w.eval(`(async()=>{${code}\n})()`);
  const tick = () => new Promise((r) => setTimeout(r, 25));
  const click = async (selector) => {
    // The board has no "first note" button; tests add a note through the
    // command palette, as a person without the toolbar would.
    if (selector === '[data-action="add-note"]') {
      await click('[data-action="commands"]');
      const search = w.document.querySelector("#command-search");
      search.value = "Sticky note";
      search.dispatchEvent(new w.Event("input", { bubbles: true }));
      return click('[data-command="add:note"]');
    }
    const el = w.document.querySelector(selector);
    assert.ok(el, selector);
    el.click();
    await tick();
    if (el.dataset.action === "new") {
      const deadline = Date.now() + 3000;
      while (!w.document.querySelector("#canvas") && Date.now() < deadline)
        await tick();
    }
  };
  return {
    w,
    doc: w.document,
    click,
    tick,
    downloads,
    names,
    close: () => w.close(),
  };
}
function transfer(formats = {}) {
  const values = new Map(Object.entries(formats));
  return {
    files: [],
    get types() {
      return [...values.keys()];
    },
    getData: (type) => values.get(type) || "",
    setData: (type, value) => values.set(type, value),
  };
}
function dispatch(app, type, data) {
  const event = new app.w.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: data });
  app.doc.querySelector("#canvas").dispatchEvent(event);
}
function selected(app) {
  const data = transfer();
  dispatch(app, "copy", data);
  return JSON.parse(data.getData(CLIPBOARD_TYPE)).items;
}
async function audit(app, root) {
  if (!app.w.axe) app.w.eval(axe.source);
  const result = await app.w.axe.run(root, {
    rules: { "color-contrast": { enabled: false } },
  });
  assert.equal(
    result.violations.length,
    0,
    result.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`).join("\n"),
  );
}

test("the built editor plans tasks: task cards, the task panel, the Tasks dialog, timeline placement, and Kanban sync", async () => {
  const app = await setup(),
    { doc, w, click } = app;
  try {
    await click('[data-action="new"]');
    // A task card from More tools is a sticky note with task details.
    await click('[data-action="more-tools"]');
    await click('[data-feature="task-card"]');
    doc.querySelector("#canvas-text-editor").value = "Draft agenda";
    await click('[data-action="finish-text"]');
    let [card] = selected(app);
    assert.equal(card.type, "note");
    assert.deepEqual(card.task, newTask());
    // The shape library offers task cards too.
    await click('[data-action="shapes"]');
    assert.ok(doc.querySelector('[data-extra="task-card"]'));
    doc.querySelector("dialog .dialog-header button").click();
    await app.tick();
    // Pasted objects keep their task details.
    const { b } = plan();
    dispatch(app, "paste", transfer(clipboardFormats(b.items.slice(0, 7))));
    await app.tick();
    const pastedPlan = selected(app);
    assert.equal(pastedPlan.filter((i) => i.task).length, 4);
    // A pasted task keeps its Jira link while no task on the board has it,
    // as after a cut; a second copy is a new task without the link.
    assert.equal(pastedPlan.find((i) => i.task?.jira)?.task.jira.key, "WB-7");
    dispatch(app, "paste", transfer(clipboardFormats(b.items.slice(0, 7))));
    await app.tick();
    assert.equal(selected(app).filter((i) => i.task?.jira).length, 0);
    await click('[data-action="undo"]');
    // A connector between two tasks offers the dependency option.
    const link = pastedPlan.find((i) => i.type === "arrow");
    assert.equal(link.dependency, "blocks");
    await click(`[data-id="${link.id}"]`);
    const dependency = doc.querySelector("#line-dependency");
    assert.equal(dependency.value, "blocks");
    dependency.value = "depends-on";
    dependency.dispatchEvent(new w.Event("change"));
    await app.tick();
    assert.equal(selected(app)[0].dependency, "depends-on");
    await click('[data-action="undo"]');
    await click(`[data-id="${link.id}"]`);
    assert.equal(selected(app)[0].dependency, "blocks");
    // Task details and the facilitation panel share the right edge, so
    // opening one closes the other.
    await click('.canvas-navigation [data-action="facilitation"]');
    assert.ok(doc.querySelector("#facilitation-panel"));
    await click(`[data-id="${card.id}"]`);
    assert.ok(doc.querySelector("#task-details"), "Task details on toolbar");
    await click("#task-details");
    assert.ok(doc.querySelector("#task-panel"));
    assert.equal(doc.querySelector("#facilitation-panel"), null);
    await click('.canvas-navigation [data-action="facilitation"]');
    assert.equal(doc.querySelector("#task-panel"), null);
    await click('.canvas-navigation [data-action="facilitation"]');
    await click("#task-details");
    const panel = doc.querySelector("#task-panel");
    assert.ok(panel);
    await audit(app, panel);
    const status = panel.querySelector("#task-status");
    status.value = "in-progress";
    status.dispatchEvent(new w.Event("change"));
    await app.tick();
    const assignee = panel.querySelector("#task-assignee-text");
    assert.equal(panel.querySelector("#task-assignee-field").hidden, true);
    assignee.value = "Dana Lee";
    assignee.dispatchEvent(new w.Event("change"));
    await app.tick();
    const due = panel.querySelector("#task-due");
    due.value = "2026-10-20";
    due.dispatchEvent(new w.Event("change"));
    await app.tick();
    [card] = selected(app);
    assert.deepEqual(card.task, {
      assignee: { id: "name:dana lee", name: "Dana Lee" },
      start: null,
      due: "2026-10-20",
      status: "in-progress",
    });
    // Each change is one undo step.
    await click('[data-action="undo"]');
    await click(`[data-id="${card.id}"]`);
    assert.equal(selected(app)[0].task.due, null);
    assert.equal(selected(app)[0].task.assignee.name, "Dana Lee");
    await click('[data-action="redo"]');
    // The Tasks dialog lists, filters, and exports tasks.
    assert.ok(doc.querySelector("#tag-access ~ #task-access, #task-access"));
    await click("#task-access");
    const dialog = doc.querySelector("dialog.tasks-modal");
    assert.ok(dialog);
    assert.match(dialog.querySelector("#tasks-summary").textContent, /Tasks5/);
    await audit(app, dialog);
    assert.equal(dialog.querySelectorAll(".task-go").length, 5);
    const statusFilter = dialog.querySelector("#tasks-status");
    statusFilter.value = "todo";
    statusFilter.dispatchEvent(new w.Event("change", { bubbles: true }));
    assert.equal(dialog.querySelectorAll(".task-go").length, 2);
    assert.match(
      dialog.querySelector("#tasks-count").textContent,
      /2 tasks shown/,
    );
    assert.equal(
      doc.activeElement?.id,
      "tasks-status",
      "focus stays on the filter",
    );
    const reset = dialog.querySelector("#tasks-status");
    reset.value = "";
    reset.dispatchEvent(new w.Event("change", { bubbles: true }));
    dialog.querySelector("#tasks-csv").click();
    assert.match(app.names.at(-1), /^\S.* tasks\.csv$/);
    // A title of only symbols still names the file.
    const title = doc.querySelector("#board-title");
    title.value = "🚀";
    title.dispatchEvent(new w.Event("change"));
    dialog.querySelector("#tasks-csv").click();
    assert.equal(app.names.at(-1), "Tasks.csv");
    const csv = await new Promise((resolve) => {
      const reader = new w.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(app.downloads.at(-1));
    });
    assert.match(csv, /Draft agenda,In progress,Dana Lee,,2026-10-20/);
    dialog.querySelector("#tasks-xlsx").click();
    assert.match(app.downloads.at(-1).type, /spreadsheetml/);
    // Timeline view: keyboard-navigable bars and a table alternative.
    dialog.querySelector("#tasks-tab-timeline").click();
    assert.equal(dialog.querySelector("#tasks-timeline").hidden, false);
    const bars = [...dialog.querySelectorAll(".timeline-bar")];
    assert.equal(bars.length, 4);
    assert.equal(bars.filter((x) => x.tabIndex === 0).length, 1);
    bars[0].focus();
    bars[0].dispatchEvent(
      new w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    assert.equal(doc.activeElement, bars[1]);
    assert.ok(dialog.querySelector(".timeline-deps path"));
    await audit(app, dialog);
    dialog.querySelector("#timeline-table").click();
    assert.equal(dialog.querySelectorAll("#timeline-data tbody tr").length, 4);
    // A task with only a due date shows no start, as in the list.
    const agenda = [...dialog.querySelectorAll("#timeline-data tbody tr")]
      .find((tr) => tr.textContent.includes("Draft agenda"))
      .querySelectorAll("td");
    assert.equal(agenda[1].textContent, "");
    assert.equal(agenda[2].querySelector("time").dateTime, "2026-10-20");
    assert.equal(agenda[3].textContent, "1");
    await audit(app, dialog);
    dialog.querySelector("#timeline-place").click();
    await app.tick();
    assert.equal(doc.querySelector("dialog.tasks-modal"), null);
    const placed = selected(app);
    assert.ok(placed.length > 10);
    assert.ok(placed.some((i) => i.type === "frame" && i.text === "Timeline"));
    assert.ok(placed.filter((i) => i.objectLink).length === 4);
    // Kanban status sync: enable it, then move a task into "Done".
    await click("#task-access");
    const sync = doc.querySelector("#tasks-sync");
    sync.checked = true;
    sync.dispatchEvent(new w.Event("change", { bubbles: true }));
    doc.querySelector("dialog.tasks-modal .dialog-header button").click();
    await app.tick();
    const pasted = plan();
    dispatch(
      app,
      "paste",
      transfer(
        clipboardFormats([
          pasted.done,
          item("note", 2000, 2000, { text: "Moving task", task: newTask() }),
        ]),
      ),
    );
    await app.tick();
    const [frame, moving] = selected(app);
    await click(`[data-id="${moving.id}"]`);
    await click('[data-action="organize"]');
    const choice = doc.querySelector("#parent-frame");
    assert.ok(choice);
    choice.querySelector(`input[value="${frame.id}"]`).click();
    doc.querySelector("#assign-frame").click();
    await app.tick();
    await click(`[data-id="${moving.id}"]`);
    assert.equal(selected(app)[0].task.status, "done");
    // French names the planning views and statuses.
    doc.querySelector("#language").value = "fr";
    doc.querySelector("#language").dispatchEvent(new w.Event("change"));
    await app.tick();
    await click("#task-access");
    const french = doc.querySelector("dialog.tasks-modal");
    assert.match(
      french.querySelector("#tasks-tab-timeline").textContent,
      /Chronologie/,
    );
    assert.match(french.textContent, /✓ Terminé/);
    assert.match(french.textContent, /◐ En cours/);
    assert.match(french.textContent, /Exporter en Excel/);
  } finally {
    app.close();
  }
});

test("the built editor offers Refresh timeline on a placed timeline and undoes it in one step", async () => {
  const app = await setup(),
    { doc, w, click } = app;
  try {
    await click('[data-action="new"]');
    const { b } = plan();
    dispatch(app, "paste", transfer(clipboardFormats(b.items)));
    await app.tick();
    const pasted = selected(app);
    const task = pasted.find((i) => i.text === "Design review");
    await click("#task-access");
    const dialog = doc.querySelector("dialog.tasks-modal");
    dialog.querySelector("#tasks-tab-timeline").click();
    dialog.querySelector("#timeline-place").click();
    await app.tick();
    assert.match(
      doc.querySelector("#toast").textContent,
      /choose Refresh timeline/,
    );
    const frame = selected(app).find((i) => i.type === "frame");
    // A copied bar links to its task by address.
    const bar = () =>
      selected(app).find((i) =>
        i.objectLink?.url?.endsWith(`&object=${task.id}`),
      );
    assert.match(bar().text, /\(In progress\)/);
    const menu = () =>
      doc.querySelector(
        '#selection-more-menu [data-action="timeline-refresh"]',
      );
    assert.ok(menu(), "The selected timeline offers Refresh timeline");
    // The task is finished after the timeline was placed.
    // The command palette offers it for a timeline only.
    const palette = async () => {
      await click('[data-action="commands"]');
      const search = doc.querySelector("#command-search");
      search.value = "Refresh timeline";
      search.dispatchEvent(new w.Event("input", { bubbles: true }));
      const option = doc.querySelector('[data-command="timeline-refresh"]');
      const disabled = option.getAttribute("aria-disabled") === "true";
      const reason = option.querySelector("small").textContent;
      doc.querySelector("dialog[open]").close();
      await app.tick();
      return { disabled, reason };
    };
    assert.deepEqual(await palette(), { disabled: false, reason: "Edit" });
    await click(`[data-id="${task.id}"]`);
    assert.equal(menu(), null, "An ordinary task offers no refresh");
    assert.deepEqual(await palette(), {
      disabled: true,
      reason: "Select a timeline placed from the Tasks view.",
    });
    await click("#task-details");
    const status = doc.querySelector("#task-panel #task-status");
    status.value = "done";
    status.dispatchEvent(new w.Event("change"));
    await app.tick();
    await click(`[data-id="${frame.id}"]`);
    assert.match(bar().text, /\(In progress\)/, "Placed as a copy");
    await click('#selection-more-menu [data-action="timeline-refresh"]');
    assert.match(bar().text, /^Design review \(Done\)$/);
    assert.equal(selected(app)[0].id, frame.id);
    await click('[data-action="undo"]');
    await click(`[data-id="${frame.id}"]`);
    assert.match(bar().text, /\(In progress\)/, "One undo step");
    await click(`[data-id="${task.id}"]`);
    assert.equal(selected(app)[0].task.status, "done");
    // French names the action.
    await click(`[data-id="${frame.id}"]`);
    doc.querySelector("#language").value = "fr";
    doc.querySelector("#language").dispatchEvent(new w.Event("change"));
    await app.tick();
    assert.match(menu().textContent, /Actualiser la chronologie/);
  } finally {
    app.close();
  }
});

test("turning Kanban status sync on aligns cards in a locked column, and leaves locked cards alone", () => {
  const { done } = plan();
  const b = board("Locks");
  const free = item("note", 760, 100, {
      text: "Free",
      parentId: done.id,
      task: newTask(),
    }),
    locked = item("note", 760, 300, {
      text: "Locked",
      parentId: done.id,
      task: newTask(),
      locked: true,
    });
  b.items.push({ ...done, locked: true }, free, locked);
  const kept = new Set([locked.id]);
  assert.deepEqual(
    alignColumnStatuses(b, kept).map((c) => c.item.id),
    [free.id],
  );
  assert.equal(free.task.status, "done");
  assert.equal(locked.task.status, "todo");
});

test("turning Kanban status sync on from the Tasks dialog lines up cards already in columns", async () => {
  const app = await setup(),
    { doc, w, click } = app;
  try {
    await click('[data-action="new"]');
    const { done } = plan();
    const card = item("note", 760, 100, {
      text: "Already shipped",
      parentId: done.id,
      task: newTask(),
    });
    // The column is locked, which leaves it a column all the same.
    dispatch(
      app,
      "paste",
      transfer(clipboardFormats([{ ...done, locked: true }, card])),
    );
    await app.tick();
    const { id } = selected(app).find((i) => i.text === "Already shipped");
    const status = async () => {
      await click(`[data-id="${id}"]`);
      return selected(app)[0].task.status;
    };
    assert.equal(await status(), "todo");
    await click("#task-access");
    const sync = doc.querySelector("#tasks-sync");
    sync.checked = true;
    sync.dispatchEvent(new w.Event("change", { bubbles: true }));
    doc.querySelector("dialog.tasks-modal .dialog-header button").click();
    await app.tick();
    assert.match(doc.querySelector("#toast").textContent, /Statuses updated/);
    assert.equal(await status(), "done");
    // One undo step turns sync off and puts the status back.
    await click('[data-action="undo"]');
    assert.equal(await status(), "todo");
  } finally {
    app.close();
  }
});

test("inserting the Kanban template turns status sync on, says so, and lines up the board's own cards", async () => {
  const app = await setup(),
    { doc, click } = app;
  try {
    await click('[data-action="new"]');
    const { done } = plan();
    const card = item("note", 760, 100, {
      text: "Already shipped",
      parentId: done.id,
      task: newTask(),
    });
    dispatch(app, "paste", transfer(clipboardFormats([done, card])));
    await app.tick();
    const { id } = selected(app).find((i) => i.text === "Already shipped");
    await click('[data-action="more-tools"]');
    await click('[data-feature="templates"]');
    await click('[data-use="kanban"]');
    await app.tick();
    assert.match(
      doc.querySelector("#toast").textContent,
      /Kanban status sync is on for this board\. Statuses updated/,
    );
    const inserted = selected(app);
    assert.ok(inserted.some((i) => i.task?.status === "blocked"));
    await click(`[data-id="${id}"]`);
    assert.equal(selected(app)[0].task.status, "done");
    // One undo takes the template, the setting and the status back.
    await click('[data-action="undo"]');
    await click(`[data-id="${id}"]`);
    assert.equal(selected(app)[0].task.status, "todo");
  } finally {
    app.close();
  }
});

test("undo and redo turn Kanban status sync off and on again on a personal board", async () => {
  const app = await setup(),
    { doc, w, click } = app;
  try {
    await click('[data-action="new"]');
    const syncShown = async () => {
      await click("#task-access");
      const checked = doc.querySelector("#tasks-sync").checked;
      doc.querySelector("dialog.tasks-modal .dialog-header button").click();
      await app.tick();
      return checked;
    };
    await click("#task-access");
    const sync = doc.querySelector("#tasks-sync");
    sync.checked = true;
    sync.dispatchEvent(new w.Event("change", { bubbles: true }));
    doc.querySelector("dialog.tasks-modal .dialog-header button").click();
    await app.tick();
    assert.equal(await syncShown(), true);
    await click('[data-action="undo"]');
    assert.equal(await syncShown(), false);
    await click('[data-action="redo"]');
    assert.equal(await syncShown(), true);
  } finally {
    app.close();
  }
});

test("sending tasks to Jira twice at once creates the issues once", async () => {
  const dom = new JSDOM("<canvas></canvas>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { createPlanning } = await import("../src/planning/index.js");
    const { b, design } = plan();
    let requests = 0,
      release;
    const org = {
      server: "https://org.puter.work",
      info: { configured: true, role: "member" },
      allows: () => true,
      request: async (op) => {
        assert.equal(op, "org.jira.create");
        requests++;
        await new Promise((resolve) => (release = resolve));
        return { created: [] };
      },
    };
    const planning = createPlanning({
      board: () => b,
      selection: () => new Set([design.id]),
      readOnly: () => false,
      session: () => ({ server: org.server, room: b.id }),
      org,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      mutate: (fn) => fn(),
      toast: () => {},
    });
    const first = planning.actions["task-jira-send"]();
    planning.actions["task-jira-send"]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await first;
    assert.equal(requests, 1);
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("task details and Jira leave out hidden content and respect facilitator locks", async () => {
  const dom = new JSDOM(
    '<div class="canvas-wrap"><canvas id="canvas"></canvas></div>',
    { url: "https://x.test", pretendToBeVisual: true },
  );
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { createPlanning } = await import("../src/planning/index.js");
    const { b, design, build } = plan();
    design.task.jira = {
      key: "WB-1",
      url: "https://fabrikam.atlassian.net/browse/WB-1",
    };
    build.task.jira = {
      key: "WB-2",
      url: "https://fabrikam.atlassian.net/browse/WB-2",
    };
    const requests = [];
    const toasts = [];
    const org = {
      server: "https://org.puter.work",
      info: { configured: true, role: "member" },
      allows: () => true,
      request: async (op, input) => {
        requests.push([op, input]);
        return { issues: [] };
      },
    };
    let frozen = false;
    const selection = new Set([design.id]);
    const planning = createPlanning({
      board: () => b,
      // Another participant's private note, face down for this person.
      concealed: () => new Set([design.id]),
      locked: () => frozen,
      selection: () => selection,
      canvas: () => dom.window.document.querySelector("#canvas"),
      readOnly: () => false,
      session: () => ({ server: org.server, room: b.id }),
      org,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      mutate: (fn) => fn(),
      prepare: () => {},
      toast: (m) => toasts.push(m),
    });
    planning.actions["task-details"]();
    assert.equal(dom.window.document.querySelector("#task-panel"), null);
    assert.match(toasts.at(-1), /Select sticky notes/);
    await planning.actions["task-jira-refresh"]();
    assert.ok(requests[0][1].keys.includes("WB-2"));
    assert.ok(!requests[0][1].keys.includes("WB-1"), "Hidden links stay out");
    // A frozen board makes task details read-only.
    selection.clear();
    selection.add(build.id);
    frozen = true;
    planning.actions["task-details"]();
    const panel = dom.window.document.querySelector("#task-panel");
    assert.ok(panel);
    assert.equal(panel.querySelector("#task-readonly").hidden, false);
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("the Tasks dialog keeps focus on task rows and resets vanished filters", async () => {
  const dom = new JSDOM("<body></body>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { openTasksDialog } = await import("../src/planning/tasks-dialog.js");
    const { b, design } = plan();
    const opened = openTasksDialog({
      board: () => b,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      canAdd: () => true,
      selectedTasks: () => [],
      jira: { status: () => ({ available: false, message: "" }) },
      focusObject() {},
      placeTimeline() {},
      setStatusSync() {},
      download() {},
    });
    const row = () =>
      opened.dialog.querySelector(`.task-go[data-task="${design.id}"]`);
    row().focus();
    design.task = { ...design.task, status: "blocked" };
    opened.refresh();
    assert.equal(document.activeElement, row(), "focus stays on the task");
    // Filter by an assignee, then that person's tasks go away.
    const person = b.items.find((i) => i.task?.assignee).task.assignee.id;
    const select = opened.dialog.querySelector("#tasks-assignee");
    select.value = person;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    for (const i of b.items)
      if (i.task?.assignee?.id === person)
        i.task = { ...i.task, assignee: null };
    opened.refresh();
    assert.equal(opened.dialog.querySelector("#tasks-assignee").value, "*");
    assert.ok(opened.dialog.querySelectorAll(".task-go").length > 0);
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("sending more than 50 tasks to Jira says how many are still waiting", async () => {
  const dom = new JSDOM("<canvas></canvas>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { createPlanning } = await import("../src/planning/index.js");
    const b = {
      ...board("Backlog"),
      items: Array.from({ length: 60 }, (_, n) =>
        item("note", n * 250, 0, {
          text: `Task ${n}`,
          task: { status: "todo" },
        }),
      ),
    };
    const toasts = [];
    const org = {
      server: "https://org.puter.work",
      info: { configured: true, role: "member" },
      allows: () => true,
      request: async (op, { issues }) => ({
        created: issues.map((i, n) => ({
          item: i.item,
          key: `WB-${n + 1}`,
          url: `https://fabrikam.atlassian.net/browse/WB-${n + 1}`,
        })),
      }),
    };
    const planning = createPlanning({
      board: () => b,
      selection: () => new Set(b.items.map((i) => i.id)),
      readOnly: () => false,
      session: () => ({ server: org.server, room: b.id }),
      org,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      mutate: (fn) => fn(),
      toast: (message) => toasts.push(message),
    });
    await planning.actions["task-jira-send"]();
    assert.match(toasts.at(-1), /created: 50\. Not sent yet: 10\./);
    await planning.actions["task-jira-send"]();
    assert.equal(toasts.at(-1), "Jira issues created: 10.");
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("Jira issues created while the board closes or turns read-only are named, not lost", async () => {
  const dom = new JSDOM("<canvas></canvas>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { createPlanning } = await import("../src/planning/index.js");
    for (const change of ["read-only", "closed"]) {
      const { b, design } = plan();
      let current = b,
        readOnly = false;
      const toasts = [];
      const org = {
        server: "https://org.puter.work",
        info: { configured: true, role: "member" },
        allows: () => true,
        request: async () => {
          if (change === "read-only") readOnly = true;
          else current = board("Other");
          return {
            created: [
              {
                item: design.id,
                key: "WB-9",
                url: "https://fabrikam.atlassian.net/browse/WB-9",
              },
            ],
          };
        },
      };
      const planning = createPlanning({
        board: () => current,
        selection: () => new Set([design.id]),
        readOnly: () => readOnly,
        session: () => ({ server: org.server, room: b.id }),
        org,
        now: () => Date.parse(`${TODAY}T12:00:00`),
        // The editor refuses edits on a read-only board.
        mutate: (fn) => (readOnly ? toasts.push("read-only") : fn()),
        toast: (message) => toasts.push(message),
      });
      await planning.actions["task-jira-send"]();
      assert.equal(
        toasts.at(-1),
        "Jira issues created: 1 (WB-9). They are not linked to their tasks because the board was closed, locked, or became read-only.",
      );
      assert.equal(design.task.jira, undefined);
    }
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("Jira issues whose tasks were deleted or linked meanwhile are named, not reported as refused", async () => {
  const dom = new JSDOM("<canvas></canvas>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { createPlanning } = await import("../src/planning/index.js");
    const { b, design, build, ship } = plan();
    const toasts = [];
    const org = {
      server: "https://org.puter.work",
      info: { configured: true, role: "member" },
      allows: () => true,
      request: async () => {
        // A collaborator deletes one task and sends another meanwhile.
        b.items = b.items.filter((i) => i.id !== design.id);
        build.task = {
          ...build.task,
          jira: {
            key: "WB-1",
            url: "https://fabrikam.atlassian.net/browse/WB-1",
          },
        };
        return {
          created: [design, build, ship].map((i, n) => ({
            item: i.id,
            key: `WB-${n + 10}`,
            url: `https://fabrikam.atlassian.net/browse/WB-${n + 10}`,
          })),
        };
      },
    };
    const planning = createPlanning({
      board: () => b,
      selection: () => new Set([design.id, build.id, ship.id]),
      readOnly: () => false,
      session: () => ({ server: org.server, room: b.id }),
      org,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      mutate: (fn) => fn(),
      toast: (message) => toasts.push(message),
    });
    await planning.actions["task-jira-send"]();
    assert.equal(
      toasts.at(-1),
      "Jira issues created: 3. Not linked because their tasks were deleted or linked by someone else meanwhile: WB-10, WB-11.",
    );
    // The other person's link is kept.
    assert.equal(build.task.jira.key, "WB-1");
    assert.equal(ship.task.jira.key, "WB-12");
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("the Tasks dialog keeps the assignee breakdown open and focused on refresh", async () => {
  const dom = new JSDOM("<body></body>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  try {
    const { openTasksDialog } = await import("../src/planning/tasks-dialog.js");
    const { b, design } = plan();
    const opened = openTasksDialog({
      board: () => b,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      canAdd: () => true,
      selectedTasks: () => [],
      jira: { status: () => ({ available: false, message: "" }) },
      focusObject() {},
      placeTimeline() {},
      setStatusSync() {},
      download() {},
    });
    const people = () => opened.dialog.querySelector(".task-people");
    people().open = true;
    people().querySelector("summary").focus();
    // A collaborator changes a task.
    design.task = { ...design.task, status: "blocked" };
    opened.refresh();
    assert.equal(people().open, true);
    assert.equal(document.activeElement, people().querySelector("summary"));
    // So does changing a filter.
    const status = opened.dialog.querySelector("#tasks-status");
    status.value = "todo";
    status.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(people().open, true);
    // Closed, it stays closed.
    people().open = false;
    opened.refresh();
    assert.equal(people().open, false);
  } finally {
    globalThis.document = previous;
    delete globalThis.NodeFilter;
    dom.window.close();
  }
});

test("the Tasks dialog keeps people's names as written in French", async () => {
  const dom = new JSDOM("<body></body>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  const { setLanguage, translateUI } = await import("../src/i18n.js");
  try {
    setLanguage("fr");
    const { openTasksDialog } = await import("../src/planning/tasks-dialog.js");
    const { b, design } = plan();
    // An assignee whose name is also an interface word.
    design.task = { ...design.task, assignee: { id: "u9", name: "Back" } };
    // A title that starts like an interface label.
    design.text = "Open the new office";
    const opened = openTasksDialog({
      board: () => b,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      canAdd: () => true,
      selectedTasks: () => [],
      jira: { status: () => ({ available: false, message: "" }) },
      focusObject() {},
      placeTimeline() {},
      setStatusSync() {},
      download() {},
    });
    const group = opened.dialog.querySelector("#tasks-group");
    group.value = "assignee";
    group.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    opened.dialog.querySelector("#tasks-tab-timeline").click();
    translateUI(opened.dialog);
    const captions = [...opened.dialog.querySelectorAll("caption")].map(
      (c) => c.textContent,
    );
    assert.ok(captions.includes("Back"), captions.join());
    const lane = [
      ...opened.dialog.querySelectorAll(".timeline-lane-label"),
    ].find((l) => l.textContent === "Back");
    assert.ok(lane, "lane keeps the name");
    assert.equal(
      opened.dialog.querySelector(`[aria-labelledby="${lane.id}"]`)?.className,
      "timeline-lane",
    );
    const bar = opened.dialog.querySelector(
      `.timeline-bar[data-task="${design.id}"]`,
    );
    const name = opened.dialog.querySelector(
      `#${bar.getAttribute("aria-labelledby")}`,
    );
    assert.match(name.textContent, /^Open the new office, /);
    bar.focus();
    assert.match(
      opened.dialog.querySelector("#tasks-title-preview").textContent,
      /^Open the new office \(/,
    );
    // Counts of 0 and 1 take the singular in French.
    const people = opened.dialog.querySelector(".task-people").textContent;
    assert.match(people, /\(0 terminée\)/);
    assert.doesNotMatch(people, /terminées/);
    const status = opened.dialog.querySelector("#tasks-status");
    status.value = "blocked";
    status.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(
      opened.dialog.querySelector("#tasks-count").textContent,
      "0 tâche affichée",
    );
  } finally {
    setLanguage("en");
    globalThis.document = previous;
    delete globalThis.NodeFilter;
    dom.window.close();
  }
});

test("Jira links are shown only for issue pages on a Jira Cloud site", () => {
  const link = (url, key = "WB-7") => jiraLink({ key, url });
  assert.match(
    link("https://fabrikam.atlassian.net/browse/WB-7"),
    /^<a href="https:\/\/fabrikam\.atlassian\.net\/browse\/WB-7"/,
  );
  for (const url of [
    "https://fabrikam.atlassian.net.evil.example/browse/WB-7",
    "https://fabrikam.atlassian.net/browse/WB-8",
    "https://fabrikam.atlassian.net/login?next=/browse/WB-7",
    "https://evil.example/browse/WB-7",
  ])
    assert.equal(link(url), "<span data-user-content>WB-7</span>", url);
});

test("task badge layouts are reused until the task or its size changes", () => {
  const ctx = createCanvas(10, 10).getContext("2d");
  const note = item("note", 0, 0, {
    text: "Plan",
    task: { status: "todo", due: "2026-10-01" },
  });
  const first = taskLayout(ctx, note, { today: TODAY });
  assert.equal(taskLayout(ctx, note, { today: TODAY }), first);
  note.task = { ...note.task, status: "done" };
  const done = taskLayout(ctx, note, { today: TODAY });
  assert.notEqual(done, first);
  note.w += 100;
  assert.notEqual(taskLayout(ctx, note, { today: TODAY }), done);
});

test("closing task details with Escape returns focus to the button that opened them", async () => {
  const dom = new JSDOM(
    `<div class="canvas-wrap"><canvas id="canvas" tabindex="0"></canvas><div id="selection-tools"><button id="task-details">Task details</button></div></div>`,
  );
  const saved = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { createTaskPanel } = await import("../src/planning/task-panel.js");
    const note = item("note", 0, 0, { text: "Plan", task: newTask() });
    const b = { ...board("Tasks"), items: [note] };
    const panel = createTaskPanel({
      board: () => b,
      selection: () => new Set([note.id]),
      canEdit: () => true,
      readOnly: () => false,
      canvas: () => document.querySelector("#canvas"),
      prepare() {},
      toast() {},
      mutate: (fn) => fn(),
      announce() {},
      people: async () => [],
      jira: { available: () => false, send() {} },
    });
    const button = document.querySelector("#task-details");
    button.focus();
    panel.open();
    assert.ok(
      document.querySelector("#task-panel").contains(document.activeElement),
    );
    // The toolbar redraws its buttons while the panel is open.
    const redrawn = button.cloneNode(true);
    button.replaceWith(redrawn);
    document.activeElement.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    assert.equal(panel.isOpen(), false);
    assert.equal(document.activeElement, redrawn);
  } finally {
    globalThis.document = saved;
    dom.window.close();
  }
});

test("Jira status refresh checks every linked task, 100 at a time", async () => {
  const dom = new JSDOM("<canvas></canvas>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { createPlanning } = await import("../src/planning/index.js");
    const b = board("Jira");
    b.items = Array.from({ length: 150 }, (_, n) =>
      item("note", n * 10, 0, {
        id: `n${n}`,
        text: `Task ${n}`,
        task: {
          ...newTask(),
          jira: {
            key: `WB-${n + 1}`,
            url: `https://fabrikam.atlassian.net/browse/WB-${n + 1}`,
          },
        },
      }),
    );
    const sent = [];
    const org = {
      server: "https://org.puter.work",
      info: { configured: true, role: "member" },
      allows: () => true,
      request: async (op, input) => {
        sent.push(input.keys.length);
        return { issues: [] };
      },
    };
    const planning = createPlanning({
      board: () => b,
      selection: () => new Set(),
      readOnly: () => false,
      session: () => ({ server: org.server, room: b.id }),
      org,
      now: () => Date.now(),
      mutate: (fn) => fn(),
      toast: () => {},
    });
    await planning.actions["task-jira-refresh"]();
    assert.deepEqual(sent, [100, 50]);
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("timeline dependency lines meet their bars when lanes are taller than planned", async () => {
  const dom = new JSDOM("<body></body>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  const w = dom.window;
  // Lay the chart out as a browser would, with every lane 80px tall: more
  // than its bars need, as when its label wraps.
  const box = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  const rect = function () {
    if (this.matches(".timeline-deps")) return box(150, 100, 1000, 400);
    if (this.matches(".timeline-body")) return box(0, 100, 1150, 400);
    if (this.matches(".timeline-bar")) {
      const lane = [
        ...this.closest(".timeline-body").querySelectorAll(".timeline-lane"),
      ].indexOf(this.closest(".timeline-lane"));
      return box(
        150 + parseFloat(this.style.left) * 10,
        100 + lane * 80 + parseFloat(this.style.top),
        parseFloat(this.style.width) * 10,
        28,
      );
    }
    return box(0, 0, 0, 0);
  };
  w.HTMLElement.prototype.getBoundingClientRect = rect;
  w.SVGElement.prototype.getBoundingClientRect = rect;
  try {
    const { openTasksDialog } = await import("../src/planning/tasks-dialog.js");
    const { b } = plan();
    const opened = openTasksDialog({
      board: () => b,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      canAdd: () => true,
      selectedTasks: () => [],
      jira: { status: () => ({ available: false, message: "" }) },
      focusObject() {},
      placeTimeline() {},
      setStatusSync() {},
      download() {},
    });
    const group = opened.dialog.querySelector("#tasks-group");
    group.value = "status";
    group.dispatchEvent(new w.Event("change", { bubbles: true }));
    opened.dialog.querySelector("#tasks-tab-timeline").click();
    const lines = [...opened.dialog.querySelectorAll(".timeline-deps g")];
    assert.ok(lines.length);
    for (const line of lines) {
      const center = (id) => {
        const r = rect.call(
          opened.dialog.querySelector(`.timeline-bar[data-task="${id}"]`),
        );
        return r.top + r.height / 2 - 100;
      };
      const [start, end] = line
        .querySelector("path")
        .getAttribute("d")
        .match(/M[\d.]+ ([\d.]+)H[\d.]+V([\d.]+)/)
        .slice(1)
        .map(Number);
      assert.equal(start, center(line.dataset.from));
      assert.equal(end, center(line.dataset.to));
    }
    assert.equal(
      opened.dialog.querySelector(".timeline-deps").getAttribute("viewBox"),
      "0 0 1000 400",
    );
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("the timeline shows every dated task whatever the list's filters are", async () => {
  const dom = new JSDOM("<body></body>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { openTasksDialog } = await import("../src/planning/tasks-dialog.js");
    const { b, design, build, ship } = plan();
    let placed;
    const opened = openTasksDialog({
      board: () => b,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      canAdd: () => true,
      selectedTasks: () => [],
      jira: { status: () => ({ available: false, message: "" }) },
      focusObject() {},
      placeTimeline: (rows) => ((placed = rows), false),
      setStatusSync() {},
      download() {},
    });
    const d = opened.dialog;
    const status = d.querySelector("#tasks-status");
    status.value = "in-progress";
    status.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(d.querySelectorAll(".task-go").length, 1);
    d.querySelector("#tasks-tab-timeline").click();
    // The filters stay on the List tab and do not narrow the timeline.
    assert.ok(d.querySelector("#tasks-status").closest("[hidden]"));
    assert.deepEqual(
      [...d.querySelectorAll(".timeline-bar")]
        .map((x) => x.dataset.task)
        .sort(),
      [design.id, build.id, ship.id].sort(),
    );
    d.querySelector("#timeline-place").click();
    assert.equal(placed.length, 4);
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("French task statuses, priorities, and dependencies agree with their nouns", async () => {
  const dom = new JSDOM("<body></body>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  const { setLanguage, t } = await import("../src/i18n.js");
  await import("../src/planning/i18n.js");
  try {
    setLanguage("fr");
    assert.deepEqual(
      STATUSES.map((s) => t(STATUS_LABELS[s], "task")),
      ["À faire", "En cours", "Bloquée", "Terminée"],
    );
    assert.equal(t("None", "priority"), "Aucune");
    assert.equal(t("None", "dependency"), "Aucune");
    // Elsewhere the core wording stays.
    assert.equal(t("Done"), "Terminé");
    // The board spreadsheet names a task's status as the task does.
    const { b, retro } = plan();
    const objects = spreadsheetModel(b, exportRegions(b))[0].rows;
    const row = objects.find((r) => r.includes(retro.text));
    assert.equal(row[objects[0].indexOf("Statut")], "Terminée");
    setLanguage("en");
    assert.equal(t(STATUS_LABELS.done, "task"), "Done");
  } finally {
    setLanguage("en");
    globalThis.document = previous;
    dom.window.close();
  }
});

test("a comment pin opens comments in place of the task panel", async () => {
  const app = await setup();
  const { w, doc, click, tick } = app;
  try {
    // Pins are placed on a canvas that has a size.
    w.HTMLElement.prototype.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      x: 0,
      y: 0,
      right: 1200,
      bottom: 800,
      width: 1200,
      height: 800,
    });
    await click('[data-action="new"]');
    await click('[data-action="add-note"]');
    await click('[data-action="add-comment"]');
    const text = doc.querySelector("#comment-text");
    text.value = "Check this";
    text.dispatchEvent(new w.Event("input", { bubbles: true }));
    doc
      .querySelector("#comment-form")
      .dispatchEvent(
        new w.Event("submit", { bubbles: true, cancelable: true }),
      );
    await tick();
    await click("#comments-close");
    await click("#board-outline button");
    await click("#task-details");
    assert.ok(doc.querySelector("#task-panel"));
    await click("#comment-pins button");
    assert.ok(doc.querySelector("#comments-panel"));
    assert.equal(doc.querySelector("#task-panel"), null);
  } finally {
    app.close();
  }
});

test("a placed timeline leaves out tasks hidden from participants", async () => {
  const dom = new JSDOM(
    '<div class="canvas-wrap"><canvas id="canvas"></canvas></div>',
    { url: "https://whiteboard.test", pretendToBeVisual: true },
  );
  const previous = {
    document: globalThis.document,
    NodeFilter: globalThis.NodeFilter,
  };
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  try {
    const { createPlanning } = await import("../src/planning/index.js");
    const { b, design } = plan();
    b.workshop = { settings: { hide: [design.id] } };
    const toasts = [];
    let d;
    const planning = createPlanning({
      board: () => b,
      selection: () => new Set(),
      select: () => {},
      canvas: () => document.querySelector("#canvas"),
      readOnly: () => false,
      session: () => null,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      prepare: () => {},
      mutate: (fn) => fn(),
      focusRegion: () => {},
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.close = () => d.remove();
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast: (m) => toasts.push(m),
      download: () => {},
    });
    const before = b.items.length;
    planning.actions.tasks();
    d.querySelector("#tasks-tab-timeline").click();
    // The facilitator still sees the hidden task in the dialog...
    assert.ok(
      [...d.querySelectorAll(".timeline-bar")].some(
        (x) => x.dataset.task === design.id,
      ),
    );
    d.querySelector("#timeline-place").click();
    // ...but the placed timeline, which everyone sees, leaves it out.
    const added = b.items.slice(before);
    assert.ok(added.length > 0);
    assert.ok(!added.some((i) => /Design review/.test(i.text || "")));
    assert.ok(!added.some((i) => i.objectLink?.objectId === design.id));
    assert.match(toasts.at(-1), /Tasks hidden from participants are left out/);
  } finally {
    dom.window.close();
    globalThis.document = previous.document;
    globalThis.NodeFilter = previous.NodeFilter;
  }
});

test("Refresh timeline draws a placed timeline again from its tasks, as one change, unless refused", async () => {
  const dom = new JSDOM(
    '<div class="canvas-wrap"><canvas id="canvas"></canvas></div>',
    { url: "https://whiteboard.test", pretendToBeVisual: true },
  );
  const previous = {
    document: globalThis.document,
    NodeFilter: globalThis.NodeFilter,
  };
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  try {
    const { createPlanning } = await import("../src/planning/index.js");
    const { b, design, build, plain } = plan();
    const toasts = [];
    let d,
      selection = new Set(),
      readOnly = false,
      boardLocked = null,
      changes = 0;
    const planning = createPlanning({
      board: () => b,
      selection: () => selection,
      select: (ids) => (selection = ids),
      canvas: () => document.querySelector("#canvas"),
      readOnly: () => readOnly,
      boardLocked: () => boardLocked,
      session: () => null,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      prepare: () => {},
      mutate: (fn) => {
        changes++;
        fn();
      },
      focusRegion: () => {},
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.close = () => d.remove();
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast: (m) => toasts.push(m),
      download: () => {},
    });
    planning.actions.tasks();
    d.querySelector("#tasks-tab-timeline").click();
    d.querySelector("#timeline-place").click();
    // Placing says the timeline is a copy and how to bring it up to date.
    assert.match(toasts.at(-1), /select it and choose Refresh timeline/);
    const [frameId] = selection;
    const frame = b.items.find((i) => i.id === frameId);
    const barOf = (id) =>
      b.items.find(
        (i) => i.parentId === frameId && i.objectLink?.objectId === id,
      );
    assert.equal(planning.timelineSelected(), true);
    // A bar inside it offers the refresh too; an ordinary note does not.
    selection = new Set([barOf(design.id).id]);
    assert.equal(planning.timelineSelected(), true);
    selection = new Set([plain.id]);
    assert.equal(planning.timelineSelected(), false);
    planning.actions["timeline-refresh"]();
    assert.equal(
      toasts.at(-1),
      "Select a timeline placed from the Tasks view.",
    );
    design.task.status = "done";
    build.task.due = "2026-10-08";
    const designBar = barOf(design.id),
      buildEnd = barOf(build.id).x + barOf(build.id).w;
    const unchanged = structuredClone(b.items);
    selection = new Set([designBar.id]);
    // Read-only access, the facilitator's lock, and a locked bar refuse it.
    readOnly = true;
    planning.actions["timeline-refresh"]();
    assert.equal(toasts.at(-1), "This board is read-only.");
    readOnly = false;
    boardLocked = "The facilitator locked this board.";
    planning.actions["timeline-refresh"]();
    assert.equal(toasts.at(-1), "The facilitator locked this board.");
    boardLocked = null;
    designBar.locked = true;
    planning.actions["timeline-refresh"]();
    assert.equal(
      toasts.at(-1),
      "Unlock protected objects before changing this selection.",
    );
    delete designBar.locked;
    assert.deepEqual(b.items, unchanged);
    const before = changes;
    planning.actions["timeline-refresh"]();
    assert.equal(changes, before + 1, "One change, so one undo step");
    assert.equal(toasts.at(-1), "Timeline refreshed from the board’s tasks.");
    assert.deepEqual([...selection], [frameId]);
    // The same frame, in the same place, with only its size drawn again.
    const { w: _w, h: _h, ...kept } = b.items.find((i) => i.id === frameId);
    const { w: _fw, h: _fh, ...was } = frame;
    assert.deepEqual(kept, was);
    assert.equal(barOf(design.id).id, designBar.id);
    assert.match(barOf(design.id).text, /Design review \(Done\)/);
    assert.ok(barOf(build.id).x + barOf(build.id).w > buildEnd);
    validateBoard(b);
  } finally {
    dom.window.close();
    globalThis.document = previous.document;
    globalThis.NodeFilter = previous.NodeFilter;
  }
});

test("the Tasks dialog keeps refusals and Jira results on screen instead of a fading notification", async () => {
  const dom = new JSDOM(
    '<div class="canvas-wrap"><canvas id="canvas"></canvas></div>',
    { url: "https://whiteboard.test", pretendToBeVisual: true },
  );
  const previous = {
    document: globalThis.document,
    NodeFilter: globalThis.NodeFilter,
  };
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  try {
    const { createPlanning } = await import("../src/planning/index.js");
    const { b } = plan();
    const tasks = b.items.filter((i) => i.task);
    // Every task is hidden from participants, so none can be placed.
    b.workshop = { settings: { hide: tasks.map((i) => i.id) } };
    const toasts = [];
    let d,
      fail = true;
    const org = {
      server: "https://org.puter.work",
      info: { configured: true, role: "member" },
      allows: () => true,
      request: async (op, { issues }) => {
        if (fail) throw Error("Could not reach Jira.");
        return {
          created: issues.map((i, n) => ({
            item: i.item,
            key: `WB-${n + 1}`,
            url: `https://fabrikam.atlassian.net/browse/WB-${n + 1}`,
          })),
        };
      },
    };
    const planning = createPlanning({
      board: () => b,
      selection: () => new Set(tasks.map((i) => i.id)),
      select: () => {},
      canvas: () => document.querySelector("#canvas"),
      readOnly: () => false,
      session: () => ({ server: org.server, room: b.id }),
      org,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      prepare: () => {},
      mutate: (fn) => fn(),
      focusRegion: () => {},
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.close = () => d.remove();
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast: (m) => toasts.push(m),
      download: () => {},
    });
    planning.actions.tasks();
    const feedback = d.querySelector("#tasks-feedback");
    assert.equal(feedback.getAttribute("role"), "status");
    d.querySelector("#tasks-tab-timeline").click();
    d.querySelector("#timeline-place").click();
    assert.ok(d.isConnected, "The refused dialog stays open");
    assert.match(feedback.textContent, /hidden from participants/);
    assert.deepEqual(toasts, []);
    const send = d.querySelector("#tasks-jira-send");
    send.click();
    assert.equal(feedback.textContent, "", "A new action clears the old one");
    for (let n = 0; n < 20 && !feedback.textContent; n++)
      await new Promise((r) => setTimeout(r, 0));
    assert.equal(feedback.textContent, "Could not reach Jira.");
    fail = false;
    d.querySelector("#tasks-jira-send").click();
    for (let n = 0; n < 20 && !/created/.test(feedback.textContent); n++)
      await new Promise((r) => setTimeout(r, 0));
    assert.match(feedback.textContent, /^Jira issues created: \d+\.$/);
    assert.deepEqual(toasts, []);
    // Once the dialog has closed, results go back to the notification.
    d.close();
    for (const i of tasks) delete i.task.jira;
    await planning.actions["task-jira-send"]();
    assert.match(toasts.at(-1), /^Jira issues created/);
  } finally {
    dom.window.close();
    globalThis.document = previous.document;
    globalThis.NodeFilter = previous.NodeFilter;
  }
});

test("a dependency that would make tasks wait on each other in a loop is refused", async () => {
  const { b, design, build, ship, dependency } = plan();
  const line = (from, to, value = "") => ({
    ...item("arrow", 0, 0, { text: "" }),
    startId: from.id,
    endId: to.id,
    ...(value ? { dependency: value } : {}),
  });
  // Design blocks Build already; Build blocking Design would be a loop.
  const back = line(build, design);
  assert.equal(dependencyCycle([...b.items, back], back, "blocks"), true);
  assert.equal(dependencyCycle([...b.items, back], back, "depends-on"), false);
  // Loops through other tasks count too.
  const onward = line(build, ship, "blocks");
  const close = line(ship, design);
  const items = [...b.items, onward, close];
  assert.equal(dependencyCycle(items, close, "blocks"), true);
  // A line changing its own direction is not a loop with itself.
  assert.equal(dependencyCycle(b.items, dependency, "depends-on"), false);
  // The line menu refuses it and keeps the line as it was.
  const dom = new JSDOM(
    '<div class="canvas-wrap"><canvas id="canvas"></canvas></div><div id="selection-tools"><div class="selection-row"></div><div class="line-format-tools"></div></div>',
    { url: "https://whiteboard.test", pretendToBeVisual: true },
  );
  const previous = {
    document: globalThis.document,
    NodeFilter: globalThis.NodeFilter,
  };
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  try {
    const { createPlanning } = await import("../src/planning/index.js");
    b.items.push(back);
    const toasts = [];
    let mutations = 0;
    const planning = createPlanning({
      board: () => b,
      selection: () => new Set([back.id]),
      canvas: () => document.querySelector("#canvas"),
      readOnly: () => false,
      session: () => null,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      prepare: () => {},
      mutate: (fn) => (mutations++, fn()),
      toast: (m) => toasts.push(m),
    });
    planning.render();
    const select = document.querySelector("#line-dependency");
    select.value = "blocks";
    select.dispatchEvent(new dom.window.Event("change"));
    assert.equal(mutations, 0);
    assert.equal(back.dependency, undefined);
    assert.equal(select.value, "");
    assert.match(toasts.at(-1), /wait for each other in a loop/);
    select.value = "depends-on";
    select.dispatchEvent(new dom.window.Event("change"));
    assert.equal(back.dependency, "depends-on");
  } finally {
    dom.window.close();
    globalThis.document = previous.document;
    globalThis.NodeFilter = previous.NodeFilter;
  }
});

test("dependencies two people add at once never leave tasks waiting on each other", () => {
  const initial = board("Plan");
  const design = item("note", 0, 0, { text: "Design", task: newTask() }),
    build = item("note", 400, 0, { text: "Build", task: newTask() });
  const first = item("arrow", 0, 0, { startId: design.id, endId: build.id }),
    second = item("arrow", 0, 0, { startId: build.id, endId: design.id });
  initial.items = [design, build, first, second];
  const seed = new SharedDocument();
  seed.commit(initial);
  const a = new SharedDocument(seed.update()),
    b = new SharedDocument(seed.update());
  seed.destroy();
  try {
    // Each adds one dependency; each alone is allowed.
    const mine = a.snapshot(),
      theirs = b.snapshot();
    mine.items.find((i) => i.id === first.id).dependency = "blocks";
    theirs.items.find((i) => i.id === second.id).dependency = "blocks";
    a.commit(mine);
    b.commit(theirs);
    a.apply(b.update(a.vector()));
    b.apply(a.update(b.vector()));
    for (const doc of [a, b]) {
      const merged = doc.snapshot();
      validateBoard(merged);
      assert.equal(dependencyEdges(merged.items).length, 1);
      const rows = collectTasks(merged, { today: TODAY });
      assert.equal(rows.filter((r) => r.blockedBy.length).length, 1);
    }
    assert.deepEqual(
      dependencyEdges(a.snapshot().items),
      dependencyEdges(b.snapshot().items),
    );
  } finally {
    a.destroy();
    b.destroy();
  }
});

test("members who can no longer open a board are marked so no one assigns them", async () => {
  const env = environment();
  const boards = env.service;
  const b = board("Team");
  b.items = [item("note", 0, 0, { text: "Plan" })];
  const seed = new SharedDocument();
  seed.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await boards.call(owner, {
    op: "invite",
    room: b.id,
    role: "editor",
  });
  await boards.call(editor, { op: "join", room: b.id, token: invite.token });
  await boards.org.kv.set("org:user:" + editor.uuid, {
    uuid: editor.uuid,
    username: editor.username,
    status: "deactivated",
    role: "member",
  });
  boards.org.forgetUser(editor.uuid);
  const { members } = await boards.call(owner, {
    op: "members",
    room: b.id,
  });
  const byId = new Map(members.map((m) => [m.uuid, m]));
  assert.equal(byId.get(editor.uuid).inactive, true);
  assert.equal(byId.get(owner.uuid).inactive, undefined);
});

test("assignee names from tasks hidden from this person are not suggested", async () => {
  const dom = new JSDOM(
    '<div class="canvas-wrap"><canvas id="canvas" tabindex="0"></canvas></div>',
    { url: "https://whiteboard.test", pretendToBeVisual: true },
  );
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { createTaskPanel } = await import("../src/planning/task-panel.js");
    const { b, ship } = plan();
    const design = b.items.find((i) => i.text === "Design review");
    const panel = createTaskPanel({
      board: () => b,
      selection: () => new Set([ship.id]),
      canvas: () => document.querySelector("#canvas"),
      canEdit: () => true,
      readOnly: () => false,
      mutate: (fn) => {
        fn();
        panel.render();
      },
      toast: () => {},
      announce: () => {},
      prepare: () => {},
      people: async () => null,
      concealed: () => new Set([design.id]),
      jira: { available: () => false },
    });
    panel.open();
    const suggested = [
      ...document.querySelectorAll("#task-assignee-names option"),
    ].map((o) => o.value);
    assert.ok(suggested.length > 0);
    assert.ok(!suggested.includes("Bob Smith"), suggested.join(", "));
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("tasks that come back are not announced again, however many there are or whoever assigned them", async () => {
  const env = environment();
  const boards = env.service;
  const b = board("Sprint");
  b.items = [item("note", 0, 0, { text: "Start" })];
  const seed = new SharedDocument();
  seed.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const invite = await boards.call(owner, {
    op: "invite",
    room: b.id,
    role: "editor",
  });
  await boards.call(editor, { op: "join", room: b.id, token: invite.token });
  async function commit(user, change) {
    const { doc } = await boards.load(b.id);
    const vector = doc.vector();
    const next = doc.snapshot();
    change(next);
    doc.commit(next);
    const update = doc.update(vector);
    doc.destroy();
    env.now += 1000;
    return boards.call(user, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
    });
  }
  const notices = async () =>
    (await adminCall(boards.org, boards, editor, { op: "notifications.list" }))
      .items;
  const task = (n) =>
    item("note", n * 10, 100, {
      text: `Task ${n}`,
      task: { ...newTask(), assignee: { id: editor.uuid, name: "Bob" } },
    });
  // Bob assigns himself a task, which the owner deletes and brings back.
  const own = task(-1);
  await commit(editor, (next) => next.items.push(structuredClone(own)));
  await commit(owner, (next) => {
    next.items = next.items.filter((i) => i.id !== own.id);
  });
  await commit(owner, (next) => next.items.push(structuredClone(own)));
  assert.equal((await notices()).length, 0);
  // 150 tasks assigned at once, deleted, and restored.
  const many = Array.from({ length: 150 }, (_, n) => task(n));
  await commit(owner, (next) => next.items.push(...structuredClone(many)));
  const [first] = await notices();
  assert.equal(first.more, 149);
  const ids = new Set(many.map((i) => i.id));
  await commit(owner, (next) => {
    next.items = next.items.filter((i) => !ids.has(i.id));
  });
  await commit(owner, (next) => next.items.push(...structuredClone(many)));
  assert.equal((await notices()).length, 1);
});

test("focus stays in the tasks dialog and returns from the task panel when a collaborator removes the task", async () => {
  const dom = new JSDOM(
    '<div><canvas id="canvas" tabindex="0"></canvas></div>',
    { url: "https://whiteboard.test" },
  );
  const saved = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { openTasksDialog } = await import("../src/planning/tasks-dialog.js");
    const { createTaskPanel } = await import("../src/planning/task-panel.js");
    const b = board("Tasks");
    const task = (text, due) =>
      item("note", 0, 0, {
        text,
        task: { assignee: null, start: null, due, status: "todo" },
      });
    const alpha = task("Alpha", "2026-10-01"),
      charlie = task("Charlie", "2026-10-03");
    b.items = [alpha, charlie];
    const opened = openTasksDialog({
      board: () => b,
      now: () => Date.now(),
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      canAdd: () => true,
      selectedTasks: () => [],
      jira: { status: () => ({ available: false, message: "" }) },
      focusObject() {},
      placeTimeline() {},
      setStatusSync() {},
      download() {},
    });
    const inside = () => opened.dialog.contains(document.activeElement);
    opened.dialog.querySelector(`.task-go[data-task="${alpha.id}"]`).focus();
    b.items = b.items.filter((i) => i !== alpha);
    opened.refresh();
    assert.ok(inside(), "a removed row");
    opened.dialog.querySelector("#tasks-tab-timeline").click();
    opened.dialog.querySelector(".timeline-bar").focus();
    charlie.task = { ...charlie.task, due: null };
    opened.refresh();
    assert.ok(inside(), "a bar whose task lost its dates");
    opened.dialog.remove();
    // The task panel closes and returns focus instead of leaving it on the page.
    const note = task("Note", null);
    b.items = [note];
    const selection = new Set([note.id]);
    const panel = createTaskPanel({
      board: () => b,
      selection: () => selection,
      canvas: () => document.querySelector("#canvas"),
      canEdit: () => true,
      readOnly: () => false,
      mutate: (fn) => fn(),
      toast() {},
      announce() {},
      prepare() {},
      people: () => Promise.resolve(null),
      jira: { available: () => false },
    });
    panel.open();
    assert.ok(
      document.activeElement.closest(".task-panel, #task-panel") ||
        document.activeElement.id.startsWith("task"),
    );
    b.items = [];
    selection.clear();
    panel.render();
    assert.equal(panel.isOpen(), false);
    assert.equal(document.activeElement, document.querySelector("#canvas"));
  } finally {
    globalThis.document = saved;
    dom.window.close();
  }
});

for (const length of [248, 249, 250])
  test(`Jira task summary retains complete Unicode at ${length} characters`, () => {
    const text = "Q".repeat(length) + "😀\nOriginal description 😀";
    const b = board("Jira summary");
    b.items = [
      item("note", 0, 0, {
        text,
        lang: "fr-CA",
        textRuns: [
          { start: length, end: length + 2, style: { lang: "en-GB" } },
        ],
        task: {
          assignee: null,
          start: null,
          due: "2026-10-10",
          status: "todo",
        },
      }),
    ];
    validateBoard(structuredClone(b));
    const before = structuredClone(b);
    const issues = jiraIssues(b.items);
    assert.equal(issues.length, 1);
    assert.equal(
      issues[0].summary,
      "Q".repeat(length) + (length === 248 ? "😀" : ""),
    );
    assert.equal(issues[0].summary.isWellFormed(), true);
    assert.equal(issues[0].description, text);
    assert.equal(issues[0].due, "2026-10-10");
    assert.deepEqual(b, before);
    assert.equal(
      JSON.parse(JSON.stringify(issues))[0].summary,
      issues[0].summary,
    );
  });

for (const locale of ["en", "fr"])
  for (const length of [248, 249, 250])
    test(`Jira task panel sends complete Unicode at ${length} characters in ${locale}`, async () => {
      const dom = new JSDOM(
          '<div><canvas id="canvas" tabindex="0"></canvas></div>',
          { url: "https://whiteboard.test" },
        ),
        previous = globalThis.document;
      globalThis.document = dom.window.document;
      let planning, finish;
      const i18n = await import("../src/i18n.js"),
        previousLanguage = i18n.language;
      try {
        const { createPlanning } = await import("../src/planning/index.js");
        i18n.setLanguage(locale);
        const text = "Q".repeat(length) + "😀\nOriginal description 😀",
          b = board("Jira Unicode");
        b.items = [
          item("note", 0, 0, {
            text,
            lang: "fr-CA",
            textRuns: [
              { start: length, end: length + 2, style: { lang: "en-GB" } },
            ],
            task: {
              assignee: null,
              start: null,
              due: "2026-10-10",
              status: "todo",
            },
          }),
        ];
        validateBoard(structuredClone(b));
        const original = structuredClone(b);
        let received;
        const session = {
            server: "https://org.puter.work",
            room: b.id,
            request: async () => ({ members: [] }),
          },
          org = {
            server: session.server,
            info: { configured: true, role: "member" },
            allows: () => true,
            request: (op, payload) => {
              assert.equal(op, "org.jira.create");
              received = structuredClone(payload);
              return new Promise((resolve) => (finish = resolve));
            },
          };
        planning = createPlanning({
          board: () => b,
          selection: () => new Set([b.items[0].id]),
          readOnly: () => false,
          session: () => session,
          org,
          canvas: () => document.querySelector("canvas"),
          prepare() {},
          now: () => Date.now(),
          mutate: (fn) => fn(),
          toast() {},
        });
        planning.actions["task-details"]();
        const button = document.querySelector("#task-jira-send");
        assert.equal(button.hidden, false);
        button.focus();
        button.click();
        assert.ok(received);
        assert.equal(received.room, b.id);
        const issue = received.issues[0];
        assert.equal(
          issue.summary,
          "Q".repeat(length) + (length === 248 ? "😀" : ""),
        );
        assert.equal(issue.summary.isWellFormed(), true);
        assert.equal(issue.description, text);
        assert.equal(issue.due, "2026-10-10");
        assert.deepEqual(b, original);
        assert.equal(document.documentElement.lang, locale);
        assert.equal(document.activeElement, button);
      } finally {
        finish?.({ created: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        planning?.close();
        i18n.setLanguage(previousLanguage);
        dom.window.close();
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
      }
    });

test("refreshing Jira status skips tasks a lock protects instead of stopping", async (t) => {
  const dom = new JSDOM('<canvas id="canvas"></canvas>'),
    previous = {
      document: globalThis.document,
      NodeFilter: globalThis.NodeFilter,
    };
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  t.after(() => {
    dom.window.close();
    globalThis.document = previous.document;
    globalThis.NodeFilter = previous.NodeFilter;
  });
  const { createPlanning } = await import("../src/planning/index.js");
  const { hasLocked } = await import("../src/locking.js");
  const b = board("Jira");
  const link = (key) => ({
    key,
    url: `https://team.atlassian.net/browse/${key}`,
  });
  const grouped = item("note", 0, 0, {
    text: "Grouped",
    groupId: "g1",
    task: { status: "todo", jira: link("WB-1") },
  });
  const free = item("note", 300, 0, {
    text: "Free",
    task: { status: "todo", jira: link("WB-2") },
  });
  // The grouped task's group holds a locked note.
  b.items = [
    grouped,
    item("note", 0, 200, { text: "Locked", groupId: "g1", locked: true }),
    free,
  ];
  const requests = [],
    toasts = [];
  const planning = createPlanning({
    board: () => b,
    selection: () => new Set(),
    readOnly: () => false,
    locked: (ids) => hasLocked(b.items, ids),
    session: () => ({ server: "https://org.puter.work", room: b.id }),
    org: {
      server: "https://org.puter.work",
      info: { configured: true, role: "member" },
      allows: () => true,
      request: async (op, body) => {
        requests.push(body.keys);
        return {
          issues: body.keys.map((key) => ({ key, status: "In Review" })),
        };
      },
    },
    mutate: (fn) => fn(),
    toast: (message) => toasts.push(message),
    now: () => Date.now(),
    canvas: () => null,
  });
  await planning.actions["task-jira-refresh"]();
  assert.deepEqual(requests, [["WB-2"]]);
  assert.equal(free.task.jira.status, "In Review");
  assert.equal(grouped.task.jira.status, undefined);
});

test("the Tasks timeline draws a dependency added on a finished task", async () => {
  const dom = new JSDOM("<body></body>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { openTasksDialog } = await import("../src/planning/tasks-dialog.js");
    const b = board("Dependencies");
    const done = item("note", 0, 0, {
      text: "Done first",
      task: { status: "done", start: "2026-10-01", due: "2026-10-02" },
    });
    const next = item("note", 300, 0, {
      text: "Then this",
      task: { status: "todo", start: "2026-10-03", due: "2026-10-05" },
    });
    b.items = [done, next];
    const opened = openTasksDialog(
      {
        board: () => b,
        now: () => Date.parse(`${TODAY}T12:00:00`),
        modal: (title, html, ready) => {
          const d = document.createElement("dialog");
          d.innerHTML = html;
          document.body.append(d);
          ready(d);
          return d;
        },
        canAdd: () => true,
        selectedTasks: () => [],
        jira: { status: () => ({ available: false, message: "" }) },
        focusObject() {},
        placeTimeline() {},
        setStatusSync() {},
        download() {},
      },
      { tab: "timeline" },
    );
    const lines = () =>
      opened.dialog.querySelectorAll(".timeline-deps g").length;
    assert.equal(lines(), 0);
    b.items.push(
      item("arrow", 0, 0, {
        startId: done.id,
        endId: next.id,
        dependency: "blocks",
      }),
    );
    opened.refresh();
    assert.equal(lines(), 1);
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("the Tasks dialog's Jira buttons keep keyboard focus after they finish", async () => {
  const dom = new JSDOM("<body></body>", { url: "https://x.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { openTasksDialog } = await import("../src/planning/tasks-dialog.js");
    const b = board("Jira");
    const linked = item("note", 0, 0, {
      text: "Linked",
      task: {
        status: "todo",
        jira: { key: "WB-1", url: "https://x.atlassian.net/browse/WB-1" },
      },
    });
    b.items = [linked];
    let finish;
    const opened = openTasksDialog({
      board: () => b,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      canAdd: () => true,
      selectedTasks: () => [linked],
      jira: {
        status: () => ({ available: true, message: "" }),
        refresh: () => new Promise((r) => (finish = r)),
        send: () => new Promise((r) => (finish = r)),
      },
      focusObject() {},
      placeTimeline() {},
      setStatusSync() {},
      download() {},
    });
    for (const id of ["tasks-jira-refresh", "tasks-jira-send"]) {
      const button = opened.dialog.querySelector(`#${id}`);
      button.focus();
      button.click();
      assert.equal(button.disabled, true);
      // Browsers move focus off a control that turns off.
      const elsewhere = document.createElement("input");
      document.body.append(elsewhere);
      elsewhere.focus();
      elsewhere.remove();
      assert.notEqual(document.activeElement, button);
      finish();
      await new Promise((r) => setTimeout(r));
      assert.equal(document.activeElement.id, id);
    }
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("keyboard focus stays on a task's Jira link when the task list or panel refreshes", async () => {
  const dom = new JSDOM(
    '<div><canvas id="canvas" tabindex="0"></canvas></div>',
    {
      url: "https://x.test",
      pretendToBeVisual: true,
    },
  );
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { openTasksDialog } = await import("../src/planning/tasks-dialog.js");
    const { createTaskPanel } = await import("../src/planning/task-panel.js");
    const jira = (key) => ({
      key,
      url: `https://team.atlassian.net/browse/${key}`,
    });
    const b = board("Jira");
    const linked = item("note", 0, 0, {
      text: "Linked",
      task: { status: "todo", jira: jira("WB-1") },
    });
    const other = item("note", 300, 0, {
      text: "Other",
      task: { status: "todo" },
    });
    b.items = [linked, other];
    const opened = openTasksDialog({
      board: () => b,
      now: () => Date.parse(`${TODAY}T12:00:00`),
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      canAdd: () => true,
      selectedTasks: () => [],
      jira: { status: () => ({ available: false, message: "" }) },
      focusObject() {},
      placeTimeline() {},
      setStatusSync() {},
      download() {},
    });
    opened.dialog.querySelector(`[data-jira-task="${linked.id}"] a`).focus();
    other.task = { ...other.task, status: "blocked" };
    opened.refresh();
    assert.equal(document.activeElement.textContent, "WB-1");
    opened.dialog.remove();
    // The task panel keeps it too when the issue's status arrives.
    const panel = createTaskPanel({
      board: () => b,
      selection: () => new Set([linked.id]),
      canvas: () => document.querySelector("#canvas"),
      canEdit: () => true,
      readOnly: () => false,
      mutate: (fn) => (fn(), panel.render()),
      toast() {},
      announce() {},
      prepare() {},
      people: () => Promise.resolve(null),
      jira: { available: () => true },
    });
    panel.open();
    document.querySelector("#task-jira a").focus();
    linked.task = {
      ...linked.task,
      jira: { ...linked.task.jira, status: "In Review" },
    };
    panel.render();
    assert.equal(document.activeElement.textContent, "WB-1");
    panel.close();
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("task titles are read again only when an object's text, runs or language change", () => {
  const b = board("Titles");
  const a = item("note", 0, 0, {
    text: "  Plan   the\nlaunch  ",
    task: { assignee: null, start: null, due: null, status: "todo" },
  });
  b.items = [a];
  const first = collectTasks(b)[0];
  assert.equal(first.title, "Plan the launch");
  const again = collectTasks(b)[0];
  assert.equal(again.title, "Plan the launch");
  assert.notEqual(first, again, "each row is its own object");
  a.text = "Ship it";
  assert.equal(collectTasks(b)[0].title, "Ship it");
  a.textRuns = [{ start: 0, end: 4, style: { lang: "fr" } }];
  assert.deepEqual(collectTasks(b)[0].titleRuns, [
    { start: 0, end: 4, style: { lang: "fr" } },
  ]);
  a.lang = "fr-CA";
  assert.equal(collectTasks(b)[0].titleLang, "fr-CA");
});

test("placed timeline text is readable on its lanes and the canvas in both themes", () => {
  const { b } = plan();
  const { items } = timelineItems(b, collectTasks(b, { today: TODAY }), {
    today: TODAY,
    groupBy: "status",
    origin: { x: 0, y: 900 },
  });
  const luminance = (hex) =>
    hex
      .match(/[\da-f]{2}/gi)
      .map((v) => parseInt(v, 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, n) => sum + v * [0.2126, 0.7152, 0.0722][n], 0);
  const contrast = (a, b) => {
    const x = luminance(a),
      y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  // The theme's ink (--text) and canvas (--canvas) in style.css; frames
  // are drawn without a fill.
  const themes = {
    light: { ink: "#253247", canvas: "#f3f4f6" },
    dark: { ink: "#e6edf8", canvas: "#19212d" },
  };
  const fills = items.filter(
    (i) => i.type === "rect" && !i.text && !i.objectLink && i.w > 2,
  );
  const texts = items.filter((i) => i.type === "text");
  assert.ok(texts.some((i) => i.text === "Today"));
  assert.ok(texts.some((i) => i.text === "In progress"));
  for (const i of texts) {
    const cx = i.x + i.w / 2,
      cy = i.y + Math.min(i.h, 20) / 2;
    const under = fills.findLast(
      (r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h,
    );
    for (const [name, theme] of Object.entries(themes)) {
      const ink = i.textColor || theme.ink,
        back = i.highlight || under?.color || theme.canvas;
      assert.ok(
        contrast(ink, back) >= 4.5,
        `${i.text} in the ${name} theme: ${ink} on ${back} is ${contrast(ink, back).toFixed(2)}`,
      );
    }
  }
});

test("the Gantt chart's tasks are exported with the workstream lane they sit in", async () => {
  const { fromTemplate } = await import("../src/templates.js");
  for (const [lang, lanes] of [
    ["en", ["Discovery", "Design", "Build", "Launch"]],
    ["fr", ["Découverte", "Conception", "Développement", "Lancement"]],
  ]) {
    const b = fromTemplate("gantt", lang);
    const rows = collectTasks(b, { today: "2027-02-10" });
    const sheet = taskSheet(rows);
    const lane = sheet.rows[0].indexOf("Lane");
    assert.ok(lane > 0);
    assert.equal(sheet.rows[0].at(-1), "ID");
    const found = new Set(sheet.rows.slice(1).map((r) => r[lane]));
    assert.deepEqual([...found].sort(), [...lanes].sort());
    const research = rows.find((r) =>
      /User research|Recherche auprès/.test(r.title),
    );
    assert.equal(research.lane, lanes[0]);
  }
});

test("refreshing Jira status names issues Jira no longer has, and Jira's reason for refusing", async (t) => {
  const dom = new JSDOM('<canvas id="canvas"></canvas>'),
    previous = {
      document: globalThis.document,
      NodeFilter: globalThis.NodeFilter,
    };
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  t.after(() => {
    dom.window.close();
    globalThis.document = previous.document;
    globalThis.NodeFilter = previous.NodeFilter;
  });
  const { createPlanning } = await import("../src/planning/index.js");
  const b = board("Jira");
  const link = (key) => ({
    key,
    url: `https://team.atlassian.net/browse/${key}`,
  });
  b.items = ["WB-1", "WB-2"].map((key, n) =>
    item("note", n * 300, 0, {
      text: key,
      task: { status: "todo", jira: link(key) },
    }),
  );
  const toasts = [];
  let answer = async () => ({
    issues: [{ key: "WB-1", status: "Done", category: "done" }],
  });
  const planning = createPlanning({
    board: () => b,
    selection: () => new Set(),
    readOnly: () => false,
    locked: () => false,
    session: () => ({ server: "https://org.puter.work", room: b.id }),
    org: {
      server: "https://org.puter.work",
      info: { configured: true, role: "member" },
      allows: () => true,
      request: (op, body) => answer(body),
    },
    mutate: (fn) => fn(),
    toast: (message) => toasts.push(message),
    now: () => Date.now(),
    canvas: () => null,
  });
  await planning.actions["task-jira-refresh"]();
  assert.equal(
    toasts.at(-1),
    "Jira status updated: 1. Not found in Jira, so not updated: WB-2.",
  );
  // Nothing new for the issue it found.
  await planning.actions["task-jira-refresh"]();
  assert.equal(
    toasts.at(-1),
    "Not found in Jira, so not updated: WB-2. The others are up to date.",
  );
  answer = async () => {
    throw Object.assign(Error("Jira did not accept the request."), {
      status: 502,
      detail: "The value 'WB' does not exist for the field 'project'.",
    });
  };
  await planning.actions["task-jira-refresh"]();
  assert.equal(
    toasts.at(-1),
    "Jira did not accept the request. Jira says: The value 'WB' does not exist for the field 'project'.",
  );
});
