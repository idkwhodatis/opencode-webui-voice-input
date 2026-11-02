import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioRecorder } from "../src/audio";
import { type Host, type Target, createDictation } from "./controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const target: Target = {
    key: "server/session",
    visit: {},
    screen: {},
    insert: vi.fn(),
    focus: vi.fn(),
  };
  let current: Target | undefined = target;
  const audio: AudioRecorder = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => new Blob(["synthetic audio"], { type: "audio/webm" })),
    cancel: vi.fn(),
    isRecording: vi.fn(() => true),
  };
  const host: Host = {
    capture: vi.fn(() => current),
    composing: vi.fn(() => false),
    authorize: vi.fn(async () => "memory-only-key"),
    transcribe: vi.fn(async () => "dictated text"),
    changed: vi.fn(),
    notify: vi.fn(),
    recorder: vi.fn(() => audio),
  };
  const controller = createDictation(host);
  return {
    target,
    audio,
    host,
    controller,
    route: (value: Target | undefined) => {
      current = value;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("Desktop dictation controller", () => {
  it("records, transcribes, then waits for explicit insert without replacing or sending a draft", async () => {
    const f = fixture();
    await f.controller.start();
    expect(f.controller.state()).toBe("recording");
    await f.controller.stop();
    expect(f.controller.state()).toBe("review");
    expect(f.controller.transcript()).toBe("dictated text");
    expect(f.target.insert).not.toHaveBeenCalled();
    expect(f.host.transcribe).toHaveBeenCalledWith(
      expect.any(Blob),
      "memory-only-key",
      expect.any(AbortSignal),
    );
    f.controller.insert();
    expect(f.target.insert).toHaveBeenCalledExactlyOnceWith("dictated text");
    expect(f.target.focus).toHaveBeenCalledOnce();
    expect(f.controller.state()).toBe("idle");
    expect(f.controller.transcript()).toBe("");
    f.controller.insert();
    expect(f.target.insert).toHaveBeenCalledOnce();
  });

  it("cancels pending microphone permission and releases a later stream without upload", async () => {
    const f = fixture();
    const permission = deferred<void>();
    vi.mocked(f.audio.start).mockReturnValue(permission.promise);
    const pending = f.controller.start();
    await Promise.resolve();
    expect(f.controller.state()).toBe("starting");
    f.controller.cancel();
    permission.resolve();
    await pending;
    expect(f.audio.cancel).toHaveBeenCalled();
    expect(f.controller.state()).toBe("idle");
    expect(f.host.transcribe).not.toHaveBeenCalled();
    expect(f.target.insert).not.toHaveBeenCalled();
  });

  it("cancels pending authorization and does not cache its late secret", async () => {
    const f = fixture();
    const authorization = deferred<string | undefined>();
    vi.mocked(f.host.authorize).mockReturnValueOnce(authorization.promise);
    const pending = f.controller.start();
    f.controller.cancel();
    authorization.resolve("late-secret");
    await pending;
    expect(f.audio.start).not.toHaveBeenCalled();
    await f.controller.start();
    expect(f.host.authorize).toHaveBeenCalledTimes(2);
    f.controller.cancel();
  });

  it("handles denied microphone with sanitized message and retry", async () => {
    const f = fixture();
    vi.mocked(f.audio.start).mockRejectedValueOnce(new Error("private-device-secret"));
    await f.controller.start();
    expect(f.controller.state()).toBe("idle");
    expect(f.audio.cancel).toHaveBeenCalled();
    expect(f.host.notify).toHaveBeenCalledWith(
      "Could not start recording. Check your microphone permission and device.",
    );
    await f.controller.start();
    expect(f.controller.state()).toBe("recording");
    f.controller.cancel();
  });

  it("latches repeated start and stop requests", async () => {
    const f = fixture();
    const stop = deferred<Blob>();
    vi.mocked(f.audio.stop).mockReturnValue(stop.promise);
    await Promise.all([f.controller.start(), f.controller.start()]);
    expect(f.audio.start).toHaveBeenCalledOnce();
    const pending = f.controller.stop();
    await f.controller.stop();
    expect(f.audio.stop).toHaveBeenCalledOnce();
    stop.resolve(new Blob(["mock audio"]));
    await pending;
    expect(f.host.transcribe).toHaveBeenCalledOnce();
  });

  it("cancels while recorder finalizes without uploading the late audio", async () => {
    const f = fixture();
    const stop = deferred<Blob>();
    vi.mocked(f.audio.stop).mockReturnValue(stop.promise);
    await f.controller.start();
    const pending = f.controller.stop();
    f.controller.cancel();
    stop.resolve(new Blob(["mock audio"]));
    await pending;
    expect(f.host.transcribe).not.toHaveBeenCalled();
    expect(f.controller.state()).toBe("idle");
  });

  it("aborts transcription and discards its late result", async () => {
    const f = fixture();
    const transcript = deferred<string>();
    vi.mocked(f.host.transcribe).mockReturnValue(transcript.promise);
    await f.controller.start();
    const pending = f.controller.stop();
    await Promise.resolve();
    const signal = vi.mocked(f.host.transcribe).mock.calls[0][2];
    f.controller.cancel();
    expect(signal.aborted).toBe(true);
    transcript.resolve("stale transcript");
    await pending;
    expect(f.controller.state()).toBe("idle");
    expect(f.controller.transcript()).toBe("");
    expect(f.target.insert).not.toHaveBeenCalled();
  });

  it.each(["recording", "review"])("cancels %s when switching routes", async (phase) => {
    const f = fixture();
    await f.controller.start();
    if (phase === "review") await f.controller.stop();
    f.route({ ...f.target, key: "server/other-session", visit: {} });
    f.controller.checkTarget();
    f.controller.insert();
    expect(f.controller.state()).toBe("idle");
    expect(f.target.insert).not.toHaveBeenCalled();
  });

  it("rejects away-and-back to the same session with a new visit identity", async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    f.route({ ...f.target, visit: {} });
    f.controller.insert();
    expect(f.controller.state()).toBe("idle");
    expect(f.target.insert).not.toHaveBeenCalled();
  });

  it("rejects a replaced screen even with the same route and visit", async () => {
    const f = fixture();
    await f.controller.start();
    f.route({ ...f.target, screen: {} });
    await f.controller.stop();
    expect(f.host.transcribe).not.toHaveBeenCalled();
    expect(f.controller.state()).toBe("idle");
  });

  it("drops result if route changes before completion without an observer tick", async () => {
    const f = fixture();
    const transcript = deferred<string>();
    vi.mocked(f.host.transcribe).mockReturnValue(transcript.promise);
    await f.controller.start();
    const pending = f.controller.stop();
    await Promise.resolve();
    f.route(undefined);
    transcript.resolve("stale");
    await pending;
    expect(f.controller.state()).toBe("idle");
    expect(f.target.insert).not.toHaveBeenCalled();
  });

  it("does not start in Home or while IME composition is active", async () => {
    const f = fixture();
    f.route(undefined);
    await f.controller.start();
    expect(f.host.authorize).not.toHaveBeenCalled();
    f.route(f.target);
    vi.mocked(f.host.composing).mockReturnValue(true);
    await f.controller.start();
    expect(f.audio.start).not.toHaveBeenCalled();
  });

  it("keeps review text during composition and allows later explicit insert", async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    vi.mocked(f.host.composing).mockReturnValue(true);
    f.controller.insert();
    expect(f.target.insert).not.toHaveBeenCalled();
    expect(f.controller.state()).toBe("review");
    vi.mocked(f.host.composing).mockReturnValue(false);
    f.controller.insert();
    expect(f.target.insert).toHaveBeenCalledOnce();
  });

  it.each([new Blob(), new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]), null as unknown as Blob])(
    "rejects empty, oversized or malformed recordings",
    async (blob) => {
      const f = fixture();
      vi.mocked(f.audio.stop).mockResolvedValue(blob);
      await f.controller.start();
      await f.controller.stop();
      expect(f.host.transcribe).not.toHaveBeenCalled();
      expect(f.controller.state()).toBe("idle");
    },
  );

  it.each(["  ", null as unknown as string, {} as unknown as string])(
    "rejects empty or malformed transcript",
    async (text) => {
      const f = fixture();
      vi.mocked(f.host.transcribe).mockResolvedValue(text);
      await f.controller.start();
      await f.controller.stop();
      expect(f.controller.state()).toBe("idle");
      expect(f.target.insert).not.toHaveBeenCalled();
    },
  );

  it("disposal releases resources, clears draft, and forbids future recording", async () => {
    const f = fixture();
    await f.controller.start();
    f.controller.dispose();
    await f.controller.start();
    expect(f.audio.start).toHaveBeenCalledOnce();
    expect(f.audio.cancel).toHaveBeenCalled();
    expect(f.controller.state()).toBe("idle");
  });

  it("clearKey cancels active work and asks for authorization next time", async () => {
    const f = fixture();
    await f.controller.start();
    f.controller.cancel();
    await f.controller.start();
    expect(f.host.authorize).toHaveBeenCalledOnce();
    f.controller.clearKey();
    await f.controller.start();
    expect(f.host.authorize).toHaveBeenCalledTimes(2);
    f.controller.cancel();
  });

  it("discards at the 120-second recording limit without uploading", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.controller.state()).toBe("idle");
    expect(f.audio.cancel).toHaveBeenCalled();
    expect(f.host.transcribe).not.toHaveBeenCalled();
    expect(f.host.notify).toHaveBeenCalledWith(
      "Recording reached the 120-second limit and was discarded.",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles recorder failure callback without revealing its error or uploading", async () => {
    const f = fixture();
    await f.controller.start();
    const recorder = f.host.recorder;
    if (!recorder) throw new Error("Missing test recorder");
    vi.mocked(recorder).mock.calls[0][0]("private hardware error");
    expect(f.controller.state()).toBe("idle");
    expect(f.host.notify).toHaveBeenCalledWith(
      "Microphone recording failed. Check microphone permission and try again.",
    );
    expect(f.host.transcribe).not.toHaveBeenCalled();
  });
});
