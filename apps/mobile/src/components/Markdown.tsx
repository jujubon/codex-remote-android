import { Fragment, memo, useState, type ReactNode } from 'react';

interface InlineOptions {
  keyPrefix: string;
}

const createdThreadDirective = /^::created-thread\{(?:threadId|clientThreadId)="[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}"\}\s*$/i;
const localFileTarget = /^(?:\/?[a-z]:[/\\]|\/(?!\/)|file:\/\/\/)/i;

/**
 * Deliberately small, safe Markdown renderer for Codex turn output.
 * It produces React nodes only: HTML in model output is rendered as text.
 */
function renderInline(source: string, { keyPrefix }: InlineOptions): ReactNode[] {
  const expression = /\[(?<label>[^\]]+)\]\((?:<(?<wrappedTarget>[^<>\n]+)>|(?<target>[^\s)]+))\)|`(?<code>[^`]+)`|\*\*(?<strong>[^*]+)\*\*|__(?<strongUnderscores>[^_]+)__|\*(?<emphasis>[^*]+)\*|_(?<emphasisUnderscores>[^_]+)_/g;
  const nodes: ReactNode[] = [];
  let index = 0;
  let last = 0;
  for (const match of source.matchAll(expression)) {
    const position = match.index ?? 0;
    if (position > last) nodes.push(source.slice(last, position));
    const key = `${keyPrefix}-${index++}`;
    const { label, wrappedTarget, target, code, strong, strongUnderscores, emphasis, emphasisUnderscores } = match.groups!;
    const destination = wrappedTarget ?? target ?? '';
    if (/^https?:\/\/\S+$/i.test(destination)) {
      nodes.push(<a key={key} href={destination} target="_blank" rel="noreferrer">{label}</a>);
    } else if (localFileTarget.test(destination)) {
      nodes.push(<code key={key}>{label}</code>);
    } else if (code) {
      nodes.push(<code key={key}>{code}</code>);
    } else if (strong || strongUnderscores) {
      nodes.push(<strong key={key}>{strong ?? strongUnderscores}</strong>);
    } else if (emphasis || emphasisUnderscores) {
      nodes.push(<em key={key}>{emphasis ?? emphasisUnderscores}</em>);
    } else {
      nodes.push(match[0]);
    }
    last = position + match[0].length;
  }
  if (last < source.length) nodes.push(source.slice(last));
  return nodes;
}

function isListLine(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
}

function listItemText(line: string): { ordered: boolean; text: string } {
  const ordered = /^\s*\d+[.)]\s+/.test(line);
  return { ordered, text: line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '') };
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [feedback, setFeedback] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setFeedback('已复制');
    } catch {
      setFeedback('请长按代码复制');
    }
  }
  return <div className="code-block">
    <div className="code-tools"><span>{language}</span><button type="button" onClick={copy} aria-live="polite">{feedback || '复制'}</button></div>
    <pre className="markdown-code"><code>{code}</code></pre>
  </div>;
}

export const Markdown = memo(function Markdown({ content, hideDesktopDirectives = false }: { content: string; hideDesktopDirectives?: boolean }) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let cursor = 0;
  let blockIndex = 0;
  const isDesktopDirective = (line: string) => hideDesktopDirectives && createdThreadDirective.test(line);

  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (!line.trim() || isDesktopDirective(line)) {
      cursor += 1;
      continue;
    }

    const fence = line.match(/^```([^\s]*)\s*$/);
    if (fence) {
      const language = fence[1] || 'text';
      const code: string[] = [];
      cursor += 1;
      while (cursor < lines.length && !/^```\s*$/.test(lines[cursor] ?? '')) {
        code.push(lines[cursor] ?? '');
        cursor += 1;
      }
      if (cursor < lines.length) cursor += 1;
      blocks.push(<CodeBlock key={`block-${blockIndex++}`} language={language} code={code.join('\n')} />);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(4, heading[1].length);
      const text = renderInline(heading[2], { keyPrefix: `heading-${blockIndex}` });
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={`block-${blockIndex++}`}>{text}</Tag>);
      cursor += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (cursor < lines.length && /^\s*>\s?/.test(lines[cursor] ?? '')) {
        quote.push((lines[cursor] ?? '').replace(/^\s*>\s?/, ''));
        cursor += 1;
      }
      blocks.push(<blockquote key={`block-${blockIndex++}`}>{renderInline(quote.join('\n'), { keyPrefix: 'quote' })}</blockquote>);
      continue;
    }

    const next = lines[cursor + 1] ?? '';
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const header = cells(line);
      cursor += 2;
      const rows: string[][] = [];
      while (cursor < lines.length && lines[cursor]?.includes('|')) {
        rows.push(cells(lines[cursor] ?? ''));
        cursor += 1;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={`block-${blockIndex++}`}>
          <table><thead><tr>{header.map((cell, index) => <th key={index}>{renderInline(cell, { keyPrefix: `th-${index}` })}</th>)}</tr></thead>
          <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] ?? '', { keyPrefix: `td-${rowIndex}-${cellIndex}` })}</td>)}</tr>)}</tbody></table>
        </div>,
      );
      continue;
    }

    if (isListLine(line)) {
      const { ordered } = listItemText(line);
      const items: string[] = [];
      while (cursor < lines.length && isListLine(lines[cursor] ?? '')) {
        items.push(listItemText(lines[cursor] ?? '').text);
        cursor += 1;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={`block-${blockIndex++}`}>{items.map((item, index) => <li key={index}>{renderInline(item, { keyPrefix: `li-${index}` })}</li>)}</List>);
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={`block-${blockIndex++}`} />);
      cursor += 1;
      continue;
    }

    const paragraph: string[] = [line];
    cursor += 1;
    while (cursor < lines.length && lines[cursor]?.trim() && !isDesktopDirective(lines[cursor] ?? '') && !/^```/.test(lines[cursor] ?? '') && !/^(#{1,4})\s+/.test(lines[cursor] ?? '') && !/^\s*>\s?/.test(lines[cursor] ?? '') && !isListLine(lines[cursor] ?? '')) {
      paragraph.push(lines[cursor] ?? '');
      cursor += 1;
    }
    blocks.push(<p key={`block-${blockIndex++}`}>{paragraph.map((row, index) => <Fragment key={index}>{index > 0 && <br />}{renderInline(row, { keyPrefix: `p-${blockIndex}-${index}` })}</Fragment>)}</p>);
  }

  return <div className="markdown-content">{blocks}</div>;
});
