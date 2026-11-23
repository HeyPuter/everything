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
    // The share of the picture in the leaving (red) or arriving (blue)
    // slide's color; null for a picture that cannot be read (WebGL).
    const share = () => {
      const source = host.querySelector(".slide-transition canvas");
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 36;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(source, 0, 0, 64, 36);
      const data = ctx.getImageData(0, 0, 64, 36).data;
      let red = 0,
        blue = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 150 && data[i + 2] < 100) red++;
        if (data[i + 2] > 150 && data[i] < 100) blue++;
      }
      if (!red && !blue) return null;
      return { red: red / 2304, blue: blue / 2304 };
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
        if (first && first.red < 0.99)
          wrong.push(`${name} starts ${first.red}`);
        if (last && last.blue < 0.99) wrong.push(`${name} ends ${last.blue}`);
      }
    }
    host.remove();
    return wrong;
  });
  expect(wrong).toEqual([]);
});
