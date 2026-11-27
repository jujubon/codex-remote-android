import type { ApprovalDecision, ApprovalRequest, PermissionMode } from '../types/protocol';
import { AlertIcon } from './Icons';
import { useState } from 'react';
import type { AsyncQuestion } from '../lib/asyncQuestions';

function stringDecision(decision: ApprovalDecision): string | null {
  return typeof decision === 'string' ? decision : null;
}

export function AsyncQuestionCard({ question, disabled, onAnswer }: {
  question: AsyncQuestion;
  disabled: boolean;
  onAnswer: (answer: string) => Promise<boolean> | boolean;
}) {
  const [choice, setChoice] = useState('');
  const [custom, setCustom] = useState('');
  const [sending, setSending] = useState(false);
  const answer = custom.trim() || choice;
  return (
    <form className="approval-card new-thread-form async-question" onSubmit={async event => {
      event.preventDefault();
      if (!answer || disabled || sending) return;
      setSending(true);
      try { await onAnswer(answer); } finally { setSending(false); }
    }}>
      <h3>{question.title}</h3>
      {question.options.map((option, index) => (
        <button key={index} type="button" className="secondary-button" aria-pressed={option === choice && !custom}
          disabled={disabled || sending} onClick={() => { setChoice(option); setCustom(''); }}>{option}</button>
      ))}
      <div className="async-question-response">
        <input aria-label="自行撰写答复" value={custom} onChange={event => setCustom(event.target.value)}
          placeholder="自行撰写答复…" disabled={disabled || sending} maxLength={4000} />
        <button className="primary-button" type="submit" disabled={!answer || disabled || sending}>
          {sending ? '正在提交' : '提交回答'}
        </button>
      </div>
    </form>
  );
}

export function ApprovalCard({ approval, permissionMode, onResolve }: { approval: ApprovalRequest; permissionMode: PermissionMode; onResolve: (approvalId: string, decision: ApprovalDecision) => void }) {
  const antigravity = approval.method === 'antigravity/permission';
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (approval.method === 'item/tool/requestUserInput') {
    const questions = approval.questions ?? [];
    return <form className="approval-card new-thread-form" onSubmit={event => { event.preventDefault(); onResolve(approval.id, { kind: 'answerQuestions', answers }); }}>
      <h3>{approval.title}</h3>
      {questions.map(q => <div key={q.id}>
        <label><span>{q.question}</span><input required type={q.secret ? 'password' : 'text'} value={answers[q.id] ?? ''} onChange={event => setAnswers({ ...answers, [q.id]: event.target.value })} /></label>
        {q.options.map(option => <button className="secondary-button" type="button" key={option} onClick={() => setAnswers({ ...answers, [q.id]: option })}>{option}</button>)}
      </div>)}
      {questions.length ? <button className="primary-button" type="submit">提交回答</button> : <p>请在电脑端查看此问题。</p>}
    </form>;
  }
  const findString = (value: string) => approval.availableDecisions.find((decision) => stringDecision(decision) === value);
  const execpolicy = approval.availableDecisions.find((decision) => typeof decision === 'object' && decision.kind === 'acceptWithExecpolicyAmendment');
  const networkPolicy = approval.availableDecisions.find((decision) => typeof decision === 'object' && decision.kind === 'applyNetworkPolicyAmendment');
  const decline = findString('decline');
  const cancel = findString('cancel');
  const accept = findString('accept');
  const acceptForSession = findString('acceptForSession');

  return (
    <article className="approval-card">
      <div className="approval-heading">
        <span className="approval-icon"><AlertIcon /></span>
        <div><p>需要批准</p><h3>{approval.title}</h3></div>
      </div>
      <p className="approval-source">{antigravity ? 'Antigravity' : <>来源：<code>{approval.method}</code></>}</p>
      {!antigravity && permissionMode === 'full-access' && <p className="approval-mode-note">当前任务已选择完全访问。切换前已经产生的审批不会自动撤销；若这是切换后新产生的请求，请保留下方来源用于排查。</p>}
      {approval.description && <p className="approval-description">{approval.description}</p>}
      {approval.command && <pre className="approval-command"><code>{approval.command}</code></pre>}
      {approval.cwd && <p className="approval-cwd">目录：{approval.cwd}</p>}
      <div className="approval-actions">
        {decline && <button className="deny-button" type="button" onClick={() => onResolve(approval.id, decline)}>拒绝</button>}
        {!decline && cancel && <button className="deny-button" type="button" onClick={() => onResolve(approval.id, cancel)}>取消</button>}
        {accept && <button className="once-button" type="button" onClick={() => onResolve(approval.id, accept)}>本次允许</button>}
        {execpolicy && <button className="once-button" type="button" onClick={() => onResolve(approval.id, execpolicy)}>允许同类命令</button>}
        {networkPolicy && <button className="once-button" type="button" onClick={() => onResolve(approval.id, networkPolicy)}>应用网络规则</button>}
        {acceptForSession && <button className="approve-button" type="button" onClick={() => onResolve(approval.id, acceptForSession)}>会话内允许</button>}
      </div>
    </article>
  );
}
