// 괴담 위키 서버 v1.0.1 (외부 패키지 없음, Node 기본 기능만 사용)
// - 누구나 문서 작성/수정 "제안"을 보낼 수 있음
// - 관리자(주인)가 승인해야만 문서에 실제 반영됨
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '1.0.1';
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'wiki.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const CATEGORIES = ['도시괴담', '학교괴담', '인터넷괴담', '실화괴담', '기타'];
const MAX_TITLE = 80;
const MAX_CONTENT = 50000;
const MAX_PENDING = 500;
const MAX_BODY = 200 * 1024;

if (ADMIN_PASSWORD === 'change-me') {
  console.warn('[경고] ADMIN_PASSWORD 환경변수가 설정되지 않았습니다. 기본 비밀번호 "change-me"가 사용됩니다. 꼭 바꿔주세요!');
}

// ---------- 저장소 ----------
let db = { pages: {}, proposals: [], nextId: 1 };

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('데이터 로드 실패, 새로 시작합니다:', e.message);
  }
  if (!db.pages || !db.pages['대문']) {
    const now = Date.now();
    db.pages = db.pages || {};
    db.proposals = db.proposals || [];
    const content =
      '== 괴담 위키에 오신 것을 환영합니다 ==\n' +
      '여기는 누구나 괴담을 적고 고칠 수 있는 위키입니다.\n' +
      '* 문서를 고치거나 새로 만들면 **편집 제안**으로 접수됩니다.\n' +
      '* 관리자가 승인하면 그때 문서에 반영됩니다.\n' +
      '* 문서끼리는 [[문서이름]] 형태로 연결할 수 있습니다.\n\n' +
      '=== 작성 안내 ===\n' +
      '> 실제 인물·단체를 비방하거나 특정할 수 있는 내용은 승인되지 않을 수 있습니다.\n';
    db.pages['대문'] = {
      title: '대문',
      category: '기타',
      content,
      updatedAt: now,
      revisions: [{ id: 1, content, category: '기타', author: '관리자', summary: '문서 생성', at: now }]
    };
    db.nextId = Math.max(db.nextId || 1, 2);
    save();
  }
}

let saving = false, dirty = false;
function save() {
  if (saving) { dirty = true; return; }
  saving = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('저장 실패:', e.message);
  }
  saving = false;
  if (dirty) { dirty = false; save(); }
}

// ---------- 관리자 인증 ----------
const tokens = new Map(); // token -> expiresAt
const TOKEN_TTL = 1000 * 60 * 60 * 12;
const loginFails = new Map(); // ip -> {count, until}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  if (!t) return false;
  const exp = tokens.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { tokens.delete(t); return false; }
  return true;
}

// ---------- 제안 속도 제한 ----------
const proposeLog = new Map(); // ip -> [timestamps]
function proposeLimited(ip) {
  const now = Date.now();
  const arr = (proposeLog.get(ip) || []).filter(t => now - t < 60 * 1000);
  if (arr.length >= 5) { proposeLog.set(ip, arr); return true; }
  arr.push(now);
  proposeLog.set(ip, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of tokens) if (exp < now) tokens.delete(t);
  for (const [ip, arr] of proposeLog) if (!arr.some(t => now - t < 60 * 1000)) proposeLog.delete(ip);
  for (const [ip, f] of loginFails) if (f.until < now && f.count < 5) loginFails.delete(ip);
}, 10 * 60 * 1000).unref();

// ---------- 유틸 ----------
function cleanTitle(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}
function cleanCategory(c) {
  return CATEGORIES.includes(c) ? c : '기타';
}
function cleanAuthor(a) {
  const s = String(a || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return s || '익명';
}
function clientIp(req) {
  // 프록시(Render 등) 뒤에서는 가장 오른쪽 X-Forwarded-For 값을 사용
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('잘못된 요청 형식입니다.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// ---------- 문서 반영 ----------
function applyRevision(title, content, category, author, summary) {
  const now = Date.now();
  let p = db.pages[title];
  if (!p) {
    p = db.pages[title] = { title, content: '', category: '기타', updatedAt: now, revisions: [] };
  }
  const rev = { id: db.nextId++, content, category, author, summary, at: now };
  p.revisions.push(rev);
  p.content = content;
  p.category = category;
  p.updatedAt = now;
  if (p.revisions.length > 200) p.revisions.splice(0, p.revisions.length - 200);
  return rev;
}
function trimProposals() {
  const done = db.proposals.filter(x => x.status !== 'pending');
  if (done.length > 300) {
    const drop = new Set(done.sort((a, b) => a.decidedAt - b.decidedAt).slice(0, done.length - 300).map(x => x.id));
    db.proposals = db.proposals.filter(x => !drop.has(x.id));
  }
}

// ---------- API 라우트 ----------
const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, admin: !!opts.admin, handler });
}

