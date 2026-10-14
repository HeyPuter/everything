import "./i18n.js";
import { createElement, ListChecks, ChartGantt, SquareCheck } from "lucide";
import { bounds, escape, validateBoard, MAX_OBJECTS } from "../model.js";
import { t, labelled } from "../i18n.js";
import { addMoreTools, addShapeChoices } from "../features.js";
import { addCommands } from "../commands.js";
import { hasLocked, protectedIds } from "../locking.js";
import {
  DEPENDENCIES,
  STATUS_LABELS,
  taskable,
  hasTask,
  newTask,
  canBeDependency,
  dependencyCycle,
  localDate,
} from "./task.js";
import { createTaskPanel } from "./task-panel.js";
import { openTasksDialog } from "./tasks-dialog.js";
import {
  timelineItems,
  placedTimeline,
  refreshedTimeline,
} from "./timeline.js";
import {
  taskParents,
  applyStatusSync,
  alignColumnStatuses,
  statusSyncEnabled,
} from "./kanban.js";
import { jiraStatus, jiraIssues, applyCreated, applyStatuses } from "./jira.js";
import { collectTasks } from "./tasks.js";
import { concealment } from "../facilitation/model.js";

const svg = (node, extra = {}) => {
  const el = createElement(node, {
    "aria-hidden": "true",
    "stroke-width": 1.65,
    ...extra,
  });
  return el.outerHTML;
};
const iconButton = (node, label, id, extra = "") =>
  `<button type="button" class="icon-btn" id="${id}" aria-label="${escape(label)}" title="${escape(label)}" ${extra}>${svg(node)}</button>`;

