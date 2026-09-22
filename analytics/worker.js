/**
 * 그린홈시스 방문 집계 서버 (Cloudflare Worker)
 *
 * 하는 일
 *  1) POST /collect  — 사이트에서 보내온 방문/행동 기록을 D1에 저장 (공개)
 *  2) GET  /         — 비밀번호 입력 화면 또는 대시보드 (로그인 필요)
 *  3) POST /login    — 비밀번호 확인 후 서명된 세션 쿠키 발급
 *  4) GET  /api/stats— 집계 결과 JSON (로그인 필요)
 *  5) "견적서 받기" — 고객은 전화번호+문자 인증으로 본인 가견적서만 보고, 마음에
 *     걸리는 부분을 체크한다. 관리자는 /quotes 화면에서 전체 목록을 보고 새 가견적서를
 *     보낸다. 아래는 공개 API(문자 인증), 아래아래는 관리자 API(로그인 필요) —
 *     자세한 내용은 "가견적서" 절 참고.
 *       POST /quote/request-code   — 전화번호로 인증번호 문자 발송
 *       POST /quote/verify-code    — 인증번호 확인 → 열람용 토큰 발급
 *       GET  /quote/me             — (토큰) 본인 가견적서 조회
 *       PATCH /quote/me/concerns   — (토큰) 마음에 걸리는 부분 저장
 *       GET  /quotes               — 관리자 화면 (로그인 필요)
 *       GET  /api/quotes           — 관리자: 전체 목록 (로그인 필요)
 *       POST /api/quotes           — 관리자: 새 가견적서 등록 (로그인 필요)
 *       POST /api/quotes/:id/revoke— 관리자: 가견적서 회수 (로그인 필요)
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
 *                              예: https://gh-gp.replit.app,https://greenhomesys.com
 *  - 변수 SITE_NAMES         : 사이트 코드와 표시 이름, 쉼표로 구분 (선택)
 *                              예: ghgp=영업 페이지,home=그린홈시스,viablanc=비아블랑
 *  - 변수 EXCLUDE_IPS        : 집계에서 뺄 IP, 쉼표로 구분 (선택)
 *                              사무실 IP를 넣으면 그 회선의 방문은 기록되지 않습니다.
 *                              끝을 점으로 끝내면 앞부분만 일치해도 제외: 121.130.5.
 *                              (이 값도 저장되지 않고 비교에만 쓰입니다)
 *
 * "견적서 받기"(가견적서)에 필요한 추가 설정
 *  - 비밀 변수 PPURIO_ACCOUNT : 비즈뿌리오 계정 아이디 (문자 발송용)
 *  - 비밀 변수 PPURIO_API_KEY : 비즈뿌리오 API 키
 *  - 변수 PPURIO_FROM         : 문자 발신번호 (사전에 비즈뿌리오에 등록된 번호)
 *  - 변수 QUOTE_TEST_MODE     : '1' 이면 실제 문자를 보내지 않고 인증번호를 화면에
 *                              그대로 보여줍니다. 실제 문자 연동을 확인하기 전까지
 *                              테스트할 때만 켜 두고, 확인되면 반드시 지우세요.
 *                              (지워져 있으면 평소처럼 꺼진 상태입니다)
 */

const SESSION_HOURS = 12;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return preflight(env, request.headers.get('Origin') || '');
    if (url.pathname === '/collect' && request.method === 'POST') return collect(request, env);
    if (url.pathname === '/login' && request.method === 'POST') return login(request, env);
    if (url.pathname === '/logout') return logout(env);

    // 가견적서 — 공개 API (문자 인증으로 본인 확인, 로그인 세션과 무관)
    if (url.pathname === '/quote/request-code' && request.method === 'POST') return quoteRequestCode(request, env);
    if (url.pathname === '/quote/verify-code' && request.method === 'POST') return quoteVerifyCode(request, env);
    if (url.pathname === '/quote/me' && request.method === 'GET') return quoteMe(request, env);
    if (url.pathname === '/quote/me/concerns' && (request.method === 'PATCH' || request.method === 'POST')) {
      return quoteMeConcerns(request, env);
    }

    // 아래부터는 로그인 필요
    const ok = await hasSession(request, env);
    if (url.pathname === '/api/stats') {
      if (!ok) return json({ error: 'unauthorized' }, 401);
      return stats(url, env, request);
    }
    if (url.pathname === '/api/diag') {
      if (!ok) return json({ error: 'unauthorized' }, 401);
      return diag(env, request);
    }
    if (url.pathname === '/api/quotes' && request.method === 'GET') {
      if (!ok) return json({ error: 'unauthorized' }, 401);
      return adminQuotesList(env);
    }
    if (url.pathname === '/api/quotes' && request.method === 'POST') {
      if (!ok) return json({ error: 'unauthorized' }, 401);
      return adminQuotesCreate(request, env);
    }
    const revokeMatch = url.pathname.match(/^\/api\/quotes\/(\d+)\/revoke$/);
    if (revokeMatch && request.method === 'POST') {
      if (!ok) return json({ error: 'unauthorized' }, 401);
      return adminQuotesRevoke(Number(revokeMatch[1]), env);
    }
    if (url.pathname === '/quotes' || url.pathname === '/quotes.html') {
      return html(ok ? QUOTES_ADMIN_HTML : LOGIN_HTML);
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
    return new Response(JSON.stringify({
      ok: false,
      reason: '이 사이트 주소가 허용 목록에 없습니다',
      보낸주소: origin,
      허용된주소: allowedOrigins(env),
    }), { status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
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

  // 사무실 등 내부 회선에서의 접속은 집계하지 않습니다.
  if (ipExcluded(ip, env)) {
    return new Response(JSON.stringify({ ok: true, saved: false, reason: '이 회선은 집계 제외로 설정되어 있습니다' }),
      { headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env, origin) } });
  }

  const visitor = await dailyHash(ip + ua, day, env.SECRET || 'ghgp');

  const page = String(body.page || '/').slice(0, 120);
  const event = String(body.event || 'view').slice(0, 60);
  const site = String(body.site || 'ghgp').slice(0, 30);
  const device = /Mobi|Android|iPhone|iPad/i.test(ua) ? 'mobile' : 'desktop';
  const ref = refLabel(body.ref, body.from);

  await env.DB.prepare(
    'INSERT INTO hits (ts, day, site, visitor, page, ref, device, event) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(now, day, site, visitor, page, ref, device, event).run();

  return new Response(JSON.stringify({ ok: true, saved: true }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env, origin) } });
}

