// The Animation Pane: the slide's effects in the order they play, grouped by
// click, each with its start, its picture, its object and a bar on a timeline
// in seconds. Effects are chosen here (and their objects with them), dragged
// or moved to reorder, and changed or removed from each one's menu.
import { el, icon, openMenu } from "../ui.js";
import { commandIcon } from "../chrome/icons.js";
import { categoryOf, effectIcon, effectName } from "./catalog.js";
import { buildSequence, slideTimeline, totalDuration } from "./player.js";

const START_LABELS = {
  click: "On Click",
  with: "With Previous",
  after: "After Previous",
};
const glyph = (name, size = 16) => commandIcon(name, size) || icon(name, size);

export function createAnimationPane({ tools, P, ctx }) {
  let node = null;
  // Pixels per second on the timeline: fitted to the longest sequence, then
  // zoomed in or out from the ruler.
  let scale = 60;
  let zoom = 1;
  let timeline = true;
  const expanded = new Set();
  let drag = null;
  let lastAnchor = null;

  function toggle(force) {
    const open = force ?? !node?.isConnected;
    if (!open) {
      node?.remove();
      node = null;
      return;
    }
    if (node?.isConnected) return;
    node = el("aside", {
      class: "task-pane animation-pane",
      "aria-label": "Animation Pane",
      tabindex: -1,
    });
    ctx.editorBody()?.append(node);
    render();
    node.querySelector(".anim-row")?.focus() || node.focus();
  }

  const shapeName = (shapeId) => {
    const shape = P.findShapeById(ctx.slide(), Number(shapeId));
    return shape ? ctx.shapeLabel(shape) : `Object ${shapeId}`;
  };
  // Rows: one per effect, in sequence order, with timing for the bars.
  function rowsOf(effects) {
    const s = ctx.slide();
    const sequences = [];
    const main = effects
      .map((effect, index) => ({ effect, index }))
      .filter((x) => x.effect.trigger === undefined);
    sequences.push({ trigger: null, list: main });
    const triggers = [];
    for (const e of effects)
      if (e.trigger !== undefined && !triggers.includes(e.trigger))
        triggers.push(e.trigger);
    for (const t of triggers)
      sequences.push({
        trigger: t,
        list: effects
          .map((effect, index) => ({ effect, index }))
          .filter((x) => x.effect.trigger === t),
      });
    return sequences.map(({ trigger, list }) => {
      const items = list.map(({ effect, index }) => ({
        effect,
        index,
        shapeId: effect.shapeId,
        part: null,
        sub: 0,
        start: effect.start,
        delay: effect.delayMs,
      }));
      const groups = buildSequence(items, { main: !trigger });
      const auto = groups[0]?.auto ? 1 : 0;
      const rows = [];
      groups.forEach((g, gi) =>
        g.items.forEach((item, k) =>
          rows.push({
            ...item,
            step: k === 0 ? gi + 1 - auto : null,
            auto: g.auto,
          }),
        ),
      );
      void s;
      return { trigger, rows };
    });
  }

  function render() {
    if (!node?.isConnected) return;
    const effects = tools().effects();
    const chosen = new Set(
      tools()
        .current()
        .map((t) => t.index),
    );
    const focusedIndex = node.contains(document.activeElement)
      ? document.activeElement.closest?.(".anim-row")?.dataset.index
      : null;
    const scroll = node.querySelector(".anim-list")?.scrollTop ?? 0;
    const playing = tools().previewing;
    const playLabel = playing ? "Stop" : chosen.size ? "Play From" : "Play All";
    const head = el(
      "div",
      { class: "task-pane-head" },
      el("h2", {}, "Animation Pane"),
      el(
        "button",
        {
          type: "button",
          class: "icon-btn",
          "aria-label": "Close Animation Pane",
          title: "Close",
          onclick: () => tools().togglePane(false),
        },
        icon("X", 16),
      ),
    );
    const bar = el(
      "div",
      { class: "anim-pane-bar" },
      el(
        "button",
        {
          type: "button",
          class: "anim-play",
          disabled: !effects.length || null,
          onclick: () => {
            if (tools().previewing) return tools().stopPreview();
            const from = chosen.size ? Math.min(...chosen) : 0;
            // Play From starts at the click group of the first chosen effect.
            tools().playPreview({ from: groupOf(effects, from) });
          },
        },
        playing ? icon("Square", 13) : icon("Play", 14),
        playLabel,
      ),
      el(
        "span",
        { class: "anim-pane-move" },
        el(
          "button",
          {
            type: "button",
            class: "icon-btn",
            "aria-label": "Move Earlier",
            title: "Move Earlier",
            disabled: ![...chosen].some((i) => i > 0) || null,
            onclick: () => tools().move(-1),
          },
          icon("ChevronUp", 16),
        ),
        el(
          "button",
          {
            type: "button",
            class: "icon-btn",
            "aria-label": "Move Later",
            title: "Move Later",
            disabled: ![...chosen].some((i) => i < effects.length - 1) || null,
            onclick: () => tools().move(1),
          },
          icon("ChevronDown", 16),
        ),
      ),
    );
    const list = el("div", {
      class: "anim-list",
      role: "listbox",
      "aria-label": "Effects on this slide",
      "aria-multiselectable": "true",
    });
    const sequences = rowsOf(effects);
    let longest = 1;
    for (const seq of sequences)
      for (const row of seq.rows)
        longest = Math.max(longest, row.at + totalDuration(row.effect));
    scale = zoom * Math.min(60, 110 / Math.max(1, longest / 1000));
    for (const seq of sequences) {
      if (seq.trigger)
        list.append(
          el(
            "div",
            { class: "anim-trigger-head", role: "presentation" },
            glyph("trigger", 14),
            `Trigger: ${shapeName(seq.trigger)}`,
          ),
        );
      for (const row of seq.rows) {
        list.append(rowNode(row, chosen, effects));
        if (expanded.has(row.index) && row.effect.text)
          for (const sub of subRows(row)) list.append(sub);
      }
    }
    const ruler = timeline ? rulerNode(longest) : null;
    node.replaceChildren(
      head,
      bar,
      effects.length
        ? list
        : el(
            "p",
            { class: "helper" },
            "This slide has no animations. Select an object and choose an effect on the Animations tab.",
          ),
      ...(effects.length && ruler ? [ruler] : []),
    );
    list.scrollTop = scroll;
    if (focusedIndex != null)
      list
        .querySelector(`.anim-row[data-index="${focusedIndex}"]`)
        ?.focus({ preventScroll: true });
  }

  function groupOf(effects, index) {
    // The main sequence's click group holding effect `index` (paragraph
    // builds have a group per paragraph).
    const main = effects.filter((e) => e.trigger === undefined);
    const at = main.indexOf(effects[index]);
    if (at < 0) return 0;
    const { groups } = slideTimeline(ctx.slide(), effects);
    return Math.max(
      0,
      groups.findIndex((g) => g.items.some((it) => it.index === at)),
    );
  }

  function rowNode(row, chosen, effects) {
    const { effect, index } = row;
    const cat = categoryOf(effect.presetClass);
    const name = shapeName(effect.shapeId);
    const label = `${row.step != null && !(row.auto && row.step === 0) ? `${row.step}. ` : ""}${effectName(effect)}: ${name}, ${START_LABELS[effect.start]}${effect.delayMs ? `, delay ${(effect.delayMs / 1000).toFixed(2)} s` : ""}, ${(effect.durationMs / 1000).toFixed(2)} s`;
    const selected = chosen.has(index);
    const node = el(
      "div",
      {
        class: `anim-row ${selected ? "selected" : ""} cls-${effect.presetClass}`,
        role: "option",
        tabindex: selected || (!chosen.size && index === 0) ? 0 : -1,
        "aria-selected": String(selected),
        "aria-label": label,
        "data-index": String(index),
        title: label,
        onclick: (e) => select(index, e),
        ondblclick: () => tools().openEffectDialog("effect"),
        oncontextmenu: (e) => {
          e.preventDefault();
          if (!chosen.has(index)) tools().choose([index]);
          openMenu({
            items: itemMenu(index),
            x: e.clientX,
            y: e.clientY,
            label: "Effect options",
          });
        },
        onkeydown: (e) => keydown(e, index, effects),
        onpointerdown: (e) => startDrag(e, index),
      },
      el(
        "span",
        { class: "anim-step", "aria-hidden": "true" },
        row.step != null && !(row.auto && row.step === 0)
          ? String(row.step)
          : "",
      ),
      el(
        "span",
        {
          class: `anim-start start-${effect.start}`,
          "aria-hidden": "true",
          title: START_LABELS[effect.start],
        },
        effect.start === "click"
          ? icon("Pointer", 12)
          : effect.start === "after"
            ? glyph("duration", 13)
            : "",
      ),
      effect.text
        ? el(
            "button",
            {
              type: "button",
              class: "anim-expand",
              tabindex: -1,
              "aria-label": expanded.has(index)
                ? "Collapse paragraphs"
                : "Expand paragraphs",
              "aria-expanded": String(expanded.has(index)),
              onclick: (e) => {
                e.stopPropagation();
                if (expanded.has(index)) expanded.delete(index);
                else expanded.add(index);
                render();
              },
            },
            icon(expanded.has(index) ? "ChevronDown" : "ChevronRight", 12),
          )
        : el("span", { class: "anim-expand-space" }),
      el("span", { class: `anim-cat hue-${cat.hue}` }, effectIcon(effect, 16)),
      el("span", { class: "anim-name" }, name),
      timeline ? timelineBar(row) : null,
      el(
        "button",
        {
          type: "button",
          class: "anim-row-menu",
          tabindex: -1,
          "aria-label": `Options for ${effectName(effect)} on ${name}`,
          "aria-haspopup": "menu",
          onclick: (e) => {
            e.stopPropagation();
            if (!chosen.has(index)) tools().choose([index]);
            openMenu({
              anchor: e.currentTarget,
              items: itemMenu(index),
              label: "Effect options",
              align: "end",
            });
          },
        },
        icon("ChevronDown", 14),
      ),
    );
    return node;
  }

  function subRows(row) {
    const shape = P.findShapeById(ctx.slide(), Number(row.effect.shapeId));
    const groups = P.getShapeBuildParagraphs(
      ctx.slide(),
      row.effect.shapeId,
      row.effect.text.level,
    );
    return groups.map((g) => {
      let text = "";
      try {
        text = P.getShapeText(shape).split(/\n/)[g.start] || "";
      } catch {}
      return el(
        "div",
        { class: "anim-row anim-sub", role: "presentation" },
        el("span", { class: "anim-step" }),
        el("span", { class: "anim-start" }),
        el("span", { class: "anim-expand-space" }),
        el("span", { class: "anim-cat" }),
        el("span", { class: "anim-name" }, text || `Paragraph ${g.start + 1}`),
      );
    });
  }

  function timelineBar(row) {
    const { effect } = row;
    const total = totalDuration(effect);
    const wrap = el("span", { class: "anim-time", "aria-hidden": "true" });
    const barEl = el("span", {
      class: `anim-bar cls-${effect.presetClass}`,
      style: `left:${(row.at / 1000) * scale}px;width:${Math.max(3, (total / 1000) * scale)}px`,
    });
    wrap.append(barEl);
    return wrap;
  }

  function rulerNode(longest) {
    const secs = Math.ceil(200 / scale);
    const every = scale < 20 ? 5 : scale < 40 ? 2 : 1;
    const ticks = el("div", { class: "anim-ruler-ticks" });
    for (let s = 0; s <= secs; s += every)
      ticks.append(
        el(
          "span",
          { class: "anim-tick", style: `left:${s * scale}px` },
          String(s),
        ),
      );
    return el(
      "div",
      { class: "anim-ruler" },
      el(
        "button",
        {
          type: "button",
          class: "anim-ruler-label",
          "aria-haspopup": "menu",
          onclick: (e) =>
            openMenu({
              anchor: e.currentTarget,
              label: "Timeline",
              items: [
                {
                  label: "Zoom In",
                  disabled: zoom >= 8,
                  onSelect: () => {
                    zoom = Math.min(8, zoom * 2);
                    render();
                  },
                },
                {
                  label: "Zoom Out",
                  disabled: zoom <= 0.25,
                  onSelect: () => {
                    zoom = Math.max(0.25, zoom / 2);
                    render();
                  },
                },
              ],
            }),
        },
        "Seconds",
        icon("ChevronDown", 12),
      ),
      ticks,
    );
  }

  function itemMenu(index) {
    const effect = tools().effects()[index];
    if (!effect) return [];
    const set = (start) => () => tools().update(() => ({ start }));
    return [
      ...["click", "with", "after"].map((start) => ({
        label: `Start ${START_LABELS[start]}`,
        checked: effect.start === start,
        onSelect: set(start),
      })),
      { separator: true },
      {
        label: "Effect Options…",
        onSelect: () => tools().openEffectDialog("effect"),
      },
      { label: "Timing…", onSelect: () => tools().openEffectDialog("timing") },
      ...(tools().hasText(effect.shapeId)
        ? [
            {
              label: "Text Animation…",
              onSelect: () => tools().openEffectDialog("text"),
            },
          ]
        : []),
      {
        label: timeline ? "Hide Advanced Timeline" : "Show Advanced Timeline",
        onSelect: () => {
          timeline = !timeline;
          render();
        },
      },
      { separator: true },
      {
        label: "Play From Here",
        onSelect: () =>
          tools().playPreview({ from: groupOf(tools().effects(), index) }),
      },
      { label: "Remove", danger: true, onSelect: () => tools().remove() },
    ];
  }

  function select(index, e) {
    const current = tools()
      .current()
      .map((t) => t.index);
    if (e?.shiftKey && lastAnchor != null) {
      const [a, b] = [Math.min(lastAnchor, index), Math.max(lastAnchor, index)];
      const range = [];
      for (let i = a; i <= b; i++) range.push(i);
      tools().choose(range);
    } else if (e?.metaKey || e?.ctrlKey) {
      tools().choose(
        current.includes(index)
          ? current.filter((i) => i !== index)
          : [...current, index],
      );
      lastAnchor = index;
    } else {
      tools().choose([index]);
      lastAnchor = index;
    }
    render();
    node
      ?.querySelector(`.anim-row[data-index="${index}"]`)
      ?.focus({ preventScroll: false });
  }

  function keydown(e, index, effects) {
    const rows = [...node.querySelectorAll(".anim-row[data-index]")];
    const at = rows.findIndex((r) => Number(r.dataset.index) === index);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      if (e.altKey) return tools().move(step);
      const next = rows[at + step];
      if (next) select(Number(next.dataset.index), e);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const target = e.key === "Home" ? rows[0] : rows[rows.length - 1];
      if (target) select(Number(target.dataset.index), e);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      tools().remove();
    } else if (e.key === "Enter") {
      e.preventDefault();
      tools().openEffectDialog("effect");
    } else if (e.key === " ") {
      e.preventDefault();
      select(index, e);
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      openMenu({
        items: itemMenu(index),
        x: r.left + 24,
        y: r.bottom,
        label: "Effect options",
      });
    } else if (e.key === "Escape") {
      e.stopPropagation();
    }
    void effects;
  }

  // Dragging a row moves its effect to where it is dropped.
  function startDrag(e, index) {
    if (e.button !== 0 || e.target.closest("button")) return;
    const row = e.currentTarget;
    const list = row.parentElement;
    const startY = e.clientY;
    let moved = false;
    const marker = el("div", { class: "anim-drop-marker" });
    const onMove = (ev) => {
      if (!moved && Math.abs(ev.clientY - startY) < 5) return;
      moved = true;
      row.classList.add("dragging");
      const rows = [...list.querySelectorAll(".anim-row[data-index]")];
      let to = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          to = i;
          break;
        }
      }
      drag = { from: index, to };
      const ref = rows[to];
      if (ref) list.insertBefore(marker, ref);
      else list.append(marker);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      marker.remove();
      row.classList.remove("dragging");
      if (moved && drag) {
        const rows = [...list.querySelectorAll(".anim-row[data-index]")];
        const target =
          drag.to < rows.length
            ? Number(rows[drag.to].dataset.index)
            : rows.length;
        const to = target > drag.from ? target - 1 : target;
        tools().reorder(drag.from, to);
      }
      drag = null;
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  return {
    toggle,
    render,
    get open() {
      return !!node?.isConnected;
    },
  };
}
