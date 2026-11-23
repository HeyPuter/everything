import { describe, expect, it } from "vitest";
import {
  layoutCore,
  layoutTextSvg,
  defaultMeasurer,
} from "../lib/pptx-preview/src/text-layout.ts";

const piece = (text = "Hgp", sizePx = 40, family = "Arial") => ({
  text,
  sizePx,
  family,
  bold: false,
  italic: false,
  letterSpacingPx: 0,
  fillHex: "#000000",
  underline: "none",
  strike: false,
  superSub: 0,
  href: null,
  isBreak: false,
});
const para = (options = {}) => ({
  align: "left",
  marLpx: 0,
  marRpx: 0,
  firstIndentPx: 0,
  spcBefPx: 0,
  spcAftPx: 0,
  lineSpacing: null,
  lineSpacingReduction: 0,
  bullet: null,
  pieces: [piece()],
  fallbackSizePx: 40,
  ...options,
});
const body = (options = {}) => ({
  boxXpx: 17,
  boxYpx: 0,
  boxWpx: 350,
  boxHpx: 144,
  anchor: "top",
  wrap: false,
  paragraphs: [para()],
  ...options,
});
// Font-wide Arial metrics at 40 px. Native reference control exports at 30 pt
// provide the expected baselines below; no glyph-ink measurements or offsets.
const measure = (text, spec) => ({
  widthPx: ([...text].length * spec.sizePx) / 2,
  ascentPx: spec.sizePx * 0.9052734375,
  descentPx: spec.sizePx * 0.2119140625,
  lineGapPx: spec.sizePx * 0.03271484375,
});
const y = (input) =>
  layoutCore(input, measure).placements.map((p) => p.baselineY);

const origins = (svg) =>
  [...svg.matchAll(/<(?:text|image) x="([^"]+)"/g)].map((m) => Number(m[1]));

it("keeps kerning distinct in layout measurement caches and emitted run groups", () => {
  const input = body({
    paragraphs: [
      para({
        pieces: [
          { ...piece("AVA", 20), kerning: "normal" },
          { ...piece("AVA", 20), kerning: "none" },
        ],
      }),
    ],
  });
  const measured = (text, spec) => ({
    ...measure(text, spec),
    widthPx: text.length * (spec.kerning === "normal" ? 8 : 10),
  });
  expect(
    layoutCore(input, measured).placements[0].line.tokens.map((t) => t.width),
  ).toEqual([24, 30]);
  const svg = layoutTextSvg(input, measured);
  expect(svg.match(/<tspan /g)).toHaveLength(2);
  expect(svg).toContain('style="font-kerning:normal"');
  expect(svg).toContain('style="font-kerning:none"');
});

describe("emergency word wrapping", () => {
  const lines = (input) =>
    layoutCore(input, measure).placements.map(({ line }) =>
      line.tokens.map((token) => token.text).join(""),
    );

  it.each([0.5, 1, 2.75])(
    "moves an oversized word to a fresh line before splitting at scale %s",
    (scale) => {
      expect(
        lines(
          body({
            boxWpx: 50 * scale,
            wrap: true,
            paragraphs: [
              para({ pieces: [piece("one abcdef gh", 20 * scale)] }),
            ],
          }),
        ),
      ).toEqual(["one", "abcde", "f gh"]);
    },
  );

  it("preserves separate run formatting and permits a normal word after the final fragment", () => {
    const first = { ...piece("one ", 20), bold: true };
    const second = {
      ...piece("abcdef gh", 20),
      italic: true,
      href: "https://example.com",
    };
    const input = body({
      boxWpx: 50,
      wrap: true,
      paragraphs: [para({ pieces: [first, second] })],
    });
    expect(lines(input)).toEqual(["one", "abcde", "f gh"]);
    const result = layoutCore(input, measure);
    expect(result.placements[0].line.tokens[0].piece).toBe(first);
    expect(
      result.placements
        .slice(1)
        .flatMap(({ line }) => line.tokens)
        .every((token) => token.piece === second),
    ).toBe(true);
  });

  it("does not add an empty line before a leading oversized word or after a hard break", () => {
    for (const pieces of [
      [piece("abcdef gh", 20)],
      [
        piece("one", 20),
        { ...piece("", 20), isBreak: true },
        piece("abcdef gh", 20),
      ],
    ]) {
      expect(
        lines(body({ boxWpx: 50, wrap: true, paragraphs: [para({ pieces })] })),
      ).toEqual(
        pieces.length === 1 ? ["abcde", "f gh"] : ["one", "abcde", "f gh"],
      );
    }
  });

  it("uses paragraph margins when deciding whether a word needs emergency splitting", () => {
    expect(
      lines(
        body({
          boxWpx: 90,
          wrap: true,
          paragraphs: [
            para({
              marLpx: 20,
              marRpx: 20,
              pieces: [piece("one abcdef gh", 20)],
            }),
          ],
        }),
      ),
    ).toEqual(["one", "abcde", "f gh"]);
  });

  it("leaves ordinary wrapping and explicitly unwrapped text unchanged", () => {
    const input = body({
      boxWpx: 50,
      wrap: true,
      paragraphs: [para({ pieces: [piece("one ab cd", 20)] })],
    });
    expect(lines(input)).toEqual(["one", "ab cd"]);
    expect(
      lines({
        ...input,
        wrap: false,
        paragraphs: [para({ pieces: [piece("one abcdef gh", 20)] })],
      }),
    ).toEqual(["one abcdef gh"]);
  });
});

