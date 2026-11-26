const DRAFT_PREFIX = 'codex-mobile.composer-draft.v1.';
const clearedDrafts = new EventTarget();

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
