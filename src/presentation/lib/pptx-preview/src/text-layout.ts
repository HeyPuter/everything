import { splitGraphemes } from "unicode-segmenter/grapheme";
import type {
  DateFieldOptions,
  SlideLayoutData,
  SlideShapeData,
} from "../../pptx/src/index.ts";

// Pure-SVG text layout engine for the preview renderer.
//
// The playground's default text path lays text out with <foreignObject> + HTML
// and lets the browser wrap/position it. That cannot be rasterized without a
// browser, so the fidelity harness (and any future Node renderer) needs text as
// real SVG <text>/<tspan>. This module does that layout itself: measure runs,
// wrap to the inner box, position lines on their baselines, and emit SVG.
//
// It is PURE — no @office-kit/pptx, no Node, no browser globals — so it runs in the
// SvelteKit bundle, in the Node harness, and in unit tests. The caller injects
// a `TextMeasurer`; in the browser that can wrap `ctx.measureText`, in Node it
// wraps fontkit (see site/fidelity/measure.ts). All geometry is in CSS px.

// ---------------------------------------------------------------------------
// Public injection contract.

/** What a measurer needs to size one run. Pixels at 96 DPI; the caller has
 *  already applied EMU→px, pt→px and the autofit fontScale. `family` is the
 *  resolved internal family name (see `substituteFamily`), not a CSS list. */
export interface FontSpec {
  readonly family: string;
  readonly sizePx: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly letterSpacingPx: number;
  /** Resolved kerning; omitted leaves the measurer's default unchanged. */
  readonly kerning?: "normal" | "none";
}

/** Advance width of `text` in px, plus optional vertical metrics. A real
 *  measurer returns ascent/descent/lineGap so line height matches the font;
 *  the heuristic returns width only and the engine falls back to a ratio. */
export interface MeasureResult {
  readonly widthPx: number;
  readonly ascentPx?: number;
  readonly descentPx?: number;
  readonly lineGapPx?: number;
  /** True when the width is an estimate rather than a glyph measurement —
   *  the heuristic measurer always, the fontkit measurer when the resolved
   *  font lacks a glyph and per-character ratios filled the gap. The audit
   *  API surfaces this so borderline verdicts can be treated as advisory. */
  readonly approximate?: boolean;
}

export type TextMeasurer = (text: string, spec: FontSpec) => MeasureResult;

export type TextLayoutMode = "foreignObject" | "svg";

export interface RenderSlideOptions {
  /** Fit the slide uniformly by default. Image previews can map the complete
   * viewBox to a host rectangle that already controls the slide's aspect ratio. */
  readonly preserveAspectRatio?: "xMidYMid meet" | "none";
  /** Keep definition IDs stable for standalone SVG images so browsers can reuse
   * unchanged previews. Leave false when inserting SVGs into a shared document,
   * where IDs must remain unique across renders. Defaults to false. */
  readonly stableDefinitionIds?: boolean;
  /** Use native CSS gradients for browser rectangle paints. Defaults to pure
   * SVG for consumers without foreignObject support. Both paths preserve
   * the nonlinear two-color rule and ordinary premultiplied alpha. */
  readonly gradientRendering?: "svg" | "css";
  /** Override the presentation's opening-time snapshot for a render/export. */
  readonly fieldDate?: Date;
  readonly dateFieldOptions?: DateFieldOptions;
  /** Measurer used by the pure-SVG text path. Required when `textLayout` is
   *  'svg'; ignored otherwise. */
  readonly measureText?: TextMeasurer;
  /** Additional emitted font usages that do not pass through text measurement.
   * Resource exporters can include their exact font face and style. */
  readonly onFontUsed?: (font: FontSpec) => void;
  /** Which text path to use. Defaults to 'foreignObject' (the browser path)
   *  so existing callers are unaffected; the harness opts into 'svg'. */
  readonly textLayout?: TextLayoutMode;
  /** Resolves authored typefaces for SVG text and measurement. */
  readonly resolveFontFamily?: (
    family: string | null | undefined,
    layout: SlideLayoutData | null,
  ) => string;
  /** Font-provider capabilities may further restrict the resolved OOXML
   * kerning. Uses the same resolved face for measuring and painting. */
  readonly resolveFontKerning?: (spec: FontSpec) => FontSpec["kerning"];
  /** Draw one layer of the slide rather than the whole of it, so a show can
   *  move the parts of a slide independently (animations). `background`
   *  says whether the slide background and the layout's and master's own
   *  shapes are drawn; `shape` is asked about each of the slide's top-level
   *  shapes: false leaves it out, true draws it whole, and a part draws its
   *  fill and outline (`body`) and/or some of its paragraphs. */
  readonly layer?: {
    readonly background: boolean;
    readonly shape: (shape: SlideShapeData) => boolean | SlideShapeLayerPart;
  };
}

export interface SlideShapeLayerPart {
  /** The shape's geometry: fill, outline and effects. */
  readonly body: boolean;
  /** Paragraph indexes to paint; null paints every paragraph. */
  readonly paragraphs: ReadonlySet<number> | null;
}

// ---------------------------------------------------------------------------
// Font substitution. resvg matches a <text font-family> against the *internal*
// family name in the loaded TTF. We bundle metric-compatible open substitutes
// (the same ones LibreOffice renders with), so we must emit and measure under
// the substitute's exact internal name — "Liberation Sans" with a space, not
// "LiberationSans". This map is the single source of truth shared by the SVG
// emitter and the Node measurer (site/fidelity/measure.ts).

export const SANS = "Carlito"; // Calibri / Aptos / generic sans substitute
export const SERIF = "Caladea"; // Cambria substitute
export const ARIAL = "Liberation Sans";
export const TIMES = "Liberation Serif";
export const MONO = "Liberation Mono";

export const substituteFamily = (family: string | null | undefined): string => {
  if (!family) return SANS;
  const f = family.trim().toLowerCase();
  if (f.startsWith("calibri") || f.startsWith("aptos")) return SANS;
  if (f.startsWith("cambria")) return SERIF;
  if (
    f === "arial" ||
    f === "helvetica" ||
    f === "helvetica neue" ||
    f.startsWith("arial ")
  )
    return ARIAL;
  if (f === "times new roman" || f === "times" || f.startsWith("times "))
    return TIMES;
  if (
    f === "courier new" ||
    f === "courier" ||
    f === "consolas" ||
    f.startsWith("courier ")
  )
    return MONO;
  // Unknown family → generic sans substitute, matching DEFAULT_FONT's Calibri
  // lead and LibreOffice's behavior when the named face is unavailable.
  return SANS;
};

// CJK detection — lifted from render-slide.ts so the heuristic measurer
// matches today's autofit estimate exactly. Exported for the fontkit
// measurer's missing-glyph fallback, which must estimate with the same ratios.
export const isCjk = (cp: number): boolean =>
  (cp >= 0x3040 && cp <= 0x309f) ||
  (cp >= 0x30a0 && cp <= 0x30ff) ||
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0xac00 && cp <= 0xd7af);

// Mean glyph width as a fraction of size for a typical sans-serif (0.55),
// also used by the autofit estimate. Used by the heuristic measurer
// and by the fontkit measurer's missing-glyph fallback.
export const AVG_GLYPH_W_RATIO = 0.55;

export const defaultMeasurer: TextMeasurer = (text, spec) => {
  let w = 0;
  for (const ch of text) {
    const ratio = isCjk(ch.codePointAt(0) ?? 0) ? 1 : AVG_GLYPH_W_RATIO;
    w += spec.sizePx * ratio;
  }
  const n = [...text].length;
  if (n > 1) w += spec.letterSpacingPx * (n - 1); // tracking applies between glyphs
  return { widthPx: w, approximate: true };
};

