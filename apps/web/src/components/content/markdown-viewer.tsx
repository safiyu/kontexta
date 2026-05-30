"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidViewer } from "./mermaid-viewer";

interface MarkdownViewerProps {
  content: string;
  className?: string;
}

export function MarkdownViewer({ content, className }: MarkdownViewerProps) {
  return (
    <div className={`prose dark:prose-invert max-w-none text-[var(--text-primary)] ${className || ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-3xl font-black mb-6 bg-gradient-to-r from-[var(--accent)] via-[#E5C079] to-[var(--accent)] bg-clip-text text-transparent drop-shadow-[0_0_15px_rgba(180,120,30,0.2)] font-title tracking-tight">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-[#E5C079] text-2xl font-bold mb-4 mt-8 border-b border-amber-accent/10 pb-2">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-[#E5C079] text-xl font-bold mb-3 mt-6">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-[#E5C079] text-lg font-semibold mb-2 mt-4">
              {children}
            </h4>
          ),
          h5: ({ children }) => (
            <h5 className="text-[#E5C079] text-base font-semibold mb-2">
              {children}
            </h5>
          ),
          h6: ({ children }) => (
            <h6 className="text-[#E5C079] text-sm font-semibold mb-2">
              {children}
            </h6>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-amber-accent/30 bg-amber-accent/5 px-6 py-3 rounded-r-lg my-8 text-[var(--text-secondary)] italic leading-relaxed">
              {children}
            </blockquote>
          ),
          strong: ({ children }) => (
            <strong className="font-bold text-[#E5C079]">
              {children}
            </strong>
          ),
          code: ({ className, children, ...props }: any) => {
            if (className === "language-mermaid") {
              return <MermaidViewer source={String(children).replace(/\n$/, "")} className="my-4" />;
            }
            return <code className={className} {...props}>{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
