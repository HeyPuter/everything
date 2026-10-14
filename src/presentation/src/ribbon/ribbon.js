// The ribbon: a row of tabs over a panel of command groups, as desktop
// presentation software lays out its commands. Tabs and their commands are
// declared as plain data (src/ribbon/tabs.js); this module draws them, keeps
// them in step with the editor through refresh(), folds groups that do not
// fit into drop-downs, and gives the whole strip keyboard access.
//
// A tab:      { id, label, contextual?, visible?(), groups: [group] }
// A group:    { id, label, icon, items: [control], collapsible? }
// A control is one of (all take id, label, icon, title, keytip,
// enabled?(), visible?(), and most take run()):
//   { type: "large", menu?(), split? }   icon over a label
//   { type: "small", menu?(), split?, showLabel? }   icon beside a label
//   { type: "toggle", pressed() }        small, pressed or not
//   { type: "stack", items, rows? }      controls stacked in rows
//   { type: "row", items }               controls side by side
//   { type: "divider" }                  a thin rule between clusters
//   { type: "combo", value(), options(), commit(value), width }
//   { type: "spin", value(), commit(number), min, max, step, format(), parse() }
//   { type: "check", checked(), commit(boolean) }
//   { type: "color", color(), run(), menu() }   split button with a colour bar
//   { type: "gallery", items(), selected?(), choose(item), columns, more?(),
//     contextMenu?(item) }
//   { type: "custom", render(), sync?(node) }
import "./ribbon.css";
import { el, icon, openMenu, closeMenu } from "../ui.js";
import { commandIcon } from "../chrome/icons.js";

const glyph = (name, size) =>
  (name && commandIcon(name, size)) || (name ? icon(name, size) : null);
let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

