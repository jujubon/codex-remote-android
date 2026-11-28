import type { ReactNode, RefObject } from 'react';
import { afterDialogClose } from '../lib/dialogMotion';
import { CloseIcon } from './Icons';

export function AssistantSettingsSheet({ dialogRef, titleId, title, closeLabel, onClosed, children }: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  titleId: string;
  title: string;
  closeLabel: string;
  onClosed: () => void;
  children: ReactNode;
}) {
  return <dialog className="session-dialog assistant-sheet" ref={dialogRef} aria-labelledby={titleId}
    onClose={event => afterDialogClose(event, onClosed)}
    onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="assistant-sheet-frame">
      <header className="sheet-title-row assistant-sheet-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="nav-icon-button assistant-sheet-close" aria-label={closeLabel}
          onClick={() => dialogRef.current?.close()}><CloseIcon aria-hidden="true" /></button>
      </header>
      <div className="assistant-sheet-body">{children}</div>
    </div>
  </dialog>;
}
