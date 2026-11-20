// 괴현상관리국 v1.4.0 - Cloudflare Workers + D1
// - 누구나 문서 작성/수정 "제안"을 보낼 수 있고, 관리자가 승인해야 문서에 반영됩니다.
// - 정적 파일(public/)은 Workers Assets가, /api/* 는 이 파일이 처리합니다.

const VERSION = '1.4.0';
// v1.3.0부터 분류 기능은 없습니다. 이미 만들어진 DB의 category 열과 호환되도록 열은 남겨두고 항상 이 값만 넣습니다.
const NO_CATEGORY = '기타';
const MAX_TITLE = 80;
const MAX_CONTENT = 50000;
const MAX_PENDING = 500;
const MAX_BODY = 200 * 1024;
const IMPORT_MAX_BODY = 8 * 1024 * 1024; // 백업 복원 파일 최대 크기
const IMPORT_MAX_PAGES = 500;            // 한 번에 복원할 수 있는 문서 수
const MAX_REVISIONS = 200;
const MAX_DONE_PROPOSALS = 300;
const TOKEN_TTL = 12 * 60 * 60 * 1000;

// ---------- 스키마 (처음 요청 때 자동 생성) ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pages (
    title TEXT PRIMARY KEY,
    category TEXT NOT NULL DEFAULT '기타',
    scare INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    scare INTEGER NOT NULL DEFAULT 0,
    author TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rev_title ON revisions(title, id)`,
  `CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    scare INTEGER NOT NULL DEFAULT 0,
    author TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    is_new INTEGER NOT NULL DEFAULT 0,
    base_rev INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_at INTEGER,
    reason TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_prop_status ON proposals(status, id)`,
  `CREATE TABLE IF NOT EXISTS ratelimit (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reactions (
    title TEXT NOT NULL,
    who TEXT NOT NULL,
    PRIMARY KEY (title, who)
  )`
];

const HOME_TEXT =
  '== 괴현상관리국에 오신 것을 환영합니다 ==\n' +
  '누구나 괴담을 적고 고칠 수 있습니다. 다만 고친 내용은 바로 실리지 않고, 관리자가 확인해 승인한 것만 문서에 남습니다.\n' +
  '* 문서를 만들거나 고치면 **편집 제안**으로 접수됩니다.\n' +
  '* 접수한 제안이 어떻게 처리됐는지는 [[도움말]]에 적힌 "내 제안" 메뉴에서 볼 수 있습니다.\n' +
  '* 문서끼리는 [[문서이름]] 형태로 연결합니다.\n\n' +
  '=== 지켜야 할 것 ===\n' +
  '> 실제 인물이나 단체를 지목하거나 비방하는 내용은 승인되지 않습니다.\n' +
  '* 직접 겪었거나 들은 이야기라면 출처를 함께 적어주세요.\n' +
  '* 결말을 가리고 싶을 땐 ||이렇게 감싸면|| 클릭해야 보입니다.\n';

const HELP_TEXT =
  '== 글쓰기 문법 ==\n' +
  '문서는 아래 문법으로 꾸밉니다.\n\n' +
  '=== 제목 ===\n' +
  '* `== 큰 제목 ==` 은 큰 제목, `=== 작은 제목 ===` 은 작은 제목입니다.\n' +
  '* 큰 제목과 작은 제목은 문서 위쪽 목차에 자동으로 모입니다.\n\n' +
  '=== 글꼴과 목록 ===\n' +
  '* `**굵게**` 로 강조합니다.\n' +
  '* 줄 맨 앞에 `* ` 를 쓰면 목록, `1. ` 을 쓰면 번호 목록이 됩니다.\n' +
  '* 줄 맨 앞에 `> ` 를 쓰면 인용입니다.\n' +
  '* `---` 만 쓴 줄은 구분선입니다.\n\n' +
  '=== 연결과 가리기 ===\n' +
  '* `[[문서이름]]` 으로 다른 문서에 연결합니다. 없는 문서는 붉은 점선으로 보이고, 눌러서 새로 만들 수 있습니다.\n' +
  '* `[[문서이름|보일 글자]]` 로 표시 글자를 바꿀 수 있습니다.\n' +
  '* `||가릴 내용||` 은 눌러야 보입니다. 결말이나 반전을 가릴 때 쓰세요.\n\n' +
  '=== 제안이 처리되는 과정 ===\n' +
  '* 제안을 보내면 번호가 생기고, 이 브라우저의 "내 제안"에서 대기·승인·거절 여부와 거절 사유를 볼 수 있습니다.\n' +
  '* 관리자는 바뀐 줄만 비교해서 보고 승인하거나 거절합니다.\n';

// ---------- 공통 유틸 ----------
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(s) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(String(s))));
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function timingEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function cleanTitle(t) {
  return String(t || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\[\]|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);
}
function cleanScare(n) {
  n = parseInt(n, 10);
  return Number.isFinite(n) ? Math.min(5, Math.max(0, n)) : 0;
}
function cleanAuthor(a) {
  const s = String(a || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20);
  return s || '익명';
}
function escLike(s) {
  return String(s).replace(/[\\%_]/g, m => '\\' + m);
}
function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// ---------- 사람 확인 (Cloudflare Turnstile, 선택 사항) ----------
// TURNSTILE_SITE_KEY 와 TURNSTILE_SECRET 이 둘 다 설정돼 있을 때만 켜집니다.
function turnstileOn(env) {
  return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
}
async function verifyTurnstile(request, env, token) {
  if (!turnstileOn(env)) return;
  if (!token || typeof token !== 'string' || token.length > 2048) {
    throw new HttpError(400, '"로봇이 아닙니다" 확인을 먼저 완료해주세요.');
  }
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.set('remoteip', ip);
  let ok = false;
  try {
    const r = await fetch(env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    ok = !!(await r.json()).success;
  } catch (e) {
    throw new HttpError(503, '사람 확인 서버에 연결하지 못했습니다. 잠시 뒤에 다시 시도해주세요.');
  }
  if (!ok) throw new HttpError(400, '사람 확인에 실패했습니다. 다시 확인해주세요.');
}

// ---------- 관리자 인증 (서명 토큰, 서버에 세션을 저장하지 않음) ----------
async function makeToken(env) {
  const exp = String(Date.now() + TOKEN_TTL);
  return exp + '.' + await hmacHex(env.ADMIN_PASSWORD, 'admin:' + exp);
}
async function isAdmin(request, env) {
  const t = request.headers.get('x-admin-token');
  if (!t || !env.ADMIN_PASSWORD) return false;
  const dot = t.indexOf('.');
  if (dot < 1) return false;
  const exp = t.slice(0, dot);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return timingEq(t.slice(dot + 1), await hmacHex(env.ADMIN_PASSWORD, 'admin:' + exp));
}

// ---------- 속도 제한 (D1에 저장) ----------
async function rateCheck(env, key) {
  const row = await env.DB.prepare('SELECT count, reset_at FROM ratelimit WHERE key=?').bind(key).first();
  if (!row || row.reset_at < Date.now()) return 0;
  return row.count;
}
async function rateHit(env, key, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT count, reset_at FROM ratelimit WHERE key=?').bind(key).first();
  if (!row || row.reset_at < now) {
    await env.DB.prepare('INSERT OR REPLACE INTO ratelimit(key,count,reset_at) VALUES(?,1,?)').bind(key, now + windowMs).run();
    return 1;
  }
  await env.DB.prepare('UPDATE ratelimit SET count=count+1 WHERE key=?').bind(key).run();
  return row.count + 1;
}

// ---------- 문서 반영 ----------
function applyStmts(env, d, now, trim = true) {
  const stmts = [
    env.DB.prepare('INSERT INTO revisions(title,content,category,scare,author,summary,at) VALUES(?,?,?,?,?,?,?)')
      .bind(d.title, d.content, NO_CATEGORY, d.scare, d.author, d.summary, now),
    env.DB.prepare(
      `INSERT INTO pages(title,category,scare,content,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(title) DO UPDATE SET category=excluded.category, scare=excluded.scare,
         content=excluded.content, updated_at=excluded.updated_at`
    ).bind(d.title, NO_CATEGORY, d.scare, d.content, now)
  ];
  if (trim) {
    stmts.push(env.DB.prepare(
      'DELETE FROM revisions WHERE title=? AND id NOT IN (SELECT id FROM revisions WHERE title=? ORDER BY id DESC LIMIT ?)'
    ).bind(d.title, d.title, MAX_REVISIONS));
  }
  return stmts;
}

// 오늘의 괴담용 요약: 제목 줄과 가려진 내용(||...||)은 빼고 첫머리만 보여줍니다.
function makeExcerpt(text) {
  const parts = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || /^={2,}/.test(t) || /^-{3,}$/.test(t)) continue;
    parts.push(t.replace(/^(>|\*\s)\s*/, '').replace(/^\d+\.\s+/, ''));
    if (parts.join(' ').length > 160) break;
  }
  const s = parts.join(' ')
    .replace(/\|\|.+?\|\|/g, '…')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`/g, '');
  return s.length > 110 ? s.slice(0, 110).trim() + '…' : s;
}

