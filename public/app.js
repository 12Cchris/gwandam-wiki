// 괴현상관리국 v1.4.0 - 화면 로직
'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const main = $('#main');
  const HOME = '대문';
  const MAX_CONTENT = 50000;

  let info = { version: '', admin: false, pending: 0 };
  let token = lsGet('adminToken') || '';
  let pages = [];
  let pageSet = new Set();

  // ---------- 저장소(브라우저) ----------
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 저장 불가 환경 */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* 저장 불가 환경 */ } }
  function lsJson(k, d) { try { return JSON.parse(lsGet(k)) || d; } catch (e) { return d; } }

  // ---------- 유틸 ----------
  const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ENT[c]);
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const enc = encodeURIComponent;
  const wlink = t => '#/w/' + enc(t);

  function fmt(t) {
    return new Date(t).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function ago(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return '방금';
    if (s < 3600) return Math.floor(s / 60) + '분 전';
    if (s < 86400) return Math.floor(s / 3600) + '시간 전';
    if (s < 86400 * 30) return Math.floor(s / 86400) + '일 전';
    return new Date(t).toLocaleDateString('ko-KR');
  }
  function toast(msg, type) {
    const d = document.createElement('div');
    d.className = 'toast ' + (type || '');
    d.textContent = msg;
    $('#toasts').appendChild(d);
    setTimeout(() => d.classList.add('out'), 3200);
    setTimeout(() => d.remove(), 3700);
  }

  async function api(path, opts = {}) {
    const headers = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['x-admin-token'] = token;
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* 본문 없음 */ }
    if (res.status === 401 && token && path !== '/api/admin/login') setToken('');
    if (!res.ok) {
      const err = new Error((data && data.error) || '요청에 실패했습니다. 잠시 뒤에 다시 시도해주세요.');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  function setToken(t) {
    token = t;
    if (t) lsSet('adminToken', t); else lsDel('adminToken');
    info.admin = !!t;
    if (!t) info.pending = 0;
    renderRail();
  }
  async function refreshInfo() {
    try {
      const i = await api('/api/info');
      info = Object.assign(info, i);
      if (token && !i.admin) { token = ''; lsDel('adminToken'); }
      info.admin = !!token && i.admin;
    } catch (e) { /* 연결 실패 시 기존 값 유지 */ }
  }
  async function refreshPages() {
    try {
      pages = await api('/api/pages');
      pageSet = new Set(pages.map(p => p.title));
    } catch (e) { /* 목록 실패해도 화면은 계속 */ }
    renderRail();
    return pages;
  }

  // ---------- 사람 확인(Turnstile) ----------
  let tsLoading = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (!tsLoading) {
      tsLoading = new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        sc.async = true;
        sc.onload = resolve;
        sc.onerror = () => { tsLoading = null; reject(new Error('사람 확인 위젯을 불러오지 못했습니다. 광고 차단 기능을 끄고 새로고침해주세요.')); };
        document.head.appendChild(sc);
      });
    }
    return tsLoading;
  }

  // ---------- 위키 문법 ----------
  function inline(raw) {
    let s = esc(raw);
    s = s.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (m, t, label) => {
      const target = unesc(t).trim();
      return `<a class="wl${pageSet.has(target) ? '' : ' missing'}" href="${wlink(target)}">${label || t}</a>`;
    });
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" tabindex="0" role="button" title="눌러서 보기">$1</span>');
    return s;
  }
  function render(text) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    let html = '', list = null, para = [], quote = [], n = 0;
    const toc = [];
    const flushQuote = () => { if (quote.length) { html += '<blockquote>' + quote.map(inline).join('<br>') + '</blockquote>'; quote = []; } };
    const flushPara = () => { flushQuote(); if (para.length) { html += '<p>' + para.map(inline).join('<br>') + '</p>'; para = []; } };
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    const openList = t => { if (list !== t) { closeList(); html += `<${t}>`; list = t; } };
    for (const line of lines) {
      let m;
      if ((m = line.match(/^===\s*(.+?)\s*===\s*$/))) {
        flushPara(); closeList(); const id = 'sec-' + (++n);
        toc.push({ id, level: 3, text: m[1] }); html += `<h3 id="${id}">${inline(m[1])}</h3>`;
      } else if ((m = line.match(/^==\s*(.+?)\s*==\s*$/))) {
        flushPara(); closeList(); const id = 'sec-' + (++n);
        toc.push({ id, level: 2, text: m[1] }); html += `<h2 id="${id}">${inline(m[1])}</h2>`;
      } else if ((m = line.match(/^\*\s+(.*)$/))) {
        flushPara(); openList('ul'); html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^\d+\.\s+(.*)$/))) {
        flushPara(); openList('ol'); html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^>\s?(.*)$/))) {
        if (para.length) flushPara();
        closeList(); quote.push(m[1]);
      } else if (/^---+\s*$/.test(line)) {
        flushPara(); closeList(); html += '<hr>';
      } else if (line.trim() === '') {
        flushPara(); closeList();
      } else {
        closeList(); para.push(line);
      }
    }
    flushPara(); closeList();
    return { html, toc };
  }
  function tocHtml(toc) {
    if (toc.length < 3) return '';
    return '<nav class="toc" aria-label="목차"><div class="toc-t">목차</div><ol>' +
      toc.map(t => `<li class="l${t.level}"><button type="button" class="linklike" data-goto="${t.id}">${esc(t.text)}</button></li>`).join('') +
      '</ol></nav>';
  }
  function scareHtml(n) {
    n = +n || 0;
    if (!n) return '';
    let i = '';
    for (let k = 1; k <= 5; k++) i += `<i class="${k <= n ? 'on' : ''}"></i>`;
    return `<span class="scare" title="공포도 ${n}/5"><span class="scare-l">공포도</span>${i}</span>`;
  }

  // ---------- 줄 단위 비교 ----------
  function diffLines(a, b) {
    const A = a === '' ? [] : a.split('\n'), B = b === '' ? [] : b.split('\n');
    if (A.length * B.length > 4000000) return null;
    let s = 0;
    while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let ea = A.length, eb = B.length;
    while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
    const a2 = A.slice(s, ea), b2 = B.slice(s, eb);
    const n = a2.length, m = b2.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = A.slice(0, s).map(v => ({ t: '=', v }));
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { ops.push({ t: '=', v: a2[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', v: a2[i++] }); }
      else { ops.push({ t: '+', v: b2[j++] }); }
    }
    while (i < n) ops.push({ t: '-', v: a2[i++] });
    while (j < m) ops.push({ t: '+', v: b2[j++] });
    A.slice(ea).forEach(v => ops.push({ t: '=', v }));
    return ops;
  }
  function diffHtml(a, b) {
    const ops = diffLines(a, b);
    if (!ops) return '<p class="meta">내용이 너무 길어 줄 비교는 생략했습니다. 아래 미리보기로 확인해주세요.</p>';
    if (!ops.some(o => o.t !== '=')) return '<p class="meta">본문은 바뀐 곳이 없습니다.</p>';
    const keep = new Array(ops.length).fill(false);
    ops.forEach((o, i) => {
      if (o.t !== '=') for (let k = Math.max(0, i - 2); k <= Math.min(ops.length - 1, i + 2); k++) keep[k] = true;
    });
    let out = '<div class="diff" tabindex="0" aria-label="변경 내용">', gap = false;
    ops.forEach((o, i) => {
      if (!keep[i]) { gap = true; return; }
      if (gap) { out += '<div class="dl gap">⋯</div>'; gap = false; }
      const sign = o.t === '+' ? '+' : o.t === '-' ? '−' : '';
      out += `<div class="dl ${o.t === '+' ? 'add' : o.t === '-' ? 'del' : ''}"><span class="sg">${sign}</span><span class="tx">${esc(o.v) || '&nbsp;'}</span></div>`;
    });
    if (gap) out += '<div class="dl gap">⋯</div>';
    return out + '</div>';
  }
  function metaChange(os, ns) {
    if (os == null || +os === +ns) return '';
    return `<p class="chg">공포도 <b>${+os}</b> → <b>${+ns}</b></p>`;
  }

  // ---------- 공통 조각 ----------
  function seal(wait, extra) {
    return `<div class="seal ${wait ? 'wait' : ''} ${extra || ''}" aria-label="${wait ? '검토 중' : '관리자 승인'}">${wait ? '검토<br>중' : '怪'}</div>`;
  }
  function note(kind, msg) { return `<div class="note ${kind || ''}" role="${kind === 'err' ? 'alert' : 'status'}">${msg}</div>`; }
  function setTitle(t) { document.title = (t ? t + ' - ' : '') + '괴현상관리국'; }
  function go(hash) {
    if (location.hash === hash) route(); else location.hash = hash;
  }

  function renderRail(active) {
    const rail = $('#rail');
    if (active !== undefined) rail.dataset.active = active;
    active = rail.dataset.active || '';
    rail.innerHTML =
      `<div class="rail-h">둘러보기</div>
       <a href="#/" class="${active === 'home' ? 'on' : ''}">대문</a>
       <a href="#/all" class="${active === 'all' ? 'on' : ''}"><span>전체 문서</span><span class="n">${pages.length}</span></a>
       <a href="#/recent" class="${active === 'recent' ? 'on' : ''}">최근 변경</a>
       <a href="#/random">무작위 괴담</a>
       <div class="rail-h">참여</div>
       <a href="#/new" class="${active === 'new' ? 'on' : ''}">새 괴담 제안</a>
       <a href="#/mine" class="${active === 'mine' ? 'on' : ''}">내 제안</a>
       <a href="#/w/${enc('도움말')}">글쓰기 도움말</a>
       <a href="#/admin" class="${active === 'admin' ? 'on' : ''}"><span>${info.admin ? '승인 대기' : '관리자'}</span>${info.admin && info.pending ? `<span class="badge">${info.pending}</span>` : ''}</a>
       <div class="rail-ver">v${esc(info.version)}</div>`;
  }

  // ---------- 화면: 대문 ----------
  async function viewHome() {
    const [home, recent, today] = await Promise.all([
      api('/api/pages/' + enc(HOME)).catch(() => null),
      api('/api/recent'),
      api('/api/today').catch(() => ({ title: null })),
      refreshPages()
    ]);
    renderRail('home');
    const r = home ? render(home.content) : { html: '' };
    main.innerHTML =
      `<section class="hero">
         <div>
           <h1>괴담은 관리자의 결재를 거친 뒤에야 기록됩니다</h1>
           <p>괴현상관리국은 괴담을 감시하고, 격리하고, 연구합니다. 누구나 글을 쓰고 고칠 수 있지만 보낸 글은 승인 대기열에 들어가고, 관리자가 확인한 내용만 공식 기록으로 남습니다.</p>
           <div class="row"><a class="btn primary" href="#/random">무작위 괴담 읽기</a><a class="btn" href="#/new">괴담 제안하기</a></div>
         </div>
         ${seal(false, 'big stamp')}
       </section>
       ${today.title ? `<a class="today" href="${wlink(today.title)}"><span class="today-k">오늘의 괴담</span><b>${esc(today.title)}</b>${scareHtml(today.scare)}<span class="today-x">${esc(today.excerpt)}</span></a>` : ''}
       <div class="paper"><div class="article">${r.html}</div></div>
       <section class="paper slim"><h2 class="sec-t">최근 변경</h2>${ledger(recent.slice(0, 8))}<p class="meta"><a href="#/recent">모두 보기</a></p></section>`;
    setTitle('');
  }
  function ledger(list) {
    if (!list.length) return '<p class="empty">아직 문서가 없습니다.</p>';
    return `<ul class="ledger">${list.map(r =>
      `<li><div class="l"><a href="${wlink(r.title)}">${esc(r.title)}</a>${r.summary ? `<span class="sum">${esc(r.summary)}</span>` : ''}</div>
       <div class="r">${esc(r.author || '')} ${ago(r.updatedAt)}</div></li>`).join('')}</ul>`;
  }

  // ---------- 화면: 문서 ----------
  async function viewPage(title) {
    await refreshPages();
    renderRail('');
    let p = null, pending = 0;
    try { p = await api('/api/pages/' + enc(title)); pending = p.pending; }
    catch (e) { if (e.status !== 404) throw e; pending = (e.data && e.data.pending) || 0; }
    setTitle(title);
    if (!p) {
      main.innerHTML =
        `<div class="paper"><div class="doc-head"><h1>${esc(title)}</h1>${seal(true)}</div>
         <p>아직 없는 문서입니다. 첫 내용을 제안해 문서를 만들 수 있습니다.</p>
         ${pending ? note('', `이 제목으로 승인을 기다리는 제안이 ${pending}건 있습니다.`) : ''}
         <a class="btn primary" href="#/edit/${enc(title)}">이 문서 만들기</a></div>`;
      return;
    }
    const r = render(p.content);
    const back = p.backlinks.length
      ? `<div class="back"><div class="back-t">이 문서를 가리키는 문서</div>${p.backlinks.map(t => `<a href="${wlink(t)}">${esc(t)}</a>`).join('')}</div>` : '';
    main.innerHTML =
      `<article class="paper">
         <div class="doc-head"><h1>${esc(p.title)}</h1>${seal(false)}</div>
         <div class="doc-meta">${scareHtml(p.scare)}
           <span>${fmt(p.updatedAt)} 수정</span><span>${p.revCount}개 판</span></div>
         <div class="doc-actions"><a class="btn primary" href="#/edit/${enc(p.title)}">편집 제안</a><a class="btn" href="#/history/${enc(p.title)}">변경 기록</a><button type="button" class="react" id="react">무서웠어요 <span id="rn">${p.reactions || 0}</span></button></div>
         ${pending ? note('warn', `이 문서에 승인을 기다리는 편집 제안이 ${pending}건 있습니다.`) : ''}
         ${tocHtml(r.toc)}
         <div class="article">${r.html}</div>
         ${back}
       </article>`;
    const rb = $('#react');
    if (lsGet('reacted:' + title)) rb.classList.add('on');
    rb.onclick = async () => {
      if (rb.classList.contains('on')) return;
      rb.disabled = true;
      try {
        const r = await api('/api/pages/' + enc(title) + '/react', { method: 'POST', body: {} });
        $('#rn').textContent = r.reactions; rb.classList.add('on'); lsSet('reacted:' + title, '1');
      } catch (e) { toast(e.message, 'err'); }
      rb.disabled = false;
    };
  }

  // ---------- 화면: 편집 ----------
  async function viewEdit(title) {
    await refreshPages();
    renderRail(title ? '' : 'new');
    let cur = null;
    if (title) { try { cur = await api('/api/pages/' + enc(title)); } catch (e) { if (e.status !== 404) throw e; } }
    setTitle(cur ? '편집 제안: ' + title : '새 괴담 제안');
    const draftKey = 'draft:' + (title || '__new');
    const draft = lsJson(draftKey, null);
    const startText = draft && draft.content && (!cur || draft.content !== cur.content) ? draft.content : (cur ? cur.content : '');
    const curScare = draft && draft.scare != null ? draft.scare : (cur ? cur.scare : 0);

    main.innerHTML =
      `<div class="paper"><h1>${cur ? '편집 제안: ' + esc(title) : '새 괴담 제안'}</h1>
       ${note(info.admin ? 'ok' : '', info.admin ? '관리자 모드입니다. "바로 저장"은 승인 없이 곧바로 문서에 반영됩니다.' : '보낸 내용은 관리자가 승인해야 문서에 실립니다. 승인 여부는 "내 제안"에서 확인할 수 있습니다.')}
       ${draft && startText === draft.content ? note('warn', '이전에 쓰던 글을 불러왔습니다. <button type="button" class="linklike" id="dropDraft">버리고 처음부터 시작</button>') : ''}
       <div id="msg"></div>
       <label for="t">제목</label>
       <input type="text" id="t" maxlength="80" value="${esc(title || '')}" ${cur ? 'readonly' : ''}>
       <div class="grid2">
         <div><label for="sc">공포도</label><select id="sc">${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}" ${n === +curScare ? 'selected' : ''}>${n ? n + ' / 5' : '표시 안 함'}</option>`).join('')}</select></div>
       </div>
       <div class="tabs" role="tablist"><button type="button" class="tab on" id="tabEdit" role="tab">쓰기</button><button type="button" class="tab" id="tabPrev" role="tab">미리보기</button></div>
       <div id="writeBox">
         <div class="tool">
           <button type="button" data-ins="h2">큰 제목</button><button type="button" data-ins="h3">작은 제목</button>
           <button type="button" data-ins="b">굵게</button><button type="button" data-ins="ul">목록</button>
           <button type="button" data-ins="q">인용</button><button type="button" data-ins="link">문서 연결</button><button type="button" data-ins="sp">내용 가리기</button>
         </div>
         <textarea id="body" aria-label="본문">${esc(startText)}</textarea>
         <div class="counter"><span id="cnt">0</span> / ${MAX_CONTENT.toLocaleString('ko-KR')}자</div>
       </div>
       <div id="prevBox" class="article preview" hidden></div>
       <div class="grid2">
         <div><label for="a">닉네임 (비워두면 익명)</label><input type="text" id="a" maxlength="20" value="${esc(lsGet('nick') || '')}"></div>
         <div><label for="s">무엇을 바꿨나요? (선택)</label><input type="text" id="s" maxlength="100"></div>
       </div>
       ${info.turnstileSiteKey ? '<div id="tsBox" class="tsbox"></div>' : ''}
       <div class="row mt">
         <button type="button" class="primary" id="submit">제안 보내기</button>
         ${info.admin ? '<button type="button" id="direct">바로 저장</button>' : ''}
         <a class="btn" href="#/${title ? 'w/' + enc(title) : ''}">취소</a>
       </div></div>`;

    const ta = $('#body');
    let tsId = null;
    if (info.turnstileSiteKey) {
      loadTurnstile().then(() => {
        if (!$('#tsBox')) return;
        tsId = window.turnstile.render('#tsBox', { sitekey: info.turnstileSiteKey, theme: 'dark', language: 'ko' });
      }).catch(e => { const m = $('#msg'); if (m) m.innerHTML = note('err', esc(e.message)); });
    }
    const val = () => ({ title: $('#t').value.trim(), scare: +$('#sc').value, content: ta.value, author: $('#a').value, summary: $('#s').value });
    const upd = () => { $('#cnt').textContent = ta.value.length.toLocaleString('ko-KR'); };
    let timer = null;
    const saveDraft = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if ($('#body') !== ta) return; // 이미 다른 화면으로 넘어갔으면 저장하지 않음
        const v = val();
        if (v.content.trim()) lsSet(draftKey, JSON.stringify({ content: v.content, scare: v.scare }));
      }, 600);
    };
    ta.addEventListener('input', () => { upd(); saveDraft(); });
    $('#sc').addEventListener('change', saveDraft);
    upd();
    const dd = $('#dropDraft');
    if (dd) dd.onclick = () => { lsDel(draftKey); route(); };

    const showTab = prev => {
      $('#tabEdit').classList.toggle('on', !prev);
      $('#tabPrev').classList.toggle('on', prev);
      $('#writeBox').hidden = prev;
      $('#prevBox').hidden = !prev;
      if (prev) { pageSet = new Set(pages.map(p => p.title)); $('#prevBox').innerHTML = render(ta.value).html || '<p class="meta">미리 볼 내용이 없습니다.</p>'; }
    };
    $('#tabEdit').onclick = () => showTab(false);
    $('#tabPrev').onclick = () => showTab(true);

    const INS = {
      h2: ['== ', ' ==', '큰 제목', true], h3: ['=== ', ' ===', '작은 제목', true], b: ['**', '**', '강조할 글', false],
      ul: ['* ', '', '목록 항목', true], q: ['> ', '', '인용할 글', true], link: ['[[', ']]', '문서이름', false], sp: ['||', '||', '가릴 내용', false]
    };
    $$('[data-ins]').forEach(btn => btn.onclick = () => {
      const [pre, post, ph, lineStart] = INS[btn.dataset.ins];
      const s = ta.selectionStart, e = ta.selectionEnd;
      const sel = ta.value.slice(s, e) || ph;
      const lead = lineStart && s > 0 && ta.value[s - 1] !== '\n' ? '\n' : '';
      ta.setRangeText(lead + pre + sel + post, s, e, 'end');
      ta.focus();
      const a = s + lead.length + pre.length;
      ta.setSelectionRange(a, a + sel.length);
      ta.dispatchEvent(new Event('input'));
    });

    const fail = e => { $('#msg').innerHTML = note('err', esc(e.message)); window.scrollTo({ top: 0 }); };
    $('#submit').onclick = async ev => {
      const btn = ev.currentTarget, v = val();
      lsSet('nick', v.author);
      if (info.turnstileSiteKey) {
        const tk = window.turnstile && tsId !== null ? window.turnstile.getResponse(tsId) : '';
        if (!tk) { fail(new Error('"로봇이 아닙니다" 확인을 먼저 완료해주세요.')); return; }
        v.turnstile = tk;
      }
      btn.disabled = true;
      try {
        const r = await api('/api/proposals', { method: 'POST', body: v });
        const mine = lsJson('myProposals', []);
        mine.unshift({ id: r.id, title: v.title, at: Date.now() });
        lsSet('myProposals', JSON.stringify(mine.slice(0, 30)));
        clearTimeout(timer);
        lsDel(draftKey);
        renderRail('');
        main.innerHTML =
          `<div class="paper"><div class="doc-head"><h1>제안을 보냈습니다</h1>${seal(true)}</div>
           <p>제안 번호는 <b>${r.id}번</b>입니다. 관리자가 확인하면 "내 제안"에서 승인이나 거절 여부를 볼 수 있습니다.</p>
           <div class="row"><a class="btn primary" href="#/mine">내 제안 보기</a><a class="btn" href="#/${v.title ? 'w/' + enc(v.title) : ''}">문서로 돌아가기</a></div></div>`;
      } catch (e) {
        btn.disabled = false;
        if (window.turnstile && tsId !== null) window.turnstile.reset(tsId);
        fail(e);
      }
    };
    const dir = $('#direct');
    if (dir) dir.onclick = async () => {
      const v = val();
      try {
        await api('/api/pages/' + enc(v.title), { method: 'PUT', body: v });
        clearTimeout(timer);
        lsDel(draftKey);
        toast('저장했습니다.');
        go(wlink(v.title));
      } catch (e) { fail(e); }
    };
  }

  // ---------- 화면: 변경 기록 ----------
  async function viewHistory(title) {
    renderRail('');
    const list = await api('/api/pages/' + enc(title) + '/history');
    setTitle('변경 기록: ' + title);
    main.innerHTML =
      `<div class="paper"><h1>${esc(title)}의 변경 기록</h1>
       <p class="meta"><a href="${wlink(title)}">문서로 돌아가기</a></p>
       <ul class="ledger hist">${list.map((r, i) =>
        `<li data-rev="${r.id}" class="blk">
           <div class="card-h"><div><b>#${r.id}</b> ${esc(r.author)} <span class="meta">${fmt(r.at)}</span>${r.summary ? `<span class="sum">${esc(r.summary)}</span>` : ''}</div>
           <div class="row"><button type="button" data-view="${r.id}">바뀐 내용 보기</button>
           ${info.admin && i > 0 ? `<button type="button" class="danger" data-rb="${r.id}">이 판으로 되돌리기</button>` : ''}</div></div>
           <div class="box" hidden></div></li>`).join('')}</ul>
       ${info.admin ? '<hr><button type="button" class="danger" id="del">이 문서 삭제</button>' : ''}</div>`;
    $$('[data-view]').forEach(b => b.onclick = async () => {
      const box = $('li[data-rev="' + b.dataset.view + '"] .box');
      if (!box.hidden) { box.hidden = true; b.textContent = '바뀐 내용 보기'; return; }
      b.disabled = true;
      try {
        const d = await api(`/api/pages/${enc(title)}/rev/${b.dataset.view}`);
        box.innerHTML = metaChange(d.prev ? d.prev.scare : null, d.rev.scare) + diffHtml(d.prev ? d.prev.content : '', d.rev.content);
        box.hidden = false; b.textContent = '닫기';
      } catch (e) { toast(e.message, 'err'); }
      b.disabled = false;
    });
    $$('[data-rb]').forEach(b => b.onclick = async () => {
      if (!confirm('이 판의 내용으로 되돌릴까요? 현재 내용은 변경 기록에 남습니다.')) return;
      try { await api(`/api/pages/${enc(title)}/rollback/${b.dataset.rb}`, { method: 'POST' }); toast('되돌렸습니다.'); go(wlink(title)); }
      catch (e) { toast(e.message, 'err'); }
    });
    const del = $('#del');
    if (del) del.onclick = async () => {
      if (!confirm(`"${title}" 문서를 변경 기록까지 모두 삭제할까요? 되돌릴 수 없습니다.`)) return;
      try { await api('/api/pages/' + enc(title), { method: 'DELETE' }); toast('삭제했습니다.'); go('#/'); }
      catch (e) { toast(e.message, 'err'); }
    };
  }

  // ---------- 화면: 목록 ----------
  async function viewAll() {
    await refreshPages();
    renderRail('all');
    setTitle('전체 문서');
    main.innerHTML =
      `<div class="paper"><h1>전체 문서</h1>
       <div class="tools"><input type="text" id="flt" placeholder="목록에서 제목 찾기" aria-label="목록에서 제목 찾기">
         <select id="srt" aria-label="정렬"><option value="name">이름순</option><option value="new">최근 수정순</option><option value="scare">공포도 높은 순</option><option value="react">무서웠어요 많은 순</option></select></div>
       <div id="lst"></div></div>`;
    const draw = () => {
      const q = $('#flt').value.trim().toLowerCase(), srt = $('#srt').value;
      const l = pages.filter(p => !q || p.title.toLowerCase().includes(q));
      if (srt === 'new') l.sort((a, b) => b.updatedAt - a.updatedAt);
      else if (srt === 'scare') l.sort((a, b) => b.scare - a.scare || a.title.localeCompare(b.title, 'ko'));
      else if (srt === 'react') l.sort((a, b) => (b.reactions || 0) - (a.reactions || 0) || a.title.localeCompare(b.title, 'ko'));
      $('#lst').innerHTML = l.length
        ? `<ul class="ledger">${l.map(p => `<li><div class="l"><a href="${wlink(p.title)}">${esc(p.title)}</a></div><div class="r">${p.reactions ? `<span class="rc">무서웠어요 ${p.reactions}</span>` : ''}${scareHtml(p.scare)}</div></li>`).join('')}</ul>`
        : '<p class="empty">맞는 문서가 없습니다. 새 괴담을 제안해보세요.</p>';
    };
    $('#flt').oninput = draw; $('#srt').onchange = draw;
    draw();
  }
  async function viewRecent() {
    const [list] = await Promise.all([api('/api/recent'), refreshPages()]);
    renderRail('recent');
    setTitle('최근 변경');
    main.innerHTML = `<div class="paper"><h1>최근 변경</h1>${ledger(list)}</div>`;
  }
  async function viewSearch(q) {
    renderRail('');
    const [r] = await Promise.all([api('/api/search?q=' + enc(q)), refreshPages()]);
    setTitle('검색: ' + q);
    main.innerHTML =
      `<div class="paper"><h1>"${esc(q)}" 검색 결과 ${r.length}건</h1>
       ${r.length ? `<ul class="ledger">${r.map(x =>
        `<li><div class="l"><a href="${wlink(x.title)}">${esc(x.title)}</a><span class="sum">${esc(x.snippet)}</span></div><div class="r">${scareHtml(x.scare)}</div></li>`).join('')}</ul>`
        : `<p class="empty">찾는 문서가 없습니다.</p>`}
       ${r.some(x => x.title === q) ? '' : `<p><a class="btn" href="#/edit/${enc(q)}">"${esc(q)}" 문서 만들기</a></p>`}</div>`;
  }

  // ---------- 화면: 내 제안 ----------
  async function viewMine() {
    renderRail('mine');
    setTitle('내 제안');
    const mine = lsJson('myProposals', []);
    let st = [];
    if (mine.length) { try { st = await api('/api/proposals/status', { method: 'POST', body: { ids: mine.map(m => m.id) } }); } catch (e) { /* 상태 조회 실패 */ } }
    const byId = Object.fromEntries(st.map(s => [s.id, s]));
    const label = { pending: '대기 중', approved: '승인됨', rejected: '거절됨' };
    main.innerHTML =
      `<div class="paper"><h1>내 제안</h1>
       <p class="meta">이 브라우저에서 보낸 제안만 표시됩니다. 브라우저 데이터를 지우면 목록도 사라집니다.</p>
       ${mine.length ? `<ul class="ledger">${mine.map(m => {
        const s = byId[m.id];
        const stt = s ? s.status : 'gone';
        return `<li class="blk"><div class="card-h"><div><b>${esc(m.title)}</b> <span class="meta">${m.id}번 / ${fmt(m.at)}</span></div>
          <span class="st ${stt}">${s ? label[stt] : '기록 없음'}</span></div>
          ${s && s.status === 'rejected' ? `<p class="meta">거절 사유: ${esc(s.reason) || '적힌 사유가 없습니다.'}</p>` : ''}
          ${s && s.status === 'approved' ? `<p class="meta"><a href="${wlink(m.title)}">문서 보러 가기</a></p>` : ''}
          ${!s ? '<p class="meta">오래되어 기록이 정리됐을 수 있습니다.</p>' : ''}</li>`;
      }).join('')}</ul>` : '<p class="empty">아직 보낸 제안이 없습니다.</p>'}</div>`;
  }

  // ---------- 화면: 관리자 ----------
  function viewBackup() {
    main.innerHTML =
      `<div class="paper slim"><div class="card-h"><h1>백업</h1>
         <div class="row"><a class="btn" href="#/admin">대기 중</a><a class="btn" href="#/admin/done">처리 내역</a><a class="btn primary" href="#/admin/backup">백업</a><button type="button" id="logout">로그아웃</button></div></div></div>
       <div class="paper slim"><h2 class="sec-t">문서 내려받기</h2>
         <p class="meta">지금 올라가 있는 모든 문서를 파일 하나(JSON)로 저장합니다.</p>
         <label class="chk"><input type="checkbox" id="withRev"> 변경 기록도 포함</label>
         <div class="row mt"><button type="button" class="primary" id="dl">문서 내려받기</button></div></div>
       <div class="paper slim"><h2 class="sec-t">백업에서 복원</h2>
         <p class="meta">내려받은 백업 파일을 고르면 문서를 다시 올립니다. 같은 내용의 문서는 건너뛰고, 내용이 다른 문서는 백업의 내용을 새 판으로 올립니다. 백업에 없는 문서는 건드리지 않습니다.</p>
         <input type="file" id="bf" accept=".json,application/json" aria-label="백업 파일">
         <div class="row mt"><button type="button" class="danger" id="rs">복원하기</button></div><div id="rmsg" class="mt"></div></div>`;
    $('#logout').onclick = () => { setToken(''); toast('로그아웃했습니다.'); route(); };
    $('#dl').onclick = async () => {
      try {
        const d = await api('/api/admin/export' + ($('#withRev').checked ? '?revisions=1' : ''));
        const blob = new Blob([JSON.stringify(d, null, 1)], { type: 'application/json' });
        const a = document.createElement('a');
        const t = new Date();
        a.href = URL.createObjectURL(blob);
        a.download = `gwandam-backup-${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast(`문서 ${d.pages.length}개를 내려받았습니다.`);
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#rs').onclick = async () => {
      const f = $('#bf').files[0];
      if (!f) { toast('백업 파일을 먼저 고르세요.', 'err'); return; }
      let data;
      try { data = JSON.parse(await f.text()); } catch (e) { toast('JSON 파일을 읽을 수 없습니다.', 'err'); return; }
      const n = Array.isArray(data.pages) ? data.pages.length : 0;
      if (!confirm(`문서 ${n}개를 복원합니다. 계속할까요?`)) return;
      $('#rs').disabled = true;
      try {
        const r = await api('/api/admin/import', { method: 'POST', body: { app: data.app, pages: (data.pages || []).map(p => ({ title: p.title, scare: p.scare, content: p.content })) } });
        $('#rmsg').innerHTML = note('', `복원 ${r.imported}개, 건너뜀 ${r.skipped}개, 올바르지 않음 ${r.invalid}개`);
        await refreshPages();
      } catch (e) { $('#rmsg').innerHTML = note('err', esc(e.message)); }
      $('#rs').disabled = false;
    };
  }
  async function viewAdmin(tab) {
    renderRail('admin');
    setTitle('관리자');
    if (!token) {
      main.innerHTML =
        `<div class="paper slim narrow"><h1>관리자 로그인</h1><div id="msg"></div>
         <label for="pw">비밀번호</label><input type="password" id="pw" autocomplete="current-password">
         <div class="row mt"><button type="button" class="primary" id="login">로그인</button></div></div>`;
      const doLogin = async () => {
        try {
          const r = await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } });
          setToken(r.token); await refreshInfo(); renderRail('admin'); route();
        } catch (e) { $('#msg').innerHTML = note('err', esc(e.message)); }
      };
      $('#login').onclick = doLogin;
      $('#pw').onkeydown = e => { if (e.key === 'Enter') doLogin(); };
      $('#pw').focus();
      return;
    }
    if (tab === 'backup') return viewBackup();
    const done = tab === 'done';
    let list;
    try { list = await api('/api/proposals' + (done ? '?status=done' : '')); } catch (e) { if (!token) return route(); throw e; }
    if (!done) { info.pending = list.length; renderRail('admin'); }
    pageSet = new Set(pages.map(p => p.title));
    const head =
      `<div class="paper slim"><div class="card-h"><h1>${done ? '처리 내역' : `승인 대기 ${list.length}건`}</h1>
       <div class="row"><a class="btn ${done ? '' : 'primary'}" href="#/admin">대기 중</a><a class="btn ${done ? 'primary' : ''}" href="#/admin/done">처리 내역</a><a class="btn" href="#/admin/backup">백업</a><button type="button" id="logout">로그아웃</button></div></div></div>`;
    let body;
    if (done) {
      body = list.length ? `<div class="paper slim"><ul class="ledger">${list.map(p =>
        `<li class="blk"><div class="card-h"><div><b>${esc(p.title)}</b> <span class="meta">${esc(p.author)} / ${fmt(p.decidedAt)}</span></div>
         <span class="st ${p.status}">${p.status === 'approved' ? '승인됨' : '거절됨'}</span></div>
         ${p.reason ? `<p class="meta">거절 사유: ${esc(p.reason)}</p>` : ''}</li>`).join('')}</ul></div>` : '<div class="paper slim"><p class="empty">처리한 제안이 아직 없습니다.</p></div>';
    } else {
      body = list.length ? list.map(p =>
        `<div class="card" data-id="${p.id}">
           <div class="card-h"><div><b>${esc(p.title)}</b><span class="tag">${p.isNew ? '새 문서' : '편집'}</span> ${scareHtml(p.scare)}</div>
           <span class="meta">${esc(p.author)} / ${fmt(p.createdAt)}</span></div>
           ${p.summary ? `<p class="meta">요약: ${esc(p.summary)}</p>` : ''}
           ${p.outdated ? note('warn', '이 제안을 보낸 뒤에 문서가 바뀌었습니다. 승인하면 지금 내용을 이 제안의 내용으로 덮어씁니다.') : ''}
           <div data-diff="${p.id}">${p.isNew ? '' : metaChange(p.curScare, p.scare)}${diffHtml(p.isNew ? '' : (p.curContent || ''), p.content)}</div>
           <details><summary>제안한 글 미리보기</summary><div class="article">${render(p.content).html}</div></details>
           <div class="editbox" data-editbox="${p.id}" hidden>
             <div class="grid2">
               <div><label>공포도</label><select data-escare="${p.id}" aria-label="공포도">${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}" ${n === +p.scare ? 'selected' : ''}>${n ? n + ' / 5' : '표시 안 함'}</option>`).join('')}</select></div>
             </div>
             <label>본문 (고치면 위의 비교에 바로 반영됩니다)</label>
             <textarea data-etext="${p.id}" aria-label="고칠 본문">${esc(p.content)}</textarea>
             <div class="row mt"><button type="button" class="primary" data-apedit="${p.id}">고친 내용으로 승인</button><button type="button" data-editcancel="${p.id}">고치기 취소</button></div>
           </div>
           <div class="reason"><input type="text" maxlength="200" placeholder="거절 사유 (선택, 제안한 사람에게 보입니다)" aria-label="거절 사유" data-reason="${p.id}">
             <button type="button" class="primary" data-ap="${p.id}">그대로 승인</button><button type="button" data-editopen="${p.id}">고쳐서 승인</button><button type="button" class="danger" data-rj="${p.id}">거절</button></div>
         </div>`).join('') : '<div class="paper slim"><p class="empty">대기 중인 제안이 없습니다.</p></div>';
    }
    main.innerHTML = head + body;
    $('#logout').onclick = () => { setToken(''); toast('로그아웃했습니다.'); route(); };
    const act = (sel, path, getBody, okMsg, confirmMsg) => $$(sel).forEach(b => b.onclick = async () => {
      const id = b.dataset.ap || b.dataset.rj;
      if (confirmMsg && !confirm(confirmMsg)) return;
      b.disabled = true;
      try { await api(`/api/proposals/${id}/${path}`, { method: 'POST', body: getBody(id) }); toast(okMsg); await refreshPages(); viewAdmin(); }
      catch (e) { b.disabled = false; toast(e.message, 'err'); if (e.status === 404) viewAdmin(); }
    });
    act('[data-ap]', 'approve', () => ({}), '승인했습니다.');

    // 고쳐서 승인: 본문을 고치면 위의 비교가 바로 바뀝니다.
    const byId = Object.fromEntries(list.map(p => [p.id, p]));
    const ed = (id, k) => $(`[data-${k}="${id}"]`);
    const redraw = id => {
      const p = byId[id], box = ed(id, 'diff');
      if (!p || !box || !ed(id, 'etext')) return; // 승인 직후 화면이 바뀐 뒤 늦게 실행될 수 있음
      box.innerHTML = (p.isNew ? '' : metaChange(p.curScare, +ed(id, 'escare').value)) +
        diffHtml(p.isNew ? '' : (p.curContent || ''), ed(id, 'etext').value);
    };
    $$('[data-editopen]').forEach(b => b.onclick = () => {
      const id = b.dataset.editopen, box = ed(id, 'editbox');
      box.hidden = !box.hidden;
      if (!box.hidden) ed(id, 'etext').focus();
    });
    $$('[data-etext]').forEach(t => {
      let timer = null;
      t.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => redraw(t.dataset.etext), 250); });
    });
    $$('[data-escare]').forEach(x => x.addEventListener('change', () => redraw(x.dataset.escare)));
    $$('[data-editcancel]').forEach(b => b.onclick = () => {
      const id = b.dataset.editcancel, p = byId[id];
      ed(id, 'etext').value = p.content;
      ed(id, 'escare').value = String(p.scare);
      ed(id, 'editbox').hidden = true;
      redraw(id);
    });
    $$('[data-apedit]').forEach(b => b.onclick = async () => {
      const id = b.dataset.apedit;
      b.disabled = true;
      try {
        await api(`/api/proposals/${id}/approve`, { method: 'POST', body: { content: ed(id, 'etext').value, scare: +ed(id, 'escare').value } });
        toast('고쳐서 승인했습니다.'); await refreshPages(); viewAdmin();
      } catch (e) { b.disabled = false; toast(e.message, 'err'); if (e.status === 404) viewAdmin(); }
    });
    act('[data-rj]', 'reject', id => ({ reason: $(`[data-reason="${id}"]`).value }), '거절했습니다.', '이 제안을 거절할까요?');
  }

  // ---------- 라우터 ----------
  async function route() {
    document.body.classList.remove('menu-open');
    $('#menuBtn').setAttribute('aria-expanded', 'false');
    const raw = location.hash.replace(/^#\/?/, '');
    const i = raw.indexOf('/');
    const kind = i < 0 ? raw : raw.slice(0, i);
    let arg = i < 0 ? '' : raw.slice(i + 1);
    try { arg = decodeURIComponent(arg); } catch (e) { /* 그대로 사용 */ }
    window.scrollTo(0, 0);
    try {
      if (!kind) await viewHome();
      else if (kind === 'w') await viewPage(arg);
      else if (kind === 'edit') await viewEdit(arg);
      else if (kind === 'new') await viewEdit('');
      else if (kind === 'history') await viewHistory(arg);
      else if (kind === 'all') await viewAll();
      else if (kind === 'recent') await viewRecent();
      else if (kind === 'search') await viewSearch(arg);
      else if (kind === 'mine') await viewMine();
      else if (kind === 'admin') await viewAdmin(arg);
      else if (kind === 'random') {
        const r = await api('/api/random');
        if (r.title) { location.replace(wlink(r.title)); } else { toast('아직 읽을 괴담이 없습니다. 첫 괴담을 제안해보세요.'); location.replace('#/new'); }
      } else await viewHome();
    } catch (e) {
      main.innerHTML = `<div class="paper">${note('err', esc(e.message))}<p><a class="btn" href="#/">대문으로</a></p></div>`;
    }
  }

  // ---------- 이벤트 ----------
  main.addEventListener('click', e => {
    const g = e.target.closest('[data-goto]');
    if (g) { const t = document.getElementById(g.dataset.goto); if (t) t.scrollIntoView(); return; }
    const sp = e.target.closest('.spoiler');
    if (sp) sp.classList.toggle('on');
  });
  main.addEventListener('keydown', e => {
    const sp = e.target.closest && e.target.closest('.spoiler');
    if (sp && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sp.classList.toggle('on'); }
  });
  $('#sform').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('#q').value.trim();
    if (q) go('#/search/' + enc(q));
  });
  $('#menuBtn').addEventListener('click', () => {
    const open = document.body.classList.toggle('menu-open');
    $('#menuBtn').setAttribute('aria-expanded', String(open));
  });
  window.addEventListener('hashchange', route);

  (async () => {
    await refreshInfo();
    renderRail('');
    route();
  })();
})();
