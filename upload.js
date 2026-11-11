/* ============================================================
   upload.js — Direct GitHub Upload (No Worker Needed)
   ============================================================ */

const MAX_BYTES     = 8 * 1024 * 1024;
const ALLOWED_EXT   = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'];
const PAD           = 3;
const REPO          = 'Studycare1/BiologyGuess';
const BRANCH        = 'main';

const $ = (sel) => document.querySelector(sel);

const els = {
  token:     $('#githubToken'),
  title:     $('#title'),
  author:    $('#author'),
  slug:      $('#slug'),
  dropzone:  $('#dropzone'),
  fileInput: $('#fileInput'),
  fileList:  $('#fileList'),
  summary:   $('#fileSummary'),
  clearBtn:  $('#clearBtn'),
  uploadBtn: $('#uploadBtn'),
  cancelBtn: $('#cancelBtn'),
  bar:       $('#uploadBar'),
  status:    $('#uploadStatus'),
  log:       $('#log'),
  theme:     $('#themeBtn'),
};

const state = { files: [], uploading: false, slugTouched: false };

/* ---------- Helpers ---------- */
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const extOf = (name) => { const e = String(name).split('.').pop().toLowerCase(); return e === 'jpeg' ? 'jpg' : e; };
const formatBytes = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b/1024).toFixed(0)} KB` : `${(b/1048576).toFixed(1)} MB`;

function log(line) {
  const time = new Date().toLocaleTimeString();
  els.log.textContent += `[${time}] ${line}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

