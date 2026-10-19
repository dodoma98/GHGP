/* 견적서 받기(quote.html) 전용 PWA 설치용 최소 서비스워커.
   캐시는 하지 않는다 — 가견적서는 항상 최신 서버 응답을 봐야 한다.
   크롬/안드로이드의 "홈 화면에 추가" 설치 조건(서비스워커 등록) 을 채우기 위한 자리다. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // 응답을 가로채지 않는다 — 네트워크 그대로
