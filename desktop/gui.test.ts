import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Packaging/host contract smoke only: this is NOT the real OpenCode SDK runtime.
const bundle = readFileSync(new URL("./dist/gui-experimental.cjs", import.meta.url), "utf8");
type Definition = Record<string, unknown>;
interface PluginDefinition {
  setup(ctx: unknown): undefined | (() => void);
  main(ctx: unknown): void;
}
const Command = Symbol("Command");
const ComposerPill = Symbol("ComposerPill");

function load(globals: Record<string, unknown> = {}) {
  const module = { exports: {} as { default: PluginDefinition } };
  const ipc = vi.fn((value: Definition) => value);
  const require = (name: string) => {
    if (name === "@opencode/plugin/gui") {
      return {
        Command,
        ComposerPill,
        Plugin: { define: (value: unknown) => value },
        Ipc: { define: ipc },
      };
    }
    if (name === "effect") {
      return {
        Schema: {
          Struct: (value: unknown) => value,
          Array: (value: unknown) => [value],
          Number: "number",
          String: "string",
        },
      };
    }
    if (name === "solid-js") {
      return {
        createSignal(initial: unknown) {
          let value = initial;
          return [
            () => value,
            (next: unknown) => {
              value = next;
            },
          ];
        },
        createEffect: (effect: () => void) => effect(),
      };
    }
    throw new Error(`Unexpected bundled dependency: ${name}`);
  };
  runInNewContext(bundle, {
    module,
    exports: module.exports,
    require,
    URL,
    Blob,
    AbortController,
    AbortSignal,
    clearTimeout,
    setTimeout,
    ...globals,
  });
  return { plugin: module.exports.default, ipc };
}

function host(platform = "desktop", version = "2.2.5", options: unknown = {}) {
  const registrations: Array<{ token: symbol; definition: Definition | (() => Definition) }> = [];
  const document = new EventTarget();
  const window = new EventTarget();
  const addListener = vi.spyOn(document, "addEventListener");
  const removeListener = vi.spyOn(document, "removeEventListener");
  const removeWindowListener = vi.spyOn(window, "removeEventListener");
  const microphone = vi.fn();
  const prompt = vi.fn(async (): Promise<string | undefined> => undefined);
  const confirm = vi.fn(async () => true);
  const focused = vi.fn(() => true);
  const quotable = vi.fn(() => true);
  const screen = { composer: { quotable, focused, insert: vi.fn(), focus: vi.fn() } };
  const visit = {};
  const ctx = {
    app: { platform, version },
    options,
    signal: new AbortController().signal,
    sessions: { current: () => ({ key: "session-one", visit, pending: false }) },
    screen: { current: () => screen },
    toast: { show: vi.fn() },
    dialogs: { prompt, confirm },
    main: vi.fn(),
    add: vi.fn((token: symbol, definition: Definition | (() => Definition)) => {
      registrations.push({ token, definition });
    }),
  };
  return {
    ctx,
    document,
    window,
    microphone,
    prompt,
    confirm,
    screen,
    focused,
    quotable,
    registrations,
    addListener,
    removeListener,
    removeWindowListener,
  };
}

function command(registrations: ReturnType<typeof host>["registrations"], id: string): Definition {
  const definitions = registrations
    .filter((item) => item.token === Command)
    .map((item) => (typeof item.definition === "function" ? item.definition() : item.definition));
  const value = definitions.find((item) => item.id === id);
  if (!value) throw new Error(`Missing ${id}`);
  return value;
}

class SyntheticRecorder {
  static isTypeSupported() {
    return true;
  }
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["synthetic audio only"]) });
    this.onstop?.();
  }
}

