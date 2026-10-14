// The Format pane's detailed sections — fill, line, effects, 3-D, size and
// properties, text box, alt text and text options — and the effect presets,
// checked by what they write to the downloaded file.
import { test, expect } from "@playwright/test";
import {
  P,
  addShape,
  addTextBox,
  command,
  download,
  formatPane,
  section,
  start,
  tab,
} from "./format-helpers.js";

test.setTimeout(120_000);

async function setNumber(scope, label, value) {
  const input = scope
    .getByLabel(label, { exact: true })
    .filter({ visible: true })
    .last();
  await input.fill(String(value));
  await input.press("Tab");
}

test("fill types: gradient with stops, pattern, tiled texture and the slide background", async ({
  page,
}) => {
  await start(page);
  await addShape(page, "Rectangle");
  const pane = await formatPane(page);
  const fill = await section(pane, "fill");
  await fill.getByRole("radio", { name: "Gradient" }).click();
  await expect(fill.getByLabel("Gradient type")).toBeVisible();
  await fill.getByLabel("Gradient type").selectOption("radial");
  await expect(fill.getByLabel("Gradient type")).toHaveValue("radial");
  await fill.getByRole("button", { name: "Add gradient stop" }).click();
  await expect(fill.locator(".fmt-gradient-stop")).toHaveCount(3);
  let { shapes, p } = await download(page);
  let g = P.getShapeGradientFill(shapes[0]);
  expect(g.path).toBe("circle");
  expect(g.stops).toHaveLength(3);

  await fill.getByRole("radio", { name: "Pattern" }).click();
  await fill.getByRole("radio", { name: "Pattern dkUpDiag" }).click();
  await expect(
    fill.getByRole("radio", { name: "Pattern dkUpDiag" }),
  ).toHaveAttribute("aria-checked", "true");
  ({ shapes, p } = await download(page));
  expect(P.getShapePatternFill(p, shapes[0]).preset).toBe("dkUpDiag");

  await fill.getByRole("radio", { name: "Picture or texture" }).click();
  await fill.getByLabel("Texture", { exact: true }).selectOption("linen");
  await expect(
    fill.getByRole("checkbox", { name: "Tile picture as texture" }),
  ).toBeChecked();
  await setNumber(fill, "Scale X", 50);
  ({ shapes } = await download(page));
  expect(P.getShapeImageFillMode(shapes[0])).toMatchObject({
    mode: "tile",
    scaleX: 0.5,
  });

  await fill.getByRole("radio", { name: "Slide background" }).click();
  await expect(
    fill.getByRole("radio", { name: "Slide background" }),
  ).toHaveAttribute("aria-checked", "true");
  const { slideXml } = await download(page);
  expect(slideXml()).toMatch(/<p:sp useBgFill="1"/);
});

test("line options: width, compound, dash, caps, joins, arrows and a gradient line", async ({
  page,
}) => {
  await start(page);
  await addShape(page, "Rectangle");
  const pane = await formatPane(page);
  const line = await section(pane, "line");
  await line.getByRole("radio", { name: "Solid" }).click();
  await expect(line.getByLabel("Compound type")).toBeVisible();
  await setNumber(line, "Line width", 6);
  await line.getByLabel("Compound type").selectOption("thickThin");
  await line.getByLabel("Dash type").selectOption("lgDashDot");
  await line.getByLabel("Cap type").selectOption("rnd");
  await line.getByLabel("Join type").selectOption("bevel");
  await line.getByLabel("End arrow type").selectOption("stealth");
  await line.getByLabel("End arrow size").selectOption("lg|lg");
  await expect(line.getByLabel("End arrow size")).toHaveValue("lg|lg");
  let { shapes } = await download(page);
  const s = shapes[0];
  expect(P.getShapeStrokeWidth(s)).toBe(76200);
  const f = P.getShapeStrokeFormattingEffective(s);
  expect(f).toMatchObject({
    compound: "thickThin",
    cap: "rnd",
    tail: { type: "stealth", width: "lg", length: "lg" },
  });
  expect(f.dash).toEqual({ kind: "preset", value: "lgDashDot" });
  await line.getByRole("radio", { name: "Gradient" }).click();
  await expect(line.getByLabel("Line gradient angle")).toBeVisible();
  const { slideXml } = await download(page);
  expect(slideXml()).toMatch(/<a:ln[^>]*w="76200"[^>]*>\s*<a:gradFill/);
});