// EXCLUDE_IPS 에 적힌 주소면 true. '121.130.5.' 처럼 점으로 끝내면 앞부분 일치도 제외됩니다.
function ipExcluded(ip, env) {
  if (!ip) return false;
  return (env.EXCLUDE_IPS || '').split(',').map(s => s.trim()).filter(Boolean)
    .some(rule => rule.endsWith('.') ? ip.startsWith(rule) : ip === rule);
}

// 주소 끝의 '/' 나 대소문자 차이로 거부되지 않도록 다듬습니다.
// (설정에 https://gh-gp.replit.app/ 처럼 슬래시를 붙여 넣는 실수가 잦습니다)
function normOrigin(s) {
  return String(s || '').trim().replace(/\/+$/, '').toLowerCase();
}

function allowedOrigins(env) {
  return (env.ALLOW_ORIGIN || '').split(',').map(normOrigin).filter(Boolean);
}

function originAllowed(origin, env) {
  const list = allowedOrigins(env);
  return list.length === 0 || list.includes(normOrigin(origin));
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

// 조회 기간 선택지. bucket = 그래프 한 칸의 단위
const RANGES = {
  '5m':  { sec: 300,      bucket: 300,   unit: 'minute', label: '실시간 (최근 5분)' },
  '1h':  { sec: 3600,     bucket: 300,   unit: 'minute', label: '최근 1시간' },
  '12h': { sec: 43200,    bucket: 3600,  unit: 'hour',   label: '최근 12시간' },
  '24h': { sec: 86400,    bucket: 3600,  unit: 'hour',   label: '최근 24시간' },
  '7d':  { sec: 604800,   bucket: 86400, unit: 'day',    label: '최근 7일' },
  '30d': { sec: 2592000,  bucket: 86400, unit: 'day',    label: '최근 30일' },
  '90d': { sec: 7776000,  bucket: 86400, unit: 'day',    label: '최근 90일' },
};

async function stats(url, env, request) {
  const key = url.searchParams.get('range') || '30d';
  const R = RANGES[key] || RANGES['30d'];
  const now = Math.floor(Date.now() / 1000);
  const fromTs = now - R.sec;
  const site = (url.searchParams.get('site') || 'all').slice(0, 30);

  // site=all 이면 전체, 아니면 해당 사이트만
  const cond = site === 'all' ? '' : ' AND site=?';
  const args = site === 'all' ? [fromTs] : [fromTs, site];
  const q = (sql, extra = []) => env.DB.prepare(sql).bind(...args, ...extra).all();

  // 그래프 가로축 눈금 문구 (한국시간 기준)
  const fmt = R.unit === 'day' ? '%m-%d' : R.unit === 'hour' ? '%H' : '%H:%M';
  const bucketExpr = `strftime('${fmt}', datetime((ts/${R.bucket})*${R.bucket},'unixepoch','+9 hours'))`;

  const todayStart = Math.floor(Date.now() / 1000) - (Math.floor(Date.now() / 1000) + 9 * 3600) % 86400;

  const [series, pages, refs, devices, events, hours, totals, todayRow, bySite] = await Promise.all([
    q(`SELECT ${bucketExpr} label, COUNT(DISTINCT visitor) uv, COUNT(*) pv FROM hits
        WHERE event='view' AND ts>=?${cond} GROUP BY 1 ORDER BY MIN(ts)`),
    q(`SELECT site, page, COUNT(*) n FROM hits
        WHERE event='view' AND ts>=?${cond} GROUP BY site, page ORDER BY n DESC LIMIT 25`),
    q(`SELECT ref, COUNT(DISTINCT visitor) n FROM hits
        WHERE event='view' AND ts>=?${cond} GROUP BY ref ORDER BY n DESC LIMIT 12`),
    q(`SELECT device, COUNT(DISTINCT visitor) n FROM hits
        WHERE event='view' AND ts>=?${cond} GROUP BY device`),
    q(`SELECT event, COUNT(*) n FROM hits
        WHERE event<>'view' AND ts>=?${cond} GROUP BY event ORDER BY n DESC LIMIT 20`),
    q(`SELECT CAST(strftime('%H', datetime(ts,'unixepoch','+9 hours')) AS INTEGER) h, COUNT(*) n
        FROM hits WHERE event='view' AND ts>=?${cond} GROUP BY h ORDER BY h`),
    q(`SELECT COUNT(DISTINCT visitor) uv, COUNT(*) pv FROM hits
        WHERE event='view' AND ts>=?${cond}`),
    // 오늘 숫자는 기간 선택과 무관하게 항상 '오늘 0시부터'
    env.DB.prepare(`SELECT COUNT(DISTINCT visitor) uv, COUNT(*) pv FROM hits
        WHERE event='view' AND ts>=?${cond}`).bind(...(site === 'all' ? [todayStart] : [todayStart, site])).all(),
    // 사이트별 비교는 선택한 기간 기준, 전체 사이트 대상
    env.DB.prepare(`SELECT site, COUNT(DISTINCT visitor) uv, COUNT(*) pv FROM hits
        WHERE event='view' AND ts>=? GROUP BY site ORDER BY uv DESC`).bind(fromTs).all(),
  ]);

  const myIp = request ? (request.headers.get('CF-Connecting-IP') || '') : '';
  const names = siteNames(env);
  // 사이트 목록은 선택한 기간에 기록이 있는 사이트 + 설정에 등록해 둔 사이트를 합칩니다.
  // 예전에는 표 전체에서 DISTINCT site 를 뽑았는데, 그 한 줄이 새로고침마다
  // 표 전체를 훑어 "읽은 행"을 크게 잡아먹었습니다.
  const recorded = (bySite.results || []).map(r => r.site);
  const sites = [...new Set([...recorded, ...Object.keys(names)])].sort();

  return json({
    range: key,
    rangeLabel: R.label,
    unit: R.unit,
    site,
    myIp,
    excluded: ipExcluded(myIp, env),
    names,
    sites,
    today: (todayRow.results || [])[0] || { uv: 0, pv: 0 },
    total: (totals.results || [])[0] || { uv: 0, pv: 0 },
    series: series.results || [],
    bySite: bySite.results || [],
    pages: pages.results || [],
    refs: refs.results || [],
    devices: devices.results || [],
    events: events.results || [],
    hours: hours.results || [],
  });
}

/* ───────────── 설정 점검 ───────────── */

// "왜 기록이 0건인지" 확인할 수 있도록 현재 상태를 그대로 보여줍니다.
async function diag(env, request) {
  const now = Math.floor(Date.now() / 1000);
  const [all, day, recent] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) n FROM hits').all(),
    env.DB.prepare('SELECT COUNT(*) n FROM hits WHERE ts>=?').bind(now - 86400).all(),
    env.DB.prepare(`SELECT datetime(ts,'unixepoch','+9 hours') t, site, page, ref, device, event
                    FROM hits ORDER BY id DESC LIMIT 8`).all(),
  ]);
  const myIp = request.headers.get('CF-Connecting-IP') || '';
  return json({
    총기록: (all.results || [])[0]?.n ?? 0,
    최근24시간: (day.results || [])[0]?.n ?? 0,
    최근기록: recent.results || [],
    허용된주소: allowedOrigins(env),
    제외규칙: (env.EXCLUDE_IPS || '').split(',').map(s => s.trim()).filter(Boolean),
    사이트이름: siteNames(env),
    내IP: myIp,
    내회선_제외됨: ipExcluded(myIp, env),
    데이터베이스_연결됨: true,
  });
}