async function reviewFixture() {
  const h = host();
  h.prompt.mockResolvedValue("TEST_ONLY_FAKE_KEY");
  const track = { stop: vi.fn() };
  h.microphone.mockResolvedValue({ getTracks: () => [track] });
  const transcript = "Full reviewed transcript. ".repeat(12);
  const transcribe = vi.fn(async () => transcript);
  h.ctx.main.mockReturnValue({ transcribe });
  const { plugin } = load({
    document: h.document,
    window: h.window,
    navigator: { mediaDevices: { getUserMedia: h.microphone } },
    MediaRecorder: SyntheticRecorder,
  });
  const cleanup = plugin.setup(h.ctx);
  await (command(h.registrations, "toggle").run as () => unknown)();
  expect(h.microphone).toHaveBeenCalledOnce();
  await (command(h.registrations, "toggle").run as () => unknown)();
  expect(transcribe).toHaveBeenCalledOnce();
  expect(command(h.registrations, "insert").enabled).toBe(true);
  return { ...h, cleanup, transcript, transcribe, track };
}

describe("built experimental GUI entry contract", () => {
  it("evaluates in main without document, window, navigator or microphone globals", () => {
    const { plugin, ipc } = load();
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.main).toBe("function");
    expect(ipc).toHaveBeenCalledOnce();
    expect(ipc.mock.calls[0][0].id).toBe("opencode-desktop-voice-input.speech");
  });

  it("main provides the same typed IPC namespace without starting a recording or request", () => {
    const { plugin, ipc } = load();
    const provide = vi.fn();
    plugin.main({ provide, options: {} });
    expect(provide).toHaveBeenCalledOnce();
    expect(provide.mock.calls[0][0]).toBe(ipc.mock.results[0].value);
    expect(typeof provide.mock.calls[0][1].transcribe).toBe("function");
    expect(Object.keys(ipc.mock.calls[0][0].methods as object)).toEqual(["transcribe"]);
  });

  it("does not register browser WebUI controls or request permissions", () => {
    const { plugin } = load();
    const { ctx } = host("web");
    expect(plugin.setup(ctx)).toBeUndefined();
    expect(ctx.add).not.toHaveBeenCalled();
    expect(ctx.dialogs.prompt).not.toHaveBeenCalled();
    expect(ctx.toast.show).not.toHaveBeenCalled();
  });

  it("refuses an unverified experimental SDK version before touching browser globals", () => {
    const { plugin } = load();
    const { ctx } = host("desktop", "2.2.4");
    expect(plugin.setup(ctx)).toBeUndefined();
    expect(ctx.add).not.toHaveBeenCalled();
    expect(ctx.toast.show).toHaveBeenCalledOnce();
  });

  it("rejects invalid endpoint configuration before mounting controls", () => {
    const { plugin } = load();
    const { ctx } = host("desktop", "2.2.5", { endpoint: "http://provider.test/stt" });
    expect(plugin.setup(ctx)).toBeUndefined();
    expect(ctx.add).not.toHaveBeenCalled();
    expect(ctx.toast.show).toHaveBeenCalledOnce();
  });

  it("registers one pill and five commands without requesting microphone or API key", () => {
    const h = host();
    const { plugin } = load({
      document: h.document,
      window: h.window,
      navigator: { mediaDevices: { getUserMedia: h.microphone } },
    });
    const cleanup = plugin.setup(h.ctx);
    expect(h.registrations.filter((item) => item.token === Command)).toHaveLength(5);
    expect(h.registrations.filter((item) => item.token === ComposerPill)).toHaveLength(1);
    expect(command(h.registrations, "toggle").bind).toBe("ctrl+shift+space");
    expect(h.microphone).not.toHaveBeenCalled();
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.ctx.main).not.toHaveBeenCalled();
    cleanup?.();
    expect(h.addListener).toHaveBeenCalledTimes(3);
    expect(h.removeListener).toHaveBeenCalledWith("compositionstart", expect.any(Function), true);
    expect(h.removeListener).toHaveBeenCalledWith("compositionend", expect.any(Function), true);
    expect(h.removeWindowListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
  });

  it("leaves hotkeys alone during IME composition or when another field has focus", () => {
    const h = host();
    const { plugin } = load({ document: h.document, window: h.window });
    const cleanup = plugin.setup(h.ctx);
    const run = command(h.registrations, "toggle").run as () => unknown;
    h.document.dispatchEvent(new Event("compositionstart"));
    expect(run()).toBe(false);
    h.document.dispatchEvent(new Event("compositionend"));
    h.focused.mockReturnValue(false);
    expect(run()).toBe(false);
    expect(h.prompt).not.toHaveBeenCalled();
    cleanup?.();
  });
  it("restores recording after interrupted composition focusout without bypassing active IME", async () => {
    const h = host();
    h.prompt.mockResolvedValue("TEST_ONLY_FAKE_KEY");
    const track = { stop: vi.fn() };
    h.microphone.mockResolvedValue({ getTracks: () => [track] });
    const { plugin } = load({
      document: h.document,
      window: h.window,
      navigator: { mediaDevices: { getUserMedia: h.microphone } },
      MediaRecorder: SyntheticRecorder,
    });
    const cleanup = plugin.setup(h.ctx);
    const toggle = command(h.registrations, "toggle").run as () => unknown;
    try {
      h.document.dispatchEvent(new Event("compositionstart"));
      expect(toggle()).toBe(false);
      await (command(h.registrations, "start").run as () => unknown)();
      expect(h.prompt).not.toHaveBeenCalled();
      expect(h.microphone).not.toHaveBeenCalled();
      // No compositionend: focus left the input while IME was still active.
      h.document.dispatchEvent(new Event("focusout"));
      await toggle();
      expect(h.prompt).toHaveBeenCalledOnce();
      expect(h.microphone).toHaveBeenCalledOnce();
      expect(command(h.registrations, "toggle").title).toBe("Voice: stop and transcribe");
      expect(h.ctx.main).not.toHaveBeenCalled();
    } finally {
      cleanup?.();
    }
    expect(track.stop).toHaveBeenCalled();
  });

  it("restores reviewed insertion after interrupted composition focusout", async () => {
    const h = await reviewFixture();
    const insert = command(h.registrations, "insert").run as () => unknown;
    try {
      h.document.dispatchEvent(new Event("compositionstart"));
      await insert();
      expect(h.confirm).toHaveBeenCalledOnce();
      expect(h.screen.composer.insert).not.toHaveBeenCalled();
      expect(command(h.registrations, "insert").enabled).toBe(true);
      // Accepting the dialog must not bypass active composition; focusout restores it.
      h.document.dispatchEvent(new Event("focusout"));
      await insert();
      expect(h.confirm).toHaveBeenCalledTimes(2);
      expect(h.screen.composer.insert).toHaveBeenCalledExactlyOnceWith(h.transcript);
      expect(h.screen.composer.focus).toHaveBeenCalledOnce();
    } finally {
      h.cleanup?.();
    }
  });

  it("shows the full transcript before explicit draft-only insertion", async () => {
    const h = await reviewFixture();
    try {
      expect(h.screen.composer.insert).not.toHaveBeenCalled();
      await (command(h.registrations, "insert").run as () => unknown)();
      expect(h.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          description: h.transcript,
          confirm: "Insert into draft (do not send)",
        }),
      );
      expect(h.screen.composer.insert).toHaveBeenCalledExactlyOnceWith(h.transcript);
      expect(h.screen.composer.focus).toHaveBeenCalledOnce();
      expect(h.track.stop).toHaveBeenCalled();
    } finally {
      h.cleanup?.();
    }
  });

  it("ignores a late accepted review after cancellation", async () => {
    const h = await reviewFixture();
    try {
      let accept: ((value: boolean) => void) | undefined;
      h.confirm.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            accept = resolve;
          }),
      );
      const pending = (command(h.registrations, "insert").run as () => Promise<void>)();
      expect(h.confirm).toHaveBeenCalledOnce();
      (command(h.registrations, "cancel").run as () => void)();
      accept?.(true);
      await pending;
      expect(h.screen.composer.insert).not.toHaveBeenCalled();
    } finally {
      h.cleanup?.();
    }
  });
});
