import type { ConnectionPhase } from '../types/protocol';

const LABELS: Record<ConnectionPhase, string> = {
  idle: '未配置',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  offline: '离线',
  error: '连接异常',
};

export function ConnectionStatus({ phase, detail, onReconnect, compact = false }: { phase: ConnectionPhase; detail?: string; onReconnect: () => void; compact?: boolean }) {
  const canReconnect = phase === 'error' || phase === 'offline' || phase === 'reconnecting';
  return (
    <button
      className={`connection-status connection-${phase}`}
      onClick={canReconnect ? onReconnect : undefined}
      type="button"
      title={detail || LABELS[phase]}
      aria-label={compact && canReconnect ? `${LABELS[phase]}，点击重连` : detail ? `${LABELS[phase]}：${detail}` : LABELS[phase]}
    >
      <span className="status-dot" />
      <span className="status-copy">
        <span>{LABELS[phase]}</span>
        {!compact && detail ? <small>{detail}</small> : null}
      </span>
    </button>
  );
}
