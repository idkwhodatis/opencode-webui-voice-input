/** Main-process only. Never persist or log recordings, credentials, or transcripts. */
export interface AudioInput {
  audio: readonly number[];
  mimeType: string;
  apiKey: string;
}

export interface TransportOptions {
  endpoint?: unknown;
  model?: unknown;
  language?: unknown;
}

class TransportError extends Error {}

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm;codecs=opus": "webm",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg;codecs=opus": "ogg",
};

export function resolveOptions(options: TransportOptions = {}): {
  endpoint: string;
  model: string;
  language: string;
} {
  const endpoint = options.endpoint ?? "https://api.groq.com/openai/v1/audio/transcriptions";
  const model = options.model ?? "whisper-large-v3-turbo";
  const language = options.language ?? "";
  if (typeof endpoint !== "string") throw new TransportError("STT endpoint must be an HTTPS URL.");
  let url: URL;
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
  if (
    typeof language !== "string" ||
    !/^(?:[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)?$/.test(language)
  ) {
    throw new TransportError("Invalid STT language configuration.");
  }
  return { endpoint: url.href, model, language };
}

async function readResponse(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw new TransportError("STT response exceeded the size limit.");
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    void response.body?.cancel().catch(() => {});
    throw new TransportError("STT service did not return JSON.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TransportError("STT service returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new TransportError("STT response exceeded the size limit.");
      }
      chunks.push(value);
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
  let value: unknown;
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

/** Audio leaves the machine only through this explicit call after the user stops recording. */
export async function transcribeAudio(
  input: AudioInput,
  options: TransportOptions = {},
  signal?: AbortSignal,
): Promise<string> {
  const config = resolveOptions(options);
  const extension = Object.hasOwn(MIME_EXTENSIONS, input.mimeType)
    ? MIME_EXTENSIONS[input.mimeType]
    : undefined;
  if (!extension) throw new TransportError("Unsupported recording format.");
  if (
    !Array.isArray(input.audio) ||
    input.audio.length === 0 ||
    input.audio.length > MAX_AUDIO_BYTES
  ) {
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
  }, 60_000);
  try {
    const body = new FormData();
    body.append(
      "file",
      new Blob([Uint8Array.from(input.audio)], { type: input.mimeType }),
      `dictation.${extension}`,
    );
    body.append("model", config.model);
    body.append("temperature", "0");
    if (config.language) body.append("language", config.language);
    let response: Response;
    try {
      response = await fetch(config.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.apiKey}` },
        body,
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new TransportError("STT request failed. Check the configured endpoint and connection.");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new TransportError(`STT service returned HTTP ${response.status}.`);
    }
    try {
      const text = await readResponse(response);
      if (controller.signal.aborted) throw new TransportError("Transcription cancelled.");
      return text;
    } catch (error) {
      // Only expose our own fixed messages, never a provider body or network exception.
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