// Vertical-metric fallback when the measurer returns width only. Calibri /
// Carlito sit near ascent 0.9em / descent 0.22em / gap 0.08em including the
// internal leading. The scored harness path always supplies real metrics, so
// this only drives the browser heuristic preview.
const FALLBACK_ASCENT = 0.9;
const FALLBACK_DESCENT = 0.22;
const FALLBACK_LINEGAP = 0.08;

// Compatible line spacing uses a font-independent 120% em
// advance. Font metrics still determine the baseline and final descent.
const COMPATIBLE_LINE_HEIGHT = 1.2;

// ---------------------------------------------------------------------------
// Engine input model. render-slide.ts resolves the OOXML cascade and hands the
// engine this already-normalized, px-native structure.

export interface PieceInput {
  readonly text: string;
  readonly family: string; // internal substituted name
  readonly sizePx: number; // post-autofit
  readonly bold: boolean;
  readonly italic: boolean;
  readonly letterSpacingPx: number;
  readonly kerning?: "normal" | "none";
  readonly fillHex: string;
  readonly fillOpacity?: number;
  /** `'wavy'` covers every `ST_TextUnderlineType` wavy variant (`wavy`,
   *  `wavyDbl`, `wavyHeavy`) — SVG/resvg has no `text-decoration-style`
   *  support, so the engine draws it as an explicit path (see `wavyPath`). */
  readonly underline: "none" | "single" | "wavy";
  readonly strike: boolean;
  /** Underline color when it differs from the text's; drawn as a line. */
  readonly underlineHex?: string;
  /** A double underline (`dbl`), drawn as two lines. */
  readonly underlineDouble?: boolean;
  /** A double strikethrough (`dblStrike`), drawn as two lines. */
  readonly strikeDouble?: boolean;
  /** Text outline (`<a:ln>` on the run). */
  readonly strokeHex?: string;
  readonly strokeWidthPx?: number;
  readonly strokeOpacity?: number;
  readonly superSub: 0 | 1 | -1; // 1 superscript, -1 subscript
  readonly href: string | null;
  readonly isBreak: boolean; // <a:br>
}

export interface BulletInput {
  readonly text: string;
  readonly family: string;
  readonly sizePx: number;
  readonly fillHex: string;
  readonly fillOpacity?: number;
  // Data URL for a picture bullet (`<a:buBlip>`); when set, the bullet
  // renders as a square `<image>` of `sizePx` instead of `text`.
  readonly imageHref?: string;
}

export interface ParaInput {
  readonly align: "left" | "center" | "right" | "justify";
  readonly marLpx: number;
  readonly marRpx: number;
  readonly firstIndentPx: number; // first-line indent (negative = hanging)
  readonly spcBefPx: number;
  readonly spcAftPx: number;
  /** Multiples of the first/last natural line height, before custom leading. */
  readonly spcBefPct?: number;
  readonly spcAftPct?: number;
  readonly lineSpacing:
    { kind: "pct"; value: number } | { kind: "pts"; px: number } | null;
  readonly lineSpacingReduction: number; // lnSpcReduction, percentage points
  readonly bullet: BulletInput | null;
  readonly pieces: readonly PieceInput[];
  readonly fallbackSizePx: number; // line height for an empty paragraph
  /** Invisible, zero-advance paragraph end; contributes only to the final line. */
  readonly endMarker?: FontSpec;
  /** Font of an empty paragraph or the empty line after its final break. */
  readonly emptyLineFont?: FontSpec;
  /** Custom tab stops, measured from the text box's left inset. */
  readonly tabStops?: readonly {
    readonly posPx: number;
    readonly align: "l" | "ctr" | "r" | "dec";
  }[];
  /** Spacing of the default tab stops past the last custom one. */
  readonly defaultTabPx?: number;
}

/** Normalized text direction the engine understands. render-slide maps the
 *  OOXML `vert` token (`vert`/`eaVert`/`vert270`/…) onto one of these — the
 *  engine stays free of OOXML vocabulary. `cw90` rotates the horizontal layout
 *  90° clockwise (reading top-to-bottom, columns right-to-left); `cw270` is the
 *  opposite 270° rotation (columns left-to-right). `upright` is `wordArtVert` —
 *  glyphs stay upright and stack one per line (render-slide pre-splits the runs
 *  one code point per line), so it lays out like `none` with no rotation. */
export type VerticalLayout = "none" | "cw90" | "cw270" | "upright";

export interface ColumnLayout {
  readonly count: number; // clamped to >= 2 before this point
  readonly gapPx: number;
}

export interface TextBodyInput {
  readonly boxXpx: number;
  readonly boxYpx: number;
  readonly boxWpx: number;
  readonly boxHpx: number;
  readonly anchor: "top" | "center" | "bottom";
  readonly wrap: boolean;
  readonly paragraphs: readonly ParaInput[];
  /** Compatible spacing applies when compatLnSpc is omitted. An
   * explicit false instead uses the font's ascent + descent + line gap. */
  readonly compatibleLineSpacing?: boolean;
  /** spcFirstLastPara includes the outer paragraph margins and the last
   * line's full advance in the bounds used for anchoring and autofit. */
  readonly includeOuterSpacing?: boolean;
  /** Vertical text direction; omitted / 'none' is the default horizontal flow. */
  readonly vert?: VerticalLayout;
  /** Multi-column body (`numCol`/`spcCol`); null / omitted is single column. */
  readonly columns?: ColumnLayout | null;
  /** Paint only these paragraphs (by index). Every paragraph still takes its
   *  place in the layout, so a paragraph painted alone sits exactly where it
   *  does in the whole body. Null / omitted paints them all. */
  readonly visibleParagraphs?: ReadonlySet<number> | null;
}

// ---------------------------------------------------------------------------
// Layout internals.

export interface Token {
  readonly text: string;
  readonly piece: PieceInput;
  readonly isSpace: boolean;
  readonly isBreak: boolean;
  /** Full break unit width on its first token, including other formatted runs. */
  readonly wordWidth?: number;
  /** A formatting boundary inside a word/grapheme is not a break opportunity. */
  readonly wordContinuation?: boolean;
  width: number;
}

export interface Line {
  readonly tokens: Token[];
  /** This line begins at an automatic wrap, rather than an authored break. */
  readonly automaticStart: boolean;
  /** Unbroken word excess over this line's content width, before emergency splitting. */
  readonly unbreakableOverflowW: number;
  /** Index into TextBodyInput.paragraphs of the paragraph this line came
   *  from — the audit API maps wrapped line counts back to paragraphs. */
  readonly paraIndex: number;
  ascent: number;
  descent: number;
  lineGap: number;
  topY: number;
  advance: number;
  /** Baseline relative to line top; independent of baseline-to-baseline advance. */
  baselineOffset: number;
  /** Last-line extent when trailing line spacing is suppressed. */
  extent: number;
  anchorX: number;
  textAnchor: "start" | "middle" | "end";
  bullet: { x: number; baselineDy: number; b: BulletInput } | null;
}

// The box (in local coords) that one horizontal layout pass fills. Horizontal
// text uses the shape box directly; vertical text uses a swapped-extent frame
// re-centred on the box (see layoutTextSvg).
interface Frame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// A laid-out line ready to emit: its baseline Y plus an X shift (non-zero only
// for the second-and-later columns of a multi-column body).
export interface Placement {
  readonly line: Line;
  readonly baselineY: number;
  readonly dx: number;
}

// Builds the line list for one column of a given content width. Closes over the
// paragraph model and measurer caches inside layoutTextSvg.
type LineBuilder = (
  contentLeft: number,
  contentRight: number,
) => { lines: Line[]; blockH: number };

