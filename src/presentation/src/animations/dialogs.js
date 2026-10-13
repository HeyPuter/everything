// Dialogs of the Animations tab: every effect of a family (More Effects), and
// one effect's settings (Effect Options: effect, timing and text animation).
import { el, dialog } from "../ui.js";
import {
  CATEGORIES,
  EFFECTS,
  FAMILIES,
  effectIcon,
  effectKey,
  effectName,
  entryFor,
} from "./catalog.js";
import { COLORS, optionGroups } from "./options.js";

const confirmButton = (d) =>
  [...(d?.querySelectorAll(".dialog-actions .btn") || [])].find((b) =>
    b.classList.contains("primary"),
  );

/** Resolves to the chosen catalog entry, or null. */
export async function moreEffectsDialog({ cls, current = null, hasText }) {
  const cat = CATEGORIES.find((c) => c.id === cls);
  let picked = current?.cls === cls ? current : null;
  const body = el("div", { class: "dialog-body anim-more" });
  const entries = EFFECTS.filter((e) => e.cls === cls);
  const families = [...new Set(entries.map((e) => e.family))];
  const options = [];
  for (const family of families) {
    body.append(el("h3", { class: "anim-more-head" }, FAMILIES[family]));
    const grid = el("div", {
      class: "anim-more-grid",
      role: "listbox",
      "aria-label": FAMILIES[family],
    });
    for (const entry of entries.filter((e) => e.family === family)) {
      const disabled = entry.text && !hasText;
      const option = el(
        "button",
        {
          type: "button",
          role: "option",
          class: "anim-more-item",
          "aria-selected": String(picked === entry),
          disabled: disabled || null,
          "data-key": effectKey(entry),
          onclick: () => pick(entry),
          ondblclick: () => {
            pick(entry);
            confirmButton(option.closest("dialog"))?.click();
          },
          onkeydown: (e) => {
            const i = options.indexOf(option);
            const step =
              e.key === "ArrowRight" || e.key === "ArrowDown"
                ? 1
                : e.key === "ArrowLeft" || e.key === "ArrowUp"
                  ? -1
                  : 0;
            if (!step) return;
            e.preventDefault();
            const next = options
              .slice(i + step)
              .concat(options.slice(0, i + step));
            const target = (
              step > 0 ? next : [...options.slice(0, i)].reverse()
            ).find((o) => !o.disabled);
            target?.focus();
          },
        },
        effectIcon(entry, 24),
        el("span", {}, entry.name),
      );
      options.push(option);
      grid.append(option);
    }
    body.append(grid);
  }
  function pick(entry) {
    picked = entry;
    for (const o of options)
      o.setAttribute(
        "aria-selected",
        String(o.dataset.key === effectKey(entry)),
      );
  }
  const shown = dialog({
    title: `Change ${cat?.id === "path" ? "Motion Path" : `${cat?.label} Effect`}`,
    body,
    confirm: "OK",
  });
  requestAnimationFrame(() =>
    (
      options.find((o) => o.getAttribute("aria-selected") === "true") ||
      options.find((o) => !o.disabled)
    )?.focus(),
  );
  const ok = await shown;
  return ok ? picked : null;
}

const secondsInput = (label, ms, { min = 0, max = 59 } = {}) => {
  const input = el("input", {
    class: "input",
    type: "number",
    min,
    max,
    step: 0.25,
    value: (ms / 1000).toFixed(2),
    "aria-label": `${label} (seconds)`,
  });
  return {
    input,
    node: el("label", {}, label, input),
    value: () =>
      Math.round(Math.min(max, Math.max(min, Number(input.value) || 0)) * 1000),
  };
};
const select = (label, choices, value) => {
  const node = el(
    "select",
    { class: "input", "aria-label": label },
    ...choices.map(([v, text]) =>
      el(
        "option",
        { value: String(v), selected: String(v) === String(value) },
        text,
      ),
    ),
  );
  return {
    input: node,
    node: el("label", {}, label, node),
    value: () => node.value,
  };
};
const checkbox = (label, checked) => {
  const input = el("input", { type: "checkbox", checked: checked || null });
  return {
    input,
    node: el("label", { class: "check-field" }, input, el("span", {}, label)),
    value: () => input.checked,
  };
};

