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
    return { text: replies.map(item => `${item.question}\n${item.answer}`).join('\n\n'), ids: replies.map(item => item.questionItemId) };
  } catch { return; }
}

export function pendingAsyncQuestions(messages: RemoteMessage[]): AsyncQuestion[] {
  const answered = new Set(messages.flatMap(message => message.status === 'failed' ? [] : message.asyncAnswerIds ?? []));
  return messages.flatMap(message => {
    if (message.role !== 'assistant' || message.status !== 'complete') return [];
    const item = message.detail as { id?: unknown; questions?: unknown } | undefined;
    if (typeof item?.id !== 'string' || !Array.isArray(item.questions)) return [];
    return item.questions.flatMap((question, index) => {
      const id = JSON.stringify(['request_user_input_async', item.id, index]);
      if (!question || typeof question.title !== 'string' || !question.title.trim() || answered.has(id)
          || new TextEncoder().encode(id).length > 512) return [];
      const options = Array.isArray(question.options) ? question.options.filter((option: unknown): option is string => typeof option === 'string') : [];
      return [{ id, title: question.title, options }];
    });
  });
}
