import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
// The custom properties each theme block sets.
function theme(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, selector);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*#([\da-f]{6}|[\da-f]{3})\b/gi)].map(
      (m) => [
        m[1],
        `#${m[2].length === 3 ? [...m[2]].map((c) => c + c).join("") : m[2]}`,
      ],
    ),
  );
}
function luminance(hex) {
  return hex
    .match(/[\da-f]{2}/gi)
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, n) => sum + v * [0.2126, 0.7152, 0.0722][n], 0);
}
function contrast(a, b) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("placeholder hints use the muted text color, readable on every field background", () => {
  // Browsers' default placeholder grey (#757575 in Chrome) is under 4.5:1 on
  // the page and panel backgrounds, so the app sets its own.
  const rule = css.match(/(?:^|\n)::placeholder\s*\{([^}]*)\}/);
  assert.ok(rule, "A global ::placeholder rule exists");
  assert.match(rule[1], /color:\s*var\(--muted\)/);
  assert.match(rule[1], /opacity:\s*1\b/, "Firefox's dimming is undone");
  const light = theme(":root"),
    dark = { ...light, ...theme(':root[data-theme="dark"]') };
  for (const [name, colors] of [
    ["light", light],
    ["dark", dark],
  ])
    for (const background of ["--bg", "--surface", "--sidebar", "--canvas"])
      assert.ok(
        contrast(colors["--muted"], colors[background]) >= 4.5,
        `${name} ${background}: ${contrast(colors["--muted"], colors[background])}`,
      );
});

test("the frame in view keeps its number and object count readable on its tint", () => {
  // The muted text on the current row's --soft tint was 4.41:1 in the
  // light theme.
  const at = css.indexOf(
    ".frame-row:has(.frame-go[aria-current]) :is(.frame-go > span, .frame-go small) {",
  );
  assert.ok(at >= 0);
  assert.match(
    css.slice(at, css.indexOf("}", at)),
    /color:\s*color-mix\(in srgb, var\(--muted\) 80%, var\(--text\)\)/,
  );
  // color-mix in srgb mixes the encoded channels.
  const mix = (a, b, share) =>
    "#" +
    [0, 2, 4]
      .map((n) =>
        Math.round(
          parseInt(a.slice(1 + n, 3 + n), 16) * share +
            parseInt(b.slice(1 + n, 3 + n), 16) * (1 - share),
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  const light = theme(":root"),
    dark = { ...light, ...theme(':root[data-theme="dark"]') };
  for (const [name, colors] of [
    ["light", light],
    ["dark", dark],
  ]) {
    const ratio = contrast(
      mix(colors["--muted"], colors["--text"], 0.8),
      colors["--soft"],
    );
    assert.ok(ratio >= 4.5, `${name}: ${ratio}`);
  }
});
