import { isTextControl } from "./text-control.js";

// Verified against dev 907b3bc and beta e5ecb571 (ADRs 0008 and 0009).
// The beta composer renamed both its form and editor; stable V2 retains prompt-input.
const EDITOR_SELECTOR =
  '[data-component="composer-editor"][contenteditable="true"], [data-component="prompt-input"][contenteditable="true"]';
const QUESTION_SELECTOR =
  'textarea[data-slot="question-custom-input"], [data-component="session-question-dock"] .question-custom-field input[data-slot="text-input-v2-input"]';
const COMPOSER_SELECTORS = [
  'form[data-component="composer"]',
  '[data-component="prompt-input-v2"]',
  '[data-component="session-prompt-dock"]',
  '[data-component="session-new-composer"]',
  '[data-component="session-composer"]',
];

export type InsertTarget = "composer" | "question";
export interface InputTarget {
  kind: InsertTarget;
  editor: HTMLElement | HTMLTextAreaElement | HTMLInputElement;
  composer: HTMLElement;
  url: string;
  question?: { root: HTMLElement; key: string };
}

function questionAvailable(editor: HTMLTextAreaElement | HTMLInputElement): boolean {
  if (editor.matches(":disabled") || editor.closest("fieldset:disabled") || editor.readOnly)
    return false;
  if (editor.closest('[inert], [hidden], [aria-hidden="true"], [data-disabled="true"]'))
    return false;
  for (let element: HTMLElement | null = editor; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return false;
    }
  }
  return true;
}

function questionTarget(): InputTarget | null {
  for (const editor of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    QUESTION_SELECTOR,
  )) {
    if (!questionAvailable(editor)) continue;
    const root = editor.closest<HTMLElement>('[data-component="session-question-dock"]');
    // V2.0.29+ keeps one input mounted across questions. Node/URL identity alone
    // cannot protect an asynchronous transcript from landing in the next question.
    const progress = root
      ? [...root.querySelectorAll('[data-slot="question-progress-segment"]')]
      : [];
    const key = JSON.stringify([
      root?.querySelector('[data-slot="question-text"]')?.textContent,
      root?.querySelector('[data-slot="question-options"]')?.getAttribute("aria-label"),
      progress.length,
      progress.findIndex((item) => item.matches('[data-active="true"], [aria-current="step"]')),
    ]);
    const composer =
      editor instanceof HTMLInputElement
        ? editor.closest<HTMLElement>('[data-slot="question-option"][data-custom="true"]')
        : editor.parentElement;
    if (composer)
      return {
        kind: "question",
        editor,
        composer,
        url: location.href,
        question: root ? { root, key } : undefined,
      };
  }
  return null;
}

export function isQuestionPromptOpen(): boolean {
  return questionTarget() !== null;
}

export function captureTarget(kind: InsertTarget = "composer"): InputTarget | null {
  if (kind === "question") {
    return questionTarget();
  }
  if (isQuestionPromptOpen()) return null;
  for (const selector of COMPOSER_SELECTORS) {
    for (const composer of document.querySelectorAll<HTMLElement>(selector)) {
      if (composer.querySelector('[data-component="session-question-dock"]')) continue;
      const editor = composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
      if (editor) return { kind, editor, composer, url: location.href };
    }
  }
  return null;
}

export function isCurrentTarget(target: InputTarget): boolean {
  const current = captureTarget(target.kind);
  return (
    target.url === location.href &&
    current?.editor === target.editor &&
    current.composer === target.composer &&
    current.question?.root === target.question?.root &&
    current.question?.key === target.question?.key &&
    target.editor.isConnected
  );
}

export function insertText(text: string, target: InputTarget): boolean {
  if (!text.trim() || !isCurrentTarget(target)) return false;
  const { editor } = target;
  const transcript = editor instanceof HTMLInputElement ? text.replace(/[\r\n]+/g, " ") : text;
  editor.focus();
  if (!isCurrentTarget(target)) return false;
  const existing = isTextControl(editor) ? editor.value : editor.textContent;
  const append = `${existing && !/\s$/.test(existing) ? " " : ""}${transcript}`;
  if (isTextControl(editor)) {
    // Use the native setter and input event, so framework state sees the append.
    const prototype =
      editor instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return false;
    setter.call(editor, editor.value + append);
    editor.selectionStart = editor.selectionEnd = editor.value.length;
    editor.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: append }),
    );
    return true;
  }

  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  // Same insertion path as OpenCode V2's paste handler. Never replace innerHTML
  // or textContent: mentions and attachments must remain intact.
  let receivedInput = false;
  const onInput = () => {
    receivedInput = true;
  };
  editor.addEventListener("input", onInput);
  try {
    const before = editor.textContent;
    if (typeof document.execCommand === "function") {
      document.execCommand("insertText", false, append);
    }
    if (editor.textContent === before) {
      const node = document.createTextNode(append);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (!receivedInput) {
      editor.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: append }),
      );
    }
  } finally {
    editor.removeEventListener("input", onInput);
  }
  return true;
}

export function submitPrompt(target: InputTarget): boolean {
  if (target.kind !== "composer" || !isCurrentTarget(target)) return false;
  const button = target.composer.querySelector<HTMLButtonElement>(
    'button[data-action="composer-submit"], button[data-action="prompt-submit"]',
  );
  // Both layouts reuse their submit button for Stop and shell execution. The
  // beta IconButton uses a sprite instead of data-icon; do not guess from labels.
  const isSend =
    button?.matches('[data-icon="arrow-up"]') ||
    button?.querySelector('svg[data-slot="icon-svg"] use[href="#opencode-v2-icon-arrow-up"]');
  // Click only a verified Send icon in the original composer.
  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true" || !isSend)
    return false;
  button.click();
  return true;
}
