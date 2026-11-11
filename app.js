/* ============================================================
   app.js — Digital Book Reader
   GitHub से images fetch करके library + reader render करता है.
   ============================================================ */

/* ------------------------------------------------------------
   ⚙️ CONFIG — सिर्फ़ ये दो लाइनें बदलें
   ------------------------------------------------------------ */
const REPO   = 'your-username/your-repo';   // GitHub owner/repo
const BRANCH = 'main';                      // default branch

/* ------------------------------------------------------------ */

const RAW_BASE  = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const INDEX_URL = `${RAW_BASE}books/index.json`;

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const els = {
  library:      $('#library'),
  status:       $('#libraryStatus'),
  empty:        $('#emptyState'),
  search:       $('#searchInput'),
  refresh:      $('#refreshBtn'),
  theme:        $('#themeBtn'),

  reader:       $('#reader'),
  readerTitle:  $('#readerTitle'),
  readerAuthor: $('#readerAuthor'),
  stage:        $('#pageStage'),
  image:        $('#pageImage'),
  loading:      $('#pageLoading'),
  error:        $('#pageError'),
  prev:         $('#prevBtn'),
  next:         $('#nextBtn'),
  slider:       $('#pageSlider'),
  counter:      $('#pageCounter'),
  close:        $('#closeReader'),
  zoom:         $('#zoomBtn'),
  fullscreen:   $('#fullscreenBtn'),
};

const state = {
  books: [],
  query: '',
  book: null,
  page: 1,
  zoom: false,
  cache: new Map(),     // preloaded images
};

/* ============================================================
   Helpers
   ============================================================ */
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function pageFile(book, pageNumber) {
  const pad = Number(book.pad) || 3;
  const ext = String(book.ext || 'jpg').toLowerCase();
  return `page-${String(pageNumber).padStart(pad, '0')}.${ext}`;
}

function pageUrl(book, pageNumber) {
  return `${RAW_BASE}books/${book.slug}/${pageFile(book, pageNumber)}`;
}

function coverUrl(book) {
  if (book.cover) return RAW_BASE + book.cover;
  return pageUrl(book, 1);
}

function setStatus(text, isError = false) {
  els.status.textContent = text || '';
  els.status.classList.toggle('error', !!isError);
}

/* ============================================================
   Theme
   ============================================================ */
function initTheme() {
  const saved = localStorage.getItem('dbr:theme');
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  const theme = saved || (prefersLight ? 'light' : 'dark');
  applyTheme(theme);

  els.theme?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('dbr:theme', next);
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (els.theme) els.theme.textContent = theme === 'light' ? '☀️' : '🌙';
}

/* ============================================================
   Library
   ============================================================ */
async function loadLibrary(force = false) {
  setStatus('Loading library…');
  try {
    const url = force ? `${INDEX_URL}?v=${Date.now()}` : INDEX_URL;
    const res = await fetch(url, { cache: force ? 'no-store' : 'default' });

    if (!res.ok) {
      throw new Error(`books/index.json not found (HTTP ${res.status}). Check REPO/BRANCH in app.js.`);
    }

    const data = await res.json();
    const books = Array.isArray(data) ? data : (data.books || []);

    state.books = books
      .filter((b) => b && b.slug)
      .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));

    renderLibrary();
  } catch (err) {
    state.books = [];
    renderLibrary();
    setStatus(`Library load failed — ${err.message}`, true);
  }
}

function renderLibrary() {
  const q = state.query.trim().toLowerCase();

  const list = state.books.filter((b) => {
    if (!q) return true;
    return [b.title, b.author, b.slug]
      .some((v) => String(v || '').toLowerCase().includes(q));
  });

  els.library.innerHTML = '';
  list.forEach((book) => els.library.appendChild(bookCard(book)));

  els.empty.hidden = state.books.length !== 0;

  if (state.books.length && !list.length) {
    setStatus(`No results for “${state.query}”.`);
  } else if (state.books.length) {
    setStatus(`${state.books.length} book${state.books.length === 1 ? '' : 's'} in library.`);
  } else {
    setStatus('');
  }
}

function bookCard(book) {
  const card = document.createElement('article');
  card.className = 'book-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open ${book.title || book.slug}`);

  const pages = Number(book.pages) || 0;

  card.innerHTML = `
    <div class="cover">
      <img alt="${escapeHtml(book.title || book.slug)} cover" loading="lazy" decoding="async">
      <span class="pages-badge">${pages || '?'} page${pages === 1 ? '' : 's'}</span>
    </div>
    <div class="meta">
      <h3>${escapeHtml(book.title || book.slug)}</h3>
      <p>${escapeHtml(book.author || 'Unknown author')}</p>
    </div>`;

  const img = $('img', card);
  img.addEventListener('error', () => img.classList.add('missing'), { once: true });
  img.src = coverUrl(book);

  const open = () => openBook(book);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });

  return card;
}

