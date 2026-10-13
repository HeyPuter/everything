// The Font, Paragraph, Tabs and Columns dialogs. Each reads the current
// settings, lets them be changed together, and hands back only what changed,
// so text that mixes formats keeps whatever was left alone.
import { el } from "../ui.js";
import {
  IN,
  PT,
  checkField,
  colorButton,
  cssColor,
  formatDialog,
  numberField,
  segmented,
  selectField,
  tabs,
} from "./controls.js";

export const UNDERLINE_STYLES = [
  ["none", "(none)"],
  ["words", "Words only"],
  ["sng", "Single"],
  ["dbl", "Double"],
  ["heavy", "Heavy"],
  ["dotted", "Dotted"],
  ["dottedHeavy", "Dotted heavy"],
  ["dash", "Dashed"],
  ["dashHeavy", "Dashed heavy"],
  ["dashLong", "Long dashes"],
  ["dashLongHeavy", "Long dashes heavy"],
  ["dotDash", "Dot dash"],
  ["dotDashHeavy", "Dot dash heavy"],
  ["dotDotDash", "Dot dot dash"],
  ["dotDotDashHeavy", "Dot dot dash heavy"],
  ["wavy", "Wavy"],
  ["wavyHeavy", "Wavy heavy"],
  ["wavyDbl", "Wavy double"],
];

const underlineToken = (u) =>
  u === true ? "sng" : !u || u === "none" ? "none" : u;
const strikeToken = (s) =>
  s === true ? "sngStrike" : !s || s === "noStrike" ? "noStrike" : s;

// CSS that approximates a format for the preview.
function previewStyle(f, theme) {
  const u = underlineToken(f.underline);
  const s = strikeToken(f.strike);
  const deco = [u !== "none" && "underline", s !== "noStrike" && "line-through"]
    .filter(Boolean)
    .join(" ");
  const color = cssColor(f.color, theme) || "currentColor";
  return [
    `font-family:"${f.font || "Arial"}", system-ui`,
    `font-size:${Math.max(8, Math.min(48, f.size || 18))}px`,
    `font-weight:${f.bold ? 700 : 400}`,
    `font-style:${f.italic ? "italic" : "normal"}`,
    `color:${color}`,
    deco && `text-decoration:${deco}`,
    deco && u === "dbl" && "text-decoration-style:double",
    deco && u.startsWith("wavy") && "text-decoration-style:wavy",
    deco &&
      (u.startsWith("dot") || u.startsWith("dash")) &&
      `text-decoration-style:${u.startsWith("dot") ? "dotted" : "dashed"}`,
    f.underlineColor &&
      `text-decoration-color:${cssColor(f.underlineColor, theme)}`,
    f.cap === "all" && "text-transform:uppercase",
    f.cap === "small" && "font-variant:small-caps",
    f.spc && `letter-spacing:${(f.spc / 100) * 1.333}px`,
    f.baseline && `vertical-align:${f.baseline * 100}%`,
    f.baseline && "font-size:75%",
  ]
    .filter(Boolean)
    .join(";");
}

/**
 * The Font dialog. `format` is the selection's current format, `sample`
 * the text it shows, `fonts` the font list. Resolves to the changes, or
 * null when cancelled.
 */
