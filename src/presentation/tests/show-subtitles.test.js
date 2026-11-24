// Live subtitles in a show: speech recognition that fails for good turns
// the subtitles off and says why, rather than starting over and over.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubtitles } from "../src/show/subtitles.js";

// Just enough of a page for the captions box.
const node = () => ({
  dataset: {},
  textContent: "",
  hidden: false,
  setAttribute() {},
  append() {},
  remove() {},
});
const host = () => ({ ...node(), ownerDocument: { createElement: node } });

function fakeRecognition(error) {
  const made = { starts: 0 };
  vi.stubGlobal(
    "SpeechRecognition",
    class {
      start() {
        made.starts++;
        setTimeout(() => {
          this.onerror?.({ error });
          this.onend?.();
        }, 0);
      }
      abort() {}
    },
  );
  return made;
}

describe("live subtitles", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ["network", "Subtitles need a network connection for speech recognition."],
    ["audio-capture", "Subtitles need a microphone, and none was found."],
    [
      "language-not-supported",
      "Subtitles are not available for this spoken language.",
    ],
  ])("turn off and say why on %s", async (error, message) => {
    const made = fakeRecognition(error);
    const told = [];
    const subtitles = createSubtitles({
      host: host(),
      language: "en-US",
      position: "bottom",
      onState: (m) => told.push(m),
    });
    expect(subtitles.start()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(made.starts).toBe(1);
    expect(subtitles.running).toBe(false);
    expect(told.at(-1)).toBe(message);
  });

  it("start again after a pause, but not over and over", async () => {
    vi.useFakeTimers();
    const made = fakeRecognition("no-speech");
    const subtitles = createSubtitles({
      host: host(),
      language: "en-US",
      position: "bottom",
    });
    subtitles.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(subtitles.running).toBe(true);
    expect(made.starts).toBeLessThanOrEqual(4);
    expect(made.starts).toBeGreaterThanOrEqual(2);
    subtitles.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(made.starts).toBeLessThanOrEqual(4);
  });
});
