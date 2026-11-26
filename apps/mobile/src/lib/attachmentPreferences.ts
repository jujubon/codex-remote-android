import { Preferences } from '@capacitor/preferences';

const ATTACHMENT_CLEANUP_KEY = 'codex.remote.delete-attachments-after-turn';

export async function loadAttachmentCleanupPreference(): Promise<boolean> {
  return (await Preferences.get({ key: ATTACHMENT_CLEANUP_KEY })).value === 'true';
}

export async function saveAttachmentCleanupPreference(enabled: boolean): Promise<void> {
  if (enabled) await Preferences.set({ key: ATTACHMENT_CLEANUP_KEY, value: 'true' });
  else await Preferences.remove({ key: ATTACHMENT_CLEANUP_KEY });
}
