// Live subtitles: what the presenter says, written over or beside the slide
// as they speak, with the browser's speech recognition. Browsers without it
// get a notice and the show goes on without subtitles.
import { speechRecognitionClass } from "./prefs.js";

const LINE_MS = 6000;
// Errors that starting again cannot mend: the subtitles turn off and say why.
const FATAL = {
  "not-allowed": "Subtitles need permission to use the microphone.",
  "service-not-allowed": "Subtitles need permission to use the microphone.",
  "audio-capture": "Subtitles need a microphone, and none was found.",
  network: "Subtitles need a network connection for speech recognition.",
  "language-not-supported":
    "Subtitles are not available for this spoken language.",
};
// Recognition that ends this soon after starting waits before starting again.
const RESTART_MS = 1000;

/**
 * host: the element the captions show in (the audience's stage).
 * onState(message|null): a notice to show, such as when recognition stops.
 */
export function createSubtitles({ host, language, position, onState }) {
  const doc = host.ownerDocument;
  const box = doc.createElement("div");
  box.className = "show-captions";
  box.setAttribute("role", "log");
  box.setAttribute("aria-live", "polite");
  box.setAttribute("aria-label", "Subtitles");
  box.hidden = true;
  const final = doc.createElement("span");
  const interim = doc.createElement("span");
  interim.className = "interim";
  box.append(final, interim);
  host.append(box);
  let recognition = null;
  let running = false;
  let clearTimer = 0;
  let restartTimer = 0;
  let startedAt = 0;

  function place(where) {
    box.dataset.position = where;
    host.dataset.captions = running ? where : "";
  }
  place(position);

  function write(finalText, interimText) {
    if (finalText) {
      // Keep the last line or two: subtitles, not a transcript.
      const text = `${final.textContent} ${finalText}`.trim();
      final.textContent =
        text.length > 160 ? text.slice(-160).replace(/^\S*\s/, "…") : text;
    }
    interim.textContent = interimText ? ` ${interimText}` : "";
    box.hidden = !(final.textContent || interim.textContent);
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      final.textContent = "";
      interim.textContent = "";
      box.hidden = true;
    }, LINE_MS);
  }

  function start(lang = language) {
    const Recognition = speechRecognitionClass();
    if (!Recognition) {
      onState?.(
        "Live subtitles need speech recognition, which this browser does not offer.",
      );
      return false;
    }
    stop();
    try {
      recognition = new Recognition();
      recognition.lang = lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        let finalText = "";
        let interimText = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) finalText += result[0].transcript;
          else interimText += result[0].transcript;
        }
        write(finalText.trim(), interimText.trim());
      };
      const mine = recognition;
      recognition.onerror = (event) => {
        if (recognition !== mine || !FATAL[event.error]) return;
        stop();
        onState?.(FATAL[event.error]);
      };
      // Recognition ends on its own after a pause; it starts again while the
      // subtitles are on, though not over and over if it keeps ending.
      recognition.onend = () => {
        if (!running || recognition !== mine) return;
        const again = () => {
          if (!running || recognition !== mine) return;
          startedAt = performance.now();
          try {
            mine.start();
          } catch {}
        };
        clearTimeout(restartTimer);
        const wait = startedAt + RESTART_MS - performance.now();
        if (wait > 0) restartTimer = setTimeout(again, wait);
        else again();
      };
      running = true;
      startedAt = performance.now();
      recognition.start();
      place(box.dataset.position);
      onState?.(null);
      return true;
    } catch {
      running = false;
      onState?.("Live subtitles could not start.");
      return false;
    }
  }
  function stop() {
    running = false;
    clearTimeout(clearTimer);
    clearTimeout(restartTimer);
    try {
      recognition?.abort();
    } catch {}
    recognition = null;
    final.textContent = "";
    interim.textContent = "";
    box.hidden = true;
    place(box.dataset.position);
  }
  return {
    get running() {
      return running;
    },
    start,
    stop,
    toggle: () => (running ? (stop(), false) : start()),
    setPosition: place,
    /** Moves the captions to another stage (the audience's window). */
    moveTo(next) {
      next.append(box);
      delete host.dataset.captions;
      host = next;
      place(box.dataset.position);
    },
    dispose() {
      stop();
      box.remove();
      delete host.dataset.captions;
    },
  };
}
