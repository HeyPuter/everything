// Equations: typed as TeX-style math with palettes of structures and
// symbols, drawn by our own layout (src/insert/math) and placed as an SVG
// picture with a PNG stand-in. The source travels in the picture's object
// data and alt text, so double-clicking it opens it for editing again.
import { el, dialog } from "../ui.js";
import { renderMathSvg, browserMeasure } from "./math/layout.js";
import { PLACEHOLDER } from "./math/parse.js";
import { SYMBOLS, SYMBOL_PALETTE } from "./math/symbols.js";
import { svgToPng, svgDataUrl } from "./util.js";

const P_ = PLACEHOLDER;
// Structures, by group: [label, source]. ⬚ marks a slot to fill in.
export const STRUCTURES = [
  [
    "Fraction",
    [
      ["Stacked fraction", `\\frac{${P_}}{${P_}}`],
      ["Small fraction", `\\tfrac{${P_}}{${P_}}`],
      ["Linear fraction", `${P_}/${P_}`],
      ["dy over dx", "\\frac{dy}{dx}"],
      ["Partial derivative", `\\frac{\\partial ${P_}}{\\partial ${P_}}`],
    ],
  ],
  [
    "Script",
    [
      ["Superscript", `${P_}^{${P_}}`],
      ["Subscript", `${P_}_{${P_}}`],
      ["Subscript and superscript", `${P_}_{${P_}}^{${P_}}`],
      ["x squared", "x^2"],
      ["e to the minus i omega t", "e^{-i\\omega t}"],
    ],
  ],
  [
    "Radical",
    [
      ["Square root", `\\sqrt{${P_}}`],
      ["Root with degree", `\\sqrt[${P_}]{${P_}}`],
      ["Cube root", `\\sqrt[3]{${P_}}`],
      ["Distance", "\\sqrt{a^2+b^2}"],
    ],
  ],
  [
    "Integral",
    [
      ["Integral", `\\int ${P_}\\,d${P_}`],
      ["Definite integral", `\\int_{${P_}}^{${P_}} ${P_}\\,d${P_}`],
      ["Double integral", `\\iint ${P_}\\,dA`],
      ["Triple integral", `\\iiint ${P_}\\,dV`],
      ["Contour integral", `\\oint ${P_}\\,d${P_}`],
    ],
  ],
  [
    "Large Operator",
    [
      ["Summation", `\\sum_{${P_}}^{${P_}} ${P_}`],
      ["Product", `\\prod_{${P_}}^{${P_}} ${P_}`],
      ["Union", `\\bigcup_{${P_}} ${P_}`],
      ["Intersection", `\\bigcap_{${P_}} ${P_}`],
      ["Sum over k", "\\sum_{k=0}^{n} a_k"],
    ],
  ],
  [
    "Bracket",
    [
      ["Parentheses", `\\left(${P_}\\right)`],
      ["Square brackets", `\\left[${P_}\\right]`],
      ["Braces", `\\left\\{${P_}\\right\\}`],
      ["Absolute value", `\\left|${P_}\\right|`],
      ["Norm", `\\left\\|${P_}\\right\\|`],
      ["Angle brackets", `\\left\\langle ${P_}\\right\\rangle`],
      ["Floor", `\\left\\lfloor ${P_}\\right\\rfloor`],
      ["Ceiling", `\\left\\lceil ${P_}\\right\\rceil`],
      ["Cases", `\\begin{cases} ${P_} & ${P_} \\\\ ${P_} & ${P_} \\end{cases}`],
      ["Binomial", `\\binom{${P_}}{${P_}}`],
    ],
  ],
  [
    "Function",
    [
      ["Sine", `\\sin ${P_}`],
      ["Cosine", `\\cos ${P_}`],
      ["Tangent", `\\tan ${P_}`],
      ["Natural log", `\\ln ${P_}`],
      ["Logarithm base", `\\log_{${P_}} ${P_}`],
      ["Exponential", `\\exp ${P_}`],
      ["Inverse sine", `\\arcsin ${P_}`],
      ["Hyperbolic sine", `\\sinh ${P_}`],
    ],
  ],
  [
    "Accent",
    [
      ["Hat", `\\hat{${P_}}`],
      ["Bar", `\\bar{${P_}}`],
      ["Vector", `\\vec{${P_}}`],
      ["Dot", `\\dot{${P_}}`],
      ["Double dot", `\\ddot{${P_}}`],
      ["Tilde", `\\tilde{${P_}}`],
      ["Overline", `\\overline{${P_}}`],
      ["Underline", `\\underline{${P_}}`],
      ["Arrow over", `\\overrightarrow{${P_}}`],
      ["Overbrace", `\\overbrace{${P_}}`],
      ["Underbrace", `\\underbrace{${P_}}`],
    ],
  ],
  [
    "Limit and Log",
    [
      ["Limit", `\\lim_{${P_}\\to ${P_}} ${P_}`],
      ["Limit to infinity", `\\lim_{n\\to\\infty} ${P_}`],
      ["Maximum", `\\max_{${P_}} ${P_}`],
      ["Minimum", `\\min_{${P_}} ${P_}`],
      ["Log", `\\log ${P_}`],
    ],
  ],
  [
    "Operator",
    [
      ["Defined as", "\\coloneqq"],
      ["Equals by definition", "\\triangleq"],
      ["Over arrow", `\\overset{${P_}}{\\rightarrow}`],
      ["Under arrow", `\\underset{${P_}}{\\rightarrow}`],
      ["Delta equals", "\\overset{\\Delta}{=}"],
    ],
  ],
  [
    "Matrix",
    [
      [
        "2 × 2 matrix",
        `\\begin{matrix} ${P_} & ${P_} \\\\ ${P_} & ${P_} \\end{matrix}`,
      ],
      [
        "2 × 2 in parentheses",
        `\\begin{pmatrix} ${P_} & ${P_} \\\\ ${P_} & ${P_} \\end{pmatrix}`,
      ],
      [
        "2 × 2 in brackets",
        `\\begin{bmatrix} ${P_} & ${P_} \\\\ ${P_} & ${P_} \\end{bmatrix}`,
      ],
      [
        "Determinant",
        `\\begin{vmatrix} ${P_} & ${P_} \\\\ ${P_} & ${P_} \\end{vmatrix}`,
      ],
      [
        "3 × 3 matrix",
        `\\begin{pmatrix} ${P_} & ${P_} & ${P_} \\\\ ${P_} & ${P_} & ${P_} \\\\ ${P_} & ${P_} & ${P_} \\end{pmatrix}`,
      ],
      [
        "Column vector",
        `\\begin{pmatrix} ${P_} \\\\ ${P_} \\\\ ${P_} \\end{pmatrix}`,
      ],
      ["Identity", "\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}"],
    ],
  ],
];

