# Compatibility — 2026-11-02

Latest stable OpenCode V2 is **2.2.5**, published 2026-10-30 23:17:23 UTC, tag commit `9bbb8ce18c80f099e0e448775f59d965ead40a21`. `/releases/latest` deliberately remains V1 for its updater; do not use it to decide the V2 target.

| Edition | Target / scope | Installation | Validation boundary |
|---|---|---|---|
| A: userscript 1.1.7 | Stable V2 / renamed beta composer; 2.2.5 old and new icon names | [Root guide](../README.md#-path-a--tampermonkey-quick-start) | Mock unit/DOM contracts; new-icon browser project added, not run successfully in this workspace |
| B: server injection 0.6.2 | Same UI adapters, current and legacy question inputs; retains Caddy subpath/SSE/WebSocket routing | [Server guide](../server/README.md) | Shared unit contracts; Bun/server/browser integration not run in this workspace |
| C: Desktop GUI 0.1.0 | Exact 2.2.5, existing session composer; SDK experimental | [Desktop guide](../desktop/README.md) | Mock controller/transport/SDK contracts; real Desktop and full SDK typecheck not run |

Existing V2 editor dialects, exact Send guards and question identity checks are retained. The 2.2.5 **New icons** experiment changes the Send sprite to `#opencode-v2-icon-new-arrow-up`; the new shared guard accepts only that and the legacy arrow-up, never Stop/shell icons. [Decision and source](decisions/0013-v225-new-icons.md).

Native voice-call code exists, but `VoiceComposer` requires Desktop + a non-prod channel + the `voice.calls` experiment (default off). Stable Desktop maps latest to prod. Consequently no production-accessible native voice UI was found for either WebUI or stable Desktop; this is not a claim that upstream has no voice implementation.

## Executed checks

- WebUI unit/DOM suite: **176 passed**; coverage **85.71% lines, 89.95% branches, 84.09% functions**.
- Desktop isolated suite: **69 passed** (24 controller, 34 transport, 11 built-CJS mocked host, including interrupted-IME focusout recovery).
- Repository Biome, root TypeScript, server TypeScript, Knip, userscript build, Desktop core strict TypeScript, Desktop CJS build and `git diff --check`: passed.
- `npm run check` is **not a full pass**: browser stage blocked as below; the supported independent Desktop suite passed. No full SDK dependency/type integration was installed.

## Runtime boundaries

- Chromium launch in this cloud workspace was rejected by sandbox IPC restrictions. The one escalation attempt failed environment setup (`bwrap` read-only filesystem) before test execution. No bypass or forbidden-file access attempted. Added browser regressions must be run on a working browser runner.
- Bun is unavailable in the checked runtime locations, so service integration, Caddy routing, SSE/WebSocket/reconnect and actual OpenCode server tests are **not verified here**. Existing route logic was not modified.
- Desktop's real Electron loader, OS microphone grant/deny/revoke, device removal, background/unload behavior and remote-server reconnect remain manual acceptance checks. Mock tests are not a substitute.
- No real STT calls, microphones, API keys, persistent credential changes, installs, live OrangePi changes, pushes or deployments.

## Manual acceptance checklist

Use a non-sensitive phrase and your own authorized STT account only after reviewing costs and endpoint.

- A/B: current 2.2.5 old/new icons, normal/new session and question input, mentions/attachments, IME, selected text, narrow layout, scoped URL/subpath; Start/Stop/Cancel and permission denial; no Stop/shell click.
- A/B: streaming response, disconnect/reconnect, back/forward, session switch while recording/transcribing, custom question changes, focus/caret retention, hotkey repetition. Preserve Caddy direct SSE/WebSocket paths.
- C: local directory installation in Desktop background-server global config; native pill and palette; shortcut only in composer; full review; shell/subagent excluded; draft unchanged until confirmation; attachments/selection preserved.
- C: OS permission deny/pending grant+Cancel/revoke; empty/device error; 401/429/5xx/timeout; cancellation during upload; route away-and-back/reconnect; reload/unload clears key and capture. Verify no ghost recordings, duplicate pill or stale insertion.

## Official sources

[2.2.5 release](https://github.com/anomalyco/opencode/releases/tag/v2.2.5), [V1 latest explanation](https://github.com/anomalyco/opencode/issues/57675), [tagged voice gating](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/app/src/voice/composer.tsx), [Desktop channel mapping](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/desktop/electron.vite.config.ts), [GUI plugin guide](https://github.com/anomalyco/opencode/blob/v2.2.5/services/www/src/docs/content/build/plugins/gui/index.mdx).