// Emergency wrapping uses user-perceived characters (UAX #29), not code
// points or glyph advances. A standalone mark can have a positive advance.
// Use one Unicode version across runtimes, including browsers without
// Intl.Segmenter. Printable ASCII and unified Han ideographs contain no
// extending/joining characters or Hangul jamo, so their
// code-point boundaries are already grapheme boundaries (UAX #29 GB999).
const SIMPLE_GRAPHEMES = /^[\u0020-\u007e\p{Unified_Ideograph}]*$/u;
function* graphemes(text: string): IterableIterator<string> {
  if (SIMPLE_GRAPHEMES.test(text)) {
    yield* text;
  } else {
    yield* splitGraphemes(text);
  }
}

// East Asian text carries no spaces, so a whole CJK clause arrives as one
// `\S+` "word". Treating it as unbreakable pushes the entire clause to the
// next line (leaving e.g. a lone bullet glyph behind). Instead we break
// East Asian runs between characters. Split CJK runs into
// grapheme tokens, gluing closing punctuation to its predecessor and
// opening brackets to their successor (simple kinsoku).
const EAST_ASIAN_CHAR =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const CLOSING_PUNCT = /^[、。，．・）」』】〉》”’！？：；ー〜…,.!?:;)\]}]+$/;
const OPENING_PUNCT = /^[（「『【〈《“‘([{]+$/;

const isPunctuationSequence = (part: string, pattern: RegExp): boolean => {
  // A punctuation grapheme may also carry marks. Examine each grapheme's
  // leading character without detaching the marks from the punctuation.
  if (!pattern.test(part[0] ?? "")) return false;
  for (const cluster of graphemes(part))
    if (!pattern.test(cluster[0]!)) return false;
  return true;
};

const splitEastAsianBreakables = (word: string): string[] => {
  if (!EAST_ASIAN_CHAR.test(word)) return [word];
  const parts: string[] = [];
  let latin = "";
  for (const ch of graphemes(word)) {
    if (EAST_ASIAN_CHAR.test(ch)) {
      if (latin !== "") {
        parts.push(latin);
        latin = "";
      }
      parts.push(ch);
    } else {
      latin += ch;
    }
  }
  if (latin !== "") parts.push(latin);

  const glued: string[] = [];
  for (const part of parts) {
    const prev = glued.at(-1);
    if (
      prev !== undefined &&
      (isPunctuationSequence(part, CLOSING_PUNCT) ||
        isPunctuationSequence(prev, OPENING_PUNCT))
    ) {
      glued[glued.length - 1] = prev + part;
    } else {
      glued.push(part);
    }
  }
  return glued;
};

// Find break units in the logical text, then map them back to their source
// pieces. Run boundaries describe formatting, not word boundaries. Scanning
// monotonically through both sequences keeps even heavily formatted text
// linear in length; measuring growing prefixes would be quadratic.
const tokenizePieces = (
  pieces: readonly PieceInput[],
  wrap: boolean,
  available: number,
  width: (text: string, piece: PieceInput) => number,
): Token[] => {
  const tokens: Token[] = [];
  let pending: PieceInput[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    const text = pending.map((piece) => piece.text).join("");
    let pieceIndex = 0;
    let pieceOffset = 0;
    // JS \s also includes nonbreaking spaces and U+FEFF (a word joiner).
    // Those are part of a break unit, never a discardable inter-word gap.
    // A tab is a token of its own: its width depends on where it lands.
    const words = text.match(
      /\t|[^\S\t\u00a0\u2007\u202f\ufeff]+|[\S\u00a0\u2007\u202f\ufeff]+/gu,
    );
    for (const word of words ?? []) {
      const isSpace = /^[^\S\u00a0\u2007\u202f\ufeff]+$/u.test(word);
      const segments = isSpace
        ? [word]
        : splitEastAsianBreakables(word).flatMap((part) =>
            // Breaks are permitted after authored ASCII hyphens, even
            // before digits, comma or a word joiner. This native delimiter
            // rule differs from Unicode's default line-break rules. Repeated
            // hyphens stay with their preceding text. Unicode hyphens are
            // distinct: native reference controls do not give them this
            // opportunity.
            // No-wrap still measures the complete compound.
            wrap ? part.split(/(?<=-)(?!-)/u) : [part],
          );
      for (const segment of segments) {
        const start = tokens.length;
        let remaining = segment.length;
        let wordWidth = 0;
        while (remaining > 0) {
          const piece = pending[pieceIndex]!;
          const length = Math.min(remaining, piece.text.length - pieceOffset);
          const fragment = piece.text.slice(pieceOffset, pieceOffset + length);
          const measured = width(fragment, piece);
          tokens.push({
            text: fragment,
            piece,
            isSpace,
            isBreak: false,
            width: measured,
          });
          wordWidth += measured;
          remaining -= length;
          pieceOffset += length;
          if (pieceOffset === piece.text.length) {
            pieceIndex++;
            pieceOffset = 0;
          }
        }
        // Identical formatting can span source runs. SVG paints it as one
        // shaped span, so its unbroken word width must use that same context.
        if (tokens.length > start + 1) {
          wordWidth = groupTokens(tokens.slice(start)).reduce(
            (sum, group) => sum + width(group.text, group.piece),
            0,
          );
        }
        if (wrap && !isSpace && wordWidth > available) {
          const fragments = tokens.splice(start);
          if (SIMPLE_GRAPHEMES.test(segment)) {
            // Keep the cheap scalar path for text whose graphemes are known
            // to be single code points, including heavily formatted words.
            let firstCharacter = true;
            for (const fragment of fragments) {
              for (const ch of fragment.text) {
                tokens.push({
                  ...fragment,
                  text: ch,
                  width: width(ch, fragment.piece),
                  ...(firstCharacter ? { wordWidth } : {}),
                });
                firstCharacter = false;
              }
            }
            continue;
          }
          let fragmentIndex = 0,
            fragmentOffset = 0;
          let firstCluster = true;
          // Segment the logical break unit before mapping it back to pieces.
          // A formatting boundary inside a grapheme must not allow a wrap.
          // Both cursors advance monotonically, including for many tiny runs.
          for (const cluster of graphemes(segment)) {
            const clusterStart = tokens.length;
            let remaining = cluster.length,
              clusterWidth = 0;
            while (remaining > 0) {
              const fragment = fragments[fragmentIndex]!;
              const length = Math.min(
                remaining,
                fragment.text.length - fragmentOffset,
              );
              const text = fragment.text.slice(
                fragmentOffset,
                fragmentOffset + length,
              );
              const measured = width(text, fragment.piece);
              tokens.push({
                ...fragment,
                text,
                width: measured,
                ...(tokens.length > clusterStart
                  ? { wordContinuation: true }
                  : {}),
              });
              clusterWidth += measured;
              remaining -= length;
              fragmentOffset += length;
              if (fragmentOffset === fragment.text.length) {
                fragmentIndex++;
                fragmentOffset = 0;
              }
            }
            tokens[clusterStart] = {
              ...tokens[clusterStart]!,
              wordWidth: firstCluster ? wordWidth : clusterWidth,
            };
            firstCluster = false;
          }
        } else if (!isSpace && tokens.length > start + 1) {
          tokens[start] = { ...tokens[start]!, wordWidth };
          for (let index = start + 1; index < tokens.length; index++) {
            tokens[index] = { ...tokens[index]!, wordContinuation: true };
          }
        }
      }
    }
    pending = [];
  };
  for (const piece of pieces) {
    if (piece.isBreak) {
      flush();
      tokens.push({ text: "", piece, isSpace: false, isBreak: true, width: 0 });
    } else if (piece.text !== "") pending.push(piece);
  }
  flush();
  return tokens;
};

const specOf = (piece: PieceInput): FontSpec => ({
  family: piece.family,
  sizePx: piece.sizePx,
  bold: piece.bold,
  italic: piece.italic,
  letterSpacingPx: piece.letterSpacingPx,
  ...(piece.kerning ? { kerning: piece.kerning } : {}),
});

const bulletSpec = (b: BulletInput): FontSpec => ({
  family: b.family,
  sizePx: b.sizePx,
  bold: false,
  italic: false,
  letterSpacingPx: 0,
});

const escapeXml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );

const fmt = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

// ---------------------------------------------------------------------------

export interface LayoutCore {
  readonly placements: Placement[];
  readonly paragraphSpacing: readonly { beforePx: number; afterPx: number }[];
  readonly requiredH: number; // laid-out content height in px (top-anchored space)
  /** Explicit lines can exceed height even when no automatic wrapping occurs. */
  readonly automaticWraps: number;
  /**
   * Largest unbroken word excess, in the layout frame's horizontal axis.
   * Emergency splitting does not erase it. This is distinct from painted ink
   * overflow (for example, leading spaces) and does not select a fit policy.
   */
  readonly unbreakableOverflowW: number;
  readonly vert: VerticalLayout;
  readonly cx: number;
  readonly cy: number;
}

// Gives each tab on a line the width that carries the text after it to the
// next tab stop: a custom stop (left, centered, right or decimal) or, past
// those, the next default stop. Positions count from the box's left inset.
const placeTabs = (
  toks: Token[],
  lineLeft: number,
  origin: number,
  para: ParaInput,
): void => {
  const stops = [...(para.tabStops ?? [])].sort((a, b) => a.posPx - b.posPx);
  const step =
    para.defaultTabPx && para.defaultTabPx > 0 ? para.defaultTabPx : 96;
  let x = lineLeft;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.isBreak) continue;
    if (t.text !== "\t") {
      x += t.width;
      continue;
    }
    const at = x - origin;
    const stop = stops.find((s) => s.posPx > at + 0.5);
    let target: number;
    let width: number;
    if (stop) {
      target = origin + stop.posPx;
      // The text up to the next tab decides where a non-left stop puts it.
      let segment = 0,
        beforePoint = 0,
        pointSeen = false;
      for (let k = i + 1; k < toks.length && toks[k]!.text !== "\t"; k++) {
        const next = toks[k]!;
        if (next.isBreak) break;
        segment += next.width;
        if (!pointSeen) {
          const point = next.text.search(/[.,]/);
          if (point >= 0) {
            pointSeen = true;
            beforePoint += (next.width * point) / Math.max(1, next.text.length);
          } else beforePoint += next.width;
        }
      }
      const shift =
        stop.align === "r"
          ? segment
          : stop.align === "ctr"
            ? segment / 2
            : stop.align === "dec"
              ? pointSeen
                ? beforePoint
                : segment
              : 0;
      width = target - shift - x;
    } else {
      const last = stops.length ? stops[stops.length - 1]!.posPx : 0;
      const from = Math.max(at, last);
      target = origin + (Math.floor(from / step + 1e-6) + 1) * step;
      width = target - x;
    }
    t.width = Math.max(0, width);
    x += t.width;
  }
};

