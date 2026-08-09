// 브라우저 없이 게임 로직·언어 전환·기록 저장을 검증한다.
//
//     npm test
//
// 실제 브라우저를 띄우지 않는 이유: 이 게임에서 깨지기 쉬운 건 렌더링이
// 아니라 상태 전이(idle/running/locked)와 localStorage 왕복이다. jsdom이면
// 그 둘을 시간까지 통제하면서 볼 수 있고 CI에서 몇 초면 끝난다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, "..", "public", "index.html"), "utf8");

const problems = [];
let pass = 0, fail = 0;

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [o] ${name}`); }
  else { fail++; console.log(`  [X] ${name}  ${detail}`); }
}

// 한 세션을 연다. store를 넘기면 이전 세션의 localStorage를 이어받는다.
// locale로 브라우저 언어를 흉내 낸다.
function open({ store = null, locale = "en-US" } = {}) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => problems.push("jsdomError: " + (e.stack || e.message)));
  return new JSDOM(HTML, {
    runScripts: "dangerously",
    url: "https://offby.dev/",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      let t = 0;
      w.performance.now = () => t;              // 시간을 직접 제어한다
      w.__advance = ms => { t += ms; };
      Object.defineProperty(w.navigator, "language", { get: () => locale });
      if (store) for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, v);
      w.addEventListener("error", e => problems.push("window.error: " + (e.error?.stack || e.message)));
    },
  });
}

// 정지 뒤 LOCKOUT(650ms) 동안 패드가 비활성이라 실제 시간으로 기다려야
// 다음 시도가 먹는다. performance.now만 앞으로 돌리면 setTimeout은 안 돈다.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function attempt(dom, errSec) {
  const w = dom.window, d = w.document;
  const target = parseFloat(d.getElementById("target").textContent);
  d.getElementById("pad").click();                 // 시작
  w.__advance((target + errSec) * 1000);
  d.getElementById("pad").click();                 // 정지
  // 판정 문구는 락아웃이 끝나면 안내 문구로 덮인다. 지금 잡아 둔다.
  const verdict = d.getElementById("verdict").textContent;
  await sleep(750);
  return { target, verdict };
}

const dump = w => ({ "offby/v1": w.localStorage.getItem("offby/v1") });

console.log("=".repeat(68));
console.log("세션 1 — 영어 기본 + 정수 목표");
console.log("=".repeat(68));

let dom = open();
let w = dom.window, d = w.document;

check("기본 언어 영어", d.documentElement.lang === "en", d.documentElement.lang);
check("라벨이 영어", d.getElementById("t-kicker").textContent === "Target time",
      d.getElementById("t-kicker").textContent);
check("버튼 Start", d.getElementById("pad").textContent === "Start",
      d.getElementById("pad").textContent);
check("초기 안내 문구", d.getElementById("verdict").textContent.includes("Press space"),
      d.getElementById("verdict").textContent);

const t0 = parseFloat(d.getElementById("target").textContent);
check("목표가 정수", Number.isInteger(t0), String(t0));
check("목표 범위 2~9", t0 >= 2 && t0 <= 9, String(t0));
check("단위 s", d.getElementById("t-unit").textContent === "s",
      d.getElementById("t-unit").textContent);

// 목표가 20회 연속 정수이고 매번 달라지는지
const seen = new Set([t0]);
let allInt = true, noRepeat = true, prev = t0;
for (let i = 0; i < 20; i++) {
  const r = await attempt(dom, 0.4);
  const nx = parseFloat(d.getElementById("target").textContent);
  if (!Number.isInteger(nx) || nx < 2 || nx > 9) allInt = false;
  if (nx === prev) noRepeat = false;
  seen.add(nx); prev = nx;
}
check("20회 모두 정수 2~9", allInt);
check("같은 목표가 연속으로 안 나옴", noRepeat);
check("목표가 여러 종류 나옴", seen.size >= 4, `${seen.size}종`);

console.log("");
console.log("=".repeat(68));
console.log("세션 2 — 판정 / 통계");
console.log("=".repeat(68));

dom = open(); w = dom.window; d = w.document;

const a1 = await attempt(dom, 0.010);
check("등급 Perfect", a1.verdict.includes("Perfect"), a1.verdict);
check("오차 +0.010s late", a1.verdict.includes("+0.010") && a1.verdict.includes("late"), a1.verdict);
check("시도 1", d.getElementById("s-count").textContent === "1");
check("최고 0.010", d.getElementById("s-best").textContent === "0.010",
      d.getElementById("s-best").textContent);
check("연속 적중 1", d.getElementById("s-streak").textContent === "1");
check("락아웃 뒤 안내 복귀", d.getElementById("verdict").textContent.includes("Press space"),
      d.getElementById("verdict").textContent);

const a2 = await attempt(dom, -0.400);
check("등급 Off", a2.verdict.includes("Off"), a2.verdict);
check("빠르면 early", a2.verdict.includes("early"), a2.verdict);
check("연속 적중 끊김", d.getElementById("s-streak").textContent === "0");
check("최고 기록은 유지", d.getElementById("s-best").textContent === "0.010");
check("차트 마크 2개", d.querySelectorAll("#strip .mark").length === 2,
      String(d.querySelectorAll("#strip .mark").length));

await attempt(dom, 0.05);
check("편향 문구 표시", d.getElementById("bias").textContent.length > 0,
      `"${d.getElementById("bias").textContent}"`);
check("편향 문구가 영어", /press|lean/i.test(d.getElementById("bias").textContent),
      d.getElementById("bias").textContent);

console.log("");
console.log("=".repeat(68));
console.log("세션 3 — 언어 전환");
console.log("=".repeat(68));

d.getElementById("lang").click();
check("전환 후 lang=ko", d.documentElement.lang === "ko", d.documentElement.lang);
check("라벨 한국어", d.getElementById("t-kicker").textContent === "목표 시간",
      d.getElementById("t-kicker").textContent);
check("버튼 한국어", d.getElementById("pad").textContent === "시작",
      d.getElementById("pad").textContent);
check("단위 초", d.getElementById("t-unit").textContent === "초");
check("단위가 목표 옆에 유지됨", d.getElementById("target").textContent.endsWith("초"),
      d.getElementById("target").textContent);
check("편향 문구도 한국어", d.getElementById("bias").textContent.includes("누릅니다"),
      d.getElementById("bias").textContent);
check("통계는 그대로", d.getElementById("s-count").textContent === "3",
      d.getElementById("s-count").textContent);

const ko = await attempt(dom, 0.02);
check("한국어 판정 문구", ko.verdict.includes("완벽") && ko.verdict.includes("늦음"), ko.verdict);

d.getElementById("lang").click();
check("영어로 되돌아옴", d.documentElement.lang === "en");

console.log("");
console.log("=".repeat(68));
console.log("세션 4 — 저장 / 복원");
console.log("=".repeat(68));

const saved = dump(w);
const parsed = JSON.parse(saved["offby/v1"] || "{}");
check("저장됨", !!saved["offby/v1"]);
check("저장 구조 v=1", parsed.v === 1);
check("기록 4개", Array.isArray(parsed.results) && parsed.results.length === 4,
      JSON.stringify(parsed.results?.length));
check("언어도 저장", parsed.lang === "en", String(parsed.lang));

dom = open({ store: saved }); w = dom.window; d = w.document;
check("시도 복원 4", d.getElementById("s-count").textContent === "4",
      d.getElementById("s-count").textContent);
check("최고 복원 0.010", d.getElementById("s-best").textContent === "0.010",
      d.getElementById("s-best").textContent);
check("차트 복원 4개", d.querySelectorAll("#strip .mark").length === 4,
      String(d.querySelectorAll("#strip .mark").length));
check("저장된 언어 복원", d.documentElement.lang === "en");

// 한국어를 저장해 두면 브라우저가 영어여도 한국어로 열려야 한다
const koStore = { "offby/v1": JSON.stringify({ ...parsed, lang: "ko" }) };
const koDom = open({ store: koStore, locale: "en-US" });
check("저장된 ko가 브라우저 언어를 이김", koDom.window.document.documentElement.lang === "ko",
      koDom.window.document.documentElement.lang);

// 저장이 없으면 브라우저 언어를 따른다
const krBrowser = open({ locale: "ko-KR" });
check("한국어 브라우저는 한국어로 열림", krBrowser.window.document.documentElement.lang === "ko",
      krBrowser.window.document.documentElement.lang);

console.log("");
console.log("=".repeat(68));
console.log("세션 5 — 지우기 / 예외 상황");
console.log("=".repeat(68));

d.getElementById("reset").click();
check("지운 뒤 시도 0", d.getElementById("s-count").textContent === "0");
check("지운 뒤 최고 —", d.getElementById("s-best").textContent === "—");
check("지운 뒤 마크 0개", d.querySelectorAll("#strip .mark").length === 0);
check("localStorage도 비움", w.localStorage.getItem("offby/v1") === null);

const broken = open({ store: { "offby/v1": "{{{ 깨진 JSON" } });
check("손상된 저장값에도 안 죽음",
      broken.window.document.getElementById("s-count").textContent === "0");

// localStorage를 아예 못 쓰는 환경(사파리 프라이빗 등)
const vc2 = new VirtualConsole();
const blocked = new JSDOM(HTML, {
  runScripts: "dangerously", url: "https://offby.dev/", pretendToBeVisual: true,
  virtualConsole: vc2,
  beforeParse(w2) {
    let t = 0;
    w2.performance.now = () => t;
    w2.__advance = ms => { t += ms; };
    Object.defineProperty(w2, "localStorage", {
      get() { throw new Error("SecurityError: localStorage 차단됨"); }
    });
    w2.addEventListener("error", e => problems.push("blocked: " + (e.error?.stack || e.message)));
  },
});
const bd = blocked.window.document;
bd.getElementById("pad").click();
blocked.window.__advance(3000);
bd.getElementById("pad").click();
check("localStorage 차단돼도 플레이 가능", bd.getElementById("s-count").textContent === "1",
      bd.getElementById("s-count").textContent);
bd.getElementById("lang").click();
check("차단 환경에서도 언어 전환 가능", bd.documentElement.lang === "ko",
      bd.documentElement.lang);

console.log("");
console.log("=".repeat(68));
console.log(`런타임 오류: ${problems.length ? "\n  " + problems.join("\n  ") : "없음"}`);
console.log(`통과 ${pass} / 실패 ${fail}`);
console.log("=".repeat(68));
process.exit(fail || problems.length ? 1 : 0);
