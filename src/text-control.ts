// Shared by userscript insertion and the server edition's caret/draft guards.
export function isTextControl(
  editor: HTMLElement,
): editor is HTMLTextAreaElement | HTMLInputElement {
  return editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement;
}
