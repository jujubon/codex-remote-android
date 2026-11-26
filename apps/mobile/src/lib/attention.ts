import type { ApprovalRequest, PromptQueueItem, RemoteThread } from '../types/protocol';

export interface AttentionTarget {
  kind: 'input' | 'approval' | 'queue';
  id?: string;
  handling?: 'phone' | 'desktop' | 'unknown';
}

export function approvalAttention(method: string, id: string): AttentionTarget {
  return { kind: method === 'item/tool/requestUserInput' ? 'input' : 'approval', id, handling: 'phone' };
}

export function queueNeedsAttention(item: Pick<PromptQueueItem, 'status'>): boolean {
  return item.status === 'failed' || item.status === 'uncertain' || item.status === 'paused';
}

export function attentionForThread(thread: RemoteThread, approvals: ApprovalRequest[], queue: PromptQueueItem[],
  questionId: string | undefined, desktopBlocked: boolean): AttentionTarget | undefined {
  const approval = approvals.find(request => request.threadId === thread.id);
  if (approval) return approvalAttention(approval.method, String(approval.wireId));
  if (questionId) return { kind: 'input', id: questionId, handling: 'phone' };
  if (thread.state === 'waiting_input' || thread.state === 'waiting_approval') {
    return { kind: thread.state === 'waiting_input' ? 'input' : 'approval', handling: desktopBlocked ? 'desktop' : 'unknown' };
  }
  const item = queue.find(queueNeedsAttention);
  if (item) return { kind: 'queue', id: item.id, handling: 'phone' };
}

export function attentionAction(target: AttentionTarget): string {
  const action = { input: 'openInput', approval: 'openApproval', queue: 'openQueue' }[target.kind];
  return target.id === undefined ? action : `${action}:${target.id}`;
}

export function parseAttentionAction(value: unknown): AttentionTarget | undefined {
  if (typeof value !== 'string') return;
  const match = /^(openInput|openApproval|openQueue)(?::(.+))?$/.exec(value);
  if (!match) return;
  return { kind: match[1] === 'openInput' ? 'input' : match[1] === 'openQueue' ? 'queue' : 'approval', id: match[2] };
}