// 새 제안 알림 (NOTIFY_WEBHOOK_URL 이 설정돼 있을 때만, Discord 웹훅 형식)
function notifyNewProposal(c, id, title, isNew, author) {
  const url = c.env.NOTIFY_WEBHOOK_URL;
  if (!url || !/^https?:\/\//.test(url)) return;
  const text = `새 제안 #${id}: 「${title}」 (${isNew ? '새 문서' : '편집'}, ${author})\n승인하러 가기: ${new URL(c.request.url).origin}/#/admin`.slice(0, 1800);
  const job = fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '괴현상관리국', content: text, text, allowed_mentions: { parse: [] } })
  }).catch(() => {});
  if (c.ctx && c.ctx.waitUntil) c.ctx.waitUntil(job);
}
function trimProposalsStmt(env) {
  return env.DB.prepare(
    `DELETE FROM proposals WHERE status != 'pending' AND id NOT IN
     (SELECT id FROM proposals WHERE status != 'pending' ORDER BY id DESC LIMIT ?)`
  ).bind(MAX_DONE_PROPOSALS);
}

// ---------- 초기화 ----------
let initPromise = null;
function init(env) {
  if (!initPromise) {
    initPromise = (async () => {
      await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
      const home = await env.DB.prepare("SELECT 1 AS x FROM pages WHERE title='대문'").first();
      if (!home) {
        const now = Date.now();
        const stmts = [];
        stmts.push(...applyStmts(env, { title: '대문', content: HOME_TEXT, scare: 0, author: '관리자', summary: '문서 생성' }, now));
        stmts.push(...applyStmts(env, { title: '도움말', content: HELP_TEXT, scare: 0, author: '관리자', summary: '문서 생성' }, now));
        await env.DB.batch(stmts);
      }
      await env.DB.prepare('DELETE FROM ratelimit WHERE reset_at < ?').bind(Date.now()).run();
    })().catch(e => { initPromise = null; throw e; });
  }
  return initPromise;
}

