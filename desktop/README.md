# Path C — OpenCode Desktop voice plugin (experimental)

This is a **real GUI plugin**, not a userscript, backend-only plugin, modified OpenCode build, or Caddy injection. It uses the official `@opencode/plugin/gui` `ComposerPill`, `Command`, `Ipc` and `composer.insert()` APIs.

## Compatibility and limits

- **OpenCode Desktop 2.2.5 only**, Windows/macOS/Linux. Other versions show a warning and disable the window entry rather than guess an experimental API. GUI plugins debuted in 2.2.0, but this package has not been verified against 2.2.0–2.2.4.
- Source contract verified at OpenCode tag `v2.2.5`, commit `9bbb8ce18c80f099e0e448775f59d965ead40a21`.
- Existing session composers only. The host SDK does not expose a composer on Home/new-session drafts. Question-answer inputs are not exposed by this SDK; use the existing WebUI edition for those.
- Native voice-call source exists upstream, but is gated to **non-production Desktop** plus the experimental `voice.calls` toggle; WebUI is excluded. This plugin does not enable/bypass that feature.
- No automatic submit. Streaming replies are not stopped; dictation inserts into the next draft only after explicit review. Shell-mode and subagent composers are excluded.
- No Caddy, Bun service, extra listener, browser extension, or OpenCode binary patch needed. Do not also inject Path A/B into the Desktop renderer.

## Install locally

The `desktop/dist/gui-experimental.cjs` bundle is committed. Keep the entire `desktop/` directory at a stable absolute path. Add it to the **global configuration of Desktop's own background server**, normally `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/opencode-webui-voice-input/desktop",
      "options": {
        "endpoint": "https://api.groq.com/openai/v1/audio/transcriptions",
        "model": "whisper-large-v3-turbo",
        "language": ""
      }
    }
  ]
}
```

On Windows use an absolute JSON path such as `C:/Users/you/plugins/opencode-webui-voice-input/desktop`. The config key is **`plugins`**, plural. Configure the directory, **not the CJS file**. A plugin configured only on a remote OpenCode server is not a Desktop GUI installation. Preserve unrelated configuration entries.

Restart Desktop, then check **Settings → Extensions → Plugins**. Enable its GUI if disabled. An existing session shows the **Voice input** pill above its composer. To uninstall, remove this plugin entry or switch its GUI off in Extensions; recording and requests are cancelled on unload. Local bundle rebuilds are watched by the host. No npm publication or install into a real Desktop was performed for this change.

## Use and privacy

1. Open an existing session. Click **Voice input**, use **Voice: start recording** in the palette, or press **Ctrl+Shift+Space** while the composer has focus. The shortcut is editable under Settings → Shortcuts. It intentionally differs from Path A/B's Ctrl+Space.
2. On first use in each window, the native secret dialog displays the exact HTTPS destination/model and asks for your provider API key. Cancelling does not start recording. The key stays **in that window's memory only**. Never put it in plugin options, a source file or a committed config.
3. Approve microphone permission yourself if prompted. The plugin never changes OS/Electron permissions. macOS/Windows/Linux permissions and audio backend behavior require verification on your actual Desktop.
4. **Stop & transcribe (send audio)** uploads to the disclosed provider; charges may apply. **Cancel and discard** never initiates an upload and aborts pending work. Aborting cannot retract bytes already sent to the provider. Recording has a 120-second discard limit and a 20 MiB upload limit.
5. **Review transcript** → **Insert transcript into current draft** opens the full transcript in the host confirmation dialog. Confirming inserts at the composer's last caret without replacing selected text, mentions or attachments. Review the final draft and send yourself. Dismissing review keeps it for later; Cancel discards it.
6. **Voice: forget API key and cancel** clears the in-memory key. Closing/reloading the window or unloading the plugin also clears it. No audio/transcript/key is written to disk or logged by this plugin. Audio/transcripts necessarily exist temporarily in memory and the chosen STT service receives audio and authorization.

A custom endpoint must be a trusted HTTPS OpenAI-compatible audio transcription endpoint. It receives the API key and recording. Redirects, credentials embedded in a URL, and URL fragments are rejected. Provider/model/language changes are configured in options and reload the GUI. Network calls happen in Electron main through the typed plugin IPC, not a renderer CORS bypass or arbitrary proxy. Keys never persist in Electron main.

Session/server/visit changes (including away and back), plugin unload, Cancel, and pending microphone cancellation invalidate late results. IME composition blocks start/insertion; finish composing before confirming again. Transcription errors preserve the original draft, reveal no provider body/credential, and permit retry. Review buffers are discarded on navigation, rather than inserted into the wrong session.

## Build and verification

From the repository root with its existing dev dependencies installed:

```sh
npm run check:desktop
```

The build uses the repository's esbuild to emit one CJS file, externalizing the host's `@opencode/plugin/gui`, `effect`, and `solid-js`. There is no JSX, so a second Solid compiler/runtime is unnecessary. `typecheck:core` checks controller and transport only; **it is not a full SDK typecheck**. GUI APIs are manually checked against exact tagged upstream source and exercised with contract mocks. A real Desktop load/permission test is still required; mock success is not that result.

All automated STT/microphone tests are mocked: no actual recording, paid call, API key, real installation, live OpenCode/Pi change or deployment occurs. See [compatibility report](../docs/COMPATIBILITY.md) for exact validation boundaries.

## Official references

- [GUI plugin loading, API and package contract](https://github.com/anomalyco/opencode/blob/v2.2.5/services/www/src/docs/content/build/plugins/gui/index.mdx)
- [Composer insertion API](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/gui/host-apis.ts)
- [Native voice gating](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/app/src/voice/composer.tsx)
- [Desktop audio permission guard](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/desktop/src/main/windows/security.ts)
