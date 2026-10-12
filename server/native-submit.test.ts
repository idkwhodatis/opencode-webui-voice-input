import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureTarget } from "../src/insert";
import type { DictationState } from "../src/types";
import { mountComposer, mountRenamedComposer } from "../tests/fixtures/composer";
import { createNativeSend } from "./native-submit";
import { sendDraft } from "./send";

const guards: ReturnType<typeof createNativeSend>[] = [];
const controllers: AbortController[] = [];
const modifierCases: KeyboardEventInit[] = [
  {}, { altKey: true }, { ctrlKey: true }, { metaKey: true },
  { ctrlKey: true, altKey: true }, { metaKey: true, altKey: true },
  { ctrlKey: true, metaKey: true }, { ctrlKey: true, metaKey: true, altKey: true },
];
const alternateCases = modifierCases.filter((keys) => keys.ctrlKey || keys.metaKey);

function setup(phase: DictationState = "recording", mount = mountRenamedComposer) {
  const editor = mount();
  editor.innerHTML = '<span data-mention="true" contenteditable="false">@context</span> old draft';
  const target = captureTarget()!;
  const button = target.composer.querySelector<HTMLButtonElement>("button")!;
  vi.spyOn(button, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
  const alternate = document.createElement("button");
  alternate.type = "button";
  alternate.dataset.action = "composer-alternate-delivery";
  alternate.innerHTML = '<span>Queue <svg><use href="#keybind-enter"></use></svg></span>';
  button.before(alternate);
  const native = vi.fn((_alternate: boolean, _draft: string) => {});
  button.addEventListener("click", () => native(false, editor.textContent ?? ""));
  alternate.addEventListener("click", () => native(true, editor.textContent ?? ""));
  // The submission branch from OpenCode 2.0.27 editor.tsx. It calls submit
  // directly, so a test that merely routes Enter through button.click() is weak.
  editor.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (event.repeat) return;
      native(mod, editor.textContent ?? "");
    }
  });
  target.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    native(false, editor.textContent ?? "");
  });
  const onSend = vi.fn(() => guard.update("processing"));
  const guard = createNativeSend(onSend);
  guards.push(guard);
  guard.update(phase, "composer");
  const key = (keys: KeyboardEventInit = {}, type = "keydown") => {
    const event = new KeyboardEvent(type, { key: "Enter", bubbles: true, cancelable: true, ...keys });
    editor.dispatchEvent(event);
    return event;
  };
  const append = () => {
    editor.append(document.createTextNode(" new transcript"));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
  };
  const finish = () => {
    append();
    const controller = new AbortController(); controllers.push(controller);
    return sendDraft(target, controller.signal);
  };
  return { editor, target, button, alternate, native, onSend, guard, key, append, finish };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  history.replaceState({}, "", "/project/session");
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const guard of guards.splice(0)) guard.destroy();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("native voice submission guards", () => {
  it.each(["starting", "processing"] as const)("blocks every native submission path while %s", (phase) => {
    const f = setup(phase);
    for (const keys of modifierCases) {
      expect(f.key(keys).defaultPrevented).toBe(true);
      expect(f.key(keys, "keyup").defaultPrevented).toBe(true);
    }
    f.button.click();
    f.button.querySelector("use")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    f.alternate.querySelector("use")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (const submitter of [null, f.button, f.alternate]) {
      const event = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter });
      f.target.composer.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(f.native).not.toHaveBeenCalled();
    expect(f.onSend).not.toHaveBeenCalled();
    expect(f.editor.textContent).toBe("@context old draft");
  });

  it.each([mountComposer, mountRenamedComposer])("plain and Alt Enter finish once and send only the final draft (%#)", async (mount) => {
    for (const keys of [{}, { altKey: true }]) {
      const f = setup("recording", mount);
      expect(f.key(keys).defaultPrevented).toBe(true);
      f.key(keys); f.key({ ...keys, repeat: true }); f.key(keys, "keyup");
      f.alternate.click(); f.key({ ctrlKey: true }); f.button.click();
      expect(f.native).not.toHaveBeenCalled();
      expect(f.onSend).toHaveBeenCalledOnce();
      const result = f.finish();
      f.key({ metaKey: true, altKey: true });
      await vi.advanceTimersByTimeAsync(49);
      expect(f.native).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBe("sent");
      expect(f.native).toHaveBeenCalledExactlyOnceWith(false, "@context old draft new transcript");
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.native).toHaveBeenCalledOnce();
      f.guard.destroy();
    }
  });

  it.each(alternateCases)("retains recording and draft for alternate Enter %j without replay", async (keys) => {
    const f = setup();
    expect(f.key(keys).defaultPrevented).toBe(true);
    expect(f.onSend).not.toHaveBeenCalled();
    expect(f.native).not.toHaveBeenCalled();
    // The turn may finish, or the preferred delivery may invert. Never turn the
    // old Queue intent into today's Steer (or into the primary Send action).
    f.alternate.textContent = "Steer";
    f.guard.update("processing"); f.key(keys); f.alternate.click();
    f.append(); f.guard.update("idle");
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.native).not.toHaveBeenCalled();
    expect(f.editor.textContent).toBe("@context old draft new transcript");
    f.key(keys);
    expect(f.native).toHaveBeenCalledExactlyOnceWith(true, "@context old draft new transcript");
  });

  it.each(["button", "span", "use"])("blocks alternate %s clicks without stopping recording", (node) => {
    const f = setup();
    const nested = node === "button" ? f.alternate : f.alternate.querySelector(node)!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    nested.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(f.native).not.toHaveBeenCalled();
    expect(f.onSend).not.toHaveBeenCalled();
  });

  it.each(["stop", "shell", "missing"])("guards the separate alternate even when primary is %s", (mode) => {
    const f = setup();
    if (mode === "missing") f.button.remove();
    else {
      f.button.innerHTML = "";
      f.button.dataset.icon = mode === "shell" ? "arrow-undo-down" : "stop";
    }
    f.alternate.querySelector("use")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    f.key({ ctrlKey: true }); f.key({ metaKey: true, altKey: true });
    expect(f.native).not.toHaveBeenCalled();
    expect(f.onSend).not.toHaveBeenCalled();
  });

  it.each(["stop", "arrow-undo-down"])("preserves actual native %s clicks and keys", (icon) => {
    const f = setup();
    f.alternate.remove(); f.button.innerHTML = ""; f.button.dataset.icon = icon;
    f.button.click(); f.key({}); f.key({ ctrlKey: true });
    expect(f.native).toHaveBeenCalledTimes(3);
    expect(f.onSend).not.toHaveBeenCalled();
  });

  it.each(modifierCases)("preserves idle native Enter semantics %j", (keys) => {
    const f = setup("idle");
    f.key(keys);
    expect(f.native).toHaveBeenCalledExactlyOnceWith(Boolean(keys.ctrlKey || keys.metaKey), "@context old draft");
    expect(f.onSend).not.toHaveBeenCalled();
  });

  it.each([
    { shiftKey: true }, { shiftKey: true, ctrlKey: true }, { shiftKey: true, altKey: true },
    { shiftKey: true, metaKey: true }, { isComposing: true }, { isComposing: true, ctrlKey: true },
    { keyCode: 229 }, { key: "Escape" }, { key: "g", ctrlKey: true },
  ])("leaves newline, composition and non-submit keys native: %j", (keys) => {
    const f = setup();
    const reachedEditor = vi.fn();
    f.editor.addEventListener("keydown", reachedEditor);
    f.key(keys);
    expect(reachedEditor).toHaveBeenCalledOnce();
    expect(f.onSend).not.toHaveBeenCalled();
  });

  it("blocks repeats and keyup without finishing recording", () => {
    const f = setup();
    for (const keys of modifierCases) {
      expect(f.key({ ...keys, repeat: true }).defaultPrevented).toBe(true);
      expect(f.key(keys, "keyup").defaultPrevented).toBe(true);
    }
    expect(f.onSend).not.toHaveBeenCalled();
    expect(f.native).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps Enter for adjacent suggestions, even without an active item (%s)", (active) => {
    const f = setup();
    const suggestions = document.createElement("div");
    suggestions.dataset.component = "composer-suggestions";
    f.target.composer.before(suggestions);
    const selection = vi.fn();
    const handled = vi.fn();
    f.editor.addEventListener("keydown", (event) => {
      // The controller's popover handling precedes the native submission branch.
      // Its reducer also consumes Enter when there is no active suggestion.
      if (event.key === "Enter") {
        event.preventDefault(); event.stopImmediatePropagation(); handled();
        if (active) selection();
      }
    }, true);
    for (const keys of modifierCases) f.key(keys);
    expect(handled).toHaveBeenCalledTimes(modifierCases.length);
    expect(selection).toHaveBeenCalledTimes(active ? modifierCases.length : 0);
    expect(f.native).not.toHaveBeenCalled();
    expect(f.onSend).not.toHaveBeenCalled();
    suggestions.remove();
    f.key({ altKey: true });
    expect(f.onSend).toHaveBeenCalledOnce();
  });

  it("does not mistake another composer's suggestions or controls for this composer", () => {
    const f = setup();
    const other = document.createElement("form");
    other.innerHTML = '<div data-component="composer-suggestions"></div><div contenteditable="true"></div><button type="button" data-action="composer-alternate-delivery"><span>Queue</span></button>';
    document.body.append(other);
    const native = vi.fn(); other.addEventListener("click", native); other.addEventListener("keydown", native);
    other.querySelector("span")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    other.querySelector('[contenteditable]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(native).toHaveBeenCalledTimes(2);
    f.key({ altKey: true });
    expect(f.onSend).toHaveBeenCalledOnce();
  });

  it.each(["idle", "destroy"])("releases all native actions on %s without replaying blocked ones", async (release) => {
    const f = setup();
    f.key({ ctrlKey: true }); f.alternate.click();
    if (release === "idle") f.guard.update("idle"); else f.guard.destroy();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.native).not.toHaveBeenCalled();
    f.alternate.click(); f.key({ metaKey: true }); f.button.click();
    expect(f.native).toHaveBeenCalledTimes(3);
    expect(f.onSend).not.toHaveBeenCalled();
  });

  it.each(["navigate", "replace"])("does not capture stale composer actions after %s", (change) => {
    const f = setup();
    if (change === "navigate") history.pushState({}, "", "/project/another-session");
    else f.editor.replaceWith(f.editor.cloneNode(true));
    f.alternate.click(); f.button.click();
    expect(f.native).toHaveBeenCalledTimes(2);
    expect(f.onSend).not.toHaveBeenCalled();
  });

  it("does not grant alternate submission the validated primary click's exception", async () => {
    const f = setup("processing");
    f.button.addEventListener("click", () => { f.alternate.click(); f.key({ ctrlKey: true }); });
    const result = f.finish();
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBe("sent");
    expect(f.native).toHaveBeenCalledExactlyOnceWith(false, "@context old draft new transcript");
  });

  it("allows a validated primary click's own form default action", async () => {
    const f = setup("processing");
    f.button.type = "submit";
    const result = f.finish();
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBe("sent");
    // Click plus its form default action are both left to the native app. Voice
    // emits only one click and never replaces native form semantics.
    expect(f.native).toHaveBeenCalledTimes(2);
    expect(f.native.mock.calls.every(([alternate]) => alternate === false)).toBe(true);
  });
});
