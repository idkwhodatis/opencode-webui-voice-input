# 0013 — OpenCode v2.2.5 optional New icons

## Evidence (2026-11-02)

Source tag `v2.2.5`, commit `9bbb8ce18c80f099e0e448775f59d965ead40a21`:

- [Composer](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/app/src/composer/editor/editor.tsx): `form[data-component="composer"]`, editable `composer-editor`, `composer-actions`, and `composer-submit` are retained. The submit icon remains `arrow-up`, `stop`, or `arrow-undo-down`; held submissions render a Loader. Input parses the editor and preserves attachment parts.
- [Icon rendering](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/ui/src/icons/icon/icon.tsx): the optional New icons experiment emits `#opencode-v2-icon-new-${name}` instead of the original sprite ID where artwork exists.
- [Classic questions](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/app/src/session/requests/session-question-dock-classic.tsx) and [experimental questions](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/app/src/session/requests/session-question-dock-experimental.tsx) retain `session-question-dock`, `question-text`, `question-options`, progress markers, custom option and `question-custom-field`.
- [TextInput](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/ui/src/forms/text-input/text-input.tsx) retains `text-input-v2-input` on the native input. No broad selector fallback is needed.

## Decision

Share one narrowly allowlisted Send-icon check between userscript submission, server Send readiness, and server native-action borrowing. Accept exactly the original and New icons `arrow-up` sprite IDs (plus the existing legacy data-icon). Never use substring matching or translated button labels: Stop, shell, busy Loader and unknown icons remain non-send actions.

Retain the existing composer detection order and question ownership/cancellation rules. Userscript and server injection remain separate installation paths.

## Verification boundary

Unit fixtures cover old V2, renamed composer and v2.2.5 New icons, including single-dispatch settlement and guarded native actions. Chromium runs the built userscript against all three source-shaped layouts; microphone and STT are mocked. These are contract regressions, not a full running OpenCode release or a real speech-provider test. No live deployment or microphone permission is changed.
