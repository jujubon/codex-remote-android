import type { SyntheticEvent } from 'react';

export function closeDialogForHandoff(dialog: HTMLDialogElement | null) {
  if (!dialog?.open) return;
  dialog.dataset.handoff = '';
  dialog.close();
  // Commit removal from the top layer before the replacement opens.
  void dialog.offsetWidth;
  delete dialog.dataset.handoff;
}

/** Keep conditionally rendered sheets mounted until the native top-layer exit is done. */
export function afterDialogClose(event: SyntheticEvent<HTMLDialogElement>, onClosed: () => void) {
  const dialog = event.currentTarget;
  if (event.target !== dialog || dialog.open) return;
  const transitions = dialog.getAnimations().filter(animation => animation.playState === 'running');
  if (!transitions.length) {
    onClosed();
    return;
  }
  void Promise.allSettled(transitions.map(animation => animation.finished)).then(() => {
    if (!dialog.open && dialog.isConnected) onClosed();
  });
}