route('GET', '/api/info', (req, res) => {
  sendJson(res, 200, { version: VERSION, categories: CATEGORIES, admin: isAdmin(req) });
});

route('POST', '/api/admin/login', (req, res) => {
  const ip = clientIp(req);
  const f = loginFails.get(ip);
  if (f && f.until > Date.now()) {
    return sendJson(res, 429, { error: '시도가 너무 많습니다. 잠시 후 다시 해주세요.' });
  }
  if (safeEqual(req.body && req.body.password, ADMIN_PASSWORD)) {
    loginFails.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, Date.now() + TOKEN_TTL);
    return sendJson(res, 200, { token });
  }
  const cnt = (f ? f.count : 0) + 1;
  loginFails.set(ip, { count: cnt, until: cnt >= 5 ? Date.now() + 5 * 60 * 1000 : 0 });
  sendJson(res, 401, { error: '비밀번호가 틀렸습니다.' });
});

route('POST', '/api/admin/logout', (req, res) => {
  const t = req.headers['x-admin-token'];
  if (t) tokens.delete(t);
  sendJson(res, 200, { ok: true });
});

// 문서 목록
route('GET', '/api/pages', (req, res) => {
  const list = Object.values(db.pages).map(p => ({
    title: p.title, category: p.category, updatedAt: p.updatedAt
  }));
  list.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  sendJson(res, 200, list);
});

// 최근 변경
route('GET', '/api/recent', (req, res) => {
  const list = Object.values(db.pages).map(p => {
    const last = p.revisions[p.revisions.length - 1];
    return { title: p.title, category: p.category, updatedAt: p.updatedAt, author: last && last.author, summary: last && last.summary };
  });
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  sendJson(res, 200, list.slice(0, 20));
});

// 검색
route('GET', '/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return sendJson(res, 200, []);
  const out = [];
  for (const p of Object.values(db.pages)) {
    const inTitle = p.title.toLowerCase().includes(q);
    const idx = p.content.toLowerCase().indexOf(q);
    if (inTitle || idx >= 0) {
      let snippet = '';
      if (idx >= 0) snippet = p.content.slice(Math.max(0, idx - 30), idx + 70).replace(/\s+/g, ' ');
      out.push({ title: p.title, category: p.category, snippet, inTitle });
    }
  }
  out.sort((a, b) => (b.inTitle ? 1 : 0) - (a.inTitle ? 1 : 0));
  sendJson(res, 200, out.slice(0, 50));
});

// 문서 보기
route('GET', '/api/pages/:title', (req, res, params) => {
  const title = cleanTitle(params.title);
  const p = db.pages[title];
  const pending = db.proposals.filter(x => x.status === 'pending' && x.title === title).length;
  if (!p) return sendJson(res, 404, { error: '문서가 없습니다.', pending });
  sendJson(res, 200, {
    title: p.title, category: p.category, content: p.content,
    updatedAt: p.updatedAt, revCount: p.revisions.length, pending
  });
});

// 문서 역사
route('GET', '/api/pages/:title/history', (req, res, params) => {
  const title = cleanTitle(params.title);
  const p = db.pages[title];
  if (!p) return sendJson(res, 404, { error: '문서가 없습니다.' });
  sendJson(res, 200, p.revisions.slice().reverse().map(r => ({
    id: r.id, author: r.author, summary: r.summary, at: r.at, category: r.category, content: r.content
  })));
});

// 편집 제안 (누구나)
route('POST', '/api/proposals', (req, res) => {
  if (proposeLimited(clientIp(req))) {
    return sendJson(res, 429, { error: '제안을 너무 자주 보내고 있습니다. 잠시 후 다시 해주세요.' });
  }
  const b = req.body || {};
  const title = cleanTitle(b.title);
  const content = String(b.content || '');
  if (!title) return sendJson(res, 400, { error: '제목을 입력해주세요.' });
  if (!content.trim()) return sendJson(res, 400, { error: '내용을 입력해주세요.' });
  if (content.length > MAX_CONTENT) return sendJson(res, 400, { error: '내용이 너무 깁니다.' });
  if (db.proposals.filter(x => x.status === 'pending').length >= MAX_PENDING) {
    return sendJson(res, 503, { error: '대기 중인 제안이 너무 많습니다. 나중에 다시 시도해주세요.' });
  }
  const existing = db.pages[title];
  if (existing && existing.content === content && existing.category === cleanCategory(b.category)) {
    return sendJson(res, 400, { error: '기존 문서와 달라진 내용이 없습니다.' });
  }
  const prop = {
    id: db.nextId++,
    title,
    content,
    category: cleanCategory(b.category),
    author: cleanAuthor(b.author),
    summary: String(b.summary || '').trim().slice(0, 100),
    isNew: !existing,
    baseRev: existing ? existing.revisions[existing.revisions.length - 1].id : 0,
    createdAt: Date.now(),
    status: 'pending'
  };
  db.proposals.push(prop);
  save();
  sendJson(res, 200, { ok: true, id: prop.id });
});

