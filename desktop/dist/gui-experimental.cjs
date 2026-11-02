"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// gui.js
var gui_exports = {};
__export(gui_exports, {
  default: () => gui_default
});
module.exports = __toCommonJS(gui_exports);
var import_gui = require("@opencode/plugin/gui");
var import_effect = require("effect");
var import_solid_js = require("solid-js");

// ../src/audio.ts
function createAudioRecorder(onError) {
  let mediaRecorder = null;
  let chunks = [];
  let stream = null;
  let cancelled = false;
  let stopping = false;
  let stopPromise = null;
  const release = () => {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };
  return {
    async start() {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error(
          "Microphone recording requires HTTPS (or localhost) and a supported browser."
        );
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        if (cancelled) throw new Error("Recording cancelled");
        const mimeType = [
          "audio/webm;codecs=opus",
          "audio/webm",
          "audio/mp4",
          "audio/ogg;codecs=opus"
        ].find((type) => MediaRecorder.isTypeSupported(type));
        if (!mimeType) throw new Error("No supported audio recording format in this browser.");
        mediaRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 128e3, mimeType });
        mediaRecorder.ondataavailable = (event) => {
          if (!cancelled && event.data.size > 0) chunks.push(event.data);
        };
        mediaRecorder.onerror = () => {
          release();
          onError?.("Microphone recording failed. Please try again.");
        };
        mediaRecorder.onstop = () => {
          release();
          if (!cancelled && !stopping) onError?.("Microphone recording stopped unexpectedly.");
        };
        mediaRecorder.start();
      } catch (error) {
        release();
        throw error;
      }
    },
    stop() {
      if (stopPromise) return stopPromise;
      const recorder = mediaRecorder;
      if (!recorder || recorder.state === "inactive") {
        release();
        return Promise.reject(new Error("No recording in progress."));
      }
      stopping = true;
      stopPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => finish(new Error("Microphone did not finish recording.")),
          5e3
        );
        const finish = (error) => {
          clearTimeout(timeout);
          release();
          const blob = new Blob(chunks, { type: recorder.mimeType });
          chunks = [];
          if (error) reject(error);
          else resolve(blob);
        };
        recorder.onstop = () => finish();
        recorder.onerror = () => finish(new Error("Microphone recording failed."));
        try {
          recorder.stop();
        } catch {
          finish(new Error("Could not stop recording."));
        }
        release();
      });
      return stopPromise;
    },
    cancel() {
      cancelled = true;
      if (mediaRecorder?.state !== "inactive") {
        try {
          mediaRecorder?.stop();
        } catch {
        }
      }
      release();
      chunks = [];
    },
    isRecording: () => mediaRecorder?.state === "recording"
  };
}

