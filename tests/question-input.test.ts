import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaretTracker, insertAtCaret } from "../server/caret";
import { draftSnapshot } from "../server/send";
import {
  captureTarget,
  insertText,
  isCurrentTarget,
  isQuestionPromptOpen,
  submitPrompt,
} from "../src/insert";
import { setupUI } from "../src/ui";
import { mountQuestionInput } from "./fixtures/composer";

let ui: ReturnType<typeof setupUI> | undefined;
let caret: ReturnType<typeof createCaretTracker> | undefined;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  history.replaceState({}, "", "/project/session");
  document.execCommand = vi.fn(() => false);
  mountQuestionInput();
});
afterEach(() => {
  ui?.destroy();
  caret?.destroy();
  ui = undefined;
  caret = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing fixture element: ${selector}`);
  return found;
}

function target() {
  const captured = captureTarget("question");
  if (!captured) throw new Error("Missing question fixture");
  return captured;
}
function switchQuestion(sameText = false) {
  const tabs = document.querySelectorAll<HTMLElement>('[data-slot="question-progress-segment"]');
  tabs[0].dataset.active = "false";
  tabs[0].removeAttribute("aria-current");
  tabs[1].dataset.active = "true";
  tabs[1].setAttribute("aria-current", "step");
  if (!sameText) {
    element('[data-slot="question-text"]').textContent = "Second question";
    element('[data-slot="question-options"]').setAttribute("aria-label", "Second question");
  }
}

describe("OpenCode 2.0.29+ custom answers", () => {
  it("captures only the scoped native text input and never sends a question", () => {
    const captured = target();
    expect(captured.editor).toBe(document.querySelector("input"));
    expect(captured.composer.matches('[data-slot="question-option"][data-custom="true"]')).toBe(
      true,
    );
    expect(isQuestionPromptOpen()).toBe(true);
    expect(captureTarget()).toBeNull();
    expect(submitPrompt(captured)).toBe(false);
    element('[data-component="session-question-dock"]').removeAttribute("data-component");
    expect(captureTarget("question")).toBeNull();
  });

  it("uses the native input value setter, preserves draft text, and notifies once", () => {
    const captured = target();
    const input = captured.editor as HTMLInputElement;
    input.value = "Existing";
    const handler = vi.fn();
    input.addEventListener("input", handler);
    expect(insertText("answer\nnext line", captured)).toBe(true);
    expect(input.value).toBe("Existing answer next line");
    expect(input.childNodes).toHaveLength(0);
    expect(input.selectionStart).toBe(input.value.length);
    expect(draftSnapshot(captured)).toBe(input.value);
    expect(handler).toHaveBeenCalledOnce();
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it.each(["disabled", "readonly", "inert", "hidden", "aria-hidden"])(
    "rejects %s questions",
    (attribute) => {
      const captured = target();
      const node =
        attribute === "disabled" || attribute === "readonly"
          ? captured.editor
          : element('[data-slot="question-options"]');
      node.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
      expect(captureTarget("question")).toBeNull();
      expect(isCurrentTarget(captured)).toBe(false);
      expect(insertText("must not write", captured)).toBe(false);
    },
  );

  it("rejects CSS-hidden and disabled-fieldset questions", () => {
    const captured = target();
    captured.composer.style.display = "none";
    expect(captureTarget("question")).toBeNull();
    captured.composer.style.display = "";
    const fieldset = document.createElement("fieldset");
    captured.composer.before(fieldset);
    fieldset.append(captured.composer);
    fieldset.disabled = true;
    expect(captureTarget("question")).toBeNull();
  });

  it.each([false, true])(
    "rejects a tab change retaining the exact input node (same labels: %s)",
    (sameText) => {
      const captured = target();
      switchQuestion(sameText);
      expect(captureTarget("question")?.editor).toBe(captured.editor);
      expect(isCurrentTarget(captured)).toBe(false);
      expect(insertText("old question answer", captured)).toBe(false);
    },
  );

  it("rejects a changed question without progress tabs", () => {
    element('[data-slot="question-progress"]').remove();
    const captured = target();
    element('[data-slot="question-text"]').childNodes[0].textContent = "New question";
    expect(isCurrentTarget(captured)).toBe(false);
  });

  it("rechecks the question after focus handlers switch it", () => {
    const captured = target();
    captured.editor.addEventListener("focus", () => switchQuestion(), { once: true });
    expect(insertText("wrong answer", captured)).toBe(false);
    expect((captured.editor as HTMLInputElement).value).toBe("");
  });

  it("mounts inline beside the compact input once and cancels promptly on context changes", async () => {
    const captured = target();
    const changed = vi.fn(() => isCurrentTarget(captured));
    ui = setupUI({ onToggle: vi.fn(), onCancel: vi.fn(), onContextChange: changed });
    const controls = element(".ocvd-container");
    expect(controls.dataset.layout).toBe("question-inline");
    expect(controls.parentElement).toBe(captured.composer);
    expect(controls.previousElementSibling?.matches(".question-custom-field")).toBe(true);
    expect(getComputedStyle(controls).position).toBe("static");
    ui.inject();
    await flush();
    expect(document.querySelectorAll(".ocvd-btn")).toHaveLength(1);
    changed.mockClear();
    switchQuestion(true);
    await flush();
    expect(changed).toHaveBeenCalled();
    expect(changed.mock.results.at(-1)?.value).toBe(false);
    element('[data-slot="question-options"]').setAttribute("inert", "");
    await flush();
    expect(document.querySelector(".ocvd-btn")).toBeNull();
  });
});

describe("native question caret and draft guards", () => {
  it("does not reuse a previous question's selection for an identical new draft", () => {
    const captured = target();
    const input = captured.editor as HTMLInputElement;
    input.value = "same draft";
    caret = createCaretTracker();
    input.focus();
    input.setSelectionRange(0, 4);
    caret.freeze(captured);
    input.blur();
    switchQuestion(true);
    const next = target();
    const bookmark = caret.freeze(next);
    expect(insertAtCaret("new answer", next, bookmark)).toEqual({
      inserted: true,
      fallback: false,
    });
    expect(input.value).toBe("same draft new answer");
  });

  it("replaces the selected input text through one native input event", () => {
    const captured = target();
    const input = captured.editor as HTMLInputElement;
    input.value = "before WRONG after";
    caret = createCaretTracker();
    input.focus();
    input.setSelectionRange(7, 12);
    const bookmark = caret.freeze(captured);
    const handler = vi.fn();
    input.addEventListener("input", handler);
    expect(insertAtCaret("right\nanswer", captured, bookmark)).toEqual({
      inserted: true,
      fallback: false,
    });
    expect(input.value).toBe("before right answer after");
    expect(input.selectionStart).toBe(19);
    expect(handler).toHaveBeenCalledOnce();
    expect(submitPrompt(captured)).toBe(false);
  });

  it("appends for review when the input value changes during transcription", () => {
    const captured = target();
    const input = captured.editor as HTMLInputElement;
    input.value = "before WRONG after";
    caret = createCaretTracker();
    input.focus();
    input.setSelectionRange(7, 12);
    const bookmark = caret.freeze(captured);
    input.value = "User edit";
    expect(insertAtCaret("transcript", captured, bookmark)).toEqual({
      inserted: true,
      fallback: true,
    });
    expect(input.value).toBe("User edit transcript");
  });

  it("discards a frozen transcript when the same input belongs to another question", () => {
    const captured = target();
    const input = captured.editor as HTMLInputElement;
    input.value = "first draft";
    caret = createCaretTracker();
    input.focus();
    input.setSelectionRange(0, 0);
    const bookmark = caret.freeze(captured);
    switchQuestion();
    input.value = "second draft";
    expect(insertAtCaret("old transcript", captured, bookmark)).toEqual({
      inserted: false,
      fallback: false,
    });
    expect(input.value).toBe("second draft");
  });
});