// Exported (module-level, not part of the package's public surface) for the
// audit API, which reads the raw placements instead of emitting SVG.
export const layoutCore = (
  input: TextBodyInput,
  measure: TextMeasurer,
): LayoutCore => {
  const widthCache = new Map<string, number>();
  const metricCache = new Map<string, { a: number; d: number; g: number }>();
  const key = (text: string, s: FontSpec): string =>
    `${s.family}|${s.sizePx}|${s.bold}|${s.italic}|${s.letterSpacingPx}|${s.kerning ?? "auto"}|${text}`;
  const mWidth = (text: string, s: FontSpec): number => {
    const k = key(text, s);
    let w = widthCache.get(k);
    if (w === undefined) {
      w = measure(text, s).widthPx;
      widthCache.set(k, w);
    }
    return w;
  };
  const mMetrics = (s: FontSpec): { a: number; d: number; g: number } => {
    const k = `${s.family}|${s.sizePx}|${s.bold}|${s.italic}`;
    let m = metricCache.get(k);
    if (!m) {
      const r = measure("Mg", s);
      m =
        Number.isFinite(r.ascentPx) &&
        Number.isFinite(r.descentPx) &&
        r.ascentPx! >= 0 &&
        r.descentPx! >= 0 &&
        r.ascentPx! + r.descentPx! > 0
          ? {
              a: r.ascentPx!,
              d: r.descentPx!,
              g: Number.isFinite(r.lineGapPx) ? r.lineGapPx! : 0,
            }
          : {
              a: s.sizePx * FALLBACK_ASCENT,
              d: s.sizePx * FALLBACK_DESCENT,
              g: s.sizePx * FALLBACK_LINEGAP,
            };
      metricCache.set(k, m);
    }
    return m;
  };

  // One horizontal layout pass, parameterized on the content box's left/right
  // edges so the same wrap/measure code serves the shape box (horizontal), a
  // single column of a multi-column body, and the swapped frame of vertical
  // text. Closes over the measurer caches above.
  const paragraphSpacing: { beforePx: number; afterPx: number }[] = [];
  const buildLines: LineBuilder = (contentLeft, contentRight) => {
    const lines: Line[] = [];
    let cursorY = 0;

    for (let paraIndex = 0; paraIndex < input.paragraphs.length; paraIndex++) {
      const para = input.paragraphs[paraIndex]!;
      const spacing = { beforePx: para.spcBefPx, afterPx: para.spcAftPx };
      paragraphSpacing[paraIndex] = spacing;
      if (
        para.spcBefPct === undefined &&
        (input.includeOuterSpacing || paraIndex > 0)
      )
        cursorY += spacing.beforePx;
      const wrapLeft = contentLeft + para.marLpx;
      const wrapRight = contentRight - para.marRpx;
      const firstLeft = wrapLeft + para.firstIndentPx;
      const hasText = para.pieces.some((p) => !p.isBreak && p.text !== "");
      const bullet = para.bullet && hasText ? para.bullet : null;
      // Picture bullets reserve a square of `sizePx` plus a trailing space;
      // glyph bullets reserve the measured "<glyph> " width.
      const bulletLead = bullet
        ? bullet.imageHref
          ? bullet.sizePx + mWidth(" ", bulletSpec(bullet))
          : mWidth(`${bullet.text} `, bulletSpec(bullet))
        : 0;

      // Break units can span formatted runs. Pre-split units wider than a full
      // line into characters only after measuring all their source fragments.
      const avail = Math.max(1, wrapRight - wrapLeft);
      const tokens = tokenizePieces(
        para.pieces,
        input.wrap,
        avail - bulletLead,
        (text, piece) => mWidth(text, specOf(piece)),
      );

      const wrapped = wrapTokens(
        tokens,
        input.wrap,
        wrapRight - firstLeft - bulletLead,
        avail,
        (text, piece) => mWidth(text, specOf(piece)),
      );
      const paraLines =
        wrapped.length > 0 ? wrapped : [{ tokens: [], automaticStart: false }];

      for (let li = 0; li < paraLines.length; li++) {
        const { tokens: toks, automaticStart } = paraLines[li]!;
        const isFirst = li === 0;
        // Bulleted hanging indent (firstIndent < 0): the bullet goes at
        // marL+indent and starts the text at marL itself, so the
        // first line aligns with the wrapped lines. The bullet-width floor
        // keeps a bullet wider than the hang from overlapping its text.
        const lineLeft = bullet
          ? Math.max(wrapLeft, firstLeft + bulletLead)
          : (isFirst ? firstLeft : wrapLeft) + bulletLead;
        const availableW = wrapRight - lineLeft;
        if (toks.some((t) => t.text === "\t"))
          placeTabs(toks, lineLeft, contentLeft, para);
        let unbreakableOverflowW = 0;
        let ascent = 0;
        let descent = 0;
        let lineGap = 0;
        let maxSize = 0;
        for (const t of toks) {
          if (t.isBreak) continue;
          if (!t.isSpace && !t.wordContinuation)
            unbreakableOverflowW = Math.max(
              unbreakableOverflowW,
              (t.wordWidth ?? t.width) - availableW,
            );
          const m = mMetrics(specOf(t.piece));
          maxSize = Math.max(maxSize, t.piece.sizePx);
          if (m.a > ascent) ascent = m.a;
          if (m.d > descent) descent = m.d;
          if (m.g > lineGap) lineGap = m.g;
        }
        if (ascent > 0 && li === paraLines.length - 1 && para.endMarker) {
          const marker = para.endMarker;
          const m = mMetrics(marker);
          maxSize = Math.max(maxSize, marker.sizePx);
          ascent = Math.max(ascent, m.a);
          descent = Math.max(descent, m.d);
          lineGap = Math.max(lineGap, m.g);
        }
        if (ascent === 0) {
          // A break's font matters only when it terminates an empty line.
          // A trailing empty line instead uses the paragraph insertion point.
          const breakFont = toks.find((t) => t.isBreak)?.piece;
          const emptyFont =
            (breakFont && breakFont.sizePx > 0 ? breakFont : undefined) ??
            para.emptyLineFont ??
            (para.endMarker
              ? { ...para.endMarker, sizePx: para.fallbackSizePx }
              : undefined);
          maxSize = emptyFont?.sizePx ?? para.fallbackSizePx;
          const m = emptyFont ? mMetrics(emptyFont) : null;
          ascent = m?.a ?? maxSize * FALLBACK_ASCENT;
          descent = m?.d ?? maxSize * FALLBACK_DESCENT;
          lineGap = m?.g ?? maxSize * FALLBACK_LINEGAP;
        }
        if (input.compatibleLineSpacing !== false) {
          const scale = (COMPATIBLE_LINE_HEIGHT * maxSize) / (ascent + descent);
          ascent *= scale;
          descent *= scale;
          lineGap = 0;
        }
        if (isFirst && para.spcBefPct !== undefined) {
          spacing.beforePx = para.spcBefPct * (ascent + descent + lineGap);
          if (input.includeOuterSpacing || paraIndex > 0)
            cursorY += spacing.beforePx;
        }
        const line: Line = {
          tokens: toks,
          automaticStart,
          unbreakableOverflowW,
          paraIndex,
          ascent,
          descent,
          lineGap,
          topY: cursorY,
          advance: 0,
          baselineOffset: 0,
          extent: 0,
          anchorX: lineLeft,
          textAnchor: "start",
          bullet: null,
        };
        if (para.align === "center") {
          line.textAnchor = "middle";
          line.anchorX = (lineLeft + wrapRight) / 2;
        } else if (para.align === "right") {
          line.textAnchor = "end";
          line.anchorX = wrapRight;
        }
        if (isFirst && bullet) {
          // The bullet hangs to the LEFT of the aligned text block and travels
          // with it: on a centered / right-aligned paragraph the bullet stays
          // immediately left of the text, not pinned to the margin.
          // Offset it from the rendered text's left edge by the same gap it has
          // on a left-aligned line (lineLeft - firstLeft).
          let bulletX = firstLeft;
          if (para.align === "center" || para.align === "right") {
            let end = toks.length;
            while (
              end > 0 &&
              (toks[end - 1]!.isSpace || toks[end - 1]!.isBreak)
            )
              end--;
            let lineW = 0;
            for (let ti = 0; ti < end; ti++)
              if (!toks[ti]!.isBreak) lineW += toks[ti]!.width;
            const textLeft =
              para.align === "right"
                ? wrapRight - lineW
                : (lineLeft + wrapRight) / 2 - lineW / 2;
            bulletX = textLeft - (lineLeft - firstLeft);
          }
          line.bullet = { x: bulletX, baselineDy: 0, b: bullet };
        }
        line.advance = lineAdvance(line, para);
        // Baseline-aligned text sits at three quarters of a
        // custom line advance. At single or compressed proportional spacing,
        // retain the full line box whenever it is taller than that baseline
        // plus the font's descent. Unlike CSS, leading is not split in half.
        const proportional = para.lineSpacing?.kind !== "pts";
        const natural = ascent + descent + lineGap;
        line.baselineOffset =
          proportional && line.advance <= natural
            ? Math.max(0.75 * line.advance, line.advance - descent)
            : 0.75 * line.advance;
        line.extent = line.baselineOffset + descent;
        cursorY += line.advance;
        lines.push(line);
      }
      if (para.spcAftPct !== undefined) {
        const last = lines.at(-1)!;
        spacing.afterPx =
          para.spcAftPct * (last.ascent + last.descent + last.lineGap);
      }
      if (input.includeOuterSpacing || paraIndex < input.paragraphs.length - 1)
        cursorY += spacing.afterPx;
    }
    const last = lines.at(-1);
    return {
      lines,
      blockH:
        last && !input.includeOuterSpacing
          ? cursorY - last.advance + last.extent
          : cursorY,
    };
  };

  const vert = input.vert ?? "none";
  const cx = input.boxXpx + input.boxWpx / 2;
  const cy = input.boxYpx + input.boxHpx / 2;
  // Vertical text lays out horizontally into a frame whose extents are swapped
  // and re-centred on the box, so a single rotate(±90) about the box centre
  // maps that horizontal layout exactly onto the shape. All wrap / anchor /
  // align math then stays identical to horizontal — only the wrapping transform
  // differs, which is what keeps the calibrated horizontal path byte-stable.
  // `upright` keeps the box as-is (no extent swap): the glyphs are already
  // pre-split one per line by render-slide, so they stack within the real box.
  const frame: Frame =
    vert === "none" || vert === "upright"
      ? { x: input.boxXpx, y: input.boxYpx, w: input.boxWpx, h: input.boxHpx }
      : {
          x: cx - input.boxHpx / 2,
          y: cy - input.boxWpx / 2,
          w: input.boxHpx,
          h: input.boxWpx,
        };

  // Columns apply to horizontal text only — a faithful rotated-column layout is
  // disproportionate and native reference support for vert + numCol is
  // minimal, so we keep the rotation and drop numCol rather than emit a wrong
  // combined layout.
  const columns = vert === "none" ? (input.columns ?? null) : null;

  const { placements, requiredH } =
    columns && columns.count >= 2
      ? placeColumns(
          frame,
          columns,
          input.anchor,
          buildLines,
          !!input.includeOuterSpacing,
        )
      : placeSingle(frame, input.anchor, buildLines);

  let automaticWraps = 0;
  let unbreakableOverflowW = 0;
  for (const { line } of placements) {
    if (line.automaticStart) automaticWraps++;
    unbreakableOverflowW = Math.max(
      unbreakableOverflowW,
      line.unbreakableOverflowW,
    );
  }
  return {
    placements,
    paragraphSpacing,
    requiredH,
    automaticWraps,
    unbreakableOverflowW,
    vert,
    cx,
    cy,
  };
};

