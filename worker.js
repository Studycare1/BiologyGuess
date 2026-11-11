/**
 * worker.js — Secure GitHub Upload API (Cloudflare Worker)
 * =====================================================================
 * Browser में GitHub token expose किए बिना images upload करने के लिए.
 *
 * REQUIRED ENV VARS (Cloudflare → Worker → Settings → Variables):
 *   GITHUB_TOKEN    Fine-grained PAT · repo → Contents: Read and write
 *   GITHUB_REPO     "owner/repo"
 *   ADMIN_KEY       लंबा random secret (upload panel में यही डालें)
 *
 * OPTIONAL:
 *   GITHUB_BRANCH   default "main"
 *   ALLOWED_ORIGIN  default "*" · comma separated list भी चलेगी
 *
 * ROUTES:
 *   GET    /api/health     → { ok, repo, branch }
 *   POST   /api/upload     → { slug, filename, content(base64), overwrite? }
 *   POST   /api/finalize   → { slug, title, author, pages, ext, pad }
 *   DELETE /api/book       → { slug }   (index से हटाता है)
 *
 * REPO STRUCTURE:
 *   books/index.json
 *   books/<slug>/page-001.jpg …
 * =====================================================================
 */

const GITHUB_API      = 'https://api.github.com';
const INDEX_PATH      = 'books/index.json';
const MAX_FILE_BYTES  = 8 * 1024 * 1024;   // 8 MB / page
const MAX_BODY_BYTES  = 32 * 1024 * 1024;  // 32 MB / request

const SLUG_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/;
const FILE_RE = /^page-\d{3,4}\.(jpg|jpeg|png|webp|avif|gif)$/i;
const EXT_RE  = /^(jpg|jpeg|png|webp|avif|gif)$/i;

/* ============================================================
   Entry
   ============================================================ */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);
    const { pathname } = new URL(request.url);
    const route = pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      /* Public health check */
      if (route === '/api/health') {
        return json({
          ok: true,
          repo: env.GITHUB_REPO || null,
          branch: branch(env),
          time: new Date().toISOString(),
        }, 200, cors);
      }

      if (!['/api/upload', '/api/finalize', '/api/book'].includes(route)) {
        return json({ ok: false, error: 'Not found' }, 404, cors);
      }

      /* Auth */
      if (!isAuthorized(request, env)) {
        return json({ ok: false, error: 'Unauthorized' }, 401, cors);
      }

      assertEnv(env);

      /* Content-Length guard (rough) */
      const len = Number(request.headers.get('content-length') || 0);
      if (len > MAX_BODY_BYTES) {
        return json({ ok: false, error: 'Payload too large' }, 413, cors);
      }

      if (route === '/api/upload'   && request.method === 'POST')   return await handleUpload(request, env, cors);
      if (route === '/api/finalize' && request.method === 'POST')   return await handleFinalize(request, env, cors);
      if (route === '/api/book'     && request.method === 'DELETE') return await handleDelete(request, env, cors);

      return json({ ok: false, error: 'Method not allowed' }, 405, cors);

    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ ok: false, error: err.message || 'Server error' }, status, cors);
    }
  },
};

/* ============================================================
   Handlers
   ============================================================ */

/** Upload a single page image (base64). */
async function handleUpload(request, env, cors) {
  const body = await safeJson(request);
  const { slug, filename, content, overwrite = false } = body;

  assertSlug(slug);

  if (typeof filename !== 'string' || !FILE_RE.test(filename)) {
    throw bad('filename must look like "page-001.jpg"');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw bad('content (base64) is required');
  }

  const bytes = base64Bytes(content);
  if (bytes > MAX_FILE_BYTES) {
    throw bad(`File too large (${(bytes / 1048576).toFixed(1)} MB). Max ${MAX_FILE_BYTES / 1048576} MB.`);
  }

  const path = `books/${slug}/${filename.toLowerCase()}`;
  const existing = await getFile(env, path);

  if (existing && !overwrite) {
    return json({ ok: true, skipped: true, path, sha: existing.sha }, 200, cors);
  }

  const result = await putFile(
    env,
    path,
    stripBase64Prefix(content),
    `dbr: upload ${path}`,
    existing?.sha
  );

  return json({
    ok: true,
    path,
    sha: result?.content?.sha ?? null,
  }, 200, cors);
}