// Planning features: task metadata on objects, the task panel, the Tasks
// dialog with its timeline, dependencies, Kanban status sync, and Jira.
// Everything the editor provides arrives through `api`.
export function createPlanning(api) {
  let dialog = null;
  const board = () => api.board();
  // Task lists, exports, and timelines show the board as this person sees
  // it, without private round notes or hidden objects.
  const view = () => api.view?.() ?? board();
  // Content hidden from this person, and the editor's lock check, which
  // also covers facilitator locks.
  const concealed = () => api.concealed?.() ?? new Set();
  const writable = (ids) =>
    !!board() &&
    !api.readOnly() &&
    !(api.locked ? api.locked(ids) : hasLocked(board().items, ids));
  // Why chosen objects cannot change: read-only access, the facilitator's
  // lock, or objects locked on the board.
  const refusal = () =>
    api.readOnly()
      ? "This board is read-only."
      : api.boardLocked?.() ||
        "Unlock protected objects before changing this selection.";
  // Why the board's plan and new objects cannot change now, or null.
  const unchangeable = () =>
    !board() || api.readOnly()
      ? "This board is read-only."
      : api.boardLocked?.() || null;
  const selectedTasks = () => {
    const hidden = concealed();
    return (
      board()?.items.filter(
        (i) => api.selection().has(i.id) && hasTask(i) && !hidden.has(i.id),
      ) || []
    );
  };
  // One send at a time: items are only linked once Jira answers, so a
  // second send meanwhile would create duplicate issues.
  let sending = false;
  const jira = {
    status: () => jiraStatus(api.org, api.session()),
    available: () => jiraStatus(api.org, api.session()).available,
    get sending() {
      return sending;
    },
    // The Tasks dialog passes `report` to keep the outcome on screen while
    // it is open; it returns false once the dialog has closed.
    async send(items, report) {
      if (sending) return;
      const say = (message) => report?.(message) || api.toast(message);
      const status = jiraStatus(api.org, api.session());
      if (!status.available) return say(status.message);
      const issues = jiraIssues(items);
      if (!issues.length)
        return say("Select tasks that are not linked to Jira yet.");
      if (!writable(new Set(issues.map((i) => i.item)))) return say(refusal());
      const target = board();
      // Up to 50 go per request; the toast says when more are waiting.
      const waiting =
        items.filter((i) => hasTask(i) && !i.task.jira).length - issues.length;
      sending = true;
      try {
        const { created } = await api.org.request("org.jira.create", {
          room: api.session().room,
          issues,
        });
        let result;
        // A lock or read-only access that arrived meanwhile keeps the
        // issues unlinked rather than reporting links that were refused.
        if (board() === target && writable(new Set(issues.map((i) => i.item))))
          api.mutate(() => {
            result = applyCreated(target.items, created);
          });
        const named = (keys) =>
          keys.slice(0, 5).join(", ") +
          (keys.length > 5 ? ` +${keys.length - 5}` : "");
        // The board was closed or became read-only meanwhile, so the new
        // issues are named for the person to find them in Jira.
        if (!result) {
          const made = (created || []).filter((c) => c.key).map((c) => c.key);
          if (made.length)
            say(
              `${labelled(t("Jira issues created"), "")}${made.length} (${named(made)}). ${t("They are not linked to their tasks because the board was closed, locked, or became read-only.")}`,
            );
          return;
        }
        const { unlinked } = result;
        say(
          (result.failed
            ? `${labelled(t("Jira issues created"), "")}${result.linked + unlinked.length}. ${labelled(t("Not created"), "")}${result.failed}. ${t(result.error || "Jira did not accept the request.")}${result.detail ? ` ${labelled(t("Jira says"), "")}${result.detail}` : ""}`
            : `${labelled(t("Jira issues created"), "")}${result.linked + unlinked.length}.`) +
            (unlinked.length
              ? ` ${labelled(t("Not linked because their tasks were deleted or linked by someone else meanwhile"), "")}${named(unlinked)}.`
              : "") +
            (waiting > 0
              ? ` ${labelled(t("Not sent yet"), "")}${waiting}. ${t("Send to Jira again to create them.")}`
              : ""),
        );
      } catch (error) {
        say(error.message || "Could not reach Jira.");
      } finally {
        sending = false;
      }
    },
    async refresh(report) {
      const say = (message) => report?.(message) || api.toast(message);
      const status = jiraStatus(api.org, api.session());
      if (!status.available) return say(status.message);
      const target = board();
      const hidden = concealed(),
        // Tasks a lock protects, including group members of a locked
        // object, are skipped rather than stopping every other update.
        blocked = protectedIds(target.items);
      const linked = target.items.filter(
        (i) =>
          hasTask(i) && i.task.jira && !blocked.has(i.id) && !hidden.has(i.id),
      );
      if (!linked.length) return say("No tasks are linked to Jira.");
      const ids = new Set(linked.map((i) => i.id));
      if (!writable(ids)) return say(refusal());
      try {
        // The worker checks up to 100 issues a request.
        const keys = [...new Set(linked.map((i) => i.task.jira.key))];
        const issues = [];
        for (let n = 0; n < keys.length; n += 100)
          issues.push(
            ...(
              await api.org.request("org.jira.status", {
                room: api.session().room,
                keys: keys.slice(n, n + 100),
              })
            ).issues,
          );
        if (board() !== target) return;
        if (!writable(ids)) return say(refusal());
        let changed = 0;
        const probe = linked.map((i) => ({ ...i, task: { ...i.task } }));
        if (applyStatuses(probe, issues))
          api.mutate(() => {
            changed = applyStatuses(linked, issues);
          });
        // Jira leaves out issues it no longer has, or that moved out of the
        // organization's project; their tasks keep their last status.
        const returned = new Set(issues.map((issue) => issue.key));
        const missing = keys.filter((key) => !returned.has(key));
        const outcome = changed
          ? `${labelled(t("Jira status updated"), "")}${changed}`
          : t("Jira status is up to date.");
        say(
          missing.length
            ? `${outcome}${changed ? "." : ""} ${labelled(t("Not found in Jira, so not updated"), "")}${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` +${missing.length - 5}` : ""}.`
            : outcome,
        );
      } catch (error) {
        say(
          error.detail
            ? `${t(error.message)} ${labelled(t("Jira says"), "")}${error.detail}`
            : error.message || "Could not reach Jira.",
        );
      }
    },
  };
  const panel = createTaskPanel({
    board,
    selection: api.selection,
    canvas: api.canvas,
    canEdit: writable,
    readOnly: api.readOnly,
    mutate: api.mutate,
    toast: api.toast,
    announce: api.toast,
    prepare: api.prepare,
    people,
    concealed,
    jira,
    layout: api.layout,
  });
  const peopleCache = new WeakMap();
  // Shared boards assign board members; organization administrators can also
  // choose anyone in the organization, marked as not on the board because
  // only members are notified and can open it. Personal boards use free text.
  // The list is kept for the session; `refresh` fetches it again, unless a
  // fetch is already under way, so people who joined or left are current.
  function people(refresh = false) {
    const session = api.session();
    if (!session) return Promise.resolve(null);
    const cached = peopleCache.get(session);
    if (cached && (!refresh || cached.pending)) return cached.list;
    const entry = { pending: true };
    entry.list = (async () => {
      const list = new Map();
      const { members } = await session.request("members");
      for (const m of members || [])
        if (m.role !== "removed" && !m.inactive && m.uuid)
          list.set(m.uuid, { name: m.username || m.uuid, member: true });
      const org = api.org;
      if (org?.isAdmin && org.server === session.server)
        try {
          const { users } = await org.request("org.users.list");
          for (const u of users || [])
            if (u.uuid && u.status === "active" && !list.has(u.uuid))
              list.set(u.uuid, {
                name: u.username || u.email || u.uuid,
                member: false,
              });
        } catch {
          /* Board members remain available. */
        }
      return [...list]
        .map(([id, person]) => ({ id, ...person }))
        .sort((a, b) => a.name.localeCompare(b.name));
    })().then(
      (list) => {
        entry.pending = false;
        return list;
      },
      (error) => {
        // A failed refresh keeps the list from before.
        if (peopleCache.get(session) === entry)
          if (cached) peopleCache.set(session, cached);
          else peopleCache.delete(session);
        throw error;
      },
    );
    peopleCache.set(session, entry);
    return entry.list;
  }
  function focusObject(id) {
    const i = board()?.items.find((x) => x.id === id);
    if (!i) return api.toast("This task is no longer on the board.");
    api.select(new Set([id]));
    api.focusRegion(bounds([i]));
    api.canvas()?.focus({ preventScroll: true });
  }
  function addTaskCard() {
    if (!board() || api.readOnly())
      return api.toast("This board is read-only.");
    api.addObject("note", undefined, {
      task: newTask(),
      h: 190,
      text: "",
    });
  }
  function makeTask() {
    const items = board()?.items.filter(
      (i) => api.selection().has(i.id) && taskable(i) && !hasTask(i),
    );
    if (!items?.length) return panel.open();
    if (!writable(new Set(items.map((i) => i.id)))) return api.toast(refusal());
    api.mutate(() => items.forEach((i) => (i.task = newTask())));
    panel.open();
  }
  function setStatusSync(enabled) {
    const refused = unchangeable();
    if (refused) return api.toast(refused);
    if (statusSyncEnabled(board()) === enabled) return;
    // Tasks hidden from this person or locked keep their status. A frame
    // that is locked, or holds a locked card, is still a column for the
    // others, as it is when cards are moved into it.
    const byId = new Map(board().items.map((i) => [i.id, i]));
    const kept = new Set([
      ...concealed(),
      ...[...protectedIds(board().items)].filter(
        (id) => byId.get(id)?.type !== "frame",
      ),
    ]);
    let aligned = [];
    api.mutate(() => {
      if (enabled) {
        board().planning = { statusSync: true };
        aligned = alignColumnStatuses(board(), kept);
      } else delete board().planning;
    });
    api.toast(
      enabled
        ? aligned.length
          ? `${t("Kanban status sync is on for this board.")} ${labelled(t("Statuses updated"), "")}${aligned.length}`
          : "Kanban status sync is on for this board."
        : "Kanban status sync is off.",
    );
  }
  // A placed timeline is board content everyone sees, so tasks hidden from
  // participants stay out of it, whoever places it.
  function participantRows(target, rows) {
    const c = concealment(target, "", false);
    const shown = rows.filter((r) => !c.hidden.has(r.id) && !c.notes.has(r.id));
    if (rows.length && !shown.length)
      throw Error(
        "These tasks are hidden from participants, so they are not placed on the board.",
      );
    return shown;
  }
  // A refusal goes to `report` while the Tasks dialog that asked stays open.
  function placeTimeline(rows, groupBy, report) {
    const say = (message) => report?.(message) || api.toast(message);
    const target = board(),
      refused = unchangeable();
    if (refused) {
      say(refused);
      return false;
    }
    try {
      const shown = participantRows(target, rows);
      const all = target.items;
      const box = bounds(all);
      const plan = timelineItems(target, shown, {
        groupBy,
        today: localDate(api.now()),
        origin: all.length
          ? { x: Math.round(box.x), y: Math.round(box.y + box.h + 120) }
          : { x: 0, y: 0 },
      });
      if (all.length + plan.items.length > MAX_OBJECTS)
        throw Error("A board can contain at most 5,000 objects.");
      // The board must stay valid to load and save.
      validateBoard({ ...target, items: [...target.items, ...plan.items] });
      api.mutate(() => {
        target.items.push(...plan.items);
      });
      api.select(new Set([plan.frame.id]));
      api.focusRegion(bounds([plan.frame]));
      // It is a copy of the plan as it is now, so the toast says how to
      // bring it up to date.
      api.toast(
        [
          "Timeline placed on the board. Bars link to their tasks.",
          shown.length < rows.length
            ? "Tasks hidden from participants are left out."
            : "",
          "It does not update by itself; select it and choose Refresh timeline when tasks change.",
        ]
          .filter(Boolean)
          .map((m) => t(m))
          .join(" "),
      );
      return true;
    } catch (error) {
      say(error.message);
      return false;
    }
  }
  // The placed timeline that is selected, or that the selected objects are
  // in, or null. The board's objects are only read for it when the
  // selection, the board, or its number of objects changed.
  let timelineCache = null;
  function selectedTimeline(b = board(), selection = api.selection()) {
    if (!b || !selection.size) return null;
    let frameId = null;
    for (const i of b.items)
      if (selection.has(i.id)) {
        const id = i.type === "frame" ? i.id : i.parentId;
        if (!id || (frameId && id !== frameId)) return null;
        frameId = id;
      }
    if (!frameId) return null;
    const key = [b.items, b.items.length, frameId];
    if (!timelineCache?.key.every((value, n) => value === key[n]))
      timelineCache = { key, found: placedTimeline(b.items, frameId) };
    return timelineCache.found;
  }
  // Draws the selected placed timeline again from the tasks now on the
  // board, in place and as one undo step.
  function refreshTimeline() {
    const target = board(),
      refused = unchangeable();
    if (refused) return api.toast(refused);
    timelineCache = null;
    const found = selectedTimeline();
    if (!found)
      return api.toast("Select a timeline placed from the Tasks view.");
    try {
      const rows = collectTasks(view(), { today: localDate(api.now()) });
      const shown = participantRows(target, rows);
      const items = refreshedTimeline(target, found, shown, {
        today: localDate(api.now()),
      });
      // What is replaced or removed, with connectors to bars that went.
      const kept = new Set(items.map((i) => i.id)),
        changed = new Set(found.generated.map((i) => i.id));
      for (const i of target.items) if (!kept.has(i.id)) changed.add(i.id);
      if (found.frame.locked || !writable(changed)) return api.toast(refusal());
      if (items.length > MAX_OBJECTS)
        throw Error("A board can contain at most 5,000 objects.");
      validateBoard({ ...target, items });
      api.mutate(() => {
        target.items = items;
      });
      api.select(new Set([found.frame.id]));
      api.toast(
        shown.length < rows.length
          ? `${t("Timeline refreshed from the board’s tasks.")} ${t("Tasks hidden from participants are left out.")}`
          : "Timeline refreshed from the board’s tasks.",
      );
    } catch (error) {
      api.toast(error.message);
    }
  }
  function openDialog(tab) {
    if (!board()) return;
    panel.close();
    api.prepare();
    dialog = openTasksDialog(
      {
        board,
        view,
        modal: api.modal,
        now: api.now,
        canAdd: () => !!board() && !api.readOnly(),
        // The plan's settings and a placed timeline wait for a lock too.
        canPlan: () => !unchangeable(),
        focusObject,
        placeTimeline,
        setStatusSync,
        selectedTasks,
        jira,
        download: (blob, ext) => {
          // A title of only symbols leaves no stem to name the file by.
          const stem = (board().title || "")
            .normalize("NFC")
            .replace(/[^\p{L}\p{M}\p{N} _-]/gu, "")
            .trim();
          return api.download(
            blob,
            `${stem ? `${stem} ${t("tasks")}` : t("Tasks")}.${ext}`,
            blob.type,
          );
        },
      },
      { tab },
    );
  }
  function setDependency(value) {
    const line = board()?.items.find(
      (i) => api.selection().has(i.id) && i.type === "arrow",
    );
    if (!line || !writable(new Set([line.id]))) return;
    if ((line.dependency || "") === value) return;
    if (dependencyCycle(board().items, line, value)) {
      const select = document.querySelector("#line-dependency");
      if (select) select.value = line.dependency || "";
      return api.toast(
        "This dependency would make these tasks wait for each other in a loop, so none of them could start.",
      );
    }
    api.mutate(() => {
      if (value) line.dependency = value;
      else delete line.dependency;
    });
  }
  // Buttons are injected next to existing controls so the editor markup
  // stays unchanged: Tasks in the canvas navigation, Task details on the
  // selection toolbar, and the dependency choice for connection lines.
  function render() {
    panel.render();
    if (dialog?.dialog?.isConnected) dialog.refresh();
    const b = board();
    if (!b) return;
    const nav = document.querySelector(".canvas-navigation");
    if (nav && !nav.querySelector("#task-access")) {
      // Tasks follows the buttons that come and go with the selection: the
      // bar is anchored on the right, so those appearing at its left end
      // never move the buttons a pointer is already on.
      const anchor = nav.querySelector("#text-link-access");
      const html = iconButton(
        ListChecks,
        t("Tasks"),
        "task-access",
        'aria-haspopup="dialog"',
      );
      if (anchor) anchor.insertAdjacentHTML("afterend", html);
      else nav.insertAdjacentHTML("afterbegin", html);
      nav.querySelector("#task-access").onclick = () => openDialog("list");
    }
    const tools = document.querySelector("#selection-tools");
    // The object's actions, which end with More options.
    const row =
      tools?.querySelector(".object-tools") ??
      tools?.querySelector(".selection-row");
    const hidden = concealed();
    const chosen = b.items.filter(
      (i) => api.selection().has(i.id) && !hidden.has(i.id),
    );
    if (row && chosen.some(taskable) && !row.querySelector("#task-details")) {
      const more = row.querySelector("#selection-more");
      const html = iconButton(SquareCheck, t("Task details"), "task-details");
      // Before the More options button, which stays last in the row.
      if (more) more.insertAdjacentHTML("beforebegin", html);
      else row.insertAdjacentHTML("beforeend", html);
      row.querySelector("#task-details").onclick = () => panel.open();
    }
    const lines = tools?.querySelector(".line-format-tools");
    const line =
      chosen.length === 1 && chosen[0].type === "arrow" ? chosen[0] : null;
    const eligible = line && canBeDependency(line, b.items);
    const existing = lines?.querySelector("#line-dependency")?.closest("label");
    if (lines && eligible) {
      if (!existing) {
        lines.insertAdjacentHTML(
          "beforeend",
          `<label class="line-control"><span>${t("Dependency")}</span><select id="line-dependency"><option value="">${t("None", "dependency")}</option><option value="blocks">${t("Start blocks end")}</option><option value="depends-on">${t("Start depends on end")}</option></select></label>`,
        );
        lines.querySelector("#line-dependency").onchange = (e) =>
          setDependency(
            DEPENDENCIES.includes(e.target.value) ? e.target.value : "",
          );
      }
      const select = lines.querySelector("#line-dependency");
      if (document.activeElement !== select)
        select.value = line.dependency || "";
      select.disabled = !writable(new Set([line.id]));
    } else existing?.remove();
  }
  const actions = {
    tasks: () => openDialog("list"),
    "task-timeline": () => openDialog("timeline"),
    "task-details": () => panel.open(),
    "task-card": addTaskCard,
    "task-make": makeTask,
    "task-jira-send": () => jira.send(selectedTasks()),
    "task-jira-refresh": () => jira.refresh(),
    "task-status-sync": () => setStatusSync(!statusSyncEnabled(board())),
    "timeline-refresh": refreshTimeline,
  };
  addMoreTools([
    ["tasks", "Tasks", actions.tasks],
    ["task-timeline", "Task timeline", actions["task-timeline"]],
    ["task-card", "Task card", actions["task-card"]],
  ]);
  addShapeChoices([
    {
      key: "task-card",
      get name() {
        return t("Task card");
      },
      get hint() {
        return t("Sticky note with status, owner, and dates");
      },
      // Found by these words in either language.
      keywords: [
        "task card sticky note status owner dates planning",
        "carte de tâche note adhésive statut responsable dates planification",
      ],
      icon: svg(SquareCheck, { class: "shape-icon" }),
      run: addTaskCard,
    },
  ]);
  addCommands(({ board: b, selection, add, edit, create, writable: can }) => {
    const chosen = b.items.filter((i) => selection.has(i.id));
    add(
      "tasks",
      "Tasks",
      "Board",
      "planning tasks list status tâches planification kanban",
    );
    add(
      "task-timeline",
      "Task timeline",
      "Board",
      "gantt timeline roadmap schedule chronologie calendrier feuille de route",
    );
    add(
      "task-card",
      "Task card",
      "Create",
      "task card todo carte tâche",
      "",
      create,
    );
    add(
      "task-details",
      "Task details",
      "Edit",
      "assign owner due date status priority assigner responsable échéance statut",
      "",
      chosen.some(taskable)
        ? ""
        : "Select sticky notes, shapes, or text to plan tasks.",
    );
    add(
      "task-make",
      "Make task",
      "Edit",
      "convert to task convertir en tâche",
      "",
      can ||
        (chosen.some((i) => taskable(i) && !hasTask(i))
          ? ""
          : "Select sticky notes, shapes, or text to plan tasks."),
    );
    add(
      "timeline-refresh",
      "Refresh timeline",
      "Edit",
      "update gantt timeline tasks mettre à jour actualiser chronologie tâches",
      "",
      edit ||
        (selectedTimeline(b, selection)
          ? ""
          : "Select a timeline placed from the Tasks view."),
    );
    add(
      "task-status-sync",
      statusSyncEnabled(b)
        ? "Turn off Kanban status sync"
        : "Turn on Kanban status sync",
      "Board",
      "kanban columns status frames synchronisation colonnes",
      "",
      edit,
    );
    const jiraState = jiraStatus(api.org, api.session());
    add(
      "task-jira-send",
      "Send selected tasks to Jira",
      "Board",
      "jira issue export tracking billet",
      "",
      !jiraState.available
        ? jiraState.message
        : can || (chosen.some(hasTask) ? "" : "Select tasks first."),
    );
    add(
      "task-jira-refresh",
      "Refresh Jira status",
      "Board",
      "jira sync status update actualiser",
      "",
      jiraState.available ? "" : jiraState.message,
    );
  });
  return {
    actions,
    render,
    close: () => panel.close(),
    // Kanban sync: snapshot memberships before an edit, apply after it.
    parents: (items = board()?.items) =>
      statusSyncEnabled(board()) ? taskParents(items) : null,
    syncStatus(before) {
      if (!before || !board()) return;
      const changes = applyStatusSync(board(), before);
      if (changes.length === 1)
        api.toast(
          `${labelled(t("Status updated"), "")}${t(STATUS_LABELS[changes[0].status], "task")}`,
        );
      else if (changes.length)
        api.toast(`${labelled(t("Statuses updated"), "")}${changes.length}`);
    },
    tasks: () => collectTasks(view(), { today: localDate(api.now()) }),
    // Whether the selection is, or is inside, a timeline placed from the
    // Tasks view, which Refresh timeline draws again.
    timelineSelected: () => !!selectedTimeline(),
    // Whether a dependency line among these objects closes a loop of tasks.
    dependencyLoop(items, id) {
      const line = items.find((i) => i.id === id);
      return !!line && dependencyCycle(items, line, line.dependency);
    },
  };
}
