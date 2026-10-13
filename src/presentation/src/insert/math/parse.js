// A parser for the equation editor's input: TeX-style math (\frac{a}{b},
// x^2, \sqrt[3]{x}, \sum_{i=1}^{n}, \left( … \right), \begin{matrix} …).
// It never throws: a missing argument becomes an empty slot, and an unknown
// command is kept as its own name so the person sees what they typed.

import {
  ACCENTS,
  DELIMITERS,
  FUNCTIONS,
  LARGE_OPERATORS,
  SPACES,
  SYMBOLS,
  charClass,
} from "./symbols.js";

export const PLACEHOLDER = "⬚";

const MATRIX_ENVS = {
  matrix: ["", ""],
  smallmatrix: ["", ""],
  pmatrix: ["(", ")"],
  bmatrix: ["[", "]"],
  Bmatrix: ["{", "}"],
  vmatrix: ["|", "|"],
  Vmatrix: ["‖", "‖"],
  cases: ["{", ""],
  array: ["", ""],
  aligned: ["", ""],
  align: ["", ""],
  "align*": ["", ""],
  gathered: ["", ""],
};

export function parseMath(source) {
  const src = String(source ?? "");
  let i = 0;
  const peek = () => src[i];
  const skipSpace = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const readName = () => {
    const start = i;
    if (/[a-zA-Z]/.test(src[i] ?? "")) {
      while (/[a-zA-Z]/.test(src[i] ?? "")) i++;
      if (src[i] === "*") i++;
    } else if (i < src.length) i++;
    return src.slice(start, i);
  };
  // A raw brace group's text, for \text{…} and environment names.
  const readRawGroup = () => {
    skipSpace();
    if (peek() !== "{") return "";
    i++;
    let depth = 1;
    const start = i;
    while (i < src.length && depth) {
      if (src[i] === "\\") i++;
      else if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    return src.slice(start, depth ? i : i - 1);
  };
  const readOptional = () => {
    skipSpace();
    if (peek() !== "[") return null;
    i++;
    const row = parseRow("]");
    if (peek() === "]") i++;
    return row;
  };
  // One argument: a group, a command, or a single character.
  const readArg = () => {
    skipSpace();
    if (i >= src.length || "}&]".includes(peek())) return row([]);
    const atom = parseAtom();
    return atom ?? row([]);
  };
  const readDelimiter = () => {
    skipSpace();
    if (peek() === "\\") {
      const save = i;
      i++;
      const name = `\\${readName()}`;
      if (name in DELIMITERS) return DELIMITERS[name];
      i = save;
      return "";
    }
    const ch = src[i++] ?? "";
    return ch in DELIMITERS ? DELIMITERS[ch] : ch;
  };

  function parseRow(stop) {
    const items = [];
    for (;;) {
      skipSpace();
      if (i >= src.length) break;
      const ch = peek();
      if (ch === stop || (stop === "}" && ch === "}")) break;
      if (ch === "}" || ch === "&") break;
      if (src.startsWith("\\\\", i)) break;
      if (/^\\(right|end|middle)(?![a-zA-Z])/.test(src.slice(i))) break;
      if (ch === "^" || ch === "_") {
        i++;
        const arg = readArg();
        let base = items.pop();
        if (!base || base.type === "space") {
          if (base) items.push(base);
          base = { type: "char", text: "", cls: "ord" };
        }
        if (base.type !== "scripts") base = { type: "scripts", base };
        if (ch === "^" && !base.sup) base.sup = arg;
        else if (ch === "_" && !base.sub) base.sub = arg;
        else
          base = { type: "scripts", base, [ch === "^" ? "sup" : "sub"]: arg };
        items.push(base);
        continue;
      }
      if (ch === "'") {
        // Primes are superscripts.
        let count = 0;
        while (src[i] === "'") {
          i++;
          count++;
        }
        const prime = { type: "char", text: "′".repeat(count), cls: "ord" };
        const base = items.pop() ?? { type: "char", text: "", cls: "ord" };
        items.push(
          base.type === "scripts" && !base.sup
            ? { ...base, sup: prime }
            : { type: "scripts", base, sup: prime },
        );
        continue;
      }
      const atom = parseAtom();
      if (atom) items.push(atom);
    }
    return row(items);
  }

  function parseAtom() {
    skipSpace();
    const ch = src[i];
    if (ch === undefined) return null;
    if (ch === "{") {
      i++;
      const group = parseRow("}");
      if (peek() === "}") i++;
      return group;
    }
    if (ch === "\\") {
      i++;
      return command(readName());
    }
    if (ch === "~") {
      i++;
      return { type: "space", em: 0.25 };
    }
    i++;
    if (/[0-9]/.test(ch)) {
      let text = ch;
      while (
        /[0-9]/.test(src[i] ?? "") ||
        (src[i] === "." && /[0-9]/.test(src[i + 1] ?? ""))
      )
        text += src[i++];
      return { type: "char", text, cls: "ord" };
    }
    if (ch === PLACEHOLDER || ch === "□") return { type: "placeholder" };
    if (/[a-zA-Z]/.test(ch) || /\p{L}/u.test(ch))
      return {
        type: "char",
        text: ch,
        cls: "ord",
        italic: /[a-zA-Zα-ω]/.test(ch),
      };
    const text = ch === "-" ? "−" : ch === "*" ? "∗" : ch;
    return { type: "char", text, cls: charClass(text) };
  }

  function command(name) {
    if (name in SPACES) return { type: "space", em: SPACES[name] };
    if (name in SYMBOLS) {
      const { glyph, cls } = SYMBOLS[name];
      return {
        type: "char",
        text: glyph,
        cls,
        italic: /^[a-z]+$/.test(name) && /[α-ω]/.test(glyph),
      };
    }
    if (name in LARGE_OPERATORS) {
      const [glyph, limits] = LARGE_OPERATORS[name];
      let useLimits = limits;
      skipSpace();
      if (src.startsWith("\\limits", i)) {
        i += 7;
        useLimits = true;
      } else if (src.startsWith("\\nolimits", i)) {
        i += 9;
        useLimits = false;
      }
      return { type: "op", text: glyph, limits: useLimits, integral: !limits };
    }
    if (name in FUNCTIONS)
      return { type: "func", text: name, limits: FUNCTIONS[name] };
    if (name in ACCENTS)
      return {
        type: "accent",
        accent: ACCENTS[name],
        name,
        under: name === "underline" || name === "underbrace",
        wide: /^(wide|over|under)/.test(name),
        body: readArg(),
      };
    switch (name) {
      case "frac":
      case "dfrac":
      case "tfrac":
      case "cfrac":
        return {
          type: "frac",
          num: readArg(),
          den: readArg(),
          style:
            name === "dfrac" ? "display" : name === "tfrac" ? "text" : null,
        };
      case "binom":
      case "dbinom":
      case "tbinom":
        return {
          type: "delim",
          left: "(",
          right: ")",
          body: row([
            { type: "frac", num: readArg(), den: readArg(), noBar: true },
          ]),
        };
      case "sqrt": {
        const index = readOptional();
        return { type: "sqrt", index, body: readArg() };
      }
      case "left": {
        const left = readDelimiter();
        const body = parseRow(null);
        let right = "";
        if (src.startsWith("\\right", i)) {
          i += 6;
          right = readDelimiter();
        }
        return { type: "delim", left, right, body };
      }
      case "middle":
        return { type: "char", text: readDelimiter(), cls: "rel" };
      case "text":
      case "textrm":
      case "mbox":
      case "textnormal":
        return {
          type: "text",
          text: readRawGroup().replace(/\\([{}])/g, "$1"),
          font: "text",
        };
      case "mathrm":
      case "operatorname":
      case "mathbf":
      case "textbf":
      case "mathit":
      case "textit":
      case "mathbb":
      case "mathcal":
      case "mathsf":
      case "boldsymbol": {
        const font = {
          mathrm: "rm",
          operatorname: "rm",
          mathbf: "bf",
          textbf: "bf",
          boldsymbol: "bf",
          mathit: "it",
          textit: "it",
          mathbb: "bb",
          mathcal: "cal",
          mathsf: "sf",
        }[name];
        const body = readArg();
        return name === "operatorname"
          ? { type: "func", text: flatText(body), limits: false }
          : { type: "font", font, body };
      }
      case "overset":
      case "stackrel":
      case "underset": {
        const over = readArg();
        const base = readArg();
        return {
          type: "stack",
          base,
          [name === "underset" ? "under" : "over"]: over,
        };
      }
      case "begin": {
        const env = readRawGroup();
        if (env === "array") readRawGroup();
        const rows = [];
        let current = [];
        for (;;) {
          current.push(parseRow(null));
          if (peek() === "&") {
            i++;
            continue;
          }
          rows.push(current);
          current = [];
          if (src.startsWith("\\\\", i)) {
            i += 2;
            continue;
          }
          break;
        }
        if (src.startsWith("\\end", i)) {
          i += 4;
          readRawGroup();
        }
        const [left, right] = MATRIX_ENVS[env] ?? ["", ""];
        const aligned = /^(aligned|align\*?|cases)$/.test(env);
        const matrix = {
          type: "matrix",
          rows: rows.filter(
            (r) => r.some((cell) => cell.items.length) || rows.length === 1,
          ),
          align: aligned ? "aligned" : "center",
          small: env === "smallmatrix",
        };
        return left || right
          ? { type: "delim", left, right, body: row([matrix]) }
          : matrix;
      }
      case "{":
      case "}":
        return {
          type: "char",
          text: name,
          cls: name === "{" ? "open" : "close",
        };
      case "|":
        return { type: "char", text: "‖", cls: "ord" };
      case "langle":
      case "rangle":
      case "lfloor":
      case "rfloor":
      case "lceil":
      case "rceil":
        return {
          type: "char",
          text: DELIMITERS[`\\${name}`],
          cls: /^l/.test(name) ? "open" : "close",
        };
      case "displaystyle":
      case "textstyle":
      case "limits":
      case "nolimits":
        return null;
      default:
        return { type: "text", text: `\\${name}`, font: "unknown" };
    }
  }

  const result = parseRow(null);
  // Anything left (a stray brace or \right) is shown, not lost.
  if (i < src.length) {
    const skip = src.startsWith("\\\\", i)
      ? 2
      : src.startsWith("\\right", i)
        ? 6
        : src.startsWith("\\end", i)
          ? 4
          : 1;
    const shown = skip === 1 && src[i] !== "&" ? src[i] : "";
    const rest = parseMath(src.slice(i + skip));
    return row([
      ...result.items,
      ...(shown ? [{ type: "char", text: shown, cls: "ord" }] : []),
      ...rest.items,
    ]);
  }
  return result;
}

function row(items) {
  return { type: "row", items };
}

/** The plain text of a parsed group (for \operatorname). */
export function flatText(node) {
  if (!node) return "";
  if (node.type === "row") return node.items.map(flatText).join("");
  if (node.type === "char" || node.type === "text" || node.type === "func")
    return node.text;
  return "";
}
