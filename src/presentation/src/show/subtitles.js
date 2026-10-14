// Live subtitles: what the presenter says, written over or beside the slide
// as they speak, with the browser's speech recognition. Browsers without it
// get a notice and the show goes on without subtitles.
import { speechRecognitionClass } from "./prefs.js";

const LINE_MS = 6000;

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
      recognition.onerror = (event) => {
        if (
          event.error === "not-allowed" ||
          event.error === "service-not-allowed"
        ) {
          running = false;
          place(box.dataset.position);
          onState?.("Subtitles need permission to use the microphone.");
        } else if (event.error === "language-not-supported")
          onState?.("Subtitles are not available for this spoken language.");
      };
      // Recognition ends on its own after a pause; it starts again while the
      // subtitles are on.
      recognition.onend = () => {
        if (running)
          try {
            recognition.start();
          } catch {}
      };
      running = true;
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
