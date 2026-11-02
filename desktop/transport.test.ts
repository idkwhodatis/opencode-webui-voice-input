// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AudioInput, resolveOptions, transcribeAudio } from "./transport";

const input: AudioInput = { audio: [1, 2, 3], mimeType: "audio/webm", apiKey: "test-key" };
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Desktop STT main transport", () => {
  it("sends bounded multipart audio to explicit endpoint without storing credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ text: "Hello" }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      transcribeAudio(input, {
        endpoint: "https://speech.example/v1/audio/transcriptions",
        model: "custom/model",
        language: "zh",
      }),
    ).resolves.toBe("Hello");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://speech.example/v1/audio/transcriptions");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ Authorization: "Bearer test-key" });
    expect(init.body.get("model")).toBe("custom/model");
    expect(init.body.get("language")).toBe("zh");
    expect(init.body.get("temperature")).toBe("0");
    const file = init.body.get("file") as File;
    expect(file.name).toBe("dictation.webm");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("defaults to Groq without inventing a credential or forcing language", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ text: "" }));
    vi.stubGlobal("fetch", fetch);
    await expect(transcribeAudio(input)).resolves.toBe("");
    expect(fetch.mock.calls[0][0]).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(fetch.mock.calls[0][1].body.get("language")).toBeNull();
  });

  it.each([
    "http://speech.example",
    "https://user:secret@speech.example",
    "https://speech.example/#secret",
    "file:///tmp/audio",
    "invalid",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => resolveOptions({ endpoint })).toThrow(/HTTPS/);
  });

  it.each([{ model: "" }, { language: "\nsecret" }, { endpoint: 42 }])(
    "rejects invalid options %s",
    (options) => {
      expect(() => resolveOptions(options)).toThrow();
    },
  );

  it.each([
    { ...input, audio: [] },
    { ...input, audio: [-1] },
    { ...input, audio: [256] },
    { ...input, audio: [0.5] },
    { ...input, audio: new Array(2) },
    { ...input, mimeType: "toString" },
    { ...input, mimeType: "text/html" },
    { ...input, apiKey: "secret\r\nheader" },
    { ...input, apiKey: "" },
  ])("rejects invalid input before network", async (invalid) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(transcribeAudio(invalid)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized audio before allocation or fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      transcribeAudio({ ...input, audio: new Array(20 * 1024 * 1024 + 1) }),
    ).rejects.toThrow(/20 MiB/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 429, 500])("does not surface provider error bodies for %s", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private transcript api key", { status })),
    );
    await expect(transcribeAudio(input)).rejects.toThrow(`STT service returned HTTP ${status}.`);
  });

  it("redacts network errors including endpoint, credentials, and redirect destinations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("secret-key https://private.example")),
    );
    await expect(transcribeAudio(input)).rejects.toThrow(
      "STT request failed. Check the configured endpoint and connection.",
    );
  });

  it.each([
    new Response("secret text", { headers: { "Content-Type": "text/html" } }),
    new Response("secret text", { headers: { "Content-Type": "application/json" } }),
    json({ message: "secret text" }),
    json({ text: 42 }),
  ])("rejects malformed or non-transcript responses without exposing content", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(transcribeAudio(input)).rejects.not.toThrow("secret text");
  });

  it("bounds streamed response even without content-length", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { headers: { "Content-Type": "application/json" } }),
        ),
    );
    await expect(transcribeAudio(input)).rejects.toThrow(/size limit/);
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects declared oversized response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{}", {
          headers: { "Content-Type": "application/json", "Content-Length": "1048577" },
        }),
      ),
    );
    await expect(transcribeAudio(input)).rejects.toThrow(/size limit/);
  });

  it("redacts response stream errors even if they imitate an application message", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error("STT response secret-key"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { headers: { "Content-Type": "application/json" } }),
        ),
    );
    await expect(transcribeAudio(input)).rejects.toThrow("STT response could not be read.");
  });

  it("does not fetch after cancellation", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(transcribeAudio(input, {}, AbortSignal.abort())).rejects.toThrow(
      "Transcription cancelled.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates cancel and sanitizes the abort reason", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("private reason")));
          }),
      ),
    );
    const result = transcribeAudio(input, {}, controller.signal);
    controller.abort("secret");
    await expect(result).rejects.toThrow("Transcription cancelled.");
  });

  it("times out and cleans up after 60 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("private reason")));
          }),
      ),
    );
    const result = expect(transcribeAudio(input)).rejects.toThrow(
      "STT request timed out after 60 seconds.",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
