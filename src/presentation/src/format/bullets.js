// Bullets and numbering: the bullet and numbering galleries the ribbon's
// drop-downs show, the Bullets and Numbering dialog (size, color, start
// number, a bullet from any symbol, or a picture), and the symbol picker.
import { el } from "../ui.js";
import {
  colorButton,
  cssColor,
  formatDialog,
  galleryGrid,
  numberField,
  tabs,
} from "./controls.js";

/** Character bullets: [id, label, char, font or null to follow the text]. */
export const BULLET_STYLES = [
  ["round", "Filled Round Bullets", "•", "Arial"],
  ["hollow", "Hollow Round Bullets", "◦", "Arial"],
  ["square", "Filled Square Bullets", "▪", "Arial"],
  ["hollowSquare", "Hollow Square Bullets", "□", null],
  ["diamond", "Filled Diamond Bullets", "◆", null],
  ["arrow", "Arrow Bullets", "➤", null],
  ["check", "Check Mark Bullets", "✓", null],
  ["star", "Star Bullets", "★", null],
  ["dash", "Dash Bullets", "–", "Arial"],
];

/** Autonumber schemes on offer: [scheme, label, sample(n)]. */
export const NUMBER_STYLES = [
  ["arabicPeriod", "Numbers: 1. 2. 3.", (n) => `${n}.`],
  ["arabicParenR", "Numbers with parenthesis: 1) 2) 3)", (n) => `${n})`],
  ["arabicParenBoth", "Numbers in parentheses: (1) (2) (3)", (n) => `(${n})`],
  [
    "romanUcPeriod",
    "Uppercase Roman numerals: I. II. III.",
    (n) => `${roman(n)}.`,
  ],
  ["alphaUcPeriod", "Uppercase letters: A. B. C.", (n) => `${alpha(n)}.`],
  [
    "alphaLcParenR",
    "Lowercase letters with parenthesis: a) b) c)",
    (n) => `${alpha(n).toLowerCase()})`,
  ],
  [
    "alphaLcPeriod",
    "Lowercase letters: a. b. c.",
    (n) => `${alpha(n).toLowerCase()}.`,
  ],
  [
    "romanLcPeriod",
    "Lowercase Roman numerals: i. ii. iii.",
    (n) => `${roman(n).toLowerCase()}.`,
  ],
  ["circleNumDbPlain", "Circled numbers: ① ② ③", (n) => circled(n)],
  [
    "circleNumWdBlackPlain",
    "Filled circled numbers: ❶ ❷ ❸",
    (n) => circled(n, true),
  ],
];

function roman(n) {
  const map = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let out = "";
  for (const [v, s] of map)
    while (n >= v) {
      out += s;
      n -= v;
    }
  return out;
}
function alpha(n) {
  let out = "";
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}
function circled(n, black = false) {
  if (black && n >= 1 && n <= 10) return String.fromCodePoint(0x2775 + n);
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x245f + n);
  return `${n}.`;
}

/** The current list style of a paragraph, as the galleries name it. */
export function bulletKind(P, shape, index) {
  let bullet = null;
  try {
    bullet = P.getParagraphBullet(shape, index);
  } catch {}
  if (bullet === "bullet") return { kind: "bullet", char: "•" };
  if (bullet === "number")
    return { kind: "number", scheme: "arabicPeriod", startAt: 1 };
  if (bullet && typeof bullet === "object" && "char" in bullet)
    return { kind: "bullet", char: bullet.char };
  if (bullet && typeof bullet === "object" && "autoNum" in bullet)
    return {
      kind: "number",
      scheme: bullet.autoNum,
      startAt: bullet.startAt ?? 1,
    };
  try {
    if (P.isParagraphBulletPicture(shape, index)) return { kind: "picture" };
  } catch {}
  return { kind: "none" };
}

/**
 * Applies a list style to paragraphs of a shape:
 * `{ kind: "none" }`, `{ kind: "bullet", char, font }`,
 * `{ kind: "number", scheme, startAt }` or `{ kind: "picture", bytes }`,
 * plus optional `color` (null follows the text) and `sizePct`.
 */
