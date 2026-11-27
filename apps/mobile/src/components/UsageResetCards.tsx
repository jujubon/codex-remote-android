import { useId, useRef, useState } from 'react';
import { afterDialogClose } from '../lib/dialogMotion';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest } from '../lib/deviceTools';
import type { AccountUsage, UsageResetCard, UsageResetOutcome } from '../types/protocol';

const cardName = (card: UsageResetCard) => card.title || 'Codex 额度重置卡';
const expiration = (card: UsageResetCard) => card.expiresAt ? `${new Date(card.expiresAt).toLocaleString()} 到期` : '';

export function UsageResetCards({ resets, config, refresh }: {
  resets: NonNullable<AccountUsage['resetCredits']>;
  config: RemoteConfig;
  refresh: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogTitle = useId();
  const [selected, setSelected] = useState<UsageResetCard>();
  const [token, setToken] = useState('');
  const [stage, setStage] = useState<'checking' | 'confirming'>();
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [finished, setFinished] = useState<string[]>([]);
  const attempt = useRef(0);
  const sending = useRef(false);

  async function start(card: UsageResetCard) {
    const sequence = ++attempt.current;
    setSelected(card);
    setError('');
    setToken('');
    setStage('checking');
    dialog.current?.showModal();
    try {
      const proposal = await deviceRequest<{ token: string; card: UsageResetCard }>(config, 'usage/reset/prepare', { creditId: card.id });
      if (sequence !== attempt.current || !dialog.current?.open) return;
      if (!proposal.token || proposal.card?.id !== card.id) throw new Error('电脑未确认这张重置卡。');
      setSelected(proposal.card);
      setToken(proposal.token);
    } catch (failure) {
      if (sequence === attempt.current) setError(failure instanceof Error ? failure.message : '暂时无法读取这张重置卡。');
    } finally {
      if (sequence === attempt.current) setStage(undefined);
    }
  }

  async function confirm() {
    if (!selected || !token || sending.current || !dialog.current?.open) return;
    sending.current = true;
    setStage('confirming');
    setError('');
    try {
      const { outcome } = await deviceRequest<{ outcome: UsageResetOutcome }>(config, 'usage/reset/confirm', { token });
      if (outcome === 'reset' || outcome === 'alreadyRedeemed') {
        setFinished(ids => [...ids, selected.id]);
        setReceipt('重置卡已使用，正在刷新额度。');
      } else if (outcome === 'nothingToReset') {
        setReceipt('当前额度还不符合重置条件。这张卡仍可留待之后使用。');
      } else if (outcome === 'noCredit') {
        setFinished(ids => [...ids, selected.id]);
        setReceipt('这张重置卡已不可用，正在刷新。');
      } else {
        throw new Error('暂未确认重置结果，可重试本次确认。');
      }
      dialog.current?.close();
      refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '暂未确认重置结果。');
    } finally {
      sending.current = false;
      setStage(undefined);
    }
  }

  const cards = resets.cards.filter(card => !finished.includes(card.id));
  const count = Math.max(0, resets.availableCount - (resets.cards.length - cards.length));
  return <section className="usage-resets" aria-label="Codex 重置卡">
    <div className="usage-heading"><strong>重置卡</strong><small>{count} 张可用</small></div>
    {cards.map(card => <div className="usage-reset-row" key={card.id}>
      <div><strong>{cardName(card)}</strong>{card.expiresAt && <small>{expiration(card)}</small>}</div>
      <button type="button" className="secondary-button" disabled={Boolean(stage)} onClick={() => void start(card)}>使用</button>
    </div>)}
    {count > 0 && !cards.length && <p>电脑暂未提供卡片详情，请刷新额度。</p>}
    {receipt && <p role="status">{receipt}</p>}
    <dialog ref={dialog} className="usage-reset-dialog" aria-labelledby={dialogTitle} data-confirming={stage === 'confirming' || undefined}
      onCancel={event => { if (sending.current) event.preventDefault(); }} onClose={event => {
        attempt.current++;
        afterDialogClose(event, () => { setStage(undefined); setToken(''); });
      }}>
      <div className="usage-reset-confirmation">
        <h2 id={dialogTitle}>使用这张重置卡？</h2>
        {selected && <div><strong>{cardName(selected)}</strong>{selected.expiresAt && <small>{expiration(selected)}</small>}</div>}
        <p>将消耗 1 张重置卡，立即恢复卡片所覆盖且符合条件的 Codex 额度。使用后无法撤销。</p>
        {stage === 'checking' && <p role="status">正在核对重置卡…</p>}
        {error && <p role="alert">{error}</p>}
        <div className="usage-reset-actions">
          <button type="button" className="secondary-button" autoFocus disabled={stage === 'confirming'} onClick={() => dialog.current?.close()}>取消</button>
          <button type="button" className="primary-button" disabled={Boolean(stage) || !token} onClick={() => void confirm()}>
            {stage === 'confirming' ? '正在使用…' : '确认使用'}
          </button>
        </div>
      </div>
    </dialog>
  </section>;
}
