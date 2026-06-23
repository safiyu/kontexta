// ---- Mermaid zoom/fullscreen (per-diagram) ----
const _zoomMap = new Map();

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function zoomDiagram(id, delta) {
  const current = _zoomMap.get(id) ?? 1;
  const level = Math.max(0.25, Math.min(4, current + delta));
  _zoomMap.set(id, level);
  const stage = document.getElementById(id);
  if (!stage) return;
  stage.style.transform = `scale(${level})`;
  stage.style.transformOrigin = 'top left';
  const bar = document.getElementById(`${id}-level`);
  if (bar) bar.textContent = `${Math.round(level * 100)}%`;
}

function toggleDiagramFullscreen(wrapId) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    wrap.requestFullscreen();
  }
}

function _onFsChange() {
  if (document.fullscreenElement) {
    const wrap = document.fullscreenElement.closest('.mermaid-wrap');
    if (wrap) {
      const stage = wrap.querySelector('.mermaid-stage');
      if (stage) stage.style.maxHeight = 'none';
    }
  } else {
    document.querySelectorAll('.mermaid-stage').forEach((stage) => {
      stage.style.maxHeight = '600px';
    });
  }
}
document.addEventListener('fullscreenchange', _onFsChange);
document.addEventListener('webkitfullscreenchange', _onFsChange);

// ---- Data bootstrapping + router + chrome ----
// Injected by shell.ts as globals: window.__NAV__, window.__DOCS__, window.__SEARCH__, window.__ENDPOINTS__, window.__SITE__
const NAV = window.__NAV__ || [];
const DOCS = window.__DOCS__ || {};
const SEARCH = window.__SEARCH__ || [];
const ENDPOINTS = window.__ENDPOINTS__ || {};
const SITE = window.__SITE__ || {};

function routeKey() {
  const h = location.hash.replace(/^#\/+/g, "");
  if (!h) return firstDocKey();
  // Strip any in-page fragment first: "folder/slug#heading" → "folder/slug".
  const pathPart = h.split("#")[0];
  // Folders can be NESTED ("specs/slt-cdc"), so a naive split("/") would
  // misread the folder as the first segment only and the slug as the
  // second — DOCS[ ] then misses and the content pane stays empty. Use
  // the LAST "/" as the folder/slug boundary; slugs are always a single
  // filename and never contain "/".
  const lastSlash = pathPart.lastIndexOf("/");
  if (lastSlash < 0) return firstDocKey();
  const folder = pathPart.slice(0, lastSlash);
  const slug = pathPart.slice(lastSlash + 1);
  if (!folder || !slug) return firstDocKey();
  // URI-decode each segment so a navigation to `#/foo%26bar/slug` (escaped &)
  // produces the same raw key as the data-key attribute on the matching nav
  // item. Tolerate malformed URI escapes by falling back to the raw value.
  let f = folder, s = slug;
  try { f = decodeURIComponent(folder); } catch {}
  try { s = decodeURIComponent(slug); } catch {}
  return `${f}/${s}`;
}

function firstDocKey() {
  const g = NAV[0];
  const i = g && g.items[0];
  return i ? `${i.folder}/${i.slug}` : "";
}

function renderSidebar() {
  const el = document.getElementById("sidebar");
  el.innerHTML = NAV.map((g) =>
    `<div class="nav-group-label">${escapeHtml(g.group)}</div>` +
    g.items.map((i) => {
      // Use the raw key for the data attribute (escaping just for HTML safety
      // when emitting) so dataset.key after the browser decodes the attribute
      // matches the raw key returned by routeKey(). Previously we built the
      // key from already-HTML-escaped halves, then re-embedded that escaped
      // string into the attribute, producing a double-encoded value that
      // never matched the raw routeKey() comparison for folder names
      // containing &, <, > etc.
      const rawKey = `${i.folder}/${i.slug}`;
      const attrKey = escapeHtml(rawKey);
      const href = `#/${encodeURI(rawKey)}`;
      return `<a class="nav-item" data-key="${attrKey}" href="${href}">${i.icon ? escapeHtml(i.icon) + " " : ""}${escapeHtml(i.title)}</a>`;
    }).join("")
  ).join("");
}

function renderToc(doc) {
  const el = document.getElementById("toc");
  el.innerHTML = `<div class="toc-label">On this page</div>` +
    (doc.toc || []).map((t) =>
      `<a class="toc-item level-${escapeHtml(t.level)}" href="#/${escapeHtml(doc.folder)}/${escapeHtml(doc.slug)}#${escapeHtml(t.id)}" data-id="${escapeHtml(t.id)}">${escapeHtml(t.text)}</a>`
    ).join("");
}

function showDoc(key) {
  const doc = DOCS[key];
  if (!doc) return;

  const content = document.getElementById("content");
  // Create or reuse the content-inner wrapper
  let inner = content.querySelector('.content-inner');
  if (!inner) {
    inner = document.createElement('div');
    inner.className = 'content-inner';
    content.appendChild(inner);
  }
  inner.innerHTML = doc.html;

  // Update active nav item
  document.querySelectorAll(".nav-item").forEach((a) =>
    a.classList.toggle("active", a.dataset.key === key));

  renderToc(doc);

  // Re-init mermaid diagrams
  if (window.mermaid) {
    document.querySelectorAll('.mermaid').forEach(el => {
      el.removeAttribute('data-processed');
    });
    window.mermaid.run({ querySelector: '#content .mermaid' }).then(() => {
      // Hide wrappers for diagrams that failed to render (syntax errors, etc.)
      // Mermaid renders an SVG with aria-roledescription="error" for broken diagrams.
      document.querySelectorAll('#content .mermaid-wrap').forEach((wrap) => {
        if (wrap.querySelector('svg[aria-roledescription="error"]')) {
          wrap.style.display = 'none';
        }
      });
    });
  }

  // Scroll to fragment or top
  const frag = location.hash.split("#")[2];
  if (frag) {
    setTimeout(() => {
      const el = document.getElementById(frag);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }, 50);
  } else {
    content.scrollTo?.(0, 0);
  }

  initScrollSpy();
}

// scroll-spy for TOC
let _scrollSpy = null;
function initScrollSpy() {
  if (_scrollSpy) {
    _scrollSpy.disconnect();
    _scrollSpy = null;
  }
  const content = document.getElementById("content");
  const headers = content.querySelectorAll(".content-inner h2, .content-inner h3");
  if (headers.length === 0) return;
  _scrollSpy = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        document.querySelectorAll(".toc-item").forEach((a) =>
          a.classList.toggle("active", a.dataset.id === entry.target.id));
      }
    });
  }, { root: content, rootMargin: "0px 0px -60% 0px" });
  headers.forEach((h) => _scrollSpy.observe(h));
}

