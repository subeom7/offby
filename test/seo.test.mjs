// 검색 노출에 필요한 정적 계약을 브라우저나 네트워크 없이 검증한다.
// 배포 뒤 리디렉션과 Content-Type은 별도 스모크 테스트가 필요하지만, 이 파일은
// 메타데이터·본문·구조화 데이터·robots·sitemap이 서로 어긋나는 실수를 막는다.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PUBLIC = join(ROOT, "public");
const HTML = readFileSync(join(PUBLIC, "index.html"), "utf8");
const ROBOTS = readFileSync(join(PUBLIC, "robots.txt"), "utf8");
const SITEMAP = readFileSync(join(PUBLIC, "sitemap.xml"), "utf8");
const CANONICAL = "https://offby.dev/";

let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  [o] ${name}`);
  } else {
    fail++;
    console.log(`  [X] ${name}${detail ? `  ${detail}` : ""}`);
  }
}

function valueOf(nodes, name, attribute = "content") {
  check(`${name} 1개`, nodes.length === 1, `${nodes.length}개`);
  if (attribute === "textContent") return nodes[0]?.textContent.trim() || "";
  return nodes[0]?.getAttribute(attribute)?.trim() || "";
}

function parseUrl(urlString, base) {
  try {
    return new URL(urlString, base);
  } catch {
    return null;
  }
}

function localFile(url) {
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  return relative.endsWith("/") || !relative
    ? join(PUBLIC, relative, "index.html")
    : join(PUBLIC, relative);
}

console.log("=".repeat(68));
console.log("SEO — 문서와 메타데이터");
console.log("=".repeat(68));

const dom = new JSDOM(HTML, { url: CANONICAL });
const document = dom.window.document;

check("HTML5 doctype", document.doctype?.name.toLowerCase() === "html");
check("기본 언어 en", document.documentElement.lang === "en", document.documentElement.lang);
check("main 1개", document.querySelectorAll("main").length === 1);
check("h1 1개", document.querySelectorAll("h1").length === 1);
check("h1 정적 문구", document.querySelector("h1")?.textContent.trim() === "Precision timer");

const title = valueOf(document.querySelectorAll("title"), "title", "textContent");
const description = valueOf(document.querySelectorAll('meta[name="description"]'), "description");
const canonical = valueOf(document.querySelectorAll('link[rel="canonical"]'), "canonical", "href");

check("title 길이 30–60자", title.length >= 30 && title.length <= 60, `${title.length}자`);
check("description 길이 120–160자", description.length >= 120 && description.length <= 160,
  `${description.length}자`);
check("canonical 고정", canonical === CANONICAL, canonical);
check("noindex 없음", ![...document.querySelectorAll('meta[name="robots"]')]
  .some(node => /(?:^|,)\s*noindex\b/i.test(node.content)));

const aboutTitle = document.getElementById("t-about-title")?.textContent.trim() || "";
const aboutCopy = document.getElementById("t-about-copy")?.textContent.trim() || "";
check("설명 섹션 제목이 정적 HTML에 있음", aboutTitle.length > 0);
check("플레이 방법이 정적 HTML에 있음", aboutCopy.length >= 120, `${aboutCopy.length}자`);
check("게임 핵심 범위 2–9초 설명", /2 to 9 seconds/.test(aboutCopy));

const ogTitle = valueOf(document.querySelectorAll('meta[property="og:title"]'), "og:title");
const ogDescription = valueOf(document.querySelectorAll('meta[property="og:description"]'), "og:description");
const ogUrl = valueOf(document.querySelectorAll('meta[property="og:url"]'), "og:url");
const ogImage = valueOf(document.querySelectorAll('meta[property="og:image"]'), "og:image");
const ogImageUrl = parseUrl(ogImage);
const ogImageFile = ogImageUrl ? localFile(ogImageUrl) : "";
check("OG title 일치", ogTitle === title);
check("OG description 일치", ogDescription === description);
check("OG URL 일치", ogUrl === canonical);
check("OG image HTTPS", ogImageUrl?.protocol === "https:");
check("OG image 동일 origin", ogImageUrl?.origin === new URL(canonical).origin);
check("OG image 파일 존재", Boolean(ogImageFile) && existsSync(ogImageFile), ogImageFile);

const png = ogImageFile && existsSync(ogImageFile) ? readFileSync(ogImageFile) : Buffer.alloc(24);
check("OG image가 PNG", png.length >= 24
  && png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a");
const declaredWidth = Number(valueOf(document.querySelectorAll('meta[property="og:image:width"]'), "og:image:width"));
const declaredHeight = Number(valueOf(document.querySelectorAll('meta[property="og:image:height"]'), "og:image:height"));
check("OG image 실제 크기 일치", declaredWidth === png.readUInt32BE(16)
  && declaredHeight === png.readUInt32BE(20), `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
