import { Command, ComposerPill, Ipc, Plugin } from "@opencode/plugin/gui";
import { Schema } from "effect";
import { createEffect, createSignal } from "solid-js";
import { createDictation } from "./controller";
import { resolveOptions, transcribeAudio } from "./transport";

const Speech = Ipc.define({
  id: "opencode-desktop-voice-input.speech",
  methods: {
    transcribe: {
      input: Schema.Struct({
        audio: Schema.Array(Schema.Number),
        mimeType: Schema.String,
        apiKey: Schema.String,
      }),
      output: Schema.String,
    },
  },
});

export default Plugin.define({
  setup(ctx) {
    if (ctx.app.platform !== "desktop") return;
    if (ctx.app.version !== "2.2.5") {
      ctx.toast.show({
        title: "Voice plugin: this experimental GUI API is tested only with OpenCode 2.2.5.",
        variant: "error",
      });
      return;
    }
    let configured;
    try {
      configured = resolveOptions(ctx.options);
    } catch {
      ctx.toast.show({
        title: "Voice plugin: invalid endpoint, model or language configuration.",
        variant: "error",
      });
      return;
    }
    let composing = false;
    const [state, setState] = createSignal("idle");
    const [text, setText] = createSignal("");
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
          focus: () => screen.composer.focus(),
        };
      },
      composing: () => composing,
      authorize: () =>
        ctx.dialogs.prompt({
          title: "Voice input: speech-provider API key",
          description: `Stop & transcribe sends your recording to ${configured.endpoint} using ${configured.model}. Provider charges may apply. The key stays in this window's memory only; Cancel never uploads audio.`,
          secret: true,
          submit: "Use key for this window",
        }),
      async transcribe(blob, apiKey, signal) {
        const audio = Array.from(new Uint8Array(await blob.arrayBuffer()));
        if (signal.aborted) throw new Error("Cancelled");
        return ctx.main(Speech).transcribe(
          { audio, mimeType: blob.type, apiKey },
          {
            signal: AbortSignal.any([signal, ctx.signal, AbortSignal.timeout(65_000)]),
          },
        );
      },
      changed(next, transcript) {
        setState(next);
        setText(transcript);
      },
      notify: (message) => ctx.toast.show({ title: message }),
    });
    async function review() {
      if (dictation.state() !== "review") return;
      const revision = dictation.revision();
      const accepted = await ctx.dialogs.confirm({
        title: "Review voice transcript",
        description: dictation.transcript(),
        confirm: "Insert into draft (do not send)",
        cancel: "Keep for later",
      });
      if (accepted && revision === dictation.revision()) dictation.insert();
    }
    // Session visit identity, not only session id, rejects away-and-back races.
    createEffect(() => {
      ctx.sessions.current()?.visit;
      ctx.screen.current()?.composer.quotable();
      dictation.checkTarget();
    });
    const onPageHide = () => dictation.clearKey();
    window.addEventListener("pagehide", onPageHide);
    ctx.add(Command, () => ({
      id: "toggle",
      hidden: true,
      title: state() === "recording" ? "Voice: stop and transcribe" : "Voice: start recording",
      section: "prompt",
      bind: "ctrl+shift+space",
      editable: true,
      enabled: state() === "idle" || state() === "recording",
      run() {
        if (composing || (state() === "idle" && !ctx.screen.current()?.composer.focused()))
          return false;
        return state() === "recording" ? dictation.stop() : dictation.start();
      },
    }));
    ctx.add(Command, () => ({
      id: "start",
      title: "Voice: start recording",
      section: "prompt",
      enabled: state() === "idle",
      run: dictation.start,
    }));
    ctx.add(Command, () => ({
      id: "cancel",
      title: "Voice: cancel and discard",
      section: "prompt",
      enabled: state() !== "idle",
      run: dictation.cancel,
    }));
    ctx.add(Command, () => ({
      id: "insert",
      title: "Voice: insert reviewed transcript",
      section: "prompt",
      enabled: state() === "review",
      run: review,
    }));
    ctx.add(Command, {
      id: "clear-key",
      title: "Voice: forget API key and cancel",
      run: () => dictation.clearKey(),
    });
    ctx.add(ComposerPill, {
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
            run: () => void dictation.stop(),
          });
        if (value === "review") {
          rows.push({ id: "preview", label: text().slice(0, 160) });
          rows.push({
            id: "insert",
            label: "Insert transcript into current draft",
            run: review,
          });
        }
        rows.push({ id: "cancel", label: "Cancel and discard", run: dictation.cancel });
        return {
          label: {
            starting: "Waiting for microphone…",
            recording: "Recording…",
            processing: "Transcribing…",
            review: "Review transcript",
          }[value],
          rows,
        };
      },
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
      transcribe: (input, caller) => transcribeAudio(input, ctx.options, caller.signal),
    });
  },
});