test("effect presets from the ribbon, and shadow, glow, soft edge, bevel and 3-D settings in the pane", async ({
  page,
}) => {
  await start(page);
  await addShape(page, "Rectangle");
  await tab(page, "Shape Format");
  const pick = async (group, name) => {
    await (await command(page, "format-shape-effects")).click();
    await page.getByRole("menuitem", { name: group, exact: true }).click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };
  await pick("Shadow", "Inside: Bottom Right");
  await pick("Glow", "Glow: 8 pt, Accent 3");
  await pick("Reflection", "Half Reflection: Touching");
  await pick("Bevel", "Cool Slant");
  await pick("3-D Rotation", "Isometric: Left Down");
  let { shapes, p } = await download(page);
  let spec = P.getShapeEffectSpec(p, shapes[0]);
  expect(spec.shadow).toMatchObject({ type: "inner", angleDeg: 45 });
  expect(spec.glow.radiusEmu).toBe(8 * 12700);
  expect(spec.reflection.endPos).toBeCloseTo(0.55);
  let three = P.getShape3D(shapes[0]);
  expect(three).toMatchObject({
    present: true,
    camera: "isometricLeftDown",
    bevelTop: { preset: "coolSlant" },
  });

  const pane = await formatPane(page);
  const shadow = await section(pane, "shadow");
  await shadow.getByRole("radio", { name: "Outside" }).click();
  await expect(shadow.getByRole("radio", { name: "Outside" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await setNumber(shadow, "Shadow distance", 10);
  const soft = await section(pane, "softEdges");
  await soft.getByLabel("Soft edge presets").selectOption("10");
  const solid = await section(pane, "format3d");
  await setNumber(solid, "Depth size", 12);
  await solid.getByLabel("Material").selectOption("metal");
  await expect(solid.getByLabel("Material")).toHaveValue("metal");
  const rotation = await section(pane, "rotation3d");
  await setNumber(rotation, "Z rotation", 30);
  await expect(rotation.getByLabel("Z rotation", { exact: true })).toHaveValue(
    "30",
  );
  ({ shapes, p } = await download(page));
  spec = P.getShapeEffectSpec(p, shapes[0]);
  expect(spec.shadow).toMatchObject({ type: "outer", distEmu: 127000 });
  expect(spec.softEdge).toEqual({ radiusEmu: 127000 });
  three = P.getShape3D(shapes[0]);
  expect(three).toMatchObject({
    depthEmu: 152400,
    material: "metal",
    rotZ: 30,
  });
});

test("size and properties, the text box, alt text and text options", async ({
  page,
}) => {
  await start(page);
  await addTextBox(page);
  const pane = await formatPane(page);
  const size = await section(pane, "size");
  await size.getByRole("checkbox", { name: "Lock aspect ratio" }).check();
  await expect(
    size.getByRole("checkbox", { name: "Lock aspect ratio" }),
  ).toBeChecked();
  const box = await section(pane, "textBox");
  await box.getByRole("radio", { name: "Resize shape to fit text" }).click();
  await setNumber(box, "Left margin", 0.25);
  await box.getByRole("checkbox", { name: "Wrap text in shape" }).uncheck();
  await box.getByLabel("Text direction").selectOption("vert270");
  await expect(box.getByLabel("Text direction")).toHaveValue("vert270");
  const alt = await section(pane, "altText");
  await alt.getByLabel("Alt text description").fill("A greeting");
  await alt.getByLabel("Alt text description").press("Tab");
  const outline = await section(pane, "textOutline");
  await outline.getByRole("radio", { name: "Solid" }).click();
  await expect(outline.getByLabel("Text outline width")).toBeVisible();
  const fx = await section(pane, "textEffects");
  await fx.getByLabel("Text glow", { exact: true }).selectOption("8");
  await expect(fx.getByLabel("Text glow", { exact: true })).toHaveValue("8");
  const fillText = await section(pane, "textFill");
  await fillText.getByRole("radio", { name: "Gradient" }).click();
  await expect(fillText.getByLabel("Text gradient angle")).toBeVisible();
  const { shapes } = await download(page);
  const s = shapes[0];
  expect(P.getShapeAspectLock(s)).toBe(true);
  expect(P.getShapeTextAutoFit(s)).toBe("shape");
  expect(P.getShapeTextWrap(s)).toBe("none");
  expect(P.getShapeTextDirection(s)).toBe("vert270");
  expect(P.getShapeTextMargins(s).left).toBe(228600);
  expect(P.getShapeDescription(s)).toBe("A greeting");
  const fmt = P.getShapeRunFormat(s, 0, 0);
  expect(fmt.outline).toMatchObject({ widthEmu: 9525 });
  expect(fmt.effects.glow.radiusEmu).toBe(8 * 12700);
  expect(fmt.gradient.stops).toHaveLength(2);
});