check("OG image 대체 텍스트", valueOf(
  document.querySelectorAll('meta[property="og:image:alt"]'), "og:image:alt").length > 0);

check("Twitter card", valueOf(document.querySelectorAll('meta[name="twitter:card"]'),
  "twitter:card") === "summary_large_image");
check("Twitter title 일치", valueOf(document.querySelectorAll('meta[name="twitter:title"]'),
  "twitter:title") === title);
check("Twitter description 일치", valueOf(
  document.querySelectorAll('meta[name="twitter:description"]'), "twitter:description") === description);
check("Twitter image 일치", valueOf(document.querySelectorAll('meta[name="twitter:image"]'),
  "twitter:image") === ogImage);

const favicon = valueOf(document.querySelectorAll('link[rel~="icon"]'), "favicon", "href");
const faviconUrl = parseUrl(favicon, canonical);
check("favicon이 크롤 가능한 파일", favicon.startsWith("/") && Boolean(faviconUrl)
  && faviconUrl.origin === new URL(canonical).origin && existsSync(localFile(faviconUrl)));

console.log("");
console.log("=".repeat(68));
console.log("SEO — 구조화 데이터");
console.log("=".repeat(68));

const jsonLd = [];
for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
  try {
    jsonLd.push(JSON.parse(script.textContent));
    check("JSON-LD 파싱", true);
  } catch (error) {
    check("JSON-LD 파싱", false, error.message);
  }
}
const website = jsonLd.find(item => item["@type"] === "WebSite");
check("WebSite JSON-LD 존재", Boolean(website));
check("WebSite 이름", website?.name === "offby", website?.name);
check("WebSite URL 일치", website?.url === canonical, website?.url);
check("WebSite 영어 지원", website?.inLanguage?.includes("en"));

console.log("");
console.log("=".repeat(68));
console.log("SEO — robots.txt와 sitemap.xml");
console.log("=".repeat(68));

check("robots가 루트 크롤을 차단하지 않음", !/^\s*Disallow:\s*\/\s*$/mi.test(ROBOTS));
const sitemapDirective = ROBOTS.match(/^\s*Sitemap:\s*(\S+)\s*$/mi)?.[1] || "";
check("robots sitemap 절대 URL", sitemapDirective === `${CANONICAL}sitemap.xml`, sitemapDirective);

const sitemapDom = new JSDOM(SITEMAP, { contentType: "text/xml" });
const sitemapDocument = sitemapDom.window.document;
check("sitemap XML 파싱", !sitemapDocument.querySelector("parsererror"));
const locations = [...sitemapDocument.querySelectorAll("loc")]
  .map(node => node.textContent.trim());
check("sitemap URL 중복 없음", new Set(locations).size === locations.length);
check("canonical이 sitemap에 있음", locations.includes(canonical));
for (const location of locations) {
  const url = parseUrl(location);
  const file = url ? localFile(url) : "";
  check(`sitemap HTTPS: ${location}`, url?.protocol === "https:");
  check(`sitemap 동일 origin: ${location}`, url?.origin === new URL(canonical).origin);
  check(`sitemap 파일 존재: ${location}`, Boolean(file) && existsSync(file), file);
}

const redirects = readFileSync(join(PUBLIC, "_redirects"), "utf8");
check("/index.html 영구 리디렉션", /^\/index\.html\s+\/\s+301\s*$/m.test(redirects));

console.log("");
console.log("=".repeat(68));
console.log(`통과 ${pass} / 실패 ${fail}`);
console.log("=".repeat(68));

dom.window.close();
sitemapDom.window.close();
if (fail) process.exit(1);