// controller.ts
function createDictation(host) {
  let state = "idle";
  let transcript = "";
  let target;
  let recorder;
  let request;
  let generation = 0;
  let key = "";
  let timer;
  let disposed = false;
  const getState = () => state;
  const change = (next) => {
    state = next;
    host.changed(state, transcript);
  };
  const current = () => {
    const now = host.capture();
    return !!target && now?.key === target.key && now.visit === target.visit && now.screen === target.screen;
  };
  function cancel() {
    generation++;
    clearTimeout(timer);
    recorder?.cancel();
    request?.abort();
    recorder = void 0;
    request = void 0;
    target = void 0;
    transcript = "";
    change("idle");
  }
  function checkTarget() {
    if (state !== "idle" && !current()) cancel();
  }
  async function start() {
    if (disposed || state !== "idle" || host.composing()) return;
    target = host.capture();
    if (!target) return;
    const own = ++generation;
    change("starting");
    try {
      if (!key) {
        const value = await host.authorize();
        if (own !== generation || !current()) return;
        if (!value?.trim()) {
          cancel();
          return;
        }
        key = value.trim();
      }
      const audio = (host.recorder ?? createAudioRecorder)(() => {
        if (own !== generation) return;
        cancel();
        host.notify("Microphone recording failed. Check microphone permission and try again.");
      });
      recorder = audio;
      await audio.start();
      if (own !== generation || !current()) {
        audio.cancel();
        return;
      }
      change("recording");
      timer = setTimeout(() => {
        if (own !== generation) return;
        cancel();
        host.notify("Recording reached the 120-second limit and was discarded.");
      }, 12e4);
    } catch {
      if (own === generation) {
        cancel();
        host.notify("Could not start recording. Check your microphone permission and device.");
      }
    } finally {
      if (own === generation && getState() === "starting") cancel();
    }
  }
  async function stop() {
    if (state !== "recording") return;
    if (!current()) {
      cancel();
      return;
    }
    const audio = recorder;
    if (!audio) return;
    clearTimeout(timer);
    const own = generation;
    const controller = new AbortController();
    request = controller;
    change("processing");
    try {
      const blob = await audio.stop();
      if (own !== generation || !current()) return;
      if (!blob.size || blob.size > 20 * 1024 * 1024) throw new Error("Audio size");
      const text = await host.transcribe(blob, key, controller.signal);
      if (own !== generation || !current()) return;
      if (!text.trim()) {
        cancel();
        host.notify("No speech detected.");
        return;
      }
      transcript = text;
      recorder = void 0;
      request = void 0;
      change("review");
    } catch {
      if (own === generation && !controller.signal.aborted) {
        cancel();
        host.notify(
          "Transcription failed. Check the provider, connection and API key; no text was inserted."
        );
      }
    } finally {
      if (own === generation && getState() === "processing") cancel();
    }
  }
  function insert() {
    if (state !== "review") return;
    if (!current()) {
      cancel();
      return;
    }
    if (host.composing()) {
      host.notify("Finish composing text before inserting the transcript.");
      return;
    }
    const captured = target;
    const text = transcript;
    if (!captured) return;
    captured.insert(text);
    captured.focus();
    cancel();
  }
  return {
    start,
    stop,
    insert,
    cancel,
    checkTarget,
    clearKey() {
      cancel();
      key = "";
    },
    dispose() {
      disposed = true;
      cancel();
      key = "";
    },
    revision: () => generation,
    state: () => state,
    transcript: () => transcript
  };
}