export const layoutTextSvg = (
  input: TextBodyInput,
  measure: TextMeasurer,
): string => {
  const { placements, vert, cx, cy } = layoutCore(input, measure);
  const visible = input.visibleParagraphs;
  const body = emitPlacements(
    visible
      ? placements.filter((p) => visible.has(p.line.paraIndex))
      : placements,
  );
  if (vert === "none" || vert === "upright") return body;
  const deg = vert === "cw90" ? 90 : 270;
  return `<g transform="rotate(${deg} ${fmt(cx)} ${fmt(cy)})">${body}</g>`;
};

/** Content height (px) the body would occupy at the given input's font sizes —
 *  for a single column the block height, for multi-column the tallest filled
 *  column. The SVG normAutofit path uses this to pick a shrink scale. */
export const measureTextBodyHeight = (
  input: TextBodyInput,
  measure: TextMeasurer,
): number => layoutCore(input, measure).requiredH;

// Anchor the measured text block, independently of its baseline placement.
const anchorOffsetY = (
  frameY: number,
  frameH: number,
  blockH: number,
  anchor: "top" | "center" | "bottom",
): number => {
  let offsetY = frameY;
  if (anchor === "center") offsetY = frameY + (frameH - blockH) / 2;
  else if (anchor === "bottom") offsetY = frameY + (frameH - blockH);
  return offsetY;
};

