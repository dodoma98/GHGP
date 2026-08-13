/**
 * 그린홈시스 방문 집계 서버 (Cloudflare Worker)
 *
 * 하는 일
 *  1) POST /collect  — 사이트에서 보내온 방문/행동 기록을 D1에 저장 (공개)
 *  2) GET  /         — 비밀번호 입력 화면 또는 대시보드 (로그인 필요)
 *  3) POST /login    — 비밀번호 확인 후 서명된 세션 쿠키 발급
 *  4) GET  /api/stats— 집계 결과 JSON (로그인 필요)
 *
 * 개인정보
 *  - IP 주소는 저장하지 않습니다. 방문자 구분용 임시 식별자를 만들 때만 잠깐 쓰이고,
 *    되돌릴 수 없는 해시로 바꾼 뒤 버립니다. 이 식별자는 매일 0시에 초기화됩니다.
 *  - 쿠키를 심지 않습니다. (관리자 로그인 쿠키만 예외)
 *
 * 여러 사이트를 하나의 대시보드에서 봅니다. 각 사이트의 집계 코드가 보내는
 * site 값(ghgp, home, point ...)으로 구분하며, 대시보드 위쪽에서 골라 볼 수 있습니다.
 *
 * 필요한 설정 (Cloudflare 화면에서 지정)
 *  - D1 데이터베이스 바인딩 이름: DB
 *  - 비밀 변수 DASH_PASSWORD : 대시보드 로그인 비밀번호
 *  - 비밀 변수 SECRET        : 쿠키 서명·해시에 쓰는 아무 긴 문자열
 *  - 변수 ALLOW_ORIGIN       : 집계를 허용할 사이트 주소들, 쉼표로 구분
 *                              예: https://ghgp.replit.app,https://greenhomesys.com
 *  - 변수 SITE_NAMES         : 사이트 코드와 표시 이름, 쉼표로 구분 (선택)
 *                              예: ghgp=영업 페이지,home=그린홈시스,viablanc=비아블랑
 */

const SESSION_HOURS = 12;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return preflight(env, request.headers.get('Origin') || '');
    if (url.pathname === '/collect' && request.method === 'POST') return collect(request, env);
    if (url.pathname === '/login' && request.method === 'POST') return login(request, env);
    if (url.pathname === '/logout') return logout(env);

    // 아래부터는 로그인 필요
    const ok = await hasSession(request, env);
    if (url.pathname === '/api/stats') {
      if (!ok) return json({ error: 'unauthorized' }, 401);
      return stats(url, env);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return html(ok ? DASHBOARD_HTML : LOGIN_HTML);
    }
    return new Response('Not found', { status: 404 });
  },
};

/* ───────────── 기록 수집 ───────────── */

