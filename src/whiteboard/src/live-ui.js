import { labelled, language, plural, t } from "./i18n.js";
import { escape } from "./model.js";
import { REACTIONS } from "./facilitation/model.js";
import "./facilitation/strings.js";

// The most reactions floating at once. In a room of a hundred people the
// rest are dropped rather than queued, as they would be late.
export const MAX_FLOATING = 30;
// How long a reaction floats, or fades in place for those who ask for
// less motion; a node is removed after it even if no animation ran.
const FLOAT = 2600,
  FADE = 1600;

// The raised hands in the order they went up, as Participants and the
// facilitation People tab list them. Owners and facilitators see who, and
// can lower each hand or all of them; others see who too unless input is
// anonymous, and then only how many are up. Anyone can lower their own.
// Returns whether the control that had focus went, for the caller to move
// focus on.
export function renderHands(section, list, { manage, anonymous }) {
  const named = manage || !anonymous;
  const next = JSON.stringify([
    list.map((h) => [h.user ?? h.session, h.username, h.sessions, h.self]),
    manage,
    named,
    language,
  ]);
  if (section.dataset.signature === next) return false;
  section.dataset.signature = next;
  const focused = section.ownerDocument.activeElement,
    before = [...section.querySelectorAll("button")],
    at = before.indexOf(focused);
  section.hidden = !list.length;
  const id = section.id;
  section.innerHTML = `<div class="raised-hands-head"><h4 id="${id}-heading">${escape(plural(list.length, "{count} raised hand", "{count} raised hands"))}</h4>${manage && list.length ? `<button type="button" class="secondary" data-lower-hand="all">${t("Lower all hands")}</button>` : ""}</div>${
    named
      ? `<ol class="raised-hands-list" aria-labelledby="${id}-heading">${list
          .map(
            (h) =>
              `<li><span class="raised-hand-name"><span data-user-content>${escape(h.username)}</span>${h.self ? ` (${t("you")})` : ""}</span>${
                manage || h.self
                  ? `<button type="button" class="text-btn" data-lower-hand="${escape(h.sessions.join(" "))}" aria-label="${escape(labelled(t("Lower hand"), h.username))}">${t("Lower hand")}</button>`
                  : ""
              }</li>`,
          )
          .join("")}</ol>`
      : ""
  }`;
  if (at < 0) return false;
  const after = [...section.querySelectorAll("button")];
  const replacement = after[Math.min(at, after.length - 1)];
  if (!replacement) return true;
  replacement.focus({ preventScroll: true });
  return false;
}

