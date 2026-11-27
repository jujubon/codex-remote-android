import { Capacitor, registerPlugin } from '@capacitor/core';

const antigravityRemote = registerPlugin<{ open(): Promise<void> }>('AntigravityRemote');

export async function openAntigravityPortal() {
  if (Capacitor.getPlatform() !== 'android') {
    window.open('https://antigravity.google.com/', '_blank', 'noopener,noreferrer');
    return;
  }
  try {
    await antigravityRemote.open();
  } catch (error) {
    throw new Error((error as { code?: string } | null)?.code === 'no_compatible_browser'
      ? '请启用 Chrome，或将支持应用内标签页的浏览器设为默认浏览器。'
      : '暂时无法打开 Antigravity 远程控制，请重试。');
  }
}