/** Write / update the book entry in books/index.json. */
async function handleFinalize(request, env, cors) {
  const body = await safeJson(request);
  const { slug, title, author = '', pages, ext = 'jpg', pad = 3 } = body;

  assertSlug(slug);

  const pageCount = Number(pages);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 5000) {
    throw bad('pages must be an integer between 1 and 5000');
  }
  if (!EXT_RE.test(String(ext))) throw bad('unsupported ext');

  const extClean = String(ext).toLowerCase() === 'jpeg' ? 'jpg' : String(ext).toLowerCase();
  const padClean = Number(pad) || 3;
  const now = new Date().toISOString();

  const index = await readIndex(env);

  const entry = {
    slug,
    title: String(title || slug).slice(0, 160),
    author: String(author || '').slice(0, 120),
    pages: pageCount,
    ext: extClean,
    pad: padClean,
    cover: `books/${slug}/page-${String(1).padStart(padClean, '0')}.${extClean}`,
    updated: now,
  };

  const i = index.books.findIndex((b) => b && b.slug === slug);
  if (i >= 0) {
    entry.created = index.books[i].created || now;
    index.books[i] = entry;
  } else {
    entry.created = now;
    index.books.unshift(entry);
  }

  index.updated = now;
  await writeIndex(env, index);

  return json({ ok: true, book: entry }, 200, cors);
}

/** Remove a book from the index (image files stay in the repo). */
async function handleDelete(request, env, cors) {
  const { slug } = await safeJson(request);
  assertSlug(slug);

  const index = await readIndex(env);
  const i = index.books.findIndex((b) => b && b.slug === slug);
  if (i < 0) throw new HttpError(404, 'Book not found in index');

  index.books.splice(i, 1);
  index.updated = new Date().toISOString();
  await writeIndex(env, index);

  return json({
    ok: true,
    removed: slug,
    note: 'Image files remain in the repo — delete them on GitHub if needed.',
  }, 200, cors);
}

/* ============================================================
   GitHub Contents API
   ============================================================ */

async function gh(env, filePath, { method = 'GET', body, ref } = {}) {
  const url = new URL(`${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${encodePath(filePath)}`);
  if (ref) url.searchParams.set('ref', ref);

  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'digital-book-reader-worker',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  return res;
}

/** @returns {{sha:string, text:string, size:number}|null} */
async function getFile(env, filePath) {
  const res = await gh(env, filePath, { ref: branch(env) });

  if (res.status === 404) return null;

  if (!res.ok) {
    const detail = await safeText(res);
    throw new HttpError(502, `GitHub read failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const text = data.content ? base64ToUtf8(data.content) : '';

  return { sha: data.sha, text, size: data.size ?? 0 };
}

async function putFile(env, filePath, base64Content, message, sha) {
  const body = {
    message,
    content: base64Content,
    branch: branch(env),
  };
  if (sha) body.sha = sha;

  const res = await gh(env, filePath, { method: 'PUT', body });

  if (!res.ok) {
    const detail = await safeText(res);
    throw new HttpError(502, `GitHub write failed (${res.status}): ${detail}`);
  }

  return res.json();
}

async function readIndex(env) {
  const file = await getFile(env, INDEX_PATH);
  if (!file || !file.text.trim()) return { books: [], updated: null };

  try {
    const parsed = JSON.parse(file.text);
    if (Array.isArray(parsed)) return { books: parsed, updated: null };
    if (parsed && Array.isArray(parsed.books)) return parsed;
    return { books: [], updated: null };
  } catch {
    return { books: [], updated: null };
  }
}

async function writeIndex(env, index) {
  const text = JSON.stringify(index, null, 2) + '\n';
  const existing = await getFile(env, INDEX_PATH);

  await putFile(
    env,
    INDEX_PATH,
    utf8ToBase64(text),
    'dbr: update library index',
    existing?.sha
  );
}

/* ============================================================
   Validation / helpers
   ============================================================ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

function assertEnv(env) {
  const missing = ['GITHUB_TOKEN', 'GITHUB_REPO'].filter((k) => !env[k]);
  if (missing.length) {
    throw new HttpError(500, `Worker misconfigured — missing env: ${missing.join(', ')}`);
  }
}

function assertSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw bad('Invalid slug (a-z, 0-9, "-", "_" · 2–64 chars)');
  }
}

function isAuthorized(request, env) {
  const expected = env.ADMIN_KEY;
  if (!expected) return false;

  const given = request.headers.get('x-admin-key') || '';
  if (given.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function corsHeaders(env, origin) {
  const configured = (env.ALLOWED_ORIGIN || '*').trim();
  let allow = '*';

  if (configured !== '*') {
    const list = configured.split(',').map((s) => s.trim()).filter(Boolean);
    allow = list.includes(origin) ? origin : (list[0] || '*');
  }

  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-admin-key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

async function safeJson(request) {
  try {
    const data = await request.json();
    if (!data || typeof data !== 'object') throw new Error();
    return data;
  } catch {
    throw bad('Invalid JSON body');
  }
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}

function branch(env) {
  return env.GITHUB_BRANCH || 'main';
}

function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

/* ---------- base64 helpers ---------- */

function stripBase64Prefix(s) {
  const i = s.indexOf('base64,');
  const clean = i >= 0 ? s.slice(i + 7) : s;
  return clean.replace(/\s+/g, '');
}

function base64Bytes(s) {
  const clean = stripBase64Prefix(s);
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - pad;
}

function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
