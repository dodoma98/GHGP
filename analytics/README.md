# 그린홈시스 방문 집계 · 대시보드 설치 안내

우리 사이트의 방문 기록을 **직접 집계**해서, 관리자만 볼 수 있는 대시보드에서 확인하는 구성입니다.
외부 분석 서비스를 쓰지 않고, 데이터는 전부 우리 Cloudflare 계정에 쌓입니다.

```
방문자 → 사이트(집계 코드) → Cloudflare Worker → D1 데이터베이스
                                     ↑
                          관리자 → 대시보드 (비밀번호 로그인)
```

## 파일

| 파일 | 설명 |
|---|---|
| `worker.js` | 집계 서버 + 대시보드 화면 (Cloudflare Worker에 붙여넣는 코드) |
| `schema.sql` | 기록이 쌓일 표 구조 |

---

## 설치 순서 (한 번만, 약 10분)

### 1. 데이터베이스 만들기
1. Cloudflare 대시보드 → 왼쪽 메뉴 **Storage & Databases → D1**
2. **Create database** → 이름 `ghgp-analytics` → 생성
3. 만들어진 DB의 **Console** 탭에 `schema.sql` 내용을 붙여넣고 실행

### 2. Worker 만들기
1. 왼쪽 메뉴 **Compute (Workers) → Workers & Pages → Create → Start from Hello World**
2. 이름 `ghgp-stats` 로 지정하고 배포
3. **Edit code** 를 눌러 편집기를 열고, 기본 코드를 모두 지운 뒤 `worker.js` 내용을 붙여넣고 **Deploy**

### 3. Worker에 설정값 연결
Worker 화면 → **Settings** 에서:

**Bindings → D1 database**
- Variable name: `DB`  ← 반드시 이 이름
- Database: 1번에서 만든 `ghgp-analytics`

**Variables and Secrets**
| 이름 | 종류 | 값 |
|---|---|---|
| `DASH_PASSWORD` | Secret | 대시보드 로그인 비밀번호 (직접 정하세요) |
| `SECRET` | Secret | 아무 긴 무작위 문자열 (30자 이상 권장) |
| `ALLOW_ORIGIN` | Text | `https://ghgp.replit.app` |

저장 후 **Deploy** 를 한 번 더 눌러 반영합니다.

### 4. 사이트에 집계 코드 켜기
Worker 주소(예: `https://ghgp-stats.○○○.workers.dev`)를 확인한 뒤,
`index.html` · `archive.html` · `reviews.html` 맨 아래 집계 코드의

```js
var ENDPOINT = '';
```

부분을 아래처럼 채웁니다. (Claude에게 Worker 주소를 알려주면 대신 처리합니다.)

```js
var ENDPOINT = 'https://ghgp-stats.○○○.workers.dev/collect';
```

`ENDPOINT` 가 비어 있으면 집계 코드는 아무 일도 하지 않으므로, 설정 전까지 사이트에 아무 영향이 없습니다.

---

## 사용법

- **대시보드 주소**: Worker 주소 그대로 (예: `https://ghgp-stats.○○○.workers.dev`)
- 비밀번호를 넣으면 12시간 동안 로그인이 유지됩니다.
- 검색엔진에 노출되지 않도록 처리돼 있습니다.

### 보이는 항목
- 오늘/기간 방문자·조회수, 일별 방문자 추이 그래프
- 페이지별 조회수 (메인 / 자료실 / 사례&리뷰)
- 유입 경로 (네이버·블로그·숨고·구글·직접 접속 등)
- 버튼·자료 클릭 (전화, 포인트 서비스, 카탈로그·시스템창호 열람, 자료 다운로드, 블로그·숨고 클릭, 견적/거래처 문의, 영상 재생)
- 기기 비율(모바일/PC), 시간대별 방문 분포

### 내 방문을 집계에서 빼기
확인용으로 자주 들어가는 기기에서 `https://ghgp.replit.app/?notrack=1` 을 한 번 열면
그 기기·브라우저의 방문은 이후 집계되지 않습니다. (브라우저 저장소를 지우면 다시 설정해야 합니다.)

---

## 개인정보 처리

- **IP 주소를 저장하지 않습니다.** 방문자 구분용 임시 식별자를 만들 때만 잠깐 쓰이고, 되돌릴 수 없는 해시로 바꾼 뒤 버립니다.
- 이 식별자는 **매일 0시에 초기화**되므로 날짜를 넘겨 같은 사람을 추적할 수 없습니다.
- 방문자에게 쿠키를 심지 않습니다. (관리자 로그인 쿠키만 예외)
- 이름·연락처 등 개인을 특정할 수 있는 정보는 일절 수집하지 않습니다.

## 비용

Cloudflare 무료 요금제 범위 안에서 동작합니다.
(Worker 하루 10만 요청, D1 하루 500만 행 읽기 — 우리 사이트 규모로는 여유가 큽니다.)

## 참고

- Replit Growth 탭의 숫자와는 집계 기준이 달라 값이 조금 다를 수 있습니다. 둘 다 정상입니다.
- 숨고 리뷰 수, 네이버 블로그 조회수처럼 다른 회사 사이트 안의 숫자는 외부에서 가져올 수 없어 이 대시보드에 자동 표시되지 않습니다.
