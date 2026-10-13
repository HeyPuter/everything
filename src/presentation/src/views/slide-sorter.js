// Slide Sorter: every slide as a thumbnail in a grid that wraps to the
// window, grouped under their sections. Slides are selected with a click
// (Shift for a range, Ctrl or Cmd to add one), dragged to reorder, within
// a section or into another, and opened in Normal view with a double-click
// or Enter. Sections fold away under their headers, and their menu renames,
// moves and removes them.
import { el, icon, openMenu, promptName } from "../ui.js";
import {
  groupSlides,
  moveSlidesTo,
  addSectionAt,
  renameSectionAt,
  moveSectionBy,
  removeSectionAt,
} from "./sections-model.js";

const BASE_CARD = 200;
export const SORTER_STEPS = [0.33, 0.5, 0.66, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

export function createSlideSorter(ctx) {
  const { P } = ctx;
  let host = null;
  let grid = null;
  let zoom = 1;
  let collapsed = new Set();
  const cards = new Map();
  let anchorPart = null;
  const visible = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const part = entry.target.closest(".sorter-card")?.dataset.part;
        if (!part) continue;
        if (entry.isIntersecting) {
          visible.add(part);
          paint(part);
        } else visible.delete(part);
      }
    },
    { rootMargin: "200px" },
  );

  const pres = () => ctx.doc().pres;
  const slides = () => P.getSlides(pres());
  const order = () => slides().map(P.getSlidePartName);
  const slideOf = (part) =>
    slides().find((s) => P.getSlidePartName(s) === part);
  const sections = () => {
    try {
      return P.getSlideSections(pres()).map((sec) => ({
        name: sec.name,
        slides: sec.slides.map(P.getSlidePartName),
      }));
    } catch {
      return [];
    }
  };
  const sectionKey = (sec, i) => `${i}:${sec.name}`;

  function paint(part) {
    const card = cards.get(part);
    const s = slideOf(part);
    if (!card || !s) return;
    const img = card.querySelector("img");
    const src = ctx.thumbnail(s);
    if (img.getAttribute("src") !== src) img.src = src;
  }

  function enter() {
    const settings = ctx.settings();
    zoom = SORTER_STEPS.includes(settings.sorterZoom)
      ? settings.sorterZoom
      : Number(settings.sorterZoom) > 0
        ? Math.min(3, Math.max(0.33, Number(settings.sorterZoom)))
        : 1;
    collapsed = new Set(settings.collapsedSections || []);
    host = document.querySelector("#view-host");
    grid = el("div", {
      class: "sorter-grid",
      role: "region",
      "aria-label": "Slide Sorter",
      onkeydown: keydown,
      oncontextmenu: (e) => {
        if (e.target.closest(".sorter-card, .sorter-section-head")) return;
        e.preventDefault();
        backgroundMenu(e);
      },
      onwheel: (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        ctx.stepZoom(e.deltaY < 0 ? 1 : -1);
      },
    });
    host.replaceChildren(grid);
    host.className = "view-host sorter-view";
    applyZoom();
    refresh();
    const current = cards.get(P.getSlidePartName(ctx.currentSlide()));
    current?.scrollIntoView({ block: "nearest" });
    current?.focus({ preventScroll: true });
  }
  function leave() {
    observer.disconnect();
    visible.clear();
    cards.clear();
    host?.replaceChildren();
    grid = null;
  }
  function applyZoom() {
    grid?.style.setProperty(
      "--sorter-card",
      `${Math.round(BASE_CARD * zoom)}px`,
    );
    ctx.zoomChanged();
  }

  function refresh() {
    if (!grid) return;
    const focusedPart = grid.contains(document.activeElement)
      ? document.activeElement.closest(".sorter-card")?.dataset.part
      : null;
    const focusedHead = grid.contains(document.activeElement)
      ? document.activeElement.closest(".sorter-section")?.dataset.section
      : null;
    const all = slides();
    const parts = all.map(P.getSlidePartName);
    const secs = sections();
    const groups = groupSlides(parts, secs);
    const chosen = ctx.selectedParts();
    const current = P.getSlidePartName(ctx.currentSlide());
    const aspect = ctx.currentSize();
    grid.style.setProperty("--slide-aspect", `${aspect.cx} / ${aspect.cy}`);
    for (const part of [...cards.keys()])
      if (!parts.includes(part)) {
        observer.unobserve(cards.get(part).querySelector("img"));
        cards.delete(part);
      }
    const nodes = groups.map((group, gi) => {
      const list = el("div", {
        class: "sorter-cards",
        role: "listbox",
        "aria-multiselectable": "true",
        "aria-label": group.name ? `${group.name} slides` : "Slides",
      });
      for (const part of group.slides) {
        const i = parts.indexOf(part);
        const card = cards.get(part) || makeCard(part);
        updateCard(card, all[i], i, chosen.has(part), part === current);
        list.append(card);
      }
      if (group.name === null) return list;
      const key = sectionKey(group, gi);
      const folded = collapsed.has(key);
      const section = el(
        "div",
        {
          class: `sorter-section ${folded ? "collapsed" : ""}`,
          role: "group",
          "aria-label": group.name,
          "data-section": String(gi),
        },
        el(
          "div",
          {
            class: "sorter-section-head",
            oncontextmenu: (e) => {
              e.preventDefault();
              sectionMenu(e, gi);
            },
          },
          el(
            "button",
            {
              type: "button",
              class: "sorter-toggle",
              "aria-expanded": String(!folded),
              "data-section": String(gi),
              onclick: () => toggleSection(key),
              ondblclick: (e) => {
                e.preventDefault();
                rename(gi);
              },
            },
            icon(folded ? "ChevronRight" : "ChevronDown", 14),
            el("span", { class: "sorter-section-name" }, group.name),
            el(
              "span",
              { class: "sorter-section-count" },
              `(${group.slides.length} ${group.slides.length === 1 ? "slide" : "slides"})`,
            ),
          ),
          el(
            "button",
            {
              type: "button",
              class: "sorter-section-menu icon-btn",
              "aria-label": `Options for section ${group.name}`,
              "aria-haspopup": "menu",
              onclick: (e) => sectionMenu(e, gi),
            },
            icon("MoreHorizontal", 14),
          ),
        ),
        folded ? null : list,
      );
      return section;
    });
    grid.replaceChildren(...nodes);
    if (!parts.length) grid.append(el("p", { class: "muted" }, "No slides"));
    // One card takes the Tab key: the current slide's.
    for (const [part, card] of cards)
      card.tabIndex = part === current && card.isConnected ? 0 : -1;
    if (![...cards.values()].some((c) => c.tabIndex === 0 && c.isConnected))
      grid.querySelector(".sorter-card")?.setAttribute("tabindex", "0");
    if (focusedPart && cards.get(focusedPart)?.isConnected)
      cards.get(focusedPart).focus({ preventScroll: true });
    else if (focusedHead != null)
      grid
        .querySelector(`.sorter-toggle[data-section="${focusedHead}"]`)
        ?.focus({ preventScroll: true });
    for (const part of visible) paint(part);
  }

  function makeCard(part) {
    const img = el("img", { alt: "", draggable: "false" });
    const card = el(
      "div",
      {
        class: "sorter-card",
        role: "option",
        "data-part": part,
        tabindex: -1,
        onpointerdown: (e) => press(e, part),
        ondblclick: () => open(part),
        oncontextmenu: (e) => {
          e.preventDefault();
          if (!ctx.selectedParts().has(part)) select(part, {});
          cardMenu(e, part);
        },
      },
      el("div", { class: "sorter-thumb" }, img),
      el(
        "div",
        { class: "sorter-meta" },
        el("span", { class: "sorter-number" }),
        el("span", { class: "sorter-markers" }),
      ),
    );
    cards.set(part, card);
    observer.observe(img);
    return card;
  }
  function updateCard(card, s, i, chosen, current) {
    const hidden = P.isSlideHidden(s);
    card.classList.toggle("selected", chosen);
    card.classList.toggle("current", current);
    card.classList.toggle("hidden-slide", hidden);
    card.setAttribute("aria-selected", String(chosen));
    card.setAttribute("aria-label", ctx.slideLabel(s, i));
    card.querySelector(".sorter-number").textContent = String(i + 1);
    const markers = ctx.markers(s);
    const box = card.querySelector(".sorter-markers");
    const want = [
      markers.transition && [
        "transition",
        "o:previewTransition",
        "Has a transition",
      ],
      markers.animation && ["animation", "o:addAnimation", "Has animations"],
    ].filter(Boolean);
    const have = [...box.children].map((n) => n.dataset.marker).join();
    if (have !== want.map((w) => w[0]).join())
      box.replaceChildren(
        ...want.map(([kind, name, label]) =>
          el(
            "span",
            {
              class: "sorter-marker",
              "data-marker": kind,
              title: label,
              role: "img",
              "aria-label": label,
            },
            icon(name, 12),
          ),
        ),
      );
  }

  // Selection follows the editor's: the current slide and the others
  // chosen with it.
  function select(part, { shift = false, toggle = false }) {
    const parts = order();
    const chosen = ctx.selectedParts();
    if (shift) {
      const from = parts.indexOf(
        anchorPart || P.getSlidePartName(ctx.currentSlide()),
      );
      const to = parts.indexOf(part);
      const range = parts.slice(Math.min(from, to), Math.max(from, to) + 1);
      return ctx.choose(
        part,
        range.filter((p) => p !== part),
      );
    }
    anchorPart = part;
    if (toggle) {
      if (chosen.has(part) && chosen.size > 1) {
        const rest = [...chosen].filter((p) => p !== part);
        return ctx.choose(rest[0], rest.slice(1));
      }
      return ctx.choose(
        part,
        [...chosen].filter((p) => p !== part),
      );
    }
    return ctx.choose(part, []);
  }
  function open(part) {
    ctx.choose(part, []).then(() => ctx.setView("normal"));
  }
  const selectedSlides = () => {
    const chosen = ctx.selectedParts();
    return slides().filter((s) => chosen.has(P.getSlidePartName(s)));
  };

  // A press selects; moving the pointer far enough drags the selection.
  function press(e, part) {
    if (e.button !== 0) {
      return;
    }
    const card = e.currentTarget;
    card.focus({ preventScroll: true });
    const chosen = ctx.selectedParts();
    const modifier = e.shiftKey || e.ctrlKey || e.metaKey;
    // A selected slide pressed without a modifier may be the start of a
    // drag of the whole selection; the selection narrows on release.
    if (modifier || !chosen.has(part))
      select(part, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
    if (e.pointerType === "touch") return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let drop = null;
    let indicator = null;
    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 6)
          return;
        dragging = true;
        card.setPointerCapture(ev.pointerId);
        grid.classList.add("reordering");
        indicator = el("div", { class: "sorter-drop", "aria-hidden": "true" });
        grid.append(indicator);
        for (const p of ctx.selectedParts())
          cards.get(p)?.classList.add("dragging");
      }
      drop = place(ev, indicator);
      autoScroll(ev);
    };
    const finish = (apply) => {
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", up);
      card.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", escape, true);
      if (!dragging) {
        if (apply && !modifier && chosen.has(part) && chosen.size > 1)
          select(part, {});
        return;
      }
      grid?.classList.remove("reordering");
      indicator?.remove();
      for (const c of cards.values()) c.classList.remove("dragging");
      if (apply && drop) moveSelection(drop);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const escape = (ev) => {
      if (ev.key === "Escape" && dragging) {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", up);
    card.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", escape, true);
  }
  function autoScroll(ev) {
    const r = host.getBoundingClientRect();
    if (ev.clientY < r.top + 40) host.scrollTop -= 12;
    else if (ev.clientY > r.bottom - 40) host.scrollTop += 12;
  }
  // Where a drop at the pointer lands: before a card, at the end of a
  // section's row, or at the start of a section whose header it is over.
  function place(ev, indicator) {
    const gridRect = grid.getBoundingClientRect();
    const head = document
      .elementFromPoint(ev.clientX, ev.clientY)
      ?.closest(".sorter-section-head");
    const groups = groupSlides(order(), sections());
    if (head) {
      const section = Number(head.closest(".sorter-section").dataset.section);
      const r = head.getBoundingClientRect();
      Object.assign(indicator.style, {
        left: `${r.left - gridRect.left}px`,
        top: `${r.bottom - gridRect.top}px`,
        width: `${r.width}px`,
        height: "3px",
      });
      return { section, before: groups[section]?.slides[0] ?? null };
    }
    // The nearest card, by its row first.
    let best = null;
    for (const [part, card] of cards) {
      if (!card.isConnected) continue;
      const r = card.getBoundingClientRect();
      const dy =
        ev.clientY < r.top
          ? r.top - ev.clientY
          : Math.max(0, ev.clientY - r.bottom);
      const dx = Math.abs(ev.clientX - (r.left + r.width / 2));
      const score = dy * 10 + dx;
      if (!best || score < best.score) best = { part, card, r, score };
    }
    if (!best) return null;
    const after = ev.clientX > best.r.left + best.r.width / 2;
    const section = groups.findIndex((g) => g.slides.includes(best.part));
    const slidesIn = groups[section].slides;
    const before = after
      ? (slidesIn[slidesIn.indexOf(best.part) + 1] ?? null)
      : best.part;
    const x = after ? best.r.right + 4 : best.r.left - 6;
    Object.assign(indicator.style, {
      left: `${x - gridRect.left}px`,
      top: `${best.r.top - gridRect.top}px`,
      width: "3px",
      height: `${best.r.height}px`,
    });
    return { section: Math.max(0, section), before };
  }
  function moveSelection(target) {
    const moving = ctx.selectedParts();
    const plan = moveSlidesTo(order(), sections(), moving, target);
    if (!plan) return;
    return apply(plan);
  }
  // Puts the deck in a planned order and section list, as one edit.
  function apply(plan, { remove = [] } = {}) {
    const current = P.getSlidePartName(ctx.currentSlide());
    return ctx.mutate(() => {
      const p = pres();
      for (const part of remove) {
        const s = P.getSlides(p).find((x) => P.getSlidePartName(x) === part);
        if (s && P.getSlides(p).length > 1) P.removeSlide(p, s);
      }
      plan.order.forEach((part, i) => {
        const list = P.getSlides(p);
        const s = list.find((x) => P.getSlidePartName(x) === part);
        if (s && list.indexOf(s) !== i) P.moveSlide(p, s, i);
      });
      const byPart = new Map(
        P.getSlides(p).map((s) => [P.getSlidePartName(s), s]),
      );
      if (plan.sections.length || P.getSlideSections(p).length)
        P.setSlideSections(
          p,
          plan.sections.map((sec) => ({
            name: sec.name,
            slides: sec.slides.map((x) => byPart.get(x)).filter(Boolean),
          })),
        );
      ctx.settle([current, ...plan.order]);
    });
  }

  function toggleSection(key) {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    ctx.saveSettings({ collapsedSections: [...collapsed] });
    refresh();
  }
  function setAllCollapsed(on) {
    const secs = sections();
    collapsed = new Set(on ? secs.map(sectionKey) : []);
    ctx.saveSettings({ collapsedSections: [...collapsed] });
    refresh();
  }
  async function rename(i) {
    const sec = groupSlides(order(), sections())[i];
    if (!sec) return;
    const name = await promptName("Rename Section", sec.name, null, {
      confirm: "Rename",
    });
    if (!name) return;
    const plan = renameSectionAt(order(), sections(), i, name);
    if (plan) await apply(plan);
  }
  async function addSection(part) {
    const name = await promptName("Add Section", "Untitled Section", null, {
      keep: true,
      confirm: "Add",
    });
    if (!name) return;
    await apply(addSectionAt(order(), sections(), part, name));
  }
  function removeSection(i, withSlides) {
    const plan = removeSectionAt(order(), sections(), i, { withSlides });
    if (!plan) return;
    if (withSlides && plan.removed.length >= order().length) {
      ctx.toast("Keep at least one slide in your presentation.");
      return;
    }
    return apply(plan, { remove: plan.removed });
  }

  function sectionMenu(e, i) {
    const secs = sections();
    const items = [
      {
        label: "Rename Section…",
        icon: "Pencil",
        onSelect: () => rename(i).catch(ctx.fail),
      },
      {
        label: "Remove Section",
        icon: "Trash2",
        onSelect: () => removeSection(i, false),
      },
      {
        label: "Remove Section & Slides",
        icon: "Trash2",
        danger: true,
        onSelect: () => removeSection(i, true),
      },
      {
        label: "Remove All Sections",
        icon: "Trash2",
        onSelect: () => apply({ order: order(), sections: [] }),
      },
      { separator: true },
      {
        label: "Move Section Up",
        icon: "ArrowUp",
        disabled: i === 0,
        onSelect: () => {
          const plan = moveSectionBy(order(), secs, i, -1);
          if (plan) apply(plan);
        },
      },
      {
        label: "Move Section Down",
        icon: "ArrowDown",
        disabled: i >= secs.length - 1,
        onSelect: () => {
          const plan = moveSectionBy(order(), secs, i, 1);
          if (plan) apply(plan);
        },
      },
      { separator: true },
      {
        label: "Collapse All",
        icon: "ChevronUp",
        onSelect: () => setAllCollapsed(true),
      },
      {
        label: "Expand All",
        icon: "ChevronDown",
        onSelect: () => setAllCollapsed(false),
      },
    ];
    openMenu(
      e.type === "contextmenu"
        ? {
            x: e.clientX,
            y: e.clientY,
            contextual: true,
            label: "Section",
            items,
          }
        : { anchor: e.currentTarget, label: "Section", items },
    );
  }
  function cardMenu(e, part) {
    const group = selectedSlides();
    const noun = group.length > 1 ? `${group.length} Slides` : "Slide";
    const allHidden = group.every((s) => P.isSlideHidden(s));
    const groups = groupSlides(order(), sections());
    const si = groups.findIndex((g) => g.slides.includes(part));
    const inSection = sections().length > 0;
    openMenu({
      x: e.clientX,
      y: e.clientY,
      contextual: true,
      label: "Slide",
      items: [
        {
          label: "Open in Normal View",
          icon: "o:normalView",
          onSelect: () => open(part),
        },
        { separator: true },
        {
          label: "New Slide",
          icon: "o:newSlide",
          onSelect: () => ctx.addSlideAfter(slideOf(part)),
        },
        {
          label: `Duplicate ${noun}`,
          icon: "Copy",
          onSelect: () => ctx.duplicateSlides(group),
        },
        {
          label: `${allHidden ? "Show" : "Hide"} ${noun}`,
          icon: allHidden ? "Eye" : "EyeOff",
          onSelect: () => ctx.setSlidesHidden(group, !allHidden),
        },
        {
          label: `Delete ${noun}`,
          icon: "Trash2",
          danger: true,
          onSelect: () => ctx.deleteSlides(group),
        },
        { separator: true },
        {
          label: "Add Section",
          icon: "o:section",
          onSelect: () => addSection(part).catch(ctx.fail),
        },
        inSection && {
          label: "Rename Section…",
          icon: "Pencil",
          onSelect: () => rename(si).catch(ctx.fail),
        },
        inSection && {
          label: "Remove Section",
          icon: "Trash2",
          onSelect: () => removeSection(si, false),
        },
      ].filter(Boolean),
    });
  }
  function backgroundMenu(e) {
    const last = slides().at(-1);
    openMenu({
      x: e.clientX,
      y: e.clientY,
      contextual: true,
      label: "Slides",
      items: [
        {
          label: "New Slide",
          icon: "o:newSlide",
          onSelect: () => ctx.addSlideAfter(last),
        },
        {
          label: "Add Section",
          icon: "o:section",
          onSelect: () =>
            addSection(P.getSlidePartName(ctx.currentSlide())).catch(ctx.fail),
        },
      ],
    });
  }

  // Arrow keys move through the cards (Up and Down by rows), Shift extends
  // the selection, Alt with an arrow moves the selected slides, Enter opens
  // the slide, and Delete removes the selection.
  function keydown(e) {
    const card = e.target.closest?.(".sorter-card");
    if (!card) return;
    const part = card.dataset.part;
    const all = [...grid.querySelectorAll(".sorter-card")];
    const i = all.indexOf(card);
    const mod = e.ctrlKey || e.metaKey;
    const go = (j, extend) => {
      const target = all[Math.max(0, Math.min(all.length - 1, j))];
      if (!target) return;
      e.preventDefault();
      if (e.altKey && !extend) return;
      target.focus();
      target.scrollIntoView({ block: "nearest" });
      if (extend) select(target.dataset.part, { shift: true });
      else if (!mod) select(target.dataset.part, {});
    };
    const columns = () => {
      const top = card.getBoundingClientRect().top;
      return Math.max(
        1,
        all.filter(
          (c) =>
            c.parentElement === card.parentElement &&
            Math.abs(c.getBoundingClientRect().top - top) < 2,
        ).length,
      );
    };
    if (
      e.altKey &&
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
    ) {
      e.preventDefault();
      const step = ["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 1;
      ctx.moveSlides(selectedSlides(), step);
      return;
    }
    switch (e.key) {
      case "ArrowLeft":
        return go(i - 1, e.shiftKey);
      case "ArrowRight":
        return go(i + 1, e.shiftKey);
      case "ArrowUp":
        return go(i - columns(), e.shiftKey);
      case "ArrowDown":
        return go(i + columns(), e.shiftKey);
      case "Home":
        return go(0, e.shiftKey);
      case "End":
        return go(all.length - 1, e.shiftKey);
      case " ":
        e.preventDefault();
        select(part, { toggle: mod });
        return;
      case "Enter":
        e.preventDefault();
        open(part);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        ctx.deleteSlides(selectedSlides());
        return;
      case "ContextMenu": {
        e.preventDefault();
        const r = card.getBoundingClientRect();
        cardMenu({ clientX: r.left + 20, clientY: r.top + 20 }, part);
        return;
      }
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      const parts = order();
      ctx.choose(
        part,
        parts.filter((p) => p !== part),
      );
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      ctx.duplicateSlides(selectedSlides());
    }
  }

  // The sorter's own zoom, from the status bar and the Zoom dialog.
  const zoomControl = {
    factor: () => zoom,
    isFit: () => false,
    setting: () => zoom,
    steps: SORTER_STEPS,
    set(next) {
      zoom =
        next === "fit" ? 1 : Math.min(3, Math.max(0.33, Number(next) || 1));
      ctx.saveSettings({ sorterZoom: zoom });
      applyZoom();
    },
  };

  return { enter, leave, refresh, zoom: zoomControl, addSection };
}
