-- 그린홈시스 방문 집계 테이블 (Cloudflare D1)
-- 여러 사이트를 하나의 표에 함께 기록하고, site 값으로 구분해서 봅니다.
--
-- 개인정보는 저장하지 않습니다. IP는 기록하지 않고,
-- visitor 값은 매일 바뀌는 임시 식별자(복원 불가능한 해시)입니다.

CREATE TABLE IF NOT EXISTS hits (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,   -- 기록 시각 (unix seconds)
  day     TEXT    NOT NULL,   -- 한국시간 기준 날짜 YYYY-MM-DD
  site    TEXT    NOT NULL,   -- 사이트 구분 (ghgp, home, point 등)
  visitor TEXT    NOT NULL,   -- 그날 하루만 유효한 임시 식별자
  page    TEXT    NOT NULL,   -- 페이지 경로 (/index.html 등)
  ref     TEXT,               -- 유입 경로 (네이버, 숨고, direct 등)
  device  TEXT,               -- mobile / desktop
  event   TEXT    NOT NULL    -- view = 페이지 조회, 그 외 = 버튼 클릭 등 행동
);

CREATE INDEX IF NOT EXISTS idx_hits_site_day   ON hits (site, day);
CREATE INDEX IF NOT EXISTS idx_hits_site_event ON hits (site, event, day);

-- 대시보드 조회는 전부 ts(기록 시각) 범위로 찾습니다. 위의 day 인덱스로는 걸리지
-- 않아 매번 표 전체를 훑게 되고, D1 의 "읽은 행" 한도를 순식간에 써버립니다.
-- 아래 두 줄이 그 조회를 범위 검색으로 바꿔 줍니다.
CREATE INDEX IF NOT EXISTS idx_hits_event_ts      ON hits (event, ts);
CREATE INDEX IF NOT EXISTS idx_hits_site_event_ts ON hits (site, event, ts);

-- 가견적서 ("견적서 받기" 메뉴). 로그인이 없는 사이트라, 고객은 전화번호 + 문자
-- 인증번호로 본인 가견적서만 본다. 관리자는 기존 대시보드 비밀번호(세션 쿠키)로
-- /quotes 화면에서 전체 목록을 본다.
--
-- 이미지는 R2가 아니라 이 표에 data URL(base64) 그대로 저장한다. 조회는 항상
-- phone 하나로 찾는 단일 행 조회라 표 전체를 훑지 않는다 — hits 표에서 겪었던
-- "읽은 행" 폭증과는 다른 상황이다.
CREATE TABLE IF NOT EXISTS quotes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT    NOT NULL,        -- 숫자만 (예: 01012345678)
  title       TEXT    NOT NULL,
  pages       TEXT    NOT NULL,        -- JSON 배열 문자열 — data URL 목록
  concerns    TEXT    NOT NULL DEFAULT '[]',  -- JSON 배열 문자열 — 고객이 고른 concern key
  concerns_at INTEGER,                 -- concerns 마지막 저장 시각 (unix seconds)
  viewed_at   INTEGER,                 -- 고객이 처음 열어본 시각
  active      INTEGER NOT NULL DEFAULT 1,  -- 0이면 거둔(회수한) 가견적서 — 기록은 남긴다
  created_at  INTEGER NOT NULL
);

-- /quote/me, /quote/request-code 모두 phone 으로 "지금 활성" 가견적서 하나를 찾는다.
CREATE INDEX IF NOT EXISTS idx_quotes_phone ON quotes (phone, id DESC);
-- 한 전화번호에 활성 가견적서는 동시에 하나만 — 새로 보내면 이전 것부터 비활성화한다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_phone_active ON quotes (phone) WHERE active = 1;
-- 관리자 목록 화면은 최신순 전체 목록.
CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes (created_at DESC);

-- 문자 인증번호. 전화번호 하나당 한 번에 하나만 유효 — 새로 요청하면 이 행을 덮어쓴다.
-- 인증번호는 원문이 아니라 해시로만 저장한다(계정 비밀번호와 같은 이유).
CREATE TABLE IF NOT EXISTS quote_otp (
  phone       TEXT PRIMARY KEY,
  code_hash   TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,   -- unix seconds, 발급 후 5분
  attempts    INTEGER NOT NULL DEFAULT 0,  -- 틀린 시도 횟수 — 일정 횟수 넘으면 재요청해야 함
  sent_at     INTEGER NOT NULL    -- 재발송 간격 제한(60초)에 사용
);