export async function fontDialog({ format, sample, fonts, theme, tab = 0 }) {
  const f = { ...format };
  const changes = {};
  const set = (key, value) => {
    f[key] = value;
    changes[key] = value;
    updatePreview();
  };
  const previewText = el(
    "span",
    {},
    (sample || "").trim().slice(0, 60) || "Sample text",
  );
  const preview = el(
    "div",
    { class: "fmt-font-preview", "aria-label": "Preview", role: "img" },
    previewText,
  );
  function updatePreview() {
    previewText.style.cssText = previewStyle(f, theme);
    preview.setAttribute(
      "aria-label",
      `Preview: ${f.font || "Default font"}, ${f.size ? `${f.size} point` : "default size"}${f.bold ? ", bold" : ""}${f.italic ? ", italic" : ""}`,
    );
  }
  const fontId = "fmt-font-family";
  const fontList = el(
    "datalist",
    { id: `${fontId}-list` },
    ...fonts.map((name) => el("option", { value: name })),
  );
  const fontInput = el("input", {
    id: fontId,
    class: "input",
    list: `${fontId}-list`,
    value: f.font || "",
    autocomplete: "off",
    spellcheck: "false",
    onchange: (e) => {
      const v = e.target.value.trim();
      if (v) set("font", v);
    },
  });
  const styleValue = f.bold
    ? f.italic
      ? "bold-italic"
      : "bold"
    : f.italic
      ? "italic"
      : "regular";
  const fontTab = () => {
    const strike = strikeToken(f.strike);
    let strikeBox, doubleBox, superBox, subBox, smallBox, allBox;
    const effects = el(
      "fieldset",
      { class: "fmt-fieldset" },
      el("legend", {}, "Effects"),
      el(
        "div",
        { class: "fmt-check-grid" },
        (strikeBox = checkField({
          label: "Strikethrough",
          checked: strike === "sngStrike",
          onChange: (on) => {
            if (on) doubleBox.querySelector("input").checked = false;
            set("strike", on ? "sngStrike" : "noStrike");
          },
        })),
        (smallBox = checkField({
          label: "Small caps",
          checked: f.cap === "small",
          onChange: (on) => {
            if (on) allBox.querySelector("input").checked = false;
            set("cap", on ? "small" : "none");
          },
        })),
        (doubleBox = checkField({
          label: "Double strikethrough",
          checked: strike === "dblStrike",
          onChange: (on) => {
            if (on) strikeBox.querySelector("input").checked = false;
            set("strike", on ? "dblStrike" : "noStrike");
          },
        })),
        (allBox = checkField({
          label: "All caps",
          checked: f.cap === "all",
          onChange: (on) => {
            if (on) smallBox.querySelector("input").checked = false;
            set("cap", on ? "all" : "none");
          },
        })),
        (superBox = checkField({
          label: "Superscript",
          checked: (f.baseline || 0) > 0,
          onChange: (on) => {
            if (on) subBox.querySelector("input").checked = false;
            const n = on ? 30 : 0;
            offset.querySelector("input").value = String(n);
            set("baseline", n / 100);
          },
        })),
        checkField({
          label: "Equalize character height",
          checked: !!f.normalizeHeight,
          onChange: (on) => set("normalizeHeight", on),
        }),
        (subBox = checkField({
          label: "Subscript",
          checked: (f.baseline || 0) < 0,
          onChange: (on) => {
            if (on) superBox.querySelector("input").checked = false;
            const n = on ? -25 : 0;
            offset.querySelector("input").value = String(n);
            set("baseline", n / 100);
          },
        })),
      ),
    );
    const offset = numberField({
      label: "Offset",
      value: Math.round((f.baseline || 0) * 100),
      unit: "%",
      min: -100,
      max: 100,
      step: 1,
      places: 0,
      onCommit: (n) => {
        superBox.querySelector("input").checked = n > 0;
        subBox.querySelector("input").checked = n < 0;
        set("baseline", n / 100);
      },
    });
    effects.append(offset);
    return el(
      "div",
      { class: "fmt-stack" },
      el(
        "div",
        { class: "fmt-row fmt-font-row" },
        el(
          "div",
          { class: "fmt-field fmt-grow" },
          el("label", { for: fontId }, "Font"),
          fontInput,
          fontList,
        ),
        selectField({
          label: "Font style",
          value: styleValue,
          options: [
            ["regular", "Regular"],
            ["italic", "Italic"],
            ["bold", "Bold"],
            ["bold-italic", "Bold Italic"],
          ],
          onChange: (v) => {
            set("bold", v.startsWith("bold"));
            set("italic", v.endsWith("italic"));
          },
        }),
        numberField({
          label: "Size",
          value: f.size ?? "",
          unit: "pt",
          min: 1,
          max: 4000,
          step: 1,
          places: 1,
          onCommit: (n) => set("size", n),
        }),
      ),
      el(
        "div",
        { class: "fmt-row" },
        colorButton({
          label: "Font color",
          value: f.color,
          theme,
          automatic: { label: "Automatic", value: "scheme:tx1" },
          onPick: (v) => set("color", v),
        }),
        selectField({
          label: "Underline style",
          value: underlineToken(f.underline),
          options: UNDERLINE_STYLES,
          onChange: (v) => set("underline", v === "none" ? false : v),
        }),
        colorButton({
          label: "Underline color",
          value: f.underlineColor ?? null,
          theme,
          automatic: { label: "Same as Text", value: null },
          onPick: (v) => set("underlineColor", v),
        }),
      ),
      effects,
    );
  };
  const spacingTab = () => {
    const spc = f.spc || 0;
    let mode = spc > 0 ? "expanded" : spc < 0 ? "condensed" : "normal";
    let amount = Math.abs(spc) / 100;
    const by = numberField({
      label: "By",
      value: amount,
      unit: "pt",
      min: 0,
      max: 1584,
      step: 0.1,
      places: 1,
      disabled: mode === "normal",
      onCommit: (n) => {
        amount = n;
        apply();
      },
    });
    const apply = () => {
      by.querySelector("input").disabled = mode === "normal";
      set(
        "spc",
        mode === "normal"
          ? 0
          : Math.round((mode === "expanded" ? 1 : -1) * amount * 100),
      );
    };
    const kern = f.kern;
    let kernOn = kern !== undefined && kern > 0;
    let kernAt = kernOn ? kern / 100 : 12;
    const kernSize = numberField({
      label: "Points and above",
      value: kernAt,
      unit: "pt",
      min: 1,
      max: 4000,
      step: 1,
      disabled: !kernOn,
      onCommit: (n) => {
        kernAt = n;
        set("kern", Math.round(kernAt * 100));
      },
    });
    return el(
      "div",
      { class: "fmt-stack" },
      el(
        "div",
        { class: "fmt-row" },
        selectField({
          label: "Spacing",
          value: mode,
          options: [
            ["normal", "Normal"],
            ["expanded", "Expanded"],
            ["condensed", "Condensed"],
          ],
          onChange: (v) => {
            mode = v;
            if (v !== "normal" && amount === 0) {
              amount = 1;
              by.querySelector("input").value = "1";
            }
            apply();
          },
        }),
        by,
      ),
      el(
        "div",
        { class: "fmt-row" },
        checkField({
          label: "Kerning for fonts",
          checked: kernOn,
          onChange: (on) => {
            kernOn = on;
            kernSize.querySelector("input").disabled = !on;
            set("kern", on ? Math.round(kernAt * 100) : 0);
          },
        }),
        kernSize,
      ),
    );
  };
  const t = tabs(
    [
      { id: "font", label: "Font", render: fontTab },
      { id: "spacing", label: "Character Spacing", render: spacingTab },
    ],
    { label: "Font settings", initial: tab },
  );
  updatePreview();
  const ok = await formatDialog({
    title: "Font",
    body: el("div", { class: "fmt-stack" }, t.node, preview),
    wide: true,
  });
  return ok && Object.keys(changes).length ? changes : null;
}

