import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
// The declarations of the first rule whose selector list contains `selector`.
function rule(selector, from = 0) {
  const at = css.indexOf(selector, from);
  assert.ok(at >= 0, `${selector} has a rule`);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

test("phone rules for the old inline language and theme selects are gone", () => {
  // They out-specified the Preferences popover's own rules, shrinking its
  // selects to 69px of 11px type and hiding the appearance icon.
  assert.equal(css.includes(".editor-actions .language-control"), false);
  assert.equal(css.includes(".editor-actions .theme-control"), false);
  assert.equal(css.includes("max-width: 69px"), false);
  // The phone-width shrink of the language select applies to the sidebar's
  // picker only, not to the popover's.
  assert.equal(/\n  \.language-control select \{/.test(css), false);
  assert.equal(/\n  \.theme-control select,/.test(css), false);
  assert.ok(css.includes(".sidebar-bottom .language-control select {"));
});

test("the Preferences popover hangs from the left on narrow screens", () => {
  const at = css.indexOf(
    "@media (max-width: 760px)",
    css.indexOf(".preferences-menu select:hover"),
  );
  assert.ok(at >= 0);
  const menu = rule(".preferences-menu", at);
  assert.match(menu, /left:\s*0/);
  assert.match(menu, /right:\s*auto/);
});

test("the keyboard's place in the context menu and the mention list shows as a ring, not only a tint", () => {
  const menu = rule(".context-menu .menu-item:focus-visible {");
  assert.doesNotMatch(menu, /outline:\s*none/);
  assert.match(menu, /outline:\s*2px solid var\(--accent\)/);
  const org = readFileSync(
    new URL("../src/organization/organization.css", import.meta.url),
    "utf8",
  );
  const at = org.indexOf('.mention-list li[aria-selected="true"] {');
  assert.ok(at >= 0);
  assert.match(
    org.slice(at, org.indexOf("}", at)),
    /outline:\s*2px solid var\(--accent\)/,
  );
});

test("a hidden notification is invisible to the keyboard, not only to the eye", () => {
  assert.match(rule("#toast {"), /visibility:\s*hidden/);
  assert.match(rule("#toast.visible {"), /visibility:\s*visible/);
});

test("hover tints apply only where hovering exists", () => {
  for (const selector of ["button:hover {", ".swatch:hover {"]) {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `${selector} has a rule`);
    const media = css.lastIndexOf("@media (hover: hover)", at);
    assert.ok(media >= 0, `${selector} is inside @media (hover: hover)`);
    // No rule closes between the media query's opening and the selector.
    assert.equal(css.slice(media, at).split("}").length, 1);
  }
});

test("the library header stays in view while the boards scroll", () => {
  // Like the editor header, the library header keeps the breadcrumb, the
  // command, join, help and account controls reachable from any scroll
  // position instead of scrolling away with the first card row.
  const top = rule(".library-top {");
  assert.match(top, /position:\s*sticky/);
  assert.match(top, /top:\s*0/);
  assert.match(top, /background:\s*var\(--bg\)/);
  assert.match(top, /z-index:\s*\d+/);
  // The header spans the page so no card scrolls past it in the gutters.
  assert.doesNotMatch(top, /margin:\s*0 46px/);
  assert.match(top, /padding:\s*0 46px/);
  for (const narrow of [
    "@media (max-width: 1100px)",
    "@media (max-width: 760px)",
    "@media (max-width: 460px)",
  ]) {
    const at = css.indexOf(narrow);
    const r = rule(".library-top {", at);
    assert.doesNotMatch(r, /margin:\s*0 \d+px/, `${narrow} uses padding`);
    assert.match(r, /padding:\s*0 \d+px/, `${narrow} uses padding`);
  }
});

test("the page behind an open dialog does not scroll", () => {
  assert.match(rule("body:has(dialog[open]) {"), /overflow:\s*hidden/);
});

test("touch screens get 44px dialog close buttons and text links", () => {
  const at = css.indexOf("Touch screens get 44px targets");
  assert.ok(at >= 0);
  const close = rule(".dialog-header .icon-btn {", at);
  assert.match(close, /height:\s*44px/);
  assert.match(rule(".text-btn {", at), /min-height:\s*44px/);
});

test("a red confirmation button keeps a hover state instead of an !important fill", () => {
  assert.doesNotMatch(css, /\n\.danger-fill \{/);
  assert.doesNotMatch(rule("button.primary.danger-fill {"), /!important/);
  assert.match(rule("button.primary.danger-fill:hover {"), /background:/);
});

test("user content in a dialog wraps rather than widening it", () => {
  assert.match(
    rule("dialog [data-user-content] {"),
    /overflow-wrap:\s*anywhere/,
  );
});

test("rules for removed home markup are gone", () => {
  // The section heading holds a button, the sidebar bottom holds no nav
  // items, and a canvas never inherits a colour.
  assert.equal(css.includes(".section-heading > span"), false);
  assert.equal(css.includes(".sidebar-bottom > .nav-item"), false);
  assert.doesNotMatch(rule(".template-art {"), /color:/);
});

test("on phones the selection toolbar wraps its object actions instead of hiding them past the edge", () => {
  const selector =
    ".selection-row:not(.text-format-tools):not(.list-format-tools)";
  const at = css.indexOf(selector);
  assert.ok(at >= 0);
  // Inside the phone layout's media query, after the toolbar's own rules.
  const media = css.lastIndexOf("@media", at);
  assert.match(css.slice(media, css.indexOf("{", media)), /max-width: 760px/);
  assert.ok(media > css.indexOf(".selection-row {"));
  assert.match(rule(selector), /flex-wrap:\s*wrap/);
});

test("the board list drops columns in a narrower library instead of hiding names", () => {
  // Its fixed columns (450px with a 56px thumbnail and 104px of padding)
  // left board names 0px wide between 761 and 1000px and scrolled the page
  // sideways under 835px.
  assert.match(
    rule(".boards-section {", css.indexOf("drops its location")),
    /container-type:\s*inline-size/,
  );
  const wide = css.indexOf("@container (max-width: 880px)");
  const narrow = css.indexOf("@container (max-width: 680px)");
  assert.ok(wide >= 0 && narrow > wide);
  assert.match(
    rule(".board-grid.is-list .board-info {", wide),
    /minmax\(0, 1fr\) 120px 150px;/,
  );
  assert.match(
    rule(".board-grid.is-list .board-info {", narrow),
    /minmax\(0, 1fr\) 120px;/,
  );
  // Header columns line up with the rows' columns.
  assert.match(
    rule(".board-list-head:has(+ .board-grid.is-list) {", wide),
    /56px minmax\(0, 1fr\) 120px 150px 70px/,
  );
  assert.match(
    rule(".board-list-head:has(+ .board-grid.is-list) {", narrow),
    /56px minmax\(0, 1fr\) 120px 70px/,
  );
  // Phones keep their own layout, which comes later.
  assert.ok(
    css.indexOf(
      "@media (max-width: 760px) {\n  .board-grid.is-list .board-info {",
    ) > narrow,
  );
});

test("the board list's column names show only above boards, not above an empty state", () => {
  // "Name, Objects, Last edited, Location" stood over "No boards found" and
  // "Trash is empty".
  assert.equal(
    css.includes(
      ".board-list-head:has(+ .board-grid.is-list) {\n  display: grid;",
    ),
    false,
  );
  assert.match(
    rule(".board-list-head:has(+ .board-grid.is-list > .board-card) {"),
    /display:\s*grid/,
  );
});

test("the templates heading keeps a gap before Browse all templates on phones", () => {
  // At 390px the heading ran into the button (1px apart in English, none
  // in French).
  assert.match(rule(".section-heading {"), /gap:\s*12px/);
  assert.match(rule(".section-heading .text-btn {"), /flex:\s*none/);
});

test("the minimap rises above the getting-started offer on wide screens", () => {
  // Beside an open side panel the minimap moves toward the middle, where the
  // offer floats 72px above the bottom.
  const at = css.lastIndexOf(
    "@media (min-width: 761px)",
    css.indexOf(".editor.chrome-stacked .canvas-top"),
  );
  assert.ok(at >= 0);
  const minimap = rule(".canvas-wrap:has(> .tour-offer) .minimap", at);
  const [, bottom] = minimap.match(/--minimap-bottom:\s*(\d+)px/) || [];
  assert.ok(Number(bottom) >= 124, `${bottom}px clears the offer`);
});

test("the facilitation panel's toolbar offset applies only to a docked toolbar", () => {
  // Its left offset out-specified the floating toolbar's left: 0, so the
  // toolbar placed from the script slid 88 or 130 px under the panel.
  const facilitation = readFileSync(
    new URL("../src/facilitation/facilitation.css", import.meta.url),
    "utf8",
  );
  const rules = facilitation.match(/[^{}]*\.selection-tools[^{}]*\{/g);
  assert.equal(rules.length, 2);
  for (const selector of rules)
    assert.match(selector, /\.selection-tools:not\(\.is-floating\)/);
});

test("Find on board scrolls on a short window and keeps a whole result in view", () => {
  // Above phone width the panel had a maximum height but no scrolling, so
  // at 1280 by 450 its last buttons ran out below it and the results list
  // shrank to nothing.
  const panel = rule(".board-search {");
  assert.match(panel, /overflow:\s*auto/);
  assert.match(rule(".search-results:not(:empty) {"), /min-height:\s*60px/);
});

test("a long save status ends in an ellipsis in the floating header instead of running under the actions", () => {
  // The floating header's status did not wrap and could not shrink, so
  // French statuses, or "Cannot reach the shared board · retrying · view
  // only", ran under the actions between 761 and about 1000 px.
  const state = rule("#save-state {", css.indexOf("#save-state {") + 1);
  assert.match(state, /white-space:\s*nowrap/);
  assert.match(state, /overflow:\s*hidden/);
  assert.match(state, /text-overflow:\s*ellipsis/);
  // The board name gives way first, down to its 64px, so a status that
  // fitted before is never cut short.
  assert.match(state, /flex-shrink:\s*0/);
  assert.match(state, /max-width:\s*calc\(100% - 74px\)/);
  assert.match(
    rule(
      ".editor-heading input {",
      css.lastIndexOf(".editor-heading input {", css.indexOf("field-sizing")),
    ),
    /min-width:\s*64px/,
  );
});

test("the selection's More options menu fits a phone screen and wraps long labels", () => {
  // Its items never wrapped, so at 320 px in French the menu was 350 px
  // wide and ran 42 px off the left edge.
  assert.match(rule(".selection-menu {"), /max-width:\s*calc\(100vw - 24px\)/);
  assert.match(rule(".selection-menu .menu-item {"), /white-space:\s*normal/);
});

test("Find on board's filters are drawn like the app's other selects, in both themes", () => {
  // They kept the browser's square, grey-edged select, with a #3b3b3b fill
  // in the dark theme.
  const select = rule(".search-filter select {");
  assert.match(select, /border:\s*1px solid var\(--field-line\)/);
  assert.match(select, /border-radius:\s*8px/);
  assert.match(select, /background:\s*var\(--surface\)/);
  assert.match(select, /color:\s*var\(--text\)/);
});

test("the task panel's toolbar offset applies only to a docked toolbar", () => {
  // Its left offset out-specified the floating toolbar's left: 0, so the
  // toolbar placed from the script slid 88 or 130 px under the panel.
  const planning = readFileSync(
    new URL("../src/planning/planning.css", import.meta.url),
    "utf8",
  );
  const rules = planning.match(/[^{}]*\.selection-tools[^{}]*\{/g);
  assert.equal(rules.length, 2);
  for (const selector of rules)
    assert.match(selector, /\.selection-tools:not\(\.is-floating\)/);
});

test("the board search keeps a usable width in a narrow library", () => {
  // It was a 258px flex item that shrank to 48px in French at 768px wide.
  assert.match(rule(".board-filters .search {"), /flex-shrink:\s*0/);
  const at = css.indexOf("@container (max-width: 680px)");
  assert.ok(at >= 0, "a narrow library has its own rules");
  assert.match(rule(".board-filters {", at), /flex-wrap:\s*wrap/);
  assert.match(rule(".board-filters .search {", at), /flex:\s*1 1 100%/);
  // On phones the sort follows the tools rather than taking a row of its own.
  const phone = css.indexOf("@media (max-width: 460px)");
  assert.doesNotMatch(
    rule(".sort {", css.indexOf(".board-filters {", phone)),
    /width:\s*100%/,
  );
});

test("the admin console puts its tabs in a row above the panel before its tables would scroll", () => {
  // Beside the 190px tab list, a 768px window left 482px for tables that
  // need about 700px.
  const org = readFileSync(
    new URL("../src/organization/organization.css", import.meta.url),
    "utf8",
  );
  const at = org.indexOf("@media (max-width: 980px) {");
  assert.ok(at >= 0);
  const block = org.slice(at, org.indexOf("\n}\n", at));
  assert.match(block, /\.admin-console \{\s*grid-template-columns: 1fr;/);
  assert.match(block, /\.admin-tabs \{\s*flex-direction: row;/);
});

test("a field marked invalid shows it, in both themes", () => {
  assert.match(
    rule('.field [aria-invalid="true"] {'),
    /border-color:\s*#ad514b/,
  );
  assert.match(
    rule(':root[data-theme="dark"] .field [aria-invalid="true"] {'),
    /border-color:\s*#ff8f86/,
  );
});

test("a long frame title takes at most two lines in Frames and navigation", () => {
  // Without a clamp, a title of a few hundred words made its row hundreds
  // of pixels tall.
  const title = rule(".frame-go strong {");
  assert.match(title, /-webkit-line-clamp:\s*2/);
  assert.match(title, /display:\s*-webkit-box/);
  assert.match(title, /overflow:\s*hidden/);
});

test("a choice's box keeps its size beside a label long enough to wrap", () => {
  assert.match(rule(".slide-choices input {"), /flex:\s*none/);
  const label = rule(".slide-choices label > span {");
  assert.match(label, /min-width:\s*0/);
  assert.match(label, /overflow-wrap:\s*anywhere/);
});

test("the chosen template category's count stays readable on its tint", () => {
  // Plain muted text on the 8% tint measured 4.44:1 in the light theme.
  assert.match(
    rule('#library-panel .library-chip[aria-pressed="true"] span {'),
    /color:\s*color-mix\(in srgb, var\(--muted\) 80%, var\(--text\)\)/,
  );
});

test("in forced colors, pressed and chosen controls show the system highlight and colour choices keep their colours", () => {
  const at = css.indexOf("@media (forced-colors: active) {");
  assert.ok(at >= 0);
  const block = css.slice(at, css.indexOf("\n}\n", at));
  for (const state of [
    '[aria-pressed="true"]',
    '[aria-checked="true"]',
    '[aria-current="page"]',
    '[role="tab"][aria-selected="true"]',
    '[role="option"][aria-selected="true"]',
  ])
    assert.ok(block.includes(state), state);
  assert.match(block, /:not\(\.swatch\)/);
  assert.match(block, /background-color:\s*Highlight !important/);
  assert.match(block, /color:\s*HighlightText !important/);
  assert.match(
    block,
    /\.swatch,\s*\.fill-chip\s*\{\s*forced-color-adjust:\s*none/,
  );
});

test("a narrow, very short window scrolls the editor instead of stacking the tool rail under the canvas tools", () => {
  const at = css.indexOf("@media (max-width: 460px) and (max-height: 359px) {");
  assert.ok(at >= 0);
  assert.match(rule(".editor {", at), /height:\s*360px/);
});

test("on phones the tool row stacks above vote badges, comment pins and reactions", () => {
  // The rail has no box there, so its own stacking never applied and a tap
  // on Pan could cast a vote on a note scrolled under it.
  const at = css.indexOf("so the tool\n     row stacks itself above");
  assert.ok(at >= 0);
  const tools = rule(".tools {", at);
  assert.match(tools, /z-index:\s*3/);
  assert.match(tools, /bottom:\s*77px/);
});