// ---------- 라우터 ----------
const routes = [];
function route(method, pattern, admin, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, admin, handler });
}

async function readJson(request, limit = MAX_BODY) {
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, '요청이 너무 큽니다.');
  if (!text) return {};
  try { return JSON.parse(text); }
  catch (e) { throw new HttpError(400, '요청 형식이 올바르지 않습니다.'); }
}

// ----- 공개 API -----
route('GET', '/api/info', false, async c => {
  const out = {
    version: VERSION, admin: c.admin, configured: !!c.env.ADMIN_PASSWORD,
    turnstileSiteKey: turnstileOn(c.env) ? String(c.env.TURNSTILE_SITE_KEY) : ''
  };
  if (c.admin) {
    out.pending = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status='pending'").first()).n;
  }
  return json(out);
});

route('POST', '/api/admin/login', false, async c => {
  if (!c.env.ADMIN_PASSWORD) {
    throw new HttpError(500, '관리자 비밀번호가 아직 설정되지 않았습니다. README의 "비밀번호 설정" 단계를 먼저 진행해주세요.');
  }
  const key = 'l:' + clientIp(c.request);
  if ((await rateCheck(c.env, key)) >= 5) {
    throw new HttpError(429, '로그인 시도가 너무 많습니다. 5분 뒤에 다시 해주세요.');
  }
  const body = await readJson(c.request);
  const ok = timingEq(await sha256Hex(body.password || ''), await sha256Hex(c.env.ADMIN_PASSWORD));
  if (!ok) {
    await rateHit(c.env, key, 5 * 60 * 1000);
    throw new HttpError(401, '비밀번호가 맞지 않습니다.');
  }
  await c.env.DB.prepare('DELETE FROM ratelimit WHERE key=?').bind(key).run();
  return json({ token: await makeToken(c.env) });
});

