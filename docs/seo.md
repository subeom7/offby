# SEO 운영 체크리스트

코드로 보장할 수 있는 항목은 저장소에 넣고 `npm test`로 검증한다. 도메인 설정과
검색엔진 소유권 확인은 배포 계정이 필요하므로 아래 절차를 배포 뒤 한 번 진행한다.

## 현재 URL·언어 정책

- canonical 홈페이지는 `https://offby.dev/` 하나다.
- 루트의 검색용 정적 HTML은 영어다.
- 한국어 버튼은 같은 URL의 UI를 바꾸는 기능이다. `/ko/` 페이지가 생기기 전에는
  한국어 URL이나 `hreflang`을 선언하지 않는다.
- 리더보드나 별도 설명 페이지를 공개할 때만 해당 canonical URL을 sitemap에 넣는다.

## Cloudflare

1. Redirect Rule 또는 **Always Use HTTPS**로 모든 `http://offby.dev/*` 요청을
   같은 경로의 `https://offby.dev/*`로 301 또는 308 리디렉션한다.
2. `https://www.offby.dev/*`가 `https://offby.dev/*`로 영구 리디렉션되는지 확인한다.
3. `/index.html`이 `/`로 301 리디렉션되는지 확인한다. 저장소의 `_redirects`가
   이 경로 규칙을 담당한다.
4. 위 리디렉션이 안정적으로 동작한 뒤에만 HSTS 적용을 검토한다.

Workers Static Assets의 `_redirects`는 경로 리디렉션용이다. HTTP→HTTPS와
www→apex 같은 도메인 규칙은 Cloudflare 대시보드에서 관리한다.

## 검색엔진 등록

1. Google Search Console에 Domain property `offby.dev`를 DNS로 확인한다.
2. `https://offby.dev/sitemap.xml`을 제출한다.
3. URL 검사에서 `https://offby.dev/`의 live test를 실행하고 색인을 요청한다.
4. Bing Webmaster Tools에도 같은 sitemap을 제출한다.

인증 토큰은 저장소에 커밋하지 않는다. HTML 태그 방식으로 소유권을 확인해야 한다면
검색엔진이 발급한 실제 값만 `index.html`에 추가한다.

## 배포 스모크 테스트

- `/`, `/robots.txt`, `/sitemap.xml`, `/favicon.svg`, `/og.png`가 `200`인지 확인한다.
- `/index.html`, HTTP, www 변형이 한 번의 영구 리디렉션으로 canonical URL에 도달하는지 확인한다.
- 루트 HTML에 `noindex` 또는 `X-Robots-Tag: noindex`가 없는지 확인한다.
- Search Console에서 색인 상태와 sitemap 오류를 주기적으로 확인한다.
