import { escape } from "./model.js";
import { t, plural, labelled, language, untitledFrame } from "./i18n.js";
import { authoredTextHTML } from "./accessibility/object-content.js";
import { opener, returnFocus } from "./accessibility/focus-return.js";
import { orderedFrames, framesItems, frameParents } from "./scene.js";
import { searchIndex, searchWords, matchesWord } from "./libraries.js";

const frameTitleHTML = (frame, n) =>
  frame.text ? authoredTextHTML(frame) : escape(untitledFrame(n));
// The frame a row's button acts on, and which of its buttons it is.
const KINDS = ["frame", "link", "order"];
const kind = (b) => KINDS.find((k) => b.dataset[k]);
const rowOf = (b) => b.dataset[kind(b)];
// The area two boxes share.
function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// Frames and navigation: the board's frames in presentation order, as a
// table of contents in a side panel that stays open while going from frame
// to frame, as Miro's frames panel does. It marks the frame in view.
export function createFramesPanel(api) {
  let panel = null,
    origin = null,
    // The list is one Tab stop: the frame the keyboard was last on.
    active = null,
    // The frame last gone to, marked while it is still in view.
    reached = null,
    frame = 0,
    // What the list was last drawn from, and what it showed.
    signature = null,
    written = "",
    writtenRows = null,
    listed = [];
  const shownItems = () => (api.visualBoard?.() || api.board()).items;
  const list = () => panel.querySelector(".frame-list");
  const search = () => panel.querySelector("#frame-search");
  // The part of the board the panel leaves in view: beside it, or below it
  // on a phone, where frames gone to are framed.
  function uncovered() {
    const view = api.view(),
      canvas = api.canvas().getBoundingClientRect(),
      r = panel.getBoundingClientRect(),
      z = canvas.width / view.w;
    if (!r.width || !canvas.width || !z) return view;
    const part =
      canvas.width > 760
        ? { ...view, w: (r.left - canvas.left) / z }
        : {
            ...view,
            y: view.y + (r.bottom - canvas.top) / z,
            h: view.h - (r.bottom - canvas.top) / z,
          };
    return part.w > 0 && part.h > 0 ? part : view;
  }
  // The frame most of the view shows: the one last gone to while most of it
  // is in view, or else the one covering most of the view. Zoomed out over
  // many frames, none is.
  function inView() {
    const view = uncovered(),
      area = view.w * view.h;
    let best = null,
      most = 0;
    for (const f of orderedFrames(shownItems())) {
      const shared = overlap(f, view);
      if (shared < 0.1 * area || shared < 0.5 * Math.min(f.w * f.h, area))
        continue;
      if (f.id === reached) return f.id;
      if (shared > most) {
        best = f.id;
        most = shared;
      }
    }
    return best;
  }
  // Marks the frame in view, in place: the view changes on every pan.
  function mark() {
    const id = inView();
    for (const b of list().querySelectorAll("[data-frame]"))
      if (b.dataset.frame === id) b.setAttribute("aria-current", "location");
      else b.removeAttribute("aria-current");
    return id;
  }
  // The list is drawn again when the board's content, what this person may
  // see or do, or the language changed: an edit, undo, or a collaborator's
  // change, not a pan or zoom.
  const contentKey = () => [
    shownItems(),
    api.version?.(),
    language,
    api.canAddFrames?.(),
    api.canArrange?.(),
  ];
  function draw() {
    signature = contentKey();
    // What this person may see: staged and hidden frames stay covered.
    const shown = shownItems();
    const every = orderedFrames(shown),
      place = new Map(every.map((f, n) => [f, n])),
      field = search(),
      query = searchWords(field.value);
    // A long list of frames can be searched by title.
    field.closest("label").hidden = every.length <= 7 && !field.value;
    const all = query.length
      ? every.filter((f) => {
          const title = searchIndex(f.text || untitledFrame(place.get(f)));
          return query.every((word) => matchesWord(title, word));
        })
      : every;
    // Every frame's contents in one pass over the board, with the frames
    // lying within it, as it moves and presents with them.
    const contents = framesItems(
      shown,
      all.map((f) => f.id),
      { nested: true },
    );
    // A frame removed meanwhile hands the Tab stop to the one now in its
    // place.
    if (!all.some((f) => f.id === active)) {
      const at = Math.max(0, listed.indexOf(active));
      active = all[Math.min(at, all.length - 1)]?.id ?? null;
    }
    listed = all.map((f) => f.id);
    // A frame lying within another is indented under it, by how deep it
    // lies, and says which frame holds it.
    const parents = frameParents(shown),
      byId = new Map(every.map((f) => [f.id, f]));
    const level = (f) => {
      let n = 1;
      for (let id = parents.get(f.id); id; id = parents.get(id)) n++;
      return n;
    };
    // Reordering renumbers every frame, so it waits while some are hidden
    // from this person.
    const concealed = api.concealedIn?.(api.board()) || new Set();
    const fixed = orderedFrames(api.board().items).some((f) =>
      concealed.has(f.id),
    );
    // Only people who may change the board are offered the order arrows,
    // and not on a locked frame; one next to a locked frame cannot trade
    // places with it.
    const arranging = !!api.canArrange?.();
    panel.querySelector("#frame-list-hint").textContent = t(
      arranging
        ? "Arrow keys move between frames. Alt and the up or down arrow move a frame earlier or later."
        : "Arrow keys move between frames.",
    );
    const arrows = (f, n, stop) => {
      if (!arranging || f.locked) return "";
      const blocked = (to) => fixed || !every[to] || every[to].locked;
      return `<button class="secondary" data-order="${escape(f.id)}" data-delta="-1" tabindex="${stop}" aria-label="${t("Move frame earlier")}" ${blocked(n - 1) ? "disabled" : ""}>↑</button><button class="secondary" data-order="${escape(f.id)}" data-delta="1" tabindex="${stop}" aria-label="${t("Move frame later")}" ${blocked(n + 1) ? "disabled" : ""}>↓</button>`;
    };
    const rows = all.map((f) => {
      const n = place.get(f),
        stop = f.id === active ? "0" : "-1",
        depth = level(f),
        holder = byId.get(parents.get(f.id));
      return `<div class="frame-row" role="listitem" aria-level="${depth}" data-level="${Math.min(depth, 4)}"><button class="frame-go" data-frame="${escape(f.id)}" tabindex="${stop}"><span class="sr-only">${labelled(t("Go to frame"), "")}</span><span>${n + 1}</span> <strong data-user-content title="${escape(f.text || untitledFrame(n))}">${frameTitleHTML(f, n)}</strong>${holder ? `<span class="sr-only">, ${labelled(t("In frame"), frameTitleHTML(holder, place.get(holder)))}</span>` : ""} <small>${plural(contents.get(f.id).size - 1, "{count} object", "{count} objects")}</small></button><button class="icon-btn frame-link" data-link="${escape(f.id)}" tabindex="${stop}" aria-label="${t("Copy link to frame")}" title="${t("Copy link to frame")}"><i data-lucide="link" aria-hidden="true"></i></button>${arrows(f, n, stop)}</div>`;
    });
    write(
      all.length
        ? `<div role="list">${rows.join("")}</div>` +
            (fixed && arranging
              ? `<p class="dialog-copy">${t("Frames can be reordered once the facilitator shows every frame.")}</p>`
              : "")
        : every.length
          ? `<p class="dialog-copy">${t("No frames match your search.")}</p>`
          : `<p class="dialog-copy">${t("Add a frame to organize content and create presentation slides.")}</p>`,
      all.length ? rows : null,
    );
    footer();
    mark();
  }
  // Writes the list when it changed, keeping its scroll position and the
  // keyboard on the same control of the same frame, or on the row now in
  // the place of one removed. An edit on the board mostly changes one
  // frame's count of objects, so when the rows are the same frames as
  // before, only those that changed are written again.
  function write(html, frameRows = null) {
    if (html === written) return;
    const before = written,
      beforeRows = writtenRows;
    written = html;
    writtenRows = frameRows;
    const rows = list(),
      focused = rows.contains(document.activeElement)
        ? document.activeElement
        : null,
      control = focused && kind(focused),
      id = focused && rowOf(focused),
      delta = focused?.dataset.delta,
      top = rows.scrollTop;
    if (!rewriteRows(rows, before, html, beforeRows, frameRows))
      rows.innerHTML = html;
    rows.scrollTop = top;
    api.refreshIcons?.();
    // A control in a row left as it was keeps the keyboard.
    if (!focused || focused.isConnected) return;
    const buttons = [...rows.querySelectorAll("button")];
    const same = buttons.find(
      (b) => b.dataset[control] === id && b.dataset.delta === delta,
    );
    const next =
      same && !same.disabled
        ? same
        : buttons.find((b) => b.dataset.frame && b.dataset.frame === active);
    (
      next ||
      search().closest("label:not([hidden])")?.querySelector("input") ||
      panel.querySelector("#frames-close")
    ).focus({ preventScroll: true });
  }
  // Writes again the rows that changed, when the list shows as many frames
  // as before and nothing else in it changed. Says whether it did, which it
  // does not when so many changed that writing the whole list is quicker.
  function rewriteRows(rows, before, html, beforeRows, frameRows) {
    if (!beforeRows || !frameRows || beforeRows.length !== frameRows.length)
      return false;
    // What follows the rows, a note under the list, is the same.
    const end = (list) =>
      '<div role="list">'.length +
      list.reduce((sum, row) => sum + row.length, 0) +
      "</div>".length;
    if (before.slice(end(beforeRows)) !== html.slice(end(frameRows)))
      return false;
    const shown = rows.firstElementChild?.children;
    if (shown?.length !== frameRows.length) return false;
    const changed = [];
    for (let n = 0; n < frameRows.length; n++)
      if (frameRows[n] !== beforeRows[n]) changed.push(n);
    if (changed.length > 50) return false;
    const template = document.createElement("template");
    for (const n of changed) {
      template.innerHTML = frameRows[n];
      shown[n].replaceWith(template.content);
    }
    // The keyboard moves the Tab stop in place, without writing the list,
    // so the rows left as they were follow the stop as written now.
    for (const b of rows.querySelectorAll('button[tabindex="0"]'))
      if (rowOf(b) !== active) b.tabIndex = -1;
    const stop = shown[listed.indexOf(active)];
    if (stop)
      for (const b of stop.querySelectorAll("button"))
        if (b.tabIndex !== 0) b.tabIndex = 0;
    return true;
  }
  // Add frame is offered while this person may add frames, which a
  // facilitator's lock can change while the panel is open.
  function footer() {
    const add = panel.querySelector("#add-frame"),
      allowed = !!api.canAddFrames?.();
    if (allowed && !add) {
      const button = document.createElement("button");
      button.className = "secondary";
      button.id = "add-frame";
      button.innerHTML = `<i data-lucide="plus" aria-hidden="true"></i><span>${t("Add frame")}</span>`;
      button.onclick = addFrame;
      panel.querySelector(".frames-footer").prepend(button);
      api.refreshIcons?.();
    } else if (!allowed && add) {
      if (add === document.activeElement)
        panel.querySelector("#present-frames").focus();
      add.remove();
    }
  }
  // A new slide after the last, ready to fill in on the board, and gone to
  // like any other.
  function addFrame() {
    const made = api.addFrame();
    if (!made || !panel) return;
    draw();
    go(made.id);
  }
  // Goes to a frame, leaving the panel open and the keyboard on its row.
  function go(id) {
    const f = api.board().items.find((i) => i.id === id && i.type === "frame");
    // Collaborators can remove frames while this list is open.
    if (!f) return draw();
    reached = active = id;
    api.go(f, panel.getBoundingClientRect());
    mark();
    // The keyboard stays in the list, so where it went is said aloud.
    const every = orderedFrames(shownItems()),
      shown = every.find((i) => i.id === id) || f,
      n = every.indexOf(shown);
    api.announce?.(
      labelled(
        t("Showing frame {number} of {count}")
          .replace("{number}", n + 1)
          .replace("{count}", every.length),
        shown.text || untitledFrame(n),
      ),
    );
  }
  // Copies a link to the frame, as Copy link to object does.
  function copy(id) {
    const f = api.board().items.find((i) => i.id === id && i.type === "frame");
    if (!f) return draw();
    api.copyLink(f);
  }
  // Moves a frame one place earlier or later in the presentation order, and
  // says whether it did.
  function move(id, delta) {
    const latest = orderedFrames(api.board().items),
      concealed = api.concealedIn?.(api.board()) || new Set();
    // As the arrows say, frames hidden from this person keep the order as
    // it is.
    if (latest.some((f) => concealed.has(f.id))) return false;
    const from = latest.findIndex((f) => f.id === id),
      to = from + delta;
    if (from < 0 || to < 0 || to >= latest.length) {
      draw();
      return false;
    }
    // Moving a frame in the order changes nothing inside it, so a locked
    // note in some frame is no reason to refuse.
    if (!api.canEdit(new Set())) return false;
    if (latest[from].locked || latest[to].locked) {
      api.toast("Unlock protected objects before changing this selection.");
      return false;
    }
    api.mutate(() => {
      const ordered = orderedFrames(api.board().items),
        index = ordered.findIndex((f) => f.id === id),
        next = index + delta;
      [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
      ordered.forEach((f, i) => (f.order = i));
    });
    active = id;
    draw();
    return true;
  }
  function focusActive() {
    const row = list().querySelector('[data-frame][tabindex="0"]');
    if (row) {
      row.scrollIntoView?.({ block: "nearest" });
      row.focus({ preventScroll: true });
    } else panel.querySelector("#frames-close").focus();
  }
  function close(restoreFocus = true) {
    if (!panel) return;
    cancelAnimationFrame(frame);
    frame = 0;
    panel.remove();
    panel = null;
    active = reached = signature = null;
    written = "";
    writtenRows = null;
    listed = [];
    document
      .querySelector('[data-action="frames"]')
      ?.setAttribute("aria-expanded", "false");
    api.layout?.();
    // Focus goes back to what opened the panel, or else the canvas.
    if (restoreFocus) returnFocus(origin, api.canvas());
    origin = null;
  }
  function open() {
    if (panel) return focusActive();
    if (!api.board()) return;
    origin = opener('[data-action="frames"]');
    api.prepare();
    panel = document.createElement("section");
    panel.id = "frames-panel";
    panel.className = "frames-panel panel";
    panel.setAttribute("aria-label", t("Frames and navigation"));
    panel.innerHTML = `<div class="search-heading"><strong>${t("Frames and navigation")}</strong><button type="button" class="text-btn" id="frames-close">${t("Close")}</button></div><label class="search frame-search"><input id="frame-search" type="search" maxlength="200" aria-label="${t("Search frames")}" placeholder="${t("Search frames")}" aria-controls="frame-list" autocomplete="off"></label><p id="frame-list-hint" class="sr-only"></p><div class="frame-list" id="frame-list" role="group" aria-label="${t("Frames")}" aria-describedby="frame-list-hint"></div><div class="frames-footer"><button class="primary" id="present-frames">${t("Present")}</button></div>`;
    api.canvas().parentElement.append(panel);
    document
      .querySelector('[data-action="frames"]')
      ?.setAttribute("aria-expanded", "true");
    // The panel has its own focus context: board shortcuts and clipboard
    // keys must not act on the canvas selection from a row.
    for (const event of ["copy", "cut", "paste"])
      panel.addEventListener(event, (e) => e.stopPropagation());
    panel.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        close();
      }
    });
    panel.querySelector("#frames-close").onclick = () => close();
    const rows = list();
    rows.addEventListener("click", (e) => {
      const target = e.target.closest("[data-frame]");
      if (target) return go(target.dataset.frame);
      const link = e.target.closest("[data-link]");
      if (link) return copy(link.dataset.link);
      const btn = e.target.closest("[data-order]");
      if (!btn || !move(btn.dataset.order, Number(btn.dataset.delta))) return;
      // The list is drawn again; the keyboard stays with the moved frame,
      // on the same arrow or the other one at the ends.
      const same = rows.querySelector(
        `[data-order="${btn.dataset.order}"][data-delta="${btn.dataset.delta}"]`,
      );
      (same?.disabled
        ? rows.querySelector(
            `[data-order="${btn.dataset.order}"]:not(:disabled)`,
          )
        : same
      )?.focus();
    });
    rows.addEventListener("focusin", (e) => {
      const id = e.target.closest?.(".frame-row")?.querySelector("[data-frame]")
        ?.dataset.frame;
      if (!id || id === active) return;
      active = id;
      for (const b of rows.querySelectorAll("button"))
        b.tabIndex = rowOf(b) === id ? 0 : -1;
    });
    rows.addEventListener("keydown", (e) => {
      const row = e.target.closest?.("[data-frame]");
      if (!row || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const buttons = [...rows.querySelectorAll("[data-frame]")],
        at = buttons.indexOf(row);
      if (e.altKey) {
        const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
        if (!delta) return;
        e.preventDefault();
        // The keyboard stays on the frame, moved or not, as at either end
        // of the list, where the list may have been drawn again.
        const id = row.dataset.frame;
        move(id, delta);
        [...rows.querySelectorAll("[data-frame]")]
          .find((b) => b.dataset.frame === id)
          ?.focus();
        return;
      }
      const next =
        e.key === "ArrowDown"
          ? at + 1
          : e.key === "ArrowUp"
            ? at - 1
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : null;
      if (next === null) return;
      e.preventDefault();
      buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
    });
    const field = search();
    field.oninput = draw;
    // Down from the search goes into the list.
    field.onkeydown = (e) => {
      if (e.key !== "ArrowDown") return;
      const row = rows.querySelector('[data-frame][tabindex="0"]');
      if (!row) return;
      e.preventDefault();
      row.focus();
    };
    panel.querySelector("#present-frames").onclick = () => api.present();
    // Opened again, the list starts at the frame in view.
    active = inView();
    draw();
    api.refreshIcons?.();
    api.layout?.();
    focusActive();
  }
  return {
    open,
    close,
    toggle: () => (panel ? close() : open()),
    isOpen: () => !!panel,
    // Called on each draw of the board, the list follows the board and the
    // marker the view, at most once a frame.
    render() {
      if (!panel || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!panel) return;
        const key = contentKey();
        if (key.some((value, n) => value !== signature[n])) draw();
        else mark();
      });
    },
  };
}
