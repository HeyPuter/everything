import { test, expect } from "@playwright/test";

// Every transition in the gallery, with each of its options, starts on the
// leaving slide and ends on the arriving one: no flash of either at the
// ends, and nothing of the leaving slide left over.

test("every transition starts on the leaving slide and ends on the arriving one", async ({
  page,
}) => {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const wrong = await page.evaluate(async () => {
    const { TRANSITIONS, transitionFor } =
      await import("/src/transitions/catalog.js");
    const { playTransition } = await import("/src/transitions/player.js");
    const picture = (color) =>
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="${color}"/></svg>`,
      );
    const host = document.createElement("div");
    Object.assign(host.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "320px",
      height: "180px",
    });
    document.body.append(host);
    const frame = () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // The share of the picture that is exactly the leaving (red) or the
    // arriving (blue) slide's color, so a shadow, a soft edge or a seam
    // left over counts; null for a picture that cannot be read (WebGL).
    const share = () => {
      const source = host.querySelector(".slide-transition canvas");
      const ctx = source.getContext("2d");
      if (!ctx) return null;
      const { width, height } = source;
      const data = ctx.getImageData(0, 0, width, height).data;
      let red = 0,
        blue = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r > 247 && g < 8 && b < 8) red++;
        if (b > 247 && r < 8 && g < 8) blue++;
      }
      return { red: red / (width * height), blue: blue / (width * height) };
    };
    const wrong = [];
    for (const entry of TRANSITIONS) {
      if (["none", "morph", "random"].includes(entry.id)) continue;
      for (const option of entry.options || [{ id: null }]) {
        const transition = {
          ...transitionFor(entry.id, option.id, null),
          durationMs: 1000,
        };
        const playback = playTransition({
          host,
          from: picture("#ff0000"),
          to: picture("#0000ff"),
          transition,
        });
        for (let i = 0; i < 200 && !host.querySelector("canvas"); i++)
          await frame();
        const clock = playback.element.getAnimations()[0];
        clock.pause();
        const name = `${entry.id} ${option.id ?? ""}`;
        clock.currentTime = 0;
        await frame();
        const first = share();
        clock.currentTime = 999;
        await frame();
        const last = share();
        playback.cancel();
        if (first && first.red < 0.995)
          wrong.push(`${name} starts ${first.red}`);
        if (last && last.blue < 0.995) wrong.push(`${name} ends ${last.blue}`);
      }
    }
    host.remove();
    return wrong;
  });
  expect(wrong).toEqual([]);
});