export function applyListStyle(P, shape, indexes, style) {
  let pictureId = null;
  for (const pi of indexes) {
    if (style.kind === "none") {
      P.setParagraphBullet(shape, pi, "none");
      P.setParagraphLayout(shape, pi, { marL: null, indent: null });
      continue;
    }
    if (style.kind === "picture")
      pictureId = P.setParagraphBulletPicture(
        shape,
        pi,
        pictureId ? { relationshipId: pictureId } : { bytes: style.bytes },
      );
    else
      P.setParagraphBullet(
        shape,
        pi,
        style.kind === "number"
          ? {
              autoNum: style.scheme,
              ...(style.startAt > 1 ? { startAt: style.startAt } : {}),
            }
          : style.char === "•"
            ? "bullet"
            : { char: style.char },
      );
    const format = {};
    if (style.color !== undefined) format.color = style.color;
    if (style.sizePct !== undefined) format.sizePct = style.sizePct;
    if (style.kind === "bullet" && style.font !== undefined)
      format.font = style.font;
    if (Object.keys(format).length)
      P.setParagraphBulletFormat(shape, pi, format);
  }
}

// A small picture of a list: three lines of "text" led by the bullet.
function listPreview(marks, { color = null, font = null } = {}) {
  return el(
    "span",
    { class: "fmt-list-preview", "aria-hidden": "true" },
    ...marks.map((mark) =>
      el(
        "span",
        { class: "fmt-list-row" },
        el(
          "span",
          {
            class: "fmt-list-mark",
            style: `${color ? `color:${color};` : ""}${font ? `font-family:${font};` : ""}`,
          },
          mark,
        ),
        el("span", { class: "fmt-list-line" }),
      ),
    ),
  );
}
const noneCell = () =>
  el("span", { class: "fmt-list-none", "aria-hidden": "true" }, "None");

/** Menu items for the ribbon's Bullets drop-down. */
export function bulletMenuItems({ current, choose, openDialog }) {
  const items = [
    {
      label: "None",
      checked: current.kind === "none",
      render: noneCell,
      onSelect: () => choose({ kind: "none" }),
    },
    ...BULLET_STYLES.map(([, label, char, font]) => ({
      label,
      checked: current.kind === "bullet" && current.char === char,
      render: () => listPreview([char, char, char], { font }),
      onSelect: () => choose({ kind: "bullet", char, font }),
    })),
  ];
  return [
    { custom: galleryGrid(items, { label: "Bullet styles", columns: 5 }) },
    { separator: true },
    {
      label: "Bullets and Numbering…",
      icon: "o:bullets",
      onSelect: () => openDialog("bullets"),
    },
  ];
}

/** Menu items for the ribbon's Numbering drop-down. */
export function numberingMenuItems({ current, choose, openDialog }) {
  const items = [
    {
      label: "None",
      checked: current.kind === "none",
      render: noneCell,
      onSelect: () => choose({ kind: "none" }),
    },
    ...NUMBER_STYLES.map(([scheme, label, sample]) => ({
      label,
      checked: current.kind === "number" && current.scheme === scheme,
      render: () => listPreview([sample(1), sample(2), sample(3)]),
      onSelect: () =>
        choose({
          kind: "number",
          scheme,
          startAt: current.kind === "number" ? current.startAt : 1,
        }),
    })),
  ];
  return [
    { custom: galleryGrid(items, { label: "Numbering styles", columns: 4 }) },
    { separator: true },
    {
      label: "Bullets and Numbering…",
      icon: "o:numbering",
      onSelect: () => openDialog("numbering"),
    },
  ];
}

// Symbol sets for a custom bullet, by Unicode block.
const SYMBOL_SETS = [
  ["Bullets", "•◦‣⁃∙●○◉◎◘◙■□▪▫▬▭▮▯▰▱◆◇◈◊❖✦✧✱✲✳✴✵✶✷✸✹✺"],
  ["Arrows", "→⇒⇨➔➘➙➚➛➜➝➞➟➠➡➢➣➤➥➦➧➨➩➪➫➬➭➮➯➱➲➳➴➵➶➷➸➹➺➻➼➽➾↠↣↦⇢⇾"],
  ["Checks and crosses", "✓✔✕✖✗✘☐☑☒⊕⊗⊙⊛⊠⊡"],
  ["Stars and flowers", "★☆✡✪✫✬✭✮✯✰❀❁❂❃❄❅❆❇❈❉❊❋✿✾✽✼"],
  ["Hands and marks", "☛☞✌✍✎✏✐✑✒❍❏❐❑❒❢❣❤❥❦❧♠♣♥♦♤♧♡♢"],
  ["Math and signs", "+−±×÷=≠≈≤≥∞∑∏√∂∆∇∈∉∩∪⊂⊃⊆⊇∧∨¬∀∃§¶†‡※"],
];