describe("zero-advance tokens on overfull lines", () => {
  const measured = (text, spec) => ({
    ...measure(text, spec),
    widthPx: [...text].reduce(
      (width, ch) =>
        width + (/\p{Mark}|\u200d/u.test(ch) ? 0 : spec.sizePx / 2),
      0,
    ),
  });
  const layout = (pieces, width = 5) =>
    layoutCore(
      body({
        boxWpx: width,
        wrap: true,
        paragraphs: [para({ pieces })],
      }),
      measured,
    );
  const texts = (result) =>
    result.placements.map(({ line }) =>
      line.tokens.map((token) => token.text).join(""),
    );

  it.each(["e\u0301", "か\u3099", "a\u0308\u0301"])(
    "keeps zero-advance marks with an oversized base in %s",
    (cluster) => {
      for (const width of [1, 5, 10]) {
        expect(texts(layout([piece(cluster.repeat(2), 20)], width))).toEqual([
          cluster,
          cluster,
        ]);
      }
    },
  );

  it("retains marks and their formatting across run boundaries", () => {
    const base = piece("e", 20);
    const mark = { ...piece("\u0301", 20), fillHex: "#ff0000", italic: true };
    const next = piece("x", 20);
    const result = layout([base, mark, next]);
    expect(texts(result)).toEqual(["e\u0301", "x"]);
    expect(result.placements[0].line.tokens.map((t) => t.piece)).toEqual([
      base,
      mark,
    ]);
  });

  it("still honors explicit breaks before zero-advance marks", () => {
    expect(
      texts(
        layout([
          piece("e", 20),
          { ...piece("", 20), isBreak: true },
          piece("\u0301", 20),
        ]),
      ),
    ).toEqual(["e", "\u0301"]);
  });

  it("uses the whole-word width even when its first character has zero advance", () => {
    expect(texts(layout([piece("a \u200dbcd", 20)], 20))).toEqual([
      "a",
      "\u200dbc",
      "d",
    ]);
  });

  it("retains a paragraph containing only zero-advance characters", () => {
    expect(texts(layout([piece("\u0301\u0308", 20)]))).toEqual([
      "\u0301\u0308",
    ]);
  });
});