/* ───────────── 가견적서 ("견적서 받기") ─────────────
 * 영업 페이지(gh-gp.replit.app)는 로그인이 없는 정적 사이트라, 고객이 "본인 것만"
 * 보게 하려면 회원 시스템 대신 전화번호+문자 인증을 쓴다. 흐름:
 *   1) 고객이 전화번호 입력 → POST /quote/request-code → 6자리 인증번호 문자 발송
 *   2) 고객이 인증번호 입력 → POST /quote/verify-code  → 열람용 토큰 발급(24시간)
 *   3) 그 토큰으로 GET /quote/me (조회), PATCH /quote/me/concerns (체크 저장)
 * 관리자는 기존 대시보드 로그인 세션 쿠키를 그대로 쓴다 (/quotes 화면, /api/quotes*).
 *
 * 같은 전화번호에 "활성" 가견적서는 항상 하나뿐이다(schema.sql 의 unique index).
 * 관리자가 새로 보내면 이전 것은 active=0 으로 바뀌고 기록만 남는다 — 지우지 않는다.
 */

// 그린홈시스 가견적서 오른쪽 화면의 고정 6개 항목. greenhome-mileage(포인트 웹)와
// 같은 목록이다 — 두 화면의 고객 경험을 맞추려는 의도적 선택. key 를 고치거나 빼면
// 이미 저장된 옛 고객의 선택이 화면에서 사라지니, 문구(label)만 고칠 것.
const QUOTE_CONCERNS = [
  { key: 'price', label: '가격이 부담돼요' },
  { key: 'compare', label: '다른 업체와 비교하고 싶어요' },
  { key: 'material', label: '자재·브랜드가 궁금해요' },
  { key: 'schedule', label: '시공 일정이 걱정돼요' },
  { key: 'spec', label: '제품 사양(단열·방음 등)이 궁금해요' },
  { key: 'as', label: 'A/S·보증 조건이 궁금해요' },
];
const QUOTE_CONCERN_KEYS = new Set(QUOTE_CONCERNS.map(c => c.key));

// 숫자만 남긴 전화번호. 010/011 등 휴대폰과, 드물게 오는 지역번호 문의까지 느슨하게
// 허용한다(9~11자리) — 너무 빡빡하게 막으면 실제 고객이 인증번호조차 못 받는다.
function normPhone(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  return /^0[0-9]{8,10}$/.test(digits) ? digits : '';
}

function genOtpCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

// 인증번호는 원문을 저장하지 않는다 — 세션 쿠키 서명과 같은 hmac()을 재사용해
// "전화번호+코드"를 해시로 바꿔 D1에는 그 해시만 남긴다.
const otpHash = (phone, code, secret) => hmac(`otp:${phone}:${code}`, secret);

// 가견적서 열람 토큰: "전화번호.만료시각.서명" — 관리자 세션 쿠키와 같은 방식이라
// 새 암호화 라이브러리 없이 crypto.subtle 만으로 끝난다. 24시간 동안 유효.
async function issueQuoteToken(phone, secret) {
  const exp = Date.now() + 24 * 3600 * 1000;
  const sig = await hmac(`quote:${phone}:${exp}`, secret);
  return `${phone}.${exp}.${sig}`;
}
async function verifyQuoteToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return '';
  const [phone, exp, sig] = parts;
  if (!phone || !exp || Number(exp) < Date.now()) return '';
  const good = await hmac(`quote:${phone}:${exp}`, secret);
  return sig === good ? phone : '';
}
function bearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/* 문자 발송 — 비즈뿌리오(Ppurio) API.
 * ⚠ 검증 필요: 토큰 발급(POST /v1/token, Basic 인증)은 공식 문서로 확인했지만,
 *   메시지 발송(POST /v3/message)의 정확한 JSON 필드는 이 환경에서 비즈뿌리오
 *   문서 사이트에 접속이 막혀 있어 실제 응답으로 확인하지 못했다. 아래 body는
 *   공개된 예시를 바탕으로 한 최선의 추정이다 — 실제 계정으로 처음 보낼 때는
 *   QUOTE_TEST_MODE=1 로 먼저 전체 흐름을 확인한 뒤, 그 값을 지우고 실제 문자가
 *   도착하는지 꼭 한 번 확인해 주세요. 만약 발송이 실패하면(관리자에게 오류로
 *   보인다) 비즈뿌리오 개발 문서의 최신 예시로 이 함수 하나만 고치면 된다.
 */