const placeSingle = (
  frame: Frame,
  anchor: "top" | "center" | "bottom",
  buildLines: LineBuilder,
): { placements: Placement[]; requiredH: number } => {
  const { lines, blockH } = buildLines(frame.x, frame.x + frame.w);
  const offsetY = anchorOffsetY(frame.y, frame.h, blockH, anchor);
  return {
    placements: lines.map((line) => ({
      line,
      baselineY: offsetY + line.topY + line.baselineOffset,
      dx: 0,
    })),
    requiredH: blockH,
  };
};

const placeColumns = (
  frame: Frame,
  columns: ColumnLayout,
  anchor: "top" | "center" | "bottom",
  buildLines: LineBuilder,
  includeOuterSpacing: boolean,
): { placements: Placement[]; requiredH: number } => {
  const gap = columns.gapPx;
  const colW = Math.max(
    1,
    (frame.w - (columns.count - 1) * gap) / columns.count,
  );
  const { lines, blockH } = buildLines(frame.x, frame.x + colW);
  const last = lines.at(-1);
  const trailingMargin =
    last && includeOuterSpacing ? blockH - last.topY - last.advance : 0;
  const finalExtent = (line: Line): number =>
    (includeOuterSpacing ? line.advance : line.extent) +
    (line === last ? trailingMargin : 0);
  // Sequential fill (not CSS column-fill:balance): fill
  // column 1 down to the box height, then column 2, and so on; once every
  // column in a row is full (autofit "none" doesn't stop the text, it just
  // stops growing the box), start a new row of columns directly below it,
  // like a second copy of the box stacked underneath the first — exactly what
  // `21-showcase`/`23-columns`'s ground truth shows. A column only breaks
  // once it already holds a line, so a single over-tall line can't loop.
  let col = 0;
  let colStartTopY = 0;
  let rowTopY = 0;
  let curColHasLine = false;
  let tallest = 0;
  const placed: { line: Line; localTopY: number; col: number }[] = [];
  for (const line of lines) {
    // Test the candidate final line using the same trailing-spacing rule
    // as a single-column body. Its full advance still separates earlier lines.
    const localInkBottom = line.topY - colStartTopY + finalExtent(line);
    if (localInkBottom > frame.h && curColHasLine) {
      if (col + 1 < columns.count) {
        col += 1;
      } else {
        col = 0;
        rowTopY += frame.h;
      }
      colStartTopY = line.topY;
      curColHasLine = false;
    }
    const localTopY = rowTopY + (line.topY - colStartTopY);
    placed.push({ line, localTopY, col });
    curColHasLine = true;
    tallest = Math.max(tallest, localTopY + finalExtent(line));
  }
  // Vertical anchor applies to the whole body via its tallest column block —
  // with sequential fill the filled columns reach the box height, so this
  // anchors the body as one unit.
  const offsetY = anchorOffsetY(frame.y, frame.h, tallest, anchor);
  return {
    placements: placed.map(({ line, localTopY, col: c }) => ({
      line,
      baselineY: offsetY + localTopY + line.baselineOffset,
      dx: c * (colW + gap),
    })),
    requiredH: tallest,
  };
};

const emitPlacements = (placements: Placement[]): string => {
  const parts: string[] = [];
  for (const { line, baselineY, dx } of placements) {
    if (line.bullet) {
      const b = line.bullet.b;
      if (b.imageHref) {
        // Sit the square bullet on the text baseline (bottom edge at the
        // baseline), matching where the glyph's ink would land.
        parts.push(
          `<image x="${fmt(line.bullet.x + dx)}" y="${fmt(baselineY - b.sizePx)}" width="${fmt(b.sizePx)}" height="${fmt(b.sizePx)}" href="${b.imageHref}" xlink:href="${b.imageHref}" preserveAspectRatio="xMidYMid meet"/>`,
        );
      } else {
        parts.push(
          `<text x="${fmt(line.bullet.x + dx)}" y="${fmt(baselineY)}" font-family="${escapeXml(b.family)}" font-size="${fmt(b.sizePx)}" fill="${b.fillHex}"${b.fillOpacity !== undefined && b.fillOpacity !== 1 ? ` fill-opacity="${b.fillOpacity}"` : ""} xml:space="preserve">${escapeXml(b.text)}</text>`,
        );
      }
    }
    parts.push(emitLine(line, baselineY, dx));
  }
  return parts.join("");
};

const lineAdvance = (line: Line, para: ParaInput): number => {
  // Metrics have already been normalized for compatible spacing when enabled.
  // Proportional spacing scales that natural height; exact spacing replaces it.
  const natural = line.ascent + line.descent + line.lineGap;
  // DrawingML normAutofit subtracts percentage points from proportional line
  // spacing. Exact point spacing is independent of both autofit factors.
  if (para.lineSpacing?.kind === "pts") return para.lineSpacing.px;
  const ratio = para.lineSpacing?.value ?? 1;
  return Math.max(0, ratio - para.lineSpacingReduction) * natural;
};

const emitLine = (line: Line, baselineY: number, dx: number): string => {
  const toks = [...line.tokens];
  while (
    toks.length > 0 &&
    (toks[toks.length - 1]!.isSpace || toks[toks.length - 1]!.isBreak)
  ) {
    toks.pop();
  }
  const content = toks.filter((t) => !t.isBreak);
  if (content.length === 0) return "";
  const groups = groupTokens(content);
  let pendingDx = 0;
  const tspans = groups
    .map((g) => {
      if (g.text === "\t" || /^\t+$/.test(g.text)) {
        pendingDx += g.width;
        return "";
      }
      const out = tspan(g, pendingDx);
      pendingDx = 0;
      return out;
    })
    .join("");
  if (tspans === "") return "";
  const x0 = line.anchorX + dx;
  const text = `<text x="${fmt(x0)}" y="${fmt(baselineY)}" text-anchor="${line.textAnchor}" xml:space="preserve">${tspans}</text>`;
  return (
    text +
    emitWavyUnderlines(groups, line.textAnchor, x0, baselineY) +
    emitDrawnDecorations(groups, line.textAnchor, x0, baselineY)
  );
};

const explicitUnderline = (p: PieceInput): boolean =>
  p.underline === "single" && (!!p.underlineHex || !!p.underlineDouble);