/**
 * Resolves to the changes for the effect (a partial effect), or null.
 * `tab`: "effect", "timing" or "text".
 */
export async function effectOptionsDialog({
  effect,
  tab = "effect",
  tools,
  ctx,
}) {
  const P = ctx.P;
  const entry = entryFor(effect);
  const hasText = tools.hasText(effect.shapeId);
  const paragraphs = tools.shapeParagraphCount(effect.shapeId);
  const panels = {};
  const fields = [];

  // ---- Effect ----
  const effectPanel = el("div", { class: "anim-tab-panel" });
  const groups = optionGroups(entry, effect, { hasText, paragraphs }).filter(
    (g) => g.label !== "Sequence" && g.label !== "Path" && g.label !== "Color",
  );
  const groupSelects = groups.map((g) => {
    const active = Math.max(
      0,
      g.options.findIndex((o) => o.active),
    );
    const s = select(
      g.label,
      g.options.map((o, i) => [i, o.label]),
      active,
    );
    effectPanel.append(s.node);
    return { group: g, s, initial: active };
  });
  let color = null;
  if (entry?.color) {
    const input = el("input", {
      type: "color",
      class: "input anim-color",
      value: `#${(effect.color || "E81224").toLowerCase()}`,
      "aria-label": "Color",
      list: "anim-colors",
    });
    const list = el(
      "datalist",
      { id: "anim-colors" },
      ...COLORS.map(([v]) => el("option", { value: `#${v.toLowerCase()}` })),
    );
    effectPanel.append(el("label", {}, "Color", input, list));
    color = input;
  }
  const smoothStart = secondsInput(
    "Smooth start",
    (effect.smoothStart || 0) * effect.durationMs,
  );
  const smoothEnd = secondsInput(
    "Smooth end",
    (effect.smoothEnd || 0) * effect.durationMs,
  );
  const bounceEnd = secondsInput(
    "Bounce end",
    (effect.bounceEnd || 0) * effect.durationMs,
  );
  const autoReverse = checkbox("Auto-reverse", effect.autoReverse);
  const reversePath =
    effect.presetClass === "path"
      ? checkbox("Reverse path direction", false)
      : null;
  effectPanel.append(
    el("h3", { class: "anim-dialog-head" }, "Settings"),
    el(
      "div",
      { class: "anim-field-row" },
      smoothStart.node,
      smoothEnd.node,
      bounceEnd.node,
    ),
    autoReverse.node,
    ...(reversePath ? [reversePath.node] : []),
  );
  const afterChoices = [
    ["none", "Don't Dim"],
    ["hide", "Hide After Animation"],
    ...COLORS.map(([v, name]) => [`dim:${v}`, `Dim to ${name}`]),
  ];
  const afterValue = !effect.after
    ? "none"
    : effect.after.kind === "hide"
      ? "hide"
      : `dim:${effect.after.color.toUpperCase()}`;
  if (
    effect.after?.kind === "dim" &&
    !afterChoices.some(([v]) => v === afterValue)
  )
    afterChoices.push([afterValue, `Dim to #${effect.after.color}`]);
  const after = select("After animation", afterChoices, afterValue);
  const sound = select("Sound", [["none", "No Sound"]], "none");
  sound.input.disabled = true;
  sound.node.title =
    "Sounds in the file are kept; adding sounds is not available.";
  const iterate = select(
    "Animate text",
    [
      ["all", "All at Once"],
      ["word", "By Word"],
      ["letter", "By Letter"],
    ],
    effect.iterate?.type || "all",
  );
  const iterateDelay = el("input", {
    class: "input",
    type: "number",
    min: 0,
    max: 100,
    step: 1,
    value: String(effect.iterate?.delayPercent ?? 10),
    "aria-label": "Delay between letters or words (percent)",
  });
  iterate.input.disabled = !hasText;
  iterateDelay.disabled = !hasText;
  effectPanel.append(
    el("h3", { class: "anim-dialog-head" }, "Enhancements"),
    sound.node,
    after.node,
    el(
      "div",
      { class: "anim-field-row" },
      iterate.node,
      el("label", {}, "% delay between", iterateDelay),
    ),
  );
  panels.effect = effectPanel;

  // ---- Timing ----
  const timingPanel = el("div", { class: "anim-tab-panel" });
  const start = select(
    "Start",
    [
      ["click", "On Click"],
      ["with", "With Previous"],
      ["after", "After Previous"],
    ],
    effect.start,
  );
  const delay = secondsInput("Delay", effect.delayMs);
  const duration = secondsInput("Duration", effect.durationMs, { min: 0 });
  const repeatValue = effect.repeat === undefined ? "1" : String(effect.repeat);
  const repeatChoices = [
    ["1", "(none)"],
    ["2", "2"],
    ["3", "3"],
    ["4", "4"],
    ["5", "5"],
    ["10", "10"],
    ["untilNextClick", "Until Next Click"],
    ["untilEndOfSlide", "Until End of Slide"],
  ];
  if (!repeatChoices.some(([v]) => v === repeatValue))
    repeatChoices.push([repeatValue, repeatValue]);
  const repeat = select("Repeat", repeatChoices, repeatValue);
  const rewind = checkbox("Rewind when done playing", effect.rewind);
  const others = ctx
    .topLevelShapes(ctx.slide())
    .filter((s) => String(P.getShapeId(s)) !== effect.shapeId);
  const triggerMode = select(
    "Triggers",
    [
      ["sequence", "Animate as part of click sequence"],
      ...(others.length ? [["click", "Start effect on click of"]] : []),
    ],
    effect.trigger ? "click" : "sequence",
  );
  const triggerShape = select(
    "Object",
    others.map((s) => [String(P.getShapeId(s)), ctx.shapeLabel(s)]),
    effect.trigger || (others[0] ? String(P.getShapeId(others[0])) : ""),
  );
  triggerShape.input.disabled = !effect.trigger;
  triggerMode.input.addEventListener(
    "change",
    () => (triggerShape.input.disabled = triggerMode.value() !== "click"),
  );
  timingPanel.append(
    start.node,
    el("div", { class: "anim-field-row" }, delay.node, duration.node),
    repeat.node,
    rewind.node,
    triggerMode.node,
    ...(others.length ? [triggerShape.node] : []),
  );
  panels.timing = timingPanel;

  // ---- Text animation ----
  const textPanel = el("div", { class: "anim-tab-panel" });
  const groupValue = !effect.text
    ? "whole"
    : effect.text.by === "allAtOnce"
      ? "all"
      : String(effect.text.level);
  const groupText = select(
    "Group text",
    [
      ["whole", "As One Object"],
      ["all", "All Paragraphs At Once"],
      ["1", "By 1st Level Paragraphs"],
      ["2", "By 2nd Level Paragraphs"],
      ["3", "By 3rd Level Paragraphs"],
      ["4", "By 4th Level Paragraphs"],
      ["5", "By 5th Level Paragraphs"],
    ],
    groupValue,
  );
  const autoAfter = checkbox(
    "Automatically after",
    effect.text?.autoAfterMs !== undefined,
  );
  const autoAfterTime = secondsInput("Seconds", effect.text?.autoAfterMs ?? 0);
  const animateShape = checkbox(
    "Animate attached shape",
    effect.text?.animateBackground,
  );
  const reverse = checkbox("In reverse order", effect.text?.reverse);
  textPanel.append(
    groupText.node,
    el(
      "div",
      { class: "anim-field-row anim-inline" },
      autoAfter.node,
      autoAfterTime.node,
    ),
    animateShape.node,
    reverse.node,
  );
  if (!hasText)
    for (const x of textPanel.querySelectorAll("input,select"))
      x.disabled = true;
  panels.text = textPanel;

  // Tabs
  const tabs = [
    ["effect", "Effect"],
    ["timing", "Timing"],
    ...(hasText ? [["text", "Text Animation"]] : []),
  ];
  if (!panels[tab] || (tab === "text" && !hasText)) tab = "effect";
  const tablist = el("div", {
    class: "anim-tabs",
    role: "tablist",
    "aria-label": "Effect settings",
  });
  const tabButtons = tabs.map(([id, label]) => {
    const b = el(
      "button",
      {
        type: "button",
        role: "tab",
        id: `anim-tab-${id}`,
        "aria-controls": `anim-panel-${id}`,
        "aria-selected": String(id === tab),
        tabindex: id === tab ? 0 : -1,
        onclick: () => show(id),
        onkeydown: (e) => {
          const i = tabs.findIndex(([t]) => t === id);
          const step =
            e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          const [next] = tabs[(i + step + tabs.length) % tabs.length];
          show(next);
          tablist.querySelector(`#anim-tab-${next}`).focus();
        },
      },
      label,
    );
    return b;
  });
  tablist.append(...tabButtons);
  for (const [id] of tabs) {
    panels[id].id = `anim-panel-${id}`;
    panels[id].setAttribute("role", "tabpanel");
    panels[id].setAttribute("aria-labelledby", `anim-tab-${id}`);
  }
  function show(id) {
    for (const [t] of tabs) {
      panels[t].hidden = t !== id;
      tablist
        .querySelector(`#anim-tab-${t}`)
        .setAttribute("aria-selected", String(t === id));
      tablist.querySelector(`#anim-tab-${t}`).tabIndex = t === id ? 0 : -1;
    }
  }
  const form = el(
    "form",
    { class: "dialog-body anim-options" },
    tablist,
    ...tabs.map(([id]) => panels[id]),
  );
  show(tab);
  const ok = await dialog({
    title: `${effectName(effect)}`,
    body: form,
    confirm: "OK",
  });
  if (!ok) return null;
  void fields;

  // Collect the changes.
  let change = {};
  for (const { group, s, initial } of groupSelects) {
    const i = Number(s.value());
    if (i !== initial || !group.options[initial]?.active)
      change = {
        ...change,
        ...group.options[i].apply({ ...effect, ...change }),
      };
  }
  if (color) change.color = color.value.replace("#", "").toUpperCase();
  const durationMs = duration.value();
  const frac = (ms) =>
    durationMs > 0
      ? Math.min(1, Math.round((ms / durationMs) * 1000) / 1000)
      : 0;
  change.smoothStart = frac(smoothStart.value()) || undefined;
  change.smoothEnd = frac(smoothEnd.value()) || undefined;
  change.bounceEnd = frac(bounceEnd.value()) || undefined;
  change.autoReverse = autoReverse.value() || undefined;
  if (reversePath?.value()) {
    const { reversePath: rev } = await import("./options.js");
    change.path = rev(
      effect.path || P.motionPathFor(effect.presetId, effect.presetSubtype),
    );
  }
  const a = after.value();
  change.after =
    a === "none"
      ? undefined
      : a === "hide"
        ? { kind: "hide" }
        : { kind: "dim", color: a.slice(4) };
  const it = iterate.value();
  change.iterate =
    hasText && it !== "all"
      ? {
          type: it,
          delayPercent: Math.min(
            100,
            Math.max(0, Number(iterateDelay.value) || 0),
          ),
        }
      : undefined;
  change.start = start.value();
  change.delayMs = delay.value();
  change.durationMs = durationMs;
  const r = repeat.value();
  change.repeat = r === "1" ? undefined : /^\d/.test(r) ? Number(r) : r;
  change.rewind = rewind.value() || undefined;
  change.trigger =
    triggerMode.value() === "click" && triggerShape.value()
      ? triggerShape.value()
      : undefined;
  if (hasText) {
    const g = groupText.value();
    change.text =
      g === "whole"
        ? undefined
        : {
            by: g === "all" ? "allAtOnce" : "paragraph",
            level: g === "all" ? effect.text?.level || 1 : Number(g),
            ...(reverse.value() ? { reverse: true } : {}),
            ...(animateShape.value() ? { animateBackground: true } : {}),
            ...(autoAfter.value() && g !== "all"
              ? { autoAfterMs: autoAfterTime.value() }
              : {}),
          };
  }
  // Only what was changed: an effect left as it was keeps its markup.
  const same = (a, b) => {
    const norm = (v) => (v === undefined || v === false || v === 0 ? null : v);
    if (typeof a === "number" && typeof b === "number")
      return Math.abs(a - b) < 0.011;
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  };
  for (const key of Object.keys(change))
    if (same(change[key], effect[key])) delete change[key];
  return Object.keys(change).length ? change : null;
}