route('GET', '/api/pages', false, async c => {
  const { results } = await c.env.DB.prepare('SELECT title, scare, updated_at AS updatedAt, (SELECT COUNT(*) FROM reactions r WHERE r.title = pages.title) AS reactions FROM pages').all();
  results.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  return json(results);
});

route('GET', '/api/recent', false, async c => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.title, p.scare, p.updated_at AS updatedAt, r.author, r.summary
     FROM pages p LEFT JOIN revisions r ON r.id = (SELECT MAX(id) FROM revisions WHERE title = p.title)
     ORDER BY p.updated_at DESC LIMIT 30`
  ).all();
  return json(results);
});

route('GET', '/api/random', false, async c => {
  const row = await c.env.DB.prepare("SELECT title FROM pages WHERE title NOT IN ('대문','도움말') ORDER BY RANDOM() LIMIT 1").first();
  return json({ title: row ? row.title : null });
});

route('GET', '/api/search', false, async c => {
  const q = String(c.url.searchParams.get('q') || '').trim().slice(0, 100);
  if (!q) return json([]);
  const like = '%' + escLike(q) + '%';
  const { results } = await c.env.DB.prepare(
    `SELECT title, scare, content FROM pages
     WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' LIMIT 80`
  ).bind(like, like).all();
  const ql = q.toLowerCase();
  const out = results.map(p => {
    const idx = p.content.toLowerCase().indexOf(ql);
    return {
      title: p.title, scare: p.scare,
      inTitle: p.title.toLowerCase().includes(ql),
      snippet: idx >= 0 ? p.content.slice(Math.max(0, idx - 30), idx + 90).replace(/\s+/g, ' ') : ''
    };
  });
  out.sort((a, b) => (b.inTitle ? 1 : 0) - (a.inTitle ? 1 : 0));
  return json(out.slice(0, 50));
});