// Colored and double underlines and double strikethroughs have no SVG
// decoration of their own; they are drawn as lines under or through the run.
const emitDrawnDecorations = (
  groups: readonly Group[],
  textAnchor: "start" | "middle" | "end",
  x0: number,
  baselineY: number,
): string => {
  if (!groups.some((g) => explicitUnderline(g.piece) || g.piece.strikeDouble))
    return "";
  const total = groups.reduce((sum, g) => sum + g.width, 0);
  let cursor =
    textAnchor === "middle"
      ? x0 - total / 2
      : textAnchor === "end"
        ? x0 - total
        : x0;
  const parts: string[] = [];
  for (const g of groups) {
    const p = g.piece;
    if (g.width > 0 && !/^\t+$/.test(g.text)) {
      const size = renderedSizePxOf(p);
      const y0 = baselineY - baselineShiftPxOf(p);
      const width = Math.max(0.6, size * 0.055);
      const line = (y: number, color: string) =>
        `<path d="M${fmt(cursor)} ${fmt(y)}H${fmt(cursor + g.width)}" stroke="${color}" stroke-width="${fmt(width)}" fill="none"/>`;
      if (explicitUnderline(p)) {
        const color = p.underlineHex ?? p.fillHex;
        const y = y0 + size * 0.11;
        parts.push(line(y, color));
        if (p.underlineDouble) parts.push(line(y + width * 2.2, color));
      }
      if (p.strike && p.strikeDouble) {
        const y = y0 - size * 0.28;
        parts.push(line(y - width * 1.2, p.fillHex));
        parts.push(line(y + width * 1.2, p.fillHex));
      }
    }
    cursor += g.width;
  }
  return parts.join("");
};

interface Group {
  text: string;
  piece: PieceInput;
  width: number;
}

const groupTokens = (toks: Token[]): Group[] => {
  const groups: Group[] = [];
  for (const t of toks) {
    if (t.isBreak) continue;
    const last = groups[groups.length - 1];
    const tab = t.text === "\t";
    if (
      last &&
      samePiece(last.piece, t.piece) &&
      !tab &&
      !/^\t+$/.test(last.text)
    ) {
      last.text += t.text;
      last.width += t.width;
    } else {
      groups.push({ text: t.text, piece: t.piece, width: t.width });
    }
  }
  return groups;
};

// SVG baseline-shift sign convention: positive shifts the glyph UP (smaller
// y), so superscript is positive and subscript is negative — tspan() below
// applies this to the native text-decoration underline, and wavyPath reuses
// it (as a y offset in the opposite direction) so a wavy-underlined
// super/subscript run draws under the shifted glyphs, not the line's plain
// baseline.
const SUPERSCRIPT_SHIFT_RATIO = 0.33;
const SUBSCRIPT_SHIFT_RATIO = 0.16;
const baselineShiftPxOf = (p: PieceInput): number =>
  p.superSub === 1
    ? p.sizePx * SUPERSCRIPT_SHIFT_RATIO
    : p.superSub === -1
      ? -p.sizePx * SUBSCRIPT_SHIFT_RATIO
      : 0;

// A super/subscript run's glyphs render at this fraction of its authored
// size (see tspan()) — wavyPath reuses it so a wavy-underlined super/
// subscript run's wave is sized to the glyphs actually drawn, not the
// pre-shrink font size.
const SUPER_SUB_SIZE_RATIO = 0.65;
const renderedSizePxOf = (p: PieceInput): number =>
  p.superSub !== 0 ? p.sizePx * SUPER_SUB_SIZE_RATIO : p.sizePx;

// resvg has no `text-decoration-style: wavy` support (nor does core SVG
// define one), so a wavy underline is drawn as an explicit path under its
// run(s) instead of relying on `tspan`'s CSS decoration. `x0` is the same
// anchor point the caller's `<text>` element uses; since SVG resolves
// text-anchor by centering/right-aligning the whole flowed text around it,
// each group's actual start is `x0` shifted by the anchor's fraction of the
// total width, then offset by the widths of the groups before it.
const emitWavyUnderlines = (
  groups: readonly Group[],
  textAnchor: "start" | "middle" | "end",
  x0: number,
  baselineY: number,
): string => {
  if (!groups.some((g) => g.piece.underline === "wavy")) return "";
  const totalWidth = groups.reduce((sum, g) => sum + g.width, 0);
  const lineStartX =
    textAnchor === "middle"
      ? x0 - totalWidth / 2
      : textAnchor === "end"
        ? x0 - totalWidth
        : x0;
  let cursor = lineStartX;
  const parts: string[] = [];
  for (const g of groups) {
    if (g.piece.underline === "wavy" && g.width > 0) {
      // Subtract the baseline-shift (positive = up = smaller y) so a wavy
      // super/subscript run's wave tracks its raised/lowered glyphs.
      const y = baselineY - baselineShiftPxOf(g.piece);
      parts.push(wavyPath(cursor, cursor + g.width, y, g.piece));
    }
    cursor += g.width;
  }
  return parts.join("");
};

// Calibrated purely for legibility at typical body-text sizes (no ground-truth
// wavy-underline spec to match — OOXML doesn't define the wave's geometry,
// only that it must render as one): amplitude and period scale with the
// run's font size, the wave sits a little below the baseline like a real
// underline, and the floors keep very small text from collapsing the wave
// into an illegible flat line.
const WAVY_AMPLITUDE_RATIO = 0.045;
const WAVY_AMPLITUDE_MIN_PX = 0.6;
const WAVY_PERIOD_RATIO = 0.18;
const WAVY_PERIOD_MIN_PX = 2;
const WAVY_BASELINE_OFFSET_RATIO = 0.12;
const WAVY_STROKE_WIDTH_RATIO = 0.06;
const WAVY_STROKE_WIDTH_MIN_PX = 0.6;

const wavyPath = (
  x1: number,
  x2: number,
  baselineY: number,
  piece: PieceInput,
): string => {
  const size = renderedSizePxOf(piece);
  const amp = Math.max(WAVY_AMPLITUDE_MIN_PX, size * WAVY_AMPLITUDE_RATIO);
  const period = Math.max(WAVY_PERIOD_MIN_PX, size * WAVY_PERIOD_RATIO);
  const y = baselineY + size * WAVY_BASELINE_OFFSET_RATIO;
  let d = `M${fmt(x1)} ${fmt(y)}`;
  let cx = x1;
  let up = true;
  while (cx < x2 - 0.01) {
    const half = Math.min(period / 2, x2 - cx);
    const midX = cx + half;
    d += ` Q${fmt(cx + half / 2)} ${fmt(y + (up ? -amp : amp))} ${fmt(midX)} ${fmt(y)}`;
    cx = midX;
    up = !up;
  }
  const strokeWidth = Math.max(
    WAVY_STROKE_WIDTH_MIN_PX,
    size * WAVY_STROKE_WIDTH_RATIO,
  );
  return `<path d="${d}" stroke="${piece.fillHex}"${piece.fillOpacity !== undefined && piece.fillOpacity !== 1 ? ` stroke-opacity="${piece.fillOpacity}"` : ""} stroke-width="${fmt(strokeWidth)}" fill="none"/>`;
};

const samePiece = (a: PieceInput, b: PieceInput): boolean =>
  a.family === b.family &&
  a.sizePx === b.sizePx &&
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.letterSpacingPx === b.letterSpacingPx &&
  a.kerning === b.kerning &&
  a.fillHex === b.fillHex &&
  (a.fillOpacity ?? 1) === (b.fillOpacity ?? 1) &&
  a.underline === b.underline &&
  a.strike === b.strike &&
  a.underlineHex === b.underlineHex &&
  a.underlineDouble === b.underlineDouble &&
  a.strikeDouble === b.strikeDouble &&
  a.strokeHex === b.strokeHex &&
  a.strokeWidthPx === b.strokeWidthPx &&
  a.strokeOpacity === b.strokeOpacity &&
  a.superSub === b.superSub &&
  a.href === b.href;