describe("Authored text coordinates", () => {
  it.each([
    ["left", 47],
    ["center", 201.5],
    ["right", 356],
  ])("preserves %s alignment at different coordinate scales", (align, x) => {
    for (const scale of [0.5, 1, 2.75]) {
      const svg = layoutTextSvg(
        body({
          boxXpx: 17 * scale,
          boxWpx: 350 * scale,
          paragraphs: [
            para({
              align,
              marLpx: 23 * scale,
              marRpx: 11 * scale,
              firstIndentPx: 7 * scale,
              pieces: [piece("Hgp", 40 * scale)],
            }),
          ],
        }),
        measure,
      );
      expect(origins(svg)).toHaveLength(1);
      // SVG coordinates are serialized to hundredths of a pixel.
      expect(Math.abs(origins(svg)[0] - x * scale)).toBeLessThan(0.006);
    }
  });
  it.each([
    ["left", 41, 65],
    ["center", 156.5, 210.5],
    ["right", 272, 356],
  ])(
    "keeps glyph and picture bullets with %s-aligned text",
    (align, marker, text) => {
      for (const imageHref of [undefined, "data:image/png;base64,AA=="]) {
        const svg = layoutTextSvg(
          body({
            paragraphs: [
              para({
                align,
                marLpx: 48,
                marRpx: 11,
                firstIndentPx: -24,
                bullet: {
                  text: "•",
                  family: "Arial",
                  sizePx: 16,
                  fillHex: "#000000",
                  imageHref,
                },
              }),
            ],
          }),
          measure,
        );
        expect(origins(svg)).toEqual([marker, text]);
      }
    },
  );
  it("preserves fractional and negative origins", () => {
    for (const boxXpx of [0, -11.125, 17.375]) {
      const [x] = origins(layoutTextSvg(body({ boxXpx }), measure));
      expect(Math.abs(x - boxXpx)).toBeLessThan(0.006);
    }
  });
  it("positions both text and its underline within each column", () => {
    const p = para({ pieces: [{ ...piece(), underline: "wavy" }] });
    const svg = layoutTextSvg(
      body({
        boxHpx: 50,
        columns: { count: 2, gapPx: 10 },
        paragraphs: [p, p],
      }),
      measure,
    );
    expect(origins(svg)).toEqual([17, 197]);
    expect(
      [...svg.matchAll(/<path d="M([\d.-]+) /g)].map((m) => Number(m[1])),
    ).toEqual([17, 197]);
  });
});

describe("native text line metrics", () => {
  it.each([
    [null, [38.72, 86.72, 134.72]],
    [{ kind: "pct", value: 0.9 }, [34.56, 85.12, 135.36]],
    [{ kind: "pct", value: 1.5 }, [54.72, 95.04, 135.68]],
    [{ kind: "pts", px: 32 }, [24, 79.36, 135.04]],
  ])(
    "matches native top, middle, and bottom baselines for %j",
    (lineSpacing, expected) => {
      ["top", "center", "bottom"].forEach((anchor, index) => {
        expect(
          Math.abs(
            y(body({ anchor, paragraphs: [para({ lineSpacing })] }))[0] -
              expected[index],
          ),
        ).toBeLessThan(0.8);
      });
    },
  );
  it("uses the font's natural height only when compatible spacing is explicitly disabled", () => {
    const input = body({ compatibleLineSpacing: false });
    expect(layoutCore(input, measure).requiredH).toBeCloseTo(45.99609375);
    expect(Math.abs(y(input)[0] - 37.44)).toBeLessThan(0.2);
    expect(layoutCore(body(), measure).requiredH).toBeCloseTo(48);
    expect(y(body({ compatibleLineSpacing: true }))).toEqual(y(body()));
  });
  it("keeps a single bottom-anchored baseline independent of line spacing", () => {
    const baselines = [0.5, 0.9, 1, 1.5, 3].map(
      (value) =>
        y(
          body({
            anchor: "bottom",
            paragraphs: [para({ lineSpacing: { kind: "pct", value } })],
          }),
        )[0],
    );
    baselines.forEach((b) => expect(b).toBeCloseTo(baselines[0]));
  });
  it("uses full advances between lines and the final descent for anchoring", () => {
    const input = body({
      anchor: "bottom",
      paragraphs: [
        para({
          lineSpacing: { kind: "pct", value: 1.5 },
          pieces: [piece(), { ...piece(), isBreak: true }, piece()],
        }),
      ],
    });
    const result = layoutCore(input, measure);
    expect(result.placements).toHaveLength(2);
    expect(y(input)[1] - y(input)[0]).toBeCloseTo(72);
    expect(y(input)[1] + result.placements[1].line.descent).toBeCloseTo(144);
    const outer = layoutCore({ ...input, includeOuterSpacing: true }, measure);
    expect(outer.requiredH).toBeCloseTo(144);
    expect(outer.placements[1].baselineY).toBeCloseTo(126);
  });
  it("suppresses only the outer paragraph margins unless requested", () => {
    const paragraphs = [
      para({ spcBefPx: 11, spcAftPx: 13 }),
      para({ spcBefPx: 17, spcAftPx: 19 }),
    ];
    const normal = layoutCore(body({ paragraphs }), measure);
    const outer = layoutCore(
      body({ paragraphs, includeOuterSpacing: true }),
      measure,
    );
    expect(normal.requiredH).toBeCloseTo(126);
    expect(outer.requiredH - normal.requiredH).toBeCloseTo(30);
    expect(
      normal.placements[1].baselineY - normal.placements[0].baselineY,
    ).toBeCloseTo(78);
    expect(
      outer.placements[0].baselineY - normal.placements[0].baselineY,
    ).toBeCloseTo(11);
  });
  it.each([12, 27, 96])(
    "scales line metrics proportionally at %s px",
    (sizePx) => {
      const scaled = body({
        boxHpx: (144 * sizePx) / 40,
        anchor: "center",
        paragraphs: [
          para({
            pieces: [piece("Other content", sizePx)],
            fallbackSizePx: sizePx,
          }),
        ],
      });
      expect(y(scaled)[0]).toBeCloseTo(
        (y(body({ anchor: "center" }))[0] * sizePx) / 40,
      );
    },
  );
  it("uses the same final-line bounds for column breaks and body height", () => {
    const p = para({ lineSpacing: { kind: "pct", value: 1.5 } });
    const input = body({
      boxHpx: 65,
      columns: { count: 2, gapPx: 10 },
      paragraphs: [p, p],
    });
    const result = layoutCore(input, measure);
    expect(result.placements.map((p) => p.dx)).toEqual([0, 180]);
    expect(result.placements[0].baselineY).toBe(result.placements[1].baselineY);
    expect(result.requiredH).toBeLessThan(65);
  });
  it("includes the final paragraph margin in a column's anchored height when requested", () => {
    const input = body({
      anchor: "bottom",
      columns: { count: 2, gapPx: 10 },
      includeOuterSpacing: true,
      paragraphs: [para({ spcBefPx: 11, spcAftPx: 19 })],
    });
    const result = layoutCore(input, measure);
    expect(result.requiredH).toBeCloseTo(78);
    expect(
      result.placements[0].baselineY + result.placements[0].line.descent,
    ).toBeCloseTo(125);
  });
  it("subtracts percentage points while preserving natural-height defaults and exact spacing", () => {
    for (const [spacing, expected] of [
      [null, 38.4],
      [{ kind: "pct", value: 1.5 }, 62.4],
      [{ kind: "pts", px: 31 }, 31],
    ]) {
      const p = para({
        lineSpacing: spacing,
        lineSpacingReduction: 0.2,
        pieces: [piece(), { ...piece(), isBreak: true }, piece()],
      });
      const result = layoutCore(body({ paragraphs: [p] }), measure);
      expect(
        result.placements[1].baselineY - result.placements[0].baselineY,
      ).toBeCloseTo(expected);
    }
    const result = layoutCore(
      body({
        paragraphs: [
          para({
            lineSpacing: { kind: "pct", value: 0.1 },
            lineSpacingReduction: 0.2,
          }),
        ],
      }),
      measure,
    );
    expect(result.placements[0].line.advance).toBe(0);
    expect(Number.isFinite(result.requiredH)).toBe(true);
  });
  it("retains a finite line box for empty paragraphs, spaces and unavailable metrics", () => {
    for (const pieces of [[], [piece("   ")], [piece(), piece(" large", 72)]]) {
      for (const measurer of [
        defaultMeasurer,
        () => ({ widthPx: 10, ascentPx: NaN, descentPx: -1 }),
      ]) {
        const result = layoutCore(
          body({ paragraphs: [para({ pieces })] }),
          measurer,
        );
        expect(result.requiredH).toBeGreaterThan(0);
        expect(Number.isFinite(result.placements[0].baselineY)).toBe(true);
      }
    }
  });
});

describe("invisible paragraph-end metrics", () => {
  it("changes only final-line metrics, without contributing width or a rendered glyph", () => {
    const base = body({
      boxWpx: 105,
      wrap: true,
      paragraphs: [
        para({ pieces: [piece("Alpha Beta Gamma", 20)], fallbackSizePx: 20 }),
      ],
    });
    const normal = layoutCore(base, measure);
    const marked = {
      ...base,
      paragraphs: [{ ...base.paragraphs[0], endMarker: piece("", 48) }],
    };
    const result = layoutCore(marked, measure);
    expect(result.placements).toHaveLength(normal.placements.length);
    for (let i = 0; i < result.placements.length - 1; i++)
      expect(result.placements[i]).toEqual(normal.placements[i]);
    expect(result.placements.at(-1).line.advance).toBeCloseTo(57.6);
    expect(
      result.placements.flatMap((p) => p.line.tokens.map((t) => t.text)),
    ).toEqual(
      normal.placements.flatMap((p) => p.line.tokens.map((t) => t.text)),
    );
    const svg = layoutTextSvg(marked, measure);
    expect(svg).not.toContain('font-size="48.00"');
    expect(svg).not.toContain("\u200b");
  });
  it("retains a trailing empty line and uses its insertion-point size", () => {
    const input = body({
      paragraphs: [
        para({
          pieces: [piece("Alpha", 20), { ...piece("", 20), isBreak: true }],
          fallbackSizePx: 48,
          endMarker: piece("", 20),
        }),
      ],
    });
    const result = layoutCore(input, measure);
    expect(result.placements).toHaveLength(2);
    expect(result.placements[0].line.advance).toBeCloseTo(24);
    expect(result.placements[1].line.advance).toBeCloseTo(57.6);
    expect(result.requiredH).toBeCloseTo(81.6);
    expect(result.placements[1].line.tokens).toEqual([]);
  });
});

describe("empty hard-break line metrics", () => {
  it("uses a break font only on an empty line and the insertion font on the trailing line", () => {
    const result = layoutCore(
      body({
        paragraphs: [
          para({
            pieces: [
              piece("Alpha", 20),
              { ...piece("", 40), isBreak: true },
              { ...piece("", 12), isBreak: true },
            ],
            emptyLineFont: piece("", 8),
          }),
        ],
      }),
      measure,
    );
    expect(result.placements.map((p) => p.line.advance)).toEqual([
      24, 14.4, 9.6,
    ]);
    expect(result.placements[1].line.tokens.every((t) => t.isBreak)).toBe(true);
    expect(result.placements[2].line.tokens).toEqual([]);
  });
  it("keeps unsized synthetic break markers finite", () => {
    const result = layoutCore(
      body({
        paragraphs: [
          para({
            pieces: [{ ...piece("", 0), isBreak: true }],
            fallbackSizePx: 20,
          }),
        ],
      }),
      measure,
    );
    expect(result.placements.map((p) => p.line.advance)).toEqual([24, 24]);
    expect(Number.isFinite(result.requiredH)).toBe(true);
  });
});

describe("line-break units across formatting", () => {
  const lines = (input) =>
    layoutCore(input, measure).placements.map(({ line }) =>
      line.tokens.map((token) => token.text).join(""),
    );
  const input = (pieces, width = 70) =>
    body({ boxWpx: width, wrap: true, paragraphs: [para({ pieces })] });

  it.each([0.5, 1, 2.75])(
    "keeps a formatted word intact at scale %s",
    (scale) => {
      const first = piece("one ga", 20 * scale);
      const second = {
        ...piece("mma", 20 * scale),
        bold: true,
        href: "#target",
      };
      const value = input([first, second], 70 * scale);
      expect(lines(value)).toEqual(["one", "gamma"]);
      const tokens = layoutCore(value, measure).placements[1].line.tokens;
      expect(tokens.map((token) => token.piece)).toEqual([first, second]);
      expect(layoutTextSvg(value, measure)).toContain('font-weight="700"');
    },
  );

  it("splits an oversized word only after combining its formatted fragments", () => {
    expect(
      lines(
        input(
          [piece("a ab", 20), { ...piece("cdefg z", 20), italic: true }],
          50,
        ),
      ),
    ).toEqual(["a", "abcde", "fg z"]);
  });

  it("retains break units across empty formatting runs", () => {
    expect(
      lines(input([piece("one ga", 20), piece("", 72), piece("mma", 20)])),
    ).toEqual(["one", "gamma"]);
  });

  it("resets at explicit line and paragraph boundaries", () => {
    const pieces = [
      piece("one ga", 20),
      { ...piece("", 20), isBreak: true },
      piece("mma", 20),
    ];
    expect(lines(input(pieces))).toEqual(["one ga", "mma"]);
    expect(
      lines(
        body({
          boxWpx: 70,
          wrap: true,
          paragraphs: [
            para({ pieces: [piece("one ga", 20)] }),
            para({ pieces: [piece("mma", 20)] }),
          ],
        }),
      ),
    ).toEqual(["one ga", "mma"]);
  });

  it("keeps East Asian punctuation attached across formatting boundaries", () => {
    expect(lines(input([piece("一二", 20), piece("。三", 20)], 25))).toEqual([
      "一",
      "二。",
      "三",
    ]);
  });

  it("preserves explicit no-wrap and all source characters", () => {
    const value = {
      ...input([piece("one ga", 20), piece("mma-a", 20)], 10),
      wrap: false,
    };
    expect(lines(value)).toEqual(["one gamma-a"]);
  });

  it("retains whole hyphenated word measurement when wrapping is disabled", () => {
    const value = { ...input([piece("gam-ma", 20)], 10), wrap: false };
    const result = layoutCore(value, (text, spec) => ({
      ...measure(text, spec),
      widthPx: text === "gam-ma" ? 57 : measure(text, spec).widthPx,
    }));
    expect(
      result.placements[0].line.tokens.reduce((sum, t) => sum + t.width, 0),
    ).toBe(57);
  });

  it("does not measure growing prefixes of heavily formatted words", () => {
    const pieces = Array.from({ length: 4000 }, (_, i) => ({
      ...piece("a", 20),
      fillHex: i % 2 ? "#ff0000" : "#0000ff",
    }));
    let measuredCharacters = 0;
    const result = layoutCore(input(pieces, 100), (text, spec) => {
      measuredCharacters += text.length;
      return measure(text, spec);
    });
    expect(result.placements).toHaveLength(400);
    expect(measuredCharacters).toBeLessThan(100);
    expect(
      result.placements.flatMap(({ line }) => line.tokens).map((t) => t.piece),
    ).toEqual(pieces);
  });
});

describe("explicit hyphen line breaks", () => {
  const lines = (pieces, width = 80, wrap = true) =>
    layoutCore(
      body({ boxWpx: width, wrap, paragraphs: [para({ pieces })] }),
      measure,
    ).placements.map(({ line }) => line.tokens.map((t) => t.text).join(""));

  it.each([0.5, 1, 2.75])(
    "uses the last fitting compound prefix at scale %s",
    (scale) => {
      expect(lines([piece("one ab-cd zz", 20 * scale)], 80 * scale)).toEqual([
        "one ab-",
        "cd zz",
      ]);
    },
  );

  it("finds hyphens across formatting boundaries and retains every run", () => {
    const a = piece("one ab", 20),
      b = { ...piece("-", 20), bold: true },
      c = { ...piece("cd zz", 20), italic: true, href: "#target" };
    const value = body({
      boxWpx: 80,
      wrap: true,
      paragraphs: [para({ pieces: [a, b, c] })],
    });
    const result = layoutCore(value, measure);
    expect(
      result.placements.map(({ line }) =>
        line.tokens.map((t) => t.text).join(""),
      ),
    ).toEqual(["one ab-", "cd zz"]);
    expect(result.placements[0].line.tokens.at(-1).piece).toBe(b);
    expect(result.placements[1].line.tokens.every((t) => t.piece === c)).toBe(
      true,
    );
    expect(layoutTextSvg(value, measure)).toContain('font-weight="700"');
    expect(layoutTextSvg(value, measure)).toContain('font-style="italic"');
  });

  it("permits an authored minus before a number, as the native reference does", () => {
    expect(lines([piece("one -1234 zz", 20)], 60)).toEqual([
      "one -",
      "1234",
      "zz",
    ]);
  });

  it("keeps consecutive hyphens on the preceding line", () => {
    expect(lines([piece("one ab--cd zz", 20)])).toEqual(["one ab--", "cd zz"]);
  });

  it.each(["\u2010", "\u2011", "\u2212"])(
    "retains the existing break unit for non-ASCII dash %s",
    (dash) => {
      expect(lines([piece(`one ab${dash}cd zz`, 20)])).toEqual([
        "one",
        `ab${dash}cd zz`,
      ]);
    },
  );

  it.each(["\u2060", ","])(
    "retains native's explicit delimiter break before %s",
    (following) => {
      expect(lines([piece(`one ab-${following}cd`, 20)])).toEqual([
        "one ab-",
        `${following}cd`,
      ]);
    },
  );

  it.each(["\u00a0", "\u2007", "\u202f", "\ufeff"])(
    "keeps nonbreaking space/joiner %s inside a formatted word",
    (space) => {
      expect(lines([piece("one ab", 20), piece(`${space}cd`, 20)])).toEqual([
        "one",
        `ab${space}cd`,
      ]);
    },
  );

  it("does not split measurement or alter characters in an unwrapped compound", () => {
    const input = body({
      paragraphs: [para({ pieces: [piece("ab-cd", 20)] })],
    });
    const result = layoutCore(input, (text, spec) => ({
      ...measure(text, spec),
      widthPx: text === "ab-cd" ? 53 : measure(text, spec).widthPx,
    }));
    expect(result.placements[0].line.tokens).toHaveLength(1);
    expect(result.placements[0].line.tokens[0].width).toBe(53);
    expect(lines([piece("one ab-cd zz", 20)], 10, false)).toEqual([
      "one ab-cd zz",
    ]);
  });
});

describe("wrapping provenance and unbroken word measurements", () => {
  const input = (pieces, options = {}) =>
    body({
      boxWpx: 50,
      boxHpx: 1,
      wrap: true,
      paragraphs: [para({ pieces })],
      ...options,
    });

  it("distinguishes automatic lines from explicit breaks and empty paragraphs", () => {
    const value = input([
      piece("ab cd ef", 20),
      { ...piece("", 20), isBreak: true },
      piece("gh", 20),
    ]);
    const result = layoutCore(value, measure);
    expect(result.placements.map(({ line }) => line.automaticStart)).toEqual([
      false,
      true,
      false,
    ]);
    expect(result.automaticWraps).toBe(1);
    expect(result.unbreakableOverflowW).toBe(0);
    const explicit = layoutCore(
      {
        ...value,
        paragraphs: [para({ pieces: [piece("ab", 20)] }), para({ pieces: [] })],
      },
      measure,
    );
    expect(explicit.automaticWraps).toBe(0);
    expect(explicit.requiredH).toBeGreaterThan(value.boxHpx);
  });

  it("reports automatic wraps even when zero line advance leaves height unchanged", () => {
    const value = input([], {
      paragraphs: [
        para({
          pieces: [piece("ab cd ef", 20)],
          lineSpacing: { kind: "pts", px: 0 },
        }),
      ],
    });
    const result = layoutCore(value, measure);
    expect(result.requiredH).toBe(
      layoutCore({ ...value, wrap: false }, measure).requiredH,
    );
    expect(result.automaticWraps).toBe(1);
    expect(result.unbreakableOverflowW).toBe(0);
  });

  it("retains full word overflow after emergency splitting across formatted runs", () => {
    const result = layoutCore(
      input([piece("abc", 20), { ...piece("def", 20), bold: true }]),
      measure,
    );
    expect(result.unbreakableOverflowW).toBe(10);
    expect(
      result.placements.every(
        ({ line }) => line.tokens.reduce((n, t) => n + t.width, 0) <= 50,
      ),
    ).toBe(true);
    expect(result.automaticWraps).toBe(1);
  });

  it("uses the first-line indent and preserves a wider hanging first line", () => {
    const positive = input([], {
      paragraphs: [para({ pieces: [piece("I", 20)], firstIndentPx: 50 })],
    });
    expect(layoutCore(positive, measure).unbreakableOverflowW).toBe(10);
    const hanging = input([], {
      paragraphs: [
        para({ pieces: [piece("abcd", 20)], marLpx: 30, firstIndentPx: -30 }),
      ],
    });
    const result = layoutCore(hanging, measure);
    expect(result.unbreakableOverflowW).toBe(0);
    expect(result.automaticWraps).toBe(0);
  });

  it("does not confuse overflowing leading spaces with an oversized word", () => {
    const result = layoutCore(input([piece("      I", 20)]), measure);
    expect(
      result.placements[0].line.tokens.reduce((n, t) => n + t.width, 0),
    ).toBeGreaterThan(50);
    expect(result.unbreakableOverflowW).toBe(0);
    expect(result.automaticWraps).toBe(0);
  });

  it("uses the text start after a hanging bullet when measuring word excess", () => {
    const value = input([], {
      boxWpx: 60,
      paragraphs: [
        para({
          pieces: [piece("abcd", 20)],
          marLpx: 30,
          firstIndentPx: -30,
          bullet: {
            text: "•",
            family: "Arial",
            sizePx: 20,
            fillHex: "#000000",
          },
        }),
      ],
    });
    expect(layoutCore(value, measure).unbreakableOverflowW).toBe(10);
  });

  it.each([0, -10])(
    "reports words in nonpositive content width %s",
    (width) => {
      const result = layoutCore(
        input([piece("a", 20)], { boxWpx: width }),
        measure,
      );
      expect(result.unbreakableOverflowW).toBe(10 - width);
      expect(Number.isFinite(result.requiredH)).toBe(true);
    },
  );

  it("keeps column placement separate from automatic wrapping", () => {
    const value = input([piece("ab cd ef gh", 20)], {
      boxWpx: 100,
      boxHpx: 25,
      columns: { count: 2, gapPx: 0 },
    });
    const result = layoutCore(value, measure);
    expect(result.placements).toHaveLength(2);
    expect(result.automaticWraps).toBe(1);
    expect(result.unbreakableOverflowW).toBe(0);
  });

  it("reports fit in the rotated layout frame", () => {
    const value = input([piece("abcdef", 20)], {
      boxWpx: 300,
      boxHpx: 50,
      vert: "cw90",
    });
    const result = layoutCore(value, measure);
    expect(result.automaticWraps).toBe(1);
    expect(result.unbreakableOverflowW).toBe(10);
  });

  it("measures East Asian break units rather than the entire unspaced clause", () => {
    const result = layoutCore(
      input([piece("日本語の文字", 20)], { boxWpx: 20 }),
      measure,
    );
    expect(result.automaticWraps).toBe(2);
    expect(result.unbreakableOverflowW).toBe(0);
  });
});

describe("percentage paragraph spacing", () => {
  it.each([null, { kind: "pct", value: 2 }, { kind: "pts", px: 3 }])(
    "uses natural boundary line heights independently of custom leading %j",
    (lineSpacing) => {
      const input = body({
        compatibleLineSpacing: false,
        includeOuterSpacing: true,
        paragraphs: [
          para({
            lineSpacing,
            spcBefPct: 0.5,
            spcAftPct: 1,
            pieces: [
              piece("First", 20),
              { ...piece("", 20), isBreak: true },
              piece("Largest middle", 60),
              { ...piece("", 60), isBreak: true },
              piece("Last", 30),
            ],
          }),
        ],
      });
      const snapshot = JSON.stringify(input);
      const result = layoutCore(input, measure);
      expect(result.paragraphSpacing[0].beforePx).toBeCloseTo(
        (10 * 2355) / 2048,
      );
      expect(result.paragraphSpacing[0].afterPx).toBeCloseTo(
        (30 * 2355) / 2048,
      );
      expect(result.placements[0].line.topY).toBeCloseTo(
        result.paragraphSpacing[0].beforePx,
      );
      expect(JSON.stringify(input)).toBe(snapshot);
    },
  );
  it("remeasures the boundary after automatic wrapping and uses the largest run on that line", () => {
    const content = para({
      spcBefPct: 0.5,
      spcAftPct: 1,
      pieces: [piece("AA ", 20), piece("BB", 40)],
    });
    const wide = layoutCore(
      body({ boxWpx: 300, wrap: true, paragraphs: [content] }),
      measure,
    );
    const narrow = layoutCore(
      body({ boxWpx: 60, wrap: true, paragraphs: [content] }),
      measure,
    );
    expect(wide.paragraphSpacing[0]).toEqual({ beforePx: 24, afterPx: 48 });
    expect(narrow.paragraphSpacing[0]).toEqual({ beforePx: 12, afterPx: 48 });
    expect(narrow.automaticWraps).toBe(1);
  });
  it("honors zero, first/last suppression, empty insertion fonts, and adjacent additive margins", () => {
    const input = body({
      paragraphs: [
        para({ spcBefPct: 2, spcAftPct: 0.5 }),
        para({
          spcBefPct: 0.25,
          spcAftPct: 2,
          pieces: [],
          emptyLineFont: {
            family: "Arial",
            sizePx: 20,
            bold: false,
            italic: false,
            letterSpacingPx: 0,
          },
        }),
      ],
    });
    const result = layoutCore(input, measure);
    expect(result.placements[0].line.topY).toBe(0);
    expect(result.placements[1].line.topY).toBeCloseTo(48 + 24 + 6);
    const outer = layoutCore({ ...input, includeOuterSpacing: true }, measure);
    expect(outer.placements[0].line.topY).toBe(96);
    const zero = layoutCore(
      body({
        includeOuterSpacing: true,
        paragraphs: [
          para({ spcBefPx: 100, spcAftPx: 100, spcBefPct: 0, spcAftPct: 0 }),
        ],
      }),
      measure,
    );
    expect(zero.paragraphSpacing[0]).toEqual({ beforePx: 0, afterPx: 0 });
    expect(zero.requiredH).toBe(48);
  });
  it("applies the paragraph end only to final-line spacing", () => {
    const result = layoutCore(
      body({
        paragraphs: [
          para({
            pieces: [
              piece("First", 20),
              { ...piece("", 20), isBreak: true },
              piece("Last", 20),
            ],
            spcBefPct: 1,
            spcAftPct: 1,
            endMarker: {
              family: "Arial",
              sizePx: 50,
              bold: false,
              italic: false,
              letterSpacingPx: 0,
            },
          }),
        ],
      }),
      measure,
    );
    expect(result.paragraphSpacing[0]).toEqual({ beforePx: 24, afterPx: 60 });
  });
});

describe("shaped spans across line-break opportunities", () => {
  const shaped = (text, spec) => ({
    ...measure(text, spec),
    widthPx:
      text.length * 10 -
      (spec.kerning === "normal"
        ? (text.match(/[AT] /g)?.length ?? 0) * 7
        : 0) +
      Math.max(0, text.length - 1) * spec.letterSpacingPx,
  });
  const input = (pieces, width, options = {}) =>
    body({
      boxWpx: width,
      wrap: true,
      paragraphs: [para({ pieces })],
      ...options,
    });
  const p = (text, extra = {}) => ({
    ...piece(text, 20),
    kerning: "normal",
    ...extra,
  });
  const texts = (result) =>
    result.placements.map(({ line }) =>
      line.tokens.map((t) => t.text).join(""),
    );

  it.each(["A b", "T c"])(
    "uses cross-space shaping for %s instead of summing words",
    (text) => {
      expect(texts(layoutCore(input([p(text)], 25), shaped))).toEqual([text]);
      expect(
        texts(layoutCore(input([p(text, { kerning: "none" })], 25), shaped)),
      ).toEqual([text[0], text.at(-1)]);
    },
  );
  it("rebuilds shaping context after automatic and authored line breaks", () => {
    const result = layoutCore(
      input([p("A b T c"), { ...p(""), isBreak: true }, p("T d")], 25),
      shaped,
    );
    expect(texts(result)).toEqual(["A b", "T c", "T d"]);
    expect(result.placements.map(({ line }) => line.automaticStart)).toEqual([
      false,
      true,
      false,
    ]);
  });
  it("shapes adjacent equal source runs as the one span that SVG emits", () => {
    const a = p("A"),
      b = p(" "),
      c = p("b");
    const value = input([a, b, c], 25),
      result = layoutCore(value, shaped);
    expect(texts(result)).toEqual(["A b"]);
    expect(result.placements[0].line.tokens.map((t) => t.piece)).toEqual([
      a,
      b,
      c,
    ]);
    expect(layoutTextSvg(value, shaped).match(/<tspan /g)).toHaveLength(1);
  });
  it("retains paint boundaries and uses the shaped width of each emitted span", () => {
    const a = p("A ", { fillHex: "#ff0000" }),
      b = p("b");
    const value = input([a, b], 25),
      result = layoutCore(value, shaped);
    expect(texts(result)).toEqual(["A b"]);
    expect(
      result.placements[0].line.tokens.reduce((sum, t) => sum + t.width, 0),
    ).toBe(23);
    expect(layoutTextSvg(value, shaped).match(/<tspan /g)).toHaveLength(2);
  });
  it("resets context where font or kerning formatting changes", () => {
    expect(
      texts(layoutCore(input([p("A"), p(" b", { bold: true })], 25), shaped)),
    ).toEqual(["A", "b"]);
    expect(
      texts(
        layoutCore(input([p("A"), p(" b", { kerning: "none" })], 25), shaped),
      ),
    ).toEqual(["A", "b"]);
  });
  it.each([false, true])(
    "accounts for tracking across spaces and source runs (fragmented=%s)",
    (fragmented) => {
      const content = fragmented
        ? [p("ab", { letterSpacingPx: 2 }), p(" cd", { letterSpacingPx: 2 })]
        : [p("ab cd", { letterSpacingPx: 2 })];
      const result = layoutCore(input(content, 55), shaped);
      expect(texts(result)).toEqual(["ab", "cd"]);
      expect(
        result.placements.map(({ line }) =>
          line.tokens.reduce((sum, t) => sum + t.width, 0),
        ),
      ).toEqual([22, 22]);
    },
  );
  it("uses shaped widths for centered bullet and wavy underline placement", () => {
    const value = input([], 100, {
      paragraphs: [
        para({
          align: "center",
          bullet: {
            text: "•",
            family: "Arial",
            sizePx: 20,
            fillHex: "#000000",
          },
          pieces: [p("A b", { underline: "wavy" })],
        }),
      ],
    });
    const result = layoutCore(value, shaped),
      line = result.placements[0].line;
    expect(line.tokens.reduce((sum, t) => sum + t.width, 0)).toBe(23);
    expect(line.bullet.x).toBe(17 + 20 + (100 - 20 - 23) / 2 - 20);
    const svg = layoutTextSvg(value, shaped);
    expect(svg).toContain('d="M65.5 ');
  });
  it("measures the complete shaped span even when wrapping is disabled", () => {
    const result = layoutCore(
      input([p("A b T c")], 1, { wrap: false }),
      shaped,
    );
    expect(texts(result)).toEqual(["A b T c"]);
    expect(
      result.placements[0].line.tokens.reduce((sum, t) => sum + t.width, 0),
    ).toBe(56);
  });
  it("uses shaped emergency prefixes while retaining full unbroken word overflow", () => {
    const kerned = (text, spec) => ({
      ...measure(text, spec),
      widthPx: text.length * 10 - (text.match(/AV/g)?.length ?? 0) * 7,
    });
    const result = layoutCore(input([p("x AVAVAV y")], 35), kerned);
    expect(texts(result)).toEqual(["x", "AVAV", "AV y"]);
    expect(result.unbreakableOverflowW).toBe(4);
  });
  it("shapes equal-format source fragments before testing word overflow", () => {
    const kerned = (text, spec) => ({
      ...measure(text, spec),
      widthPx: text.length * 10 - (text.match(/AV/g)?.length ?? 0) * 7,
    });
    const result = layoutCore(input([p("A"), p("V")], 15), kerned);
    expect(texts(result)).toEqual(["AV"]);
    expect(result.unbreakableOverflowW).toBe(0);
  });
  it("keeps authored breaks out of glyph measurement spans", () => {
    const result = layoutCore(
      input([p("A"), p("", { isBreak: true }), p("b")], 100),
      (text, spec) => {
        if (text === "") throw Error("break measured as a glyph span");
        return shaped(text, spec);
      },
    );
    expect(texts(result)).toEqual(["A", "b"]);
  });
  it("bounds measured characters for a very long homogeneous line", () => {
    const text = Array.from(
      { length: 4000 },
      (_, i) => `w${i.toString(36)}`,
    ).join(" ");
    let characters = 0;
    const result = layoutCore(
      input([p(text)], text.length * 20),
      (value, spec) => {
        characters += value.length;
        return shaped(value, spec);
      },
    );
    expect(texts(result)).toEqual([text]);
    expect(characters).toBeLessThan(
      text.length * (Math.ceil(Math.log2(text.length)) + 4),
    );
  });
});

describe("justified paragraphs", () => {
  // 20 px per character: "aa bb cc dd" wraps after "cc" in 200 px.
  const justified = (pieces) =>
    layoutTextSvg(
      body({
        boxXpx: 0,
        boxWpx: 200,
        wrap: true,
        paragraphs: [para({ align: "justify", pieces })],
      }),
      measure,
    );
  it("widens the word spaces of each wrapped line to fill it", () => {
    const svg = justified([piece("aa bb cc dd", 40)]);
    const lines = [...svg.matchAll(/<text\b[^>]*>/g)].map((m) => m[0]);
    expect(lines).toHaveLength(2);
    // "aa bb cc" is 160 px wide, leaving 40 px for its two spaces.
    expect(lines[0]).toContain('word-spacing="20"');
    expect(lines[1]).not.toContain("word-spacing");
  });
  it("leaves a line that ends at a line break at the start", () => {
    const svg = justified([
      piece("aa bb", 40),
      { ...piece("", 40), isBreak: true },
      piece("cc", 40),
    ]);
    expect(svg).not.toContain("word-spacing");
  });
});

describe("highlighted runs", () => {
  const highlighted = (options = {}) =>
    layoutTextSvg(
      body({
        boxXpx: 0,
        boxWpx: 400,
        paragraphs: [
          para({
            pieces: [
              piece("ab ", 40),
              { ...piece("cd", 40), highlightHex: "#FFFF00" },
              piece(" ef", 40),
            ],
            ...options,
          }),
        ],
      }),
      measure,
    );
  it("paints the highlight behind the run, as tall as the line's text", () => {
    const svg = highlighted();
    const band = svg.match(
      /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="#FFFF00"\/>/,
    );
    expect(band).not.toBeNull();
    // "ab " is 60 px at 20 px per character; "cd" is 40 px.
    expect(Number(band[1])).toBe(60);
    expect(Number(band[3])).toBe(40);
    expect(svg.indexOf("<rect")).toBeLessThan(svg.indexOf("<text"));
    // A highlighted run is a span of its own.
    expect(svg).toContain(">cd</tspan>");
  });
  it("runs a right-to-left line's first run from the right", () => {
    const band = highlighted({ rtl: true }).match(
      /<rect x="([^"]+)"[^>]*fill="#FFFF00"/,
    );
    // 160 px of text from x = 0: "cd" sits 60 px in from the right.
    expect(Number(band[1])).toBe(160 - 60 - 40);
  });
});