route('GET', '/api/pages/:title', false, async c => {
  const title = cleanTitle(c.params.title);
  const db = c.env.DB;
  const pending = (await db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status='pending' AND title=?").bind(title).first()).n;
  const p = await db.prepare('SELECT title, scare, content, updated_at, (SELECT COUNT(*) FROM reactions r WHERE r.title = pages.title) AS reactions FROM pages WHERE title=?').bind(title).first();
  if (!p) return json({ error: '문서가 없습니다.', pending }, 404);
  const revCount = (await db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE title=?').bind(title).first()).n;
  const t = escLike(title);
  const { results: bl } = await db.prepare(
    `SELECT title FROM pages WHERE title != ? AND (content LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY title LIMIT 50`
  ).bind(title, '%[[' + t + ']]%', '%[[' + t + '|%').all();
  return json({
    title: p.title, scare: p.scare, content: p.content,
    updatedAt: p.updated_at, revCount, pending, reactions: p.reactions, backlinks: bl.map(x => x.title)
  });
});

route('GET', '/api/pages/:title/history', false, async c => {
  const title = cleanTitle(c.params.title);
  const { results } = await c.env.DB.prepare(
    'SELECT id, author, summary, at, scare FROM revisions WHERE title=? ORDER BY id DESC LIMIT ?'
  ).bind(title, MAX_REVISIONS).all();
  if (!results.length) throw new HttpError(404, '문서가 없습니다.');
  return json(results);
});

route('GET', '/api/pages/:title/rev/:id', false, async c => {
  const title = cleanTitle(c.params.title);
  const id = Number(c.params.id);
  const db = c.env.DB;
  const rev = await db.prepare('SELECT id, author, summary, at, scare, content FROM revisions WHERE title=? AND id=?').bind(title, id).first();
  if (!rev) throw new HttpError(404, '해당 판이 없습니다.');
  const prev = await db.prepare('SELECT content, scare FROM revisions WHERE title=? AND id<? ORDER BY id DESC LIMIT 1').bind(title, id).first();
  return json({ rev, prev: prev || null });
});

// 편집 제안 (누구나)
route('POST', '/api/proposals', false, async c => {
  const db = c.env.DB;
  const ip = clientIp(c.request);
  if ((await rateHit(c.env, 'p:' + ip, 60 * 1000)) > 5) {
    throw new HttpError(429, '제안을 너무 자주 보내고 있습니다. 1분 뒤에 다시 보내주세요.');
  }
  const b = await readJson(c.request);
  await verifyTurnstile(c.request, c.env, b.turnstile);
  const title = cleanTitle(b.title);
  const content = String(b.content || '').replace(/\r/g, '');
  if (!title) throw new HttpError(400, '제목을 입력해주세요.');
  if (!content.trim()) throw new HttpError(400, '내용을 입력해주세요.');
  if (content.length > MAX_CONTENT) throw new HttpError(400, `내용이 너무 깁니다. ${MAX_CONTENT.toLocaleString('ko-KR')}자까지 쓸 수 있습니다.`);
  const pend = (await db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status='pending'").first()).n;
  if (pend >= MAX_PENDING) throw new HttpError(503, '대기 중인 제안이 너무 많습니다. 잠시 뒤에 다시 보내주세요.');

  const scare = cleanScare(b.scare);
  const existing = await db.prepare('SELECT content, scare FROM pages WHERE title=?').bind(title).first();
  if (existing && existing.content === content && existing.scare === scare) {
    throw new HttpError(400, '현재 문서와 달라진 내용이 없습니다.');
  }
  let baseRev = 0;
  if (existing) {
    const r = await db.prepare('SELECT MAX(id) AS m FROM revisions WHERE title=?').bind(title).first();
    baseRev = (r && r.m) || 0;
  }
  const res = await db.prepare(
    `INSERT INTO proposals(title,content,category,scare,author,summary,is_new,base_rev,created_at,status)
     VALUES(?,?,?,?,?,?,?,?,?, 'pending')`
  ).bind(title, content, NO_CATEGORY, scare, cleanAuthor(b.author), String(b.summary || '').trim().slice(0, 100), existing ? 0 : 1, baseRev, Date.now()).run();
  notifyNewProposal(c, res.meta.last_row_id, title, !existing, cleanAuthor(b.author));
  return json({ ok: true, id: res.meta.last_row_id });
});

// 내가 보낸 제안의 처리 상태 (번호로만 조회, 내용은 돌려주지 않음)
route('POST', '/api/proposals/status', false, async c => {
  const b = await readJson(c.request);
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 30);
  if (!ids.length) return json([]);
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, status, reason, created_at AS createdAt, decided_at AS decidedAt
     FROM proposals WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();
  return json(results);
});

// ----- 관리자 API -----
route('GET', '/api/proposals', true, async c => {
  const db = c.env.DB;
  const done = c.url.searchParams.get('status') === 'done';
  let results;
  if (done) {
    ({ results } = await db.prepare(
      `SELECT id, title, scare, author, summary, is_new AS isNew, created_at AS createdAt,
              status, decided_at AS decidedAt, reason
       FROM proposals WHERE status != 'pending' ORDER BY id DESC LIMIT 100`
    ).all());
  } else {
    ({ results } = await db.prepare(
      `SELECT pr.id, pr.title, pr.content, pr.scare, pr.author, pr.summary, pr.is_new AS isNew,
              pr.base_rev AS baseRev, pr.created_at AS createdAt, pr.status,
              p.content AS curContent, p.scare AS curScare,
              (SELECT MAX(id) FROM revisions WHERE title = pr.title) AS lastRev
       FROM proposals pr LEFT JOIN pages p ON p.title = pr.title
       WHERE pr.status = 'pending' ORDER BY pr.id DESC LIMIT 100`
    ).all());
    results.forEach(r => { r.outdated = r.curContent != null && (r.lastRev || 0) !== r.baseRev; });
  }
  return json(results);
});

route('POST', '/api/proposals/:id/approve', true, async c => {
  const db = c.env.DB;
  const id = Number(c.params.id);
  const prop = await db.prepare("SELECT * FROM proposals WHERE id=? AND status='pending'").bind(id).first();
  if (!prop) throw new HttpError(404, '대기 중인 제안이 없습니다. 이미 처리됐을 수 있습니다.');

  // 본문(content)을 함께 보내면 관리자가 고친 내용으로 반영합니다.
  const b = await readJson(c.request);
  let content = prop.content, scare = prop.scare, edited = false;
  if (typeof b.content === 'string') {
    content = b.content.replace(/\r/g, '');
    if (!content.trim()) throw new HttpError(400, '내용을 입력해주세요.');
    if (content.length > MAX_CONTENT) throw new HttpError(400, '내용이 너무 깁니다.');
    scare = b.scare !== undefined ? cleanScare(b.scare) : prop.scare;
    edited = content !== prop.content.replace(/\r/g, '') || scare !== prop.scare;
  }
  let summary = prop.summary || (prop.is_new ? '새 문서' : '편집');
  if (edited) summary = summary.slice(0, 88) + ' (관리자 수정)';

  const now = Date.now();
  await db.batch([
    ...applyStmts(c.env, { title: prop.title, content, scare, author: prop.author, summary }, now),
    db.prepare("UPDATE proposals SET status='approved', decided_at=? WHERE id=?").bind(now, id),
    trimProposalsStmt(c.env)
  ]);
  return json({ ok: true });
});

route('POST', '/api/proposals/:id/reject', true, async c => {
  const db = c.env.DB;
  const id = Number(c.params.id);
  const b = await readJson(c.request);
  const reason = String(b.reason || '').trim().slice(0, 200);
  const res = await db.prepare("UPDATE proposals SET status='rejected', decided_at=?, reason=? WHERE id=? AND status='pending'")
    .bind(Date.now(), reason, id).run();
  if (!res.meta.changes) throw new HttpError(404, '대기 중인 제안이 없습니다. 이미 처리됐을 수 있습니다.');
  await trimProposalsStmt(c.env).run();
  return json({ ok: true });
});

route('PUT', '/api/pages/:title', true, async c => {
  const title = cleanTitle(c.params.title);
  const b = await readJson(c.request);
  const content = String(b.content || '').replace(/\r/g, '');
  if (!title) throw new HttpError(400, '제목이 필요합니다.');
  if (!content.trim()) throw new HttpError(400, '내용을 입력해주세요.');
  if (content.length > MAX_CONTENT) throw new HttpError(400, '내용이 너무 깁니다.');
  await c.env.DB.batch(applyStmts(c.env, {
    title, content, scare: cleanScare(b.scare),
    author: '관리자', summary: String(b.summary || '').trim().slice(0, 100) || '관리자 편집'
  }, Date.now()));
  return json({ ok: true });
});

// 오늘의 괴담: 날짜(한국 시간)마다 문서 한 편을 고정으로 보여줍니다.
route('GET', '/api/today', false, async c => {
  const db = c.env.DB;
  const where = "WHERE title NOT IN ('대문','도움말')";
  const n = (await db.prepare(`SELECT COUNT(*) AS n FROM pages ${where}`).first()).n;
  if (!n) return json({ title: null });
  const day = Math.floor((Date.now() + 9 * 3600 * 1000) / 86400000);
  const p = await db.prepare(`SELECT title, scare, content FROM pages ${where} ORDER BY title LIMIT 1 OFFSET ?`).bind(day % n).first();
  return json({ title: p.title, scare: p.scare, excerpt: makeExcerpt(p.content) });
});

// "무서웠어요" 반응: 사람마다(접속 정보 기준) 문서당 한 번만 셉니다.
route('POST', '/api/pages/:title/react', false, async c => {
  const db = c.env.DB;
  const title = cleanTitle(c.params.title);
  const ip = clientIp(c.request);
  if ((await rateHit(c.env, 'r:' + ip, 60 * 1000)) > 30) throw new HttpError(429, '너무 자주 누르고 있습니다. 잠시 뒤에 다시 눌러주세요.');
  const exists = await db.prepare('SELECT 1 AS x FROM pages WHERE title=?').bind(title).first();
  if (!exists) throw new HttpError(404, '문서가 없습니다.');
  const who = await sha256Hex(ip + '|' + title + '|' + (c.env.ADMIN_PASSWORD || ''));
  await db.prepare('INSERT OR IGNORE INTO reactions(title, who) VALUES(?, ?)').bind(title, who).run();
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE title=?').bind(title).first()).n;
  return json({ ok: true, reactions: n });
});

// 문서 내려받기 (관리자)
route('GET', '/api/admin/export', true, async c => {
  const db = c.env.DB;
  const withRev = c.url.searchParams.get('revisions') === '1';
  const { results: pages } = await db.prepare('SELECT title, scare, content, updated_at AS updatedAt FROM pages ORDER BY title').all();
  const byTitle = {};
  if (withRev) {
    const { results } = await db.prepare('SELECT title, author, summary, at, scare, content FROM revisions ORDER BY id').all();
    for (const r of results) (byTitle[r.title] = byTitle[r.title] || []).push({ author: r.author, summary: r.summary, at: r.at, scare: r.scare, content: r.content });
  }
  return json({
    app: 'gwandam-wiki', version: VERSION, exportedAt: Date.now(),
    pages: pages.map(p => withRev ? Object.assign({}, p, { revisions: byTitle[p.title] || [] }) : p)
  });
});

// 백업에서 복원 (관리자): 같은 내용은 건너뛰고, 다른 문서는 새 판으로 올립니다.
route('POST', '/api/admin/import', true, async c => {
  const db = c.env.DB;
  const b = await readJson(c.request, IMPORT_MAX_BODY);
  if (!b || b.app !== 'gwandam-wiki' || !Array.isArray(b.pages)) throw new HttpError(400, '괴현상관리국 백업 파일이 아닙니다.');
  if (b.pages.length > IMPORT_MAX_PAGES) throw new HttpError(400, `한 번에 ${IMPORT_MAX_PAGES}개 문서까지 복원할 수 있습니다.`);
  const { results: cur } = await db.prepare('SELECT title, content, scare FROM pages').all();
  const have = new Map(cur.map(r => [r.title, r]));
  const seen = new Set();
  const stmts = [];
  const now = Date.now();
  let imported = 0, skipped = 0, invalid = 0;
  for (const p of b.pages) {
    const title = cleanTitle(p && p.title);
    const content = String((p && p.content) || '').replace(/\r/g, '');
    if (!title || seen.has(title) || !content.trim() || content.length > MAX_CONTENT) { invalid++; continue; }
    seen.add(title);
    const scare = cleanScare(p.scare);
    const ex = have.get(title);
    if (ex && ex.content === content && ex.scare === scare) { skipped++; continue; }
    stmts.push(...applyStmts(c.env, { title, content, scare, author: '복원', summary: '백업에서 복원' }, now, false));
    imported++;
  }
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  return json({ ok: true, imported, skipped, invalid });
});

route('DELETE', '/api/pages/:title', true, async c => {
  const title = cleanTitle(c.params.title);
  if (title === '대문') throw new HttpError(400, '대문은 삭제할 수 없습니다.');
  const exists = await c.env.DB.prepare('SELECT 1 AS x FROM pages WHERE title=?').bind(title).first();
  if (!exists) throw new HttpError(404, '문서가 없습니다.');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM pages WHERE title=?').bind(title),
    c.env.DB.prepare('DELETE FROM revisions WHERE title=?').bind(title),
    c.env.DB.prepare('DELETE FROM reactions WHERE title=?').bind(title)
  ]);
  return json({ ok: true });
});