/* ============================================================
   Reader
   ============================================================ */
function openBook(book) {
  const total = Number(book.pages) || 1;

  state.book = book;
  state.cache.clear();
  state.zoom = false;
  els.stage.classList.remove('zoomed');

  els.readerTitle.textContent = book.title || book.slug;
  els.readerAuthor.textContent = book.author || '';
  els.slider.max = String(total);
  els.image.dataset.page = '';
  els.image.removeAttribute('src');

  const saved = Number(localStorage.getItem(`dbr:page:${book.slug}`)) || 1;

  els.reader.hidden = false;
  document.body.classList.add('is-reading');

  showPage(clamp(saved, 1, total));
  els.close.focus();
}

function closeBook() {
  els.reader.hidden = true;
  document.body.classList.remove('is-reading');
  document.body.classList.remove('is-reading');
  state.book = null;
  state.cache.clear();
  els.image.removeAttribute('src');
  els.image.classList.remove('loaded');
  els.loading.classList.remove('visible');
  els.error.hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

function showPage(n) {
  const book = state.book;
  if (!book) return;

  const total = Number(book.pages) || 1;
  n = clamp(Math.round(n), 1, total);
  state.page = n;

  els.error.hidden = true;
  els.loading.classList.add('visible');
  els.image.classList.remove('loaded');
  els.image.dataset.page = String(n);
  els.image.alt = `${book.title || book.slug} — page ${n}`;
  els.image.src = pageUrl(book, n);

  updateHud();
  preload(n);
  localStorage.setItem(`dbr:page:${book.slug}`, String(n));
}

function updateHud() {
  const total = Number(state.book?.pages) || 1;
  els.counter.textContent = `${state.page} / ${total}`;
  els.slider.max = String(total);
  els.slider.value = String(state.page);
  els.prev.disabled = state.page <= 1;
  els.next.disabled = state.page >= total;
}

function nextPage(delta) {
  if (!state.book) return;
  const total = Number(state.book.pages) || 1;
  const target = state.page + delta;
  if (target < 1 || target > total) return;
  showPage(target);
}

function preload(n) {
  const book = state.book;
  if (!book) return;
  const total = Number(book.pages) || 1;

  [n + 1, n + 2, n - 1].forEach((p) => {
    if (p < 1 || p > total) return;
    const url = pageUrl(book, p);
    if (state.cache.has(url)) return;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    state.cache.set(url, img);
  });
}

/* ============================================================
   Events
   ============================================================ */
function bindEvents() {
  /* Library */
  els.refresh?.addEventListener('click', () => loadLibrary(true));

  els.search?.addEventListener('input', (e) => {
    state.query = e.target.value;
    renderLibrary();
  });

  /* Reader image state */
  els.image.addEventListener('load', () => {
    els.image.classList.add('loaded');
    els.loading.classList.remove('visible');
  });

  els.image.addEventListener('error', () => {
    els.loading.classList.remove('visible');
    els.error.hidden = false;
  });

  /* Reader controls */
  els.close.addEventListener('click', closeBook);
  els.prev.addEventListener('click', () => nextPage(-1));
  els.next.addEventListener('click', () => nextPage(1));

  els.slider.addEventListener('input', (e) => showPage(Number(e.target.value)));

  els.zoom.addEventListener('click', () => {
    state.zoom = !state.zoom;
    els.stage.classList.toggle('zoomed', state.zoom);
    els.zoom.textContent = state.zoom ? '⤡' : '⤢';
  });

  els.fullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await els.reader.requestFullscreen();
    } catch { /* unsupported — ignore */ }
  });

  /* Keyboard */
  document.addEventListener('keydown', (e) => {
    if (els.reader.hidden) return;

    switch (e.key) {
      case 'Escape':     closeBook(); break;
      case 'ArrowRight':
      case 'PageDown':
      case ' ':          e.preventDefault(); nextPage(1); break;
      case 'ArrowLeft':
      case 'PageUp':     e.preventDefault(); nextPage(-1); break;
      case 'Home':       e.preventDefault(); showPage(1); break;
      case 'End':        e.preventDefault(); showPage(Number(state.book?.pages) || 1); break;
      case 'f':
      case 'F':          els.fullscreen.click(); break;
      default: break;
    }
  });

  /* Swipe gestures */
  let touchStart = null;

  els.stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || state.zoom) return;
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY, time: Date.now() };
  }, { passive: true });

  els.stage.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const dt = Date.now() - touchStart.time;
    touchStart = null;

    if (dt > 800) return;                                    // slow drag → ignore
    if (Math.abs(dx) < 55) return;                           // too short
    if (Math.abs(dx) < Math.abs(dy) * 1.4) return;           // vertical scroll

    nextPage(dx < 0 ? 1 : -1);
  }, { passive: true });
}

/* ============================================================
   Boot
   ============================================================ */
(function init() {
  initTheme();
  bindEvents();
  loadLibrary();
})();
