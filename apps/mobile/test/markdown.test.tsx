import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Markdown } from '../src/components/Markdown';

const directive = '::created-thread{threadId="12345678-1234-4678-9234-123456789abc"}';

it('displays local file labels without creating clickable local file links', () => {
  const content = '[启动脚本](D:/Code/dist/Start-Tunnel.cmd) [配置](</D:/My Folder/start.ps1:3>) [文档](https://example.com/docs)';
  const html = renderToStaticMarkup(<Markdown content={content} />);
  expect(html).toContain('<code>启动脚本</code>');
  expect(html).toContain('<code>配置</code>');
  expect(html).toContain('href="https://example.com/docs"');
  expect(html).not.toContain('D:/');
});

it('hides Desktop markers in assistant prose and preserves literal examples in code', () => {
  const html = renderToStaticMarkup(<Markdown content={`已创建会话\n${directive}\n接着聊\n\n\`\`\`text\n${directive}\n\`\`\``} hideDesktopDirectives />);
  expect(html).toContain('已创建会话');
  expect(html).toContain('接着聊');
  expect(html.match(/::created-thread/g)).toHaveLength(1);
  expect(renderToStaticMarkup(<Markdown content={directive} />)).toContain('::created-thread');
});
