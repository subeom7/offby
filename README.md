# offby

[offby.dev](https://offby.dev)

목표 시간(2~9초)이 뜨면 시작을 누르고, 그만큼 지났다 싶을 때 다시 누른다.
진행 중에는 시간을 보여주지 않는다. 얼마나 빗나갔는지가 기록계처럼 쌓인다.

이름은 게임의 출력에서 왔다 — `+0.008s late`. **얼마나 off by 인가**가
이 게임이 답하는 전부다.

혼자 치는 **연습**, 연속 10회로 순위를 겨루는 **기록 도전**, 다 같이
같은 목표를 받아 동시에 시작하는 **방** — 셋이 한 장의 HTML 안에 있다.
번들러는 여전히 없다.

```
npm test        # 게임 · 화면 · SEO · 워커 · 방  (jsdom + 노드, 브라우저 불필요)
npm run dev     # http://localhost:5173   정적만. 연습 모드가 그대로 돈다
npm run dev:api # 전체 (API·방). wrangler라 Node 22가 필요하다
npm run fonts   # 폰트 서브셋 다시 만들기 (문구를 고쳤을 때)
npm run og      # og:image 다시 만들기
```

---

## 왜 엣지인가

게임 자체는 클라이언트에서 끝난다. 서버가 하는 일은 순위를 보관하고
방의 라운드를 여는 것뿐이라, 항상 켜져 있는 VM이 할 일이 아니다.

그래서 **Cloudflare Workers**에 올린다. 정적 자산은 엣지에서 그대로
나가고, `/api/*`와 방 URL만 워커를 탄다. 트래픽이
몰려도 엣지가 받아내고, 비용은 0이고, 관리할 서버가 없다. 링크 하나가
퍼져서 동시 접속이 튀는 게 이 게임의 성공 시나리오인데, 그 시나리오에서
단일 인스턴스는 가장 나쁜 선택이다.

| | 단일 VM | Cloudflare Workers |
|---|---|---|
| 월 비용 | ~$21 | 0 |
| 동시 접속 급증 | 코어 수만큼 버티다 죽음 | 엣지에서 분산 |
| 배포 | 컨테이너·인증서·프로세스 | git push |
| 실시간 방 | 프로세스에 상태를 이고 있음 | Durable Object 하나 = 방 하나 |

무료 티어 안에 들어가는 게 설계 제약이다. 특히 **WebSocket 메시지 하나가
DO 요청 하나로 과금**돼서(하루 10만), 방 프로토콜은 라운드당 1인 3메시지를
넘기지 않게 짰다 — [docs/multiplayer.md](docs/multiplayer.md).

## 목표는 정수 초만 나온다

2~9초 중 하나다. 소수점 목표(4.7초)는 숫자를 *읽고 재현하는* 과제가 되지만,
정수는 몸에 익은 단위라 순수하게 감각만 겨루게 된다.

부수 효과가 하나 더 있다. 목표가 8종류뿐이라 **기록을 서로 비교할 수 있다.**
소수점이었다면 난이도가 제각각이라 리더보드가 성립하지 않는다.

## 언어

기본은 영어, 한국어 브라우저면 한국어로 열린다. 하단에서 언제든 바꿀 수 있고
선택은 저장된다. 우선순위는 `저장된 선택 > 브라우저 언어 > 영어`다.

## 폰트: 문자 체계별로 나눠서 직접 호스팅

원본은 Google Fonts CDN을 참조했다. 그러면 첫 렌더가 외부 왕복만큼 늦고,
방문자 IP가 구글로 넘어가고, 그쪽 장애에 같이 묶인다. 정적 사이트라
폰트를 함께 배포해도 비용이 0이다.

문제는 한글 폰트 용량이다. IBM Plex Sans KR은 웨이트당 2.7MB다. 그런데 이
페이지가 쓰는 한글은 74자뿐이라, 쓰는 글자만 남기면 22KB가 된다.

여기에 더해 **기본 언어가 영어라 대부분의 방문자는 한글을 한 글자도 그리지
않는다.** 그런데 한 폰트가 라틴과 한글을 모두 담고 있으면 영어만 표시해도
브라우저가 그 파일을 받아 온다. 그래서 문자 체계별로 자르고 `unicode-range`를
걸었다. 브라우저가 글자마다 맞는 파일만 받아 간다.

```
              원본        서브셋
Azeret Mono   104KB  ->  14.5KB   라틴 (가변 1개로 400/500/700)
Plex Sans     525KB  ->  30.1KB   라틴 (가변)
Plex KR x3    8.1MB  ->  85.5KB   한글 전용, unicode-range로 지연 로드
              ─────────────────
영어 사용자                45KB
한국어로 바꾸면          +86KB
```

글자 목록은 손으로 적지 않는다. `tools/build_fonts.py`가 `index.html`에서
직접 뽑아 문자 체계별로 나누므로, 문구를 고치고 `npm run fonts`를 다시
돌리면 알아서 맞춰진다.

세 폰트 모두 SIL Open Font License다. 라이선스 전문을 `public/fonts/`에
함께 배포한다.

## 캐시

파일명에 내용 해시가 들어간다(`IBMPlexSansKR-Regular.aabf6dc5.woff2`).
내용이 바뀌면 URL이 바뀌므로 영구 캐시가 안전하다.

```
/fonts/*.woff2   max-age=31536000, immutable
/index.html      max-age=0, must-revalidate   (새 폰트 URL을 알려주는 쪽)
```

해시가 없으면 반대 문제가 생긴다. 문구를 고쳐 서브셋이 바뀌어도 파일명이
같아서 브라우저가 옛 폰트를 계속 쓰고, 새로 추가된 글자가 두부로 뜬다.

## 기록 저장

`localStorage`에 남는다. 새로고침해도 누적 시도 횟수와 최고 정확도가 이어진다.

- 저장: 최근 500회의 오차, 누적 시도 횟수, 역대 최고 정확도, 연속 적중, 언어
- 오차 배열만 자르는 이유: 차트와 평균에만 쓰여서 그 이상은 의미가 없다.
  반면 누적 횟수와 최고 기록은 잘리면 안 되므로 따로 센다.
- 사파리 프라이빗 모드처럼 `localStorage`가 막힌 환경에서는 저장만 조용히
  건너뛰고 게임은 그대로 돌아간다. 손상된 저장값도 무시하고 새로 시작한다.

## 구조

```
public/
  index.html          게임 전체 (외부 의존성 없음)
  fonts/              서브셋한 woff2 + OFL 라이선스
  og.png              링크 공유용 이미지
  favicon.svg         검색 결과와 브라우저 탭 아이콘
  robots.txt          크롤링 정책 + sitemap 위치
  sitemap.xml         검색엔진에 제출할 canonical URL 목록
  _headers            캐시 정책
  _redirects          중복 HTML 경로 영구 리디렉션
src/
  worker.js           /api/* 라우팅. 나머지는 그대로 ASSETS로 넘어간다
  room.js             방 하나 = Durable Object 하나 (WebSocket Hibernation)
  schema.sql          D1 스키마
  lib/
    run.js            런 발급·검증 (목표 서명, 벽시계 하한, 사람의 한계)
    board.js          순위 쿼리 + 캐시 + 보관 정리
    room-logic.js     라운드 판정·점수·도착창 (순수 함수)
    sign.js           HMAC (WebCrypto만 — 노드에서도 그대로 돈다)
    ids.js            방 코드·닉네임 정제·플레이어 해시
tools/
  build_fonts.py      폰트 다운로드 + 문자 체계별 서브셋 + 해시 파일명
  build_og.py         og:image 생성 (게임과 같은 색·폰트)
  check_assets.py     폰트 글리프 커버리지 · og 크기 검사
test/
  game.test.mjs       솔로 게임이 예전 그대로인가 (49)
  client.test.mjs     모드 전환·기록 도전·순위표·방 화면 (76)
  seo.test.mjs        메타·본문·JSON-LD·robots·sitemap 계약 (55)
  worker.test.mjs     서명·런 검증·순위 쿼리·라운드 판정 (90)
  room.test.mjs       방 상태 전이 (53)
  stub/               cloudflare:workers 대역 — 워커 런타임 없이 Room을 돌린다
docs/
  leaderboard.md      순위 기준과 부정 방지 — 계획에서 뒤집힌 지점 포함
  multiplayer.md      동시 시작·도착창·DO 수명
  seo.md              배포 뒤 검색엔진 등록·점검 체크리스트
```

## 테스트

브라우저를 띄우지 않는다. 이 게임에서 깨지기 쉬운 건 렌더링이 아니라
**상태 전이**(idle → running → locked)와 **localStorage 왕복**이라,
jsdom에서 `performance.now()`를 직접 통제하며 보는 편이 빠르고 정확하다.

검증하는 것: 목표가 정수 2~9인지, 같은 목표가 연속으로 안 나오는지,
판정 등급 경계, 연속 적중이 끊기는 조건, 차트 마크 개수, 언어 전환 후
문구·통계 유지, 새로고침 후 복원, 저장된 언어가 브라우저 언어를 이기는지,
기록 지우기, 손상된 저장값, `localStorage` 차단 환경.

SEO 테스트는 title/description/canonical과 공유 메타의 일치, 정적 h1·게임 설명,
WebSite JSON-LD, 실제 OG 이미지 크기, favicon, robots와 sitemap의 연결, sitemap의
동일 출처 URL과 `/index.html` 영구 리디렉션을 검증한다.

서버 쪽도 같은 방식이다. `src/lib/*`는 WebCrypto만 쓰므로 노드에서 그대로
import된다 — 서명 위조, 목표 바꿔치기, 벽시계 하한, 도착창을 워커를 띄우지
않고 본다. 방은 `cloudflare:workers`를 대역으로 돌려(`test/stub/`) Room을
노드에서 통째로 돌린다. **wrangler가 Node 22를 요구하는데 CI는 20**이기도
하고, 어차피 여기서 깨지기 쉬운 건 바인딩이 아니라 순서다 — 누가 방장인가,
나간 사람을 기다리다 라운드가 멈추지 않는가, 마감에 안 낸 사람이 DNF가 되는가.

화면 테스트는 `fetch`와 `WebSocket`을 대역으로 넣는다. 물어보는 건 네트워크가
아니라 **서버 응답에 화면이 어떻게 반응하는가**이고, 특히 **서버가 없을 때
연습 모드로 조용히 떨어지는지**를 본다. 문구가 배로 늘어난 변경이라 en/ko
키 커버리지도 통째로 비교한다 — 한쪽에만 키를 추가하는 실수는 화면을 다
눌러 보기 전엔 안 드러난다.

락아웃(650ms) 때문에 판정 문구는 곧 안내 문구로 덮인다. 테스트는 정지
직후 값을 잡아 둔다 — 이걸 놓치면 "등급이 안 나온다"고 오해하기 쉽다.

CI는 테스트에 더해 **폰트와 og:image가 최신인지** 확인한다. 문구를 고치고
`npm run fonts`를 잊으면 서브셋에 없는 글자가 두부로 뜨는데, 브라우저에서
눈으로 보기 전까지 아무도 모른다. 다시 만들어 커밋된 것과 다르면 실패시킨다
(두 생성기 모두 출력이 결정론적이라 성립한다).

## 배포

Cloudflare Workers에 저장소를 연결한다. 설정은 `wrangler.jsonc`가 들고 있다.

| 설정 | 값 |
|---|---|
| Build command | `npm ci` |
| Deploy command | `npx wrangler deploy` |

`main`에 push하면 배포된다.

Pages가 아니라 Workers를 고른 게 여기서 값을 했다. 리더보드와 방을 붙이면서
`wrangler.jsonc`에 `main`과 바인딩만 더했고 **정적 사이트 구조는 하나도 안
바꿨다.** 정적 자산은 그대로 엣지에서 나가고 `/api/*`만 워커를 탄다.

처음 배포 전에 계정 쪽 준비가 세 줄 필요하다.

```
npx wrangler d1 create offby                              # 나온 id를 wrangler.jsonc에
npx wrangler d1 execute offby --file=src/schema.sql --remote
npx wrangler secret put RUN_SECRET                        # 긴 랜덤 문자열
```

이게 없으면 `/api/*`가 503(`unconfigured`)을 낸다. 클라이언트는 그걸 보고
연습 모드로 떨어지므로, **설정이 덜 돼도 게임은 열린다.**

wrangler 4는 Node 22 이상을 요구한다. `.node-version`으로 빌드 환경에
고정해 뒀다. 로컬 Node가 20이면 `npm test`는 되지만 `npx wrangler`는 안 된다
— 배포는 Cloudflare가 하므로 문제되지 않는다.

## 순위와 방

두 문서가 설계의 이유를 들고 있다.

[docs/leaderboard.md](docs/leaderboard.md) — 순위는 연속 10회의 평균으로
매긴다(단발 최고 기록은 운으로 나온다). 계획에서 한 군데가 뒤집혔는데,
**시도마다 목표를 발급하는 구조를 버린 것**이 그것이다 — 목표는 어차피 매
시도 전에 화면에 뜨므로 봇에게는 아무 차이가 없고, 대신 650ms 락아웃 안에
네트워크가 끼어 게임이 끊긴다. 실제로 막는 건 벽시계 하한과 사람의 한계
필터다.

[docs/multiplayer.md](docs/multiplayer.md) — **동시 시작에 정밀한 시계
동기화는 필요 없다.** 각자의 오차는 자기 기기의 `performance.now()` 차이로
재므로 시계가 어긋나도 점수는 공정하다. 동기화는 순전히 카운트다운을 같이
보기 위한 것이라 ±50ms면 충분하고, 그래서 입장할 때 ping 다섯 번으로 끝난다.

## 다음

- `HUMAN_FLOOR`(사람이 낼 수 있는 평균오차의 하한)를 실측으로 정하기.
  지금 값에는 근거가 없어서, 걸린 런을 버리지 않고 `flagged`로 쌓아 두고 있다.
- 방 성적은 아직 글로벌 순위와 분리돼 있다. 친구끼리 짜고 치는 경로를
  막으려는 것인데, 방 쪽이 서버가 라운드를 열어 검증이 더 강하다는 점에서
  다시 볼 여지가 있다.
