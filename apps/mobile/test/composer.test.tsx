import { describe, expect, it, vi } from 'vitest';
import { effectiveDeliveryMode, shouldSubmitComposerShortcut } from '../src/components/Composer';
import { clearSentComposerDraft, composerDraftKey, onComposerDraftSent, readComposerDraft, saveComposerDraft } from '../src/lib/composerDraft';

describe('Composer delivery mode', () => {
  it('uses normal automatic delivery while the task is idle', () => {
    expect(effectiveDeliveryMode(false, 'auto')).toBe('auto');
    expect(effectiveDeliveryMode(false, 'steer')).toBe('auto');
    expect(effectiveDeliveryMode(false, 'queue')).toBe('auto');
  });

  it('defaults an active task to steering instead of starting a competing turn', () => {
    expect(effectiveDeliveryMode(true, 'auto')).toBe('steer');
    expect(effectiveDeliveryMode(true, 'steer')).toBe('steer');
  });

  it('preserves an explicit next-turn queue choice while the task is active', () => {
    expect(effectiveDeliveryMode(true, 'queue')).toBe('queue');
    expect(effectiveDeliveryMode(true, 'steer', false)).toBe('queue');
  });
});


describe('Composer Enter behavior', () => {
  it('keeps plain Enter and IME Enter as textarea input instead of sending', () => {
    expect(shouldSubmitComposerShortcut({ key: 'Enter' })).toBe(false);
    expect(shouldSubmitComposerShortcut({ key: 'Enter', isComposing: true, ctrlKey: true })).toBe(false);
  });

  it('allows only an explicit physical-keyboard modifier shortcut', () => {
    expect(shouldSubmitComposerShortcut({ key: 'Enter', ctrlKey: true })).toBe(true);
    expect(shouldSubmitComposerShortcut({ key: 'Enter', metaKey: true })).toBe(true);
  });
});

it('restores drafts per chat and preserves newer text when an older send is acknowledged', () => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  const first = composerDraftKey('paired-host', 'first');
  const second = composerDraftKey('paired-host', 'second');
  const cleared = vi.fn();
  const unsubscribe = onComposerDraftSent(first, cleared);
  try {
    saveComposerDraft(first, '第一行\n第二行');
    saveComposerDraft(second, '另一段对话');
    expect(readComposerDraft(first)).toBe('第一行\n第二行');
    expect(readComposerDraft(second)).toBe('另一段对话');
    expect(readComposerDraft(composerDraftKey('different-host', 'first'))).toBe('');
    saveComposerDraft(first, '刚编辑的新文本');
    clearSentComposerDraft(first, '第一行\n第二行');
    expect(readComposerDraft(first)).toBe('刚编辑的新文本');
    expect(cleared).not.toHaveBeenCalled();
    clearSentComposerDraft(first, '刚编辑的新文本');
    expect(readComposerDraft(first)).toBe('');
    expect(cleared).toHaveBeenCalledOnce();
    expect(readComposerDraft(second)).toBe('另一段对话');
  } finally {
    unsubscribe();
    vi.unstubAllGlobals();
  }
});
