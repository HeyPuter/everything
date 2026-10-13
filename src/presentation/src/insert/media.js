// Video and audio: inserting from a file or a recording, the controls that
// play them on the editing canvas, and the Playback tab with trim, fades,
// volume, how they start in a slide show, looping, poster frames and
// bookmarks.
import { el, dialog, toast, icon, iconButton } from "../ui.js";
import {
  bytesUrl,
  canvasPng,
  encodeWav,
  fieldRow,
  fileBytes,
  formatTime,
  parseTime,
  pickFiles,
  svgToPng,
} from "./util.js";

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
const MAX_BYTES = 150 * 1024 * 1024;
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

// A speaker for audio objects, drawn here.
export const SPEAKER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="14" fill="#EEF2F7" stroke="#94A3B8" stroke-width="2"/><path d="M14 26h8l12-10v32L22 38h-8z" fill="#2563EB"/><path d="M40 24c3.5 4.5 3.5 11.5 0 16M45 19c6 7.5 6 18.5 0 26" fill="none" stroke="#2563EB" stroke-width="3.5" stroke-linecap="round"/></svg>`;

function loadMedia(url, kind) {
  return new Promise((resolve, reject) => {
    const media = document.createElement(kind === "video" ? "video" : "audio");
    media.preload = "auto";
    media.muted = true;
    media.playsInline = true;
    media.onloadeddata = () => resolve(media);
    media.onerror = () =>
      reject(
        new Error(
          `This ${kind} could not be played by the browser. Choose an ${kind === "video" ? "MP4, WebM or MOV" : "MP3, WAV, M4A or OGG"} file.`,
        ),
      );
    media.src = url;
  });
}

function seek(media, time) {
  return new Promise((resolve) => {
    const done = () => {
      media.removeEventListener("seeked", done);
      resolve();
    };
    media.addEventListener("seeked", done);
    media.currentTime = time;
    setTimeout(done, 1500);
  });
}

/** A PNG of the video's frame at `time` seconds, with its pixel size. */
export async function videoFrame(media, time = 0) {
  if (time != null)
    await seek(
      media,
      Math.min(time, Math.max(0, (media.duration || 0) - 0.05)),
    );
  const scale = Math.min(
    1,
    1280 / Math.max(media.videoWidth, media.videoHeight, 1),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(media.videoWidth * scale));
  canvas.height = Math.max(2, Math.round(media.videoHeight * scale));
  canvas.getContext("2d").drawImage(media, 0, 0, canvas.width, canvas.height);
  return {
    png: await canvasPng(canvas),
    width: canvas.width,
    height: canvas.height,
  };
}

export function createMediaFeatures(ctx) {
  const { P } = ctx;
  const urls = new Map();
  const mediaOf = (obj) =>
    obj && P.getShapeKind(obj) === "picture" ? P.getShapeMedia(obj) : null;
  const isMedia = (obj) =>
    !!obj && P.getShapeKind(obj) === "picture" && !!P.getShapeMediaKind(obj);
  const current = () => {
    const obj = ctx.currentShape();
    return isMedia(obj) && ctx.selectedShapes().length === 1 ? obj : null;
  };
  /** A playable URL for a media object's bytes, made once per part. */
  function urlFor(media) {
    const key = `${media.partName}:${media.data.byteLength}`;
    let entry = urls.get(key);
    if (!entry || entry.data !== media.data) {
      if (entry) URL.revokeObjectURL(entry.url);
      entry = {
        url: bytesUrl(media.data, media.contentType),
        data: media.data,
      };
      urls.set(key, entry);
    }
    return entry.url;
  }

  async function insertMediaFile(file, kindWanted) {
    const type = mediaType(file);
    if (!type || (kindWanted && type.kind !== kindWanted))
      throw new Error(
        kindWanted === "audio"
          ? "Choose an MP3, WAV, M4A or OGG sound file."
          : "Choose an MP4, WebM or MOV video file.",
      );
    if (file.size > MAX_BYTES)
      throw new Error(
        "Choose a file smaller than 150 MB; large media makes the presentation slow to save and share.",
      );
    const data = await fileBytes(file);
    const url = bytesUrl(data, type.contentType);
    try {
      const media = await loadMedia(url, type.kind);
      const durationMs = Number.isFinite(media.duration)
        ? Math.round(media.duration * 1000)
        : 0;
      let poster, width, height;
      if (type.kind === "video") {
        ({ png: poster, width, height } = await videoFrame(media, 0));
      } else {
        poster = await svgToPng(SPEAKER_SVG, 128, 128);
        width = height = 1;
      }
      await placeMedia({
        kind: type.kind,
        data,
        contentType: type.contentType,
        extension: type.extension,
        poster,
        width,
        height,
        name: file.name,
        durationMs,
      });
    } finally {
      URL.revokeObjectURL(url);
    }
    if (file.size > 25 * 1024 * 1024)
      toast("Large media makes the file slower to save and share.");
  }

  async function placeMedia(m) {
    ctx.commitText();
    const size = ctx.currentSize();
    let w, h;
    if (m.kind === "video") {
      w = Math.min(size.cx * 0.6, (size.cy * 0.6 * m.width) / m.height);
      h = (w * m.height) / m.width;
    } else w = h = P.inches(0.6);
    const x = Math.round((size.cx - w) / 2),
      y = Math.round((size.cy - h) / 2);
    let id = null;
    await ctx.mutateSlide(ctx.slide(), (slide) => {
      const shape = P.addSlideMedia(
        slide,
        {
          kind: m.kind,
          data: m.data,
          contentType: m.contentType,
          extension: m.extension,
          poster: m.poster,
        },
        {
          x,
          y,
          w: Math.round(w),
          h: Math.round(h),
          name: m.name.replace(/\.[^.]+$/, "") || undefined,
        },
        { durationMs: m.durationMs, start: "inClickSequence" },
      );
      P.setShapeObjectData(shape, { type: "media", durationMs: m.durationMs });
      P.setShapeDescription(shape, m.name);
      id = P.getShapeId(shape);
      ctx.selectIds([id]);
    });
    ctx.ribbonSelect("playback");
  }

  const insertVideo = async () => {
    const [file] = await pickFiles(VIDEO_ACCEPT);
    if (file) await insertMediaFile(file, "video");
  };
  const insertAudio = async () => {
    const [file] = await pickFiles(AUDIO_ACCEPT);
    if (file) await insertMediaFile(file, "audio");
  };

  // ---- Recording -------------------------------------------------------
  async function recordAudio() {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    )
      throw new Error("This browser cannot record sound.");
    const name = el("input", {
      class: "input",
      value: "Recorded Sound",
      maxlength: 120,
      "aria-label": "Name",
    });
    const time = el(
      "span",
      { class: "record-time", role: "timer", "aria-live": "off" },
      "00:00.00",
    );
    const status = el(
      "p",
      { class: "record-status", role: "status" },
      "Press Record to start.",
    );
    const level = el(
      "div",
      { class: "record-level", "aria-hidden": "true" },
      el("span"),
    );
    let stream = null,
      recorder = null,
      chunks = [],
      blob = null,
      started = 0,
      timer = 0,
      analyser = null,
      audioCtx = null,
      player = null;
    const recordBtn = el(
      "button",
      { type: "button", class: "btn secondary record-btn" },
      icon("o:recordAudio", 16),
      el("span", {}, "Record"),
    );
    const stopBtn = el(
      "button",
      { type: "button", class: "btn secondary", disabled: true },
      icon("Square", 16),
      el("span", {}, "Stop"),
    );
    const playBtn = el(
      "button",
      { type: "button", class: "btn secondary", disabled: true },
      icon("Play", 16),
      el("span", {}, "Play"),
    );
    const insert = el(
      "button",
      { type: "button", class: "btn primary", disabled: true },
      "Insert",
    );
    const tick = () => {
      time.textContent = formatTime(Date.now() - started);
      if (analyser) {
        const data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
        level.firstChild.style.width = `${Math.round(peak * 100)}%`;
      }
    };
    const stopStream = () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      clearInterval(timer);
      audioCtx?.close().catch(() => {});
      audioCtx = analyser = null;
      level.firstChild.style.width = "0";
    };
    recordBtn.onclick = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        status.textContent =
          "The microphone is not available. Allow access to it and try again.";
        return;
      }
      chunks = [];
      blob = null;
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        stopStream();
        status.textContent = `Recorded ${time.textContent}. Play it back, record again, or insert it.`;
        playBtn.disabled = insert.disabled = false;
        recordBtn.disabled = false;
        stopBtn.disabled = true;
      };
      try {
        audioCtx = new AudioContext();
        analyser = audioCtx.createAnalyser();
        audioCtx.createMediaStreamSource(stream).connect(analyser);
      } catch {}
      recorder.start();
      started = Date.now();
      timer = setInterval(tick, 50);
      status.textContent = "Recording… Press Stop when you are done.";
      recordBtn.disabled = playBtn.disabled = insert.disabled = true;
      stopBtn.disabled = false;
      stopBtn.focus();
    };
    stopBtn.onclick = () => recorder?.state === "recording" && recorder.stop();
    playBtn.onclick = () => {
      if (!blob) return;
      player?.pause();
      player = new Audio(URL.createObjectURL(blob));
      player.play().catch(() => {});
    };
    let chosen = false;
    const body = el(
      "div",
      { class: "dialog-body record-dialog" },
      fieldRow("Name", name),
      el("div", { class: "record-row" }, time, level),
      el("div", { class: "record-row" }, recordBtn, stopBtn, playBtn),
      status,
      el("div", { class: "dialog-inline-actions" }, insert),
    );
    insert.onclick = () => {
      chosen = true;
      body.closest("dialog")?.dispatchEvent(new Event("cancel"));
    };
    await dialog({
      title: "Record Sound",
      body,
      confirm: null,
      cancel: "Cancel",
    });
    if (recorder?.state === "recording") recorder.stop();
    stopStream();
    player?.pause();
    if (!chosen || !blob) return;
    // Recordings become WAV, which every presentation app plays.
    const decodeCtx = new AudioContext();
    let buffer;
    try {
      buffer = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
    } finally {
      decodeCtx.close().catch(() => {});
    }
    const channels = [
      ...Array(Math.min(2, buffer.numberOfChannels)).keys(),
    ].map((c) => buffer.getChannelData(c));
    const data = encodeWav(channels, buffer.sampleRate);
    const label = name.value.trim() || "Recorded Sound";
    await placeMedia({
      kind: "audio",
      data,
      contentType: "audio/wav",
      extension: "wav",
      poster: await svgToPng(SPEAKER_SVG, 128, 128),
      width: 1,
      height: 1,
      name: `${label}.wav`,
      durationMs: Math.round(buffer.duration * 1000),
    });
  }

  // ---- Options ---------------------------------------------------------
  const durationOf = (obj) =>
    Number(P.getShapeObjectData(obj)?.durationMs) || 0;
  const options = () => {
    const obj = current();
    return obj ? (mediaOf(obj)?.options ?? null) : null;
  };
  function setOptions(change, obj = current()) {
    if (!obj) return;
    return ctx.mutateShape(obj, (target) => {
      const media = P.getShapeMedia(target);
      if (!media) return;
      P.setShapeMediaOptions(target, {
        ...media.options,
        ...change,
        durationMs: durationOf(target),
      });
    });
  }

  async function trimDialog() {
    const obj = current();
    const media = mediaOf(obj);
    if (!media) return;
    const total = durationOf(obj) || 0;
    const player = document.createElement(
      media.kind === "video" ? "video" : "audio",
    );
    player.src = urlFor(media);
    player.preload = "auto";
    player.controls = false;
    player.className = "trim-player";
    let duration = total / 1000;
    const startInput = el("input", {
      class: "input time-input",
      value: formatTime(media.options.trimStart),
      "aria-label": "Start time",
    });
    const endInput = el("input", {
      class: "input time-input",
      value: formatTime(Math.max(0, total - media.options.trimEnd)),
      "aria-label": "End time",
    });
    const scrub = el("input", {
      type: "range",
      min: 0,
      max: 1000,
      value: 0,
      step: 1,
      class: "trim-scrub",
      "aria-label": "Position",
    });
    const clock = el("span", { class: "trim-clock" }, formatTime(0));
    const range = el(
      "div",
      { class: "trim-range", "aria-hidden": "true" },
      el("span"),
    );
    const startMs = () => parseTime(startInput.value) ?? 0;
    const endMs = () => parseTime(endInput.value) ?? duration * 1000;
    const syncRange = () => {
      const d = duration * 1000 || 1;
      const band = range.firstChild;
      band.style.left = `${(startMs() / d) * 100}%`;
      band.style.width = `${Math.max(0, (endMs() - startMs()) / d) * 100}%`;
    };
    player.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(player.duration)) duration = player.duration;
      if (!total) endInput.value = formatTime(duration * 1000);
      syncRange();
    });
    player.addEventListener("timeupdate", () => {
      clock.textContent = formatTime(player.currentTime * 1000);
      scrub.value = String(
        Math.round((player.currentTime / (duration || 1)) * 1000),
      );
      if (player.currentTime * 1000 >= endMs()) player.pause();
    });
    scrub.addEventListener("input", () => {
      player.currentTime = (Number(scrub.value) / 1000) * duration;
    });
    startInput.addEventListener("change", syncRange);
    endInput.addEventListener("change", syncRange);
    const play = iconButton("Play the trimmed part", "o:mediaPlay", () => {
      if (!player.paused) return player.pause();
      if (
        player.currentTime * 1000 < startMs() ||
        player.currentTime * 1000 >= endMs()
      )
        player.currentTime = startMs() / 1000;
      player.play().catch(() => {});
    });
    const body = el(
      "form",
      { class: "dialog-body trim-dialog" },
      media.kind === "video"
        ? player
        : el("div", { class: "trim-audio" }, icon("o:audio", 32)),
      range,
      el("div", { class: "trim-row" }, play, scrub, clock),
      el(
        "div",
        { class: "trim-row" },
        fieldRow("Start Time", startInput),
        el(
          "button",
          {
            type: "button",
            class: "btn secondary",
            onclick: () => (
              (startInput.value = formatTime(player.currentTime * 1000)),
              syncRange()
            ),
          },
          "Set to current",
        ),
      ),
      el(
        "div",
        { class: "trim-row" },
        fieldRow("End Time", endInput),
        el(
          "button",
          {
            type: "button",
            class: "btn secondary",
            onclick: () => (
              (endInput.value = formatTime(player.currentTime * 1000)),
              syncRange()
            ),
          },
          "Set to current",
        ),
      ),
    );
    if (media.kind === "audio") body.prepend(player);
    syncRange();
    const ok = await dialog({
      title: media.kind === "video" ? "Trim Video" : "Trim Audio",
      body,
      confirm: "OK",
    });
    player.pause();
    if (!ok) return;
    const full = Math.round(duration * 1000);
    const start = Math.max(0, Math.min(startMs(), full));
    const end = Math.max(start, Math.min(endMs(), full));
    if (end - start < 100)
      throw new Error(
        "Leave at least a tenth of a second between the start and end.",
      );
    await setOptions(
      { trimStart: start, trimEnd: Math.max(0, full - end) },
      obj,
    );
  }

  async function posterFromCurrentFrame() {
    const obj = current();
    const media = mediaOf(obj);
    if (!media || media.kind !== "video") return;
    const player = players.get(keyOf(obj))?.element;
    const source =
      player && player.readyState >= 2
        ? player
        : await loadMedia(urlFor(media), "video");
    const time = player ? null : media.options.trimStart / 1000;
    const { png } = await videoFrame(source, time);
    await ctx.mutateShape(obj, (target, slide) => {
      P.setShapeVectorPicture(target, { png });
      ctx.pruneMedia(slide);
    });
  }
  async function posterFromFile() {
    const obj = current();
    if (!obj) return;
    const [file] = await pickFiles("image/png,image/jpeg");
    if (!file) return;
    const { bytes } = await ctx.readImage(file);
    await ctx.mutateShape(obj, (target, slide) => {
      P.setShapeImage(target, bytes);
      ctx.pruneMedia(slide);
    });
  }

  async function addBookmark() {
    const obj = current();
    const media = mediaOf(obj);
    if (!media) return;
    const player = players.get(keyOf(obj))?.element;
    if (!player) {
      toast("Play the media and pause where the bookmark should go.");
      return;
    }
    const time = Math.round(player.currentTime * 1000);
    const bookmarks = [
      ...media.options.bookmarks,
      { name: `Bookmark ${media.options.bookmarks.length + 1}`, time },
    ].sort((a, b) => a.time - b.time);
    await setOptions({ bookmarks }, obj);
  }
  async function removeBookmark(index) {
    const media = mediaOf(current());
    if (!media) return;
    const bookmarks = media.options.bookmarks.filter((_, i) => i !== index);
    await setOptions({ bookmarks });
  }

  // ---- Playing on the canvas -------------------------------------------
  const players = new Map();
  const keyOf = (obj) =>
    `${P.getSlidePartName(P.getShapeSlide(obj))}#${P.getShapeId(obj)}`;
  function stopAll(except = null) {
    for (const [key, p] of players)
      if (key !== except) {
        p.element.pause();
        p.surface?.remove();
        players.delete(key);
      }
  }
  function playerFor(obj) {
    const key = keyOf(obj);
    let p = players.get(key);
    const media = mediaOf(obj);
    if (!media) return null;
    if (!p) {
      const element = document.createElement(
        media.kind === "video" ? "video" : "audio",
      );
      element.src = urlFor(media);
      element.preload = "auto";
      element.playsInline = true;
      element.className = "media-surface";
      element.setAttribute("aria-hidden", "true");
      p = {
        element,
        kind: media.kind,
        surface: media.kind === "video" ? element : null,
      };
      players.set(key, p);
      element.addEventListener("loadedmetadata", () => {
        const o = mediaOf(obj)?.options ?? media.options;
        element.currentTime = o.trimStart / 1000;
      });
    }
    p.options = media.options;
    p.element.volume = media.options.muted ? 0 : media.options.volume;
    return p;
  }

  function decorate(canvas) {
    canvas.querySelectorAll(".media-bar").forEach((n) => n.remove());
    const slide = ctx.slide();
    const size = ctx.currentSize();
    const visible = new Set(ctx.visibleShapes(slide).map(P.getShapeId));
    const keep = new Set();
    for (const obj of P.getSlideShapes(slide)) {
      if (!isMedia(obj) || !visible.has(P.getShapeId(obj))) continue;
      const b = ctx.slideBounds(obj);
      if (!b) continue;
      const key = keyOf(obj);
      keep.add(key);
      const p = players.get(key);
      const pos = (node, top) => {
        node.style.left = `${(b.x / size.cx) * 100}%`;
        node.style.width = `${(b.w / size.cx) * 100}%`;
        node.style.top = `${(top / size.cy) * 100}%`;
      };
      if (p?.surface) {
        pos(p.surface, b.y);
        p.surface.style.height = `${(b.h / size.cy) * 100}%`;
        if (!p.surface.isConnected) canvas.append(p.surface);
      }
      const selected = ctx.selectedIds().has(P.getShapeId(obj));
      const bar = mediaBar(obj, selected);
      // Under the object, or inside its foot when that would leave the slide.
      const below = b.y + b.h + size.cy * 0.07 < size.cy;
      pos(bar, below ? b.y + b.h : b.y + b.h - size.cy * 0.07);
      canvas.append(bar);
    }
    // Media on another slide, or deleted, stops.
    for (const [key, p] of [...players])
      if (!keep.has(key)) {
        p.element.pause();
        p.surface?.remove();
        players.delete(key);
      }
  }

  function mediaBar(obj, selected) {
    const p = players.get(keyOf(obj));
    const media = mediaOf(obj);
    const playing = p && !p.element.paused;
    const total =
      (durationOf(obj) || 0) -
      (media?.options.trimStart ?? 0) -
      (media?.options.trimEnd ?? 0);
    const time = el(
      "span",
      { class: "media-time" },
      formatTime(
        p ? p.element.currentTime * 1000 - (media?.options.trimStart ?? 0) : 0,
      ),
    );
    const scrub = el("input", {
      type: "range",
      class: "media-scrub",
      min: 0,
      max: 1000,
      step: 1,
      value:
        p && total > 0
          ? Math.round(
              ((p.element.currentTime * 1000 - media.options.trimStart) /
                total) *
                1000,
            )
          : 0,
      "aria-label": "Position",
      oninput: (e) => {
        const player = playerFor(obj);
        player.element.currentTime =
          (media.options.trimStart + (Number(e.target.value) / 1000) * total) /
          1000;
      },
    });
    const play = iconButton(
      playing ? "Pause" : "Play",
      playing ? "o:mediaPause" : "o:mediaPlay",
      (e) => {
        e.stopPropagation();
        toggle(obj);
      },
    );
    const volumeOn = !media?.options.muted && (media?.options.volume ?? 1) > 0;
    const mute = iconButton(
      volumeOn ? "Mute" : "Unmute",
      volumeOn ? "o:volume" : "o:mute",
      (e) => {
        e.stopPropagation();
        setOptions({ muted: volumeOn }, obj);
      },
    );
    const bar = el(
      "div",
      {
        class: `media-bar ${selected ? "selected" : ""} ${playing ? "playing" : ""}`,
        role: "group",
        "aria-label": `${media?.kind === "audio" ? "Audio" : "Video"} controls`,
        onpointerdown: (e) => e.stopPropagation(),
        onclick: (e) => e.stopPropagation(),
      },
      play,
      scrub,
      time,
      mute,
    );
    if (p) {
      const update = () => {
        if (!bar.isConnected)
          return p.element.removeEventListener("timeupdate", update);
        const at = p.element.currentTime * 1000 - media.options.trimStart;
        time.textContent = formatTime(at);
        if (total > 0) scrub.value = String(Math.round((at / total) * 1000));
        // Stop at the trimmed end.
        if (
          p.element.currentTime * 1000 >=
          (durationOf(obj) || Infinity) - media.options.trimEnd
        ) {
          p.element.pause();
          if (!media.options.loop) ctx.refreshCanvas();
          else p.element.currentTime = media.options.trimStart / 1000;
        }
      };
      p.element.addEventListener("timeupdate", update);
    }
    return bar;
  }

  function toggle(obj) {
    const p = playerFor(obj);
    if (!p) return;
    stopAll(keyOf(obj));
    if (p.element.paused) {
      const o = p.options;
      const end = (durationOf(obj) || Infinity) - o.trimEnd;
      if (
        p.element.currentTime * 1000 < o.trimStart ||
        p.element.currentTime * 1000 >= end - 30
      )
        p.element.currentTime = o.trimStart / 1000;
      p.element.onpause = p.element.onplay = () => ctx.refreshCanvas();
      p.element
        .play()
        .catch(() => toast("This media could not be played in the browser."));
    } else p.element.pause();
    ctx.refreshCanvas();
  }

  // ---- Playback tab ----------------------------------------------------
  const kind = () => (current() ? P.getShapeMediaKind(current()) : null);
  const playbackTab = () => ({
    id: "playback",
    label: "Playback",
    contextual: true,
    visible: () => !!current(),
    groups: [
      {
        id: "playback-preview",
        label: "Preview",
        icon: "play",
        items: [
          {
            type: "large",
            id: "playback-play",
            label: "Play",
            icon: "mediaPlay",
            title: "Play",
            description: "Play the selected video or audio here.",
            run: () => current() && toggle(current()),
          },
        ],
      },
      {
        id: "playback-bookmarks",
        label: "Bookmarks",
        icon: "bookmark",
        items: [
          {
            type: "stack",
            items: [
              {
                type: "small",
                id: "playback-add-bookmark",
                label: "Add Bookmark",
                icon: "bookmarkAdd",
                description: "Mark the current playing position.",
                run: () => addBookmark().catch(ctx.fail),
              },
              {
                type: "small",
                id: "playback-remove-bookmark",
                label: "Remove Bookmark",
                icon: "bookmarkRemove",
                enabled: () => !!options()?.bookmarks.length,
                menu: () =>
                  (options()?.bookmarks ?? []).map((b, i) => ({
                    label: `${b.name} (${formatTime(b.time)})`,
                    onSelect: () => removeBookmark(i).catch(ctx.fail),
                  })),
              },
            ],
          },
        ],
      },
      {
        id: "playback-editing",
        label: "Editing",
        icon: "trim",
        items: [
          {
            type: "large",
            id: "playback-trim",
            label: "Trim",
            icon: "trim",
            title: "Trim",
            description: "Cut time from the start and end.",
            run: () => trimDialog().catch(ctx.fail),
          },
          {
            type: "stack",
            items: [
              {
                type: "spin",
                id: "playback-fade-in",
                label: "Fade In",
                width: 70,
                min: 0,
                max: 60,
                step: 0.25,
                format: (n) => `${n.toFixed(2)}`,
                value: () => (options()?.fadeIn ?? 0) / 1000,
                commit: (n) => setOptions({ fadeIn: Math.round(n * 1000) }),
              },
              {
                type: "spin",
                id: "playback-fade-out",
                label: "Fade Out",
                width: 70,
                min: 0,
                max: 60,
                step: 0.25,
                format: (n) => `${n.toFixed(2)}`,
                value: () => (options()?.fadeOut ?? 0) / 1000,
                commit: (n) => setOptions({ fadeOut: Math.round(n * 1000) }),
              },
            ],
          },
        ],
      },
      {
        id: "playback-options",
        label: "Options",
        icon: "settings",
        items: [
          {
            type: "large",
            id: "playback-volume",
            label: "Volume",
            icon: "audio",
            title: "Volume",
            menu: () =>
              [
                ["Low", 0.33],
                ["Medium", 0.66],
                ["High", 1],
                ["Mute", 0],
              ].map(([label, v]) => ({
                label,
                checked:
                  v === 0
                    ? !!options()?.muted
                    : !options()?.muted &&
                      Math.abs((options()?.volume ?? 1) - v) < 0.05,
                onSelect: () =>
                  setOptions(
                    v === 0 ? { muted: true } : { muted: false, volume: v },
                  ).catch(ctx.fail),
              })),
          },
          {
            type: "stack",
            items: [
              {
                type: "combo",
                id: "playback-start",
                label: "Start",
                width: 150,
                value: () =>
                  START_LABELS.find(([v]) => v === options()?.start)?.[1] ?? "",
                options: () => START_LABELS.map(([, l]) => l),
                commit: (label) => {
                  const value = START_LABELS.find(([, l]) => l === label)?.[0];
                  if (value) setOptions({ start: value });
                },
              },
              {
                type: "check",
                id: "playback-full-screen",
                label: "Play Full Screen",
                visible: () => kind() === "video",
                checked: () => !!options()?.fullScreen,
                commit: (on) => setOptions({ fullScreen: on }),
              },
              {
                type: "check",
                id: "playback-across-slides",
                label: "Play Across Slides",
                visible: () => kind() === "audio",
                checked: () => !!options()?.playAcrossSlides,
                commit: (on) => setOptions({ playAcrossSlides: on }),
              },
            ],
          },
          {
            type: "stack",
            items: [
              {
                type: "check",
                id: "playback-hide",
                label: "Hide While Not Playing",
                checked: () => !!options()?.hideWhileNotPlaying,
                commit: (on) => setOptions({ hideWhileNotPlaying: on }),
              },
              {
                type: "check",
                id: "playback-loop",
                label: "Loop until Stopped",
                checked: () => !!options()?.loop,
                commit: (on) => setOptions({ loop: on }),
              },
              {
                type: "check",
                id: "playback-rewind",
                label: "Rewind after Playing",
                checked: () => !!options()?.rewind,
                commit: (on) => setOptions({ rewind: on }),
              },
            ],
          },
        ],
      },
      {
        id: "playback-poster",
        label: "Poster Frame",
        icon: "pictures",
        visible: () => kind() === "video",
        items: [
          {
            type: "large",
            id: "playback-poster-frame",
            label: "Poster\nFrame",
            icon: "posterFrame",
            title: "Poster Frame",
            description: "The picture shown before the video plays.",
            menu: () => [
              {
                label: "Current Frame",
                onSelect: () => posterFromCurrentFrame().catch(ctx.fail),
              },
              {
                label: "Image from File…",
                onSelect: () => posterFromFile().catch(ctx.fail),
              },
            ],
          },
        ],
      },
    ],
  });

  // ---- Insert menus ----------------------------------------------------
  const videoMenu = () => [
    {
      label: "Video from File…",
      icon: "o:video",
      onSelect: () => insertVideo().catch(ctx.fail),
    },
  ];
  const audioMenu = () => [
    {
      label: "Audio from File…",
      icon: "o:audio",
      onSelect: () => insertAudio().catch(ctx.fail),
    },
    { separator: true },
    {
      label: "Record Audio…",
      icon: "o:recordAudio",
      onSelect: () => recordAudio().catch(ctx.fail),
    },
  ];

  return {
    isMedia,
    insertVideo,
    insertAudio,
    insertMediaFile,
    recordAudio,
    videoMenu,
    audioMenu,
    playbackTab,
    decorate,
    toggle,
    stopAll: () => stopAll(),
    urlFor,
    trimDialog,
  };
}
