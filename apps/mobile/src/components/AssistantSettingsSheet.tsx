import { useEffect, useRef, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { afterDialogClose } from '../lib/dialogMotion';
import { CloseIcon } from './Icons';

type SheetDrag = {
  id: number;
  startX: number;
  startY: number;
  lastY: number;
  lastAt: number;
  height: number;
  offset: number;
  velocity: number;
  dragging: boolean;
};

const slide = (offset: number) => `translate3d(0, ${offset}px, 0)`;

export function AssistantSettingsSheet({ dialogRef, titleId, title, closeLabel, onClosed, children, className }: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  titleId: string;
  title: string;
  closeLabel: string;
  onClosed: () => void;
  children: ReactNode;
  className?: string;
}) {
  const drag = useRef<SheetDrag | null>(null);
  const frame = useRef<number | null>(null);
  const settling = useRef<Animation | null>(null);

  useEffect(() => () => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    settling.current?.cancel();
  }, []);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    const dialog = dialogRef.current;
    if (!dialog?.open || !event.isPrimary || event.button !== 0) return;
    settling.current?.cancel();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: event.pointerId, startX: event.clientX, startY: event.clientY, lastY: event.clientY,
      lastAt: event.timeStamp, height: dialog.offsetHeight, offset: 0, velocity: 0, dragging: false,
    };
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const gesture = drag.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const distance = event.clientY - gesture.startY;
    if (!gesture.dragging) {
      const horizontal = Math.abs(event.clientX - gesture.startX);
      if (Math.max(Math.abs(distance), horizontal) < 5) return;
      if (horizontal >= Math.abs(distance)) { drag.current = null; return; }
      gesture.dragging = true;
    }
    const elapsed = event.timeStamp - gesture.lastAt;
    if (elapsed > 0) gesture.velocity = elapsed > 90 ? 0 : (event.clientY - gesture.lastY) / elapsed;
    gesture.lastAt = event.timeStamp;
    gesture.lastY = event.clientY;
    gesture.offset = distance < 0 ? Math.max(-14, distance * .18) : Math.min(distance, gesture.height);
    if (frame.current == null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (drag.current === gesture && dialogRef.current?.open) dialogRef.current.style.transform = slide(gesture.offset);
    });
  }

  function endDrag(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const gesture = drag.current;
    const dialog = dialogRef.current;
    if (!gesture || gesture.id !== event.pointerId || !dialog) return;
    drag.current = null;
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = null;
    dialog.style.removeProperty('transform');
    if (!gesture.dragging || !dialog.open) return;

    const threshold = Math.max(48, Math.min(112, gesture.height * .32));
    const flick = gesture.offset >= 28 && event.timeStamp - gesture.lastAt < 80 && gesture.velocity > .58;
    const dismiss = !cancelled && (gesture.offset >= threshold || flick);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && typeof dialog.animate === 'function') {
      settling.current = dialog.animate([
        { transform: slide(gesture.offset) }, { transform: slide(dismiss ? gesture.height + 12 : 0) },
      ], {
        duration: dismiss ? 190 : 230,
        easing: dismiss ? 'cubic-bezier(.26,.7,.35,1)' : 'cubic-bezier(.21,1.18,.37,1)',
        fill: dismiss ? 'forwards' : 'none',
      });
    }
    if (dismiss) dialog.close();
  }

  return <dialog className={['session-dialog assistant-sheet', className].filter(Boolean).join(' ')} ref={dialogRef} aria-labelledby={titleId}
    onClose={event => {
      const dialog = event.currentTarget;
      if (dialog.open) return;
      drag.current = null;
      if (frame.current != null) cancelAnimationFrame(frame.current);
      frame.current = null;
      afterDialogClose(event, () => {
        settling.current?.cancel();
        settling.current = null;
        dialog.style.removeProperty('transform');
        onClosed();
      });
    }}
    onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="assistant-sheet-frame">
      <div className="assistant-sheet-grip" aria-hidden="true" onPointerDown={startDrag} onPointerMove={moveDrag}
        onPointerUp={endDrag} onPointerCancel={event => endDrag(event, true)} onLostPointerCapture={event => endDrag(event, true)} />
      <header className="sheet-title-row assistant-sheet-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="nav-icon-button assistant-sheet-close" aria-label={closeLabel}
          onClick={() => dialogRef.current?.close()}><CloseIcon aria-hidden="true" /></button>
      </header>
      <div className="assistant-sheet-body">{children}</div>
    </div>
  </dialog>;
}
