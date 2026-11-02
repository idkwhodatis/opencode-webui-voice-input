import { type AudioRecorder, createAudioRecorder } from "../src/audio";

export type State = "idle" | "starting" | "recording" | "processing" | "review";
export interface Target {
  key: string;
  visit: object;
  screen: object;
  insert(text: string): void;
  focus(): void;
}
export interface Host {
  capture(): Target | undefined;
  composing(): boolean;
  authorize(): Promise<string | undefined>;
  transcribe(blob: Blob, key: string, signal: AbortSignal): Promise<string>;
  changed(state: State, transcript: string): void;
  notify(message: string): void;
  recorder?(onError: (message: string) => void): AudioRecorder;
}

// No DOM selectors, draft replacement, auto-send, storage or network in this layer.
export function createDictation(host: Host) {
  let state: State = "idle";
  let transcript = "";
  let target: Target | undefined;
  let recorder: AudioRecorder | undefined;
  let request: AbortController | undefined;
  let generation = 0;
  let key = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const getState = (): State => state;
  const change = (next: State) => {
    state = next;
    host.changed(state, transcript);
  };
  const current = () => {
    const now = host.capture();
    return (
      !!target &&
      now?.key === target.key &&
      now.visit === target.visit &&
      now.screen === target.screen
    );
  };
  function cancel() {
    generation++;
    clearTimeout(timer);
    recorder?.cancel();
    request?.abort();
    recorder = undefined;
    request = undefined;
    target = undefined;
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
      // Never automatically upload at the limit: discard instead.
      timer = setTimeout(() => {
        if (own !== generation) return;
        cancel();
        host.notify("Recording reached the 120-second limit and was discarded.");
      }, 120_000);
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
      recorder = undefined;
      request = undefined;
      change("review");
    } catch {
      if (own === generation && !controller.signal.aborted) {
        cancel();
        host.notify(
          "Transcription failed. Check the provider, connection and API key; no text was inserted.",
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
    // SDK insert preserves selected text, mentions and attachments; never setText.
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
    transcript: () => transcript,
  };
}