route('POST', '/api/pages/:title/rollback/:rev', true, async c => {
  const title = cleanTitle(c.params.title);
  const r = await c.env.DB.prepare('SELECT * FROM revisions WHERE title=? AND id=?').bind(title, Number(c.params.rev)).first();
  if (!r) throw new HttpError(404, '해당 판이 없습니다.');
  await c.env.DB.batch(applyStmts(c.env, {
    title, content: r.content, scare: r.scare,
    author: '관리자', summary: `#${r.id} 판으로 되돌림`
  }, Date.now()));
  return json({ ok: true });
});

// ---------- 진입점 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    try {
      if (!env.DB) throw new HttpError(500, 'D1 데이터베이스(DB)가 연결되지 않았습니다. wrangler.jsonc의 database_id를 확인해주세요.');
      await init(env);

      let matched = null, params = {}, pathHit = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathHit = true;
        if (r.method !== request.method) continue;
        matched = r;
        r.keys.forEach((k, i) => {
          try { params[k] = decodeURIComponent(m[i + 1]); } catch (e) { params[k] = m[i + 1]; }
        });
        break;
      }
      if (!matched) throw new HttpError(pathHit ? 405 : 404, pathHit ? '허용되지 않는 요청입니다.' : '찾을 수 없는 주소입니다.');

      const admin = await isAdmin(request, env);
      if (matched.admin && !admin) throw new HttpError(401, '관리자 로그인이 필요합니다.');
      return await matched.handler({ request, env, ctx, url, params, admin });
    } catch (e) {
      if (e instanceof HttpError) return json(Object.assign({ error: e.message }, e.extra), e.status);
      console.error(e);
      return json({ error: '서버에서 오류가 났습니다. 잠시 뒤에 다시 시도해주세요.' }, 500);
    }
  }
};