async function collect(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!originAllowed(origin, env)) {
    return new Response('forbidden', { status: 403 });
  }

  const ua = request.headers.get('User-Agent') || '';
  if (/bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit/i.test(ua)) {
    return corsOk(env, origin); // 검색엔진 로봇은 집계에서 제외
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  const day = kstDay(now);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const visitor = await dailyHash(ip + ua, day, env.SECRET || 'ghgp');

  const page = String(body.page || '/').slice(0, 120);
  const event = String(body.event || 'view').slice(0, 60);
  const site = String(body.site || 'ghgp').slice(0, 30);
  const device = /Mobi|Android|iPhone|iPad/i.test(ua) ? 'mobile' : 'desktop';
  const ref = refLabel(body.ref, body.from);

  await env.DB.prepare(
    'INSERT INTO hits (ts, day, site, visitor, page, ref, device, event) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(now, day, site, visitor, page, ref, device, event).run();

  return corsOk(env, origin);
}

function allowedOrigins(env) {
  return (env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
}

function originAllowed(origin, env) {
  const list = allowedOrigins(env);
  return list.length === 0 || list.includes(origin);
}

function siteNames(env) {
  const map = {};
  (env.SITE_NAMES || '').split(',').forEach(pair => {
    const [k, v] = pair.split('=').map(s => (s || '').trim());
    if (k && v) map[k] = v;
  });
  return map;
}

// 링크에 ?from=blog 처럼 표시를 달아 보내면 그 값을 우선 사용합니다.
// 네이버 블로그·리틀리 등은 유입 정보를 넘겨주지 않아 이 방법이 필요합니다.
const FROM_NAMES = {
  blog: '네이버 블로그', littly: '리틀리', insta: '인스타그램', instagram: '인스타그램',
  youtube: '유튜브', kakao: '카카오톡', band: '밴드', card: '명함 QR', sms: '문자',
  soomgo: '숨고', naver: '네이버',
};

function refLabel(raw, from) {
  if (from) {
    const key = String(from).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
    if (key) return FROM_NAMES[key] || key;
  }
  if (!raw) return 'direct';
  let host;
  try {
    host = new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return 'direct';
  }
  if (/naver/.test(host)) return /blog/.test(host) ? '네이버 블로그' : '네이버';
  if (/soomgo/.test(host)) return '숨고';
  if (/google/.test(host)) return '구글';
  if (/daum|kakao/.test(host)) return '다음·카카오';
  if (/instagram|facebook/.test(host)) return 'SNS';
  if (/youtube/.test(host)) return '유튜브';
  if (/greenhomesys|gh-point|replit\.app/.test(host)) return '자사 사이트';
  return host.slice(0, 40);
}

/* ───────────── 집계 ───────────── */

async function stats(url, env) {
  const days = Math.min(parseInt(url.searchParams.get('days') || '30', 10) || 30, 180);
  const from = kstDay(Math.floor(Date.now() / 1000) - days * 86400);
  const site = (url.searchParams.get('site') || 'all').slice(0, 30);

  // site=all 이면 전체, 아니면 해당 사이트만
  const cond = site === 'all' ? '' : ' AND site=?';
  const args = site === 'all' ? [from] : [from, site];
  const q = (sql, extra = []) => env.DB.prepare(sql).bind(...args, ...extra).all();

  const [daily, pages, refs, devices, events, hours, totals, bySite, allSites] = await Promise.all([
    q(`SELECT day, COUNT(DISTINCT visitor) uv, COUNT(*) pv FROM hits
        WHERE event='view' AND day>=?${cond} GROUP BY day ORDER BY day`),
    q(`SELECT site, page, COUNT(*) n FROM hits
        WHERE event='view' AND day>=?${cond} GROUP BY site, page ORDER BY n DESC LIMIT 25`),
    q(`SELECT ref, COUNT(DISTINCT visitor) n FROM hits
        WHERE event='view' AND day>=?${cond} GROUP BY ref ORDER BY n DESC LIMIT 12`),
    q(`SELECT device, COUNT(DISTINCT visitor) n FROM hits
        WHERE event='view' AND day>=?${cond} GROUP BY device`),
    q(`SELECT event, COUNT(*) n FROM hits
        WHERE event<>'view' AND day>=?${cond} GROUP BY event ORDER BY n DESC LIMIT 20`),
    q(`SELECT CAST(strftime('%H', datetime(ts,'unixepoch','+9 hours')) AS INTEGER) h, COUNT(*) n
        FROM hits WHERE event='view' AND day>=?${cond} GROUP BY h ORDER BY h`),
    q(`SELECT COUNT(DISTINCT visitor) uv, COUNT(*) pv FROM hits
        WHERE event='view' AND day>=?${cond}`),
    // 사이트별 비교는 항상 전체 기준
    env.DB.prepare(`SELECT site, COUNT(DISTINCT visitor) uv, COUNT(*) pv FROM hits
        WHERE event='view' AND day>=? GROUP BY site ORDER BY uv DESC`).bind(from).all(),
    env.DB.prepare(`SELECT DISTINCT site FROM hits ORDER BY site`).all(),
  ]);

  const today = kstDay(Math.floor(Date.now() / 1000));
  const todayRow = (daily.results || []).find(r => r.day === today) || { uv: 0, pv: 0 };

  return json({
    days, site,
    names: siteNames(env),
    sites: (allSites.results || []).map(r => r.site),
    today: { uv: todayRow.uv, pv: todayRow.pv },
    total: (totals.results || [])[0] || { uv: 0, pv: 0 },
    daily: daily.results || [],
    bySite: bySite.results || [],
    pages: pages.results || [],
    refs: refs.results || [],
    devices: devices.results || [],
    events: events.results || [],
    hours: hours.results || [],
  });
}

/* ───────────── 로그인 ───────────── */

async function login(request, env) {
  const form = await request.formData();
  const pw = String(form.get('password') || '');
  if (!env.DASH_PASSWORD || pw !== env.DASH_PASSWORD) {
    return html(LOGIN_HTML.replace('<!--ERR-->', '<p class="err">비밀번호가 맞지 않습니다.</p>'), 401);
  }
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const token = `${exp}.${await hmac(String(exp), env.SECRET || 'ghgp')}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': `ghgp_s=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
    },
  });
}

