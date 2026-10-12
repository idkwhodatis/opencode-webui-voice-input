import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureTarget } from "../src/insert";
import { mountComposer, mountRenamedComposer } from "../tests/fixtures/composer";
import { sendDraft } from "./send";

const controllers: AbortController[] = [];

function setup(mount = mountRenamedComposer) {
  const editor = mount();
  editor.innerHTML = '<span data-mention="true" contenteditable="false">@context</span> old draft <img data-type="attachment" alt="image" src="data:,">';
  const target = captureTarget()!;
  const button = target.composer.querySelector<HTMLButtonElement>("button")!;
  // happy-dom has no layout; keep production visibility and click guards intact.
  vi.spyOn(button, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
  let nativeDraft = editor.textContent;
  editor.addEventListener("input", () => {
    const next = editor.textContent;
    setTimeout(() => { nativeDraft = next; }, 25);
  });
  const text = document.createTextNode(" new transcript");
  editor.append(text);
  const range = document.createRange();
  range.setStart(text, text.length);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text.textContent }));
  const clicked = vi.fn(() => nativeDraft);
  button.addEventListener("click", clicked);
  const controller = new AbortController();
  controllers.push(controller);
  return { target, editor, button, controller, clicked, text, start: () => sendDraft(target, controller.signal) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  history.replaceState({}, "", "/project/session");
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("server direct-send settle delay", () => {
  it.each([mountComposer, mountRenamedComposer])("waits 50 ms for the new native draft and dispatches once (%#)", async (mount) => {
    const fixture = setup(mount);
    const { editor, clicked, text } = fixture;
    const mention = editor.querySelector("[data-mention]");
    const attachment = editor.querySelector("[data-type=attachment]");
    const draft = editor.innerHTML;
    const result = fixture.start();
    await vi.advanceTimersByTimeAsync(49);
    expect(clicked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("sent");
    expect(clicked).toHaveBeenCalledOnce();
    expect(clicked.mock.results[0].value).toBe("@context old draft  new transcript");
    expect(editor.innerHTML).toBe(draft);
    expect(editor.querySelector("[data-mention]")).toBe(mention);
    expect(editor.querySelector("[data-type=attachment]")).toBe(attachment);
    expect(window.getSelection()!.anchorNode).toBe(text);
    expect(window.getSelection()!.anchorOffset).toBe(text.length);
    await vi.advanceTimersByTimeAsync(2000);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it.each(["abort", "navigate", "replace", "input", "attachment", "native-click"])("rechecks %s during the initial delay before dispatch", async (interruption) => {
    const fixture = setup();
    const result = fixture.start();
    await vi.advanceTimersByTimeAsync(25);
    if (interruption === "abort") fixture.controller.abort();
    if (interruption === "navigate") history.pushState({}, "", "/project/other-session");
    if (interruption === "replace") fixture.editor.replaceWith(fixture.editor.cloneNode(true));
    if (interruption === "input") fixture.editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    if (interruption === "attachment") fixture.editor.querySelector("img")!.alt = "changed";
    if (interruption === "native-click") fixture.button.click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe(["input", "attachment", "native-click"].includes(interruption) ? "changed" : "cancelled");
    expect(fixture.clicked).toHaveBeenCalledTimes(interruption === "native-click" ? 1 : 0);
  });

  it("does not let a cancelled send dispatch into a new recording", async () => {
    const old = setup();
    const oldResult = old.start();
    await vi.advanceTimersByTimeAsync(25);
    old.controller.abort();
    const current = setup();
    const result = current.start();
    await vi.advanceTimersByTimeAsync(25);
    expect(old.clicked).not.toHaveBeenCalled();
    expect(current.clicked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    expect(await oldResult).toBe("cancelled");
    expect(await result).toBe("sent");
    expect(current.clicked).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent attempts through the native-click guard", async () => {
    const fixture = setup();
    const results = [fixture.start(), fixture.start()];
    await vi.advanceTimersByTimeAsync(50);
    expect((await Promise.all(results)).sort()).toEqual(["changed", "sent"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.clicked).toHaveBeenCalledOnce();
  });

  it("preserves bounded readiness polling before the first dispatched click", async () => {
    const fixture = setup();
    fixture.button.disabled = true;
    const result = fixture.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(fixture.clicked).not.toHaveBeenCalled();
    fixture.button.disabled = false;
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBe("sent");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.clicked).toHaveBeenCalledOnce();
  });

  it("includes the settle delay in the 1.5-second readiness budget", async () => {
    const fixture = setup();
    fixture.button.disabled = true;
    const result = fixture.start();
    const settled = vi.fn();
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("unavailable");
    fixture.button.disabled = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.clicked).not.toHaveBeenCalled();
    expect(fixture.editor.textContent).toContain("new transcript");
  });

  it("never retries an unacknowledged native send and leaves manual retry available", async () => {
    const fixture = setup();
    const draft = fixture.editor.innerHTML;
    // A failed native handler can leave the draft unchanged. Dispatch is still final.
    const result = fixture.start();
    await vi.advanceTimersByTimeAsync(2050);
    expect(await result).toBe("sent");
    expect(fixture.clicked).toHaveBeenCalledOnce();
    expect(fixture.editor.innerHTML).toBe(draft);
    fixture.button.click();
    expect(fixture.clicked).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.clicked).toHaveBeenCalledTimes(2);
  });
});
