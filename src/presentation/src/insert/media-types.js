// Media kinds and content types the Insert Video / Audio commands accept.

export const VIDEO_ACCEPT =
  "video/mp4,video/webm,video/quicktime,.mp4,.m4v,.webm,.mov";
export const AUDIO_ACCEPT =
  "audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/ogg,.mp3,.wav,.m4a,.ogg,.oga";
const TYPES = {
  mp4: ["video", "video/mp4"],
  m4v: ["video", "video/mp4"],
  webm: ["video", "video/webm"],
  mov: ["video", "video/quicktime"],
  mp3: ["audio", "audio/mpeg"],
  wav: ["audio", "audio/wav"],
  m4a: ["audio", "audio/mp4"],
  ogg: ["audio", "audio/ogg"],
  oga: ["audio", "audio/ogg"],
};
export const MAX_BYTES = 150 * 1024 * 1024;
export const START_LABELS = [
  ["inClickSequence", "In Click Sequence"],
  ["automatically", "Automatically"],
  ["whenClicked", "When Clicked On"],
];

/** Kind and content type for a chosen file, by extension or MIME type. */
export function mediaType(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (TYPES[ext])
    return {
      kind: TYPES[ext][0],
      contentType: TYPES[ext][1],
      extension: ext === "m4v" ? "mp4" : ext === "oga" ? "ogg" : ext,
    };
  const type = (file.type || "").toLowerCase();
  const found = Object.entries(TYPES).find(([, [, t]]) => t === type);
  return found
    ? { kind: found[1][0], contentType: found[1][1], extension: found[0] }
    : null;
}