function logout(env) {
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': 'ghgp_s=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' },
  });
}

async function hasSession(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/ghgp_s=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig === await hmac(exp, env.SECRET || 'ghgp');
}

/* ───────────── 도우미 ───────────── */

function kstDay(unixSec) {
  return new Date((unixSec + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function dailyHash(raw, day, secret) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${day}|${secret}|${raw}`));
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

function corsHeaders(env, origin) {
  const list = allowedOrigins(env);
  const allow = list.length === 0 ? '*' : (list.includes(origin) ? origin : list[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
const preflight = (env, origin) => new Response(null, { status: 204, headers: corsHeaders(env, origin) });
const corsOk = (env, origin) => new Response('ok', { headers: corsHeaders(env, origin) });
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } });

/* ───────────── 화면 ───────────── */

const BASE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Pretendard Variable",Pretendard,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;
       background:#f4f8f4;color:#1b2b20;line-height:1.6;word-break:keep-all}
  .wrap{max-width:1100px;margin:0 auto;padding:24px 18px 60px}
  h1{font-size:22px;font-weight:800;letter-spacing:-.02em}
  .muted{color:#5e6e62;font-size:14px}
  .card{background:#fff;border:1px solid #cde3d3;border-radius:14px;padding:20px;box-shadow:0 6px 24px rgba(20,60,35,.06)}
`;

const LOGIN_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>그린홈시스 대시보드</title>
<style>${BASE_CSS}
 .box{max-width:360px;margin:14vh auto;text-align:center}
 input{width:100%;padding:13px 14px;font-size:16px;border:1.5px solid #cde3d3;border-radius:10px;margin:16px 0 12px}
 button{width:100%;padding:13px;font-size:16px;font-weight:700;color:#fff;background:#1b7a44;border:none;border-radius:10px;cursor:pointer}
 button:hover{background:#14532d}
 .err{color:#a6242f;font-size:14px;margin-top:12px;font-weight:700}
</style></head><body><div class="wrap"><div class="box card">
<h1>그린홈시스 대시보드</h1><p class="muted">관리자 전용 화면입니다.</p>
<form method="POST" action="/login">
<input type="password" name="password" placeholder="비밀번호" autofocus required>
<button type="submit">들어가기</button></form><!--ERR-->
</div></div></body></html>`;

const DASHBOARD_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>그린홈시스 대시보드</title>
<style>${BASE_CSS}
 header{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}
 header .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
 select,.btn{font-family:inherit;font-size:14px;padding:8px 12px;border:1.5px solid #cde3d3;
   border-radius:999px;background:#fff;color:#1b2b20;cursor:pointer}
 .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
 .kpi{background:#fff;border:1px solid #cde3d3;border-radius:14px;padding:16px 18px}
 .kpi b{display:block;font-size:28px;font-weight:800;letter-spacing:-.02em}
 .kpi span{font-size:13.5px;color:#5e6e62}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
 .card h2{font-size:16px;font-weight:800;margin-bottom:14px}
 .full{grid-column:1/-1}
 table{width:100%;border-collapse:collapse;font-size:14.5px}
 td{padding:7px 0;border-bottom:1px solid #eef4ef}
 td:last-child{text-align:right;font-weight:700;white-space:nowrap}
 tr:last-child td{border-bottom:none}
 .bar{position:relative}
 .bar i{position:absolute;left:0;top:0;bottom:0;background:#e8f3eb;border-radius:4px;z-index:0}
 .bar span{position:relative;z-index:1;padding-left:6px}
 .empty{color:#5e6e62;font-size:14px;padding:8px 0}
 svg{width:100%;height:auto;display:block}
 @media(max-width:820px){.kpis{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<header>
  <div><h1>그린홈시스 대시보드</h1><p class="muted" id="range">불러오는 중…</p></div>
  <div class="sp">
    <select id="site"><option value="all">전체 사이트</option></select>
    <select id="days">
      <option value="7">최근 7일</option>
      <option value="30" selected>최근 30일</option>
      <option value="90">최근 90일</option>
    </select>
    <a class="btn" href="/logout">로그아웃</a>
  </div>
</header>
<div class="kpis">
  <div class="kpi"><b id="k1">–</b><span>오늘 방문자</span></div>
  <div class="kpi"><b id="k2">–</b><span>오늘 조회수</span></div>
  <div class="kpi"><b id="k3">–</b><span>기간 방문자</span></div>
  <div class="kpi"><b id="k4">–</b><span>기간 조회수</span></div>
</div>
<div class="grid">
  <div class="card full"><h2>일별 방문자</h2><div id="chart"></div></div>
  <div class="card full" id="siteCard"><h2>사이트별 비교</h2><div id="bySite"></div></div>
  <div class="card"><h2>페이지별 조회</h2><div id="pages"></div></div>
  <div class="card"><h2>유입 경로</h2><div id="refs"></div></div>
  <div class="card"><h2>버튼·자료 클릭</h2><div id="events"></div></div>
  <div class="card"><h2>기기 · 시간대</h2><div id="devices"></div><div id="hours" style="margin-top:14px"></div></div>
</div>
<script>
const PAGE_NAMES = {'/':'메인','/index.html':'메인','/archive.html':'자료실','/reviews.html':'사례&리뷰'};
const EVENT_NAMES = {
  'call':'전화 걸기','point':'포인트 서비스','catalog':'카탈로그 열람','system':'시스템창호 열람',
  'download':'자료 다운로드','blog':'블로그 글 클릭','soomgo':'숨고 리뷰 클릭','quote':'견적 문의','partner':'거래처 문의',
  'homepage':'홈페이지 이동','video':'영상 재생'
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function table(el, rows, labelFn, key){
  const max = Math.max(1, ...rows.map(r => r[key]));
  el.innerHTML = rows.length ? '<table>' + rows.map(r =>
    '<tr><td class="bar"><i style="width:' + (r[key]/max*100) + '%"></i><span>' + esc(labelFn(r)) + '</span></td>' +
    '<td>' + r[key].toLocaleString() + '</td></tr>').join('') + '</table>'
    : '<p class="empty">아직 기록이 없습니다.</p>';
}
function chart(el, daily){
  if (!daily.length) { el.innerHTML = '<p class="empty">아직 기록이 없습니다.</p>'; return; }
  const W = 900, H = 220, P = 30, max = Math.max(1, ...daily.map(d => d.uv));
  const x = i => P + i * (W - P*2) / Math.max(1, daily.length - 1);
  const y = v => H - P - v / max * (H - P*2);
  const pts = daily.map((d,i) => x(i) + ',' + y(d.uv)).join(' ');
  const area = 'M' + x(0) + ',' + (H-P) + ' L' + pts.split(' ').join(' L') + ' L' + x(daily.length-1) + ',' + (H-P) + ' Z';
  const ticks = daily.filter((_,i) => i % Math.ceil(daily.length/6) === 0 || i === daily.length-1);
  el.innerHTML =
    '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="일별 방문자 추이">' +
    '<path d="' + area + '" fill="#e8f3eb"/>' +
    '<polyline points="' + pts + '" fill="none" stroke="#1b7a44" stroke-width="2.5" stroke-linejoin="round"/>' +
    daily.map((d,i) => '<circle cx="' + x(i) + '" cy="' + y(d.uv) + '" r="3" fill="#1b7a44"><title>' +
      d.day + ' · 방문자 ' + d.uv + '명</title></circle>').join('') +
    ticks.map(d => '<text x="' + x(daily.indexOf(d)) + '" y="' + (H-8) + '" font-size="11" fill="#5e6e62" text-anchor="middle">' +
      d.day.slice(5) + '</text>').join('') +
    '<text x="' + P + '" y="18" font-size="11" fill="#5e6e62">최대 ' + max + '명</text></svg>';
}
let SITE_NAMES = {};
function siteLabel(code){ return SITE_NAMES[code] || code; }

async function load(){
  const days = document.getElementById('days').value;
  const site = document.getElementById('site').value;
  const r = await fetch('/api/stats?days=' + days + '&site=' + encodeURIComponent(site));
  if (!r.ok) { location.reload(); return; }
  const d = await r.json();
  SITE_NAMES = d.names || {};

  // 사이트 선택 메뉴 채우기 (처음 한 번)
  const sel = document.getElementById('site');
  if (sel.options.length === 1 && d.sites.length) {
    d.sites.forEach(function(code){
      const o = document.createElement('option');
      o.value = code; o.textContent = siteLabel(code);
      sel.appendChild(o);
    });
    sel.value = d.site;
  }
  const scope = d.site === 'all' ? '전체 사이트' : siteLabel(d.site);
  document.getElementById('range').textContent = scope + ' · 최근 ' + d.days + '일 · 한국시간';
  document.getElementById('k1').textContent = d.today.uv.toLocaleString();
  document.getElementById('k2').textContent = d.today.pv.toLocaleString();
  document.getElementById('k3').textContent = d.total.uv.toLocaleString();
  document.getElementById('k4').textContent = d.total.pv.toLocaleString();
  chart(document.getElementById('chart'), d.daily);

  const siteCard = document.getElementById('siteCard');
  if (d.bySite.length > 1) {
    siteCard.style.display = '';
    table(document.getElementById('bySite'), d.bySite,
      r => siteLabel(r.site) + ' · 조회 ' + r.pv.toLocaleString(), 'uv');
  } else {
    siteCard.style.display = 'none';
  }

  table(document.getElementById('pages'), d.pages,
    r => (d.site === 'all' && d.sites.length > 1 ? '[' + siteLabel(r.site) + '] ' : '') + (PAGE_NAMES[r.page] || r.page), 'n');
  table(document.getElementById('refs'), d.refs, r => r.ref === 'direct' ? '직접 접속' : r.ref, 'n');
  table(document.getElementById('events'), d.events, r => EVENT_NAMES[r.event] || r.event, 'n');
  table(document.getElementById('devices'), d.devices, r => r.device === 'mobile' ? '모바일' : 'PC', 'n');
  table(document.getElementById('hours'), d.hours.map(h => ({ label: h.h + '시', n: h.n })), r => r.label, 'n');
}
document.getElementById('days').addEventListener('change', load);
document.getElementById('site').addEventListener('change', load);
load();
</script></div></body></html>`;