async function sendOtpSmsViaPpurio(phone, code, env) {
  const account = env.PPURIO_ACCOUNT;
  const apiKey = env.PPURIO_API_KEY;
  const from = env.PPURIO_FROM;
  if (!account || !apiKey || !from) {
    throw new Error('문자 발송 설정(PPURIO_ACCOUNT/PPURIO_API_KEY/PPURIO_FROM)이 되어 있지 않습니다.');
  }
  const tokenRes = await fetch('https://api.bizppurio.com/v1/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${account}:${apiKey}`)}` },
  });
  if (!tokenRes.ok) {
    throw new Error(`문자 서비스 인증에 실패했습니다 (${tokenRes.status}). 계정/API키를 확인해 주세요.`);
  }
  const tokenBody = await tokenRes.json();
  const bearer = tokenBody.token;
  if (!bearer) throw new Error('문자 서비스 인증 응답에 토큰이 없습니다.');

  const sendRes = await fetch('https://api.bizppurio.com/v3/message', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      account,
      messages: [{
        to: phone,
        from: String(from).replace(/[^0-9]/g, ''),
        content: `[그린홈시스] 가견적서 인증번호는 ${code} 입니다. (5분 이내 입력)`,
      }],
    }),
  });
  if (!sendRes.ok) {
    const detail = await sendRes.text().catch(() => '');
    throw new Error(`문자 발송에 실패했습니다 (${sendRes.status}). ${detail.slice(0, 200)}`);
  }
}

async function sendOtpCode(phone, code, env) {
  if (env.QUOTE_TEST_MODE === '1') return; // 테스트 모드 — 실제 문자 없이 응답에 코드를 그대로 보여준다.
  await sendOtpSmsViaPpurio(phone, code, env);
}

// POST /quote/request-code  { phone }
async function quoteRequestCode(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!originAllowed(origin, env)) return jsonCors({ ok: false, reason: '허용되지 않은 사이트입니다.' }, 403, env, origin);

  let body;
  try { body = await request.json(); } catch { return jsonCors({ ok: false, reason: '요청 형식이 올바르지 않습니다.' }, 400, env, origin); }
  const phone = normPhone(body.phone);
  if (!phone) return jsonCors({ ok: false, reason: '휴대폰 번호를 확인해 주세요.' }, 400, env, origin);

  // 등록된 가견적서가 없는 번호에는 문자를 보내지 않는다 — 비용·오발송 방지.
  const has = await env.DB.prepare('SELECT id FROM quotes WHERE phone=? AND active=1 LIMIT 1').bind(phone).all();
  if (!(has.results || []).length) {
    return jsonCors({ ok: false, reason: '등록된 가견적서가 없습니다. 담당자에게 문의해 주세요.' }, 404, env, origin);
  }

  const now = Math.floor(Date.now() / 1000);
  const existing = await env.DB.prepare('SELECT sent_at FROM quote_otp WHERE phone=?').bind(phone).all();
  const prevSentAt = (existing.results || [])[0]?.sent_at;
  if (prevSentAt && now - prevSentAt < 60) {
    return jsonCors({ ok: false, reason: '잠시 후 다시 시도해 주세요. (60초에 한 번만 보낼 수 있어요)' }, 429, env, origin);
  }

  const code = genOtpCode();
  const codeHash = await otpHash(phone, code, env.SECRET || 'ghgp');
  await env.DB.prepare(
    'INSERT INTO quote_otp (phone, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?) ' +
    'ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at'
  ).bind(phone, codeHash, now + 300, now).run();

  try {
    await sendOtpCode(phone, code, env);
  } catch (e) {
    return jsonCors({ ok: false, reason: e instanceof Error ? e.message : '문자 발송에 실패했습니다.' }, 500, env, origin);
  }

  const testCode = env.QUOTE_TEST_MODE === '1' ? code : undefined;
  return jsonCors({ ok: true, testCode }, 200, env, origin);
}

// POST /quote/verify-code  { phone, code }
async function quoteVerifyCode(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!originAllowed(origin, env)) return jsonCors({ ok: false, reason: '허용되지 않은 사이트입니다.' }, 403, env, origin);

  let body;
  try { body = await request.json(); } catch { return jsonCors({ ok: false, reason: '요청 형식이 올바르지 않습니다.' }, 400, env, origin); }
  const phone = normPhone(body.phone);
  const code = String(body.code || '').replace(/[^0-9]/g, '');
  if (!phone || code.length !== 6) return jsonCors({ ok: false, reason: '인증번호를 확인해 주세요.' }, 400, env, origin);

  const row = await env.DB.prepare('SELECT code_hash, expires_at, attempts FROM quote_otp WHERE phone=?').bind(phone).all();
  const otp = (row.results || [])[0];
  if (!otp) return jsonCors({ ok: false, reason: '인증번호를 먼저 요청해 주세요.' }, 400, env, origin);
  if (Math.floor(Date.now() / 1000) > otp.expires_at) {
    return jsonCors({ ok: false, reason: '인증번호가 만료되었습니다. 다시 요청해 주세요.' }, 400, env, origin);
  }
  if (otp.attempts >= 5) {
    return jsonCors({ ok: false, reason: '시도 횟수를 초과했습니다. 인증번호를 다시 요청해 주세요.' }, 429, env, origin);
  }

  const good = await otpHash(phone, code, env.SECRET || 'ghgp');
  if (good !== otp.code_hash) {
    await env.DB.prepare('UPDATE quote_otp SET attempts = attempts + 1 WHERE phone=?').bind(phone).run();
    return jsonCors({ ok: false, reason: '인증번호가 맞지 않습니다.' }, 400, env, origin);
  }

  await env.DB.prepare('DELETE FROM quote_otp WHERE phone=?').bind(phone).run();
  const token = await issueQuoteToken(phone, env.SECRET || 'ghgp');
  return jsonCors({ ok: true, token }, 200, env, origin);
}

