/* ============================================================
   upload.js — Multiple Image Upload (Admin Panel)
   Worker API के ज़रिए GitHub पर pages upload करता है.
   ============================================================ */

/* ------------------------------------------------------------
   ⚙️ CONFIG — अपना Worker URL यहाँ डालें
   ------------------------------------------------------------ */
const WORKER_URL = 'https://your-worker.workers.dev';
/* ------------------------------------------------------------ */

const MAX_BYTES = 8 * 1024 * 1024;      // 8 MB per image
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'];
const PAD = 3;

const $ = (sel) => document.querySelector(sel);

const els = {
  key:        $('#adminKey'),
  title:      $('#title'),
  author:     $('#author'),
  slug:       $('#slug'),
  dropzone:   $('#dropzone'),
  fileInput:  $('#fileInput'),
  fileList:   $('#fileList'),
  summary:    $('#fileSummary'),
  clearBtn:   $('#clearBtn'),
  uploadBtn:  $('#uploadBtn'),
  cancelBtn:  $('#cancelBtn'),
  bar:        $('#uploadBar'),
  status:     $('#uploadStatus'),
  log:        $('#log'),
  theme:      $('#themeBtn'),
};

const state = {
  files: [],          // { file, url, status, message }
  uploading: false,
  cancelled: false,
  slugTouched: false,
};

/* ============================================================
   Utilities
   ============================================================ */
const slugify = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64);

const extOf = (name) => {
  const e = String(name).split('.').pop().toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
};

const formatBytes = (b) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
};

function log(line) {
  const time = new Date().toLocaleTimeString();
  els.log.textContent += `[${time}] ${line}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

function setProgress(pct) {
  els.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/* ============================================================
   Worker API
   ============================================================ */
async function api(path, body, method = 'POST') {
  const res = await fetch(`${WORKER_URL.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-admin-key': els.key.value.trim(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = {};
  try { data = await res.json(); } catch { /* non-json */ }

  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ============================================================
   File management
   ============================================================ */
function addFiles(fileList) {
  const incoming = [...fileList];
  let skipped = 0;

  incoming.forEach((file) => {
    const ext = extOf(file.name);

    if (!file.type.startsWith('image/') || !ALLOWED_EXT.includes(ext)) { skipped++; return; }
    if (file.size > MAX_BYTES) { skipped++; log(`SKIP ${file.name} — ${formatBytes(file.size)} > 8 MB`); return; }

    state.files.push({
      file,
      url: URL.createObjectURL(file),
      status: 'pending',
      message: '',
    });
  });

  if (skipped) log(`${skipped} file(s) skipped (unsupported type or too large).`);

  renderFiles();
  els.fileInput.value = '';
}

function renderFiles() {
  els.fileList.innerHTML = '';

  state.files.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'file-row';

    const stateLabel = {
      pending: 'pending',
      uploading: 'uploading…',
      done: '✓ done',
      error: '✕ error',
    }[item.status] || item.status;

    li.innerHTML = `
      <img src="${item.url}" alt="">
      <span class="name">${index + 1}. ${item.file.name}</span>
      <span class="size">${formatBytes(item.file.size)}</span>
      <span class="state ${item.status}">${stateLabel}</span>
      <button class="icon-btn" data-act="up"   title="Move up"   ${index === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn" data-act="down" title="Move down" ${index === state.files.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="icon-btn" data-act="del"  title="Remove">✕</button>`;

    li.querySelector('[data-act="up"]').onclick   = () => move(index, -1);
    li.querySelector('[data-act="down"]').onclick = () => move(index, 1);
    li.querySelector('[data-act="del"]').onclick  = () => remove(index);

    els.fileList.appendChild(li);
  });

  const total = state.files.reduce((sum, f) => sum + f.file.size, 0);
  els.summary.textContent = state.files.length
    ? `${state.files.length} page(s) · ${formatBytes(total)}`
    : '';

  els.clearBtn.disabled = !state.files.length || state.uploading;
  els.uploadBtn.disabled = !state.files.length || state.uploading;
}

function move(index, delta) {
  if (state.uploading) return;
  const target = index + delta;
  if (target < 0 || target >= state.files.length) return;
  [state.files[index], state.files[target]] = [state.files[target], state.files[index]];
  renderFiles();
}

function remove(index) {
  if (state.uploading) return;
  URL.revokeObjectURL(state.files[index].url);
  state.files.splice(index, 1);
  renderFiles();
}

function clearAll() {
  if (state.uploading) return;
  state.files.forEach((f) => URL.revokeObjectURL(f.url));
  state.files = [];
  renderFiles();
}

/* ============================================================
   Validation
   ============================================================ */
function readForm() {
  const key = els.key.value.trim();
  const slug = els.slug.value.trim().toLowerCase();
  const title = els.title.value.trim();
  const author = els.author.value.trim();

  if (!key) throw new Error('Admin key required.');
  if (!/^[a-z0-9][a-z0-9-_]{1,63}$/.test(slug)) {
    throw new Error('Slug must be 2–64 chars: a-z, 0-9, "-", "_".');
  }
  if (!title) throw new Error('Title required.');
  if (!state.files.length) throw new Error('Add at least one page image.');

  const exts = new Set(state.files.map((f) => extOf(f.file.name)));
  if (exts.size > 1) {
    throw new Error(`Mixed formats (${[...exts].join(', ')}). सभी pages एक ही format में रखें.`);
  }

  return { key, slug, title, author, ext: [...exts][0] };
}

