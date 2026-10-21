# ADR 0012: Support OpenCode V2's persistent question input

- Date: 2026-10-21
- Status: Accepted
- Userscript version: 1.1.6
- Server version: 0.6.1

## Evidence

OpenCode [PR #54822](https://github.com/anomalyco/opencode/pull/54822), first
included in v2.0.29, replaced the custom-answer textarea with `TextInput`.
The implementation remains unchanged in v2.1.2, commit
[`a517687`](https://github.com/anomalyco/opencode/tree/a517687fde98a7329ada3ae644a01a9fc6c4e99e).

- [Question dock](https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/app/src/session/requests/session-question-dock.tsx#L659-L755): the input remains mounted across question tabs, and minimized options are inert.
- [TextInput](https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/ui/src/forms/text-input/text-input.tsx#L50-L73): renders a native single-line input with `data-slot="text-input-v2-input"` inside `.question-custom-field`.
- [Request ownership](https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/app/src/session/composer/session-composer-region.tsx#L40-L46): keyed request rendering remounts the dock for a new request.

## Decision

Keep the legacy textarea adapter and add a question-dock-scoped native input
adapter. Share text-control detection for native value setters, selection offsets
and draft snapshots; flatten transcript line breaks only for single-line inputs.
Do not use DOM Range or innerHTML to write an input's value.

Capture the question root, visible question text, options label and active tab
index with each target. Recheck them before insertion and after focus, and include
them in caret bookmark identity. Observe relevant question mutations so both
recording and pending transcription cancel on a tab/context change. Disabled,
readonly, minimized/inert and hidden questions are not eligible. This relies on
the verified keyed request mount rather than inventing an unavailable request ID.

Place controls beside the compact custom-answer field as a flex sibling, instead
of overlaying the input. Question answers remain drafts and never auto-submit,
including when userscript auto-submit is enabled for the main composer.

Separately, increase the server direct-send initial settling delay from 5 ms to
10 ms as requested. Preserve the 1.5-second total readiness budget, 50 ms
pre-dispatch readiness polling, all cancellation/intent guards, and no retry after
a dispatched click.

## Verification

Regression coverage includes native input insertion/events, selection replacement,
user edits during transcription, same-node question switches (including repeated
labels), same-draft bookmark isolation, focus-time context changes, inert/hidden/
disabled fields, draft-only behavior, and the 9 ms / 10 ms send boundary.

Browser fixtures exercise the current question DOM, keyboard start/stop, pending
transcript cancellation and compact mobile geometry using synthetic audio and a
mocked endpoint. Browser execution requires a host that permits Chromium and a
loopback fixture server; source/unit results do not establish a live deployment's
microphone/provider behavior.
