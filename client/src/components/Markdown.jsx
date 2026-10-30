import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { cx } from './ui.jsx';

export const Markdown = memo(function Markdown({ children, className }) {
  return (
    <div className={cx('md text-[0.86rem]', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{ a: ({ node, ...p }) => <a {...p} target="_blank" rel="noreferrer" /> }}>
        {children || ''}
      </ReactMarkdown>
    </div>
  );
});
