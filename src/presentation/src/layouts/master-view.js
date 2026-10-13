// Master views: Slide Master, Notes Master and Handout Master.
//
// In a master view the editor's canvas edits a slide master, one of its
// layouts, the notes master or the handout master instead of a slide. The
// canvas works on an editing view of that part (P.getTemplateSlide), so the
// selection, text editing, formatting and arrangement the editor already has
// all apply, and every slide that inherits from the part follows the edit.
// This module owns which part is open, the pane that lists the masters and
// their layouts, and the contextual ribbon tab of each view.
import { el, dialog, openMenu, toast } from "../ui.js";
import { P } from "../model.js";
import { templateThumb } from "./gallery.js";
import "./icons.js";
import "./layouts.css";

const KINDS = {
  slide: { view: "slideMaster", label: "Slide Master", tab: "slide-master" },
  notes: { view: "notesMaster", label: "Notes Master", tab: "notes-master" },
  handout: {
    view: "handoutMaster",
    label: "Handout Master",
    tab: "handout-master",
  },
};

const PLACEHOLDER_KINDS = [
  ["content", "Content", "o:insertPlaceholder"],
  ["contentVertical", "Content (Vertical)", "o:insertPlaceholder"],
  ["text", "Text", "o:textBox"],
  ["textVertical", "Text (Vertical)", "o:textDirection"],
  ["picture", "Picture", "o:picture"],
  ["chart", "Chart", "o:chartColumn"],
  ["table", "Table", "o:table"],
  ["smartArt", "SmartArt", "o:smartArt"],
  ["media", "Media", "o:video"],
];