const tspan = (g: Group, dx = 0): string => {
  const p = g.piece;
  const sizePx = renderedSizePxOf(p);
  const attrs: string[] = [
    ...(dx ? [`dx="${fmt(dx)}"`] : []),
    `font-family="${escapeXml(p.family)}"`,
    `font-size="${fmt(sizePx)}"`,
    ...(p.kerning ? [`style="font-kerning:${p.kerning}"`] : []),
    `fill="${p.fillHex}"`,
  ];
  if (p.bold) attrs.push('font-weight="700"');
  if (p.fillOpacity !== undefined && p.fillOpacity !== 1)
    attrs.push(`fill-opacity="${p.fillOpacity}"`);
  if (p.italic) attrs.push('font-style="italic"');
  const deco: string[] = [];
  // 'wavy' is drawn as an explicit path by emitWavyUnderlines — resvg has no
  // text-decoration-style support to lean on here.
  if (p.underline === "single" && !explicitUnderline(p)) deco.push("underline");
  if (p.strike && !p.strikeDouble) deco.push("line-through");
  if (p.strokeHex && (p.strokeWidthPx ?? 0) > 0) {
    attrs.push(
      `stroke="${p.strokeHex}"`,
      `stroke-width="${fmt(p.strokeWidthPx!)}"`,
      'stroke-linejoin="round"',
    );
    if (p.strokeOpacity !== undefined && p.strokeOpacity !== 1)
      attrs.push(`stroke-opacity="${p.strokeOpacity}"`);
  }
  if (deco.length) attrs.push(`text-decoration="${deco.join(" ")}"`);
  if (p.letterSpacingPx !== 0)
    attrs.push(`letter-spacing="${fmt(p.letterSpacingPx)}"`);
  if (p.superSub !== 0)
    attrs.push(`baseline-shift="${fmt(baselineShiftPxOf(p))}"`);
  return `<tspan ${attrs.join(" ")}>${escapeXml(g.text)}</tspan>`;
};

// ---------------------------------------------------------------------------
// Greedy first-fit line breaking. An oversized word first moves to a fresh
// line, then splits into graphemes. Retaining its full width on the initial
// character prevents a fragment from filling the preceding line's spare space.

/**
 * Index the same contiguous spans that SVG emits. A range needs at most two
 * partial-span measurements; complete middle spans use prefix sums. Offsets
 * refer to UTF-16 source text, while legal breaks remain grapheme-aware tokens.
 */
const tokenRanges = (
  tokens: readonly Token[],
  width: (text: string, piece: PieceInput) => number,
) => {
  const spans: {
    start: number;
    end: number;
    text: string;
    piece: PieceInput;
  }[] = [];
  const owners: number[] = [],
    offsets: number[] = [],
    totals = [0];
  for (let start = 0; start < tokens.length;) {
    const piece = tokens[start]!.piece,
      fragments: string[] = [];
    let end = start,
      offset = 0;
    while (
      end < tokens.length &&
      (end === start ||
        (!tokens[end]!.isBreak &&
          !tokens[start]!.isBreak &&
          samePiece(piece, tokens[end]!.piece)))
    ) {
      owners[end] = spans.length;
      offsets[end] = offset;
      fragments.push(tokens[end]!.text);
      offset += tokens[end]!.text.length;
      end++;
    }
    const text = fragments.join("");
    spans.push({ start, end, text, piece });
    totals.push(
      totals.at(-1)! + (tokens[start]!.isBreak ? 0 : width(text, piece)),
    );
    start = end;
  }
  const partial = (start: number, end: number) => {
    const span = spans[owners[start]!]!;
    return width(
      span.text.slice(
        offsets[start]!,
        offsets[end - 1]! + tokens[end - 1]!.text.length,
      ),
      span.piece,
    );
  };
  const measure = (start: number, end: number): number => {
    if (start === end) return 0;
    const first = owners[start]!,
      last = owners[end - 1]!;
    return first === last
      ? partial(start, end)
      : partial(start, spans[first]!.end) +
          totals[last]! -
          totals[first + 1]! +
          partial(spans[last]!.start, end);
  };
  const shaped = (start: number, end: number) => {
    const result = tokens.slice(start, end).map((token) => ({ ...token }));
    for (let index = start; index < end;) {
      const next = Math.min(end, spans[owners[index]!]!.end);
      let isolated = 0;
      for (let i = index; i < next; i++) isolated += tokens[i]!.width;
      const last = result[next - start - 1]!,
        difference = partial(index, next) - isolated;
      if (difference !== 0) {
        // Preserve the isolated break-unit ruler used to report word overflow.
        if (
          !last.isSpace &&
          !last.wordContinuation &&
          last.wordWidth === undefined
        )
          Object.assign(last, { wordWidth: last.width });
        last.width += difference;
      }
      index = next;
    }
    return result;
  };
  return { measure, shaped };
};

const wrapTokens = (
  tokens: Token[],
  wrap: boolean,
  firstAvail: number,
  avail: number,
  width: (text: string, piece: PieceInput) => number,
): { tokens: Token[]; automaticStart: boolean }[] => {
  const lines: { tokens: Token[]; automaticStart: boolean }[] = [];
  const ranges = tokenRanges(tokens, width);
  let segment = 0;
  for (let stop = 0; stop <= tokens.length; stop++) {
    if (stop < tokens.length && !tokens[stop]!.isBreak) continue;
    const units: {
      start: number;
      end: number;
      fitWidth: number;
      barrier: boolean;
    }[] = [];
    for (let i = segment; i < stop;) {
      if (tokens[i]!.isSpace) {
        i++;
        continue;
      }
      const start = i++;
      while (i < stop && tokens[i]!.wordContinuation) i++;
      const isolated = ranges.measure(start, i),
        fitWidth = tokens[start]!.wordWidth ?? isolated;
      units.push({ start, end: i, fitWidth, barrier: fitWidth > isolated });
    }
    if (!units.length) {
      if (stop < tokens.length)
        lines.push({ tokens: [tokens[stop]!], automaticStart: false });
      else if (tokens.at(-1)?.isBreak)
        lines.push({ tokens: [], automaticStart: false });
      segment = stop + 1;
      continue;
    }
    const nextBarrier: number[] = [];
    let barrier = units.length;
    for (let i = units.length - 1; i >= 0; i--) {
      nextBarrier[i] = barrier;
      if (units[i]!.barrier) barrier = i;
    }
    for (let first = 0; first < units.length;) {
      const start = first === 0 ? segment : units[first]!.start;
      const limit = lines.length === 0 ? firstAvail : avail;
      let accepted = first;
      if (!wrap) accepted = units.length - 1;
      else if (ranges.measure(start, units[first]!.end) > limit + 0.5) {
        // Leading spaces and a single oversized unit are retained. Zero-width
        // units cannot force another wrap on an already overfull line.
        while (
          accepted + 1 < units.length &&
          units[accepted + 1]!.fitWidth <= 0
        )
          accepted++;
      } else {
        const fits = (last: number) => {
          // A pre-split oversized word moves to a fresh line as a whole before
          // emergency graphemes may fill it. Do not lose that original ruler.
          for (let i = nextBarrier[first]!; i <= last; i = nextBarrier[i]!) {
            const unit = units[i]!;
            if (
              ranges.measure(start, units[i - 1]!.end) > 0 &&
              ranges.measure(start, unit.start) + unit.fitWidth > limit + 0.5
            )
              return false;
          }
          return ranges.measure(start, units[last]!.end) <= limit + 0.5;
        };
        // Exponential bracketing followed by binary refinement measures shaped
        // ranges, rather than every growing prefix. Long lines cost O(n log n)
        // measured characters instead of O(n²); fragmented spans stay indexed.
        let step = 1,
          rejected = units.length;
        while (accepted + step < units.length) {
          const trial = accepted + step;
          if (!fits(trial)) {
            rejected = trial;
            break;
          }
          accepted = trial;
          step *= 2;
        }
        while (rejected - accepted > 1) {
          const trial = accepted + Math.floor((rejected - accepted) / 2);
          if (fits(trial)) accepted = trial;
          else rejected = trial;
        }
      }
      lines.push({
        tokens: ranges.shaped(start, units[accepted]!.end),
        automaticStart: first !== 0,
      });
      first = accepted + 1;
    }
    segment = stop + 1;
  }
  return lines;
};