/** Lets a person choose any symbol; resolves to the character or null. */
export async function pickSymbol({ initial = "•" } = {}) {
  let chosen = initial;
  const preview = el("span", { class: "fmt-symbol-preview" }, chosen);
  const code = el("input", {
    class: "input",
    "aria-label": "Character code (hexadecimal)",
    value: chosen.codePointAt(0).toString(16).toUpperCase(),
    maxlength: 6,
    oninput: (e) => {
      const n = parseInt(e.target.value, 16);
      if (Number.isFinite(n) && n > 0x1f && n <= 0x10ffff)
        set(String.fromCodePoint(n), false);
    },
  });
  function set(ch, updateCode = true) {
    chosen = ch;
    preview.textContent = ch;
    if (updateCode) code.value = ch.codePointAt(0).toString(16).toUpperCase();
    for (const b of body.querySelectorAll(".symbol-cell"))
      b.setAttribute("aria-pressed", String(b.textContent === ch));
  }
  const groups = SYMBOL_SETS.map(([name, chars]) =>
    el(
      "fieldset",
      { class: "fmt-symbol-set" },
      el("legend", {}, name),
      el(
        "div",
        { class: "symbol-grid" },
        ...Array.from(chars).map((ch) =>
          el(
            "button",
            {
              type: "button",
              class: "symbol-cell",
              "aria-label": `${ch} U+${ch.codePointAt(0).toString(16).toUpperCase()}`,
              "aria-pressed": String(ch === chosen),
              onclick: () => set(ch),
              ondblclick: () => {
                set(ch);
                body.closest("dialog")?.querySelector(".btn.primary")?.click();
              },
            },
            ch,
          ),
        ),
      ),
    ),
  );
  const body = el(
    "div",
    { class: "fmt-symbol-picker" },
    el("div", { class: "fmt-symbol-scroll" }, ...groups),
    el(
      "div",
      { class: "fmt-symbol-footer" },
      preview,
      el("label", { class: "fmt-inline" }, "Character code", code),
    ),
  );
  const ok = await formatDialog({ title: "Symbol", body, wide: true });
  return ok ? chosen : null;
}

/**
 * The Bullets and Numbering dialog. `current` is the first paragraph's
 * style with its color and size; resolves to the style chosen, or null.
 */