/* ============================================================
   Upload flow
   ============================================================ */
async function uploadAll() {
  let cfg;
  try {
    cfg = readForm();
  } catch (err) {
    setStatus(err.message, true);
    log(`ERROR ${err.message}`);
    return;
  }

  sessionStorage.setItem('dbr:adminKey', cfg.key);

  state.uploading = true;
  state.cancelled = false;
  els.uploadBtn.disabled = true;
  els.cancelBtn.disabled = false;
  els.clearBtn.disabled = true;
  setProgress(0);

  const total = state.files.length;
  let uploaded = 0;
  let failed = 0;

  log(`Publishing "${cfg.title}" → books/${cfg.slug}/ (${total} pages)`);

  for (let i = 0; i < total; i++) {
    if (state.cancelled) { log('Cancelled by user.'); break; }

    const item = state.files[i];
    const filename = `page-${String(i + 1).padStart(PAD, '0')}.${cfg.ext}`;

    item.status = 'uploading';
    renderFiles();
    setStatus(`Uploading page ${i + 1} of ${total}…`);

    try {
      const content = await fileToBase64(item.file);

      const res = await api('/api/upload', {
        slug: cfg.slug,
        filename,
        content,
        overwrite: true,
      });

      item.status = 'done';
      uploaded++;
      log(`OK   ${filename}${res.skipped ? ' (already existed)' : ''}`);
    } catch (err) {
      item.status = 'error';
      item.message = err.message;
      failed++;
      log(`FAIL ${filename} — ${err.message}`);
    }

    renderFiles();
    setProgress(((i + 1) / total) * 90);   // last 10% = finalize
  }

  /* Publish index */
  if (!state.cancelled && uploaded > 0) {
    setStatus('Updating library index…');
    try {
      await api('/api/finalize', {
        slug: cfg.slug,
        title: cfg.title,
        author: cfg.author,
        pages: uploaded,
        ext: cfg.ext,
        pad: PAD,
      });

      setProgress(100);
      setStatus(
        failed
          ? `Published with ${failed} failed page(s). Re-run upload to retry.`
          : `Done ✅ "${cfg.title}" is live in the library.`,
        failed > 0
      );
      log(`Published: ${uploaded} page(s), ext=${cfg.ext}.`);
      log('Open index.html to view the book.');
    } catch (err) {
      setProgress(90);
      setStatus(`Index update failed — ${err.message}`, true);
      log(`ERROR finalize — ${err.message}`);
    }
  } else if (state.cancelled) {
    setStatus('Cancelled.');
  } else {
    setStatus('No pages uploaded — index not updated.', true);
  }

  state.uploading = false;
  els.uploadBtn.disabled = false;
  els.cancelBtn.disabled = true;
  renderFiles();
}

/* ============================================================
   Events
   ============================================================ */
function bindEvents() {
  /* Theme (shared with reader) */
  const savedTheme = localStorage.getItem('dbr:theme')
    || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(savedTheme);

  els.theme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('dbr:theme', next);
  });

  /* Restore admin key for the session */
  const savedKey = sessionStorage.getItem('dbr:adminKey');
  if (savedKey) els.key.value = savedKey;

  /* Slug auto-fill */
  els.slug.addEventListener('input', () => { state.slugTouched = true; });
  els.title.addEventListener('input', () => {
    if (!state.slugTouched) els.slug.value = slugify(els.title.value);
  });

  /* Dropzone */
  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
  });

  els.fileInput.addEventListener('change', (e) => addFiles(e.target.files));

  ['dragenter', 'dragover'].forEach((evt) =>
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropzone.classList.add('dragover');
    })
  );

  ['dragleave', 'dragend'].forEach((evt) =>
    els.dropzone.addEventListener(evt, () => els.dropzone.classList.remove('dragover'))
  );

  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  /* Prevent the browser from opening dropped files elsewhere */
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  /* Buttons */
  els.clearBtn.addEventListener('click', clearAll);
  els.uploadBtn.addEventListener('click', uploadAll);
  els.cancelBtn.addEventListener('click', () => {
    state.cancelled = true;
    els.cancelBtn.disabled = true;
    setStatus('Cancelling after current page…');
  });

  /* Health check (optional, non-blocking) */
  fetch(`${WORKER_URL.replace(/\/+$/, '')}/api/health`)
    .then((r) => r.json())
    .then((d) => log(`Worker ready · repo=${d.repo || '?'} · branch=${d.branch || '?'}`))
    .catch(() => log('Worker health check failed — URL या CORS check करें.'));
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (els.theme) els.theme.textContent = theme === 'light' ? '☀️' : '🌙';
}

/* ============================================================
   Boot
   ============================================================ */
(function init() {
  renderFiles();
  bindEvents();
})();
