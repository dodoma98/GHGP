-- 그린홈시스 방문 집계 테이블 (Cloudflare D1)
-- 개인정보는 저장하지 않습니다. IP는 기록하지 않고,
-- visitor 값은 매일 바뀌는 임시 식별자(복원 불가능한 해시)입니다.

CREATE TABLE IF NOT EXISTS hits (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,   -- 기록 시각 (unix seconds)
  day     TEXT    NOT NULL,   -- 한국시간 기준 날짜 YYYY-MM-DD
  visitor TEXT    NOT NULL,   -- 그날 하루만 유효한 임시 식별자
  page    TEXT    NOT NULL,   -- 페이지 경로 (/index.html 등)
  ref     TEXT,               -- 유입 경로 (naver, soomgo, direct 등)
  device  TEXT,               -- mobile / desktop
  event   TEXT    NOT NULL    -- view = 페이지 조회, 그 외 = 버튼 클릭 등 행동
);

CREATE INDEX IF NOT EXISTS idx_hits_day   ON hits (day);
CREATE INDEX IF NOT EXISTS idx_hits_event ON hits (event, day);