// `focusFallback` gives the element that takes the keyboard focus when the
// control holding it is switched off by a refresh.
export function createRibbon({
  tabs,
  initial = "home",
  onTabChange,
  onCollapse,
  focusFallback = null,
} = {}) {
  let active = initial;
  let collapsed = false;
  // Each control's sync, by the tab it is on: a refresh brings the visible
  // tab up to date, and a tab is brought up to date when it is shown.
  const syncers = [];
  let buildingTab = null;
  const addSync = (fn) => syncers.push({ tab: buildingTab, fn });
  const tabButtons = new Map();
  const panels = new Map();
  const root = el("section", {
    class: "ribbon",
    "aria-label": "Ribbon",
  });
  const tablist = el("div", {
    class: "ribbon-tabs",
    role: "tablist",
    "aria-label": "Ribbon tabs",
  });
  const collapse = el(
    "button",
    {
      type: "button",
      class: "ribbon-collapse",
      "aria-label": "Collapse the ribbon",
      title: "Collapse the ribbon",
      "aria-expanded": "true",
      onclick: () => setCollapsed(!collapsed),
    },
    icon("ChevronUp", 16),
  );
  const tabRow = el("div", { class: "ribbon-tab-row" }, tablist, collapse);
  const body = el("div", { class: "ribbon-body" });
  root.append(tabRow, body);

  for (const tab of tabs) {
    const id = `ribbon-tab-${tab.id}`;
    const panelId = `ribbon-panel-${tab.id}`;
    const tabButton = el(
      "button",
      {
        type: "button",
        role: "tab",
        id,
        class: `ribbon-tab ${tab.contextual ? "contextual" : ""}`,
        "aria-selected": "false",
        "aria-controls": panelId,
        tabindex: -1,
        "data-tab": tab.id,
        onclick: () => {
          if (collapsed && active === tab.id)
            flyout(!root.classList.contains("flyout"));
          else select(tab.id, { focus: false });
        },
        ondblclick: () => setCollapsed(!collapsed),
      },
      tab.label,
    );
    tabButtons.set(tab.id, tabButton);
    tablist.append(tabButton);
    const panel = el("div", {
      class: "ribbon-panel",
      role: "tabpanel",
      id: panelId,
      "aria-labelledby": id,
      hidden: true,
      "data-tab": tab.id,
    });
    buildingTab = tab.id;
    for (const group of tab.groups) panel.append(renderGroup(group));
    buildingTab = null;
    panels.set(tab.id, panel);
    body.append(panel);
  }

  // Arrow keys move along the tabs, as a tab list is expected to; Home and
  // End go to either end, and Down steps into the commands.
  tablist.addEventListener("keydown", (e) => {
    const visible = [...tabButtons.values()].filter((b) => !b.hidden);
    const at = visible.indexOf(document.activeElement);
    if (at < 0) return;
    let next = null;
    if (e.key === "ArrowRight") next = visible[(at + 1) % visible.length];
    else if (e.key === "ArrowLeft")
      next = visible[(at - 1 + visible.length) % visible.length];
    else if (e.key === "Home") next = visible[0];
    else if (e.key === "End") next = visible[visible.length - 1];
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      firstControl(panels.get(active))?.focus();
      return;
    }
    if (!next) return;
    e.preventDefault();
    select(next.dataset.tab, { focus: true });
  });
  // Inside a panel the arrows move between commands; Up from the top row
  // goes back to the tab.
  body.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp"].includes(e.key)) return;
    if (e.target.matches("input, select, textarea")) return;
    const panel = panels.get(active);
    const all = focusables(panel);
    const at = all.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    if (e.key === "ArrowUp") {
      tabButtons.get(active)?.focus();
      return;
    }
    const step = e.key === "ArrowRight" ? 1 : -1;
    all[(at + step + all.length) % all.length]?.focus();
  });

  function focusables(panel) {
    return [
      ...panel.querySelectorAll(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
      ),
    ].filter((node) => node.offsetParent !== null);
  }
  function firstControl(panel) {
    return focusables(panel)[0];
  }

  function select(id, { focus = false } = {}) {
    if (!panels.has(id)) return;
    const changed = active !== id;
    active = id;
    for (const [tabId, button] of tabButtons) {
      const on = tabId === id;
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
    }
    for (const [tabId, panel] of panels) panel.hidden = tabId !== id;
    if (focus) tabButtons.get(id).focus();
    refresh();
    fit();
    if (changed) onTabChange?.(id);
    if (collapsed) flyout(true);
  }
  function setCollapsed(on) {
    const changed = collapsed !== on;
    collapsed = on;
    if (changed) onCollapse?.(on);
    root.classList.toggle("collapsed", on);
    root.classList.remove("flyout");
    collapse.setAttribute("aria-expanded", String(!on));
    collapse.setAttribute(
      "aria-label",
      on ? "Expand the ribbon" : "Collapse the ribbon",
    );
    collapse.title = collapse.getAttribute("aria-label");
    collapse.replaceChildren(icon(on ? "ChevronDown" : "ChevronUp", 16));
    if (!on) {
      refresh();
      fit();
    }
  }
  // A collapsed ribbon opens over the slide when a tab is chosen, and folds
  // away again once a command has run or the pointer goes elsewhere.
  function flyout(on) {
    root.classList.toggle("flyout", on);
    if (on) {
      refresh();
      fit();
    }
  }
  document.addEventListener("pointerdown", (e) => {
    if (
      root.classList.contains("flyout") &&
      !root.contains(e.target) &&
      !e.target.closest?.(".menu")
    )
      flyout(false);
  });

  // ---- Controls ----
  function renderGroup(group) {
    const content = el("div", { class: "ribbon-group-content" });
    for (const item of group.items) {
      const node = renderControl(item);
      if (node) content.append(node);
    }
    const node = el(
      "div",
      {
        class: "ribbon-group",
        role: "group",
        "aria-label": group.label,
        "data-group": group.id,
      },
      content,
    );
    // When the ribbon is too narrow the group folds into one large button
    // whose drop-down holds the group as it was.
    const folded = el(
      "button",
      {
        type: "button",
        class: "ribbon-btn ribbon-large ribbon-fold",
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
        title: group.label,
        hidden: true,
        onclick: (e) => openFold(e.currentTarget, node, content),
      },
      glyph(group.icon || "more", 32),
      el(
        "span",
        { class: "ribbon-label" },
        group.label,
        el("span", { class: "ribbon-caret", "aria-hidden": "true" }),
      ),
    );
    node.append(folded);
    if (group.visible) addSync(() => (node.hidden = !group.visible()));
    node._group = { group, content, folded };
    return node;
  }
  function openFold(anchor, node, content) {
    const pop = el("div", {
      class: "ribbon-fold-panel",
      role: "dialog",
      "aria-label": node.getAttribute("aria-label"),
    });
    pop.append(content);
    content.hidden = false;
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    // Mobile layout overflow can inflate innerWidth beyond the visible screen.
    // Match menu placement so every command remains inside the client viewport.
    pop.style.left = `${Math.max(4, Math.min(r.left, document.documentElement.clientWidth - pop.offsetWidth - 4))}px`;
    pop.style.top = `${r.bottom + 2}px`;
    anchor.setAttribute("aria-expanded", "true");
    const close = (e) => {
      if (e && (pop.contains(e.target) || e.target.closest?.(".menu"))) return;
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", onKey, true);
      node.insertBefore(content, node.firstChild);
      content.hidden = node._folded;
      pop.remove();
      anchor.setAttribute("aria-expanded", "false");
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        anchor.focus();
      }
    };
    // Escape closes the panel at once; a press outside it, from the next
    // task on, so the press that opened it does not.
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => document.addEventListener("pointerdown", close, true));
    pop.addEventListener("click", (e) => {
      if (e.target.closest("button:not([aria-haspopup])")) setTimeout(close);
    });
    firstControl(pop)?.focus();
  }

  function renderControl(item) {
    if (!item) return null;
    const make = {
      large: commandButton,
      small: commandButton,
      toggle: commandButton,
      stack: stack,
      row: row,
      divider: () => el("span", { class: "ribbon-divider", role: "separator" }),
      combo,
      spin,
      check,
      color: colorButton,
      gallery,
      custom,
      label: (i) => el("span", { class: "ribbon-text" }, i.label),
    }[item.type || "small"];
    const node = make(item);
    if (item.visible) {
      const sync = () => (node.hidden = !item.visible());
      addSync(sync);
    }
    return node;
  }
  function stack(item) {
    const node = el("div", {
      class: `ribbon-stack rows-${item.rows || item.items.length}`,
    });
    for (const child of item.items) {
      const control = renderControl(child);
      if (control) node.append(control);
    }
    return node;
  }
  function row(item) {
    const node = el("div", { class: "ribbon-row" });
    for (const child of item.items) {
      const control = renderControl(child);
      if (control) node.append(control);
    }
    return node;
  }
  // Screen tips: the command's name, its shortcut, and what it does, shown
  // after a short pause over a command, as desktop ribbons explain theirs.
  function tip(node, item) {
    if (!item.title && !item.description) return;
    node.dataset.tipTitle = item.title || item.label;
    if (item.description) node.dataset.tipText = item.description;
  }
  function commandButton(item) {
    const large = item.type === "large";
    const hasMenu = !!item.menu;
    const split = hasMenu && item.split;
    // A large command's label may say where it breaks onto its second line.
    const label = item.label.replace(/\n/g, " ");
    const shown = large ? item.label : label;
    const face = el(
      "button",
      {
        type: "button",
        class: `ribbon-btn ${large ? "ribbon-large" : "ribbon-small"} ${item.showLabel === false ? "icon-only" : ""} ${split ? "split-face" : ""}`,
        "aria-label": item.ariaLabel || label,
        "data-command": item.id || null,
        "aria-pressed": item.type === "toggle" ? "false" : null,
        "aria-haspopup": hasMenu && !split ? "menu" : null,
        "aria-expanded": hasMenu && !split ? "false" : null,
        "aria-keyshortcuts": item.keyshortcuts || null,
        onclick: (e) => {
          if (hasMenu && !split) showMenu(e.currentTarget, item);
          else run(item, e);
        },
        // While text is being edited a formatting command must not take the
        // focus, and with it the selection, away from the text.
        onpointerdown: item.keepFocus ? (e) => e.preventDefault() : null,
      },
      glyph(item.icon, large ? 32 : 16),
      item.showLabel === false && !large
        ? null
        : el(
            "span",
            { class: "ribbon-label" },
            shown,
            hasMenu && !split
              ? el("span", { class: "ribbon-caret", "aria-hidden": "true" })
              : null,
          ),
      hasMenu && !split && item.showLabel === false && !large
        ? el("span", { class: "ribbon-caret", "aria-hidden": "true" })
        : null,
    );
    tip(face, item);
    let node = face;
    let arrow = null;
    if (split) {
      arrow = el(
        "button",
        {
          type: "button",
          class: `ribbon-btn split-arrow ${large ? "large" : ""}`,
          "aria-label": item.menuLabel || `${label} options`,
          "aria-haspopup": "menu",
          "aria-expanded": "false",
          onclick: (e) => showMenu(e.currentTarget, item),
        },
        el("span", { class: "ribbon-caret", "aria-hidden": "true" }),
      );
      tip(arrow, { title: item.menuLabel || `${label} options` });
      node = el(
        "div",
        { class: `ribbon-split ${large ? "large" : "small"}` },
        face,
        arrow,
      );
    }
    addSync(() => {
      const enabled = item.enabled ? !!item.enabled() : true;
      face.disabled = !enabled;
      if (arrow)
        arrow.disabled = item.menuEnabled ? !item.menuEnabled() : !enabled;
      if (item.pressed)
        face.setAttribute("aria-pressed", String(!!item.pressed()));
      if (item.dynamicIcon) {
        const name = item.dynamicIcon();
        const current = face.querySelector("svg");
        if (current?.dataset.icon !== name)
          current?.replaceWith(glyph(name, large ? 32 : 16));
      }
      if (item.dynamicLabel) {
        const text = item.dynamicLabel();
        const span = face.querySelector(".ribbon-label");
        if (
          span &&
          span.firstChild?.nodeType === 3 &&
          span.firstChild.textContent !== text
        )
          span.firstChild.textContent = text;
      }
    });
    return node;
  }
  function run(item, e) {
    if (!item.run) return;
    try {
      const result = item.run(e);
      if (result?.catch) result.catch((error) => reportError(error));
    } catch (error) {
      reportError(error);
    }
    if (root.classList.contains("flyout") && !item.menu) flyout(false);
    setTimeout(refresh);
  }
  let reportError = (error) => console.error(error);
  function showMenu(anchor, item) {
    const items = typeof item.menu === "function" ? item.menu() : item.menu;
    if (!items) return;
    anchor.setAttribute("aria-expanded", "true");
    openMenu({
      anchor,
      items,
      label: item.menuLabel || item.label,
      align: "start",
      minWidth: item.menuWidth || 180,
      onClose: () => {
        anchor.setAttribute("aria-expanded", "false");
        setTimeout(refresh);
      },
    });
  }
  // An editable list, as the font name and size boxes are: type a value and
  // press Enter, or choose one from the list.
  function combo(item) {
    const listId = nextId("combo");
    const input = el("input", {
      type: "text",
      class: "ribbon-combo-input",
      "aria-label": item.label,
      role: "combobox",
      "aria-expanded": "false",
      "aria-controls": listId,
      autocomplete: "off",
      spellcheck: "false",
      "data-command": item.id || null,
      onkeydown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          item.afterCommit?.();
        } else if (e.key === "Escape") {
          input.value = input.dataset.value || "";
          input.blur();
        } else if (e.key === "ArrowDown" && e.altKey) {
          e.preventDefault();
          openList();
        }
      },
      onchange: () => commit(),
      onfocus: () => input.select(),
    });
    function commit() {
      const value = input.value.trim();
      if (!value || value === input.dataset.value) return;
      input.dataset.value = value;
      try {
        const result = item.commit(value);
        result?.catch?.((error) => reportError(error));
      } catch (error) {
        reportError(error);
      }
      setTimeout(refresh);
    }
    const caret = el(
      "button",
      {
        type: "button",
        class: "ribbon-combo-caret",
        tabindex: -1,
        "aria-label": `${item.label} list`,
        onclick: () => openList(),
      },
      el("span", { class: "ribbon-caret", "aria-hidden": "true" }),
    );
    function openList() {
      const current = item.value();
      input.setAttribute("aria-expanded", "true");
      openMenu({
        anchor: wrap,
        label: item.label,
        align: "start",
        minWidth: Math.max(wrap.offsetWidth, item.listWidth || 0),
        items: item.options().map((option) => {
          const value = typeof option === "object" ? option.value : option;
          return {
            label: typeof option === "object" ? option.label : String(option),
            checked: String(value) === String(current),
            labelStyle: item.optionStyle?.(value) || null,
            onSelect: () => {
              input.value = String(value);
              commit();
            },
          };
        }),
        onClose: () => input.setAttribute("aria-expanded", "false"),
      });
    }
    const wrap = el(
      "div",
      {
        class: "ribbon-combo",
        style: `width:${item.width || 120}px`,
      },
      input,
      caret,
    );
    tip(wrap, item);
    addSync(() => {
      const enabled = item.enabled ? !!item.enabled() : true;
      input.disabled = caret.disabled = !enabled;
      wrap.classList.toggle("disabled", !enabled);
      if (document.activeElement === input) return;
      const value = enabled ? String(item.value() ?? "") : "";
      input.value = value;
      input.dataset.value = value;
    });
    return wrap;
  }
  // A number with its unit, nudged by the arrows beside it or the arrow
  // keys, and applied with Enter or when the focus leaves.
  function spin(item) {
    const format = item.format || ((n) => String(n));
    const parse = item.parse || ((s) => parseFloat(s));
    const input = el("input", {
      type: "text",
      inputmode: "decimal",
      class: "ribbon-spin-input",
      "aria-label": item.ariaLabel || item.label,
      role: "spinbutton",
      "data-command": item.id || null,
      onkeydown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          nudge(e.key === "ArrowUp" ? 1 : -1);
        } else if (e.key === "Escape") {
          input.value = input.dataset.value || "";
          input.blur();
        }
      },
      onchange: () => commit(),
    });
    function clamp(n) {
      return Math.min(item.max ?? Infinity, Math.max(item.min ?? -Infinity, n));
    }
    function commit(value = parse(input.value)) {
      if (!Number.isFinite(value)) {
        input.value = input.dataset.value || "";
        return;
      }
      const n = clamp(value);
      input.value = format(n);
      if (input.value === input.dataset.value) return;
      input.dataset.value = input.value;
      try {
        const result = item.commit(n);
        result?.catch?.((error) => reportError(error));
      } catch (error) {
        reportError(error);
      }
      setTimeout(refresh);
    }
    function nudge(direction) {
      const current = parse(input.value);
      const base = Number.isFinite(current) ? current : (item.min ?? 0);
      const step = item.step || 1;
      commit(Math.round((base + direction * step) / step) * step);
    }
    const arrows = el(
      "span",
      { class: "ribbon-spin-arrows" },
      el(
        "button",
        {
          type: "button",
          tabindex: -1,
          "aria-label": `Increase ${item.label}`,
          onclick: () => nudge(1),
        },
        el("span", { class: "ribbon-caret up", "aria-hidden": "true" }),
      ),
      el(
        "button",
        {
          type: "button",
          tabindex: -1,
          "aria-label": `Decrease ${item.label}`,
          onclick: () => nudge(-1),
        },
        el("span", { class: "ribbon-caret", "aria-hidden": "true" }),
      ),
    );
    const node = el(
      "label",
      { class: "ribbon-spin" },
      item.icon ? glyph(item.icon, 16) : null,
      item.showLabel === false
        ? null
        : el("span", { class: "ribbon-spin-label" }, item.label),
      el(
        "span",
        { class: "ribbon-spin-box", style: `width:${item.width || 64}px` },
        input,
        arrows,
      ),
    );
    tip(node, item);
    addSync(() => {
      const enabled = item.enabled ? !!item.enabled() : true;
      input.disabled = !enabled;
      for (const b of arrows.querySelectorAll("button")) b.disabled = !enabled;
      node.classList.toggle("disabled", !enabled);
      if (document.activeElement === input) return;
      const value = enabled ? item.value() : null;
      input.value = value == null || value === "" ? "" : format(value);
      input.dataset.value = input.value;
    });
    return node;
  }
  function check(item) {
    const input = el("input", {
      type: "checkbox",
      "data-command": item.id || null,
      onchange: (e) => {
        try {
          const result = item.commit(e.target.checked);
          result?.catch?.((error) => reportError(error));
        } catch (error) {
          reportError(error);
        }
        setTimeout(refresh);
      },
    });
    const node = el(
      "label",
      { class: "ribbon-check" },
      input,
      el("span", {}, item.label),
    );
    tip(node, item);
    addSync(() => {
      const enabled = item.enabled ? !!item.enabled() : true;
      input.disabled = !enabled;
      node.classList.toggle("disabled", !enabled);
      input.checked = !!item.checked();
    });
    return node;
  }
  // A colour command: the face applies the colour last chosen, shown in the
  // bar under the icon; the arrow opens the palette.
  function colorButton(item) {
    const bar = el("span", { class: "ribbon-color-bar" });
    const node = commandButton({
      ...item,
      type: item.large ? "large" : "small",
      split: true,
    });
    const face = node.querySelector(".split-face");
    face.classList.add("ribbon-color");
    face.querySelector("svg")?.after(bar);
    addSync(() => {
      bar.style.background = item.color() || "transparent";
    });
    return node;
  }
  // A gallery: a strip of choices drawn as small pictures, scrolled a row at
  // a time, with a button that opens every choice at once.
  function gallery(item) {
    const strip = el("div", {
      class: "ribbon-gallery-items",
      role: "listbox",
      "aria-label": item.label,
    });
    const node = el(
      "div",
      {
        class: `ribbon-gallery ${item.className || ""}`,
        style: item.width ? `width:${item.width}px` : null,
      },
      strip,
    );
    let page = 0;
    const columns = item.columns || 6;
    const up = el(
      "button",
      {
        type: "button",
        class: "ribbon-gallery-scroll",
        "aria-label": `Previous row of ${item.label}`,
        tabindex: -1,
        onclick: () => {
          page = Math.max(0, page - 1);
          shown = null;
          draw();
        },
      },
      el("span", { class: "ribbon-caret up", "aria-hidden": "true" }),
    );
    const down = el(
      "button",
      {
        type: "button",
        class: "ribbon-gallery-scroll",
        "aria-label": `Next row of ${item.label}`,
        tabindex: -1,
        onclick: () => {
          page += 1;
          shown = null;
          draw();
        },
      },
      el("span", { class: "ribbon-caret", "aria-hidden": "true" }),
    );
    const more = el(
      "button",
      {
        type: "button",
        class: "ribbon-gallery-scroll more",
        "aria-label": `More ${item.label}`,
        "aria-haspopup": "dialog",
        onclick: (e) => openAll(e.currentTarget),
      },
      el("span", { class: "ribbon-more", "aria-hidden": "true" }),
    );
    node.append(el("div", { class: "ribbon-gallery-arrows" }, up, down, more));
    const option = (choice, selected, onChosen) => {
      const b = el(
        "button",
        {
          type: "button",
          role: "option",
          class: `ribbon-gallery-item ${item.itemClass || ""}`,
          "aria-selected": String(!!selected),
          "aria-label": choice.label,
          disabled: choice.disabled || null,
          onclick: () => {
            onChosen?.();
            try {
              const result = item.choose(choice);
              result?.catch?.((error) => reportError(error));
            } catch (error) {
              reportError(error);
            }
            setTimeout(refresh);
          },
          // A choice can offer more (a theme: apply to all slides or to
          // the selected ones) on right-click or the context-menu key.
          oncontextmenu: item.contextMenu
            ? (e) => {
                const items = item.contextMenu(choice);
                if (!items?.length) return;
                e.preventDefault();
                const r = b.getBoundingClientRect();
                openMenu({
                  anchor: b,
                  x: e.clientX || r.left + r.width / 2,
                  y: e.clientY || r.bottom,
                  contextual: true,
                  label: `${choice.label} options`,
                  items: items.map((entry) =>
                    entry.onSelect
                      ? {
                          ...entry,
                          onSelect: () => {
                            onChosen?.();
                            entry.onSelect();
                            setTimeout(refresh);
                          },
                        }
                      : entry,
                  ),
                });
              }
            : null,
          onpointerenter: item.preview ? () => item.preview(choice) : null,
          onpointerleave: item.endPreview ? () => item.endPreview() : null,
        },
        choice.render ? choice.render() : glyph(choice.icon, 32),
        item.showLabels === false
          ? null
          : el("span", { class: "ribbon-gallery-label" }, choice.label),
      );
      tip(b, { title: choice.label, description: choice.description });
      return b;
    };
    let choices = [];
    let shown = null;
    function draw() {
      const enabled = item.enabled ? !!item.enabled() : true;
      choices = item.items();
      const pages = Math.max(1, Math.ceil(choices.length / columns));
      page = Math.min(page, pages - 1);
      const selected = item.selected?.();
      // Rendering the choices can be costly (slide previews); they are drawn
      // again only when what the strip shows has changed.
      const key = JSON.stringify([
        enabled,
        page,
        selected ?? null,
        choices.map((c) => [c.id, c.label, c.disabled, c.version]),
      ]);
      if (key === shown) return;
      shown = key;
      strip.replaceChildren(
        ...choices
          .slice(page * columns, page * columns + columns)
          .map((choice) => {
            const b = option(
              choice,
              selected != null && choice.id === selected,
            );
            if (!enabled) b.disabled = true;
            return b;
          }),
      );
      up.disabled = !enabled || page === 0;
      down.disabled = !enabled || page >= pages - 1;
      more.disabled = !enabled;
      node.classList.toggle("disabled", !enabled);
    }
    function openAll(anchor) {
      const selected = item.selected?.();
      const pop = el("div", {
        class: "ribbon-gallery-panel",
        role: "dialog",
        "aria-label": item.label,
      });
      const close = () => {
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", onKey, true);
        pop.remove();
        anchor.focus();
      };
      const sections = item.sections
        ? item.sections(choices)
        : [{ label: null, items: choices }];
      for (const section of sections) {
        if (section.label)
          pop.append(
            el("div", { class: "ribbon-gallery-heading" }, section.label),
          );
        const grid = el("div", {
          class: "ribbon-gallery-grid",
          role: "listbox",
          "aria-label": section.label || item.label,
          style: `grid-template-columns:repeat(${item.panelColumns || columns}, auto)`,
        });
        for (const choice of section.items)
          grid.append(
            option(choice, selected != null && choice.id === selected, close),
          );
        pop.append(grid);
      }
      for (const extra of item.footer?.() || []) {
        if (extra.separator) {
          pop.append(el("div", { class: "menu-sep" }));
          continue;
        }
        pop.append(
          el(
            "button",
            {
              type: "button",
              class: "ribbon-gallery-footer",
              disabled: extra.disabled || null,
              onclick: () => {
                close();
                extra.onSelect();
              },
            },
            extra.icon
              ? glyph(extra.icon, 16)
              : el("span", { class: "spacer" }),
            extra.label,
          ),
        );
      }
      document.body.append(pop);
      const r = node.getBoundingClientRect();
      pop.style.left = `${Math.max(4, Math.min(r.left, document.documentElement.clientWidth - pop.offsetWidth - 8))}px`;
      pop.style.top = `${r.top}px`;
      const outside = (e) => {
        if (!pop.contains(e.target)) close();
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      };
      setTimeout(() => {
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("keydown", onKey, true);
      });
      (
        pop.querySelector('[aria-selected="true"]') ||
        pop.querySelector("button")
      )?.focus();
    }
    addSync(draw);
    return node;
  }
  function custom(item) {
    const node = item.render();
    if (item.sync) addSync(() => item.sync(node));
    return node;
  }

  // ---- Fitting: fold groups, last first, until the panel fits ----
  function fit() {
    const panel = panels.get(active);
    if (!panel || panel.hidden || !panel.isConnected) return;
    const groups = [...panel.querySelectorAll(":scope > .ribbon-group")];
    for (const group of groups) setFolded(group, false);
    const order = groups
      .filter((g) => g._group.group.collapsible !== false && !g.hidden)
      .sort(
        (a, b) =>
          (a._group.group.priority ?? 0) - (b._group.group.priority ?? 0) ||
          groups.indexOf(b) - groups.indexOf(a),
      );
    for (const group of order) {
      if (panel.scrollWidth <= panel.clientWidth + 1) break;
      setFolded(group, true);
    }
  }
  function setFolded(group, on) {
    group._folded = on;
    group._group.content.hidden = on;
    group._group.folded.hidden = !on;
    group.classList.toggle("folded", on);
  }
  const observer = new ResizeObserver(() => fit());
  observer.observe(body);

  function refresh() {
    const focused = document.activeElement;
    for (const { tab, fn } of syncers) {
      if (tab !== active || (collapsed && !root.classList.contains("flyout")))
        continue;
      try {
        fn();
      } catch (error) {
        console.error(error);
      }
    }
    // Contextual tabs come and go with the selection.
    let activeHidden = false;
    for (const tab of tabs) {
      const button = tabButtons.get(tab.id);
      const visible = tab.visible ? !!tab.visible() : true;
      button.hidden = !visible;
      if (!visible && tab.id === active) activeHidden = true;
    }
    const contextual = tabs.filter(
      (t) => t.contextual && !tabButtons.get(t.id).hidden,
    );
    tablist.classList.toggle("has-contextual", contextual.length > 0);
    if (activeHidden) select(tabs.find((t) => !t.contextual)?.id || "home");
    // A control switched off under the keyboard focus hands it on rather
    // than dropping it onto the page.
    if (
      focused?.disabled &&
      (root.contains(focused) || focused.closest(".ribbon-fold-panel"))
    )
      focusFallback?.()?.focus({ preventScroll: true });
  }

  select(panels.has(active) ? active : tabs[0].id);
  return {
    el: root,
    select: (id) => select(id),
    get active() {
      return active;
    },
    refresh,
    fit,
    setCollapsed,
    get collapsed() {
      return collapsed;
    },
    onError(fn) {
      reportError = fn;
    },
    // Every command, for searching: label, the tab it is on, and a way to
    // run it or open its menu.
    commands() {
      const out = [];
      for (const tab of tabs)
        for (const group of tab.groups)
          (function walk(items) {
            for (const item of items) {
              if (!item) continue;
              if (Array.isArray(item.items)) walk(item.items);
              if (!item.label || item.type === "divider") continue;
              if (!item.run && !item.menu) continue;
              out.push({ item, tab, group });
            }
          })(group.items);
      return out;
    },
    closeMenus: closeMenu,
  };
}

// Screen tips follow the pointer over any element that declares one.
let tipNode = null,
  tipTimer = 0,
  tipFor = null;
function hideTip() {
  clearTimeout(tipTimer);
  tipNode?.remove();
  tipNode = null;
  tipFor = null;
}
document.addEventListener("pointerover", (e) => {
  const target = e.target.closest?.("[data-tip-title]");
  if (target === tipFor) return;
  hideTip();
  if (!target || e.pointerType === "touch") return;
  tipFor = target;
  tipTimer = setTimeout(() => {
    if (!target.isConnected || document.querySelector(".menu")) return;
    tipNode = el(
      "div",
      { class: "screen-tip", role: "tooltip" },
      el("strong", {}, target.dataset.tipTitle),
      target.dataset.tipText ? el("p", {}, target.dataset.tipText) : null,
    );
    document.body.append(tipNode);
    const r = target.getBoundingClientRect();
    tipNode.style.left = `${Math.max(4, Math.min(r.left, document.documentElement.clientWidth - tipNode.offsetWidth - 8))}px`;
    tipNode.style.top = `${r.bottom + 6}px`;
  }, 650);
});
document.addEventListener("pointerdown", hideTip, true);
document.addEventListener("keydown", hideTip, true);