// GET /quote/me — Authorization: Bearer <token>
async function quoteMe(request, env) {
  const origin = request.headers.get('Origin') || '';
  const phone = await verifyQuoteToken(bearerToken(request), env.SECRET || 'ghgp');
  if (!phone) return jsonCors({ ok: false, reason: '인증이 만료되었습니다. 다시 인증해 주세요.' }, 401, env, origin);

  const row = await env.DB.prepare(
    'SELECT id, title, pages, concerns, concerns_at, viewed_at, created_at FROM quotes WHERE phone=? AND active=1 LIMIT 1'
  ).bind(phone).all();
  const q = (row.results || [])[0];
  if (!q) return jsonCors({ ok: true, quote: null }, 200, env, origin);

  if (!q.viewed_at) {
    await env.DB.prepare('UPDATE quotes SET viewed_at=? WHERE id=?').bind(Math.floor(Date.now() / 1000), q.id).run();
  }

  return jsonCors({
    ok: true,
    quote: {
      id: q.id,
      title: q.title,
      pages: JSON.parse(q.pages || '[]'),
      concerns: JSON.parse(q.concerns || '[]'),
      concernsAt: q.concerns_at,
      createdAt: q.created_at,
    },
    concernOptions: QUOTE_CONCERNS,
  }, 200, env, origin);
}

// PATCH /quote/me/concerns — Authorization: Bearer <token>, body { concerns: [...] }
async function quoteMeConcerns(request, env) {
  const origin = request.headers.get('Origin') || '';
  const phone = await verifyQuoteToken(bearerToken(request), env.SECRET || 'ghgp');
  if (!phone) return jsonCors({ ok: false, reason: '인증이 만료되었습니다. 다시 인증해 주세요.' }, 401, env, origin);

  let body;
  try { body = await request.json(); } catch { return jsonCors({ ok: false, reason: '요청 형식이 올바르지 않습니다.' }, 400, env, origin); }
  const list = Array.isArray(body.concerns) ? body.concerns : [];
  const concerns = [...new Set(list.filter(k => QUOTE_CONCERN_KEYS.has(k)))];

  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    'UPDATE quotes SET concerns=?, concerns_at=? WHERE phone=? AND active=1'
  ).bind(JSON.stringify(concerns), now, phone).run();
  if (!res.meta || res.meta.changes === 0) {
    return jsonCors({ ok: false, reason: '가견적서를 찾을 수 없습니다.' }, 404, env, origin);
  }
  return jsonCors({ ok: true, concerns }, 200, env, origin);
}

/* ───────────── 가견적서 — 관리자 API (로그인 필요) ───────────── */

async function adminQuotesList(env) {
  const rows = await env.DB.prepare(
    'SELECT id, phone, title, active, viewed_at, concerns, concerns_at, created_at FROM quotes ORDER BY created_at DESC LIMIT 300'
  ).all();
  const quotes = (rows.results || []).map(q => ({
    ...q,
    concerns: JSON.parse(q.concerns || '[]'),
  }));
  return json({ ok: true, quotes, concernOptions: QUOTE_CONCERNS });
}

async function adminQuotesCreate(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, reason: '요청 형식이 올바르지 않습니다.' }, 400); }
  const phone = normPhone(body.phone);
  const title = String(body.title || '').trim().slice(0, 80);
  const pages = Array.isArray(body.pages) ? body.pages.filter(p => typeof p === 'string' && p.startsWith('data:image/')) : [];

  if (!phone) return json({ ok: false, reason: '휴대폰 번호를 확인해 주세요.' }, 400);
  if (!title) return json({ ok: false, reason: '제목을 입력해 주세요.' }, 400);
  if (!pages.length) return json({ ok: false, reason: '가견적서 이미지를 1장 이상 올려 주세요.' }, 400);
  if (pages.length > 20) return json({ ok: false, reason: '이미지는 한 번에 20장까지 올릴 수 있어요.' }, 400);

  const pagesJson = JSON.stringify(pages);
  // D1 한 행에 너무 큰 값이 들어가지 않도록 넉넉히 여유를 둔 상한선(약 8MB 상당).
  if (pagesJson.length > 8_000_000) {
    return json({ ok: false, reason: '이미지 용량이 너무 큽니다. 장수를 줄이거나 더 작은 이미지로 올려 주세요.' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.batch([
    env.DB.prepare('UPDATE quotes SET active=0 WHERE phone=? AND active=1').bind(phone),
    env.DB.prepare(
      "INSERT INTO quotes (phone, title, pages, concerns, active, created_at) VALUES (?, ?, ?, '[]', 1, ?)"
    ).bind(phone, title, pagesJson, now),
  ]);
  const id = result[1]?.meta?.last_row_id;
  return json({ ok: true, id });
}

async function adminQuotesRevoke(id, env) {
  if (!Number.isInteger(id) || id < 1) return json({ ok: false, reason: '잘못된 요청입니다.' }, 400);
  const res = await env.DB.prepare('UPDATE quotes SET active=0 WHERE id=? AND active=1').bind(id).run();
  if (!res.meta || res.meta.changes === 0) return json({ ok: false, reason: '이미 회수되었거나 없는 가견적서입니다.' }, 404);
  return json({ ok: true });
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
  const allow = list.length === 0 ? '*' : (list.includes(normOrigin(origin)) ? origin : list[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    // 가견적서 화면(quote.html)은 GET/PATCH 로도 이 Worker를 부르고, 열람 토큰을
    // Authorization 헤더로 보낸다 — /collect 만 쓰던 시절보다 넓혀 둔다.
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}
const preflight = (env, origin) => new Response(null, { status: 204, headers: corsHeaders(env, origin) });
const corsOk = (env, origin) => new Response('ok', { headers: corsHeaders(env, origin) });
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const jsonCors = (obj, status, env, origin) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env, origin) } });
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
  <div><h1>그린홈시스 대시보드</h1><p class="muted" id="scope">불러오는 중…</p></div>
  <div class="sp">
    <select id="site"><option value="all">전체 사이트</option></select>
    <select id="range">
      <option value="5m">실시간 (최근 5분)</option>
      <option value="1h">최근 1시간</option>
      <option value="12h">최근 12시간</option>
      <option value="24h">최근 24시간</option>
      <option value="7d">최근 7일</option>
      <option value="30d" selected>최근 30일</option>
      <option value="90d">최근 90일</option>
    </select>
    <a class="btn" href="/quotes">가견적서 →</a>
    <a class="btn" href="/logout">로그아웃</a>
  </div>
