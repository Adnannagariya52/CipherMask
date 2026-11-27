import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface SafeMarkdownProps {
  content: string;
}

/**
 * Renders assistant or local markdown strictly without raw HTML, remote images, or active scripts.
 * External links are rendered as inert text badges to prevent accidental referrer leakage or phishing navigation.
 */
export const SafeMarkdown: React.FC<SafeMarkdownProps> = ({ content }) => {
  return (
    <div className="max-w-none text-[15px] leading-relaxed text-[#101828] break-words space-y-2">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: ({ alt }) => (
            <span className="inline-block rounded-md border border-[#FDE68A] bg-[#FFFBEB] px-2 py-0.5 text-xs text-[#B45309]">
              [External image blocked: {alt || 'image'}]
            </span>
          ),
          a: ({ href, children }) => (
            <span
              title={`Blocked auto-link: ${href || ''}`}
              className="underline decoration-dotted text-[#087F6D] font-mono text-sm"
            >
              {children} ({href})
            </span>
          ),
          pre: ({ children }) => (
            <pre className="rounded-xl border border-[#E2E8F0] bg-[#F1F5F9] p-3.5 overflow-x-auto font-mono text-[13px] text-[#101828] my-2.5">
              {children}
            </pre>
          ),
          code: ({ children }) => (
            <code className="rounded bg-[#F1F5F9] px-1.5 py-0.5 font-mono text-[13px] text-[#087F6D]">
              {children}
            </code>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
};