/** Line spacing as the Paragraph dialog names it. */
function lineSpacingRule(lineSpacing) {
  if (!lineSpacing) return { rule: "single", at: 1 };
  if (lineSpacing.kind === "pts")
    return { rule: "exactly", at: lineSpacing.value };
  const v = lineSpacing.value;
  if (Math.abs(v - 1) < 0.001) return { rule: "single", at: 1 };
  if (Math.abs(v - 1.5) < 0.001) return { rule: "onehalf", at: 1.5 };
  if (Math.abs(v - 2) < 0.001) return { rule: "double", at: 2 };
  return { rule: "multiple", at: v };
}

/**
 * The Paragraph dialog. `paragraph` holds the first paragraph's settings:
 * { align, marL, indent, spaceBefore, spaceAfter, lineSpacing, tabs,
 * defaultTab } (EMU and points). Resolves to the changes or null.
 */
export async function paragraphDialog({ paragraph }) {
  const p = { ...paragraph };
  const changes = {};
  const set = (key, value) => {
    p[key] = value;
    changes[key] = value;
  };
  const special =
    (p.indent || 0) > 0 ? "first" : (p.indent || 0) < 0 ? "hanging" : "none";
  let specialMode = special;
  let specialBy = Math.abs(p.indent || 0) / IN;
  // Before text is where wrapped lines start; a first-line indent moves
  // the first line from there.
  const beforeText = (p.marL || 0) / IN;
  const by = numberField({
    label: "By",
    value: specialBy,
    unit: "in",
    min: 0,
    max: 20,
    step: 0.1,
    disabled: specialMode === "none",
    onCommit: (n) => {
      specialBy = n;
      writeIndent();
    },
  });
  const writeIndent = () => {
    by.querySelector("input").disabled = specialMode === "none";
    set(
      "indent",
      specialMode === "none"
        ? 0
        : Math.round((specialMode === "first" ? 1 : -1) * specialBy * IN),
    );
  };
  const { rule, at } = lineSpacingRule(p.lineSpacing);
  let lineRule = rule;
  let lineAt = at;
  const atField = numberField({
    label: "At",
    value: lineAt,
    unit: lineRule === "exactly" ? "pt" : "",
    min: 0,
    max: lineRule === "exactly" ? 1584 : 9.99,
    step: lineRule === "exactly" ? 1 : 0.1,
    disabled: lineRule !== "exactly" && lineRule !== "multiple",
    onCommit: (n) => {
      lineAt = n;
      writeLine();
    },
  });
  const writeLine = () => {
    const input = atField.querySelector("input");
    input.disabled = lineRule !== "exactly" && lineRule !== "multiple";
    atField
      .querySelector(".fmt-unit")
      ?.replaceChildren(lineRule === "exactly" ? "pt" : "");
    const value =
      lineRule === "single"
        ? null
        : lineRule === "onehalf"
          ? { kind: "pct", value: 1.5 }
          : lineRule === "double"
            ? { kind: "pct", value: 2 }
            : lineRule === "exactly"
              ? { kind: "pts", value: Math.max(0, lineAt) }
              : { kind: "pct", value: Math.max(0, lineAt) };
    set("lineSpacing", value);
  };
  const tabsButton = el(
    "button",
    {
      type: "button",
      class: "btn secondary",
      onclick: async () => {
        const result = await tabsDialog({
          tabs: p.tabs || [],
          defaultTab: p.defaultTab ?? IN,
        });
        if (!result) return;
        set("tabs", result.tabs);
        set("defaultTab", result.defaultTab);
      },
    },
    "Tabs…",
  );
  const body = el(
    "div",
    { class: "fmt-stack" },
    el(
      "fieldset",
      { class: "fmt-fieldset" },
      el("legend", {}, "General"),
      selectField({
        label: "Alignment",
        value: p.align || "left",
        options: [
          ["left", "Left"],
          ["center", "Centered"],
          ["right", "Right"],
          ["justify", "Justified"],
          ["distribute", "Distributed"],
        ],
        onChange: (v) => set("align", v),
      }),
    ),
    el(
      "fieldset",
      { class: "fmt-fieldset" },
      el("legend", {}, "Indentation"),
      el(
        "div",
        { class: "fmt-row" },
        numberField({
          label: "Before text",
          value: beforeText,
          unit: "in",
          min: 0,
          max: 20,
          step: 0.1,
          onCommit: (n) => set("marL", Math.round(n * IN)),
        }),
        selectField({
          label: "Special",
          value: specialMode,
          options: [
            ["none", "(none)"],
            ["first", "First line"],
            ["hanging", "Hanging"],
          ],
          onChange: (v) => {
            specialMode = v;
            if (v !== "none" && specialBy === 0) {
              specialBy = 0.5;
              by.querySelector("input").value = "0.5";
            }
            writeIndent();
          },
        }),
        by,
      ),
    ),
    el(
      "fieldset",
      { class: "fmt-fieldset" },
      el("legend", {}, "Spacing"),
      el(
        "div",
        { class: "fmt-row" },
        numberField({
          label: "Before",
          value: p.spaceBefore || 0,
          unit: "pt",
          min: 0,
          max: 1584,
          step: 1,
          onCommit: (n) => set("spaceBefore", n),
        }),
        numberField({
          label: "After",
          value: p.spaceAfter || 0,
          unit: "pt",
          min: 0,
          max: 1584,
          step: 1,
          onCommit: (n) => set("spaceAfter", n),
        }),
      ),
      el(
        "div",
        { class: "fmt-row" },
        selectField({
          label: "Line spacing",
          value: lineRule,
          options: [
            ["single", "Single"],
            ["onehalf", "1.5 lines"],
            ["double", "Double"],
            ["exactly", "Exactly"],
            ["multiple", "Multiple"],
          ],
          onChange: (v) => {
            lineRule = v;
            const input = atField.querySelector("input");
            if (v === "exactly") {
              lineAt = lineAt < 4 ? 18 : lineAt;
              input.max = "1584";
              input.step = "1";
            } else {
              lineAt =
                v === "multiple"
                  ? lineAt > 9.99
                    ? 1.2
                    : lineAt
                  : { single: 1, onehalf: 1.5, double: 2 }[v];
              input.max = "9.99";
              input.step = "0.1";
            }
            input.value = String(lineAt);
            writeLine();
          },
        }),
        atField,
      ),
    ),
    el("div", { class: "fmt-row fmt-end" }, tabsButton),
  );
  const ok = await formatDialog({ title: "Paragraph", body, wide: true });
  return ok && Object.keys(changes).length ? changes : null;
}