// Well-known formulas offered from the Equation button.
export const BUILT_IN_EQUATIONS = [
  ["Area of a circle", "A=\\pi r^2"],
  ["Quadratic formula", "x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}"],
  ["Pythagorean theorem", "a^2+b^2=c^2"],
  ["Binomial theorem", "(x+a)^n=\\sum_{k=0}^{n}\\binom{n}{k}x^k a^{n-k}"],
  ["Euler's identity", "e^{i\\pi}+1=0"],
  [
    "Taylor expansion",
    "e^x=1+\\frac{x}{1!}+\\frac{x^2}{2!}+\\frac{x^3}{3!}+\\cdots",
  ],
  [
    "Fourier series",
    "f(x)=a_0+\\sum_{n=1}^{\\infty}\\left(a_n\\cos\\frac{n\\pi x}{L}+b_n\\sin\\frac{n\\pi x}{L}\\right)",
  ],
  [
    "Gaussian integral",
    "\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx=\\sqrt{\\pi}",
  ],
  ["Trig identity", "\\sin^2\\theta+\\cos^2\\theta=1"],
];

const PX = 64; // pixels per em in the stored drawing
const DEFAULT_PT = 28;

export function createEquationFeatures(ctx) {
  const { P } = ctx;
  const isEquation = (obj) =>
    !!obj &&
    P.getShapeKind(obj) === "picture" &&
    P.getShapeObjectData(obj)?.type === "equation";
  const current = () => {
    const obj = ctx.currentShape();
    return isEquation(obj) ? obj : null;
  };

  function render(source, color, px = PX) {
    return renderMathSvg(source, {
      size: px,
      color,
      measure: browserMeasure(),
    });
  }

  /** The equation dialog; resolves to the source, or null. */
  async function editDialog(initial = "", { title = "Equation" } = {}) {
    const input = el("textarea", {
      class: "input equation-input",
      rows: 3,
      spellcheck: "false",
      autocapitalize: "off",
      "aria-label": "Equation (TeX-style)",
      "aria-describedby": "equation-help",
      value: initial,
    });
    const preview = el("div", {
      class: "equation-preview",
      role: "img",
      "aria-label": "Preview",
    });
    const help = el(
      "p",
      { class: "equation-help", id: "equation-help" },
      "Type math such as x^2, \\frac{a}{b}, \\sqrt{x} or \\alpha, or pick a structure. Tab moves to the next empty slot.",
    );
    const update = () => {
      const value = input.value;
      const { svg } = render(value || PLACEHOLDER, "#111111", 40);
      preview.replaceChildren(
        el("img", {
          src: svgDataUrl(svg),
          alt: value ? `Preview of ${value}` : "Empty equation",
        }),
      );
    };
    // Inserting a template selects its first slot, so typing fills it.
    const insert = (snippet) => {
      const start = input.selectionStart,
        end = input.selectionEnd;
      const before = input.value.slice(0, start);
      // A selection replaces the first slot of a structure placed around it.
      const selected = input.value.slice(start, end);
      let text = snippet;
      if (selected && text.includes(PLACEHOLDER))
        text = text.replace(PLACEHOLDER, selected);
      const needsSpace = /\\[a-zA-Z]+$/.test(before) && /^[a-zA-Z]/.test(text);
      input.value =
        before + (needsSpace ? " " : "") + text + input.value.slice(end);
      const base = start + (needsSpace ? 1 : 0);
      const slot = text.indexOf(PLACEHOLDER);
      input.focus();
      if (slot >= 0) input.setSelectionRange(base + slot, base + slot + 1);
      else input.setSelectionRange(base + text.length, base + text.length);
      update();
    };
    input.addEventListener("input", update);
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || e.shiftKey) return;
      const next = input.value.indexOf(PLACEHOLDER, input.selectionEnd);
      const first = next >= 0 ? next : input.value.indexOf(PLACEHOLDER);
      if (first < 0) return;
      e.preventDefault();
      input.setSelectionRange(first, first + 1);
    });
    const thumb = (source) => {
      const node = el("span", {
        class: "equation-thumb",
        "aria-hidden": "true",
      });
      node.innerHTML = render(source, "currentColor", 18).svg;
      return node;
    };
    const tabs = el("div", {
      class: "equation-tabs",
      role: "tablist",
      "aria-label": "Palettes",
    });
    const panel = el("div", { class: "equation-palette", role: "tabpanel" });
    const groups = [
      ...STRUCTURES.map(([label, items]) => [
        label,
        items.map(([name, source]) => [name, source, thumb(source)]),
      ]),
      ...SYMBOL_PALETTE.map(([label, names]) => [
        label,
        names
          .filter((n) => SYMBOLS[n])
          .map((n) => [
            `\\${n}`,
            `\\${n} `,
            el(
              "span",
              { class: "equation-glyph", "aria-hidden": "true" },
              SYMBOLS[n].glyph,
            ),
          ]),
      ]),
    ];
    const show = (index) => {
      [...tabs.children].forEach((t, i) => {
        t.setAttribute("aria-selected", String(i === index));
        t.tabIndex = i === index ? 0 : -1;
      });
      const [, items] = groups[index];
      panel.replaceChildren(
        ...items.map(([name, source, art]) =>
          el(
            "button",
            {
              type: "button",
              class: "equation-item",
              title: name,
              "aria-label": name,
              onclick: () => insert(source),
            },
            art,
          ),
        ),
      );
    };
    groups.forEach(([label], i) =>
      tabs.append(
        el(
          "button",
          {
            type: "button",
            role: "tab",
            class: "equation-tab",
            onclick: () => show(i),
            onkeydown: (e) => {
              const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
              if (!step) return;
              e.preventDefault();
              const next = (i + step + groups.length) % groups.length;
              show(next);
              tabs.children[next].focus();
            },
          },
          label,
        ),
      ),
    );
    show(0);
    const body = el(
      "form",
      { class: "dialog-body equation-dialog" },
      tabs,
      panel,
      input,
      help,
      preview,
    );
    update();
    const response = dialog({
      title,
      body,
      confirm: initial ? "Update" : "Insert",
    });
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    const ok = await response;
    const value = input.value.trim();
    return ok && value ? value.replaceAll(PLACEHOLDER, "") || null : null;
  }

  async function pictureFor(source, color, pt) {
    const { svg, width, height } = render(source, color);
    const png = await svgToPng(svg, width * 2, height * 2);
    // An em of the drawing is the equation's font size on the slide.
    const emu = (px) => Math.round((px / PX) * (pt / 72) * 914400);
    return {
      svg: new TextEncoder().encode(svg),
      png,
      w: emu(width),
      h: emu(height),
    };
  }

  async function insertEquation(initial = "") {
    ctx.commitText();
    const source = initial || (await editDialog(""));
    if (!source) return;
    const color = ctx.inkColor();
    const pic = await pictureFor(source, color, DEFAULT_PT);
    const size = ctx.currentSize();
    await ctx.mutateSlide(ctx.slide(), (slide) => {
      const shape = P.addSlideVectorPicture(
        slide,
        { png: pic.png, svg: pic.svg },
        {
          x: Math.round((size.cx - pic.w) / 2),
          y: Math.round((size.cy - pic.h) / 2),
          w: pic.w,
          h: pic.h,
          name: `Equation ${P.getSlideShapes(slide).length + 1}`,
        },
      );
      P.setShapeObjectData(shape, {
        type: "equation",
        source,
        color,
        pt: DEFAULT_PT,
        w: pic.w,
      });
      P.setShapeDescription(shape, `Equation: ${source}`);
      ctx.selectIds([P.getShapeId(shape)]);
    });
  }

  async function editEquation(obj = current()) {
    if (!isEquation(obj)) return false;
    const data = P.getShapeObjectData(obj);
    const source = await editDialog(data.source || "", {
      title: "Edit Equation",
    });
    if (!source || source === data.source) return true;
    await redraw(obj, { ...data, source });
    return true;
  }

  async function redraw(obj, data) {
    const pic = await pictureFor(
      data.source,
      data.color || "#000000",
      data.pt || DEFAULT_PT,
    );
    await ctx.mutateShape(obj, (target, slide) => {
      const b = P.getShapeBounds(target);
      // Keep the equation's scale: the new drawing grows from the same corner
      // at the size the current one was shown.
      const old = P.getShapeObjectData(target);
      const scale = old?.w ? b.w / old.w : 1;
      P.setShapeVectorPicture(target, { png: pic.png, svg: pic.svg });
      P.setShapeBounds?.(target, {
        x: b.x,
        y: b.y,
        w: Math.round(pic.w * scale),
        h: Math.round(pic.h * scale),
      });
      P.setShapeObjectData(target, { ...data, type: "equation", w: pic.w });
      P.setShapeDescription(target, `Equation: ${data.source}`);
      ctx.pruneMedia(slide);
    });
  }

  const tab = () => ({
    id: "equation",
    label: "Equation",
    contextual: true,
    visible: () => !!current() && ctx.selectedShapes().length === 1,
    groups: [
      {
        id: "equation-edit",
        label: "Equation",
        icon: "equation",
        items: [
          {
            type: "large",
            id: "equation-edit-button",
            label: "Edit\nEquation",
            icon: "equation",
            title: "Edit Equation",
            run: () => editEquation().catch(ctx.fail),
          },
          {
            type: "large",
            id: "equation-color",
            label: "Color",
            icon: "textColor",
            title: "Equation Color",
            menu: () =>
              ctx.colorItems((hex) => {
                const obj = current();
                if (obj)
                  redraw(obj, {
                    ...P.getShapeObjectData(obj),
                    color: hex,
                  }).catch(ctx.fail);
              }),
          },
        ],
      },
    ],
  });

  const menu = () => [
    {
      label: "Insert New Equation",
      icon: "o:equation",
      onSelect: () => insertEquation().catch(ctx.fail),
    },
    { separator: true },
    ...BUILT_IN_EQUATIONS.map(([label, source]) => ({
      label,
      onSelect: () => insertEquation(source).catch(ctx.fail),
    })),
  ];

  return {
    insertEquation,
    editEquation,
    isEquation,
    tab,
    menu,
    editDialog,
    svgDataUrl,
  };
}
