import type { RemoteMessage } from '../types/protocol';

const replyOpen = '<send_user_message_question_reply>';
const replyClose = '</send_user_message_question_reply>';

export interface AsyncQuestion {
  id: string;
  title: string;
  options: string[];
}

export function encodeAsyncAnswer(question: AsyncQuestion, answer: string): string {
  const title = Array.from(question.title).slice(0, 128).join('').replace(/[\r\n]/g, ' ');
  const payload = [{ questionItemId: question.id, question: title, answer }];
  return `${replyOpen}\n${JSON.stringify(payload)}\n${replyClose}`;
}

export function describeAsyncAnswer(text: string): { text: string; ids: string[] } | undefined {
  if (!text.startsWith(replyOpen) || !text.endsWith(replyClose)) return;
  try {
    const value: unknown = JSON.parse(text.slice(replyOpen.length, -replyClose.length));
    const replies = Array.isArray(value) ? value : [value];
    if (replies.length === 0 || !replies.every(item =>
      item && typeof item.questionItemId === 'string' && typeof item.question === 'string' && typeof item.answer === 'string')) return;
    return { text: replies.map(item => item.answer).join('\n\n'), ids: replies.map(item => item.questionItemId) };
  } catch { return; }
}

export function asyncQuestionDetail(message: RemoteMessage | undefined) {
  if (message?.role !== 'assistant') return;
  const item = message.detail as { id?: unknown; questions?: unknown } | undefined;
  if (typeof item?.id === 'string' && Array.isArray(item.questions) && item.questions.length) {
    return { id: item.id, questions: item.questions };
  }
}

export function isAsyncQuestionTranscript(message: RemoteMessage): boolean {
  if (message.status !== 'complete' || message.attachments?.length) return false;
  const item = asyncQuestionDetail(message);
  if (!item) return false;
  // The question item carries a text rendering for clients that have no question UI.
  // Only suppress that exact rendering, keeping prose that accompanies a question.
  const blocks = item.questions.map(question => {
    if (!question || typeof question.title !== 'string' || !question.title.trim()) return null;
    const options: string[] = Array.isArray(question.options)
      ? question.options.filter((option: unknown): option is string => typeof option === 'string')
      : [];
    return [question.title, ...options.map(option => `- ${option}`)].join('\n');
  });
  const normalize = (text: string) => text.replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  return blocks.every(block => block !== null) && normalize(message.content) === normalize(blocks.join('\n'));
}

export function pendingAsyncQuestions(messages: RemoteMessage[]): AsyncQuestion[] {
  const answered = new Set(messages.flatMap(message => message.status === 'complete'
    && (!message.id.startsWith('local_') || message.deliveryAcknowledged === true) ? message.asyncAnswerIds ?? [] : []));
  const pending = new Map<string, AsyncQuestion>();
  for (const message of messages) {
    if (message.status !== 'complete') continue;
    const item = asyncQuestionDetail(message);
    if (!item) continue;
    item.questions.forEach((question, index) => {
      const id = JSON.stringify(['request_user_input_async', item.id, index]);
      if (!question || typeof question.title !== 'string' || !question.title.trim() || answered.has(id)
          || new TextEncoder().encode(id).length > 512) return;
      const options = Array.isArray(question.options) ? question.options.filter((option: unknown): option is string => typeof option === 'string') : [];
      pending.set(id, { id, title: question.title, options });
    });
  }
  return [...pending.values()];
}
