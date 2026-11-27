import { useEffect, useRef, useState } from 'react';
import { ElapsedTime } from './ElapsedTime';

interface TransientActivityProps {
  assistantName?: string;
  running: boolean;
  content?: string;
  summaryId?: string;
  startedAt?: number;
}

function compact(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, '正在检查代码…')
    .replace(/^\s*[-*#>]\s*/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function TransientActivity({ running, content = '', summaryId, startedAt, assistantName = 'Codex' }: TransientActivityProps) {
  const summary = compact(content);
  const slot = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!running || !slot.current) return;
    let inView = typeof IntersectionObserver === 'undefined';
    const update = () => setPlaying(inView && document.visibilityState === 'visible');
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false;
      update();
    });
    observer?.observe(slot.current);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [running]);

  return (
    <div ref={slot} className={`activity-status-slot ${running ? 'is-active' : ''}`} data-playing={running && playing}>
      {running && (
        <div className="activity-status">
          <span className="activity-wave" aria-hidden="true"><i /><i /><i /></span>
          <span key={summary ? summaryId ?? 'summary' : 'thinking'} className="activity-copy" aria-live="polite">
            {summary || `${assistantName} 正在思考`}
          </span>
          <ElapsedTime startedAt={startedAt} />
        </div>
      )}
    </div>
  );
}
