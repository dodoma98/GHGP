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
