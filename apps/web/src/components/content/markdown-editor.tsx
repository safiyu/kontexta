"use client";

import { useEffect, useRef } from "react";

interface MarkdownEditorProps {
  content: string;
  onChange: (content: string) => void;
}

export function MarkdownEditor({ content, onChange }: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "0px";
      const scrollHeight = textareaRef.current.scrollHeight;
      textareaRef.current.style.height = scrollHeight + "px";
    }
  }, [content]);

  return (
    <div className="flex flex-col h-full bg-[#FAFAFA] dark:bg-[#0A0A0A]">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 w-full p-6 bg-transparent border-none outline-none resize-none font-mono text-sm text-[#0F172A] dark:text-[#F1F5F9] leading-relaxed"
        placeholder="Start typing your markdown..."
        spellCheck={false}
      />
    </div>
  );
}
