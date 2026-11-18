/**
 * Page-wide drag-and-drop for chat attachments.
 *
 * Dropped files are handed to the composer's existing attachment input, so the
 * same validation, size limits and upload path apply as when using the + button.
 */

/** Types the attachment endpoint accepts (matches the composer's file picker). */
const SUPPORTED_FILE = /\.(png|jpe?g|webp|txt|pdf|docx)$/i;
const SUPPORTED_LABEL = 'PNG, JPEG, WebP, TXT, PDF or DOCX';

export type PaneKind = 'direct' | 'group' | 'boss' | 'none';

/** True when a drag carries files (as opposed to selected text or a link). */
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  return Array.from(types ?? []).includes('Files');
}

/** Classify a chat pane from its CSS classes. The classifier does not grant upload authority; each pane maps its own input. */
export function paneKind(classes: Iterable<string> | null): PaneKind {
  if (!classes) return 'none';
  const names = new Set(classes);
  if (names.has('dispatcher')) return 'boss';
  if (names.has('group-conversation')) return 'group';
  return 'direct';
}

export function splitDroppedFiles(files: Iterable<File>): { accepted: File[]; skipped: File[] } {
  const accepted: File[] = [];
  const skipped: File[] = [];
  for (const file of files) (SUPPORTED_FILE.test(file.name) ? accepted : skipped).push(file);
  return { accepted, skipped };
}

export function skippedNotice(skipped: File[]): string {
  if (!skipped.length) return '';
  const subject = skipped.length === 1 ? `"${skipped[0].name}" was` : `${skipped.length} files were`;
  return `${subject} skipped. Supported types: ${SUPPORTED_LABEL}.`;
}

const ATTACH_BUTTON = 'button[data-attachment-button],button[aria-label="Attach image or document"]';
const OVERLAY_IDLE_MS = 1000;
const TOAST_MS = 6000;

export function installChatDrop(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const marker = window as unknown as { __relayChatDrop?: boolean };
  if (marker.__relayChatDrop) return;
  marker.__relayChatDrop = true;

  let overlay: HTMLDivElement | null = null;
  let toast: HTMLDivElement | null = null;
  let overlayTimer = 0;
  let toastTimer = 0;

  function hideOverlay() {
    window.clearTimeout(overlayTimer);
    if (overlay) overlay.hidden = true;
  }
  function showOverlay(pane: Element, title: string, detail: string, unsupported: boolean) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'chat-drop-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.appendChild(document.createElement('strong'));
      overlay.appendChild(document.createElement('small'));
      document.body.appendChild(overlay);
    }
    const rect = pane.getBoundingClientRect();
    overlay.style.left = `${rect.left + 8}px`;
    overlay.style.top = `${rect.top + 8}px`;
    overlay.style.width = `${Math.max(0, rect.width - 16)}px`;
    overlay.style.height = `${Math.max(0, rect.height - 16)}px`;
    overlay.classList.toggle('unsupported', unsupported);
    overlay.children[0].textContent = title;
    overlay.children[1].textContent = detail;
    overlay.hidden = false;
    window.clearTimeout(overlayTimer);
    // dragleave is unreliable between elements; hide if the drag goes quiet.
    overlayTimer = window.setTimeout(hideOverlay, OVERLAY_IDLE_MS);
  }
  function notify(message: string) {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'chat-drop-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { if (toast) toast.hidden = true; }, TOAST_MS);
  }
  function paneOf(event: DragEvent): Element | null {
    if(!(event.target instanceof Element)||event.target.closest('form,input[type="password"],.typesafe-connection,.interaction-card,[data-secure-entry]'))return null;
    return event.target.closest('main.conversation-pane');
  }

  function deliver(pane: Element, dropped: File[]) {
    const { accepted, skipped } = splitDroppedFiles(dropped);
    const skippedMessage = skippedNotice(skipped);
    if (!accepted.length) { notify(skippedMessage || 'No files were found in that drop.'); return; }
    const button = pane.querySelector<HTMLButtonElement>(ATTACH_BUTTON);
    const target=pane.getAttribute('data-attachment-input');
    const candidate=target?document.getElementById(target):null;
    const input=candidate instanceof HTMLInputElement&&candidate.type==='file'?candidate:null;
    if (!button || !input) { notify('Select a chat before attaching files.'); return; }
    if (button.disabled) { notify('Files can be attached once the current response or upload finishes. Drop them again in a moment.'); return; }
    const transfer = new DataTransfer();
    for (const file of accepted) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (skippedMessage) notify(skippedMessage);
  }

  document.addEventListener('dragover', event => {
    if (!dragHasFiles(event.dataTransfer?.types)) return;
    // A component with its own drop zone (thumbnail picker) already took this drag.
    if (event.defaultPrevented) { hideOverlay(); return; }
    event.preventDefault();
    const pane = paneOf(event);
    if (pane && pane.hasAttribute('data-attachment-input')) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      showOverlay(pane, 'Drop to attach', `${SUPPORTED_LABEL} \u00b7 added to your next message`, false);
      return;
    }
    // Never let the browser navigate away to a dropped file.
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    hideOverlay();
  });
  document.addEventListener('drop', event => {
    if (!dragHasFiles(event.dataTransfer?.types)) return;
    hideOverlay();
    if (event.defaultPrevented) return;
    event.preventDefault();
    const pane = paneOf(event);
    if (pane && pane.hasAttribute('data-attachment-input')) deliver(pane, Array.from(event.dataTransfer?.files ?? []));
  });
  document.addEventListener('dragleave', event => {
    if (event.relatedTarget === null && (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight)) hideOverlay();
  });
  document.addEventListener('dragend', hideOverlay);
}