</header>
<div class="kpis">
  <div class="kpi"><b id="k1">–</b><span>오늘 방문자</span></div>
  <div class="kpi"><b id="k2">–</b><span>오늘 조회수</span></div>
  <div class="kpi"><b id="k3">–</b><span id="k3l">기간 방문자</span></div>
  <div class="kpi"><b id="k4">–</b><span id="k4l">기간 조회수</span></div>
</div>
<div class="grid">
  <div class="card full"><h2 id="chartTitle">방문자 추이</h2><div id="chart"></div></div>
  <div class="card full" id="siteCard"><h2>사이트별 비교</h2><div id="bySite"></div></div>
  <div class="card"><h2>페이지별 조회</h2><div id="pages"></div></div>
  <div class="card"><h2>유입 경로</h2><div id="refs"></div></div>
  <div class="card"><h2>버튼·자료 클릭</h2><div id="events"></div></div>
  <div class="card"><h2>기기 · 시간대</h2><div id="devices"></div><div id="hours" style="margin-top:14px"></div></div>
</div>
<p class="card" id="emptyHint" style="margin-top:18px;display:none;line-height:1.7;font-size:14.5px"></p>
<div class="card" style="margin-top:18px">
  <h2>설정 점검 <button class="btn-diag" type="button" id="diagBtn">확인하기</button></h2>
  <div id="diag" class="empty">버튼을 누르면 지금 설정 상태와 최근 기록을 그대로 보여줍니다.</div>
</div>
<p class="muted" id="ipInfo" style="margin-top:18px;text-align:center"></p>
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
function chart(el, rows, unit){
  if (!rows.length) { el.innerHTML = '<p class="empty">이 기간에는 기록이 없습니다.</p>'; return; }
  const suffix = unit === 'hour' ? '시' : '';
  const W = 900, H = 220, P = 30, max = Math.max(1, ...rows.map(d => d.uv));
  const x = i => rows.length === 1 ? W/2 : P + i * (W - P*2) / (rows.length - 1);
  const y = v => H - P - v / max * (H - P*2);
  const pts = rows.map((d,i) => x(i) + ',' + y(d.uv)).join(' ');
  const area = 'M' + x(0) + ',' + (H-P) + ' L' + pts.split(' ').join(' L') + ' L' + x(rows.length-1) + ',' + (H-P) + ' Z';
  const step = Math.ceil(rows.length / 6);
  el.innerHTML =
    '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="방문자 추이">' +
    '<path d="' + area + '" fill="#e8f3eb"/>' +
    '<polyline points="' + pts + '" fill="none" stroke="#1b7a44" stroke-width="2.5" stroke-linejoin="round"/>' +
    rows.map((d,i) => '<circle cx="' + x(i) + '" cy="' + y(d.uv) + '" r="3.5" fill="#1b7a44"><title>' +
      esc(d.label) + suffix + ' · 방문자 ' + d.uv + '명 / 조회 ' + d.pv + '회</title></circle>').join('') +
    rows.map((d,i) => (i % step === 0 || i === rows.length-1)
      ? '<text x="' + x(i) + '" y="' + (H-8) + '" font-size="11" fill="#5e6e62" text-anchor="middle">' +
        esc(d.label) + suffix + '</text>' : '').join('') +
    '<text x="' + P + '" y="18" font-size="11" fill="#5e6e62">최대 ' + max + '명</text></svg>';
}
let SITE_NAMES = {};
function siteLabel(code){ return SITE_NAMES[code] || code; }

let timer = null;
let autoMs = 0;

// 탭이 보일 때만 타이머를 돌립니다. 숨겨지면 멈추고, 다시 보이면 한 번 새로 읽습니다.
function restartTimer(){
  if (timer) { clearInterval(timer); timer = null; }
  if (autoMs && !document.hidden) timer = setInterval(load, autoMs);
}
document.addEventListener('visibilitychange', function(){
  if (document.hidden) { if (timer) { clearInterval(timer); timer = null; } }
  else { load(); }
});