// Live reactions and raised hands on a shared board: a control in the
// board's navigation row opens a small popover of the eight reaction kinds
// and a raise hand toggle. Each reaction chosen floats up the board for
// everyone present, the sender included. Nothing is saved to the board or
// its history.
export function createLiveUI(api) {
  let host = null,
    button = null,
    popover = null,
    layer = null,
    signature = "",
    // Others' raised hands as last heard, by person, and the changes not
    // yet said to a facilitator.
    handsSeen = null,
    handChanges = { raised: [], lowered: [] },
    handTimer = null,
    handsSession = null;
  const timers = new Set();
  const session = () => api.session();
  const available = () => !!session() && api.shared();
  const linked = () => !!session()?.linked();

  const raised = () => !!session()?.hand;
  function render() {
    if (!button) return;
    const shown = available();
    if (button.hidden === shown) button.hidden = !shown;
    // The control shows a raised hand, so it is seen with the popover shut.
    const up = shown && raised();
    if (button.classList.contains("is-raised") !== up)
      button.classList.toggle("is-raised", up);
    if (!shown && popover) close(false);
    renderPopover();
  }
  function renderPopover() {
    if (!popover) return;
    const live = linked(),
      up = raised();
    const next = JSON.stringify([live, up]);
    if (next === signature) return;
    signature = next;
    for (const choice of popover.querySelectorAll("[data-live-reaction]"))
      choice.disabled = !live;
    const hand = popover.querySelector("[data-live-hand]");
    // Lowering stays possible without a link, so a hand is never stuck.
    hand.disabled = !live && !up;
    hand.setAttribute("aria-pressed", String(up));
    popover.querySelector(".live-offline").hidden = live;
  }
  function open() {
    if (!host || !button || popover || !available()) return;
    popover = document.createElement("div");
    popover.id = "live-popover";
    popover.className = "live-popover panel";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", t("Live reactions"));
    popover.innerHTML = `<div class="live-reaction-grid" role="group" aria-label="${t("Send a reaction")}">${REACTIONS.map(
      ([type, emoji, label]) =>
        `<button type="button" class="live-reaction-choice" data-live-reaction="${type}" aria-label="${t(label)}" title="${t(label)}"><span aria-hidden="true">${emoji}</span></button>`,
    ).join(
      "",
    )}</div><button type="button" class="secondary live-hand" data-live-hand aria-pressed="false"><i data-lucide="hand" aria-hidden="true"></i><span>${t("Raise hand")}</span></button><p class="live-offline dialog-copy" hidden>${t("Reactions need a live connection to the others on this board.")}</p>`;
    signature = "";
    host.append(popover);
    popover.addEventListener("click", (e) => {
      const choice = e.target.closest("[data-live-reaction]");
      if (choice && !choice.disabled) react(choice.dataset.liveReaction);
      const hand = e.target.closest("[data-live-hand]");
      if (hand && !hand.disabled) toggleHand();
    });
    popover.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    });
    document.addEventListener("pointerdown", outside, true);
    button.setAttribute("aria-expanded", "true");
    renderPopover();
    place();
    api.refreshIcons?.();
    popover.querySelector("button:not([disabled])")?.focus();
  }
  // Under the control, right-aligned to it and kept inside the board.
  function place() {
    if (!popover || !host) return;
    const area = host.getBoundingClientRect(),
      anchor = button.getBoundingClientRect(),
      width = popover.offsetWidth;
    const left = Math.max(
      8,
      Math.min(anchor.right - area.left - width, area.width - width - 8),
    );
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(anchor.bottom - area.top + 8)}px`;
  }
  // A press anywhere else closes the popover and leaves focus where it
  // went; the control itself toggles it.
  function outside(e) {
    if (popover?.contains(e.target) || button?.contains(e.target)) return;
    close(false);
  }
  function close(focus = true) {
    if (!popover) return;
    const within = popover.contains(document.activeElement);
    popover.remove();
    popover = null;
    document.removeEventListener("pointerdown", outside, true);
    button?.setAttribute("aria-expanded", "false");
    if ((focus || within) && button && !button.hidden)
      button.focus({ preventScroll: true });
  }
  function toggle() {
    if (popover) close(true);
    else open();
  }
  function react(type) {
    const s = session();
    const reaction = REACTIONS.find((r) => r[0] === type);
    if (!s || !reaction) return;
    if (!s.react(type)) {
      api.announce(
        t(
          linked()
            ? "Too many reactions at once. Try again in a moment."
            : "Reactions need a live connection to the others on this board.",
        ),
      );
      return;
    }
    show(
      {
        session: s.session,
        username: s.user?.username,
        type,
      },
      true,
    );
    api.announce(labelled(t("Reaction sent"), t(reaction[2])));
  }
  function toggleHand() {
    const s = session();
    if (!s) return;
    const up = !s.hand;
    if (!s.raiseHand(up)) {
      api.announce(
        t("Reactions need a live connection to the others on this board."),
      );
      return;
    }
    api.announce(t(up ? "Your hand is raised." : "Your hand is lowered."));
    render();
    api.handChanged?.();
  }
  // A facilitator lowered this person's hand.
  function loweredBy() {
    api.announce(t("A facilitator lowered your hand."));
    render();
    api.handChanged?.();
  }
  // Raised hands as they change. Owners and facilitators hear who raised or
  // lowered a hand, by name even under anonymous input, as they call on
  // people; changes within a second are said together, as are the hands
  // already up when they arrive. This person's own hand is not said.
  function hands(list) {
    // Another session, as after reconnecting, starts afresh; out of one,
    // as on leaving, hands going away are not said.
    if (handsSession !== session()) {
      handsSession = session();
      handsSeen = new Map();
    }
    if (!handsSession) return;
    const now = new Map(
      list.filter((h) => !h.self).map((h) => [h.user ?? h.session, h.username]),
    );
    const before = handsSeen;
    handsSeen = now;
    if (!api.canManage()) return;
    for (const [key, name] of now)
      if (!before.has(key)) handChanges.raised.push(name);
    for (const [key, name] of before)
      if (!now.has(key)) handChanges.lowered.push(name);
    if (!handChanges.raised.length && !handChanges.lowered.length) return;
    handTimer ??= setTimeout(() => {
      handTimer = null;
      const { raised: up, lowered: down } = handChanges;
      handChanges = { raised: [], lowered: [] };
      const said = [];
      if (up.length === 1) said.push(labelled(t("Hand raised"), up[0]));
      else if (up.length)
        said.push(
          plural(up.length, "{count} hand raised.", "{count} hands raised."),
        );
      if (down.length === 1) said.push(labelled(t("Hand lowered"), down[0]));
      else if (down.length)
        said.push(
          plural(
            down.length,
            "{count} hand lowered.",
            "{count} hands lowered.",
          ),
        );
      if (said.length && host) api.announce(said.join(" "));
    }, 1000);
  }
  // Where across the board a reaction rises, in percent: a name's width
  // away from those still rising where that is easily found, so a burst of
  // them stays legible on a phone too.
  // Where none is free, as for a burst on a narrow screen, it starts a row
  // higher than those it would cover.
  const recent = [];
  function spot() {
    const gap = Math.max(12, (110 / (layer?.clientWidth || 900)) * 100);
    const near = (x, row) =>
      recent.filter((o) => o.row === row && Math.abs(o.x - x) < gap).length;
    let best = null;
    for (let tries = 0; tries < 24; tries++) {
      const x = Math.round(12 + Math.random() * 76);
      if (!near(x, 0)) {
        best = { x, row: 0 };
        break;
      }
      // The lowest row free at this place, up to three rows high.
      let row = 1;
      while (row < 3 && near(x, row)) row++;
      if (!best || row < best.row) best = { x, row };
    }
    recent.push(best);
    if (recent.length > 8) recent.shift();
    return best;
  }
  // A reaction floats up from the bottom of the board, with who sent it
  // unless anonymous input is on. Past the limit others' are dropped, but
  // this person's own always shows, in place of the oldest.
  function show(person, own = false) {
    const reaction = REACTIONS.find((r) => r[0] === person.type);
    if (!layer || !reaction) return;
    if (layer.childElementCount >= MAX_FLOATING) {
      if (!own) return;
      layer.firstElementChild.remove();
    }
    const still = !!api.reducedMotion?.();
    const node = document.createElement("div");
    node.className = `live-reaction${still ? " is-still" : ""}`;
    const { x, row } = spot();
    node.style.setProperty("--x", `${x}%`);
    node.style.setProperty("--row", row);
    node.style.setProperty(
      "--drift",
      `${Math.round((Math.random() - 0.5) * 48)}px`,
    );
    const emoji = document.createElement("span");
    emoji.className = "live-reaction-emoji";
    emoji.textContent = reaction[1];
    node.append(emoji);
    const name = !api.anonymous() && person.username;
    if (name) {
      const label = document.createElement("span");
      label.className = "live-reaction-name";
      label.dataset.userContent = "";
      label.textContent = name;
      node.append(label);
    }
    layer.append(node);
    let timer = null;
    const done = () => {
      node.remove();
      clearTimeout(timer);
      timers.delete(timer);
    };
    node.addEventListener("animationend", done, { once: true });
    timer = setTimeout(done, (still ? FADE : FLOAT) + 400);
    timers.add(timer);
  }
  // Someone else's reaction, as the session passes it on.
  function receive(person) {
    if (!available() || person.session === session()?.session) return;
    show(person);
  }
  function bind(element) {
    detach();
    host = element;
    if (!host) return;
    button = host.querySelector('[data-action="live"]');
    layer = document.createElement("div");
    layer.className = "live-reactions";
    layer.setAttribute("aria-hidden", "true");
    host.append(layer);
    render();
  }
  // A presentation covers the board, so reactions float up over it while it
  // is open, and over the board again once it closes.
  function present(dialog) {
    if (!layer) return;
    const moved = layer;
    dialog.append(moved);
    dialog.addEventListener(
      "close",
      () => {
        if (layer === moved && host) host.append(moved);
      },
      { once: true },
    );
  }
  function detach() {
    close(false);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    clearTimeout(handTimer);
    handTimer = null;
    handsSeen = null;
    handsSession = null;
    handChanges = { raised: [], lowered: [] };
    layer?.remove();
    layer = button = host = null;
  }
  return {
    bind,
    detach,
    render,
    toggle,
    close,
    receive,
    hands,
    loweredBy,
    place,
    present,
    isOpen: () => !!popover,
  };
}