function onRoute() { showDoc(routeKey()); }
window.addEventListener("hashchange", onRoute);

// Endpoint modal
window.openEndpoint = function (id) {
  const ep = ENDPOINTS[id];
  if (!ep) return;
  const m = document.getElementById("modal");
  document.getElementById("modal-body").innerHTML = endpointHtml(ep);
  m.classList.add("open");
};

function endpointHtml(ep) {
  const rows = (obj) => Object.entries(obj || {}).map(([k, v]) => `<div><code>${escapeHtml(k)}</code> — ${escapeHtml(v)}</div>`).join("");
  return `<div class="modal-section-title">${escapeHtml(ep.method)} ${escapeHtml(ep.path)}</div>
    ${ep.description ? `<p>${escapeHtml(ep.description)}</p>` : ""}
    ${ep.headers ? `<div class="modal-section"><div class="modal-section-title">Headers</div>${rows(ep.headers)}</div>` : ""}
    ${ep.statusCodes ? `<div class="modal-section"><div class="modal-section-title">Status Codes</div>${rows(ep.statusCodes)}</div>` : ""}
    ${ep.request ? `<div class="modal-section"><div class="modal-section-title">Request</div><pre>${escapeHtml(ep.request)}</pre></div>` : ""}
    ${ep.response ? `<div class="modal-section"><div class="modal-section-title">Response</div><pre>${escapeHtml(ep.response)}</pre></div>` : ""}`;
}

function closeModal() { document.getElementById("modal").classList.remove("open"); }

// Cmd/Ctrl+K search palette over the embedded index
function openPalette() { document.getElementById("search-overlay").classList.add("open"); document.getElementById("search-input").focus(); }
function closePalette() { document.getElementById("search-overlay").classList.remove("open"); document.getElementById("search-input").value = ""; }

function runSearch(q) {
  const ql = q.toLowerCase().trim();
  const hits = ql ? SEARCH.filter((e) => (e.title + " " + (e.snippet || "")).toLowerCase().includes(ql)).slice(0, 30) : [];
  document.getElementById("search-results").innerHTML = hits.map((h) =>
    `<a class="search-result" href="${escapeHtml(h.url)}" onclick="closePaletteSoon()"><span class="search-type">${escapeHtml(h.type)}</span> ${escapeHtml(h.title)}</a>`
  ).join("") || `<div class="search-empty">No results found</div>`;
}
window.closePaletteSoon = () => setTimeout(closePalette, 0);

// Theme toggle (light/dark), default dark
function applyTheme(t) { document.documentElement.classList.toggle("dark", t === "dark"); }
function toggleTheme() {
  const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
  try { localStorage.setItem("kxta-publish-theme", next); } catch {}
  applyTheme(next);
}

// boot
document.addEventListener("DOMContentLoaded", () => {
  let t = "dark";
  try { t = localStorage.getItem("kxta-publish-theme") || "dark"; } catch {}
  applyTheme(t);

  renderSidebar();
  if (!location.hash) location.hash = `#/${firstDocKey()}`;
  onRoute();

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    if (e.key === "Escape") { closePalette(); closeModal(); }
  });

  document.getElementById("search-input").addEventListener("input", (e) => runSearch(e.target.value));
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("nav-toggle")?.addEventListener("click", () => {
    const sidebar = document.getElementById("sidebar");
    sidebar.classList.toggle("open");
    document.getElementById("sidebar-backdrop")?.classList.toggle("open", sidebar.classList.contains("open"));
  });
  document.getElementById("sidebar-backdrop")?.addEventListener("click", () => {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("sidebar-backdrop").classList.remove("open");
  });

  // Close search overlay when clicking outside
  document.getElementById("search-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closePalette();
  });
  // Close modal when clicking outside
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
});