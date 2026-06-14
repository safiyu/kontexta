function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render a mermaid source string into the zoomable/fullscreen-able wrapper. */
export function renderMermaid(source: string, id: string): string {
  const body = escapeHtml(source);
  return `<div class="mermaid-wrap" id="${id}-wrap">
  <div class="mermaid-zoom-bar">
    <span class="mermaid-zoom-level" id="${id}-level">100%</span>
    <button type="button" onclick="zoomDiagram('${id}', -0.15)" title="Zoom out">−</button>
    <button type="button" onclick="zoomDiagram('${id}', 0.15)" title="Zoom in">+</button>
    <button type="button" onclick="zoomDiagram('${id}', 0)" title="Reset">⟳</button>
    <button type="button" onclick="toggleDiagramFullscreen('${id}-wrap')" title="Toggle fullscreen" id="${id}-fs">⛶</button>
  </div>
  <div class="mermaid-stage" id="${id}"><pre class="mermaid">${body}</pre></div>
</div>`;
}
