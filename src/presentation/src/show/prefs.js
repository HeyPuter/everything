// Slide show preferences that belong to this app and the person using it,
// not to the file: live subtitles, presenter view, the notes' text size and
// the camera and microphone chosen for recording.

const KEY = "presentation:show";
const DEFAULTS = {
  alwaysSubtitles: false,
  subtitleLanguage: "",
  subtitlePosition: "bottom", // bottom | top | below | above
  usePresenterView: true,
  notesFontSize: 20,
  cameraShape: "circle", // circle | rect
  cameraOn: true,
  micOn: true,
  cameraId: "",
  micId: "",
};

let cache = null;
function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {}
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

export const showPrefs = new Proxy(
  {},
  {
    get: (_, name) => load()[name],
    set(_, name, value) {
      load()[name] = value;
      try {
        localStorage.setItem(KEY, JSON.stringify(cache));
      } catch {}
      return true;
    },
  },
);

export const SUBTITLE_POSITIONS = [
  ["bottom", "Bottom (Overlaid)"],
  ["top", "Top (Overlaid)"],
  ["below", "Below Slide"],
  ["above", "Above Slide"],
];

// Languages the browser's speech recognition commonly accepts.
export const SPOKEN_LANGUAGES = [
  ["ar-SA", "Arabic"],
  ["zh-CN", "Chinese (Simplified)"],
  ["zh-TW", "Chinese (Traditional)"],
  ["da-DK", "Danish"],
  ["nl-NL", "Dutch"],
  ["en-AU", "English (Australia)"],
  ["en-CA", "English (Canada)"],
  ["en-IN", "English (India)"],
  ["en-GB", "English (United Kingdom)"],
  ["en-US", "English (United States)"],
  ["fi-FI", "Finnish"],
  ["fr-CA", "French (Canada)"],
  ["fr-FR", "French (France)"],
  ["de-DE", "German"],
  ["hi-IN", "Hindi"],
  ["it-IT", "Italian"],
  ["ja-JP", "Japanese"],
  ["ko-KR", "Korean"],
  ["nb-NO", "Norwegian"],
  ["fa-IR", "Persian"],
  ["pl-PL", "Polish"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["pt-PT", "Portuguese (Portugal)"],
  ["ru-RU", "Russian"],
  ["es-MX", "Spanish (Mexico)"],
  ["es-ES", "Spanish (Spain)"],
  ["sv-SE", "Swedish"],
  ["tr-TR", "Turkish"],
  ["uk-UA", "Ukrainian"],
];

/** The spoken language for subtitles: the one chosen, else the browser's. */
export function spokenLanguage() {
  const chosen = showPrefs.subtitleLanguage;
  if (chosen) return chosen;
  const browser = (globalThis.navigator?.language || "en-US").toLowerCase();
  return (
    SPOKEN_LANGUAGES.find(([code]) => code.toLowerCase() === browser)?.[0] ||
    SPOKEN_LANGUAGES.find(
      ([code]) => code.slice(0, 2).toLowerCase() === browser.slice(0, 2),
    )?.[0] ||
    "en-US"
  );
}

export const speechRecognitionClass = () =>
  globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
