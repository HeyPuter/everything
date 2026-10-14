// The equation editor's parser and layout: TeX-style input becomes a tree,
// and the tree lays out as boxes drawn into SVG.
import { describe, expect, it } from "vitest";
import { parseMath, flatText, PLACEHOLDER } from "../src/insert/math/parse.js";
import { layoutMath, renderMathSvg } from "../src/insert/math/layout.js";

const types = (row) => row.items.map((n) => n.type);

describe("parsing", () => {
  it("reads fractions, scripts, roots and operators", () => {
    const tree = parseMath("x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}");
    expect(types(tree)).toEqual(["char", "char", "frac"]);
    const frac = tree.items[2];
    expect(types(frac.num)).toEqual(["char", "char", "char", "sqrt"]);
    const sqrt = frac.num.items[3];
    expect(sqrt.body.items[0]).toMatchObject({
      type: "scripts",
      base: { text: "b" },
    });
    expect(frac.num.items[0].text).toBe("−");
    expect(frac.num.items[2]).toMatchObject({ text: "±", cls: "bin" });
  });

  it("attaches limits to large operators and keeps function names upright", () => {
    const [sum] = parseMath("\\sum_{i=1}^{n} i").items;
    expect(sum.type).toBe("scripts");
    expect(sum.base).toMatchObject({ type: "op", text: "∑", limits: true });
    expect(flatText(sum.sub)).toBe("i=1");
    const [lim] = parseMath("\\lim_{x\\to 0} f").items;
    expect(lim.base).toMatchObject({ type: "func", text: "lim" });
    const [integral] = parseMath("\\int_0^1").items;
    expect(integral.base).toMatchObject({ text: "∫", integral: true });
  });

  it("reads brackets, accents, matrices and text", () => {
    const [delim] = parseMath("\\left( \\frac{a}{b} \\right]").items;
    expect(delim).toMatchObject({ type: "delim", left: "(", right: "]" });
    const [hat] = parseMath("\\hat{x}").items;
    expect(hat).toMatchObject({ type: "accent", name: "hat" });
    const [matrix] = parseMath(
      "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
    ).items;
    expect(matrix.type).toBe("delim");
    expect(matrix.body.items[0].rows.map((r) => r.map(flatText))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    const [text] = parseMath("\\text{if } x").items;
    expect(text).toMatchObject({ type: "text", text: "if " });
  });

  it("never throws on unfinished input, and keeps what it cannot read", () => {
    for (const source of [
      "\\frac{",
      "x^",
      "\\left(",
      "}",
      "\\begin{matrix} a &",
      "\\unknown x",
    ])
      expect(() => parseMath(source)).not.toThrow();
    expect(parseMath("\\foo").items[0]).toMatchObject({ text: "\\foo" });
    expect(parseMath(PLACEHOLDER).items[0].type).toBe("placeholder");
  });
});

describe("layout", () => {
  it("stacks a fraction across the axis and widens it to its parts", () => {
    const narrow = layoutMath("\\frac{1}{2}");
    const wide = layoutMath("\\frac{1+2+3}{2}");
    expect(wide.w).toBeGreaterThan(narrow.w);
    expect(narrow.h).toBeGreaterThan(0.6);
    expect(narrow.d).toBeGreaterThan(0.3);
  });

  it("raises superscripts and lowers subscripts", () => {
    const sup = layoutMath("x^2");
    const sub = layoutMath("x_2");
    const plain = layoutMath("x");
    expect(sup.h).toBeGreaterThan(plain.h);
    expect(sub.d).toBeGreaterThan(plain.d);
  });

  it("stretches brackets around tall content", () => {
    const svg = renderMathSvg("\\left(\\frac{a}{b}\\right)").svg;
    expect(svg).toMatch(/<path d="M[^"]*Q/);
    const small = renderMathSvg("(a)").svg;
    expect(small).toContain(">(</text>");
  });

  it("spaces relations wider than binary operators", () => {
    const rel = layoutMath("a=b").w;
    const bin = layoutMath("a+b").w;
    const tight = layoutMath("ab").w;
    expect(rel).toBeGreaterThan(tight);
    expect(bin).toBeGreaterThan(tight);
  });

  it("draws a complete SVG document in the requested colour", () => {
    const { svg, width, height } = renderMathSvg(
      "\\sqrt[3]{x}+\\sum_{k=0}^{n}\\binom{n}{k}",
      { size: 40, color: "#336699" },
    );
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('fill="#336699"');
    expect(width).toBeGreaterThan(100);
    expect(height).toBeGreaterThan(40);
    expect(svg).not.toContain("NaN");
  });
});