export async function bulletsDialog({
  initialTab = "bullets",
  current,
  theme,
  pickImage,
}) {
  let style = { ...current };
  let color = current.color ?? null;
  let sizePct = current.sizePct ?? 1;
  let startAt = current.startAt ?? 1;
  let chosenBullet =
    current.kind === "bullet"
      ? { char: current.char, font: current.font ?? null }
      : null;
  let pictureBytes = null;
  const renderGrid = (kind) => {
    const shown = cssColor(color, theme);
    const cells =
      kind === "bullets"
        ? [
            { kind: "none" },
            ...BULLET_STYLES.map(([, , char, font]) => ({
              kind: "bullet",
              char,
              font,
            })),
            ...(chosenBullet &&
            !BULLET_STYLES.some(([, , c]) => c === chosenBullet.char)
              ? [{ kind: "bullet", ...chosenBullet }]
              : []),
          ]
        : [
            { kind: "none" },
            ...NUMBER_STYLES.map(([scheme]) => ({ kind: "number", scheme })),
          ];
    const grid = el("div", {
      class: "fmt-gallery fmt-dialog-gallery",
      role: "radiogroup",
      "aria-label": kind === "bullets" ? "Bullet styles" : "Numbering styles",
      style: "--fmt-columns:5",
    });
    const same = (a, b) =>
      a.kind === b.kind &&
      (a.kind !== "bullet" || a.char === b.char) &&
      (a.kind !== "number" || a.scheme === b.scheme);
    const buttons = cells.map((cell) => {
      const label =
        cell.kind === "none"
          ? "None"
          : cell.kind === "bullet"
            ? (BULLET_STYLES.find(([, , c]) => c === cell.char)?.[1] ??
              `Bullet ${cell.char}`)
            : NUMBER_STYLES.find(([s]) => s === cell.scheme)[1];
      const sample =
        cell.kind === "number"
          ? NUMBER_STYLES.find(([s]) => s === cell.scheme)[2]
          : null;
      const button = el(
        "button",
        {
          type: "button",
          role: "radio",
          class: "fmt-gallery-cell",
          "aria-label": label,
          title: label,
          "aria-checked": String(same(cell, style)),
          tabindex: same(cell, style) ? 0 : -1,
          onclick: () => {
            style = { ...cell };
            if (cell.kind === "bullet")
              chosenBullet = { char: cell.char, font: cell.font };
            for (const b of buttons) {
              const on = b === button;
              b.setAttribute("aria-checked", String(on));
              b.tabIndex = on ? 0 : -1;
            }
          },
        },
        cell.kind === "none"
          ? noneCell()
          : cell.kind === "bullet"
            ? listPreview([cell.char, cell.char, cell.char], {
                color: shown,
                font: cell.font,
              })
            : listPreview(
                [sample(startAt), sample(startAt + 1), sample(startAt + 2)],
                { color: shown },
              ),
      );
      return button;
    });
    if (!buttons.some((b) => b.tabIndex === 0)) buttons[0].tabIndex = 0;
    grid.addEventListener("keydown", (e) => {
      const at = buttons.indexOf(document.activeElement);
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 5, ArrowUp: -5 }[
        e.key
      ];
      if (at < 0 || !step || !buttons[at + step]) return;
      e.preventDefault();
      buttons[at + step].focus();
      buttons[at + step].click();
    });
    grid.append(...buttons);
    return grid;
  };
  const holders = {};
  const refresh = () => {
    for (const [kind, holder] of Object.entries(holders))
      holder.replaceChildren(renderGrid(kind));
  };
  const common = () => [
    numberField({
      label: "Size (% of text)",
      value: Math.round(sizePct * 100),
      unit: "%",
      min: 25,
      max: 400,
      step: 5,
      onCommit: (n) => (sizePct = n / 100),
    }),
    colorButton({
      label: "Color",
      value: color,
      theme,
      automatic: { label: "Follow Text Color", value: null },
      onPick: (v) => {
        color = v;
        refresh();
      },
    }),
  ];
  const pictureNote = el(
    "p",
    { class: "helper", hidden: true },
    "The picture you chose leads each paragraph. Choose OK to use it.",
  );
  const t = tabs(
    [
      {
        id: "bullets",
        label: "Bulleted",
        render: () => {
          holders.bullets = el("div", {}, renderGrid("bullets"));
          return el(
            "div",
            { class: "fmt-stack" },
            holders.bullets,
            el("div", { class: "fmt-row" }, ...common()),
            el(
              "div",
              { class: "fmt-row" },
              el(
                "button",
                {
                  type: "button",
                  class: "btn secondary",
                  onclick: async () => {
                    const ch = await pickSymbol({
                      initial: chosenBullet?.char ?? "•",
                    });
                    if (!ch) return;
                    chosenBullet = { char: ch, font: null };
                    style = { kind: "bullet", char: ch, font: null };
                    refresh();
                  },
                },
                "Customize…",
              ),
              el(
                "button",
                {
                  type: "button",
                  class: "btn secondary",
                  onclick: async () => {
                    const bytes = await pickImage();
                    if (!bytes) return;
                    pictureBytes = bytes;
                    style = { kind: "picture", bytes };
                    pictureNote.hidden = false;
                    refresh();
                  },
                },
                "Picture…",
              ),
            ),
            pictureNote,
          );
        },
      },
      {
        id: "numbering",
        label: "Numbered",
        render: () => {
          holders.numbering = el("div", {}, renderGrid("numbering"));
          return el(
            "div",
            { class: "fmt-stack" },
            holders.numbering,
            el(
              "div",
              { class: "fmt-row" },
              ...common(),
              numberField({
                label: "Start at",
                value: startAt,
                min: 1,
                max: 32767,
                step: 1,
                places: 0,
                onCommit: (n) => {
                  startAt = Math.round(n);
                  refresh();
                },
              }),
            ),
          );
        },
      },
    ],
    {
      label: "List type",
      initial: initialTab === "numbering" ? 1 : 0,
    },
  );
  const ok = await formatDialog({
    title: "Bullets and Numbering",
    body: t.node,
    wide: true,
  });
  if (!ok) return null;
  if (style.kind === "picture" && pictureBytes)
    return { kind: "picture", bytes: pictureBytes, sizePct };
  if (style.kind === "number")
    return { kind: "number", scheme: style.scheme, startAt, color, sizePct };
  if (style.kind === "bullet")
    return {
      kind: "bullet",
      char: style.char,
      font: style.font ?? null,
      color,
      sizePct,
    };
  return { kind: "none" };
}

// For tests.
export const _private = { roman, alpha, circled };
