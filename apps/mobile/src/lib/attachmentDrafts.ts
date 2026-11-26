import type { InboxFile } from './deviceTools';

type Draft = { files: File[]; inbox?: InboxFile };
const drafts = new Map<string, Draft>();
const updates = new EventTarget();
let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('codex-mobile-attachment-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => {
    database = undefined;
    throw error;
  });
}

export const emptyAttachmentDraft: Draft = { files: [] };

export async function readAttachmentDraft(key: string): Promise<Draft> {
  if (drafts.has(key)) return drafts.get(key)!;
  const db = await openDatabase();
  const stored = await new Promise<Draft | undefined>((resolve, reject) => {
    const request = db.transaction('drafts').objectStore('drafts').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!drafts.has(key)) drafts.set(key, stored ?? emptyAttachmentDraft);
  return drafts.get(key)!;
}

export function onAttachmentDraftChange(key: string, update: (draft: Draft) => void) {
  const listener = () => update(drafts.get(key) ?? emptyAttachmentDraft);
  updates.addEventListener(key, listener);
  return () => updates.removeEventListener(key, listener);
}

export async function saveAttachmentDraft(key: string, draft: Draft) {
  drafts.set(key, draft);
  updates.dispatchEvent(new Event(key));
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite');
    const store = transaction.objectStore('drafts');
    if (draft.files.length || draft.inbox) store.put(draft, key);
    else store.delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function forgetAttachmentDrafts(prefix: string) {
  for (const key of drafts.keys()) if (key.startsWith(prefix)) drafts.delete(key);
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite');
    const cursor = transaction.objectStore('drafts').openKeyCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (entry) {
        entry.delete();
        entry.continue();
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}