// 대기 중 제안 목록 (관리자)
route('GET', '/api/proposals', { admin: true }, (req, res) => {
  const onlyPending = req.query.status !== 'all';
  const list = db.proposals
    .filter(x => !onlyPending || x.status === 'pending')
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(x => {
      const cur = db.pages[x.title];
      const lastRev = cur ? cur.revisions[cur.revisions.length - 1].id : 0;
      return Object.assign({}, x, {
        currentContent: cur ? cur.content : '',
        currentCategory: cur ? cur.category : null,
        outdated: !!cur && lastRev !== x.baseRev
      });
    });
  sendJson(res, 200, list);
});

// 승인
route('POST', '/api/proposals/:id/approve', { admin: true }, (req, res, params) => {
  const prop = db.proposals.find(x => x.id === Number(params.id));
  if (!prop || prop.status !== 'pending') return sendJson(res, 404, { error: '대기 중인 제안이 없습니다.' });
  applyRevision(prop.title, prop.content, prop.category, prop.author, prop.summary || (prop.isNew ? '새 문서' : '편집'));
  prop.status = 'approved';
  prop.decidedAt = Date.now();
  trimProposals();
  save();
  sendJson(res, 200, { ok: true });
});

// 거절
route('POST', '/api/proposals/:id/reject', { admin: true }, (req, res, params) => {
  const prop = db.proposals.find(x => x.id === Number(params.id));
  if (!prop || prop.status !== 'pending') return sendJson(res, 404, { error: '대기 중인 제안이 없습니다.' });
  prop.status = 'rejected';
  prop.decidedAt = Date.now();
  trimProposals();
  save();
  sendJson(res, 200, { ok: true });
});

// 관리자 직접 저장
route('PUT', '/api/pages/:title', { admin: true }, (req, res, params) => {
  const title = cleanTitle(params.title);
  const b = req.body || {};
  const content = String(b.content || '');
  if (!title) return sendJson(res, 400, { error: '제목이 필요합니다.' });
  if (!content.trim()) return sendJson(res, 400, { error: '내용을 입력해주세요.' });
  if (content.length > MAX_CONTENT) return sendJson(res, 400, { error: '내용이 너무 깁니다.' });
  applyRevision(title, content, cleanCategory(b.category), '관리자', String(b.summary || '').slice(0, 100) || '관리자 편집');
  save();
  sendJson(res, 200, { ok: true });
});

// 문서 삭제 (관리자)
route('DELETE', '/api/pages/:title', { admin: true }, (req, res, params) => {
  const title = cleanTitle(params.title);
  if (title === '대문') return sendJson(res, 400, { error: '대문은 삭제할 수 없습니다.' });
  if (!db.pages[title]) return sendJson(res, 404, { error: '문서가 없습니다.' });
  delete db.pages[title];
  save();
  sendJson(res, 200, { ok: true });
});

// 되돌리기 (관리자)
route('POST', '/api/pages/:title/rollback/:rev', { admin: true }, (req, res, params) => {
  const title = cleanTitle(params.title);
  const p = db.pages[title];
  if (!p) return sendJson(res, 404, { error: '문서가 없습니다.' });
  const r = p.revisions.find(x => x.id === Number(params.rev));
  if (!r) return sendJson(res, 404, { error: '해당 판이 없습니다.' });
  applyRevision(title, r.content, r.category, '관리자', `#${r.id} 판으로 되돌림`);
  save();
  sendJson(res, 200, { ok: true });
});

// ---------- 정적 파일 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { rel = ''; }
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- 서버 ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, pathname);
    }

    let matched = null, params = {}, pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      matched = r;
      r.keys.forEach((k, i) => {
        try { params[k] = decodeURIComponent(m[i + 1]); } catch (e) { params[k] = m[i + 1]; }
      });
      break;
    }
    if (!matched) return sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? '허용되지 않는 요청입니다.' : '찾을 수 없습니다.' });
    if (matched.admin && !isAdmin(req)) return sendJson(res, 401, { error: '관리자 로그인이 필요합니다.' });

    req.query = Object.fromEntries(url.searchParams);
    req.body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};
    matched.handler(req, res, params);
  } catch (e) {
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : '서버 오류가 발생했습니다.' });
    else res.end();
    if (!e.status) console.error(e);
  }
});

load();
server.listen(PORT, () => {
  console.log(`괴담 위키 v${VERSION} 실행 중: http://localhost:${PORT}`);
});