export function createMasterView(host) {
  // host: {
  //   pres(), mutate(fn), skip,
  //   currentSlide(),            the slide normal view shows
  //   setView(id),               switch the editor's view
  //   render(),                  draw the canvas and pane again
  //   clearSelection(), selectShape(id),
  //   commitText(), ribbon(),
  // }
  let mode = null; // "slide" | "notes" | "handout"
  let target = null; // the open part, in Slide Master view
  let handoutSlots = 6;

  const pres = () => host.pres();

  function allTemplateParts() {
    return P.getSlideMasters(pres()).flatMap((m) => [
      m.partName,
      ...m.layouts.map((l) => l.partName),
    ]);
  }

  function targetPart() {
    if (!mode) return null;
    if (mode === "notes") return P.getNotesMasterPartName(pres());
    if (mode === "handout") return P.getHandoutMasterPartName(pres());
    const parts = allTemplateParts();
    if (target && parts.includes(target)) return target;
    target = parts[0] || null;
    return target;
  }

  function slide() {
    const part = targetPart();
    return part ? P.getTemplateSlide(pres(), part) : null;
  }

  function enter(kind) {
    if (!KINDS[kind]) return;
    host.commitText();
    if (kind === "slide") {
      const layout = P.getSlideLayout(host.currentSlide());
      target = layout ? P.getSlideLayoutPartName(layout) : null;
    }
    const create =
      kind === "notes"
        ? !P.getNotesMasterPartName(pres())
        : kind === "handout"
          ? !P.getHandoutMasterPartName(pres())
          : false;
    mode = kind;
    host.clearSelection();
    // A presentation without a notes or handout master gets one, as an
    // ordinary edit that undo takes back.
    if (create)
      host.mutate(() => {
        if (kind === "notes") P.ensureNotesMaster(pres());
        else P.ensureHandoutMaster(pres());
      });
    queueMicrotask(() => host.ribbon()?.select(KINDS[kind].tab));
  }

  function leave() {
    mode = null;
    host.clearSelection();
  }

  function close() {
    host.setView("normal");
  }

  function choose(part) {
    if (part === target) return;
    host.commitText();
    target = part;
    host.clearSelection();
    host.render();
    requestAnimationFrame(() =>
      document
        .querySelector(
          `.master-pane-item[data-part="${CSS.escape(part)}"] .master-pane-thumb`,
        )
        ?.focus({ preventScroll: false }),
    );
  }

  // ---- Structure commands ------------------------------------------------

  const entryOf = (part = targetPart()) => {
    for (const m of P.getSlideMasters(pres())) {
      if (m.partName === part) return { kind: "master", master: m, entry: m };
      const layout = m.layouts.find((l) => l.partName === part);
      if (layout) return { kind: "layout", master: m, entry: layout };
    }
    return null;
  };

  function insertSlideMaster() {
    host.commitText();
    const after = entryOf()?.master.partName || null;
    host.mutate(() => {
      target = P.addSlideMaster(pres(), { after });
      host.clearSelection();
    });
  }

  function insertLayout() {
    host.commitText();
    const info = entryOf();
    if (!info) return;
    const after = info.kind === "layout" ? info.entry.partName : null;
    host.mutate(() => {
      target = P.addSlideLayout(pres(), info.master.partName, {
        name: uniqueName("Custom Layout"),
        after,
      });
      host.clearSelection();
    });
  }

  function uniqueName(base) {
    const taken = new Set(
      P.getSlideMasters(pres()).flatMap((m) => [
        m.name,
        ...m.layouts.map((l) => l.name),
      ]),
    );
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  function canDelete(part = targetPart()) {
    const info = entryOf(part);
    if (!info) return false;
    if (info.kind === "layout")
      return info.entry.slideCount === 0 && info.master.layouts.length > 1;
    return info.master.slideCount === 0 && P.getSlideMasters(pres()).length > 1;
  }

  function deleteTarget(part = targetPart()) {
    const info = entryOf(part);
    if (!info) return;
    if (!canDelete(part)) {
      toast(
        info.kind === "layout"
          ? info.entry.slideCount
            ? "This layout is used by slides, so it can't be deleted."
            : "A slide master needs at least one layout."
          : info.master.slideCount
            ? "This slide master is used by slides, so it can't be deleted."
            : "A presentation needs at least one slide master.",
      );
      return;
    }
    host.commitText();
    const masters = P.getSlideMasters(pres());
    host.mutate(() => {
      if (info.kind === "layout") {
        const list = info.master.layouts;
        const at = list.findIndex((l) => l.partName === part);
        P.deleteSlideLayout(pres(), part);
        target =
          list[at + 1]?.partName ||
          list[at - 1]?.partName ||
          info.master.partName;
      } else {
        const at = masters.findIndex((m) => m.partName === part);
        P.deleteSlideMaster(pres(), part);
        target = (masters[at + 1] || masters[at - 1])?.partName || null;
      }
      host.clearSelection();
    });
  }

  function duplicateTarget(part = targetPart()) {
    const info = entryOf(part);
    if (!info) return;
    host.commitText();
    host.mutate(() => {
      target =
        info.kind === "layout"
          ? P.duplicateSlideLayout(pres(), part)
          : P.duplicateSlideMaster(pres(), part);
      host.clearSelection();
    });
  }

  async function renameTarget(part = targetPart()) {
    const info = entryOf(part);
    if (!info) return;
    const noun = info.kind === "layout" ? "Layout" : "Master";
    const input = el("input", {
      class: "input",
      autofocus: true,
      value: info.entry.name,
      maxlength: 120,
      "aria-label": `${noun} name`,
    });
    const answer = dialog({
      title: `Rename ${noun}`,
      body: el(
        "form",
        { class: "dialog-body" },
        el("label", {}, `${noun} name`, input),
      ),
      confirm: "Rename",
    });
    input.select();
    const ok = await answer;
    const name = input.value.trim();
    if (!ok || !name || name === info.entry.name) return;
    host.mutate(() => P.renameTemplate(pres(), part, name));
  }

  function togglePreserve(part = targetPart()) {
    const info = entryOf(part);
    if (!info) return;
    host.mutate(() =>
      P.setTemplatePreserved(pres(), part, !info.entry.preserve),
    );
  }

  // ---- Placeholders ------------------------------------------------------

  function insertPlaceholder(kind = "content") {
    const view = slide();
    if (!view || P.getTemplateKind(view) !== "layout") return;
    host.commitText();
    const size = P.getTemplatePageSize(pres(), view);
    const part = targetPart();
    host.mutate(() => {
      const fresh = P.getTemplateSlide(pres(), part);
      const shape = P.insertTemplatePlaceholder(fresh, kind, {
        x: Math.round(size.cx * 0.25),
        y: Math.round(size.cy * 0.3),
        w: Math.round(size.cx * 0.5),
        h: Math.round(size.cy * 0.45),
      });
      host.selectShape(P.getShapeId(shape));
    });
  }

  const hasSlot = (slot) => {
    const view = slide();
    return !!view && P.hasTemplatePlaceholder(view, slot);
  };

  function setSlot(slots, on) {
    const part = targetPart();
    if (!part) return;
    host.commitText();
    host.mutate(() => {
      const view = P.getTemplateSlide(pres(), part);
      const before = P.getSlideXmlString(view);
      for (const slot of slots)
        P.setTemplatePlaceholder(pres(), view, slot, on);
      host.clearSelection();
      return P.getSlideXmlString(view) === before ? host.skip : undefined;
    });
  }

  const FOOTER_SLOTS = ["date", "footer", "slideNumber"];
  const footersOn = () => FOOTER_SLOTS.some(hasSlot);

  const isLayout = () => entryOf()?.kind === "layout";
  const isMaster = () => entryOf()?.kind === "master";

  function hidesBackgroundGraphics() {
    const view = slide();
    if (!view || P.getTemplateKind(view) !== "layout") return false;
    return /<p:sldLayout\b[^>]*\bshowMasterSp="(0|false)"/.test(
      P.getSlideXmlString(view),
    );
  }

  function setHideBackgroundGraphics(on) {
    const part = targetPart();
    if (!isLayout()) return;
    host.mutate(() => {
      const view = P.getTemplateSlide(pres(), part);
      P.setTemplateShowsMasterShapes(view, !on);
    });
  }

  // ---- Notes and handout pages ------------------------------------------

  const orientation = () => {
    const size = P.getNotesPageSize(pres());
    return size.cx > size.cy ? "landscape" : "portrait";
  };
  function setOrientation(value) {
    if (orientation() === value) return;
    host.mutate(() => P.setNotesPageOrientation(pres(), value));
  }

  // ---- The pane ----------------------------------------------------------

  function describeLayout(layout) {
    const name = layout.name || "Custom Layout";
    if (!layout.slideCount) return `${name} layout: not used by any slide`;
    const numbers = [];
    P.getSlides(pres()).forEach((s, i) => {
      const l = P.getSlideLayout(s);
      if (l && P.getSlideLayoutPartName(l) === layout.partName)
        numbers.push(i + 1);
    });
    return `${name} layout: used by slide${numbers.length > 1 ? "s" : ""} ${numbers.join(", ")}`;
  }

  function paneItem({ part, kind, number, label, description, badge }) {
    const active = part === targetPart();
    const thumb = el(
      "button",
      {
        type: "button",
        class: "master-pane-thumb",
        "aria-label": description,
        "aria-current": active ? "true" : null,
        title: description,
        onclick: () => choose(part),
        oncontextmenu: (e) => {
          e.preventDefault();
          choose(part);
          paneMenu(e.currentTarget, part, { x: e.clientX, y: e.clientY });
        },
      },
      templateThumb(pres(), part, { frames: true }),
      badge && el("span", { class: "master-pane-badge" }, badge),
    );
    return el(
      "div",
      {
        class: `master-pane-item ${kind} ${active ? "active" : ""}`,
        "data-part": part,
      },
      el(
        "span",
        { class: "master-pane-number", "aria-hidden": "true" },
        number ?? "",
      ),
      thumb,
      el("span", { class: "sr-only" }, label),
    );
  }

  function paneMenu(anchor, part, at = null) {
    const info = entryOf(part);
    if (!info) return;
    const layout = info.kind === "layout";
    openMenu({
      anchor,
      ...(at ? { x: at.x, y: at.y, contextual: true } : {}),
      label: layout ? "Layout options" : "Master options",
      items: [
        {
          label: "Insert Slide Master",
          icon: "o:insertSlideMaster",
          onSelect: insertSlideMaster,
        },
        {
          label: "Insert Layout",
          icon: "o:insertLayout",
          onSelect: insertLayout,
        },
        { separator: true },
        {
          label: layout ? "Duplicate Layout" : "Duplicate Slide Master",
          icon: "o:duplicateLayout",
          onSelect: () => duplicateTarget(part),
        },
        {
          label: layout ? "Delete Layout" : "Delete Master",
          icon: "o:deleteLayout",
          disabled: !canDelete(part),
          onSelect: () => deleteTarget(part),
        },
        {
          label: layout ? "Rename Layout…" : "Rename Master…",
          icon: "o:renameLayout",
          onSelect: () => renameTarget(part),
        },
        {
          label: "Preserve",
          checked: info.entry.preserve,
          onSelect: () => togglePreserve(part),
        },
      ],
    });
  }

  function renderPane(list) {
    const pane = el("div", {
      class: "master-pane",
      role: "list",
      "aria-label": KINDS[mode].label,
    });
    if (mode === "slide") {
      P.getSlideMasters(pres()).forEach((master, i) => {
        pane.append(
          paneItem({
            part: master.partName,
            kind: "master",
            number: i + 1,
            label: master.name,
            description: `${master.name} slide master${master.slideCount ? `: used by ${master.slideCount} slide${master.slideCount > 1 ? "s" : ""}` : ""}`,
            badge: master.preserve ? "Preserved" : null,
          }),
        );
        for (const layout of master.layouts)
          pane.append(
            paneItem({
              part: layout.partName,
              kind: "layout",
              label: layout.name,
              description: describeLayout(layout),
            }),
          );
      });
    } else {
      const part = targetPart();
      if (part)
        pane.append(
          paneItem({
            part,
            kind: "master",
            number: 1,
            label: KINDS[mode].label,
            description: KINDS[mode].label,
          }),
        );
    }
    for (const item of pane.children) item.setAttribute("role", "listitem");
    pane.addEventListener("keydown", paneKey);
    list.replaceChildren(pane);
    list
      .querySelector(".master-pane-item.active")
      ?.scrollIntoView({ block: "nearest" });
  }

  function paneKey(e) {
    const thumbs = [...e.currentTarget.querySelectorAll(".master-pane-thumb")];
    const at = thumbs.indexOf(document.activeElement);
    if (at < 0) return;
    const parts = [
      ...e.currentTarget.querySelectorAll(".master-pane-item"),
    ].map((n) => n.dataset.part);
    const go = (i) => {
      const next = parts[Math.max(0, Math.min(parts.length - 1, i))];
      if (next) choose(next);
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(parts.length - 1);
    else if ((e.key === "Delete" || e.key === "Backspace") && mode === "slide")
      deleteTarget(parts[at]);
    else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))
      paneMenu(thumbs[at], parts[at]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // ---- Canvas extras -----------------------------------------------------

  /** The handout master shows where slides go on the printed page. */
  function decorateCanvas(canvas) {
    canvas.querySelector(".handout-slots")?.remove();
    if (mode !== "handout") return;
    const layer = el("div", { class: "handout-slots", "aria-hidden": "true" });
    const page = P.getNotesPageSize(pres());
    const slideSize = P.getSlideSize(pres());
    const ratio =
      Number(slideSize?.height || 6858000) /
      Number(slideSize?.width || 12192000);
    const cols = handoutSlots <= 3 ? 1 : handoutSlots <= 6 ? 2 : 3;
    const rows = Math.ceil(handoutSlots / cols);
    const top = 0.1,
      bottom = 0.1,
      side = 0.08;
    const cellW = (1 - 2 * side) / cols;
    const cellH = (1 - top - bottom) / rows;
    for (let i = 0; i < handoutSlots; i++) {
      const c = i % cols,
        r = Math.floor(i / cols);
      let w = cellW * 0.86;
      let h = (w * page.cx * ratio) / page.cy;
      if (h > cellH * 0.86) {
        h = cellH * 0.86;
        w = (h * page.cy) / (page.cx * ratio);
      }
      const x = side + c * cellW + (cellW - w) / 2;
      const y = top + r * cellH + (cellH - h) / 2;
      layer.append(
        el("span", {
          style: `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%`,
        }),
      );
    }
    canvas.append(layer);
  }

  // ---- Ribbon tabs -------------------------------------------------------

  const closeGroup = {
    id: "master-close",
    label: "Close",
    icon: "closeMasterView",
    items: [
      {
        type: "large",
        id: "close-master-view",
        label: "Close Master\nView",
        icon: "closeMasterView",
        title: "Close Master View",
        description: "Go back to editing slides.",
        run: close,
      },
    ],
  };

  function slideMasterTab() {
    return {
      id: KINDS.slide.tab,
      label: "Slide Master",
      contextual: true,
      visible: () => mode === "slide",
      groups: [
        {
          id: "edit-master",
          label: "Edit Master",
          icon: "insertSlideMaster",
          items: [
            {
              type: "large",
              id: "insert-slide-master",
              label: "Insert Slide\nMaster",
              icon: "insertSlideMaster",
              title: "Insert Slide Master",
              description:
                "Add a new slide master, with its own theme and set of layouts.",
              run: insertSlideMaster,
            },
            {
              type: "large",
              id: "insert-layout",
              label: "Insert\nLayout",
              icon: "insertLayout",
              title: "Insert Layout",
              description:
                "Add a custom layout to this master. Add placeholders to make it your own.",
              run: insertLayout,
            },
            {
              type: "stack",
              items: [
                {
                  type: "small",
                  id: "delete-layout",
                  label: "Delete",
                  icon: "deleteLayout",
                  title: "Delete",
                  description:
                    "Delete this layout or master. Layouts that slides use stay.",
                  enabled: () => canDelete(),
                  run: () => deleteTarget(),
                },
                {
                  type: "small",
                  id: "rename-layout",
                  label: "Rename",
                  icon: "renameLayout",
                  title: "Rename",
                  enabled: () => !!entryOf(),
                  run: () => renameTarget(),
                },
                {
                  type: "small",
                  id: "duplicate-layout",
                  label: "Duplicate",
                  icon: "duplicateLayout",
                  title: "Duplicate",
                  enabled: () => !!entryOf(),
                  run: () => duplicateTarget(),
                },
                {
                  type: "toggle",
                  id: "preserve-layout",
                  label: "Preserve",
                  showLabel: true,
                  icon: "preserveLayout",
                  title: "Preserve",
                  description:
                    "Keep this layout or master in the file even when no slide uses it.",
                  enabled: () => !!entryOf(),
                  pressed: () => !!entryOf()?.entry.preserve,
                  run: () => togglePreserve(),
                },
              ],
            },
          ],
        },
        {
          id: "master-layout",
          label: "Master Layout",
          icon: "masterLayout",
          items: [
            {
              type: "large",
              id: "master-layout-elements",
              label: "Master\nLayout",
              icon: "masterLayout",
              title: "Master Layout",
              description:
                "Choose which placeholders the slide master has: title, text, date, slide number and footer.",
              enabled: () => isMaster(),
              menu: () =>
                [
                  ["title", "Title"],
                  ["body", "Text"],
                  ["date", "Date"],
                  ["slideNumber", "Slide Number"],
                  ["footer", "Footer"],
                ].map(([slot, label]) => ({
                  label,
                  checked: hasSlot(slot),
                  onSelect: () => setSlot([slot], !hasSlot(slot)),
                })),
              menuLabel: "Master placeholders",
            },
            {
              type: "large",
              id: "insert-placeholder",
              label: "Insert\nPlaceholder",
              icon: "insertPlaceholder",
              title: "Insert Placeholder",
              description:
                "Add a placeholder to the layout for content, text, a picture, a chart, a table and more.",
              split: true,
              enabled: () => isLayout(),
              run: () => insertPlaceholder("content"),
              menu: () =>
                PLACEHOLDER_KINDS.map(([kind, label, icon]) => ({
                  label,
                  icon,
                  onSelect: () => insertPlaceholder(kind),
                })),
              menuLabel: "Placeholder kinds",
            },
            {
              type: "stack",
              items: [
                {
                  type: "check",
                  id: "layout-title",
                  label: "Title",
                  enabled: () => isLayout(),
                  checked: () => hasSlot("title"),
                  commit: (on) => setSlot(["title"], on),
                },
                {
                  type: "check",
                  id: "layout-footers",
                  label: "Footers",
                  enabled: () => isLayout(),
                  checked: () => footersOn(),
                  commit: (on) => setSlot(FOOTER_SLOTS, on),
                },
              ],
            },
          ],
        },
        {
          id: "master-background",
          label: "Background",
          icon: "hideBackgroundGraphics",
          items: [
            {
              type: "check",
              id: "hide-background-graphics",
              label: "Hide Background Graphics",
              enabled: () => isLayout(),
              checked: () => hidesBackgroundGraphics(),
              commit: (on) => setHideBackgroundGraphics(on),
            },
          ],
        },
        closeGroup,
      ],
    };
  }

  function pageTab(kind) {
    const notes = kind === "notes";
    const slots = notes
      ? [
          ["header", "Header"],
          ["slideImage", "Slide Image"],
          ["footer", "Footer"],
          ["date", "Date"],
          ["body", "Body"],
          ["slideNumber", "Page Number"],
        ]
      : [
          ["header", "Header"],
          ["footer", "Footer"],
          ["date", "Date"],
          ["slideNumber", "Page Number"],
        ];
    const check = ([slot, label]) => ({
      type: "check",
      id: `${kind}-${slot}`,
      label,
      checked: () => hasSlot(slot),
      commit: (on) => setSlot([slot], on),
    });
    const half = Math.ceil(slots.length / 2);
    return {
      id: KINDS[kind].tab,
      label: KINDS[kind].label,
      contextual: true,
      visible: () => mode === kind,
      groups: [
        {
          id: `${kind}-page-setup`,
          label: "Page Setup",
          icon: "pageOrientation",
          items: [
            {
              type: "large",
              id: `${kind}-orientation`,
              label: notes ? "Notes Page\nOrientation" : "Handout\nOrientation",
              icon: "pageOrientation",
              title: notes ? "Notes Page Orientation" : "Handout Orientation",
              description: "Turn the page portrait or landscape.",
              menu: () => [
                {
                  label: "Portrait",
                  checked: orientation() === "portrait",
                  onSelect: () => setOrientation("portrait"),
                },
                {
                  label: "Landscape",
                  checked: orientation() === "landscape",
                  onSelect: () => setOrientation("landscape"),
                },
              ],
              menuLabel: "Orientation",
            },
            !notes && {
              type: "large",
              id: "handout-slides-per-page",
              label: "Slides Per\nPage",
              icon: "handoutMaster",
              title: "Slides Per Page",
              description:
                "Show where slides go on a handout page with this many slides.",
              menu: () =>
                [1, 2, 3, 4, 6, 9].map((n) => ({
                  label: `${n} Slide${n > 1 ? "s" : ""}`,
                  checked: handoutSlots === n,
                  onSelect: () => {
                    handoutSlots = n;
                    host.render();
                  },
                })),
              menuLabel: "Slides per page",
            },
          ].filter(Boolean),
        },
        {
          id: `${kind}-placeholders`,
          label: "Placeholders",
          icon: "masterLayout",
          items: [
            { type: "stack", items: slots.slice(0, half).map(check) },
            { type: "stack", items: slots.slice(half).map(check) },
          ],
        },
        { ...closeGroup, id: `${kind}-close` },
      ].map((group) => ({
        ...group,
        items: group.items.map((item) =>
          item.id === "close-master-view"
            ? { ...item, id: `${kind}-close-master-view` }
            : item,
        ),
      })),
    };
  }

  // ---- Labels ------------------------------------------------------------

  function label() {
    if (!mode) return "";
    if (mode !== "slide") return KINDS[mode].label.toUpperCase();
    const info = entryOf();
    if (!info) return "SLIDE MASTER";
    return info.kind === "master"
      ? `SLIDE MASTER · ${info.entry.name}`
      : `LAYOUT · ${info.entry.name || "Custom Layout"}`;
  }

  return {
    get active() {
      return !!mode;
    },
    get mode() {
      return mode;
    },
    viewId: (kind) => KINDS[kind]?.view,
    kindOfView: (view) =>
      Object.keys(KINDS).find((k) => KINDS[k].view === view) || null,
    enter,
    leave,
    close,
    slide,
    targetPart,
    slideByPart: (part) =>
      mode && part && part === targetPart() ? slide() : null,
    pageSize: () =>
      mode === "notes" || mode === "handout"
        ? P.getNotesPageSize(pres())
        : null,
    renderPane,
    decorateCanvas,
    label,
    tabs: () => [slideMasterTab(), pageTab("notes"), pageTab("handout")],
    insertSlideMaster,
    insertLayout,
    insertPlaceholder,
    choose,
  };
}