async function load(){
  const range = document.getElementById('range').value;
  const site = document.getElementById('site').value;
  const r = await fetch('/api/stats?range=' + range + '&site=' + encodeURIComponent(site));
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
  const now = new Date();
  const hhmm = ('0'+now.getHours()).slice(-2) + ':' + ('0'+now.getMinutes()).slice(-2) + ':' + ('0'+now.getSeconds()).slice(-2);
  document.getElementById('scope').textContent = scope + ' · ' + d.rangeLabel + ' · 한국시간 · ' + hhmm + ' 기준';
  document.getElementById('chartTitle').textContent =
    d.unit === 'day' ? '일별 방문자' : d.unit === 'hour' ? '시간별 방문자' : '분 단위 방문자';

  // 짧은 기간을 보고 있을 때만, 그리고 화면을 실제로 보고 있을 때만 새로고침합니다.
  // 켜둔 채 잊은 탭이 배경에서 계속 조회하면 D1 의 "읽은 행" 한도를 다 써버립니다.
  autoMs = { '5m': 15000, '1h': 60000, '12h': 300000, '24h': 300000 }[d.range] || 0;
  restartTimer();
  document.getElementById('k1').textContent = d.today.uv.toLocaleString();
  document.getElementById('k2').textContent = d.today.pv.toLocaleString();
  document.getElementById('k3').textContent = d.total.uv.toLocaleString();
  document.getElementById('k4').textContent = d.total.pv.toLocaleString();
  document.getElementById('k3l').textContent = d.rangeLabel + ' 방문자';
  document.getElementById('k4l').textContent = d.rangeLabel + ' 조회수';
  chart(document.getElementById('chart'), d.series, d.unit);

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

  var emptyEl = document.getElementById('emptyHint');
  if (d.total.pv === 0) {
    emptyEl.style.display = '';
    emptyEl.innerHTML = '<b>아직 쌓인 기록이 없습니다.</b><br>'
      + '① 각 사이트를 새로 배포했는지 ② Worker 설정의 ALLOW_ORIGIN 에 그 사이트 주소가 들어 있는지 '
      + '③ 지금 보고 계신 회선이 EXCLUDE_IPS 로 제외되어 있지는 않은지 확인해 보세요. '
      + '(제외된 회선에서 방문하면 기록이 남지 않습니다 — 휴대폰 데이터로 접속해 확인해 보시는 것이 확실합니다.)';
  } else {
    emptyEl.style.display = 'none';
  }

  var ipEl = document.getElementById('ipInfo');
  if (d.myIp) {
    ipEl.innerHTML = d.excluded
      ? '지금 접속한 회선(' + esc(d.myIp) + ')은 집계에서 제외되어 있습니다.'
      : '지금 접속한 회선: <b>' + esc(d.myIp) + '</b> — 사무실에서 보고 계신다면 이 주소를 '
        + 'Cloudflare 설정의 EXCLUDE_IPS 에 넣으면 사무실 방문이 집계에서 빠집니다.';
  }
}
document.getElementById('diagBtn').addEventListener('click', async function () {
  var el = document.getElementById('diag');
  el.textContent = '확인 중…';
  var r = await fetch('/api/diag');
  if (!r.ok) { el.textContent = '확인에 실패했습니다. 다시 로그인해 주세요.'; return; }
  var d = await r.json();
  var row = function (k, v, cls) {
    return '<div class="diag-row"><b>' + k + '</b><span' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</span></div>';
  };
  var html = '';
  html += row('저장된 기록', d['총기록'].toLocaleString() + '건 (최근 24시간 ' + d['최근24시간'].toLocaleString() + '건)',
              d['총기록'] > 0 ? 'diag-ok' : 'diag-bad');
  html += row('허용된 사이트 주소', d['허용된주소'].length ? d['허용된주소'].map(esc).join('<br>') : '(설정 안 됨 — 모든 주소 허용)',
              d['허용된주소'].length ? '' : 'diag-bad');
  html += row('집계 제외 회선', d['제외규칙'].length ? d['제외규칙'].map(esc).join(', ') : '(없음)');
  html += row('지금 내 회선', esc(d['내IP']) + (d['내회선_제외됨'] ? ' → 집계에서 제외됨' : ' → 집계 대상'),
              d['내회선_제외됨'] ? 'diag-bad' : 'diag-ok');
  html += row('사이트 이름 설정', Object.keys(d['사이트이름']).length
              ? Object.keys(d['사이트이름']).map(function (k) { return esc(k + ' = ' + d['사이트이름'][k]); }).join('<br>')
              : '(설정 안 됨)');
  if (d['최근기록'].length) {
    html += '<div class="diag-row"><b>최근 기록</b><span>' + d['최근기록'].map(function (h) {
      return esc(h.t + '  ' + h.site + '  ' + h.page + '  (' + h.event + ')');
    }).join('<br>') + '</span></div>';
  } else {
    html += row('최근 기록', '없음 — 아래 원인 중 하나입니다: ①사이트 재배포 안 됨 ②허용 주소 누락 ③지금 회선이 제외됨', 'diag-bad');
  }
  el.className = '';
  el.innerHTML = html;
});

