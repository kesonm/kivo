import ReactMarkdown from 'react-markdown';
import type { Element, Root } from 'hast';
import { Icon } from './icons';
import type { MessageArtifact, MessageAttachment, MessageCitation } from './types';

const citationBlocks = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th']);

function citationBlock(node: Root | Element, offset: number): Element | undefined {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (start === undefined || end === undefined || offset < start || offset > end) continue;
    const nested = citationBlock(child, offset);
    if (nested) return nested;
    if (citationBlocks.has(child.tagName)) return child;
  }
}

function sourceUrl(value: string) {
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url;
  } catch { /* Ignore malformed URLs from the provider. */ }
}

function inlineCitations(citations: MessageCitation[]) {
  return () => (tree: Root) => {
    let fallback: Element | undefined;
    const seen = new Map<Element, Set<string>>();
    let number = 0;
    for (const citation of citations) {
      const url = sourceUrl(citation.url);
      if (!url) continue;
      // Attach the source to its paragraph instead of splitting Markdown syntax.
      let block = citationBlock(tree, citation.endIndex) ?? citationBlock(tree, citation.startIndex);
      if (!block) {
        if (!fallback) {
          fallback = { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: '参考来源 ' }] };
          tree.children.push(fallback);
        }
        block = fallback;
      }
      const urls = seen.get(block) ?? new Set<string>();
      if (urls.has(url.href)) continue;
      urls.add(url.href);
      seen.set(block, urls);
      const label = citation.title || url.hostname;
      number++;
      block.children.push({
        type: 'element', tagName: 'sup', properties: { className: ['chat-inline-citation'] },
        children: [{
          type: 'element', tagName: 'a',
          properties: { href: url.href, title: label, ariaLabel: `来源 ${number}：${label}` },
          children: [{ type: 'text', value: String(number) }],
        }],
      });
    }
  };
}

export function Markdown({ content, citations }: { content: string; citations?: MessageCitation[] }) {
  return <div className="markdown"><ReactMarkdown
    rehypePlugins={citations?.length ? [inlineCitations(citations)] : undefined}
    components={{ a: ({ node: _node, children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}
  >{content}</ReactMarkdown></div>;
}

export function AttachmentChips({ files, onRemove, disabled }: {
  files: Pick<MessageAttachment, 'name'>[];
  onRemove?: (index: number) => void;
  disabled?: boolean;
}) {
  return <ul className="chat-attachments" aria-label="附件">{files.map((file, index) => <li key={`${file.name}:${index}`} className="chat-attachment">
    <Icon name="file" size={15} />
    <span title={file.name}>{file.name}</span>
    {onRemove && <button type="button" className="icon-button" title="移除附件" aria-label={`移除附件 ${file.name}`} disabled={disabled} onClick={() => onRemove(index)}><Icon name="close" size={14} /></button>}
  </li>)}</ul>;
}

export function ChatImages({ artifacts, onLoad }: { artifacts: MessageArtifact[]; onLoad: () => void }) {
  const images = artifacts.filter(artifact =>
    ['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mimeType) &&
    /^[A-Za-z0-9_-]+$/.test(artifact.id) && artifact.url === `/api/chat-artifacts/${artifact.id}`,
  );
  if (!images.length) return null;
  return <div className="chat-images">{images.map(image => <figure key={image.id}>
    <img src={image.url} alt="kivo 生成的图片" loading="lazy" decoding="async" onLoad={onLoad} />
    <figcaption>
      <a href={image.url} download={image.name}><Icon name="download" size={15} />下载图片</a>
    </figcaption>
  </figure>)}</div>;
}
