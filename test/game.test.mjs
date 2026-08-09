// 브라우저 없이 게임 로직과 기록 저장을 검증한다.
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
function open(store) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => problems.push("jsdomError: " + (e.stack || e.message)));
  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    url: "https://timing.example/",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      let t = 0;
      w.performance.now = () => t;              // 시간을 직접 제어한다
      w.__advance = ms => { t += ms; };
      if (store) for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, v);
      w.addEventListener("error", e => problems.push("window.error: " + (e.error?.stack || e.message)));
    },
  });
  return dom;
}

// 목표에 대해 오차 errSec 만큼 어긋나게 한 번 시도한다.
// stop() 뒤 LOCKOUT(650ms) 동안 패드가 비활성이라 실제 시간으로 기다려야
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
  await sleep(750);                                // 락아웃 해제 대기
  return { target, verdict };
}

const dumpStore = w => ({ "timing-game/v1": w.localStorage.getItem("timing-game/v1") });

console.log("=".repeat(66));
console.log("세션 1 — 기록 남기기");
console.log("=".repeat(66));

let dom = open(null);
let w = dom.window, d = w.document;

check("초기 시도 0", d.getElementById("s-count").textContent === "0");
check("초기 최고기록 —", d.getElementById("s-best").textContent === "—");
check("빈 상태 안내 보임", d.getElementById("empty").style.display !== "none");

const first = await attempt(dom, 0.010);   // 완벽
check("1회 후 시도=1", d.getElementById("s-count").textContent === "1",
      `실제 ${d.getElementById("s-count").textContent}`);
check("등급 '완벽'", first.verdict.includes("완벽"), first.verdict);
check("오차 표기 +0.010초 늦음", first.verdict.includes("+0.010") && first.verdict.includes("늦음"),
      first.verdict);
check("락아웃 뒤 안내 문구 복귀", d.getElementById("verdict").textContent.includes("스페이스"),
      d.getElementById("verdict").textContent);
check("최고 정확도 0.010", d.getElementById("s-best").textContent === "0.010",
      d.getElementById("s-best").textContent);
check("연속 적중 1", d.getElementById("s-streak").textContent === "1");

await attempt(dom, 0.050);   // 정밀 -> streak 유지
await attempt(dom, -0.400);  // 빗나감 -> streak 끊김
check("3회 후 시도=3", d.getElementById("s-count").textContent === "3",
      d.getElementById("s-count").textContent);
check("streak 끊김(0)", d.getElementById("s-streak").textContent === "0",
      d.getElementById("s-streak").textContent);
check("최고기록은 유지 0.010", d.getElementById("s-best").textContent === "0.010",
      d.getElementById("s-best").textContent);
check("차트 마크 3개", d.querySelectorAll("#strip .mark").length === 3,
      String(d.querySelectorAll("#strip .mark").length));
check("빈 상태 숨김", d.getElementById("empty").style.display === "none");
check("편향 문구 표시", d.getElementById("bias").textContent.length > 0,
      `"${d.getElementById("bias").textContent}"`);

const saved = dumpStore(w);
check("localStorage에 저장됨", !!saved["timing-game/v1"]);
const parsed = JSON.parse(saved["timing-game/v1"] || "{}");
check("저장 구조 v=1", parsed.v === 1);
check("저장된 기록 3개", Array.isArray(parsed.results) && parsed.results.length === 3,
      JSON.stringify(parsed.results));
check("저장된 total=3", parsed.total === 3, String(parsed.total));

console.log("");
console.log("=".repeat(66));
console.log("세션 2 — 새로고침 후 복원");
console.log("=".repeat(66));

dom = open(saved);
w = dom.window; d = w.document;

check("시도 복원 3", d.getElementById("s-count").textContent === "3",
      d.getElementById("s-count").textContent);
check("최고기록 복원 0.010", d.getElementById("s-best").textContent === "0.010",
      d.getElementById("s-best").textContent);
check("streak 복원 0", d.getElementById("s-streak").textContent === "0");
check("차트 마크 복원 3개", d.querySelectorAll("#strip .mark").length === 3,
      String(d.querySelectorAll("#strip .mark").length));
check("빈 상태 숨김 유지", d.getElementById("empty").style.display === "none");

await attempt(dom, 0.005);
check("이어서 4회째", d.getElementById("s-count").textContent === "4",
      d.getElementById("s-count").textContent);
check("최고기록 갱신 0.005", d.getElementById("s-best").textContent === "0.005",
      d.getElementById("s-best").textContent);

console.log("");
console.log("=".repeat(66));
console.log("세션 3 — 기록 지우기 / 예외 상황");
console.log("=".repeat(66));

d.getElementById("reset").click();
check("지운 뒤 시도 0", d.getElementById("s-count").textContent === "0");
check("지운 뒤 최고기록 —", d.getElementById("s-best").textContent === "—");
check("지운 뒤 마크 0개", d.querySelectorAll("#strip .mark").length === 0);
check("localStorage도 비움", w.localStorage.getItem("timing-game/v1") === null);

// 손상된 저장값
dom = open({ "timing-game/v1": "{{{ 깨진 JSON" });
check("손상된 저장값에도 안 죽음", dom.window.document.getElementById("s-count").textContent === "0");

// localStorage를 아예 못 쓰는 환경(사파리 프라이빗 등)
const vc2 = new VirtualConsole();
const blocked = new JSDOM(HTML, {
  runScripts: "dangerously", url: "https://timing.example/", pretendToBeVisual: true,
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

console.log("");
console.log("=".repeat(66));
console.log(`런타임 오류: ${problems.length ? "\n  " + problems.join("\n  ") : "없음"}`);
console.log(`통과 ${pass} / 실패 ${fail}`);
console.log("=".repeat(66));
process.exit(fail || problems.length ? 1 : 0);
