import { useRef, useState, type PointerEvent, type ReactNode } from 'react';

interface SwipeAction {
  label: string;
  tone: 'hide' | 'archive' | 'delete';
  icon: ReactNode;
  onSelect: () => void;
}

interface SwipeGesture {
  id: number;
  x: number;
  y: number;
  start: number;
  direction: -1 | 1;
  width: number;
  lastX: number;
  lastAt: number;
  velocity: number;
  horizontal: boolean;
  offset: number;
  frame?: number;
}

export function SwipeActions({ id, open, onChange, actions, project = false, children }: {
  id: string;
  open: boolean;
  onChange: (id: string | null) => void;
  actions: SwipeAction[];
  project?: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const foreground = useRef<HTMLDivElement>(null);
  const gesture = useRef<SwipeGesture | null>(null);
  const preventClick = useRef(false);
  const [direction, setDirection] = useState<-1 | 1>(-1);
  const isForeground = (target: EventTarget | null, root: HTMLElement) =>
    target instanceof Element && target.closest('[data-swipe-id]') === root && !target.closest('.swipe-options');

  function start(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || !isForeground(event.target, event.currentTarget)) return;
    preventClick.current = false;
    const width = panel.current?.offsetWidth ?? 0;
    if (!width) return;
    gesture.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY, start: open ? width : 0, direction, width,
      lastX: event.clientX, lastAt: event.timeStamp, velocity: 0, horizontal: false, offset: 0,
    };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const pointer = gesture.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    let dx = event.clientX - pointer.x;
    if (!pointer.horizontal) {
      const dy = Math.abs(event.clientY - pointer.y);
      if (Math.max(Math.abs(dx), dy) < 9) return;
      if (Math.abs(dx) < dy * 1.25 || !foreground.current) {
        gesture.current = null;
        return;
      }
      // Pick up the actual position if the previous swipe is still settling.
      const transform = getComputedStyle(foreground.current).transform;
      const offset = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
      if (!project && dx > 0 && offset >= -.5) {
        gesture.current = null;
        return;
      }
      const settling = Math.abs(offset - pointer.direction * pointer.start) > .5;
      pointer.direction = Math.abs(offset) > .5 ? (offset > 0 ? 1 : -1) : (dx > 0 ? 1 : -1);
      pointer.start = Math.min(pointer.width, Math.abs(offset));
      if (settling) {
        pointer.x = pointer.lastX = event.clientX;
        dx = 0;
      }
      pointer.horizontal = true;
      setDirection(pointer.direction);
      preventClick.current = true;
      event.currentTarget.dataset.swipeDragging = 'true';
      foreground.current.style.transform = `translate3d(${offset}px, 0, 0)`;
      event.currentTarget.setPointerCapture(pointer.id);
    }
    const elapsed = event.timeStamp - pointer.lastAt;
    if (elapsed > 0) pointer.velocity = elapsed > 90 ? 0 : .35 * pointer.velocity + .65 * (event.clientX - pointer.lastX) / elapsed;
    pointer.lastX = event.clientX;
    pointer.lastAt = event.timeStamp;
    pointer.offset = pointer.direction * Math.max(0, Math.min(pointer.width, pointer.start + pointer.direction * dx));
    if (pointer.frame === undefined) pointer.frame = requestAnimationFrame(() => {
      pointer.frame = undefined;
      if (gesture.current === pointer && foreground.current) {
        foreground.current.style.transform = `translate3d(${pointer.offset}px, 0, 0)`;
      }
    });
  }

  function finish(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const pointer = gesture.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    gesture.current = null;
    if (!pointer.horizontal) return;
    if (pointer.frame !== undefined) cancelAnimationFrame(pointer.frame);
    if (!cancelled) {
      const dx = event.clientX - pointer.x;
      const flick = Math.abs(dx) > 23 && event.timeStamp - pointer.lastAt < 90 && Math.abs(pointer.velocity) > 0.4;
      const reveal = flick ? pointer.velocity * pointer.direction > 0 : pointer.start + pointer.direction * dx > pointer.width / 2;
      onChange(reveal ? id : null);
    }
    delete event.currentTarget.dataset.swipeDragging;
    foreground.current?.style.removeProperty('transform');
  }

  return (
    <div className={`swipe-shell${project ? ' project-swipe' : ''}`} data-swipe-id={id}
      data-swipe-side={direction === 1 ? 'left' : 'right'}
      data-swipe-open={open || undefined}
      onPointerDown={start} onPointerMove={move} onPointerUp={finish}
      onPointerCancel={event => finish(event, true)}
      onLostPointerCapture={event => { if (event.target === event.currentTarget) finish(event, true); }}
      onClickCapture={event => {
        if (!isForeground(event.target, event.currentTarget)) return;
        if (event.detail === 0) return;
        if (preventClick.current || (open && !(event.target instanceof Element && event.target.closest('[data-swipe-toggle]')))) {
          if (!preventClick.current) onChange(null);
          preventClick.current = false;
          event.stopPropagation();
          event.preventDefault();
        }
      }}
      onContextMenu={event => {
        if (!isForeground(event.target, event.currentTarget)) return;
        event.preventDefault();
        onChange(id);
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          if (panel.current?.contains(document.activeElement))
            event.currentTarget.querySelector<HTMLButtonElement>(':scope > .swipe-content button')?.focus();
          onChange(null);
        }
        if (!isForeground(event.target, event.currentTarget)) return;
        if ((event.key === 'ArrowLeft' || (project && event.key === 'ArrowRight')) && !open) {
          event.preventDefault();
          setDirection(event.key === 'ArrowRight' ? 1 : -1);
          onChange(id);
          requestAnimationFrame(() => panel.current?.querySelector('button')?.focus());
        }
      }}>
      <div className="swipe-options" ref={panel} inert={!open} aria-hidden={!open}>
        {actions.map(action => <button key={action.tone} type="button" className={`swipe-action swipe-action-${action.tone}`}
          onClick={() => { onChange(null); action.onSelect(); }}>
          <span className="swipe-action-label">{action.icon}<span>{action.label}</span></span>
        </button>)}
      </div>
      <div className="swipe-content" ref={foreground}>
        {children}
      </div>
    </div>
  );
}