// transport.ts
var TransportError = class extends Error {
};
var MAX_AUDIO_BYTES = 20 * 1024 * 1024;
var MAX_RESPONSE_BYTES = 1024 * 1024;
var MIME_EXTENSIONS = {
  "audio/webm;codecs=opus": "webm",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg;codecs=opus": "ogg"
};
function resolveOptions(options = {}) {
  const endpoint = options.endpoint ?? "https://api.groq.com/openai/v1/audio/transcriptions";
  const model = options.model ?? "whisper-large-v3-turbo";
  const language = options.language ?? "";
  if (typeof endpoint !== "string") throw new TransportError("STT endpoint must be an HTTPS URL.");
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TransportError("STT endpoint must be an HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TransportError("STT endpoint requires HTTPS without URL credentials or a fragment.");
  }
  if (typeof model !== "string" || !/^[\w./:-]{1,128}$/.test(model)) {
    throw new TransportError("Invalid STT model configuration.");
  }
  if (typeof language !== "string" || !/^(?:[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)?$/.test(language)) {
    throw new TransportError("Invalid STT language configuration.");
  }
  return { endpoint: url.href, model, language };
}
async function readResponse(response) {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => {
    });
    throw new TransportError("STT response exceeded the size limit.");
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    void response.body?.cancel().catch(() => {
    });
    throw new TransportError("STT service did not return JSON.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TransportError("STT service returned an empty response.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value: value2 } = await reader.read();
      if (done) break;
      size += value2.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {
        });
        throw new TransportError("STT response exceeded the size limit.");
      }
      chunks.push(value2);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TransportError("STT service returned invalid JSON.");
  }
  if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") {
    throw new TransportError("STT response did not contain a transcript.");
  }
  return value.text;
}
async function transcribeAudio(input, options = {}, signal) {
  const config = resolveOptions(options);
  const extension = Object.hasOwn(MIME_EXTENSIONS, input.mimeType) ? MIME_EXTENSIONS[input.mimeType] : void 0;
  if (!extension) throw new TransportError("Unsupported recording format.");
  if (!Array.isArray(input.audio) || input.audio.length === 0 || input.audio.length > MAX_AUDIO_BYTES) {
    throw new TransportError("Recording must contain valid audio bytes and be at most 20 MiB.");
  }
  for (const byte of input.audio) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TransportError("Recording must contain valid audio bytes.");
    }
  }
  if (typeof input.apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(input.apiKey)) {
    throw new TransportError("A valid STT API key is required.");
  }
  if (signal?.aborted) throw new TransportError("Transcription cancelled.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 6e4);
  try {
    const body = new FormData();
    body.append(
      "file",
      new Blob([Uint8Array.from(input.audio)], { type: input.mimeType }),
      `dictation.${extension}`
    );
    body.append("model", config.model);
    body.append("temperature", "0");
    if (config.language) body.append("language", config.language);
    let response;
    try {
      response = await fetch(config.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.apiKey}` },
        body,
        redirect: "error",
        signal: controller.signal
      });
    } catch {
      throw new TransportError("STT request failed. Check the configured endpoint and connection.");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {
      });
      throw new TransportError(`STT service returned HTTP ${response.status}.`);
    }
    try {
      const text = await readResponse(response);
      if (controller.signal.aborted) throw new TransportError("Transcription cancelled.");
      return text;
    } catch (error) {
      const safe = error instanceof TransportError;
      throw new TransportError(safe ? error.message : "STT response could not be read.");
    }
  } catch (error) {
    if (timedOut) throw new TransportError("STT request timed out after 60 seconds.");
    if (controller.signal.aborted) throw new TransportError("Transcription cancelled.");
    throw error instanceof TransportError ? error : new TransportError("STT request failed.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

// gui.js
var Speech = import_gui.Ipc.define({
  id: "opencode-desktop-voice-input.speech",
  methods: {
    transcribe: {
      input: import_effect.Schema.Struct({
        audio: import_effect.Schema.Array(import_effect.Schema.Number),
        mimeType: import_effect.Schema.String,
        apiKey: import_effect.Schema.String
      }),
      output: import_effect.Schema.String
    }
  }
});
var gui_default = import_gui.Plugin.define({
  setup(ctx) {
    if (ctx.app.platform !== "desktop") return;
    if (ctx.app.version !== "2.2.5") {
      ctx.toast.show({
        title: "Voice plugin: this experimental GUI API is tested only with OpenCode 2.2.5.",
        variant: "error"
      });
      return;
    }
    let configured;
    try {
      configured = resolveOptions(ctx.options);
    } catch {
      ctx.toast.show({
        title: "Voice plugin: invalid endpoint, model or language configuration.",
        variant: "error"
      });
      return;
    }
    let composing = false;
    const [state, setState] = (0, import_solid_js.createSignal)("idle");
    const [text, setText] = (0, import_solid_js.createSignal)("");
    const startComposition = () => {
      composing = true;
    };
    const endComposition = () => {
      composing = false;
    };
    document.addEventListener("compositionstart", startComposition, true);
    document.addEventListener("compositionend", endComposition, true);
    document.addEventListener("focusout", endComposition, true);
    const dictation = createDictation({
      capture() {
        const session = ctx.sessions.current();
        const screen = ctx.screen.current();
        if (!session || session.pending || !screen?.composer.quotable()) return;
        return {
          key: session.key,
          visit: session.visit,
          screen,
          insert: (value) => screen.composer.insert(value),
          focus: () => screen.composer.focus()
        };
      },
      composing: () => composing,
      authorize: () => ctx.dialogs.prompt({
        title: "Voice input: speech-provider API key",
        description: `Stop & transcribe sends your recording to ${configured.endpoint} using ${configured.model}. Provider charges may apply. The key stays in this window's memory only; Cancel never uploads audio.`,
        secret: true,
        submit: "Use key for this window"
      }),
      async transcribe(blob, apiKey, signal) {
        const audio = Array.from(new Uint8Array(await blob.arrayBuffer()));
        if (signal.aborted) throw new Error("Cancelled");
        return ctx.main(Speech).transcribe(
          { audio, mimeType: blob.type, apiKey },
          {
            signal: AbortSignal.any([signal, ctx.signal, AbortSignal.timeout(65e3)])
          }
        );
      },
      changed(next, transcript) {
        setState(next);
        setText(transcript);
      },
      notify: (message) => ctx.toast.show({ title: message })
    });
    async function review() {
      if (dictation.state() !== "review") return;
      const revision = dictation.revision();
      const accepted = await ctx.dialogs.confirm({
        title: "Review voice transcript",
        description: dictation.transcript(),
        confirm: "Insert into draft (do not send)",
        cancel: "Keep for later"
      });
      if (accepted && revision === dictation.revision()) dictation.insert();
    }
    (0, import_solid_js.createEffect)(() => {
      ctx.sessions.current()?.visit;
      ctx.screen.current()?.composer.quotable();
      dictation.checkTarget();
    });
    const onPageHide = () => dictation.clearKey();
    window.addEventListener("pagehide", onPageHide);
    ctx.add(import_gui.Command, () => ({
      id: "toggle",
      hidden: true,
      title: state() === "recording" ? "Voice: stop and transcribe" : "Voice: start recording",
      section: "prompt",
      bind: "ctrl+shift+space",
      editable: true,
      enabled: state() === "idle" || state() === "recording",
      run() {
        if (composing || state() === "idle" && !ctx.screen.current()?.composer.focused())
          return false;
        return state() === "recording" ? dictation.stop() : dictation.start();
      }
    }));
    ctx.add(import_gui.Command, () => ({
      id: "start",
      title: "Voice: start recording",
      section: "prompt",
      enabled: state() === "idle",
      run: dictation.start
    }));
    ctx.add(import_gui.Command, () => ({
      id: "cancel",
      title: "Voice: cancel and discard",
      section: "prompt",
      enabled: state() !== "idle",
      run: dictation.cancel
    }));
    ctx.add(import_gui.Command, () => ({
      id: "insert",
      title: "Voice: insert reviewed transcript",
      section: "prompt",
      enabled: state() === "review",
      run: review
    }));
    ctx.add(import_gui.Command, {
      id: "clear-key",
      title: "Voice: forget API key and cancel",
      run: () => dictation.clearKey()
    });
    ctx.add(import_gui.ComposerPill, {
      id: "dictation",
      show(input) {
        if (!input.screen.composer.quotable()) return;
        const value = state();
        if (value === "idle") return { label: "Voice input", run: () => void dictation.start() };
        const rows = [];
        if (value === "recording")
          rows.push({
            id: "stop",
            label: "Stop & transcribe (send audio)",
            run: () => void dictation.stop()
          });
        if (value === "review") {
          rows.push({ id: "preview", label: text().slice(0, 160) });
          rows.push({
            id: "insert",
            label: "Insert transcript into current draft",
            run: review
          });
        }
        rows.push({ id: "cancel", label: "Cancel and discard", run: dictation.cancel });
        return {
          label: {
            starting: "Waiting for microphone\u2026",
            recording: "Recording\u2026",
            processing: "Transcribing\u2026",
            review: "Review transcript"
          }[value],
          rows
        };
      }
    });
    return () => {
      dictation.dispose();
      document.removeEventListener("compositionstart", startComposition, true);
      document.removeEventListener("compositionend", endComposition, true);
      document.removeEventListener("focusout", endComposition, true);
      window.removeEventListener("pagehide", onPageHide);
    };
  },
  main(ctx) {
    ctx.provide(Speech, {
      transcribe: (input, caller) => transcribeAudio(input, ctx.options, caller.signal)
    });
  }
});