/** The Tabs dialog: tab stops and the default spacing. */
export async function tabsDialog({ tabs: initial, defaultTab }) {
  let stops = initial.map((t) => ({ ...t }));
  let spacing = defaultTab / IN;
  let position = 1;
  let align = "l";
  const list = el("ul", {
    class: "fmt-tab-list",
    role: "listbox",
    "aria-label": "Tab stops",
  });
  const label = (a) =>
    ({ l: "Left", ctr: "Center", r: "Right", dec: "Decimal" })[a];
  const render = () => {
    stops.sort((a, b) => a.pos - b.pos);
    list.replaceChildren(
      ...stops.map((stop, i) =>
        el(
          "li",
          { role: "option", "aria-selected": "false" },
          el("span", {}, `${(stop.pos / IN).toFixed(2)}″`),
          el("span", { class: "muted" }, label(stop.align)),
          el(
            "button",
            {
              type: "button",
              class: "btn icon-btn small",
              "aria-label": `Clear the tab stop at ${(stop.pos / IN).toFixed(2)} inches`,
              title: "Clear",
              onclick: () => {
                stops.splice(i, 1);
                render();
              },
            },
            "×",
          ),
        ),
      ),
    );
    if (!stops.length)
      list.append(el("li", { class: "helper" }, "No tab stops yet."));
  };
  render();
  const body = el(
    "div",
    { class: "fmt-stack" },
    el(
      "div",
      { class: "fmt-stack" },
      numberField({
        label: "Tab stop position",
        value: position,
        unit: "in",
        min: 0,
        max: 50,
        step: 0.25,
        onCommit: (n) => (position = n),
      }),
      el(
        "div",
        { class: "fmt-field" },
        el("span", { class: "fmt-label" }, "Alignment"),
        segmented({
          label: "Alignment",
          value: align,
          options: [
            ["l", "Left"],
            ["ctr", "Center"],
            ["r", "Right"],
            ["dec", "Decimal"],
          ],
          onChange: (v) => (align = v),
        }),
      ),
    ),
    el(
      "div",
      { class: "fmt-row" },
      el(
        "button",
        {
          type: "button",
          class: "btn secondary",
          onclick: () => {
            const pos = Math.round(position * IN);
            stops = stops.filter((s) => Math.abs(s.pos - pos) > 100);
            if (stops.length < 32) stops.push({ pos, align });
            render();
          },
        },
        "Set",
      ),
      el(
        "button",
        {
          type: "button",
          class: "btn secondary",
          onclick: () => {
            stops = [];
            render();
          },
        },
        "Clear All",
      ),
    ),
    list,
    numberField({
      label: "Default tab stops",
      value: spacing,
      unit: "in",
      min: 0.1,
      max: 10,
      step: 0.25,
      onCommit: (n) => (spacing = n),
    }),
  );
  const ok = await formatDialog({ title: "Tabs", body });
  return ok ? { tabs: stops, defaultTab: Math.round(spacing * IN) } : null;
}

/** The Columns dialog. Resolves to { count, gapEmu } or null. */
export async function columnsDialog({ count = 1, gapEmu = 0 }) {
  let n = count;
  let gap = gapEmu / IN;
  const body = el(
    "div",
    { class: "fmt-row" },
    numberField({
      label: "Number",
      value: n,
      min: 1,
      max: 16,
      step: 1,
      places: 0,
      onCommit: (v) => (n = Math.round(v)),
    }),
    numberField({
      label: "Spacing",
      value: gap,
      unit: "in",
      min: 0,
      max: 20,
      step: 0.1,
      onCommit: (v) => (gap = v),
    }),
  );
  const ok = await formatDialog({ title: "Columns", body });
  return ok ? { count: n, gapEmu: Math.round(gap * IN) } : null;
}

export { PT };
