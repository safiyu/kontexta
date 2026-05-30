"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";

interface MermaidViewerProps {
  source: string;
  className?: string;
  filename?: string;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `mermaid-${Date.now()}-${idCounter}`;
}

function sanitizeFilename(name?: string): string {
  if (!name) return "diagram";
  // Strip any path segments and trim
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  // Strip known extensions (.mmd, .md, .markdown)
  const stem = base.replace(/\.(mmd|md|markdown)$/i, "").trim();
  return stem || "diagram";
}

export function MermaidViewer({ source, className, filename }: MermaidViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSvg(null);

    (async () => {
      try {
        const mod = await import("mermaid");
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          theme: resolvedTheme === "light" ? "default" : "dark",
          securityLevel: "strict",
        });
        const id = nextId();
        const { svg: rendered } = await mermaid.render(id, source);
        if (!cancelled) {
          setSvg(rendered);
          if (containerRef.current) {
            containerRef.current.innerHTML = rendered;
          }
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
          setSvg(null);
          if (containerRef.current) containerRef.current.innerHTML = "";
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, resolvedTheme]);

  const stem = sanitizeFilename(filename);

  const handleExportSvg = () => {
    if (!svg) return;
    const svgEl = containerRef.current?.querySelector("svg") as SVGSVGElement | null;
    if (!svgEl) {
      setError("SVG export failed: rendered SVG not found");
      return;
    }
    // Serialise via XMLSerializer so HTML inside <foreignObject> (e.g. <br>)
    // is emitted as valid XML (<br/>). Mermaid's raw render() output is not
    // guaranteed to be well-formed XML and breaks XML viewers / browsers
    // when opened directly.
    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    const serialised = new XMLSerializer().serializeToString(clone);
    const withDecl = serialised.startsWith("<?xml")
      ? serialised
      : `<?xml version="1.0" encoding="UTF-8"?>\n${serialised}`;
    const blob = new Blob([withDecl], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${stem}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportPng = () => {
    if (!svg) return;
    const svgEl = containerRef.current?.querySelector("svg") as SVGSVGElement | null;
    if (!svgEl) {
      setError("PNG export failed: rendered SVG not found");
      return;
    }

    // Determine intrinsic dimensions
    let width = 800;
    let height = 600;
    const viewBox = svgEl.viewBox?.baseVal;
    if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
      width = viewBox.width;
      height = viewBox.height;
    } else {
      try {
        const bbox = svgEl.getBBox();
        if (bbox.width > 0 && bbox.height > 0) {
          width = bbox.width;
          height = bbox.height;
        }
      } catch {
        // getBBox can throw on detached nodes — fall back to defaults.
      }
    }

    // Clone and set explicit width/height + xmlns so the <img> can rasterise it.
    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));

    const serialised = new XMLSerializer().serializeToString(clone);
    // Use a UTF-8-safe base64 encoding to avoid btoa() throwing on non-Latin1 chars.
    const utf8 = new TextEncoder().encode(serialised);
    let binary = "";
    for (let i = 0; i < utf8.length; i++) binary += String.fromCharCode(utf8[i]);
    const dataUrl = `data:image/svg+xml;base64,${btoa(binary)}`;

    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("PNG export failed: 2D canvas context unavailable");
      return;
    }

    const img = new Image();
    img.onload = () => {
      // White background so dark-mode SVGs aren't transparent on light viewers.
      ctx.fillStyle = resolvedTheme === "light" ? "#ffffff" : "#1f2937";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        canvas.toBlob((blob) => {
          if (!blob) {
            setError("PNG export failed: canvas returned empty blob");
            return;
          }
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${stem}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, "image/png");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`PNG export failed: ${msg}`);
      }
    };
    img.onerror = () => {
      setError("PNG export failed: SVG could not be loaded as an image (it may reference external resources or unsupported features)");
    };
    img.src = dataUrl;
  };

  const showExport = !!svg && !error;

  return (
    <div className={className}>
      {showExport && (
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            onClick={handleExportSvg}
            className="btn btn-sm"
            aria-label="Export diagram as SVG"
            title="Export as SVG"
          >
            SVG
          </button>
          <button
            type="button"
            onClick={handleExportPng}
            className="btn btn-sm"
            aria-label="Export diagram as PNG"
            title="Export as PNG (2x)"
          >
            PNG
          </button>
        </div>
      )}
      {error && (
        <pre className="text-red-500 whitespace-pre-wrap mb-2 text-sm">
          Mermaid render error: {error}
        </pre>
      )}
      <div ref={containerRef} />
      {error && (
        <pre className="mt-2 p-3 bg-zinc-900 text-zinc-100 text-xs overflow-x-auto">
          {source}
        </pre>
      )}
    </div>
  );
}