document.getElementById('range').addEventListener('change', load);
document.getElementById('site').addEventListener('change', load);
load();
</script></div></body></html>`;

/* ───────────── 가견적서 관리자 화면 ───────────── */

const QUOTES_ADMIN_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>가견적서 관리 — 그린홈시스</title>
<style>${BASE_CSS}
 header{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}
 header .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
 .btn{font-family:inherit;font-size:14px;padding:8px 12px;border:1.5px solid #cde3d3;
   border-radius:999px;background:#fff;color:#1b2b20;cursor:pointer;text-decoration:none;display:inline-block}
 form.card{display:grid;gap:12px;margin-bottom:20px}
 form.card label{font-size:13.5px;font-weight:700;color:#1b2b20;display:block;margin-bottom:6px}
 form.card input[type=text],form.card input[type=tel]{width:100%;padding:11px 12px;font-size:15px;
   border:1.5px solid #cde3d3;border-radius:10px}
 form.card input[type=file]{width:100%;font-size:14px}
 .row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
 .thumbs{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
 .thumbs img{width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #cde3d3}
 button[type=submit]{padding:13px;font-size:15.5px;font-weight:800;color:#fff;background:#1b7a44;
   border:none;border-radius:10px;cursor:pointer}
 button[type=submit]:disabled{opacity:.6;cursor:not-allowed}
 .msg{font-size:13.5px;font-weight:700;margin-top:-4px}
 .msg.err{color:#a6242f}
 .msg.ok{color:#1b7a44}
 table{width:100%;border-collapse:collapse;font-size:14px}
 th,td{padding:9px 8px;border-bottom:1px solid #eef4ef;text-align:left;vertical-align:top}
 th{color:#5e6e62;font-weight:700;font-size:12.5px}
 .tag{display:inline-block;font-size:12px;font-weight:700;padding:2px 9px;border-radius:999px}
 .tag-on{background:#e8f3eb;color:#14532d}
 .tag-off{background:#f4e6e6;color:#a6242f}
 .concern-chip{display:inline-block;font-size:11.5px;background:#f4f8f4;border:1px solid #cde3d3;
   border-radius:999px;padding:2px 8px;margin:1px}
 .revoke{font-size:12.5px;color:#a6242f;background:#fff;border:1.5px solid #f0cdd0;border-radius:999px;
   padding:5px 10px;cursor:pointer}
 .empty{color:#5e6e62;font-size:14px;padding:10px 0}
 @media(max-width:700px){.row2{grid-template-columns:1fr}table,thead,tbody,th,td,tr{display:block}
   thead{display:none}tr{border-bottom:1px solid #cde3d3;padding:10px 0}
   td{border-bottom:none;padding:3px 0}td::before{content:attr(data-l);display:inline-block;min-width:88px;color:#5e6e62;font-size:12px}}
</style></head><body><div class="wrap">
<header>
  <div><h1>가견적서 관리</h1><p class="muted">전화번호 인증으로 고객이 본인 것만 봅니다.</p></div>
  <div class="sp">
    <a class="btn" href="/">← 대시보드</a>
    <a class="btn" href="/logout">로그아웃</a>
  </div>
</header>

<form class="card" id="sendForm">
  <h2 style="font-size:16px;font-weight:800">새 가견적서 보내기</h2>
  <div class="row2">
    <div><label for="phone">고객 휴대폰 번호</label><input type="tel" id="phone" placeholder="01012345678" required></div>
    <div><label for="title">제목</label><input type="text" id="title" placeholder="예: 홍길동님 시스템창호 가견적" required></div>
  </div>
  <div>
    <label for="files">가견적서 이미지 (여러 장 선택 가능, 순서대로 저장됩니다)</label>
    <input type="file" id="files" accept="image/*" multiple required>
    <div class="thumbs" id="thumbs"></div>
  </div>
  <div id="sendMsg" class="msg"></div>
  <button type="submit" id="sendBtn">고객에게 보내기</button>
</form>

<div class="card">
  <h2 style="font-size:16px;font-weight:800;margin-bottom:10px">전체 목록</h2>
  <div id="list" class="empty">불러오는 중…</div>
</div>
</div>
<script>
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let CONCERN_LABELS = {};

// 큰 사진을 그대로 올리면 D1 행 하나가 너무 커진다 — 가로 최대 1600px, JPEG로
// 줄여서 data URL로 만든다 (원본 화질은 손실되지만 견적서 열람 용도로는 충분하다).
function downscale(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    reader.onload = () => { img.src = reader.result; };
    img.onerror = () => reject(new Error('이미지를 열지 못했습니다.'));
    img.onload = () => {
      const scale = Math.min(1, 1600 / img.width);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    reader.readAsDataURL(file);
  });
}

async function loadList() {
  const el = document.getElementById('list');
  const r = await fetch('/api/quotes');
  if (!r.ok) { el.textContent = '불러오지 못했습니다.'; return; }
  const d = await r.json();
  CONCERN_LABELS = {};
  (d.concernOptions || []).forEach(c => { CONCERN_LABELS[c.key] = c.label; });
  if (!d.quotes.length) { el.innerHTML = '<p class="empty">아직 보낸 가견적서가 없습니다.</p>'; return; }
  el.innerHTML = '<table><thead><tr><th>전화번호</th><th>제목</th><th>상태</th><th>고객이 열어봄</th>'
    + '<th>마음에 걸리는 부분</th><th>보낸 날짜</th><th></th></tr></thead><tbody>'
    + d.quotes.map(q => {
      const concerns = (q.concerns || []).map(k => '<span class="concern-chip">' + esc(CONCERN_LABELS[k] || k) + '</span>').join('') || '<span class="muted">-</span>';
      const when = new Date(q.created_at * 1000).toLocaleString('ko-KR');
      return '<tr>'
        + '<td data-l="전화번호">' + esc(q.phone) + '</td>'
        + '<td data-l="제목">' + esc(q.title) + '</td>'
        + '<td data-l="상태"><span class="tag ' + (q.active ? 'tag-on' : 'tag-off') + '">' + (q.active ? '전달중' : '회수됨') + '</span></td>'
        + '<td data-l="열어봄">' + (q.viewed_at ? '예' : '아직') + '</td>'
        + '<td data-l="마음에 걸리는 부분">' + concerns + '</td>'
        + '<td data-l="보낸 날짜">' + when + '</td>'
        + '<td>' + (q.active ? '<button class="revoke" data-id="' + q.id + '">회수</button>' : '') + '</td>'
        + '</tr>';
    }).join('') + '</tbody></table>';
  el.querySelectorAll('.revoke').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('이 가견적서를 회수하시겠어요? 고객이 더 이상 볼 수 없습니다.')) return;
    btn.disabled = true;
    const r = await fetch('/api/quotes/' + btn.dataset.id + '/revoke', { method: 'POST' });
    if (r.ok) loadList(); else { alert('회수에 실패했습니다.'); btn.disabled = false; }
  }));
}

document.getElementById('files').addEventListener('change', async (e) => {
  const thumbs = document.getElementById('thumbs');
  thumbs.innerHTML = '';
  const files = [...e.target.files];
  for (const f of files) {
    try {
      const url = await downscale(f);
      const img = document.createElement('img');
      img.src = url;
      thumbs.appendChild(img);
    } catch (err) {}
  }
});

document.getElementById('sendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('sendMsg');
  const btn = document.getElementById('sendBtn');
  msg.textContent = ''; msg.className = 'msg';
  const phone = document.getElementById('phone').value;
  const title = document.getElementById('title').value;
  const files = [...document.getElementById('files').files];
  if (!files.length) { msg.textContent = '이미지를 선택해 주세요.'; msg.className = 'msg err'; return; }
  btn.disabled = true; btn.textContent = '올리는 중…';
  try {
    const pages = [];
    for (const f of files) pages.push(await downscale(f));
    const r = await fetch('/api/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, title, pages }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.reason || '보내지 못했습니다.');
    msg.textContent = '보냈습니다. 고객이 문자 인증 후 바로 볼 수 있어요.';
    msg.className = 'msg ok';
    document.getElementById('sendForm').reset();
    document.getElementById('thumbs').innerHTML = '';
    loadList();
  } catch (err) {
    msg.textContent = err instanceof Error ? err.message : '보내지 못했습니다.';
    msg.className = 'msg err';
  } finally {
    btn.disabled = false; btn.textContent = '고객에게 보내기';
  }
});

loadList();
</script></body></html>`;