function setProgress(pct) { els.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`; }

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/* ---------- GitHub Direct API ---------- */
async function githubApi(path, body, method = 'PUT') {
  const token = els.token.value.trim() || localStorage.getItem('dbr:ghToken');
  if (!token) throw new Error('GitHub Token डालना ज़रूरी है (Step 0)');

  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }

  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

/* ---------- File Management ---------- */
function addFiles(fileList) {
  let skipped = 0;
  [...fileList].forEach((file) => {
    const ext = extOf(file.name);
    if (!file.type.startsWith('image/') || !ALLOWED_EXT.includes(ext)) { skipped++; return; }
    if (file.size > MAX_BYTES) { skipped++; log(`SKIP ${file.name} — 8MB से बड़ा है`); return; }
    state.files.push({ file, url: URL.createObjectURL(file), status: 'pending' });
  });
  if (skipped) log(`${skipped} फाइलें छोड़ दी गईं (गलत फॉर्मेट या बहुत बड़ी)`);
  renderFiles();
  els.fileInput.value = '';
}

function renderFiles() {
  els.fileList.innerHTML = '';
  state.files.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'file-row';
    const stateLabel = { pending: 'pending', uploading: 'uploading…', done: '✓ done', error: '✕ error' }[item.status] || item.status;
    
    li.innerHTML = `
      <img src="${item.url}" alt="">
      <span class="name">${index + 1}. ${item.file.name}</span>
      <span class="size">${formatBytes(item.file.size)}</span>
      <span class="state ${item.status}">${stateLabel}</span>
      <button class="icon-btn" data-act="del" title="Remove">✕</button>`;
      
    li.querySelector('[data-act="del"]').onclick = () => {
      if (state.uploading) return;
      URL.revokeObjectURL(item.url);
      state.files.splice(index, 1);
      renderFiles();
    };
    els.fileList.appendChild(li);
  });
  els.summary.textContent = state.files.length ? `${state.files.length} page(s)` : '';
  els.uploadBtn.disabled = !state.files.length || state.uploading;
}

/* ---------- Upload Flow ---------- */
async function uploadAll() {
  const key = els.token.value.trim();
  const slug = els.slug.value.trim().toLowerCase();
  const title = els.title.value.trim();
  const author = els.author.value.trim();

  if (!key) return setStatus('GitHub Token डालें (Step 0)', true);
  if (!/^[a-z0-9][a-z0-9-_]{1,63}$/.test(slug)) return setStatus('Slug गलत है', true);
  if (!title) return setStatus('Title डालें', true);
  if (!state.files.length) return setStatus('कम से कम 1 इमेज डालें', true);

  localStorage.setItem('dbr:ghToken', key);
  
  state.uploading = true;
  els.uploadBtn.disabled = true;
  setProgress(0);

  const total = state.files.length;
  let uploaded = 0;
  const ext = extOf(state.files[0].file.name);

  log(`Publishing "${title}" → books/${slug}/`);

  for (let i = 0; i < total; i++) {
    const item = state.files[i];
    const filename = `page-${String(i + 1).padStart(PAD, '0')}.${ext}`;
    item.status = 'uploading';
    renderFiles();
    setStatus(`Uploading page ${i + 1} / ${total}...`);

    try {
      const content = await fileToBase64(item.file);
      
      // Get SHA if file exists (for overwrite)
      let sha = null;
      try {
        const existing = await githubApi(`books/${slug}/${filename}`, null, 'GET');
        sha = existing.sha;
      } catch (e) { /* file doesn't exist, ignore */ }

      const body = { message: `upload ${filename}`, content: content.split('base64,')[1], branch: BRANCH };
      if (sha) body.sha = sha;

      await githubApi(`books/${slug}/${filename}`, body, 'PUT');
      item.status = 'done';
      uploaded++;
      log(`OK   ${filename}`);
    } catch (err) {
      item.status = 'error';
      log(`FAIL ${filename} — ${err.message}`);
    }
    renderFiles();
    setProgress(((i + 1) / total) * 90);
  }

  if (uploaded > 0) {
    setStatus('Updating index.json...');
    try {
      // Update index.json
      let indexSha = null;
      let index = { books: [], updated: null };
      
      try {
        const existingIdx = await githubApi(`books/index.json`, null, 'GET');
        indexSha = existingIdx.sha;
        const decoded = atob(existingIdx.content.replace(/\s+/g, ''));
        index = JSON.parse(decoded);
      } catch (e) { /* new index */ }

      // Remove existing book with same slug
      index.books = index.books.filter(b => b.slug !== slug);
      
      // Add new book
      index.books.unshift({
        slug, title, author, pages: uploaded, ext, pad: PAD,
        cover: `books/${slug}/page-001.${ext}`,
        updated: new Date().toISOString()
      });
      
      const newB64 = btoa(unescape(encodeURIComponent(JSON.stringify(index, null, 2) + '\n')));
      const body = { message: 'update index.json', content: newB64, branch: BRANCH };
      if (indexSha) body.sha = indexSha;

      await githubApi(`books/index.json`, body, 'PUT');

      setProgress(100);
      setStatus(`Done ✅ "${title}" library में जुड़ गई!`);
      log(`Published: ${uploaded} page(s)`);
    } catch (err) {
      setStatus(`Index update failed — ${err.message}`, true);
      log(`ERROR index — ${err.message}`);
    }
  } else {
    setStatus('कोई पेज अपलोड नहीं हुआ', true);
  }

  state.uploading = false;
  els.uploadBtn.disabled = false;
  renderFiles();
}

/* ---------- Events ---------- */
function bindEvents() {
  const savedTheme = localStorage.getItem('dbr:theme') || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(savedTheme);
  els.theme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('dbr:theme', next);
  });

  const savedKey = localStorage.getItem('dbr:ghToken');
  if (savedKey) els.token.value = savedKey;

  els.slug.addEventListener('input', () => { state.slugTouched = true; });
  els.title.addEventListener('input', () => { if (!state.slugTouched) els.slug.value = slugify(els.title.value); });

  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', (e) => addFiles(e.target.files));
  
  ['dragenter', 'dragover'].forEach(evt => els.dropzone.addEventListener(evt, (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); }));
  ['dragleave', 'dragend'].forEach(evt => els.dropzone.addEventListener(evt, () => els.dropzone.classList.remove('dragover')));
  els.dropzone.addEventListener('drop', (e) => { e.preventDefault(); els.dropzone.classList.remove('dragover'); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

  els.clearBtn.addEventListener('click', () => { if (state.uploading) return; state.files = []; renderFiles(); });
  els.uploadBtn.addEventListener('click', uploadAll);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (els.theme) els.theme.textContent = theme === 'light' ? '☀️' : '🌙';
}

(function init() {
  renderFiles();
  bindEvents();
})();
