"use client";
import { useMemo } from "react";

export function HtmlViewer({ html }: { html: string }) {
  const srcDoc = useMemo(() => `<!doctype html><html><head><meta charset="utf-8"><base href="/api/reports/"><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:16px;color:#111}img{max-width:100%}</style></head><body>${html}</body></html>`, [html]);
  return (
    <iframe
      title="report"
      sandbox=""
      srcDoc={srcDoc}
      style={{ width: "100%", height: "100%", border: "0", background: "white" }}
    />
  );
}
