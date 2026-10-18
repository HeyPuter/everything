import { attachMentions } from "./mentions.js";
import { say } from "./accessibility/live-region.js";
import { escape } from "./model.js";
import { labelled, language, plural, t, translateUI } from "./i18n.js";
import { fold, searchTerms } from "./search-fold.js";
import {
  COMMENT_LIMITS,
  commentPoint,
  commentAttachment,
  commentActivity,
  commentExcerpt,
  commentMessage,
  commentThread,
  validateComments,
  validateCommentLanguage,
  mentions,
} from "./comments.js";
import { canonicalLanguage } from "./accessibility/language-tag.js";
import {
  authoredTextHTML,
  objectNameHTML,
} from "./accessibility/object-content.js";
import { keepReadingOrder } from "./accessibility/reading-order.js";
import { formatTextRuns, replaceTextRuns, sliceTextRuns } from "./rich-text.js";
import { keepPageFocus, keepPaginationFocus } from "./paging.js";

export function createCommentsUI(api) {
  // Times come from the board's shared clock when there is one: the worker
  // refuses comments dated far from its own time, as a fast device's would be.
  const now = () => api.now?.() ?? Date.now();
  let layer,
    panel,
    boardId,
    active,
    draft,
    editing,
    positioning,
    signature,
    page = 0,
    drag,
    suppressClick = 0;
  let visible = true;
  const pins = new Map(),
    drafts = new Map(),
    // Drafts this tab wrote or removed since it last stored them.
    touched = new Set();
  let indexedItems,
    indexedLength = -1,
    itemIndex = new Map();
  // Which object a discussion is on, for a screen reader that cannot see the
  // pin sitting on it. An object hidden or face down is not named.
  function attachedTo(c, byId = itemsById()) {
    const s = state();
    if (
      !c?.anchorId ||
      s.hidden?.has(c.anchorId) ||
      s.concealed?.has(c.anchorId)
    )
      return "";
    const anchor = byId.get(c.anchorId);
    return anchor
      ? escape(labelled(t("Attached to"), "")) + objectNameHTML(anchor, 80)
      : "";
  }
  function itemsById() {
    const items = state().board.items;
    if (items !== indexedItems || items.length !== indexedLength) {
      indexedItems = items;
      indexedLength = items.length;
      itemIndex = new Map(items.map((i) => [i.id, i]));
    }
    return itemIndex;
  }
  try {
    visible = localStorage.getItem("whiteboard-comments-visible") !== "false";
    const saved = JSON.parse(
      localStorage.getItem("whiteboard-comment-drafts") || "[]",
    );
    if (Array.isArray(saved))
      for (const [key, value] of saved.slice(-20))
        if (
          typeof key === "string" &&
          value &&
          typeof value.text === "string" &&
          value.text.length <= COMMENT_LIMITS.text
        ) {
          try {
            validateCommentLanguage(value);
          } catch {
            delete value.lang;
            delete value.textRuns;
          }
          drafts.set(key, value);
        }
  } catch {}
  const state = () => api.state(),
    threads = () => state().board?.comments || [];
  const thread = () => threads().find((c) => c.id === active);
  // What this person has read, per board and on this device: a discussion
  // with a message from someone else newer than that is marked, as in
  // Miro. Comments already on a board the first time it is opened here
  // count as read.
  const SEEN_KEY = "whiteboard-comments-seen";
  let seen = null,
    seenBoard = null,
    // A discussion opened from the Unread list stays in it, though now read,
    // until the filter or search changes.
    keptUnread = null;
  const announced = new Set();
  // Whether each message named this person when last seen, so an edit that
  // adds their name is said too, and one that keeps it is not said again.
  const named = new Map();
  let announceSince = 0,
    // Changes to what is read, and the discussions last counted.
    seenVersion = 0,
    counted = null;
  function readSeen() {
    try {
      const all = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
      return all && typeof all === "object" && !Array.isArray(all) ? all : {};
    } catch {
      return {};
    }
  }
  function saveSeen() {
    const all = readSeen();
    all[seenBoard] = seen;
    // The fifty boards opened or read most recently are remembered.
    const kept = Object.entries(all)
      .filter(([, v]) => v && Number.isFinite(v.at))
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, 50);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch {}
  }
  function seenFor() {
    const id = state().board?.id;
    if (seenBoard !== id || !seen) {
      seenBoard = id;
      const saved = readSeen()[id];
      seen =
        saved &&
        Number.isFinite(saved.since) &&
        saved.threads &&
        typeof saved.threads === "object"
          ? saved
          : { since: now(), at: Date.now(), threads: {} };
      // Opening a board counts as using it, so a board visited often is not
      // forgotten behind others merely read since, which would mark all its
      // comments read, those that arrived while away included.
      seen.at = Date.now();
      saveSeen();
      announced.clear();
      named.clear();
      announceSince = now();
    }
    return seen;
  }
  const fromOthers = (c) =>
    c.messages.filter((m) => !m.deleted && m.authorId !== state().author?.id);
  function unread(c) {
    if (c.id === "draft" || c.resolved) return false;
    const s = seenFor(),
      mark = Math.max(s.since, s.threads[c.id] || 0);
    return fromOthers(c).some((m) => m.createdAt > mark);
  }
  function markSeen(c) {
    if (!c?.messages?.length) return;
    const s = seenFor(),
      latest = Math.max(...c.messages.map((m) => m.editedAt || m.createdAt));
    if ((s.threads[c.id] || 0) >= latest) return;
    s.threads[c.id] = latest;
    s.at = Date.now();
    seenVersion++;
    saveSeen();
  }
  // The Comments button says how many discussions have something new.
  function renderBadge() {
    const button = document.querySelector(
      '.canvas-navigation [data-action="comments"]',
    );
    if (!button) return;
    const list = threads();
    if (
      counted?.list === list &&
      counted.version === seenVersion &&
      counted.board === state().board?.id &&
      button.contains(counted.badge)
    )
      return;
    const count = list.filter((c) => unread(c)).length;
    let badge = button.querySelector(".comment-badge");
    if (count && !badge) {
      badge = document.createElement("span");
      badge.className = "comment-badge";
      badge.setAttribute("aria-hidden", "true");
      button.append(badge);
    }
    if (badge) {
      badge.hidden = !count;
      badge.textContent = count > 99 ? "99+" : String(count);
    }
    const label = count
      ? `${t("Comments")} · ${t("{count} with new messages").replace("{count}", count)}`
      : t("Comments");
    if (button.getAttribute("aria-label") !== label)
      button.setAttribute("aria-label", label);
    counted = { list, version: seenVersion, board: state().board?.id, badge };
  }
  // What happens in the open discussion is said: replies and mentions from
  // others, gathered for a moment so a burst is said once, and this
  // person's own posts and resolutions, which change nothing else that is
  // read out.
  let heard = null,
    hearing = [],
    hearTimer = null;
  function tell(message) {
    say(panel?.querySelector("#comment-said"), message, { delay: 50 });
  }
  function hear(message) {
    hearing.push(message);
    hearTimer ??= setTimeout(() => {
      const said = [...new Set(hearing)];
      tell(
        said.length > 3
          ? t("{count} new messages in this discussion").replace(
              "{count}",
              hearing.length,
            )
          : said.join(". "),
      );
      stopHearing(false);
    }, 1000);
  }
  function stopHearing(forget = true) {
    clearTimeout(hearTimer);
    hearTimer = null;
    hearing = [];
    if (forget) heard = null;
  }
  const byName = (text, m) =>
    t(text).replace("{name}", () => m.authorName || t("Someone"));
  function hearReplies() {
    const c = panel && active ? thread() : null;
    const known = c && heard?.thread === c.id ? heard.ids : null;
    heard = c
      ? { thread: c.id, ids: new Set(c.messages.map((m) => m.id)) }
      : null;
    if (!known) return;
    // A message naming this person is said as a mention instead.
    const me = state().board?.shared && state().author?.name?.toLowerCase();
    for (const m of fromOthers(c))
      if (!known.has(m.id) && !(me && mentions(m.text).includes(me)))
        hear(byName("{name} replied", m));
  }
  // Someone else naming this person in a comment, while the board is open,
  // is said once, with a way to open the discussion, or as one more message
  // in it when that discussion is the one open.
  let mentionsChecked = null;
  function announceMentions() {
    const s = state(),
      name = s.author?.name;
    if (!s.board?.shared || !name || mentionsChecked === threads()) return;
    mentionsChecked = threads();
    seenFor();
    const me = name.toLowerCase();
    for (const c of threads())
      for (const m of fromOthers(c)) {
        const mentioned = mentions(m.text).includes(me),
          before = named.get(m.id);
        named.set(m.id, mentioned);
        if (!mentioned || announced.has(m.id)) continue;
        if (
          m.createdAt > announceSince ||
          (before === false && m.editedAt > announceSince)
        ) {
          announced.add(m.id);
          if (active === c.id && panel) {
            hear(byName("{name} mentioned you", m));
            continue;
          }
          api.toast(
            t("{name} mentioned you in a comment.").replace(
              "{name}",
              () => m.authorName || t("Someone"),
            ),
            { label: t("Open discussion"), run: () => show(c.id) },
          );
        }
      }
  }
  const key = () => `${boardId}|${active || "new"}|${editing?.id || "reply"}`;
  // Typing keeps the draft in memory at once and in storage shortly after,
  // rather than rewriting every draft on each keystroke.
  let storeTimer = null;
  function remember(soon = false) {
    if (!panel || !draft) return;
    const next = panel.querySelector("textarea").value;
    if (next !== draft.text && draft.textRuns?.length)
      draft.textRuns = replaceTextRuns(draft.text, next, draft.textRuns);
    draft.text = next;
    // The draft just written is the most recent, so the oldest untouched
    // one goes first when there are too many.
    drafts.delete(key());
    touched.add(key());
    if (draft.text) drafts.set(key(), structuredClone({ ...draft, editing }));
    while (drafts.size > 20) {
      touched.add(drafts.keys().next().value);
      drafts.delete(drafts.keys().next().value);
    }
    if (!soon) rememberStorage();
    else if (!storeTimer) storeTimer = setTimeout(rememberStorage, 500);
  }
  function clearDraft() {
    drafts.delete(key());
    touched.add(key());
    draft = null;
    rememberStorage();
  }
  function rememberStorage() {
    clearTimeout(storeTimer);
    storeTimer = null;
    try {
      // Other tabs keep their drafts in the same list: only what this tab
      // changed is written over, so theirs stay.
      let stored = new Map();
      try {
        stored = new Map(
          JSON.parse(localStorage.getItem("whiteboard-comment-drafts")),
        );
      } catch {}
      for (const key of touched) {
        stored.delete(key);
        if (drafts.has(key)) stored.set(key, drafts.get(key));
      }
      touched.clear();
      while (stored.size > 20) stored.delete(stored.keys().next().value);
      localStorage.setItem(
        "whiteboard-comment-drafts",
        JSON.stringify([...stored]),
      );
    } catch {}
  }
  globalThis.addEventListener?.("pagehide", () => {
    if (storeTimer) rememberStorage();
  });
  function close(focus = true) {
    cancelDrag();
    if (!panel) return;
    remember();
    panel.remove();
    panel = null;
    stopHearing();
    active = editing = draft = positioning = null;
    signature = null;
    document
      .querySelector('[data-action="comments"]')
      ?.setAttribute("aria-expanded", "false");
    // The keyboard returns to the control that opens the panel.
    if (focus)
      (
        document.querySelector('[data-action="comments"]') || api.canvas()
      )?.focus();
    api.draw();
  }
  function skeleton() {
    if (panel) return;
    api.prepare();
    boardId = state().board.id;
    panel = document.createElement("section");
    panel.id = "comments-panel";
    panel.className = "comments-panel panel";
    panel.setAttribute("aria-label", t("Comments"));
    panel.innerHTML = `<header><h2 tabindex="-1">Comments</h2><button class="icon-btn" id="comments-close" aria-label="Close comments">${api.icon("x")}</button></header>
      <div class="comment-filters"><label class="sr-only" for="comment-search">Search comments</label><input id="comment-search" type="search" placeholder="Search comments"><label class="sr-only" for="comment-filter">Show comments</label><select id="comment-filter"><option value="open">Open comments</option><option value="unread">Unread comments</option><option value="resolved">Resolved comments</option><option value="all">All comments</option></select></div>
      <div class="comment-list-actions"><button id="comment-new" class="text-btn">New comment</button><label><input id="comment-pins-visible" type="checkbox">Show pins</label></div><p id="comment-access" hidden></p>
      <div id="comment-list"></div><p id="comments-results" class="sr-only" role="status"></p><p id="comment-said" class="sr-only" role="status"></p><div class="comment-pages"><button class="text-btn" id="comments-previous">Previous</button><span id="comments-count"></span><button class="text-btn" id="comments-next">Next</button></div>
      <section id="comment-thread" hidden><header><h3 tabindex="-1">Discussion</h3><button class="text-btn" id="comment-resolve"></button></header><button class="text-btn" id="comment-move" aria-expanded="false" aria-controls="comment-position">Move pin</button><form id="comment-position" hidden><p class="dialog-copy" id="comment-position-help">Set the pin position in board pixels.</p><div class="field-row"><label class="field">Horizontal position<input id="comment-x" type="number" step="any" min="-1000000" max="1000000" required aria-describedby="comment-position-help comment-position-error"></label><label class="field">Vertical position<input id="comment-y" type="number" step="any" min="-1000000" max="1000000" required aria-describedby="comment-position-help comment-position-error"></label></div><p id="comment-position-error" role="alert" hidden></p><div class="dialog-footer"><button class="text-btn" type="button" id="comment-move-cancel">Cancel</button><button class="primary" type="submit">Apply move</button></div></form><div id="comment-messages"></div></section>
      <form id="comment-form" hidden><label class="sr-only" for="comment-text">Write a comment</label><textarea id="comment-text" maxlength="4000" rows="3" placeholder="Write a reply" aria-describedby="comment-help comment-error"></textarea><p id="comment-help">Enter to post · Shift+Enter for a new line</p><p id="comment-error" role="alert" hidden></p><div class="comment-form-actions"><button type="button" class="text-btn" id="comment-edit-cancel" hidden>Cancel edit</button><button class="primary" type="submit">Post comment</button></div></form>`;
    api.canvas().parentElement.append(panel);
    panel.querySelector("#comments-close").onclick = () => close();
    panel.querySelector("#comment-new").onclick = () => api.add();
    panel.querySelector("#comment-filter").onchange = panel.querySelector(
      "#comment-search",
    ).oninput = () => {
      page = 0;
      keptUnread = null;
      signature = null;
      render();
    };
    panel.querySelector("#comment-pins-visible").checked = visible;
    panel.querySelector("#comment-pins-visible").onchange = togglePins;
    const previous = panel.querySelector("#comments-previous"),
      next = panel.querySelector("#comments-next");
    previous.onclick = () => {
      page--;
      signature = null;
      render();
      keepPageFocus(previous, next);
    };
    next.onclick = () => {
      page++;
      signature = null;
      render();
      keepPageFocus(next, previous);
    };
    panel.querySelector("#comment-resolve").onclick = () => {
      if (
        change((all) => {
          const c = all.find((i) => i.id === active);
          if (c) c.resolved = !c.resolved;
        })
      )
        tell(
          t(thread()?.resolved ? "Discussion resolved" : "Discussion reopened"),
        );
    };
    panel.querySelector("#comment-move").onclick = () =>
      positioning ? closePosition() : openPosition();
    panel.querySelector("#comment-move-cancel").onclick = () => closePosition();
    panel.querySelector("#comment-position").onsubmit = submitPosition;
    panel.querySelector("#comment-edit-cancel").onclick = () => {
      clearDraft();
      editing = null;
      loadDraft();
      render();
      panel.querySelector("textarea").focus();
    };
    panel.querySelector("textarea").oninput = () => {
      remember(true);
      panel.querySelector("#comment-error").hidden = true;
    };
    if (api.people)
      attachMentions(panel.querySelector("textarea"), () => api.people());
    panel.querySelector("#comment-form").onsubmit = submit;
    panel
      .querySelector("#comment-text")
      .insertAdjacentHTML(
        "afterend",
        `<button id="comment-language-options" class="text-btn" type="button" aria-expanded="false" aria-controls="comment-language-controls">${t("Content language")}</button><div id="comment-language-controls" hidden></div>`,
      );
    panel.querySelector("#comment-language-options").onclick = openLanguage;
    // Touch keyboards have no Shift+Enter, so there Enter adds a line and
    // the button posts.
    const enterPosts = !globalThis.matchMedia?.("(pointer: coarse)").matches;
    if (!enterPosts)
      panel.querySelector("#comment-help").textContent =
        "Enter adds a new line · Post comment sends";
    panel.querySelector("textarea").onkeydown = (e) => {
      if (
        enterPosts &&
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.isComposing &&
        e.keyCode !== 229
      ) {
        e.preventDefault();
        submit(e);
      }
    };
    // Keys and clipboard actions here stay in the panel; board shortcuts
    // would otherwise move or delete the selected objects.
    for (const event of ["copy", "cut", "paste"])
      panel.addEventListener(event, (e) => e.stopPropagation());
    panel.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        e.stopPropagation();
        // Escape in the Move pin form closes only the form, as it does in
        // the language options, and returns to its button.
        if (positioning && e.target.closest?.("#comment-position"))
          closePosition();
        else close();
      }
    };
    translateUI(panel);
    document
      .querySelector('[data-action="comments"]')
      ?.setAttribute("aria-expanded", "true");
  }
  function closeLanguage(focus = false) {
    const controls = panel?.querySelector("#comment-language-controls");
    if (!controls) return;
    controls.hidden = true;
    controls.replaceChildren();
    panel
      .querySelector("#comment-language-options")
      .setAttribute("aria-expanded", "false");
    if (focus) panel.querySelector("#comment-language-options").focus();
  }
  function openLanguage() {
    if (!draft || state().readOnly) return;
    const root = panel.querySelector("#comment-language-controls");
    if (!root.hidden) return closeLanguage(true);
    remember();
    const box = panel.querySelector("#comment-text");
    const range = {
      start: box.selectionStart,
      end: box.selectionEnd,
      text: box.value,
    };
    const phrase = range.end > range.start;
    root.innerHTML = `<label class="field">${t("Apply to")}<select id="comment-language-scope">${phrase ? `<option value="text">${t("Selected text")}</option>` : ""}<option value="comment">${t("Whole comment")}</option></select></label><label class="field">${t("Language tag")}<input id="comment-language-tag" maxlength="64" placeholder="fr-CA" aria-describedby="comment-language-help comment-language-error" autocomplete="off" spellcheck="false"></label><p id="comment-language-help" class="dialog-copy">${t("Enter a language tag, such as en, fr-CA, or es. Leave empty to inherit the surrounding language.")}</p><p id="comment-language-error" role="alert" hidden></p><div class="dialog-footer"><button type="button" id="comment-language-cancel" class="text-btn">${t("Cancel")}</button><button type="button" id="comment-language-save" class="secondary">${t("Apply language")}</button></div>`;
    const tag = root.querySelector("#comment-language-tag");
    const scope = root.querySelector("#comment-language-scope");
    const sync = () => {
      const values = sliceTextRuns(draft.textRuns, range.start, range.end).map(
        (run) => run.style.lang,
      );
      tag.value =
        scope.value === "text"
          ? values.length && values.every((v) => v === values[0])
            ? values[0]
            : ""
          : draft.lang || "";
    };
    scope.onchange = sync;
    sync();
    root.hidden = false;
    panel
      .querySelector("#comment-language-options")
      .setAttribute("aria-expanded", "true");
    root.querySelector("#comment-language-cancel").onclick = () =>
      closeLanguage(true);
    root.onkeydown = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeLanguage(true);
      }
      // Enter applies from the fields; on a button it presses that button.
      if (e.key === "Enter" && !e.target.closest("button")) {
        e.preventDefault();
        e.stopPropagation();
        root.querySelector("#comment-language-save").click();
      }
    };
    root.querySelector("#comment-language-save").onclick = () => {
      if (!draft || state().readOnly) return;
      const value = tag.value.trim();
      const lang = value ? canonicalLanguage(value) : null;
      const error = root.querySelector("#comment-language-error");
      if (value && !lang) {
        error.hidden = false;
        error.textContent = t(
          "Enter a valid language tag, such as en or fr-CA.",
        );
        tag.focus();
        return;
      }
      if (scope.value === "text") {
        if (box.value !== range.text) {
          error.hidden = false;
          error.textContent = t(
            "The comment text changed. Reopen Content language to select the passage again.",
          );
          return;
        }
        const runs = formatTextRuns(
          box.value,
          draft.textRuns,
          range.start,
          range.end,
          { lang },
        );
        if (runs.length) draft.textRuns = runs;
        else delete draft.textRuns;
      } else {
        if (lang) draft.lang = lang;
        else delete draft.lang;
      }
      remember();
      if (draft.lang) box.lang = draft.lang;
      else box.removeAttribute("lang");
      closeLanguage(true);
    };
    tag.focus();
  }
  function loadDraft(position) {
    closeLanguage();
    const saved = drafts.get(key());
    // A newly chosen place replaces the saved draft's place and object.
    draft = structuredClone(
      position
        ? {
            text: saved?.text || "",
            ...(saved?.lang ? { lang: saved.lang } : {}),
            ...(saved?.textRuns?.length ? { textRuns: saved.textRuns } : {}),
            ...position,
          }
        : saved || { text: "" },
    );
    panel.querySelector("textarea").value = draft.text;
    if (draft.lang) panel.querySelector("textarea").lang = draft.lang;
    else panel.querySelector("textarea").removeAttribute("lang");
    // An error belongs to the thread and text it was about.
    panel.querySelector("#comment-error").hidden = true;
    signature = null;
  }
  // A place no other pin covers, for a comment added at a default spot such
  // as an object's corner: moved left, a pin's width at a time, past the
  // pins of discussions already there, so each stays reachable.
  function freePoint(point) {
    const byId = itemsById(),
      reach = 24 / (state().view?.z || 1),
      taken = threads()
        .filter((c) => !c.resolved && c.messages.some((m) => !m.deleted))
        .map((c) => commentPoint(c, byId));
    let p = point;
    for (
      let n = 0;
      n < 50 && taken.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < reach);
      n++
    )
      p = { ...p, x: p.x - reach };
    return p;
  }
  const readOnlyReason = () =>
    api.readOnlyReason?.() || "This board is read-only.";
  function compose(point, anchor, { avoidPins = false } = {}) {
    if (state().readOnly) return api.toast(readOnlyReason());
    if (avoidPins) point = freePoint(point);
    remember();
    skeleton();
    closePosition(false);
    active = editing = null;
    loadDraft({
      ...point,
      ...(anchor ? commentAttachment(point, anchor) : {}),
    });
    render();
    panel.querySelector("textarea").focus();
    api.draw();
  }
  function show(id, focus = true) {
    remember();
    skeleton();
    closePosition(false);
    active = id;
    editing = null;
    loadDraft();
    const opened = thread();
    keptUnread = opened && unread(opened) ? id : null;
    markSeen(thread());
    render();
    const c = thread();
    // A thread on content hidden from this person opens in place, without
    // moving the view to where that content is.
    if (c && !state().concealed?.has(c.anchorId)) {
      api.reveal?.(c.anchorId);
      const p = commentPoint(
        c,
        new Map(state().board.items.map((i) => [i.id, i])),
      );
      api.focus(p, panel);
    }
    if (focus)
      panel.querySelector(state().readOnly ? "h3" : "textarea").focus();
    api.draw();
  }
  function change(fn) {
    if (state().readOnly) {
      api.toast(readOnlyReason());
      return false;
    }
    try {
      const all = structuredClone(threads());
      fn(all);
      validateComments(all);
      api.save(all);
      signature = null;
      if (panel) panel.querySelector("#comment-error").hidden = true;
      render();
      return true;
    } catch (e) {
      if (panel) {
        const error = panel.querySelector("#comment-error");
        error.hidden = false;
        error.textContent = t(e.message);
      } else api.toast(e.message);
      return false;
    }
  }
  function closePosition(focus = true) {
    positioning = null;
    if (!panel) return;
    panel.querySelector("#comment-position").hidden = true;
    const button = panel.querySelector("#comment-move");
    button.setAttribute("aria-expanded", "false");
    if (focus) button.focus();
  }
  function openPosition() {
    const c = thread();
    if (!c || state().readOnly || state().concealed?.has(c.anchorId)) return;
    positioning = { board: boardId, id: c.id, ...commentPoint(c, itemsById()) };
    panel.querySelector("#comment-x").value = positioning.x;
    panel.querySelector("#comment-y").value = positioning.y;
    panel.querySelector("#comment-position-error").hidden = true;
    panel.querySelector("#comment-position").hidden = false;
    panel.querySelector("#comment-move").setAttribute("aria-expanded", "true");
    panel.querySelector("#comment-x").focus();
    panel.querySelector("#comment-x").select();
  }
  function submitPosition(e) {
    e.preventDefault();
    const form = panel.querySelector("#comment-position");
    if (!positioning || !form.reportValidity()) return;
    const c = thread();
    if (
      !c ||
      state().board.id !== positioning.board ||
      c.id !== positioning.id ||
      state().readOnly ||
      state().concealed?.has(c.anchorId)
    ) {
      render();
      return;
    }
    const point = commentPoint(c, itemsById()),
      error = panel.querySelector("#comment-position-error");
    if (point.x !== positioning.x || point.y !== positioning.y) {
      error.hidden = false;
      error.textContent = t(
        "This pin moved. Close and reopen Move pin to use its current position.",
      );
      return;
    }
    const next = {
      x: panel.querySelector("#comment-x").valueAsNumber,
      y: panel.querySelector("#comment-y").valueAsNumber,
    };
    if (next.x === point.x && next.y === point.y) return closePosition();
    if (positionThread(c.id, next)) closePosition();
    else {
      error.hidden = false;
      error.textContent = panel.querySelector("#comment-error").textContent;
    }
  }
  function submit(e) {
    e.preventDefault();
    if (state().readOnly || !draft) return;
    remember();
    const raw = panel.querySelector("textarea").value;
    const text = raw.trim();
    const trimStart = raw.length - raw.trimStart().length;
    const textRuns = sliceTextRuns(
      draft.textRuns,
      trimStart,
      trimStart + text.length,
    );
    const formatting = {
      ...(draft.lang ? { lang: draft.lang } : {}),
      ...(textRuns.length ? { textRuns } : {}),
    };
    if (!text) {
      panel.querySelector("textarea").focus();
      return;
    }
    let nextId = active;
    const posted = editing
      ? "Comment saved"
      : active
        ? "Reply posted"
        : "Comment posted";
    const success = change((all) => {
      const author = state().author,
        c = all.find((i) => i.id === active);
      if (active && !c) throw Error("This discussion is no longer available.");
      if (editing) {
        const m = c.messages.find((m) => m.id === editing.id);
        if (
          !m ||
          m.deleted ||
          m.authorId !== author.id ||
          m.text !== editing.original ||
          m.lang !== editing.originalLanguage ||
          JSON.stringify(m.textRuns || []) !==
            JSON.stringify(editing.originalRuns || [])
        )
          throw Error("This comment changed. Reopen it before editing.");
        if (
          m.text !== text ||
          m.lang !== formatting.lang ||
          JSON.stringify(m.textRuns || []) !== JSON.stringify(textRuns)
        ) {
          m.text = text;
          if (formatting.lang) m.lang = formatting.lang;
          else delete m.lang;
          if (textRuns.length) m.textRuns = textRuns;
          else delete m.textRuns;
          m.editedAt = Math.max(Math.round(now()), m.createdAt);
        }
      } else if (c) {
        if (c.messages.length >= COMMENT_LIMITS.replies)
          throw Error("This discussion has reached its reply limit.");
        // A reply follows the discussion even when this device's clock is
        // behind the one that started it.
        c.messages.push(
          Object.assign(
            commentMessage(
              author,
              text,
              Math.max(
                Math.round(now()),
                ...c.messages.map((m) => m.createdAt + 1),
              ),
            ),
            formatting,
          ),
        );
        c.resolved = false;
      } else {
        if (all.length >= COMMENT_LIMITS.threads)
          throw Error("This board has reached its comment limit.");
        const byId = new Map(state().board.items.map((i) => [i.id, i]));
        const next = commentThread(
          commentPoint(draft, byId),
          author,
          text,
          byId.get(draft.anchorId),
          Math.round(now()),
        );
        nextId = next.id;
        Object.assign(next.messages[0], formatting);
        all.push(next);
      }
    });
    if (success) {
      clearDraft();
      active = nextId;
      editing = null;
      loadDraft();
      render();
      panel.querySelector("textarea").focus();
      tell(t(posted));
    } else if (editing) {
      // A resumed edit of a message that changed meanwhile is refused once;
      // editing it again starts from the message as it is now, as the
      // error says.
      const m = thread()?.messages.find((m) => m.id === editing.id);
      if (m && !m.deleted && m.authorId === state().author.id) {
        editing = {
          id: m.id,
          original: m.text,
          originalLanguage: m.lang,
          originalRuns: structuredClone(m.textRuns || []),
        };
        remember();
      }
    }
  }
  // Messages in the order they were written. Replies posted at the same time
  // by two people can be stored in the order they reached the board.
  function inOrder(c) {
    return [...c.messages].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  }
  function editMessage(id) {
    const m = thread()?.messages.find((m) => m.id === id);
    if (!m || state().readOnly || m.authorId !== state().author.id) return;
    remember();
    editing = {
      id,
      original: m.text,
      originalLanguage: m.lang,
      originalRuns: structuredClone(m.textRuns || []),
    };
    loadDraft();
    if (draft.editing?.id === id && typeof draft.editing.original === "string")
      editing = { ...draft.editing };
    if (!draft.text) {
      panel.querySelector("textarea").value = draft.text = m.text;
      if (m.lang) draft.lang = m.lang;
      if (m.textRuns?.length) draft.textRuns = structuredClone(m.textRuns);
    }
    render();
    panel.querySelector("textarea").focus();
  }
  function deleteMessage(id) {
    change((all) => {
      const m = all
        .find((i) => i.id === active)
        ?.messages.find((m) => m.id === id);
      if (!m || m.authorId !== state().author.id)
        throw Error("Only the author can edit this comment.");
      // Deleting or restoring leaves the words as they were, so a restored
      // comment is not marked edited.
      m.deleted = !m.deleted;
    });
  }
  function render() {
    const s = state();
    if (panel && s.board?.id !== boardId) {
      close(false);
      return;
    }
    // A discussion open in the panel is read as it arrives.
    if (panel && active) markSeen(thread());
    announceMentions();
    hearReplies();
    renderPins();
    renderBadge();
    if (!panel) return;
    if (s.readOnly || !draft) {
      const lostFocus = panel
        .querySelector("#comment-language-controls")
        .contains(document.activeElement);
      closeLanguage();
      if (lostFocus)
        panel.querySelector("#comment-search").focus({ preventScroll: true });
    }
    let c = thread();
    // The discussion being replied to went away, as when someone removed
    // it or an earlier version came back: the box is for a new comment
    // again, with the reply kept as a draft, and says so.
    if (active && !c) {
      active = null;
      editing = null;
      loadDraft();
      const error = panel.querySelector("#comment-error");
      error.hidden = false;
      error.textContent = t("This discussion is no longer available.");
      c = undefined;
    }
    const author = s.author;
    const query = searchTerms(
        panel.querySelector("#comment-search").value,
      ).join(" "),
      filter = panel.querySelector("#comment-filter").value;
    const value = [
      s.board.comments,
      active,
      editing,
      filter,
      query,
      page,
      s.readOnly,
      author.id,
      visible,
      s.board.workshop,
      !!s.concealed?.has(c?.anchorId),
      // What this person has read changes which discussions are new.
      seenVersion,
    ];
    if (signature && value.every((v, n) => v === signature[n])) return;
    signature = value;
    // The list and messages are rebuilt; a focused control inside them gets
    // focus back afterwards, found by its data attributes.
    const regions = ["#comment-list", "#comment-messages"];
    const focused = document.activeElement;
    const region = regions.find((r) =>
      panel.querySelector(r)?.contains(focused),
    );
    const keyOf = (el) =>
      el.tagName +
      [...el.attributes]
        .filter((a) => a.name.startsWith("data-"))
        .map((a) => `|${a.name}=${a.value}`)
        .join("");
    const focusKey =
      region && focused !== panel.querySelector(region) ? keyOf(focused) : null;
    const controls = () =>
      region
        ? [...panel.querySelector(region).querySelectorAll("button:enabled")]
        : [];
    const focusIndex = focusKey ? controls().indexOf(focused) : -1;
    const results = threads()
      .filter(
        (c) =>
          (filter === "all" ||
            (filter === "unread"
              ? unread(c) || c.id === keptUnread
              : filter === "resolved"
                ? c.resolved
                : !c.resolved && c.messages.some((m) => !m.deleted))) &&
          (!query ||
            // Each word is found somewhere in the discussion. This
            // person's own messages are listed as "You", so that word
            // finds them too.
            (() => {
              const hay = fold(
                c.messages
                  .filter((m) => !m.deleted)
                  .map(
                    (m) =>
                      `${m.authorName} ${m.authorId === author.id ? t("You") : ""} ${m.text}`,
                  )
                  .join("\n"),
              );
              return query.split(" ").every((word) => hay.includes(word));
            })()),
      )
      .sort(
        (a, b) =>
          commentActivity(b) - commentActivity(a) || a.id.localeCompare(b.id),
      );
    page = Math.max(0, Math.min(page, Math.ceil(results.length / 50) - 1));
    const byId = itemsById(),
      on = (c) => {
        const html = attachedTo(c, byId);
        return html ? `<span class="sr-only">. ${html}</span>` : "";
      };
    panel.querySelector("#comment-list").innerHTML =
      results
        .slice(page * 50, page * 50 + 50)
        .map((c) => {
          const first = inOrder(c).find((m) => !m.deleted);
          // New messages from others are marked in words as well as with
          // the dot their pin has, for discussions whose pin is out of view.
          const fresh = unread(c);
          return `<button class="comment-summary${fresh ? " is-unread" : ""}" data-thread="${escape(c.id)}" aria-pressed="${active === c.id}"><strong data-user-content>${escape(first?.authorId === s.author.id ? t("You") : first?.authorName || t("Deleted comment"))}</strong><span data-user-content>${first ? authoredTextHTML(first, commentExcerpt(first.text, 120)) : escape(t("Deleted comment"))}</span><small>${fresh ? `<b class="comment-new">${escape(t("New messages"))}</b> · ` : ""}${c.resolved ? t("Resolved") : t("Open")} · ${c.messages.filter((m) => !m.deleted).length}</small>${on(c)}</button>`;
        })
        .join("") || `<p class="dialog-copy">${t("No comments to show.")}</p>`;
    for (const b of panel.querySelectorAll("[data-thread]"))
      b.onclick = () => show(b.dataset.thread);
    panel.querySelector("#comments-previous").disabled = page === 0;
    panel.querySelector("#comments-next").disabled =
      (page + 1) * 50 >= results.length;
    panel.querySelector("#comments-count").textContent = String(results.length);
    // Searching and filtering say how many discussions match, even when
    // they all fit on one page and the pager is hidden. A count changed by
    // anything else, such as resolving the open discussion, is not said.
    const found = panel.querySelector("#comments-results"),
      summary = plural(
        results.length,
        "{count} discussion",
        "{count} discussions",
      ),
      asked = `${filter}|${query}`;
    if (found.textContent !== summary)
      found.textContent = found.dataset.asked === asked ? "" : summary;
    found.dataset.asked = asked;
    panel.querySelector(".comment-pages").hidden = results.length <= 50;
    keepPaginationFocus(
      focused,
      panel.querySelector("#comments-previous"),
      panel.querySelector("#comments-next"),
      panel.querySelector("#comment-search"),
    );
    panel.classList.toggle("has-discussion", !!c);
    panel.querySelector("#comment-new").disabled = s.readOnly;
    // Beside the unavailable New comment, why, and what to ask for.
    const access = panel.querySelector("#comment-access"),
      reason = s.readOnly ? t(readOnlyReason()) : "";
    if (access.textContent !== reason) access.textContent = reason;
    access.hidden = !reason;
    panel.querySelector("#comment-thread").hidden = !c;
    panel.querySelector("#comment-resolve").textContent = t(
      c?.resolved ? "Reopen discussion" : "Resolve discussion",
    );
    panel.querySelector("#comment-resolve").disabled = s.readOnly;
    panel.querySelector("#comment-move").disabled =
      s.readOnly || s.concealed?.has(c?.anchorId);
    if (!c || s.readOnly || s.concealed?.has(c.anchorId)) closePosition(false);
    panel.querySelector("#comment-messages").innerHTML = c
      ? inOrder(c)
          .map(
            (m) =>
              `<article class="comment-message" data-message="${escape(m.id)}"><header><strong data-user-content>${escape(m.authorId === author.id ? t("You") : m.authorName)}</strong><time datetime="${new Date(m.createdAt).toISOString()}">${escape(new Date(m.createdAt).toLocaleString(language === "fr" ? "fr-CA" : "en-CA", { dateStyle: "medium", timeStyle: "short" }))}</time></header><p data-user-content>${m.deleted ? escape(t("Comment deleted")) : authoredTextHTML(m)}</p>${m.editedAt && !m.deleted ? `<small>${t("Edited")}</small>` : ""}${api.reactions?.(c, m) || ""}${!s.readOnly && m.authorId === author.id ? `<div>${!m.deleted ? `<button class="text-btn" data-edit-comment="${escape(m.id)}">${t("Edit comment")}</button>` : ""}<button class="text-btn" data-delete-comment="${escape(m.id)}">${t(m.deleted ? "Restore comment" : "Delete comment")}</button></div>` : ""}</article>`,
          )
          .join("")
      : "";
    for (const b of panel.querySelectorAll("[data-edit-comment]"))
      b.onclick = () => editMessage(b.dataset.editComment);
    for (const b of panel.querySelectorAll("[data-delete-comment]"))
      b.onclick = () => deleteMessage(b.dataset.deleteComment);
    panel.querySelector("#comment-form").hidden = s.readOnly || !draft;
    panel.querySelector("#comment-edit-cancel").hidden = !editing;
    panel.querySelector('#comment-form [type="submit"]').textContent = t(
      editing ? "Save comment" : active ? "Reply" : "Post comment",
    );
    // The visible hint says what the box is for, as its label does.
    const purpose = t(
      editing ? "Edit comment" : active ? "Write a reply" : "Write a comment",
    );
    const box = panel.querySelector("textarea");
    box.setAttribute("aria-label", purpose);
    if (draft?.lang) box.lang = draft.lang;
    else box.removeAttribute("lang");
    box.placeholder = purpose;
    panel.querySelector("#comment-pins-visible").checked = visible;
    if (focusKey) {
      const same = [...panel.querySelector(region).querySelectorAll("*")].find(
        (el) => keyOf(el) === focusKey,
      );
      // Gone, as when someone else resolved that discussion: the control
      // now in its place, or the panel's heading.
      const nearby = controls();
      (
        same ||
        (focusIndex >= 0 && nearby[Math.min(focusIndex, nearby.length - 1)]) ||
        panel.querySelector("h2")
      )?.focus();
    }
    if (
      panel.contains(focused) &&
      (focused.disabled || focused.closest("[hidden]")) &&
      (document.activeElement === focused ||
        document.activeElement === document.body)
    )
      panel.querySelector("#comment-search").focus({ preventScroll: true });
  }
  // A pin that leaves the view or the board while focused hands the
  // keyboard to the canvas instead of the page.
  function removePin(pin) {
    if (pin.contains(document.activeElement))
      api.canvas()?.focus({ preventScroll: true });
    pin.remove();
  }
  function renderPins() {
    if (!layer || !state().board) return;
    if (!threads().length && !(draft && !active && panel)) {
      for (const pin of pins.values()) removePin(pin);
      pins.clear();
      return;
    }
    const s = state(),
      byId = itemsById(),
      rect = api.canvas().getBoundingClientRect(),
      keep = new Set(),
      order = [];
    for (const c of [
      ...threads(),
      ...(draft && !active && panel
        ? [{ ...draft, id: "draft", messages: [], resolved: false }]
        : []),
    ]) {
      if (
        !visible ||
        s.hidden?.has(c.anchorId) ||
        (c.resolved && c.id !== active) ||
        (c.id !== "draft" &&
          c.messages.every((m) => m.deleted) &&
          c.id !== active)
      )
        continue;
      const p = drag?.id === c.id ? drag.point : commentPoint(c, byId),
        x = s.view.x + p.x * s.view.z,
        y = s.view.y + p.y * s.view.z;
      // The pin being dragged stays even past the edge: removing it would
      // end its pointer capture and cancel the drag.
      if (
        ![x, y].every(Number.isFinite) ||
        (drag?.id !== c.id &&
          (x < -30 || y < -30 || x > rect.width + 30 || y > rect.height + 30))
      )
        continue;
      keep.add(c.id);
      let pin = pins.get(c.id);
      if (!pin) {
        pin = document.createElement("button");
        pin.className = "comment-pin";
        pin.dataset.comment = c.id;
        pin.innerHTML =
          api.icon("message-square") +
          '<span class="sr-only" data-comment-label></span>';
        pin.onclick = () => {
          if (drag || performance.now() < suppressClick) return;
          if (c.id === "draft") panel?.querySelector("textarea")?.focus();
          else show(c.id);
        };
        pin.addEventListener("pointerdown", (e) => startDrag(e, c.id));
        pin.addEventListener("pointermove", moveDrag);
        pin.addEventListener("pointerup", endDrag);
        for (const type of ["pointercancel", "lostpointercapture"])
          pin.addEventListener(type, (e) => {
            if (drag && drag.pointer === e.pointerId) cancelDrag();
          });
        pin.onkeydown = (e) => {
          if (e.key === "Escape" && drag) {
            e.preventDefault();
            e.stopPropagation();
            cancelDrag();
          }
          // Deleting from a focused pin must not delete the selected objects.
          if (e.key === "Delete" || e.key === "Backspace") e.stopPropagation();
          const direction = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, -1],
            ArrowDown: [0, 1],
          }[e.key];
          if (direction && !e.altKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            e.stopPropagation();
            if (state().readOnly || c.id === "draft") return;
            const current = threads().find((t) => t.id === c.id);
            if (!current) return;
            const p = commentPoint(current, itemsById()),
              step = e.shiftKey ? 10 : 1;
            positionThread(c.id, {
              x: p.x + direction[0] * step,
              y: p.y + direction[1] * step,
            });
          }
        };
        layer.append(pin);
        pins.set(c.id, pin);
      }
      pin.style.left = `${x}px`;
      pin.style.top = `${y}px`;
      order.push({ node: pin, x: p.x, y: p.y });
      const first = inOrder(c).find((m) => !m.deleted);
      const name =
        c.id === "draft"
          ? escape(t("Draft comment"))
          : escape(labelled(t("Comment"), "")) +
            (first
              ? authoredTextHTML(first, commentExcerpt(first.text, 100))
              : escape(t("Comment deleted")));
      const label = pin.querySelector("[data-comment-label]");
      const fresh = unread(c);
      if (pin.classList.contains("is-unread") !== fresh)
        pin.classList.toggle("is-unread", fresh);
      const on = attachedTo(c, byId);
      const named = [name, fresh && escape(t("New messages")), on]
        .filter(Boolean)
        .join(" · ");
      if (pin.labelMarkup !== named) {
        label.innerHTML = named;
        pin.labelMarkup = named;
      }
      pin.title = label.textContent;
      pin.setAttribute(
        "aria-pressed",
        String(c.id === active || c.id === "draft"),
      );
    }
    for (const [id, pin] of pins)
      if (!keep.has(id)) {
        removePin(pin);
        pins.delete(id);
      }
    // Moving the dragged pin in the page would end its pointer capture.
    if (!drag) keepReadingOrder(layer, order);
  }
  function startDrag(e, id) {
    if (e.button !== 0 || drag || state().readOnly || id === "draft") return;
    e.preventDefault();
    e.stopPropagation();
    const c = threads().find((t) => t.id === id);
    if (!c) return;
    const point = commentPoint(
      c,
      new Map(state().board.items.map((i) => [i.id, i])),
    );
    drag = {
      id,
      pointer: e.pointerId,
      board: state().board.id,
      sx: e.clientX,
      sy: e.clientY,
      original: point,
      point,
      moved: false,
    };
    e.currentTarget.focus({ preventScroll: true });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  }
  function moveDrag(e) {
    if (!drag || drag.pointer !== e.pointerId) return;
    if (state().readOnly || state().board.id !== drag.board)
      return cancelDrag();
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3)
      drag.moved = true;
    if (drag.moved) {
      drag.point = {
        x: drag.original.x + (e.clientX - drag.sx) / state().view.z,
        y: drag.original.y + (e.clientY - drag.sy) / state().view.z,
      };
      renderPins();
    }
  }
  function endDrag(e) {
    if (!drag || drag.pointer !== e.pointerId) return;
    const previous = drag;
    drag = null;
    if (!previous.moved) return;
    suppressClick = performance.now() + 400;
    if (state().readOnly || state().board.id !== previous.board)
      return renderPins();
    positionThread(previous.id, previous.point);
    renderPins();
  }
  function positionThread(id, point) {
    return change((all) => {
      const c = all.find((c) => c.id === id);
      if (!c) return;
      Object.assign(c, point);
      for (const k of ["anchorId", "dx", "dy"]) delete c[k];
      const anchor = api.anchor(point);
      if (anchor) Object.assign(c, commentAttachment(c, anchor));
    });
  }
  function cancelDrag() {
    if (!drag) return;
    drag = null;
    renderPins();
  }
  function togglePins() {
    visible = !visible;
    try {
      localStorage.setItem("whiteboard-comments-visible", String(visible));
    } catch {}
    render();
  }
  return {
    bind(next) {
      close(false);
      layer = next;
      pins.clear();
    },
    close,
    compose,
    show,
    render,
    cancel: cancelDrag,
    isOpen: () => !!panel,
    toggle() {
      if (panel) close();
      else {
        skeleton();
        render();
        panel.querySelector("h2").focus();
        api.draw();
      }
    },
    togglePins,
    unreadCount: () =>
      state().board ? threads().filter((c) => unread(c)).length : 0,
  };
}
