import { expect, test, type Page } from "@playwright/test";
import { mountQuestionInput } from "../tests/fixtures/composer";

const inputSelector = 'input[data-slot="text-input-v2-input"]';
const idleName = "Voice Dictation (Ctrl+Space)";

async function openQuestion(page: Page, delay = 0) {
  await page.route("**/voice/transcribe", async (route) => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ text: "right answer" }) });
  });
  await page.goto("/project/session");
  await page.evaluate(mountQuestionInput);
  await page.addStyleTag({ content: `
    [data-slot="question-option"] { display:flex; align-items:center; gap:8px; height:40px; padding:0 10px; }
    .question-custom-field { flex:1; min-width:0; height:28px; }
    [data-slot="text-input-v2-value"] { width:100%; }
    input { box-sizing:border-box; width:100%; height:28px; min-width:0; }
    [data-slot="question-custom-toggle"] { width:16px; flex:0 0 16px; }
  ` });
  await page.locator(inputSelector).fill("before WRONG after");
  await page.locator(inputSelector).evaluate((element) => {
    const input = element as HTMLInputElement;
    input.focus(); input.setSelectionRange(7, 12);
    Object.assign(window, { questionEvents: 0 });
    input.addEventListener("input", () => {
      const counter = window as unknown as { questionEvents: number };
      counter.questionEvents++;
    });
  });
  await expect(page.getByRole("button", { name: idleName, exact: true })).toBeVisible();
}
async function record(page: Page) {
  await page.getByRole("button", { name: idleName, exact: true }).tap();
  await expect(page.getByRole("button", { name: "Stop and review", exact: true })).toBeVisible();
  await page.waitForTimeout(150);
}

test.beforeEach(async ({ page, request }) => {
  await request.post("/__test/reset");
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      await context.resume();
      return destination.stream;
    } });
  });
});

test("new custom answer inserts at its saved selection and remains a draft", async ({ page }) => {
  await openQuestion(page);
  await record(page);
  await page.getByRole("button", { name: "Stop and review", exact: true }).tap();
  await expect(page.getByRole("button", { name: idleName, exact: true })).toBeEnabled();
  await expect(page.locator(inputSelector)).toHaveValue("before right answer after");
  expect(await page.evaluate("window.questionEvents")).toBe(1);
  expect(await page.evaluate("window.sendCount")).toBe(0);
  expect(await page.locator(inputSelector).evaluate((element) => element.childNodes.length)).toBe(0);
});

test("Ctrl+Space starts/stops the new answer input without submitting", async ({ page }) => {
  await openQuestion(page);
  await page.keyboard.press("Control+Space");
  await expect(page.getByRole("button", { name: "Stop and review", exact: true })).toBeVisible();
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+Space");
  await expect(page.getByRole("button", { name: idleName, exact: true })).toBeEnabled();
  await expect(page.locator(inputSelector)).toHaveValue("before right answer after");
  expect(await page.evaluate("window.sendCount")).toBe(0);
});

for (const interruption of ["tab", "minimize", "disable"]) {
  test(`pending answer is discarded after ${interruption}`, async ({ page }) => {
    await openQuestion(page, 600);
    await record(page);
    await page.getByRole("button", { name: "Stop and review", exact: true }).tap();
    await expect(page.locator(".ocvd-btn")).toHaveAttribute("title", "Transcribing...");
    await page.evaluate((change) => {
      const input = document.querySelector<HTMLInputElement>('input[data-slot="text-input-v2-input"]')!;
      if (change === "tab") {
        const tabs = document.querySelectorAll<HTMLElement>('[data-slot="question-progress-segment"]');
        tabs[0].dataset.active = "false"; tabs[0].removeAttribute("aria-current");
        tabs[1].dataset.active = "true"; tabs[1].setAttribute("aria-current", "step");
        input.value = "second draft";
      }
      if (change === "minimize") document.querySelector('[data-slot="question-options"]')!.setAttribute("inert", "");
      if (change === "disable") input.disabled = true;
    }, interruption);
    await page.waitForTimeout(800);
    await expect(page.locator(inputSelector)).toHaveValue(interruption === "tab" ? "second draft" : "before WRONG after");
    expect(await page.evaluate("window.sendCount")).toBe(0);
    expect(await page.evaluate("window.questionEvents")).toBe(0);
  });
}

test("mic controls remain beside, not on top of, the compact input at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openQuestion(page);
  const assertGeometry = async () => {
    const input = await page.locator(inputSelector).boundingBox();
    const controls = await page.locator(".ocvd-container").boundingBox();
    expect(input).not.toBeNull(); expect(controls).not.toBeNull();
    expect(input!.x + input!.width).toBeLessThanOrEqual(controls!.x + 1);
    expect(input!.width).toBeGreaterThan(30);
    expect(controls!.x + controls!.width).toBeLessThanOrEqual(360);
  };
  await assertGeometry();
  await record(page);
  await assertGeometry();
  await page.getByRole("button", { name: "Cancel dictation" }).tap();
});
