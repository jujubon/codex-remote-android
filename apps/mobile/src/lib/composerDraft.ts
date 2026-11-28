const DRAFT_PREFIX = 'codex-mobile.composer-draft.v1.';
const clearedDrafts = new EventTarget();
const sendingDrafts = new Set<string>();
const sendChanges = new EventTarget();

export function composerDraftSending(key: string): boolean {
  return sendingDrafts.has(key);
}

export function onComposerSendChange(key: string, update: () => void): () => void {
  sendChanges.addEventListener(key, update);
  return () => sendChanges.removeEventListener(key, update);
}

export function beginComposerSend(key: string): (() => void) | undefined {
  if (sendingDrafts.has(key)) return;
  sendingDrafts.add(key);
  sendChanges.dispatchEvent(new Event(key));
  return () => {
    sendingDrafts.delete(key);
    sendChanges.dispatchEvent(new Event(key));
  };
}

export function composerDraftKey(scope: string, threadId: string): string {
  return `${DRAFT_PREFIX}${scope}:${threadId}`;
}

export function readComposerDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function saveComposerDraft(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // Keep typing usable if storage is unavailable.
  }
}

export function clearSentComposerDraft(key: string, sent: string): void {
  if (!sent || readComposerDraft(key) !== sent) return;
  saveComposerDraft(key, '');
  // A receipt may arrive after this chat has been opened in a new composer.
  clearedDrafts.dispatchEvent(new Event(key));
}

export function onComposerDraftSent(key: string, clear: () => void): () => void {
  clearedDrafts.addEventListener(key, clear);
  return () => clearedDrafts.removeEventListener(key, clear);
}

export function forgetComposerDrafts(scope: string): void {
  try {
    const prefix = composerDraftKey(scope, '');
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // Some browser previews do not allow persistent storage.
  }
}
