// ---- Mermaid zoom/fullscreen (ported from SLT) ----
let _zoomLevel = 1;
function _diagramZoom(delta) {
  _zoomLevel = Math.max(0.25, Math.min(4, _zoomLevel + delta));
  const stage = document.querySelector('.mermaid-stage');
  if (!stage) return;
  stage.style.transform = `scale(${_zoomLevel})`;
  stage.style.transformOrigin = 'top left';
  const bar = document.querySelector('.mermaid-zoom-level');
  if (bar) bar.textContent = `${Math.round(_zoomLevel * 100)}%`;
}
function zoomDiagram(dir) { _diagramZoom(dir === 'in' ? 0.25 : -0.25); }
function _preFsZoom() { _zoomLevel = 1; }
function toggleDiagramFullscreen() {
  const stage = document.querySelector('.mermaid-stage');
  if (!stage) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    _preFsZoom();
    stage.requestFullscreen();
  }
}
function _onFsChange() {
  const stage = document.querySelector('.mermaid-stage');
  if (stage && document.fullscreenElement) {
    stage.style.maxHeight = 'none';
  } else if (stage) {
    stage.style.maxHeight = '600px';
  }
}
document.addEventListener('fullscreenchange', _onFsChange);
document.addEventListener('webkitfullscreenchange', _onFsChange);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '=' || (e.metaKey || e.ctrlKey) && e.key === '+') {
    e.preventDefault(); zoomDiagram('in');
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '-') { e.preventDefault(); zoomDiagram('out'); }
});

// ---- Data bootstrapping + router + chrome ----
// Injected by shell.ts as globals: window.__NAV__, window.__DOCS__, window.__SEARCH__, window.__ENDPOINTS__, window.__SITE__
const NAV = window.__NAV__ || [];
const DOCS = window.__DOCS__ || {};        // slug-key "folder/slug" -> { html, toc, title, folder }
const SEARCH = window.__SEARCH__ || [];
const ENDPOINTS = window.__ENDPOINTS__ || {}; // id -> EndpointData
const SITE = window.__SITE__ || {};

function routeKey() {
  const h = location.hash.replace(/^#\//, "");
  const [folder, slugWithFrag] = h.split("/");
  const slug = (slugWithFrag || "").split("#")[0];
  return folder && slug ? `${folder}/${slug}` : firstDocKey();
}
function firstDocKey() {
  const g = NAV[0]; const i = g && g.items[0];
  return i ? `${i.folder}/${i.slug}` : "";
}
function renderSidebar() {
  const el = document.getElementById("sidebar");
  el.innerHTML = NAV.map((g) =>
    `<div class="nav-group-label">${g.group}</div>` +
    g.items.map((i) =>
      `<a class="nav-item" data-key="${i.folder}/${i.slug}" href="#/${i.folder}/${i.slug}">${i.icon ? i.icon + " " : ""}${i.title}</a>`
    ).join("")
  ).join("");
}
function renderToc(doc) {
  const el = document.getElementById("toc");
  el.innerHTML = (doc.toc || []).map((t) =>
    `<a class="toc-item level-${t.level}" href="#/${doc.folder}/${doc.slug}#${t.id}" data-id="${t.id}">${t.text}</a>`
  ).join("");
}
function showDoc(key) {
  const doc = DOCS[key];
  if (!doc) return;
  document.getElementById("content").innerHTML = doc.html;
  document.querySelectorAll(".nav-item").forEach((a) =>
    a.classList.toggle("active", a.dataset.key === key));
  renderToc(doc);
  if (window.mermaid) window.mermaid.run({ querySelector: "#content .mermaid" });
  const frag = location.hash.split("#")[2];
  if (frag) document.getElementById(frag)?.scrollIntoView();
  else document.getElementById("content").scrollTo?.(0, 0);
}
function onRoute() { showDoc(routeKey()); }
window.addEventListener("hashchange", onRoute);

// Endpoint modal
window.openEndpoint = function (id) {
  const ep = ENDPOINTS[id]; if (!ep) return;
  const m = document.getElementById("modal");
  document.getElementById("modal-body").innerHTML = endpointHtml(ep);
  m.classList.add("open");
};
function endpointHtml(ep) {
  const rows = (obj) => Object.entries(obj || {}).map(([k, v]) => `<div><code>${k}</code> — ${v}</div>`).join("");
  return `<div class="modal-section-title">${ep.method} ${ep.path}</div>
    ${ep.description ? `<p>${ep.description}</p>` : ""}
    ${ep.headers ? `<div class="modal-section"><div class="modal-section-title">Headers</div>${rows(ep.headers)}</div>` : ""}
    ${ep.statusCodes ? `<div class="modal-section"><div class="modal-section-title">Status Codes</div>${rows(ep.statusCodes)}</div>` : ""}
    ${ep.request ? `<div class="modal-section"><div class="modal-section-title">Request</div><pre>${ep.request}</pre></div>` : ""}
    ${ep.response ? `<div class="modal-section"><div class="modal-section-title">Response</div><pre>${ep.response}</pre></div>` : ""}`;
}
function closeModal() { document.getElementById("modal").classList.remove("open"); }

// ⌘K search palette over the embedded index
function openPalette() { document.getElementById("search-overlay").classList.add("open"); document.getElementById("search-input").focus(); }
function closePalette() { document.getElementById("search-overlay").classList.remove("open"); }
function runSearch(q) {
  const ql = q.toLowerCase().trim();
  const hits = ql ? SEARCH.filter((e) => (e.title + " " + (e.snippet || "")).toLowerCase().includes(ql)).slice(0, 30) : [];
  document.getElementById("search-results").innerHTML = hits.map((h) =>
    `<a class="search-result" href="${h.url}" onclick="closePaletteSoon()"><span class="search-type">${h.type}</span> ${h.title}</a>`
  ).join("") || `<div class="search-empty">No matches</div>`;
}
window.closePaletteSoon = () => setTimeout(closePalette, 0);

// Theme toggle (light/dark), default dark
function applyTheme(t) { document.documentElement.classList.toggle("dark", t === "dark"); }
function toggleTheme() {
  const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
  try { localStorage.setItem("kxta-publish-theme", next); } catch {}
  applyTheme(next);
}

// scroll-spy for toc
function initScrollSpy() {
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        document.querySelectorAll(".toc-item").forEach((a) =>
          a.classList.toggle("active", a.dataset.id === en.target.id));
      }
    });
  }, { rootMargin: "0px 0px -70% 0px" });
  document.querySelectorAll("#content h2, #content h3").forEach((h) => obs.observe(h));
}
const _origShow = showDoc;
showDoc = function (k) { _origShow(k); initScrollSpy(); };

// boot
document.addEventListener("DOMContentLoaded", () => {
  let t = "dark"; try { t = localStorage.getItem("kxta-publish-theme") || "dark"; } catch {}
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
  document.getElementById("nav-toggle")?.addEventListener("click", () =>
    document.getElementById("sidebar").classList.toggle("open"));
});
