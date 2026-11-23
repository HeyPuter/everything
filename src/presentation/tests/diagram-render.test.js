import { describe, expect, it } from "vitest";
import { P } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { renderedDiagramDeck as fixture } from "./diagram-render-fixture.js";

const render = (pres, mode = "svg") =>
  renderSlideToSvg(pres, P.getSlides(pres)[0], {
    textLayout: mode,
    stableDefinitionIds: true,
  });

describe("saved SmartArt rendering", () => {
  it("exposes the authored diagram description and click action while preserving child text", async () => {
    const { pres, frame } = await fixture();
    P.setShapeDescription(frame, "Workflow <overview> & decisions");
    P.setShapeClickAction(frame, {
      kind: "url",
      url: "https://example.org/workflow?a=1&b=2",
    });
    const svg = render(pres);
    expect(svg).toContain(
      'role="group" aria-label="Workflow &lt;overview&gt; &amp; decisions"',
    );
    expect(svg).toContain('href="https://example.org/workflow?a=1&amp;b=2"');
    expect(svg).toContain('data-pptx-shape-name="Diagram 0"');
    expect(svg).toContain("Rendered");
  });
  it("inherits omitted text transform position and size without inheriting shape rotation twice", async () => {
    const { pres, diagram } = await fixture({
      geometry: { x: 914400, y: 0, w: 1828800, h: 914400, rotation: 90 },
      textTransform: { rotation: -90 },
    });
    diagram.drawing.part.data = new TextEncoder().encode(
      new TextDecoder()
        .decode(diagram.drawing.part.data)
        .replace(
          /<dsp:txXfrm[^>]*>[\s\S]*?<\/dsp:txXfrm>/,
          '<dsp:txXfrm rot="-5400000"/>',
        ),
    );
    const svg = render(pres, "foreignObject");
    expect(svg).toContain(
      'transform="rotate(90 192.00 48.00) rotate(-90 192.00 48.00)"',
    );
    expect(svg).toContain(
      '<foreignObject x="96.00" y="0.00" width="192.00" height="96.00"',
    );
  });

  it("retains a nonempty text rectangle when the associated painted geometry has zero area", async () => {
    const { pres } = await fixture({
      geometry: { w: 0, h: 0 },
      textTransform: { w: 914400, h: 914400 },
    });
    const svg = render(pres, "foreignObject");
    expect(svg).toContain("Rendered 0");
    expect(svg).toContain(
      '<foreignObject x="0.00" y="0.00" width="96.00" height="96.00"',
    );
  });
  it.each(["svg", "foreignObject"])(
    "renders structured geometry and styled text in %s mode at the frame origin",
    async (mode) => {
      const { pres } = await fixture({
        geometry: { x: 190500, y: 95250, w: 1828800, h: 914400 },
      });
      const svg = render(pres, mode);
      expect(svg).toContain('data-pptx-diagram="saved-layout"');
      expect(svg).not.toContain('data-pptx-fallback="graphicFrame"');
      expect(svg).toContain("translate(96.00 192.00)");
      expect(svg).toContain('fill="#123456"');
      expect(svg).toContain("Rendered");
      expect(svg).toContain("#A12BCD");
      expect(svg).not.toContain("data-pptx-diagram-issues");
      // The saved shape remains 192x96, not scaled to the 576x384 frame.
      expect(svg).toContain(
        'x="20.00" y="10.00" width="192.00" height="96.00"',
      );
    },
  );

  it("lays out text in its saved rectangle without the painted preset's inscribing rectangle", async () => {
    const { pres } = await fixture({
      preset: "diamond",
      geometry: { w: 1828800, h: 1828800 },
      textTransform: { x: 190500, y: 285750, w: 914400, h: 381000 },
    });
    const svg = render(pres, "foreignObject");
    expect(svg).toContain(
      '<foreignObject x="20.00" y="30.00" width="96.00" height="40.00"',
    );
    expect(svg).toContain('fill="#123456"');
  });

  it("composes text rotation with shape rotation around their respective centers", async () => {
    const { pres } = await fixture({
      geometry: { w: 1828800, h: 914400, rotation: 90 },
      textTransform: { x: 457200, y: 0, w: 914400, h: 914400, rotation: -90 },
    });
    const svg = render(pres, "foreignObject");
    expect(svg).toContain(
      'transform="rotate(90 96.00 48.00) rotate(-90 96.00 48.00)"',
    );
    expect(svg).toContain(
      '<foreignObject x="48.00" y="0.00" width="96.00" height="96.00"',
    );
  });

  it("keeps image geometry and its independent text transform separate", async () => {
    const { pres } = await fixture({
      image: true,
      geometry: { rotation: 30 },
      textTransform: {
        x: 914400,
        y: 914400,
        w: 1828800,
        h: 914400,
        rotation: -30,
      },
    });
    const svg = render(pres, "foreignObject");
    expect(svg).toContain("data:image/png;base64,");
    expect(svg).toContain(
      'transform="rotate(30 48.00 48.00) rotate(-30 192.00 144.00)"',
    );
    expect(svg).toContain(
      '<foreignObject x="96.00" y="96.00" width="192.00" height="96.00"',
    );
    expect((svg.match(/<foreignObject/g) || []).length).toBe(1);
  });

  it("preserves nested group coordinates without deriving bounds from child unions", async () => {
    const { pres } = await fixture({ nested: true });
    const svg = render(pres);
    expect(svg).toContain("translate(96.00 192.00)");
    // The nested group doubles its child into its frame: the child is drawn
    // at its mapped place and size, with its text left at its point size.
    expect(svg).toContain(
      '<rect x="96.00" y="0.00" width="192.00" height="192.00"',
    );
    expect(svg).toContain("Rendered");
  });

  it("refreshes replaced drawing data and reports stale semantic text while retaining visible cache content", async () => {
    const { pres, diagram } = await fixture();
    expect(render(pres)).toContain("Rendered");
    diagram.drawing.part.data = new TextEncoder().encode(
      new TextDecoder()
        .decode(diagram.drawing.part.data)
        .replace("Rendered 0", "Updated cache"),
    );
    const svg = render(pres);
    expect(svg).toContain("Updated");
    expect(svg).not.toContain("Rendered");
    expect(svg).toContain(
      "saved text differs from semantic text; layout reconciliation required",
    );
  });

  it("does not rewrite source parts, convert the editable graphicFrame, or change exports", async () => {
    const { pres, frame } = await fixture();
    const pkg = P._internalPackageOf(pres),
      before = pkg.parts.map((p) => [p.name, p.data.slice()]);
    const svg = render(pres);
    expect(P.getShapeKind(frame)).toBe("graphicFrame");
    expect(pkg.parts.map((p) => [p.name, p.data])).toEqual(before);
    const reopened = await P.loadPresentation(await P.savePresentation(pres));
    expect(
      P._internalPackageOf(reopened).parts.map((p) => [p.name, p.data]),
    ).toEqual(before);
    expect(render(reopened)).toBe(svg);
  });
});
